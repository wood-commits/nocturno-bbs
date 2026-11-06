import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { InputError } from '../src/validation.js';
import { DatabaseSync } from 'node:sqlite';

test('users, calls and public messages persist across restarts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bbs.sqlite');
  let store = new Store(filename);
  try {
    const user = store.createUser('Caller_1', 'test-only-hash');
    const call = store.startCall(user, 1);
    const id = store.post(user, "Hello '); DROP TABLE users; --", 'First line\nSecond line');
    assert.equal(store.message(id).body, 'First line\nSecond line');
    assert.equal(store.message(id).handle, 'Caller_1');
    assert.equal(store.messages()[0].id, id);
    assert.equal(store.users()[0].handle, 'Caller_1');
    assert.equal(store.users(1).length, 0);
    assert.equal(store.callers()[0].ended_at, null);
    store.endCall(call);
    assert.ok(store.callers()[0].ended_at);
    store.close();
    store = new Store(filename);
    assert.equal(store.findUser('caller_1').id, user);
    assert.equal(store.messages().length, 1);
    assert.deepEqual(store.stats(), { users: 1, messages: 1, calls: 1, today: 1 });
  } finally { store.close(); }
});

test('storage rejects terminal control injection, invalid users, and orphan posts', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const id = store.createUser('Caller', 'test-only-hash');
  assert.throws(() => store.createUser('../bad', 'hash'), InputError);
  assert.throws(() => store.createUser('CALLER', 'hash'), InputError);
  assert.throws(() => store.post(id, '\x1b[2J', 'hello'), InputError);
  assert.throws(() => store.post(id, 'subject', 'bad\x07bell'), InputError);
  assert.throws(() => store.post(id, 'subject', 'a'.repeat(4097)), InputError);
  assert.throws(() => store.post(id, 'subject', Array(51).fill('a').join('\n')), InputError);
  assert.throws(() => store.post(999, 'subject', 'body'), InputError);
  assert.equal(store.message(999), undefined);
});

test('deleted accounts reserve IDs, clear private fields and preserve anonymized history across restarts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-delete-user-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bbs.sqlite');
  let store = new Store(filename);
  try {
    const user = store.createUser('OriginalCaller', 'private-test-hash');
    const message = store.post(user, 'Preserved subject', 'Preserved body');
    store.startCall(user, 1);
    for (const field of ['real_name', 'location', 'sysop_note']) store.editUser(user, field, 'Private value');
    store.db.prepare('INSERT INTO community_profiles(user_id, signature, user_note) VALUES (?, ?, ?)')
      .run(user, 'Private signature', 'Private note');
    store.deleteUser(user);
    assert.equal(store.user(user), undefined);
    assert.equal(store.findUser('OriginalCaller'), undefined);
    assert.deepEqual(store.sysopUsers(), []);
    assert.deepEqual(store.users(), []);
    assert.equal(store.stats().users, 0);
    const tombstone = store.db.prepare('SELECT * FROM users WHERE id = ?').get(user);
    assert.equal(tombstone.handle, `Deleted user #${user}`);
    assert.equal(tombstone.deleted, 1);
    assert.equal(tombstone.disabled, 1);
    assert.equal(tombstone.can_post, 0);
    assert.equal(tombstone.can_doors, 0);
    for (const field of ['password_hash', 'real_name', 'location', 'sysop_note']) assert.equal(tombstone[field], '');
    assert.equal(store.db.prepare('SELECT * FROM community_profiles WHERE user_id = ?').get(user), undefined);
    assert.equal(store.message(message).body, 'Preserved body');
    assert.equal(store.message(message).handle, tombstone.handle);
    assert.equal(store.callers()[0].handle, tombstone.handle);
    for (const action of [
      () => store.deleteUser(user), () => store.setUserDisabled(user, false),
      () => store.renameUser(user, 'Restored'), () => store.editUser(user, 'can_post', 1),
      () => store.access.assign(user, 1), () => store.decideApplication(user, true)
    ]) assert.throws(action, /not found/);
    assert.throws(() => store.post(user, 'Denied', 'Body'), InputError);
    const replacement = store.createUser('originalcaller', 'replacement-test-hash');
    assert.ok(replacement > user);
    assert.equal(store.users()[0].handle, 'originalcaller');
    assert.equal(store.stats().users, 1);
    store.close();
    store = new Store(filename);
    assert.equal(store.user(user), undefined);
    assert.equal(store.findUser('OriginalCaller').id, replacement);
    assert.equal(store.message(message).handle, tombstone.handle);
    assert.equal(store.callers()[0].handle, tombstone.handle);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); }
});

test('deleting pending users removes their applications and profile failures roll deletion back', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const pending = store.createUser('Applicant', 'test-hash', true);
  store.deleteUser(pending);
  assert.deepEqual(store.applications(), []);
  assert.throws(() => store.decideApplication(pending, true), /not found/);
  const user = store.createUser('Preserved', 'test-hash');
  store.db.prepare('INSERT INTO community_profiles(user_id, signature) VALUES (?, ?)').run(user, 'Signature');
  store.db.exec(`CREATE TRIGGER fail_profile_delete BEFORE DELETE ON community_profiles
    BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END`);
  assert.throws(() => store.deleteUser(user), /test deletion failure/);
  assert.equal(store.findUser('Preserved').id, user);
  assert.equal(store.findUser('Preserved').password_hash, 'test-hash');
  assert.equal(store.user(user).disabled, 0);
  assert.equal(store.db.prepare('SELECT signature FROM community_profiles WHERE user_id = ?').get(user).signature, 'Signature');
});

test('public replies keep their parent and base across restarts and moderation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-replies-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bbs.sqlite');
  let store = new Store(filename);
  try {
    const user = store.createUser('Caller', 'test-only-hash');
    const base = store.createBase('Reply discussion');
    const parent = store.post(user, 'Original', 'Original body', base);
    const reply = store.post(user, 'Re: Original', 'Reply body', base, parent);
    assert.equal(store.message(parent).reply_to, null);
    assert.equal(store.message(reply).reply_to, parent);
    assert.equal(store.messages(0, base)[0].reply_to, parent);
    for (const invalid of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, 999]) {
      assert.throws(() => store.post(user, 'Reply', 'Body', base, invalid), InputError);
    }
    assert.throws(() => store.post(user, 'Wrong base', 'Body', 1, parent), /not found in this base/);
    store.access.setMessagePermissions(1, base, 1, 0);
    assert.throws(() => store.post(user, 'Denied', 'Body', base, parent), /permission denied/i);
    store.access.setMessagePermissions(1, base, 1, 1);
    store.close();
    store = new Store(filename);
    assert.equal(store.message(reply).reply_to, parent);
    store.deleteMessage(parent);
    assert.throws(() => store.post(user, 'Removed parent', 'Body', base, parent), /not found in this base/);
    assert.equal(store.message(reply).reply_to, parent);
    assert.equal(store.message(reply).body, 'Reply body');
    assert.equal(store.stats().messages, 1);
  } finally { store.close(); }
});

test('pre-sysop database migrates without losing users or messages, and settings persist', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-migrate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bbs.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO users VALUES (1, 'OldCaller', 'legacy-hash', '2026-10-29', NULL);
    INSERT INTO messages VALUES (1, 1, 'Old subject', 'Old body', '2026-10-29');
  `);
  legacy.close();
  let store = new Store(filename);
  try {
    assert.equal(store.settings().name, 'Nocturno BBS');
    store.initSettings('Initial Name');
    assert.equal(store.user(1).disabled, 0);
    assert.equal(store.findUser('oldcaller').deleted, 0);
    assert.equal(store.findUser('oldcaller').password_hash, 'legacy-hash');
    assert.equal(store.message(1).body, 'Old body');
    assert.equal(store.message(1).base_id, 1);
    assert.equal(store.message(1).reply_to, null);
    assert.equal(store.user(1).can_post, 1);
    assert.equal(store.user(1).can_doors, 1);
    assert.equal(store.user(1).sysop_note, '');
    const baseId = store.createBase('Tech', 'Technical discussion');
    store.post(1, 'Tech post', 'Additive migration', baseId);
    store.setString('goodbye', 'Good night!');
    store.editUser(1, 'location', 'The Wire');
    store.updateSettings({ name: 'Persistent Name', registration: 0, session_minutes: 30, idle_minutes: 2 });
    store.renameUser(1, 'NewCaller');
    store.setUserDisabled(1, true);
    store.close();
    store = new Store(filename);
    store.initSettings('Nocturno BBS');
    assert.deepEqual({ ...store.settings() },
      { name: 'Persistent Name', registration: 0, session_minutes: 30, idle_minutes: 2, last_callers: 1 });
    assert.equal(store.user(1).disabled, 1);
    assert.equal(store.message(1).handle, 'NewCaller');
    assert.equal(store.bases()[1].name, 'Tech');
    assert.equal(store.messages(0, baseId)[0].subject, 'Tech post');
    assert.equal(store.stringOverride('goodbye'), 'Good night!');
    assert.equal(store.user(1).location, 'The Wire');
    const saved = store.settings();
    for (const invalid of [{ name: '\x1b[2J' }, { registration: 2 }, { idle_minutes: 61 }, { last_callers: 2 },
      { session_minutes: 0 }, { session_minutes: 1.5 }, { idle_minutes: NaN }]) {
      assert.throws(() => store.updateSettings({ ...saved, ...invalid }), InputError);
      assert.deepEqual(store.settings(), saved);
    }
    assert.throws(() => store.renameUser(999, 'NoSuch'), /not found/);
    assert.throws(() => store.setUserDisabled(999, true), /not found/);
    assert.throws(() => store.setUserDisabled(1, 1), InputError);
    store.updateSettings({ ...saved, registration: 1 });
    store.createUser('Taken', 'hash');
    assert.throws(() => store.renameUser(1, 'TAKEN'), /already in use/);
    store.renameUser(1, 'newcaller');
    assert.equal(store.user(1).handle, 'newcaller');
  } finally { store.close(); }
});

test('bases isolate messages and private user fields never leak into public lists', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const user = store.createUser('Caller', 'secret-hash');
  const base = store.createBase('Technology', 'Talk about tech');
  const generalPost = store.post(user, 'General subject', 'General body');
  const techPost = store.post(user, 'Tech subject', 'Tech body', base);
  assert.equal(store.messages()[0].id, generalPost);
  assert.equal(store.messages(0, base)[0].id, techPost);
  assert.equal(store.messages(1, base).length, 0);
  assert.throws(() => store.createBase('TECHNOLOGY'), /already in use/);
  assert.throws(() => store.createBase('\x1b[2J'), InputError);
  assert.throws(() => store.post(user, 'Subject', 'Body', 999), /base not found/);
  store.editUser(user, 'real_name', 'Private Name');
  store.editUser(user, 'location', 'Private Location');
  store.editUser(user, 'sysop_note', 'Private Note');
  store.editUser(user, 'can_post', 0);
  assert.throws(() => store.post(user, 'Denied', 'Nope', base), /permission denied/);
  assert.throws(() => store.editUser(user, 'can_post', 2), InputError);
  assert.throws(() => store.editUser(user, 'password_hash', 'bad'), InputError);
  assert.throws(() => store.editUser(user, 'location', '\x1b[2J'), InputError);
  assert.ok(!JSON.stringify(store.users()).includes('Private'));
  assert.ok(!JSON.stringify(store.sysopUsers()).includes('secret-hash'));
  store.editUser(user, 'can_post', 1);
  store.editUser(user, 'sysop_note', '');
  assert.equal(store.user(user).sysop_note, '');
  store.setUserDisabled(user, true);
  assert.throws(() => store.post(user, 'Denied', 'Nope'), /permission denied/);
});

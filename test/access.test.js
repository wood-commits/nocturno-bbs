import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { InputError } from '../src/validation.js';
import { doorScreen, doorCommand } from '../src/doors.js';
import { Community } from '../src/community.js';
import { DatabaseSync } from 'node:sqlite';
import { Transfers } from '../src/transfers.js';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const user = store.createUser('RoleCaller', 'test-only-hash');
  const role = store.access.createRole('Reader');
  return { store, user, role, access: store.access };
}

test('one default Member role preserves access; custom roles start denied and do not leak privately', t => {
  const { store, user, role, access } = fixture(t);
  const base = store.createBase('Restricted', 'Private discussion');
  const fileBase = access.createFileBase('Restricted files');
  const post = store.post(user, 'Secret subject', 'Secret body', base);
  assert.equal(store.user(user).role_id, 1);
  assert.equal(access.requireMessage(user, base, 'post').id, base);
  assert.equal(access.requireFile(user, fileBase, 'upload').id, fileBase);
  access.assign(user, role);
  assert.deepEqual(access.messageBases(user), []);
  assert.deepEqual(access.fileBases(0, user), []);
  for (const action of [
    () => access.messages(user, 0, base),
    () => access.message(user, post, base),
    () => access.requireFile(user, fileBase),
    () => store.post(user, 'Denied', 'Nope', base),
    () => access.caller(user, 'doors')
  ]) assert.throws(action, InputError);
  assert.equal(Object.hasOwn(store.users()[0], 'role_id'), false);
  assert.equal(Object.hasOwn(store.sysopUsers()[0], 'password_hash'), false);
  assert.equal(store.user(user).id, user);
});

test('message read/post grants combine with global and per-user restrictions and apply live', t => {
  const { store, user, role, access } = fixture(t);
  const id = store.post(user, 'Existing', 'Text');
  access.assign(user, role);
  access.setMessagePermissions(role, 1, 1, 0);
  assert.equal(access.message(user, id, 1).subject, 'Existing');
  assert.throws(() => store.post(user, 'No', 'Body'), InputError);
  access.setRolePermissions(role, 1, 1);
  access.setMessagePermissions(role, 1, 1, 1);
  assert.ok(store.post(user, 'Allowed', 'Body'));
  store.editUser(user, 'can_post', 0);
  assert.throws(() => store.post(user, 'No', 'Body'), InputError);
  store.editUser(user, 'can_post', 1);
  access.setMessagePermissions(role, 1, 0, 1);
  assert.throws(() => access.message(user, id, 1), InputError);
  assert.throws(() => store.post(user, 'No', 'Body'), InputError);
  access.setMessagePermissions(role, 1, 1, 1);
  store.setUserDisabled(user, true);
  assert.throws(() => access.message(user, id, 1), InputError);
  store.setUserDisabled(user, false);
  store.db.prepare("UPDATE users SET application_status = 'pending' WHERE id = ?").run(user);
  assert.throws(() => access.messageBases(user), InputError);
  assert.throws(() => access.requireFile(user, 1), InputError);
});

test('role posting and door flags protect services directly without granting remote sysop access', t => {
  const { store, user, role, access } = fixture(t);
  const community = new Community(store);
  access.assign(user, role);
  assert.throws(() => doorScreen(store, user), InputError);
  assert.throws(() => community.enabled(user, true), InputError);
  access.setRolePermissions(role, 1, 1);
  doorScreen(store, user);
  doorCommand(store, user, 'E');
  access.setRolePermissions(role, 0, 0);
  assert.throws(() => doorCommand(store, user, 'H'), InputError);
  assert.throws(() => community.enabled(user, true), InputError);
  store.editUser(user, 'can_doors', 0);
  access.setRolePermissions(role, 1, 1);
  assert.throws(() => doorCommand(store, user, 'H'), InputError);
});

test('filtered base pagination has no inaccessible gaps and grants do not inherit to new bases', t => {
  const { store, user, role, access } = fixture(t);
  for (let index = 0; index < 23; index++) {
    const base = store.createBase(`Message ${index}`);
    const file = access.createFileBase(`Files ${index}`);
    if (index % 2 === 0) {
      access.setMessagePermissions(role, base, 1, 0);
      access.setFilePermissions(role, file, 1, 0, 0);
    }
  }
  access.assign(user, role);
  assert.equal(access.messageBases(user).length, 10);
  assert.equal(access.messageBases(user, 1).length, 2);
  assert.equal(access.fileBases(0, user).length, 10);
  assert.equal(access.fileBases(1, user).length, 2);
  assert.equal(access.messageBases(user, 2).length, 0);
  assert.equal(access.fileBases(2, user).length, 0);
  assert.throws(() => access.messageBases(user, -1), InputError);
  assert.throws(() => access.fileBases(NaN, user), InputError);
});

test('roles, grants, revocations and user assignments persist without reseeding', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'bbs.sqlite');
  let store = new Store(path);
  try {
    const user = store.createUser('PersistentCaller', 'hash');
    const role = store.access.createRole('Trusted');
    const base = store.createBase('Private');
    const files = store.access.createFileBase('Private files');
    store.access.setMessagePermissions(role, base, 1, 1);
    store.access.setFilePermissions(role, files, 1, 1, 0);
    store.access.assign(user, role);
    store.access.setMessagePermissions(1, 1, 0, 0);
    store.access.setFilePermissions(1, 1, 0, 0, 0);
    store.close();
    store = new Store(path);
    assert.equal(store.user(user).role_id, role);
    assert.equal(store.access.requireMessage(user, base).name, 'Private');
    assert.equal(store.access.requireFile(user, files, 'download').name, 'Private files');
    assert.throws(() => store.access.requireFile(user, files, 'upload'), InputError);
    const fresh = store.createUser('NewMember', 'hash');
    assert.equal(store.user(fresh).role_id, 1);
    assert.throws(() => store.access.requireMessage(fresh, 1), InputError);
    assert.throws(() => store.access.requireFile(fresh, 1), InputError);
  } finally { store.close(); }
});

test('pre-role users, message bases and file records migrate additively to Member and General', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-access-migrate-'));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'bbs.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT
    );
    INSERT INTO users VALUES (42, 'LegacyCaller', 'legacy-hash', '2026-10-29', NULL);
    CREATE TABLE message_bases (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO message_bases VALUES (8, 'Legacy base', 'Keep this description');
    CREATE TABLE transfer_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', storage_key TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO transfer_files VALUES (57, 42, 'legacy.txt', 'Keep file metadata',
      '00000000-0000-0000-0000-000000000000.bin', 12, 1, 0, '2026-10-29');
  `);
  legacy.close();
  store = new Store(path);
  assert.equal(store.user(42).role_id, 1);
  assert.equal(store.findUser('LegacyCaller').password_hash, 'legacy-hash');
  assert.equal(store.access.requireMessage(42, 8, 'post').description, 'Keep this description');
  const transfers = new Transfers({ store, directory: join(directory, 'files') });
  assert.equal(transfers.catalog(42)[0].id, 57);
  assert.equal(transfers.catalog(42)[0].description, 'Keep file metadata');
  assert.equal(transfers.sysopFiles()[0].base_id, 1);
});

test('role management rejects invalid grants, identities, names and unbounded growth', t => {
  const { store, user, role, access } = fixture(t);
  for (const action of [
    () => access.assign(user, 999), () => access.assign(999, role),
    () => access.createRole('reader'), () => access.createRole('\x1b[2J'),
    () => access.createRole('x'.repeat(25)), () => access.setRolePermissions(role, 2, 0),
    () => access.setMessagePermissions(role, 1, 1, -1),
    () => access.setMessagePermissions(role, 999, 1, 1),
    () => access.setFilePermissions(role, 1, 1, 2, 0),
    () => access.setFilePermissions(role, 999, 1, 1, 1),
    () => access.requireMessage(undefined, 1), () => access.requireFile(999, 1),
    () => access.requireMessage(user, 1, 'admin'), () => access.requireFile(user, 1, 'admin')
  ]) assert.throws(action, InputError);
  assert.throws(() => store.db.prepare('UPDATE users SET role_id = 999 WHERE id = ?').run(user), /Role not found/);
  for (let index = 0; index < 98; index++) access.createRole(`Role ${index}`);
  assert.throws(() => access.createRole('Overflow'), /100 roles/);
  for (let index = 0; index < 99; index++) access.createFileBase(`Files ${index}`);
  assert.throws(() => access.createFileBase('Overflow'), /100 file bases/);
});

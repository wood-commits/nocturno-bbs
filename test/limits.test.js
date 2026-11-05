import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Transfers } from '../src/transfers.js';
import { Community } from '../src/community.js';
import { InputError } from '../src/validation.js';
import { Session } from '../src/session.js';
import { LocalSocket } from '../src/local-terminal.js';
import { plainText } from '../src/strings.js';
import { QWK_ID, zip, unzip, qwkMessage } from '../src/transfer-qwk.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-limits-'));
  const filename = join(directory, 'test.sqlite');
  const f = { directory, filename, sessions: [] };
  f.store = new Store(filename);
  f.store.initSettings('Test BBS');
  f.user = f.store.createUser('Caller', 'test-only-hash');
  f.transfers = new Transfers({ store: f.store, directory: join(directory, 'files') });
  t.after(() => {
    for (const session of f.sessions) {
      f.transfers.cancel(session);
      session.cleanup?.();
      session.socket?.destroy();
    }
    f.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}

function reopen(f) {
  f.store.close();
  f.store = new Store(f.filename);
  f.transfers = new Transfers({ store: f.store, directory: join(f.directory, 'files') });
}

function transferSession(f) {
  const session = { user: f.store.user(f.user), id: 1, state: 'main', output: [], binary: [],
    write(data) { this.output.push(data); }, writeBinary(data) { this.binary.push(data); },
    editor: { setRaw() {} } };
  f.sessions.push(session);
  return session;
}

function callerSession(f, auth = { login: async () => f.store.user(f.user) }) {
  const frames = [], errors = [];
  const socket = new LocalSocket(data => frames.push(data.toString('latin1')));
  const session = new Session({ socket, store: f.store, auth, local: true, id: f.sessions.length + 1,
    onError: error => errors.push(error) });
  session.welcomeArt = async () => {};
  session.state = 'login-password';
  session.pendingHandle = 'Caller';
  f.sessions.push(session);
  return { session, frames, errors };
}

test('limit defaults, nullable inheritance, unlimited overrides and validation persist', t => {
  const f = fixture(t), { limits } = f.store;
  assert.deepEqual({ ...limits.defaults() }, { download_ratio: 0, daily_minutes: 0 });
  assert.deepEqual(limits.resolve(f.user), { download_ratio: 0, daily_minutes: 0 });
  limits.setDefaults({ download_ratio: 3, daily_minutes: 60 });
  assert.deepEqual(limits.resolve(f.user), { download_ratio: 3, daily_minutes: 60 });
  limits.setUser(f.user, { download_ratio: 0, daily_minutes: 10 });
  limits.setDefaults({ download_ratio: 4, daily_minutes: 90 });
  assert.deepEqual(limits.resolve(f.user), { download_ratio: 0, daily_minutes: 10 });
  limits.setUser(f.user, { download_ratio: null, daily_minutes: 0 });
  assert.deepEqual(limits.resolve(f.user), { download_ratio: 4, daily_minutes: 0 });
  for (const download_ratio of [-1, 1001, 1.5, '2', NaN, undefined, null]) {
    assert.throws(() => limits.setDefaults({ download_ratio, daily_minutes: 10 }), InputError);
  }
  for (const daily_minutes of [-1, 1441, 0.5, '1', undefined]) {
    assert.throws(() => limits.setUser(f.user, { download_ratio: null, daily_minutes }), InputError);
  }
  assert.throws(() => limits.setUser(999, { download_ratio: 0, daily_minutes: 0 }), InputError);
  reopen(f);
  assert.deepEqual(f.store.limits.resolve(f.user), { download_ratio: 4, daily_minutes: 0 });
  f.store.deleteUser(f.user);
  assert.throws(() => f.store.limits.setUser(f.user, { download_ratio: 0, daily_minutes: 0 }), InputError);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM caller_limit_users').get().n, 0);
});

test('only approved uploads earn durable byte credit, once, including old-schema upgrades', t => {
  const f = fixture(t);
  f.store.limits.setDefaults({ download_ratio: 2, daily_minutes: 0 });
  const file = f.transfers.save(f.user, 'credit.txt', Buffer.from('1234'));
  assert.throws(() => f.store.limits.checkDownload(f.user, 1), { stringKey: 'limits_ratio_exhausted' });
  f.transfers.approve(file);
  f.transfers.approve(file, false);
  f.transfers.approve(file);
  assert.equal(f.store.limits.ratioUsage(f.user).uploaded_bytes, 4);
  f.store.limits.consumeDownload(f.user, 8);
  assert.throws(() => f.store.limits.consumeDownload(f.user, 1), { stringKey: 'limits_ratio_exhausted' });
  reopen(f);
  assert.deepEqual({ ...f.store.limits.ratioUsage(f.user) }, { uploaded_bytes: 4, downloaded_bytes: 8 });
  f.transfers.remove(file);
  assert.equal(f.store.limits.ratioUsage(f.user).uploaded_bytes, 4);
  const next = f.transfers.save(f.user, 'legacy.txt', Buffer.from('12345'));
  f.transfers.approve(next);
  f.store.close();
  const legacy = new DatabaseSync(f.filename);
  legacy.exec('ALTER TABLE transfer_files DROP COLUMN ratio_credited; DELETE FROM transfer_ratio_usage');
  legacy.close();
  f.store = new Store(f.filename);
  assert.equal(f.store.limits.ratioUsage(f.user).uploaded_bytes, 5);
  reopen(f);
  assert.equal(f.store.limits.ratioUsage(f.user).uploaded_bytes, 5);
  assert.equal(f.store.user(f.user).id, f.user);
});

test('parallel downloads share credit and canceled downloads cannot reclaim delivered bytes', t => {
  const f = fixture(t);
  const fileId = f.transfers.save(f.user, 'payload.bin', Buffer.from('1234'));
  f.transfers.approve(fileId);
  f.store.limits.setDefaults({ download_ratio: 1, daily_minutes: 0 });
  const file = f.transfers.download(f.user, fileId);
  const first = transferSession(f), second = transferSession(f);
  f.transfers.begin(first, { direction: 'send', kind: 'download', file });
  assert.equal(f.store.limits.ratioUsage(f.user).downloaded_bytes, 4);
  assert.throws(() => f.transfers.begin(second, { direction: 'send', kind: 'download', file }), { stringKey: 'limits_ratio_exhausted' });
  assert.equal(second.binary.length, 0);
  assert.equal(f.transfers.active.size, 1);
  f.transfers.cancel(first);
  assert.throws(() => f.transfers.download(f.user, fileId), { stringKey: 'limits_ratio_exhausted' });
  assert.equal(f.transfers.stats(f.user).downloads, 0);
  f.store.limits.setUser(f.user, { download_ratio: 0, daily_minutes: null });
  assert.equal(f.transfers.download(f.user, fileId).data.length, 4);
});

test('approval failures roll back both publication and upload credit', t => {
  const f = fixture(t);
  const file = f.transfers.save(f.user, 'atomic.txt', Buffer.from('1234'));
  f.store.db.exec(`CREATE TRIGGER fail_credit BEFORE INSERT ON transfer_ratio_usage
    BEGIN SELECT RAISE(ABORT, 'test credit failure'); END`);
  assert.throws(() => f.transfers.approve(file), /test credit failure/);
  assert.equal(f.transfers.catalog(f.user).length, 0);
  assert.equal(f.store.limits.ratioUsage(f.user).uploaded_bytes, 0);
  assert.equal(f.store.db.prepare('SELECT ratio_credited FROM transfer_files WHERE id = ?').get(file).ratio_credited, 0);
  f.store.db.exec('DROP TRIGGER fail_credit');
  f.transfers.approve(file);
  assert.equal(f.store.limits.ratioUsage(f.user).uploaded_bytes, 4);
});

test('daily budgets combine simultaneous calls, count unlimited usage and survive history pruning/restart', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 2, 12) });
  const f = fixture(t);
  const first = f.store.startCall(f.user, 1), second = f.store.startCall(f.user, 2);
  t.mock.timers.tick(29999);
  assert.equal(f.store.limits.checkTime(f.user), Infinity);
  f.store.limits.setDefaults({ download_ratio: 0, daily_minutes: 1 });
  assert.equal(f.store.limits.checkTime(f.user), 2);
  t.mock.timers.tick(1);
  assert.throws(() => f.store.limits.checkTime(f.user), { stringKey: 'limits_daily_exhausted' });
  f.store.endCall(first);
  f.store.endCall(second);
  f.store.db.exec('DELETE FROM calls');
  reopen(f);
  assert.throws(() => f.store.startCall(f.user, 1), { stringKey: 'limits_daily_exhausted' });
  assert.equal(f.store.callers().length, 0);
  f.store.limits.setUser(f.user, { download_ratio: null, daily_minutes: 0 });
  assert.equal(f.store.limits.checkTime(f.user), Infinity);
});

test('failed call creation and usage checkpoints roll back instead of losing time or creating orphan calls', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 2, 12) });
  const f = fixture(t);
  f.store.db.exec(`CREATE TRIGGER fail_checkpoint BEFORE INSERT ON caller_usage_calls
    BEGIN SELECT RAISE(ABORT, 'test checkpoint failure'); END`);
  assert.throws(() => f.store.startCall(f.user, 1), /test checkpoint failure/);
  assert.equal(f.store.user(f.user).last_login, null);
  assert.equal(f.store.stats().calls, 0);
  f.store.db.exec('DROP TRIGGER fail_checkpoint');
  f.store.startCall(f.user, 1);
  t.mock.timers.tick(10000);
  f.store.db.exec(`CREATE TRIGGER fail_usage BEFORE UPDATE ON caller_daily_usage
    BEGIN SELECT RAISE(ABORT, 'test usage failure'); END`);
  assert.throws(() => f.store.limits.account(f.user), /test usage failure/);
  f.store.db.exec('DROP TRIGGER fail_usage');
  assert.equal(f.store.limits.account(f.user), 10000);
});

test('UTC rollover splits usage; backward clocks cannot reset a spent budget or double-charge time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 2, 23, 59, 40) });
  const f = fixture(t);
  f.store.limits.setDefaults({ download_ratio: 0, daily_minutes: 1 });
  const call = f.store.startCall(f.user, 1);
  t.mock.timers.tick(15000);
  assert.equal(f.store.limits.checkTime(f.user), 45000);
  t.mock.timers.tick(20000);
  assert.equal(f.store.limits.checkTime(f.user), 45000);
  const forward = Date.now();
  t.mock.timers.setTime(forward - 60000);
  assert.equal(f.store.limits.checkTime(f.user), 45000);
  t.mock.timers.setTime(forward + 5000);
  assert.equal(f.store.limits.checkTime(f.user), 40000);
  const before = f.store.db.prepare('SELECT last_at FROM caller_usage_calls WHERE call_id = ?').get(call).last_at;
  assert.throws(() => f.store.limits.checkTime(f.user, -1), { stringKey: 'limits_invalid_date' });
  assert.equal(f.store.db.prepare('SELECT last_at FROM caller_usage_calls WHERE call_id = ?').get(call).last_at, before);
  f.store.endCall(call);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM caller_usage_calls').get().n, 0);
});

test('usage checkpoints persist through a crash but do not charge offline downtime on restart', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 2, 12) });
  const f = fixture(t);
  f.store.limits.setDefaults({ download_ratio: 0, daily_minutes: 1 });
  f.store.startCall(f.user, 1);
  t.mock.timers.tick(20000);
  assert.equal(f.store.limits.checkTime(f.user), 40000);
  t.mock.timers.tick(3600000);
  reopen(f);
  assert.equal(f.store.limits.checkTime(f.user), 40000);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM caller_usage_calls').get().n, 0);
});

test('asynchronous quota-denied login never attaches an authenticated user or starts a call', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 2, 12) });
  const f = fixture(t);
  let finish;
  const { session, frames, errors } = callerSession(f, { login: () => new Promise(resolve => { finish = resolve; }) });
  session.queue.push('test password');
  const pending = session.drain();
  await Promise.resolve();
  await Promise.resolve();
  f.store.limits.setDefaults({ download_ratio: 0, daily_minutes: 1 });
  f.store.db.prepare('INSERT INTO caller_daily_usage VALUES (?, ?, ?)').run(f.user, '2026-01-02', 60000);
  finish(f.store.user(f.user));
  await pending;
  assert.equal(session.user, undefined);
  assert.equal(session.callId, undefined);
  assert.equal(session.state, 'welcome');
  assert.equal(f.store.stats().calls, 0);
  assert.match(plainText(frames.join('')), /daily connection time is exhausted/);
  assert.deepEqual(errors, []);
});

test('daily timers disconnect idle callers at the shared limit, including live global changes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 2, 12) });
  const f = fixture(t);
  const first = callerSession(f), second = callerSession(f);
  for (const caller of [first, second]) {
    caller.session.queue.push('test password');
    await caller.session.drain();
  }
  t.mock.timers.tick(29000);
  f.store.limits.setDefaults({ download_ratio: 0, daily_minutes: 1 });
  t.mock.timers.tick(999);
  assert.equal(first.session.closed, false);
  assert.equal(second.session.closed, false);
  t.mock.timers.tick(1);
  assert.equal(first.session.closed, true);
  assert.equal(second.session.closed, true);
  for (const caller of [first, second]) {
    assert.match(plainText(caller.frames.join('')), /daily connection time is exhausted/);
    assert.deepEqual(caller.errors, []);
  }
});

test('moderated posts/replies and QWK imports stay invisible until approved; rejection reserves IDs', t => {
  const f = fixture(t), { store, user, transfers } = f;
  const original = store.post(user, 'Published original', 'Public body');
  store.setModeration(1, true);
  const pending = store.post(user, 'Hidden subject', 'Hidden body', 1, original);
  assert.equal(store.isMessagePending(pending), true);
  assert.equal(store.message(pending).reply_to, original);
  assert.equal(store.access.message(user, pending, 1), undefined);
  assert.deepEqual(store.access.messages(user, 0, 1).map(row => row.id), [original]);
  assert.deepEqual(store.messages(0, 1, true).map(row => row.id), [pending]);
  assert.equal(new Community(store).publicStats(user).posts, 1);
  assert.equal(store.stats().messages, 1);
  assert.throws(() => store.post(user, 'Reply to hidden', 'No', 1, pending), InputError);
  assert.ok(!unzip(transfers.qwk(user)).get('MESSAGES.DAT').toString().includes('Hidden'));
  const producer = Buffer.alloc(128, 32);
  producer.write(QWK_ID);
  const replyPacket = zip([[`${QWK_ID}.MSG`, Buffer.concat([producer,
    qwkMessage({ base_id: 1, subject: 'Offline hidden', body: 'Offline secret', handle: 'Caller' }, true)])]]);
  assert.deepEqual(transfers.importReplyPacket(user, replyPacket), { count: 1, queued: 1 });
  assert.equal(store.stats().messages, 1);
  store.setModeration(1, false);
  assert.equal(store.access.message(user, pending, 1), undefined);
  const immediate = store.post(user, 'New immediate', 'Published');
  assert.equal(store.isMessagePending(immediate), false);
  store.decideMessage(pending, true);
  assert.equal(store.access.message(user, pending, 1).subject, 'Hidden subject');
  const rejected = store.messages(0, 1, true)[0].id;
  store.decideMessage(rejected, false);
  assert.equal(store.message(rejected), undefined);
  const tombstone = store.db.prepare('SELECT removed, body, subject FROM messages WHERE id = ?').get(rejected);
  assert.deepEqual({ ...tombstone }, { removed: 1, body: '', subject: '' });
  assert.throws(() => store.decideMessage(rejected, true), { stringKey: 'moderation_pending_missing' });
  assert.ok(store.post(user, 'After rejection', 'Body') > immediate);
});

test('per-board moderation and pending rows survive upgrades/restarts without publishing old queues', t => {
  const f = fixture(t), base = f.store.createBase('Moderated');
  const original = f.store.post(f.user, 'Legacy published', 'Body');
  f.store.close();
  const legacy = new DatabaseSync(f.filename);
  legacy.exec('ALTER TABLE messages DROP COLUMN pending; DROP TABLE message_moderation');
  legacy.close();
  f.store = new Store(f.filename);
  assert.equal(f.store.moderation(1), false);
  assert.equal(f.store.access.message(f.user, original, 1).subject, 'Legacy published');
  f.store.setModeration(base, true);
  const queued = f.store.post(f.user, 'Pending in base', 'Body', base);
  assert.equal(f.store.isMessagePending(f.store.post(f.user, 'General published', 'Body')), false);
  reopen(f);
  assert.equal(f.store.moderation(base), true);
  assert.equal(f.store.access.message(f.user, queued, base), undefined);
  assert.equal(f.store.messages(0, base, true)[0].id, queued);
  assert.throws(() => f.store.setModeration(999, true), InputError);
  assert.throws(() => f.store.setModeration(base, 1), InputError);
});

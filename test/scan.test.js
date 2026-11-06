import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { createBbs as startBbs } from '../src/server.js';
import { hashPassword } from '../src/auth.js';
import { plainText } from '../src/strings.js';
import { Presentation } from '../src/presentation.js';
import { InputError } from '../src/validation.js';

const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));
const createBbs = options => startBbs({ ansiDirectory: samples, ...options });

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const author = store.createUser('Author', 'test-only-hash');
  const reader = store.createUser('Reader', 'test-only-hash');
  const tech = store.createBase('Tech', 'Technical');
  return { store, access: store.access, author, reader, tech };
}

const unread = (access, user) => Object.fromEntries(access.unreadCounts(user));

test('read pointers count, advance monotonically and catch up per caller and base', t => {
  const { store, access, author, reader, tech } = setup(t);
  const first = store.post(author, 'One', 'Body', 1);
  const second = store.post(author, 'Two', 'Body', 1);
  const techPost = store.post(author, 'Tech', 'Body', tech);
  assert.deepEqual(unread(access, reader), { 1: 2, [tech]: 1 });
  assert.deepEqual(access.messages(reader, 0, 1).map(row => [row.id, row.unread]), [[second, true], [first, true]]);
  assert.deepEqual(access.nextUnread(reader, 1), { id: first, base_id: 1 });
  access.markRead(reader, second, 1);
  // A single high-water mark: reading a later message also covers earlier ones.
  assert.deepEqual(unread(access, reader), { [tech]: 1 });
  access.markRead(reader, first, 1);
  assert.equal(access.lastRead(reader, 1), store.db.prepare('SELECT scan_seq FROM messages WHERE id = ?').get(second).scan_seq);
  assert.deepEqual(access.nextUnread(reader, 1), { id: techPost, base_id: tech });
  // Pointers belong to one caller only.
  assert.deepEqual(unread(access, author), { 1: 2, [tech]: 1 });
  access.catchUp(reader, tech);
  assert.equal(access.nextUnread(reader, 1), undefined);
  assert.throws(() => access.markRead(reader, first, 999), InputError);
  store.deleteUser(reader);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM message_reads WHERE user_id = ?').get(reader).n, 0);
});

test('approved moderated posts become new even when their IDs predate the read pointer', t => {
  const { store, access, author, reader } = setup(t);
  store.setModeration(1, true);
  const queued = store.post(author, 'Queued', 'Awaiting review', 1);
  store.setModeration(1, false);
  const later = store.post(author, 'Later', 'Visible now', 1);
  assert.deepEqual(unread(access, reader), { 1: 1 });
  access.markRead(reader, later, 1);
  assert.deepEqual(unread(access, reader), {});
  store.decideMessage(queued, true);
  assert.ok(queued < later);
  assert.deepEqual(unread(access, reader), { 1: 1 });
  assert.deepEqual(access.nextUnread(reader, 1), { id: queued, base_id: 1 });
  // Pending, rejected and removed posts are never counted.
  store.setModeration(1, true);
  const rejected = store.post(author, 'Rejected', 'No', 1);
  assert.deepEqual(unread(access, reader), { 1: 1 });
  store.decideMessage(rejected, false);
  store.deleteMessage(queued);
  assert.deepEqual(unread(access, reader), {});
});

test('scans skip bases without live read grants and wrap from the current base', t => {
  const { store, access, author, reader, tech } = setup(t);
  const third = store.createBase('Third', 'Another');
  const general = store.post(author, 'General', 'Body', 1);
  const thirdPost = store.post(author, 'Third', 'Body', third);
  const techPost = store.post(author, 'Tech', 'Body', tech);
  assert.deepEqual(access.nextUnread(reader, tech), { id: techPost, base_id: tech });
  assert.deepEqual(access.nextUnread(reader, third), { id: thirdPost, base_id: third });
  access.catchUp(reader, third);
  // Wraps past the last base back to the first.
  assert.deepEqual(access.nextUnread(reader, third), { id: general, base_id: 1 });
  access.setMessagePermissions(1, 1, 0, 0);
  assert.deepEqual(unread(access, reader), { [tech]: 1 });
  assert.deepEqual(access.nextUnread(reader, third), { id: techPost, base_id: tech });
  assert.throws(() => access.catchUp(reader, 1), InputError);
  store.setUserDisabled(reader, true);
  assert.throws(() => access.unreadCounts(reader), InputError);
});

test('upgrading a database assigns scan order to existing visible posts only', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-scan-migrate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bbs.sqlite');
  let store = new Store(filename);
  const author = store.createUser('Author', 'test-only-hash');
  const reader = store.createUser('Reader', 'test-only-hash');
  const visible = store.post(author, 'Visible', 'Body', 1);
  store.setModeration(1, true);
  const pending = store.post(author, 'Pending', 'Body', 1);
  store.close();
  // Simulate a database created before scan sequences existed.
  const legacy = new DatabaseSync(filename);
  legacy.exec('DROP INDEX messages_scan; DROP TABLE message_reads; ALTER TABLE messages DROP COLUMN scan_seq;');
  legacy.close();
  store = new Store(filename);
  try {
    const sequence = id => store.db.prepare('SELECT scan_seq FROM messages WHERE id = ?').get(id).scan_seq;
    assert.equal(sequence(visible), visible);
    assert.equal(sequence(pending), null);
    assert.deepEqual(unread(store.access, reader), { 1: 1 });
    store.decideMessage(pending, true);
    assert.ok(sequence(pending) > sequence(visible));
    store.access.markRead(reader, pending, 1);
    store.close();
    store = new Store(filename);
    assert.deepEqual(unread(store.access, reader), {});
  } finally { store.close(); }
});

test('telnet callers see new-message totals, scan across bases and catch up', { timeout: 20000 }, async t => {
  const store = new Store(':memory:');
  const secret = 'unique scan password';
  const reader = store.createUser('Reader', await hashPassword(secret));
  const author = store.createUser('Author', 'test-only-hash');
  const tech = store.createBase('Tech', 'Technical');
  store.post(author, 'General one', 'First body', 1);
  store.post(author, 'General two', 'Second body', 1);
  store.post(author, 'Tech one', 'Tech body', tech);
  const bbs = await createBbs({ store, port: 0, onError: assert.fail });
  const socket = net.connect({ host: '127.0.0.1', port: Number(bbs.endpoints[0].split(':').at(-1)) });
  t.after(async () => { socket.destroy(); await bbs.close(); store.close(); });
  let output = '';
  socket.on('data', data => { output += data.toString('latin1'); });
  await once(socket, 'connect');
  socket.write(Buffer.from([255, 253, 1, 255, 253, 3, 255, 251, 3]));
  const wait = async text => {
    const deadline = Date.now() + 5000;
    while (!output.includes(text) && !plainText(output).includes(text)) {
      if (Date.now() > deadline) assert.fail(`Timed out waiting for ${text}; received ${plainText(output)}`);
      await delay(10);
    }
  };
  const send = async (value, text) => { output = ''; socket.write(`${value}\r\n`); await wait(text); };
  await wait('Selection:');
  const form = new Presentation(samples);
  await send('L', form.position('login', '|{LOGINHANDLE}') ?? 'Handle');
  await send('Reader', form.position('login', '|{LOGINPASSWORD}') ?? 'assword');
  await send(secret, 'You have 3 new messages.');
  await wait('Press any key');
  output = ''; socket.write(' ');
  await wait('Main command:');
  await send('M', 'Scan new');
  assert.match(plainText(output), /\* +Author +General two/);
  await send('S', 'First body');
  assert.equal(store.access.unreadCounts(reader).get(1), 1);
  await send('S', 'Second body');
  // Scanning continues into the next readable base.
  await send('S', 'Tech body');
  await send('S', 'No new messages.');
  assert.equal(store.access.unreadCounts(reader).size, 0);
  store.post(author, 'Fresh', 'Fresh body', 1);
  await send('B', 'Open base');
  assert.match(plainText(output), /General +\(1 new\)/);
  assert.ok(!/Tech +\(/.test(plainText(output)));
  await send('1', 'Catch up');
  await send('C', 'now marked as read');
  assert.ok(!plainText(output).includes('*'));
  assert.equal(store.access.unreadCounts(reader).size, 0);
});

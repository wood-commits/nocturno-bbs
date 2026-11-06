import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Auth, AttemptLimiter } from '../src/auth.js';
import { createBbs as startBbs } from '../src/server.js';
import { Presentation } from '../src/presentation.js';
import { plainText } from '../src/strings.js';

const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));
const createBbs = options => startBbs({ ansiDirectory: samples, ...options });
const oldSecret = 'original changeable password';
const newSecret = 'replacement changeable password';

async function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store);
  await auth.init();
  const { id } = await auth.register('Changer', oldSecret, 'seed');
  return { store, auth, id };
}

test('password changes require the current password and replace the credential', async t => {
  const { store, auth, id } = await setup(t);
  const before = (await auth.login('Changer', oldSecret, 'a')).credentialVersion;
  await assert.rejects(auth.changePassword(id, 'not the current password', newSecret, 'a'), /Current password is incorrect/);
  await assert.rejects(auth.changePassword(id, oldSecret, oldSecret, 'a'), /must differ/);
  await assert.rejects(auth.changePassword(id, oldSecret, 'short', 'a'), /12-128 printable/);
  const version = await auth.changePassword(id, oldSecret, newSecret, 'a');
  assert.equal(version, before + 1);
  assert.equal(store.credentialVersion(id), version);
  await assert.rejects(auth.login('Changer', oldSecret, 'a'), /Invalid handle or password/);
  assert.equal((await auth.login('Changer', newSecret, 'a')).credentialVersion, version);
  // Hashes never appear in caller or console projections.
  assert.equal(Object.hasOwn(store.user(id), 'password_hash'), false);
  assert.equal(JSON.stringify(store.user(id)).includes('scrypt'), false);
});

test('password changes share the address limiter and reject disabled or racing accounts', async t => {
  const { store, auth, id } = await setup(t);
  auth.limiter = new AttemptLimiter({ limit: 1 });
  await assert.rejects(auth.changePassword(id, 'not the current password', newSecret, '2001:db8::1'), /incorrect/);
  await assert.rejects(auth.changePassword(id, oldSecret, newSecret, '2001:db8::2'), /Too many attempts/);
  auth.limiter = new AttemptLimiter();
  // Disabled while scrypt is running: the change must not apply.
  const change = auth.changePassword(id, oldSecret, newSecret, 'b');
  store.setUserDisabled(id, true);
  await assert.rejects(change, /Account unavailable/);
  store.setUserDisabled(id, false);
  assert.ok(await auth.login('Changer', oldSecret, 'b'));
  // Two concurrent changes verified against the same hash: only one wins.
  const results = await Promise.allSettled([
    auth.changePassword(id, oldSecret, newSecret, 'c'),
    auth.changePassword(id, oldSecret, 'a third changeable password', 'c')
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  // A login whose password changes during derivation fails rather than authenticating the old secret.
  const winner = results.findIndex(result => result.status === 'fulfilled') === 0 ? newSecret : 'a third changeable password';
  const login = auth.login('Changer', winner, 'd');
  store.setPassword(id, store.passwordHash(id), 'changed-during-derivation');
  await assert.rejects(login, /Invalid handle or password/);
});

// The close may already have happened while waiting for the farewell text.
const closed = socket => socket.closed ? undefined : once(socket, 'close');

async function caller(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
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
  const send = async (value, text) => { output = ''; socket.write(`${value}\r\n`); if (text) await wait(text); };
  return { socket, wait, send, output: () => output, clear() { output = ''; } };
}

async function login(client, secret) {
  const form = new Presentation(samples);
  await client.wait('Selection:');
  await client.send('L', form.position('login', '|{LOGINHANDLE}') ?? 'Handle');
  await client.send('Changer', form.position('login', '|{LOGINPASSWORD}') ?? 'assword');
  await client.send(secret, 'Press any key');
  client.clear(); client.socket.write(' ');
  await client.wait('LAST CALLERS');
  await client.wait('Press any key');
  client.clear(); client.socket.write(' ');
  await client.wait('Main command:');
}

test('telnet callers change passwords with hidden entry and other sessions end', { timeout: 20000 }, async t => {
  const store = new Store(':memory:');
  const bbs = await createBbs({ store, port: 0, onError: assert.fail });
  const { id } = await bbs.auth.register('Changer', oldSecret, 'seed');
  const port = Number(bbs.endpoints[0].split(':').at(-1));
  const first = await caller(port), second = await caller(port);
  t.after(async () => { first.socket.destroy(); second.socket.destroy(); await bbs.close(); store.close(); });
  await login(first, oldSecret);
  await login(second, oldSecret);
  await first.send('C', 'change password');
  await first.send('P', 'Current password');
  let typed = '';
  await first.send(oldSecret, 'New password');
  typed += first.output();
  // A mismatched confirmation asks for the new password again.
  await first.send(newSecret, 'Confirm new password');
  typed += first.output();
  await first.send('a different changeable password', 'do not match');
  typed += first.output();
  await first.wait('New password');
  await first.send(newSecret, 'Confirm new password');
  typed += first.output();
  await first.send(newSecret, 'Password changed.');
  typed += first.output();
  for (const secret of [oldSecret, newSecret, 'a different changeable password']) assert.ok(!typed.includes(secret));
  await second.wait('Your password was changed. Please log on again.');
  await closed(second.socket);
  // The changing session continues normally.
  await first.send('Q', 'Main command:');
  assert.equal(bbs.auth.store.credentialVersion(id), 1);
  const third = await caller(port);
  t.after(() => third.socket.destroy());
  await login(third, newSecret);
});

test('three incorrect current passwords end the session even across /abort', { timeout: 20000 }, async t => {
  const store = new Store(':memory:');
  const bbs = await createBbs({ store, port: 0, onError: assert.fail });
  await bbs.auth.register('Changer', oldSecret, 'seed');
  const client = await caller(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(async () => { client.socket.destroy(); await bbs.close(); store.close(); });
  await login(client, oldSecret);
  await client.send('C', 'change password');
  for (let attempt = 1; attempt <= 3; attempt++) {
    await client.send('P', 'Current password');
    await client.send(`wrong current password ${attempt}`, 'New password');
    await client.send(newSecret, 'Confirm new password');
    if (attempt < 3) {
      await client.send(newSecret, 'Current password is incorrect.');
      await client.send('/abort', 'Main command:');
      await client.send('C', 'change password');
    } else await client.send(newSecret, 'Too many incorrect current passwords.');
  }
  await closed(client.socket);
  assert.ok(await bbs.auth.login('Changer', oldSecret, 'other'));
});

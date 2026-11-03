import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createBbs as startBbs } from '../src/server.js';
import { Presentation } from '../src/presentation.js';
import { plainText } from '../src/strings.js';
import { terminal } from './helpers/ansi-terminal.js';

const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));
const createBbs = options => startBbs({ ansiDirectory: samples, ...options });
const loginForm = new Presentation(samples);
const handlePrompts = ['Handle (', loginForm.position('login', '~LN')].filter(Boolean);
const passwordPrompts = ['Password (12-128 characters; input hidden): ', loginForm.position('login', '~LP')].filter(Boolean);

async function client(port, tlsOptions) {
  const socket = tlsOptions
    ? tls.connect({ host: '127.0.0.1', port, ...tlsOptions })
    : net.connect({ host: '127.0.0.1', port });
  let output = '';
  socket.on('data', data => { output += data.toString('latin1'); });
  await once(socket, tlsOptions ? 'secureConnect' : 'connect');
  socket.write(Buffer.from([255, 253, 1, 255, 253, 3, 255, 251, 3]));
  return {
    socket,
    send: value => socket.write(`${value}\r\n`),
    clear: () => { output = ''; },
    output: () => output,
    wait: async value => {
      const targets = Array.isArray(value) ? value : [value];
      const deadline = Date.now() + (targets.some(target => target.includes('Press any key')) ? 15000 : 5000);
      while (!targets.some(target => output.includes(target))) {
        if (Date.now() > deadline) assert.fail(`Timed out waiting for ${value}; received ${output}`);
        await delay(10);
      }
    }
  };
}

async function register(caller, store, handle = 'Night_Owl') {
  await caller.wait('Selection:');
  caller.send('N');
  await caller.wait(handlePrompts);
  caller.send(handle);
  await caller.wait(passwordPrompts);
  caller.clear();
  caller.send('unique test password!');
  await caller.wait('Confirm password');
  caller.clear(); caller.send('unique test password!');
  await caller.wait('pending local sysop approval');
  assert.ok(!caller.output().includes('unique test password!'));
  store.decideApplication(store.findUser(handle).id, true);
  caller.clear(); caller.send('L');
  await caller.wait(handlePrompts);
  caller.send(handle);
  await caller.wait(passwordPrompts);
  caller.clear(); caller.send('unique test password!');
  await caller.wait('Press any key');
  caller.clear(); caller.socket.write(' ');
  await caller.wait('Main command:');
  assert.ok(!caller.output().includes('unique test password!'));
}

test('socket replies use the selected base, editable default subjects and live posting checks', async t => {
  const store = new Store(':memory:'), errors = [];
  const base = store.createBase('Reply discussion');
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await register(caller, store);
  const user = store.findUser('Night_Owl').id;
  const parent = store.post(user, 'S'.repeat(60), Array.from({ length: 20 }, (_, i) => `Original line ${i}`).join('\n'), base);
  const session = [...bbs.sessions.values()][0];
  caller.clear(); caller.send('M');
  await caller.wait('GENERAL MESSAGE BASE');
  caller.clear(); caller.send('B');
  await caller.wait('MESSAGE BASES');
  caller.clear(); caller.send(String(base));
  await caller.wait('REPLY DISCUSSION MESSAGE BASE');
  caller.clear(); caller.send(String(parent));
  await caller.wait('Reply');
  caller.clear(); caller.socket.write('R');
  await caller.wait('Enter keeps "Re: ');
  caller.socket.write('\r\n'); // Optional Enter after a single-key shortcut.
  caller.send('');
  await caller.wait('single . saves');
  caller.send('Reply body');
  caller.clear(); caller.send('.');
  await caller.wait('Message #2 posted.');
  assert.equal(store.message(2).subject, `Re: ${'S'.repeat(56)}`);
  assert.equal(store.message(2).base_id, base);
  assert.equal(store.message(2).reply_to, parent);
  assert.ok(caller.output().lastIndexOf('Message #2 posted.') > caller.output().lastIndexOf('\x1b[2J'));
  caller.clear(); caller.send('2');
  await caller.wait('Reply body');
  assert.ok(caller.output().includes(`In reply to message #${parent}`));
  caller.clear(); caller.send('R');
  await caller.wait('wait 10 seconds');
  assert.equal(session.state, 'read');
  session.lastPost = 0;
  caller.clear(); caller.send('R');
  await caller.wait('Enter keeps "Re: ');
  assert.ok(!caller.output().includes('Re: Re:'));
  caller.send('Edited reply subject');
  await caller.wait('single . saves');
  caller.send('Edited reply body');
  caller.clear(); caller.send('.');
  await caller.wait('Message #3 posted.');
  assert.equal(store.message(3).subject, 'Edited reply subject');
  assert.equal(store.message(3).reply_to, 2);
  session.lastPost = 0;
  caller.clear(); caller.send(String(parent));
  await caller.wait('Original line');
  store.access.setMessagePermissions(1, base, 1, 0);
  caller.clear(); caller.send('R');
  await caller.wait('Access permission denied');
  assert.equal(session.state, 'read');
  store.access.setMessagePermissions(1, base, 1, 1);
  caller.clear(); caller.send('R');
  await caller.wait('Enter keeps');
  caller.send('Denied during composition');
  await caller.wait('single . saves');
  caller.send('Unsaved body');
  store.access.setMessagePermissions(1, base, 1, 0);
  caller.clear(); caller.send('.');
  await caller.wait('Access permission denied');
  assert.equal(store.stats().messages, 3);
  caller.clear(); caller.send('/abort');
  await caller.wait('REPLY DISCUSSION MESSAGE BASE');
  store.access.setMessagePermissions(1, base, 1, 1);
  caller.clear(); caller.send('W');
  await caller.wait('Subject (');
  assert.equal(session.replyTo, null);
  assert.equal(session.replySubject, undefined);
  caller.send('/abort');
  caller.clear(); caller.send(String(parent));
  await caller.wait('Original line');
  caller.clear(); caller.send('R');
  await caller.wait('Enter keeps');
  caller.send('Parent removed during composition');
  await caller.wait('single . saves');
  caller.send('Unsaved body');
  store.deleteMessage(parent);
  caller.clear(); caller.send('.');
  await caller.wait('Message not found in this base.');
  assert.equal(store.stats().messages, 2);
  caller.clear(); caller.send('/abort');
  await caller.wait('REPLY DISCUSSION MESSAGE BASE');
  assert.deepEqual(errors, []);
});

test('real caller routes hide restricted bases and enforce live read, composition and file access', async t => {
  const store = new Store(':memory:'), errors = [];
  const secretBase = store.createBase('Secret discussion');
  const secretFiles = store.access.createFileBase('Secret files');
  const role = store.access.createRole('Limited member');
  store.access.setRolePermissions(role, 1, 0);
  store.access.setMessagePermissions(role, 1, 1, 1);
  store.access.setFilePermissions(role, 1, 1, 0, 0);
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await register(caller, store);
  const user = store.findUser('Night_Owl').id;
  const visible = store.post(user, 'Visible post', 'Visible body');
  store.post(user, 'Hidden subject', 'Hidden body', secretBase);
  store.access.assign(user, role);
  caller.clear(); caller.send('M');
  await caller.wait('Visible post');
  assert.ok(!caller.output().includes('Hidden subject'));
  caller.clear(); caller.send('B');
  await caller.wait('MESSAGE BASES');
  assert.ok(!caller.output().includes('Secret discussion'));
  caller.clear(); caller.send(String(secretBase));
  await caller.wait('Access permission denied');
  caller.clear(); caller.send('1');
  await caller.wait('Visible post');
  caller.clear(); caller.send('W');
  await caller.wait('Subject (');
  caller.send('Compose before revocation');
  await caller.wait('single . saves');
  caller.send('Body before revocation');
  const count = store.stats().messages;
  store.access.setMessagePermissions(role, 1, 1, 0);
  caller.clear(); caller.send('.');
  await caller.wait('Access permission denied');
  assert.equal(store.stats().messages, count);
  caller.clear(); caller.send('/abort');
  await caller.wait('Visible post');
  caller.clear(); caller.send(String(visible));
  await caller.wait('Visible body');
  store.access.setMessagePermissions(role, 1, 0, 0);
  caller.clear(); caller.send('N');
  await caller.wait('Access permission denied');
  assert.ok(!caller.output().includes('Visible body'));
  caller.clear(); caller.send('Q');
  await caller.wait('MESSAGE BASES');
  caller.clear(); caller.send('Q');
  await caller.wait('Main command:');
  caller.clear(); caller.send('F');
  await caller.wait('File base 1: General');
  caller.clear(); caller.send('B');
  await caller.wait('FILE BASES');
  assert.ok(!caller.output().includes('Secret files'));
  caller.clear(); caller.send(String(secretFiles));
  await caller.wait('Access permission denied');
  caller.clear(); caller.send('1');
  await caller.wait('File base 1: General');
  caller.clear(); caller.send('U');
  await caller.wait('Access permission denied');
  assert.equal(bbs.transfers.active.size, 0);
  caller.clear(); caller.send('Q');
  await caller.wait('Main command:');
  caller.clear(); caller.send('D');
  await caller.wait('Access permission denied');
  caller.clear(); caller.send('S');
  await caller.wait('Private note to local sysop');
  assert.deepEqual(errors, []);
});

test('real socket single-key actions need no Enter while subjects, multi-digit IDs and passwords still do', async t => {
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await caller.wait('Selection:');
  caller.clear(); caller.socket.write('N');
  await caller.wait(handlePrompts);
  caller.send('NoEnterCaller');
  await caller.wait(passwordPrompts);
  caller.clear(); caller.socket.write('QGood password');
  await delay(30);
  assert.equal(store.findUser('NoEnterCaller'), undefined);
  assert.ok(!caller.output().includes('QGood password'));
  caller.socket.write('\r\n');
  await caller.wait('Confirm password');
  assert.equal(store.findUser('NoEnterCaller'), undefined);
  caller.clear(); caller.socket.write('QGood password');
  await delay(30);
  assert.equal(store.findUser('NoEnterCaller'), undefined);
  assert.ok(!caller.output().includes('QGood password'));
  caller.socket.write('\r\n');
  await caller.wait('pending local sysop approval');
  const id = store.findUser('NoEnterCaller').id;
  store.decideApplication(id, true);
  caller.clear(); caller.socket.write('L');
  await caller.wait(handlePrompts);
  caller.send('NoEnterCaller');
  await caller.wait(passwordPrompts);
  caller.clear(); caller.send('QGood password');
  await caller.wait('Press any key');
  assert.ok(!caller.output().includes('QGood password'));
  caller.clear(); caller.socket.write(' ');
  await caller.wait('Main command:');
  for (const [command, target] of [['U', 'USER LIST'], ['Q', 'Main command:'],
    ['C', 'CONFIG'], ['Q', 'Main command:'], ['F', 'FILE CATALOG'],
    ['N', 'FILE CATALOG'], ['Q', 'Main command:'], ['K', 'QWK offline mail'],
    ['Q', 'Main command:'], ['D', 'DOOR GAMES'],
    ['1', 'Frontier Realms'], ['B', 'DEVELOPMENT'], ['F', 'advanced to level 1'],
    ['M', 'Markets advanced to level 1'], ['W', 'Watchtowers advanced to level 1'],
    ['L', 'LEADERBOARD'], ['N', 'Page 2'], ['P', 'Page 1'],
    ['?', 'Win if force'], ['C', 'REALM COMMAND'],
    ['Q', 'DOOR GAMES'], ['Q', 'Main command:'],
    ['M', 'GENERAL MESSAGE BASE'], ['W', 'Subject (']]) {
    caller.clear(); caller.socket.write(command);
    await caller.wait(target);
  }
  caller.clear(); caller.socket.write('Quiet subject');
  await delay(30);
  assert.equal(store.stats().messages, 0);
  caller.socket.write('\r\n');
  await caller.wait('single . saves');
  caller.send('Body |04stays literal.');
  caller.send('.');
  await caller.wait('Message #1 posted.');
  for (let index = 2; index <= 12; index++) store.post(id, `Subject ${index}`, `Body ${index}`);
  caller.clear(); caller.socket.write('1');
  await delay(30);
  assert.ok(!caller.output().includes('Body |04stays literal.'));
  caller.socket.write('2\r\n');
  await caller.wait('Body 12');
  caller.clear(); caller.socket.write('Q');
  await caller.wait('GENERAL MESSAGE BASE');
  caller.clear(); caller.socket.write('Q');
  await caller.wait('Main command:');
  const closed = once(caller.socket, 'close');
  caller.socket.write('/G\r\n');
  await closed;
  assert.deepEqual(errors, []);
});

test('editable colored authentication errors do not authenticate the caller or expose credentials', async t => {
  const store = new Store(':memory:');
  store.setString('error_invalid_handle_or_password', '|12Credentials rejected.|07');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await caller.wait('Selection:');
  caller.clear(); caller.socket.write('L');
  await caller.wait(handlePrompts);
  caller.send('UnknownCaller');
  await caller.wait(passwordPrompts);
  caller.clear(); caller.send('never echo this password');
  await caller.wait('Credentials rejected.');
  assert.ok(caller.output().includes('\x1b[0;1;31;40mCredentials rejected.'));
  assert.ok(!caller.output().includes('never echo this password'));
  assert.ok(!caller.output().includes('Invalid handle or password.'));
  assert.equal(store.callers().length, 0);
  assert.equal(bbs.nodes()[0].handle, undefined);
  assert.deepEqual(errors, []);
});

test('real telnet session: register, users, callers, post, read, logout and login', { timeout: 35000 }, async t => {
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const port = Number(bbs.endpoints[0].split(':').at(-1));
  const caller = await client(port);
  t.after(() => caller.socket.destroy());
  await register(caller, store);
  assert.equal(bbs.nodes()[0].handle, 'Night_Owl');
  caller.clear(); caller.send('U');
  await caller.wait('USER LIST');
  assert.ok(caller.output().includes('Night_Owl'));
  caller.clear(); caller.send('Q');
  await caller.wait('Main command:');
  caller.clear(); caller.send('L');
  await caller.wait('LAST CALLERS');
  assert.ok(caller.output().includes('Night_Owl'));
  caller.clear(); caller.send('Q');
  await caller.wait('Main command:');
  caller.clear(); caller.send('M');
  await caller.wait('GENERAL MESSAGE BASE');
  caller.clear(); caller.send('W');
  await caller.wait('Subject (');
  caller.clear(); caller.send('First post');
  await caller.wait('single . saves');
  caller.send('Hello from the wire.');
  caller.send('.');
  await caller.wait('Message #1 posted.');
  caller.clear(); caller.send('1');
  await caller.wait('Hello from the wire.');
  caller.clear(); caller.send('Q');
  await caller.wait('GENERAL MESSAGE BASE');
  caller.clear(); caller.send('Q');
  await caller.wait('Main command:');
  const closed = once(caller.socket, 'close');
  caller.send('Q');
  await closed;
  await delay(20);
  assert.ok(store.callers()[0].ended_at);
  const returning = await client(port);
  t.after(() => returning.socket.destroy());
  await returning.wait('Selection:');
  returning.send('L');
  await returning.wait(handlePrompts);
  returning.send('night_owl');
  await returning.wait(passwordPrompts);
  returning.clear();
  returning.send('unique test password!');
  await returning.wait('Press any key');
  returning.socket.write(' ');
  await returning.wait('Main command:');
  assert.ok(!returning.output().includes('unique test password!'));
  assert.equal(store.callers().length, 2);
  assert.deepEqual(errors, []);
});

test('real telnet main lightbar and message paging preserve artwork and every body page', async t => {
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await register(caller, store, 'LayoutCaller');
  assert.ok(caller.output().includes('\x1b[0;1;37;44m message menu'));
  assert.ok(!caller.output().includes('MAIN MENU //'));
  caller.clear();
  caller.socket.write('\x1b[');
  caller.socket.write('C');
  await caller.wait('Main command:');
  assert.ok(caller.output().includes('\x1b[0;1;37;44m note to sysop'));
  caller.clear(); caller.socket.write('\x1b[B');
  await caller.wait('Main command:');
  assert.ok(caller.output().includes('\x1b[0;1;37;44m page sysop'));
  assert.ok(caller.output().includes('\x1b[0;1;30;40mmessage menu'));
  const body = Array.from({ length: 20 }, (_, index) => `Public layout line ${index + 1}`).join('\n');
  const message = store.post(store.findUser('LayoutCaller').id, 'Layout subject', body);
  caller.clear(); caller.send('M');
  await caller.wait('GENERAL MESSAGE BASE');
  caller.clear(); caller.send(String(message));
  await caller.wait('Message list:');
  assert.ok(caller.output().includes('\x1b[14;1H  Public layout line 1'));
  assert.ok(caller.output().includes('Public layout line 9'));
  assert.ok(!caller.output().includes('Public layout line 10'));
  assert.ok(caller.output().includes('Page 1/3'));
  for (const [command, page, first, last] of [
    ['N', 2, 10, 18], ['N', 3, 19, 20], ['P', 2, 10, 18], ['P', 1, 1, 9]
  ]) {
    caller.clear(); caller.send(command);
    await caller.wait('Message list:');
    assert.ok(caller.output().includes(`Page ${page}/3`));
    assert.ok(caller.output().includes(`Public layout line ${first}`));
    assert.ok(caller.output().includes(`Public layout line ${last}`));
  }
  assert.deepEqual(errors, []);
});

test('all main sections redraw themed screens and retain shortcut/arrow selections on return', async t => {
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await register(caller, store, 'MenuCaller');
  assert.ok(caller.output().includes('\x1b[0;1;37;44m message menu'));
  caller.clear(); caller.socket.write('\x1b[A');
  await caller.wait('\x1b[0;1;37;44m user list');
  caller.clear(); caller.socket.write('\r\n');
  await caller.wait('USER LIST');
  caller.clear(); caller.socket.write('Q');
  await caller.wait('Main command:');
  assert.ok(caller.output().includes('\x1b[0;1;37;44m user list'));

  for (const [key, title, label] of [
    ['E', 'EMAIL', 'email'], ['C', 'CONFIG', 'user config'],
    ['U', 'USER LIST', 'user list'], ['F', 'FILE CATALOG', 'files'],
    ['M', 'GENERAL MESSAGE BASE', 'message menu'], ['S', 'Note line:', 'note to sysop'],
    ['K', 'QWK MAIL', 'qwk mail menu'], ['O', 'AUTOMESSAGE', 'automessage'],
    ['P', 'Reason (160', 'page sysop'], ['T', 'Q main | Command:', 'your stats'],
    ['B', 'BBS // PAGE', 'bbs list'], ['L', 'LAST CALLERS', 'last callers'],
    ['I', 'ONELINERS', 'oneliners'], ['D', 'DOOR GAMES', 'doors'],
    ['G', 'SIGNATURE', 'autosig menu']
  ]) {
    caller.clear(); caller.socket.write(key);
    await caller.wait(title);
    assert.ok(caller.output().startsWith('\x1b[0m\x1b[2J\x1b[H'), `${key} must start a fresh screen`);
    assert.ok(caller.output().includes('\x1b[0;1;36;40m'), `${key} must have a colored prompt`);
    if (key === 'D') {
      caller.clear(); caller.socket.write('1');
      await caller.wait('Realm command:');
      assert.ok(caller.output().startsWith('\x1b[0m\x1b[2J\x1b[H'));
      caller.clear(); caller.socket.write('E');
      await caller.wait('Realm command:');
      assert.ok(caller.output().startsWith('\x1b[0m\x1b[2J\x1b[H'));
      assert.ok(caller.output().includes('Your scouts expanded the frontier.'));
      caller.clear(); caller.socket.write('Q');
      await caller.wait('DOOR GAMES');
    }
    caller.clear();
    if (key === 'S' || key === 'P') caller.send('/abort');
    else caller.socket.write('Q');
    await caller.wait('Main command:');
    assert.ok(caller.output().includes(`\x1b[0;1;37;44m ${label}`), `${key} selection must survive returning`);
  }
  for (const key of ['?', 'A']) {
    caller.clear(); caller.socket.write(key);
    await caller.wait('Press any key to return:');
    caller.clear(); caller.socket.write(' ');
    await caller.wait('Main command:');
    assert.ok(caller.output().includes('\x1b[0;1;37;44m autosig menu'));
  }
  assert.deepEqual(errors, []);
});

test('unauthenticated commands cannot post and oversized input is disconnected', async t => {
  const store = new Store(':memory:');
  const bbs = await createBbs({ store, port: 0, onError: assert.fail });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await caller.wait('Selection:');
  caller.send('W');
  await delay(30);
  assert.equal(store.stats().messages, 0);
  caller.clear();
  const closed = once(caller.socket, 'close');
  caller.send('a'.repeat(161));
  await closed;
  assert.ok(caller.output().includes('Input line too long'));
});

test('socket routes custom art, message bases, live strings/permissions and multiplayer doors', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-socket-art-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Fixed screen names inside this test's isolated temporary directory.
  /* eslint-disable security/detect-non-literal-fs-filename */
  writeFileSync(join(directory, 'main.ans'), 'CUSTOM MAIN %BBSNAME% %USERNAME% NODE %NODE%\n[D] Doors [M] Messages [Q] Quit');
  writeFileSync(join(directory, 'message-header.ans'), 'CUSTOM HEADER %BASENAME% %MESSAGEAUTHOR% %MESSAGESUBJECT% #%MESSAGEID%\n');
  writeFileSync(join(directory, 'messages.ans'), 'CUSTOM BASE %BASENAME% PAGE %PAGE%\n');
  /* eslint-enable security/detect-non-literal-fs-filename */
  const store = new Store(':memory:');
  const errors = [];
  const tech = store.createBase('Technology', 'Tech talk');
  const bbs = await createBbs({ store, port: 0, ansiDirectory: directory, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const port = Number(bbs.endpoints[0].split(':').at(-1));
  const first = await client(port);
  const second = await client(port);
  t.after(() => { first.socket.destroy(); second.socket.destroy(); });
  await register(first, store, 'RealmOne');
  await register(second, store, 'RealmTwo');
  assert.ok(first.output().includes('CUSTOM MAIN Nocturno BBS RealmOne'));
  const firstId = store.findUser('RealmOne').id;
  const secondId = store.findUser('RealmTwo').id;
  const generalPost = store.post(firstId, 'General-only post', 'General-only body');
  store.setString('posted', 'Saved #%MESSAGEID%!');
  first.clear(); first.send('M');
  await first.wait('CUSTOM BASE General');
  first.clear(); first.send('B');
  await first.wait('MESSAGE BASES');
  assert.ok(first.output().includes('Technology'));
  first.clear(); first.send(String(tech));
  await first.wait('CUSTOM BASE Technology');
  first.clear(); first.send('W');
  await first.wait('Subject (');
  store.editUser(firstId, 'can_post', 0);
  first.clear(); first.send('Technology subject');
  await first.wait('does not have permission');
  store.editUser(firstId, 'can_post', 1);
  first.clear(); first.send('Technology subject');
  await first.wait('single . saves');
  first.clear(); first.send('Technology body');
  await first.wait('> ');
  store.editUser(firstId, 'can_post', 0);
  first.clear(); first.send('.');
  await first.wait('does not have permission');
  assert.equal(store.messages(0, tech).length, 0);
  store.editUser(firstId, 'can_post', 1);
  first.clear(); first.send('.');
  await first.wait('Saved #2!');
  assert.equal(store.messages().length, 1);
  assert.equal(store.messages(0, tech).length, 1);
  first.clear(); first.send(String(generalPost));
  await first.wait('Message not found in this base');
  assert.ok(!first.output().includes('General-only body'));
  first.clear(); first.send('2');
  await first.wait('CUSTOM HEADER Technology RealmOne Technology subject #2');
  assert.ok(first.output().includes('Technology body'));
  first.clear(); first.send('Q');
  await first.wait('CUSTOM BASE Technology');
  store.editUser(firstId, 'can_post', 0);
  first.clear(); first.send('W');
  await first.wait('does not have permission');
  first.clear(); first.send('Q');
  await first.wait('Main command:');
  first.clear(); first.send('D');
  await first.wait('DOOR GAMES');
  first.clear(); first.send('1');
  await first.wait('Frontier Realms');
  second.clear(); second.send('D');
  await second.wait('DOOR GAMES');
  second.clear(); second.send('1');
  await second.wait('Frontier Realms');
  first.clear(); first.send(`A ${secondId}`);
  await first.wait('repelled');
  assert.ok(!first.output().includes('Internal error'));
  store.editUser(firstId, 'can_doors', 0);
  first.clear(); first.send('H');
  await first.wait('does not have permission');
  first.clear(); first.send('Q');
  await first.wait('DOOR GAMES');
  first.clear(); first.send('Q');
  await first.wait('Main command:');
  first.clear(); first.send('D');
  await first.wait('does not have permission');
  store.setString('main_prompt', 'Custom command: ');
  first.clear(); first.send('Z');
  await first.wait('Custom command: ');
  assert.deepEqual(errors, []);
});

test('disconnecting during authentication cannot create an orphan live call', async t => {
  const store = new Store(':memory:');
  const bbs = await createBbs({ store, port: 0, onError: assert.fail });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  await caller.wait('Selection:');
  caller.send('N');
  await caller.wait(handlePrompts);
  caller.send('Disconnect');
  await caller.wait(passwordPrompts);
  caller.send('unique test password!');
  await caller.wait('Confirm password');
  caller.send('unique test password!');
  await delay(20);
  caller.socket.destroy();
  await bbs.close();
  assert.equal(store.callers().length, 0);
});

test('ANSI authentication fields preserve labels across handle retries and hidden password entry', async t => {
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  const form = new Presentation(samples);
  const handlePosition = form.position('login', '~LN');
  const passwordPosition = form.position('login', '~LP');
  assert.ok(handlePosition);
  assert.ok(passwordPosition);
  // Strip renderer-generated color/cursor sequences when checking artwork labels.
  // eslint-disable-next-line no-control-regex
  const plain = () => caller.output().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  await caller.wait('Selection:');
  for (const command of ['L', 'N', 'C']) {
    caller.clear(); caller.send(command);
    await caller.wait(handlePosition);
    assert.ok(plain().includes('handle:'));
    assert.ok(plain().includes('passwd:'));
    assert.ok(!caller.output().includes('Handle ('));
    assert.ok(caller.output().endsWith(handlePosition));
    caller.clear(); caller.send('Invalid!');
    await caller.wait('Use 3-24 letters');
    assert.ok(plain().includes('passwd:'));
    assert.ok(caller.output().endsWith(handlePosition));
    assert.ok(!caller.output().includes('Handle:'));
    caller.clear(); caller.send('ValidCaller');
    await caller.wait(passwordPosition);
    assert.equal(caller.output(), `ValidCaller\r\n${passwordPosition}`);
    caller.clear();
    const secret = 'never echo this password';
    caller.socket.write(secret);
    await delay(30);
    assert.equal(caller.output(), '');
    caller.socket.write(`${'\b'.repeat(secret.length)}/abort\r\n`);
    await caller.wait('Selection:');
    assert.ok(!caller.output().includes(secret));
  }
  assert.deepEqual(errors, []);
});

test('authentication keeps text prompts when the artwork or individual input markers are absent', async t => {
  for (const [name, source] of [
    ['no artwork', undefined],
    ['no markers', 'CUSTOM LOGIN\r\nhandle:\r\npasswd:\r\n'],
    ['handle marker only', 'CUSTOM LOGIN\r\nhandle: ~LN\r\npasswd:\r\n'],
    ['password marker only', 'CUSTOM LOGIN\r\nhandle:\r\npasswd: ~LP\r\n']
  ]) {
    await t.test(name, async t => {
      const directory = mkdtempSync(join(tmpdir(), 'nocturno-login-'));
      const store = new Store(':memory:');
      let bbs;
      t.after(async () => { await bbs?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
      if (source !== undefined) {
        // Fixed filename in an isolated temporary template directory.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        writeFileSync(join(directory, 'login.ans'), source);
      }
      const form = new Presentation(directory);
      const handlePosition = form.position('login', '~LN');
      const passwordPosition = form.position('login', '~LP');
      bbs = await createBbs({ store, port: 0, ansiDirectory: directory, onError: assert.fail });
      const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
      t.after(() => caller.socket.destroy());
      await caller.wait('Selection:');
      caller.clear(); caller.send('L');
      await caller.wait(handlePosition ?? 'Handle (');
      if (handlePosition) assert.ok(!caller.output().includes('Handle ('));
      caller.clear(); caller.send('Invalid!');
      await caller.wait('Use 3-24 letters');
      assert.ok(handlePosition ? caller.output().endsWith(handlePosition) :
        plainText(caller.output()).endsWith('Handle (3-24 letters/numbers/_/-): '));
      caller.clear(); caller.send('ValidCaller');
      await caller.wait(passwordPosition ?? 'input hidden');
      if (passwordPosition) assert.equal(caller.output(), `ValidCaller\r\n${passwordPosition}`);
      else if (source !== undefined) {
        assert.ok(caller.output().includes('\x1b[23;1H\x1b[2K'));
        assert.ok(plainText(caller.output()).endsWith('Password (12-128 characters; input hidden): '));
      } else assert.equal(plainText(caller.output()), 'ValidCaller\r\nPassword (12-128 characters; input hidden): ');
    });
  }
});

for (const layout of ['generated', 'sample', 'without status marker']) {
  test(`new applications require hidden matching passwords with ${layout} login screens`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'nocturno-confirm-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    if (layout === 'without status marker') {
      // This fixed template belongs to the isolated test directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(join(directory, 'login.ans'), 'LOGIN\r\nhandle: ~LN\r\npasswd: ~LP\r\n');
    }
    const ansiDirectory = layout === 'sample' ? samples : directory;
    const store = new Store(':memory:'), errors = [];
    const bbs = await createBbs({ store, port: 0, ansiDirectory, onError: error => errors.push(error) });
    t.after(async () => { await bbs.close(); store.close(); });
    const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
    t.after(() => caller.socket.destroy());
    const session = [...bbs.sessions.values()][0];
    const form = new Presentation(ansiDirectory);
    const handlePrompt = form.position('login', '~LN') ?? 'Handle (';
    const passwordPrompt = form.position('login', '~LP') ?? 'Password (';
    const secret = 'unique confirmation password!';

    async function apply() {
      caller.clear(); caller.send('N');
      await caller.wait(handlePrompt);
      caller.send('ConfirmCaller');
      await caller.wait(passwordPrompt);
    }

    async function password() {
      caller.clear(); caller.send(secret);
      await caller.wait('Confirm password');
      assert.equal(session.state, 'register-confirm-password');
      assert.equal(store.findUser('ConfirmCaller'), undefined);
      assert.ok(!caller.output().includes(secret));
      assert.ok(!session.screenHistory.includes(secret));
    }

    await caller.wait('Selection:');
    await apply();
    await password();
    caller.clear(); caller.send(secret + ' ');
    await caller.wait('Passwords do not match.');
    await caller.wait(passwordPrompt);
    assert.equal(session.state, 'register-password');
    assert.equal(session.pendingPassword, undefined);
    assert.equal(store.findUser('ConfirmCaller'), undefined);
    assert.ok(!caller.output().includes(secret));
    await password();
    caller.clear(); caller.send('short');
    await caller.wait('Use a unique password of 12-128 printable ASCII characters.');
    await caller.wait(passwordPrompt);
    assert.equal(session.state, 'register-password');
    assert.equal(session.pendingPassword, undefined);
    await password();
    caller.clear(); caller.send('/abort');
    await caller.wait('Selection:');
    assert.equal(session.pendingPassword, undefined);
    assert.equal(store.findUser('ConfirmCaller'), undefined);

    await apply();
    await password();
    store.updateSettings({ ...store.settings(), registration: 0 });
    caller.clear(); caller.send(secret);
    await caller.wait('registration is closed');
    await caller.wait('Selection:');
    assert.equal(session.pendingPassword, undefined);
    assert.equal(store.findUser('ConfirmCaller'), undefined);
    store.updateSettings({ ...store.settings(), registration: 1 });

    await apply();
    await password();
    caller.clear(); caller.send(secret);
    await caller.wait('pending local sysop approval');
    assert.equal(store.findUser('ConfirmCaller').application_status, 'pending');
    assert.equal(session.pendingPassword, undefined);
    assert.equal(store.callers().length, 0);
    assert.ok(!caller.output().includes(secret));
    assert.ok(!session.screenHistory.includes(secret));
    assert.deepEqual(errors, []);
  });
}

for (const artwork of [false, true]) {
  test(`login errors and application notices use one prompt ${artwork ? 'with artwork' : 'without artwork'}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'nocturno-login-notice-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new Store(':memory:');
    const errors = [];
    const bbs = await createBbs({ store, port: 0, ansiDirectory: artwork ? samples : directory,
      onError: error => errors.push(error) });
    t.after(async () => { await bbs.close(); store.close(); });
    const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
    t.after(() => caller.socket.destroy());
    const form = new Presentation(artwork ? samples : directory);
    const handlePrompt = form.position('login', '~LN') ?? 'Handle (';
    const passwordPrompt = form.position('login', '~LP') ?? 'Password (';
    const secret = 'unique test password!';

    async function submit(command, password) {
      caller.clear(); caller.send(command);
      await caller.wait(handlePrompt);
      caller.send('NoticeCaller');
      await caller.wait(passwordPrompt);
      caller.clear(); caller.send(password);
    }

    async function notice(message) {
      await caller.wait(message);
      await caller.wait('Selection:');
      const frame = caller.output();
      const screen = terminal(frame, { rows: 24 });
      assert.equal(plainText(frame).split('Selection:').length - 1, 1);
      assert.equal(plainText(frame).split(message).length - 1, 1);
      assert.equal(screen.scrolls, 0);
      assert.ok(!frame.includes(secret));
      if (artwork) {
        assert.ok(screen.text.startsWith('NOCTURNO sample login matrix'));
        assert.ok(screen.cells[22].map(cell => cell.char).join('').includes(message));
        assert.ok(screen.cells[23].map(cell => cell.char).join('').includes('Selection:'));
        assert.equal(screen.row, 23);
      }
      assert.equal(store.callers().length, 0);
      assert.equal(bbs.nodes()[0].handle, undefined);
    }

    await caller.wait('Selection:');
    await submit('N', 'short');
    await notice('Use a unique password of 12-128 printable ASCII characters.');
    assert.equal(store.findUser('NoticeCaller'), undefined);
    await submit('N', secret);
    await caller.wait('Confirm password');
    caller.clear(); caller.send(secret);
    await notice('Application: pending local sysop approval.');
    await submit('C', 'incorrect test password');
    await notice('Invalid handle or password.');
    await submit('C', secret);
    await notice('Application: pending.');
    await submit('L', secret);
    await notice('Application not approved. Use Check application.');
    store.decideApplication(store.findUser('NoticeCaller').id, true);
    await submit('C', secret);
    await notice('Application: approved.');
    store.updateSettings({ ...store.settings(), registration: 0 });
    caller.clear(); caller.send('N');
    await notice('New caller registration is closed.');

    await submit('L', 'short');
    await notice('Use a unique password of 12-128 printable ASCII characters.');
    await submit('L', 'short');
    const closed = once(caller.socket, 'close');
    await closed;
    assert.ok(caller.output().includes('Too many authentication attempts.'));
    assert.deepEqual(errors, []);
  });
}

test('legacy login lightbar checks pending applications without granting access', async t => {
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[0].split(':').at(-1)));
  t.after(() => caller.socket.destroy());
  await caller.wait('Selection:');
  caller.clear();
  caller.socket.write('\x1b[');
  caller.socket.write('B\r\n');
  await caller.wait(handlePrompts);
  assert.ok(caller.output().includes('\x1b[0;1;7;37;40mApply for an account'));
  caller.send('PendingCaller');
  await caller.wait(passwordPrompts);
  caller.clear(); caller.send('unique test password!');
  await caller.wait('Confirm password');
  caller.clear(); caller.send('unique test password!');
  await caller.wait('pending local sysop approval');
  assert.ok(!caller.output().includes('unique test password!'));
  assert.equal(store.callers().length, 0);
  assert.equal(bbs.nodes()[0].handle, undefined);
  caller.clear(); caller.send('C');
  await caller.wait(handlePrompts);
  caller.send('PendingCaller');
  await caller.wait(passwordPrompts);
  caller.clear(); caller.send('unique test password!');
  await caller.wait('Application: pending');
  assert.equal(store.callers().length, 0);
  assert.equal(bbs.nodes()[0].handle, undefined);
  store.decideApplication(store.findUser('PendingCaller').id, true);
  caller.clear(); caller.send('L');
  await caller.wait(handlePrompts);
  caller.send('PendingCaller');
  await caller.wait(passwordPrompts);
  caller.clear(); caller.send('unique test password!');
  await caller.wait('Press any key');
  assert.ok(!caller.output().includes('SAUCE00'));
  assert.ok(!caller.output().includes('Main command:'));
  caller.clear(); caller.socket.write('x');
  await caller.wait('Main command:');
  caller.clear(); caller.socket.write('\x1bOA\r\n');
  await caller.wait('USER LIST');
  assert.ok(caller.output().includes('PendingCaller'));
  assert.deepEqual(errors, []);
});

test('TLS listener authenticates with a trusted certificate and encrypts the session', {
  skip: !process.env.BBS_TEST_CERT || !process.env.BBS_TEST_KEY
}, async t => {
  // Test paths are supplied by the local operator or CI, never network input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const cert = readFileSync(process.env.BBS_TEST_CERT);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const key = readFileSync(process.env.BBS_TEST_KEY);
  const store = new Store(':memory:');
  const bbs = await createBbs({ store, port: 0, tlsPort: 0, tlsOptions: { cert, key }, onError: assert.fail });
  t.after(async () => { await bbs.close(); store.close(); });
  const caller = await client(Number(bbs.endpoints[1].split(':').at(-1)), { ca: cert, servername: 'localhost' });
  t.after(() => caller.socket.destroy());
  await register(caller, store, 'TLS_Caller');
  assert.equal(caller.socket.authorized, true);
  assert.equal(caller.socket.encrypted, true);
  assert.match(caller.output(), /main menu/i);
  await bbs.close();
  assert.equal(bbs.sessions.size, 0);
  assert.ok(store.callers()[0].ended_at);
});

test('local user deletion disconnects callers and preserves posts without transferring ownership on handle reuse', async t => {
  const store = new Store(':memory:'), errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const port = Number(bbs.endpoints[0].split(':').at(-1));
  const caller = await client(port);
  t.after(() => caller.socket.destroy());
  await register(caller, store, 'DeleteCaller');
  const original = store.findUser('DeleteCaller').id;
  const post = store.post(original, 'Preserved post', 'Original content');
  caller.clear(); caller.send(`X ${original}`);
  await caller.wait('Main command:');
  assert.ok(store.user(original), 'Caller commands must not delete accounts');
  caller.clear();
  const closed = once(caller.socket, 'close');
  const cleaned = once([...bbs.sessions.values()][0], 'session-close');
  bbs.deleteUser(original);
  await Promise.all([closed, cleaned]);
  assert.ok(caller.output().includes('Account deleted by sysop.'));
  assert.equal(store.user(original), undefined);
  assert.equal(store.message(post).handle, `Deleted user #${original}`);
  assert.ok(store.callers()[0].ended_at);
  const replacement = await client(port);
  t.after(() => replacement.socket.destroy());
  await register(replacement, store, 'DeleteCaller');
  const next = store.findUser('DeleteCaller').id;
  assert.ok(next > original);
  assert.equal(store.message(post).body, 'Original content');
  assert.equal(store.message(post).handle, `Deleted user #${original}`);
  assert.deepEqual(errors, []);
});

test('live sysop settings, moderation, disable and hangup are enforced on real sockets', async t => {
  const store = new Store(':memory:');
  store.initSettings('Before Change');
  store.updateSettings({ ...store.settings(), idle_minutes: 2, session_minutes: 10 });
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  t.after(async () => { await bbs.close(); store.close(); });
  const port = Number(bbs.endpoints[0].split(':').at(-1));
  const caller = await client(port);
  t.after(() => caller.socket.destroy());
  await register(caller, store);
  const user = store.findUser('Night_Owl');
  const [session] = bbs.sessions.values();
  assert.equal(session.socket.timeout, 120000);
  store.renameUser(user.id, 'Renamed');
  store.updateSettings({ ...store.settings(), name: 'Changed BBS' });
  caller.clear(); caller.send('Z');
  await caller.wait('Main command:');
  assert.ok(!caller.output().includes('MAIN MENU //'));
  assert.equal(session.name, 'Changed BBS');
  assert.equal(bbs.nodes()[0].handle, 'Renamed');
  const message = store.post(user.id, 'Remove me', 'Body to remove');
  caller.clear(); caller.send('M');
  await caller.wait('GENERAL MESSAGE BASE');
  assert.ok(caller.output().includes('Changed BBS'));
  caller.clear(); caller.send(String(message));
  await caller.wait('Body to remove');
  store.deleteMessage(message);
  caller.clear(); caller.send('N');
  await caller.wait('removed by the sysop');
  const closed = once(caller.socket, 'close');
  bbs.setUserDisabled(user.id, true);
  await closed;
  assert.equal(store.user(user.id).disabled, 1);
  bbs.setUserDisabled(user.id, false);
  const stranger = await client(port);
  t.after(() => stranger.socket.destroy());
  await stranger.wait('Selection:');
  store.updateSettings({ ...store.settings(), registration: 0 });
  stranger.clear(); stranger.send('N');
  await stranger.wait('registration is closed');
  stranger.clear(); stranger.send('S');
  await stranger.wait('sysop');
  assert.equal(store.settings().registration, 0);
  assert.ok(!stranger.output().includes('SYSTEM CONFIGURATION'));
  const node = bbs.nodes().find(node => !node.handle);
  const hungUp = once(stranger.socket, 'close');
  bbs.disconnectNode(node.id);
  await hungUp;
  assert.throws(() => bbs.disconnectNode(99999), /no longer connected/);
  assert.deepEqual(errors, []);
});

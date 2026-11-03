import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createBbs } from '../src/server.js';
import { startSysopConsole } from '../src/sysop.js';
import { terminalText } from '../src/local-terminal.js';
import { ansi } from '../src/screens.js';
import { terminal } from './helpers/ansi-terminal.js';
import { plainText } from '../src/strings.js';

const secret = 'unique console password';

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for console/session transition');
    await delay(5);
  }
}

async function fixture(t) {
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  const user = await bbs.auth.register('Caller', secret, 'seed');
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = raw => { input.isRaw = raw; };
  let output = '';
  const sink = { isTTY: true, writableLength: 0, write: text => { output += text; } };
  const adapter = startSysopConsole({ store, bbs, input, output: sink,
    onError: error => errors.push(error), onQuit: () => {} });
  t.after(async () => {
    adapter.stop();
    input.destroy();
    await bbs.close();
    store.close();
  });
  return { store, bbs, user, input, sink, adapter, controller: adapter.controller, errors,
    output: () => output, clear: () => { output = ''; } };
}

async function remote(f, t) {
  const port = Number(f.bbs.endpoints[0].split(':').at(-1));
  const socket = net.connect({ host: '127.0.0.1', port });
  let output = '';
  socket.on('data', data => { output += data.toString('latin1'); });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  await waitFor(() => f.bbs.sessions.size === 1);
  const session = [...f.bbs.sessions.values()][0];
  socket.write(Buffer.from([255, 253, 1, 255, 253, 3, 255, 251, 3]));
  await waitFor(() => session.editor.echoAccepted);
  return { socket, session, output: () => output };
}

async function login(send, session) {
  send('L');
  await waitFor(() => session.state === 'login-handle' && !session.busy);
  send('Caller\r\n');
  await waitFor(() => session.state === 'login-password' && !session.busy);
  send(secret + '\r\n');
  await waitFor(() => session.state === 'post-welcome' && !session.busy, 15000);
  send(' ');
  await waitFor(() => session.state === 'main' && !session.busy);
}

test('ending sysop chat never replays message content after live role revocation', async t => {
  const f = await fixture(t);
  const caller = await remote(f, t);
  const send = value => caller.socket.write(value);
  await login(send, caller.session);
  const message = f.store.post(f.user.id, 'Protected chat subject', 'Protected chat body');
  send('M');
  await waitFor(() => caller.session.state === 'messages' && !caller.session.busy);
  send(`${message}\r\n`);
  await waitFor(() => caller.session.state === 'read' && !caller.session.busy);
  caller.session.startChat();
  f.store.access.setMessagePermissions(1, 1, 0, 0);
  let replay = '';
  const record = frame => { replay += frame; };
  caller.session.on('display', record);
  caller.session.endChat();
  caller.session.removeListener('display', record);
  assert.equal(caller.session.state, 'main');
  assert.ok(!replay.includes('Protected chat body'));
  assert.match(plainText(replay), /Access permission denied/);
  assert.deepEqual(f.errors, []);
});

test('CP437 console translation preserves ANSI controls and all high-byte glyphs', () => {
  assert.equal(terminalText('\x1b[1;36m\xda\xc4\xbf\r\n\xb3 \xb3\x1b[0m'),
    '\x1b[1;36m┌─┐\r\n│ │\x1b[0m');
  const high = terminalText(Buffer.from(Array.from({ length: 128 }, (_, i) => i + 128)).toString('latin1'));
  assert.equal(high.length, 128);
  assert.ok(!high.includes('undefined'));
  assert.equal(high.at(-1), '\u00a0');
});

test('WFC local login uses real authentication, hides passwords, supports arrows and logs off to WFC', async t => {
  const f = await fixture(t);
  f.input.write('L');
  const session = f.controller.activeSession;
  assert.equal(session.local, true);
  assert.equal(session.user, undefined);
  f.input.write('L');
  await waitFor(() => session.state === 'login-handle' && !session.busy);
  f.input.write('Caller\r');
  await waitFor(() => session.state === 'login-password' && !session.busy);
  f.clear();
  f.input.write('incorrect password\r');
  await waitFor(() => session.state === 'welcome' && !session.busy);
  assert.ok(!f.output().includes('incorrect password'));
  assert.equal(f.store.callers().length, 0);
  await login(value => f.input.write(value), session);
  assert.ok(!f.output().includes(secret));
  assert.ok(!session.screenHistory.includes(secret));
  assert.equal(f.store.callers().length, 1);
  const selected = session.selected;
  f.input.write('\x1b[B');
  await waitFor(() => session.selected !== selected);
  f.input.write('/G\r');
  await waitFor(() => f.controller.view === 'wfc' && f.bbs.sessions.size === 0);
  assert.ok(f.store.callers()[0].ended_at);
  assert.deepEqual(f.errors, []);
});

test('local transfers fail explicitly; disable, Escape and console stop clean up local nodes', async t => {
  const f = await fixture(t);
  f.input.write('L');
  let session = f.controller.activeSession;
  await login(value => f.input.write(value), session);
  f.input.write('K');
  await waitFor(() => session.state === 'transfer-qwk' && !session.busy);
  f.input.write('D');
  await waitFor(() => f.output().includes('Local login does not support binary transfers'));
  assert.equal(session.transferRaw, undefined);
  f.bbs.setUserDisabled(f.user.id, true);
  await waitFor(() => f.controller.view === 'wfc' && f.bbs.sessions.size === 0);
  f.input.write('L');
  session = f.controller.activeSession;
  f.input.write('\x1b');
  await waitFor(() => session.closed && f.bbs.sessions.size === 0);
  assert.equal(f.controller.view, 'wfc');
  f.input.write('L');
  session = f.controller.activeSession;
  f.adapter.stop();
  await waitFor(() => f.bbs.sessions.size === 0);
  assert.equal(session.listenerCount('display'), 0);
  assert.equal(f.input.isRaw, false);
  assert.deepEqual(f.errors, []);
});

test('watch replays the rendered screen, mirrors live ANSI, excludes binary and never controls caller input', async t => {
  const f = await fixture(t);
  const { socket, session } = await remote(f, t);
  assert.throws(() => f.bbs.watchNode(session.id), /Only logged-in/);
  await login(value => socket.write(value), session);
  f.input.write(`NW ${session.id}\r`);
  assert.equal(f.controller.view, 'watch');
  const localScreen = terminal(f.output());
  const remoteScreen = terminal(terminalText(session.screenHistory));
  assert.equal(localScreen.text.slice(0, 24 * 81 - 1), remoteScreen.text.slice(0, 24 * 81 - 1));
  const state = session.state;
  f.input.write('MU\x1b[B\r');
  assert.equal(session.state, state);
  assert.equal(session.editor.line, '');
  f.clear();
  socket.write('U');
  await waitFor(() => session.state === 'users' && !session.busy);
  assert.ok(f.output().includes('USER LIST'));
  assert.ok(f.output().includes('\x1b[2J'));
  f.clear();
  session.write(Buffer.from('\x1b]0;binary payload\x07'));
  session.transferRaw = true;
  session.write('transfer-only output');
  assert.throws(() => f.bbs.watchNode(session.id), /busy/);
  session.transferRaw = false;
  assert.equal(f.output(), '');
  assert.ok(!session.screenHistory.includes('binary payload'));
  f.controller.terminalKey('', { name: 'escape' });
  assert.equal(f.controller.view, 'nodes');
  assert.equal(session.listenerCount('display'), 0);
  assert.equal(session.closed, false);
  assert.deepEqual(f.errors, []);
});

test('watch hangup requires YES, cancellation leaves caller connected and close restores WFC', async t => {
  const f = await fixture(t);
  const { socket, session } = await remote(f, t);
  await login(value => socket.write(value), session);
  f.input.write(`NW ${session.id}\rH`);
  assert.equal(f.controller.view, 'watch-controls');
  const before = f.output();
  session.write('caller output while confirming');
  assert.equal(f.output(), before);
  f.input.write('no\r');
  assert.equal(session.closed, false);
  f.input.write('Q');
  assert.equal(f.controller.view, 'watch');
  f.input.write('HYES\r');
  await waitFor(() => f.controller.view === 'wfc');
  assert.equal(session.closed, true);
  assert.equal(session.listenerCount('display'), 0);
  assert.deepEqual(f.errors, []);
});

test('live chat pauses BBS commands and restores an unfinished composition without saving chat', async t => {
  const f = await fixture(t);
  const { socket, session, output } = await remote(f, t);
  await login(value => socket.write(value), session);
  socket.write('M');
  await waitFor(() => session.state === 'messages' && !session.busy);
  socket.write('W');
  await waitFor(() => session.state === 'subject' && !session.busy);
  socket.write('Existing draft\r\n');
  await waitFor(() => session.state === 'body' && !session.busy);
  socket.write('Saved draft line\r\n');
  await waitFor(() => session.body?.length === 1 && !session.busy);
  const screen = session.screenHistory;
  f.input.write(`NW ${session.id}\rC`);
  assert.equal(f.controller.view, 'chat');
  assert.equal(session.state, 'sysop-chat');
  f.input.write('Hello |04caller\r');
  await waitFor(() => output().includes('Hello |04caller'));
  socket.write('/G\r\n');
  await waitFor(() => f.output().includes('Caller:'));
  assert.equal(session.closed, false);
  assert.equal(session.state, 'sysop-chat');
  assert.equal(f.store.stats().messages, 0);
  assert.equal(session.body.length, 1);
  f.input.write('unsent local draft');
  f.input.write('\x1b');
  await waitFor(() => session.state === 'body');
  assert.equal(session.state, 'body');
  assert.equal(f.controller.view, 'watch');
  assert.ok(session.screenHistory.endsWith(screen));
  assert.equal(session.editor.line, '');
  socket.write('.\r\n');
  await waitFor(() => f.store.stats().messages === 1);
  assert.equal(f.store.message(1).body, 'Saved draft line');
  assert.deepEqual(f.errors, []);
});

test('chat refuses partial input and transfers; chat disconnect and stop release all listeners', async t => {
  const f = await fixture(t);
  const { socket, session } = await remote(f, t);
  await login(value => socket.write(value), session);
  socket.write('M');
  await waitFor(() => session.state === 'messages' && !session.busy);
  socket.write('12');
  await waitFor(() => session.editor.line === '12');
  f.input.write(`NW ${session.id}\rC`);
  assert.equal(f.controller.view, 'watch-controls');
  assert.ok(f.output().includes('Caller is busy'));
  assert.equal(session.editor.line, '12');
  socket.write('\x7f\x7f');
  await waitFor(() => session.editor.line === '');
  session.transferRaw = true;
  assert.throws(() => session.startChat(), /busy/);
  session.transferRaw = false;
  f.input.write('C');
  assert.equal(session.state, 'sysop-chat');
  f.input.write('unsent chat input');
  socket.end();
  await waitFor(() => f.controller.view === 'wfc');
  f.input.write('S');
  assert.equal(f.controller.view, 'config');
  assert.equal(session.listenerCount('display'), 0);
  assert.equal(session.chat, undefined);
  assert.deepEqual(f.errors, []);
});

test('stopping the console ends chat and restores the remote caller without hanging up', async t => {
  const f = await fixture(t);
  const { socket, session } = await remote(f, t);
  await login(value => socket.write(value), session);
  const selected = session.selected;
  f.input.write(`NW ${session.id}\rC`);
  assert.equal(session.state, 'sysop-chat');
  f.adapter.stop();
  assert.equal(session.state, 'main');
  assert.equal(session.selected, selected);
  assert.equal(session.closed, false);
  assert.equal(session.chat, undefined);
  assert.equal(session.listenerCount('display'), 0);
  assert.equal(session.listenerCount('session-close'), 0);
  assert.deepEqual(f.errors, []);
});

test('screen history and terminal output are bounded and recover after a clearing redraw', async t => {
  const f = await fixture(t);
  const session = f.bbs.openLocalSession();
  await login(value => session.socket.send(value), session);
  session.write('x'.repeat(131073));
  assert.equal(session.screenHistory, undefined);
  assert.throws(() => f.bbs.watchNode(session.id), /replay limit/);
  session.write('more output');
  assert.equal(session.screenHistory, undefined);
  session.write(ansi.reset + ansi.clear + 'Fresh screen');
  assert.ok(session.screenHistory.endsWith('Fresh screen'));
  assert.equal(f.bbs.watchNode(session.id), session);
  f.controller.attach(session);
  f.sink.writableLength = 65537;
  session.write('slow terminal');
  assert.equal(f.controller.activeSession, undefined);
  assert.equal(session.listenerCount('display'), 0);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /too slow/);
});

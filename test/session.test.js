import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';
import { Store } from '../src/store.js';
import { LocalSocket } from '../src/local-terminal.js';
import { Presentation } from '../src/presentation.js';
import { ui, plainText } from '../src/strings.js';
import { performance } from 'node:perf_hooks';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const store = new Store(':memory:');
  store.initSettings('Test BBS');
  const user = store.user(store.createUser('Caller', 'test-only-hash'));
  const artwork = '\x1b[0m\x1b[2J' + ('\x1b[1;36m' + '\xb1'.repeat(71) + '\r\n').repeat(36);
  const presentation = new Presentation();
  const render = presentation.render.bind(presentation);
  t.mock.method(presentation, 'render', (screen, fallback, values) =>
    screen === 'welcome' ? artwork : render(screen, fallback, values));
  const frames = [];
  const socket = new LocalSocket(data => frames.push(data.toString('latin1')));
  const errors = [];
  const session = new Session({ socket, store, local: true, id: 1, presentation,
    auth: { login: async () => user }, onError: error => errors.push(error) });
  t.after(() => { session.cleanup(); socket.destroy(); store.close(); });
  frames.length = 0;
  return { session, store, user, artwork, frames, errors };
}

test('main menu help uses capitalized labels and acronym names', async t => {
  const f = fixture(t);
  f.session.user = f.user;
  f.session.state = 'main';
  f.session.queue.push('?');
  await f.session.drain();
  const help = plainText(f.frames.join(''));
  for (const [key, label] of [
    ['E', 'Email'], ['C', 'User Config'], ['M', 'Message Menu'],
    ['K', 'QWK Mail Menu'], ['B', 'BBS List'], ['S', 'Note to Sysop']
  ]) {
    assert.ok(help.includes(plainText(ui(f.store, 'session_value_value', { KEY: key, LABEL: label }))));
  }
  assert.equal(f.session.state, 'art');
  assert.deepEqual(f.errors, []);
});

for (const replay of [false, true]) {
  test(`welcome ${replay ? 'replay' : 'login'} streams at 28.8k and waits for a fresh key`, async t => {
    const f = fixture(t);
    if (replay) {
      f.session.user = f.user;
      f.session.state = 'main';
    } else {
      f.session.state = 'login-password';
      f.session.pendingHandle = f.user.handle;
    }
    f.session.queue.push(replay ? 'A' : 'unique test password!');
    const done = f.session.drain();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(f.session.welcomePlayback, true);
    assert.equal(f.frames.length, 0);
    f.session.editor.feed(Buffer.from(' M\r\n\x1b[B'));
    assert.deepEqual(f.session.queue, []);
    assert.equal(f.session.editor.line, '');
    t.mock.timers.tick(500);
    const partial = f.frames.join('');
    assert.ok(partial.length <= 1440, 'No more than 2,880 bytes/second');
    assert.ok(partial.length >= 1280, 'Output stays within one chunk of the target rate');
    assert.ok(f.artwork.startsWith(partial));
    assert.ok(!partial.includes('Press any key'));
    for (const frame of f.frames) {
      // eslint-disable-next-line no-control-regex
      assert.ok(!frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes('\x1b'));
      assert.ok(!frame.endsWith('\r'));
    }
    t.mock.timers.tick(Math.ceil(f.artwork.length * 1000 / 2880) - 501);
    assert.equal(f.session.welcomePlayback, true, 'Playback cannot finish before its byte budget');
    t.mock.timers.tick(2);
    await done;
    assert.equal(f.frames.join(''), f.artwork + '\r\n' + ui(f.store, replay ? 'return_prompt' : 'continue_prompt'));
    assert.ok(f.session.screenHistory.includes(f.artwork.slice(4)));
    assert.equal(f.session.state, replay ? 'art' : 'post-welcome');
    f.session.editor.feed(Buffer.from(' '));
    assert.equal(f.session.state, 'main');
    assert.deepEqual(f.errors, []);
  });
}

for (const disconnect of [false, true]) {
  test(`welcome playback cancels on ${disconnect ? 'disconnect' : 'socket close'}`, async t => {
    const f = fixture(t);
    f.session.state = 'post-welcome';
    const done = f.session.welcomeArt('session_welcome', 'continue_prompt');
    t.mock.timers.tick(100);
    if (disconnect) f.session.disconnect('Goodbye.');
    else f.session.cleanup();
    const output = f.frames.join('');
    await done;
    t.mock.timers.tick(10000);
    assert.equal(f.frames.join(''), output);
    assert.equal(f.session.welcomePlayback, false);
    assert.equal(f.session.cancelWelcome, undefined);
    assert.deepEqual(f.errors, []);
  });
}

for (const action of ['abort', 'disconnect', 'cleanup']) {
  test(`registration clears its temporary password on ${action}`, async t => {
    const f = fixture(t);
    const secret = 'unique confirmation password!';
    f.session.state = 'register-password';
    f.session.pendingHandle = 'Applicant';
    f.session.queue.push(secret);
    await f.session.drain();
    assert.equal(f.session.state, 'register-confirm-password');
    assert.equal(f.session.pendingPassword, secret);
    assert.ok(!f.frames.join('').includes(secret));
    assert.ok(!f.session.screenHistory.includes(secret));
    if (action === 'abort') {
      f.session.queue.push('/abort');
      await f.session.drain();
      assert.equal(f.session.state, 'welcome');
    } else if (action === 'disconnect') f.session.disconnect('Goodbye.');
    else f.session.cleanup();
    assert.equal(f.session.pendingPassword, undefined);
    assert.deepEqual(f.errors, []);
  });
}

test('password-confirmation mismatches retain the five-failure limit', async t => {
  const f = fixture(t);
  f.session.state = 'register-password';
  f.session.pendingHandle = 'Applicant';
  for (let attempt = 1; attempt <= 5; attempt++) {
    f.session.queue.push('unique confirmation password!');
    await f.session.drain();
    assert.equal(f.session.state, 'register-confirm-password');
    f.session.queue.push('a different confirmation password!');
    await f.session.drain();
    assert.equal(f.session.attempts, attempt);
    assert.equal(f.session.pendingPassword, undefined);
    assert.equal(f.session.closed, attempt === 5);
  }
  assert.ok(f.frames.join('').includes('Too many authentication attempts.'));
  assert.deepEqual(f.errors, []);
});

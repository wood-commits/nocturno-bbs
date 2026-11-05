import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { reportError, reportStartupError } from '../src/errors.js';
import { createBbs } from '../src/server.js';
import { Store } from '../src/store.js';
import { InputError } from '../src/validation.js';
import { config } from '../src/config.js';

test('startup diagnostics identify known configuration failures without logging values', t => {
  let output = '';
  t.mock.method(process.stderr, 'write', data => { output += data; return true; });
  for (const [env, expected] of [
    [{ BBS_PORT: 'private-port-value' }, 'BBS_PORT and BBS_TLS_PORT must be integers'],
    [{ BBS_TLS_CERT: 'private-certificate-path' }, 'Set both BBS_TLS_CERT and BBS_TLS_KEY'],
    [{ BBS_NAME: 'private-name\x1b[2J' }, 'BBS_NAME must contain 1-40'],
    [{ BBS_MCP_TOKEN: 'private-token' }, '64 randomly generated hexadecimal characters']
  ]) {
    output = '';
    assert.throws(() => config(env), error => {
      reportStartupError(error, 'configuration');
      return true;
    });
    assert.ok(output.includes('Startup stage: reading environment configuration'));
    assert.ok(output.includes(expected));
    assert.ok(!output.includes('private-'));
    assert.ok(!output.includes('\x1b'));
  }
});

test('startup artwork diagnostics name only allowlisted screens and reasons', t => {
  let output = '';
  t.mock.method(process.stderr, 'write', data => { output += data; return true; });
  reportStartupError(new InputError('error_unsupported_placeholder_in_value_ans_value', {
    SCREEN: 'main', VALUE2: 'PRIVATE_PASSWORD_TOKEN'
  }), 'services');
  assert.ok(output.includes('main.ans: An unsupported MCI code'));
  assert.ok(output.includes('ANSI.md'));
  assert.ok(!output.includes('PRIVATE_PASSWORD_TOKEN'));
  output = '';
  reportStartupError(new InputError('error_unsupported_ansi_controls_value_ans', {
    SCREEN: 'private-path\x1b[2J'
  }), 'services');
  assert.ok(output.includes('Unsupported terminal controls'));
  assert.ok(!output.includes('private-path'));
  assert.ok(!output.includes('\x1b'));
});

test('unknown startup failures keep raw messages, stacks, paths and stage values private', t => {
  let output = '';
  t.mock.method(process.stderr, 'write', data => { output += data; return true; });
  const error = new Error('private-message\x1b]52;password\x07');
  error.stack = 'private-stack';
  error.path = 'private-path';
  reportStartupError(error, 'private-stage\x1b[2J');
  assert.ok(output.includes('[BBS error: Error]'));
  assert.ok(output.includes('Startup stage: initializing the BBS'));
  assert.ok(!output.includes('private-'));
  assert.ok(!output.includes('\x1b'));
  output = '';
  reportStartupError({ code: 'EADDRINUSE', message: 'private-message' }, 'services');
  assert.ok(output.includes('already in use'));
  assert.ok(!output.includes('private-message'));
  output = '';
  reportStartupError({ code: 'ERR_SQLITE_ERROR', message: 'private-database-content' }, 'database');
  assert.ok(output.includes('opening the SQLite database'));
  assert.ok(output.includes('SQLite initialization failed'));
  assert.ok(!output.includes('private-database-content'));
});

test('shared error reporter bounds diagnostics and never logs messages, stacks or terminal controls', t => {
  const output = [];
  t.mock.method(process.stderr, 'write', data => { output.push(data); return true; });
  const error = new Error('password=private-test-value\r\nFORGED MESSAGE\x1b[31m');
  error.stack = 'private-test-stack';
  error.code = 'ECONNRESET\r\n\x1b]0;FORGED TITLE\x07';
  reportError(error);
  assert.deepEqual(output, [
    '\r\n[BBS error: ECONNRESET????0?FORGED?TITLE?] See README troubleshooting; no credentials logged.\r\n'
  ]);
  output.length = 0;
  reportError({ code: 'A'.repeat(1000), message: error.message });
  reportError({ name: 'TypeError', message: error.message });
  reportError(null);
  reportError({ code: { toString() { assert.fail('Do not stringify arbitrary error properties'); } } });
  assert.equal(output.length, 4);
  assert.ok(output[0].includes(`[BBS error: ${'A'.repeat(64)}]`));
  assert.ok(output[1].includes('[BBS error: TypeError]'));
  assert.ok(output[2].includes('[BBS error: Error]'));
  assert.ok(output[3].includes('[BBS error: Error]'));
  for (const record of output) {
    assert.ok(!record.includes('private-test'));
    assert.ok(!record.includes('\x1b'));
  }
});

test('server default reporter sanitizes socket errors and destroys the failed caller', async t => {
  const store = new Store(':memory:');
  const bbs = await createBbs({ store, port: 0,
    ansiDirectory: fileURLToPath(new URL('../examples/ansi', import.meta.url)) });
  t.after(async () => { await bbs.close(); store.close(); });
  const output = [];
  t.mock.method(process.stderr, 'write', data => { output.push(data); return true; });
  const session = bbs.openAgentSession();
  const closed = new Promise(resolve => session.socket.once('close', resolve));
  const error = new Error('password=private-test-value\r\nFORGED MESSAGE\x1b[31m');
  error.code = 'ECONNRESET\r\n\x1b';
  session.socket.emit('error', error);
  assert.ok(session.socket.destroyed);
  await closed;
  assert.ok(session.closed);
  assert.equal(bbs.sessions.size, 0);
  assert.deepEqual(output, [
    '\r\n[BBS error: ECONNRESET???] See README troubleshooting; no credentials logged.\r\n'
  ]);
});

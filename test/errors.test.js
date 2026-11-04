import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { reportError } from '../src/errors.js';
import { createBbs } from '../src/server.js';
import { Store } from '../src/store.js';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import * as screens from '../src/screens.js';

test('configuration is safe by default and rejects malformed values', () => {
  const options = config({});
  assert.equal(options.name, 'Nocturno BBS');
  assert.equal(config({ BBS_NAME: 'Custom Board' }).name, 'Custom Board');
  assert.equal(options.port, 2323);
  assert.equal(options.tlsHost, '127.0.0.1');
  assert.equal(options.tlsOptions, undefined);
  for (const value of ['0', '-1', '65536', 'abc', '23.2', '']) {
    assert.throws(() => config({ BBS_PORT: value }), /Port/);
  }
  assert.throws(() => config({ BBS_TLS_KEY: 'missing' }), /both/);
  assert.throws(() => config({ BBS_NAME: '\x1b[2J' }), /printable/);
});

test('ANSI screens fit 80 columns, sanitize stored text and paginate message bodies', () => {
  const stats = { users: 1, messages: 2, calls: 3, today: 1 };
  const row = { id: 1, handle: 'Caller\x1b[2J', subject: 'hello', body: 'a'.repeat(1600), created_at: '2026-10-29T20:00:00Z' };
  const frames = [
    screens.welcome('Nocturno BBS', false),
    screens.welcome('Nocturno BBS', true),
    screens.mainMenu('Nocturno BBS', 'Caller', 1),
    screens.userList([], 0),
    screens.callerList([], 0),
    screens.messageList([row], 0),
    screens.readMessage(row),
    screens.waitingScreen('Nocturno BBS', stats, [], ['TELNET 127.0.0.1:2323'], 5)
  ];
  for (const frame of frames) {
    const withoutLineEndings = frame.replaceAll('\r\n', '');
    assert.ok(!withoutLineEndings.includes('\n'), 'Screen output must not contain bare LF');
    assert.ok(!withoutLineEndings.includes('\r'), 'Screen output must not contain bare CR');
    // ANSI control sequences are the subject of this rendering test.
    // eslint-disable-next-line no-control-regex
    const plain = frame.replace(/\x1b\[[0-9;]*[Hf]/g, '\r\n').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.ok(plain.split(/\r?\n/).every(line => line.length <= 80));
  }
  assert.ok(!screens.messageList([row], 0).includes('Caller\x1b'));
  assert.ok(screens.readMessage(row).includes('1/2'));
  assert.ok(screens.readMessage(row, 1).includes('2/2'));
});

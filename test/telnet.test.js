import test from 'node:test';
import assert from 'node:assert/strict';
import { TelnetInput } from '../src/telnet.js';

function parser(options = {}) {
  const output = [], lines = [], violations = [];
  const input = new TelnetInput({ write: value => output.push(value), ...options });
  input.on('line', line => lines.push(line));
  input.on('violation', error => violations.push(error));
  return { input, output, lines, violations };
}

test('fragmented negotiation, CRLF/CR-NUL, backspace and ASCII editing', () => {
  const { input, lines, violations } = parser();
  input.feed(Buffer.from([255, 253]));
  input.feed(Buffer.from([1]));
  assert.equal(input.echoAccepted, true);
  input.feed(Buffer.from('helx\blo\r'));
  input.feed(Buffer.from('\nworld\r'));
  input.feed(Buffer.from([0]));
  input.feed(Buffer.from('last\n'));
  assert.deepEqual(lines, ['hello', 'world', 'last']);
  assert.deepEqual(violations, []);
});

test('passwords and backspaces are never echoed', () => {
  const { input, output, lines } = parser({ secret: () => true });
  input.feed(Buffer.from('hidden passworx\bd\r\n'));
  assert.deepEqual(lines, ['hidden password']);
  assert.equal(output.join(''), '\r\n');
});

test('CSI/OSC control sequences and subnegotiation never become user text', () => {
  const { input, lines } = parser();
  input.feed(Buffer.from('safe\x1b[31mred\x1b]0;title\x07\x1b]52;clipboard\x1b\\'));
  input.feed(Buffer.from([255, 250, 24, 1, 255]));
  input.feed(Buffer.from([240]));
  input.feed(Buffer.from('\n'));
  assert.deepEqual(lines, ['safered']);
});

test('oversized input, negotiation floods, and echo refusal fail closed', () => {
  const cases = [
    Buffer.from('a'.repeat(161)),
    Buffer.from([255, 250, ...Array(1025).fill(1)]),
    Buffer.from(Array(129).fill([255, 253, 3]).flat()),
    Buffer.from([255, 254, 1]),
    Buffer.from([255, 251, 1])
  ];
  for (const data of cases) {
    const { input, violations, lines } = parser();
    input.feed(data);
    input.feed(Buffer.from('ignored\n'));
    assert.equal(violations.length, 1);
    assert.equal(lines.length, 0);
  }
});

test('unknown options are declined without negotiation loops', () => {
  const { input, output } = parser();
  input.feed(Buffer.from([255, 253, 42, 255, 251, 42, 255, 252, 42]));
  assert.deepEqual(output, [Buffer.from([255, 252, 42]), Buffer.from([255, 254, 42])]);
});

test('lightbar arrows decode fragmented CSI and SS3 without becoming line input', () => {
  let mode = 'key';
  const { input, lines, output } = parser({ mode: () => mode });
  const keys = [];
  input.on('key', key => {
    keys.push(key);
    if (key === 'enter') mode = 'line';
  });
  input.feed(Buffer.from('\x1b'));
  input.feed(Buffer.from('[A\x1bOB\x1b[C\x1b[D'));
  input.feed(Buffer.from('L\b\r\nCaller\r\n'));
  assert.deepEqual(keys, ['up', 'down', 'right', 'left', 'L', 'backspace', 'enter']);
  assert.deepEqual(lines, ['Caller']);
  assert.ok(!output.join('').includes('\x1b'));
});

test('raw transfer input preserves binary payload and decodes escaped telnet IAC', () => {
  const { input, lines, output } = parser({ mode: () => 'raw' });
  const chunks = [];
  input.on('raw', data => chunks.push(data));
  input.feed(Buffer.from([0, 13, 10, 27, 24, 255]));
  input.feed(Buffer.from([255, 128, 255, 253, 3]));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 13, 10, 27, 24, 255, 128]));
  assert.deepEqual(lines, []);
  assert.deepEqual(output, []);
});

test('unterminated terminal escape input is bounded', () => {
  const { input, violations } = parser();
  input.feed(Buffer.from('\x1b]' + 'x'.repeat(1025)));
  assert.deepEqual(violations, ['Terminal escape sequence too long.']);
});

test('single-key actions dispatch immediately while IDs, text and optional CRLF remain line-oriented', () => {
  let shortcuts = 'WNQ';
  const { input, lines } = parser({ shortcuts: () => shortcuts });
  input.on('line', line => { if (line === 'W') shortcuts = ''; });
  input.feed(Buffer.from('N'));
  assert.deepEqual(lines, ['N']);
  input.feed(Buffer.from('\r'));
  input.feed(Buffer.from('\n123Q\r\nW\r'));
  input.feed(Buffer.from('\0New subject\r\n'));
  assert.deepEqual(lines, ['N', '123Q', 'W', 'New subject']);
});

test('shortcuts never intercept password input or slash commands', () => {
  let secret = true;
  const { input, lines, output } = parser({
    secret: () => secret, shortcuts: () => secret ? '' : 'GQ'
  });
  input.feed(Buffer.from('QGood password\r\n'));
  assert.deepEqual(lines, ['QGood password']);
  assert.equal(output.join(''), '\r\n');
  secret = false;
  input.feed(Buffer.from('/G\r\n'));
  assert.deepEqual(lines, ['QGood password', '/G']);
});

test('an immediate action followed by arrow and Enter still opens the highlighted item', () => {
  const { input, lines } = parser({ shortcuts: () => 'N', mode: () => 'key' });
  const keys = [];
  input.on('key', key => keys.push(key));
  input.feed(Buffer.from('N\x1b'));
  input.feed(Buffer.from('[B\r\n'));
  assert.deepEqual(lines, ['N']);
  assert.deepEqual(keys, ['down', 'enter']);
});

test('raw transfer bytes bypass shortcut and optional-Enter handling', () => {
  let mode = 'line';
  const { input, lines } = parser({ shortcuts: () => 'UQ', mode: () => mode });
  input.on('line', () => { mode = 'raw'; });
  const chunks = [];
  input.on('raw', data => chunks.push(data));
  input.feed(Buffer.from('U'));
  input.feed(Buffer.from([13, 0, 81, 255, 255, 10]));
  assert.deepEqual(lines, ['U']);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([13, 0, 81, 255, 10]));
});

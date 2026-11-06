import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createBbs as startBbs } from '../src/server.js';
import { Presentation } from '../src/presentation.js';
import { hashPassword } from '../src/auth.js';
import { plainText } from '../src/strings.js';
import { InputError } from '../src/validation.js';
import { QUOTE_WIDTH, quotePrefix, quoteLines, parseQuote } from '../src/quote.js';

const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));
const createBbs = options => startBbs({ ansiDirectory: samples, ...options });

test('quote prefixes use handle initials and wrapped lines fit the quote width', () => {
  assert.equal(quotePrefix('Night_Owl'), 'NO> ');
  assert.equal(quotePrefix('dark-star-gazer-x'), 'DSG> ');
  assert.equal(quotePrefix('Author'), 'AU> ');
  assert.equal(quotePrefix('a1'), 'A1> ');
  const long = `${'word '.repeat(40)}end`;
  const lines = quoteLines(`First\n\n${long}\n${'x'.repeat(150)}`, 'AU> ');
  assert.equal(lines[0], 'First');
  assert.equal(lines[1], '');
  assert.ok(lines.every(line => line.length <= QUOTE_WIDTH - 4));
  assert.equal(lines.slice(2, -3).join(' '), long);
  assert.equal(lines.slice(-3).join(''), 'x'.repeat(150));
});

test('quote ranges are 1-based, inclusive and bounded', () => {
  assert.equal(parseQuote('', 5), undefined);
  assert.deepEqual(parseQuote('2', 5), { first: 2, last: 2 });
  assert.deepEqual(parseQuote('2-5', 5), { first: 2, last: 5 });
  for (const invalid of ['0', '6', '3-2', '1-6', 'a', '1 - 2', '-1', '1-', '1000']) {
    assert.throws(() => parseQuote(invalid, 5), InputError, invalid);
  }
});

test('telnet replies list and quote the original with limits and live checks', { timeout: 20000 }, async t => {
  const store = new Store(':memory:');
  const secret = 'unique quoting password';
  store.createUser('Reader', await hashPassword(secret));
  const author = store.createUser('Author', 'test-only-hash');
  const parent = store.post(author, 'Original topic', 'Line one of the original\nLine two here\nLine three ends it', 1);
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
  const form = new Presentation(samples);
  await wait('Selection:');
  await send('L', form.position('login', '|{LOGINHANDLE}'));
  await send('Reader', form.position('login', '|{LOGINPASSWORD}'));
  await send(secret, 'Press any key');
  output = ''; socket.write(' ');
  await wait('LAST CALLERS');
  await wait('Press any key');
  output = ''; socket.write(' ');
  await wait('Main command:');
  await send('M', 'Scan new');
  await send(String(parent), 'Line one of the original');
  await send('R', 'Enter keeps');
  await send('', 'Replying: /Q lists the original');
  await send('/Q', 'Original message (3 lines):');
  assert.match(plainText(output), / {2}1 Line one of the original/);
  assert.match(plainText(output), / {2}3 Line three ends it/);
  await send('/q 9', '/Q n or /Q n-m (1-3)');
  await send('/Q 1-2', 'Quoted 2 lines.');
  await send('My answer', '> ');
  await send('/Q 3', 'Quoted 1 lines.');
  await send('.', 'Message #');
  const reply = store.messages(0, 1).find(row => row.reply_to === parent);
  assert.equal(store.message(reply.id).body,
    'AU> Line one of the original\nAU> Line two here\nMy answer\nAU> Line three ends it');

  // Skip the 10-second posting cooldown between scripted posts.
  const ready = () => { for (const session of bbs.sessions.values()) session.lastPost = 0; };
  ready();
  // Quotes respect the editor limits and the parent's live availability.
  await send(String(parent), 'Line one of the original');
  await send('R', 'Enter keeps');
  await send('', 'Replying:');
  // One at a time: the input queue deliberately disconnects bursts beyond 16 commands.
  for (let index = 0; index < 49; index++) await send('filler', '> ');
  await send('/Q 1-2', 'exceed 50 lines / 4096 characters');
  await send('/abort', 'Scan new');
  await send(String(parent), 'Line one of the original');
  await send('R', 'Enter keeps');
  await send('', 'Replying:');
  store.deleteMessage(parent);
  await send('/Q', 'Message not found in this base.');
  await send('/abort', 'Scan new');

  ready();
  // Outside replies, /Q is ordinary text.
  await send('W', 'Subject');
  await send('Plain post', '> ');
  await send('/Q 1', '> ');
  await send('.', 'Message #');
  assert.equal(store.message(store.messages(0, 1)[0].id).body, '/Q 1');
});

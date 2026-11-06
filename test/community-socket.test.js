import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createBbs } from '../src/server.js';
import { hashPassword } from '../src/auth.js';
import { Presentation } from '../src/presentation.js';
import { plainText } from '../src/strings.js';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { terminal } from './helpers/ansi-terminal.js';

const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));

async function connect(port, errors) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let received = '', failure;
  socket.on('error', error => { failure = error; });
  socket.on('data', bytes => { received += bytes.toString('latin1'); });
  await once(socket, 'connect');
  socket.write(Buffer.from([255, 253, 1, 255, 253, 3, 255, 251, 3]));
  const client = {
    socket,
    text: () => received,
    clear() { received = ''; },
    async wait(marker) {
      const deadline = Date.now() + (marker.includes('Press any key') ? 15000 : 5000);
      while (!received.includes(marker) && !plainText(received).includes(marker)) {
        if (failure) throw failure;
        assert.ok(!socket.destroyed, `Socket closed waiting for ${marker}: ${received}\n${errors.map(error => error.stack).join('\n')}`);
        assert.ok(Date.now() < deadline, `Timed out waiting for ${marker}`);
        await delay(5);
      }
    },
    async command(line, marker) {
      received = '';
      socket.write(`${line}\r\n`);
      await this.wait(marker);
    },
    async login(handle, form = new Presentation(samples)) {
      await this.wait('Selection:');
      await this.command('L', form.position('login', '|{LOGINHANDLE}') ?? 'Handle (');
      await this.command(handle, form.position('login', '|{LOGINPASSWORD}') ?? 'input hidden');
      await this.command('socket community password!', 'Press any key');
      received = '';
      socket.write(' ');
      await this.wait('LAST CALLERS');
      await this.wait('Press any key');
      received = '';
      socket.write(' ');
      await this.wait('Main command:');
    }
  };
  return client;
}

test('real telnet community menus echo input at the prompt cursor', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-prompt-socket-'));
  const store = new Store(':memory:');
  const errors = [];
  let bbs, caller;
  t.after(async () => {
    caller?.socket.destroy();
    await bbs?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.createUser('PromptCaller', await hashPassword('socket community password!'));
  bbs = await createBbs({ store, port: 0, ansiDirectory: directory, onError: error => errors.push(error) });
  caller = await connect(Number(bbs.endpoints[0].split(':').at(-1)), errors);
  await caller.login('PromptCaller', new Presentation(directory));
  for (const key of ['O', 'E', 'G', 'C', 'T', 'I']) {
    await caller.command(key, 'Command:');
    const frame = caller.text();
    const before = terminal(frame, { rows: 24 });
    const promptRow = before.cells.findLastIndex(row => row.map(cell => cell.char).join('').includes('Command: '));
    const promptColumn = before.cells[promptRow].map(cell => cell.char).join('').indexOf('Command: ') + 'Command: '.length;
    assert.equal(before.row, promptRow, key);
    assert.equal(before.column, promptColumn, key);
    caller.clear();
    caller.socket.write('x');
    await caller.wait('x');
    const echoed = terminal(frame + caller.text(), { rows: 24 });
    assert.equal(echoed.cells[promptRow][promptColumn].char, 'x', key);
    await caller.command('\x7fQ', 'Main command:');
  }
  assert.deepEqual(errors, []);
});

test('real telnet community actions preserve privacy, account edits, signatures and local requests',
  { timeout: 20000 }, async t => {
    const directory = resolve(`.community-socket-${randomUUID()}`);
    const files = join(directory, 'files');
    // Only generated project-local test paths are passed to filesystem APIs.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(files, { recursive: true });
    const store = new Store(join(directory, 'bbs.sqlite'));
    const clients = [], errors = [];
    let bbs;
    t.after(async () => {
      for (const client of clients) client.socket.destroy();
      await bbs?.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    });
    const hash = await hashPassword('socket community password!');
    const aliceId = store.createUser('Alice', hash);
    const bobId = store.createUser('Bob', hash);
    bbs = await createBbs({ store, port: 0, ansiDirectory: samples, transferDirectory: files, onError: error => errors.push(error) });
    // Keep transfer payload paths isolated even when testing older server wiring.
    bbs.transfers.directory = files;
    const port = Number(bbs.endpoints[0].split(':').at(-1));
    const guest = await connect(port, errors);
    clients.push(guest);
    await guest.wait('Selection:');
    await guest.command('S', 'Note line:');
    await guest.command('Guest private sysop note', 'Next line');
    await guest.command('.', 'Selection:');
    assert.equal(bbs.community.notifications()[0].user_id, null);
    assert.deepEqual(bbs.community.notification(bbs.community.notifications()[0].id).body_lines,
      ['Guest private sysop note']);
    const guestClosed = once(guest.socket, 'close');
    guest.socket.destroy();
    await guestClosed;

    const alice = await connect(port, errors);
    clients.push(alice);
    await alice.login('Alice');
    await alice.command('E', 'EMAIL');
    await alice.command('W', 'Recipient handle:');
    await alice.command('Bob', 'Subject (60');
    const privateSubject = 'Private socket subject longer than the artwork subject field';
    await alice.command(privateSubject, 'Private email body');
    await alice.command('Body only Bob should receive', 'Next line');
    for (let line = 1; line <= 20; line++) await alice.command(`Private page line ${line}`, 'Next line');
    await alice.command('.', 'Private email sent.');
    const mailId = bbs.community.inbox(bobId)[0].id;
    assert.equal(bbs.community.unread(bobId), 1);
    await alice.command(String(mailId), 'Mail not found.');
    assert.equal(alice.text().includes('Body only Bob should receive'), false);
    await alice.command('Q', 'EMAIL');
    const draftRecipient = store.createUser('DraftTarget', hash);
    await alice.command('W', 'Recipient handle:');
    await alice.command('dRAFTtARGET', 'Subject (60');
    await alice.command('Confidential in-progress mail', 'Private email body');
    await alice.command('Never deliver to the replacement account', 'Next line');
    store.deleteUser(draftRecipient);
    const replacement = store.createUser('DraftTarget', hash, true);
    store.decideApplication(replacement, true);
    await alice.command('.', 'Recipient unavailable.');
    assert.ok(!alice.text().includes('Private email sent.'));
    assert.deepEqual(bbs.community.inbox(replacement), []);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM community_mail').get().n, 1);
    await alice.command('/abort', 'Main command:');

    const bob = await connect(port, errors);
    clients.push(bob);
    await bob.login('Bob');
    await bob.command('E', 'EMAIL');
    assert.match(bob.text(), /Private socket subject/);
    await bob.command(String(mailId), 'Body only Bob should receive');
    assert.ok(bob.text().includes(privateSubject));
    assert.equal(bob.text().split(privateSubject).length - 1, 1);
    assert.ok(bob.text().includes('Page 1/3'));
    assert.ok(bob.text().includes('Private page line 8'));
    assert.ok(!bob.text().includes('Private page line 9'));
    await bob.command('N', 'Page 2/3');
    assert.ok(bob.text().includes('Private page line 9'));
    assert.ok(bob.text().includes('Private page line 17'));
    assert.ok(!bob.text().includes('Private page line 18'));
    await bob.command('N', 'Page 3/3');
    assert.ok(bob.text().includes('Private page line 20'));
    await bob.command('P', 'Page 2/3');
    assert.ok(bob.text().includes('Private page line 9'));
    assert.equal(bbs.community.unread(bobId), 0);
    await bob.command('Q', 'EMAIL');
    await bob.command('Q', 'Main command:');

    await alice.command('C', 'CONFIG');
    await alice.command('R', 'Private value');
    await alice.command('Private Alice name', 'Saved.');
    await alice.command('L', 'Private value');
    await alice.command('Private Alice location', 'Saved.');
    await alice.command('N', 'Private value');
    await alice.command('Own socket stats note', 'Saved.');
    await alice.command('Q', 'Main command:');
    await alice.command('G', 'SIGNATURE');
    await alice.command('E', 'Text (signature');
    await alice.command('Socket signature', 'Saved.');
    await alice.command('Q', 'Main command:');
    await alice.command('M', '[W] Write');
    await alice.command('W', 'Subject (/abort');
    await alice.command('Signed public socket post', 'single . saves');
    await alice.command('Public socket body', '> ');
    await alice.command('.', '[W] Write');
    assert.equal(store.message(store.messages()[0].id).body, 'Public socket body\n-- \nSocket signature');
    await alice.command('Q', 'Main command:');

    await alice.command('O', 'AUTOMESSAGE');
    await alice.command('W', 'Text (signature');
    await alice.command('Socket automessage', 'Saved.');
    await alice.command('Q', 'Main command:');
    await alice.command('B', 'BBS');
    await alice.command('A', 'BBS name (40');
    await alice.command('Socket board', 'Address (100');
    await alice.command('tls://example.invalid:992', 'Saved.');
    await alice.command('N', 'PAGE 2');
    await alice.command('P', 'PAGE 1');
    await alice.command('Q', 'Main command:');
    await alice.command('I', 'ONELINERS');
    await alice.command('A', 'Text (signature');
    await alice.command('Socket oneliner', 'Saved.');
    await alice.command('Q', 'Main command:');
    await alice.command('S', 'Note line:');
    await alice.command('Authenticated private sysop note', 'Next line');
    await alice.command('.', 'Main command:');
    await alice.command('P', 'Reason (160');
    await alice.command('Socket page reason', 'Main command:');
    await alice.command('P', 'Reason (160');
    await alice.command('Cannot bypass page cooldown', 'Please wait');
    await alice.command('/abort', 'Main command:');
    await alice.command('T', 'Command:');
    assert.equal(bbs.community.publicStats(aliceId).calls, 1);
    assert.equal(bbs.community.stats(aliceId).user_note, 'Own socket stats note');
    assert.equal(alice.text().includes('Private Alice location'), false);
    await alice.command('Q', 'Main command:');

    await bob.command('U', '[Q] Main menu');
    assert.equal(bob.text().includes('Private Alice name'), false);
    assert.equal(bob.text().includes('Private Alice location'), false);
    assert.equal(bbs.community.automessage(bobId).body, 'Socket automessage');
    assert.equal(bbs.community.bbsList(bobId)[0].name, 'Socket board');
    assert.equal(bbs.community.oneliners(bobId)[0].body, 'Socket oneliner');
    assert.equal(bbs.community.notifications().length, 3);
    const page = bbs.community.notifications().find(row => row.kind === 'page');
    assert.equal(page.user_id, aliceId);
    assert.deepEqual(bbs.community.notification(page.id).body_lines, ['Socket page reason']);
    bbs.community.resolveNotification(page.id);
    assert.equal(bbs.community.notifications().length, 2);
    assert.deepEqual(errors, []);
  });

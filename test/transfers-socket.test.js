import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { fileURLToPath } from 'node:url';
import { createBbs as startBbs } from '../src/server.js';
import { hashPassword } from '../src/auth.js';
import { Transfers } from '../src/transfers.js';
import { ZTransfer } from '../src/transfer-zmodem.js';
import { QWK_ID, qwkMessage, zip, unzip } from '../src/transfer-qwk.js';
import { Presentation } from '../src/presentation.js';

// Never load the operator's private, Git-ignored ansi/ directory: its artwork
// can be large and is paced at 28.8k, making results machine-dependent.
const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));
const createBbs = options => startBbs({ ansiDirectory: samples, ...options });

function telnetBytes(bytes) {
  const out = [];
  for (const byte of bytes) {
    out.push(byte);
    if (byte === 255) out.push(255);
  }
  return Buffer.from(out);
}

async function connect(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let text = '', peer = null, state = 'data', failure;
  socket.on('error', error => { failure = error; });
  // Independent client-side telnet decoder; binary bytes never enter a line editor.
  socket.on('data', bytes => {
    for (const byte of bytes) {
      if (state === 'option') { state = 'data'; continue; }
      if (state === 'sub') { if (byte === 255) state = 'sub-iac'; continue; }
      if (state === 'sub-iac') { state = byte === 240 ? 'data' : 'sub'; continue; }
      if (state === 'iac') {
        state = 'data';
        if ([251, 252, 253, 254].includes(byte)) { state = 'option'; continue; }
        if (byte === 250) { state = 'sub'; continue; }
        if (byte !== 255) continue;
      } else if (byte === 255) { state = 'iac'; continue; }
      if (peer) {
        try { peer.feed(Buffer.from([byte])); }
        catch (error) { failure = error; peer = null; }
      } else text += String.fromCharCode(byte);
    }
  });
  await once(socket, 'connect');
  socket.write(Buffer.from([255, 253, 1, 255, 253, 3, 255, 251, 3]));
  const wait = async marker => {
    const deadline = Date.now() + (marker.includes('Press any key') ? 15000 : 5000);
    while (!text.includes(marker)) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, `Timed out waiting for ${marker}`);
      await delay(5);
    }
  };
  return {
    socket, wait, clear() { text = ''; }, send(command) { socket.write(`${command}\r\n`); },
    transfer(command, options) {
      text = '';
      return new Promise((resolveTransfer, reject) => {
        const timer = setTimeout(() => {
          peer = null;
          reject(failure ?? new Error('Socket transfer did not complete.'));
        }, 5000);
        peer = new ZTransfer({
          ...options, maxSize: 4 * 1024 * 1024,
          write: bytes => socket.write(telnetBytes(bytes)),
          complete: result => {
            peer = null;
            clearTimeout(timer);
            resolveTransfer(result);
          }
        });
        socket.write(`${command}\r\n`);
      });
    }
  };
}

test('real telnet file and QWK transfers preserve binary bytes, permissions, menus and durable counters', { timeout: 20000 }, async t => {
  const directory = resolve(`.transfer-socket-${randomUUID()}`);
  const files = join(directory, 'files'), database = join(directory, 'bbs.sqlite');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(files, { recursive: true });
  let store = new Store(database);
  const user = store.createUser('WireCaller', await hashPassword('unique transfer password!'));
  store.post(user, 'Public source', 'Line one\nLine two');
  const errors = [];
  const bbs = await createBbs({
    store, port: 0, transferDirectory: files, onError: error => errors.push(error)
  });
  let client;
  t.after(async () => {
    client?.socket.destroy();
    await bbs.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  client = await connect(Number(bbs.endpoints[0].split(':').at(-1)));
  const form = new Presentation(samples);
  await client.wait('Selection:');
  client.clear(); client.send('L');
  await client.wait(form.position('login', '|{LOGINHANDLE}') ?? 'Handle (');
  client.clear(); client.send('WireCaller');
  await client.wait(form.position('login', '|{LOGINPASSWORD}') ?? 'input hidden');
  client.clear(); client.send('unique transfer password!');
  await client.wait('Press any key');
  client.clear(); client.socket.write(' ');
  await client.wait('LAST CALLERS');
  await client.wait('Press any key');
  client.clear(); client.socket.write(' ');
  await client.wait('Main command:');
  client.clear(); client.send('F');
  await client.wait('FILE CATALOG');

  const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
  await client.transfer('U', { direction: 'send', file: { name: 'wire.bin', data: binary } });
  await client.wait('awaiting local sysop approval');
  const uploaded = bbs.transfers.sysopFiles()[0];
  assert.equal(uploaded.approved, 0);
  assert.throws(() => bbs.transfers.download(user, uploaded.id), /not found/);
  bbs.transfers.approve(uploaded.id);
  const downloaded = await client.transfer(`D ${uploaded.id}`, { direction: 'receive' });
  await client.wait('Download complete.');
  assert.deepEqual(downloaded.data, binary);
  assert.equal(downloaded.name, 'wire.bin');
  assert.equal(bbs.nodes()[0].state, 'transfer-files');
  assert.deepEqual({ ...bbs.transfers.stats(user) }, { uploads: 1, downloads: 1 });

  client.clear(); client.send('Q');
  await client.wait('Main command:');
  client.clear(); client.send('K');
  await client.wait('QWK offline mail');
  const qwk = await client.transfer('D', { direction: 'receive' });
  await client.wait('Download complete.');
  assert.equal(qwk.name, `${QWK_ID}.QWK`);
  const contents = unzip(qwk.data);
  assert.match(contents.get('CONTROL.DAT').toString('ascii'), /WireCaller/);
  assert.match(contents.get('MESSAGES.DAT').subarray(256).toString('latin1'), /Line one\xe3Line two/);
  const producer = Buffer.alloc(128, 32);
  producer.write(QWK_ID);
  const reply = zip([[`${QWK_ID}.MSG`, Buffer.concat([
    producer, qwkMessage({ base_id: 1, handle: 'Forged author', subject: 'Offline reply', body: 'Wire reply\nSecond line' }, true)
  ])]]);
  await client.transfer('U', { direction: 'send', file: { name: `${QWK_ID}.REP`, data: reply } });
  await client.wait('Imported 1 public replies.');
  assert.equal(store.messages()[0].subject, 'Offline reply');
  assert.equal(store.messages()[0].handle, 'WireCaller');
  assert.equal(store.message(store.messages()[0].id).body, 'Wire reply\nSecond line');
  assert.deepEqual({ ...bbs.transfers.stats(user) }, { uploads: 1, downloads: 1 });

  client.clear(); client.send('Q');
  await client.wait('Main command:');
  client.clear(); client.send('F');
  await client.wait('FILE CATALOG');
  client.clear(); client.send('U');
  await client.wait('Start your ZMODEM client');
  const closed = once(client.socket, 'close');
  client.socket.write(Buffer.alloc(5, 24));
  await closed;
  assert.deepEqual({ ...bbs.transfers.stats(user) }, { uploads: 1, downloads: 1 });
  assert.deepEqual(errors, []);
  await bbs.close();
  store.close();
  store = new Store(database);
  const reopened = new Transfers({ store, directory: files });
  assert.deepEqual({ ...reopened.stats(user) }, { uploads: 1, downloads: 1 });
  store.setUserDisabled(user, true);
  assert.throws(() => reopened.stats(user), /approved account/);
});

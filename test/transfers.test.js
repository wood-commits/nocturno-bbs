import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, rmSync, readdirSync, existsSync, constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { InputError } from '../src/validation.js';
import { plainText } from '../src/strings.js';
import { Transfers, initializeTransfers, TRANSFER_LIMITS } from '../src/transfers.js';
import { Z, ZParser, ZTransfer, zHeader, zData, crc16, crc32 } from '../src/transfer-zmodem.js';
import { QWK_ID, QWK_LIMIT, zip, unzip, qwkMessage, parseReplies } from '../src/transfer-qwk.js';

function fixture(t) {
  const directory = resolve(`.transfer-test-${randomUUID()}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(directory);
  const store = new Store(':memory:');
  initializeTransfers(store.db);
  const user = store.createUser('Caller_1', 'test-only-hash');
  const transfers = new Transfers({ store, directory });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, user, transfers, directory };
}

function rep(rows) {
  const producer = Buffer.alloc(128, 32);
  producer.write(QWK_ID);
  return zip([[`${QWK_ID}.MSG`, Buffer.concat([producer, ...rows.map(row => qwkMessage(row, true))])]]);
}

function session(f) {
  return {
    user: f.store.user(f.user), state: 'main', id: 1, output: [], binary: [],
    write(data) { this.output.push(data); },
    writeBinary(data) { this.binary.push(data); },
    disconnect(reason) { this.disconnected = reason; this.closed = true; },
    menu() { this.state = 'main'; },
    editor: { setRaw(callback) { this.raw = callback; } }
  };
}

test('ZMODEM reply completion distinguishes imported and approval-queued messages', async t => {
  const f = fixture(t), { store, user, transfers } = f;
  store.setModeration(1, true);
  const packet = rep([{ base_id: 1, subject: 'Offline moderated', body: 'Queued offline body', handle: 'Caller_1' }]);
  const s = session(f);
  t.after(() => transfers.cancel(s));
  transfers.menu(s, 'qwk');
  await transfers.handle(s, 'U');
  transfers.feed(s, Buffer.concat([
    zHeader(Z.ZFILE), zData(Buffer.from(`reply.rep\x00${packet.length}\0`)),
    zHeader(Z.ZDATA), zData(packet), zHeader(Z.ZEOF, packet.length), zHeader(Z.ZFIN), Buffer.from('OO')
  ]));
  assert.match(plainText(s.output.join('')), /Imported 1 replies; 1 queued for approval/);
  assert.equal(store.access.messages(user, 0, 1).length, 0);
  assert.equal(store.messages(0, 1, true).length, 1);
});

test('tightened byte ratios stop active downloads before sending more binary output', t => {
  const f = fixture(t), { store, user, transfers } = f;
  const own = transfers.save(user, 'credit.txt', Buffer.from('1234'));
  transfers.approve(own);
  const owner = store.createUser('OtherOwner', 'test-only-hash');
  const file = transfers.save(owner, 'large.bin', Buffer.from('12345678'));
  transfers.approve(file);
  const s = session(f);
  t.after(() => transfers.cancel(s));
  transfers.begin(s, { direction: 'send', kind: 'download', file: transfers.download(user, file) });
  const before = s.binary.length;
  store.limits.setDefaults({ download_ratio: 1, daily_minutes: 0 });
  transfers.feed(s, zHeader(Z.ZRINIT));
  assert.equal(s.binary.length, before);
  assert.equal(transfers.active.has(s), false);
  assert.match(plainText(s.disconnected), /Download ratio exceeded/);
  assert.equal(s.closed, true);
  assert.equal(store.limits.ratioUsage(user).downloaded_bytes, 8);
});

test('deleted uploaders keep approved files under a deleted identity without transferring ownership', t => {
  const { store, user, transfers } = fixture(t);
  const file = transfers.save(user, 'preserved.txt', Buffer.from('Preserved payload'));
  transfers.approve(file);
  store.deleteUser(user);
  const replacement = store.createUser('Caller_1', 'replacement-hash');
  assert.notEqual(replacement, user);
  assert.equal(transfers.catalog(replacement)[0].id, file);
  assert.equal(transfers.sysopFiles()[0].handle, `Deleted user #${user}`);
  assert.equal(transfers.download(replacement, file).data.toString(), 'Preserved payload');
  assert.equal(transfers.stats(replacement).uploads, 0);
  assert.throws(() => transfers.download(user, file), InputError);
  assert.throws(() => transfers.save(user, 'denied.txt', Buffer.from('Denied')), InputError);
});

test('file bases isolate catalogs and enforce independent live list/download/upload grants', async t => {
  const f = fixture(t), { store, user, transfers } = f;
  const base = store.access.createFileBase('Private files');
  const id = transfers.save(user, 'private.bin', Buffer.from('private bytes'), '', base);
  transfers.approve(id);
  const role = store.access.createRole('File reader');
  store.access.assign(user, role);
  assert.throws(() => transfers.catalog(user, 0, base), InputError);
  assert.throws(() => transfers.download(user, id), InputError);
  store.access.setFilePermissions(role, base, 1, 0, 0);
  assert.equal(transfers.catalog(user, 0, base)[0].id, id);
  assert.throws(() => transfers.download(user, id), InputError);
  assert.throws(() => transfers.save(user, 'denied', Buffer.from('x'), '', base), InputError);
  store.access.setFilePermissions(role, base, 1, 1, 1);
  assert.equal(transfers.download(user, id).data.toString(), 'private bytes');
  assert.throws(() => transfers.save(user, 'denied', Buffer.from('x'), '', base), InputError);
  store.access.setRolePermissions(role, 1, 0);
  assert.ok(transfers.save(user, 'allowed', Buffer.from('x'), '', base));
  store.access.setFilePermissions(role, base, 0, 1, 1);
  assert.throws(() => transfers.download(user, id), InputError);
  assert.throws(() => transfers.save(user, 'denied', Buffer.from('x'), '', base), InputError);
  const s = session(f);
  transfers.menu(s);
  assert.equal(s.state, 'transfer-bases');
  assert.ok(!plainText(s.output.join('')).includes('Private files'));
  store.access.setFilePermissions(role, base, 1, 1, 1);
  await transfers.handle(s, String(base));
  assert.equal(s.fileBaseId, base);
  assert.match(plainText(s.output.at(-1)), /private.bin/);
  transfers.move(id, 1);
  assert.equal(transfers.catalog(user, 0, base).length, 0);
  assert.throws(() => transfers.download(user, id), InputError);
  assert.equal(transfers.sysopFiles(0, 1)[0].id, id);
});

test('binary transfers capture upload base and stop before sending revoked file or QWK data', async t => {
  const f = fixture(t), { store, transfers } = f;
  const base = store.access.createFileBase('Uploads');
  const s = session(f);
  t.after(() => transfers.cancel(s));
  transfers.menu(s);
  await transfers.handle(s, 'B');
  await transfers.handle(s, String(base));
  await transfers.handle(s, 'U');
  s.fileBaseId = 1;
  transfers.feed(s, Buffer.concat([
    zHeader(Z.ZFILE), zData(Buffer.from('captured.bin\x001\0')), zHeader(Z.ZDATA),
    zData(Buffer.from('x')), zHeader(Z.ZEOF, 1), zHeader(Z.ZFIN), Buffer.from('OO')
  ]));
  const uploaded = transfers.sysopFiles()[0];
  assert.equal(uploaded.base_id, base);
  transfers.approve(uploaded.id);
  await transfers.handle(s, `D ${uploaded.id}`);
  const sentBefore = s.binary.length;
  store.access.setFilePermissions(1, base, 1, 0, 1);
  transfers.feed(s, zHeader(Z.ZRINIT));
  assert.match(plainText(s.disconnected), /permission denied/);
  assert.equal(s.binary.length, sentBefore);
  assert.equal(transfers.active.size, 0);

  const q = session(f);
  t.after(() => transfers.cancel(q));
  transfers.menu(q, 'qwk');
  await transfers.handle(q, 'D');
  const qwkSent = q.binary.length;
  store.access.setMessagePermissions(1, 1, 0, 0);
  transfers.feed(q, zHeader(Z.ZRINIT));
  assert.match(plainText(q.disconnected), /permission denied/);
  assert.equal(q.binary.length, qwkSent);
  assert.equal(transfers.active.size, 0);
});

test('revoking base upload permission during a binary upload prevents persistence', async t => {
  const f = fixture(t), s = session(f);
  t.after(() => f.transfers.cancel(s));
  f.transfers.menu(s);
  await f.transfers.handle(s, 'U');
  f.store.access.setFilePermissions(1, 1, 1, 1, 0);
  f.transfers.feed(s, Buffer.concat([
    zHeader(Z.ZFILE), zData(Buffer.from('denied.bin\x001\0')), zHeader(Z.ZDATA),
    zData(Buffer.from('x')), zHeader(Z.ZEOF, 1), zHeader(Z.ZFIN), Buffer.from('OO')
  ]));
  assert.match(plainText(s.disconnected), /permission denied/);
  assert.equal(f.transfers.sysopFiles().length, 0);
  assert.equal(f.transfers.active.size, 0);
});

test('QWK excludes inaccessible conferences before limiting posts and imports replies atomically', t => {
  const f = fixture(t), { store, user, transfers } = f;
  const secret = store.createBase('Secret conference');
  store.post(user, 'Visible subject', 'Visible body');
  for (let index = 0; index < 101; index++) store.post(user, `Hidden ${index}`, 'Secret content', secret);
  const role = store.access.createRole('Offline reader');
  store.access.setRolePermissions(role, 1, 0);
  store.access.setMessagePermissions(role, 1, 1, 1);
  store.access.assign(user, role);
  const packet = unzip(transfers.qwk(user));
  assert.ok(!packet.get('CONTROL.DAT').includes(Buffer.from('Secret conference')));
  const messages = packet.get('MESSAGES.DAT').toString('ascii');
  assert.ok(messages.includes('Visible subject'));
  assert.ok(!messages.includes('Hidden'));
  assert.ok(!messages.includes('Secret content'));
  assert.equal(packet.has(`${secret}.NDX`), false);
  const before = store.stats().messages;
  assert.throws(() => transfers.importReplies(user, rep([
    { base_id: 1, subject: 'Allowed reply', body: 'Body' },
    { base_id: secret, subject: 'Denied reply', body: 'Body' }
  ])), InputError);
  assert.equal(store.stats().messages, before);
  store.access.setMessagePermissions(role, secret, 1, 0);
  assert.throws(() => transfers.importReplies(user, rep([
    { base_id: secret, subject: 'Read only', body: 'Body' }
  ])), InputError);
  store.access.setMessagePermissions(role, 1, 0, 0);
  store.access.setMessagePermissions(role, secret, 0, 0);
  assert.throws(() => transfers.qwk(user), InputError);
});

test('ZMODEM framing uses standard CRC16/XMODEM and IEEE CRC32 vectors', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x31c3);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(zHeader(Z.ZRINIT, 0x23000000).toString('latin1'), '**\x18B0100000023be50\r\n\x11');
  // Golden wire CRCs also checked independently with Python binascii.crc_hqx/zlib.crc32.
  assert.equal(zData(Buffer.from('123456789')).toString('hex'), '313233343536373839186b38bf11');
  assert.equal(zData(Buffer.from('123456789'), Z.ZCRCW, 'crc32').toString('hex'), '313233343536373839186b18d926a4da11');
  assert.equal(zHeader(Z.ZDATA, 0x78563412, 'crc16').toString('hex'), '2a1841184a1852345678f218c2');
  assert.equal(zHeader(Z.ZDATA, 0x78563412, 'crc32').toString('hex'), '2a1843184a1852345678383edfe7');
  for (const format of ['hex', 'crc16', 'crc32']) {
    const headers = [], packets = [];
    const parser = new ZParser({
      header(type, position, encoding) { headers.push([type, position]); parser.expectData(encoding); },
      data(bytes, end) { packets.push([bytes, end]); }
    });
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const frame = Buffer.concat([zHeader(Z.ZDATA, 0x78563412, format), zData(bytes, Z.ZCRCW, format === 'crc32' ? 'crc32' : 'crc16')]);
    for (const byte of frame) parser.feed(Buffer.from([byte]));
    assert.deepEqual(headers, [[Z.ZDATA, 0x78563412]]);
    assert.deepEqual(packets, [[bytes, Z.ZCRCW]]);
  }
});

test('ZMODEM parser rejects corrupted CRC, invalid escapes, oversize packets and cancellation', () => {
  const make = () => new ZParser({ header() {}, data() {} });
  const header = zHeader(Z.ZDATA);
  header[7] = header[7] === 48 ? 49 : 48;
  assert.throws(() => make().feed(header), /CRC mismatch/);
  const parser = make();
  parser.expectData('crc16');
  const data = zData(Buffer.from('hello'));
  data[0] ^= 1;
  assert.throws(() => parser.feed(data), /CRC mismatch/);
  const escape = make();
  escape.expectData('crc16');
  assert.throws(() => escape.feed(Buffer.from([24, 1])), /escape/);
  const large = make();
  large.expectData('crc16');
  assert.throws(() => large.feed(Buffer.alloc(8193, 65)), /too large/);
  assert.throws(() => make().feed(Buffer.alloc(5, 24)), /cancelled/);
  assert.throws(() => make().feed(Buffer.alloc(8200, 65)), /framing noise/);
});

test('ZMODEM sender and receiver exchange binary files with fragmented stop-and-wait frames', () => {
  for (const size of [1, 1024, 1025, 16384]) {
    const file = Buffer.from(Array.from({ length: size }, (_, i) => i % 256));
    const queue = [];
    let uploaded, sent = false;
    const sender = new ZTransfer({
      direction: 'send', file: { name: 'binary.dat', data: file }, maxSize: 65536,
      write: bytes => queue.push(['receiver', bytes]), complete: () => { sent = true; }
    });
    const receiver = new ZTransfer({
      direction: 'receive', maxSize: 65536,
      write: bytes => queue.push(['sender', bytes]), complete: result => { uploaded = result; }
    });
    sender.start();
    receiver.start();
    let frames = 0;
    while (queue.length) {
      assert.ok(++frames < 200);
      const [target, bytes] = queue.shift();
      const protocol = target === 'sender' ? sender : receiver;
      for (let i = 0; i < bytes.length; i += 3) protocol.feed(bytes.subarray(i, i + 3));
    }
    assert.equal(sent, true);
    assert.equal(uploaded.name, 'binary.dat');
    assert.deepEqual(uploaded.data, file);
    assert.equal(receiver.phase, 'done');
  }
});

test('ZMODEM receiver accepts streaming CRC32 frames and rejects paths, sizes and truncation', () => {
  let uploaded;
  const receiver = new ZTransfer({ direction: 'receive', maxSize: 1024, write() {}, complete: result => { uploaded = result; } });
  const bytes = Buffer.from([0, 13, 10, 255, 24, 17, 128, 254]);
  const frames = [
    zHeader(Z.ZFILE, 0, 'crc32'), zData(Buffer.from('stream.bin\x008 0\0'), Z.ZCRCW, 'crc32'),
    zHeader(Z.ZDATA, 0, 'crc32'),
    zData(bytes.subarray(0, 4), Z.ZCRCG, 'crc32'), zData(bytes.subarray(4), Z.ZCRCE, 'crc32'),
    zHeader(Z.ZEOF, bytes.length), zHeader(Z.ZFIN), Buffer.from('OO')
  ];
  receiver.feed(Buffer.concat(frames));
  assert.deepEqual(uploaded.data, bytes);
  for (const metadata of ['../file\x001\0', 'a.bin\x001025\0', 'a.bin\0unknown\0', 'C:\\file\x001\0']) {
    const bad = new ZTransfer({ direction: 'receive', maxSize: 1024, write() {}, complete() {} });
    assert.throws(() => bad.feed(Buffer.concat([zHeader(Z.ZFILE), zData(Buffer.from(metadata))])), InputError);
  }
  const short = new ZTransfer({ direction: 'receive', maxSize: 1024, write() {}, complete() {} });
  short.feed(Buffer.concat([zHeader(Z.ZFILE), zData(Buffer.from('a.bin\x0010\0'))]));
  assert.throws(() => short.feed(zHeader(Z.ZEOF, 0)), /size mismatch/);
});

test('file catalog quarantines uploads; storage validates identity, paths, permissions and removal', t => {
  const f = fixture(t), bytes = Buffer.from([0, 255, 13, 10, 24]);
  const id = f.transfers.save(f.user, 'safe.dat', bytes, 'A binary file');
  assert.equal(f.transfers.catalog(f.user).length, 0);
  assert.equal(f.transfers.sysopFiles()[0].approved, 0);
  assert.throws(() => f.transfers.download(f.user, id), InputError);
  f.transfers.approve(id);
  assert.deepEqual(f.transfers.download(f.user, id).data, bytes);
  assert.equal(f.transfers.catalog(f.user)[0].name, 'safe.dat');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.match(readdirSync(f.directory)[0], /^[0-9a-f-]{36}\.bin$/);
  for (const name of ['../file', 'C:\\file', '.dot', 'a..b', 'a\x1b.bin']) {
    assert.throws(() => f.transfers.save(f.user, name, bytes), InputError);
  }
  assert.throws(() => f.transfers.save(f.user, 'empty', Buffer.alloc(0)), InputError);
  assert.throws(() => f.transfers.save(f.user, 'large', Buffer.alloc(TRANSFER_LIMITS.file + 1)), InputError);
  assert.throws(() => f.transfers.save(999, 'a', bytes), InputError);
  f.store.editUser(f.user, 'can_post', 0);
  assert.throws(() => f.transfers.save(f.user, 'a', bytes), /permission/);
  assert.deepEqual(f.transfers.download(f.user, id).data, bytes);
  f.store.editUser(f.user, 'can_post', 1);
  f.transfers.remove(id);
  assert.throws(() => f.transfers.download(f.user, id), /not found/);
  assert.equal(f.transfers.catalog(f.user).length, 0);
  const replacement = f.transfers.save(f.user, 'next', bytes);
  assert.ok(replacement > id);
});

test('downloads validate the opened file identity before reading and always close it', async t => {
  for (const scenario of ['valid', 'replaced inode', 'replaced device', 'symlink', 'unknown identity',
    'wrong size', 'non-file', 'missing entry', 'open rejected', 'descriptor error', 'read error', 'short read']) {
    await t.test(scenario, t => {
      const f = fixture(t), bytes = Buffer.from('approved bytes');
      const id = f.transfers.save(f.user, 'safe.dat', bytes);
      f.transfers.approve(id);
      const path = f.transfers.storagePath(f.store.db.prepare('SELECT storage_key FROM transfer_files WHERE id = ?').get(id).storage_key);
      const original = { openSync: fs.openSync, lstatSync: fs.lstatSync,
        fstatSync: fs.fstatSync, readSync: fs.readSync, closeSync: fs.closeSync };
      const calls = [];
      let opened;
      t.mock.method(fs, 'openSync', (target, flags) => {
        assert.equal(target, path);
        assert.equal(flags, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        calls.push('open');
        if (scenario === 'open rejected') throw Object.assign(new Error('Symlink rejected'), { code: 'ELOOP' });
        // Emulate a filesystem without O_NOFOLLOW, regardless of the test host.
        opened = original.openSync(target, constants.O_RDONLY);
        return opened;
      });
      t.mock.method(fs, 'fstatSync', (fd, options) => {
        assert.equal(fd, opened);
        calls.push('descriptor');
        if (scenario === 'descriptor error') throw Object.assign(new Error('Descriptor unavailable'), { code: 'EIO' });
        const stat = original.fstatSync(fd, options);
        if (scenario === 'unknown identity') stat.ino = 0n;
        if (scenario === 'wrong size') stat.size += 1n;
        if (scenario === 'non-file') stat.isFile = () => false;
        return stat;
      });
      t.mock.method(fs, 'lstatSync', (target, options) => {
        const stat = original.lstatSync(target, options);
        if (target !== path) return stat;
        assert.ok(opened !== undefined, 'No pathname check before open');
        calls.push('entry');
        if (scenario === 'missing entry') throw Object.assign(new Error('Removed after open'), { code: 'ENOENT' });
        if (scenario === 'replaced inode') stat.ino += 1n;
        if (scenario === 'replaced device') stat.dev += 1n;
        if (scenario === 'symlink') {
          stat.isFile = () => false;
          stat.isSymbolicLink = () => true;
        }
        return stat;
      });
      t.mock.method(fs, 'readSync', (...args) => {
        calls.push('read');
        if (scenario === 'read error') throw Object.assign(new Error('Read failed'), { code: 'EIO' });
        if (scenario === 'short read') return 0;
        return original.readSync(...args);
      });
      t.mock.method(fs, 'closeSync', fd => {
        calls.push('close');
        return original.closeSync(fd);
      });
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      syncBuiltinESMExports();
      if (scenario === 'valid') {
        assert.deepEqual(f.transfers.download(f.user, id).data, bytes);
        assert.deepEqual(calls, ['open', 'descriptor', 'entry', 'read', 'close']);
      } else {
        const expected = scenario === 'missing entry' ? { code: 'ENOENT' } :
          scenario === 'open rejected' ? { code: 'ELOOP' } :
            scenario === 'descriptor error' || scenario === 'read error' ? { code: 'EIO' } : InputError;
        assert.throws(() => f.transfers.download(f.user, id), expected);
        assert.deepEqual(calls, scenario === 'open rejected' ? ['open'] :
          scenario === 'descriptor error' ? ['open', 'descriptor', 'close'] :
            scenario === 'read error' || scenario === 'short read' ? ['open', 'descriptor', 'entry', 'read', 'close'] :
              ['open', 'descriptor', 'entry', 'close']);
      }
    });
  }
});

test('ZIP stored archives interoperate with directory metadata and reject CRC, traversal and bombs', () => {
  const archived = zip([['TEST.DAT', Buffer.from('hello')]]);
  assert.equal(unzip(archived).get('TEST.DAT').toString(), 'hello');
  const crcBad = Buffer.from(archived);
  crcBad[38] ^= 1;
  assert.throws(() => unzip(crcBad), /CRC/);
  assert.throws(() => unzip(zip([['../A.DAT', Buffer.from('a')]])), /filename/);
  assert.throws(() => unzip(zip([['A.DAT', Buffer.from('a')], ['a.dat', Buffer.from('b')]])), /duplicate/);
  assert.throws(() => unzip(Buffer.alloc(QWK_LIMIT + 1)), InputError);
  const compressed = deflateRawSync(Buffer.from('hello'));
  const deflated = Buffer.concat([archived.subarray(0, 38), compressed, archived.subarray(43)]);
  const directory = 38 + compressed.length;
  deflated.writeUInt16LE(8, 8);
  deflated.writeUInt32LE(compressed.length, 18);
  deflated.writeUInt16LE(8, directory + 10);
  deflated.writeUInt32LE(compressed.length, directory + 20);
  deflated.writeUInt32LE(directory, deflated.length - 6);
  assert.equal(unzip(deflated).get('TEST.DAT').toString(), 'hello');
  deflated.writeUInt32LE(QWK_LIMIT + 1, directory + 24);
  assert.throws(() => unzip(deflated), /oversized/);
});

test('QWK export has standard 128-byte headers, conferences and 0xE3 lines; REP imports atomically', t => {
  const f = fixture(t);
  const base = f.store.createBase('Other', 'More public posts');
  f.store.post(f.user, 'Hello', 'First line\nSecond line', base);
  const exported = unzip(f.transfers.qwk(f.user));
  const control = exported.get('CONTROL.DAT').toString('ascii');
  assert.match(control, /0,NOCTURNO\r\n/);
  assert.match(control, /Other\r\n/);
  assert.match(control.split('\r\n')[5], /^\d{2}-\d{2}-\d{4},\d{2}:\d{2}:\d{2}$/);
  assert.ok(!control.replace(/\r\n/g, '').includes('\n'));
  const messages = exported.get('MESSAGES.DAT'), header = messages.subarray(128, 256);
  assert.equal(QWK_ID, 'NOCTURNO');
  assert.equal(messages.subarray(0, 128).toString('ascii').trim(), 'Produced by Nocturno BBS');
  assert.equal(messages.length % 128, 0);
  assert.equal(header.subarray(71, 96).toString().trim(), 'Hello');
  assert.equal(header.readUInt16LE(123), base);
  assert.equal(header[122], 0xe1);
  assert.equal(messages.subarray(256).includes(0xe3), true);
  assert.deepEqual(exported.get(`${base}.NDX`), Buffer.from([0, 0, 0, 130, 0]));
  assert.equal(exported.get('PERSONAL.NDX').length, 0);
  const rows = [
    { base_id: 1, subject: 'Reply one', body: 'One\nTwo', handle: 'ForgedSender' },
    { base_id: base, subject: 'Reply two', body: 'Other base', handle: 'AnotherSender' }
  ];
  assert.equal(parseReplies(rep(rows)).length, 2);
  assert.equal(f.transfers.importReplies(f.user, rep(rows)), 2);
  assert.equal(f.store.messages(0, base)[0].handle, 'Caller_1');
  assert.equal(f.store.message(f.store.messages(0, 1)[0].id).body, 'One\nTwo');
  const before = f.store.stats().messages;
  rows[1].base_id = 999;
  assert.throws(() => f.transfers.importReplies(f.user, rep(rows)), /base not found/);
  assert.equal(f.store.stats().messages, before);
  f.store.editUser(f.user, 'can_post', 0);
  assert.throws(() => f.transfers.importReplies(f.user, rep(rows)), /permission/);
});

test('QWK replies retain legacy packet compatibility without accepting mismatched board IDs', t => {
  const f = fixture(t);
  const row = { base_id: 1, subject: 'Legacy reply', body: 'Preserved offline work', handle: 'Caller' };
  for (const packetId of ['NOCTURNO', 'NIGHTWIR']) {
    const producer = Buffer.alloc(128, 32);
    producer.write(packetId);
    const packet = zip([[`${packetId}.MSG`, Buffer.concat([producer, qwkMessage(row, true)])]]);
    assert.deepEqual(parseReplies(packet), [{ baseId: 1, subject: row.subject, body: row.body }]);
    producer.fill(32);
    producer.write(packetId === 'NOCTURNO' ? 'NIGHTWIR' : 'NOCTURNO');
    const mismatched = zip([[`${packetId}.MSG`, Buffer.concat([producer, qwkMessage(row, true)])]]);
    assert.throws(() => parseReplies(mismatched), /different BBS/);
  }
  const producer = Buffer.alloc(128, 32);
  producer.write('NIGHTWIR');
  const legacy = zip([['NIGHTWIR.MSG', Buffer.concat([producer, qwkMessage(row, true)])]]);
  assert.equal(f.transfers.importReplies(f.user, legacy), 1);
  assert.equal(f.store.message(f.store.messages()[0].id).body, row.body);
  f.store.editUser(f.user, 'can_post', 0);
  assert.throws(() => f.transfers.importReplies(f.user, legacy), /permission/);
});

test('QWK reply parser rejects private, malformed, control-injected and excessive messages', () => {
  const row = { base_id: 1, subject: 'Reply', body: 'Body', handle: 'Caller' };
  const producer = Buffer.alloc(128, 32);
  producer.write(QWK_ID);
  for (const change of [
    h => { h[0] = 42; }, h => { h[0] = 43; }, h => { h[122] = 0; },
    h => { h.write('999999', 116); }, h => { h.writeUInt16LE(2, 123); },
    h => { h[71] = 27; }, h => { h[128] = 27; }
  ]) {
    const message = qwkMessage(row, true);
    change(message);
    const packet = zip([[`${QWK_ID}.MSG`, Buffer.concat([producer, message])]]);
    assert.throws(() => parseReplies(packet), InputError);
  }
  assert.throws(() => parseReplies(rep(Array(101).fill(row))), /100 replies/);
  assert.throws(() => parseReplies(zip([['OTHER.MSG', producer]])), /must contain/);
});

test('transfer menus start raw binary mode, import uploads and disconnect corrupted streams', async t => {
  const f = fixture(t), s = session(f);
  f.transfers.menu(s, 'files');
  assert.equal(await f.transfers.handle(s, 'U'), true);
  assert.equal(s.state, 'transfer-binary');
  assert.equal(s.transferRaw, true);
  assert.equal(typeof s.editor.raw, 'function');
  const bytes = Buffer.from([0, 255, 17, 24]);
  const frame = Buffer.concat([
    zHeader(Z.ZFILE), zData(Buffer.from('upload.bin\x004\0')), zHeader(Z.ZDATA),
    zData(bytes), zHeader(Z.ZEOF, 4), zHeader(Z.ZFIN), Buffer.from('OO')
  ]);
  for (const byte of frame) f.transfers.feed(s, Buffer.from([byte]));
  assert.equal(s.state, 'transfer-files');
  assert.equal(s.editor.raw, null);
  assert.equal(s.transferRaw, false);
  assert.equal(f.transfers.active.size, 0);
  assert.equal(f.transfers.sysopFiles()[0].name, 'upload.bin');
  assert.match(s.output.join(''), /awaiting local sysop approval/);
  assert.ok(s.output.at(-1).startsWith('\x1b[0m\x1b[2J\x1b[H'));
  assert.match(s.output.at(-1), /awaiting local sysop approval/);
  await f.transfers.handle(s, 'U');
  f.transfers.feed(s, Buffer.alloc(5, 24));
  assert.match(plainText(s.disconnected), /cancelled/);
  assert.equal(f.transfers.active.size, 0);
});

test('binary hooks recheck permissions and bound active transfer count', async t => {
  const f = fixture(t), sessions = Array.from({ length: 5 }, () => session(f));
  t.after(() => { for (const s of sessions) f.transfers.cancel(s); });
  for (const s of sessions.slice(0, 4)) {
    f.transfers.menu(s, 'qwk');
    await f.transfers.handle(s, 'U');
  }
  f.transfers.menu(sessions[4], 'qwk');
  await assert.rejects(() => f.transfers.handle(sessions[4], 'U'), /capacity/);
  f.store.editUser(f.user, 'can_post', 0);
  f.transfers.feed(sessions[0], Buffer.from([42]));
  assert.match(plainText(sessions[0].disconnected), /permission/);
  assert.equal(f.transfers.active.size, 3);
});

test('transfers enforce idle and absolute deadlines and release raw mode on cleanup', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const idle = session(f);
  f.transfers.menu(idle);
  await f.transfers.handle(idle, 'U');
  t.mock.timers.tick(TRANSFER_LIMITS.idleMs + 1);
  assert.match(plainText(idle.disconnected), /idle timeout/);
  assert.equal(idle.transferRaw, false);
  const absolute = session(f);
  f.transfers.menu(absolute);
  await f.transfers.handle(absolute, 'U');
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(20000);
    f.transfers.feed(absolute, Buffer.from([65]));
  }
  t.mock.timers.tick(20001);
  assert.match(plainText(absolute.disconnected), /time limit/);
  assert.equal(f.transfers.active.size, 0);
});

test('file quotas count retained IDs and live bytes before writing disk content', t => {
  const f = fixture(t);
  f.store.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 16)
    INSERT INTO transfer_files(user_id, name, storage_key, size, created_at)
    SELECT ?, 'quota', 'quota-' || i, 4194304, '2026-01-01' FROM n`).run(f.user);
  assert.throws(() => f.transfers.save(f.user, 'a', Buffer.from('a')), /full/);
  f.store.db.exec('DELETE FROM transfer_files');
  f.store.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000)
    INSERT INTO transfer_files(user_id, name, storage_key, size, removed, created_at)
    SELECT ?, '', 'retained-' || i, 1, 1, '2026-01-01' FROM n`).run(f.user);
  assert.throws(() => f.transfers.save(f.user, 'a', Buffer.from('a')), /full/);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(readdirSync(f.directory).length, 0);
});

test('outgoing fallback escapes IAC and unauthenticated menus are rejected safely', async t => {
  const f = fixture(t), s = session(f);
  assert.throws(() => f.transfers.menu({ user: null }), InputError);
  delete s.writeBinary;
  f.transfers.menu(s);
  const id = f.transfers.save(f.user, 'iac.bin', Buffer.from([255, 24]));
  f.transfers.approve(id);
  await f.transfers.handle(s, `D ${id}`);
  t.after(() => f.transfers.cancel(s));
  f.transfers.feed(s, zHeader(Z.ZRINIT));
  f.transfers.feed(s, zHeader(Z.ZRPOS));
  const output = s.output.filter(Buffer.isBuffer);
  // ZMODEM quotes 0xff as ZDLE/ZRUB1, so it remains binary-safe even before telnet doubling.
  assert.ok(output.some(buffer => buffer.includes(Buffer.from([24, 109]))));
  for (const buffer of output) {
    for (let i = 0; i < buffer.length; i++) if (buffer[i] === 255) assert.equal(buffer[++i], 255);
  }
});

test('per-user file statistics retain uploads and count only completed catalog downloads', async t => {
  const f = fixture(t), s = session(f);
  assert.deepEqual({ ...f.transfers.stats(f.user) }, { uploads: 0, downloads: 0 });
  const id = f.transfers.save(f.user, 'count.bin', Buffer.from('abc'));
  f.transfers.approve(id);
  f.transfers.download(f.user, id);
  assert.deepEqual({ ...f.transfers.stats(f.user) }, { uploads: 1, downloads: 0 });
  f.transfers.menu(s);
  await f.transfers.handle(s, `D ${id}`);
  f.transfers.feed(s, zHeader(Z.ZRINIT));
  f.transfers.feed(s, zHeader(Z.ZRPOS));
  f.transfers.feed(s, Buffer.alloc(5, 24));
  assert.match(plainText(s.disconnected), /cancelled/);
  assert.deepEqual({ ...f.transfers.stats(f.user) }, { uploads: 1, downloads: 0 });
  s.closed = false;
  f.transfers.menu(s);
  await f.transfers.handle(s, `D ${id}`);
  t.after(() => f.transfers.cancel(s));
  for (const header of [
    zHeader(Z.ZRINIT), zHeader(Z.ZRPOS), zHeader(Z.ZACK, 3), zHeader(Z.ZRINIT), zHeader(Z.ZFIN)
  ]) f.transfers.feed(s, header);
  assert.equal(s.state, 'transfer-files');
  assert.deepEqual({ ...f.transfers.stats(f.user) }, { uploads: 1, downloads: 1 });
  f.transfers.remove(id);
  assert.deepEqual({ ...f.transfers.stats(f.user) }, { uploads: 1, downloads: 1 });
  const another = new Transfers({ store: f.store, directory: f.directory });
  assert.deepEqual({ ...another.stats(f.user) }, { uploads: 1, downloads: 1 });
  assert.throws(() => f.transfers.stats(999), InputError);
  f.store.db.prepare("UPDATE users SET application_status = 'pending' WHERE id = ?").run(f.user);
  assert.throws(() => f.transfers.stats(f.user), /approved account/);
});

test('transfer storage directory is created only when saving a permitted upload', t => {
  const f = fixture(t), directory = resolve(f.directory, 'lazy-files');
  const transfers = new Transfers({ store: f.store, directory });
  transfers.stats(f.user);
  transfers.catalog(f.user);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(existsSync(directory), false);
  f.store.editUser(f.user, 'can_post', 0);
  assert.throws(() => transfers.save(f.user, 'test.bin', Buffer.from('data')), /permission/);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(existsSync(directory), false);
  f.store.editUser(f.user, 'can_post', 1);
  transfers.save(f.user, 'test.bin', Buffer.from('data'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(existsSync(directory), true);
});

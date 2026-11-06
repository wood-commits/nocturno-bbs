import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers';
import { Store } from '../src/store.js';
import { Transfers } from '../src/transfers.js';
import { Session } from '../src/session.js';
import { LocalSocket } from '../src/local-terminal.js';
import { plainText, ui } from '../src/strings.js';

function fixture(t, filename = ':memory:') {
  const directory = resolve(`.file-scan-test-${randomUUID()}`);
  // Isolated temporary payload directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(directory);
  const store = new Store(filename);
  store.initSettings('Test BBS');
  const transfers = new Transfers({ store, directory });
  const uploader = store.createUser('Uploader', 'test-only-hash');
  const reader = store.createUser('Reader', 'test-only-hash');
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const upload = (name, baseId = 1, approve = true) => {
    const id = Number(transfers.save(uploader, name, Buffer.from(name), `About ${name}`, baseId));
    if (approve) transfers.approve(id);
    return id;
  };
  return { store, transfers, uploader, reader, upload };
}

function caller(f) {
  return {
    user: f.store.user(f.reader), state: 'main', id: 1, output: [],
    write(data) { this.output.push(data); },
    menu() { this.state = 'main'; },
    screen() { const text = plainText(this.output.join('')); this.output.length = 0; return text; }
  };
}

test('new files follow approval order and only shown batches are marked seen', t => {
  const f = fixture(t), { store, transfers, reader } = f;
  const late = f.upload('LATE.TXT', 1, false);
  const early = f.upload('EARLY.TXT');
  transfers.approve(late);
  // A later approval is newer even though its ID is older.
  assert.deepEqual(store.access.newFiles(reader).map(row => row.id), [early, late]);
  assert.equal(store.access.fileUnreadCounts(reader).get(1), 2);
  const shown = store.access.newFiles(reader, 1);
  assert.equal(store.access.newFiles(reader).length, 2, 'Listing alone never marks files seen');
  const after = f.upload('AFTER.TXT');
  store.access.markFilesSeen(reader, shown);
  assert.deepEqual(store.access.newFiles(reader).map(row => row.id), [late, after]);
  // Re-approving keeps the position; unapproval withdraws the file from the scan.
  transfers.approve(late);
  assert.deepEqual(store.access.newFiles(reader).map(row => row.id), [late, after]);
  transfers.approve(after, false);
  assert.deepEqual(store.access.newFiles(reader).map(row => row.id), [late]);
  transfers.remove(late);
  assert.deepEqual(store.access.newFiles(reader), []);
  assert.equal(store.db.prepare('SELECT scan_seq FROM transfer_files WHERE id = ?').get(late).scan_seq, null);
  transfers.approve(after);
  assert.deepEqual(store.access.newFiles(reader).map(row => row.id), [after], 'Re-approval is new again');
  // Pointers belong to the caller.
  assert.equal(store.access.newFiles(f.uploader).length, 2);
});

test('new-file scans honor live list grants, catch up and user deletion', t => {
  const f = fixture(t), { store, reader } = f;
  const hidden = store.access.createFileBase('Hidden', 'Restricted');
  f.upload('PUBLIC.TXT');
  const secret = f.upload('SECRET.TXT', hidden);
  store.access.setFilePermissions(1, hidden, 0, 0, 0);
  assert.deepEqual(store.access.newFiles(reader).map(row => row.name), ['PUBLIC.TXT']);
  assert.equal(store.access.fileUnreadCounts(reader).get(hidden), undefined);
  store.access.fileCatchUp(reader);
  assert.deepEqual(store.access.newFiles(reader), []);
  // Catching up never advances a denied base, so restored access still shows its files.
  store.access.setFilePermissions(1, hidden, 1, 1, 1);
  assert.deepEqual(store.access.newFiles(reader).map(row => row.id), [secret]);
  assert.equal(store.access.newFiles(reader)[0].base_name, 'Hidden');
  store.access.markFilesSeen(reader, store.access.newFiles(reader));
  assert.ok(store.db.prepare('SELECT count(*) AS n FROM file_reads WHERE user_id = ?').get(reader).n > 0);
  store.deleteUser(reader);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM file_reads WHERE user_id = ?').get(reader).n, 0);
  assert.throws(() => store.access.newFiles(reader));
});

test('existing approved files migrate to the scan once in ID order', t => {
  const folder = mkdtempSync(join(tmpdir(), 'nocturno-file-scan-'));
  const filename = join(folder, 'bbs.sqlite');
  const f = fixture(t, filename);
  const first = f.upload('FIRST.TXT');
  f.upload('PENDING.TXT', 1, false);
  const second = f.upload('SECOND.TXT');
  // Simulate a database from before scan_seq existed.
  f.store.db.exec('DROP INDEX transfer_files_scan; ALTER TABLE transfer_files DROP COLUMN scan_seq; DROP TABLE file_reads;');
  f.store.close();
  const store = new Store(filename);
  // After hooks run in order: close SQLite before Windows can remove its folder.
  t.after(() => store.close());
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.deepEqual(store.db.prepare('SELECT id, scan_seq FROM transfer_files ORDER BY id').all().map(row => ({ ...row })),
    [{ id: first, scan_seq: first }, { id: first + 1, scan_seq: null }, { id: second, scan_seq: second }]);
  assert.deepEqual(store.access.newFiles(f.reader).map(row => row.id), [first, second]);
});

test('files menu S scans new files; N and Q mark only the rendered batch', async t => {
  const f = fixture(t), { store, transfers } = f;
  for (let i = 1; i <= 12; i++) f.upload(`FILE${String(i).padStart(2, '0')}.TXT`);
  const s = caller(f);
  transfers.menu(s, 'files');
  assert.match(s.screen(), /\[S\] Scan new files/);
  await transfers.handle(s, 'B');
  assert.match(s.screen(), /General.*\(12 new\)/);
  await transfers.handle(s, 'S');
  assert.equal(s.state, 'transfer-new');
  let screen = s.screen();
  assert.match(screen, /New files since your last scan/);
  assert.ok(screen.includes('FILE01.TXT') && screen.includes('FILE10.TXT') && !screen.includes('FILE11.TXT'));
  assert.match(screen, /\d+ General FILE01\.TXT 10 bytes About FILE01\.TXT/);
  // A redraw (for example after a download) repeats the same unmarked batch.
  await transfers.handle(s, '');
  assert.ok(s.screen().includes('FILE01.TXT'));
  f.upload('LATE.TXT');
  await transfers.handle(s, 'N');
  screen = s.screen();
  assert.ok(!screen.includes('FILE10.TXT') && screen.includes('FILE11.TXT') && screen.includes('LATE.TXT'));
  await transfers.handle(s, 'Q');
  assert.equal(s.state, 'transfer-files');
  s.output.length = 0;
  await transfers.handle(s, 'S');
  assert.match(s.screen(), /No new files\./);
  f.upload('NEWEST.TXT');
  await transfers.handle(s, 'C');
  screen = s.screen();
  assert.match(screen, /All files are now marked as seen\./);
  assert.match(screen, /No new files\./);
  await transfers.handle(s, 'B');
  assert.equal(s.state, 'transfer-bases');
  assert.ok(!s.screen().includes('new)'));
  assert.equal(store.access.newFiles(f.reader).length, 0);
});

test('logon summary includes new files beside new messages', async t => {
  const f = fixture(t), { store } = f;
  store.updateSettings({ ...store.settings(), last_callers: 0 });
  f.upload('ONE.TXT');
  f.upload('TWO.TXT');
  store.post(f.uploader, 'Hello', 'Body');
  const frames = [], errors = [];
  const socket = new LocalSocket(data => frames.push(data.toString('latin1')));
  const user = store.user(f.reader);
  const session = new Session({ socket, store, local: true, id: 1, transfers: f.transfers,
    auth: { login: async () => user }, onError: error => errors.push(error) });
  t.after(() => { session.cleanup(); socket.destroy(); });
  session.state = 'login-password';
  session.pendingHandle = user.handle;
  session.queue.push('unique test password!');
  await session.drain();
  while (session.busy) await new Promise(resolve => setImmediate(resolve));
  assert.ok(plainText(frames.join('')).endsWith(
    'You have 1 new messages.  New files: 2.  ' + plainText(ui(store, 'continue_prompt'))));
  assert.deepEqual(errors, []);
});

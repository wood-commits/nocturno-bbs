import { ui, errorText } from './strings.js';
import { mkdirSync, writeFileSync, unlinkSync, lstatSync, openSync, readSync, fstatSync, closeSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError, text, safeText } from './validation.js';
import { ZTransfer } from './transfer-zmodem.js';
import { buildQwk, parseReplies, QWK_LIMIT, QWK_ID } from './transfer-qwk.js';
import { heading } from './screens.js';

export const TRANSFER_LIMITS = Object.freeze({
  file: 4 * 1024 * 1024, total: 64 * 1024 * 1024, count: 1000,
  concurrent: 4, idleMs: 30000, durationMs: 120000
});

export function initializeTransfers(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfer_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      storage_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 4194304),
      approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
      removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transfer_files_public ON transfer_files(removed, approved, id);
    CREATE TABLE IF NOT EXISTS transfer_downloads (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads BETWEEN 0 AND 999999999)
    );
  `);
}

function filename(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) || value.includes('..')) {
    throw new InputError('Use a filename of 1-64 letters, numbers, dots, underscores or hyphens; no paths.');
  }
  return value;
}

function idNumber(value) {
  if (!/^[1-9]\d{0,9}$/.test(String(value))) throw new InputError('Use a valid file ID.');
  return Number(value);
}

export class Transfers {
  constructor({ store, directory = resolve('data', 'files') }) {
    this.store = store;
    this.directory = resolve(directory);
    this.active = new Map();
  }

  ensureDirectory(create = false) {
    // This directory is trusted operator configuration; callers supply metadata only.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let stat;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    try { stat = lstatSync(this.directory); }
    catch (error) {
      if (!create && error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError('File storage directory must be a directory, not a symlink.');
  }

  caller(userId, posting = false) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new InputError('An enabled, approved account is required.');
    const user = this.store.user(userId);
    if (!user || user.disabled || (user.application_status !== undefined && user.application_status !== 'approved')) {
      throw new InputError('An enabled, approved account is required.');
    }
    if (posting && !user.can_post) throw new InputError('Posting permission is required for uploads.');
    this.store.access.caller(userId, posting ? 'post' : undefined);
    return user;
  }

  catalog(userId, page = 0, baseId = 1) {
    this.caller(userId);
    this.store.access.requireFile(userId, baseId);
    if (!Number.isSafeInteger(page) || page < 0 || page > 100) throw new InputError('Invalid catalog page.');
    return this.store.db.prepare(`SELECT id, name, description, size, created_at FROM transfer_files
      WHERE approved = 1 AND removed = 0 AND base_id = ? ORDER BY id DESC LIMIT 10 OFFSET ?`).all(baseId, page * 10);
  }

  stats(userId) {
    this.caller(userId);
    return this.store.db.prepare(`SELECT
      (SELECT count(*) FROM transfer_files WHERE user_id = ?) AS uploads,
      coalesce((SELECT downloads FROM transfer_downloads WHERE user_id = ?), 0) AS downloads`).get(userId, userId);
  }

  // These sysop methods have no caller command route. The local console owns YES confirmation.
  sysopFiles(page = 0, baseId) {
    if (!Number.isInteger(page) || page < 0 || page > 100) throw new InputError('Invalid catalog page.');
    return this.store.db.prepare(`SELECT f.id, f.name, f.description, f.size, f.approved, f.created_at, f.base_id, u.handle
      FROM transfer_files f JOIN users u ON u.id = f.user_id WHERE f.removed = 0
      AND (? IS NULL OR f.base_id = ?) ORDER BY f.id DESC LIMIT 10 OFFSET ?`).all(baseId ?? null, baseId ?? null, page * 10);
  }

  move(id, baseId) {
    if (!this.store.access.fileBase(baseId)) throw new InputError('access_file_base_missing');
    if (!this.store.db.prepare('UPDATE transfer_files SET base_id = ? WHERE id = ? AND removed = 0')
      .run(baseId, idNumber(id)).changes) throw new InputError('File not found.');
  }

  approve(id, approved = true) {
    id = idNumber(id);
    if (typeof approved !== 'boolean') throw new InputError('Invalid approval value.');
    if (!this.store.db.prepare('UPDATE transfer_files SET approved = ? WHERE id = ? AND removed = 0').run(Number(approved), id).changes) {
      throw new InputError('File not found.');
    }
  }

  remove(id) {
    id = idNumber(id);
    const row = this.store.db.prepare('SELECT storage_key FROM transfer_files WHERE id = ? AND removed = 0').get(id);
    if (!row) throw new InputError('File not found.');
    // Delete the file before clearing its key so failures remain visible and retryable.
    this.ensureDirectory();
    const path = this.storagePath(row.storage_key);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.store.db.prepare('UPDATE transfer_files SET removed = 1, approved = 0, name = \'\', description = \'\' WHERE id = ?').run(id);
  }

  storagePath(key) {
    if (!/^[0-9a-f-]{36}\.bin$/.test(key)) throw new Error('Invalid internal file storage key');
    return join(this.directory, key);
  }

  save(userId, name, data, description = '', baseId = 1) {
    this.caller(userId, true);
    this.store.access.requireFile(userId, baseId, 'upload');
    name = filename(name);
    if (description) description = text(description, 80, 'Description');
    if (!Buffer.isBuffer(data) || data.length < 1 || data.length > TRANSFER_LIMITS.file) throw new InputError('File must be 1 byte to 4 MiB.');
    const key = `${randomUUID()}.bin`, path = this.storagePath(key);
    this.store.db.exec('BEGIN IMMEDIATE');
    let written = false;
    try {
      this.caller(userId, true);
      this.store.access.requireFile(userId, baseId, 'upload');
      const { count } = this.store.db.prepare('SELECT count(*) AS count FROM transfer_files').get();
      const { size } = this.store.db.prepare('SELECT coalesce(sum(size), 0) AS size FROM transfer_files WHERE removed = 0').get();
      if (count >= TRANSFER_LIMITS.count || size + data.length > TRANSFER_LIMITS.total) throw new InputError('File storage is full. Contact the sysop.');
      this.ensureDirectory(true);
      // Only a generated UUID is used as a path, never a remote filename.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
      written = true;
      const result = this.store.db.prepare(`INSERT INTO transfer_files(user_id, name, description, storage_key, size, created_at, base_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, name, description, key, data.length, new Date().toISOString(), baseId);
      this.store.db.exec('COMMIT');
      return result.lastInsertRowid;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (written) unlinkSync(path);
      throw error;
    }
  }

  download(userId, id) {
    this.caller(userId);
    const row = this.store.db.prepare(`SELECT id, base_id, name, storage_key, size FROM transfer_files
      WHERE id = ? AND approved = 1 AND removed = 0`).get(idNumber(id));
    if (!row) throw new InputError('Approved file not found.');
    this.store.access.requireFile(userId, row.base_id, 'download');
    filename(row.name);
    this.ensureDirectory();
    const path = this.storagePath(row.storage_key);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd, { bigint: true });
      // Check the opened identity before reading, including where Windows lacks O_NOFOLLOW.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const entry = lstatSync(path, { bigint: true });
      if (!stat.isFile() || !entry.isFile() || entry.isSymbolicLink() || stat.ino <= 0n ||
          stat.ino !== entry.ino || stat.dev !== entry.dev ||
          stat.size !== BigInt(row.size) || row.size < 1 || row.size > TRANSFER_LIMITS.file) {
        throw new InputError('Stored file is unavailable. Contact the sysop.');
      }
      const data = Buffer.alloc(row.size);
      let offset = 0;
      while (offset < data.length) {
        const n = readSync(fd, data, offset, data.length - offset, offset);
        if (!n) throw new InputError('Stored file changed during download. Try again.');
        offset += n;
      }
      return { name: row.name, data, id: row.id, baseId: row.base_id };
    } finally { closeSync(fd); }
  }

  qwk(userId) { return buildQwk(this.store, this.caller(userId)); }

  importReplies(userId, packet) {
    this.caller(userId, true);
    const rows = parseReplies(packet);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.caller(userId, true);
      for (const row of rows) {
        if (!this.store.base(row.baseId)) throw new InputError('Reply message base not found.');
        this.store.post(userId, row.subject, row.body, row.baseId);
      }
      this.store.db.exec('COMMIT');
      return rows.length;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }

  menu(session, kind = 'files') {
    this.caller(session.user?.id);
    if (!['files', 'qwk'].includes(kind)) throw new InputError('Unknown transfer menu.');
    session.state = `transfer-${kind}`;
    session.transferPage = 0;
    if (kind === 'files') {
      session.fileBaseId ??= 1;
      const user = this.store.access.caller(session.user.id);
      if (!this.store.access.filePermissions(user.role_id, session.fileBaseId)?.can_list) session.state = 'transfer-bases';
    }
    this.show(session);
  }

  show(session, notice) {
    const frame = heading(ui(this.store, session.state === 'transfer-qwk' ? 'transfers_qwk_title' : 'transfers_files_title'),
      this.store.settings().name);
    const status = notice ? `${notice}\r\n` : '';
    if (session.state === 'transfer-bases') {
      const rows = this.store.access.fileBases(session.transferPage ?? 0, session.user.id);
      session.write(frame + status + ui(this.store, 'access_file_bases_title') + '\r\n' +
        rows.map(row => ui(this.store, 'access_base_row', { ID: row.id, NAME: row.name, DESCRIPTION: row.description }) + '\r\n').join('') +
        ui(this.store, 'access_file_bases_prompt') + '\r\n' + ui(this.store, 'selection'));
      return;
    }
    if (session.state === 'transfer-qwk') {
      session.write(frame + status + ui(this.store, 'transfers_qwk_offline_mail_latest_100_public_posts_ascii_replies') + '\r\n' + ui(this.store, 'transfers_d_download_value_qwk_u_upload_value_rep_q_return', { QWK_ID: QWK_ID, QWK_ID_2: QWK_ID }) + '\r\n' + ui(this.store, 'selection'));
      return;
    }
    const baseId = session.fileBaseId ?? 1;
    const rows = this.catalog(session.user.id, session.transferPage ?? 0, baseId);
    session.write(frame + status + ui(this.store, 'access_selected_file_base', { ID: baseId, NAME: this.store.access.fileBase(baseId).name }) + '\r\n' +
      ui(this.store, 'transfers_file_catalog_approved_downloads') + '\r\n' + rows.map(row =>
      (ui(this.store, 'transfers_value_value_value_bytes_value', { ID: row.id, VALUE2: safeText(row.name), SIZE: row.size, VALUE4: safeText(row.description) }) + '\r\n')).join('') +
      (ui(this.store, 'transfers_d_id_download_u_upload_sysop_approval_required_n_p_page_q_retu') + '\r\n' +
      ui(this.store, 'access_choose_file_base') + '\r\n' + ui(this.store, 'selection')));
  }

  async handle(session, line) {
    if (!session.state.startsWith('transfer-')) return false;
    this.caller(session.user?.id);
    if (session.state === 'transfer-binary') throw new InputError('Binary transfer in progress.');
    const command = line.trim().toUpperCase();
    if (command === 'Q') { session.menu(); return true; }
    const qwk = session.state === 'transfer-qwk';
    if (session.state === 'transfer-bases' && /^[1-9]\d{0,9}$/.test(command)) {
      this.store.access.requireFile(session.user.id, Number(command));
      session.fileBaseId = Number(command);
      session.state = 'transfer-files';
      session.transferPage = 0;
      this.show(session);
    } else if (!qwk && command === 'B') {
      session.state = 'transfer-bases';
      session.transferPage = 0;
      this.show(session);
    } else if (command === 'U' && session.state !== 'transfer-bases') {
      this.caller(session.user.id, true);
      this.begin(session, { direction: 'receive', kind: qwk ? 'reply' : 'upload' });
    } else if (command === 'D' && qwk) {
      this.begin(session, { direction: 'send', kind: 'qwk', file: { name: `${QWK_ID}.QWK`, data: this.qwk(session.user.id) } });
    } else if (/^D [1-9]\d{0,9}$/.test(command) && session.state === 'transfer-files') {
      this.begin(session, { direction: 'send', kind: 'download', file: this.download(session.user.id, command.slice(2)) });
    } else if (!qwk && ['N', 'P'].includes(command)) {
      session.transferPage = Math.max(0, Math.min(99, (session.transferPage ?? 0) + (command === 'N' ? 1 : -1)));
      this.show(session);
    } else this.show(session);
    return true;
  }

  begin(session, { direction, kind, file }) {
    if (session.local) throw new InputError('console_no_local_transfer');
    this.caller(session.user?.id, direction === 'receive');
    if (this.active.has(session) || this.active.size >= TRANSFER_LIMITS.concurrent) throw new InputError('Transfer capacity reached. Try again later.');
    const previous = session.state;
    const job = { previous, kind, direction, fileId: file?.id,
      baseId: file?.baseId ?? session.fileBaseId ?? 1,
      messageBases: kind === 'qwk' ? this.store.db.prepare(`SELECT base_id FROM message_permissions
        WHERE role_id = ? AND can_read = 1`).all(this.store.access.caller(session.user.id).role_id).map(row => row.base_id) : [],
      received: 0, started: Date.now(), lastActivity: Date.now() };
    this.checkJob(session, job);
    const write = buffer => {
      this.checkJob(session, job);
      if (typeof session.writeBinary === 'function') session.writeBinary(buffer);
      else {
        const out = [];
        for (const byte of buffer) { out.push(byte); if (byte === 255) out.push(255); }
        session.write(Buffer.from(out));
      }
    };
    job.protocol = new ZTransfer({
      direction, file, maxSize: kind === 'reply' ? QWK_LIMIT : TRANSFER_LIMITS.file, write,
      complete: result => {
        this.checkJob(session, job);
        let message = ui(this.store, 'transfer_download_complete');
        if (kind === 'upload') message = ui(this.store, 'transfer_upload_complete',
          { FILEID: this.save(session.user.id, result.name, result.data, '', job.baseId) });
        if (kind === 'reply') message = ui(this.store, 'transfer_replies_complete',
          { COUNT: this.importReplies(session.user.id, result.data) });
        if (kind === 'download') {
          this.store.db.prepare(`INSERT INTO transfer_downloads(user_id, downloads) VALUES (?, 1)
            ON CONFLICT(user_id) DO UPDATE SET downloads = min(999999999, downloads + 1)`).run(session.user.id);
        }
        this.cancel(session);
        session.state = previous;
        this.show(session, message);
      }
    });
    session.write(('\r\n' + ui(this.store, 'transfers_start_your_zmodem_client_now_transfer_limit_120_seconds_idle_3') + '\r\n'));
    session.state = 'transfer-binary';
    session.transferRaw = true;
    this.active.set(session, job);
    session.editor?.setRaw?.(buffer => this.feed(session, buffer));
    job.deadline = setTimeout(() => this.fail(session, new InputError('Transfer time limit reached.')), TRANSFER_LIMITS.durationMs);
    job.deadline.unref();
    this.touch(session, job);
    job.protocol.start();
  }

  touch(session, job, delay = TRANSFER_LIMITS.idleMs) {
    clearTimeout(job.idle);
    job.idle = setTimeout(() => {
      const remaining = TRANSFER_LIMITS.idleMs - (Date.now() - job.lastActivity);
      if (remaining > 0) this.touch(session, job, remaining);
      else this.fail(session, new InputError('Transfer idle timeout.'));
    }, delay);
    job.idle.unref();
  }

  checkJob(session, job) {
    this.caller(session.user?.id, job.direction === 'receive');
    if (job.kind === 'upload' || job.kind === 'download') {
      this.store.access.requireFile(session.user.id, job.baseId, job.kind);
      if (job.kind === 'download' && !this.store.db.prepare(`SELECT id FROM transfer_files
        WHERE id = ? AND base_id = ? AND approved = 1 AND removed = 0`).get(job.fileId, job.baseId)) {
        throw new InputError('Approved file not found.');
      }
    }
    for (const baseId of job.messageBases) this.store.access.requireMessage(session.user.id, baseId);
  }

  // Feed ONLY telnet-decoded binary octets; never bypass TelnetInput's IAC parser.
  feed(session, buffer) {
    const job = this.active.get(session);
    if (!job) return false;
    try {
      const now = Date.now();
      // Some telnet decoders emit individual octets; avoid a SQLite query per byte.
      if (job.checkedAt === undefined || now - job.checkedAt >= 50) {
        this.checkJob(session, job);
        job.checkedAt = now;
      }
      job.received += buffer.length;
      if (job.received > TRANSFER_LIMITS.file * 3 + 65536) throw new InputError('Transfer input limit exceeded.');
      job.lastActivity = now;
      job.protocol.feed(buffer);
    } catch (error) { this.fail(session, error); }
    return true;
  }

  fail(session, error) {
    this.cancel(session);
    // An interrupted stream cannot safely be treated as menu input.
    if (!(error instanceof InputError)) session.onError?.(error);
    session.disconnect(error instanceof InputError ? errorText(this.store, error) : ui(this.store, 'transfer_failed'));
  }

  cancel(session) {
    const job = this.active.get(session);
    if (!job) return;
    clearTimeout(job.idle);
    clearTimeout(job.deadline);
    this.active.delete(session);
    session.transferRaw = false;
    session.editor?.setRaw?.(null);
  }
}

import { InputError } from './validation.js';

export const MAX_RATIO = 1000;
export const MAX_DAILY_MINUTES = 1440;
const MINUTE_MS = 60000;
const MAX_USAGE = Number.MAX_SAFE_INTEGER;
const MAX_CLOCK_YEAR = 9999;

function value(number, maximum, inherit = false) {
  if (inherit && number === null) return;
  if (!Number.isInteger(number) || number < 0 || number > maximum) throw new InputError('limits_invalid_value');
}

function clock(now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new InputError('limits_invalid_date');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > MAX_CLOCK_YEAR) throw new InputError('limits_invalid_date');
  const day = date.toISOString().slice(0, 10);
  return { day, start: Date.parse(`${day}T00:00:00.000Z`) };
}

export class Limits {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS caller_limit_defaults (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        download_ratio INTEGER NOT NULL DEFAULT 0 CHECK (download_ratio BETWEEN 0 AND 1000),
        daily_minutes INTEGER NOT NULL DEFAULT 0 CHECK (daily_minutes BETWEEN 0 AND 1440)
      );
      INSERT OR IGNORE INTO caller_limit_defaults(id) VALUES (1);
      CREATE TABLE IF NOT EXISTS caller_limit_users (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        download_ratio INTEGER CHECK (download_ratio BETWEEN 0 AND 1000),
        daily_minutes INTEGER CHECK (daily_minutes BETWEEN 0 AND 1440)
      );
      CREATE TABLE IF NOT EXISTS caller_daily_usage (
        user_id INTEGER PRIMARY KEY REFERENCES users(id), day TEXT NOT NULL,
        used_ms INTEGER NOT NULL CHECK (used_ms BETWEEN 0 AND 9007199254740991)
      );
      CREATE TABLE IF NOT EXISTS caller_usage_calls (
        call_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
        last_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfer_ratio_usage (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes BETWEEN 0 AND 9007199254740991),
        downloaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (downloaded_bytes BETWEEN 0 AND 9007199254740991)
      );
      DELETE FROM caller_usage_calls;
    `);
    if (!this.db.prepare('PRAGMA table_info(transfer_files)').all().some(column => column.name === 'ratio_credited')) {
      this.db.exec('ALTER TABLE transfer_files ADD COLUMN ratio_credited INTEGER NOT NULL DEFAULT 0 CHECK (ratio_credited IN (0, 1))');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of this.db.prepare('SELECT id, user_id, size FROM transfer_files WHERE approved = 1 AND ratio_credited = 0').all()) {
        this.credit(file);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  defaults() { return this.db.prepare('SELECT download_ratio, daily_minutes FROM caller_limit_defaults WHERE id = 1').get(); }

  user(userId) {
    if (!this.store.user(userId)) throw new InputError('User not found.');
    return this.db.prepare('SELECT download_ratio, daily_minutes FROM caller_limit_users WHERE user_id = ?').get(userId) ??
      { download_ratio: null, daily_minutes: null };
  }

  resolve(userId) {
    const defaults = this.defaults(), user = this.user(userId);
    return { download_ratio: user.download_ratio ?? defaults.download_ratio,
      daily_minutes: user.daily_minutes ?? defaults.daily_minutes };
  }

  setDefaults({ download_ratio, daily_minutes }) {
    value(download_ratio, MAX_RATIO);
    value(daily_minutes, MAX_DAILY_MINUTES);
    this.db.prepare('UPDATE caller_limit_defaults SET download_ratio = ?, daily_minutes = ? WHERE id = 1')
      .run(download_ratio, daily_minutes);
  }

  setUser(userId, { download_ratio, daily_minutes }) {
    this.user(userId);
    value(download_ratio, MAX_RATIO, true);
    value(daily_minutes, MAX_DAILY_MINUTES, true);
    this.db.prepare(`INSERT INTO caller_limit_users VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET download_ratio = excluded.download_ratio, daily_minutes = excluded.daily_minutes`)
      .run(userId, download_ratio, daily_minutes);
  }

  account(userId, now = Date.now()) {
    this.db.exec('SAVEPOINT caller_usage');
    try {
      const used = this.accountCalls(userId, now);
      this.db.exec('RELEASE caller_usage');
      return used;
    } catch (error) {
      this.db.exec('ROLLBACK TO caller_usage; RELEASE caller_usage');
      throw error;
    }
  }

  accountCalls(userId, now) {
    const { day, start } = clock(now);
    const previous = this.db.prepare('SELECT day, used_ms FROM caller_daily_usage WHERE user_id = ?').get(userId);
    const currentDay = previous && previous.day > day ? previous.day : day;
    let used = previous?.day === currentDay ? previous.used_ms : 0;
    for (const call of this.db.prepare('SELECT call_id, last_at FROM caller_usage_calls WHERE user_id = ?').all(userId)) {
      if (day === currentDay) used = Math.min(MAX_USAGE, used + Math.max(0, now - Math.max(start, call.last_at)));
      this.db.prepare('UPDATE caller_usage_calls SET last_at = max(last_at, ?) WHERE call_id = ?').run(now, call.call_id);
    }
    this.db.prepare(`INSERT INTO caller_daily_usage VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET day = excluded.day, used_ms = excluded.used_ms`).run(userId, currentDay, used);
    return used;
  }

  checkTime(userId, now = Date.now()) {
    const limit = this.resolve(userId).daily_minutes;
    const used = this.account(userId, now);
    if (limit && used >= limit * MINUTE_MS) throw new InputError('limits_daily_exhausted');
    return limit ? limit * MINUTE_MS - used : Infinity;
  }

  nextCheck(userId) {
    const remaining = this.checkTime(userId);
    const { count } = this.db.prepare('SELECT count(*) AS count FROM caller_usage_calls WHERE user_id = ?').get(userId);
    return Math.max(1, Math.min(1000, Math.ceil(remaining / Math.max(1, count))));
  }

  startCall(callId, userId, now = Date.now()) {
    clock(now);
    this.db.prepare('INSERT INTO caller_usage_calls VALUES (?, ?, ?)').run(callId, userId, now);
  }

  endCall(callId, now = Date.now()) {
    const call = this.db.prepare('SELECT user_id FROM caller_usage_calls WHERE call_id = ?').get(callId);
    if (!call) return;
    this.account(call.user_id, now);
    this.db.prepare('DELETE FROM caller_usage_calls WHERE call_id = ?').run(callId);
  }

  ratioUsage(userId) {
    this.user(userId);
    return this.db.prepare('SELECT uploaded_bytes, downloaded_bytes FROM transfer_ratio_usage WHERE user_id = ?').get(userId) ??
      { uploaded_bytes: 0, downloaded_bytes: 0 };
  }

  checkDownload(userId, bytes = 0) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new InputError('limits_invalid_value');
    const ratio = this.resolve(userId).download_ratio;
    const usage = this.ratioUsage(userId);
    if (ratio && BigInt(usage.downloaded_bytes) + BigInt(bytes) > BigInt(usage.uploaded_bytes) * BigInt(ratio)) {
      throw new InputError('limits_ratio_exhausted');
    }
  }

  consumeDownload(userId, bytes) {
    this.checkDownload(userId, bytes);
    this.db.prepare(`INSERT INTO transfer_ratio_usage(user_id, downloaded_bytes) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET downloaded_bytes = min(9007199254740991, downloaded_bytes + excluded.downloaded_bytes)`)
      .run(userId, bytes);
  }

  credit(file) {
    this.db.prepare(`INSERT INTO transfer_ratio_usage(user_id, uploaded_bytes) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET uploaded_bytes = min(9007199254740991, uploaded_bytes + excluded.uploaded_bytes)`)
      .run(file.user_id, file.size);
    this.db.prepare('UPDATE transfer_files SET ratio_credited = 1 WHERE id = ?').run(file.id);
  }

  approveUpload(fileId, approved) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const file = this.db.prepare('SELECT id, user_id, size, ratio_credited FROM transfer_files WHERE id = ? AND removed = 0').get(fileId);
      if (!file) throw new InputError('File not found.');
      // Approval assigns the next new-file scan position; unapproval withdraws it.
      this.db.prepare(`UPDATE transfer_files SET approved = ?, scan_seq = CASE WHEN ? THEN
        coalesce(CASE WHEN approved = 1 THEN scan_seq END, (SELECT coalesce(max(scan_seq), 0) + 1 FROM transfer_files))
        ELSE NULL END WHERE id = ?`).run(Number(approved), Number(approved), fileId);
      if (approved && !file.ratio_credited) this.credit(file);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

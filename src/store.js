import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { InputError, username, text, messageBody } from './validation.js';
import { validateString } from './presentation.js';
import { initializeDoors } from './doors.js';
import { initializeCommunity } from './community.js';
import { initializeTransfers } from './transfers.js';
import { Access, initializeAccess } from './access.js';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') {
      // The database path is trusted operator configuration, never caller input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login TEXT
      );
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        node INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calls_user ON calls(user_id);
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        registration INTEGER NOT NULL CHECK (registration IN (0, 1)),
        session_minutes INTEGER NOT NULL CHECK (session_minutes BETWEEN 1 AND 1440),
        idle_minutes INTEGER NOT NULL CHECK (idle_minutes BETWEEN 1 AND 60)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'disabled')) {
      this.db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))');
    }
    if (!this.db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'deleted')) {
      this.db.exec('ALTER TABLE users ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))');
    }
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'removed')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1))');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_bases (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT ''
      );
      INSERT OR IGNORE INTO message_bases(id, name, description) VALUES (1, 'General', 'Public discussion');
      CREATE TABLE IF NOT EXISTS display_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all();
    if (!userColumns.some(item => item.name === 'application_status')) {
      this.db.exec("ALTER TABLE users ADD COLUMN application_status TEXT NOT NULL DEFAULT 'approved' CHECK (application_status IN ('pending', 'approved', 'rejected'))");
    }
    for (const column of ['can_post', 'can_doors']) {
      if (!userColumns.some(item => item.name === column)) {
        // Column names come only from the fixed list above.
        this.db.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 1 CHECK (${column} IN (0, 1))`);
      }
    }
    for (const column of ['real_name', 'location', 'sysop_note']) {
      if (!userColumns.some(item => item.name === column)) {
        this.db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
      }
    }
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'base_id')) {
      // SQLite cannot add a REFERENCES column with a non-NULL default to populated tables.
      this.db.exec('ALTER TABLE messages ADD COLUMN base_id INTEGER NOT NULL DEFAULT 1');
    }
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'reply_to')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id)');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_base ON messages(base_id, removed, id);
      CREATE TRIGGER IF NOT EXISTS messages_base_insert BEFORE INSERT ON messages
        WHEN NOT EXISTS (SELECT 1 FROM message_bases WHERE id = NEW.base_id)
        BEGIN SELECT RAISE(ABORT, 'Message base not found'); END;
      CREATE TRIGGER IF NOT EXISTS messages_base_update BEFORE UPDATE OF base_id ON messages
        WHEN NOT EXISTS (SELECT 1 FROM message_bases WHERE id = NEW.base_id)
        BEGIN SELECT RAISE(ABORT, 'Message base not found'); END;
    `);
    initializeDoors(this.db);
    initializeCommunity(this.db);
    initializeTransfers(this.db);
    initializeAccess(this.db);
    this.access = new Access(this);
    // A previous process may have stopped before its sockets could be closed.
    this.db.prepare('UPDATE calls SET ended_at = started_at WHERE ended_at IS NULL').run();
  }

  findUser(handle) {
    return this.db.prepare('SELECT * FROM users WHERE handle = ? COLLATE NOCASE AND deleted = 0').get(handle);
  }

  initSettings(name) {
    text(name, 40, 'BBS name');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (1, ?, 1, 60, 5)').run(name);
  }

  settings() {
    return this.db.prepare('SELECT name, registration, session_minutes, idle_minutes FROM settings WHERE id = 1').get() ??
      { name: 'Nocturno BBS', registration: 1, session_minutes: 60, idle_minutes: 5 };
  }

  updateSettings({ name, registration, session_minutes, idle_minutes }) {
    name = text(name, 40, 'BBS name');
    if (![0, 1].includes(registration) || !Number.isInteger(session_minutes) ||
        session_minutes < 1 || session_minutes > 1440 || !Number.isInteger(idle_minutes) ||
        idle_minutes < 1 || idle_minutes > 60) {
      throw new InputError('Registration must be 0/1; session 1-1440 and idle 1-60 minutes.');
    }
    this.db.prepare(`INSERT INTO settings VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, registration = excluded.registration,
      session_minutes = excluded.session_minutes, idle_minutes = excluded.idle_minutes`)
      .run(name, registration, session_minutes, idle_minutes);
  }

  user(id) {
    return this.db.prepare(`SELECT id, handle, disabled, created_at, last_login,
      can_post, can_doors, real_name, location, sysop_note, application_status, role_id FROM users WHERE id = ? AND deleted = 0`).get(id);
  }

  sysopUsers(page = 0) {
    return this.db.prepare(`SELECT id, handle, disabled, created_at, last_login,
      can_post, can_doors, real_name, location, sysop_note, application_status, role_id FROM users WHERE deleted = 0 ORDER BY id LIMIT 10 OFFSET ?`)
      .all(page * 10);
  }

  editUser(id, field, value) {
    if (!this.user(id)) throw new InputError('User not found.');
    if (['can_post', 'can_doors'].includes(field)) {
      if (![0, 1].includes(value)) throw new InputError('Permission must be 0 or 1.');
    } else if (['real_name', 'location', 'sysop_note'].includes(field)) {
      if (value !== '') value = text(value, field === 'sysop_note' ? 100 : 60, 'User info');
    } else throw new InputError('Unknown user field.');
    // Field is restricted to the explicit allowlist above.
    this.db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, id);
  }

  stringOverride(key) {
    return this.db.prepare('SELECT value FROM display_strings WHERE key = ?').get(key)?.value;
  }

  setString(key, value) {
    validateString(key, value);
    this.db.prepare(`INSERT INTO display_strings VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  resetString(key) {
    validateString(key, 'Default');
    this.db.prepare('DELETE FROM display_strings WHERE key = ?').run(key);
  }

  bases(page = 0) {
    return this.db.prepare('SELECT id, name, description FROM message_bases ORDER BY id LIMIT 10 OFFSET ?').all(page * 10);
  }

  base(id) {
    return this.db.prepare('SELECT id, name, description FROM message_bases WHERE id = ?').get(id);
  }

  createBase(name, description = '') {
    name = text(name, 40, 'Base name');
    if (description) description = text(description, 80, 'Description');
    if (this.db.prepare('SELECT count(*) AS n FROM message_bases').get().n >= 100) throw new InputError('Limit of 100 message bases reached.');
    if (this.db.prepare('SELECT id FROM message_bases WHERE name = ? COLLATE NOCASE').get(name)) throw new InputError('Base name is already in use.');
    const id = this.db.prepare('INSERT INTO message_bases(name, description) VALUES (?, ?)').run(name, description).lastInsertRowid;
    this.access.setMessagePermissions(1, id, 1, 1);
    return id;
  }

  renameUser(id, handle) {
    username(handle);
    if (!this.user(id)) throw new InputError('User not found.');
    const existing = this.findUser(handle);
    if (existing && existing.id !== id) throw new InputError('That handle is already in use.');
    this.db.prepare('UPDATE users SET handle = ? WHERE id = ?').run(handle, id);
  }

  setUserDisabled(id, disabled) {
    if (typeof disabled !== 'boolean') throw new InputError('Disabled must be true or false.');
    if (!this.db.prepare('UPDATE users SET disabled = ? WHERE id = ? AND deleted = 0').run(Number(disabled), id).changes) {
      throw new InputError('User not found.');
    }
  }

  deleteUser(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const user = this.user(id);
      if (!user) throw new InputError('User not found.');
      // Keep foreign keys and the ID reserved; this identity cannot be registered.
      this.db.prepare(`UPDATE users SET handle = ?, password_hash = '', deleted = 1,
        disabled = 1, can_post = 0, can_doors = 0, role_id = 1,
        real_name = '', location = '', sysop_note = '' WHERE id = ?`)
        .run(`Deleted user #${user.id}`, user.id);
      this.db.prepare('DELETE FROM community_profiles WHERE user_id = ?').run(user.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteMessage(id) {
    // Reserve the ID so a removed message can never become a different post.
    if (!this.db.prepare("UPDATE messages SET subject = '', body = '', removed = 1 WHERE id = ? AND removed = 0").run(id).changes) {
      throw new InputError('Message not found.');
    }
  }

  createUser(handle, hash, pending = false) {
    username(handle);
    if (!this.settings().registration) throw new InputError('New caller registration is closed.');
    if (this.db.prepare('SELECT count(*) AS n FROM users').get().n >= 10000) {
      throw new InputError('Registration is full. Contact the sysop.');
    }
    if (this.findUser(handle)) throw new InputError('Unable to register that handle.');
    return this.db.prepare(
      'INSERT INTO users(handle, password_hash, created_at, application_status) VALUES (?, ?, ?, ?)'
    ).run(handle, hash, new Date().toISOString(), pending ? 'pending' : 'approved').lastInsertRowid;
  }

  applications(page = 0) {
    return this.db.prepare("SELECT id, handle, created_at FROM users WHERE application_status = 'pending' AND deleted = 0 ORDER BY id LIMIT 10 OFFSET ?")
      .all(page * 10);
  }

  decideApplication(id, approved) {
    if (typeof approved !== 'boolean') throw new InputError('Approval must be true or false.');
    if (!this.db.prepare("UPDATE users SET application_status = ? WHERE id = ? AND application_status = 'pending' AND deleted = 0")
      .run(approved ? 'approved' : 'rejected', id).changes) throw new InputError('Pending application not found.');
  }

  users(page = 0) {
    return this.db.prepare(
      "SELECT handle, created_at, last_login FROM users WHERE application_status = 'approved' AND deleted = 0 ORDER BY id LIMIT 10 OFFSET ?"
    ).all(page * 10);
  }

  startCall(userId, node) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, userId);
    const id = this.db.prepare(
      'INSERT INTO calls(user_id, node, started_at) VALUES (?, ?, ?)'
    ).run(userId, node, now).lastInsertRowid;
    this.db.prepare('DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY id DESC LIMIT 1000) AND ended_at IS NOT NULL').run();
    return id;
  }

  endCall(id) {
    this.db.prepare('UPDATE calls SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  callers(page = 0) {
    return this.db.prepare(`
      SELECT c.id, u.handle, c.node, c.started_at, c.ended_at
      FROM calls c JOIN users u ON u.id = c.user_id
      ORDER BY c.id DESC LIMIT 10 OFFSET ?
    `).all(page * 10);
  }

  post(userId, subject, body, baseId = 1, replyTo = null) {
    text(subject, 60, 'Subject');
    messageBody(body);
    const user = this.user(userId);
    if (user && (user.disabled || user.application_status !== 'approved' || !user.can_post)) throw new InputError('Posting permission denied.');
    if (!this.base(baseId)) throw new InputError('Message base not found.');
    this.access.requireMessage(userId, baseId, 'post');
    if (replyTo !== null) {
      if (!Number.isSafeInteger(replyTo) || replyTo < 1 ||
          !this.access.message(userId, replyTo, baseId)) {
        throw new InputError('Message not found in this base.');
      }
    }
    if (this.db.prepare('SELECT count(*) AS n FROM messages').get().n >= 100000) {
      throw new InputError('Message base is full. Contact the sysop.');
    }
    return this.db.prepare(
      'INSERT INTO messages(user_id, subject, body, created_at, base_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, subject.trim(), body.trim(), new Date().toISOString(), baseId, replyTo).lastInsertRowid;
  }

  messages(page = 0, baseId = 1) {
    return this.db.prepare(`
      SELECT m.id, u.handle, m.subject, m.created_at, m.reply_to
      FROM messages m JOIN users u ON u.id = m.user_id WHERE m.removed = 0 AND m.base_id = ?
      ORDER BY m.id DESC LIMIT 10 OFFSET ?
    `).all(baseId, page * 10);
  }

  message(id) {
    return this.db.prepare(`
      SELECT m.id, u.handle, m.subject, m.body, m.created_at, m.base_id, m.reply_to
      FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.removed = 0
    `).get(id);
  }

  stats() {
    return {
      users: this.db.prepare('SELECT count(*) AS n FROM users WHERE deleted = 0').get().n,
      messages: this.db.prepare('SELECT count(*) AS n FROM messages WHERE removed = 0').get().n,
      calls: this.db.prepare('SELECT count(*) AS n FROM calls').get().n,
      today: this.db.prepare("SELECT count(*) AS n FROM calls WHERE started_at >= ?")
        .get(new Date().toISOString().slice(0, 10)).n
    };
  }

  close() { this.db.close(); }
}

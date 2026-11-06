import { InputError, text } from './validation.js';

export function initializeAccess(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    migrateAccess(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateAccess(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      can_post INTEGER NOT NULL DEFAULT 0 CHECK (can_post IN (0, 1)),
      can_doors INTEGER NOT NULL DEFAULT 0 CHECK (can_doors IN (0, 1))
    );
    INSERT OR IGNORE INTO roles(id, name, can_post, can_doors) VALUES (1, 'Member', 1, 1);
    CREATE TABLE IF NOT EXISTS file_bases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL DEFAULT ''
    );
    INSERT OR IGNORE INTO file_bases(id, name, description) VALUES (1, 'General', 'Approved files');
  `);
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'role_id')) {
    db.exec('ALTER TABLE users ADD COLUMN role_id INTEGER NOT NULL DEFAULT 1');
  }
  if (!db.prepare('PRAGMA table_info(transfer_files)').all().some(column => column.name === 'base_id')) {
    db.exec('ALTER TABLE transfer_files ADD COLUMN base_id INTEGER NOT NULL DEFAULT 1');
  }
  if (!db.prepare('PRAGMA table_info(transfer_files)').all().some(column => column.name === 'scan_seq')) {
    // New-file scan order: assigned when a file becomes downloadable, so late approvals are still new.
    db.exec(`ALTER TABLE transfer_files ADD COLUMN scan_seq INTEGER;
      UPDATE transfer_files SET scan_seq = id WHERE approved = 1 AND removed = 0;`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS transfer_files_scan ON transfer_files(base_id, scan_seq)');
  const initialized = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_permissions'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id),
      base_id INTEGER NOT NULL REFERENCES message_bases(id),
      can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
      can_post INTEGER NOT NULL CHECK (can_post IN (0, 1)),
      PRIMARY KEY (role_id, base_id)
    );
    CREATE TRIGGER IF NOT EXISTS users_role_insert BEFORE INSERT ON users
      WHEN NOT EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id)
      BEGIN SELECT RAISE(ABORT, 'Role not found'); END;
    CREATE TRIGGER IF NOT EXISTS users_role_update BEFORE UPDATE OF role_id ON users
      WHEN NOT EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id)
      BEGIN SELECT RAISE(ABORT, 'Role not found'); END;
    CREATE TRIGGER IF NOT EXISTS roles_delete BEFORE DELETE ON roles
      WHEN OLD.id = 1 OR EXISTS (SELECT 1 FROM users WHERE role_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'Role is in use'); END;
    CREATE TABLE IF NOT EXISTS file_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id),
      base_id INTEGER NOT NULL REFERENCES file_bases(id),
      can_list INTEGER NOT NULL CHECK (can_list IN (0, 1)),
      can_download INTEGER NOT NULL CHECK (can_download IN (0, 1)),
      can_upload INTEGER NOT NULL CHECK (can_upload IN (0, 1)),
      PRIMARY KEY (role_id, base_id)
    );
    CREATE INDEX IF NOT EXISTS transfer_files_base ON transfer_files(base_id, removed, approved, id);
    CREATE TABLE IF NOT EXISTS file_reads (
      user_id INTEGER NOT NULL REFERENCES users(id),
      base_id INTEGER NOT NULL REFERENCES file_bases(id),
      last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
      PRIMARY KEY (user_id, base_id)
    );
    CREATE TRIGGER IF NOT EXISTS transfer_files_base_insert BEFORE INSERT ON transfer_files
      WHEN NOT EXISTS (SELECT 1 FROM file_bases WHERE id = NEW.base_id)
      BEGIN SELECT RAISE(ABORT, 'File base not found'); END;
    CREATE TRIGGER IF NOT EXISTS transfer_files_base_update BEFORE UPDATE OF base_id ON transfer_files
      WHEN NOT EXISTS (SELECT 1 FROM file_bases WHERE id = NEW.base_id)
      BEGIN SELECT RAISE(ABORT, 'File base not found'); END;
  `);
  // Seed once, never restore permissions deliberately revoked by the operator.
  if (!initialized) {
    db.exec(`
      INSERT INTO message_permissions SELECT 1, id, 1, 1 FROM message_bases;
      INSERT INTO file_permissions SELECT 1, id, 1, 1, 1 FROM file_bases;
    `);
  }
}

function pageNumber(page) {
  if (!Number.isInteger(page) || page < 0 || page > 9999) throw new InputError('access_invalid_page');
}

function flags(values) {
  if (!values.every(value => value === 0 || value === 1)) throw new InputError('access_invalid_flags');
}

export class Access {
  constructor(store) { this.store = store; this.db = store.db; }

  role(id) {
    return this.db.prepare('SELECT id, name, can_post, can_doors FROM roles WHERE id = ?').get(id);
  }

  roles(page = 0) {
    pageNumber(page);
    return this.db.prepare('SELECT id, name, can_post, can_doors FROM roles ORDER BY id LIMIT 10 OFFSET ?').all(page * 10);
  }

  createRole(name) {
    name = text(name, 24, 'Role name');
    if (this.db.prepare('SELECT count(*) AS n FROM roles').get().n >= 100) throw new InputError('access_role_limit');
    if (this.db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').get(name)) throw new InputError('access_role_duplicate');
    return this.db.prepare('INSERT INTO roles(name) VALUES (?)').run(name).lastInsertRowid;
  }

  requireRole(id) {
    const role = this.role(id);
    if (!role) throw new InputError('access_role_missing');
    return role;
  }

  setRolePermissions(id, posting, doors) {
    this.requireRole(id);
    flags([posting, doors]);
    this.db.prepare('UPDATE roles SET can_post = ?, can_doors = ? WHERE id = ?').run(posting, doors, id);
  }

  assign(userId, roleId) {
    this.requireRole(roleId);
    if (!this.store.user(userId)) throw new InputError('User not found.');
    this.db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(roleId, userId);
  }

  caller(userId, permission) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new InputError('access_denied');
    const user = this.store.user(userId);
    const role = user && this.role(user.role_id);
    if (!user || user.disabled || user.application_status !== 'approved' || !role ||
        (permission === 'post' && (!user.can_post || !role.can_post)) ||
        (permission === 'doors' && (!user.can_doors || !role.can_doors))) {
      throw new InputError('access_denied');
    }
    this.store.limits.checkTime(userId);
    return user;
  }

  messagePermissions(roleId, baseId) {
    return this.db.prepare('SELECT can_read, can_post FROM message_permissions WHERE role_id = ? AND base_id = ?')
      .get(roleId, baseId);
  }

  filePermissions(roleId, baseId) {
    return this.db.prepare('SELECT can_list, can_download, can_upload FROM file_permissions WHERE role_id = ? AND base_id = ?')
      .get(roleId, baseId);
  }

  setMessagePermissions(roleId, baseId, read, post) {
    this.requireRole(roleId);
    flags([read, post]);
    if (!this.store.base(baseId)) throw new InputError('Message base not found.');
    this.db.prepare(`INSERT INTO message_permissions VALUES (?, ?, ?, ?)
      ON CONFLICT(role_id, base_id) DO UPDATE SET can_read = excluded.can_read, can_post = excluded.can_post`)
      .run(roleId, baseId, read, post);
  }

  setFilePermissions(roleId, baseId, list, download, upload) {
    this.requireRole(roleId);
    flags([list, download, upload]);
    if (!this.fileBase(baseId)) throw new InputError('access_file_base_missing');
    this.db.prepare(`INSERT INTO file_permissions VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(role_id, base_id) DO UPDATE SET can_list = excluded.can_list,
      can_download = excluded.can_download, can_upload = excluded.can_upload`)
      .run(roleId, baseId, list, download, upload);
  }

  requireMessage(userId, baseId, permission = 'read') {
    if (!['read', 'post'].includes(permission)) throw new InputError('access_denied');
    const user = this.caller(userId, permission);
    const grant = this.messagePermissions(user.role_id, baseId);
    if (!grant?.can_read || (permission === 'post' && !grant.can_post)) throw new InputError('access_denied');
    return this.store.base(baseId);
  }

  requireFile(userId, baseId, permission = 'list') {
    if (!['list', 'download', 'upload'].includes(permission)) throw new InputError('access_denied');
    const user = this.caller(userId, permission === 'upload' ? 'post' : undefined);
    const grant = this.filePermissions(user.role_id, baseId);
    if (!grant?.can_list || (permission === 'download' && !grant.can_download) ||
        (permission === 'upload' && !grant.can_upload)) throw new InputError('access_denied');
    return this.fileBase(baseId);
  }

  messageBases(userId, page = 0) {
    const user = this.caller(userId);
    pageNumber(page);
    return this.db.prepare(`SELECT b.id, b.name, b.description FROM message_bases b
      JOIN message_permissions p ON p.base_id = b.id
      WHERE p.role_id = ? AND p.can_read = 1 ORDER BY b.id LIMIT 10 OFFSET ?`).all(user.role_id, page * 10);
  }

  messages(userId, page, baseId) {
    this.requireMessage(userId, baseId);
    pageNumber(page);
    const rows = this.store.messages(page, baseId);
    const lastSeq = this.lastRead(userId, baseId);
    const sequence = this.db.prepare('SELECT scan_seq FROM messages WHERE id = ?');
    return rows.map(row => ({ ...row, unread: (sequence.get(row.id)?.scan_seq ?? 0) > lastSeq }));
  }

  // Caller-owned new-message pointers: one high-water mark of scan_seq per base.
  lastRead(userId, baseId) {
    return this.db.prepare('SELECT last_seq FROM message_reads WHERE user_id = ? AND base_id = ?')
      .get(userId, baseId)?.last_seq ?? 0;
  }

  advanceRead(userId, baseId, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return;
    this.db.prepare(`INSERT INTO message_reads(user_id, base_id, last_seq) VALUES (?, ?, ?)
      ON CONFLICT(user_id, base_id) DO UPDATE SET last_seq = max(last_seq, excluded.last_seq)`)
      .run(userId, baseId, sequence);
  }

  markRead(userId, messageId, baseId) {
    this.requireMessage(userId, baseId);
    const row = this.db.prepare(`SELECT scan_seq FROM messages
      WHERE id = ? AND base_id = ? AND removed = 0 AND pending = 0`).get(messageId, baseId);
    this.advanceRead(userId, baseId, row?.scan_seq);
  }

  catchUp(userId, baseId) {
    this.requireMessage(userId, baseId);
    const { sequence } = this.db.prepare(`SELECT max(scan_seq) AS sequence FROM messages
      WHERE base_id = ? AND removed = 0 AND pending = 0`).get(baseId);
    this.advanceRead(userId, baseId, sequence);
  }

  unreadCounts(userId) {
    const user = this.caller(userId);
    return new Map(this.db.prepare(`SELECT m.base_id, count(*) AS n FROM messages m
      JOIN message_permissions p ON p.base_id = m.base_id AND p.role_id = ? AND p.can_read = 1
      LEFT JOIN message_reads r ON r.user_id = ? AND r.base_id = m.base_id
      WHERE m.removed = 0 AND m.pending = 0 AND m.scan_seq > coalesce(r.last_seq, 0)
      GROUP BY m.base_id`).all(user.role_id, userId).map(row => [row.base_id, row.n]));
  }

  // The oldest unread message in the current base, then later bases, wrapping around.
  nextUnread(userId, fromBaseId) {
    const user = this.caller(userId);
    const row = this.db.prepare(`SELECT m.id, m.base_id FROM messages m
      JOIN message_permissions p ON p.base_id = m.base_id AND p.role_id = ? AND p.can_read = 1
      LEFT JOIN message_reads r ON r.user_id = ? AND r.base_id = m.base_id
      WHERE m.removed = 0 AND m.pending = 0 AND m.scan_seq > coalesce(r.last_seq, 0)
      ORDER BY CASE WHEN m.base_id = ? THEN 0 WHEN m.base_id > ? THEN 1 ELSE 2 END, m.base_id, m.scan_seq
      LIMIT 1`).get(user.role_id, userId, fromBaseId, fromBaseId);
    return row && { id: row.id, base_id: row.base_id };
  }

  message(userId, messageId, baseId) {
    this.requireMessage(userId, baseId);
    const row = this.store.message(messageId);
    return row?.base_id === baseId && !this.store.isMessagePending(messageId) ? row : undefined;
  }

  // Caller-owned new-file pointers: one high-water mark of scan_seq per file base.
  fileUnreadCounts(userId) {
    const user = this.caller(userId);
    return new Map(this.db.prepare(`SELECT f.base_id, count(*) AS n FROM transfer_files f
      JOIN file_permissions p ON p.base_id = f.base_id AND p.role_id = ? AND p.can_list = 1
      LEFT JOIN file_reads r ON r.user_id = ? AND r.base_id = f.base_id
      WHERE f.approved = 1 AND f.removed = 0 AND f.scan_seq > coalesce(r.last_seq, 0)
      GROUP BY f.base_id`).all(user.role_id, userId).map(row => [row.base_id, row.n]));
  }

  // The oldest new files across listable bases, in approval order. Rendering does not
  // mark them; callers pass the shown scan_seq values to markFilesSeen.
  newFiles(userId, limit = 10) {
    const user = this.caller(userId);
    return this.db.prepare(`SELECT f.id, f.name, f.description, f.size, f.created_at, f.base_id,
      f.scan_seq, b.name AS base_name FROM transfer_files f
      JOIN file_bases b ON b.id = f.base_id
      JOIN file_permissions p ON p.base_id = f.base_id AND p.role_id = ? AND p.can_list = 1
      LEFT JOIN file_reads r ON r.user_id = ? AND r.base_id = f.base_id
      WHERE f.approved = 1 AND f.removed = 0 AND f.scan_seq > coalesce(r.last_seq, 0)
      ORDER BY f.scan_seq LIMIT ?`).all(user.role_id, userId, limit);
  }

  // Advances only to sequences the caller was shown, never past files approved since.
  markFilesSeen(userId, rows) {
    this.caller(userId);
    for (const row of rows) this.advanceFileRead(userId, row.base_id, row.scan_seq);
  }

  advanceFileRead(userId, baseId, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return;
    this.db.prepare(`INSERT INTO file_reads(user_id, base_id, last_seq) VALUES (?, ?, ?)
      ON CONFLICT(user_id, base_id) DO UPDATE SET last_seq = max(last_seq, excluded.last_seq)`)
      .run(userId, baseId, sequence);
  }

  // Marks every currently listable file as seen; denied bases keep their pointers.
  fileCatchUp(userId) {
    const user = this.caller(userId);
    for (const row of this.db.prepare(`SELECT f.base_id, max(f.scan_seq) AS sequence FROM transfer_files f
      JOIN file_permissions p ON p.base_id = f.base_id AND p.role_id = ? AND p.can_list = 1
      WHERE f.approved = 1 AND f.removed = 0 GROUP BY f.base_id`).all(user.role_id)) {
      this.advanceFileRead(userId, row.base_id, row.sequence);
    }
  }

  fileBase(id) {
    return this.db.prepare('SELECT id, name, description FROM file_bases WHERE id = ?').get(id);
  }

  fileBases(page = 0, userId) {
    pageNumber(page);
    if (userId === undefined) {
      return this.db.prepare('SELECT id, name, description FROM file_bases ORDER BY id LIMIT 10 OFFSET ?').all(page * 10);
    }
    const user = this.caller(userId);
    return this.db.prepare(`SELECT b.id, b.name, b.description FROM file_bases b
      JOIN file_permissions p ON p.base_id = b.id
      WHERE p.role_id = ? AND p.can_list = 1 ORDER BY b.id LIMIT 10 OFFSET ?`).all(user.role_id, page * 10);
  }

  createFileBase(name, description = '') {
    name = text(name, 40, 'Base name');
    if (description) description = text(description, 80, 'Description');
    if (this.db.prepare('SELECT count(*) AS n FROM file_bases').get().n >= 100) throw new InputError('access_file_base_limit');
    if (this.db.prepare('SELECT id FROM file_bases WHERE name = ? COLLATE NOCASE').get(name)) throw new InputError('Base name is already in use.');
    const id = this.db.prepare('INSERT INTO file_bases(name, description) VALUES (?, ?)').run(name, description).lastInsertRowid;
    this.setFilePermissions(1, id, 1, 1, 1);
    return id;
  }
}

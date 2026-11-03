import { ui, uiText, errorText } from './strings.js';
import { InputError, text, messageBody, username, safeText } from './validation.js';
import { heading, messageLayout, messagePage, readMessage } from './screens.js';

const PAGE_SIZE = 10;
const MAX_PAGE = 9999;
const features = new Set(['email', 'config', 'automessage', 'bbs', 'oneliners',
  'signature', 'note', 'page', 'stats']);

export function initializeCommunity(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      signature TEXT NOT NULL DEFAULT '' CHECK (length(signature) <= 160),
      user_note TEXT NOT NULL DEFAULT '' CHECK (length(user_note) <= 60)
    );
    CREATE TABLE IF NOT EXISTS community_mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      recipient_id INTEGER NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 60),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
      created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS community_mail_recipient ON community_mail(recipient_id, id);
    CREATE TABLE IF NOT EXISTS community_automessage (
      id INTEGER PRIMARY KEY CHECK (id = 1), user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 160), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_bbs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
      address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 100),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_oneliners (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 120), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('note', 'page')),
      user_id INTEGER REFERENCES users(id), node INTEGER NOT NULL,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS community_notifications_user ON community_notifications(user_id, kind, id);
    CREATE TABLE IF NOT EXISTS community_activity (
      user_id INTEGER NOT NULL REFERENCES users(id), feature TEXT NOT NULL,
      last_at INTEGER NOT NULL, PRIMARY KEY(user_id, feature)
    );
    CREATE TABLE IF NOT EXISTS community_call_counts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), calls INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO community_call_counts(user_id, calls)
      SELECT user_id, count(*) FROM calls GROUP BY user_id;
    CREATE TRIGGER IF NOT EXISTS community_count_call AFTER INSERT ON calls BEGIN
      INSERT INTO community_call_counts(user_id, calls) VALUES (NEW.user_id, 1)
      ON CONFLICT(user_id) DO UPDATE SET calls = calls + 1;
    END;
  `);
  if (!db.prepare('PRAGMA table_info(community_profiles)').all().some(column => column.name === 'user_note')) {
    db.exec('ALTER TABLE community_profiles ADD COLUMN user_note TEXT NOT NULL DEFAULT \'\' CHECK (length(user_note) <= 60)');
  }
}

function id(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new InputError('Invalid ID.');
  return value;
}

function offset(page) {
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) throw new InputError('Invalid page.');
  return page * PAGE_SIZE;
}

function bodyPage(body, page) {
  offset(page);
  const lines = body.split('\n').flatMap(line => line.match(/.{1,76}/g) ?? ['']);
  return { body_lines: lines.slice(page * 14, page * 14 + 14).map(safeText),
    pages: Math.max(1, Math.ceil(lines.length / 14)), page };
}

function output(session, lines, frame = '') {
  session.write(frame + lines.map(safeText).join('\r\n') + '\r\n');
}

export class Community {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.guestNotes = new WeakSet();
  }

  enabled(userId, posting = false) {
    const user = this.store.user(id(userId));
    if (!user || user.disabled || (user.application_status ?? 'approved') !== 'approved') {
      throw new InputError('Account unavailable.');
    }
    if (posting && !user.can_post) throw new InputError('Posting permission denied.');
    if (posting) this.store.access.caller(userId, 'post');
    return user;
  }

  rate(userId, feature, interval = 60000) {
    const now = Date.now();
    const last = this.db.prepare('SELECT last_at FROM community_activity WHERE user_id = ? AND feature = ?')
      .get(userId, feature)?.last_at;
    if (last !== undefined && now - last < interval) throw new InputError('Please wait before sending another.');
    return now;
  }

  recordRate(userId, feature, now) {
    this.db.prepare(`INSERT INTO community_activity VALUES (?, ?, ?)
      ON CONFLICT(user_id, feature) DO UPDATE SET last_at = excluded.last_at`).run(userId, feature, now);
  }

  signature(userId) {
    this.enabled(userId);
    return this.db.prepare('SELECT signature FROM community_profiles WHERE user_id = ?').get(userId)?.signature ?? '';
  }

  setSignature(userId, value) {
    this.enabled(userId, true);
    value = value === '' ? '' : text(value, 160, 'Signature');
    this.db.prepare(`INSERT INTO community_profiles(user_id, signature) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET signature = excluded.signature`).run(userId, value);
  }

  config(userId) {
    const user = this.enabled(userId);
    return { real_name: user.real_name, location: user.location,
      user_note: this.db.prepare('SELECT user_note FROM community_profiles WHERE user_id = ?').get(userId)?.user_note ?? '' };
  }

  setConfig(userId, field, value) {
    this.enabled(userId);
    if (!['real_name', 'location', 'user_note'].includes(field)) throw new InputError('Unknown profile field.');
    value = value === '' ? '' : text(value, 60, 'Profile');
    if (field === 'user_note') {
      this.db.prepare(`INSERT INTO community_profiles(user_id, user_note) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET user_note = excluded.user_note`).run(userId, value);
    } else this.store.editUser(userId, field, value);
  }

  unread(userId) {
    this.enabled(userId);
    return this.db.prepare('SELECT count(*) AS n FROM community_mail WHERE recipient_id = ? AND read_at IS NULL')
      .get(userId).n;
  }

  inbox(userId, page = 0) {
    this.enabled(userId);
    return this.db.prepare(`SELECT m.id, u.handle, m.subject, m.created_at, m.read_at
      FROM community_mail m JOIN users u ON u.id = m.sender_id
      WHERE m.recipient_id = ? ORDER BY m.id DESC LIMIT 10 OFFSET ?`).all(userId, offset(page));
  }

  sendMail(userId, recipientId, subject, body) {
    this.enabled(userId, true);
    id(recipientId);
    subject = text(subject, 60, 'Subject');
    body = messageBody(body);
    const recipient = this.store.user(recipientId);
    if (!recipient || recipient.disabled || (recipient.application_status ?? 'approved') !== 'approved') {
      throw new InputError('Recipient unavailable.');
    }
    const now = this.rate(userId, 'email', 10000);
    if (this.db.prepare('SELECT count(*) AS n FROM community_mail').get().n >= 100000 ||
        this.db.prepare('SELECT count(*) AS n FROM community_mail WHERE recipient_id = ?').get(recipient.id).n >= 1000) {
      throw new InputError('Mailbox capacity reached.');
    }
    const result = this.db.prepare(`INSERT INTO community_mail(sender_id, recipient_id, subject, body, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(userId, recipient.id, subject, body, new Date(now).toISOString());
    this.recordRate(userId, 'email', now);
    return result.lastInsertRowid;
  }

  readMail(userId, mailId, page = 0) {
    this.enabled(userId);
    offset(page);
    const row = this.db.prepare(`SELECT m.id, u.handle, m.subject, m.body, m.created_at
      FROM community_mail m JOIN users u ON u.id = m.sender_id WHERE m.id = ? AND m.recipient_id = ?`)
      .get(id(mailId), userId);
    if (!row) throw new InputError('Mail not found.');
    this.db.prepare('UPDATE community_mail SET read_at = coalesce(read_at, ?) WHERE id = ? AND recipient_id = ?')
      .run(new Date().toISOString(), mailId, userId);
    const { body, ...header } = row;
    return { ...header, body, ...bodyPage(body, page) };
  }

  automessage(userId) {
    this.enabled(userId);
    return this.db.prepare(`SELECT a.body, a.created_at, u.handle FROM community_automessage a
      JOIN users u ON u.id = a.user_id WHERE a.id = 1 AND u.disabled = 0`).get();
  }

  setAutomessage(userId, body) {
    this.enabled(userId, true);
    body = text(body, 160, 'Automessage');
    const now = this.rate(userId, 'automessage');
    this.db.prepare(`INSERT INTO community_automessage VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, body = excluded.body,
      created_at = excluded.created_at`).run(userId, body, new Date(now).toISOString());
    this.recordRate(userId, 'automessage', now);
  }

  bbsList(userId, page = 0) {
    this.enabled(userId);
    return this.db.prepare(`SELECT b.id, b.name, b.address, u.handle, b.created_at
      FROM community_bbs b JOIN users u ON u.id = b.user_id WHERE u.disabled = 0
      ORDER BY b.id DESC LIMIT 10 OFFSET ?`).all(offset(page));
  }

  addBbs(userId, name, address) {
    this.enabled(userId, true);
    name = text(name, 40, 'BBS name');
    address = text(address, 100, 'Address');
    const now = this.rate(userId, 'bbs');
    if (this.db.prepare('SELECT count(*) AS n FROM community_bbs').get().n >= 1000) throw new InputError('BBS list full.');
    const result = this.db.prepare('INSERT INTO community_bbs(user_id, name, address, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, name, address, new Date(now).toISOString());
    this.recordRate(userId, 'bbs', now);
    return result.lastInsertRowid;
  }

  oneliners(userId, page = 0) {
    this.enabled(userId);
    return this.db.prepare(`SELECT o.id, o.body, u.handle, o.created_at
      FROM community_oneliners o JOIN users u ON u.id = o.user_id WHERE u.disabled = 0
      ORDER BY o.id DESC LIMIT 10 OFFSET ?`).all(offset(page));
  }

  addOneliner(userId, body) {
    this.enabled(userId, true);
    body = text(body, 120, 'Oneliner');
    const now = this.rate(userId, 'oneliners');
    if (this.db.prepare('SELECT count(*) AS n FROM community_oneliners').get().n >= 10000) throw new InputError('Oneliners full.');
    const result = this.db.prepare('INSERT INTO community_oneliners(user_id, body, created_at) VALUES (?, ?, ?)')
      .run(userId, body, new Date(now).toISOString());
    this.recordRate(userId, 'oneliners', now);
    return result.lastInsertRowid;
  }

  notify(session, kind, body) {
    if (!['note', 'page'].includes(kind)) throw new InputError('Unknown notification.');
    const userId = session.user?.id;
    if (userId !== undefined) this.enabled(userId);
    else if (kind !== 'note' || this.guestNotes.has(session)) throw new InputError('Only one guest note per connection.');
    if (!Number.isSafeInteger(session.id) || session.id < 1) throw new InputError('Invalid node.');
    body = kind === 'note' ? messageBody(body) : text(body, 160, 'Page reason');
    const now = userId === undefined ? Date.now() : this.rate(userId, kind, kind === 'page' ? 300000 : 60000);
    if (this.db.prepare('SELECT count(*) AS n FROM community_notifications').get().n >= 10000) {
      throw new InputError('Sysop notification capacity reached.');
    }
    const result = this.db.prepare(`INSERT INTO community_notifications(kind, user_id, node, body, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(kind, userId ?? null, session.id, body, new Date(now).toISOString());
    if (userId === undefined) this.guestNotes.add(session);
    else this.recordRate(userId, kind, now);
    return result.lastInsertRowid;
  }

  // Local-console API only. No caller command dispatches to these methods.
  notifications(page = 0) {
    return this.db.prepare(`SELECT n.id, n.kind, n.user_id, u.handle, n.node, n.created_at, n.resolved_at
      FROM community_notifications n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.resolved_at IS NULL ORDER BY n.id DESC LIMIT 10 OFFSET ?`).all(offset(page));
  }

  notification(notificationId, page = 0) {
    const row = this.db.prepare(`SELECT n.id, n.kind, n.user_id, u.handle, n.node, n.created_at, n.resolved_at, n.body
      FROM community_notifications n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = ?`).get(id(notificationId));
    if (!row) throw new InputError('Notification not found.');
    const { body, ...header } = row;
    return { ...header, ...bodyPage(body, page) };
  }

  resolveNotification(notificationId) {
    if (!this.db.prepare(`UPDATE community_notifications SET resolved_at = ?
      WHERE id = ? AND resolved_at IS NULL`).run(new Date().toISOString(), id(notificationId)).changes) {
      throw new InputError('Notification not found or already resolved.');
    }
  }

  publicStats(userId) {
    const user = this.enabled(userId);
    return { id: user.id, handle: user.handle, created_at: user.created_at, last_login: user.last_login,
      calls: this.db.prepare('SELECT calls FROM community_call_counts WHERE user_id = ?').get(userId)?.calls ?? 0,
      posts: this.db.prepare('SELECT count(*) AS n FROM messages WHERE user_id = ? AND removed = 0').get(userId).n };
  }

  stats(userId) {
    return { ...this.publicStats(userId), unread: this.unread(userId), user_note: this.config(userId).user_note,
      mail_sent: this.db.prepare('SELECT count(*) AS n FROM community_mail WHERE sender_id = ?').get(userId).n,
      mail_received: this.db.prepare('SELECT count(*) AS n FROM community_mail WHERE recipient_id = ?').get(userId).n };
  }

  async menu(session, feature, notice) {
    if (!features.has(feature)) throw new InputError('Unknown community feature.');
    if (feature !== 'note' || session.user) this.enabled(session.user?.id);
    if (!session.user && this.guestNotes.has(session)) throw new InputError('Only one guest note per connection.');
    session.communityState = { feature, page: 0 };
    session.state = `community-${feature}`;
    if (feature === 'note' || feature === 'page') {
      session.communityState.body = [];
      output(session, [feature === 'note' ? ui(this.store, 'community_private_note_to_local_sysop_end_with_abort_cancels') :
        ui(this.store, 'community_page_request_local_console_notification_only_no_live_chat_one_'),
      feature === 'note' ? ui(this.store, 'community_note_line') : ui(this.store, 'community_reason_160_characters_abort_cancels')],
      heading(uiText(this.store, feature.toUpperCase()), this.store.settings().name));
    } else this.show(session, notice);
  }

  show(session, notice) {
    const data = session.communityState;
    const userId = session.user.id;
    const frame = heading(ui(this.store, 'community_value_page_value', {
      VALUE1: uiText(this.store, data.feature.toUpperCase()), VALUE2: data.page + 1
    }), this.store.settings().name);
    const lines = [];
    if (data.feature === 'email') {
      for (const row of this.inbox(userId, data.page)) lines.push(ui(this.store, 'community_value_value_value_value', { ID: row.id, VALUE2: row.read_at ? ' ' : '*', HANDLE: row.handle, SUBJECT: row.subject }));
      lines.push(ui(this.store, 'community_id_read_w_compose_n_p_pages_q_main'));
    } else if (data.feature === 'config') {
      const profile = this.config(userId);
      lines.push(ui(this.store, 'community_private_real_name_value', { REAL_NAME: profile.real_name }), ui(this.store, 'community_private_location_value', { LOCATION: profile.location }),
        ui(this.store, 'community_own_stats_note_value', { USER_NOTE: profile.user_note }),
        ui(this.store, 'community_r_real_name_l_location_n_own_stats_note_q_main_your_profile_is'));
    } else if (data.feature === 'signature') {
      lines.push(ui(this.store, 'community_signature_value', { USER_ID: this.signature(userId) }), ui(this.store, 'community_e_edit_q_main_appended_to_public_posts_only'));
    } else if (data.feature === 'automessage') {
      const row = this.automessage(userId);
      lines.push(row ? ui(this.store, 'community_value_value', { HANDLE: row.handle, BODY: row.body }) : ui(this.store, 'community_no_automessage'), ui(this.store, 'community_w_replace_q_main'));
    } else if (data.feature === 'bbs') {
      for (const row of this.bbsList(userId, data.page)) lines.push(ui(this.store, 'community_value_value_value_value_2', { ID: row.id, NAME: row.name, ADDRESS: row.address, HANDLE: row.handle }));
      lines.push(ui(this.store, 'community_a_add_n_p_pages_q_main'));
    } else if (data.feature === 'oneliners') {
      for (const row of this.oneliners(userId, data.page)) lines.push(ui(this.store, 'community_value_value_value', { ID: row.id, HANDLE: row.handle, BODY: row.body }));
      lines.push(ui(this.store, 'community_a_add_n_p_pages_q_main'));
    } else if (data.feature === 'stats') {
      const stats = this.stats(userId);
      const transfers = session.transfers?.stats?.(userId) ?? { uploads: 0, downloads: 0 };
      for (const [key, value] of Object.entries({ ...stats, ...transfers })) lines.push(ui(this.store, 'community_value_value_2', { KEY: uiText(this.store, key), VALUE2: value ?? ui(this.store, 'label_never') }));
      lines.push(ui(this.store, 'community_q_main'));
      if (session.presentation && session.view) {
        const fallback = frame + lines.map(safeText).join('\r\n') + '\r\n';
        session.write(session.presentation.render('stats', fallback, session.view({
          CALLS: stats.calls, MAIL: stats.unread, UPLOADS: transfers.uploads,
          DOWNLOADS: transfers.downloads, ACCESS: ui(this.store, 'community_approved_caller'), USERNOTE: stats.user_note
        }).values));
        output(session, [ui(this.store, 'community_calls_value_public_posts_value', { CALLS: stats.calls, POSTS: stats.posts }),
          ui(this.store, 'community_mail_sent_value_received_value_unread_value', { MAIL_SENT: stats.mail_sent, MAIL_RECEIVED: stats.mail_received, UNREAD: stats.unread }),
          ui(this.store, 'community_q_main_command')]);
        return;
      }
    }
    if (notice) lines.push(notice);
    lines.push(ui(this.store, 'command_prompt'));
    output(session, lines, frame);
  }

  returnMain(session) {
    delete session.communityState;
    if (session.user) session.menu();
    else session.showWelcome();
  }

  async handle(session, line) {
    if (!session.state.startsWith('community-')) return false;
    try {
      if (typeof line !== 'string' || line.length > 512 || !/^[\x20-\x7e]*$/.test(line)) {
        throw new InputError('Use at most 512 printable characters per line.');
      }
      const data = session.communityState;
      if (!data || !features.has(data.feature)) throw new Error('Invalid community state');
      if (session.user) this.enabled(session.user.id);
      else if (data.feature !== 'note') throw new InputError('Log on first.');
      const command = line.trim().toUpperCase();
      if (command === '/ABORT') {
        this.returnMain(session);
        return true;
      }
      await this.command(session, line, command);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      output(session, [errorText(this.store, error), ui(this.store, 'retry_prompt')]);
    }
    return true;
  }

  async command(session, line, command) {
    const data = session.communityState;
    const userId = session.user?.id;
    if (data.feature === 'note' || data.step === 'mail-body') {
      if (line === '.') {
        const body = messageBody(data.body.join('\n'));
        if (data.feature === 'note') {
          this.notify(session, 'note', body);
          output(session, [ui(this.store, 'community_private_note_saved_for_the_local_sysop')]);
          this.returnMain(session);
        } else {
          this.sendMail(userId, data.recipientId, data.subject, body);
          await this.menu(session, 'email', ui(this.store, 'community_private_email_sent'));
        }
      } else {
        if (data.body.length >= 50 || data.body.join('\n').length + line.length + 1 > 4096) {
          throw new InputError('Maximum 50 lines / 4096 characters. End with . or /abort.');
        }
        data.body.push(line);
        output(session, [ui(this.store, 'community_next_line_ends')]);
      }
      return;
    }
    if (data.feature === 'page') {
      this.notify(session, 'page', line);
      output(session, [ui(this.store, 'community_page_request_saved_the_local_sysop_may_be_unavailable_no_live_')]);
      this.returnMain(session);
      return;
    }
    if (data.step === 'mail-read') {
      if (command === 'Q') return this.menu(session, 'email');
      if (!['N', 'P'].includes(command)) throw new InputError('Use N/P or Q.');
      data.readPage = Math.max(0, Math.min(data.readPages - 1, data.readPage + (command === 'N' ? 1 : -1)));
      return this.showMail(session);
    }
    if (data.step) {
      if (data.step === 'mail-handle') {
        username(line);
        const recipient = this.store.findUser(line);
        if (!recipient || recipient.disabled || (recipient.application_status ?? 'approved') !== 'approved') {
          throw new InputError('Recipient unavailable.');
        }
        data.recipientId = recipient.id;
        data.step = 'mail-subject';
        output(session, [ui(this.store, 'community_subject_60_characters')]);
        return;
      }
      if (data.step === 'mail-subject') {
        data.subject = text(line, 60, 'Subject');
        data.body = [];
        data.step = 'mail-body';
        output(session, [ui(this.store, 'community_private_email_body_end_with_abort_cancels')]);
        return;
      }
      if (data.step === 'profile') this.setConfig(userId, data.field, line === '-' ? '' : line);
      else if (data.step === 'signature') this.setSignature(userId, line === '-' ? '' : line);
      else if (data.step === 'automessage') this.setAutomessage(userId, line);
      else if (data.step === 'oneliners') this.addOneliner(userId, line);
      else if (data.step === 'bbs-name') {
        data.bbsName = text(line, 40, ui(this.store, 'community_bbs_name'));
        data.step = 'bbs-address';
        output(session, [ui(this.store, 'community_address_100_printable_characters')]);
        return;
      } else if (data.step === 'bbs-address') this.addBbs(userId, data.bbsName, line);
      else throw new Error('Invalid community editor state');
      return this.menu(session, data.feature, ui(this.store, 'community_saved'));
    }
    if (command === 'Q') return this.returnMain(session);
    if (['N', 'P'].includes(command) && ['email', 'bbs', 'oneliners'].includes(data.feature)) {
      data.page = Math.max(0, Math.min(MAX_PAGE, data.page + (command === 'N' ? 1 : -1)));
    } else if (data.feature === 'email' && /^[1-9]\d{0,14}$/.test(command)) {
      data.mailId = id(Number(command));
      data.readPage = 0;
      data.step = 'mail-read';
      return this.showMail(session);
    } else if (data.feature === 'email' && command === 'W') {
      this.enabled(userId, true);
      data.step = 'mail-handle';
      output(session, [ui(this.store, 'community_recipient_handle')]);
      return;
    } else if (data.feature === 'config' && ['R', 'L', 'N'].includes(command)) {
      data.field = command === 'R' ? 'real_name' : command === 'L' ? 'location' : 'user_note';
      data.step = 'profile';
      output(session, [ui(this.store, 'community_private_value_60_characters_clears_abort_cancels')]);
      return;
    } else if ((data.feature === 'signature' && command === 'E') ||
      (data.feature === 'automessage' && command === 'W') ||
      (['bbs', 'oneliners'].includes(data.feature) && command === 'A')) {
      this.enabled(userId, true);
      data.step = data.feature === 'bbs' ? 'bbs-name' : data.feature;
      output(session, [data.feature === 'bbs' ? ui(this.store, 'community_bbs_name_40_characters') :
        ui(this.store, 'community_text_signature_automessage_160_oneliner_120_clears_signature_a')]);
      return;
    } else if (command !== '?') throw new InputError('Unknown community command.');
    this.show(session);
  }

  showMail(session) {
    const data = session.communityState;
    const row = this.readMail(session.user.id, data.mailId, data.readPage);
    const header = [ui(this.store, 'community_email_value_from_value_value', { ID: row.id, HANDLE: row.handle, SUBJECT: row.subject }),
      ui(this.store, 'community_page_value_value', { VALUE1: row.page + 1, PAGES: row.pages })];
    if (session.view) {
      const view = session.view({ PAGE: data.readPage + 1, MESSAGEAUTHOR: row.handle, RECIPIENT: session.user.handle,
        MESSAGESUBJECT: row.subject, MESSAGEID: row.id,
        MESSAGEDATE: row.created_at.slice(0, 16).replace('T', ' '), BASENAME: ui(this.store, 'community_private_mail') });
      const layout = messageLayout(view, row);
      const content = messagePage(row.body, data.readPage, layout.pageSize, layout.width);
      data.readPages = content.pages;
      data.readPage = content.page;
      session.write(readMessage(row, content.page, session.name, view, true));
      return;
    }
    data.readPages = row.pages;
    output(session, [...header, ...row.body_lines, ui(this.store, 'community_n_p_pages_q_inbox')],
      heading(ui(this.store, 'community_private_mail'), this.store.settings().name));
  }
}

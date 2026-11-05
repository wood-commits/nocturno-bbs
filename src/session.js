import { ui, uiText, errorText } from './strings.js';
import { InputError, username, password, text, messageBody } from './validation.js';
import { TelnetInput } from './telnet.js';
import * as screens from './screens.js';
import { loginChoices, mainChoices, mainInitialSelection, mainChoiceGrid } from './presentation.js';
import { doorScreen, doorCommand } from './doors.js';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

export class Session extends EventEmitter {
  constructor({ socket, store, auth, id, secure, onError, presentation, community, transfers, local = false }) {
    super();
    Object.assign(this, { socket, store, auth, id, secure, onError, presentation, community, transfers });
    this.local = local;
    this.screenHistory = '';
    this.baseId = 1;
    this.state = 'welcome';
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.attempts = 0;
    this.page = 0;
    this.tokens = 16384;
    this.tokenTime = Date.now();
    this.lastPost = 0;
    this.selected = 0;
    this.mainSelected = mainInitialSelection;
    this.started = Date.now();
    this.sessionMinutes = store.settings().session_minutes;
    this.editor = new TelnetInput({
      write: data => this.write(data),
      mode: () => this.transferRaw ? 'raw' : this.welcomePlayback ? 'key' :
        !this.busy && ['welcome', 'main', 'post-welcome', 'art'].includes(this.state) ? 'key' : 'line',
      shortcuts: () => this.busy || this.shortcut ? '' : this.shortcuts(),
      secret: () => this.busy || this.state.includes('password')
    });
    this.editor.on('line', line => {
      if (this.queue.length >= 16) return this.disconnect('Too many queued commands.');
      this.queue.push(line);
      void this.drain();
    });
    this.editor.on('key', key => {
      if (this.busy || this.welcomePlayback) return;
      if (['post-welcome', 'art'].includes(this.state)) return this.menu();
      const choices = this.state === 'welcome' ? loginChoices : mainChoices;
      if (['up', 'down', 'left', 'right'].includes(key)) {
        this.shortcut = undefined;
        if (this.state === 'main' && (key === 'up' || key === 'down')) {
          const grid = mainChoiceGrid;
          const row = grid.findIndex(items => items.includes(this.selected));
          const column = grid[row].indexOf(this.selected);
          const next = grid[(row + (key === 'up' ? 5 : 1)) % grid.length];
          this.selected = next[column] ?? next[1];
        } else this.selected = (this.selected + (key === 'up' || key === 'left' ? choices.length - 1 : 1)) % choices.length;
        this.drawMenu();
      } else if (key === 'enter') {
        if (this.queue.length >= 16) return this.disconnect('Too many queued commands.');
        this.queue.push(this.shortcut ?? choices[this.selected][0]);
        this.shortcut = undefined;
        void this.drain();
      } else if (key === 'backspace') {
        this.shortcut = this.shortcut?.slice(0, -1) || undefined;
      } else {
        if ((this.shortcut?.length ?? 0) >= 160) return this.disconnect('Input line too long.');
        this.shortcut = (this.shortcut ?? '') + key.toUpperCase();
        const index = choices.findIndex(([shortcut]) => shortcut === this.shortcut);
        if (index >= 0) { this.selected = index; this.drawMenu(); }
      }
    });
    this.editor.on('raw', data => this.transfers?.feed(this, data));
    this.editor.on('violation', reason => this.disconnect(reason));
    const settings = store.settings();
    socket.setTimeout(settings.idle_minutes * 60 * 1000, () => this.disconnect('Idle timeout.'));
    this.lifetime = setTimeout(() => this.disconnect('Session time limit reached.'), settings.session_minutes * 60 * 1000);
    this.lifetime.unref();
    socket.on('data', data => {
      const now = Date.now();
      if (Boolean(this.transferRaw) !== Boolean(this.rawRate)) {
        this.rawRate = Boolean(this.transferRaw);
        this.tokens = this.rawRate ? 131072 : 16384;
      }
      this.tokens = Math.min(this.rawRate ? 131072 : 16384,
        this.tokens + (now - this.tokenTime) * (this.rawRate ? 256 : 8));
      this.tokenTime = now;
      this.tokens -= data.length;
      if (this.tokens < 0) {
        if (!this.rawRate) return this.disconnect('Input rate exceeded.');
        socket.pause();
        this.rateTimer = setTimeout(() => {
          if (!this.closed) socket.resume();
        }, Math.ceil(-this.tokens / 256));
        this.rateTimer.unref();
      }
      try { this.editor.feed(data); }
      catch (error) {
        if (!(error instanceof InputError)) this.onError(error);
        this.disconnect(error instanceof InputError ? errorText(this.store, error) : ui(this.store, 'session_internal_error_please_contact_the_sysop'));
      }
    });
    socket.on('error', error => {
      this.onError(error);
      socket.destroy();
    });
    socket.on('close', () => this.cleanup());
    if (local) this.editor.echoAccepted = true;
    else this.editor.negotiate();
    this.showWelcome();
  }

  get name() { return this.store.settings().name; }

  shortcuts() {
    if (this.state === 'sysop-chat') return '';
    if (this.state === 'welcome') return 'LNCSQ';
    if (this.state === 'main') return mainChoices.map(([key]) => key).join('') + 'A?';
    if (this.state === 'read') return 'RNPQ';
    if (['users', 'callers', 'bases'].includes(this.state)) return 'NPQ';
    if (this.state === 'messages') return 'WBNPQ';
    if (this.state === 'doors') return '1Q';
    if (this.state === 'realm') return 'ETHBFMWLCNP?Q';
    if (this.state === 'transfer-files') return 'UBNPQ';
    if (this.state === 'transfer-bases') return 'NPQ';
    if (this.state === 'transfer-qwk') return 'DUQ';
    const data = this.communityState;
    if (!this.state.startsWith('community-') || !data || (data.step && data.step !== 'mail-read')) return '';
    if (data.step === 'mail-read') return 'NPQ';
    return new Map([['email', 'WNPQ'], ['config', 'RLNQ'], ['signature', 'EQ'],
      ['automessage', 'WQ'], ['bbs', 'ANPQ'], ['oneliners', 'ANPQ'], ['stats', 'Q']]).get(data.feature) ?? '';
  }

  string(key, values) { return ui(this.store, key, values); }

  view(extra = {}) {
    return {
      store: this.store,
      presentation: this.presentation,
      strings: { selection: this.string('selection'), main_prompt: this.string('main_prompt') },
      values: {
        BBSNAME: this.name, USERNAME: this.user?.handle ?? ui(this.store, 'label_guest'), NODE: this.id,
        DATE: ui(this.store, 'session_value_utc', { VALUE1: screens.date(new Date().toISOString()) }), PAGE: this.page + 1,
        BASENAME: this.user && this.store.access.messagePermissions(this.store.user(this.user.id)?.role_id, this.baseId)?.can_read
          ? this.store.base(this.baseId)?.name ?? '' : '', BASEID: this.baseId,
        TRANSPORT: this.secure ? ui(this.store, 'session_tls_transport_active') : ui(this.store, 'session_local_telnet_no_transport_encryption_use_only_locally_or_via_s'),
        TAGLINE: this.string('welcome_tagline'), LOGINHELP: ui(this.store, 'login_help'),
        RECIPIENT: ui(this.store, 'label_all'),
        ...extra
      }
    };
  }

  readScreen() {
    const row = this.store.access.message(this.user.id, this.reading.id, this.baseId);
    if (!row) throw new InputError('Message no longer exists.');
    this.reading = row;
    this.write(screens.readMessage(row, this.readPage, this.name, this.view({
      PAGE: this.readPage + 1, MESSAGEID: row.id, MESSAGEAUTHOR: row.handle,
      MESSAGESUBJECT: row.subject, MESSAGEDATE: screens.date(row.created_at)
    })));
  }

  composePost(reply) {
    if (!this.user.can_post) throw new InputError('permission_denied');
    this.store.access.requireMessage(this.user.id, this.baseId, 'post');
    if (Date.now() - this.lastPost < 10000) throw new InputError('Please wait 10 seconds between posts.');
    this.replyTo = reply?.id ?? null;
    this.replySubject = reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`).slice(0, 60) : undefined;
    this.state = 'subject';
    if (this.presentation) this.write(this.presentation.render('compose', '', this.view().values));
    if (reply) this.write('\r\n' + this.string('message_reply_context', { MESSAGEID: reply.id }) + '\r\n');
    this.write('\r\n' + this.prompt());
  }

  write(data) {
    if (this.closed || this.socket.destroyed) return;
    if (this.socket.writableLength > 65536) {
      this.socket.destroy();
      return;
    }
    const rendered = typeof data === 'string' || data instanceof String;
    this.socket.write(rendered ? Buffer.from(String(data), 'latin1') : data);
    if (rendered && !this.transferRaw) {
      const text = String(data);
      const clear = text.lastIndexOf('\x1b[2J');
      if (clear >= 0) this.screenHistory = screens.ansi.reset + text.slice(clear);
      else if (this.screenHistory !== undefined) this.screenHistory += text;
      if ((this.screenHistory?.length ?? 0) > 131072) this.screenHistory = undefined;
      this.emit('display', text);
    }
  }

  startChat() {
    if (!this.user || this.closed) throw new InputError('console_authenticated_only');
    if (this.busy || this.queue.length || this.transferRaw || this.editor.line || this.shortcut || this.chat) {
      throw new InputError('console_caller_busy');
    }
    if (this.screenHistory === undefined) throw new InputError('console_screen_unavailable');
    this.chat = { state: this.state, screen: this.screenHistory };
    this.state = 'sysop-chat';
    this.write(screens.heading(ui(this.store, 'console_chat_title'), this.name) +
      ui(this.store, 'console_chat_started') + '\r\n');
  }

  chatMessage(line) {
    if (!this.chat || this.closed) throw new InputError('console_chat_unavailable');
    const message = text(line, 160, 'Chat message');
    this.write('\r\n' + ui(this.store, 'console_chat_sysop', { TEXT: message }) + '\r\n');
  }

  endChat() {
    if (!this.chat) return;
    const { state, screen } = this.chat;
    this.chat = undefined;
    this.editor.line = '';
    this.queue.length = 0;
    this.state = state;
    if (this.closed) return;
    try {
      const current = this.store.access.caller(this.user.id);
      this.user = current;
      if (['messages', 'subject', 'body'].includes(state)) {
        this.store.access.requireMessage(current.id, this.baseId, state === 'messages' ? 'read' : 'post');
      }
      if (['messages', 'bases'].includes(state)) return this.showList();
      if (state === 'read') return this.readScreen();
      if (state === 'transfer-files') {
        this.store.access.requireFile(current.id, this.fileBaseId ?? 1);
        return this.transfers.show(this);
      }
      if (state === 'transfer-bases') return this.transfers.show(this);
      if (['doors', 'realm'].includes(state)) this.store.access.caller(current.id, 'doors');
      this.write(screens.ansi.reset + screens.ansi.clear + screen);
    } catch (error) {
      if (!(error instanceof InputError)) {
        this.onError(error);
        return this.disconnect(ui(this.store, 'session_internal_error_please_contact_the_sysop'));
      }
      const user = this.store.user(this.user.id);
      if (!user || user.disabled || user.application_status !== 'approved') return this.disconnect(ui(this.store, 'session_account_unavailable'));
      this.subject = this.body = this.reading = undefined;
      this.replyTo = null;
      this.replySubject = undefined;
      this.menu();
      this.write('\r\n' + errorText(this.store, error) + '\r\n' + this.string('main_prompt'));
    }
  }

  disconnect(reason) {
    if (this.closed) return;
    this.pendingPassword = undefined;
    reason = errorText(this.store, reason);
    this.write(('\r\n' + (screens.ansi.reset) + (reason) + '\r\n'));
    this.closed = true;
    this.editor.failed = true;
    clearTimeout(this.welcomeTimer);
    this.cancelWelcome?.();
    this.socket.end();
    this.destroyTimer = setTimeout(() => this.socket.destroy(), 1000);
    this.destroyTimer.unref();
  }

  cleanup() {
    this.closed = true;
    this.queue.length = 0;
    this.editor.line = '';
    this.pendingHandle = undefined;
    this.pendingPassword = undefined;
    this.subject = undefined;
    this.body = undefined;
    this.replyTo = null;
    this.replySubject = undefined;
    this.chat = undefined;
    this.screenHistory = '';
    this.transfers?.cancel?.(this);
    clearTimeout(this.lifetime);
    clearTimeout(this.dailyTimer);
    clearTimeout(this.destroyTimer);
    clearTimeout(this.rateTimer);
    clearTimeout(this.welcomeTimer);
    this.cancelWelcome?.();
    if (this.callId) {
      try { this.store.endCall(this.callId); }
      catch (error) { this.onError(error); }
      this.callId = undefined;
    }
    this.emit('session-close');
    this.removeAllListeners();
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.closed) {
        const line = this.queue.shift();
        try { await this.handle(line); }
        catch (error) {
          if (error instanceof InputError) {
            if (this.state.endsWith('handle')) {
              this.loginScreen(errorText(this.store, error));
              continue;
            }

            if (this.state.endsWith('password')) {
              this.attempts++;
              if (this.attempts >= 5) this.disconnect(ui(this.store, 'session_too_many_authentication_attempts'));
              else if (this.state === 'register-confirm-password') {
                this.pendingPassword = undefined;
                this.state = 'register-password';
                this.loginScreen(errorText(this.store, error));
              } else this.showWelcome(errorText(this.store, error));
            } else if (this.state === 'welcome') this.showWelcome(errorText(this.store, error));
            else this.write(`\r\n${errorText(this.store, error)}\r\n${this.prompt()}`);
          } else {
            this.onError(error);
            this.disconnect(ui(this.store, 'session_internal_error_please_contact_the_sysop'));
          }
        }
      }
    } finally { this.busy = false; }
  }

  checkDailyTime() {
    if (this.closed) return;
    try {
      const delay = this.store.limits.nextCheck(this.user.id);
      this.dailyTimer = setTimeout(() => this.checkDailyTime(), delay);
      this.dailyTimer.unref();
    } catch (error) {
      if (error instanceof InputError) this.disconnect(error);
      else {
        this.onError(error);
        this.disconnect(ui(this.store, 'session_internal_error_please_contact_the_sysop'));
      }
    }
  }

  prompt() {
    if (this.state.endsWith('handle') || this.state.endsWith('password')) {
      const handle = this.state.endsWith('handle');
      const position = this.presentation?.position('login', handle ? '|{LOGINHANDLE}' : '|{LOGINPASSWORD}');
      if (position) return position;
      const prefix = this.presentation?.templates.has('login') ? '\x1b[23;1H\x1b[2K' : handle ? '\r\n' : '';
      return prefix + ui(this.store, handle ? 'handle_prompt' :
        this.state === 'register-confirm-password' ? 'confirm_password_prompt' : 'password_prompt');
    }
    if (this.state === 'subject') return this.replySubject
      ? this.string('reply_subject_prompt', { SUBJECT: this.replySubject }) : this.string('subject_prompt');
    if (this.state === 'body') return this.string('body_prompt');
    return ui(this.store, 'command_prompt_2');
  }

  loginScreen(error) {
    const confirming = this.state === 'register-confirm-password';
    const status = confirming ? ui(this.store, 'session_confirm_password') :
      this.state.startsWith('register') ? ui(this.store, 'session_apply_for_an_account') :
      this.state.startsWith('status') ? ui(this.store, 'session_check_application') : ui(this.store, 'label_login');
    this.write(this.presentation?.render('login', '', this.view({ LOGINSTATUS: error ?? status }).values) ?? '');
    const notice = error ?? (confirming && this.presentation?.templates.has('login') ? status : undefined);
    if (notice && !this.presentation?.position('login', '|{LOGINSTATUS}')) {
      this.write(`${this.presentation?.templates.has('login') ? '\x1b[22;1H\x1b[2K' : '\r\n'}${notice}\r\n`);
    }
    this.write(this.prompt());
  }

  drawMenu(notice) {
    if (this.state === 'main') this.mainSelected = this.selected;
    this.write(this.state === 'welcome'
      ? screens.loginMatrix(this.name, this.secure, this.view(), this.selected, notice)
      : screens.mainMenu(this.name, this.user.handle, this.id, this.view(), this.selected));
  }

  showWelcome(notice) {
    this.state = 'welcome';
    this.selected = 0;
    this.shortcut = undefined;
    this.pendingHandle = undefined;
    this.pendingPassword = undefined;
    this.editor.line = '';
    this.drawMenu(notice);
  }

  async welcomeArt(title, prompt) {
    const fallback = screens.heading(ui(this.store, title), this.name);
    const artwork = String(this.presentation?.render('welcome', fallback, this.view().values) ?? fallback);
    // Keep CSI controls and CRLF intact for screen history and local node watchers.
    // eslint-disable-next-line no-control-regex
    const tokens = artwork.matchAll(/\x1b\[[0-?]*[ -/]*[@-~]|\r\n|[\s\S]/g);
    this.welcomePlayback = true;
    this.queue.length = 0;
    try {
      await new Promise(resolve => {
        this.cancelWelcome = resolve;
        const started = performance.now();
        let bytes = 0;
        const next = () => {
          if (this.closed || this.socket.destroyed) return resolve();
          let chunk = '';
          for (let i = 0; i < 32; i++) {
            const token = tokens.next();
            if (token.done) break;
            chunk += token.value[0];
          }
          if (!chunk) return resolve();
          bytes += chunk.length;
          this.welcomeTimer = setTimeout(() => {
            this.write(chunk);
            next();
          }, Math.max(0, Math.ceil(bytes * 1000 / 2880 - (performance.now() - started))));
          this.welcomeTimer.unref();
        };
        next();
      });
    } finally {
      clearTimeout(this.welcomeTimer);
      this.cancelWelcome = undefined;
      this.welcomePlayback = false;
    }
    if (!this.closed && !this.socket.destroyed) this.write('\r\n' + ui(this.store, prompt));
  }

  menu() {
    this.state = 'main';
    this.page = 0;
    this.selected = this.mainSelected;
    this.shortcut = undefined;
    this.editor.line = '';
    this.drawMenu();
  }

  realmScreen(content) {
    const fallback = screens.ansi.reset + screens.ansi.clear;
    this.write((this.presentation?.render('realm', fallback, this.view().values) ?? fallback) + content);
  }

  showList() {
    if (this.state === 'users') this.write(screens.userList(this.store.users(this.page), this.page, this.name, this.view()));
    else if (this.state === 'callers') this.write(screens.callerList(this.store.callers(this.page), this.page, this.name, this.view()));
    else if (this.state === 'bases') this.write(screens.baseList(this.store.access.messageBases(this.user.id, this.page), this.page, this.name, this.view()));
    else this.write(screens.messageList(this.store.access.messages(this.user.id, this.page, this.baseId), this.page, this.name, this.view()));
  }

  async handle(line) {
    if (this.user) {
      const current = this.store.user(this.user.id);
      if (!current || current.disabled || current.application_status !== 'approved') return this.disconnect(ui(this.store, 'session_account_unavailable'));
      this.user = current;
    }
    const command = line.trim().toUpperCase();
    if (this.state === 'sysop-chat') {
      if (line.trim()) this.write('\r\n' + ui(this.store, 'console_chat_caller', {
        HANDLE: this.user.handle, TEXT: text(line, 160, 'Chat message')
      }) + '\r\n');
      return;
    }
    if (await this.community?.handle(this, line)) return;
    if (await this.transfers?.handle(this, line)) return;
    if (this.state === 'welcome') {
      if (command === 'Q') return this.disconnect(this.string('login_goodbye'));
      if (command === 'S') return this.community.menu(this, 'note');
      if (!['L', 'N', 'C'].includes(command)) {
        this.write(ui(this.store, 'session_selection_l_n_c_s_q'));
        return;
      }
      if (command === 'N' && !this.store.settings().registration) {
        throw new InputError('New caller registration is closed.');
      }
      this.state = command === 'L' ? 'login-handle' : command === 'C' ? 'status-handle' : 'register-handle';
      this.loginScreen();
    } else if (this.state.endsWith('handle')) {
      if (command === '/ABORT') return this.showWelcome();
      if (!this.editor.echoAccepted) {
        return this.disconnect(ui(this.store, 'session_use_a_telnet_client_that_negotiates_server_echo_before_logging'));
      }
      this.pendingHandle = username(line);
      this.state = this.state === 'login-handle' ? 'login-password' :
        this.state === 'status-handle' ? 'status-password' : 'register-password';
      this.write(this.prompt());
    } else if (this.state.endsWith('password')) {
      if (command === '/ABORT') return this.showWelcome();
      password(line);
      if (this.state === 'register-password') {
        this.pendingPassword = line;
        this.state = 'register-confirm-password';
        this.loginScreen();
        return;
      }
      const registering = this.state === 'register-confirm-password';
      const checking = this.state === 'status-password';
      if (registering) {
        if (line !== this.pendingPassword) throw new InputError('Passwords do not match. Enter a new password.');
        this.pendingPassword = undefined;
        this.state = 'register-password';
      }
      const user = registering
        ? await this.auth.register(this.pendingHandle, line, this.socket.remoteAddress, true)
        : await this.auth.login(this.pendingHandle, line, this.socket.remoteAddress, checking);
      if (this.closed || this.socket.destroyed) return;
      if (registering || checking) {
        this.showWelcome(ui(this.store, 'session_application_value', {
          VALUE1: uiText(this.store, registering ? 'pending local sysop approval' : user.status)
        }));
        return;
      }
      this.callId = this.store.startCall(user.id, this.id);
      this.user = user;
      this.pendingHandle = undefined;
      this.checkDailyTime();
      this.state = 'post-welcome';
      await this.welcomeArt('session_welcome', 'continue_prompt');
    } else if (!this.user) {
      throw new Error('Authenticated state without a caller');
    } else if (this.state === 'main') {
      if (command === 'D') {
        if (!this.user.can_doors) throw new InputError('permission_denied');
        this.store.access.caller(this.user.id, 'doors');
      }
      const selected = mainChoices.findIndex(([key]) => key === command);
      if (selected >= 0) this.mainSelected = this.selected = selected;
      if (command === 'Q' || command === '/G') return this.disconnect(this.string('goodbye'));
      if (command === '?') {
        this.state = 'art';
        this.write(screens.heading(ui(this.store, 'session_main_menu_help'), this.name) +
          mainChoices.map(([key, label]) => (ui(this.store, 'session_value_value', { KEY: key, LABEL: label }) + '\r\n')).join('') +
          (ui(this.store, 'session_a_welcome_artwork') + '\r\n' + ui(this.store, 'return_prompt')));
        return;
      }
      const feature = new Map([['E', 'email'], ['C', 'config'], ['O', 'automessage'], ['B', 'bbs'],
        ['I', 'oneliners'], ['G', 'signature'], ['S', 'note'], ['P', 'page'], ['T', 'stats']]).get(command);
      if (feature) return this.community.menu(this, feature);
      if (command === 'F' || command === 'K') return this.transfers.menu(this, command === 'F' ? 'files' : 'qwk');
      if (command === 'A') {
        this.state = 'art';
        await this.welcomeArt('session_welcome_art', 'return_prompt');
      } else if (command === 'D') {
        this.state = 'doors';
        this.write(screens.doorMenu(this.name, this.view()));
      } else if (['U', 'L', 'M'].includes(command)) {
        this.state = command === 'U' ? 'users' : command === 'L' ? 'callers' : 'messages';
        if (command === 'M') {
          const first = this.store.access.messageBases(this.user.id)[0];
          if (!first || !this.store.access.messagePermissions(this.user.role_id, this.baseId)?.can_read) {
            this.state = 'bases';
          }
        }
        this.page = 0;
        this.showList();
      } else this.menu();
    } else if (this.state === 'art') {
      this.menu();
    } else if (this.state === 'doors' || this.state === 'realm') {
      if (command === 'Q') {
        if (this.state === 'doors') return this.menu();
        this.state = 'doors';
        return this.write(screens.doorMenu(this.name, this.view()));
      }
      if (!this.user.can_doors) throw new InputError('permission_denied');
      this.store.access.caller(this.user.id, 'doors');
      if (this.state === 'doors') {
        if (command !== '1') throw new InputError('Choose 1 or Q.');
        this.state = 'realm';
        this.page = 0;
        this.realmScreen(doorScreen(this.store, this.user.id, this.page));
      } else {
        const result = doorCommand(this.store, this.user.id, line, this.page);
        this.page = result.page;
        this.realmScreen(result.text);
      }
    } else if (['users', 'callers', 'messages', 'bases'].includes(this.state)) {
      if (command === 'Q') return this.menu();
      if (this.state === 'messages' && command === 'B') {
        this.state = 'bases';
        this.page = 0;
        return this.showList();
      }
      if (this.state === 'bases' && /^[1-9][0-9]{0,8}$/.test(command)) {
        const base = this.store.base(Number(command));
        if (!base) throw new InputError('Message base not found.');
        this.store.access.requireMessage(this.user.id, base.id);
        this.baseId = base.id;
        this.state = 'messages';
        this.page = 0;
        return this.showList();
      }
      if (this.state === 'messages' && command === 'W') {
        this.composePost();
      } else if (this.state === 'messages' && /^[1-9][0-9]{0,8}$/.test(command)) {
        const message = this.store.access.message(this.user.id, Number(command), this.baseId);
        if (!message || message.base_id !== this.baseId) throw new InputError('Message not found in this base.');
        this.reading = message;
        this.readPage = 0;
        this.state = 'read';
        this.readScreen();
      } else {
        if (command === 'N' && this.page < 9999) this.page++;
        if (command === 'P') this.page = Math.max(0, this.page - 1);
        this.showList();
      }
    } else if (this.state === 'read') {
      if (command === 'Q') {
        this.reading = undefined;
        this.state = this.store.access.messagePermissions(this.user.role_id, this.baseId)?.can_read ? 'messages' : 'bases';
        if (this.state === 'bases') this.page = 0;
        return this.showList();
      }
      this.reading = this.store.access.message(this.user.id, this.reading.id, this.baseId);
      if (!this.reading) {
        this.state = 'messages';
        this.write(('\r\n' + (this.string('removed')) + '\r\n'));
        return this.showList();
      }
      if (command === 'R') return this.composePost(this.reading);
      const layout = screens.messageLayout(this.view(), this.reading);
      const { pages } = screens.messagePage(this.reading.body, 0, layout.pageSize, layout.width);
      if (command === 'N') this.readPage = Math.min(pages - 1, this.readPage + 1);
      if (command === 'P') this.readPage = Math.max(0, this.readPage - 1);
      this.readScreen();
    } else if (this.state === 'subject') {
      if (command === '/ABORT') return this.cancelPost();
      if (!this.user.can_post) throw new InputError('permission_denied');
      this.store.access.requireMessage(this.user.id, this.baseId, 'post');
      this.subject = text(line.trim() ? line : this.replySubject ?? line, 60, 'Subject');
      this.body = [];
      this.state = 'body';
      this.write(((this.string('editor_help')) + '\r\n' + (this.string('body_prompt'))));
    } else if (this.state === 'body') {
      if (command === '/ABORT') return this.cancelPost();
      if (!this.user.can_post) throw new InputError('permission_denied');
      this.store.access.requireMessage(this.user.id, this.baseId, 'post');
      if (line === '.') {
        const signature = this.community?.signature(this.user.id);
        const body = messageBody(this.body.join('\n') + (signature ? ('\n' + '-- ' + '\n' + ui(this.store, 'session_value_2', { SIGNATURE: signature })) : ''));
        const id = this.store.post(this.user.id, this.subject, body, this.baseId, this.replyTo ?? null);
        this.lastPost = Date.now();
        this.cancelPost();
        this.write(('\r\n' + (this.string(this.store.isMessagePending(id) ? 'moderation_queued' : 'posted', { MESSAGEID: id })) + '\r\n'));
      } else {
        if (this.body.length >= 50 || this.body.join('\n').length + line.length + 1 > 4096) {
          throw new InputError('Message limit reached. Enter . to save or /abort to cancel.');
        }
        this.body.push(line);
        this.write(this.string('body_prompt'));
      }
    }
  }

  cancelPost() {
    this.subject = undefined;
    this.body = undefined;
    this.replyTo = null;
    this.replySubject = undefined;
    this.reading = undefined;
    this.state = this.store.access.messagePermissions(this.user.role_id, this.baseId)?.can_read ? 'messages' : 'bases';
    if (this.state === 'bases') this.page = 0;
    this.showList();
  }
}

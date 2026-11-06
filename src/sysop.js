import { ui, uiText, errorText, pipeText, rawString, plainText, STRING_SOURCE_LIMIT } from './strings.js';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { InputError, safeText, username, text } from './validation.js';
import { ansi, date, waitingScreen, sysopScreen, sysopMenuRow, sysopFooter, readMessage, messagePage,
  stringEditorList, stringEditorDetail, sysopInput, sysopClip } from './screens.js';
import { stringDefaults } from './presentation.js';
import { LocalTerminal } from './local-terminal.js';
import { MAX_RATIO, MAX_DAILY_MINUTES } from './limits.js';

const stringPageSize = 3;
const userFields = [
  ['handle', 'user_editor_handle'],
  ['real_name', 'user_editor_real_name'],
  ['location', 'user_editor_location'],
  ['sysop_note', 'user_editor_sysop_note'],
  ['can_post', 'user_editor_post'],
  ['can_doors', 'user_editor_doors'],
  ['disabled', 'user_editor_disabled'],
  ['role_id', 'access_role_label']
];

function id(value) {
  if (!/^[1-9][0-9]{0,15}$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
    throw new InputError('Enter a valid numeric ID.');
  }
  return Number(value);
}

export class SysopConsole {
  constructor({ store, bbs, output, onQuit, onError, uptime = () => process.uptime() }) {
    Object.assign(this, { store, bbs, output, onQuit, onError, uptime });
    this.output = new LocalTerminal(output);
    this.view = 'wfc';
    this.page = 0;
    this.notice = '';
    this.baseId = 1;
  }

  render() {
    if (['watch', 'chat', 'local'].includes(this.view)) return;
    this.output.resize();
    const rows = this.output.rows;
    const settings = this.store.settings();
    if (this.view === 'strings' && this.field?.stringKey) {
      const key = this.field.stringKey;
      const source = this.editBuffer ?? rawString(this.store, key);
      const lines = stringEditorDetail(this.store, key, source);
      this.prompt = this.field.prompt;
      this.output.write(sysopScreen(ui(this.store, 'string_editor_edit_title', { KEY: key }),
        settings.name, lines, this.field.prompt, rows) +
        sysopFooter(ui(this.store, 'sysop_value_2', { VALUE1: safeText(this.notice) }), this.field.prompt, rows));
      this.renderInput(this.inputBuffer ?? '');
      return;
    }
    let frame, prompt, requestNotice = '';
    if (this.view === 'wfc') {
      frame = waitingScreen(settings.name, this.store.stats(), this.bbs.nodes(), this.bbs.endpoints, this.uptime(), this.store, rows);
      const requests = this.bbs.community?.notifications(0) ?? [];
      if (requests.length) requestNotice = ui(this.store, 'sysop_value_sysop_requests_waiting_r_read_requests', { VALUE1: requests.length === 10 ? '10+' : requests.length });
      prompt = ui(this.store, 'screens_local_sysop_command');
    } else if (this.view === 'watch-controls') {
      frame = sysopScreen(ui(this.store, 'console_watch_controls'), settings.name,
        [ui(this.store, 'console_watch_help')], '', rows);
    } else if (this.view === 'read') {
      frame = readMessage(this.reading, this.readPage, settings.name,
        { store: this.store, messagePageSize: rows - 11, localConsole: true });
      prompt = ui(this.store, 'sysop_read_prompt');
    } else {
      let lines;
      if (this.view === 'config') {
        lines = [
          ui(this.store, 'sysop_a_bbs_name_value', { NAME: settings.name }),
          ui(this.store, 'sysop_e_new_caller_registration_value', { VALUE1: uiText(this.store, settings.registration ? 'OPEN' : 'CLOSED') }),
          ui(this.store, 'sysop_l_last_callers_value', { VALUE1: uiText(this.store, settings.last_callers ? 'ON' : 'OFF') }),
          ui(this.store, 'sysop_1_session_time_value_minutes', { SESSION_MINUTES: settings.session_minutes }),
          ui(this.store, 'sysop_2_idle_timeout_value_minutes', { IDLE_MINUTES: settings.idle_minutes }),
          '', ui(this.store, 'sysop_name_registration_apply_live_time_limits_apply_to_new_connecti'),
          ui(this.store, 'sysop_listener_addresses_ports_and_certificates_remain_environment_s'),
          '', sysopMenuRow(this.store, 'sysop_b_create_list_message_bases_u_edit_users_t_string_editor'),
          sysopMenuRow(this.store, 'access_config_help', 2),
          ui(this.store, 'limits_config_help'), ui(this.store, 'sysop_config_return_help')
        ];
        prompt = ui(this.store, 'sysop_a_e_1_2_b_u_t_configure_q_wfc');
      } else if (this.view === 'limits' || this.view === 'user-limits') {
        const local = this.view === 'user-limits';
        const limits = local ? this.store.limits.user(this.userId) : this.store.limits.defaults();
        const effective = local ? this.store.limits.resolve(this.userId) : limits;
        const display = key => {
          const value = effective[key] === 0 ? ui(this.store, 'limits_unlimited') :
            ui(this.store, key === 'download_ratio' ? 'limits_ratio_value' : 'limits_minutes_value', { VALUE: effective[key] });
          return limits[key] === null ? ui(this.store, 'limits_inherited', { VALUE: value }) : value;
        };
        lines = [ui(this.store, 'limits_scope', { SCOPE: local ? this.store.user(this.userId).handle : ui(this.store, 'limits_global') }), '',
          ui(this.store, 'limits_ratio_row', { VALUE: display('download_ratio') }),
          ui(this.store, 'limits_time_row', { VALUE: display('daily_minutes') }), '',
          ui(this.store, 'limits_ratio_help'), ui(this.store, 'limits_time_help'), ui(this.store, 'limits_live_help')];
        if (local) {
          const usage = this.store.limits.ratioUsage(this.userId);
          lines.push(ui(this.store, 'limits_inherit_help'), '',
            ui(this.store, 'limits_bytes', { UPLOADED: usage.uploaded_bytes, DOWNLOADED: usage.downloaded_bytes }),
            ui(this.store, 'limits_daily_used', { USED: (this.store.limits.account(this.userId) / 60000).toFixed(2) }));
        }
        prompt = ui(this.store, 'limits_prompt');
      } else if (this.view === 'roles') {
        lines = [ui(this.store, 'access_roles_heading'), ...this.store.access.roles(this.page).map(role => ui(this.store, 'access_role_list_row', {
          ID: String(role.id).padEnd(7), NAME: sysopClip(this.store, role.name, 25).padEnd(25),
          POST: uiText(this.store, role.can_post ? 'YES' : 'NO').padEnd(6), DOORS: uiText(this.store, role.can_doors ? 'YES' : 'NO')
        }))];
        prompt = ui(this.store, 'access_roles_prompt');
      } else if (this.view === 'role-detail') {
        const role = this.store.access.requireRole(this.roleId);
        const start = this.page % 2 * 5;
        lines = [ui(this.store, 'access_role_row', { ID: role.id, NAME: role.name, POST: role.can_post, DOORS: role.can_doors }),
          ui(this.store, 'access_message_grants_heading'),
          ...this.store.bases(Math.floor(this.page / 2)).slice(start, start + 5).map(base => {
            const grant = this.store.access.messagePermissions(role.id, base.id);
            return ui(this.store, 'access_message_grant_row', {
              ID: base.id, NAME: base.name, READ: grant?.can_read ?? 0, POST: grant?.can_post ?? 0
            });
          }), ui(this.store, 'access_file_grants_heading'),
          ...this.store.access.fileBases(Math.floor(this.page / 2)).slice(start, start + 5).map(base => {
            const grant = this.store.access.filePermissions(role.id, base.id);
            return ui(this.store, 'access_file_grant_row', {
              ID: base.id, NAME: base.name, LIST: grant?.can_list ?? 0,
              DOWNLOAD: grant?.can_download ?? 0, UPLOAD: grant?.can_upload ?? 0
            });
          }), '', ui(this.store, 'access_global_grant_help'), ui(this.store, 'access_message_grant_help'),
          ui(this.store, 'access_file_grant_help')];
        prompt = ui(this.store, 'access_role_detail_prompt');
      } else if (this.view === 'file-bases') {
        const start = this.page % 2 * 5;
        lines = this.store.access.fileBases(Math.floor(this.page / 2)).slice(start, start + 5)
          .flatMap(base => [ui(this.store, 'sysop_value_value', { ID: base.id, NAME: base.name }), base.description]);
        prompt = ui(this.store, 'access_file_base_manager_prompt');
      } else if (this.view === 'requests') {
        lines = [ui(this.store, 'sysop_requests_heading'), ...this.bbs.community.notifications(this.page).map(request =>
          ui(this.store, 'sysop_value_value_value_node_value_value', { ID: String(request.id).padEnd(7), KIND: String(request.kind).padEnd(5),
            VALUE3: sysopClip(this.store, request.handle ?? '(guest)', 25).padEnd(25), NODE: String(request.node).padEnd(5), VALUE5: date(request.created_at) }))];
        prompt = ui(this.store, 'sysop_v_id_read_d_id_acknowledge_n_p_q');
      } else if (this.view === 'request-read') {
        const request = this.bbs.community.notification(this.requestId, this.readPage);
        lines = [ui(this.store, 'sysop_value_from_value_on_node_value', { KIND: request.kind, VALUE2: request.handle ?? '(guest)', NODE: request.node }),
          ui(this.store, 'sysop_value_utc_page_value_value', { VALUE1: date(request.created_at), VALUE2: request.page + 1, PAGES: request.pages }), '',
          ...request.body_lines];
        prompt = ui(this.store, 'sysop_n_p_page_q_requests');
      } else if (this.view === 'files') {
        lines = [ui(this.store, 'sysop_id_status_bytes_filename_uploader'),
          ...this.bbs.transfers.sysopFiles(this.page, this.fileBaseId).map(file =>
            ui(this.store, 'sysop_value_value_value_value_value', {
              ID: String(file.id).padEnd(6), BASE: String(file.base_id ?? 1).padEnd(4),
              VALUE2: uiText(this.store, file.approved ? 'approved' : 'PENDING').padEnd(8),
              SIZE: String(file.size).padEnd(7), NAME: sysopClip(this.store, file.name, 19).padEnd(19),
              HANDLE: file.handle
            }))];
        prompt = ui(this.store, 'sysop_a_id_approve_u_id_unapprove_d_id_remove_n_p_q');
      } else if (this.view === 'applications') {
        lines = [ui(this.store, 'sysop_pending_account_applications'), ...this.store.applications(this.page).map(user =>
          ui(this.store, 'sysop_value_value_value', { ID: String(user.id).padEnd(7), HANDLE: user.handle.padEnd(25), VALUE3: date(user.created_at) }))];
        prompt = ui(this.store, 'sysop_a_id_approve_r_id_reject_n_p_q');
      } else if (this.view === 'users') {
        lines = [ui(this.store, 'sysop_id_handle_status'), ...this.store.sysopUsers(this.page).map(user =>
          ui(this.store, 'sysop_value_value_value_2', { VALUE1: String(user.id).padEnd(7), VALUE2: user.handle.padEnd(25), VALUE3: uiText(this.store, user.disabled ? 'DISABLED' : user.application_status) }))];
        lines.push('', ui(this.store, 'user_editor_list_help'));
        prompt = ui(this.store, 'user_editor_list_prompt');
      } else if (this.view === 'user-detail') {
        const user = this.store.user(this.userId);
        if (!user) throw new InputError('User not found.');
        lines = [ui(this.store, 'sysop_id_value_handle_value', { ID: user.id, HANDLE: user.handle }),
          ui(this.store, 'user_editor_application', { STATUS: uiText(this.store, user.application_status) }), '',
          ...userFields.flatMap(([field, label], index) => {
            const value = field === 'role_id' ? `${user.role_id} ${this.store.access.requireRole(user.role_id).name}` : typeof user[field] === 'number' ?
              ui(this.store, user[field] ? 'user_editor_yes' : 'user_editor_no') : user[field] || ui(this.store, 'user_editor_empty');
            const row = ui(this.store, 'user_editor_row', {
              NUMBER: index + 1, FIELD: ui(this.store, label), VALUE: value
            });
            return field === 'sysop_note' && plainText(row).length > 76 ?
              [row.slice(0, 76), row.slice(76, 152)] : [sysopClip(this.store, row)];
          }), '',
          ui(this.store, 'sysop_joined_value_last_login_value', { VALUE1: date(user.created_at), VALUE2: user.last_login ? date(user.last_login) : ui(this.store, 'label_never') }),
          '', ui(this.store, 'sysop_private_fields_are_local_only_q_returns_to_user_editor')];
        prompt = ui(this.store, 'user_editor_form_prompt');
      } else if (this.view === 'bases') {
        const start = this.page % 2 * 5;
        lines = this.store.bases(Math.floor(this.page / 2)).slice(start, start + 5)
          .flatMap(base => [ui(this.store, 'sysop_value_value', { ID: base.id, NAME: base.name }), base.description]);
        prompt = ui(this.store, 'sysop_c_name_description_create_o_id_moderate_n_p_q');
      } else if (this.view === 'strings') {
        lines = stringEditorList(this.store, this.stringKeys(), this.page, stringPageSize, this.stringFilter);
        prompt = ui(this.store, 'string_editor_prompt');
      } else if (this.view === 'messages' || this.view === 'pending-messages') {
        lines = [ui(this.store, 'sysop_base_value', { NAME: this.store.base(this.baseId).name }), ui(this.store, 'sysop_id_from_subject'),
          ...this.store.messages(this.page, this.baseId, this.view === 'pending-messages').map(message =>
          ui(this.store, 'sysop_value_value_value_3', { VALUE1: String(message.id).padEnd(7), VALUE2: safeText(message.handle).padEnd(25), SUBJECT: sysopClip(this.store, message.subject, 42) }))];
        if (lines.length === 2) lines.push(ui(this.store, 'sysop_empty_page'));
        lines.push('', ui(this.store, 'moderation_status', { STATUS: ui(this.store, this.store.moderation(this.baseId) ? 'user_editor_yes' : 'user_editor_no') }));
        prompt = ui(this.store, this.view === 'pending-messages' ? 'moderation_pending_prompt' : 'moderation_messages_prompt');
      } else if (this.view === 'callers') {
        lines = [ui(this.store, 'sysop_call_handle_logon_utc_min_node'),
          ...this.store.callers(this.page).map(call => {
            const minutes = Math.max(0, Math.floor(((call.ended_at ? Date.parse(call.ended_at) : Date.now()) -
              Date.parse(call.started_at)) / 60000));
            return ui(this.store, 'sysop_value_value_value_value_valuevalue', { VALUE1: String(call.id).padEnd(7), VALUE2: call.handle.padEnd(25), VALUE3: date(call.started_at), VALUE4: String(minutes).padEnd(4), NODE: call.node, VALUE6: call.ended_at ? '' : ' *' });
          }), '', ui(this.store, 'sysop_connected_history_retains_approximately_1000_calls')];
        prompt = ui(this.store, 'sysop_n_next_p_previous_q_wfc');
      } else {
        lines = [ui(this.store, 'sysop_node_handle_state'), ...this.bbs.nodes().slice(this.page * 10, this.page * 10 + 10)
          .map(node => ui(this.store, 'sysop_value_value_value_4', { VALUE1: String(node.id).padEnd(7), VALUE2: (node.handle ?? '(connecting)').padEnd(25), STATE: node.state }))];
        prompt = ui(this.store, 'console_node_prompt');
      }
      const empty = new Map([['roles', [1, 1]], ['file-bases', [0, 0]], ['requests', [1, 1]],
        ['files', [1, 1]], ['applications', [1, 1]], ['users', [3, 1]], ['bases', [0, 0]],
        ['callers', [3, 1]], ['nodes', [1, 1]]]).get(this.view);
      if (empty && lines.length === empty[0]) lines.splice(empty[1], 0, ui(this.store, 'sysop_empty_page'));
      const title = new Map([['config', 'SYSTEM CONFIGURATION'], ['users', 'USER EDITOR'],
        ['user-detail', 'USER EDITOR'], ['bases', 'MESSAGE BASES'], ['strings', 'STRING EDITOR'],
        ['roles', 'ROLES'], ['role-detail', 'ROLE PERMISSIONS'], ['file-bases', 'FILE BASES'],
        ['applications', 'APPLICATIONS'], ['files', 'FILE CATALOG'],
        ['requests', 'SYSOP REQUESTS'], ['request-read', 'PRIVATE SYSOP REQUEST'],
        ['messages', 'MESSAGE BASE'], ['callers', 'CALLER HISTORY'], ['nodes', 'NODE LIST']]).get(this.view);
      const heading = this.view === 'limits' || this.view === 'user-limits' ? ui(this.store, 'limits_title') :
        this.view === 'pending-messages' ? ui(this.store, 'moderation_pending_title') : uiText(this.store, title);
      frame = sysopScreen(ui(this.store, 'sysop_value_page_value', { TITLE: heading, VALUE2: this.page + 1 }),
        settings.name, lines, prompt, rows);
    }
    this.prompt = ui(this.store, 'sysop_value_2', {
      VALUE1: safeText(this.pending?.prompt ?? this.field?.prompt ?? prompt ?? '')
    });
    frame += sysopFooter(
      ui(this.store, 'sysop_value_2', { VALUE1: safeText(this.notice || requestNotice) }),
      this.prompt, rows);
    this.output.write(frame);
    this.renderInput(this.inputBuffer ?? '');
  }

  renderInput(buffer) {
    this.output.write(sysopInput(this.prompt ?? '', buffer, this.output.rows));
  }

  attach(session, local = false) {
    this.detach();
    this.activeSession = session;
    this.view = local ? 'local' : 'watch';
    this.display = text => {
      if (!['watch', 'chat', 'local'].includes(this.view)) return;
      try {
        if (this.output.writableLength > 65536) throw new InputError('console_slow_output');
        this.output.write(text);
      } catch (error) {
        this.detach();
        this.view = 'wfc';
        this.notice = error instanceof InputError ? errorText(this.store, error) :
          ui(this.store, 'sysop_operation_failed_see_server_error_log');
        this.onError(error);
      }
    };
    this.sessionClosed = () => {
      this.detach();
      this.view = 'wfc';
      if (!this.stopped) this.render();
    };
    session.on('display', this.display);
    session.once('session-close', this.sessionClosed);
    this.replay();
  }

  replay() {
    const session = this.activeSession;
    if (session.screenHistory === undefined) throw new InputError('console_screen_unavailable');
    this.display(ansi.reset + '\x1b[r\x1b[?7h' + ansi.clear + session.screenHistory);
  }

  detach() {
    this.resetInput?.();
    const session = this.activeSession;
    if (!session) return;
    const local = session.local;
    session.removeListener('display', this.display);
    session.removeListener('session-close', this.sessionClosed);
    this.activeSession = undefined;
    if (session.chat) session.endChat();
    if (local && !session.closed) session.disconnect('Disconnected by sysop.');
  }

  terminalKey(value, key = {}) {
    if (this.view === 'local') {
      if (key.name === 'escape') {
        this.detach();
        this.view = 'wfc';
        this.render();
      } else {
        const sequence = key.sequence ?? value;
        if (sequence) this.activeSession.socket.send(sequence);
      }
      return true;
    }
    if (this.view === 'chat' && key.name === 'escape') {
      this.resetInput?.();
      this.activeSession.endChat();
      this.view = 'watch';
      this.replay();
      return true;
    }
    if (this.view !== 'watch') return false;
    if (key.name === 'escape' || value?.toUpperCase() === 'Q') {
      this.detach();
      this.view = 'nodes';
      this.render();
    } else if (['H', 'C'].includes(value?.toUpperCase())) {
      this.handle(value.toUpperCase());
    }
    return true;
  }

  confirm(prompt, action) {
    this.pending = { prompt: ui(this.store, 'sysop_value_type_yes_to_confirm_anything_else_cancels', { PROMPT: prompt }), action };
  }

  confirmUserDeletion(user) {
    this.confirm(ui(this.store, 'user_editor_delete_confirm', { ID: user.id, HANDLE: user.handle }), () => {
      this.bbs.deleteUser(user.id);
      this.userId = undefined;
      this.view = 'users';
      this.page = Math.min(this.page, Math.max(0, Math.ceil(this.store.stats().users / 10) - 1));
    });
  }

  stringKeys() {
    const filter = this.stringFilter?.toLowerCase() ?? '';
    return [...stringDefaults.keys()].filter(key => key.includes(filter) ||
      plainText(pipeText(stringDefaults.get(key), STRING_SOURCE_LIMIT)).toLowerCase().includes(filter));
  }

  shortcuts() {
    if (this.field || this.pending) return '';
    if (this.view === 'chat') return '';
    if (this.view === 'watch-controls') return 'CHQ';
    if (this.view === 'wfc') return 'SUBCNQAFRL';
    if (this.view === 'config') return 'AE12BUTRFGQ';
    if (this.view === 'user-detail') return '12345678XLQ';
    if (this.view === 'limits' || this.view === 'user-limits') return '12Q';
    if (this.view === 'messages') return 'NPQTM';
    return this.view === 'users' ? 'NQ' : 'NPQ';
  }

  handle(line) {
    this.notice = '';
    try {
      const limit = this.field?.stringKey ? STRING_SOURCE_LIMIT : 160;
      if (line.length > limit || !/^[\x20-\x7e]*$/.test(line)) throw new InputError('sysop_input_limit', { LIMIT: limit });
      if (this.pending) {
        const { action } = this.pending;
        this.pending = undefined;
        if (line.trim().toUpperCase() === 'YES') {
          action();
          this.notice = ui(this.store, 'sysop_action_completed');
        } else this.notice = ui(this.store, 'sysop_cancelled');
      } else if (this.view === 'chat') {
        if (line.trim()) this.activeSession.chatMessage(line);
      } else if (this.field) {
        if (line.trim().toUpperCase() === '/ABORT') {
          this.field = undefined;
          this.notice = ui(this.store, 'sysop_cancelled');
        } else {
          this.field.save(line);
          this.field = undefined;
          this.editBuffer = undefined;
          if (!this.pending) this.notice = ui(this.store, 'sysop_settings_saved');
        }
      } else if (line.trim()) this.command(line.trim());
    } catch (error) {
      if (error instanceof InputError) this.notice = errorText(this.store, error);
      else {
        this.onError(error);
        this.notice = ui(this.store, 'sysop_operation_failed_see_server_error_log');
      }
      if (this.view === 'watch') this.view = 'watch-controls';
      else if (this.view === 'chat') this.output.write('\r\n' + this.notice + '\r\n');
    }
    if (!this.stopped) this.render();
  }

  command(line) {
    const [verb, value, ...rest] = line.split(/\s+/);
    const command = verb.toUpperCase();
    if (this.view === 'watch' || this.view === 'watch-controls') {
      const session = this.activeSession;
      if (command === 'H') {
        this.view = 'watch-controls';
        this.confirm(ui(this.store, 'sysop_disconnect_node_value_value', {
          NODE_ID: session.id, VALUE2: session.user.handle
        }), () => this.bbs.disconnectNode(session.id));
      } else if (command === 'C') {
        session.startChat();
        this.view = 'chat';
        this.replay();
        this.output.write('\r\n' + ui(this.store, 'console_chat_help') + '\r\n');
      } else if (command === 'Q') {
        this.view = 'watch';
        this.replay();
      } else throw new InputError('Choose C, H or Q.');
      return;
    }
    if (command === 'Q') {
      if (this.view !== 'wfc') {
        this.view = this.view === 'read' ? this.messageReturnView ?? 'messages' :
          this.view === 'pending-messages' ? 'messages' : this.view === 'limits' ? 'config' :
          this.view === 'user-limits' ? 'user-detail' :
          this.view === 'request-read' ? 'requests' : this.view === 'user-detail' ? 'users' :
          this.view === 'role-detail' ? 'roles' :
          ['bases', 'strings', 'roles', 'file-bases'].includes(this.view) ? 'config' : 'wfc';
        if (this.view !== 'users') this.page = 0;
      }
      else this.confirm(ui(this.store, 'sysop_shut_down_the_bbs_and_disconnect_all_callers'), () => {
        this.stopped = true;
        this.onQuit();
      });
      return;
    }
    if (this.view === 'wfc') {
      if (command === 'L') {
        this.attach(this.bbs.openLocalSession(), true);
        return;
      }
      const views = new Map([['S', 'config'], ['U', 'users'], ['B', 'messages'], ['C', 'callers'],
        ['N', 'nodes'], ['A', 'applications'], ['F', 'files'], ['R', 'requests']]);
      if (!views.has(command)) throw new InputError('console_wfc_choices');
      this.view = views.get(command);
      if (this.view === 'files') this.fileBaseId = undefined;
      if (this.view === 'messages') this.baseId = 1;
      this.page = 0;
    } else if (this.view === 'config') {
      const settings = this.store.settings();
      if (['B', 'U', 'T', 'R', 'F', 'G'].includes(command)) {
        this.view = new Map([['B', 'bases'], ['U', 'users'], ['T', 'strings'], ['R', 'roles'], ['F', 'file-bases'], ['G', 'limits']]).get(command);
        this.page = 0;
      } else if (command === 'E') {
        this.confirm(ui(this.store, 'sysop_value_new_caller_registration', { VALUE1: settings.registration ? 'Close' : 'Open' }), () =>
          this.store.updateSettings({ ...this.store.settings(), registration: settings.registration ? 0 : 1 }));
      } else if (command === 'L') {
        this.confirm(ui(this.store, 'sysop_value_last_callers_after_welcome', { VALUE1: settings.last_callers ? 'Hide' : 'Show' }), () =>
          this.store.updateSettings({ ...this.store.settings(), last_callers: settings.last_callers ? 0 : 1 }));
      } else if (['A', '1', '2'].includes(command)) {
        const key = command === 'A' ? 'name' : command === '1' ? 'session_minutes' : 'idle_minutes';
        this.field = {
          prompt: command === 'A' ? ui(this.store, 'sysop_new_bbs_name_abort_cancels') :
            ui(this.store, 'sysop_minutes_1_value_abort_cancels', { VALUE1: command === '1' ? '1440' : '60' }),
          save: input => {
            if (command !== 'A' && !/^[0-9]+$/.test(input)) throw new InputError('Enter a whole number of minutes.');
            this.store.updateSettings({ ...this.store.settings(), [key]: command === 'A' ? input : Number(input) });
          }
        };
      } else throw new InputError('sysop_a_e_1_2_b_u_t_configure_q_wfc');
    } else if (this.view === 'limits' || this.view === 'user-limits') {
      if (!['1', '2'].includes(command) || value) throw new InputError('limits_prompt');
      const local = this.view === 'user-limits';
      const userId = this.userId;
      const key = command === '1' ? 'download_ratio' : 'daily_minutes';
      this.field = {
        prompt: ui(this.store, local ? 'limits_user_field_prompt' : 'limits_field_prompt'),
        save: input => {
          const inherit = local && input.trim() === '-';
          if (!inherit && !/^[0-9]{1,4}$/.test(input.trim())) throw new InputError('limits_invalid_value');
          const next = inherit ? null : Number(input.trim());
          if (next !== null && next > (key === 'download_ratio' ? MAX_RATIO : MAX_DAILY_MINUTES)) throw new InputError('limits_invalid_value');
          this.confirm(ui(this.store, 'limits_confirm'), () => {
            if (local) this.store.limits.setUser(userId, { ...this.store.limits.user(userId), [key]: next });
            else this.store.limits.setDefaults({ ...this.store.limits.defaults(), [key]: next });
          });
        }
      };
    } else if (this.view === 'read') {
      const current = this.store.message(this.reading.id);
      if (!current) throw new InputError('Message no longer exists.');
      this.reading = current;
      const { pages } = messagePage(current.body, 0, this.output.rows - 11 - (current.reply_to == null ? 0 : 1));
      if (command === 'N') this.readPage = Math.min(pages - 1, this.readPage + 1);
      else if (command === 'P') this.readPage = Math.max(0, this.readPage - 1);
      else throw new InputError('Choose N, P or Q.');
    } else if (this.view === 'request-read') {
      const request = this.bbs.community.notification(this.requestId, this.readPage);
      if (!['N', 'P'].includes(command)) throw new InputError('Choose N, P or Q.');
      this.readPage = Math.max(0, Math.min(request.pages - 1, this.readPage + (command === 'N' ? 1 : -1)));
    } else if (this.view === 'user-detail') {
      if (command === 'L' && !value) {
        this.store.limits.user(this.userId);
        this.view = 'user-limits';
        return;
      }
      if (command === 'X' && !value) {
        const user = this.store.user(this.userId);
        if (!user) throw new InputError('User not found.');
        return this.confirmUserDeletion(user);
      }
      if (!/^[1-8]$/.test(command) || value) throw new InputError('access_user_choose_field');
      const user = this.store.user(this.userId);
      if (!user) throw new InputError('User not found.');
      const [field, label] = userFields[Number(command) - 1];
      if (['can_post', 'can_doors', 'disabled'].includes(field)) {
        const next = user[field] ? 0 : 1;
        this.confirm(ui(this.store, 'user_editor_confirm', {
          FIELD: ui(this.store, label), HANDLE: user.handle,
          VALUE: ui(this.store, next ? 'user_editor_yes' : 'user_editor_no')
        }), () => {
          if (field === 'disabled') this.bbs.setUserDisabled(user.id, Boolean(next));
          else this.store.editUser(user.id, field, next);
        });
      } else if (field === 'role_id') {
        this.field = {
          prompt: ui(this.store, 'access_user_role_prompt'),
          save: input => {
            const role = this.store.access.requireRole(id(input.trim()));
            this.confirm(ui(this.store, 'access_assign_confirm', { USER: user.handle, ROLE: role.name }),
              () => this.store.access.assign(user.id, role.id));
          }
        };
      } else {
        this.field = {
          prompt: ui(this.store, field === 'handle' ? 'user_editor_handle_prompt' : 'user_editor_text_prompt', {
            FIELD: ui(this.store, label), MAX: field === 'sysop_note' ? 100 : 60
          }),
          save: input => {
            const value = field === 'handle' ? username(input.trim()) :
              input.trim() === '-' ? '' : text(input, field === 'sysop_note' ? 100 : 60, 'User info');
            this.confirm(ui(this.store, 'user_editor_confirm', {
              FIELD: ui(this.store, label), HANDLE: user.handle,
              VALUE: value || ui(this.store, 'user_editor_empty')
            }), () => {
              if (field === 'handle') this.store.renameUser(user.id, value);
              else this.store.editUser(user.id, field, value);
            });
          }
        };
      }
    } else if ((command === 'N' || command === 'P') && !value) {
      const last = this.view === 'strings' ? Math.max(0, Math.ceil(this.stringKeys().length / stringPageSize) - 1) : 9999;
      this.page = Math.max(0, Math.min(last, this.page + (command === 'N' ? 1 : -1)));
    } else if (this.view === 'roles') {
      if (command === 'C') {
        const name = text(line.slice(1).trim(), 24, 'Role name');
        this.confirm(ui(this.store, 'access_create_role_confirm', { NAME: name }), () => this.store.access.createRole(name));
      } else if ((command === 'V' && !rest.length) || (/^[1-9]\d*$/.test(command) && !value)) {
        this.roleId = this.store.access.requireRole(id(command === 'V' ? value : command)).id;
        this.view = 'role-detail';
        this.page = 0;
      } else throw new InputError('access_roles_prompt');
    } else if (this.view === 'role-detail') {
      const args = [value, ...rest];
      if (!args.every(item => /^[0-9]+$/.test(item ?? ''))) throw new InputError('access_role_detail_prompt');
      const numbers = args.map(Number);
      const roleId = this.roleId;
      if (command === 'G' && numbers.length === 2) {
        this.confirm(ui(this.store, 'access_change_confirm'), () => this.store.access.setRolePermissions(roleId, ...numbers));
      } else if (command === 'M' && numbers.length === 3) {
        this.confirm(ui(this.store, 'access_change_confirm'), () => this.store.access.setMessagePermissions(roleId, ...numbers));
      } else if (command === 'F' && numbers.length === 4) {
        this.confirm(ui(this.store, 'access_change_confirm'), () => this.store.access.setFilePermissions(roleId, ...numbers));
      } else throw new InputError('access_role_detail_prompt');
    } else if (this.view === 'requests') {
      if (!['V', 'D'].includes(command) || rest.length) throw new InputError('Use V ID or D ID.');
      const requestId = id(value);
      this.bbs.community.notification(requestId, 0);
      if (command === 'V') {
        this.requestId = requestId;
        this.readPage = 0;
        this.view = 'request-read';
      } else this.confirm(ui(this.store, 'sysop_acknowledge_sysop_request_value', { REQUEST_ID: requestId }), () => this.bbs.community.resolveNotification(requestId));
    } else if (this.view === 'files') {
      if (command === 'M' && rest.length === 1) {
        const fileId = id(value), baseId = id(rest[0]);
        this.confirm(ui(this.store, 'access_change_confirm'), () => this.bbs.transfers.move(fileId, baseId));
        return;
      }
      if (!['A', 'U', 'D'].includes(command) || rest.length) throw new InputError('Use A ID, U ID or D ID.');
      const fileId = id(value);
      this.confirm(ui(this.store, 'sysop_value_file_value', { VALUE1: command === 'D' ? 'Remove' : command === 'A' ? 'Approve' : 'Unapprove', FILE_ID: fileId }), () => {
        if (command === 'D') this.bbs.transfers.remove(fileId);
        else this.bbs.transfers.approve(fileId, command === 'A');
      });
    } else if (this.view === 'applications') {
      if (!['A', 'R'].includes(command) || rest.length) throw new InputError('Use A ID to approve or R ID to reject.');
      const userId = id(value);
      const user = this.store.user(userId);
      if (!user || user.application_status !== 'pending') throw new InputError('Pending application not found.');
      this.confirm(ui(this.store, 'sysop_value_application_from_value', { VALUE1: command === 'A' ? 'Approve' : 'Reject', HANDLE: user.handle }), () =>
        this.store.decideApplication(userId, command === 'A'));
    } else if (this.view === 'users') {
      const numericSelection = /^[1-9][0-9]*$/.test(command) && !value;
      const userId = id(numericSelection ? command : value);
      const user = this.store.user(userId);
      if (!user) throw new InputError('User not found.');
      if (numericSelection || (command === 'V' && !rest.length)) {
        this.userId = userId;
        this.view = 'user-detail';
      } else if (command === 'X' && !rest.length) {
        this.confirmUserDeletion(user);
      } else if (command === 'F' && rest.length >= 2) {
        const [field, ...words] = rest;
        if (!['real_name', 'location', 'sysop_note'].includes(field)) throw new InputError('Unknown user field.');
        const info = words.join(' ');
        this.confirm(ui(this.store, 'sysop_update_value_for_value', { FIELD: field, HANDLE: user.handle }), () => this.store.editUser(userId, field, info === '-' ? '' : info));
      } else if (command === 'P' && rest.length === 2) {
        const field = new Map([['post', 'can_post'], ['doors', 'can_doors']]).get(rest[0]);
        if (!field || !['0', '1'].includes(rest[1])) throw new InputError('Use P ID post|doors 0|1.');
        this.confirm(ui(this.store, 'sysop_set_value_permission_for_value_to_value', { VALUE1: rest[0], HANDLE: user.handle, VALUE3: rest[1] }), () =>
          this.store.editUser(userId, field, Number(rest[1])));
      } else if (command === 'A' && rest.length === 1) {
        const role = this.store.access.requireRole(id(rest[0]));
        this.confirm(ui(this.store, 'access_assign_confirm', { USER: user.handle, ROLE: role.name }),
          () => this.store.access.assign(userId, role.id));
      } else if (command === 'R' && rest.length === 1) {
        this.confirm(ui(this.store, 'sysop_rename_value_to_value', { HANDLE: user.handle, VALUE2: rest[0] }), () => this.store.renameUser(userId, rest[0]));
      } else if ((command === 'D' || command === 'E') && !rest.length) {
        this.confirm(ui(this.store, 'sysop_value_value_2', { VALUE1: uiText(this.store, command === 'D' ? 'Disable and disconnect' : 'Enable'), HANDLE: user.handle }), () =>
          this.bbs.setUserDisabled(userId, command === 'D'));
      } else throw new InputError('error_use_v_id_f_id_field_text_p_id_post_doors_0_1_r_id_handle_d_id_');
    } else if (this.view === 'bases' || this.view === 'file-bases') {
      const files = this.view === 'file-bases';
      if (command === 'C') {
        const parts = line.slice(1).trim().split('|');
        if (parts.length > 2) throw new InputError('Use C name | description.');
        const name = parts[0].trim(), description = (parts[1] ?? '').trim();
        this.confirm(ui(this.store, files ? 'access_create_file_base_confirm' : 'sysop_create_message_base_value', { NAME: name }), () =>
          files ? this.store.access.createFileBase(name, description) : this.store.createBase(name, description));
      } else if (command === 'O') {
        const base = files ? this.store.access.fileBase(id(value)) : this.store.base(id(value));
        if (!base) throw new InputError('Message base not found.');
        if (files) this.fileBaseId = base.id;
        else this.baseId = base.id;
        this.page = 0;
        this.view = files ? 'files' : 'messages';
      } else throw new InputError('Use C name | description, O ID, N, P or Q.');
    } else if (this.view === 'strings') {
      if (command === 'F') {
        this.stringFilter = line.slice(1).trim();
        this.page = 0;
        return;
      }
      const key = /^[1-3]$/.test(value ?? '') ?
        this.stringKeys()[this.page * stringPageSize + Number(value) - 1] : value;
      if (!stringDefaults.has(key)) throw new InputError('Unknown string key.');
      if (command === 'E') {
        this.field = {
          stringKey: key,
          prompt: ui(this.store, 'string_editor_edit'),
          save: input => this.store.setString(key, input)
        };
        this.editBuffer = undefined;
      } else if (command === 'R') {
        this.confirm(ui(this.store, 'sysop_restore_value_to_its_default', { VALUE: key }), () => this.store.resetString(key));
      } else throw new InputError('Use E key or R key.');
    } else if (this.view === 'messages' || this.view === 'pending-messages') {
      if (this.view === 'messages' && !value && command === 'T') {
        this.view = 'pending-messages';
        this.page = 0;
        return;
      }
      if (this.view === 'messages' && !value && command === 'M') {
        const enabled = !this.store.moderation(this.baseId), baseId = this.baseId;
        this.confirm(ui(this.store, 'moderation_confirm'), () => this.store.setModeration(baseId, enabled));
        return;
      }
      if (this.view === 'pending-messages' && ['A', 'R'].includes(command) && !rest.length) {
        const messageId = id(value), message = this.store.message(messageId);
        if (message?.base_id !== this.baseId || !this.store.isMessagePending(messageId)) throw new InputError('moderation_pending_missing');
        this.confirm(ui(this.store, 'moderation_decide_confirm', { ID: messageId }),
          () => this.store.decideMessage(messageId, command === 'A'));
        return;
      }
      const messageId = id(command === 'D' ? value : verb);
      const message = this.store.message(messageId);
      if (!message || message.base_id !== this.baseId) throw new InputError('Message not found.');
      if (this.store.isMessagePending(messageId) !== (this.view === 'pending-messages')) throw new InputError('Message not found.');
      if (command === 'D') this.confirm(ui(this.store, 'sysop_permanently_delete_message_value_value', { MESSAGE_ID: messageId, SUBJECT: message.subject }), () =>
        this.store.deleteMessage(messageId));
      else {
        this.reading = message;
        this.readPage = 0;
        this.messageReturnView = this.view;
        this.view = 'read';
      }
    } else if (this.view === 'nodes' && command === 'W' && !rest.length) {
      this.attach(this.bbs.watchNode(id(value)));
    } else if (this.view === 'nodes' && command === 'H') {
      const nodeId = id(value);
      const node = this.bbs.nodes().find(node => node.id === nodeId);
      if (!node) throw new InputError('Node is no longer connected.');
      this.confirm(ui(this.store, 'sysop_disconnect_node_value_value', { NODE_ID: nodeId, VALUE2: node.handle ?? 'connecting' }), () => this.bbs.disconnectNode(nodeId));
    } else throw new InputError('Unknown command.');
  }
}

export function startSysopConsole({ input = process.stdin, output = process.stdout, ...options }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('The local sysop console requires interactive input and output terminals.');
  }
  return startConsole({ input, output, ...options }, true);
}

export function startSysopAutomation(options) {
  return startConsole(options, false);
}

function startConsole({ input, output, ...options }, interactive) {
  const controller = new SysopConsole({ ...options, output, onQuit: () => quit() });
  const keyboard = new PassThrough();
  let buffer = '';
  let skipEnter = false;
  let previousCR = false;
  let timer;
  let stopped = false;
  controller.resetInput = () => {
    buffer = ''; controller.inputBuffer = ''; skipEnter = false; previousCR = false;
  };
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    controller.stopped = true;
    controller.detach();
    process.removeListener('exit', stop);
    input.pause();
    input.removeListener('data', forward);
    output.removeListener?.('resize', resize);
    if (interactive && !wasFlowing) input.unref?.();
    keyboard.removeListener('keypress', keypress);
    keyboard.destroy();
    try { if (interactive) input.setRawMode(Boolean(wasRaw)); }
    finally {
      if (wasFlowing) input.resume();
      output.write(ansi.consoleLeave);
    }
  };
  const quit = () => { stop(); options.onQuit(); };
  const fail = error => {
    stop();
    options.onError(error);
    options.onQuit();
  };
  const dispatch = (value, key = {}) => {
    if (key.ctrl && key.name === 'c') { quit(); return; }
    if (controller.terminalKey(value, key)) {
      buffer = '';
      skipEnter = false;
      previousCR = false;
      return;
    }
    if (previousCR && value === '\n') { previousCR = false; return; }
    previousCR = value === '\r';
    if (key.name === 'return' || key.name === 'enter') {
      if (skipEnter) { skipEnter = false; return; }
      const line = buffer;
      buffer = '';
      controller.inputBuffer = '';
      controller.editBuffer = undefined;
      controller.handle(line);
    } else if (key.name === 'backspace') {
      skipEnter = false;
      if (buffer.length) {
        buffer = buffer.slice(0, -1);
        controller.inputBuffer = buffer;
        if (controller.field?.stringKey) { controller.editBuffer = buffer; controller.render(); }
        else if (controller.view === 'chat') controller.output.write('\b \b');
        else controller.renderInput(buffer);
      }
    } else if (!key.ctrl && !key.meta && /^[\x20-\x7e]$/.test(value ?? '')) {
      skipEnter = false;
      if (!buffer && controller.shortcuts().includes(value.toUpperCase())) {
        skipEnter = true;
        controller.handle(value);
      } else if (buffer.length < (controller.field?.stringKey ? STRING_SOURCE_LIMIT : 160)) {
        buffer += value;
        controller.inputBuffer = buffer;
        if (controller.field?.stringKey) { controller.editBuffer = buffer; controller.render(); }
        else if (controller.view === 'chat') controller.output.write(value);
        else controller.renderInput(buffer);
      }
      else controller.output.write('\x07');
    }
  };
  const keypress = (value, key) => {
    if (stopped) return;
    try { dispatch(value, key); }
    catch (error) { fail(error); }
  };
  const forward = chunk => keyboard.write(chunk);
  const resize = () => {
    if (stopped) return;
    try {
      if (controller.output.resize()) {
        if (['watch', 'local'].includes(controller.view)) controller.replay();
        else if (controller.view !== 'chat') controller.render();
      }
    } catch (error) { fail(error); }
  };
  // Keep readline's decoder/listeners on an owned stream, never shared stdin.
  emitKeypressEvents(keyboard);
  keyboard.on('keypress', keypress);
  process.once('exit', stop);
  try {
    output.write(ansi.consoleEnter);
    controller.output.start();
    if (interactive) input.setRawMode(true);
    if (interactive && !wasFlowing) input.ref?.();
    input.on('data', forward);
    output.on?.('resize', resize);
    input.resume();
    controller.render();
  }
  catch (error) { stop(); throw error; }
  if (interactive) timer = setInterval(() => {
    try {
      if (controller.view === 'wfc' && !controller.pending && !buffer) controller.render();
    } catch (error) { fail(error); }
  }, 2000);
  return { controller, stop };
}

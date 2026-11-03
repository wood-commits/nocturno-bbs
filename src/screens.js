import { ui, uiText, plainText, pipeText, rawString, STRING_SOURCE_LIMIT, STRING_VISIBLE_LIMIT } from './strings.js';
import { InputError, safeText } from './validation.js';
import { loginChoices, mainChoices, mainInitialSelection, mainChoiceGrid, mainColumnWidths } from './presentation.js';

export const ansi = {
  reset: '\x1b[0m', clear: '\x1b[2J\x1b[H', cyan: '\x1b[1;36m',
  consoleEnter: '\x1b[?1049h',
  consoleLeave: '\x1b[0m\x1b[r\x1b[?7h\x1b[?25h\x1b[?1049l',
  blue: '\x1b[34m', yellow: '\x1b[1;33m', white: '\x1b[1;37m',
  gray: '\x1b[37m', green: '\x1b[1;32m'
};
const rule = `${ansi.blue}+${'-'.repeat(76)}+${ansi.reset}\r\n`;
const cell = (value, width) => safeText(value).slice(0, width).padEnd(width);
export const date = value => value ? value.slice(0, 16).replace('T', ' ') : 'Never';
const custom = (key, fallback, view) => view?.presentation
  ? view.presentation.render(key, fallback, view.values) : fallback;

export function loginMatrix(name, secure, view, selected = 0, notice) {
  const choices = loginChoices.map(([key, label], index) =>
    ('  ' + (index === selected ? '\x1b[7m' : '') + '[' + key + '] ' +
      plainText(uiText(view?.store, label)) + ansi.reset + '\r\n')).join('');
  const fallback = heading(ui(view?.store, 'screens_login_matrix'), name) + choices;
  if (view?.presentation?.templates.has('loginmatrix')) {
    const prefix = ui(view?.store, 'screens_value_l_n_c_s_q_arrows_enter', { VALUE1: safeText(name).slice(0, 24) });
    return view.presentation.render('loginmatrix', '', view.values, selected, view.store) +
      '\x1b[23;1H\x1b[2K' + (notice === undefined ? ui(view?.store, 'login_warning', {
        TRANSPORT: ui(view?.store, secure ? 'transport_tls_short' : 'transport_local_short'),
        WARNING: ui(view?.store, 'screens_never_reuse_passwords')
      }, 79) : safeText(notice).slice(0, 79)) + ansi.reset + '\x1b[24;1H\x1b[2K' +
      ui(view?.store, 'login_footer', { PREFIX: prefix, SELECTION: view.strings.selection }, 79);
  }
  return (view?.presentation?.render('loginmatrix', fallback, view.values, selected) ?? fallback) +
    ('\r\n' + ui(view?.store, secure ? 'session_tls_transport_active' : 'session_local_telnet_no_transport_encryption_use_only_locally_or_via_s') + '\r\n') +
    (ui(view?.store, 'screens_never_reuse_a_password_from_another_service') + '\r\n') +
    (ui(view?.store, 'screens_arrow_keys_select_enter_opens_l_n_c_s_q_shortcuts') + '\r\n') +
    (notice === undefined ? '' : safeText(notice).slice(0, 79) + ansi.reset + '\r\n') +
    (view?.strings.selection ?? ui(view?.store, 'selection'));
}

export function heading(title, name = 'Nocturno BBS') {
  const board = safeText(name).slice(0, 40);
  const caption = safeText(title).slice(0, Math.max(1, 72 - plainText(board).length));
  return `${ansi.reset}${ansi.clear}${rule}${ansi.cyan}  ${board}${ansi.yellow}  //  ${caption}${ansi.reset}\r\n${rule}`;
}

export function welcome(name, secure, view) {
  const frame = heading(ui(view?.store, 'screens_establishing_carrier'), name) +
    (ansi.cyan + '\r\n') +
    '    _   _ ___ ____ _   _ _______        _____ ____  _____\r\n' +
    '   | \\ | |_ _/ ___| | | |_   _\\ \\      / /_ _|  _ \\| ____|\r\n' +
    '   |  \\| || | |  _| |_| | | |  \\ \\ /\\ / / | || |_) |  _|\r\n' +
    '   | |\\  || | |_| |  _  | | |   \\ V  V /  | ||  _ <| |___\r\n' +
    '   |_| \\_|___\\____|_| |_| |_|    \\_/\\_/  |___|_| \\_\\_____|\r\n' +
    (ansi.reset + '\r\n') +
    (ansi.gray + '  ' + safeText(view?.values.TAGLINE ?? 'A new signal. An old-school community. Welcome to the wire.') + '\r\n' + '\r\n') +
    (ui(view?.store, secure ? 'session_tls_transport_active' : 'session_local_telnet_no_transport_encryption_use_only_locally_or_via_s') + '\r\n') +
    (ui(view?.store, 'screens_never_reuse_a_password_from_another_service_2') + '\r\n' + '\r\n') +
    (ansi.yellow + ui(view?.store, 'screens_l_log_on_n_new_caller_q_disconnect') + ansi.reset + '\r\n' + '\r\n');
  return custom('welcome', frame, view) + (view?.strings.selection ?? ui(view?.store, 'selection'));
}

export function mainMenu(name, handle, node, view, selected = mainInitialSelection) {
  if (view?.presentation?.templates.has('main-new')) {
    return view.presentation.render('main-new', '', view.values, selected) +
      '\x1b[24;1H\x1b[2K' + ui(view?.store, 'main_footer', {
        PROMPT: view.strings.main_prompt.slice(0, 36), HELP: ui(view?.store, 'screens_arrows_enter_help')
      }, 79);
  }
  const frame = heading(ui(view?.store, 'screens_main_menu'), name) +
    `  ${ansi.white}${ui(view?.store, 'screens_caller')}${safeText(handle)}${ansi.gray}` +
    `${ui(view?.store, 'screens_node')}${node}    ${date(new Date().toISOString())}${ui(view?.store, 'screens_utc')}\r\n${rule}`;
  const labels = mainChoices.map(([key, label]) =>
    plainText(ui(view?.store, 'screens_value_value', { KEY: key, LABEL: label })).slice(0, 23));
  const widths = mainColumnWidths(labels);
  const choices = mainChoiceGrid.map(row => row.map((index, column) => {
    if (index === null) return ' '.repeat(25);
    const text = ` ${labels[index].padEnd(widths[column])} `;
    return `\x1b[0;1;${index === selected ? '37;44' : '30;40'}m${text}${ansi.reset}${' '.repeat(25 - text.length)}`;
  }).join('')).join('\r\n');
  return custom('main', frame, view) + `\r\n${choices}\r\n${rule}` +
    `${ui(view?.store, 'single_key_help')}\r\n\r\n` +
    (view?.strings.main_prompt ?? ui(view?.store, 'main_prompt'));
}

export function userList(rows, page, name, view) {
  return custom('users', heading(ui(view?.store, 'screens_user_list_page_value', { VALUE1: page + 1 }), name), view) +
    (ansi.cyan + ui(view?.store, 'screens_handle_joined_last_logon_utc') + '\r\n' + (rule) + ansi.reset) +
    rows.map(row => (ui(view?.store, 'screens_value_value_value', { VALUE1: cell(row.handle, 24), VALUE2: cell(date(row.created_at), 16), VALUE3: row.last_login ? date(row.last_login) : ui(view?.store, 'label_never') }) + '\r\n')).join('') +
    (rows.length ? '' : (ui(view?.store, 'screens_no_users_on_this_page') + '\r\n')) +
    ('\r\n' + ui(view?.store, 'screens_n_next_p_previous_q_main_menu'));
}

export function callerList(rows, page, name, view) {
  return custom('callers', heading(ui(view?.store, 'screens_last_callers_page_value', { VALUE1: page + 1 }), name), view) +
    (ansi.cyan + ui(view?.store, 'screens_call_handle_logon_utc_min_node') + '\r\n' + (rule) + ansi.reset) +
    rows.map(row => {
      const minutes = Math.max(0, Math.floor(((row.ended_at ? Date.parse(row.ended_at) : Date.now()) - Date.parse(row.started_at)) / 60000));
      return (ui(view?.store, 'screens_value_value_value_value_valuevalue', { VALUE1: cell(row.id, 6), VALUE2: cell(row.handle, 24), VALUE3: date(row.started_at), MINUTES: cell(minutes, 4), NODE: row.node, VALUE6: row.ended_at ? '' : ' *' }) + '\r\n');
    }).join('') +
    (rows.length ? '' : (ui(view?.store, 'screens_no_callers_on_this_page') + '\r\n')) +
    ('\r\n' + ui(view?.store, 'screens_connected_or_disconnect_pending_history_retains_1000_calls') + '\r\n' + ui(view?.store, 'screens_n_next_p_previous_q_main_menu'));
}

export function messageList(rows, page, name, view) {
  return custom('messages', heading(ui(view?.store, 'screens_value_message_base_page_value', { VALUE1: safeText(view?.values.BASENAME ?? 'General').toUpperCase(), VALUE2: page + 1 }), name), view) +
    (ansi.cyan + ui(view?.store, 'screens_msg_from_subject') + '\r\n' + (rule) + ansi.reset) +
    rows.map(row => (ui(view?.store, 'screens_value_value_value', { VALUE1: cell(row.id, 6), VALUE2: cell(row.handle, 24), VALUE3: cell(row.subject, 40) }) + '\r\n')).join('') +
    (rows.length ? '' : (ui(view?.store, 'screens_no_messages_on_this_page_start_a_conversation') + '\r\n')) +
    ('\r\n' + ui(view?.store, 'screens_id_read_w_write_b_bases_n_p_page_q_main_menu'));
}

export function messageLayout(view, message) {
  const position = view?.presentation?.messagePosition();
  const details = position || message.reply_to == null ? [] :
    [ui(view?.store, 'message_reply_context', { MESSAGEID: message.reply_to })];
  if (!position) return { pageSize: (view?.messagePageSize ?? 14) - details.length, width: 76, details };
  const source = view.presentation.templates.get('new-message-header');
  for (const [marker, token, label, value] of [
    ['~MA', '%BASENAME%', 'Base', view.values.BASENAME ?? 'General'],
    ['~MT', '%MESSAGESUBJECT%', 'Subject', message.subject]
  ]) {
    const width = view.presentation.fieldWidth('new-message-header', marker) ?? 0;
    const full = safeText(value);
    if (!source.includes(token) && plainText(full).length > width) details.push(ui(view?.store, 'screens_value_value_2', { LABEL: uiText(view?.store, label), FULL: full }));
  }
  return { ...position, pageSize: Math.min(14, 23 - position.row - details.length),
    width: Math.min(76, 78 - position.column), details };
}

export function messagePage(body, page = 0, pageSize = 14, width = 76) {
  if (!Number.isInteger(page) || page < 0 || page > 9999 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 14 ||
      !Number.isInteger(width) || width < 1 || width > 76) {
    throw new InputError('Invalid message page layout.');
  }
  const lines = body.split('\n').flatMap(line => {
    const wrapped = [];
    for (let index = 0; index < line.length; index += width) wrapped.push(safeText(line.slice(index, index + width)));
    return wrapped.length ? wrapped : [''];
  });
  const pages = Math.max(1, Math.ceil(lines.length / pageSize));
  page = Math.min(page, pages - 1);
  return { body_lines: lines.slice(page * pageSize, (page + 1) * pageSize), pages, page };
}

export function readMessage(row, page = 0, name, view, privateMail = false) {
  const layout = messageLayout(view, row);
  const content = messagePage(row.body, page, layout.pageSize, layout.width);
  const context = row.reply_to == null ? '' : ui(view?.store, 'message_reply_context', { MESSAGEID: row.reply_to });
  const footer = ui(view?.store, !privateMail && !view?.localConsole ? 'message_read_prompt' : 'screens_n_next_p_previous_q_value', {
    VALUE1: uiText(view?.store, privateMail ? 'Inbox' : 'Message list')
  }).slice(0, 79);
  if (layout.row) {
    return view.presentation.render('new-message-header', '', view.values) +
      layout.details.map((line, index) => `\x1b[${layout.row + index};1H${line}`).join('') +
      content.body_lines.map((line, index) =>
        ('\x1b[' + (layout.row + layout.details.length + index) + ';' + (layout.column) + 'H  ' + (line))).join('') +
      ('\x1b[23;1H\x1b[2K' + ui(view?.store, 'message_read_page', {
        CONTEXT: context ? context.padEnd(plainText(context).length + 2) : '',
        LABEL: ui(view?.store, 'screens_page'), PAGE: content.page + 1, PAGES: content.pages
      }, 79)) +
      `\x1b[24;1H\x1b[2K${view?.localConsole ? '' : footer}`;
  }
  const header = custom('message-header', heading(ui(view?.store, 'screens_value_value_value_value', { VALUE1: uiText(view?.store, privateMail ? 'EMAIL' : 'MESSAGE'), ID: row.id, VALUE3: content.page + 1, PAGES: content.pages }), name) +
    (ui(view?.store, 'screens_from_value_posted_value_utc', { VALUE1: safeText(row.handle), VALUE2: date(row.created_at) }) + '\r\n') +
    (ui(view?.store, 'screens_subject_value', { VALUE1: safeText(row.subject) }) + '\r\n') + rule, view);
  return header + layout.details.map(line => `  ${line}\r\n`).join('') +
    content.body_lines.map(line => (ui(view?.store, 'screens_value_5', { LINE: line }) + '\r\n')).join('') +
    (view?.localConsole ? '' : '\r\n' + ui(view?.store, 'screens_value_6', { FOOTER: footer }));
}

export function baseList(rows, page, name, view) {
  return custom('message-bases', heading(ui(view?.store, 'screens_message_bases_page_value', { VALUE1: page + 1 }), name), view) +
    rows.map(row => (ui(view?.store, 'screens_value_value_3', { VALUE1: cell(row.id, 4), VALUE2: cell(row.name, 40) }) + '\r\n' + ui(view?.store, 'screens_value_7', { VALUE3: cell(row.description, 76).trimEnd() }) + '\r\n')).join('') +
    ('\r\n' + ui(view?.store, 'screens_id_open_base_n_p_page_q_main_menu'));
}

export function doorMenu(name, view) {
  return custom('doors', heading(ui(view?.store, 'screens_door_games_2'), name) +
    (ui(view?.store, 'screens_1_frontier_realms_multiplayer_strategy') + '\r\n'), view) +
    ('\r\n' + ui(view?.store, 'screens_1_play_q_main_menu'));
}

const sysopRule = `${ansi.cyan}+${'-'.repeat(78)}+${ansi.reset}`;

export function sysopClip(store, value, width = 76) {
  const text = safeText(value);
  return plainText(text).length <= width ? text :
    ui(store, 'string_editor_truncated', { TEXT: text.slice(0, width - 3) }, width);
}

function stringEditorWrap(value, limit = STRING_SOURCE_LIMIT) {
  const text = safeText(value);
  const length = Math.min(plainText(text).length, limit);
  const lines = [];
  for (let index = 0; index < Math.max(1, length); index += 76) lines.push(text.slice(index, Math.min(index + 76, limit)));
  return lines;
}

export function stringEditorList(store, keys, page, pageSize, filter = '') {
  const start = page * pageSize;
  const entries = keys.slice(start, start + pageSize);
  const lines = [
    ui(store, 'string_editor_page_summary', {
      FIRST: entries.length ? start + 1 : 0, LAST: start + entries.length, TOTAL: keys.length,
      PAGES: Math.max(1, Math.ceil(keys.length / pageSize))
    }),
    sysopClip(store, ui(store, 'string_editor_filter', { FILTER: filter || ui(store, 'label_all') }))
  ];
  for (const [index, key] of entries.entries()) {
    const source = rawString(store, key);
    lines.push(...stringEditorWrap(sysopClip(store, ui(store, 'string_editor_entry', { NUMBER: index + 1, KEY: key }), 152)),
      sysopClip(store, ui(store, 'string_editor_source', { SOURCE: source })),
      sysopClip(store, ui(store, 'string_editor_preview', { PREVIEW: pipeText(source) })), '');
  }
  if (!entries.length) lines.push('', ui(store, 'string_editor_empty'));
  return lines;
}

export function stringEditorDetail(store, key, source) {
  const preview = pipeText(source, STRING_SOURCE_LIMIT);
  const length = plainText(preview).length;
  const displayed = length > STRING_VISIBLE_LIMIT
    ? ui(store, 'string_editor_truncated', { TEXT: preview.slice(0, STRING_VISIBLE_LIMIT - 3) }, STRING_VISIBLE_LIMIT)
    : preview;
  return [
    ...stringEditorWrap(sysopClip(store, ui(store, 'string_editor_key', { KEY: key }), 152)),
    ui(store, 'string_editor_help'),
    ui(store, 'string_editor_source', { SOURCE: '' }),
    ...stringEditorWrap(source),
    '',
    ui(store, 'string_editor_preview', { PREVIEW: '' }),
    ...stringEditorWrap(displayed, STRING_VISIBLE_LIMIT),
    ui(store, length > STRING_VISIBLE_LIMIT ? 'string_editor_counts_invalid' : 'string_editor_counts', {
      SOURCE: source.length, VISIBLE: length
    })
  ];
}

export function sysopMenuRow(store, key, columns = 3) {
  const text = ui(store, key);
  const plain = plainText(text);
  const markers = [...plain.matchAll(/\[[A-Z0-9]\]/g)];
  if (columns === 1 || markers.length !== columns || plain.slice(0, markers[0].index).trim()) return text.slice(0, 76);
  const items = markers.map((marker, index) => {
    let end = markers[index + 1]?.index ?? plain.length;
    while (plain[end - 1] === ' ') end--;
    return text.slice(marker.index, end).slice(0, 24).padEnd(24);
  });
  return ui(store, 'sysop_menu_columns', { FIRST: items[0], SECOND: items[1], THIRD: items[2] ?? '' }, 76);
}

function uptimeText(uptime) {
  const total = Math.max(0, Math.floor(uptime));
  const [days, hours, minutes, seconds] = [Math.floor(total / 86400), Math.floor(total / 3600) % 24,
    Math.floor(total / 60) % 60, total % 60];
  const two = value => String(value).padStart(2, '0');
  return `${days ? `${days}d ` : ''}${two(hours)}:${two(minutes)}:${two(seconds)}`;
}

export function waitingScreen(name, stats, nodes, endpoints, uptime, store, rows = 25) {
  const line = (key, values) => `${cell(ui(store, key, values), 79)}\r\n`;
  const band = (row, key, values) => `\x1b[${row};1H\x1b[0;1;37;44m${' '.repeat(80)}` +
    `\x1b[${row};1H${ui(store, key, values).slice(0, 79)}${ansi.reset}`;
  const visibleNodes = Math.min(6, rows - 17 - endpoints.length);
  const count = Math.max(1, Math.min(visibleNodes, nodes.length));
  const separator = 8 + endpoints.length + count;
  const menu = [
    sysopMenuRow(store, 'screens_s_system_config_u_users_b_message_base'),
    sysopMenuRow(store, 'screens_c_caller_history_n_node_list_a_applications'),
    sysopMenuRow(store, 'screens_f_file_approvals_r_sysop_requests_q_quit_bbs'),
    sysopMenuRow(store, 'console_local_help', 1)
  ];
  return `${ansi.reset}${ansi.clear}` +
    band(1, 'wfc_title', { NAME: name }) +
    band(2, 'wfc_uptime', { DATE: date(new Date().toISOString()), SECONDS: Math.floor(uptime), UPTIME: uptimeText(uptime) }) +
    `\x1b[3;1H${sysopRule}\r\n` +
    line('wfc_statistics', { USERS: stats.users, POSTS: stats.messages, CALLS: stats.calls, TODAY: stats.today }) +
    line('wfc_active', { COUNT: nodes.length }) +
    line('wfc_listeners') +
    endpoints.map(endpoint => `  ${cell(endpoint, 77)}\r\n`).join('') +
    line('wfc_nodes') +
    (nodes.length ? nodes.slice(0, visibleNodes).map(node =>
      line('wfc_node', { ID: cell(node.id, 6), HANDLE: cell(node.handle ?? ui(store, 'label_connecting'), 24), STATE: node.state })
    ).join('') : line('wfc_waiting')) +
    `\x1b[${separator};1H${nodes.length > visibleNodes ? ui(store, 'console_more_nodes', { COUNT: nodes.length - visibleNodes }) : sysopRule}` +
    menu.map((row, index) => `\x1b[${separator + index + 1};3H${row}`).join('') +
    sysopFooter('', ui(store, 'screens_local_sysop_command'), rows);
}

export function sysopFooter(notice, prompt, height = 25) {
  const rows = (value, start) => {
    const text = safeText(value);
    return [0, 1].map(index =>
      `\x1b[${start + index};1H${ansi.reset}\x1b[2K${text.slice(index * 80, (index + 1) * 80)}`).join('');
  };
  return rows(notice, height - 4) + rows(prompt, height - 2) + `\x1b[${height};1H` + ansi.reset + '\x1b[2K' +
    sysopInput(prompt, '', height);
}

export function sysopInput(prompt, buffer = '', rows = 25) {
  let offset = Math.min(160, plainText(safeText(prompt)).length);
  if (offset % 80 === 79) offset++;
  const column = offset % 80;
  return `\x1b[${rows - 2 + Math.floor(offset / 80)};${column + 1}H${ansi.reset}\x1b[K` +
    safeText(buffer).slice(-(79 - column));
}

export function sysopScreen(title, name, lines, prompt, rows = 25) {
  if (lines.length > 17) throw new Error('Sysop screen exceeds the 80x25 content area.');
  const board = safeText(name).slice(0, 40);
  const caption = safeText(title).slice(0, Math.max(1, 72 - plainText(board).length));
  const header = `${ansi.reset}${ansi.clear}${rows === 24 ? '' : sysopRule + '\r\n'}` +
    `${ansi.white}  ${board}${ansi.yellow}  //  ${caption}${ansi.reset}\r\n${sysopRule}\r\n`;
  return header + lines.map(line => `  ${cell(line, 76).trimEnd()}\r\n`).join('') +
    sysopFooter('', prompt, rows);
}

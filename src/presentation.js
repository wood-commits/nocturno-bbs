import { openSync, fstatSync, statSync, readFileSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { InputError, text, safeText } from './validation.js';
import { mciCode, mciTokens, mciPattern, mciWidth, validMci, isMciColor } from './mci.js';

import { stringDefaults, pipeText, plainText, ui, uiText, STRING_SOURCE_LIMIT, STRING_VISIBLE_LIMIT } from './strings.js';
export { stringDefaults, displayString } from './strings.js';

const common = ['BBSNAME', 'USERNAME', 'NODE', 'DATE'];
export const loginChoices = [
  ['L', 'Login'], ['N', 'Apply for an account'], ['C', 'Check application'],
  ['S', 'Message sysop'], ['Q', 'Hangup']
];
export const mainChoices = [
  ['E', 'Email'], ['C', 'User Config'], ['U', 'User List'], ['F', 'Files'],
  ['M', 'Message Menu'], ['S', 'Note to Sysop'], ['K', 'QWK Mail Menu'],
  ['O', 'Automessage'], ['P', 'Page Sysop'], ['T', 'Your Stats'],
  ['B', 'BBS List'], ['L', 'Last Callers'], ['I', 'Oneliners'],
  ['D', 'Doors'], ['G', 'Autosig Menu'], ['Q', 'Goodbye']
];
export const mainInitialSelection = mainChoices.findIndex(([key]) => key === 'M');
export const mainChoiceGrid = [[null, 0, 1], [null, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15]];
export function mainColumnWidths(labels = mainChoices.map(([, label]) => label)) {
  return mainChoiceGrid[0].map((_, column) =>
    Math.max(...mainChoiceGrid.map(row => row[column] === null ? 0 : plainText(labels[row[column]]).length)));
}
const fixedScreens = new Set(['loginmatrix', 'main', 'login', 'stats', 'message-header']);
export const screenTokens = new Map([
  ['loginmatrix', [...common, 'CHOICE1', 'CHOICE2', 'CHOICE3', 'CHOICE4', 'CHOICE5']],
  ['login', [...common, 'LOGINHANDLE', 'LOGINPASSWORD', 'LOGINSTATUS', 'LOGINHELP']],
  ['stats', [...common, 'CALLS', 'POSTS', 'MAIL', 'UPLOADS', 'DOWNLOADS', 'ACCESS', 'USERNOTE']],
  ['main', common],
  ['message-header', [...common, 'PAGE', 'BASENAME', 'BASEID', 'MESSAGEID', 'MESSAGEAUTHOR', 'MESSAGESUBJECT', 'MESSAGEDATE',
    'RECIPIENT', 'MESSAGEDAY', 'MESSAGETIME', 'BODY']],
  ['welcome', [...common, 'TRANSPORT', 'TAGLINE']],
  ['users', [...common, 'PAGE']],
  ['callers', [...common, 'PAGE']],
  ['messages', [...common, 'PAGE', 'BASENAME', 'BASEID']],
  ['message-bases', [...common, 'PAGE']],
  ['compose', [...common, 'BASENAME', 'BASEID']],
  ['doors', common],
  ['realm', [...common, 'PAGE']]
]);

export function substitute(value, values) {
  return String(pipeText(value, Infinity, key =>
    Object.hasOwn(values, key) ? safeText(values[key]).slice(0, 160) :
      /^CHOICE[1-5]$/.test(key) ? '   ' : '', true));
}

function classicColors(source) {
  // Keep extended-color templates intact; DOS artwork uses only these SGR codes.
  const supported = code => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 22, 23, 24, 25, 27, 28, 29, 39, 49].includes(code) ||
    (code >= 30 && code <= 37) || (code >= 40 && code <= 47) || (code >= 90 && code <= 97);
  // eslint-disable-next-line no-control-regex
  const pattern = /\x1b\[([0-9;]*)m/g;
  const codes = value => value.split(';').map(Number);
  if ([...source.matchAll(pattern)].some(match => !codes(match[1]).every(supported))) return source;
  let foreground = 37, background = 40, bright = false;
  const attributes = new Set();
  return source.replace(pattern, (_, parameters) => {
    for (const code of codes(parameters)) {
      if (code === 0) { foreground = 37; background = 40; bright = false; attributes.clear(); }
      else if (code >= 1 && code <= 9) attributes.add(code);
      else if (code >= 30 && code <= 37) { foreground = code; bright = false; }
      else if (code >= 90 && code <= 97) { foreground = code - 60; bright = true; }
      else if (code >= 40 && code <= 47) background = code;
      else if (code === 39) { foreground = 37; bright = false; }
      else if (code === 49) background = 40;
      else if (code === 22) { attributes.delete(1); attributes.delete(2); }
      else if (code === 23) attributes.delete(3);
      else if (code === 24) attributes.delete(4);
      else if (code === 25) { attributes.delete(5); attributes.delete(6); }
      else if (code === 27) attributes.delete(7);
      else if (code === 28) attributes.delete(8);
      else if (code === 29) attributes.delete(9);
    }
    const active = [...attributes].filter(code => code !== 1);
    if (bright || attributes.has(1)) active.unshift(1);
    // Reset and restate attributes: older ANSI clients ignore selective resets (22/27).
    return `\x1b[0;${[...active, foreground, background].join(';')}m`;
  });
}

function fixedRows(source) {
  let row = 1, saved = 1;
  // Re-anchor before CRLF, including clients which already wrapped at column 80.
  // eslint-disable-next-line no-control-regex
  return source.replace(/\r\n|\x1b\[([0-9;?]{0,24})([HfABCDsu])/g, (sequence, parameters, command) => {
    if (sequence === '\r\n') {
      const position = `\x1b[${row};1H`;
      row = Math.min(24, row + 1);
      return position + sequence;
    }
    const amount = Number(parameters.split(';')[0]) || 1;
    if (command === 'H' || command === 'f') row = Math.max(1, Math.min(24, amount));
    else if (command === 'A') row = Math.max(1, row - amount);
    else if (command === 'B') row = Math.min(24, row + amount);
    else if (command === 's') saved = row;
    else if (command === 'u') row = saved;
    return sequence;
  });
}

function cursorPosition(source) {
  let row = 1, column = 1, saved = { row, column };
  // eslint-disable-next-line no-control-regex
  for (const part of source.matchAll(/\x1b\[([0-9;?]*)([mHfABCDJKsu])|[\s\S]/g)) {
    if (part[2]) {
      const [a = 1, b = 1] = part[1].split(';').map(value => Number(value) || 1);
      if (part[2] === 'H' || part[2] === 'f') { row = a; column = b; }
      if (part[2] === 'A') row = Math.max(1, row - a);
      if (part[2] === 'B') row += a;
      if (part[2] === 'C') column += a;
      if (part[2] === 'D') column = Math.max(1, column - a);
      if (part[2] === 's') saved = { row, column };
      if (part[2] === 'u') ({ row, column } = saved);
    } else if (part[0] === '\r') column = 1;
    else if (part[0] === '\n') row++;
    else { if (column > 80) { row++; column = 1; } column++; }
  }
  return { row, column };
}

function sgrState(source, end) {
  let restore = '\x1b[0m';
  // Replay only the current SGR state, including extended-color templates.
  // eslint-disable-next-line no-control-regex
  for (const color of source.slice(0, end).matchAll(/\x1b\[([0-9;]*)m/g)) {
    if (Number(color[1].split(';')[0]) === 0) restore = '';
    restore += color[0];
  }
  return restore;
}

function loginLabels(source, selected, store, values) {
  let output = source;
  for (const match of [...source.matchAll(/\|\{CHOICE([1-5])\}/g)].reverse()) {
    const start = match.index;
    const index = Number(match[1]) - 1;
    const column = cursorPosition(substitute(source.slice(0, start), values)).column;
    let available = 3, end = start + match[0].length;
    while (available < 80 - column + 1) {
      // Labels may use blank padding across SGR changes, but never artwork glyphs.
      // eslint-disable-next-line no-control-regex
      const color = /^\x1b\[[0-9;]*m/.exec(source.slice(end));
      if (color) end += color[0].length;
      else if (source[end] === ' ') { end++; available++; }
      else break;
    }
    const width = Math.min(available, Math.max(0, 80 - column + 1));
    const label = plainText(uiText(store, loginChoices[index][1])).slice(0, width).padEnd(Math.min(3, width));
    end = start + match[0].length;
    for (let consumed = 3; consumed < label.length;) {
      // eslint-disable-next-line no-control-regex
      const color = /^\x1b\[[0-9;]*m/.exec(source.slice(end));
      if (color) end += color[0].length;
      else { end++; consumed++; }
    }
    output = output.slice(0, start) +
      `\x1b[0;${index === selected ? '1;37;44' : '37;40'}m${label.replaceAll('|', '||')}${sgrState(source, end)}` +
      output.slice(end);
  }
  return output;
}

function mainLabels(source, selected, values = {}) {
  const widths = mainColumnWidths();
  const folded = source.toLowerCase();
  const matches = mainChoices.map(([, label], index) => {
    const offset = folded.indexOf(label.toLowerCase());
    return { label: source.slice(offset, offset + label.length), index, offset };
  })
    .filter(match => match.offset >= 0).sort((a, b) => b.offset - a.offset);
  let output = source;
  for (const { label, index, offset } of matches) {
    let start = offset, end = offset + label.length, text = label;
    if (index === selected) {
      // Reuse artwork whitespace, including SGR boundaries, without shifting labels.
      let leading = offset;
      while (source[leading - 1] === 'm') {
        const escape = source.lastIndexOf('\x1b[', leading - 1);
        // eslint-disable-next-line no-control-regex
        if (escape < 0 || !/^\x1b\[[0-9;]*m$/.test(source.slice(escape, leading))) break;
        leading = escape;
      }
      if (source[leading - 1] === ' ') { start = leading - 1; text = ' ' + text; }
      const column = mainChoiceGrid.find(row => row.includes(index)).indexOf(index);
      const padding = widths[column] - label.length + 1;
      let spaces = 0;
      while (spaces < padding) {
        // eslint-disable-next-line no-control-regex
        const color = /^\x1b\[[0-9;]*m/.exec(source.slice(end));
        if (color) end += color[0].length;
        else if (source[end] === ' ') { end++; spaces++; }
        else break;
      }
      // Row anchors leave implicit blank cells at the end of artwork lines.
      // eslint-disable-next-line no-control-regex
      if (end === source.length || /^(?:\r?\n|\x1b\[\d+;1[Hf]\r\n)/.test(source.slice(end))) {
        const position = cursorPosition(substitute(source.slice(0, end), values));
        spaces += Math.min(padding - spaces, Math.max(0, 80 - position.column));
      }
      text += ' '.repeat(spaces);
    }
    output = output.slice(0, start) + `\x1b[0;1;${index === selected ? '37;44' : '30;40'}m${text}${sgrState(source, end)}` + output.slice(end);
  }
  return output;
}

export function validateString(key, value) {
  if (!stringDefaults.has(key)) throw new InputError('Unknown string key.');
  text(value, STRING_SOURCE_LIMIT, 'Display string');
  const visible = plainText(pipeText(value, STRING_SOURCE_LIMIT));
  if (!visible.trim() || visible.length > STRING_VISIBLE_LIMIT) {
    throw new InputError('string_visible_error');
  }
  for (const code of value.matchAll(/\|\||\|(\d{2})/g)) {
    if (code[1] && Number(code[1]) > 23) throw new InputError('string_color_error');
  }
  const allowed = mciTokens(stringDefaults.get(key)).map(({ name }) => name).filter(Boolean);
  if (/%[A-Z][A-Z0-9_]*%|~[A-Z0-9]{2}/.test(value)) throw new InputError('Unsupported string MCI code.');
  for (const { token } of mciTokens(value)) {
    if (!validMci(token, allowed)) throw new InputError('Unsupported string MCI code.');
  }
  return value;
}

function defaultAnsiDirectory() {
  const local = new URL('../ansi', import.meta.url);
  try {
    // Fixed operator configuration path, never caller input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!statSync(local).isDirectory()) throw new Error('The local ansi path must be a directory.');
    return fileURLToPath(local);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fileURLToPath(new URL('../examples/ansi', import.meta.url));
  }
}

export class Presentation {
  constructor(directory = defaultAnsiDirectory()) {
    this.templates = new Map();
    for (const [screen, tokens] of screenTokens) {
      let fd;
      try {
        // Fixed allowlisted filenames in a trusted, operator-selected directory.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fd = openSync(join(directory, `${screen}.ans`), 'r');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      let source;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 16384) throw new InputError('error_invalid_ansi_file_value_ans_maximum_16_kib', { SCREEN: screen });
        // The descriptor refers to the already opened, size-checked template.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        let bytes = readFileSync(fd);
        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          throw new InputError('error_ansi_files_must_not_have_a_bom_value_ans', { SCREEN: screen });
        }
        if (bytes.length >= 128 && bytes.subarray(-128, -121).toString('ascii') === 'SAUCE00') {
          const record = bytes.subarray(-128);
          const comments = record[104];
          const end = bytes.length - 128 - (comments ? 5 + comments * 64 : 0);
          if (end < 0 || (comments && bytes.subarray(end, end + 5).toString('ascii') !== 'COMNT')) {
            throw new InputError('error_invalid_sauce_metadata_value_ans', { SCREEN: screen });
          }
          bytes = bytes.subarray(0, end);
          if (bytes.at(-1) === 26) bytes = bytes.subarray(0, -1);
        }
        source = bytes.toString('latin1');
      } finally { closeSync(fd); }
      source = source.replaceAll('\0', '');
      // Permit art plus bounded CSI color/cursor sequences, never OSC or telnet IAC.
      // eslint-disable-next-line no-control-regex
      const plain = source.replace(/\x1b\[[0-9;?]{0,24}[mHfABCDJKsu]/g, '');
      if (!/^[\x20-\x7e\x80-\xfe\r\n]*$/.test(plain)) {
        throw new InputError('error_unsupported_ansi_controls_value_ans', { SCREEN: screen });
      }
      const oldToken = /%[A-Z][A-Z0-9_]*%|~[A-Z0-9]{2}/.exec(source);
      if (oldToken) throw new InputError('error_unsupported_placeholder_in_value_ans_value', { SCREEN: screen, VALUE2: oldToken[0] });
      for (const { token } of mciTokens(source)) {
        if (!validMci(token, tokens)) throw new InputError('error_unsupported_placeholder_in_value_ans_value', { SCREEN: screen, VALUE2: token });
      }
      source = source.replace(/\r\n|\r|\n/g, '\r\n');
      source = classicColors(source);
      if (screen === 'loginmatrix' || screen === 'main') {
        // Exported blank rows must not scroll the fixed-screen artwork.
        const rows = source.split('\r\n');
        while (rows.length > 1) {
          // eslint-disable-next-line no-control-regex
          const text = rows.at(-1).replace(/\x1b\[[0-9;]*m/g, '');
          if (text.replaceAll(' ', '') !== '') break;
          rows.pop();
        }
        source = rows.join('\r\n');
      }
      if (fixedScreens.has(screen)) source = fixedRows(source);
      const bounded = screen === 'main' ? mainLabels(source, 0) : source;
      if (bounded.replace(mciPattern(), 'x'.repeat(160)).length + 512 > 32768) {
        throw new InputError('error_expanded_ansi_file_is_too_large_value_ans', { SCREEN: screen });
      }
      this.templates.set(screen, source);
      if (screen === 'message-header') {
        const { row, column } = this.messagePosition();
        if (row > 20 || column > 77) {
          throw new InputError('message-header.ans must leave room for message text: |{BODY} at row 1-20, column 1-77.');
        }
      }
    }
  }

  position(screen, marker) {
    const source = this.templates.get(screen);
    if (source === undefined) return undefined;
    const index = marker === undefined ? source.length : source.indexOf(marker);
    if (index < 0) return undefined;
    const prefix = source.slice(0, index).replace(mciPattern(), token =>
      token === '||' ? '|' : isMciColor(token) ? '' :
        ' '.repeat(Number(mciWidth(token) ?? (/^\|\{CHOICE[1-5]\}$/.test(token) ? 3 : 0))));
    const { row, column } = cursorPosition(prefix);
    return `\x1b[${row};${column}H`;
  }

  messagePosition() {
    const marker = this.position('message-header', '|{BODY}');
    const cursor = marker ?? this.position('message-header');
    if (!cursor) return undefined;
    const [row, column] = cursor.slice(2, -1).split(';').map(Number);
    return marker ? { row, column } : { row: row + (column > 1 ? 1 : 0), column: 1 };
  }

  fieldWidth(screen, marker) {
    let result;
    for (const { name, token } of mciTokens(this.templates.get(screen) ?? '')) {
      if (mciCode(name) === marker) result = Math.max(result ?? 0, Number(mciWidth(token) ?? 160));
    }
    return result;
  }

  render(screen, fallback, values = {}, selected = screen === 'main' ? mainInitialSelection : 0, store) {
    let source = this.templates.get(screen);
    if (source === undefined) return fallback;
    if (screen === 'loginmatrix') {
      source = loginLabels(source, selected, store, values);
    } else if (screen === 'main') {
      source = mainLabels(source, selected, values);
    } else if (screen === 'login') {
      values = { ...values, LOGINHANDLE: '', LOGINPASSWORD: '',
        LOGINSTATUS: values.LOGINSTATUS ?? '', LOGINHELP: values.LOGINHELP ?? ui(store, 'login_help') };
    } else if (screen === 'message-header') {
      values = { ...values, RECIPIENT: values.RECIPIENT ?? ui(store, 'label_all'),
        MESSAGEDAY: values.MESSAGEDATE?.slice(0, 10), MESSAGETIME: values.MESSAGEDATE?.slice(11, 16), BODY: '' };
    }
    const interactive = screen === 'loginmatrix' || screen === 'main';
    const expanded = classicColors(substitute(source, values));
    let output = `\x1b[0m\x1b[2J\x1b[H\x1b[?7l${expanded}\x1b[0m\x1b[?7h${interactive ? '' : '\r\n'}`;
    if (screen === 'stats') {
      output += '\x1b[24;1H';
    }
    if (output.length > 32768) {
      throw new InputError('error_expanded_ansi_file_is_too_large_value_ans', { SCREEN: screen });
    }
    return output;
  }
}

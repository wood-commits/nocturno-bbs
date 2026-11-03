import { openSync, fstatSync, statSync, readFileSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { InputError, text, safeText } from './validation.js';

import { stringDefaults, pipeText, plainText, ui, uiText, STRING_SOURCE_LIMIT, STRING_VISIBLE_LIMIT } from './strings.js';
export { stringDefaults, displayString } from './strings.js';

const common = ['BBSNAME', 'USERNAME', 'NODE', 'DATE'];
export const loginChoices = [
  ['L', 'Login'], ['N', 'Apply for an account'], ['C', 'Check application'],
  ['S', 'Message sysop'], ['Q', 'Hangup']
];
export const mainChoices = [
  ['E', 'email'], ['C', 'user config'], ['U', 'user list'], ['F', 'files'],
  ['M', 'message menu'], ['S', 'note to sysop'], ['K', 'qwk mail menu'],
  ['O', 'automessage'], ['P', 'page sysop'], ['T', 'your stats'],
  ['B', 'bbs list'], ['L', 'last callers'], ['I', 'oneliners'],
  ['D', 'doors'], ['G', 'autosig menu'], ['Q', 'goodbye']
];
export const mainInitialSelection = mainChoices.findIndex(([key]) => key === 'M');
export const mainChoiceGrid = [[null, 0, 1], [null, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15]];
export function mainColumnWidths(labels = mainChoices.map(([, label]) => label)) {
  return mainChoiceGrid[0].map((_, column) =>
    Math.max(...mainChoiceGrid.map(row => row[column] === null ? 0 : plainText(labels[row[column]]).length)));
}
const legacyTokens = new Map([
  ['loginmatrix', ['01', '02', '03', '04', '05']],
  ['login', ['LN', 'LP', 'LI', 'LH']],
  ['new-message-header', ['SN', 'RN', 'MT', 'MN', 'DT', 'MA', 'TI', 'TL']]
]);
const fixedScreens = new Set(['loginmatrix', 'main-new', 'login', 'stats', 'new-message-header']);
export const screenTokens = new Map([
  ['loginmatrix', common],
  ['login', common],
  ['stats', [...common, 'CALLS', 'POSTS', 'MAIL', 'UPLOADS', 'DOWNLOADS', 'ACCESS', 'USERNOTE']],
  ['main-new', common],
  ['new-message-header', [...common, 'PAGE', 'BASENAME', 'BASEID', 'MESSAGEID', 'MESSAGEAUTHOR', 'MESSAGESUBJECT', 'MESSAGEDATE']],
  ['welcome', [...common, 'TRANSPORT', 'TAGLINE']],
  ['main', common],
  ['users', [...common, 'PAGE']],
  ['callers', [...common, 'PAGE']],
  ['messages', [...common, 'PAGE', 'BASENAME', 'BASEID']],
  ['message-header', [...common, 'PAGE', 'BASENAME', 'BASEID', 'MESSAGEID', 'MESSAGEAUTHOR', 'MESSAGESUBJECT', 'MESSAGEDATE']],
  ['message-bases', [...common, 'PAGE']],
  ['compose', [...common, 'BASENAME', 'BASEID']],
  ['doors', common],
  ['realm', [...common, 'PAGE']]
]);

export function substitute(value, values) {
  return value.replace(/%([A-Z]+)%/g, (token, key) =>
    Object.hasOwn(values, key) ? safeText(values[key]).slice(0, 160) : token);
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

function legacyFields(source, pattern, render) {
  let output = '', cursor = 0;
  for (const match of source.matchAll(pattern)) {
    let end = match.index + match[0].length;
    let colors = '';
    // Color sequences between the field and its padding consume no columns.
    while (source[end] === '\x1b') {
      // eslint-disable-next-line no-control-regex
      const color = /^\x1b\[[0-9;]{0,24}m/.exec(source.slice(end));
      if (!color) break;
      colors += color[0];
      end += color[0].length;
    }
    const padding = end;
    while (source[end] === ' ') end++;
    output += source.slice(cursor, match.index) + render(match[1], 3 + end - padding) + colors;
    cursor = end;
  }
  return output + source.slice(cursor);
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

function mainLabels(source, selected, values = {}) {
  const widths = mainColumnWidths();
  const matches = mainChoices.map(([, label], index) => ({ label, index, offset: source.indexOf(label) }))
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
    let restore = '\x1b[0m';
    // Replay only the current SGR state, including extended-color templates.
    // eslint-disable-next-line no-control-regex
    for (const color of source.slice(0, end).matchAll(/\x1b\[([0-9;]*)m/g)) {
      if (Number(color[1].split(';')[0]) === 0) restore = '';
      restore += color[0];
    }
    output = output.slice(0, start) + `\x1b[0;1;${index === selected ? '37;44' : '30;40'}m${text}${restore}` + output.slice(end);
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
  const allowed = new Set([...stringDefaults.get(key).matchAll(/%([A-Z][A-Z0-9_]*)%/g)].map(match => match[1]));
  for (const token of value.matchAll(/%([A-Z][A-Z0-9_]*)%/g)) {
    if (!allowed.has(token[1])) throw new InputError('Unsupported string placeholder.');
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
      const cp437 = legacyTokens.has(screen) || ['main-new', 'stats', 'welcome'].includes(screen);
      if (cp437) source = source.replaceAll('\0', '');
      // Permit art plus bounded CSI color/cursor sequences, never OSC or telnet IAC.
      // eslint-disable-next-line no-control-regex
      const plain = source.replace(/\x1b\[[0-9;?]{0,24}[mHfABCDJKsu]/g, '');
      if (!(cp437 ? /^[\x20-\x7e\x80-\xfe\r\n]*$/ : /^[\x20-\x7e\r\n]*$/).test(plain)) {
        throw new InputError('error_unsupported_ansi_controls_value_ans', { SCREEN: screen });
      }
      for (const match of source.matchAll(/%([A-Z]+)%/g)) {
        if (!tokens.includes(match[1])) throw new InputError('error_unsupported_placeholder_in_value_ans_value', { SCREEN: screen, VALUE2: match[0] });
      }
      for (const match of source.matchAll(/~([A-Z0-9]{2})/g)) {
        if (!legacyTokens.get(screen)?.includes(match[1])) {
          throw new InputError('error_unsupported_placeholder_in_value_ans_value', { SCREEN: screen, VALUE2: match[0] });
        }
      }
      source = source.replace(/\r\n|\r|\n/g, '\r\n');
      source = classicColors(source);
      if (fixedScreens.has(screen)) source = fixedRows(source);
      const bounded = screen === 'main-new' ? mainLabels(source, 0) : source;
      if (bounded.replace(/%[A-Z]+%|~[A-Z0-9]{2}/g, 'x'.repeat(160)).length + 512 > 32768) {
        throw new InputError('error_expanded_ansi_file_is_too_large_value_ans', { SCREEN: screen });
      }
      this.templates.set(screen, source);
      if (screen === 'new-message-header') {
        const { row, column } = this.messagePosition();
        if (row > 20 || column > 77) {
          throw new InputError('new-message-header.ans must leave room for message text: ~TL at row 1-20, column 1-77.');
        }
      }
    }
  }

  position(screen, marker) {
    const source = this.templates.get(screen);
    if (source === undefined) return undefined;
    const index = marker === undefined ? source.length : source.indexOf(marker);
    if (index < 0) return undefined;
    const { row, column } = cursorPosition(source.slice(0, index));
    return `\x1b[${row};${column}H`;
  }

  messagePosition() {
    const marker = this.position('new-message-header', '~TL');
    const cursor = marker ?? this.position('new-message-header');
    if (!cursor) return undefined;
    const [row, column] = cursor.slice(2, -1).split(';').map(Number);
    return marker ? { row, column } : { row: row + (column > 1 ? 1 : 0), column: 1 };
  }

  fieldWidth(screen, marker) {
    let result;
    legacyFields(this.templates.get(screen) ?? '', /~([A-Z]{2})/g, (key, width) => {
      if (`~${key}` === marker) result = width;
      return '';
    });
    return result;
  }

  render(screen, fallback, values = {}, selected = screen === 'main-new' ? mainInitialSelection : 0, store) {
    let source = this.templates.get(screen);
    if (source === undefined) return fallback;
    const literal = value => safeText(value).replaceAll('%', '\0');
    if (screen === 'loginmatrix') {
      source = legacyFields(source, /~0([1-5])/g, (digit, width) => {
        const index = Number(digit) - 1;
        const labelWidth = Math.max(width, loginChoices[index][1].length);
        const label = plainText(uiText(store, loginChoices[index][1])).slice(0, labelWidth).padEnd(labelWidth);
        return index === selected ? `\x1b[7m${label}\x1b[27m` : label;
      });
    } else if (screen === 'main-new') {
      source = mainLabels(source, selected, values);
    } else if (screen === 'login') {
      source = source.replace(/~(LN|LP|LI|LH)/g, (_, key) => literal({
        LN: '', LP: '', LI: values.LOGINSTATUS ?? '', LH: values.LOGINHELP ?? ui(store, 'login_help')
      }[key]));
    } else if (screen === 'new-message-header') {
      const aliases = {
        SN: values.MESSAGEAUTHOR, RN: values.RECIPIENT ?? ui(store, 'label_all'), MT: values.MESSAGESUBJECT,
        MN: values.MESSAGEID, DT: values.MESSAGEDATE?.slice(0, 10),
        MA: values.BASENAME, TI: values.MESSAGEDATE?.slice(11, 16)
      };
      source = legacyFields(source, /~([A-Z]{2})/g, (key, width) => {
        const value = safeText(aliases[key] ?? '').slice(0, width).padEnd(width);
        return literal(value);
      });
    }
    const interactive = screen === 'loginmatrix' || screen === 'main-new';
    // Protect literal percent signs from a second expansion across token syntaxes.
    const expanded = classicColors(substitute(source, values).replaceAll('\0', '%'));
    let output = `\x1b[0m\x1b[2J\x1b[H\x1b[?7l${expanded}\x1b[0m\x1b[?7h${interactive ? '' : '\r\n'}`;
    if (screen === 'stats') {
      const fields = [['handle   :', values.USERNAME], ['usernote :', values.USERNOTE],
        ['access level :', values.ACCESS], ['calls        :', values.CALLS],
        ['mail waiting :', values.MAIL], ['uploads      :', values.UPLOADS],
        ['downloads    :', values.DOWNLOADS]];
      for (const [label, value] of fields) {
        const cursor = this.position(screen, label);
        if (cursor) {
          // Leave column 80 untouched to avoid delayed-wrap surprises.
          const column = Number(cursor.slice(cursor.indexOf(';') + 1, -1));
          output += `${cursor}\x1b[${label.length}C${safeText(value ?? '').slice(0, Math.max(0, 80 - column - label.length))}`;
        }
      }
      output += '\x1b[24;1H';
    }
    if (output.length > 32768) {
      throw new InputError('error_expanded_ansi_file_is_too_large_value_ans', { SCREEN: screen });
    }
    return output;
  }
}

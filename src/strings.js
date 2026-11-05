import { catalog } from './string-catalog.js';
import { mciPattern, mciName, mciWidth, isMciColor } from './mci.js';

export const stringDefaults = new Map(catalog);
export const STRING_SOURCE_LIMIT = 512;
export const STRING_VISIBLE_LIMIT = 160;
const sgr = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
const palette = [0, 4, 2, 6, 1, 5, 3, 7];

class StyledText extends String {
  slice(start = 0, end = Infinity) {
    let column = 0, result = '';
    for (const part of String(this).matchAll(/\x1b\[[0-9;]*m|[\s\S]/g)) { // eslint-disable-line no-control-regex
      if (part[0].startsWith('\x1b')) result += part[0];
      else if (column++ >= start && column <= end) result += part[0];
      if (column >= end) break;
    }
    return new StyledText(result + (String(this).includes('\x1b') ? '\x1b[0m' : ''));
  }

  padEnd(width, fill = ' ') {
    return new StyledText(String(this) + fill.repeat(Math.max(0, width - plainText(this).length)));
  }
}

export function safeText(value) {
  return value instanceof StyledText ? value : String(value).replace(/[^\x20-\x7e]/g, '?');
}

export function plainText(value) {
  return String(value).replace(sgr, '');
}

export function pipeText(source, limit = STRING_VISIBLE_LIMIT, resolve, artwork = false) {
  let foreground = 7, background = 0, column = 0, output = '', colored = false;
  source = artwork ? String(source) : String(source).slice(0, STRING_SOURCE_LIMIT).replace(/[^\x20-\x7e]/g, '?');
  // Sticky matching keeps scanning linear; the lexer is fixed, never caller supplied.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const tokens = new RegExp(mciPattern().source, 'y');
  for (let index = 0; index < source.length && column < limit; index++) {
    tokens.lastIndex = index;
    const match = source[index] === '|' ? tokens.exec(source) : undefined;
    const codeText = match?.index === index ? match[0] : undefined;
    if (codeText === '||') {
      output += '|'; index++; column++;
      continue;
    }
    if (codeText && isMciColor(codeText)) {
      const code = Number(codeText.slice(1));
      if (code < 16) foreground = code;
      else background = code - 16;
      output += `\x1b[0;${foreground >= 8 ? '1;' : ''}${30 + palette[foreground & 7]};${40 + palette[background]}m`;
      colored = true;
      index += 2;
    } else if (codeText && resolve) {
      let value = resolve(mciName(codeText), codeText);
      const width = mciWidth(codeText);
      if (width !== undefined) value = value.slice(0, Number(width)).padEnd(Number(width));
      output += value;
      column += plainText(value).length;
      index += codeText.length - 1;
    } else { output += source[index]; column++; }
  }
  return new StyledText(output + (colored ? '\x1b[0m' : ''));
}

export function rawString(store, key) {
  if (!stringDefaults.has(key)) throw new Error('Unknown display string key.');
  return store?.stringOverride(key) ?? stringDefaults.get(key);
}

export function displayString(store, key, values = {}) {
  return rawString(store, key).replace(mciPattern(), token => {
    const name = mciName(token);
    if (!Object.hasOwn(values, name)) return token;
    const value = safeText(values[name]);
    const width = mciWidth(token);
    return width === undefined ? value : value.slice(0, Number(width)).padEnd(Number(width));
  });
}

export function ui(store, key, values = {}, width = STRING_VISIBLE_LIMIT) {
  return pipeText(rawString(store, key), STRING_SOURCE_LIMIT, (name, token) =>
    Object.hasOwn(values, name) ? safeText(values[name]).slice(0, STRING_SOURCE_LIMIT) : token).slice(0, width);
}

let plainKeys;
export function stringKey(message) {
  if (!plainKeys) {
    plainKeys = new Map();
    for (const [key, source] of stringDefaults) {
      const text = plainText(pipeText(source, STRING_SOURCE_LIMIT));
      if (!plainKeys.has(text)) plainKeys.set(text, key);
    }
  }
  return plainKeys.get(plainText(message));
}

export function uiText(store, source) {
  const key = stringKey(source);
  return key ? ui(store, key) : safeText(source);
}

export function errorText(store, error) {
  const key = error?.stringKey ?? stringKey(error?.message ?? error);
  return key ? ui(store, key, error?.values) : safeText(error?.message ?? error);
}

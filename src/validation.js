import { stringDefaults, stringKey, plainText, ui } from './strings.js';
export { safeText } from './strings.js';

export class InputError extends Error {
  constructor(message, values = {}) {
    const key = stringDefaults.has(message) ? message : stringKey(message);
    super(key ? plainText(ui(undefined, key, values, 512)) : message);
    this.stringKey = key;
    this.values = values;
  }
}

export function username(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,23}$/.test(value)) {
    throw new InputError('Use 3-24 letters, numbers, underscores or hyphens.');
  }
  return value;
}

export function password(value) {
  if (!/^[\x20-\x7e]{12,128}$/.test(value)) {
    throw new InputError('Use a unique password of 12-128 printable ASCII characters.');
  }
  return value;
}

export function text(value, max, label = 'Text') {
  if (!value.trim() || value.length > max || !/^[\x20-\x7e]+$/.test(value)) {
    throw new InputError('error_value_must_contain_1_value_printable_ascii_characters', { LABEL: label, MAX: max });
  }
  return value.trim();
}

export function messageBody(value) {
  if (value.length > 4096 || value.split('\n').length > 50 ||
      !value.split('\n').every(line => /^[\x20-\x7e]*$/.test(line)) || !value.trim()) {
    throw new InputError('Message must be printable text, at most 50 lines / 4096 characters.');
  }
  return value.trim();
}

import { Duplex } from 'node:stream';

const cp437 =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export function terminalText(text) {
  return String(text).replace(/[\x80-\xff]/g, character => cp437[character.charCodeAt(0) - 128]);
}

export const localColumns = 80;
export const localRows = 25;

const dosPalette = [
  [0, 0, 0], [170, 0, 0], [0, 170, 0], [170, 85, 0],
  [0, 0, 170], [170, 0, 170], [0, 170, 170], [170, 170, 170],
  [85, 85, 85], [255, 85, 85], [85, 255, 85], [255, 255, 85],
  [85, 85, 255], [255, 85, 255], [85, 255, 255], [255, 255, 255]
];

function indexedColor(index) {
  if (index < 16) return dosPalette[index];
  if (index >= 232) return Array(3).fill(8 + (index - 232) * 10);
  const component = value => value ? 55 + value * 40 : 0;
  return [Math.floor((index - 16) / 36), Math.floor((index - 16) / 6) % 6, (index - 16) % 6].map(component);
}

export class LocalTerminal {
  constructor(output) {
    this.output = output;
    this.rows = output.rows === 24 ? 24 : localRows;
    this.row = 0;
    this.column = 0;
    this.saved = [0, 0];
    this.wrap = true;
    this.pending = '';
    this.resetColors();
  }

  get writableLength() { return this.output.writableLength ?? 0; }

  resize() {
    const rows = this.output.rows === 24 ? 24 : localRows;
    if (rows === this.rows) return false;
    const row = Math.min(this.row, rows - 1), column = Math.min(this.column, localColumns - 1);
    this.rows = rows;
    this.write(`\x1b[r\x1b[${row + 1};${column + 1}H`);
    return true;
  }

  resetColors() {
    this.foreground = 7;
    this.background = 0;
    this.bold = false;
    this.inverse = false;
    this.attributes = new Set();
  }

  colors(parameters) {
    const codes = parameters.split(';').map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index];
      if (code === 0) this.resetColors();
      else if (code === 1) this.bold = true;
      else if (code === 22) { this.bold = false; this.attributes.delete(2); }
      else if (code === 7) this.inverse = true;
      else if (code === 27) this.inverse = false;
      else if (code === 39) this.foreground = 7;
      else if (code === 49) this.background = 0;
      else if (code >= 30 && code <= 37) this.foreground = code - 30;
      else if (code >= 40 && code <= 47) this.background = code - 40;
      else if (code >= 90 && code <= 97) this.foreground = code - 90 + 8;
      else if (code >= 100 && code <= 107) this.background = code - 100 + 8;
      else if (code === 38 || code === 48) {
        const mode = codes[++index];
        const count = mode === 2 ? 3 : mode === 5 ? 1 : 0;
        const values = codes.slice(index + 1, index + 1 + count);
        if (!count || values.length !== count || values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
          throw new Error('Invalid local terminal color.');
        }
        this[code === 38 ? 'foreground' : 'background'] = mode === 2 ? values : indexedColor(values[0]);
        index += count;
      } else if ([2, 3, 4, 5, 6, 8, 9].includes(code)) this.attributes.add(code);
      else if (code >= 23 && code <= 29) {
        this.attributes.delete(code - 20);
        if (code === 25) this.attributes.delete(6);
      }
    }
    let foreground = Array.isArray(this.foreground) ? this.foreground :
      dosPalette[this.foreground | (this.bold ? 8 : 0)];
    let background = Array.isArray(this.background) ? this.background : dosPalette[this.background];
    if (this.inverse) [foreground, background] = [background, foreground];
    return `\x1b[0;${[...this.attributes, 38, 2, ...foreground, 48, 2, ...background].join(';')}m`;
  }

  position() { return `\x1b[${this.row + 1};${this.column + 1}H`; }

  control(sequence, parameters, command) {
    const values = parameters.split(';').map(Number);
    const amount = values[0] || 1;
    if (command === 'm') return this.colors(parameters);
    if (parameters === '?7' && (command === 'h' || command === 'l')) {
      this.wrap = command === 'h';
      return '\x1b[?7l';
    }
    if (command === 'r') {
      this.row = this.column = 0;
      return `\x1b[1;${this.rows}r`;
    }
    let prefix = '';
    if (this.column === localColumns) {
      this.column = localColumns - 1;
      prefix = this.position();
    }
    if (command === 's') { this.saved = [this.row, this.column]; return prefix; }
    if (command === 'u') [this.row, this.column] = this.saved;
    else if (command === 'H' || command === 'f') {
      this.row = Math.max(0, Math.min(this.rows - 1, amount - 1));
      this.column = Math.max(0, Math.min(localColumns - 1, (values[1] || 1) - 1));
    } else if (command === 'A') this.row = Math.max(0, this.row - amount);
    else if (command === 'B') this.row = Math.min(this.rows - 1, this.row + amount);
    else if (command === 'C') this.column = Math.min(localColumns - 1, this.column + amount);
    else if (command === 'D') this.column = Math.max(0, this.column - amount);
    else return prefix + sequence;
    this.column = Math.min(localColumns - 1, this.column);
    return this.position();
  }

  render(text) {
    const source = this.pending + terminalText(text);
    this.pending = '';
    let output = '';
    for (let index = 0; index < source.length; index++) {
      const character = source[index];
      if (character === '\x1b') {
        // All application escapes are CSI; retain bounded partial sequences across writes.
        // eslint-disable-next-line no-control-regex
        const sequence = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(source.slice(index));
        if (!sequence) {
          const remaining = source.slice(index);
          // eslint-disable-next-line no-control-regex
          const partial = remaining === '\x1b' || /^\x1b\[[0-9;?]*$/.test(remaining);
          if (remaining.length > 128 || !partial) {
            throw new Error('Invalid local terminal control.');
          }
          this.pending = remaining;
          break;
        }
        output += this.control(sequence[0], sequence[1], sequence[2]);
        index += sequence[0].length - 1;
      } else if (character === '\r') {
        this.column = 0;
        output += character;
      } else if (character === '\n') {
        if (this.column === localColumns) {
          this.column = localColumns - 1;
          output += this.position();
        }
        this.row = Math.min(this.rows - 1, this.row + 1);
        output += character;
      } else if (character === '\b') {
        this.column = Math.max(0, this.column - 1);
        output += this.position();
      } else if (character === '\x07') output += character;
      else {
        if (this.column === localColumns) {
          if (this.wrap) {
            output += '\r\n';
            this.row = Math.min(this.rows - 1, this.row + 1);
            this.column = 0;
          } else {
            this.column = localColumns - 1;
            output += this.position();
          }
        }
        output += character;
        this.column++;
      }
    }
    return output;
  }

  start() {
    this.started = true;
    this.output.write(`\x1b[?7l\x1b[1;${this.rows}r` + this.render('\x1b[0m\x1b[2J\x1b[H'));
  }

  write(text) {
    if (!this.started) this.start();
    return this.output.write(this.render(text));
  }
}

export class LocalSocket extends Duplex {
  constructor(onWrite = () => {}) {
    super();
    this.onWrite = onWrite;
    this.remoteAddress = '127.0.0.1';
  }

  _read() {}
  _write(data, encoding, done) { this.onWrite(data); done(); }
  _final(done) { done(); this.destroy(); }
  _destroy(error, done) { clearTimeout(this.idleTimer); done(error); }

  setTimeout(milliseconds, callback) {
    this.idleMilliseconds = milliseconds;
    this.on('timeout', callback);
    this.touch();
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.emit('timeout'), this.idleMilliseconds);
    this.idleTimer.unref();
  }

  send(data) {
    if (this.destroyed) return;
    this.touch();
    this.push(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  }
}

import { EventEmitter } from 'node:events';

const IAC = 255, WILL = 251, WONT = 252, DO = 253, DONT = 254, SB = 250, SE = 240;
const ECHO = 1, SGA = 3;

export class TelnetInput extends EventEmitter {
  constructor({ write, secret = () => false, mode = () => 'line', shortcuts = () => '', maxLine = 160 }) {
    super();
    Object.assign(this, { write, secret, mode, shortcuts, maxLine });
    this.line = '';
    this.state = 'data';
    this.cr = false;
    this.escape = '';
    this.subBytes = 0;
    this.negotiations = 0;
    this.failed = false;
  }

  negotiate() {
    this.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, SGA]));
  }

  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.line = '';
    this.emit('violation', reason);
  }

  feed(data) {
    for (let offset = 0; offset < data.length; offset++) {
      const byte = data[offset];
      if (this.failed) break;
      if (this.state === 'option') {
        if (++this.negotiations > 128) { this.fail('Too much telnet negotiation.'); break; }
        const accepted = (this.command === DO && (byte === ECHO || byte === SGA)) ||
          (this.command === WILL && byte === SGA);
        if (this.command === DO && byte === ECHO) this.echoAccepted = true;
        if (!accepted && (this.command === DO || this.command === WILL)) {
          this.write(Buffer.from([IAC, this.command === DO ? WONT : DONT, byte]));
        }
        // A refusing client could locally echo credentials. Do not offer login.
        if ((this.command === DONT && byte === ECHO) || (this.command === WILL && byte === ECHO)) {
          this.fail('Client must support server echo for password privacy.');
        }
        this.state = 'data';
        continue;
      }
      if (this.state === 'sub' || this.state === 'sub-iac') {
        if (++this.subBytes > 1024) { this.fail('Telnet subnegotiation too long.'); break; }
        if (this.state === 'sub-iac' && byte === SE) this.state = 'data';
        else this.state = byte === IAC && this.state === 'sub' ? 'sub-iac' : 'sub';
        continue;
      }
      if (this.state === 'iac') {
        if ([WILL, WONT, DO, DONT].includes(byte)) {
          this.command = byte;
          this.state = 'option';
        } else if (byte === SB) {
          this.subBytes = 0;
          this.state = 'sub';
        } else {
          this.state = 'data';
          if (byte === IAC && this.mode() === 'raw') this.emit('raw', Buffer.from([IAC]));
        }
        continue;
      }
      if (byte === IAC) { this.state = 'iac'; continue; }
      if (this.mode() === 'raw') {
        let end = data.indexOf(IAC, offset);
        if (end < 0) end = data.length;
        this.emit('raw', data.subarray(offset, end));
        offset = end - 1;
        continue;
      }
      if (this.escape) {
        if (++this.escapeBytes > 1024) { this.fail('Terminal escape sequence too long.'); break; }
        if (this.escape === 'start' && (byte === 91 || byte === 79)) this.escape = 'csi';
        else if (this.escape === 'start' && byte === 93) this.escape = 'osc';
        else if (this.escape === 'osc' && byte === 27) this.escape = 'osc-end';
        else if (this.escape === 'osc-end') this.escape = byte === 92 ? '' : 'osc';
        else if (this.escape === 'osc' && byte === 7) this.escape = '';
        else if (this.escape === 'start' || (this.escape === 'csi' && byte >= 64 && byte <= 126)) {
          const arrow = new Map([[65, 'up'], [66, 'down'], [67, 'right'], [68, 'left']]).get(byte);
          if (this.escape === 'csi' && this.escapeBytes === 2 && arrow && this.mode() === 'key') {
            this.emit('key', arrow);
          }
          this.escape = '';
        }
        continue;
      }
      if (byte === 27) { this.skipEnter = false; this.escape = 'start'; this.escapeBytes = 0; continue; }
      if (this.cr && (byte === 10 || byte === 0)) { this.cr = false; continue; }
      this.cr = false;
      if (this.skipEnter) {
        this.skipEnter = false;
        if (byte === 13 || byte === 10) { this.cr = byte === 13; continue; }
      }
      if (!this.line && byte >= 32 && byte <= 126 &&
          this.shortcuts().includes(String.fromCharCode(byte).toUpperCase())) {
        this.skipEnter = true;
        this.emit('line', String.fromCharCode(byte));
        continue;
      }
      if (this.mode() === 'key' && (byte === 8 || byte === 127)) {
        this.emit('key', 'backspace');
        continue;
      }
      if (this.mode() === 'key' && (byte === 13 || byte === 10 || (byte >= 32 && byte <= 126))) {
        this.cr = byte === 13;
        this.emit('key', byte === 13 || byte === 10 ? 'enter' : String.fromCharCode(byte));
        continue;
      }
      if (byte === 13 || byte === 10) {
        this.cr = byte === 13;
        const line = this.line;
        this.line = '';
        this.write('\r\n');
        this.emit('line', line);
      } else if (byte === 8 || byte === 127) {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          if (!this.secret()) this.write('\b \b');
        }
      } else if (byte >= 32 && byte <= 126) {
        if (this.line.length >= this.maxLine) { this.fail('Input line too long.'); break; }
        this.line += String.fromCharCode(byte);
        if (!this.secret()) this.write(String.fromCharCode(byte));
      }
    }
  }
}

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { startSysopAutomation } from './sysop.js';
import { terminalText } from './local-terminal.js';
import { InputError } from './validation.js';

const bufferLimit = 131072;

export class McpTerminal {
  constructor({ role, bbs, store, onQuit, onError }) {
    this.id = randomUUID();
    this.role = role;
    this.chunks = [];
    this.displayChunks = [];
    this.displayBytes = 0;
    this.bytes = 0;
    this.closed = false;
    const settings = store.settings();
    this.idleMilliseconds = settings.idle_minutes * 60000;
    this.touch();
    this.lifetime = setTimeout(() => this.close('Session time limit reached.'), settings.session_minutes * 60000);
    this.lifetime.unref();
    try {
      if (role === 'sysop') {
        this.input = new PassThrough();
        this.adapter = startSysopAutomation({
          store, bbs, input: this.input,
          output: { write: value => this.capture(Buffer.from(value)), writableLength: 0 },
          onQuit: () => { if (!this.closed) onQuit(); },
          onError: error => { onError(error); this.close('Internal BBS error.'); }
        });
      } else {
        this.session = bbs.openAgentSession(data => this.capture(data));
        this.display = text => this.captureDisplay(text);
        this.captureDisplay(this.session.screenHistory ?? '');
        this.session.on('display', this.display);
        this.session.once('session-close', () => this.close('Caller disconnected.'));
      }
      if (this.closed) {
        this.adapter?.stop();
        if (this.session && !this.session.closed) this.session.disconnect('MCP output limit exceeded.');
      }
    } catch (error) { this.close('Could not open session.'); throw error; }
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close('Idle timeout.'), this.idleMilliseconds);
    this.idle.unref();
  }

  capture(data) {
    if (this.closed) return;
    if (this.bytes + data.length > bufferLimit) {
      this.close('Unread output exceeded 128 KiB; session disconnected.');
      return;
    }
    this.bytes += data.length;
    this.chunks.push(Buffer.from(data));
  }

  captureDisplay(text) {
    if (this.closed) return;
    if (this.displayBytes + text.length > bufferLimit) {
      this.close('Unread display exceeded 128 KiB; session disconnected.');
      return;
    }
    this.displayBytes += text.length;
    this.displayChunks.push(text);
  }

  async exchange(data, waitMs) {
    if (data) {
      if (this.closed) throw new InputError('MCP terminal is closed.');
      if (data.length > 8192) throw new InputError('Send at most 8192 bytes at a time.');
      this.touch();
      if (this.role === 'sysop') {
        if ([...data].some(byte => byte > 127)) throw new InputError('Sysop input must be ASCII.');
        this.input.write(data);
      } else this.session.socket.send(data);
    }
    if (waitMs) await delay(waitMs);
    const raw = Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    let output;
    if (this.role === 'sysop') output = raw.toString('utf8');
    else output = terminalText(this.displayChunks.join(''));
    this.displayChunks = [];
    this.displayBytes = 0;
    // Keep cursor-positioned rows readable while retaining the original ANSI separately.
    const text = output
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[Hf]/g, '\r\n')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    return { sessionId: this.id, role: this.role, closed: this.closed, reason: this.reason,
      state: this.role === 'sysop' ? this.adapter?.controller.view : this.session?.state,
      text, ansi: output, ...(this.role === 'user' ? { base64: raw.toString('base64') } : {}) };
  }

  close(reason = 'Session closed.') {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    clearTimeout(this.idle);
    clearTimeout(this.lifetime);
    this.adapter?.stop();
    this.input?.destroy();
    if (this.display) this.session?.removeListener('display', this.display);
    if (this.session && !this.session.closed) this.session.disconnect('Disconnected by local MCP client.');
  }
}

import { InputError } from './validation.js';

export const Z = Object.freeze({
  ZRQINIT: 0, ZRINIT: 1, ZSINIT: 2, ZACK: 3, ZFILE: 4, ZSKIP: 5,
  ZNAK: 6, ZABORT: 7, ZFIN: 8, ZRPOS: 9, ZDATA: 10, ZEOF: 11,
  ZFERR: 12, ZCAN: 16, ZCRCE: 104, ZCRCG: 105, ZCRCQ: 106, ZCRCW: 107
});
const DLE = 24;

export function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escaped(bytes) {
  const out = [];
  for (const byte of bytes) {
    if (byte === 0x7f) out.push(DLE, 0x6c);
    else if (byte === 0xff) out.push(DLE, 0x6d);
    else if (byte < 32 || (byte >= 128 && byte < 160)) out.push(DLE, byte ^ 0x40);
    else out.push(byte);
  }
  return Buffer.from(out);
}

export function zHeader(type, position = 0, format = 'hex') {
  const body = Buffer.alloc(5);
  body[0] = type;
  body.writeUInt32LE(position >>> 0, 1);
  if (format === 'hex') {
    const crc = Buffer.alloc(2);
    crc.writeUInt16BE(crc16(body));
    return Buffer.concat([Buffer.from('**\x18B'), Buffer.from(Buffer.concat([body, crc]).toString('hex')), Buffer.from('\r\n\x11')]);
  }
  const crc = Buffer.alloc(format === 'crc32' ? 4 : 2);
  if (format === 'crc32') crc.writeUInt32LE(crc32(body));
  else crc.writeUInt16BE(crc16(body));
  return Buffer.concat([Buffer.from([42, DLE, format === 'crc32' ? 67 : 65]), escaped(Buffer.concat([body, crc]))]);
}

export function zData(data, end = Z.ZCRCW, format = 'crc16') {
  const crc = Buffer.alloc(format === 'crc32' ? 4 : 2);
  const checked = Buffer.concat([data, Buffer.from([end])]);
  if (format === 'crc32') crc.writeUInt32LE(crc32(checked));
  else crc.writeUInt16BE(crc16(checked));
  return Buffer.concat([escaped(data), Buffer.from([DLE, end]), escaped(crc), end === Z.ZCRCW ? Buffer.from([17]) : Buffer.alloc(0)]);
}

// Incremental framing has no NVT transformations: callers must decode telnet IAC first.
export class ZParser {
  constructor({ header, data }) {
    Object.assign(this, { header, data });
    this.buffer = Buffer.alloc(0);
    this.packet = null;
    this.noise = 0;
    this.cancels = 0;
  }

  expectData(format) {
    this.packet = { format, bytes: [], escaped: false, end: null, crc: [] };
  }

  feed(input) {
    // Work a byte at a time so even one large socket read cannot grow the parser buffer.
    for (const byte of input) {
      this.cancels = byte === DLE ? this.cancels + 1 : 0;
      if (this.cancels >= 5) throw new InputError('ZMODEM cancelled by client.');
      if (this.packet) this.dataByte(byte);
      else {
        this.buffer = Buffer.concat([this.buffer, Buffer.from([byte])]);
        this.parseHeader();
      }
    }
  }

  dataByte(byte) {
    const p = this.packet;
    if (!p.escaped && [17, 19, 145, 147].includes(byte)) return;
    if (!p.escaped && byte === DLE) { p.escaped = true; return; }
    if (p.escaped) {
      p.escaped = false;
      if (p.end === null && byte >= Z.ZCRCE && byte <= Z.ZCRCW) { p.end = byte; return; }
      if (byte === 108) byte = 127;
      else if (byte === 109) byte = 255;
      else if ((byte & 0x60) === 0x40) byte ^= 0x40;
      else throw new InputError('Invalid ZMODEM escape.');
    }
    if (p.end === null) {
      if (p.bytes.length >= 8192) throw new InputError('ZMODEM subpacket is too large.');
      p.bytes.push(byte);
    } else {
      p.crc.push(byte);
      const length = p.format === 'crc32' ? 4 : 2;
      if (p.crc.length === length) {
        const bytes = Buffer.from(p.bytes), crc = Buffer.from(p.crc);
        const checked = Buffer.concat([bytes, Buffer.from([p.end])]);
        const valid = length === 4 ? crc32(checked) === crc.readUInt32LE() : crc16(checked) === crc.readUInt16BE();
        this.packet = null;
        if (!valid) throw new InputError('ZMODEM data CRC mismatch.');
        this.data(bytes, p.end, p.format);
      }
    }
  }

  parseHeader() {
    const b = this.buffer;
    if (b.length > 40) throw new InputError('Invalid ZMODEM header.');
    if (b.length === 1 && b[0] !== 42) return this.discard();
    if (b.length < 2) return;
    if (b[1] === 42) { this.buffer = b.subarray(1); return; }
    if (b[1] !== DLE) return this.discard();
    if (b.length < 3) return;
    const marker = b[2];
    if (![65, 66, 67].includes(marker)) return this.discard();
    let decoded;
    if (marker === 66) {
      if (b.length < 19) return;
      if ((b[17] & 127) !== 13 || (b[18] & 127) !== 10) throw new InputError('Invalid ZMODEM header terminator.');
      const hex = b.subarray(3, 17).toString('ascii');
      if (!/^[0-9a-f]{14}$/i.test(hex)) throw new InputError('Invalid ZMODEM hex header.');
      decoded = Buffer.from(hex, 'hex');
    } else {
      const values = [];
      let escape = false;
      for (const byte of b.subarray(3)) {
        if (escape) {
          escape = false;
          if (byte === 108) values.push(127);
          else if (byte === 109) values.push(255);
          else if ((byte & 0x60) === 0x40) values.push(byte ^ 0x40);
          else throw new InputError('Invalid ZMODEM header escape.');
        } else if (byte === DLE) escape = true;
        else if (![17, 19, 145, 147].includes(byte)) values.push(byte);
      }
      if (escape || values.length < (marker === 67 ? 9 : 7)) return;
      decoded = Buffer.from(values);
    }
    const body = decoded.subarray(0, 5);
    const valid = marker === 67 ? crc32(body) === decoded.readUInt32LE(5) : crc16(body) === decoded.readUInt16BE(5);
    this.buffer = Buffer.alloc(0);
    this.noise = 0;
    if (!valid) throw new InputError('ZMODEM header CRC mismatch.');
    this.header(body[0], body.readUInt32LE(1), marker === 67 ? 'crc32' : 'crc16');
  }

  discard() {
    if (++this.noise > 8192) throw new InputError('Too much ZMODEM framing noise.');
    this.buffer = this.buffer.subarray(1);
  }
}

export class ZTransfer {
  constructor({ write, direction, file, maxSize, complete }) {
    Object.assign(this, { write, direction, file, maxSize, complete });
    this.offset = 0;
    this.retries = 0;
    this.phase = direction === 'receive' ? 'file' : 'init';
    this.parser = new ZParser({
      header: (type, position, format) => this.header(type, position, format),
      data: (data, end, format) => this.data(data, end, format)
    });
  }

  start() {
    this.send(this.direction === 'receive' ? Z.ZRINIT : Z.ZRQINIT, this.direction === 'receive' ? 0x23000000 : 0);
  }

  send(type, position = 0) { this.write(zHeader(type, position)); }
  feed(buffer) {
    if (this.phase === 'closing') {
      for (const byte of buffer) {
        if (byte === 79) this.overAndOut = (this.overAndOut ?? 0) + 1;
        else if (![10, 13, 17].includes(byte)) throw new InputError('Invalid ZMODEM finish.');
        if (this.overAndOut === 2) {
          this.phase = 'done';
          this.complete({ name: this.name, data: this.content });
          break;
        }
      }
      return;
    }
    // The parser may change phase while consuming a fragmented socket read.
    for (const byte of buffer) {
      if (this.phase === 'closing') this.feed(Buffer.from([byte]));
      else if (this.phase !== 'done') this.parser.feed(Buffer.from([byte]));
    }
  }

  header(type, position, format) {
    if ([Z.ZABORT, Z.ZCAN, Z.ZFERR, Z.ZSKIP].includes(type)) throw new InputError('ZMODEM transfer refused or cancelled.');
    if (type === Z.ZFIN) {
      if (this.direction === 'receive' && this.phase !== 'received') throw new InputError('ZMODEM file was not completed.');
      if (this.direction === 'send' && this.phase !== 'finish') throw new InputError('ZMODEM file was not acknowledged.');
      if (this.direction === 'send') {
        this.write(Buffer.from('OO'));
        this.phase = 'done';
        this.complete(null);
      } else {
        this.phase = 'closing';
        this.send(Z.ZFIN);
      }
      return;
    }
    if (this.direction === 'send') return this.senderHeader(type, position);
    if (type === Z.ZRQINIT && this.phase === 'file') { this.send(Z.ZRINIT, 0x23000000); return; }
    if (type === Z.ZSINIT && this.phase === 'file') {
      this.receiving = 'init';
      this.parser.expectData(format);
    } else if (type === Z.ZFILE && this.phase === 'file') {
      this.receiving = 'metadata';
      this.parser.expectData(format);
    } else if (type === Z.ZDATA && this.phase === 'data') {
      if (position !== this.offset) { this.send(Z.ZRPOS, this.offset); return; }
      this.receiving = 'data';
      this.parser.expectData(format);
    } else if (type === Z.ZEOF && this.phase === 'data') {
      if (position !== this.offset || this.offset !== this.size) throw new InputError('ZMODEM file size mismatch.');
      this.phase = 'received';
      this.send(Z.ZRINIT, 0x23000000);
    } else throw new InputError('Unexpected ZMODEM frame.');
  }

  senderHeader(type, position) {
    if (type === Z.ZRINIT && this.phase === 'init') {
      this.phase = 'position';
      this.send(Z.ZFILE);
      this.write(zData(Buffer.from(`${this.file.name}\0${this.file.data.length} 0 0 0 1 ${this.file.data.length}\0`)));
    } else if (type === Z.ZRINIT && this.phase === 'position') {
      // Both endpoints can send an initial ready/request before reading the other.
      return;
    } else if (type === Z.ZRPOS && ['position', 'ack', 'eof'].includes(this.phase)) {
      if (position > this.file.data.length || ++this.retries > 32) throw new InputError('Invalid ZMODEM restart position.');
      this.offset = position;
      this.sendChunk();
    } else if (type === Z.ZACK && this.phase === 'ack') {
      if (position !== this.offset) throw new InputError('Invalid ZMODEM acknowledgement.');
      this.sendChunk();
    } else if (type === Z.ZRINIT && this.phase === 'eof') {
      this.phase = 'finish';
      this.send(Z.ZFIN);
    } else if (type === Z.ZNAK) throw new InputError('ZMODEM peer rejected a frame. Retry the transfer.');
    else throw new InputError('Unexpected ZMODEM acknowledgement.');
  }

  sendChunk() {
    if (this.offset === this.file.data.length) {
      this.phase = 'eof';
      this.send(Z.ZEOF, this.offset);
      return;
    }
    const chunk = this.file.data.subarray(this.offset, this.offset + 1024);
    this.send(Z.ZDATA, this.offset);
    this.offset += chunk.length;
    this.phase = 'ack';
    this.write(zData(chunk));
  }

  data(bytes, end, format) {
    if (this.receiving === 'init') {
      if (bytes.length > 32 || end !== Z.ZCRCW) throw new InputError('Unsupported ZMODEM initialization.');
      this.send(Z.ZACK);
      return;
    }
    if (this.receiving === 'metadata') {
      if (end !== Z.ZCRCW || bytes.length > 1024) throw new InputError('Invalid ZMODEM file metadata.');
      const zero = bytes.indexOf(0);
      if (zero < 1) throw new InputError('ZMODEM filename missing.');
      this.name = bytes.subarray(0, zero).toString('latin1');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(this.name) || this.name.includes('..')) {
        throw new InputError('Use a filename of 1-64 letters, numbers, dots, underscores or hyphens; no paths.');
      }
      const metadata = bytes.subarray(zero + 1).toString('latin1').split('\0')[0];
      if (!/^\d{1,10}(?: |$)/.test(metadata)) throw new InputError('ZMODEM must declare the file size.');
      this.size = Number(metadata.split(' ')[0]);
      if (this.size < 1 || this.size > this.maxSize) throw new InputError('File exceeds the upload size limit.');
      this.content = Buffer.alloc(this.size);
      this.phase = 'data';
      this.send(Z.ZRPOS);
      return;
    }
    if (this.offset + bytes.length > this.size) throw new InputError('ZMODEM upload exceeds its declared size.');
    bytes.copy(this.content, this.offset);
    this.offset += bytes.length;
    if ([Z.ZCRCQ, Z.ZCRCW].includes(end)) this.send(Z.ZACK, this.offset);
    if ([Z.ZCRCG, Z.ZCRCQ].includes(end)) this.parser.expectData(format);
  }
}

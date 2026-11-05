import { inflateRawSync } from 'node:zlib';
import { InputError, text, messageBody, safeText } from './validation.js';
import { crc32 } from './transfer-zmodem.js';

export const QWK_LIMIT = 2 * 1024 * 1024;
const MAX_MESSAGES = 100;
export const QWK_ID = 'NOCTURNO';

export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name, 'ascii'), crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function unzip(input) {
  if (!Buffer.isBuffer(input) || input.length < 22 || input.length > QWK_LIMIT) throw new InputError('Invalid or oversized ZIP packet.');
  let end = -1;
  for (let i = input.length - 22; i >= Math.max(0, input.length - 65557); i--) {
    if (input.readUInt32LE(i) === 0x06054b50 && i + 22 + input.readUInt16LE(i + 20) === input.length) { end = i; break; }
  }
  if (end < 0 || input.readUInt16LE(end + 4) || input.readUInt16LE(end + 6)) throw new InputError('Unsupported ZIP archive.');
  const count = input.readUInt16LE(end + 10), start = input.readUInt32LE(end + 16);
  if (!count || count > 128 || input.readUInt16LE(end + 8) !== count ||
      start + input.readUInt32LE(end + 12) !== end) throw new InputError('Invalid ZIP directory.');
  const entries = new Map(), ranges = [];
  let at = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || input.readUInt32LE(at) !== 0x02014b50) throw new InputError('Invalid ZIP entry.');
    const flags = input.readUInt16LE(at + 8), method = input.readUInt16LE(at + 10);
    const crc = input.readUInt32LE(at + 16), compressed = input.readUInt32LE(at + 20), size = input.readUInt32LE(at + 24);
    const nameLength = input.readUInt16LE(at + 28), extra = input.readUInt16LE(at + 30), comment = input.readUInt16LE(at + 32);
    const local = input.readUInt32LE(at + 42);
    if (flags & ~0x808 || ![0, 8].includes(method) || size > QWK_LIMIT || total + size > QWK_LIMIT ||
        at + 46 + nameLength + extra + comment > end || input.readUInt16LE(at + 34)) throw new InputError('Unsupported or oversized ZIP entry.');
    const nameBytes = input.subarray(at + 46, at + 46 + nameLength), name = nameBytes.toString('latin1').toUpperCase();
    if (!/^[A-Z0-9_-]{1,32}\.[A-Z0-9]{1,3}$/.test(name) || entries.has(name)) throw new InputError('Unsafe or duplicate ZIP filename.');
    if (local + 30 > start || input.readUInt32LE(local) !== 0x04034b50 ||
        input.readUInt16LE(local + 6) !== flags || input.readUInt16LE(local + 8) !== method) throw new InputError('Invalid ZIP local entry.');
    const localName = input.readUInt16LE(local + 26), localExtra = input.readUInt16LE(local + 28);
    const dataStart = local + 30 + localName + localExtra, dataEnd = dataStart + compressed;
    if (localName !== nameLength || !input.subarray(local + 30, local + 30 + localName).equals(nameBytes) ||
        dataEnd > start || ranges.some(([a, b]) => local < b && dataEnd > a)) throw new InputError('Invalid overlapping ZIP entry.');
    ranges.push([local, dataEnd]);
    if (!(flags & 8) && (input.readUInt32LE(local + 14) !== crc || input.readUInt32LE(local + 18) !== compressed ||
        input.readUInt32LE(local + 22) !== size)) throw new InputError('ZIP metadata mismatch.');
    let data;
    try { data = method === 0 ? input.subarray(dataStart, dataEnd) : inflateRawSync(input.subarray(dataStart, dataEnd), { maxOutputLength: QWK_LIMIT }); }
    catch { throw new InputError('Invalid compressed ZIP data.'); }
    if (data.length !== size || crc32(data) !== crc) throw new InputError('ZIP CRC or size mismatch.');
    total += size;
    entries.set(name, data);
    at += 46 + nameLength + extra + comment;
  }
  if (at !== end) throw new InputError('Invalid ZIP directory length.');
  return entries;
}

function field(buffer, offset, length, value) {
  Buffer.from(safeText(value).slice(0, length), 'ascii').copy(buffer, offset);
}

export function qwkMessage(row, reply = false) {
  const body = Buffer.from(`${row.body.replace(/\n/g, '\xe3')}\xe3`, 'latin1');
  const blocks = 1 + Math.ceil(body.length / 128), header = Buffer.alloc(128, 32);
  header[0] = 32;
  field(header, 1, 7, reply ? row.base_id : row.id);
  const date = new Date(row.created_at ?? Date.now()), iso = date.toISOString();
  field(header, 8, 8, `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(2, 4)}`);
  field(header, 16, 5, iso.slice(11, 16));
  field(header, 21, 25, 'ALL');
  field(header, 46, 25, row.handle);
  field(header, 71, 25, row.subject);
  field(header, 116, 6, blocks);
  header[122] = 0xe1;
  header.writeUInt16LE(row.base_id, 123);
  header.writeUInt16LE(0, 125);
  header[127] = 32;
  const padded = Buffer.alloc((blocks - 1) * 128, 32);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

export function buildQwk(store, user) {
  user = store.access.caller(user.id);
  const bases = store.db.prepare(`SELECT b.id, b.name FROM message_bases b
    JOIN message_permissions p ON p.base_id = b.id
    WHERE b.id BETWEEN 1 AND 65535 AND p.role_id = ? AND p.can_read = 1 ORDER BY b.id LIMIT 100`).all(user.role_id);
  if (!bases.length) throw new InputError('access_denied');
  const rows = store.db.prepare(`SELECT m.id, m.base_id, m.subject, m.body, m.created_at, u.handle
    FROM messages m JOIN users u ON u.id = m.user_id
    JOIN message_permissions p ON p.base_id = m.base_id
    WHERE m.removed = 0 AND m.pending = 0 AND m.base_id BETWEEN 1 AND 65535 AND p.role_id = ? AND p.can_read = 1
    ORDER BY m.id DESC LIMIT ?`).all(user.role_id, MAX_MESSAGES).reverse();
  const timestamp = new Date().toISOString();
  const control = [
    safeText(store.settings().name), 'Local', 'Unlisted', 'Sysop', `0,${QWK_ID}`,
    `${timestamp.slice(5, 7)}-${timestamp.slice(8, 10)}-${timestamp.slice(0, 4)},${timestamp.slice(11, 19)}`,
    safeText(user.handle), '', '0', '0', String(bases.length - 1),
    ...bases.flatMap(base => [String(base.id), safeText(base.name)]), 'WELCOME', 'NEWS', 'GOODBYE', ''
  ].join('\r\n');
  const producer = Buffer.alloc(128, 32);
  producer.write('Produced by Nocturno BBS');
  const messages = [producer], indexes = new Map();
  let record = 2;
  for (const row of rows) {
    const message = qwkMessage(row);
    messages.push(message);
    // QWK indexes use the 4-byte Microsoft Binary Format, not IEEE floats.
    const ieee = Buffer.alloc(4), index = Buffer.alloc(5);
    ieee.writeFloatLE(record);
    index[0] = ieee[0];
    index[1] = ieee[1];
    index[2] = (ieee[2] & 127) | (ieee[3] & 128);
    index[3] = ((ieee.readUInt32LE() >>> 23) & 255) + 2;
    if (!indexes.has(row.base_id)) indexes.set(row.base_id, []);
    indexes.get(row.base_id).push(index);
    record += message.length / 128;
  }
  return zip([
    ['CONTROL.DAT', Buffer.from(control, 'ascii')], ['MESSAGES.DAT', Buffer.concat(messages)],
    ['PERSONAL.NDX', Buffer.alloc(0)],
    ...Array.from(indexes, ([id, records]) => [`${id}.NDX`, Buffer.concat(records)])
  ]);
}

export function parseReplies(packet) {
  const entries = unzip(packet);
  const packetId = entries.has(`${QWK_ID}.MSG`) ? QWK_ID : 'NIGHTWIR';
  const data = entries.get(`${packetId}.MSG`);
  if (!data || data.length < 128 || data.length % 128 || data.length > QWK_LIMIT) throw new InputError('error_reply_zip_must_contain_value_msg_in_128_byte_qwk_blocks', { QWK_ID: QWK_ID });
  if (data.subarray(0, 128).toString('ascii').trim().toUpperCase() !== packetId) throw new InputError('Reply packet is for a different BBS.');
  const rows = [];
  let offset = 128;
  while (offset < data.length) {
    if (rows.length >= MAX_MESSAGES) throw new InputError('At most 100 replies per packet.');
    const header = data.subarray(offset, offset + 128);
    const countField = header.subarray(116, 122).toString('ascii').trim();
    if (!/^\d{1,6}$/.test(countField)) throw new InputError('Invalid QWK message block count.');
    const count = Number(countField), next = offset + count * 128;
    if (count < 2 || count > 34 || next > data.length || header[122] !== 0xe1 ||
        ![32, 45].includes(header[0])) throw new InputError('Invalid or private QWK reply.');
    const conferenceField = header.subarray(1, 8).toString('ascii').trim();
    if (!/^\d{1,7}$/.test(conferenceField)) throw new InputError('Invalid QWK reply conference.');
    const baseId = Number(conferenceField), conference = header.readUInt16LE(123);
    if (conference && conference !== baseId) throw new InputError('Conflicting QWK reply conferences.');
    const raw = data.subarray(offset + 128, next);
    let body = '';
    for (const byte of raw) {
      if (byte === 0xe3) body += '\n';
      else if (byte >= 32 && byte <= 126) body += String.fromCharCode(byte);
      else throw new InputError('QWK replies must contain printable ASCII text.');
    }
    rows.push({ baseId, subject: text(header.subarray(71, 96).toString('latin1'), 25, 'Subject'), body: messageBody(body.trim()) });
    offset = next;
  }
  if (!rows.length) throw new InputError('Reply packet contains no messages.');
  return rows;
}

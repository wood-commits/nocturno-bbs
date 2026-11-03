import { StringDecoder } from 'node:string_decoder';

export const inputLimit = 65536;
export const outputLimit = 1048576;

export function writeJson(stream, value) {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) + (stream.writableLength ?? 0) > outputLimit) {
    throw new Error('MCP output limit exceeded.');
  }
  stream.write(frame);
}

export function readJson(stream, receive, fail, limit = inputLimit) {
  const decoder = new StringDecoder('utf8');
  let pending = '', bytes = 0, failed = false;
  const reject = error => {
    if (failed) return;
    failed = true;
    fail(error);
  };
  const data = chunk => {
    if (failed) return;
    const text = decoder.write(chunk);
    let start = 0;
    for (let index = 0; index <= text.length; index++) {
      if (index !== text.length && text[index] !== '\n') continue;
      const part = text.slice(start, index);
      bytes += Buffer.byteLength(part);
      if (bytes > limit) return reject(new Error('MCP frame limit exceeded.'));
      pending += part;
      if (index < text.length) {
        try {
          if (!pending.trim()) throw new Error('Empty MCP frame.');
          receive(JSON.parse(pending));
        } catch (error) { reject(error); return; }
        pending = '';
        bytes = 0;
      }
      start = index + 1;
    }
  };
  const end = () => {
    if (pending || decoder.end()) reject(new Error('Incomplete MCP frame.'));
  };
  stream.on('data', data);
  stream.on('end', end);
  return () => { stream.removeListener('data', data); stream.removeListener('end', end); };
}

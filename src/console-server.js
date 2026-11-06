import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { mcpProof, proofMatches } from './mcp-server.js';
import { readJson, writeJson } from './mcp-transport.js';
import { startSysopRemote } from './sysop.js';

// Remote sysop console: the same WFC controller as the local TTY, attached through an
// authenticated local IPC endpoint so `kubectl exec` / `ssh -t` operators reach it
// without any network listener. Proof roles are distinct from MCP's to keep the
// handshakes domain-separated even if an operator reuses one token for both.
export const CLIENT_ROLE = 'console-client';
export const SERVER_ROLE = 'console-server';
export const CONSOLE_INPUT_LIMIT = 4096;
const peerLimit = 4;
const handshakeMilliseconds = 5000;
// JSON escapes a control byte as six characters; clients chunk input well below this.
const frameLimit = 32768;
const burst = 200, refillPerSecond = 100;

export function validateConsoleOptions({ endpoint, token }) {
  if (typeof token !== 'string' || !/^[a-fA-F0-9]{64}$/.test(token)) {
    throw new Error('BBS_CONSOLE_TOKEN must be 64 hexadecimal characters generated randomly.');
  }
  if (typeof endpoint !== 'string' || (process.platform === 'win32'
    ? !/^\\\\\.\\pipe\\[A-Za-z0-9_-]{1,80}$/.test(endpoint)
    : !isAbsolute(endpoint))) throw new Error('The sysop console requires a local IPC endpoint.');
}

function dimension(value, fallback) {
  return Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
}

// A socket file left by this same account after a crash (common when a container
// restarts inside a pod that keeps its emptyDir) is only removed when nothing answers
// on it. A live listener, a non-socket or a file owned by anyone else is never touched.
async function removeStaleSocket(endpoint) {
  if (process.platform === 'win32') return false;
  let stats;
  // The endpoint is trusted operator configuration.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  try { stats = lstatSync(endpoint); } catch { return false; }
  if (!stats.isSocket() || stats.uid !== process.getuid?.()) return false;
  const refused = await new Promise(resolve => {
    const probe = net.connect(endpoint);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (refused) unlinkSync(endpoint);
  return refused;
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
  });
}

export async function startConsoleServer({ endpoint, token, store, bbs, onQuit, onError }) {
  validateConsoleOptions({ endpoint, token });
  const peers = new Set();
  let active;
  let stopping = false;
  const server = net.createServer(socket => {
    if (stopping || peers.size >= peerLimit) { socket.destroy(); return; }
    peers.add(socket);
    const challenge = randomBytes(32).toString('hex');
    let authenticated = false, adapter, idle, closed = false;
    let tokens = burst, tokenTime = Date.now();
    const output = new EventEmitter();
    const input = new PassThrough();
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      peers.delete(socket);
      if (active === socket) active = undefined;
      adapter?.stop();
      input.destroy();
      if (!socket.destroyed) socket.end();
    };
    const send = value => {
      if (socket.destroyed || closed) return;
      try { writeJson(socket, value); }
      // A client that stops reading must not grow server memory: drop it.
      catch { socket.destroy(); }
    };
    const idleMilliseconds = store.settings().idle_minutes * 60000;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { send({ notice: 'Idle timeout.' }); close(); }, idleMilliseconds);
      idle.unref();
    };
    Object.assign(output, {
      rows: 25, columns: 80,
      get writableLength() { return socket.writableLength; },
      write(value) { send({ output: String(value) }); return true; }
    });
    socket.setTimeout(handshakeMilliseconds, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', close);
    send({ challenge });
    const attach = ({ rows, columns }) => {
      if (active) { send({ notice: 'Another remote sysop console is attached.' }); close(); return; }
      active = socket;
      output.rows = dimension(rows, 25);
      output.columns = dimension(columns, 80);
      socket.setTimeout(0);
      touch();
      adapter = startSysopRemote({ store, bbs, input, output,
        onQuit: () => { send({ notice: 'BBS shutting down.' }); close(); onQuit(); },
        onDetach: () => { send({ notice: 'Detached; the BBS is still running.' }); close(); },
        onError: error => { onError(error); send({ notice: 'Internal BBS error.' }); close(); } });
    };
    const receive = message => {
      if (closed) return;
      if (!authenticated) {
        if (!message || typeof message.client !== 'string' || !/^[a-f0-9]{64}$/.test(message.client) ||
          !['console', 'probe'].includes(message.mode) ||
          !proofMatches(mcpProof(token, CLIENT_ROLE, challenge, message.client), message.proof)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        send({ ready: true, proof: mcpProof(token, SERVER_ROLE, challenge, message.client) });
        if (message.mode === 'probe') close();
        else attach(message);
        return;
      }
      const now = Date.now();
      tokens = Math.min(burst, tokens + (now - tokenTime) * refillPerSecond / 1000);
      tokenTime = now;
      if (--tokens < 0 || !message || typeof message !== 'object') { socket.destroy(); return; }
      if (typeof message.input === 'string') {
        if (message.input.length > CONSOLE_INPUT_LIMIT) { socket.destroy(); return; }
        touch();
        input.write(Buffer.from(message.input, 'utf8'));
      } else if (message.resize && typeof message.resize === 'object') {
        output.rows = dimension(message.resize.rows, output.rows);
        output.columns = dimension(message.resize.columns, output.columns);
        output.emit('resize');
      } else socket.destroy();
    };
    readJson(socket, receive, () => socket.destroy(), frameLimit);
  });
  try {
    try { await listen(server, endpoint); }
    catch (error) {
      if (error.code !== 'EADDRINUSE' || !await removeStaleSocket(endpoint)) throw error;
      await listen(server, endpoint);
    }
    if (process.platform !== 'win32') {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      chmodSync(endpoint, 0o600);
    }
    server.on('error', onError);
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    throw error;
  }
  return {
    endpoint,
    close() {
      stopping = true;
      for (const peer of peers) peer.destroy();
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

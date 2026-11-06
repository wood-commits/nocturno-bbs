import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, outputLimit } from './mcp-transport.js';
import { mcpProof, proofMatches } from './mcp-server.js';
import { validateConsoleOptions, CLIENT_ROLE, SERVER_ROLE } from './console-server.js';

const inputChunk = 1024;
const leave = '\x1b[0m\x1b[r\x1b[?7h\x1b[?25h\x1b[?1049l';

// Attach this terminal to a running BBS's remote sysop console. Resolves with an exit
// code; never sends the token itself and forwards no keys until the BBS proves it too.
export function connectConsole({ endpoint, token, input = process.stdin, output = process.stdout,
  errors = process.stderr, probe = false }) {
  validateConsoleOptions({ endpoint, token });
  return new Promise(resolve => {
    const socket = net.connect(endpoint);
    const client = randomBytes(32).toString('hex');
    const wasRaw = input.isRaw;
    let challenge, ready = false, done = false, attached = false, notice;
    const timer = setTimeout(() => finish(1, 'Timed out connecting to the sysop console.'), 5000);
    const forward = chunk => {
      const text = chunk.toString('utf8');
      // Ctrl+] always leaves locally, even if the BBS has stopped answering.
      if (text.includes('')) { finish(0, 'Disconnected locally.'); return; }
      for (let start = 0; start < text.length; start += inputChunk) {
        if (!socket.destroyed) writeJson(socket, { input: text.slice(start, start + inputChunk) });
      }
    };
    const resize = () => {
      if (!socket.destroyed) writeJson(socket, { resize: { rows: output.rows, columns: output.columns } });
    };
    const finish = (code, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', forward);
      output.removeListener?.('resize', resize);
      if (attached) {
        if (input.isTTY) input.setRawMode(Boolean(wasRaw));
        input.pause();
        output.write(leave);
      }
      socket.destroy();
      const text = message ?? notice;
      if (text && !probe) errors.write(`${text}\n`);
      resolve(code);
    };
    socket.on('error', () => finish(1, 'Could not reach the sysop console; check the endpoint and BBS startup.'));
    socket.once('close', () => finish(ready ? 0 : 1, ready ? undefined : 'Sysop console authentication failed.'));
    readJson(socket, message => {
      if (challenge === undefined) {
        if (!message || typeof message.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(message.challenge)) {
          throw new Error('bad challenge');
        }
        challenge = message.challenge;
        writeJson(socket, { client, proof: mcpProof(token, CLIENT_ROLE, challenge, client),
          mode: probe ? 'probe' : 'console', rows: output.rows, columns: output.columns });
      } else if (!ready) {
        if (!message || message.ready !== true ||
          !proofMatches(mcpProof(token, SERVER_ROLE, challenge, client), message.proof)) {
          throw new Error('bad proof');
        }
        ready = true;
        clearTimeout(timer);
        if (probe) return;
        attached = true;
        if (input.isTTY) input.setRawMode(true);
        input.on('data', forward);
        output.on?.('resize', resize);
        input.resume();
      } else if (typeof message?.output === 'string') output.write(message.output);
      else if (typeof message?.notice === 'string') notice = message.notice.slice(0, 160);
    }, () => finish(1, 'Sysop console authentication failed.'), outputLimit);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const probe = process.argv.includes('--probe');
  try {
    const endpoint = process.env.BBS_CONSOLE_SOCKET, token = process.env.BBS_CONSOLE_TOKEN;
    if (!probe && !(process.stdin.isTTY && process.stdout.isTTY)) {
      throw new Error('The sysop console needs an interactive terminal (use kubectl exec -it or ssh -t).');
    }
    validateConsoleOptions({ endpoint, token });
    if (!probe) process.stderr.write('Attaching to the sysop console. Ctrl+C detaches (Ctrl+] forces it); WFC Q shuts the BBS down.\n');
    process.exitCode = await connectConsole({ endpoint, token, probe });
    process.exit();
  } catch (error) {
    process.stderr.write(error.message?.startsWith('The sysop console needs')
      ? `${error.message}\n`
      : 'Nocturno console requires BBS_CONSOLE_SOCKET and a 64-hex-character BBS_CONSOLE_TOKEN.\n');
    process.exitCode = 1;
  }
}

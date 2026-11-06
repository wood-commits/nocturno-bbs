import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createBbs as startBbs } from '../src/server.js';
import { startConsoleServer, CLIENT_ROLE } from '../src/console-server.js';
import { connectConsole } from '../src/console.js';
import { mcpProof } from '../src/mcp-server.js';
import { readJson, writeJson } from '../src/mcp-transport.js';
import { config } from '../src/config.js';

const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));
const endpointName = () => process.platform === 'win32' ? `\\\\.\\pipe\\nocturno-console-${randomUUID()}`
  : join(tmpdir(), `nocturno-console-${randomUUID()}.sock`);

async function fixture(t, endpoint = endpointName()) {
  const token = randomBytes(32).toString('hex');
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await startBbs({ store, port: 0, ansiDirectory: samples, onError: error => errors.push(error) });
  let quits = 0;
  const server = await startConsoleServer({ endpoint, token, store, bbs,
    onError: error => errors.push(error), onQuit: () => { quits++; } });
  t.after(async () => { await server.close(); await bbs.close(); store.close(); });
  return { endpoint, token, store, bbs, errors, quits: () => quits };
}

function terminal(rows = 25) {
  const output = new EventEmitter();
  let text = '';
  Object.assign(output, { rows, columns: 80, write: value => { text += value; return true; } });
  const errors = { text: '', write(value) { this.text += value; } };
  return { input: new PassThrough(), output, errors, text: () => text, clear: () => { text = ''; } };
}

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

test('remote console attaches to WFC, accepts keys and Ctrl+C detaches without stopping the BBS', async t => {
  const f = await fixture(t);
  const term = terminal();
  const done = connectConsole({ endpoint: f.endpoint, token: f.token, ...term });
  await until(() => term.text().includes('Waiting for callers') || term.text().includes('\x1b[?1049h'), 'WFC frame');
  await until(() => /Command/.test(term.text()), 'WFC prompt');
  assert.match(term.text(), /to detach \(BBS keeps running\)/);
  assert.doesNotMatch(term.text(), /to shut down/);
  term.clear();
  term.input.write('U');
  await until(() => term.text().length > 0, 'user list frame');
  term.input.write('\x03');
  assert.equal(await done, 0);
  assert.match(term.errors.text, /Detached; the BBS is still running/);
  assert.ok(term.text().includes('\x1b[?1049l'), 'alternate screen restored');
  assert.equal(f.quits(), 0);
  assert.deepEqual(f.errors, []);
  // Detaching frees the single console slot.
  const probe = terminal();
  assert.equal(await connectConsole({ endpoint: f.endpoint, token: f.token, probe: true, ...probe }), 0);
});

test('remote console allows one attachment and WFC quit still needs YES', async t => {
  const f = await fixture(t);
  const first = terminal(24);
  const done = connectConsole({ endpoint: f.endpoint, token: f.token, ...first });
  await until(() => /Command/.test(first.text()), 'WFC prompt');
  const second = terminal();
  assert.equal(await connectConsole({ endpoint: f.endpoint, token: f.token, ...second }), 0);
  assert.match(second.errors.text, /Another remote sysop console is attached/);
  first.output.rows = 25;
  first.output.emit('resize');
  first.clear();
  first.input.write('Q');
  await until(() => /Shut down the BBS/.test(first.text()), 'shutdown confirmation');
  first.input.write('NO\r');
  await delay(50);
  assert.equal(f.quits(), 0);
  first.input.write('Q');
  await until(() => /Shut down the BBS/.test(first.text()), 'second confirmation');
  first.input.write('YES\r');
  assert.equal(await done, 0);
  assert.equal(f.quits(), 1);
  assert.match(first.errors.text, /BBS shutting down/);
});

test('remote console rejects wrong tokens, MCP-role proofs and malformed frames', async t => {
  const f = await fixture(t);
  const wrong = terminal();
  assert.equal(await connectConsole({ endpoint: f.endpoint, token: randomBytes(32).toString('hex'), ...wrong }), 1);
  assert.match(wrong.errors.text, /authentication failed/);
  assert.equal(wrong.text(), '');

  const handshake = async (proofRole, mode = 'console') => {
    const socket = net.connect(f.endpoint);
    const messages = [];
    readJson(socket, value => messages.push(value), () => {});
    await once(socket, 'connect');
    await until(() => messages.length, 'challenge');
    const nonce = randomBytes(32).toString('hex');
    writeJson(socket, { client: nonce, proof: mcpProof(f.token, proofRole, messages[0].challenge, nonce), mode });
    return { socket, messages };
  };
  for (const [role, mode] of [['client', 'console'], [CLIENT_ROLE, 'shell']]) {
    const { socket, messages } = await handshake(role, mode);
    await once(socket, 'close');
    assert.equal(messages.length, 1, 'no ready frame without a console-role proof');
  }
  const { socket, messages } = await handshake(CLIENT_ROLE);
  await until(() => messages.some(message => message.ready), 'ready');
  socket.write('{"input":"' + 'x'.repeat(40000) + '"}\n');
  await once(socket, 'close');
  const again = await handshake(CLIENT_ROLE);
  await until(() => again.messages.some(message => message.ready), 'slot released after malformed frame');
  writeJson(again.socket, { exec: 'rm -rf /' });
  await once(again.socket, 'close');
  assert.deepEqual(f.errors, []);
  assert.equal(f.quits(), 0);
});

test('console configuration requires a token and a local endpoint', () => {
  const token = randomBytes(32).toString('hex');
  const endpoint = endpointName();
  assert.deepEqual(config({ BBS_CONSOLE_SOCKET: endpoint, BBS_CONSOLE_TOKEN: token }).remoteConsole,
    { endpoint, token });
  assert.equal(config({}).remoteConsole, undefined);
  assert.throws(() => config({ BBS_CONSOLE_SOCKET: endpoint }), /BBS_CONSOLE_TOKEN/);
  assert.throws(() => config({ BBS_CONSOLE_SOCKET: '127.0.0.1:9000', BBS_CONSOLE_TOKEN: token }), /local IPC endpoint/);
});

test('a stale console socket left by a killed process is replaced; a live one is not', { skip: process.platform === 'win32' }, async t => {
  const endpoint = endpointName();
  const child = spawn(process.execPath, ['-e',
    `require('net').createServer().listen(${JSON.stringify(endpoint)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  await once(child, 'exit');
  // The endpoint is a generated temporary path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.ok(existsSync(endpoint), 'killed listener left its socket file');
  const f = await fixture(t, endpoint);
  const probe = terminal();
  assert.equal(await connectConsole({ endpoint: f.endpoint, token: f.token, probe: true, ...probe }), 0);

  const store = new Store(':memory:');
  const bbs = await startBbs({ store, port: 0, ansiDirectory: samples, onError: () => {} });
  t.after(async () => { await bbs.close(); store.close(); });
  await assert.rejects(startConsoleServer({ endpoint, token: f.token, store, bbs, onError: () => {}, onQuit: () => {} }),
    { code: 'EADDRINUSE' });
});

test('console CLI probe succeeds with the right token and refuses non-interactive attachment', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../src/console.js', import.meta.url));
  const run = async (args, token) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, BBS_CONSOLE_SOCKET: f.endpoint, BBS_CONSOLE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    return { code, stderr };
  };
  assert.equal((await run(['--probe'], f.token)).code, 0);
  assert.equal((await run(['--probe'], randomBytes(32).toString('hex'))).code, 1);
  const interactive = await run([], f.token);
  assert.equal(interactive.code, 1);
  assert.match(interactive.stderr, /interactive terminal/);
  assert.ok(!interactive.stderr.includes(f.token), 'token never printed');
});

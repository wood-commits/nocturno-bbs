import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../src/mcp-transport.js';
import { Store } from '../src/store.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const noMcp = { BBS_MCP_ENDPOINT: undefined, BBS_MCP_TOKEN: undefined, BBS_MCP_SYSOP: undefined };

test('clean checkout creates its default database, loads samples and serves telnet and opt-in local MCP', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-entry-'));
  let child, socket, ipc;
  t.after(async () => {
    for (const connection of [socket, ipc]) {
      if (connection && !connection.closed) {
        const closed = once(connection, 'close');
        connection.destroy();
        await closed;
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  // Copy only publishable files, never the operator's artwork or database.
  for (const name of ['src', 'examples', 'package.json']) {
    cpSync(new URL(`../${name}`, import.meta.url), join(directory, name), { recursive: true });
  }
  // These paths belong to the isolated temporary checkout.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(existsSync(join(directory, 'ansi')), false);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.equal(existsSync(join(directory, 'data')), false);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\nocturno-entry-${randomUUID()}`
    : join(directory, 'mcp.sock');
  const token = randomBytes(32).toString('hex');
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, [join(directory, 'src', 'index.js')], {
    cwd: directory,
    env: { ...process.env, BBS_NAME: undefined, BBS_PORT: String(port), BBS_DATA_DIR: undefined,
      BBS_DASHBOARD: '0', BBS_TLS_CERT: '', BBS_TLS_KEY: '',
      BBS_MCP_ENDPOINT: endpoint, BBS_MCP_TOKEN: token, BBS_MCP_SYSOP: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const deadline = Date.now() + 5000;
  while (!output.includes('Waiting for callers:')) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`Startup failed: ${errors}`);
    await delay(10);
  }
  socket = net.connect({ host: '127.0.0.1', port });
  let welcome = '';
  socket.on('data', data => { welcome += data.toString('latin1'); });
  await once(socket, 'connect');
  while (!welcome.includes('Selection:')) {
    if (Date.now() > deadline) assert.fail('No welcome screen');
    await delay(10);
  }
  assert.ok(output.includes(`127.0.0.1:${port}`));
  assert.ok(output.includes('Nocturno BBS'));
  assert.ok(welcome.includes('NOCTURNO sample login matrix'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  assert.ok(existsSync(join(directory, 'data', 'bbs.sqlite')));
  assert.ok(welcome.includes('LOCAL TELNET'));
  assert.ok(!errors.includes('[BBS error:'));
  ipc = net.connect(endpoint);
  const messages = [];
  readJson(ipc, value => messages.push(value), error => assert.fail(error.message));
  await once(ipc, 'connect');
  writeJson(ipc, { token });
  while (!messages.length) {
    assert.ok(Date.now() < deadline, 'MCP startup timed out');
    await delay(5);
  }
  assert.deepEqual(messages.shift(), { ready: true });
  writeJson(ipc, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  while (!messages.length) {
    assert.ok(Date.now() < deadline, 'MCP initialization timed out');
    await delay(5);
  }
  assert.equal(messages[0].result.serverInfo.name, 'nocturno-bbs');
  for (const connection of [socket, ipc]) {
    const closed = once(connection, 'close');
    connection.destroy();
    await closed;
  }
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  const store = new Store(join(directory, 'data', 'bbs.sqlite'));
  try {
    assert.equal(store.settings().name, 'Nocturno BBS');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  } finally {
    store.close();
  }
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { Presentation } from './src/presentation.js';
    mkdirSync('ansi');
    assert.equal(new Presentation().templates.size, 0);
    writeFileSync('ansi/loginmatrix.ans', 'LOCAL FIXTURE');
    const local = new Presentation();
    assert.equal(local.templates.size, 1);
    assert.ok(local.render('loginmatrix', '').includes('LOCAL FIXTURE'));
    assert.equal(local.render('welcome', 'BUILTIN'), 'BUILTIN');
  `], { cwd: directory });
});

test('executable rejects invalid operator configuration without opening a listener', async () => {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...noMcp, BBS_PORT: 'invalid' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.ok(errors.includes('[BBS error: Error]'));
});

test('interactive Ctrl+C restores the console and exits without closing stdin externally', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nocturno-tty-entry-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  // Model TTY capabilities on a real child stdin pipe to exercise read-handle shutdown.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { pathToFileURL } from 'node:url';
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdin.setRawMode = value => {
      process.stdin.isRaw = value;
      process.stdout.write(value ? '[RAW:1]' : '[RAW:0]');
    };
    await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write('[READY]');
  `, entry], {
    env: { ...process.env, ...noMcp, BBS_PORT: String(port), BBS_DATA_DIR: directory,
      BBS_DASHBOARD: '1', BBS_TLS_CERT: '', BBS_TLS_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (!output.includes('[READY]')) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`TTY startup failed: ${errors}`);
    await delay(10);
  }
  assert.ok(output.includes('[RAW:1]'));
  assert.ok(output.includes('\x1b[?1049h'));
  child.stdin.write('\x03');
  const [code, signal] = await closed;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(output.includes('[RAW:0]\x1b[0m'));
  assert.ok(output.includes('\x1b[?1049l'));
  assert.ok(output.indexOf('\x1b[?1049l') < output.indexOf('NO CARRIER.'));
  assert.ok(!errors.includes('[BBS error:'));
});

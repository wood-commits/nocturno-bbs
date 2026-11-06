import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createBbs as startBbs } from '../src/server.js';
import { startMcpServer, mcpProof } from '../src/mcp-server.js';
import { connectMcp } from '../src/mcp.js';
import { readJson, writeJson, outputLimit } from '../src/mcp-transport.js';
import { McpTerminal } from '../src/mcp-terminal.js';
import { config } from '../src/config.js';
import { ZTransfer } from '../src/transfer-zmodem.js';
import { unzip } from '../src/transfer-qwk.js';

// Never load the operator's private, Git-ignored ansi/ directory: its artwork
// can be large and is paced at 28.8k, making results machine-dependent.
const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));
const createBbs = options => startBbs({ ansiDirectory: samples, ...options });

const password = 'unique MCP test password';

async function fixture(t, sysop = true) {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\nocturno-test-${randomUUID()}`
    : join(tmpdir(), `nocturno-${randomUUID()}.sock`);
  const token = randomBytes(32).toString('hex');
  const store = new Store(':memory:');
  const errors = [];
  const bbs = await createBbs({ store, port: 0, onError: error => errors.push(error) });
  let quits = 0;
  const mcp = await startMcpServer({ endpoint, token, sysop, store, bbs,
    onError: error => errors.push(error), onQuit: () => { quits++; } });
  t.after(async () => { await mcp.close(); await bbs.close(); store.close(); });
  return { endpoint, token, store, bbs, errors, quits: () => quits };
}

async function client(t, f) {
  const socket = net.connect(f.endpoint);
  const messages = [];
  readJson(socket, value => messages.push(value), error => assert.fail(error.message), 1048576);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const take = async predicate => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      assert.ok(Date.now() < deadline, 'Timed out waiting for MCP response');
      await delay(5);
    }
  };
  const { challenge } = await take(value => value.challenge);
  const nonce = randomBytes(32).toString('hex');
  writeJson(socket, { client: nonce, proof: mcpProof(f.token, 'client', challenge, nonce) });
  const ready = await take(value => value.ready);
  assert.deepEqual(ready, { ready: true, proof: mcpProof(f.token, 'server', challenge, nonce) });
  let nextId = 0;
  const rpc = async (method, params) => {
    const id = ++nextId;
    writeJson(socket, { jsonrpc: '2.0', id, method, params });
    return take(value => value.id === id);
  };
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  writeJson(socket, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const tool = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.ok(!response.error, JSON.stringify(response));
    if (response.result.isError) return response.result;
    return JSON.parse(response.result.content[0].text);
  };
  return { socket, rpc, tool, send: (sessionId, text) => tool('bbs_send', { sessionId, text, waitMs: 50 }) };
}

test('MCP configuration is disabled by default and rejects nonlocal/incomplete credentials', () => {
  assert.equal(config({}).mcp, undefined);
  for (const env of [{ BBS_MCP_SYSOP: '1' }, { BBS_MCP_ENDPOINT: '127.0.0.1:8000', BBS_MCP_TOKEN: 'a'.repeat(64) },
    { BBS_MCP_ENDPOINT: '\\\\.\\pipe\\nocturno', BBS_MCP_TOKEN: 'short' },
    { BBS_MCP_SYSOP: 'true' }]) assert.throws(() => config(env), /MCP/);
});

test('JSON framing handles fragmentation, multiple messages, malformed/oversized/truncated input', async () => {
  const stream = new PassThrough();
  const values = [], errors = [];
  readJson(stream, value => values.push(value), error => errors.push(error), 32);
  stream.write('{"x":');
  stream.write('1}\n{"x":2}\n');
  assert.deepEqual(values, [{ x: 1 }, { x: 2 }]);
  stream.write('x'.repeat(33));
  assert.equal(errors.length, 1);
  stream.destroy();
  assert.throws(() => writeJson({ writableLength: outputLimit, write: () => assert.fail('Over-limit write') },
    { jsonrpc: '2.0' }), /output limit/);
  for (const input of ['{broken}\n', '{"x":']) {
    const source = new PassThrough();
    const failures = [];
    readJson(source, () => assert.fail('Unexpected frame'), error => failures.push(error));
    const ended = once(source, 'end');
    source.end(input);
    await ended;
    assert.equal(failures.length, 1);
  }
});

test('IPC rejects invalid authentication and implements MCP lifecycle, discovery and validation', async t => {
  const f = await fixture(t, false);
  const rejected = net.connect(f.endpoint);
  // Drain the server's challenge; unread data would otherwise delay 'end'/'close' forever.
  rejected.resume();
  await once(rejected, 'connect');
  // The raw token is no longer an accepted credential, and a wrong proof is refused.
  writeJson(rejected, { token: f.token });
  await once(rejected, 'close');
  const forged = net.connect(f.endpoint);
  const challenges = [];
  readJson(forged, value => challenges.push(value), () => {});
  await once(forged, 'connect');
  while (!challenges.length) await delay(5);
  assert.ok(!JSON.stringify(challenges).includes(f.token));
  const nonce = randomBytes(32).toString('hex');
  writeJson(forged, { client: nonce, proof: mcpProof('0'.repeat(64), 'client', challenges[0].challenge, nonce) });
  await once(forged, 'close');
  assert.equal(challenges.length, 1);
  const c = await client(t, f);
  const listed = await c.rpc('tools/list');
  assert.equal(listed.result.tools.length, 4);
  assert.deepEqual(listed.result.tools[0].inputSchema.properties.role.enum, ['user']);
  assert.equal((await c.tool('bbs_open', { role: 'sysop' })).isError, true);
  assert.equal((await c.tool('bbs_send', { sessionId: 'missing', text: 'L' })).isError, true);
  assert.equal((await c.rpc('not-a-method')).error.code, -32601);
  assert.equal((await c.rpc('tools/call', null)).error.code, -32602);
  assert.deepEqual((await c.rpc('ping')).result, {});
  assert.deepEqual(f.errors, []);
});

test('MCP sysop menus preserve confirmations, persisted settings, role management and client isolation', async t => {
  const f = await fixture(t);
  const c = await client(t, f);
  const other = await client(t, f);
  const opened = await c.tool('bbs_open', { role: 'sysop' });
  const id = opened.sessionId;
  assert.match(opened.text, /Nocturno BBS/);
  assert.equal((await other.tool('bbs_read', { sessionId: id })).isError, true);
  assert.equal((await other.tool('bbs_open', { role: 'sysop' })).isError, true);
  await c.send(id, 'S');
  await c.send(id, 'A');
  await c.send(id, 'MCP TEST BBS\r');
  assert.equal(f.store.settings().name, 'MCP TEST BBS');
  const confirm = await c.send(id, 'E');
  assert.match(confirm.text, /YES/);
  assert.equal(f.store.settings().registration, 1);
  await c.send(id, 'NO\r');
  assert.equal(f.store.settings().registration, 1);
  await c.send(id, 'E');
  await c.send(id, 'YES\r');
  assert.equal(f.store.settings().registration, 0);
  await c.send(id, 'R');
  await c.send(id, 'C MCP role\r');
  await c.send(id, 'YES\r');
  assert.ok(f.store.access.roles(0).some(role => role.name === 'MCP role'));
  await c.tool('bbs_close', { sessionId: id });
  assert.equal((await other.tool('bbs_open', { role: 'sysop' })).role, 'sysop');
  assert.equal(f.quits(), 0);
  assert.deepEqual(f.errors, []);
});

test('MCP callers authenticate normally, hide passwords, play doors and enforce live permissions', async t => {
  const f = await fixture(t);
  const user = await f.bbs.auth.register('McpCaller', password, 'seed');
  const c = await client(t, f);
  const opened = await c.tool('bbs_open', { role: 'user' });
  const id = opened.sessionId;
  assert.equal(opened.state, 'welcome');
  const session = [...f.bbs.sessions.values()][0];
  assert.equal(session.local, false, 'Agent caller retains binary-transfer capability');
  assert.equal(session.user, undefined);
  await c.send(id, 'L');
  await c.send(id, 'McpCaller\r');
  let output = await c.send(id, password + '\r');
  for (let tries = 0; !output.text.includes('Press any key') && tries < 150; tries++) {
    assert.ok(!JSON.stringify(output).includes(password));
    output = await c.tool('bbs_read', { sessionId: id, waitMs: 100 });
  }
  assert.equal(output.state, 'post-welcome');
  assert.ok(output.text.includes('Press any key'));
  assert.ok(!output.text.includes(password));
  assert.ok(!Buffer.from(output.base64, 'base64').toString('latin1').includes(password));
  await c.send(id, ' ');
  assert.equal((await c.send(id, 'D')).state, 'doors');
  assert.equal((await c.send(id, '1')).state, 'realm');
  await c.send(id, 'E');
  assert.equal(f.store.db.prepare('SELECT land FROM frontier_realms WHERE user_id = ?').get(user.id).land, 105);
  f.store.editUser(user.id, 'can_doors', 0);
  assert.match((await c.send(id, 'E')).text, /permission/i);
  assert.equal(f.store.db.prepare('SELECT land FROM frontier_realms WHERE user_id = ?').get(user.id).land, 105);
  await c.send(id, 'Q');
  await c.send(id, 'Q');
  await c.send(id, 'M');
  await c.send(id, 'W');
  await c.send(id, 'MCP post subject\r');
  await c.send(id, 'MCP post body\r');
  await c.send(id, '.\r');
  assert.equal(f.store.messages()[0].subject, 'MCP post subject');
  assert.equal(f.store.messages()[0].handle, 'McpCaller');
  await c.send(id, 'Q');
  await c.send(id, 'K');
  let downloaded;
  const outbound = [];
  const peer = new ZTransfer({
    direction: 'receive', maxSize: 4 * 1024 * 1024,
    write: bytes => {
      const escaped = [];
      for (const byte of bytes) { escaped.push(byte); if (byte === 255) escaped.push(byte); }
      outbound.push(Buffer.from(escaped));
    },
    complete: result => { downloaded = result; }
  });
  output = await c.send(id, 'D');
  let telnetState = 'data';
  for (let tries = 0; !downloaded && tries < 100; tries++) {
    for (const byte of Buffer.from(output.base64, 'base64')) {
      if (telnetState === 'option') { telnetState = 'data'; continue; }
      if (telnetState === 'iac') {
        telnetState = 'data';
        if ([251, 252, 253, 254].includes(byte)) { telnetState = 'option'; continue; }
        if (byte !== 255) continue;
      } else if (byte === 255) { telnetState = 'iac'; continue; }
      if (!downloaded) peer.feed(Buffer.from([byte]));
    }
    if (outbound.length) {
      const data = Buffer.concat(outbound.splice(0));
      output = await c.tool('bbs_send', { sessionId: id, base64: data.toString('base64'), waitMs: 20 });
    } else if (!downloaded) output = await c.tool('bbs_read', { sessionId: id, waitMs: 20 });
  }
  assert.equal(downloaded?.name, 'NOCTURNO.QWK');
  assert.ok(unzip(downloaded.data).get('MESSAGES.DAT').includes(Buffer.from('MCP post body')));
  f.bbs.setUserDisabled(user.id, true);
  await delay(20);
  assert.equal((await c.tool('bbs_read', { sessionId: id, waitMs: 0 })).closed, true);
  assert.equal(f.bbs.sessions.size, 0);
  assert.deepEqual(f.errors, []);
});

test('MCP send validates bytes and limits sessions; disconnect cleans up caller sessions', async t => {
  const f = await fixture(t);
  const c = await client(t, f);
  const { sessionId } = await c.tool('bbs_open', { role: 'user' });
  for (const args of [{ text: 'x', base64: 'eA==' }, { base64: '@@' }, { text: '\u00ff' },
    { text: 'a'.repeat(8193) }, { text: 'L', waitMs: -1 }, { text: 'L', surprise: true }]) {
    assert.equal((await c.tool('bbs_send', { sessionId, ...args })).isError, true);
  }
  assert.equal((await c.tool('bbs_send', { sessionId, base64: 'TA==', waitMs: 50 })).state, 'login-handle');
  for (let index = 0; index < 3; index++) await c.tool('bbs_open', { role: 'user' });
  assert.equal((await c.tool('bbs_open', { role: 'user' })).isError, true);
  c.socket.destroy();
  for (let index = 0; f.bbs.sessions.size && index < 100; index++) await delay(10);
  assert.equal(f.bbs.sessions.size, 0);
  assert.deepEqual(f.errors, []);
});

test('MCP terminal bounds unread output and preserves binary transport bytes', async t => {
  const f = await fixture(t);
  const terminal = new McpTerminal({ role: 'user', ...f, onError: error => f.errors.push(error), onQuit: () => {} });
  t.after(() => terminal.close());
  await terminal.exchange(undefined, 0);
  terminal.session.transferRaw = true;
  terminal.capture(Buffer.from([0, 255, 255, 13, 0, 128]));
  const result = await terminal.exchange(undefined, 0);
  assert.equal(result.base64, Buffer.from([0, 255, 255, 13, 0, 128]).toString('base64'));
  assert.equal(result.text, '');
  terminal.session.transferRaw = false;
  terminal.capture(Buffer.from('\x1b]0;binary-not-display\x07'));
  assert.equal((await terminal.exchange(undefined, 0)).ansi, '',
    'Binary bytes never become display output even after a transfer completes');
  terminal.capture(Buffer.alloc(131073));
  assert.equal(terminal.closed, true);
  assert.match(terminal.reason, /128 KiB/);
});

test('MCP sysop terminal idle timeout closes it without quitting the BBS', async t => {
  const f = await fixture(t);
  const terminal = new McpTerminal({ role: 'sysop', ...f,
    onError: error => f.errors.push(error), onQuit: () => assert.fail('Timeout must not shut down BBS') });
  t.after(() => terminal.close());
  terminal.idleMilliseconds = 20;
  terminal.touch();
  await terminal.exchange(undefined, 0);
  await delay(40);
  assert.equal(terminal.closed, true);
  assert.match(terminal.reason, /Idle timeout/);
  assert.equal(terminal.adapter.controller.stopped, true);
});

test('MCP bridge never discloses its token to an endpoint impostor', async t => {
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\nocturno-squat-${randomUUID()}` : join(tmpdir(), `nocturno-squat-${randomUUID()}.sock`);
  const token = randomBytes(32).toString('hex');
  const received = [];
  const impostor = net.createServer(socket => {
    readJson(socket, value => received.push(value), () => {});
    writeJson(socket, { challenge: randomBytes(32).toString('hex') });
    socket.once('data', () => writeJson(socket, { ready: true, proof: '0'.repeat(64) }));
  });
  await new Promise(resolve => impostor.listen(endpoint, resolve));
  t.after(() => new Promise(resolve => impostor.close(resolve)));
  const input = new PassThrough(), output = new PassThrough();
  const forwarded = [];
  output.on('data', data => forwarded.push(data));
  const failed = new Promise(resolve => connectMcp({ endpoint, token, input, output, onError: resolve }));
  assert.match((await failed).message, /authentication failed/);
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await delay(20);
  assert.equal(received.length, 1);
  assert.ok(!JSON.stringify(received).includes(token));
  assert.deepEqual(Object.keys(received[0]).sort(), ['client', 'proof']);
  assert.equal(forwarded.length, 0);
});

test('stdio MCP executable connects to running BBS and emits only protocol JSON', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], {
    env: { ...process.env, BBS_MCP_ENDPOINT: f.endpoint, BBS_MCP_TOKEN: f.token },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) { child.kill(); await closed; } });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const responses = [];
  readJson(child.stdout, value => responses.push(value), error => assert.fail(error.message));
  writeJson(child.stdin, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' }
  } });
  for (let index = 0; !responses.length && index < 200; index++) await delay(10);
  assert.equal(responses[0]?.result.serverInfo.name, 'nocturno-bbs', stderr);
  child.stdin.end();
  assert.equal((await closed)[0], 0);
  assert.ok(!stderr.includes('failed'));
});

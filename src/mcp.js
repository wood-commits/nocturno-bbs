import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, outputLimit } from './mcp-transport.js';
import { validateMcpOptions } from './mcp-server.js';

export function connectMcp({ endpoint, token, input = process.stdin, output = process.stdout, onError }) {
  validateMcpOptions({ endpoint, token });
  const socket = net.connect(endpoint);
  let ready = false, stopped = false, detachInput;
  const timer = setTimeout(() => fail(new Error('MCP connection timed out.')), 5000);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    detachInput?.();
    input.pause();
    input.removeListener('end', stop);
    input.removeListener('error', fail);
    output.removeListener('error', fail);
    socket.destroy();
  };
  const fail = error => { if (!stopped) { stop(); onError(error); } };
  socket.once('connect', () => {
    try { writeJson(socket, { token }); } catch (error) { fail(error); }
  });
  socket.on('error', fail);
  socket.once('close', () => {
    if (!stopped) fail(new Error('MCP bridge disconnected.'));
  });
  readJson(socket, message => {
    if (!ready) {
      if (!message || message.ready !== true) throw new Error('MCP authentication failed.');
      ready = true;
      clearTimeout(timer);
      detachInput = readJson(input, value => writeJson(socket, value), fail);
      input.once('end', stop);
      input.on('error', fail);
      input.resume();
    } else writeJson(output, message);
  }, fail, outputLimit);
  output.on('error', fail);
  return { stop, socket };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bridge = connectMcp({
      endpoint: process.env.BBS_MCP_ENDPOINT,
      token: process.env.BBS_MCP_TOKEN,
      onError: () => { process.stderr.write('Nocturno MCP bridge failed; check local endpoint/token and BBS startup.\n'); process.exitCode = 1; }
    });
    process.once('SIGINT', bridge.stop);
    process.once('SIGTERM', bridge.stop);
  } catch {
    process.stderr.write('Nocturno MCP requires BBS_MCP_ENDPOINT and a 64-hex-character BBS_MCP_TOKEN.\n');
    process.exitCode = 1;
  }
}

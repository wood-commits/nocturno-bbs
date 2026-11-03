import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { text } from './validation.js';
import { validateMcpOptions } from './mcp-server.js';

function port(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Port must be 1-65535.');
  return number;
}

export function config(env = process.env) {
  if (Boolean(env.BBS_TLS_CERT) !== Boolean(env.BBS_TLS_KEY)) {
    throw new Error('Set both BBS_TLS_CERT and BBS_TLS_KEY to enable TLS.');
  }
  const mcpEnabled = env.BBS_MCP_ENDPOINT !== undefined || env.BBS_MCP_TOKEN !== undefined ||
    env.BBS_MCP_SYSOP !== undefined;
  let mcp;
  if (mcpEnabled) {
    if (env.BBS_MCP_SYSOP !== undefined && !['0', '1'].includes(env.BBS_MCP_SYSOP)) {
      throw new Error('BBS_MCP_SYSOP must be 0 or 1.');
    }
    mcp = { endpoint: env.BBS_MCP_ENDPOINT, token: env.BBS_MCP_TOKEN, sysop: env.BBS_MCP_SYSOP === '1' };
    validateMcpOptions(mcp);
  }
  return {
    name: text(env.BBS_NAME ?? 'Nocturno BBS', 40, 'BBS name'),
    filename: resolve(env.BBS_DATA_DIR ?? 'data', 'bbs.sqlite'),
    transferDirectory: resolve(env.BBS_DATA_DIR ?? 'data', 'files'),
    port: port(env.BBS_PORT, 2323),
    tlsPort: port(env.BBS_TLS_PORT, 9923),
    tlsHost: env.BBS_TLS_HOST ?? '127.0.0.1',
    tlsOptions: env.BBS_TLS_CERT ? {
      // Certificate paths are operator configuration, never caller input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      cert: readFileSync(env.BBS_TLS_CERT),
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      key: readFileSync(env.BBS_TLS_KEY)
    } : undefined,
    dashboard: env.BBS_DASHBOARD !== '0',
    mcp
  };
}

import { Store } from './store.js';
import { createBbs } from './server.js';
import { config } from './config.js';
import { ansi } from './screens.js';
import { startSysopConsole } from './sysop.js';
import { startMcpServer } from './mcp-server.js';
import { reportError as report, reportStartupError } from './errors.js';

let store;
let bbs;
let sysop;
let mcp;
let shuttingDown = false;
let startupStage = 'configuration';
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (sysop) sysop.stop(); }
  catch (error) {
    report(error);
    process.exitCode = 1;
  }
  try {
    if (mcp) await mcp.close();
  } catch (error) {
    report(error);
    process.exitCode = 1;
  }
  try {
    if (bbs) await bbs.close();
    if (store) store.close();
  } catch (error) {
    report(error);
    process.exitCode = 1;
  }
  process.stdout.write(`${ansi.reset}\r\nNO CARRIER.\r\n`);
}

try {
  const options = config();
  startupStage = 'database';
  store = new Store(options.filename);
  startupStage = 'services';
  bbs = await createBbs({ ...options, store, onError: report });
  if (options.mcp) {
    startupStage = 'mcp';
    mcp = await startMcpServer({ ...options.mcp, store, bbs,
      onQuit: () => { void shutdown(); }, onError: report });
  }
  if (process.stdin.isTTY && process.stdout.isTTY && options.dashboard) {
    startupStage = 'console';
    sysop = startSysopConsole({ store, bbs, onQuit: () => { void shutdown(); }, onError: report });
  } else console.log(`${store.settings().name}\nWaiting for callers:\n${bbs.endpoints.join('\n')}`);
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
} catch (error) {
  reportStartupError(error, startupStage);
  await shutdown();
  process.exitCode = 1;
}

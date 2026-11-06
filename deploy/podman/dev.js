// Local test container: the hardened BBS image with its TLS listener and the remote
// sysop console, run the way deploy/k8s runs it. `podman exec -it` reaches the console
// exactly as `kubectl exec -it` does in a cluster. Development only; loopback only.
//
//   node deploy/podman/dev.js up       build the image, create credentials, start
//   node deploy/podman/dev.js status   show the container and connection commands
//   node deploy/podman/dev.js down     remove the container and podman secrets
//   node deploy/podman/dev.js purge    also delete the data volume and .dev credentials
//
// Credentials live in the Git-ignored .dev/ directory and are generated once.
/* eslint-disable security/detect-non-literal-fs-filename */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dev = join(root, '.dev');
const name = 'nocturno-dev';
const image = 'localhost/nocturno-bbs:dev';
const volume = 'nocturno-dev-data';
const tlsPort = 9923;
const secrets = { tlsCert: 'nocturno-dev-tls-crt', tlsKey: 'nocturno-dev-tls-key', token: 'nocturno-dev-console-token' };
const file = { tlsCert: join(dev, 'tls.crt'), tlsKey: join(dev, 'tls.key'), token: join(dev, 'console.token') };

function podman(args, { inherit = false } = {}) {
  return execFileSync('podman', args, { cwd: root, encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
}

function quietly(args) {
  try { podman(args); } catch { /* already absent */ }
}

function credentials() {
  mkdirSync(dev, { recursive: true });
  // Exclusive create: keep an existing token without a separate existence check.
  try { writeFileSync(file.token, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!existsSync(file.tlsCert) || !existsSync(file.tlsKey)) {
    const args = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-days', '365', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', file.tlsKey, '-out', file.tlsCert];
    try { execFileSync(openssl(), args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (error) {
      throw new Error(`Could not create the development TLS certificate: ${error.stderr?.toString().trim() || error.message}`, { cause: error });
    }
  }
}

// PATH first, then the copies Git for Windows ships but does not put on PowerShell's PATH.
function openssl() {
  const candidates = ['openssl'];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (!base) continue;
      for (const bin of ['usr\\bin', 'mingw64\\bin', 'ucrt64\\bin']) candidates.push(join(base, 'Git', bin, 'openssl.exe'));
    }
  }
  for (const candidate of candidates) {
    try { execFileSync(candidate, ['version'], { stdio: 'ignore' }); return candidate; }
    catch { /* try the next one */ }
  }
  throw new Error('openssl was not found. Install Git for Windows or OpenSSL, then rerun.');
}

async function waitForConsole() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { podman(['exec', name, 'node', 'src/console.js', '--probe']); return; }
    catch { await delay(500); }
  }
  throw new Error(`The BBS did not become ready; check: podman logs ${name}`);
}

function instructions() {
  const cert = relative(process.cwd(), file.tlsCert) || file.tlsCert;
  console.log(`
Nocturno development container is running (loopback only).

  BBS over TLS:   localhost:${tlsPort}  (self-signed; trust ${cert})
  Sysop console:  podman exec -it ${name} node src/console.js
                  Ctrl+C detaches; WFC Q + YES stops the container.
  Logs:           podman logs -f ${name}
  Stop:           npm run dev:down
`);
}

async function up() {
  podman(['build', '-t', image, '.'], { inherit: true });
  credentials();
  for (const [key, secret] of Object.entries(secrets)) podman(['secret', 'create', '--replace', secret, file[key]]);
  quietly(['rm', '-f', name]);
  // Same hardening and layout as deploy/k8s/deployment.yaml.
  podman(['run', '-d', '--name', name, '-p', `127.0.0.1:${tlsPort}:9923`,
    '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
    '-v', `${volume}:/data:U`, '--tmpfs', '/run/nocturno:rw,mode=0700,U',
    '--secret', `${secrets.tlsCert},target=/tls/tls.crt,uid=1000,gid=1000,mode=0400`,
    '--secret', `${secrets.tlsKey},target=/tls/tls.key,uid=1000,gid=1000,mode=0400`,
    '--secret', `${secrets.token},type=env,target=BBS_CONSOLE_TOKEN`,
    '-e', 'BBS_TLS_CERT=/tls/tls.crt', '-e', 'BBS_TLS_KEY=/tls/tls.key',
    '-e', 'BBS_CONSOLE_SOCKET=/run/nocturno/console.sock', image]);
  await waitForConsole();
  instructions();
}

function down({ purge = false } = {}) {
  quietly(['rm', '-f', name]);
  for (const secret of Object.values(secrets)) quietly(['secret', 'rm', secret]);
  if (purge) {
    quietly(['volume', 'rm', volume]);
    rmSync(dev, { recursive: true, force: true });
  }
  console.log(purge ? 'Removed the container, secrets, data volume and .dev credentials.'
    : 'Removed the container and secrets; the data volume is kept.');
}

function status() {
  const state = podman(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Status}}']).trim();
  console.log(state ? `${name}: ${state}` : 'The development container is not running.');
  if (state.startsWith('Up')) instructions();
}

const command = process.argv[2];
try {
  if (command === 'up') await up();
  else if (command === 'down') down();
  else if (command === 'purge') down({ purge: true });
  else if (command === 'status') status();
  else {
    console.error('Usage: node deploy/podman/dev.js up|status|down|purge');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}

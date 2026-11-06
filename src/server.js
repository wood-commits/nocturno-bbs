import net from 'node:net';
import tls from 'node:tls';
import { Auth, AttemptLimiter, addressKey } from './auth.js';
import { Session } from './session.js';
import { InputError } from './validation.js';
import { Presentation } from './presentation.js';
import { Community } from './community.js';
import { Transfers } from './transfers.js';
import { LocalSocket } from './local-terminal.js';
import { reportError } from './errors.js';

export async function createBbs({ store, name = 'Nocturno BBS', port = 2323,
  tlsOptions, tlsPort = 9923, tlsHost = '127.0.0.1', onError = reportError, ansiDirectory, transferDirectory }) {
  store.initSettings(name);
  const presentation = new Presentation(ansiDirectory);
  const community = new Community(store);
  const transfers = new Transfers({ store, directory: transferDirectory });
  const auth = new Auth(store);
  await auth.init();
  const sessions = new Map();
  const pending = new Set();
  const servers = [];
  const endpoints = [];
  const connections = new AttemptLimiter({ limit: 30, windowMs: 60000 });
  let nextId = 1;
  let stopping = false;
  let closing;
  const accept = (socket, secure, local = false) => {
    if (stopping || sessions.size >= 32) return socket.destroy();
    const id = nextId++;
    const session = new Session({ socket, store, auth, id, name, secure, onError, presentation, community, transfers, local });
    sessions.set(id, session);
    socket.once('close', () => sessions.delete(id));
    return session;
  };
  const track = socket => {
    const key = addressKey(socket.remoteAddress);
    const sameAddress = [...pending].filter(peer => addressKey(peer.remoteAddress) === key).length;
    if (stopping || pending.size >= 32 || sameAddress >= 3 || !connections.take(key)) {
      socket.destroy();
      return;
    }
    pending.add(socket);
    socket.once('close', () => pending.delete(socket));
  };
  const listen = async (server, host, listenPort, label) => {
    servers.push(server);
    server.maxConnections = 32;
    server.on('connection', track);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, host, () => {
        server.removeListener('error', reject);
        server.on('error', onError);
        resolve();
      });
    });
    endpoints.push(`${label} ${host}:${server.address().port}`);
  };
  const shutdown = async () => {
    stopping = true;
    // TLS wraps the tracked TCP socket; its close event can arrive later.
    const sockets = new Set([...pending, ...[...sessions.values()].map(session => session.socket)]);
    const closed = [...sockets].filter(socket => !socket.closed).map(socket =>
      new Promise(resolve => socket.once('close', resolve)));
    for (const session of sessions.values()) session.disconnect('BBS shutting down.');
    for (const socket of pending) socket.destroy();
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve());
    })));
    await Promise.all(closed);
    // Let in-flight scrypt complete before the owning process closes SQLite.
    while (auth.active) await new Promise(resolve => setTimeout(resolve, 10));
  };
  const close = () => {
    closing ??= shutdown();
    return closing;
  };
  try {
    // Never allow plaintext credentials to be exposed on a public interface.
    await listen(net.createServer(socket => {
      // The 'connection' callback precedes the tracking listener.
      queueMicrotask(() => { if (!socket.destroyed && pending.has(socket)) accept(socket, false); });
    }), '127.0.0.1', port, 'TELNET (local only)');
    if (tlsOptions) {
      const server = tls.createServer({
        ...tlsOptions, minVersion: 'TLSv1.2', handshakeTimeout: 10000
      }, socket => accept(socket, true));
      server.on('tlsClientError', error => onError(error));
      await listen(server, tlsHost, tlsPort, 'TLS');
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    endpoints, sessions, auth, community, transfers,
    openLocalSession() {
      if (stopping || sessions.size >= 32) throw new InputError('console_capacity');
      return accept(new LocalSocket(), false, true);
    },
    openAgentSession(onWrite) {
      if (stopping || sessions.size >= 32) throw new InputError('console_capacity');
      const session = accept(new LocalSocket(onWrite), false);
      session.socket.send(Buffer.from([255, 253, 1, 255, 253, 3, 255, 251, 3]));
      return session;
    },
    watchNode(id) {
      const session = sessions.get(id);
      if (!session || session.closed) throw new InputError('Node is no longer connected.');
      if (!session.user) throw new InputError('console_authenticated_only');
      if (session.transferRaw) throw new InputError('console_caller_busy');
      if (session.screenHistory === undefined) throw new InputError('console_screen_unavailable');
      return session;
    },
    nodes: () => [...sessions.values()].map(session => ({
      id: session.id, handle: session.user ? store.user(session.user.id)?.handle : undefined, state: session.state
    })),
    disconnectNode(id) {
      const session = sessions.get(id);
      if (!session || session.closed) throw new InputError('Node is no longer connected.');
      session.disconnect('Disconnected by sysop.');
    },
    setUserDisabled(id, disabled) {
      store.setUserDisabled(id, disabled);
      if (disabled) {
        for (const session of sessions.values()) {
          if (session.user?.id === id) session.disconnect('Account disabled by sysop.');
        }
      }
    },
    deleteUser(id) {
      store.deleteUser(id);
      for (const session of sessions.values()) {
        if (session.user?.id === id) session.disconnect('Account deleted by sysop.');
      }
    },
    close
  };
}

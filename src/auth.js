import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { InputError, username, password } from './validation.js';

const derive = promisify(scrypt);
const params = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(value) {
  password(value);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(value, salt, 64, params);
  return `scrypt$32768$8$3$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(value, encoded) {
  const match = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) throw new Error('Unsupported or damaged password hash');
  const key = await derive(value, match[1], 64, params);
  return timingSafeEqual(key, Buffer.from(match[2], 'hex'));
}

// Per-address quotas key IPv6 callers by /64: one subscriber can rotate addresses freely.
export function addressKey(address) {
  if (typeof address !== 'string' || !address) return 'unknown';
  const value = address.toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped) return mapped[1];
  if (!value.includes(':')) return value;
  const [head, tail = ''] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded IPv4 suffix only occupies interface-ID bits; the /64 prefix is unaffected.
  const groups = value.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups.slice(0, 4).map(group => (group || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class AttemptLimiter {
  constructor({ limit = 10, windowMs = 900000, maxEntries = 4096, now = Date.now } = {}) {
    Object.assign(this, { limit, windowMs, maxEntries, now });
    this.entries = new Map();
  }

  take(key) {
    const now = this.now();
    for (const [address, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(address);
    }
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) return false;
      entry = { count: 0, expires: now + this.windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }
}

export class Auth {
  constructor(store) {
    this.store = store;
    this.limiter = new AttemptLimiter();
    this.active = 0;
  }

  async init() {
    this.dummy = await hashPassword(randomBytes(32).toString('hex'));
  }

  async run(address, operation) {
    if (!this.limiter.take(addressKey(address))) throw new InputError('Too many attempts. Try again in 15 minutes.');
    if (this.active >= 4) throw new InputError('Authentication is busy. Please try again later.');
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }

  async login(handle, secret, address, statusOnly = false) {
    username(handle);
    password(secret);
    return this.run(address, async () => {
      const user = this.store.findUser(handle);
      const valid = await verifyPassword(secret, user?.password_hash ?? this.dummy);
      const current = user && this.store.user(user.id);
      // A password changed while this derivation ran must not authenticate the old one.
      const unchanged = user && this.store.passwordHash(user.id) === user.password_hash;
      if (!current || current.disabled || !valid || !unchanged) throw new InputError('Invalid handle or password.');
      if (statusOnly) return { status: current.application_status };
      if (current.application_status !== 'approved') throw new InputError('Application not approved. Use Check application.');
      return { id: current.id, handle: current.handle, credentialVersion: user.credential_version };
    });
  }

  // Authenticated self-service change. Requires the current password, shares the
  // address limiter and derivation cap, and returns the new credential version.
  async changePassword(userId, current, next, address) {
    password(current);
    password(next);
    if (current === next) throw new InputError('error_new_password_must_differ');
    return this.run(address, async () => {
      const hash = this.store.passwordHash(userId);
      const valid = await verifyPassword(current, hash || this.dummy);
      const user = this.store.user(userId);
      if (!hash || !user || user.disabled || user.application_status !== 'approved') throw new InputError('Account unavailable.');
      if (!valid) throw new InputError('error_current_password_incorrect');
      return this.store.setPassword(userId, hash, await hashPassword(next));
    });
  }

  async register(handle, secret, address, pending = false) {
    username(handle);
    password(secret);
    return this.run(address, async () => {
      if (!this.store.settings().registration) throw new InputError('New caller registration is closed.');
      const hash = await hashPassword(secret);
      const id = this.store.createUser(handle, hash, pending);
      return { id, handle };
    });
  }
}

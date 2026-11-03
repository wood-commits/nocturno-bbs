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
    if (!this.limiter.take(address)) throw new InputError('Too many attempts. Try again in 15 minutes.');
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
      if (!current || current.disabled || !valid) throw new InputError('Invalid handle or password.');
      if (statusOnly) return { status: current.application_status };
      if (current.application_status !== 'approved') throw new InputError('Application not approved. Use Check application.');
      return { id: current.id, handle: current.handle };
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { Auth, AttemptLimiter, addressKey, hashPassword, verifyPassword } from '../src/auth.js';
import { Store, PENDING_APPLICATION_LIMIT } from '../src/store.js';
import { InputError } from '../src/validation.js';

test('scrypt uses unique salts and verifies passwords without storing plaintext', async () => {
  const secret = 'a unique test password';
  const first = await hashPassword(secret);
  const second = await hashPassword(secret);
  assert.notEqual(first, second);
  assert.ok(!first.includes(secret));
  assert.equal(await verifyPassword(secret, first), true);
  assert.equal(await verifyPassword('a different password', first), false);
  await assert.rejects(verifyPassword(secret, 'damaged'), /damaged/);
  await assert.rejects(hashPassword('short'), InputError);
});

test('registration, case-insensitive login, generic errors and throttling', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store);
  await auth.init();
  const user = await auth.register('Night_Owl', 'never reuse this password', 'local');
  assert.equal((await auth.login('night_owl', 'never reuse this password', 'local')).id, user.id);
  await assert.rejects(auth.login('Night_Owl', 'incorrect password', 'local'), /Invalid handle or password/);
  await assert.rejects(auth.login('Nobody', 'incorrect password', 'local'), /Invalid handle or password/);
  await assert.rejects(auth.register('NIGHT_OWL', 'another unique password', 'local'), /Unable to register/);
  auth.active = 4;
  await assert.rejects(auth.login('Night_Owl', 'never reuse this password', 'local'), /busy/);
  auth.active = 0;
  auth.limiter = new AttemptLimiter({ limit: 1 });
  await assert.rejects(auth.login('Nobody', 'incorrect password', 'local'), /Invalid/);
  await assert.rejects(auth.login('Night_Owl', 'never reuse this password', 'local'), /Too many/);
});

test('limiter is bounded, denies overflow, and expires entries', () => {
  let now = 0;
  const limiter = new AttemptLimiter({ limit: 2, windowMs: 100, maxEntries: 1, now: () => now });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.take('b'), false);
  now = 100;
  assert.equal(limiter.take('b'), true);
  assert.equal(limiter.entries.size, 1);
});

test('deletion invalidates in-flight login and handle reuse never revives the old account', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store);
  await auth.init();
  const oldSecret = 'original test password';
  const newSecret = 'replacement test password';
  const user = await auth.register('DeletedCaller', oldSecret, 'seed');
  const login = auth.login('DeletedCaller', oldSecret, 'login');
  const status = auth.login('DeletedCaller', oldSecret, 'status', true);
  store.deleteUser(user.id);
  await Promise.all([
    assert.rejects(login, /Invalid handle or password/),
    assert.rejects(status, /Invalid handle or password/)
  ]);
  await assert.rejects(auth.login('DeletedCaller', oldSecret, 'deleted'), /Invalid handle or password/);
  const replacement = await auth.register('deletedcaller', newSecret, 'new');
  assert.notEqual(replacement.id, user.id);
  assert.equal((await auth.login('DeletedCaller', newSecret, 'replacement')).id, replacement.id);
  await assert.rejects(auth.login('DeletedCaller', oldSecret, 'old'), /Invalid handle or password/);
});

test('applications require local approval and status checks require the password', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store);
  await auth.init();
  const user = await auth.register('Applicant', 'unique application password', 'local', true);
  assert.equal(store.user(user.id).application_status, 'pending');
  assert.equal(store.users().length, 0);
  assert.equal(store.applications()[0].id, user.id);
  await assert.rejects(auth.login('Applicant', 'unique application password', 'local'), /not approved/);
  await assert.rejects(auth.login('Applicant', 'incorrect password', 'local', true), /Invalid handle or password/);
  assert.deepEqual(await auth.login('Applicant', 'unique application password', 'local', true), { status: 'pending' });
  assert.throws(() => store.post(user.id, 'No access', 'Pending callers cannot post'), /permission denied/);
  store.decideApplication(user.id, true);
  assert.equal((await auth.login('Applicant', 'unique application password', 'local')).id, user.id);
  assert.equal(store.users().length, 1);
  assert.throws(() => store.decideApplication(user.id, false), /not found/);
});

test('disabling an account or closing registration during hashing is enforced', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.initSettings('Security Test');
  const auth = new Auth(store);
  await auth.init();
  const user = await auth.register('Existing', 'unique testing password', 'local');
  const login = auth.login('Existing', 'unique testing password', 'local');
  store.setUserDisabled(user.id, true);
  await assert.rejects(login, /Invalid handle or password/);
  await assert.rejects(auth.login('Existing', 'unique testing password', 'local'), /Invalid handle or password/);
  store.setUserDisabled(user.id, false);
  assert.equal((await auth.login('Existing', 'unique testing password', 'local')).id, user.id);
  const registration = auth.register('NewCaller', 'unique testing password', 'local');
  store.updateSettings({ ...store.settings(), registration: 0 });
  await assert.rejects(registration, /closed/);
  assert.equal(store.findUser('NewCaller'), undefined);
  await assert.rejects(auth.register('NewCaller', 'unique testing password', 'local'), /closed/);
});
test('address keys group IPv6 callers by /64 so rotation cannot bypass per-address limits', async t => {
  assert.equal(addressKey('203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:0DB8:0001:0002:ffff:ffff:ffff:fffe'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8::1%eth0'), '2001:db8:0:0::/64');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey(undefined), 'unknown');
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store);
  await auth.init();
  auth.limiter = new AttemptLimiter({ limit: 1 });
  await assert.rejects(auth.login('Nobody', 'incorrect password', '2001:db8:1:2::10'), /Invalid/);
  await assert.rejects(auth.login('Nobody', 'incorrect password', '2001:db8:1:2::11'), /Too many/);
  await assert.rejects(auth.login('Nobody', 'incorrect password', '2001:db8:1:3::10'), /Invalid/);
});

test('anonymous applications are bounded by a pending review queue', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO users(handle, password_hash, created_at, application_status)
    SELECT 'Applicant_' || i, 'test-only-hash', '2026-01-01', 'pending' FROM n`).run(PENDING_APPLICATION_LIMIT);
  assert.throws(() => store.createUser('One_More', 'test-only-hash', true), /application queue is full/);
  assert.ok(store.createUser('Local_Seed', 'test-only-hash'));
  store.decideApplication(store.findUser('Applicant_1').id, false);
  assert.ok(store.createUser('One_More', 'test-only-hash', true));
});

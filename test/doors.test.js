import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { initializeDoors, doorCommand, doorScreen } from '../src/doors.js';
import { InputError } from '../src/validation.js';
import { plainText } from '../src/strings.js';

const today = new Date('2026-10-29T23:59:59Z');
const tomorrow = new Date('2026-10-30T00:00:00Z');

function setup(t) {
  const store = new Store(':memory:');
  initializeDoors(store.db);
  t.after(() => store.close());
  const first = Number(store.createUser('Scout', 'test-only-hash'));
  const second = Number(store.createUser('Farmer', 'test-only-hash'));
  const screen = (id = first, page = 0, now = today) => doorScreen(store, id, page, now);
  const command = (line, id = first, now = today) => doorCommand(store, id, line, 0, now);
  const realm = (id = first) => store.db.prepare('SELECT * FROM frontier_realms WHERE user_id = ?').get(id);
  return { store, first, second, screen, command, realm };
}

test('deleted realms cannot play or be attacked and handle reuse starts a separate realm', t => {
  const { store, first, second, screen, command, realm } = setup(t);
  screen(first);
  screen(second);
  command('E', first);
  store.deleteUser(first);
  assert.throws(() => command('E', first), InputError);
  assert.throws(() => command(`A ${first}`, second), InputError);
  const replacement = store.createUser('Scout', 'new-test-hash');
  assert.notEqual(replacement, first);
  screen(replacement);
  assert.equal(realm(first).land, 105);
  assert.equal(realm(replacement).land, 100);
});

test('only screen entry enrolls, initialization is additive, and output is safe CRLF', t => {
  const { store, first, screen, command, realm } = setup(t);
  assert.throws(() => command('E'), InputError);
  assert.equal(realm(), undefined);
  const output = screen();
  assert.match(output, /Frontier Realms/);
  assert.match(plainText(output), /Land 100 \| Gold 1000 \| Troops 20/);
  assert.equal(realm().turns, 20);
  assert.equal(realm().farms, 0);
  assert.equal(realm().markets, 0);
  assert.equal(realm().watchtowers, 0);
  command('E');
  initializeDoors(store.db);
  screen();
  assert.equal(realm().land, 105);
  store.db.prepare('UPDATE users SET handle = ? WHERE id = ?').run('\x1b[2Jbad\nname', first);
  store.db.prepare('UPDATE frontier_realms SET last_result = ? WHERE user_id = ?').run('\x1b[2J\nbad', first);
  const safe = screen();
  assert.match(plainText(safe), /^[\x20-\x7e\r\n]+$/);
  assert.ok(!safe.includes('\x1b[2J'));
  assert.doesNotMatch(safe, /(?<!\r)\n|\r(?!\n)/);
  assert.ok(output.length < 5000);
});

test('turns exhaust and refresh once per UTC day without accumulating or clock rewind', t => {
  const { screen, command, realm } = setup(t);
  screen();
  for (let i = 0; i < 20; i++) command('H');
  assert.equal(realm().turns, 0);
  const exhausted = realm();
  for (const line of ['H', 'E', 'T', 'A 2']) assert.throws(() => command(line), InputError);
  assert.deepEqual(realm(), exhausted);
  screen(undefined, 0, tomorrow);
  assert.equal(realm().turns, 20);
  command('E', undefined, tomorrow);
  screen(undefined, 0, today);
  assert.equal(realm().turns, 19);
  screen(undefined, 0, new Date('2027-01-01T00:00:00Z'));
  assert.equal(realm().turns, 20);
});

test('exploration, recruitment, harvest, and resource caps are bounded', t => {
  const { store, first, screen, command, realm } = setup(t);
  screen();
  command(' e ');
  assert.equal(realm().land, 105);
  assert.equal(realm().gold, 1050);
  command('T');
  assert.equal(realm().troops, 30);
  assert.equal(realm().gold, 950);
  command('H');
  assert.equal(realm().gold, 1060);
  store.db.prepare('UPDATE frontier_realms SET land = 999999, gold = 999999, troops = 99999 WHERE user_id = ?').run(first);
  command('E');
  command('H');
  assert.equal(realm().land, 1000000);
  assert.equal(realm().gold, 1000000);
  command('T');
  assert.equal(realm().troops, 100000);
  const full = realm();
  assert.throws(() => command('T'), InputError);
  assert.deepEqual(realm(), full);
  store.db.prepare('UPDATE frontier_realms SET gold = 99, troops = 0 WHERE user_id = ?').run(first);
  const poor = realm();
  assert.throws(() => command('T'), InputError);
  assert.throws(() => command('A 2'), InputError);
  assert.deepEqual(realm(), poor);
});

test('deterministic attacks conserve land, spend turns/troops, and notify both players', t => {
  const { store, first, second, screen, command, realm } = setup(t);
  screen();
  screen(second);
  assert.match(command(`A ${second}`).text, /repelled/);
  assert.equal(realm().turns, 19);
  assert.equal(realm().troops, 17);
  assert.equal(realm(second).troops, 19);
  assert.equal(realm().land + realm(second).land, 200);
  assert.equal(realm().last_result, realm(second).last_result);
  command('T');
  assert.match(command(`A ${second}`).text, /victory/);
  assert.equal(realm().land, 110);
  assert.equal(realm(second).land, 90);
  assert.match(screen(second), /land transferred 10/);
  command('E', second);
  assert.equal(realm(second).land, 95);
  assert.equal(realm(second).turns, 19);
  assert.equal(realm().land, 110);
  store.db.prepare('UPDATE frontier_realms SET troops = 100000, land = 999999 WHERE user_id = ?').run(first);
  store.db.prepare('UPDATE frontier_realms SET troops = 0, land = 21 WHERE user_id = ?').run(second);
  command(`A ${second}`);
  assert.equal(realm().land, 1000000);
  assert.equal(realm(second).land, 20);
  command(`A ${second}`);
  assert.equal(realm(second).land, 20);
  assert.equal(realm(second).troops, 0);
  assert.ok(realm().last_result.length <= 240);
});

test('validation, disabled users, missing and inactive realms never spend resources', t => {
  const { store, first, second, screen, command, realm } = setup(t);
  screen();
  for (const line of ['', ' ', 'E extra', 'T 2', 'H 2', 'A', 'A 2 extra', 'A 0',
    'A -1', 'A 1.0', 'A 1e1', 'A 9007199254740992', 'A 0002', 'A 2;DROP',
    '\x1b[2J', 'E\n', 'E\t', 'x'.repeat(81), null, {}, 'UNKNOWN']) {
    assert.throws(() => command(line), InputError);
  }
  const before = realm();
  assert.throws(() => command(`A ${first}`), InputError);
  assert.throws(() => command(`A ${second}`), InputError);
  assert.throws(() => command('A 999'), InputError);
  assert.deepEqual(realm(), before);
  screen(second);
  store.setUserDisabled(second, true);
  assert.throws(() => command(`A ${second}`), InputError);
  assert.throws(() => screen(second), InputError);
  assert.throws(() => command('H', second), InputError);
  store.setUserDisabled(second, false);
  store.db.prepare('UPDATE frontier_realms SET active = 0 WHERE user_id = ?').run(second);
  assert.throws(() => command(`A ${second}`), InputError);
  assert.throws(() => screen(second), InputError);
  assert.deepEqual(realm(), before);
  for (const page of [-1, 1000, 1.5, NaN, '0']) {
    assert.throws(() => doorScreen(store, first, page, today), InputError);
    assert.throws(() => doorCommand(store, first, 'E', page, today), InputError);
  }
  assert.throws(() => doorScreen(store, first, 0, new Date('invalid')), InputError);
  assert.throws(() => screen(0), InputError);
  assert.throws(() => screen(999), InputError);
  store.setUserDisabled(first, true);
  assert.throws(() => screen(), InputError);
  assert.throws(() => command('E'), InputError);
  assert.deepEqual(realm(), before);
});

test('attacks and daily refresh roll back together on a failed defender update', t => {
  const { store, first, second, screen, command, realm } = setup(t);
  screen();
  screen(second);
  command('E');
  const before = realm();
  const defender = realm(second);
  store.db.exec(`
    CREATE TRIGGER reject_defender BEFORE UPDATE ON frontier_realms
    WHEN NEW.user_id = 2 BEGIN SELECT RAISE(ABORT, 'test failure'); END;
  `);
  assert.throws(() => command(`A ${second}`, first, tomorrow), /test failure/);
  assert.deepEqual(realm(), before);
  assert.deepEqual(realm(second), defender);
  store.db.exec('DROP TRIGGER reject_defender');
  command('E');
  assert.equal(realm().turns, before.turns - 1);
});

test('leaderboard has ten rows, stable ordering, and excludes disabled/inactive users', t => {
  const { store, first, screen, command } = setup(t);
  screen();
  for (let i = 0; i < 12; i++) {
    const id = Number(store.createUser(`Player_${i}`, 'test-only-hash'));
    screen(id);
  }
  const rows = output => plainText(output).split('\r\n').filter(line => /^\d+ +\| /.test(line));
  assert.equal(rows(command('L').text).length, 10);
  assert.equal(rows(doorScreen(store, first, 1, today, 'rankings')).length, 3);
  assert.equal(rows(command('N').text).length, 3);
  assert.equal(rows(command('P').text).length, 10);
  assert.match(doorScreen(store, first, 999, today, 'rankings'), /No realms on this page/);
  store.setUserDisabled(first, true);
  store.db.prepare('UPDATE frontier_realms SET active = 0 WHERE user_id = ?').run(first + 2);
  const visible = doorScreen(store, first + 1, 0, today, 'rankings');
  assert.doesNotMatch(plainText(visible), /\| Scout +\||\| Player_0 +\|/);
});

test('development costs escalate, affects income, and preserves daily turn rules', t => {
  const { store, first, screen, command, realm } = setup(t);
  screen();
  command('F');
  assert.equal(realm().farms, 1);
  assert.equal(realm().gold, 800);
  assert.equal(realm().turns, 19);
  command('F');
  assert.equal(realm().gold, 400);
  assert.equal(realm().farms, 2);
  command('H');
  assert.equal(realm().gold, 560);
  command('M');
  assert.equal(realm().gold, 260);
  command('E');
  assert.equal(realm().gold, 320);
  assert.equal(realm().land, 105);
  command('W');
  assert.equal(realm().gold, 70);
  assert.equal(realm().watchtowers, 1);
  const poor = realm();
  assert.throws(() => command('F'), /600/);
  assert.deepEqual(realm(), poor);
  screen(first, 0, tomorrow);
  assert.equal(realm().turns, 20);
  assert.equal(realm().farms, 2);
  assert.equal(realm().markets, 1);
  assert.equal(realm().watchtowers, 1);
  store.db.prepare('UPDATE frontier_realms SET gold = 999999, land = 1000000 WHERE user_id = ?').run(first);
  command('H', first, tomorrow);
  assert.equal(realm().gold, 1000000);
  command('E', first, tomorrow);
  assert.equal(realm().gold, 1000000);
  assert.equal(realm().land, 1000000);
});

test('all development paths stop at ten levels and reject exhausted or malformed actions', t => {
  const { store, first, screen, command, realm } = setup(t);
  screen();
  for (const [key, column] of [['F', 'farms'], ['M', 'markets'], ['W', 'watchtowers']]) {
    store.db.prepare('UPDATE frontier_realms SET gold = 1000000, turns = 20 WHERE user_id = ?').run(first);
    for (let i = 0; i < 10; i++) command(key);
    assert.equal(realm()[column], 10);
    assert.equal(realm().turns, 10);
    const full = realm();
    assert.throws(() => command(key), /level 10/);
    assert.deepEqual(realm(), full);
  }
  store.db.prepare('UPDATE frontier_realms SET turns = 0 WHERE user_id = ?').run(first);
  const exhausted = realm();
  for (const key of ['F', 'M', 'W']) assert.throws(() => command(key), /No turns/);
  for (const line of ['F 2', 'M 2', 'W 2', 'B F', 'L extra', 'C extra']) {
    assert.throws(() => command(line), InputError);
  }
  for (const key of ['B', 'L', '?', 'C', 'N', 'P']) command(key);
  assert.deepEqual(realm(), exhausted);
});

test('watchtowers repel otherwise successful attacks at the exact defense threshold', t => {
  const { store, first, second, screen, command, realm } = setup(t);
  screen(); screen(second);
  command('W', second);
  store.db.prepare('UPDATE frontier_realms SET troops = 28 WHERE user_id = ?').run(first);
  assert.match(command(`A ${second}`).text, /repelled/);
  assert.equal(realm().land, 100);
  assert.equal(realm(second).land, 100);
  assert.equal(realm(second).watchtowers, 1);
  store.db.prepare('UPDATE frontier_realms SET troops = 29 WHERE user_id = ?').run(first);
  store.db.prepare('UPDATE frontier_realms SET troops = 20 WHERE user_id = ?').run(second);
  assert.match(command(`A ${second}`).text, /victory/);
  assert.equal(realm().land, 110);
  assert.equal(realm(second).land, 90);
  assert.equal(realm(second).watchtowers, 1);
});

test('old realm schema upgrades additively without changing existing progress', t => {
  const { store, first, screen, realm } = setup(t);
  store.db.exec(`
    DROP TABLE frontier_realms;
    CREATE TABLE frontier_realms (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), land INTEGER NOT NULL DEFAULT 100,
      gold INTEGER NOT NULL DEFAULT 1000, troops INTEGER NOT NULL DEFAULT 20,
      turns INTEGER NOT NULL DEFAULT 20, turn_day TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, last_result TEXT NOT NULL DEFAULT ''
    );
  `);
  store.db.prepare(`INSERT INTO frontier_realms
    (user_id, land, gold, troops, turns, turn_day, last_result) VALUES (?, 321, 765, 43, 7, ?, 'Old dispatch')`)
    .run(first, '2026-10-29');
  initializeDoors(store.db);
  initializeDoors(store.db);
  screen();
  assert.equal(realm().land, 321);
  assert.equal(realm().gold, 765);
  assert.equal(realm().troops, 43);
  assert.equal(realm().turns, 7);
  assert.equal(realm().last_result, 'Old dispatch');
  assert.equal(realm().farms + realm().markets + realm().watchtowers, 0);
  assert.throws(() => store.db.prepare('UPDATE frontier_realms SET farms = 11 WHERE user_id = ?').run(first));
});

test('development and UTC refresh roll back atomically on storage failure', t => {
  const { store, screen, command, realm } = setup(t);
  screen();
  command('E');
  const before = realm();
  store.db.exec(`CREATE TRIGGER reject_build BEFORE UPDATE OF farms ON frontier_realms
    BEGIN SELECT RAISE(ABORT, 'build failure'); END;`);
  assert.throws(() => command('F', undefined, tomorrow), /build failure/);
  assert.deepEqual(realm(), before);
});

test('every generated view fits 80x24 with classic colors and literal untrusted fields', t => {
  const { store, first, second, screen, command } = setup(t);
  screen(); screen(second);
  for (let i = 0; i < 12; i++) {
    screen(Number(store.createUser(`LongCommander_${i}`, 'test-only-hash')));
  }
  store.db.prepare('UPDATE users SET handle = ? WHERE id = ?').run('|12LiteralCommander', first);
  store.db.prepare('UPDATE frontier_realms SET last_result = ? WHERE user_id = ?')
    .run('x'.repeat(240), first);
  const before = store.db.prepare('SELECT * FROM frontier_realms WHERE user_id = ?').get(first);
  const frames = [screen(), ...['B', 'L', 'N', 'P', '?', 'C'].map(key => command(key).text),
    command('F').text, command('M').text, command('W').text, command('A 2').text];
  for (const frame of frames) {
    const lines = plainText(frame).split('\r\n');
    assert.ok(lines.length <= 24, `${lines.length} rows`);
    assert.ok(lines.every(line => line.length <= 78));
    assert.match(plainText(frame), /\|12LiteralCommander/);
    assert.doesNotMatch(frame, /(?<!\r)\n|\r(?!\n)/);
    assert.ok(frame.length < 8192);
    // eslint-disable-next-line no-control-regex
    assert.ok(new Set([...frame.matchAll(/\x1b\[([0-9;]*)m/g)].map(match => match[1])).size >= 5);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(frame, /\x1b\[(?:9\d|38|48)[;m]/);
  }
  assert.equal(before.turns - 4, store.db.prepare('SELECT turns FROM frontier_realms WHERE user_id = ?').get(first).turns);
  assert.match(plainText(command('?').text), /ceil\(enemy troops\/4\)/);
  assert.equal(command('N').page, 1);
  assert.equal(doorCommand(store, first, 'P', 0, today).page, 0);
  assert.equal(doorCommand(store, first, 'N', 999, today).page, 999);
  assert.throws(() => doorScreen(store, first, 0, today, 'unknown'), InputError);
});

test('realm state and defender notification survive closing and reopening the database', t => {
  const directory = mkdtempSync(join(process.cwd(), '.doors-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bbs.sqlite');
  let store = new Store(filename);
  try {
    initializeDoors(store.db);
    const first = Number(store.createUser('Scout', 'test-only-hash'));
    const second = Number(store.createUser('Farmer', 'test-only-hash'));
    doorScreen(store, first, 0, today);
    doorScreen(store, second, 0, today);
    for (const key of ['F', 'M', 'W']) doorCommand(store, first, key, 0, today);
    doorCommand(store, first, 'T', 0, today);
    doorCommand(store, first, `A ${second}`, 0, today);
    const before = store.db.prepare('SELECT * FROM frontier_realms ORDER BY user_id').all();
    store.close();
    store = new Store(filename);
    initializeDoors(store.db);
    assert.deepEqual(store.db.prepare('SELECT * FROM frontier_realms ORDER BY user_id').all(), before);
    assert.match(doorScreen(store, second, 0, today), /Realm 1 attacked realm 2/);
  } finally { store.close(); }
});

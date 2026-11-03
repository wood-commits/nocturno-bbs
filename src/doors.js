import { ui, plainText } from './strings.js';
import { InputError, safeText } from './validation.js';

const LAND_CAP = 1000000;
const GOLD_CAP = 1000000;
const TROOP_CAP = 100000;
const DAILY_TURNS = 20;
const DEVELOPMENT_CAP = 10;
const developments = new Map([
  ['F', { column: 'farms', name: 'doors_farms', cost: 200 }],
  ['M', { column: 'markets', name: 'doors_markets', cost: 300 }],
  ['W', { column: 'watchtowers', name: 'doors_watchtowers', cost: 250 }]
]);
const views = ['command', 'development', 'rankings', 'help'];

export function initializeDoors(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS frontier_realms (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      land INTEGER NOT NULL DEFAULT 100 CHECK (land BETWEEN 20 AND 1000000),
      gold INTEGER NOT NULL DEFAULT 1000 CHECK (gold BETWEEN 0 AND 1000000),
      troops INTEGER NOT NULL DEFAULT 20 CHECK (troops BETWEEN 0 AND 100000),
      turns INTEGER NOT NULL DEFAULT 20 CHECK (turns BETWEEN 0 AND 20),
      turn_day TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      last_result TEXT NOT NULL DEFAULT '' CHECK (length(last_result) <= 240)
    );
  `);
  const columns = db.prepare('PRAGMA table_info(frontier_realms)').all();
  for (const { column } of developments.values()) {
    if (!columns.some(item => item.name === column)) {
      // Column names are from the fixed development definitions, never caller input.
      db.exec(`ALTER TABLE frontier_realms ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} BETWEEN 0 AND 10)`);
    }
  }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function dayOf(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new InputError('Invalid realm date.');
  }
  return now.toISOString().slice(0, 10);
}

function validatePage(page) {
  if (!Number.isInteger(page) || page < 0 || page > 999) {
    throw new InputError('Realm page must be 0-999.');
  }
}

function enabledUser(store, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new InputError('Invalid realm ID.');
  const user = store.user(id);
  if (!user || user.disabled || user.application_status !== 'approved') throw new InputError('Realm user is unavailable.');
  return user;
}

function realmFor(store, id, day, enroll = false) {
  enabledUser(store, id);
  if (enroll) {
    store.db.prepare('INSERT OR IGNORE INTO frontier_realms (user_id, turn_day) VALUES (?, ?)')
      .run(id, day);
  }
  let realm = store.db.prepare('SELECT * FROM frontier_realms WHERE user_id = ? AND active = 1').get(id);
  if (!realm) throw new InputError('Enter Frontier Realms before playing; realm may be inactive.');
  // A backwards clock must not award another day's turns.
  if (day > realm.turn_day) {
    store.db.prepare('UPDATE frontier_realms SET turns = ?, turn_day = ? WHERE user_id = ?')
      .run(DAILY_TURNS, day, id);
    realm = store.db.prepare('SELECT * FROM frontier_realms WHERE user_id = ?').get(id);
  }
  return realm;
}

function harvestIncome(realm) {
  return Math.min(1000, 100 + Math.floor(realm.land / 10) + realm.farms * 25);
}

function reportLines(store, value, key) {
  const text = safeText(value).slice(0, 240);
  const lines = [];
  for (let offset = 0; offset < plainText(text).length;) {
    const remaining = plainText(text).slice(offset);
    const space = remaining.slice(0, 75).lastIndexOf(' ');
    const width = remaining.length > 74 && space >= 60 ? space : Math.min(74, remaining.length);
    lines.push(ui(store, key, { VALUE1: text.slice(offset, offset + width) }));
    offset += width + (remaining[width] === ' ' ? 1 : 0);
  }
  return lines;
}

function render(store, userId, page, view = 'command', notice = '') {
  const user = enabledUser(store, userId);
  const realm = store.db.prepare('SELECT * FROM frontier_realms WHERE user_id = ?').get(userId);
  const lines = [
    ui(store, 'doors_frontier_realms'),
    ui(store, 'doors_skyline'),
    ui(store, 'doors_divider'),
    ui(store, 'doors_id_value_value', { ID: user.id, VALUE2: safeText(user.handle).slice(0, 24) }),
    ui(store, 'doors_land_value_gold_value_troops_value', { LAND: realm.land, GOLD: realm.gold, TROOPS: realm.troops }),
    ui(store, 'doors_turns_value_20_utc_turn_day_value', { TURNS: realm.turns, TURN_DAY: realm.turn_day }),
    ui(store, 'doors_divider')
  ];
  if (view === 'rankings') {
    const leaders = store.db.prepare(`
      SELECT r.user_id, u.handle, r.land, r.gold, r.troops
      FROM frontier_realms r JOIN users u ON u.id = r.user_id
      WHERE r.active = 1 AND u.disabled = 0 AND u.application_status = 'approved'
      ORDER BY r.land DESC, r.gold DESC, r.user_id ASC LIMIT 10 OFFSET ?
    `).all(page * 10);
    lines.push(ui(store, 'doors_leaderboard_page_value_land_then_gold', { VALUE1: page + 1 }),
      ui(store, 'doors_id_handle_land_gold_troops'));
    for (const leader of leaders) {
      lines.push(ui(store, 'doors_value_value_value_value_value', {
        USER_ID: String(leader.user_id).padEnd(8), VALUE2: safeText(leader.handle).slice(0, 24).padEnd(24),
        LAND: String(leader.land).padStart(7), GOLD: String(leader.gold).padStart(7),
        TROOPS: String(leader.troops).padStart(6)
      }));
    }
    if (!leaders.length) lines.push(ui(store, 'doors_no_realms_on_this_page'));
  } else if (view === 'help') {
    for (const key of ['doors_20_turns_reset_each_utc_day_unused_turns_do_not_accumulate',
      'doors_e_explore_help', 'doors_t_recruit_1_turn_100_gold_for_up_to_10_troops',
      'doors_h_harvest_help', 'doors_a_id_attack_1_turn_up_to_500_troops_committed_losses_apply',
      'doors_defense_help', 'doors_wins_take_up_to_10_land_every_realm_keeps_at_least_20_land',
      'doors_build_help', 'doors_build_cost_help', 'doors_caps_1000000_land_gold_100000_troops',
      'doors_offline_help']) lines.push(ui(store, key));
  } else if (view === 'development') {
    lines.push(ui(store, 'doors_development_title'), ui(store, 'doors_development_columns'));
    for (const [key, item] of developments) {
      lines.push(ui(store, 'doors_development_row', {
        KEY: key, NAME: ui(store, item.name).padEnd(12), LEVEL: String(realm[item.column]).padStart(2),
        COST: realm[item.column] === DEVELOPMENT_CAP ? ui(store, 'doors_maximum') :
          String(item.cost * (realm[item.column] + 1)).padStart(5)
      }));
    }
    for (const key of ['doors_farm_help', 'doors_market_help', 'doors_tower_help',
      'doors_build_help', 'doors_build_cost_help']) lines.push(ui(store, key));
  } else {
    lines.push(ui(store, 'doors_command_title'),
      ui(store, 'doors_economy', { HARVEST: harvestIncome(realm), EXPLORE: 50 + realm.markets * 10,
        DEFENSE: realm.watchtowers * 2 }),
      ui(store, 'doors_action_menu'), ui(store, 'doors_navigation_menu'),
      ui(store, 'doors_development_summary', { FARMS: realm.farms, MARKETS: realm.markets, TOWERS: realm.watchtowers }),
      ui(store, 'doors_combat_title'),
      ...reportLines(store, realm.last_result || ui(store, 'doors_no_combat'), 'doors_report_line'));
  }
  if (notice) lines.push(...reportLines(store, notice, 'doors_notice_line'));
  lines.push(ui(store, 'doors_n_p_leaderboard_pages_help_q_return'));
  lines.push(ui(store, 'doors_realm_command'));
  return lines.map(line => safeText(line).slice(0, 78)).join('\r\n');
}

export function doorScreen(store, userId, page = 0, now = new Date(), view = 'command') {
  store.access.caller(userId, 'doors');
  validatePage(page);
  if (!views.includes(view)) throw new InputError('Unknown realm screen.');
  const day = dayOf(now);
  return transaction(store.db, () => {
    realmFor(store, userId, day, true);
    return render(store, userId, page, view);
  });
}

function parseCommand(line) {
  if (typeof line !== 'string' || line.length > 80 || !/^[\x20-\x7e]+$/.test(line)) {
    throw new InputError('Use a printable realm command of at most 80 characters.');
  }
  const tokens = line.trim().split(/ +/);
  const command = tokens[0].toUpperCase();
  if (command === 'A') {
    if (tokens.length !== 2 || !/^[1-9][0-9]{0,15}$/.test(tokens[1]) ||
        !Number.isSafeInteger(Number(tokens[1]))) {
      throw new InputError('Use A followed by a realm ID.');
    }
    return { command, target: Number(tokens[1]) };
  }
  if (tokens.length !== 1 || !['E', 'T', 'H', 'B', 'F', 'M', 'W', 'L', 'C', '?', 'N', 'P'].includes(command)) {
    throw new InputError('error_realm_commands');
  }
  return { command };
}

function attack(store, attacker, targetId) {
  if (attacker.user_id === targetId) throw new InputError('You cannot attack your own realm.');
  enabledUser(store, targetId);
  const defender = store.db.prepare('SELECT * FROM frontier_realms WHERE user_id = ? AND active = 1')
    .get(targetId);
  if (!defender) throw new InputError('Target realm is unavailable.');
  if (attacker.troops < 2) throw new InputError('At least 2 troops are needed to attack.');
  const force = Math.min(500, Math.ceil(attacker.troops / 4));
  const won = force > Math.ceil(defender.troops / 4) + defender.watchtowers * 2;
  const losses = Math.max(1, Math.ceil(force / (won ? 3 : 2)));
  const enemyLosses = Math.min(defender.troops, Math.max(1, Math.floor(force / (won ? 2 : 3))));
  const land = won ? Math.min(10, defender.land - 20, LAND_CAP - attacker.land) : 0;
  const result = `Realm ${attacker.user_id} attacked realm ${targetId}: ${won ? 'victory' : 'repelled'}; land transferred ${land}; troops lost ${losses}/${enemyLosses} (attacker/defender).`;
  store.db.prepare(`
    UPDATE frontier_realms SET turns = turns - 1, troops = troops - ?,
      land = land + ?, last_result = ? WHERE user_id = ?
  `).run(losses, land, result, attacker.user_id);
  store.db.prepare(`
    UPDATE frontier_realms SET troops = troops - ?, land = land - ?,
      last_result = ? WHERE user_id = ?
  `).run(enemyLosses, land, result, targetId);
  return result;
}

export function doorCommand(store, userId, line, page = 0, now = new Date()) {
  store.access.caller(userId, 'doors');
  validatePage(page);
  const { command, target } = parseCommand(line);
  const day = dayOf(now);
  return transaction(store.db, () => {
    const realm = realmFor(store, userId, day);
    let result = '';
    if (['E', 'T', 'H', 'A', 'F', 'M', 'W'].includes(command) && realm.turns === 0) {
      throw new InputError('No turns remain. Return on the next UTC day.');
    }
    if (command === 'E') {
      store.db.prepare(`
        UPDATE frontier_realms SET turns = turns - 1,
          land = min(?, land + 5), gold = min(?, gold + ?) WHERE user_id = ?
      `).run(LAND_CAP, GOLD_CAP, 50 + realm.markets * 10, userId);
      result = ui(store, 'doors_your_scouts_expanded_the_frontier');
    } else if (command === 'T') {
      if (realm.gold < 100) throw new InputError('Recruiting requires 100 gold.');
      if (realm.troops === TROOP_CAP) throw new InputError('Your troop capacity is full.');
      store.db.prepare(`
        UPDATE frontier_realms SET turns = turns - 1, gold = gold - 100,
          troops = min(?, troops + 10) WHERE user_id = ?
      `).run(TROOP_CAP, userId);
      result = ui(store, 'doors_new_troops_joined_your_realm');
    } else if (command === 'H') {
      const income = harvestIncome(realm);
      store.db.prepare(`
        UPDATE frontier_realms SET turns = turns - 1, gold = min(?, gold + ?) WHERE user_id = ?
      `).run(GOLD_CAP, income, userId);
      result = ui(store, 'doors_your_farms_delivered_their_harvest');
    } else if (command === 'A') {
      result = attack(store, realm, target);
    } else if (developments.has(command)) {
      const item = developments.get(command);
      const level = realm[item.column];
      if (level === DEVELOPMENT_CAP) throw new InputError('Development is already at level 10.');
      const cost = item.cost * (level + 1);
      if (realm.gold < cost) throw new InputError('error_development_gold', { COST: cost });
      store.db.prepare(`
        UPDATE frontier_realms SET turns = turns - 1, gold = gold - ?,
          ${item.column} = ${item.column} + 1 WHERE user_id = ?
      `).run(cost, userId);
      result = ui(store, 'doors_built', { NAME: ui(store, item.name), LEVEL: level + 1, COST: cost });
    }
    if (command === 'N') page = Math.min(999, page + 1);
    if (command === 'P') page = Math.max(0, page - 1);
    const view = ['L', 'N', 'P'].includes(command) ? 'rankings' :
      command === '?' ? 'help' : command === 'B' || developments.has(command) ? 'development' : 'command';
    return { text: render(store, userId, page, view, result), page, view };
  });
}

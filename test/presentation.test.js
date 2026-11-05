import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Presentation, displayString, screenTokens, loginChoices, mainChoices, mainChoiceGrid } from '../src/presentation.js';
import { LocalTerminal, terminalText } from '../src/local-terminal.js';
import { terminal as rgbTerminal } from './helpers/ansi-terminal.js';
import { Store } from '../src/store.js';
import { InputError } from '../src/validation.js';
import { ui, pipeText, plainText, stringDefaults, errorText, safeText } from '../src/strings.js';
import { catalog } from '../src/string-catalog.js';
import { mciCode, migrateMci } from '../src/mci.js';
import { DatabaseSync } from 'node:sqlite';
import { loginMatrix, mainMenu, readMessage, messageLayout, messagePage } from '../src/screens.js';

const samples = fileURLToPath(new URL('../examples/ansi', import.meta.url));

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'nocturno-art-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function writeTemplate(path, name, source) {
  // Paths are isolated temporary fixtures; names are fixed test screens.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(join(path, `${name}.ans`), source);
}

function terminal(frame, { immediate = false, modernColors = true, wrapControl = true, brightBackground = true, inverseControl = true } = {}) {
  let row = 0, column = 0, scrolls = 0, foreground = 7, background = 0;
  let bold = false, inverse = false, wrap = true;
  const blank = () => Array.from({ length: 80 }, () => ({ char: ' ', fg: 7, bg: 0 }));
  const cells = Array.from({ length: 24 }, blank);
  const advance = () => {
    row++;
    if (row === 24) { scrolls++; cells.shift(); cells.push(blank()); row = 23; }
  };
  // Model DOS-style immediate wrap and classic SGR separately from modern VT100.
  // eslint-disable-next-line no-control-regex
  for (const part of frame.matchAll(/\x1b\[([0-9;?]*)([A-Za-z])|[\s\S]/g)) {
    if (part[2]) {
      const params = part[1].split(';').map(Number);
      if (part[2] === 'H' || part[2] === 'f') {
        row = Math.min(23, Math.max(0, (params[0] || 1) - 1));
        column = Math.min(79, Math.max(0, (params[1] || 1) - 1));
      } else if (part[2] === 'C') column = Math.min(79, column + (params[0] || 1));
      else if (part[2] === 'K') cells[row] = blank();
      else if (part[2] === 'J' && params[0] === 2) {
        for (let index = 0; index < 24; index++) cells[index] = blank();
      } else if (wrapControl && part[1] === '?7') wrap = part[2] !== 'l';
      else if (part[2] === 'm') {
        for (const value of params) {
          if (value === 0) { foreground = 7; background = 0; bold = false; inverse = false; }
          else if (value === 1) bold = true;
          else if (inverseControl && value === 7) inverse = true;
          else if (modernColors && value === 22) bold = false;
          else if (modernColors && value === 27) inverse = false;
          else if (value >= 30 && value <= 37) foreground = value - 30;
          else if (value >= 40 && value <= 47) background = value - 40;
          else if (modernColors && value >= 90 && value <= 97) foreground = value - 90 + 8;
        }
      }
      continue;
    }
    if (part[0] === '\r') column = 0;
    else if (part[0] === '\n') advance();
    else {
      if (column === 80) { if (wrap) advance(); column = wrap ? 0 : 79; }
      const fg = foreground | (bold ? 8 : 0);
      cells[row][column++] = { char: part[0], fg: inverse ? background : fg,
        bg: (inverse ? fg : background) & (brightBackground ? 15 : 7) };
      if (immediate && column === 80 && wrap) { advance(); column = 0; }
    }
  }
  return { cells, scrolls, text: cells.map(line => line.map(cell => cell.char).join('')).join('\n') };
}

test('Renegade pipe prompts use the DOS palette, backgrounds, escapes and reset without color bleed', () => {
  const prompt = pipeText('|03S|10e|15lection|07: ');
  assert.equal(plainText(prompt), 'Selection: ');
  const cells = terminal(`${prompt}X`, { modernColors: false }).cells[0];
  assert.deepEqual(cells.slice(0, 3).map(cell => cell.fg), [6, 10, 15]);
  assert.deepEqual(cells.slice(9, 12).map(cell => cell.fg), [7, 7, 7]);
  const palette = [0, 4, 2, 6, 1, 5, 3, 7];
  for (let code = 0; code < 24; code++) {
    const cell = terminal(String(pipeText(`|${String(code).padStart(2, '0')}X`)),
      { modernColors: false }).cells[0][0];
    if (code < 16) assert.equal(cell.fg, palette[code & 7] + (code >= 8 ? 8 : 0));
    else assert.equal(cell.bg, palette[code - 16]);
  }
  assert.equal(plainText(pipeText('||03 |||| |24')), '|03 || |24');
});

test('all stock shortcut brackets are cyan and keys yellow locally and remotely', () => {
  const entries = catalog.filter(([, source]) => /\[[^\]]+\]/.test(plainText(pipeText(source, 512))));
  assert.ok(entries.length > 30);
  for (const [key] of entries) {
    const frame = ui(undefined, key, { NUMBER: 1, KEY: 'E', VALUE1: 'Main menu' });
    const text = plainText(frame);
    const remote = terminal(String(frame), { modernColors: false });
    let localOutput = '';
    new LocalTerminal({ write: value => { localOutput += value; } }).write(frame);
    const local = rgbTerminal(localOutput);
    for (const match of text.matchAll(/\[([^\]]+)\]/g)) {
      const first = match.index, last = first + match[0].length - 1;
      for (const offset of [first, last]) {
        assert.equal(remote.cells[Math.floor(offset / 80)][offset % 80].fg, 6, key);
        assert.equal(local.cells[Math.floor(offset / 80)][offset % 80].fg, '#00aaaa', key);
      }
      for (let offset = first + 1; offset < last; offset++) {
        assert.equal(remote.cells[Math.floor(offset / 80)][offset % 80].fg, 11, key);
        assert.equal(local.cells[Math.floor(offset / 80)][offset % 80].fg, '#ffff55', key);
      }
    }
  }
});

test('stock field prompts use gray labels and leave input gray on black', () => {
  const fields = catalog.filter(([key, source]) =>
    /(?:_prompt(?:_2)?$|^selection$|_abort_cancels$|_characters$|^string_editor_edit$|^community_note_line$|^community_next_line_ends$)/.test(key) &&
    (source.endsWith(': |07') || key === 'body_prompt') && !source.includes('|03[') && !source.startsWith('|12'));
  assert.ok(fields.length > 20);
  for (const [key] of fields) {
    const frame = ui(undefined, key);
    const text = plainText(frame);
    const remote = terminal(`${frame}X`, { modernColors: false });
    let output = '';
    new LocalTerminal({ write: value => { output += value; } }).write(`${frame}X`);
    const local = rgbTerminal(output);
    for (let offset = 0; offset <= text.length; offset++) {
      assert.equal(remote.cells[Math.floor(offset / 80)][offset % 80].fg, 7, key);
      assert.equal(remote.cells[Math.floor(offset / 80)][offset % 80].bg, 0, key);
      assert.equal(local.cells[Math.floor(offset / 80)][offset % 80].fg, '#aaaaaa', key);
      assert.equal(local.cells[Math.floor(offset / 80)][offset % 80].bg, '#000000', key);
    }
  }
});

test('stock menu labels match the reference palette and saved prompt colors remain authoritative', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const key of ['community_w_replace_q_main', 'screens_1_frontier_realms_multiplayer_strategy',
    'session_a_welcome_artwork', 'session_value_value']) {
    const frame = ui(store, key, { KEY: 'E', LABEL: 'Email' });
    const text = plainText(frame);
    const screen = terminal(String(frame), { modernColors: false });
    const first = text.indexOf('['), last = text.indexOf(']');
    assert.equal(screen.cells[0][first].fg, 6, key);
    assert.equal(screen.cells[0][first + 1].fg, 11, key);
    assert.equal(screen.cells[0][last].fg, 6, key);
    assert.equal(screen.cells[0][last + 2].fg, 7, key);
  }
  store.setString('main_prompt', '|05Custom prompt: |07');
  assert.equal(terminal(String(ui(store, 'main_prompt'))).cells[0][0].fg, 5);
  assert.equal(store.stringOverride('main_prompt'), '|05Custom prompt: |07');
  store.resetString('main_prompt');
  assert.equal(terminal(String(ui(store, 'main_prompt'))).cells[0][0].fg, 7);
});

test('example ANSI prompts share the stock shortcut and field palette', () => {
  const art = new Presentation(samples);
  const doors = terminal(art.render('doors', ''), { modernColors: false });
  for (const label of ['[1] Frontier Realms', '[Q] Return to the main menu']) {
    const row = doors.cells.find(cells => cells.map(cell => cell.char).join('').includes(label));
    const first = row.map(cell => cell.char).join('').indexOf(label);
    assert.deepEqual(row.slice(first, first + 4).map(cell => cell.fg), [6, 11, 6, 7]);
    assert.ok(row.slice(first + 4, first + label.length).every(cell => cell.fg === 7 && cell.bg === 0));
  }
  const login = terminal(art.render('login', ''), { modernColors: false });
  for (const label of ['handle: ', 'passwd: ']) {
    const row = login.cells.find(cells => cells.map(cell => cell.char).join('').includes(label));
    assert.ok(row.slice(0, label.length).every(cell => cell.fg === 7 && cell.bg === 0));
  }
});

test('editable templates interpret colors only before sanitized one-pass value substitution', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setString('posted', '|11Saved |{MESSAGEID}|07');
  const output = ui(store, 'posted', { MESSAGEID: '|04|{MESSAGEID}\x1b]52;bad\x07' });
  assert.equal(plainText(output), 'Saved |04|{MESSAGEID}?]52;bad?');
  assert.ok(!String(output).includes('\x1b]'));
  assert.ok(!String(output).includes('\x1b[0;31;40m'));
  assert.equal(safeText('|04caller\x1b[2J'), '|04caller?[2J');
  assert.equal(plainText(safeText(output).slice(0, 8)), 'Saved |0');
});

test('artwork and editable strings share MCI colors, escaping, widths and literal substitutions', t => {
  const path = directory(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const source = '|11ID |{MESSAGEID:5} ||UH ||{MESSAGEID}|07';
  writeTemplate(path, 'message-header', source + '\x1b[14;1H|{BODY}');
  store.setString('posted', source);
  const values = { MESSAGEID: '|UH|1' };
  const art = new Presentation(path);
  const expected = 'ID |UH|1 |UH |{MESSAGEID}';
  assert.ok(terminal(art.render('message-header', '', values)).text.startsWith(expected));
  assert.equal(plainText(ui(store, 'posted', values)), expected);
  assert.equal(terminal(String(ui(store, 'posted', values))).cells[0][0].fg, 14);
  assert.equal(art.fieldWidth('message-header', '|{MESSAGEID}'), 5);
  assert.equal(plainText(ui(store, 'posted', { MESSAGEID: 1 })), 'ID 1     |UH |{MESSAGEID}');
});

test('MCI validation rejects legacy, malformed, unknown and out-of-context fields', t => {
  const path = directory(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const source of ['%MESSAGEID%', '~MN', '|ZZ', '|uh', '|{UNKNOWN}', '|{MESSAGEID',
    '|{MESSAGEID:0}', '|{MESSAGEID:161}', '|{MESSAGEID:01}', '|{MESSAGEID:-1}', '|24']) {
    writeTemplate(path, 'message-header', source);
    assert.throws(() => new Presentation(path), InputError, source);
    assert.throws(() => store.setString('posted', source), InputError, source);
  }
  writeTemplate(path, 'message-header', '|{BODY:10}');
  assert.throws(() => new Presentation(path), InputError);
  store.setString('posted', '||ZZ ||{UNKNOWN} |{MESSAGEID:160}');
});

test('saved percent-token overrides migrate once, persist and preserve literal pipes', t => {
  let store;
  t.after(() => store.close());
  const path = directory(t), filename = join(path, 'strings.sqlite');
  store = new Store(filename);
  const source = '|11Saved #%MESSAGEID% |UH |||07';
  store.db.prepare('INSERT INTO display_strings VALUES (?, ?)').run('posted', source);
  store.db.exec('DELETE FROM display_string_migrations');
  store.close();
  store = new Store(filename);
  assert.equal(store.stringOverride('posted'), '|11Saved #|{MESSAGEID} ||UH |||07');
  assert.equal(plainText(ui(store, 'posted', { MESSAGEID: '|BN' })), 'Saved #|BN |UH |');
  const migrated = store.stringOverride('posted');
  store.close();
  store = new Store(filename);
  assert.equal(store.stringOverride('posted'), migrated);
  assert.equal(migrateMci('literal |{NAME} |UH |04 || %USERNAME%'), 'literal ||{NAME} ||UH |04 || |UH');
});

test('oversized saved-string MCI migration rolls back without losing overrides', t => {
  let db;
  t.after(() => db?.close());
  const filename = join(directory(t), 'strings.sqlite');
  const store = new Store(filename);
  const source = '|01'.repeat(119) + '%MESSAGEID%'.repeat(14);
  store.db.prepare('INSERT INTO display_strings VALUES (?, ?)').run('posted', source);
  store.db.exec('DELETE FROM display_string_migrations');
  store.close();
  assert.throws(() => new Store(filename), /MCI source limit/);
  db = new DatabaseSync(filename);
  assert.equal(db.prepare('SELECT value FROM display_strings WHERE key = ?').get('posted').value, source);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM display_string_migrations').get().count, 0);
});

test('unified main and message-header artwork do not load obsolete filenames', t => {
  const path = directory(t);
  writeTemplate(path, 'main-new', 'OBSOLETE');
  writeTemplate(path, 'new-message-header', 'OBSOLETE');
  const art = new Presentation(path);
  assert.equal(art.render('main', 'fallback'), 'fallback');
  assert.equal(art.render('message-header', 'fallback'), 'fallback');
  assert.equal(art.messagePosition(), undefined);
});

test('every catalog entry is editable and validates its documented tokens and limits', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assert.equal(catalog.length, stringDefaults.size);
  for (const [key, source] of catalog) {
    assert.match(key, /^[a-z0-9_]+$/);
    assert.doesNotThrow(() => store.setString(key, source), key);
    assert.equal(displayString(store, key), source);
  }
  for (const source of ['|24no', '|99no', '|00|01', '|11' + 'x'.repeat(161),
    'x'.repeat(513), '|{UNKNOWN}', 'bad\r\nline']) {
    assert.throws(() => store.setString('main_prompt', source), InputError);
  }
  store.setString('main_prompt', '||24 literal |11color|07 ');
  assert.equal(plainText(ui(store, 'main_prompt')), '|24 literal color ');
  store.setString('main_prompt', '|01'.repeat(170) + 'AB');
  assert.equal(plainText(ui(store, 'main_prompt')), 'AB');
  assert.ok(String(ui(store, 'main_prompt')).length < 8192);
});

test('colored strings persist, reset, and customize safe errors without changing default error messages', t => {
  const path = mkdtempSync(join(tmpdir(), 'nocturno-strings-'));
  const file = join(path, 'strings.sqlite');
  let store = new Store(file);
  store.setString('error_invalid_handle_or_password', '|12Access denied.|07');
  store.close();
  store = new Store(file);
  t.after(() => { store.close(); rmSync(path, { recursive: true, force: true }); });
  const error = new InputError('Invalid handle or password.');
  assert.equal(error.message, 'Invalid handle or password.');
  assert.equal(plainText(errorText(store, error)), 'Access denied.');
  store.resetString(error.stringKey);
  assert.equal(plainText(errorText(store, error)), error.message);
});

test('colored substitutions respect the actual expanded ANSI output budget', t => {
  const path = directory(t);
  writeTemplate(path, 'main', '|UH'.repeat(100));
  const art = new Presentation(path);
  assert.throws(() => art.render('main', '', {
    USERNAME: pipeText('|01'.repeat(169) + 'X')
  }), /Expanded ANSI file is too large/);
});

test('long colorized lightbar footers stay inside 80x24 without scrolling', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const key of ['selection', 'main_prompt', 'screens_arrows_enter_help',
    'transport_local_short', 'screens_never_reuse_passwords']) {
    store.setString(key, '|11' + 'X'.repeat(160));
  }
  const view = { store, presentation: new Presentation(samples), values: { BBSNAME: 'Test' },
    strings: { selection: ui(store, 'selection'), main_prompt: ui(store, 'main_prompt') } };
  for (const frame of [loginMatrix('Test', false, view), mainMenu('Test', 'Caller', 1, view)]) {
    for (const immediate of [false, true]) {
      assert.equal(terminal(frame, { immediate, wrapControl: false }).scrolls, 0);
    }
  }
});

test('optional templates fall back, expand supported sanitized values once and normalize CRLF', t => {
  const path = directory(t);
  const fallback = new Presentation(join(path, 'missing'));
  assert.equal(fallback.render('main', 'built-in'), 'built-in');
  writeTemplate(path, 'main', '\x1b[36m|BN\n|UH\r|ND\r\n|DA');
  const art = new Presentation(path);
  const rendered = art.render('main', 'unused', {
    BBSNAME: '|UH', USERNAME: 'Caller\x1b[2J', NODE: 2, DATE: 'today'
  });
  assert.ok(terminal(rendered).text.includes('|UH'));
  assert.ok(terminal(rendered).text.includes('Caller?[2J'));
  assert.ok(!rendered.includes('Caller\x1b'));
  assert.ok(!rendered.replaceAll('\r\n', '').includes('\n'));
  assert.equal(art.render('welcome', 'default'), 'default');
});

test('each documented screen accepts its own tokens and rejects unsupported placeholders', t => {
  const path = directory(t);
  for (const [screen, tokens] of screenTokens) {
    writeTemplate(path, screen, tokens.filter(token => token !== 'BODY').map(mciCode).join(' '));
  }
  const art = new Presentation(path);
  for (const [screen, tokens] of screenTokens) {
    const values = Object.fromEntries(tokens.map(token => [token, 'value']));
    assert.ok(!art.render(screen, '', values).includes('|{'));
  }
  writeTemplate(path, 'main', '|{MESSAGESUBJECT}');
  assert.throws(() => new Presentation(path), /Unsupported MCI code/);
});

test('templates reject oversized, expanding, non-regular and unsafe terminal input', t => {
  const path = directory(t);
  for (const source of ['a'.repeat(16385), '|UH'.repeat(300),
    '\x1b]0;title\x07', '\xff', '\t', '\ufeffhello', '\x1b[6n']) {
    writeTemplate(path, 'main', source === '\xff' ? Buffer.from([255]) : source);
    assert.throws(() => new Presentation(path), InputError);
  }
  rmSync(join(path, 'main.ans'));
  // Isolated fixture deliberately uses a directory in place of a template file.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(join(path, 'main.ans'));
  assert.throws(() => new Presentation(path));
});

test('display strings preserve prompt spacing, validate keys and reset defaults', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setString('main_prompt', 'Your command: ');
  assert.equal(displayString(store, 'main_prompt'), 'Your command: ');
  store.setString('posted', 'Saved #|{MESSAGEID}');
  assert.equal(displayString(store, 'posted', { MESSAGEID: 42 }), 'Saved #42');
  for (const [key, value] of [['unknown', 'text'], ['main_prompt', '|UH'],
    ['posted', '|UH'], ['goodbye', '\x1b[2J'], ['goodbye', ''], ['goodbye', 'x'.repeat(161)]]) {
    assert.throws(() => store.setString(key, value), InputError);
  }
  store.resetString('main_prompt');
  assert.equal(displayString(store, 'main_prompt'), '|07Main command: |07');
});

test('all artwork templates reject unknown codes, unsafe controls and malformed metadata', t => {
  const path = directory(t);
  const record = Buffer.alloc(128);
  record.write('SAUCE00');
  record[104] = 1;
  for (const screen of screenTokens.keys()) {
    for (const value of ['~XY', '\x1b]0;title\x07', '\t', '\x7f', '\x1b[6n', '\ufeffBOM', '\xff']) {
      writeTemplate(path, screen, value === '\xff' ? Buffer.from([255]) : value);
      assert.throws(() => new Presentation(path), InputError);
    }
    writeTemplate(path, screen, Buffer.concat([Buffer.from('art\x1a'), record]));
    assert.throws(() => new Presentation(path), /Invalid SAUCE/);
    rmSync(join(path, `${screen}.ans`));
  }
});

test('all artwork templates preserve CP437 bytes while stripping valid SAUCE, EOF and NUL padding', t => {
  const path = directory(t);
  const record = Buffer.alloc(128);
  record.write('SAUCE00');
  const source = Buffer.from([0x58, 0x0a, 0x1b, 0x5b, 0x33, 0x36, 0x6d, 0xdb, 0xb0, 0xb2, 0x00, 0x0a, 0x1a]);
  for (const screen of screenTokens.keys()) {
    writeTemplate(path, screen, Buffer.concat([source, record]));
    const rendered = new Presentation(path).render(screen, '');
    assert.ok(rendered.includes('\xdb\xb0\xb2'), screen);
    assert.ok(rendered.includes('\r\n'), screen);
    assert.ok(!rendered.includes('SAUCE00'));
    assert.ok(!rendered.includes('\x1a'));
    assert.ok(!rendered.includes('\0'));
  }
});

test('login highlights preserve borders across color-separated padding on local and classic clients', t => {
  const path = directory(t);
  const lines = Array(22).fill('\x1b[0;32;40m' + '\xb2'.repeat(80));
  for (let index = 0; index < loginChoices.length; index++) {
    lines[index + 4] = '\x1b[0;1;32;42m' + '\xdb'.repeat(5) + '\x1b[0;37;40m ' +
      `|{CHOICE${index + 1}}    \x1b[0;90;40m  \x1b[0;97;40m` + ' '.repeat(18) +
      '\x1b[0;1;32;42m' + '\xdb'.repeat(4) + '\x1b[0m';
  }
  const source = lines.join('\r\n') + '\r\n\r\n\x1b[0m \r\n'.repeat(5);
  writeTemplate(path, 'loginmatrix', Buffer.from(source, 'latin1'));
  const presentation = new Presentation(path);
  const reference = terminal(lines.join('\r\n').replace(/\|\{CHOICE[1-5]\}/g, '   '));
  const view = { presentation, values: {}, strings: { selection: 'Selection: ' } };
  for (let selected = 0; selected < loginChoices.length; selected++) {
    const frame = loginMatrix('Test', false, view, selected);
    for (const immediate of [false, true]) {
      const rendered = terminal(frame, { immediate, modernColors: false, wrapControl: false,
        brightBackground: false, inverseControl: false });
      assert.equal(rendered.scrolls, 0);
      for (let row = 0; row < 22; row++) {
        for (let column = 0; column < 80; column++) {
          const index = row - 4;
          const label = loginChoices[index]?.[1];
          if (label && column >= 6 && column < 6 + label.length) {
            assert.deepEqual(rendered.cells[row][column], {
              char: label[column - 6], fg: index === selected ? 15 : 7, bg: index === selected ? 4 : 0
            });
          } else {
            assert.deepEqual(rendered.cells[row][column], reference.cells[row][column], `art cell ${row + 1},${column + 1}`);
          }
        }
      }
    }
    let localOutput = '';
    const local = new LocalTerminal({ write: text => { localOutput += text; } });
    local.write(frame);
    const localScreen = rgbTerminal(localOutput);
    assert.equal(localScreen.scrolls, 0);
    for (let index = 0; index < loginChoices.length; index++) {
      const row = localScreen.cells[index + 4];
      assert.equal(row[6].fg, index === selected ? '#ffffff' : '#aaaaaa');
      assert.equal(row[6].bg, index === selected ? '#0000aa' : '#000000');
      assert.deepEqual(row.slice(33, 37).map(cell => [cell.char, cell.fg, cell.bg]),
        Array.from({ length: 4 }, () => [terminalText('\xdb'), '#55ff55', '#00aa00']));
    }
  }
});

test('login labels clip to blank artwork space and the screen edge instead of moving glyphs', t => {
  const path = directory(t);
  writeTemplate(path, 'loginmatrix', '\x1b[1;1H|{CHOICE2} \x1b[0;1;32;42mX\x1b[2;75H|{CHOICE1}   ');
  const presentation = new Presentation(path);
  const frame = presentation.render('loginmatrix', '', {}, 1);
  const screen = terminal(frame, { modernColors: false, inverseControl: false });
  assert.equal(screen.cells[0].slice(0, 4).map(cell => cell.char).join(''), 'Appl');
  assert.deepEqual(screen.cells[0][4], { char: 'X', fg: 10, bg: 2 });
  assert.equal(screen.cells[1].slice(74, 79).map(cell => cell.char).join(''), 'Login');
  const fallback = terminal(loginMatrix('Test', false, undefined, 1), { inverseControl: false });
  const selectedRow = fallback.cells.find(row => row.map(cell => cell.char).join('').includes('[N] Apply'));
  assert.equal(selectedRow[2].fg, 15);
  assert.equal(selectedRow[2].bg, 4);
});

test('bundled ANSI examples fit 80 columns at maximum field lengths', () => {
  const art = new Presentation(samples);
  const values = {
    BBSNAME: 'B'.repeat(40), USERNAME: 'U'.repeat(24), NODE: 1234567890,
    DATE: '2026-10-29 20:00 UTC', BASENAME: 'B'.repeat(40), BASEID: 100,
    PAGE: 10000, MESSAGEID: 100000, MESSAGEAUTHOR: 'A'.repeat(24),
    MESSAGESUBJECT: 'S'.repeat(60), MESSAGEDATE: '2026-10-29 20:00'
  };
  for (const screen of ['main', 'message-header', 'doors', 'compose']) {
    // ANSI sequences are deliberately included in these trusted sample files.
    // eslint-disable-next-line no-control-regex
    const plain = art.render(screen, '', values).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.ok(plain.split('\r\n').every(line => line.length <= 80), `${screen} exceeds 80 columns`);
  }
});

test('bundled legacy-style examples expand only allowed tokens and preserve selection colors', () => {
  const art = new Presentation(samples);
  const matrix = art.render('loginmatrix', '', {}, 1);
  assert.ok(matrix.includes('Apply for an account'));
  const [choiceRow, choiceColumn] = art.position('loginmatrix', '|{CHOICE2}').slice(2, -1).split(';').map(Number);
  assert.equal(terminal(matrix).cells[choiceRow - 1][choiceColumn - 1].fg, 15);
  assert.equal(terminal(matrix).cells[choiceRow - 1][choiceColumn - 1].bg, 4);
  assert.ok(!matrix.includes('|{CHOICE1}'));
  assert.ok(terminal(matrix).cells[0].some(cell => cell.char.charCodeAt(0) >= 128));
  const login = art.render('login', '', { LOGINSTATUS: 'Checking', LOGINHELP: 'Safe help' });
  assert.ok(login.includes('Checking'));
  assert.ok(login.includes('Safe help'));
  assert.ok(art.position('login', '|{LOGINHANDLE}'));
  assert.ok(art.position('login', '|{LOGINPASSWORD}'));
  const menu = art.render('main', '', {}, 15);
  const menuRow = terminal(menu).cells.find(cells => cells.map(cell => cell.char).join('').includes('goodbye'));
  const menuColumn = menuRow.map(cell => cell.char).join('').indexOf('goodbye');
  assert.equal(menuRow[menuColumn].fg, 15);
  assert.equal(menuRow[menuColumn].bg, 4);
  const header = art.render('message-header', '', {
    MESSAGEAUTHOR: 'Caller\x1b[2J', RECIPIENT: 'All', MESSAGESUBJECT: 'Subject',
    MESSAGEID: 42, MESSAGEDATE: '2026-11-02 18:00', BASENAME: 'General', TIMELEFT: 55
  });
  assert.ok(header.includes('Caller?[2J'));
  assert.ok(header.includes('2026-11-02'));
  assert.ok(header.includes('18:00'));
  assert.ok(!header.includes('|{MESSAGEAUTHOR}'));
  const literalHeader = art.render('message-header', '', {
    MESSAGESUBJECT: '|UH', USERNAME: '|{MESSAGEAUTHOR}', MESSAGEAUTHOR: '|BN', BBSNAME: 'Not substituted'
  });
  assert.ok(literalHeader.includes('|UH'));
  assert.ok(literalHeader.includes('|BN'));
  for (const screen of ['welcome', 'stats', 'main']) {
    const output = art.render(screen, '', {});
    assert.ok(!output.includes('SAUCE00'));
    assert.ok(!output.includes('\0'));
    assert.ok(!output.includes('\x1a'));
    assert.ok(!output.replaceAll('\r\n', '').includes('\n'));
  }
});

test('bundled lightbars retain all choices without scrolling an 80x24 terminal', () => {
  const presentation = new Presentation(samples);
  const view = { presentation, values: { BBSNAME: 'B'.repeat(40), USERNAME: 'U'.repeat(24) },
    strings: { selection: 'Selection: ', main_prompt: 'Main command: ' } };
  for (const [frame, labels] of [
    [loginMatrix('B'.repeat(40), false, view, 4), ['Login', 'Apply for an account', 'Check application', 'Message sysop', 'Hangup']],
    [mainMenu('B'.repeat(40), 'U'.repeat(24), 1, view, 15), ['email', 'user config', 'message menu', 'qwk mail menu', 'goodbye']]
  ]) {
    for (const immediate of [false, true]) {
      const rendered = terminal(frame, { immediate, wrapControl: false, modernColors: false });
      assert.equal(rendered.scrolls, 0);
      for (const label of labels) assert.ok(rendered.text.includes(label), `${label} must remain visible`);
    }
  }
});

test('login notices keep one prompt and preserve artwork, colors and footer bounds', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const view = { store, presentation: new Presentation(samples), values: {},
    strings: { selection: ui(store, 'selection') } };
  const artwork = terminal(loginMatrix('Test', false, view));
  for (const notice of [pipeText('|12Password rejected.'), pipeText('|10' + 'X'.repeat(160)),
    'Literal |04value\x1b[2J']) {
    const frame = loginMatrix('Test', false, view, 0, notice);
    for (const immediate of [false, true]) {
      const screen = terminal(frame, { immediate, modernColors: false, wrapControl: false });
      assert.equal(screen.scrolls, 0);
      assert.deepEqual(screen.cells.slice(0, 22), artwork.cells.slice(0, 22));
      assert.equal(screen.text.split('Selection:').length - 1, 1);
      assert.equal(screen.cells[22].map(cell => cell.char).join('').trimEnd(),
        plainText(safeText(notice).slice(0, 79)));
      assert.ok(screen.cells[23].map(cell => cell.char).join('').includes('Selection:'));
      if (plainText(notice).startsWith('Password')) assert.equal(screen.cells[22][0].fg, 9);
      if (plainText(notice).startsWith('X')) {
        assert.equal(screen.cells[22][78].fg, 10);
        assert.equal(screen.cells[22][79].char, ' ');
      }
    }
  }
  const fallback = loginMatrix('Test', false, undefined, 0, pipeText('|12Password rejected.'));
  assert.equal(plainText(fallback).split('Selection:').length - 1, 1);
  assert.ok(plainText(fallback).endsWith('Password rejected.\r\nSelection: '));
});

test('main artwork and generated fallback default to Messages with matching grid positions', t => {
  const presentation = new Presentation(directory(t));
  const fallback = terminal(mainMenu('Test', 'Caller', 1, { presentation, values: {}, strings: { main_prompt: 'Main command: ' } }),
    { immediate: true, modernColors: false, wrapControl: false });
  assert.equal(fallback.scrolls, 0);
  for (const [frame, label] of [
    [mainMenu('Test', 'Caller', 1), '[M] Message Menu'],
    [new Presentation(samples).render('main', '', {}), 'message menu']
  ]) {
    const result = terminal(frame, { modernColors: false });
    const row = result.cells.find(cells => cells.map(cell => cell.char).join('').includes(label));
    const column = row.map(cell => cell.char).join('').indexOf(label);
    assert.ok(column < 25, 'Messages belongs in the leftmost column');
    assert.equal(row[column].fg, 15);
    assert.equal(row[column].bg, 4);
  }
});

test('classic BBS terminals retain DOS colors and all matrix artwork rows', () => {
  const presentation = new Presentation(samples);
  const source = presentation.templates.get('loginmatrix');
  const reference = terminal(source.replace(/\|\{CHOICE[1-5]\}/g, '   '));
  const choices = ['|{CHOICE1}', '|{CHOICE2}', '|{CHOICE3}', '|{CHOICE4}', '|{CHOICE5}'].map(marker =>
    presentation.position('loginmatrix', marker).slice(2, -1).split(';').map(Number));
  const view = { presentation, values: {}, strings: { selection: 'Selection: ', main_prompt: 'Main command: ' } };
  for (const immediate of [false, true]) {
    for (const wrapControl of [false, true]) {
      const rendered = terminal(loginMatrix('Nocturno BBS', false, view, 2),
        { immediate, wrapControl, modernColors: false });
      assert.equal(rendered.scrolls, 0, 'art must not scroll before positioning its footer');
      assert.deepEqual(rendered.cells[0], reference.cells[0]);
      for (let row = 0; row < 22; row++) {
        for (let column = 0; column < 80; column++) {
          if (choices.some(([choiceRow, choiceColumn]) =>
            row === choiceRow - 1 && column >= choiceColumn - 1 && column < choiceColumn + 21)) continue;
          assert.deepEqual(rendered.cells[row][column], reference.cells[row][column], `art cell ${row + 1},${column + 1}`);
        }
      }
      assert.ok(rendered.text.includes('Check application'));
      assert.ok(rendered.text.includes('Never reuse passwords.'));
      assert.ok(rendered.text.includes('Selection:'));
    }
  }
});

test('every main lightbar selection has DOS-safe contrast without modifying surrounding artwork', () => {
  const presentation = new Presentation(samples);
  // Fixed bundled artwork, never a caller-selected filesystem path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(new URL('../examples/ansi/main.ans', import.meta.url)).toString('latin1');
  const reference = terminal(String(pipeText(source, Infinity, undefined, true)));
  const view = { presentation, values: {}, strings: { main_prompt: 'Main command: ' } };
  const labels = mainChoices.map(([, label]) => {
    const row = reference.cells.findIndex(line => line.map(cell => cell.char).join('').toLowerCase().includes(label.toLowerCase()));
    const text = reference.cells[row].map(cell => cell.char).join('');
    const column = text.toLowerCase().indexOf(label.toLowerCase());
    return { label: text.slice(column, column + label.length), row, column };
  });
  const widths = [0, 1, 2].map(column =>
    Math.max(...mainChoiceGrid.map(row => row[column] === null ? 0 : mainChoices[row[column]][1].length)) + 2);
  assert.deepEqual(widths, [14, 15, 15]);
  for (const immediate of [false, true]) {
    for (const modernColors of [false, true]) {
      for (let selected = 0; selected < mainChoices.length; selected++) {
        const rendered = terminal(mainMenu('Nocturno BBS', 'Caller', 1, view, selected),
          { immediate, modernColors, wrapControl: false, brightBackground: false });
        assert.equal(rendered.scrolls, 0);
        for (const [index, { label, row, column }] of labels.entries()) {
          for (let character = 0; character < label.length; character++) {
            assert.deepEqual(rendered.cells[row][column + character],
              { char: label[character], fg: index === selected ? 15 : 8, bg: index === selected ? 4 : 0 },
              `selection ${selected}, label ${label}, character ${character}`);
          }
        }
        const active = labels[selected];
        const gridColumn = mainChoiceGrid.find(row => row.includes(selected)).indexOf(selected);
        const width = widths[gridColumn];
        const start = active.column - 1;
        const text = ` ${active.label.padEnd(width - 2)} `;
        assert.deepEqual(rendered.cells[active.row].slice(start, start + width),
          [...text].map(char => ({ char, fg: 15, bg: 4 })), 'bar width and padding must match its column');
        assert.notEqual(rendered.cells[active.row][start - 1].bg, 4);
        assert.notEqual(rendered.cells[active.row][start + width].bg, 4);
        for (let row = 0; row < 23; row++) {
          for (let column = 0; column < 80; column++) {
            if (labels.some(item => item.row === row && column >= item.column && column < item.column + item.label.length)) continue;
            if (row === active.row && column >= start && column < start + width) continue;
            assert.deepEqual(rendered.cells[row][column], reference.cells[row][column], `art cell ${row + 1},${column + 1}`);
          }
        }
      }
    }
  }
});

test('main artwork matches every label case-insensitively and preserves its original lettering', t => {
  const path = directory(t);
  for (const style of [
    label => label.toLowerCase(),
    label => label.toUpperCase(),
    label => label,
    label => [...label].map((letter, index) => index % 2 ? letter.toUpperCase() : letter.toLowerCase()).join('')
  ]) {
    const labels = mainChoices.map(([, label]) => style(label));
    const source = mainChoiceGrid.map(row => row.map(index => index === null ? ' '.repeat(25) :
      ` \x1b[32m${labels[index]}${' '.repeat(24 - labels[index].length)}`).join('')).join('\r\n');
    writeTemplate(path, 'main', source);
    const presentation = new Presentation(path);
    const reference = terminal(source);
    for (let selected = 0; selected < mainChoices.length; selected++) {
      const rendered = terminal(presentation.render('main', '', {}, selected), { modernColors: false });
      assert.equal(rendered.scrolls, 0);
      for (const [index, label] of labels.entries()) {
        const row = mainChoiceGrid.findIndex(items => items.includes(index));
        const column = mainChoiceGrid[row].indexOf(index) * 25 + 1;
        assert.deepEqual(rendered.cells[row].slice(column, column + label.length),
          [...label].map(char => ({ char, fg: index === selected ? 15 : 8, bg: index === selected ? 4 : 0 })));
        assert.equal(reference.cells[row][column].char, rendered.cells[row][column].char);
      }
    }
  }
});

test('generated main menu defaults use proper capitalization, including acronyms', () => {
  const frame = plainText(mainMenu('Test', 'Caller', 1));
  for (const [key, label] of mainChoices) assert.ok(frame.includes(`[${key}] ${label}`));
  for (const label of ['Email', 'User Config', 'Message Menu', 'QWK Mail Menu', 'BBS List', 'Note to Sysop']) {
    assert.ok(frame.includes(label));
  }
});

test('fallback lightbars use padded column widths rather than highlighting the entire grid cell', () => {
  const widths = [18, 19, 19];
  for (let selected = 0; selected < mainChoices.length; selected++) {
    const [key, label] = mainChoices[selected];
    const gridColumn = mainChoiceGrid.find(row => row.includes(selected)).indexOf(selected);
    const text = `[${key}] ${label}`;
    for (const immediate of [false, true]) {
      const rendered = terminal(mainMenu('Test', 'Caller', 1, undefined, selected),
        { immediate, modernColors: false, wrapControl: false });
      assert.equal(rendered.scrolls, 0);
      const row = rendered.cells.find(cells => cells.map(cell => cell.char).join('').includes(text));
      const start = gridColumn * 25;
      assert.deepEqual(row.slice(start, start + widths[gridColumn]),
        [...` ${text.padEnd(widths[gridColumn] - 2)} `].map(char => ({ char, fg: 15, bg: 4 })));
      assert.notEqual(row[start + widths[gridColumn]].bg, 4);
    }
  }
});

test('padded custom lightbars preserve neighboring glyphs, SGR state and the screen edge', t => {
  const path = directory(t);
  writeTemplate(path, 'main', '\x1b[32mX \x1b[31memail\x1b[36m Y');
  const framed = terminal(new Presentation(path).render('main', '', {}, 0), { modernColors: false });
  assert.ok(framed.text.startsWith('X email Y'));
  assert.deepEqual(framed.cells[0][0], { char: 'X', fg: 2, bg: 0 });
  assert.deepEqual(framed.cells[0][1], { char: ' ', fg: 15, bg: 4 });
  assert.deepEqual(framed.cells[0][7], { char: ' ', fg: 15, bg: 4 });
  assert.deepEqual(framed.cells[0][8], { char: 'Y', fg: 6, bg: 0 });
  writeTemplate(path, 'main', '\x1b[24;1H|BN goodbye');
  for (const immediate of [false, true]) {
    const edge = terminal(new Presentation(path).render('main', '', { BBSNAME: 'X'.repeat(71) }, 15),
      { immediate, modernColors: false, wrapControl: false });
    assert.equal(edge.scrolls, 0);
    assert.equal(edge.cells[23][71].bg, 4);
    assert.equal(edge.cells[23][78].bg, 4);
    assert.equal(edge.cells[23][79].bg, 0);
  }
});

test('message text begins at |{BODY} without stray time-left values or duplicate fitting fields', () => {
  const presentation = new Presentation(samples);
  const row = { id: 1, handle: 'Caller', subject: 'Short subject',
    body: Array.from({ length: 20 }, (_, index) => `Body line ${index + 1}`).join('\n'), created_at: '2026-11-02T18:00:00Z' };
  const view = { presentation, values: { MESSAGEAUTHOR: row.handle, MESSAGESUBJECT: row.subject,
    MESSAGEID: row.id, MESSAGEDATE: '2026-11-02 18:00', BASENAME: 'General', TIMELEFT: 59 } };
  for (const immediate of [false, true]) {
    for (const wrapControl of [false, true]) {
      const rendered = terminal(readMessage(row, 0, 'BBS', view), { immediate, wrapControl, modernColors: false });
      assert.equal(rendered.scrolls, 0);
      assert.equal(rendered.cells[13].map(cell => cell.char).join('').trim(), 'Body line 1');
      assert.equal(rendered.cells[21].map(cell => cell.char).join('').trim(), 'Body line 9');
      assert.ok(rendered.text.includes('Page 1/3'));
      assert.ok(rendered.cells[23].map(cell => cell.char).join('').includes('[Q] Message list:'));
      assert.ok(!rendered.text.includes('59'));
      assert.equal(rendered.text.split(row.subject).length - 1, 1);
      assert.equal(rendered.text.split('General').length - 1, 1);
    }
  }
});

test('message pages preserve full overflowing fields, every body line and the header artwork', t => {
  const path = directory(t);
  writeTemplate(path, 'message-header',
    'From: |{MESSAGEAUTHOR:24}\r\nTo: |{RECIPIENT:24}\r\n' +
    'Base: |{BASENAME:32}\r\nSubject: |{MESSAGESUBJECT:50}\r\n' +
    '\x1b[14;1H|{BODY}');
  const presentation = new Presentation(path);
  const row = { id: 1, handle: 'Caller', subject: 'S'.repeat(60),
    body: 'X'.repeat(160) + '\n\n' + Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n') };
  const view = { presentation, values: { MESSAGEAUTHOR: row.handle, MESSAGESUBJECT: row.subject,
    MESSAGEID: row.id, MESSAGEDATE: '2026-11-02 18:00', BASENAME: 'B'.repeat(40) } };
  const layout = messageLayout(view, row);
  assert.equal(layout.pageSize, 7);
  const expected = [...Array(2).fill('X'.repeat(76)), 'X'.repeat(8), '',
    ...Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`)];
  const { pages } = messagePage(row.body, 0, layout.pageSize, layout.width);
  const reference = terminal(presentation.render('message-header', '', view.values));
  for (const immediate of [false, true]) {
    const displayed = [];
    for (let page = 0; page < pages; page++) {
      const rendered = terminal(readMessage(row, page, 'BBS', view), { immediate, wrapControl: false, modernColors: false });
      assert.equal(rendered.scrolls, 0);
      assert.deepEqual(rendered.cells.slice(0, 12), reference.cells.slice(0, 12));
      assert.equal(rendered.cells[13].map(cell => cell.char).join('').trim(), `Base: ${view.values.BASENAME}`);
      assert.equal(rendered.cells[14].map(cell => cell.char).join('').trim(), `Subject: ${row.subject}`);
      const count = Math.min(layout.pageSize, expected.length - page * layout.pageSize);
      for (let index = 0; index < count; index++) {
        displayed.push(rendered.cells[15 + index].map(cell => cell.char).join('').trimEnd().slice(2));
      }
      assert.ok(rendered.text.includes(`Page ${page + 1}/${pages}`));
    }
    assert.deepEqual(displayed, expected);
  }
});

test('reply context retains color without changing template body pagination or private-mail actions', () => {
  const presentation = new Presentation(samples);
  const row = { id: 2, handle: 'Caller', subject: 'Re: Original', reply_to: 1,
    body: Array.from({ length: 20 }, (_, i) => `Reply line ${i + 1}`).join('\n') };
  const view = { presentation, values: { MESSAGEAUTHOR: row.handle, MESSAGESUBJECT: row.subject,
    MESSAGEID: row.id, MESSAGEDATE: '2026-11-02 18:00', BASENAME: 'General' } };
  const layout = messageLayout(view, row);
  assert.equal(layout.pageSize, 9);
  for (let page = 0; page < 3; page++) {
    const screen = terminal(readMessage(row, page, 'BBS', view), { modernColors: false });
    assert.equal(screen.scrolls, 0);
    assert.ok(screen.text.includes(`In reply to message #1  Page ${page + 1}/3`));
    assert.match(screen.text, /\[R\] Reply/);
    assert.equal(screen.cells[22][0].fg, 14);
    const expected = messagePage(row.body, page, layout.pageSize, layout.width).body_lines;
    assert.deepEqual(screen.cells.slice(13, 13 + expected.length)
      .map(line => line.map(cell => cell.char).join('').trim()), expected);
  }
  const mail = terminal(readMessage({ ...row, reply_to: undefined }, 0, 'BBS', view, true));
  assert.doesNotMatch(mail.text, /\[R\] Reply/);
  assert.match(mail.text, /\[Q\] Inbox/);
});

test('legacy message-header templates still show generated reply context', t => {
  const path = directory(t);
  writeTemplate(path, 'message-header', 'Legacy header: |{MESSAGESUBJECT}\r\n');
  const row = { id: 2, subject: 'Re: Original', body: 'Reply body', reply_to: 1 };
  const view = { presentation: new Presentation(path), values: { MESSAGESUBJECT: row.subject } };
  const screen = terminal(readMessage(row, 0, 'BBS', view));
  assert.match(screen.text, /Legacy header: Re: Original/);
  assert.match(screen.text, /In reply to message #1/);
  assert.match(screen.text, /Reply body/);
  assert.match(screen.text, /\[R\] Reply/);
  assert.equal(screen.scrolls, 0);
});

test('message templates without |{BODY} start text after the art and reject layouts without body space', t => {
  const path = directory(t);
  writeTemplate(path, 'message-header', 'Header: |{MESSAGESUBJECT}\r\n');
  const presentation = new Presentation(path);
  const row = { id: 1, subject: 'Short', body: 'Body' };
  const view = { presentation, values: { MESSAGESUBJECT: row.subject, BASENAME: 'General' } };
  assert.deepEqual(presentation.messagePosition(), { row: 2, column: 1 });
  const frame = terminal(readMessage(row, 0, 'BBS', view));
  assert.equal(frame.scrolls, 0);
  assert.ok(frame.text.includes('Body'));
  for (const position of ['21;1', '14;78', '24;1']) {
    writeTemplate(path, 'message-header', `\x1b[${position}H|{BODY}`);
    assert.throws(() => new Presentation(path), /must leave room for message text/);
  }
});

test('lightbar colors restore extended-color state and remain inside the expanded-output budget', t => {
  const path = directory(t);
  const colors = '\x1b[38;5;92;48;2;1;2;3m';
  writeTemplate(path, 'main', `${colors}email After`);
  const frame = new Presentation(path).render('main', '');
  assert.ok(frame.includes(`email\x1b[0m${colors} After`));
  assert.ok(frame.length <= 32768);
  writeTemplate(path, 'main', '\x1b[38;5;92m'.repeat(500) + mainChoices.map(([, label]) => label).join(' '));
  assert.throws(() => new Presentation(path), /Expanded ANSI file is too large/);
});

test('classic color conversion preserves bright/dim transitions and selective attribute resets', t => {
  const path = directory(t);
  const source = '\x1b[92;40mG\x1b[32mD\x1b[1;32mB\x1b[0;90;47mX\x1b[37;40mW\x1b[7mR\x1b[27mN';
  writeTemplate(path, 'main', source);
  const rendered = new Presentation(path).render('main', '');
  assert.deepEqual(terminal(rendered, { modernColors: false }).cells[0].slice(0, 7),
    terminal(source).cells[0].slice(0, 7));
});

test('extended-color templates retain their original SGR rather than being misinterpreted as DOS attributes', t => {
  const path = directory(t);
  const source = '\x1b[38;5;92mPalette\x1b[48;2;90;91;92mRGB';
  writeTemplate(path, 'main', source);
  assert.ok(new Presentation(path).render('main', '').includes(source));
});

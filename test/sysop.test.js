import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.js';
import { SysopConsole, startSysopConsole } from '../src/sysop.js';
import { Session } from '../src/session.js';
import { plainText, pipeText } from '../src/strings.js';
import { sysopFooter, sysopInput } from '../src/screens.js';
import { terminal } from './helpers/ansi-terminal.js';

function setup(t, { rows } = {}) {
  const store = new Store(':memory:');
  store.initSettings('Test BBS');
  t.after(() => store.close());
  const userId = store.createUser('Caller', 'test-hash');
  const messageId = store.post(userId, 'Test subject', 'First line\nSecond line');
  let output = '', quits = 0;
  const errors = [], disconnected = [], files = [], resolved = [];
  const bbs = {
    nodes: () => [{ id: 1, handle: 'Caller', state: 'main' }],
    endpoints: ['TELNET (local only) 127.0.0.1:2323'],
    disconnectNode: id => disconnected.push(id),
    setUserDisabled: (id, disabled) => store.setUserDisabled(id, disabled),
    deleteUser: id => store.deleteUser(id),
    transfers: {
      sysopFiles: () => [{ id: 3, name: 'TEST.TXT', size: 12, approved: 0, handle: 'Caller' }],
      approve: (id, approved) => files.push(['approve', id, approved]),
      remove: id => files.push(['remove', id])
    },
    community: {
      notifications: () => resolved.length ? [] : [{ id: 8, kind: 'note', node: 1, created_at: '2026-11-02T18:00:00Z' }],
      notification: () => ({ id: 8, kind: 'note', node: 1, created_at: '2026-11-02T18:00:00Z',
        body_lines: ['Private guest request'], pages: 1, page: 0 }),
      resolveNotification: id => resolved.push(id)
    }
  };
  const options = { store, bbs, output: { rows, write: text => { output += text; } },
    onQuit: () => { quits++; }, onError: error => errors.push(error), uptime: () => 10 };
  const console = new SysopConsole(options);
  return { store, userId, messageId, console, options, errors, disconnected, files, resolved,
    output: () => output, quits: () => quits };
}

test('WFC routes to every working menu and returns without quitting', t => {
  const fixture = setup(t);
  const { console } = fixture;
  console.render();
  assert.ok(plainText(fixture.output()).includes('[S] System config'));
  for (const [command, view] of [['S', 'config'], ['U', 'users'], ['B', 'messages'], ['C', 'callers'], ['N', 'nodes']]) {
    console.handle(command);
    assert.equal(console.view, view);
    console.handle('Q');
    assert.equal(console.view, 'wfc');
  }
  assert.equal(fixture.quits(), 0);
  assert.deepEqual(fixture.errors, []);
});

for (const rows of [24, 25]) {
  test(`${rows}-row sysop polish aligns shortcuts, colors tables and keeps one reader prompt`, t => {
    const f = setup(t, { rows }), { console, store } = f;
    console.handle('S');
    let screen = terminal(f.output(), { rows });
    const shortcutRows = screen.cells.filter(row => row.map(cell => cell.char).join('').includes('[B] Create/list'));
    const accessRows = screen.cells.filter(row => row.map(cell => cell.char).join('').includes('[R] Roles'));
    assert.equal(shortcutRows.length, 1);
    assert.equal(accessRows.length, 1);
    assert.equal(shortcutRows[0][28].char, '[');
    assert.equal(accessRows[0][28].char, '[');
    assert.match(screen.text, /\[Q\] Return to WFC/);
    console.handle('R'); console.handle('V 1');
    screen = terminal(f.output(), { rows });
    const grant = screen.cells.find(row => row.map(cell => cell.char).join('').trim() === '1 General: 1 / 1');
    assert.equal(grant[2].fg, '#ffff55');
    assert.equal(grant[4].fg, '#ffffff');
    assert.equal(grant[13].fg, '#55ff55');
    console.handle('Q'); console.handle('Q'); console.handle('Q');
    const original = store.post(f.userId, 'S'.repeat(60), 'Parent body');
    const reply = store.post(f.userId, 'Re: Original', Array.from({ length: 14 }, (_, i) => `Reply row ${i + 1}`).join('\n'), 1, original);
    console.handle('B');
    screen = terminal(f.output(), { rows });
    assert.ok(screen.text.includes(`${'S'.repeat(39)}...`));
    const header = screen.cells.find(row => row.map(cell => cell.char).join('').includes('ID      From'));
    assert.equal(header[2].fg, '#55ffff');
    console.handle(String(reply));
    screen = terminal(f.output(), { rows });
    assert.equal(screen.text.split('[Q] Message list:').length - 1, 1);
    assert.doesNotMatch(screen.text, /\[R\] Reply/);
    assert.ok(screen.text.includes(`In reply to message #${original}`));
    const bodyLines = screen.cells.map(row => row.map(cell => cell.char).join('').trim());
    assert.ok(bodyLines.includes(`Reply row ${rows - 12}`));
    assert.ok(!bodyLines.includes(`Reply row ${rows - 11}`));
    console.handle('N');
    screen = terminal(f.output(), { rows });
    assert.match(screen.text, /Reply row 14/);
    assert.equal(screen.scrolls, 0);
    console.handle('Q'); console.handle('Q'); console.handle('A');
    screen = terminal(f.output(), { rows });
    assert.match(screen.text, /No entries on this page/);
    console.handle('Q');
    f.options.bbs.transfers.sysopFiles = () => [{ id: 3, base_id: 2, approved: 0, size: 4194304,
      name: 'LONG-FILENAME-FOR-INSPECTION.ZIP', handle: 'Caller' }];
    console.handle('F');
    screen = terminal(f.output(), { rows });
    const fileRow = screen.cells.find(row => row.map(cell => cell.char).join('').includes('LONG-FILENAME-FO...'));
    assert.equal(fileRow.slice(2, 8).map(cell => cell.char).join(''), '3     ');
    assert.equal(fileRow.slice(9, 13).map(cell => cell.char).join(''), '2   ');
    assert.equal(fileRow.slice(14, 22).map(cell => cell.char).join(''), 'PENDING ');
    assert.equal(fileRow.slice(23, 30).map(cell => cell.char).join(''), '4194304');
    assert.equal(fileRow.slice(31, 50).map(cell => cell.char).join(''), 'LONG-FILENAME-FO...');
    assert.equal(fileRow.slice(51, 57).map(cell => cell.char).join(''), 'Caller');
    assert.equal(fileRow[2].fg, '#ffff55');
    assert.equal(fileRow[9].fg, '#55ffff');
    assert.equal(fileRow[23].fg, '#55ff55');
    assert.equal(screen.scrolls, 0);
    console.handle('Q'); console.handle('R');
    screen = terminal(f.output(), { rows });
    const requestRows = screen.cells.map(row => row.map(cell => cell.char).join(''));
    const requestHeading = requestRows.findIndex(row => row.includes('ID      Kind  From'));
    assert.ok(requestHeading > 0);
    assert.match(requestRows[requestHeading + 1], /^ {2}8 {7}note {2}\(guest\) {19}1 {5}2026-11-02 18:00/);
    console.handle('Q'); console.handle('B'); console.handle('N');
    screen = terminal(f.output(), { rows });
    const emptyRows = screen.cells.map(row => row.map(cell => cell.char).join(''));
    assert.ok(emptyRows.findIndex(row => row.includes('ID      From')) <
      emptyRows.findIndex(row => row.includes('No entries on this page')));
    console.handle('Q'); console.handle('S'); console.handle('R');
    screen = terminal(f.output(), { rows });
    const roleRows = screen.cells.map(row => row.map(cell => cell.char).join(''));
    const roleHeading = roleRows.findIndex(row => row.includes('ID      Role'));
    assert.match(roleRows[roleHeading + 1], /^ {2}1 {7}Member {20}YES {3}YES/);
    console.handle('Q'); console.handle('Q');
    screen = terminal(f.output(), { rows });
    assert.match(screen.text, /WAITING FOR CALLERS/);
    assert.match(screen.text, /Up 00:00:10/);
    const prompt = screen.cells.find(row => row.map(cell => cell.char).join('').startsWith('[S/U/B/C/N/A/F/R/L] Command'));
    assert.equal(prompt[1].fg, '#ffff55');
    assert.equal(prompt[21].fg, '#aaaaaa');
    assert.deepEqual(f.errors, []);
  });
}

test('local roles, grants, file bases and user assignments require YES and fit the console', t => {
  const f = setup(t), { console, store, userId } = f;
  console.handle('S');
  console.handle('R');
  console.handle('C Trusted');
  assert.equal(store.access.roles().length, 1);
  console.handle('no');
  assert.equal(store.access.roles().length, 1);
  console.handle('C Trusted');
  console.handle('YES');
  const role = store.access.roles()[1].id;
  console.handle(`V ${role}`);
  assert.equal(console.view, 'role-detail');
  for (const command of ['G 1 1', 'M 1 1 1', 'F 1 1 1 0']) {
    console.handle(command);
    assert.ok(console.pending);
    console.handle('YES');
  }
  assert.equal(store.access.role(role).can_doors, 1);
  assert.equal(store.access.messagePermissions(role, 1).can_read, 1);
  assert.equal(store.access.filePermissions(role, 1).can_upload, 0);
  const screen = terminal(f.output());
  assert.equal(screen.scrolls, 0);
  assert.match(screen.text, /Message bases: read/);
  assert.match(screen.text, /File bases: list/);
  console.handle('Q');
  console.handle('Q');
  assert.equal(console.view, 'config');
  console.handle('F');
  console.handle('C Private files | Trusted downloads');
  assert.equal(store.access.fileBases().length, 1);
  console.handle('YES');
  assert.equal(store.access.fileBases()[1].name, 'Private files');
  console.handle('Q');
  console.handle('U');
  console.handle(String(userId));
  console.handle('8');
  console.handle(String(role));
  assert.equal(store.user(userId).role_id, 1);
  console.handle('no');
  console.handle('8');
  console.handle(String(role));
  console.handle('YES');
  assert.equal(store.user(userId).role_id, role);
  assert.match(terminal(f.output()).text, /\[8\] Role: 2 Trusted/);
  console.handle('Q');
  console.handle(`A ${userId} 1`);
  assert.equal(store.user(userId).role_id, role);
  console.handle('YES');
  assert.equal(store.user(userId).role_id, 1);
  assert.deepEqual(f.errors, []);
});

test('sysop cursors follow colored prompts across menus, fields and confirmations', t => {
  const fixture = setup(t);
  const { console, store } = fixture;
  for (const command of ['', 'S', 'A', '/abort', 'E', 'no', 'Q', 'U', 'Q', 'B', 'Q', 'Q']) {
    if (command) console.handle(command);
    else console.render();
    const prompt = plainText(console.prompt);
    const offset = prompt.length % 80 === 79 ? prompt.length + 1 : prompt.length;
    for (const size of [{ columns: 80, rows: 25 }, { columns: 120, rows: 40 }]) {
      const screen = terminal(fixture.output(), size);
      assert.equal(screen.row, 22 + Math.floor(offset / 80), command);
      assert.equal(screen.column, offset % 80, command);
      assert.equal(screen.cells.slice(22, 24).flatMap(row => row.slice(0, 80))
        .slice(0, prompt.length).map(cell => cell.char).join(''), prompt);
      assert.equal(screen.scrolls, 0);
    }
  }
  store.setString('screens_local_sysop_command', '|12Custom |14command: |07');
  console.handle('no');
  const screen = terminal(fixture.output());
  assert.equal(screen.row, 22);
  assert.equal(screen.column, 'Custom command: '.length);
  assert.equal(screen.cells[22][0].fg, '#ff5555');
  assert.equal(screen.cells[22][7].fg, '#ffff55');
  assert.deepEqual(fixture.errors, []);
});

test('sysop input respects visible prompt width and row boundaries without erasing prompts', () => {
  for (const length of [0, 20, 78, 79, 80, 81, 158, 159, 160]) {
    const prompt = pipeText('|11' + 'P'.repeat(length));
    const offset = length % 80 === 79 ? length + 1 : length;
    const row = 22 + Math.floor(offset / 80), column = offset % 80;
    const capacity = 79 - column;
    for (const size of [{ columns: 80, rows: 25 }, { columns: 120, rows: 40 }]) {
      const frame = sysopFooter('', prompt);
      let screen = terminal(frame, size);
      assert.equal(screen.row, row);
      assert.equal(screen.column, column);
      const edited = frame + sysopInput(prompt, 'A'.repeat(160)) + sysopInput(prompt, 'B');
      screen = terminal(edited, size);
      assert.equal(screen.scrolls, 0);
      assert.equal(screen.row, row);
      assert.equal(screen.column, column + 1);
      assert.equal(screen.cells[row][column].char, 'B');
      assert.ok(screen.cells[row].slice(column + 1, 80).every(cell => cell.char === ' '));
      const promptCells = screen.cells.slice(22, 24).flat().filter(cell => cell.char === 'P');
      assert.equal(promptCells.length, length);
      assert.ok(promptCells.every(cell => cell.fg === '#29b8db'));
      screen = terminal(frame + sysopInput(prompt, 'A'.repeat(160)), size);
      assert.equal(screen.column, 79);
      assert.equal(screen.cells[row].slice(column, column + capacity).map(cell => cell.char).join(''),
        'A'.repeat(capacity));
    }
  }
});

test('all sysop menu prompts, fields and confirmations remain visible on 80x24 terminals', t => {
  const fixture = setup(t, { rows: 24 });
  const { console, userId } = fixture;
  for (const command of ['', 'S', 'A', '/abort', 'E', 'no', 'R', 'V 1', 'Q', 'Q',
    'F', 'Q', 'T', 'E 1', '/abort', 'Q', 'Q', 'U', String(userId), '1', '/abort',
    'Q', 'Q', 'B', 'Q', 'C', 'Q', 'N', 'Q', 'A', 'Q', 'F', 'Q', 'R', 'Q']) {
    if (command) console.handle(command);
    else console.render();
    const prompt = plainText(console.prompt);
    assert.ok(prompt.length > 0, command);
    let screen = terminal(fixture.output(), { columns: 80, rows: 24 });
    assert.equal(screen.cells.slice(21, 23).flat()
      .slice(0, prompt.length).map(cell => cell.char).join(''), prompt, command);
    assert.ok(screen.cells.slice(21, 23).flat()
      .filter(cell => cell.char !== ' ').every(cell => cell.fg !== cell.bg), command);
    console.renderInput('typed command');
    screen = terminal(fixture.output(), { columns: 80, rows: 24 });
    const offset = prompt.length % 80 === 79 ? prompt.length + 1 : prompt.length;
    assert.equal(screen.row, 21 + Math.floor(offset / 80), command);
    assert.equal(screen.scrolls, 0, command);
    console.renderInput('');
  }
  assert.deepEqual(fixture.errors, []);
});

test('24-row sysop footers preserve full two-line prompts while editing bounded input', () => {
  for (const length of [0, 20, 78, 79, 80, 81, 158, 159, 160]) {
    const prompt = pipeText('|11' + 'P'.repeat(length));
    const frame = sysopFooter('Notice', prompt, 24);
    const screen = terminal(frame + sysopInput(prompt, 'A'.repeat(160), 24) +
      sysopInput(prompt, 'B', 24), { columns: 80, rows: 24 });
    assert.equal(screen.cells.slice(21, 23).flat().filter(cell => cell.char === 'P').length, length);
    assert.equal(screen.scrolls, 0);
    const offset = length % 80 === 79 ? length + 1 : length;
    assert.equal(screen.row, 21 + Math.floor(offset / 80));
    assert.equal(screen.cells[screen.row][offset % 80].char, 'B');
    assert.match(screen.text, /Notice/);
  }
});

test('24-row sysop message paging does not hide the last body line behind notices', t => {
  const f = setup(t, { rows: 24 });
  const id = f.store.post(f.userId, 'Tall message', Array.from({ length: 14 }, (_, i) => `Body row ${i + 1}`).join('\n'));
  f.console.handle('B');
  f.console.handle(String(id));
  let screen = terminal(f.output(), { columns: 80, rows: 24 });
  assert.match(screen.text, /Body row 13/);
  assert.doesNotMatch(screen.text, /Body row 14/);
  f.console.handle('N');
  screen = terminal(f.output(), { columns: 80, rows: 24 });
  assert.match(screen.text, /Body row 14/);
  assert.equal(f.console.readPage, 1);
  assert.equal(screen.scrolls, 0);
  assert.deepEqual(f.errors, []);
});

test('terminal resize redraws sysop prompts and retains partially typed input', t => {
  const f = setup(t);
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = 25;
  let frame = '';
  output.on('data', chunk => { frame += chunk.toString(); });
  const adapter = startSysopConsole({ ...f.options, input, output });
  t.after(() => { adapter.stop(); input.destroy(); output.destroy(); });
  input.write('sax');
  assert.ok(adapter.controller.field);
  for (const rows of [24, 25, 24]) {
    output.rows = rows;
    frame = '';
    output.emit('resize');
    const screen = terminal(frame, { columns: 80, rows });
    assert.match(screen.text, /New BBS name/);
    assert.equal(screen.cells[screen.row][screen.column - 1].char, 'x');
    assert.equal(screen.scrolls, 0);
  }
  adapter.stop();
  assert.equal(output.listenerCount('resize'), 0);
  assert.deepEqual(f.errors, []);
});

test('settings validate, cancel and persist; registration needs confirmation', t => {
  const { store, console, errors } = setup(t);
  console.handle('S');
  console.handle('A');
  console.handle('New Wire');
  assert.equal(store.settings().name, 'New Wire');
  console.handle('1');
  console.handle('0');
  assert.ok(console.notice.includes('1-1440'));
  assert.ok(console.field);
  console.handle('90');
  assert.equal(store.settings().session_minutes, 90);
  console.handle('2');
  console.handle('/abort');
  assert.equal(store.settings().idle_minutes, 5);
  console.handle('2');
  console.handle('3');
  assert.equal(store.settings().idle_minutes, 3);
  console.handle('E');
  console.handle('no');
  assert.equal(store.settings().registration, 1);
  console.handle('E');
  console.handle('YES');
  assert.equal(store.settings().registration, 0);
  assert.throws(() => store.createUser('NewCaller', 'hash'), /closed/);
  console.handle('E');
  console.handle('YES');
  assert.equal(store.settings().registration, 1);
  assert.deepEqual(errors, []);
});

test('local application approval and rejection require YES and preserve IDs', t => {
  const { store, console, errors } = setup(t);
  const applicant = store.createUser('Applicant', 'private-hash', true);
  console.handle('A');
  assert.equal(console.view, 'applications');
  console.handle(`A ${applicant}`);
  console.handle('no');
  assert.equal(store.user(applicant).application_status, 'pending');
  console.handle(`A ${applicant}`);
  console.handle('YES');
  assert.equal(store.user(applicant).application_status, 'approved');
  const rejected = store.createUser('Rejected', 'private-hash', true);
  console.handle(`R ${rejected}`);
  console.handle('YES');
  assert.equal(store.user(rejected).application_status, 'rejected');
  assert.deepEqual(errors, []);
});

test('user management confirms rename/disable/enable without exposing hashes', t => {
  const fixture = setup(t);
  const { store, console, userId, messageId } = fixture;
  console.handle('U');
  console.handle(`R ${userId} NewHandle`);
  assert.equal(store.user(userId).handle, 'Caller');
  console.handle('YES');
  assert.equal(store.user(userId).handle, 'NewHandle');
  assert.equal(store.message(messageId).handle, 'NewHandle');
  console.handle(`D ${userId}`);
  console.handle('');
  assert.equal(store.user(userId).disabled, 0);
  console.handle(`D ${userId}`);
  console.handle('YES');
  assert.equal(store.user(userId).disabled, 1);
  console.handle(`E ${userId}`);
  console.handle('YES');
  assert.equal(store.user(userId).disabled, 0);
  console.handle('R 999 Nothing');
  assert.equal(plainText(console.notice), 'User not found.');
  assert.ok(!fixture.output().includes('test-hash'));
  assert.ok(!JSON.stringify(store.sysopUsers()).includes('password_hash'));
});

test('message moderation reads, paginates, confirms removal, and reserves IDs', t => {
  const { store, console, userId, messageId } = setup(t);
  const long = store.post(userId, 'Long message', 'a'.repeat(1600));
  console.handle('B');
  console.handle(String(long));
  assert.equal(console.view, 'read');
  console.handle('N');
  assert.equal(console.readPage, 1);
  console.handle('N');
  assert.equal(console.readPage, 1);
  console.handle('P');
  assert.equal(console.readPage, 0);
  console.handle('Q');
  console.handle(`D ${messageId}`);
  console.handle('no');
  assert.ok(store.message(messageId));
  console.handle(`D ${messageId}`);
  console.handle('YES');
  assert.equal(store.message(messageId), undefined);
  assert.equal(store.messages().length, 1);
  console.handle(`D ${long}`);
  console.handle('YES');
  const next = store.post(userId, 'Next message', 'next');
  assert.ok(next > long);
  assert.equal(store.stats().messages, 1);
  assert.throws(() => store.deleteMessage(long), /not found/);
});

test('numbered user form edits every field only after confirmation and preserves IDs', t => {
  const fixture = setup(t);
  const { console, store, userId, messageId, errors } = fixture;
  const disabled = [];
  fixture.options.bbs.setUserDisabled = (id, value) => {
    disabled.push([id, value]);
    store.setUserDisabled(id, value);
  };
  console.handle('U');
  console.handle(String(userId));
  assert.equal(console.view, 'user-detail');
  for (const [number, field, value] of [
    ['1', 'handle', 'NewCaller'], ['2', 'real_name', 'Private Name'],
    ['3', 'location', 'Private City'], ['4', 'sysop_note', 'N'.repeat(100)]
  ]) {
    const before = store.user(userId)[field];
    console.handle(number);
    assert.ok(console.field);
    assert.equal(console.shortcuts(), '');
    console.handle(value);
    assert.ok(console.pending);
    assert.equal(console.field, undefined);
    assert.equal(plainText(console.notice), '');
    assert.equal(store.user(userId)[field], before);
    console.handle('no');
    assert.equal(store.user(userId)[field], before);
    console.handle(number);
    console.handle(value);
    console.handle('YES');
    assert.equal(store.user(userId)[field], value);
    assert.equal(console.view, 'user-detail');
  }
  assert.equal(store.message(messageId).handle, 'NewCaller');
  for (const [number, field] of [['5', 'can_post'], ['6', 'can_doors'], ['7', 'disabled']]) {
    const before = store.user(userId)[field];
    console.handle(number);
    assert.ok(console.pending);
    assert.equal(store.user(userId)[field], before);
    console.handle('no');
    assert.equal(store.user(userId)[field], before);
    console.handle(number);
    console.handle('YES');
    assert.equal(store.user(userId)[field], before ? 0 : 1);
    console.handle(number);
    console.handle('YES');
    assert.equal(store.user(userId)[field], before);
  }
  assert.deepEqual(disabled, [[userId, true], [userId, false]]);
  const screen = terminal(fixture.output());
  for (const label of ['[1] Handle: NewCaller', '[2] Real name: Private Name',
    '[3] Location: Private City', '[4] Sysop note:', '[5] Allow posting: YES',
    '[6] Allow doors: YES', '[7] Disabled (disconnects caller): NO']) {
    assert.ok(screen.text.includes(label), label);
  }
  assert.equal(screen.cells.slice(3, 20).flat().filter(cell => cell.char === 'N').length >= 100, true);
  assert.equal(screen.scrolls, 0);
  assert.ok(!fixture.output().includes('test-hash'));
  assert.deepEqual(errors, []);
});

test('user deletion requires YES in the form or list and keeps disable commands separate', t => {
  const fixture = setup(t);
  const { store, console, userId, messageId, errors } = fixture;
  console.handle('U');
  console.handle(String(userId));
  assert.ok(console.shortcuts().includes('X'));
  console.handle('X');
  assert.ok(console.pending);
  assert.ok(plainText(console.pending.prompt).includes(`Delete account #${userId} (Caller)`));
  assert.ok(store.user(userId));
  console.handle('no');
  assert.ok(store.user(userId));
  assert.equal(console.view, 'user-detail');
  console.handle('X');
  console.handle('YES');
  assert.equal(console.view, 'users');
  assert.equal(console.userId, undefined);
  assert.equal(store.user(userId), undefined);
  assert.equal(store.message(messageId).handle, `Deleted user #${userId}`);
  const replacement = store.createUser('Caller', 'replacement-hash');
  console.handle(`D ${replacement}`);
  console.handle('YES');
  assert.equal(store.user(replacement).disabled, 1);
  console.handle(`E ${replacement}`);
  console.handle('YES');
  assert.equal(store.user(replacement).disabled, 0);
  console.handle(`X ${replacement}`);
  console.handle('');
  assert.ok(store.user(replacement));
  console.handle(`X ${replacement}`);
  console.handle('YES');
  assert.equal(store.user(replacement), undefined);
  console.handle(`X ${replacement}`);
  assert.equal(plainText(console.notice), 'User not found.');
  assert.deepEqual(errors, []);
});

test('deleting the last user on a later page returns to a populated page', t => {
  const fixture = setup(t);
  const { store, console, errors } = fixture;
  for (let index = 0; index < 10; index++) store.createUser(`User_${index}`, 'hash');
  console.handle('U');
  console.handle('N');
  const selected = store.sysopUsers(1)[0].id;
  console.handle(String(selected));
  console.handle('X');
  console.handle('YES');
  assert.equal(console.view, 'users');
  assert.equal(console.page, 0);
  assert.equal(store.sysopUsers().length, 10);
  assert.equal(terminal(fixture.output()).scrolls, 0);
  assert.deepEqual(errors, []);
});

test('user form validates text, supports abort/clear, and restores the list page', t => {
  const { console, store, userId, errors } = setup(t);
  for (let index = 0; index < 10; index++) store.createUser(`User_${index}`, 'hash');
  console.handle('U');
  console.handle('N');
  const selected = store.sysopUsers(1)[0].id;
  console.handle(String(selected));
  console.handle('9');
  assert.match(plainText(console.notice), /field number 1-8/);
  console.handle('N');
  assert.equal(console.page, 1);
  console.handle('1');
  console.handle('!');
  assert.ok(console.field);
  assert.equal(console.pending, undefined);
  console.handle('/abort');
  assert.equal(console.field, undefined);
  console.handle('1');
  console.handle('Caller');
  console.handle('YES');
  assert.match(plainText(console.notice), /already in use/);
  assert.notEqual(store.user(selected).handle, store.user(userId).handle);
  for (const [number, field, limit] of [
    ['2', 'real_name', 60], ['3', 'location', 60], ['4', 'sysop_note', 100]
  ]) {
    console.handle(number);
    console.handle('x'.repeat(limit + 1));
    assert.ok(console.field);
    assert.equal(console.pending, undefined);
    console.handle('x'.repeat(limit));
    console.handle('YES');
    assert.equal(store.user(selected)[field], 'x'.repeat(limit));
    console.handle(number);
    console.handle('-');
    console.handle('YES');
    assert.equal(store.user(selected)[field], '');
  }
  console.handle('Q');
  assert.equal(console.view, 'users');
  assert.equal(console.page, 1);
  console.handle(`V ${selected}`);
  assert.equal(console.view, 'user-detail');
  assert.deepEqual(errors, []);
});

test('TTY user field numbers act immediately without consuming text or confirmations', t => {
  const fixture = setup(t);
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  const adapter = startSysopConsole({ ...fixture.options, input,
    output: { isTTY: true, write: () => {} } });
  t.after(() => { adapter.stop(); input.destroy(); });
  const { controller } = adapter;
  input.write(`u${fixture.userId}\r\n`);
  assert.equal(controller.view, 'user-detail');
  input.write('2\r\n');
  assert.ok(controller.field);
  input.write('123 Name\r\n');
  assert.ok(controller.pending);
  assert.equal(fixture.store.user(fixture.userId).real_name, '');
  input.write('YES\r\n');
  assert.equal(fixture.store.user(fixture.userId).real_name, '123 Name');
  input.write('5');
  assert.ok(controller.pending);
  input.write('YES\r\n');
  assert.equal(fixture.store.user(fixture.userId).can_post, 0);
  input.write('q');
  assert.equal(controller.view, 'users');
  assert.deepEqual(fixture.errors, []);
});

test('node hangup and graceful quit require explicit YES', t => {
  const fixture = setup(t);
  const { console } = fixture;
  console.handle('N');
  console.handle('H 1');
  console.handle('n');
  assert.deepEqual(fixture.disconnected, []);
  console.handle('H 1');
  console.handle('YES');
  assert.deepEqual(fixture.disconnected, [1]);
  console.handle('H 999');
  assert.equal(plainText(console.notice), 'Node is no longer connected.');
  console.handle('Q');
  console.handle('Q');
  console.handle('no');
  assert.equal(fixture.quits(), 0);
  console.handle('Q');
  console.handle('YES');
  assert.equal(fixture.quits(), 1);
  assert.equal(console.stopped, true);
});

test('local file approvals, revocation and removal require confirmation', t => {
  const fixture = setup(t);
  const { console, files } = fixture;
  console.handle('F');
  assert.equal(console.view, 'files');
  assert.ok(fixture.output().includes('PENDING'));
  console.handle('A 3');
  console.handle('no');
  assert.deepEqual(files, []);
  console.handle('A 3');
  console.handle('YES');
  console.handle('U 3');
  console.handle('YES');
  console.handle('D 3');
  console.handle('YES');
  assert.deepEqual(files, [['approve', 3, true], ['approve', 3, false], ['remove', 3]]);
  assert.deepEqual(fixture.errors, []);
});

test('local sysop notes are readable and acknowledgment requires confirmation', t => {
  const fixture = setup(t);
  const { console, resolved } = fixture;
  console.render();
  assert.ok(fixture.output().includes('Sysop requests waiting'));
  console.handle('R');
  assert.equal(console.view, 'requests');
  console.handle('V 8');
  assert.equal(console.view, 'request-read');
  assert.ok(fixture.output().includes('Private guest request'));
  console.handle('N');
  assert.equal(console.readPage, 0);
  console.handle('Q');
  assert.equal(console.view, 'requests');
  console.handle('D 8');
  console.handle('no');
  assert.deepEqual(resolved, []);
  console.handle('D 8');
  console.handle('YES');
  assert.deepEqual(resolved, [8]);
  assert.deepEqual(fixture.errors, []);
});

test('system configuration manages bases, private user details, permissions and strings', t => {
  const { store, console, userId, errors } = setup(t);
  console.handle('S');
  console.handle('B');
  console.handle('C Technology | Technical talk');
  console.handle('no');
  assert.equal(store.bases().length, 1);
  console.handle('C Technology | Technical talk');
  console.handle('YES');
  assert.equal(store.bases()[1].name, 'Technology');
  console.handle('O 2');
  assert.equal(console.view, 'messages');
  assert.equal(console.baseId, 2);
  console.handle('Q');
  console.handle('S');
  console.handle('U');
  console.handle(`F ${userId} real_name Private Name`);
  console.handle('YES');
  console.handle(`P ${userId} post 0`);
  console.handle('no');
  assert.equal(store.user(userId).can_post, 1);
  console.handle(`P ${userId} post 0`);
  console.handle('YES');
  assert.equal(store.user(userId).can_post, 0);
  console.handle(`P ${userId} doors 0`);
  console.handle('YES');
  assert.equal(store.user(userId).can_doors, 0);
  console.handle(`V ${userId}`);
  assert.equal(console.view, 'user-detail');
  assert.equal(store.user(userId).real_name, 'Private Name');
  console.handle('Q');
  assert.equal(console.view, 'users');
  console.handle('Q');
  console.handle('S');
  console.handle('T');
  console.handle('E main_prompt');
  console.handle('Choose: ');
  assert.equal(store.stringOverride('main_prompt'), 'Choose: ');
  console.handle('E goodbye');
  console.handle('%USERNAME%');
  assert.ok(console.field);
  console.handle('/abort');
  console.handle('R main_prompt');
  console.handle('YES');
  assert.equal(store.stringOverride('main_prompt'), undefined);
  assert.deepEqual(errors, []);
});

test('console bounds input, rejects controls, and reports unexpected failures', t => {
  const fixture = setup(t);
  const { console, errors } = fixture;
  console.handle('a'.repeat(161));
  assert.ok(console.notice.includes('160'));
  console.handle('\x1b[2J');
  assert.ok(console.notice.includes('printable'));
  console.handle('U');
  console.handle('N');
  assert.equal(console.page, 1);
  console.handle('P');
  console.handle('P');
  assert.equal(console.page, 0);
  console.handle('D nope');
  assert.ok(console.notice.includes('numeric'));
  fixture.options.bbs.setUserDisabled = () => { throw new Error('test failure'); };
  console.handle('D 1');
  console.handle('YES');
  assert.equal(errors.length, 1);
  assert.ok(console.notice.includes('Operation failed'));
});

test('TTY adapter handles hotkeys, editing, Ctrl+C and restores raw mode/listeners', t => {
  const fixture = setup(t);
  const input = new PassThrough();
  let raw = false, output = '';
  input.isTTY = true;
  input.setRawMode = value => { raw = value; input.isRaw = value; };
  const adapter = startSysopConsole({ ...fixture.options, input,
    output: { isTTY: true, write: value => { output += value; } } });
  t.after(() => { adapter.stop(); input.destroy(); });
  assert.equal(raw, true);
  input.write('s');
  assert.equal(adapter.controller.view, 'config');
  input.write('a\r');
  input.write('NewX\x7f\r');
  assert.equal(fixture.store.settings().name, 'New');
  input.write('\x03');
  assert.equal(fixture.quits(), 1);
  adapter.stop();
  assert.equal(raw, false);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.ok(output.includes('SYSTEM') || output.includes('CONFIG'));
  assert.throws(() => startSysopConsole({ ...fixture.options, input: { isTTY: false } }), /requires interactive/);
});

test('string editor searches catalog entries and renders saved/live color previews with bounded source editing', t => {
  const fixture = setup(t);
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let output = '';
  const adapter = startSysopConsole({ ...fixture.options, input,
    output: { isTTY: true, write: value => { output += value; } } });
  t.after(() => { adapter.stop(); input.destroy(); });
  input.write('st');
  assert.equal(adapter.controller.view, 'strings');
  input.write('F selection\r\n');
  assert.ok(adapter.controller.stringKeys().includes('selection'));
  assert.ok(adapter.controller.stringKeys().length < 20);
  input.write('E selection\r\n');
  output = '';
  const replacement = '|03S|10e|15lection|07: ';
  input.write(replacement);
  assert.ok(output.includes('\x1b[0;38;2;0;170;170;48;2;0;0;0mS'));
  assert.ok(output.includes('\x1b[0;38;2;85;255;85;48;2;0;0;0me'));
  assert.ok(terminal(output).text.includes('Preview:'));
  assert.ok(terminal(output).text.includes('Selection: '));
  assert.ok(output.includes(replacement));
  assert.ok(!output.includes('?[0;'));
  input.write('\r\n');
  assert.equal(fixture.store.stringOverride('selection'), replacement);
  assert.equal(plainText(adapter.controller.notice), 'Settings saved.');
  input.write('E selection\r');
  input.write('|01'.repeat(170) + 'AB');
  input.write('\x7fC\r');
  assert.equal(fixture.store.stringOverride('selection'), '|01'.repeat(170) + 'AC');
  input.write('R selection\r');
  assert.ok(adapter.controller.pending);
  input.write('Y');
  assert.ok(adapter.controller.pending);
  input.write('ES\r');
  assert.equal(fixture.store.stringOverride('selection'), undefined);
  input.write('F\r');
  assert.ok(adapter.controller.stringKeys().length > 400);
});

test('WFC labels and local validation errors use persisted editable strings', t => {
  const fixture = setup(t);
  fixture.store.setString('wfc_title', '|10%NAME% ready|07');
  fixture.console.render();
  assert.ok(plainText(fixture.output()).includes('Test BBS ready'));
  fixture.store.setString('error_user_not_found', '|12No such caller.|07');
  fixture.console.handle('U');
  fixture.console.handle('R 999 Nothing');
  assert.equal(plainText(fixture.console.notice), 'No such caller.');
  assert.ok(fixture.output().includes('\x1b[0;38;2;255;85;85;48;2;0;0;0mNo such caller.'));
  assert.deepEqual(fixture.errors, []);
});

test('stopping an initially idle TTY stops stdin reads before restoring cooked input', t => {
  const fixture = setup(t);
  const input = new PassThrough();
  input.isTTY = true;
  assert.equal(input.readableFlowing, null);
  const modes = [];
  let refs = 0, unrefs = 0;
  input.ref = () => { refs++; };
  input.unref = () => { unrefs++; };
  input.setRawMode = value => { modes.push({ raw: value, paused: input.isPaused() }); input.isRaw = value; };
  let output = '';
  const adapter = startSysopConsole({ ...fixture.options, input,
    output: { isTTY: true, write: value => { output += value; } } });
  t.after(() => { adapter.stop(); input.destroy(); });
  adapter.stop();
  assert.equal(input.isPaused(), true);
  assert.equal(refs, 1);
  assert.equal(unrefs, 1);
  assert.deepEqual(modes.at(-1), { raw: false, paused: true });
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.ok(output.includes('\x1b[?1049h'));
  assert.ok(output.endsWith('\x1b[?1049l'));
});

test('raw Ctrl+C restores the terminal before invoking asynchronous shutdown', t => {
  const fixture = setup(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let quits = 0, output = '';
  const adapter = startSysopConsole({ ...fixture.options, input,
    output: { isTTY: true, write: value => { output += value; } },
    onQuit: () => {
      quits++;
      assert.equal(input.isRaw, false);
      assert.equal(input.isPaused(), true);
      assert.equal(input.listenerCount('data'), 0);
      assert.ok(output.endsWith('\x1b[?1049l'));
    }
  });
  t.after(() => { adapter.stop(); input.destroy(); });
  input.write('\x03');
  assert.equal(quits, 1);
  assert.equal(adapter.controller.stopped, true);
  const previous = output;
  t.mock.timers.tick(10000);
  input.write('s\r');
  assert.equal(output, previous);
  adapter.stop();
  assert.equal(quits, 1);
});

test('confirmed TTY quit restores the screen and supports restarting the adapter', t => {
  const fixture = setup(t);
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let output = '';
  const options = { ...fixture.options, input,
    output: { isTTY: true, write: value => { output += value; } },
    onQuit: () => {
      assert.equal(input.isRaw, false);
      assert.equal(input.isPaused(), true);
      assert.ok(output.endsWith('\x1b[?1049l'));
    }
  };
  const adapter = startSysopConsole(options);
  t.after(() => { adapter.stop(); input.destroy(); });
  input.write('q');
  assert.equal(input.isRaw, true);
  input.write('YES\r');
  assert.equal(adapter.controller.stopped, true);
  const restarted = startSysopConsole(options);
  t.after(() => restarted.stop());
  input.write('s');
  assert.equal(restarted.controller.view, 'config');
});

test('TTY cleanup preserves pre-existing raw/flowing input and other listeners', t => {
  const fixture = setup(t);
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = true;
  input.setRawMode = value => { input.isRaw = value; };
  const otherData = () => {};
  const otherKeypress = () => {};
  input.on('data', otherData);
  input.on('keypress', otherKeypress);
  input.resume();
  input.ref = input.unref = () => assert.fail('Pre-existing flowing input must retain its reference state');
  const adapter = startSysopConsole({ ...fixture.options, input, output: { isTTY: true, write() {} } });
  t.after(() => { adapter.stop(); input.destroy(); });
  adapter.stop();
  assert.equal(input.isRaw, true);
  assert.equal(input.readableFlowing, true);
  assert.deepEqual(input.listeners('data'), [otherData]);
  assert.deepEqual(input.listeners('keypress'), [otherKeypress]);
});

test('TTY cleanup runs on process exit and removes its exit hook', t => {
  const fixture = setup(t);
  const previous = new Set(process.listeners('exit'));
  const input = new PassThrough();
  input.isTTY = true;
  input.pause();
  input.setRawMode = value => { input.isRaw = value; };
  const adapter = startSysopConsole({ ...fixture.options, input, output: { isTTY: true, write() {} } });
  t.after(() => { adapter.stop(); input.destroy(); });
  const hooks = process.listeners('exit').filter(listener => !previous.has(listener));
  assert.equal(hooks.length, 1);
  hooks[0]();
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(process.listeners('exit').includes(hooks[0]), false);
});

test('startup rendering failures and raw-mode restoration failures still release the terminal', t => {
  const fixture = setup(t);
  const previous = process.listenerCount('exit');
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let output = '';
  const options = { ...fixture.options, input,
    output: { isTTY: true, write: value => { output += value; } } };
  t.after(() => input.destroy());
  const nodes = fixture.options.bbs.nodes;
  fixture.options.bbs.nodes = () => { throw new Error('test initial render failure'); };
  assert.throws(() => startSysopConsole(options), /test initial render failure/);
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(process.listenerCount('exit'), previous);
  assert.ok(output.endsWith('\x1b[?1049l'));
  fixture.options.bbs.nodes = nodes;
  const adapter = startSysopConsole(options);
  t.after(() => adapter.stop());
  input.setRawMode = () => { throw new Error('test raw mode failure'); };
  assert.throws(() => adapter.stop(), /test raw mode failure/);
  assert.equal(input.isPaused(), true);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(process.listenerCount('exit'), previous);
  assert.ok(output.endsWith('\x1b[?1049l'));
});

test('configured session lifetime expires at the exact limit', t => {
  const { store } = setup(t);
  store.updateSettings({ ...store.settings(), session_minutes: 2, idle_minutes: 1 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new PassThrough();
  let idleMs;
  socket.setTimeout = milliseconds => { idleMs = milliseconds; };
  let output = '';
  socket.on('data', data => { output += data.toString(); });
  // Capture application output without feeding it back into the socket input.
  socket.write = value => { output += value.toString(); return true; };
  const session = new Session({ socket, store, id: 1, secure: false, onError: assert.fail });
  assert.equal(idleMs, 60000);
  t.mock.timers.tick(119999);
  assert.equal(session.closed, false);
  t.mock.timers.tick(1);
  assert.equal(session.closed, true);
  assert.ok(output.includes('Session time limit reached.'));
  session.cleanup();
  socket.destroy();
});

test('WFC refresh never overwrites menu input, edits or confirmations; failures restore TTY', t => {
  const fixture = setup(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let output = '';
  const adapter = startSysopConsole({ ...fixture.options, input,
    output: { isTTY: true, write: value => { output += value; } } });
  t.after(() => { adapter.stop(); input.destroy(); });
  let previous = output;
  t.mock.timers.tick(2000);
  assert.ok(output.length > previous.length);
  input.write('s');
  previous = output;
  t.mock.timers.tick(2000);
  assert.equal(output, previous);
  input.write('a\r');
  input.write('X');
  previous = output;
  t.mock.timers.tick(2000);
  assert.equal(output, previous);
  input.write('\r');
  input.write('q\r');
  input.write('q');
  previous = output;
  t.mock.timers.tick(2000);
  assert.equal(output, previous);
  input.write('n\r');
  fixture.options.bbs.nodes = () => { throw new Error('test render failure'); };
  t.mock.timers.tick(2000);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.quits(), 1);
});

for (const height of [24, 25]) test(`all sysop tools fit 80x${height} with full lists, notices and confirmation prompts`, t => {
  const fixture = setup(t, { rows: height });
  const { console, store, userId } = fixture;
  for (let index = 0; index < 12; index++) {
    store.createUser(`User_${index}`, 'test-hash');
    store.createBase(`Base_${index}`, 'Description '.repeat(6));
    store.post(userId, `Subject_${index}`, 'Body');
  }
  fixture.options.bbs.nodes = () => Array.from({ length: 32 }, (_, index) =>
    ({ id: index + 1, handle: 'Caller', state: 'main' }));
  fixture.options.bbs.endpoints.push('TLS 127.0.0.1:9923');
  fixture.options.bbs.community.notification = () => ({
    kind: 'note', handle: 'Caller', node: 1, created_at: '2026-11-02T18:00:00Z',
    body_lines: Array(14).fill('Request body '.repeat(5)), page: 0, pages: 1
  });
  console.userId = userId;
  console.reading = store.message(store.post(userId, 'Long body', 'x'.repeat(1600)));
  console.readPage = 0;
  console.requestId = 8;
  for (const view of ['wfc', 'config', 'users', 'user-detail', 'bases', 'strings', 'messages',
    'callers', 'nodes', 'requests', 'request-read', 'files', 'applications', 'read', 'watch-controls']) {
    console.view = view;
    console.notice = 'N'.repeat(160);
    console.confirm('Confirm ' + 'C'.repeat(65), () => {});
    console.render();
    for (const size of [{ columns: 80, rows: height }, { columns: 120, rows: 40 }]) {
      const screen = terminal(fixture.output(), size);
      assert.equal(screen.scrolls, 0, view);
      const promptLength = plainText(console.prompt).length;
      assert.equal(screen.row, height - 3 + Math.floor(promptLength / 80), view);
      assert.equal(screen.column, promptLength % 80, view);
      assert.equal(screen.cells[0][0].char, view === 'wfc' || (height === 24 && view !== 'read') ? ' ' : '+', view);
      assert.equal(screen.cells[height - 5].slice(0, 80).map(cell => cell.char).join(''), 'N'.repeat(80), view);
      assert.equal(screen.cells[height - 4].slice(0, 80).map(cell => cell.char).join(''), 'N'.repeat(80), view);
      assert.ok(screen.cells.every((row, index) => row.slice(index < height ? 80 : 0)
        .every(cell => cell.char === ' ' && cell.bg === '#000000')), view);
    }
  }
  assert.deepEqual(fixture.errors, []);
});

test('message base descriptions remain accessible across five-base local pages', t => {
  const fixture = setup(t);
  for (let index = 1; index <= 11; index++) fixture.store.createBase(`Base_${index}`, `Description_${index}`);
  fixture.console.handle('S');
  fixture.console.handle('B');
  const shown = [];
  for (let page = 0; page < 3; page++) {
    const screen = terminal(fixture.output());
    shown.push(screen.text);
    assert.equal(screen.scrolls, 0);
    assert.equal(fixture.console.page, page);
    fixture.console.handle('N');
  }
  assert.ok(!shown[0].includes('Base_5'));
  for (let index = 1; index <= 11; index++) {
    const page = Math.floor(index / 5);
    assert.ok(shown[page].includes(`Base_${index}`));
    assert.ok(shown[page].includes(`Description_${index}`));
  }
  assert.deepEqual(fixture.errors, []);
});

test('long sysop input scrolls after its prompt without scrolling menus', t => {
  const fixture = setup(t);
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = raw => { input.isRaw = raw; };
  let output = '';
  const adapter = startSysopConsole({ ...fixture.options, input,
    output: { isTTY: true, write: text => { output += text; } } });
  t.after(() => { adapter.stop(); input.destroy(); });
  input.write('SA');
  const fieldScreen = terminal(output);
  const { row, column } = fieldScreen;
  const capacity = 79 - column;
  const prompt = fieldScreen.cells[row].slice(0, column).map(cell => cell.char).join('');
  const value = 'A'.repeat(81) + 'B'.repeat(79);
  input.write(value);
  assert.equal(adapter.controller.inputBuffer, value);
  let screen = terminal(output);
  assert.equal(screen.scrolls, 0);
  assert.ok(screen.cells[row].slice(column, 79).every(cell => cell.char === 'B' && cell.bg === '#000000'));
  assert.equal(screen.row, row);
  assert.equal(screen.column, 79);
  assert.equal(screen.cells[row].slice(0, column).map(cell => cell.char).join(''), prompt);
  input.write('\x7f'.repeat(80));
  screen = terminal(output);
  assert.equal(screen.scrolls, 0);
  assert.equal(screen.cells[row].slice(column, 79).map(cell => cell.char).join(''), 'A'.repeat(capacity));
  assert.equal(adapter.controller.inputBuffer, 'A'.repeat(80));
  assert.equal(screen.cells[0][0].char, '+');
  input.write('\r/abort\rT');
  input.write('E selection\r');
  const stringScreen = terminal(output);
  const source = '|01'.repeat(170) + 'AB';
  input.write(source);
  screen = terminal(output);
  assert.equal(screen.scrolls, 0);
  assert.equal(adapter.controller.inputBuffer, source);
  assert.equal(screen.row, stringScreen.row);
  assert.equal(screen.cells[screen.row].slice(stringScreen.column, 79).map(cell => cell.char).join(''),
    source.slice(-(79 - stringScreen.column)));
  assert.deepEqual(fixture.errors, []);
});

test('WFC uses all 80 columns, aligns every menu column and colors keys separately from labels', t => {
  const fixture = setup(t);
  fixture.console.render();
  for (const size of [{ columns: 80, rows: 25 }, { columns: 120, rows: 40 }]) {
    const screen = terminal(fixture.output(), size);
    assert.ok(screen.cells[0].slice(0, 80).every(cell => cell.bg === '#0000aa'));
    assert.ok(screen.cells[1].slice(0, 80).every(cell => cell.bg === '#0000aa'));
    assert.equal(screen.cells[2][0].char, '+');
    assert.equal(screen.cells[2][79].char, '+');
    for (const [index, keys] of ['SUB', 'CNA', 'FRQ'].entries()) {
      const row = screen.cells[10 + index];
      for (const [column, key] of [...keys].entries()) {
        const start = 2 + column * 26;
        assert.deepEqual(row.slice(start, start + 3).map(cell => cell.char), ['[', key, ']']);
        assert.equal(row[start].fg, '#00aaaa');
        assert.equal(row[start + 1].fg, '#ffff55');
        assert.equal(row[start + 4].fg, '#aaaaaa');
      }
    }
    assert.equal(screen.cells[13][3].char, 'L');
    assert.equal(screen.scrolls, 0);
    assert.ok(screen.cells.slice(3).flat().every(cell => cell.bg === '#000000'));
  }
});

test('WFC puts its menu directly after connected or waiting nodes with aligned node headings', t => {
  const fixture = setup(t);
  for (const nodes of [[], [{ id: 12, handle: 'Caller', state: 'main' }]]) {
    fixture.options.bbs.nodes = () => nodes;
    fixture.console.render();
    const screen = terminal(fixture.output());
    const heading = screen.cells[7].map(cell => cell.char).join('');
    assert.equal(heading.indexOf('NODE'), 2);
    assert.equal(heading.indexOf('CALLER'), 10);
    assert.equal(heading.indexOf('STATUS'), 37);
    if (nodes.length) {
      const row = screen.cells[8].map(cell => cell.char).join('');
      assert.equal(row.indexOf('12'), 2);
      assert.equal(row.indexOf('Caller'), 10);
      assert.equal(row.indexOf('main'), 37);
    } else assert.ok(screen.cells[8].map(cell => cell.char).join('').includes('Waiting for'));
    assert.equal(screen.cells[9][0].char, '+');
    assert.equal(screen.cells[10][3].char, 'S');
  }
  fixture.options.bbs.nodes = () => Array.from({ length: 32 }, (_, id) => ({ id, handle: 'Caller', state: 'main' }));
  fixture.options.bbs.endpoints.push('TLS 127.0.0.1:9923');
  fixture.console.render();
  const screen = terminal(fixture.output());
  assert.ok(screen.cells[15].map(cell => cell.char).join('').includes('26 more active nodes'));
  assert.equal(screen.cells[16][3].char, 'S');
  assert.equal(screen.cells[19][3].char, 'L');
  assert.equal(screen.scrolls, 0);
});

test('sysop menu columns clip long colored labels without shifting following keys or losing overrides', t => {
  const fixture = setup(t);
  fixture.store.setString('screens_f_file_approvals_r_sysop_requests_q_quit_bbs',
    '|10[F] ' + 'X'.repeat(60) + ' [R] Custom requests [Q] Custom exit');
  fixture.console.render();
  let screen = terminal(fixture.output());
  const row = screen.cells[12];
  assert.equal(row[3].char, 'F');
  assert.equal(row[29].char, 'R');
  assert.equal(row[55].char, 'Q');
  assert.equal(row[3].fg, '#55ff55');
  assert.equal(row[29].fg, '#55ff55');
  assert.equal(row.slice(28, 52).map(cell => cell.char).join('').trim(), '[R] Custom requests');
  fixture.console.handle('S');
  screen = terminal(fixture.output());
  for (const [column, key] of ['B', 'U', 'T'].entries()) {
    const start = 2 + column * 26;
    assert.equal(screen.cells[11][start + 1].char, key);
    assert.equal(screen.cells[11][start + 1].fg, '#ffff55');
    assert.equal(screen.cells[11][start + 4].fg, '#aaaaaa');
  }
  assert.deepEqual(fixture.errors, []);
});

test('string catalog separates three numbered entries and marks clipped source/preview text', t => {
  const fixture = setup(t);
  fixture.console.handle('S');
  fixture.console.handle('T');
  let screen = terminal(fixture.output());
  for (const [index, key] of fixture.console.stringKeys().slice(0, 3).entries()) {
    const row = 5 + index * 4;
    assert.ok(screen.cells[row].map(cell => cell.char).join('').includes(`[${index + 1}] ${key}`));
    assert.equal(screen.cells[row][3].fg, '#ffff55');
    assert.equal(screen.cells[row][6].fg, '#55ffff');
    assert.ok(screen.cells[row + 1].map(cell => cell.char).join('').includes('Source:'));
    assert.ok(screen.cells[row + 2].map(cell => cell.char).join('').includes('Preview:'));
    assert.ok(screen.cells[row + 3].every(cell => cell.char === ' '));
  }
  assert.ok(!screen.text.includes(fixture.console.stringKeys()[3]));
  fixture.store.setString('selection', '|11' + 'X'.repeat(160));
  fixture.console.handle('F selection');
  const keyIndex = fixture.console.stringKeys().indexOf('selection');
  for (let page = 0; page < Math.floor(keyIndex / 3); page++) fixture.console.handle('N');
  screen = terminal(fixture.output());
  const row = 5 + keyIndex % 3 * 4;
  assert.ok(screen.cells[row + 1].map(cell => cell.char).join('').trimEnd().endsWith('...'));
  assert.ok(screen.cells[row + 2].map(cell => cell.char).join('').trimEnd().endsWith('...'));
  assert.equal(screen.scrolls, 0);
  assert.deepEqual(fixture.errors, []);
});

test('string paging and numeric edit/reset shortcuts follow the filtered current page', t => {
  const fixture = setup(t);
  const { console, store } = fixture;
  console.handle('S');
  console.handle('T');
  console.handle('N');
  const key = console.stringKeys()[3];
  console.handle('E 1');
  assert.equal(console.field.stringKey, key);
  console.handle('Different source');
  assert.equal(store.stringOverride(key), 'Different source');
  console.handle('R 1');
  assert.ok(console.pending.prompt.includes(key));
  console.handle('no');
  assert.equal(store.stringOverride(key), 'Different source');
  console.handle('R 1');
  console.handle('YES');
  assert.equal(store.stringOverride(key), undefined);
  console.handle('F selection');
  assert.equal(console.page, 0);
  const filtered = console.stringKeys();
  for (let page = 0; page < Math.ceil(filtered.length / 3); page++) {
    for (let index = 0; index < Math.min(3, filtered.length - page * 3); index++) {
      console.handle(`E ${index + 1}`);
      assert.equal(console.field.stringKey, filtered[page * 3 + index]);
      console.handle('/abort');
    }
    console.handle('N');
  }
  assert.equal(console.page, Math.ceil(filtered.length / 3) - 1);
  console.handle('F no-matching-display-key');
  assert.equal(console.page, 0);
  console.handle('E 1');
  assert.equal(console.field, undefined);
  assert.ok(console.notice.includes('Unknown string key'));
  console.handle('N');
  assert.equal(console.page, 0);
  assert.ok(terminal(fixture.output()).text.includes('No matching strings'));
  assert.deepEqual(fixture.errors, []);
});

test('string edit view wraps the entire 512-character source and 160-character live preview', t => {
  const fixture = setup(t);
  const { console, store } = fixture;
  const full = '|02'.repeat(117) + 'X'.repeat(158) + '|| ';
  assert.equal(full.length, 512);
  store.setString('selection', full);
  console.handle('S');
  console.handle('T');
  console.handle('E selection');
  const screen = terminal(fixture.output(), { columns: 120, rows: 40 });
  const sourceRow = screen.cells.findIndex(row => row.map(cell => cell.char).join('').trim() === 'Source:') + 1;
  const displayed = screen.cells.slice(sourceRow, sourceRow + 7)
    .map(row => row.slice(2, 78).map(cell => cell.char).join('')).join('');
  assert.equal(displayed.slice(0, 512), full);
  const previewRow = screen.cells.findIndex(row => row.map(cell => cell.char).join('').trim() === 'Preview:') + 1;
  const preview = screen.cells.slice(previewRow, previewRow + 3)
    .map(row => row.slice(2, 78).map(cell => cell.char).join('')).join('');
  assert.equal(preview.slice(0, 160), 'X'.repeat(158) + '| ');
  assert.equal(screen.cells[previewRow][2].fg, '#00aa00');
  assert.ok(screen.text.includes('Source 512/512'));
  assert.ok(screen.text.includes('Preview 160/160'));
  assert.equal(screen.scrolls, 0);
  assert.ok(screen.cells.every((row, index) => row.slice(index < 25 ? 80 : 0)
    .every(cell => cell.char === ' ' && cell.bg === '#000000')));
  assert.deepEqual(fixture.errors, []);
});

test('string editor flags oversized live previews without changing saved strings or overflowing 80x25', t => {
  const fixture = setup(t);
  const { console, store } = fixture;
  console.handle('S');
  console.handle('T');
  console.handle('E selection');
  console.editBuffer = 'X'.repeat(512);
  console.render();
  const screen = terminal(fixture.output());
  const count = screen.cells.find(row => row.map(cell => cell.char).join('').includes('Preview 512/160'));
  assert.ok(count);
  assert.equal(count[2].fg, '#ff5555');
  assert.ok(screen.text.includes('visible limit exceeded'));
  assert.ok(screen.text.includes('...'));
  assert.equal(screen.scrolls, 0);
  console.handle('X'.repeat(512));
  assert.ok(console.field);
  assert.equal(store.stringOverride('selection'), undefined);
  assert.deepEqual(fixture.errors, []);
});

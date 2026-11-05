import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Community, initializeCommunity } from '../src/community.js';
import { InputError } from '../src/validation.js';
import { Presentation } from '../src/presentation.js';
import { plainText, ui } from '../src/strings.js';
import { LocalTerminal } from '../src/local-terminal.js';
import { TelnetInput } from '../src/telnet.js';
import { terminal } from './helpers/ansi-terminal.js';

function setup(t, filename = ':memory:') {
  const store = new Store(filename);
  initializeCommunity(store.db);
  const community = new Community(store);
  t.after(() => store.close());
  const alice = store.createUser('Alice', 'not-a-real-password-hash');
  const bob = store.createUser('Bob', 'not-a-real-password-hash');
  return { store, community, alice, bob };
}

function session(store, userId, node = 1) {
  return { id: node, user: userId ? store.user(userId) : undefined, state: 'main', output: '',
    write(value) { this.output += value; },
    menu() { this.state = 'main'; },
    showWelcome() { this.state = 'welcome'; } };
}

for (const feature of ['automessage', 'email', 'signature', 'config', 'stats', 'oneliners']) {
  test(`${feature} menu leaves both local and remote cursors immediately after its prompt`, async t => {
    const { store, community, alice } = setup(t);
    const caller = session(store, alice);
    await community.menu(caller, feature);
    const prompt = plainText(ui(store, 'command_prompt'));
    const render = (frame, local) => {
      if (!local) return terminal(frame, { rows: 24 });
      let output = '';
      new LocalTerminal({ rows: 24, write: text => { output += text; } }).write(frame);
      return terminal(output, { rows: 24 });
    };
    for (const local of [false, true]) {
      const screen = render(caller.output, local);
      const row = screen.cells.findLastIndex(line => line.map(cell => cell.char).join('').includes(prompt));
      const column = screen.cells[row].map(cell => cell.char).join('').indexOf(prompt) + prompt.length;
      assert.equal(screen.row, row);
      assert.equal(screen.column, column);
      const editor = new TelnetInput({ write: value => caller.write(value) });
      editor.feed(Buffer.from('x'));
      const entered = render(caller.output, local);
      assert.equal(entered.cells[row][column].char, 'x');
      caller.output = caller.output.slice(0, -1);
    }
    assert.ok(!caller.output.endsWith('\r\n'));
  });
}

for (const artwork of [false, true]) {
  test(`stats ${artwork ? 'artwork' : 'rendered fallback'} leaves the cursor after the command prompt`, async t => {
    const { store, community, alice } = setup(t);
    const caller = session(store, alice);
    caller.presentation = new Presentation();
    caller.presentation.templates.clear();
    if (artwork) caller.presentation.templates.set('stats', 'STATS\r\n');
    caller.view = values => ({ values });
    await community.menu(caller, 'stats');
    const prompt = plainText(ui(store, 'community_q_main_command'));
    const screen = terminal(caller.output, { rows: 24 });
    const row = screen.cells.findLastIndex(line => line.map(cell => cell.char).join('').includes(prompt));
    const column = screen.cells[row].map(cell => cell.char).join('').indexOf(prompt) + prompt.length;
    assert.equal(screen.row, row);
    assert.equal(screen.column, column);
    assert.ok(!caller.output.endsWith('\r\n'));
  });
}

test('community field prompts and validation retries do not append a newline after input', async t => {
  const { store, community, alice } = setup(t);
  const caller = session(store, alice);
  store.setString('retry_prompt', '|11Try again here: |07');
  await community.menu(caller, 'config');
  await community.handle(caller, 'R');
  assert.ok(caller.output.endsWith(String(ui(store, 'community_private_value_60_characters_clears_abort_cancels'))));
  await community.handle(caller, 'x'.repeat(61));
  assert.ok(caller.output.endsWith(String(ui(store, 'retry_prompt'))));
  const screen = terminal(caller.output, { rows: 24 });
  assert.equal(screen.column, 'Try again here: '.length);
  caller.output = '';
  await community.menu(caller, 'email');
  await community.handle(caller, 'W');
  assert.ok(caller.output.endsWith(String(ui(store, 'community_recipient_handle'))));
  await community.handle(caller, 'Bob');
  assert.ok(caller.output.endsWith(String(ui(store, 'community_subject_60_characters'))));
});

test('private inbox ownership, read markers and projections exclude private fields', t => {
  const { store, community, alice, bob } = setup(t);
  community.setConfig(alice, 'real_name', 'Private Alice');
  community.setConfig(alice, 'location', 'Private location');
  const mailId = community.sendMail(alice, bob, 'Private subject', 'Secret body');
  assert.equal(community.unread(bob), 1);
  assert.equal(community.unread(alice), 0);
  assert.deepEqual(community.inbox(alice), []);
  assert.throws(() => community.readMail(alice, mailId), InputError);
  assert.equal(community.unread(bob), 1);
  assert.deepEqual(community.readMail(bob, mailId).body_lines, ['Secret body']);
  assert.equal(community.unread(bob), 0);
  assert.deepEqual(community.config(alice), { real_name: 'Private Alice', location: 'Private location', user_note: '' });
  assert.equal(JSON.stringify(community.publicStats(alice)).includes('Private'), false);
  assert.equal(JSON.stringify(store.users()).includes('Private'), false);
  assert.equal(JSON.stringify(community.inbox(bob)).includes('Secret body'), false);
  assert.equal(JSON.stringify(community.stats(alice)).includes('password'), false);
  assert.throws(() => community.setConfig(alice, 'sysop_note', 'forged privilege'), InputError);
});

test('handle reuse does not expose a deleted users mail, profile or statistics', t => {
  const { store, community, alice, bob } = setup(t);
  community.setSignature(alice, 'Private signature');
  community.setConfig(alice, 'user_note', 'Private note');
  const sent = community.sendMail(alice, bob, 'Preserved mail', 'Old sender body');
  const received = community.sendMail(bob, alice, 'Private inbox', 'Never inherited');
  store.startCall(alice, 1);
  store.post(alice, 'Old post', 'Old body');
  store.deleteUser(alice);
  const replacement = store.createUser('ALICE', 'new-test-hash');
  assert.notEqual(replacement, alice);
  assert.deepEqual(community.inbox(replacement), []);
  assert.throws(() => community.readMail(replacement, received), /not found/);
  assert.throws(() => community.inbox(alice), /unavailable/);
  assert.equal(community.signature(replacement), '');
  assert.equal(community.config(replacement).user_note, '');
  assert.equal(community.publicStats(replacement).calls, 0);
  assert.equal(community.publicStats(replacement).posts, 0);
  assert.equal(community.readMail(bob, sent).handle, `Deleted user #${alice}`);
  assert.equal(community.readMail(bob, sent).body, 'Old sender body');
});

test('storage revalidates enabled accounts, permissions and recipient at save', t => {
  const { store, community, alice, bob } = setup(t);
  store.setUserDisabled(bob, true);
  assert.throws(() => community.sendMail(alice, bob, 'Subject', 'body'), InputError);
  store.setUserDisabled(bob, false);
  store.editUser(alice, 'can_post', 0);
  for (const action of [
    () => community.sendMail(alice, bob, 'Subject', 'body'),
    () => community.setSignature(alice, 'sig'),
    () => community.setAutomessage(alice, 'auto'),
    () => community.addBbs(alice, 'Board', 'ssh://example.invalid'),
    () => community.addOneliner(alice, 'one')
  ]) assert.throws(action, InputError);
  community.setConfig(alice, 'location', 'Still own profile');
  community.notify(session(store, alice), 'note', 'Can still contact sysop');
  store.setUserDisabled(alice, true);
  for (const action of [
    () => community.inbox(alice), () => community.signature(alice),
    () => community.setConfig(alice, 'location', 'forbidden'),
    () => community.publicStats(alice), () => community.oneliners(alice),
    () => community.notify(session(store, alice), 'page', 'forbidden')
  ]) assert.throws(action, InputError);
});

test('all text is bounded printable text and all list pages validate bounds', t => {
  const { community, alice } = setup(t);
  for (const action of [
    () => community.setSignature(alice, '\x1b[2J'), () => community.setSignature(alice, 'a'.repeat(161)),
    () => community.setConfig(alice, 'real_name', 'a'.repeat(61)),
    () => community.setConfig(alice, 'user_note', 'a'.repeat(61)),
    () => community.setConfig(alice, 'user_note', '\x1b[2J'),
    () => community.setAutomessage(alice, '\x07'), () => community.setAutomessage(alice, 'a'.repeat(161)),
    () => community.addBbs(alice, 'a'.repeat(41), 'address'),
    () => community.addBbs(alice, 'board', 'a'.repeat(101)),
    () => community.addOneliner(alice, 'a'.repeat(121)),
    () => community.sendMail(alice, alice, 'subject', 'a'.repeat(4097))
  ]) assert.throws(action, InputError);
  for (const page of [-1, 0.5, 10000, Infinity, NaN, '0']) {
    for (const query of [
      () => community.inbox(alice, page), () => community.bbsList(alice, page),
      () => community.oneliners(alice, page), () => community.notifications(page)
    ]) assert.throws(query, InputError);
  }
  community.setSignature(alice, 'Own signature');
  assert.equal(community.signature(alice), 'Own signature');
  community.setSignature(alice, '');
  assert.equal(community.signature(alice), '');
});

test('ten-row pagination and bounded mail body reads', t => {
  const { store, community, alice, bob } = setup(t);
  const now = new Date().toISOString();
  for (let n = 0; n < 21; n++) {
    store.db.prepare(`INSERT INTO community_mail(sender_id,recipient_id,subject,body,created_at)
      VALUES (?, ?, ?, ?, ?)`).run(alice, bob, `subject ${n}`, 'x'.repeat(80) + '\n' + Array(20).fill('line').join('\n'), now);
    store.db.prepare('INSERT INTO community_bbs(user_id,name,address,created_at) VALUES (?, ?, ?, ?)')
      .run(alice, `Board ${n}`, 'address', now);
    store.db.prepare('INSERT INTO community_oneliners(user_id,body,created_at) VALUES (?, ?, ?)')
      .run(alice, `One ${n}`, now);
  }
  for (const query of [
    page => community.inbox(bob, page), page => community.bbsList(alice, page), page => community.oneliners(bob, page)
  ]) {
    assert.equal(query(0).length, 10);
    assert.equal(query(1).length, 10);
    assert.equal(query(2).length, 1);
    assert.equal(query(3).length, 0);
  }
  const mail = community.readMail(bob, community.inbox(bob)[0].id);
  assert.equal(mail.body_lines.length, 14);
  assert.equal(mail.pages, 2);
  assert.ok(mail.body_lines.every(line => line.length <= 76));
  assert.equal(community.readMail(bob, mail.id, 1).body_lines.length, 8);
});

test('notes and page requests are private bounded persistent notifications, not live chat', t => {
  const { store, community, alice, bob } = setup(t);
  const guest = session(store, undefined, 7);
  guest.socket = { remoteAddress: 'must-not-be-persisted' };
  const note = community.notify(guest, 'note', 'Private guest note');
  assert.throws(() => community.notify(guest, 'note', 'again'), InputError);
  assert.throws(() => community.notify(session(store), 'page', 'guest page'), InputError);
  const caller = session(store, alice, 2);
  const page = community.notify(caller, 'page', 'Please help');
  assert.throws(() => community.notify(caller, 'page', 'again'), InputError);
  const replacement = new Community(store);
  assert.throws(() => replacement.notify(session(store, alice, 3), 'page', 'new session bypass'), InputError);
  assert.equal(community.notifications().length, 2);
  assert.deepEqual(community.notification(note).body_lines, ['Private guest note']);
  assert.equal(community.notification(note).node, 7);
  assert.equal(community.notification(note).user_id, null);
  assert.equal(JSON.stringify(community.notifications()).includes('Private guest note'), false);
  assert.equal(JSON.stringify(community.notification(note)).includes('must-not-be-persisted'), false);
  assert.equal(JSON.stringify(community.publicStats(bob)).includes('Please help'), false);
  community.resolveNotification(page);
  assert.equal(community.notifications().length, 1);
  assert.ok(community.notification(page).resolved_at);
  assert.throws(() => community.resolveNotification(page), InputError);
});

test('call counters seed old history once and survive pruning without double counts', t => {
  const { store, community, alice } = setup(t);
  store.startCall(alice, 1);
  store.startCall(alice, 1);
  assert.equal(community.publicStats(alice).calls, 2);
  store.db.prepare('DELETE FROM calls WHERE user_id = ?').run(alice);
  initializeCommunity(store.db);
  assert.equal(community.publicStats(alice).calls, 2);
  store.startCall(alice, 1);
  assert.equal(community.publicStats(alice).calls, 3);
  const post = store.post(alice, 'Subject', 'Body');
  assert.equal(community.publicStats(alice).posts, 1);
  store.deleteMessage(post);
  assert.equal(community.publicStats(alice).posts, 0);
});

test('features persist across Store restarts in a project-local disposable database', t => {
  const directory = resolve(`.community-test-${randomUUID()}`);
  // The generated path is inside the project, never a caller-controlled path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = resolve(directory, 'bbs.sqlite');
  let store = new Store(filename);
  try {
    initializeCommunity(store.db);
    let community = new Community(store);
    const alice = store.createUser('Alice', 'test-hash');
    const bob = store.createUser('Bob', 'test-hash');
    community.setSignature(alice, 'Persistent sig');
    community.setConfig(alice, 'location', 'Private place');
    community.setConfig(alice, 'user_note', 'Persistent own stats note');
    community.sendMail(alice, bob, 'Persistent subject', 'Persistent private body');
    community.setAutomessage(alice, 'Persistent auto');
    community.addBbs(alice, 'Persistent board', 'tls://example.invalid:992');
    community.addOneliner(alice, 'Persistent one');
    community.notify(session(store, alice), 'page', 'Persistent request');
    store.startCall(alice, 1);
    store.close();
    store = new Store(filename);
    initializeCommunity(store.db);
    community = new Community(store);
    assert.equal(community.signature(alice), 'Persistent sig');
    assert.equal(community.config(alice).location, 'Private place');
    assert.equal(community.stats(alice).user_note, 'Persistent own stats note');
    assert.equal(community.unread(bob), 1);
    assert.equal(community.automessage(bob).body, 'Persistent auto');
    assert.equal(community.bbsList(bob)[0].name, 'Persistent board');
    assert.equal(community.oneliners(bob)[0].body, 'Persistent one');
    assert.equal(community.notifications()[0].kind, 'page');
    assert.equal(community.publicStats(alice).calls, 1);
    assert.throws(() => community.notify(session(store, alice), 'page', 'restart bypass'), InputError);
  } finally { store.close(); }
});

test('session editors compose mail and enforce live permissions on save', async t => {
  const { store, community, alice, bob } = setup(t);
  const caller = session(store, alice);
  caller.community = community;
  assert.equal(await community.handle(caller, 'unrelated'), false);
  await community.menu(caller, 'email');
  assert.equal(caller.community, community);
  for (const line of ['W', 'bOB', 'Test email', 'Private body', '.']) {
    assert.equal(await community.handle(caller, line), true);
  }
  assert.equal(community.unread(bob), 1);
  await community.menu(caller, 'oneliners');
  await community.handle(caller, 'A');
  store.editUser(alice, 'can_post', 0);
  await community.handle(caller, 'no permission');
  assert.deepEqual(community.oneliners(bob), []);
  assert.match(caller.output, /Posting permission denied/);
  await community.handle(caller, '/abort');
  assert.equal(caller.state, 'main');
  assert.equal(caller.community, community);
  assert.equal(/(?<!\r)\n/.test(caller.output), false);
});

for (const change of ['deleted', 'disabled', 'pending', 'rejected']) {
  test(`mail drafts reject ${change} recipients without delivering to a reused handle`, async t => {
    const { store, community, alice, bob } = setup(t);
    const caller = session(store, alice);
    await community.menu(caller, 'email');
    for (const line of ['W', 'bOB', 'Private subject', 'Confidential draft']) {
      await community.handle(caller, line);
    }
    assert.equal(caller.communityState.recipientId, bob);
    let replacement;
    if (change === 'deleted') {
      store.deleteUser(bob);
      replacement = store.createUser('BOB', 'replacement-hash', true);
      store.decideApplication(replacement, true);
      assert.notEqual(replacement, bob);
    } else if (change === 'disabled') store.setUserDisabled(bob, true);
    else store.db.prepare('UPDATE users SET application_status = ? WHERE id = ?').run(change, bob);
    caller.output = '';
    await community.handle(caller, '.');
    assert.match(caller.output, /Recipient unavailable/);
    assert.doesNotMatch(caller.output, /Private email sent/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM community_mail').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM community_activity').get().n, 0);
    if (replacement) assert.deepEqual(community.inbox(replacement), []);
    assert.equal(caller.communityState.step, 'mail-body');
    await community.handle(caller, '/abort');
    assert.equal(caller.state, 'main');
    assert.equal(caller.communityState, undefined);
  });
}

test('renaming a selected mail recipient never redirects the draft to the old handle owner', async t => {
  const { store, community, alice, bob } = setup(t);
  const caller = session(store, alice);
  await community.menu(caller, 'email');
  for (const line of ['W', 'bOB', 'Private subject', 'Confidential draft']) {
    await community.handle(caller, line);
  }
  store.renameUser(bob, 'RenamedBob');
  const replacement = store.createUser('Bob', 'replacement-hash');
  caller.output = '';
  await community.handle(caller, '.');
  assert.match(caller.output, /Private email sent/);
  assert.equal(community.unread(bob), 1);
  const mailId = community.inbox(bob)[0].id;
  assert.equal(community.readMail(bob, mailId).body, 'Confidential draft');
  assert.deepEqual(community.inbox(replacement), []);
  assert.throws(() => community.readMail(replacement, mailId), /Mail not found/);
});

test('mail delivery requires a valid recipient ID rather than a mutable handle', t => {
  const { community, alice } = setup(t);
  for (const recipientId of ['Bob', '2', undefined, null, 0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => community.sendMail(alice, recipientId, 'Subject', 'body'), /Invalid ID/);
  }
  assert.throws(() => community.sendMail(alice, 999, 'Subject', 'body'), /Recipient unavailable/);
});

test('guest note session returns to login and cannot access any authenticated feature', async t => {
  const { store, community } = setup(t);
  const guest = session(store);
  for (const feature of ['email', 'config', 'signature', 'automessage', 'bbs', 'oneliners', 'page', 'stats']) {
    await assert.rejects(community.menu(guest, feature), InputError);
  }
  await community.menu(guest, 'note');
  await community.handle(guest, 'Guest private message');
  await community.handle(guest, '.');
  assert.equal(guest.state, 'welcome');
  assert.equal(community.notifications().length, 1);
  await assert.rejects(community.menu(guest, 'note'), InputError);
  assert.equal(community.notifications().length, 1);
});

test('pending or rejected applications cannot act or receive mail', t => {
  const { store, community, alice, bob } = setup(t);
  if (!store.db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'application_status')) {
    store.db.exec("ALTER TABLE users ADD COLUMN application_status TEXT NOT NULL DEFAULT 'approved'");
  }
  store.db.prepare("UPDATE users SET application_status = 'pending' WHERE id = ?").run(bob);
  assert.throws(() => community.sendMail(alice, bob, 'subject', 'body'), InputError);
  assert.throws(() => community.inbox(bob), InputError);
  assert.throws(() => community.setConfig(bob, 'location', 'no'), InputError);
  store.db.prepare("UPDATE users SET application_status = 'rejected' WHERE id = ?").run(alice);
  assert.throws(() => community.addOneliner(alice, 'no'), InputError);
  assert.throws(() => community.notify(session(store, alice), 'note', 'no'), InputError);
});

test('list storage caps reject new rows without discarding existing data', t => {
  const { store, community, alice } = setup(t);
  store.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000)
    INSERT INTO community_bbs(user_id,name,address,created_at)
    SELECT ?, 'Board', 'address', '2026-01-01' FROM n`).run(alice);
  assert.throws(() => community.addBbs(alice, 'Full', 'address'), InputError);
  store.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 10000)
    INSERT INTO community_oneliners(user_id,body,created_at)
    SELECT ?, 'Existing', '2026-01-01' FROM n`).run(alice);
  assert.throws(() => community.addOneliner(alice, 'Full'), InputError);
  assert.equal(community.bbsList(alice, 99).length, 10);
  assert.equal(community.oneliners(alice, 999).length, 10);
  assert.equal(community.oneliners(alice, 1000).length, 0);
});

test('legacy recent-call history seeds a durable total exactly once', t => {
  const { store, community, alice } = setup(t);
  store.db.exec('DROP TRIGGER community_count_call; DELETE FROM community_call_counts');
  store.startCall(alice, 1);
  store.startCall(alice, 2);
  initializeCommunity(store.db);
  assert.equal(community.publicStats(alice).calls, 2);
  initializeCommunity(store.db);
  assert.equal(community.publicStats(alice).calls, 2);
  store.startCall(alice, 3);
  assert.equal(community.publicStats(alice).calls, 3);
});

test('all community editors save bounded values and return without privileged routes', async t => {
  const { store, community, alice } = setup(t);
  const caller = session(store, alice);
  for (const [feature, commands] of [
    ['config', ['R', 'Private real name', 'L', 'Private location']],
    ['signature', ['E', 'Own signature']],
    ['automessage', ['W', 'Hello community']],
    ['bbs', ['A', 'Friendly board', 'tls://example.invalid:992']],
    ['oneliners', ['A', 'A friendly one-liner']]
  ]) {
    await community.menu(caller, feature);
    for (const line of commands) await community.handle(caller, line);
    await community.handle(caller, 'Q');
    assert.equal(caller.state, 'main');
  }
  assert.equal(community.config(alice).real_name, 'Private real name');
  assert.equal(community.signature(alice), 'Own signature');
  assert.equal(community.automessage(alice).body, 'Hello community');
  assert.equal(community.bbsList(alice)[0].name, 'Friendly board');
  assert.equal(community.oneliners(alice)[0].body, 'A friendly one-liner');
  await community.menu(caller, 'page');
  await community.handle(caller, 'Please check the board');
  assert.equal(caller.state, 'main');
  assert.equal(community.notifications()[0].kind, 'page');
});

test('stats and email headers use trusted presentation templates with generated private body rows', async t => {
  const { store, community, alice, bob } = setup(t);
  const caller = session(store, bob);
  const rendered = [];
  caller.transfers = { stats: () => ({ uploads: 2, downloads: 3 }) };
  caller.presentation = new Presentation();
  const render = caller.presentation.render.bind(caller.presentation);
  caller.view = values => ({ store, presentation: caller.presentation, values });
  caller.presentation.render = (key, fallback, values) => {
    rendered.push({ key, values });
    return render(key, fallback, values);
  };
  await community.menu(caller, 'stats');
  assert.equal(rendered[0].key, 'stats');
  assert.equal(rendered[0].values.UPLOADS, 2);
  assert.equal(rendered[0].values.DOWNLOADS, 3);
  const mailId = community.sendMail(alice, bob, 'Private template subject',
    'Generated private body\n' + Array.from({ length: 19 }, (_, index) => `Mail line ${index + 2}`).join('\n'));
  store.setString('community_private_mail', '|11Private mail|07');
  await community.menu(caller, 'email');
  await community.handle(caller, String(mailId));
  assert.equal(rendered[1].key, 'message-header');
  assert.equal(rendered[1].values.RECIPIENT, 'Bob');
  assert.equal(plainText(rendered[1].values.BASENAME), 'Private mail');
  assert.ok(caller.output.includes('\x1b[0;1;36;40mPrivate mail'));
  // eslint-disable-next-line no-control-regex
  assert.ok(!caller.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').includes('\x1b'));
  assert.match(caller.output, /Generated private body/);
  assert.equal(caller.communityState.readPages, 3);
  await community.handle(caller, 'N');
  assert.equal(rendered[2].values.PAGE, 2);
  assert.match(caller.output, /Page 2\/3/);
});

test('community fields stay inline, redraws retain save notices, and custom prompt colors remain authoritative', async t => {
  const { store, community, alice } = setup(t);
  const caller = session(store, alice);
  await community.menu(caller, 'config');
  assert.ok(caller.output.startsWith('\x1b[0m\x1b[2J\x1b[H'));
  caller.output = '';
  await community.handle(caller, 'R');
  assert.ok(!caller.output.includes('\x1b[2J'), 'Editing a field must not clear its context');
  await community.handle(caller, 'Private name');
  assert.ok(caller.output.lastIndexOf('\x1b[2J') < caller.output.lastIndexOf('Saved.'));
  assert.equal(community.config(alice).real_name, 'Private name');
  store.setString('community_e_edit_q_main_appended_to_public_posts_only', '|04Custom actions|07');
  caller.output = '';
  await community.menu(caller, 'signature');
  assert.ok(caller.output.includes('\x1b[0;31;40mCustom actions'));
});

test('caller stats note is self-owned and never reveals or edits the private sysop note', async t => {
  const { store, community, alice, bob } = setup(t);
  store.editUser(alice, 'sysop_note', 'PRIVATE LOCAL SYSOP NOTE');
  community.setConfig(alice, 'user_note', 'Own display note');
  assert.equal(community.config(bob).user_note, '');
  community.setConfig(bob, 'user_note', 'Bob owns this');
  assert.equal(community.stats(alice).user_note, 'Own display note');
  assert.equal(community.stats(bob).user_note, 'Bob owns this');
  assert.equal(store.user(alice).sysop_note, 'PRIVATE LOCAL SYSOP NOTE');
  assert.equal(JSON.stringify(community.publicStats(alice)).includes('Own display note'), false);
  assert.equal(JSON.stringify(store.users()).includes('Own display note'), false);
  assert.equal(JSON.stringify(community.stats(alice)).includes('PRIVATE LOCAL'), false);
  const caller = session(store, alice);
  caller.view = values => ({ values });
  caller.presentation = { render(key, fallback, values) {
    assert.equal(values.USERNOTE, 'Own display note');
    return fallback;
  } };
  await community.menu(caller, 'stats');
  assert.equal(caller.output.includes('PRIVATE LOCAL'), false);
  await community.menu(caller, 'config');
  await community.handle(caller, 'N');
  await community.handle(caller, 'Updated own display note');
  assert.equal(community.stats(alice).user_note, 'Updated own display note');
  assert.equal(community.stats(bob).user_note, 'Bob owns this');
});

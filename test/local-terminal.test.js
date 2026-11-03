import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LocalTerminal, terminalText } from '../src/local-terminal.js';
import { Presentation } from '../src/presentation.js';
import { terminal } from './helpers/ansi-terminal.js';

const vga = [
  '#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa',
  '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff'
];

function display() {
  let output = '';
  const renderer = new LocalTerminal({ write: text => { output += text; } });
  return { renderer, output: () => output };
}

test('local startup and resets paint a black background, not the terminal theme', () => {
  for (const size of [{ columns: 80, rows: 25 }, { columns: 120, rows: 40 }]) {
    const { renderer, output } = display();
    renderer.start();
    let screen = terminal(output(), size);
    assert.ok(screen.cells.flat().every(cell => cell.bg === '#000000'));
    assert.equal(screen.scrolls, 0);
    renderer.write('\x1b[41mX\x1b[0m\x1b[2J\x1b[H');
    renderer.write('\x1b[49mA\x1b[mB\x1b[44mC\x1b[49m\x1b[K');
    screen = terminal(output(), size);
    assert.deepEqual(screen.cells[0].slice(0, 3).map(cell => cell.bg), ['#000000', '#000000', '#0000aa']);
    assert.equal(screen.cells[0][3].bg, '#000000');
    assert.equal(screen.cells[24][79].bg, '#000000');
    assert.ok(!screen.cells.flat().some(cell => cell.bg === '#303030'));
  }
});

test('24-row local terminals use valid margins and clamp cursor movement to the visible area', () => {
  let frame = '';
  const renderer = new LocalTerminal({ rows: 24, write: text => { frame += text; } });
  renderer.write('\x1b[999;1HBottom\x1b[r\x1b[24;80HX');
  const screen = terminal(frame, { columns: 80, rows: 24 });
  assert.ok(frame.includes('\x1b[1;24r'));
  assert.ok(!frame.includes('\x1b[1;25r'));
  assert.equal(screen.cells[23][79].char, 'X');
  assert.equal(screen.scrolls, 0);
});

test('all classic foreground/background colors use exact VGA RGB, including bold and bright codes', () => {
  const { renderer, output } = display();
  let source = '';
  for (let index = 0; index < 16; index++) {
    source += `\x1b[0;${index >= 8 ? '1;' : ''}${30 + index % 8}mF`;
  }
  source += '\r\n';
  for (let index = 0; index < 16; index++) source += `\x1b[0;${(index < 8 ? 40 : 100) + index % 8}mB`;
  source += '\r\n';
  for (let index = 0; index < 16; index++) source += `\x1b[0;${(index < 8 ? 30 : 90) + index % 8}mF`;
  renderer.write(source);
  const screen = terminal(output());
  assert.deepEqual(screen.cells[0].slice(0, 16).map(cell => cell.fg), vga);
  assert.deepEqual(screen.cells[1].slice(0, 16).map(cell => cell.bg), vga);
  assert.deepEqual(screen.cells[2].slice(0, 16).map(cell => cell.fg), vga);
  // eslint-disable-next-line no-control-regex
  const colors = [...output().matchAll(/\x1b\[([0-9;]*)m/g)];
  assert.ok(colors.every(match => match[1].startsWith('0;38;2;')),
    'Brightness must use RGB, not theme/bold-font preferences');
});

test('local color state survives fragmented writes, inverse/selective resets and extended colors', () => {
  const { renderer, output } = display();
  renderer.write('\x1b[1;3');
  renderer.write('1mA');
  renderer.write('B\x1b[22mC\x1b[44;7mD\x1b[27mE\x1b[39;49mF');
  renderer.write('\x1b[38;2;1;2;3;48;2;4;5;6mG');
  renderer.write('\x1b[38;5;4;48;5;11mH\x1b[38;5;196mI\x1b[38;5;244mJ');
  const cells = terminal(output()).cells[0];
  assert.deepEqual(cells.slice(0, 6).map(cell => [cell.fg, cell.bg]), [
    ['#ff5555', '#000000'], ['#ff5555', '#000000'], ['#aa0000', '#000000'],
    ['#0000aa', '#aa0000'], ['#aa0000', '#0000aa'], ['#aaaaaa', '#000000']
  ]);
  assert.deepEqual([cells[6].fg, cells[6].bg], ['#010203', '#040506']);
  assert.deepEqual([cells[7].fg, cells[7].bg], ['#0000aa', '#ffff55']);
  assert.equal(cells[8].fg, '#ff0000');
  assert.equal(cells[9].fg, '#808080');
  assert.throws(() => renderer.write('\x1b[38;2;999;0;0m'), /Invalid local terminal color/);
  assert.throws(() => display().renderer.write('\x1b[' + '1'.repeat(129)), /Invalid local terminal control/);
});

test('the local 80x25 viewport wraps and scrolls identically on 80x25 and larger hosts', () => {
  const { renderer, output } = display();
  renderer.write('X'.repeat(80) + 'Y\r\n' + 'Z'.repeat(80) + '\b \bQ');
  renderer.write('\x1b[999;999H!\r\nbottom');
  const small = terminal(output());
  const large = terminal(output(), { columns: 120, rows: 40 });
  assert.equal(small.scrolls, 1);
  assert.equal(large.scrolls, 1);
  assert.deepEqual(small.cells, large.cells.slice(0, 25).map(row => row.slice(0, 80)));
  assert.ok(large.cells.every((row, index) => row.slice(index < 25 ? 80 : 0)
    .every(cell => cell.char === ' ' && cell.bg === '#000000')));
});

test('local no-wrap, relative cursors and saved cursor positions stay within 80x25', () => {
  const { renderer, output } = display();
  renderer.write('\x1b[?7l' + 'X'.repeat(81) + 'Y');
  renderer.write('\x1b[2;3H\x1b[s\x1b[999C!\x1b[999B?\x1b[uS');
  renderer.write('\x1b[999A\x1b[999D@\x1b[?7h');
  const screen = terminal(output(), { columns: 120, rows: 40 });
  assert.equal(screen.cells[0][79].char, 'Y');
  assert.equal(screen.cells[0][80].char, ' ');
  assert.equal(screen.cells[1][2].char, 'S');
  assert.equal(screen.cells[0][0].char, '@');
  assert.equal(screen.cells[24][79].char, '?');
  assert.equal(screen.scrolls, 0);
});

test('cursor movement and erasure at column 80 behave the same on wider terminals', () => {
  const { renderer, output } = display();
  renderer.write('X'.repeat(80) + '\x1b[DZ');
  renderer.write('\r\n' + 'Y'.repeat(80) + '\x1b[K!');
  const small = terminal(output());
  const large = terminal(output(), { columns: 120, rows: 40 });
  assert.equal(small.cells[0][78].char, 'Z');
  assert.equal(small.cells[1][79].char, '!');
  assert.deepEqual(small.cells, large.cells.slice(0, 25).map(row => row.slice(0, 80)));
});

test('supplied ANSI artwork keeps every glyph and DOS palette cell in the local renderer', () => {
  const presentation = new Presentation(fileURLToPath(new URL('../examples/ansi', import.meta.url)));
  const values = {
    BBSNAME: 'Test BBS', USERNAME: 'Caller', NODE: 1, DATE: '2026-11-02',
    TRANSPORT: 'Local', TAGLINE: 'Test', CALLS: 1, POSTS: 2, MAIL: 3, UPLOADS: 4, DOWNLOADS: 5,
    ACCESS: 'Caller', USERNOTE: 'Note', PAGE: 1, BASENAME: 'General', BASEID: 1,
    MESSAGEID: 1, MESSAGEAUTHOR: 'Caller', MESSAGESUBJECT: 'Subject', MESSAGEDATE: '2026-11-02 12:00'
  };
  for (const name of ['loginmatrix', 'login', 'welcome', 'main-new', 'stats', 'new-message-header']) {
    const source = presentation.render(name, '', values);
    assert.ok(source, name);
    const expected = terminal(terminalText(source), {
      palette: vga, defaultForeground: '#aaaaaa', defaultBackground: '#000000'
    });
    const { renderer, output } = display();
    renderer.write(source);
    const actual = terminal(output(), { columns: 120, rows: 40 });
    assert.deepEqual(actual.cells.slice(0, 25).map(row => row.slice(0, 80)), expected.cells, name);
    assert.equal(actual.scrolls, expected.scrolls, name);
    assert.ok(actual.cells.every((row, index) => row.slice(index < 25 ? 80 : 0)
      .every(cell => cell.char === ' ' && cell.bg === '#000000')), name);
  }
});

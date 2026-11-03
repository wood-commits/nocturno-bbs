const hostPalette = [
  '#202020', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#cccccc',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'
];

export function terminal(frame, { columns = 80, rows = 25, palette = hostPalette,
  defaultForeground = '#cccccc', defaultBackground = '#303030' } = {}) {
  let row = 0, column = 0, scrolls = 0, top = 0, bottom = rows - 1;
  let foreground, background, bold, inverse, wrap = true, saved = [0, 0];
  const reset = () => { foreground = defaultForeground; background = defaultBackground; bold = inverse = false; };
  reset();
  const color = (value, bright = false) => typeof value === 'number' ? palette[value | (bright ? 8 : 0)] : value;
  const attributes = () => {
    const fg = color(foreground, bold), bg = color(background);
    return { fg: inverse ? bg : fg, bg: inverse ? fg : bg };
  };
  const blank = () => Array.from({ length: columns }, () => ({ char: ' ', ...attributes() }));
  const cells = Array.from({ length: rows }, blank);
  const advance = () => {
    if (row === bottom) {
      scrolls++;
      cells.splice(top, 1);
      cells.splice(bottom, 0, blank());
    } else row = Math.min(rows - 1, row + 1);
  };
  // Model a themed host, background-color erase, truecolor and native wrapping.
  // eslint-disable-next-line no-control-regex
  for (const part of String(frame).matchAll(/\x1b\[([0-9;?]*)([A-Za-z])|[\s\S]/g)) {
    const command = part[2];
    if (command) {
      const values = part[1].split(';').map(Number);
      const amount = values[0] || 1;
      if (command === 'H' || command === 'f') {
        row = Math.min(rows - 1, Math.max(0, amount - 1));
        column = Math.min(columns - 1, Math.max(0, (values[1] || 1) - 1));
      } else if (command === 'A') row = Math.max(0, row - amount);
      else if (command === 'B') row = Math.min(rows - 1, row + amount);
      else if (command === 'C') column = Math.min(columns - 1, column + amount);
      else if (command === 'D') column = Math.max(0, column - amount);
      else if (command === 's') saved = [row, column];
      else if (command === 'u') [row, column] = saved;
      else if (command === 'r') {
        top = amount - 1;
        bottom = (values[1] || rows) - 1;
        row = column = 0;
      } else if (part[1] === '?7') wrap = command === 'h';
      else if (command === 'J' && values[0] === 2) {
        for (let index = 0; index < rows; index++) cells[index] = blank();
      } else if (command === 'K') {
        const start = values[0] === 1 || values[0] === 2 ? 0 : column;
        const end = values[0] === 1 ? column + 1 : columns;
        for (let index = start; index < end; index++) cells[row][index] = { char: ' ', ...attributes() };
      } else if (command === 'm') {
        for (let index = 0; index < values.length; index++) {
          const code = values[index];
          if (code === 0) reset();
          else if (code === 1) bold = true;
          else if (code === 22) bold = false;
          else if (code === 7) inverse = true;
          else if (code === 27) inverse = false;
          else if (code === 39) foreground = defaultForeground;
          else if (code === 49) background = defaultBackground;
          else if (code >= 30 && code <= 37) foreground = code - 30;
          else if (code >= 40 && code <= 47) background = code - 40;
          else if (code >= 90 && code <= 97) foreground = code - 90 + 8;
          else if (code >= 100 && code <= 107) background = code - 100 + 8;
          else if ((code === 38 || code === 48) && values[index + 1] === 2) {
            const rgb = '#' + values.slice(index + 2, index + 5).map(value => value.toString(16).padStart(2, '0')).join('');
            if (code === 38) foreground = rgb;
            else background = rgb;
            index += 4;
          }
        }
      }
    } else if (part[0] === '\r') column = 0;
    else if (part[0] === '\n') advance();
    else if (part[0] === '\b') column = Math.max(0, column - 1);
    else if (part[0] !== '\x07') {
      if (column === columns) {
        if (wrap) { advance(); column = 0; }
        else column = columns - 1;
      }
      cells[row][column++] = { char: part[0], ...attributes() };
    }
  }
  return { cells, row, column, scrolls, text: cells.map(line => line.map(cell => cell.char).join('')).join('\n') };
}

import { InputError } from './validation.js';

// Quoted reply lines fit the reader width with room for the "XX> " prefix.
export const QUOTE_WIDTH = 72;

// Classic initials: one letter per handle word ("Night_Owl" -> "NO"), at most three.
export function quotePrefix(handle) {
  const words = String(handle).split(/[_-]+/).filter(word => /^[A-Za-z0-9]/.test(word));
  const initials = words.length > 1
    ? words.slice(0, 3).map(word => word[0]).join('')
    : String(handle).replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
  return `${(initials || 'XX').toUpperCase()}> `;
}

// Wrap the original body into numbered source lines. Bodies are already printable ASCII.
export function quoteLines(body, prefix) {
  const width = QUOTE_WIDTH - prefix.length;
  return String(body).split('\n').flatMap(line => {
    if (!line) return [''];
    const wrapped = [];
    let rest = line;
    while (rest.length > width) {
      const space = rest.lastIndexOf(' ', width);
      const cut = space > width / 2 ? space : width;
      wrapped.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    wrapped.push(rest);
    return wrapped;
  });
}

// "/Q" lists; "/Q n" or "/Q n-m" selects an inclusive, 1-based range.
export function parseQuote(argument, count) {
  if (!argument) return undefined;
  const parts = argument.split('-');
  const valid = parts.length <= 2 && parts.every(part => /^[1-9][0-9]{0,2}$/.test(part));
  const first = Number(parts[0]), last = Number(parts.at(-1));
  if (!valid || first > last || last > count) throw new InputError('error_message_quote_range', { COUNT: count });
  return { first, last };
}

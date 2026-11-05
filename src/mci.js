// Common codes follow Mystic's display-code meanings; contextual fields use extensions.
export const shortMci = new Map([
  ['BN', 'BBSNAME'], ['UH', 'USERNAME'], ['ND', 'NODE'], ['DA', 'DATE'],
  ['CS', 'CALLS'], ['MP', 'POSTS'], ['MU', 'MAIL'], ['FU', 'UPLOADS'],
  ['DL', 'DOWNLOADS'], ['SD', 'ACCESS'], ['UI', 'USERNOTE'], ['MB', 'BASENAME']
]);
const codes = new Map([...shortMci].map(([code, name]) => [name, `|${code}`]));

export const mciCode = name => codes.get(name) ?? `|{${name}}`;
export const mciName = token => token.startsWith('|{') ? token.slice(2, -1).split(':')[0] : shortMci.get(token.slice(1));
export const mciWidth = token => /^\|\{[A-Z][A-Z0-9_]*:([1-9][0-9]{0,2})\}$/.exec(token)?.[1];
export const mciPattern = () => /\|\||\|\{[^|}\r\n]*\}?|\|[A-Za-z0-9]{1,2}/g;
export const isMciColor = token => /^\|(?:0[0-9]|1[0-9]|2[0-3])$/.test(token);

export function mciTokens(source) {
  return [...source.matchAll(mciPattern())].map(match => ({
    token: match[0], name: mciName(match[0]), index: match.index
  }));
}

export function validMci(token, allowed) {
  if (token === '||' || isMciColor(token)) return true;
  const name = mciName(token);
  return name !== undefined && allowed.includes(name) &&
    (mciCode(name) === token || (mciWidth(token) !== undefined && Number(mciWidth(token)) <= 160 &&
      !/^(?:BODY|LOGINHANDLE|LOGINPASSWORD|CHOICE[1-5])$/.test(name)));
}

export function migrateMci(source) {
  // Escape existing pipes first: legacy overrides interpreted only numeric colors.
  return source.replace(/\|\||\|(?:0[0-9]|1[0-9]|2[0-3])|\||%([A-Z][A-Z0-9_]*)%/g,
    (token, name) => name ? mciCode(name) : token === '|' ? '||' : token);
}

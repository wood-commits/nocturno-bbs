export function reportError(error) {
  const label = error?.code ?? error?.name;
  const code = typeof label === 'string' ? label.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '?') : 'Error';
  process.stderr.write(`\r\n[BBS error: ${code}] See README troubleshooting; no credentials logged.\r\n`);
}

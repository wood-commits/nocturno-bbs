# Nocturno BBS contributor instructions

Read README.md before changing protocols, authentication or deployment behavior.
Use the project skill at `.github/skills/bbs-development/SKILL.md` for BBS work.

- Use Node.js 24.13+ ESM and built-in APIs. There are no runtime dependencies.
- Keep plaintext telnet bound to loopback; remote access requires TLS or SSH.
- Treat every caller byte and stored display field as untrusted. Only renderers
  may generate ANSI. Never log passwords, commands or raw client input.
- Render screen line breaks as explicit CRLF (`\r\n`), including ANSI art.
  Bare LF moves down without returning to column one in telnet terminals.
- Preserve bounded parsers, queues, connections, password work and output.
- All message-board routes require an authenticated caller. SQL uses parameters.
- Sysop commands are local-TTY or explicitly enabled authenticated local MCP
  only. Require confirmation for destructive menu actions; never add a telnet
  shortcut into the console controller. MCP callers still authenticate normally.
- Saved SQLite settings override the initial environment BBS name. Apply
  registration/account changes even during asynchronous authentication; connection
  timeouts are captured when a session starts.
- Preserve user/message IDs. Removed message content is cleared and its ID stays
  reserved. Keep additive schema upgrades compatible with existing databases.
- Use `InputError` for safe caller-facing validation failures. Report unexpected
  errors and disconnect; never disguise a failure as successful authentication.
- Update targeted tests and README.md alongside behavior changes.
- Run `npm test`, `npm run lint`, `npm run sast`, and `npm run audit`.
- Use only temporary test databases/certificates. Never commit data or PEM keys.
- Keep the project skill current when architecture or security invariants change.

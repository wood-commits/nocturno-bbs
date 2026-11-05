import { InputError } from './validation.js';
import { screenTokens } from './presentation.js';

const startupStages = new Map([
  ['configuration', 'reading environment configuration'],
  ['database', 'opening the SQLite database'],
  ['services', 'initializing BBS artwork, authentication and listeners'],
  ['mcp', 'starting the local MCP service'],
  ['console', 'starting the local sysop console']
]);
const startupHints = new Map([
  ['configuration', 'Check BBS_NAME, BBS_PORT, BBS_TLS_* and BBS_MCP_* settings.'],
  ['database', 'Check BBS_DATA_DIR permissions, available disk space and database integrity. Do not run two owners of the same database.'],
  ['services', 'Check artwork against ANSI.md and listener settings against README troubleshooting.'],
  ['mcp', 'Check the local IPC endpoint, permissions and whether another MCP service owns it.'],
  ['console', 'Use an interactive terminal, or set BBS_DASHBOARD=0 to run without the local console.']
]);
const knownStartupReasons = new Map([
  ['Port must be 1-65535.', 'BBS_PORT and BBS_TLS_PORT must be integers from 1 to 65535.'],
  ['Set both BBS_TLS_CERT and BBS_TLS_KEY to enable TLS.', 'Set both BBS_TLS_CERT and BBS_TLS_KEY, or leave both unset.'],
  ['BBS_MCP_SYSOP must be 0 or 1.', 'BBS_MCP_SYSOP must be 0 or 1.'],
  ['BBS_MCP_TOKEN must be 64 hexadecimal characters generated randomly.', 'BBS_MCP_TOKEN must contain 64 randomly generated hexadecimal characters. The token is not logged.'],
  ['MCP requires a local IPC endpoint.', 'BBS_MCP_ENDPOINT must be a valid local IPC endpoint, not a network address.'],
  ['Invalid MCP sysop flag.', 'The MCP sysop flag must be a boolean.'],
  ['The local ansi path must be a directory.', 'The local ansi path exists but is not a directory.'],
  ['Saved display string exceeds the MCI source limit after migration.',
    'A saved display string exceeds 512 source characters after MCI conversion. The migration was rolled back; shorten the override using the previous version before upgrading.'],
  ['Unsupported or damaged password hash', 'A stored password hash is unsupported or damaged. Check database integrity; do not edit credential fields manually.'],
  ['message-header.ans must leave room for message text: |{BODY} at row 1-20, column 1-77.',
    'message-header.ans: |{BODY} must be on rows 1-20, columns 1-77 to leave room for message text.']
]);
const artworkReasons = new Map([
  ['error_invalid_ansi_file_value_ans_maximum_16_kib', 'The template must be a regular file no larger than 16 KiB.'],
  ['error_ansi_files_must_not_have_a_bom_value_ans', 'Remove the UTF-8 BOM; save as ASCII or DOS CP437.'],
  ['error_invalid_sauce_metadata_value_ans', 'The trailing SAUCE metadata or comment block is malformed.'],
  ['error_unsupported_ansi_controls_value_ans', 'Unsupported terminal controls or telnet IAC bytes; only the ANSI.md allowlist is accepted.'],
  ['error_unsupported_placeholder_in_value_ans_value', 'An unsupported MCI code was found. Check this screen\'s codes in ANSI.md.'],
  ['error_expanded_ansi_file_is_too_large_value_ans', 'The expanded artwork exceeds the 32 KiB output limit. Reduce artwork or MCI codes.']
]);
const systemStartupReasons = new Map([
  ['EADDRINUSE', 'A configured port or local IPC endpoint is already in use. Change the configured endpoint or stop its owning service.'],
  ['EACCES', 'Access was denied. Check file, directory and listener permissions.'],
  ['EPERM', 'The operation was not permitted. Check file, directory and listener permissions.'],
  ['ENOENT', 'A required file or directory was not found. Check TLS certificate/key paths and data/artwork directories.'],
  ['ENOSPC', 'There is not enough disk space to initialize the database or service.'],
  ['ERR_SQLITE_ERROR', 'SQLite initialization failed. Check permissions, database integrity and other processes using the database.'],
  ['ERR_SQLITE_BUSY', 'SQLite is busy. Another process may own this database.'],
  ['ERR_OSSL_PEM_NO_START_LINE', 'A TLS certificate or key is not valid PEM. Check the configured certificate/key files.']
]);

export function reportError(error) {
  const label = error?.code ?? error?.name;
  const code = typeof label === 'string' ? label.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '?') : 'Error';
  process.stderr.write(`\r\n[BBS error: ${code}] See README troubleshooting; no credentials logged.\r\n`);
}

export function reportStartupError(error, stage) {
  reportError(error);
  let reason = systemStartupReasons.get(error?.code) ?? knownStartupReasons.get(error?.message);
  if (error instanceof InputError) {
    const artwork = artworkReasons.get(error.stringKey);
    if (artwork) {
      const screen = error.values?.SCREEN;
      reason = screenTokens.has(screen) ? `${screen}.ans: ${artwork}` : artwork;
    } else if (stage === 'configuration' && error.stringKey === 'error_value_must_contain_1_value_printable_ascii_characters') {
      reason = 'BBS_NAME must contain 1-40 printable ASCII characters.';
    }
  }
  if (!reason && typeof error?.code === 'string' && error.code.startsWith('ERR_TLS_')) {
    reason = 'TLS initialization failed. Check matching PEM files, certificate format and protocol settings.';
  }
  process.stderr.write(`Startup stage: ${startupStages.get(stage) ?? 'initializing the BBS'}.\r\n` +
    (reason ? `Cause: ${reason}\r\n` : '') +
    `${startupHints.get(stage) ?? 'See README troubleshooting for this error code.'}\r\n`);
}

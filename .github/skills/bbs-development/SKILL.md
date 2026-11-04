---
name: bbs-development
description: "Build, debug, test or extend Nocturno BBS. Use for Node.js telnet/TLS negotiation, ANSI menus, authentication, SQLite messages, WFC sysop menus, local console configuration, user management, moderation, security scans and BBS session changes."
---

# Nocturno BBS development

## Orientation

Read the root README.md and AGENTS.md. This is a single-process Node.js 24.13+
ESM application with no runtime packages. Message and file bases use role-based
access controls. There is no telnet/remote-account sysop privilege. Opt-in local
MCP automation can explicitly receive local console authority.

Follow the byte-to-screen path:

1. `src/config.js` reads trusted operator environment variables.
2. `src/server.js` owns loopback TCP, optional TLS, socket admission and shutdown.
3. `src/telnet.js` incrementally decodes telnet/NVT, bounded lines, lightbar keys
   and transparent transfer bytes. Raw transfer data still passes telnet decoding.
4. `src/session.js` owns authentication and menu/editor/read states per socket.
5. `src/auth.js` owns scrypt, timing-safe checks and bounded password work.
6. `src/store.js` owns SQLite schema, queries and public data projections.
7. `src/screens.js` produces ANSI menus and the local sysop dashboard.
8. `src/index.js` owns startup and graceful shutdown. `src/errors.js` supplies
   the shared sanitized reporter for the executable and server default:
   allowlisted code/name only, at most 64 characters, never message/stack.
   Trusted custom onError callbacks still receive original errors; never log them raw.
9. `src/sysop.js` owns local sysop navigation, confirmations and bounded raw-TTY
   keyboard input. It is never reachable from a caller's telnet session.
10. `src/presentation.js` loads fixed optional ANSI templates at startup, validates
    controls/placeholders/size and sanitizes substitutions.
    See ANSI.md for per-screen tokens; list rows and message bodies stay generated.
    Private `ansi` is ignored by Git. If absent, load original `examples/ansi`;
    an existing private directory uses built-in fallbacks for missing files.
    Tests of bundled screens explicitly select the sample directory; clean-checkout
    entry tests copy only publishable files and create temporary default data.
    `src/string-catalog.js` defines editable defaults; `src/strings.js` renders
    trusted Renegade pipe templates with sanitized, one-pass substitutions.
11. `src/doors.js` owns the original Frontier Realms game, atomic PvP actions,
    daily UTC turns and bounded persistent resources. Additive farm/market/
    watchtower levels (0-10) cost escalating gold and one turn; they boost
    harvest/exploration/defense. Generated command/development/rankings/help
    screens fit 78 columns and 24 rows. Session shortcuts E/T/H/F/M/W act
    immediately; A ID uses Enter. B/C/L/? navigate free views; N/P page rankings.
12. `src/community.js` owns private mail, caller preferences/signatures, community
    content, private sysop notes/pages and durable per-user statistics.
13. `src/transfers.js`, `src/transfer-zmodem.js` and `src/transfer-qwk.js` own
    approved file transfers and bounded offline message packets.
14. `src/access.js` owns additive role/file-base migrations, local role/grant
    management and live caller authorization. Each user has one role; Member
    (ID 1) preserves old access, new custom roles deny by default. Missing grants
    deny. Caller reads use access.message/messages/messageBases, never the trusted
    local-console store.message/messages/bases APIs directly.
15. `src/mcp-server.js` owns opt-in, token-authenticated local IPC MCP;
      `src/mcp.js` bridges stdio without opening SQLite. `src/mcp-terminal.js`
      reuses normal caller sessions (including raw telnet transfers) or the
      shared sysop keyboard/controller adapter. `src/mcp-transport.js` bounds
      newline-delimited JSON. Never add a network MCP listener or telnet sysop
      route. Require BBS_MCP_SYSOP=1 for local automation console authority.
      Preserve client-owned terminals, ordinary user authentication/live grants,
      YES confirmations, hidden password output and sanitized error reporting.
      Close owned callers and detach watchers/chat on client disconnect.
      Bound clients (8), terminals (4/client), MCP sysops (1), input (64 KiB),
      queued input (16 / 128 KiB), requests (60 burst / 10 per second), unread
      terminal output (128 KiB), sends (8192 bytes), and transport output (1 MiB).
      Capture terminal idle/lifetime settings; reads must not keep callers alive.

## Sysop operations

- WFC hotkeys S/U/B/C/N/A/F/R/Q open configuration/users/messages/callers/nodes/
  applications/files/sysop requests/quit.
  L opens a normal local BBS login, never automatic sysop authentication.
  N/W ID watches an authenticated node; watch C starts chat, H requires YES
  for hangup, Q/Escape leaves. Chat Escape restores the prior caller state/screen.
  Keep partial input, queued/busy work and binary transfers out of chat break-in.
  Mirror only rendered strings, never protocol/binary buffers or passwords.
  Screen history is memory-only, bounded at 128 KiB and reset on full clear;
  overflow blocks new replay/chat until the next clear. Translate CP437 to
  Unicode only for the local terminal. Keep slow local output bounded.
  Local login uses an in-process LocalSocket and the shared Session/auth limits;
  it counts toward 32 sessions, shares loopback authentication quotas, and
  explicitly rejects binary transfers. Escape/logoff/disconnect returns to WFC.
  Detach listeners/reset console input on close; console stop ends remote chat
  without hanging up the caller, but disconnects a console-owned local login.
  Route every local console write through LocalTerminal: an 80x24/25 viewport
  with native autowrap disabled, explicit wrapping/cursor bounds, viewport-height scroll
  margins, CP437 translation and stateful VGA-to-truecolor SGR conversion.
  Resets/39/49 must use explicit DOS gray/black, never host theme defaults;
  bold selects bright VGA RGB without emitting bold-font styling. Keep
  explicit RGB/indexed colors, inverse and selective resets correct across writes.
  Clear unused host space black; do not resize the host or modify its palette.
  WFC shows up to six nodes (five with two listeners on 24 rows); N lists all. Console bases show five per page, mapped
  onto the store's ten-base pages. Reserve the bottom five rows for two notice
  rows, two prompt rows and input overflow. Compact the header on 24 rows to
  retain all 17 body rows; message reading uses 13 body lines instead of 14.
  Resize margins/footer with the host without losing partial input.
  Input follows the prompt by visible width, advancing
  to the next row (at most the viewport height) if fewer than two columns remain; horizontally
  scroll input within the remaining line and reserve a column for the cursor.
  Keep remote ANSI/CP437 unchanged and restore native wrapping/margins on exit.
  WFC title bars/dividers span 80 columns. Place the shortcut grid directly
  after the visible nodes; do not reserve empty node rows. WFC and configuration
  shortcut rows share sysopMenuRow: 24 visible-column cells, two-column gaps,
  at columns 3/29/55. Split only these trusted UI rows, never caller content
  or completed frames. Preserve StyledText provenance and saved colors while
  clipping/padding by visible width. Defaults distinguish yellow hotkeys,
  cyan brackets/headings, gray labels and white/green live values.
  Two-cell configuration rows also use sysopMenuRow; show an explicit Q return.
  Sysop tables use colored headings/IDs/values and bounded columns; mark clipped
  subjects/file names with ellipses and label empty list pages. Local message
  readers suppress the inline caller footer so only the fixed console prompt remains.
  Standalone submenu keys are immediate. Fields, confirmations and commands with
  arguments use Enter; user-editor P also requires Enter to preserve P ID commands.
  See README.md for their syntax.
- The local user list accepts a numeric ID (or V ID) to open a numbered form:
  1 handle, 2 real name, 3 location, 4 sysop note, 5 posting, 6 doors,
  7 disabled, 8 role ID. Numbers are immediate; text and YES confirmations use Enter.
  Keep legacy list commands, private-field clearing/validation, live permission
  checks and disable/disconnect behavior. Q restores the same user-list page.
  X in the form or X ID in the list deletes an account only after YES. Preserve
  D ID/E ID disable/enable. Store.deleteUser atomically tombstones the reserved
  ID (users.deleted), clears credentials/private fields/community_profiles and
  frees the handle; historical content joins to "Deleted user #ID". Exclude
  tombstones from account/application lookup/lists/stats and all re-enable/edit
  routes. Server.deleteUser disconnects active callers; live auth/grants reject
  deleted IDs, including during scrypt. Reusing a handle never reuses ownership.
- Keep the dashboard refresh confined to WFC with no partial input/prompt;
  timers must not overwrite edits or confirmations. Use an owned keyboard decoder
  and alternate screen. On shutdown (including raw Ctrl+C, confirmed quit and
  process exit), pause/unref idle stdin before restoring raw mode, detach owned
  listeners and restore the shell screen/cursor/wrapping before async teardown.
  Preserve pre-existing input listeners and intentionally flowing/raw input.
- Saved settings live in SQLite and override the initial BBS_NAME seed. Name
  and registration apply live; timeout settings apply to new connections.
  The package/MCP server name is nocturno-bbs and the default board name is
  Nocturno BBS. Preserve saved names on upgrade. QWK exports use NOCTURNO;
  legacy NIGHTWIR reply packets remain accepted with matching headers and
  unchanged live authorization.
- Rename users without changing IDs. Disabled accounts must fail generic login
  even if disabled while scrypt is running, and active sessions must disconnect.
  Closing registration must also stop signups already deriving a password.
- Remote registration creates pending applications only after matching password
  entries; confirmation stays hidden,
  reuses ~LP with ~LI instructions, and mismatches restart the password pair.
  Clear the bounded temporary password on mismatch, abort, disconnect and cleanup.
  Only local confirmed application approval enables login. Existing users migrate as approved.
  Checking application status requires password verification and never creates
  an authenticated session or call. Pending/rejected accounts cannot post or play.
- Confirm mutations and hangups with YES. Do not expose password hashes to the
  console. Removing a post clears subject/body and keeps a reserved row/ID;
  queries exclude removed posts and callers revalidate cached reads.
- Public message readers accept immediate R to compose in the same base with
  an editable Re: subject (Enter keeps the displayed default). Reuse W's editor,
  signatures, 10-second cooldown and live grants. Store.post accepts an optional
  replyTo; the additive nullable messages.reply_to foreign key keeps the reserved
  parent ID. Validate an existing, readable same-base parent at save time, never
  accept a removed parent. Existing replies remain readable after parent removal.
  Show reply context in the template page indicator or generated header; reduce
  generated body page sizes accordingly, including local 24/25-row readers.
  Clear reply state on cancellation/cleanup and render saved notices after redraw.
- Existing databases use additive upgrades for users.disabled,
  messages.removed, message bases, private user info, can_post/can_doors,
  display strings, realms and the singleton settings table. Preserve existing data.
- S/B creates/lists bases, S/U edits users, S/T edits display strings. WFC B
  moderates General; base manager O ID moderates another base. Callers M/B
  select a base; IDs remain global. Existing posts migrate to General (ID 1).
- S/R manages roles: C name creates, V ID/numeric ID opens grants, G post doors
  sets global flags, M base read post and F base list download upload set base
  grants. Every mutation requires YES. U/ID/8 or A user role assigns a role.
  S/F creates file bases or O ID opens their catalog; WFC F lists all files.
  Local F/M file base moves files with YES. Caller F/B selects accessible bases.
  New bases grant Member full access only; never reseed revoked grants.
  Posting requires read + base post + role post + user post; file downloads and
  uploads require list + the matching grant, uploads also require role/user post.
  Global role posting also restricts community/mail writes; door actions require
  role/user doors. Role grants never override approval/disabled flags.
  Filter accessible bases before pagination and QWK messages before the 100-post
  limit. QWK conference names/indexes/bodies exclude denied bases and REP imports
  check all target grants atomically. Recheck cached reads, composition, transfer
  writes/completion and chat restoration; never replay revoked cached content.
- User info fields are private to the owner/local console (sysop notes local-only);
  public user lists never include private
  profiles, notes or hashes. Posting/door permissions apply live, not remote
  sysop rights. Require YES for user mutations, new bases and string resets.
- Caller D/1 opens Frontier Realms. Never launch shell doors or execute templates.
  Check enabled account and door permissions on game commands; enforce posting
  permissions at the storage boundary and during composition.
- Login/main menus use arrow keys and Enter, with immediate letter shortcuts.
  Login password errors and application/status notices go through showWelcome
  and the loginMatrix renderer, never append a second selection prompt.
  Artwork notices replace row 23 with 79 visible columns; row 24 stays the prompt.
  Login field markers never interpolate a password. Post-login welcome artwork
  and main A replays stream at 2,880 bytes/second (28.8k, 8N1), preserving CSI/
  CRLF chunks. Ignore playback keys, show the pause prompt only after completion,
  and cancel playback timers on disconnect. Other output stays unpaced.
  Post-login artwork pauses for any key before main. Main `?` shows shortcuts;
  `/G` still logs off.
- Main initially selects Messages (M), the first left-column item. Keep its
  remembered selection separate from login selection, update it for arrows and
  direct shortcuts, and restore it after sections/help/artwork. The generated
  fallback and arrow navigation share mainChoiceGrid with the artwork layout.
- Community/file/QWK section and page redraws use the shared clearing heading;
  field steps and validation retries stay inline. Realm redraws clear/replay
  optional art before generated content. Render save/transfer notices after the
  new frame, not immediately before a clearing redraw. Preserve string overrides.
- Strings cover caller and local UI, including expected validation/security
  errors. Only trusted templates decode |00-|15 foreground, |16-|23 background
  and || escapes; caller values stay literal. Preserve StyledText provenance
  through nested renderer fields, clip by visible columns and reset colors.
  Never decode pipes on completed frames or caller content. Enforce 512 source /
  160 visible characters and the actual 32 KiB expanded ANSI output bound.
- S/T shows three numbered string blocks per page, distinct key/source/preview
  colors, blank separators, page/filter metadata and explicit list ellipses.
  F text filters keys/default text; F clears it. E/R accept a key or current-page
  number 1-3; resets still require YES. Keep paging and number resolution on the
  same page size. Editing wraps all 512 source characters and 160 visible preview
  characters into the 17-row body, separately labeled, with live counts and an
  overflow warning. Keep StyledText colors across wraps and preserve literal
  raw pipes, per-key placeholders and trailing spaces. Editable text never changes
  commands, validation rules, authentication results or permissions.
- Main artwork labels use explicit white-on-blue active/gray-on-black inactive
  colors, never reverse video on dark labels. Restore surrounding SGR state;
  reserve only row 24 for the prompt, not a generated status banner over the art.
  Bars use each column's longest visible label plus one blank on either side.
  Preserve artwork positions/glyphs across intervening SGR; use implicit trailing
  row blanks when needed, but clip for cramped layouts or the screen edge.
  The generated fallback uses the same width rule, with cell gaps outside blue.
- Message-header `~TL` is the public/private body cursor, not remaining minutes.
  Fit body pages above rows 23-24 (page/navigation), accounting for wrapped lines
  and full subject/base overflow fields. Only repeat fields that are missing or
  truncated. Keep rendering and N/P bounds in sync across public/private readers.
- When login input markers exist, emit only the field cursor, never a duplicate
  handle/password label after the editor's CRLF. Handle retries redraw the form.
  Missing individual markers retain text prompts outside the artwork.
- Legacy screens preserve CP437 bytes, normalize CRLF, strip SAUCE metadata and
  discard NUL padding. Only allowlisted CSI and per-screen percent/tilde tokens
  are accepted. Interactive footers must not scroll an 80x24 lightbar.
- Emit classic 16-color artwork with DOS-compatible intensity/base colors and
  full SGR resets, not bright foreground/selective-reset codes alone. Guard
  autowrap and re-anchor fixed-screen rows before CRLF; immediate column-80
  wrapping must not add blank rows. Preserve all 22 login artwork rows.
- Mail and private profile fields are caller-owned, never public list fields.
  Bind mail drafts to the recipient's immutable user ID at handle selection.
  Send by ID and revalidate approval/enabled status; never resolve the handle
  again at save time or redirect mail after deletion and handle reuse.
  Sysop notes/pages are private local-console requests, not remote privileges.
  File uploads require local approval before download. Never execute uploads.
- Community editors use `session.communityState`, not `session.community`
  (the shared service). Their cooldowns persist across sessions. A caller's
  `user_note`/USERNOTE is separate from local-only `sysop_note`.
- File payloads use generated UUID names under BBS_DATA_DIR/files, with lazy
  directory creation. Preserve approved catalogs, reserved IDs and durable
  completed transfer counts. Downloads open once, then compare descriptor and
  non-symlink pathname device/inode identities using bigint stats before reading;
  reject missing/zero identities. Retain O_NOFOLLOW where available and always
  close the descriptor on failure. Keep local ACLs private to prevent in-place
  tampering. Backup payloads with the stopped SQLite database.

## Change procedure

1. Locate the state transition, storage query and screen affected by a feature.
   Read their existing tests before editing.
2. Preserve authentication checks, plaintext loopback binding, TLS verification
   guidance, server-echo negotiation and hidden password entry.
3. Validate caller text at storage boundaries and sanitize again when rendering.
   Use parameters in SQL, never interpolate caller data. Keep lists paginated.
4. Bound new work, text, queues and storage growth. Do not move scrypt to the
   event loop or permit unbounded concurrent password derivations.
5. Use safe `InputError` messages for expected input failures. Unexpected errors
   must be reported without raw input and must end the affected session.
6. Add native `node:test` tests, including fragmented/malformed protocol inputs
   for parser changes and real socket tests for authentication/menu changes.
7. Run `npm test`, `npm run lint`, `npm run sast`, `npm run audit`.
   TLS integration is explicit: supply ephemeral `BBS_TEST_CERT` / `BBS_TEST_KEY`
   for DNS localhost; otherwise it is skipped. CI supplies these.
8. Review security-tool findings rather than globally disabling rules. ESLint
   security runs through the official compatibility adapter on ESLint 10.
   CodeQL is an additional GitHub CI analysis, not a local scan claim.
9. Update README.md and this skill when architecture, commands or limits change.

## Critical regression cases

- Registration/login with case-insensitive handles; wrong/unknown passwords
  return the same response and run the same password derivation.
- Pending applications/status checks, local approval/rejection confirmations,
  CP437/SAUCE loading, fragmented arrows, 24-row lightbar layout and welcome pause.
- Compare original artwork glyphs and palette cells against classic-SGR clients
  with both immediate/delayed wrap, including clients ignoring wrap-mode changes.
- Binary transfers preserve telnet-escaped IAC and binary CR/NUL, validate CRCs,
  bound work/storage/time, and clean up on disconnect. QWK replies enforce
  live account/role/per-base posting permission atomically.
- No password echo; disconnect if server echo is refused or unacknowledged.
- No unauthenticated posting; user projections never expose password hashes.
- ANSI/OSC, SQL-looking strings, oversized lines/subnegotiation, queue flooding,
  disconnect during password derivation and shutdown with live sockets.
- Message pagination, post/read/abort and persistence after database restart.
- Sysop menu navigation/confirm/cancel, raw-TTY lifecycle, old-schema upgrades,
  settings persistence, exact timeout limits, and live moderation/account changes.
- Pipe palette/escaping/no color bleed, literal untrusted values, saved/live
  previews, long colored substitutions and fixed-footer clipping; no-Enter actions
  with legacy CRLF, arrow+Enter, multi-digit IDs, slash commands, password privacy,
  confirmations and raw binary transfers.
- All main sections clear and have colored prompts, field edits retain context,
  completion notices survive redraws, and Messages starts selected. Main selection
  survives arrow/direct navigation, sections, door commands, help and artwork.
- Limits are process-local and shared-IP callers share admission quotas.
- Data and keys are sensitive; isolate temporary test data and never touch live
  databases. Only one process may own a database.

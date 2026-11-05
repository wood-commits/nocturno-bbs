# ANSI screens and display strings

Original sample `.ans` files live in [examples/ansi](examples/ansi) and load when
the local `ansi` directory is absent. They demonstrate login lightbar markers,
login input positions, literal main lightbar labels, message-header fields,
welcome fields and caller statistics without reusing operator artwork.

Copy `examples/ansi` to `ansi` beside this document to customize the screens.
The entire `ansi` directory is ignored by Git; publish examples only. An existing
local directory takes precedence as a whole: missing files use built-in screens,
not sample replacements. To use only built-in screens, create an empty `ansi`
directory. Explicitly selected missing template directories also use built-in
screens. No database changes are necessary. Restart the BBS after
editing files. Invalid files cause an explicit startup error, not a silent
fallback. Local sysop screens are intentionally not overridden.

Use ASCII or DOS CP437 text with real ESC-based ANSI/VT100 CSI sequences, not the literal
characters `\x1b`. All artwork templates accept DOS CP437
artwork; configure your client for **CP437**, not UTF-8. Output preserves the
original CP437 bytes. Save templates without a BOM. CRLF, LF and CR line endings
are accepted and sent as CRLF. Each file must be a regular file no larger than
16 KiB, with a conservative expanded-output limit of 32 KiB. Supported sequences are CSI color (`m`), cursor position/movement
(`H`, `f`, `A`, `B`, `C`, `D`), erase (`J`, `K`) and cursor save/restore (`s`, `u`).
Parameters may contain digits, semicolons and `?`, up to 24 characters.
Classic 16-color templates are emitted using DOS-compatible SGR: bright
foregrounds (`90`-`97`) become intensity plus base color, and attribute changes
reset/restate the active colors instead of relying on selective resets.
This preserves bright/dim transitions on clients that ignore modern SGR codes.
Templates using extended-color SGR are preserved and require a compatible client.
OSC, hyperlinks, terminal queries, bell, tabs, telnet IAC and other controls
are rejected. Templates are trusted local configuration, never uploads.
All stock shortcuts use normal cyan brackets (`|03`, RGB `#00AAAA`), bright
yellow keys (`|14`, `#FFFF55`) and gray labels (`|07`, `#AAAAAA`) on black.
Stock field/input prompts also use gray labels and input. This palette applies
to generated UI, string-editor defaults, and prompts in the bundled ANSI examples.
Selected lightbars retain white-on-blue selection; headings, live values,
success notices and errors retain their separate semantic colors.
Saved string overrides and private operator artwork remain authoritative;
reset a string in the editor to adopt its new stock colors.
Community input prompts do not
append CRLF after the prompt; completed content lines still use explicit CRLF.
Trailing SAUCE records and their bounded comment blocks are removed, together
with the DOS EOF marker immediately before them. Artwork's NUL padding
is discarded, never transmitted. Other embedded controls remain invalid.

Each custom region begins with reset/clear/home and ends with reset/CRLF,
except the interactive lightbars, which position their footer without a
trailing newline so the menu does not scroll off a 24-row terminal.
Automatic wrapping is disabled while drawing artwork and restored afterward.
Fixed-screen artwork also re-anchors each row before CRLF, so DOS-style clients
that wrap immediately at column 80 do not insert extra blank rows even if they
ignore the wrap-mode switch. These generated controls and color expansions
count toward the expanded-output budget.
The login matrix reserves rows 23-24 for its warnings, navigation and prompt;
password errors and application notices replace the row-23 warning rather than
adding lines or another selection prompt below the menu.
The matrix's original rows 1-22 are preserved. The main menu reserves only row 24 for
its prompt. Trailing blank export rows are removed from both interactive templates
so they cannot scroll the artwork before the fixed footer is drawn.
No generated status banner overwrites the main artwork. Use an 80-column,
at least 24-row terminal.
Design for 80 columns, accounting for the **maximum substituted field length**.
There is no automatic wrapping or alignment unless an explicit field width is used.
Values are sanitized printable text and inserted once; they cannot introduce
terminal controls or recursively expand another MCI code.

## MCI codes

ANSI screens and editable display strings use the same **MCI codes**. Common
codes follow [Mystic's display codes](https://wiki.mysticbbs.com/doku.php?id=displaycodes):
`|BN` (BBS name), `|UH` (user handle), `|ND` (node), `|DA` (date),
`|CS` (calls), `|MP` (posts), `|MU` (unread mail), `|FU` (uploads),
`|DL` (downloads), `|SD` (access description), `|UI` (user note), and
`|MB` (message base). Date fields use Nocturno's UTC formats.
This is a supported subset, not a Mystic compatibility interpreter: scripts,
file inclusion, execution codes and arbitrary terminal commands are not supported.

Context-specific fields use the Nocturno extension `|{NAME}`, for example
`|{MESSAGEID}`, `|{PAGE}` or `|{VALUE1}`. Names are uppercase and case-sensitive.
The short spelling is required for common fields, except when specifying width:
`|{BASENAME:32}` clips/pads a base name to exactly 32 visible columns.
Widths are decimal 1-160. Any data field supports this form; cursor/choice
markers do not. Width is explicit, never inferred from trailing spaces.

`|00`-`|23` colors and `||` (a literal pipe) work in both artwork and strings.
Use `||UH` to display the literal text `|UH`. Values expand once, after trusted
template parsing, and never interpret colors or MCI codes in caller text.
Unsupported, malformed, or out-of-context codes fail ANSI startup validation or
string-editor save validation. Old `%NAME%` and `~XX` tokens are rejected.

### Upgrading

Keep only `main.ans` and `message-header.ans`, using the former `main-new.ans`
and `new-message-header.ans` artwork respectively. Old filenames are no longer
loaded. Convert private artwork to the codes below before restarting; the bundled
examples and this checkout's private artwork have already been converted.
For old padded header fields, use an explicit width equal to three plus the
old trailing-space count. `~TL` becomes `|{BODY}`, **not** time remaining.
Login `~LN`/`~LP`/`~LI`/`~LH` become `|{LOGINHANDLE}`/`|{LOGINPASSWORD}`/
`|{LOGINSTATUS}`/`|{LOGINHELP}`; `~01`-`~05` become `|{CHOICE1}`-`|{CHOICE5}`.
Statistics labels must contain explicit MCI codes; blank labels are not auto-filled.

Saved SQLite display-string overrides are converted transactionally once on
upgrade. Named percent fields become MCI codes, existing colors/escaped pipes
remain intact, and literal pipes are escaped. No user/content IDs change.
If conversion would exceed the 512-character source limit, startup fails
explicitly and rolls back the migration; shorten that override before upgrading.
Back up the stopped database and private artwork before upgrading.

## Filename-to-screen mapping

All filenames are lowercase and fixed.

Login-matrix choice markers use explicit white-on-blue active and gray-on-black
inactive colors, not reverse video. Leave blank space after each marker for its
label. Padding may cross SGR changes; labels clip at nearby artwork or the screen
edge instead of shifting glyphs. Surrounding artwork colors are restored afterward.

Every screen supports these common MCI codes:

| MCI code | Meaning |
|---|---|
| `\|BN` | Current BBS name (up to 40 characters) |
| `\|UH` | Current caller's handle (up to 24), or `Guest` before login |
| `\|ND` | Connection/node number |
| `\|DA` | Current UTC date and time (`YYYY-MM-DD HH:MM UTC`) |

| Filename | Replaces | Additional supported MCI codes |
|---|---|---|
| `loginmatrix.ans` | Pre-login lightbar menu | `\|{CHOICE1}` login, `\|{CHOICE2}` apply, `\|{CHOICE3}` check application, `\|{CHOICE4}` message sysop, `\|{CHOICE5}` hangup |
| `login.ans` | Handle/password artwork | `\|{LOGINHANDLE}` handle input position, `\|{LOGINPASSWORD}` hidden password input position, `\|{LOGINSTATUS}` login status, `\|{LOGINHELP}` login help |
| `welcome.ans` | Post-login artwork with an application-generated any-key pause; also A (art) | `\|{TRANSPORT}`, `\|{TAGLINE}` |
| `main.ans` | Lightbar main-menu artwork | None; literal menu labels use white-on-blue selection and gray-on-black inactive colors |
| `stats.ans` | Current caller's statistics | `\|CS`, `\|MP`, `\|MU`, `\|FU`, `\|DL`, `\|SD`, `\|UI` |
| `users.ans` | User-list heading only | `\|{PAGE}` |
| `callers.ans` | Last-callers heading only | `\|{PAGE}` |
| `messages.ans` | Selected message-base list heading only | `\|{PAGE}`, `\|{BASEID}`, `\|MB` |
| `message-header.ans` | Public-message/private-mail header | `\|{PAGE}`, `\|{BASEID}`, `\|MB`, `\|{MESSAGEID}`, `\|{MESSAGEAUTHOR}`, `\|{RECIPIENT}` (`All` for public posts), `\|{MESSAGESUBJECT}`, `\|{MESSAGEDATE}` (UTC timestamp), `\|{MESSAGEDAY}` (UTC date), `\|{MESSAGETIME}` (UTC time), `\|{BODY}` (body cursor) |
| `message-bases.ans` | Message-base selection heading only | `\|{PAGE}` |
| `compose.ans` | Optional artwork before the new-message subject prompt | `\|{BASEID}`, `\|MB` |
| `doors.ans` | Door lounge heading and game menu | None |
| `realm.ans` | Optional artwork when entering Frontier Realms | `\|{PAGE}` |

Every template listed above accepts CP437 characters and the same allowlisted
ANSI escape sequences. Caller text and MCI values remain sanitized.
Only the documented per-screen MCI codes are accepted. Explicit-width header fields
clip and pad to fit the artwork. Subjects and base
names appear in full below the header only when missing or too long for its fields.
`|{BODY}` positions public-message/private-mail body text, not a time-left number.
Leave the area from that marker through row 22 clear; rows 23-24 hold the page
indicator and navigation prompt. The marker must be on rows 1-20, columns 1-77,
leaving room for overflow fields, text and navigation. If absent, text starts on
the first free line after the header instead. Bodies wrap to the available
width (at most 76 characters) and page to fit without scrolling the header.
The sample header starts text on row 14, column 1: nine body lines per page, reduced when
full overflow fields need space. Without header artwork, the usual 14-line
message pages remain available.

For login artwork, `|{LOGINHANDLE}` and `|{LOGINPASSWORD}` position the input cursor only; include your
own handle/password labels before those markers. No generated label is printed
over the artwork. `|{LOGINHELP}` supplies input requirements and the hidden-password
notice. Invalid handles redraw the form with validation feedback at `|{LOGINSTATUS}`.
New-account password confirmation reuses `|{LOGINPASSWORD}`, with instructions at `|{LOGINSTATUS}`
(or row 22 if that status marker is absent). Both password entries remain hidden.
If an input marker is missing, its generated text prompt uses row 23; if `|{LOGINSTATUS}`
is missing, validation feedback uses row 22. Leave those rows free when relying
on these fallbacks. Without login artwork, ordinary text prompts remain available.

`|{PAGE}` is one-based. Base names are at most 40 characters, message subjects
60, authors 24, and `|{MESSAGEDATE}` is UTC `YYYY-MM-DD HH:MM` (without a suffix).
`|{TRANSPORT}` describes TLS or the local-only plaintext warning; `|{TAGLINE}`
is the editable `welcome_tagline` string.

Input handling, list rows, message bodies, paging controls and the live game
status remain application-generated; templates cannot hide or replace those
regions. Login field markers replace generated labels, not input validation
or hidden-password handling.
The server appends actual command choices and transport/password warnings to
the login matrix, even if they are absent from the artwork. Both lightbars
accept arrows and Enter, or the documented letter without Enter.
At the main menu, `?` displays all shortcuts; any key returns.
The initial selection is **Messages (M)**, the first option in the left column.
Each caller's main-menu selection survives returning from sections, help and
artwork; letter shortcuts update the remembered item too. Login selection is
independent. Generated menus share the artwork's navigation grid and colors.
The main lightbar matches the bundled label words case-insensitively; uppercase,
lowercase, title case and mixed case are accepted in `main.ans`. The artwork's
original lettering is preserved. Generated menus and help use capitalized names,
including QWK and BBS. Every label receives explicit active/inactive colors, avoiding
black-on-black reverse video and clearing any baked-in example highlight.
Each column's highlight is its longest label plus one blank on each side.
Labels stay at their artwork positions; padding uses adjacent whitespace.
Custom layouts should leave enough blank space around each column; highlights
clip rather than overwrite nearby glyphs or wrap past the screen edge.
Surrounding artwork colors are restored after each label. Missing artwork uses
generated menus with the same actions.
Community and file/QWK sections use the shared colored heading and clear before
menu/page redraws; field entry and validation retries stay inline. Existing
screen artwork still supplies its own visual design. Save and transfer notices
are rendered after the new frame so clearing does not erase them.

For example, the following is a valid plain-text `message-header.ans`:

```text
|BN // |MB // Message #|{MESSAGEID} // Page |{PAGE}
From: |{MESSAGEAUTHOR} at |{MESSAGEDATE} UTC
Subject: |{MESSAGESUBJECT}
```

## Local string editor

At WFC, choose **S**, then **T**. The editor lists three numbered entries per
page, separated by blank rows, with highlighted keys and distinct literal-source
and color-preview labels. Clipped list text ends with `...`; the header area
shows the entry range, page count and active filter. `F text` searches
keys/default text; `F` alone clears the filter. `N`/`P` page immediately;
`Q` returns.
Use `E key` or `E 1`/`E 2`/`E 3` for an entry on the current page, Enter, then
type the replacement text and Enter. The editing screen wraps the complete
512-character source separately from the live 160-character color preview,
updating as you type or backspace. Character counts flag a preview beyond the
visible limit; invalid replacements are still rejected on save.
`/abort` cancels. `R key` or `R number` restores the built-in default after
**YES** confirmation.
Changes persist in SQLite and apply on the next display, without restarting.
Strings accept up to **512 source characters / 160 visible characters**, including
trailing spaces (useful for prompts), and must contain visible non-space text.
Screen fields and fixed-screen footers clip to their available columns without
cutting color sequences. Strings do not support raw ANSI or line breaks.

### Renegade pipe colors

`|00`-`|15` set the foreground; `|16`-`|23` set the background.
`||` prints a literal pipe. Codes above `|23` are rejected.

| Code | Foreground | Code | Foreground |
|---|---|---|---|
| `00` | Black | `08` | Dark gray |
| `01` | Blue | `09` | Light blue |
| `02` | Green | `10` | Light green |
| `03` | Cyan | `11` | Light cyan |
| `04` | Red | `12` | Light red |
| `05` | Magenta | `13` | Light magenta |
| `06` | Brown | `14` | Yellow |
| `07` | Light gray | `15` | White |

Background codes `16`-`23` use the colors from foreground codes `00`-`07`,
respectively. Renderers emit DOS-compatible intensity/base colors and reset at
the end, preventing color bleed. Prompts default to light cyan with gray input,
errors to light red, and transfer-success notices to light green.
Community and transfer action menus use light cyan; editor instructions use
yellow and save notices use light green. Stored overrides are not overwritten
by new defaults; use `R key` to restore one explicitly.

Example: `|03S|10e|15lection|07: ` renders cyan `S`, light-green `e`, white
`lection`, then gray `: `. Login lightbar labels retain renderer-controlled
selection colors even when their text is customized.

Only sysop-authored string templates interpret pipe codes. Substituted handles,
subjects, messages, profiles, filenames and other caller data remain literal;
they cannot inject ANSI or recursively expand MCI codes.

### Catalog and MCI codes

The complete catalog, including each default and its supported MCI codes,
is [src/string-catalog.js](src/string-catalog.js). The editor exposes all entries.
The original keys remain supported:

| Key | Displayed at | Supported MCI codes |
|---|---|---|
| `selection` | Welcome prompt | None |
| `main_prompt` | Main menu prompt | None |
| `subject_prompt` | New-message subject input and retries | None |
| `body_prompt` | Each message-body line and retries | None |
| `editor_help` | Start of message-body editor | None |
| `goodbye` | Authenticated logout | None |
| `login_goodbye` | Disconnect from welcome menu | None |
| `posted` | Successful message save | `\|{MESSAGEID}` |
| `removed` | Cached message removed by sysop | None |
| `permission_denied` | Account denied posting/door access | None |
| `welcome_tagline` | Built-in welcome / `\|{TAGLINE}` in custom welcome | None |

Example: set `posted` to `Saved message #|{MESSAGEID}.` MCI codes are
validated when saving; a string accepts only the fields present in its own
default, including names such as `|{VALUE1}`, `|{KEY}` or `|{LIMIT}`.

Additional groups include `handle_prompt`, `password_prompt`, `continue_prompt`,
`command_prompt`, `retry_prompt`, `login_*`, `label_*`, `stats_*`, `screens_*`,
`community_*`, `transfer_*`, `transfers_*`, `doors_*`, `sysop_*`, `wfc_*`, `disconnect_*` and
`error_*`. These cover caller/local menus, status text, confirmations, field
prompts, and expected validation/authentication/security errors.

Customizing text does not change validation, authentication results, permissions,
limits, command keys, `YES` confirmations or binary transfer protocols. Runtime
diagnostic tags, stored/historical caller content, protocol metadata and literal
text in ANSI artwork are not translated. Use `|{TAGLINE}` to expose the welcome
tagline in custom art; login MCI labels are editable.

Standalone letter/digit actions run without Enter; arrow-key selections still
use Enter. Numeric IDs, passwords, text fields, slash commands, argument-bearing
commands and confirmations remain Enter-terminated. In the local user editor,
`P` also begins permission commands, so previous-page `P` requires Enter there.

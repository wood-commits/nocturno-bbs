# Nocturno BBS

An original, small Node.js BBS server. Inspired by Renegade,
Telegard, and TAG and others from the 90s.

## License

Licensed under the [MIT License](LICENSE).

## Requirements and quick start

- Node.js **24.13+** (includes `node:sqlite`); no runtime packages.
- A telnet client with ANSI/VT100 and server-echo negotiation, using an
  **80-column or wider, 24-row or taller** terminal. Text input is printable ASCII.

Some supported Node releases may emit a built-in SQLite experimental warning.

```powershell
npm ci --ignore-scripts
npm start
```

`npm start` also works without installing packages: the server uses only Node's
built-in APIs. On a fresh clone it creates `data/bbs.sqlite` automatically with
empty user/message tables, default settings and the Member role. There is no
seeded account or password. Apply using `N`, then approve the application from
the local sysop console before logging in.
The default board name is **Nocturno BBS**. Existing databases retain their saved
name; change it through **S, A** in the local sysop configuration if desired.

Original teaching screens in [examples/ansi](examples/ansi) load by default
when there is no local `ansi` directory. To customize them, copy that directory
to `ansi`, edit the copies and restart. The entire local `ansi` directory,
`data` (including file payloads and SQLite sidecars), local VS Code configuration,
environment files and certificate/key files are ignored by Git. The examples
contain no operator artwork or live data.

Connect using your telnet client to **127.0.0.1, port 2323**. For example, configure
PuTTY's Telnet mode, automatic local echo and automatic local line editing.
The server echoes normal input; passwords are not echoed. Clients that refuse
server echo are disconnected. Login and main menus use **arrow keys and ENTER**;
single-letter shortcuts act immediately without Enter. Standalone menu actions
and paging keys work the same way throughout the BBS. Text fields, numeric IDs,
commands with arguments, and `/G` still use Enter; an optional Enter after an
immediate shortcut is ignored.
Configure the terminal's character set as **CP437** for the supplied DOS artwork.
For encrypted remote access, see
[Connecting through a TLS tunnel with stunnel](#connecting-through-a-tls-tunnel-with-stunnel)
or [Connecting through an SSH tunnel](#connecting-through-an-ssh-tunnel).
The renderer translates bright foreground colors to classic ANSI intensity
codes and protects full-width artwork from column-80 wrapping. The login
matrix retains its banner and all 22 artwork rows above the two-line footer.
The main lightbar uses white-on-blue selection and clears the artwork's sample
highlight on inactive items. Each column's bar matches its longest label plus
one blank on either side, without moving the artwork's labels. Its prompt stays
on row 24; no generated status
banner is drawn over the template. Use `%BBSNAME%`/`%USERNAME%` in the artwork
if you want those fields displayed.
It initially selects **Messages (M)**, the first option in the left column.
Returning from a section, help or artwork restores that caller's last selected
main-menu item, including actions opened with letter shortcuts. The generated
fallback uses the same grid and selection colors as the artwork.
Section menus and page redraws clear the previous screen and use colored
headers/prompts; community and file/QWK menus use the same frame as the classic
lists. Text-entry steps and validation retries remain inline so they retain
their context. Door-game redraws also clear before displaying their content.
Choose `N` to apply, `C` to check an application, or `L` to log on.
New applications require local sysop approval; existing accounts stay approved.
Application checks require the handle and password and do not log the applicant in.
Password errors and application notices redraw the login menu with one selection
prompt. With artwork, notices temporarily replace the warning on row 23, keeping
the artwork and row-24 prompt in place without scrolling.
After a successful login, welcome artwork streams at a simulated 28.8k modem
speed (2,880 bytes/second, 8N1), then pauses until any key is pressed.
The main menu's `A` artwork replay uses the same speed. Keys pressed during
playback are ignored; other screens and file transfers remain at normal speed.
Handles are case-insensitive,
3-24 letters/numbers/underscore/hyphen, starting with a letter or number.
Use a unique password of 12-128 printable ASCII characters.
New applications require entering the password twice. Both entries stay hidden;
a mismatch clears the temporary password and asks for a new password pair before
creating an application. `/abort` cancels either password step.
With login artwork, handle/password entry uses the `~LN`/`~LP` field positions
without printing duplicate labels. Missing fields use ordinary text prompts;
password entry remains hidden in either mode.

If you only need to run an already-installed copy, `node src/index.js` needs
no installed packages. Development dependencies are just lint/SAST tooling.

## Included

- Stateful telnet negotiation, fragmented input, CRLF/CR-NUL, backspace,
  bounded subnegotiation, hidden password entry, and ANSI/VT100 output.
- Persistent registration/login, user listing, last callers with duration,
  and role-controlled message and file bases (General is the default).
- Optional private ANSI screen templates in `ansi`, original bundled examples,
  sanitized per-screen placeholders,
  and a persistent local display-string editor. See [ANSI.md](ANSI.md) for
  filenames, supported placeholders, formats and examples.
- CP437/SAUCE legacy artwork, per-screen tilde placeholders,
  lightbar login/main menus, and authenticated application status checks.
- Original multiplayer **Frontier Realms** door: colorful command center,
  persistent land, gold, armies, realm development, daily turns and PvP attacks.
- Ten-row paginated lists. Read messages by ID; write with `W`, end with `.`,
  or cancel with `/abort`. Message reading also paginates.
  While reading a public message, `R` replies in the same base. Enter keeps the
  displayed `Re:` subject (limited to 60 characters); typing replaces it.
  Replies keep a durable parent message ID, shown when reading, without copying
  the original body. The normal posting permissions, cooldown, signature and
  editor limits apply. A removed parent cannot receive new replies, including
  replies already being composed; existing replies remain readable.
  Public messages and private mail start at the header's `~TL` text position,
  with page sizes fitted above the page indicator and prompt on rows 23-24.
  Full subjects/base names appear below the header only if they do not fit its fields.
- Local blue sysop **waiting-for-callers** dashboard with UTC statistics and
  live node status, keyboard menus, persistent settings, user management,
  message moderation, caller history, node watching/hangup, live sysop chat,
  and a normal local BBS login.
  Non-TTY output uses plain startup logs. Ctrl+C shuts down.
- SQLite persistence in `data/bbs.sqlite` with WAL and foreign keys.
- Optional separate TLS listener. No public plaintext listener.

There are no default users, administrator passwords, shell doors, or telnet sysop
commands. An optional authenticated local MCP bridge can delegate console authority
to agents (see below). Authenticated users may read other users' handles, but message/file
access depends on their assigned role. Public lists never contain password hashes,
private profiles or IP addresses. The dashboard is local to the server terminal
or an explicitly enabled local MCP sysop session.
Existing and new users receive the **Member** role, preserving existing access,
including posting and doors. Per-user posting/door restrictions remain additional
restrictions; a role never overrides them or grants remote sysop privileges.

## Local sysop menus

Run `npm start` in an interactive terminal with both input and output attached.
The WFC screen and standalone submenu actions accept immediate single-key
shortcuts. Commands with arguments, text fields and confirmations still require
**Enter**. In VS Code use the integrated **Terminal**, not the Output or
Debug Console panels. `BBS_DASHBOARD=0` or redirected stdin/stdout disables the
interactive console but does not stop callers connecting.

The local console supports **80-column by 24-row or 25-row** terminals, including
the VS Code integrated terminal. Use a truecolor-capable terminal; larger
terminals keep the BBS in the upper-left 80x25 area, with the surrounding area
cleared to black. Resizing between 24 and 25 rows repositions menus and preserves
partially typed input.
The application does not resize your terminal window or change its theme.
WFC and all sysop tools reserve the bottom five rows for notices and prompts/input:
rows 21-25 on a 25-row terminal, or rows 20-24 on a 24-row terminal.
The cursor follows the prompt on the same line, moving to the next row when
the prompt leaves no room for typing. Long commands/fields scroll horizontally
within the remaining line without moving the menu; the complete bounded input
is retained. WFC shows up to six nodes (five on a 24-row terminal with two listeners)
(**N** lists all nodes); the base manager shows five bases with descriptions
per page. User, node and message lists retain their existing page sizes.
WFC uses full-width 80-column title bars/dividers and places its menu directly
below the current node list rather than leaving empty node slots. Its three
menu columns (also used for configuration shortcuts) start at columns **3, 29
and 55**, with 24 visible characters per cell and two-column gaps. Default keys
are yellow, brackets/section headings cyan, labels gray and live values
white/green. Colored string overrides retain their colors; long labels clip
within their own cell without moving the next column. Existing saved string
overrides remain in effect; reset an overridden string in **S, T** to adopt
its updated default colors.

Configuration shortcuts use the same column alignment as WFC, including roles
and file bases, with an explicit return option. Sysop tables color their IDs,
headings and values; long message subjects/file names show an ellipsis rather
than silently cutting off. Empty list pages say so. Local message readers keep
only the fixed footer prompt and fit reply context above the reserved notice rows.

| WFC key | Working controls |
|---|---|
| `S` | System configuration: `A` BBS name, `E` registration toggle, `1` session minutes, `2` idle minutes; `B` message bases, `F` file bases, `R` roles, `U` user editor, `T` string editor |
| `U` | User editor: enter a user ID to open its numbered form, then select a field with `1`-`8` |
| `B` | Message base: numeric ID to read, `D ID` to remove a message |
| `C` | Caller history with UTC login time, duration and node |
| `N` | Node listing: `W ID` watches a logged-in caller, `H ID` hangs up that node |
| `L` | Local BBS login using an ordinary account's handle/password |
| `A` | Account applications: `A ID` approve or `R ID` reject, then `YES` |
| `F` | File catalog: `A ID` approve, `U ID` unapprove, `D ID` remove, `M ID base` move; confirm with `YES` |
| `R` | Private notes/page requests: `V ID` read, `D ID` acknowledge with `YES` |
| `Q` | Confirm graceful shutdown and disconnect all callers |

Lists use `N`/`P` for next/previous pages and `Q` to return to WFC.
In the user editor, `P` still requires Enter because it also starts `P ID`
permission commands.
Message reading uses `N`/`P` and `Q` returns to the message base.
In the user editor, enter a user ID and **Enter** (or `V ID`) to open a form
showing the current values, application status and timestamps, never password
hashes. Select **1** handle, **2** real name, **3** location, **4** sysop note,
**5** posting permission, **6** door permission, **7** disabled status or **8** role ID.
Field numbers work immediately; text values require Enter. Permissions and
disabled status toggle after confirmation; disabling also disconnects active
callers. Every change requires **YES** and Enter. Use `/abort` to cancel text
entry, `-` to clear private info, and **Q** to return to the same user-list page.
Application approval remains in the separate **A** menu.

Press **X** in a user form, or enter **X ID** in the user list, to delete an
account. Deletion requires **YES** and Enter; anything else cancels. It disconnects
active callers, removes the password hash, private profile/signature, real name,
location and sysop note, and removes the account from user/application lists.
This cannot be undone by enabling the account. The old ID stays reserved, with
posts, mail, files and caller history attributed to `Deleted user #ID`.
Historical content is retained, not purged or securely erased from backups.
The old handle becomes available for a new account with a different ID; the new
account never inherits the old mailbox, file ownership, statistics or realm. Reserved rows
still count toward the bounded 10,000-account storage limit.

Existing command shortcuts remain available in the user list:
`F ID field text`, `P ID post|doors 0|1`, `R ID new_handle`, `D ID` to disable,
`E ID` to enable, and `A ID role` to assign a role. Editable fields
for `F` are `real_name`, `location` (60 characters each), and `sysop_note`
(100 characters); use `-` as the value to clear a field. These details are
**private**, not part of public user lists. Callers may edit their own name and
location; sysop notes remain local-only. `P ID post 0` prevents posting;
`P ID doors 0` prevents door play, including commands in an already-open game.
Permission changes are checked on each command and again when saving a post.
None of these flags grants remote administration rights.

### Local MCP agent access

The optional MCP server connects agents to the **running** BBS, never a second
SQLite owner. It uses authenticated local IPC (a Windows named pipe or a POSIX
Unix socket), with a stdio bridge for MCP clients. There is no HTTP/TCP MCP
listener. It has no runtime dependencies. MCP is disabled unless configured;
ordinary caller roles never grant sysop authority.

Generate a fresh 32-byte token, choose a local endpoint, and start the BBS:

```powershell
$env:BBS_MCP_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:BBS_MCP_ENDPOINT = '\\.\pipe\nocturno-bbs'
$env:BBS_MCP_SYSOP = '1' # Omit for user-only MCP access.
npm start
```

Keep the token secret; supply the **same** token and endpoint to your MCP client's
environment. This token is not a BBS account password. Do not commit it, put it
in tool arguments, or publish/share the pipe or socket. On Windows protect
the host/service account with appropriate ACLs; on POSIX choose a private
directory for the socket (its mode is set to `0600`). Existing endpoints are
never unlinked automatically: use unique endpoints or investigate stale sockets.
Anyone holding the token can operate user terminals and, with
`BBS_MCP_SYSOP=1`, has the full authority of the local console, including private
data, account approval, permissions, moderation, watching/chat and shutdown.
This explicitly extends local-TTY trust to authenticated local automation.
Treat the agent and its MCP client as trusted operators, not untrusted callers.

VS Code workspace configuration is included in [`.vscode/mcp.json`](.vscode/mcp.json).
After starting the BBS with the environment above, run **MCP: List Servers**,
select **nocturno**, and choose **Start**. Enter the running BBS's token in the
password prompt and approve the server trust prompt if shown. Enable its tools
in the chat tool picker. No token is stored in the workspace configuration.
The default endpoint is the Windows pipe above; adjust it if using another
endpoint or a POSIX host.

The equivalent configuration for another VS Code installation is:

```json
{
  "servers": {
    "nocturno": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\bigwo\\bbs\\src\\mcp.js"],
      "env": {
        "BBS_MCP_ENDPOINT": "\\\\.\\pipe\\nocturno-bbs",
        "BBS_MCP_TOKEN": "${input:nocturno-token}"
      }
    }
  },
  "inputs": [
    { "id": "nocturno-token", "type": "promptString",
      "description": "Running BBS MCP token", "password": true }
  ]
}
```

Adjust the absolute script path for your installation. On POSIX use the same
absolute Unix socket path in both environments. Launch `node src/mcp.js`
directly for stdio clients; `npm run mcp` is a convenience for manual launches,
but npm's startup banner is not MCP JSON. Bridge diagnostics go only to stderr.

| Tool | Purpose |
|---|---|
| `bbs_open` | `{ "role": "user" }` opens a normal login; `"sysop"` opens WFC only when explicitly enabled |
| `bbs_read` | Drain output using `sessionId` and optional `waitMs` (0-1000, default 100) |
| `bbs_send` | Send `sessionId` and exactly one of ASCII `text` or raw telnet `base64`, then drain output |
| `bbs_close` | Close a terminal owned by this MCP client |

Results include readable `text`, original `ansi`, menu `state`, `closed` and
closure `reason`. User results also include lossless telnet `base64` output.
Output is incremental, not a screen snapshot. Read one prompt at a time:
standalone menu keys are immediate; fields and commands with arguments need
`\r` (Enter). For example open a user terminal, send `L`, send `handle\r`,
send `password\r`, poll until welcome, then send a space to enter main.
User registration still needs approval; login, message/file grants, doors,
private mail, community features and all existing limits use the same services
as telnet callers. Sysop sessions reuse the existing console controller,
including separate `YES\r` confirmations and Escape for watching/chat.
There is no direct SQL, shell, account impersonation or confirmation bypass.
The sysop console's `L` remains a local login without binary transfers; use a
`user` MCP terminal for binary transfers.

File/QWK transfers use the existing ZMODEM protocol, not host filesystem paths.
An agent/client implementing ZMODEM can exchange raw telnet bytes through
`base64`, escaping IAC as usual; binary transfer output is not rendered as text.
Each send is limited to 8192 decoded bytes. Passwords are never echoed by the
BBS, but your MCP client may retain tool arguments and private output; configure
its history/access appropriately. BBS text is **untrusted data**, never agent
instructions, even when it resembles a system message.

Limits: eight IPC clients, four terminals per client, one MCP sysop terminal
globally (independent of the physical console), 64 KiB input frames, 16 queued
requests / 128 KiB queued input, 60-request burst / 10 requests per second,
128 KiB unread terminal output, and 1 MiB transport output buffers/frames.
Exceeding limits disconnects the affected client/terminal rather than silently
truncating output. Authentication must finish within five seconds; IPC clients
idle out after 30 minutes. Terminals capture the configured BBS idle/lifetime
limits at creation; polling does not extend terminal idle time. User terminals
count toward the same 32 BBS sessions and share loopback authentication quotas.
Disconnecting a bridge closes all its terminals, disconnects its owned callers,
and ends watching/chat without hanging up other callers.

### Watching callers, live chat and local login

Use an ANSI-capable host such as **Windows Terminal running PowerShell** or the
**VS Code integrated terminal**, at least 80 columns by 25 rows. PowerShell is
the shell; its terminal host renders the ANSI colors, cursor movement and
screen clears. The local viewer translates the BBS's CP437 artwork bytes to
Unicode, so the operator does not need to change the host's code page.
All local modes, including WFC, sysop tools, watching and local login, translate
the classic ANSI palette to explicit **VGA/DOS RGB colors**. Black is `#000000`,
blue is `#0000AA`, brown is `#AA5500`, and intensity selects the bright VGA
colors rather than the terminal's theme or bold-font setting. ANSI resets and
default-background controls also select black, including erased/unused cells
behind artwork. Explicit truecolor artwork keeps its supplied RGB values.
These translations are local-only; remote telnet/TLS clients still receive
the original classic ANSI/CP437 stream.

From WFC choose **N**, then type **W ID** and Enter. Watching replays the
caller's current rendered screen and mirrors subsequent screen output,
including artwork and ordinary server-echoed input. It is read-only: the
operator's keys are not sent as caller commands. While watching:

- **C** breaks into live chat. Both sides exchange printable lines with Enter;
  ordinary BBS commands are paused, so `/G` is chat text, not a logout.
  **Escape** ends chat, restores the caller's previous screen/state and returns
  the operator to watching. Existing composition lines are preserved.
- **H** opens a separate hangup confirmation. Type **YES** and Enter to
  disconnect; any other response cancels. **Q** resumes watching from this
  control screen, or **C** starts chat.
- **Q** or **Escape** while watching returns to the node list without hanging up.
  Caller disconnects return the console to WFC.

Chat cannot interrupt password work, queued commands, partial input or a binary
transfer; retry after the caller finishes that work. Only authenticated callers
can be watched. Passwords, telnet negotiations and binary payloads are never
mirrored. Watching can expose the caller's private mail and profile to the
trusted local operator; secure the host terminal accordingly.

Screen replay is memory-only, limited to **128 KiB per session**, and resets at
each full-screen clear. If this fills during an unusually long inline editor,
new watching/chat must wait for the caller's next clearing screen redraw;
existing live watching continues. Slow local output stops viewing rather than
buffering indefinitely. Neither screen replay nor chat is saved as a log.

From WFC choose **L** to use the BBS locally. This uses the same session state
machine, authentication, account approval, permissions, idle/lifetime limits
and caller history as an ordinary caller. It does **not** automatically log in
or grant remote sysop rights. Password entry is hidden. Arrow keys, artwork,
messages and doors work normally; binary ZMODEM/QWK transfers require a separate
capable telnet client. Logoff, disconnect or **Escape** returns to WFC.
Local login occupies one of the 32 session slots and shares loopback
authentication quotas. Closing the console disconnects its local login, but
only stops watching/ends chat for a remote caller. **Ctrl+C** still shuts down
the entire BBS in every console mode.

Under **S, B**, create a base with `C name | description` (description optional),
then **YES**. Names must be unique ignoring case, 1-40 printable ASCII
characters; descriptions are up to 80. There are at most 100 bases.
`O ID` opens that base's moderation list; WFC **B** still opens General.
Callers enter **M**, then **B** to choose a base by ID. Writing and reading
use the selected base; message IDs remain globally unique. Caller base lists
include only readable bases. Base deletion is not implemented.

### Roles and base access

Under **S, R**, use `C name` and **YES** to create a role (1-24 printable ASCII
characters, unique ignoring case; at most 100 roles). Custom roles start with
**no permissions**. Enter a role ID (or `V ID`) to view/edit its grants:

| Command | Permissions (each flag is `0` or `1`) |
|---|---|
| `G post doors` | Global posting and door-play permissions |
| `M base read post` | Read/post permissions for one message base |
| `F base list download upload` | List/download/upload permissions for one file base |

Every change requires **YES**. `N/P` pages through message/file bases and `Q`
returns to the role list. Assign exactly one role per user with **U, ID, 8**,
then enter the role ID and confirm **YES**, or use `A user_id role_id` in the
user list. Roles and grants persist in SQLite.

Missing grants deny access. Message posting also requires read access, global
role posting permission and the user's existing posting permission. File download
and upload also require list access; uploads additionally require global role
and per-user posting permission. Global posting restrictions also apply to
private mail/community writes. Doors require both role and per-user permission.
Disabled or unapproved accounts cannot use these grants.

Member (role **1**) receives read/post and list/download/upload access to existing
bases during migration. Newly created bases also grant Member full access;
other roles need explicit grants for each new base. To restrict a base, revoke
Member's grants and grant the chosen roles access. Revocations are never reset
on restart. These are independent grants, not an ordered role hierarchy.

Under **S, F**, use `C name | description` and **YES** to create a file base,
or `O ID` to open its local catalog. File bases have the same name/description
limits as message bases and a separate 100-base limit. WFC **F** lists all bases'
files and shows their base IDs. `M file_id base_id` and **YES** moves a file;
it retains its ID, payload and approval status.

Permissions are rechecked live at storage/service boundaries, during composition,
on message reads and when restoring screens after sysop chat. Transfer checks
stop further output or persistence after revocation, including cached QWK exports.
Previously displayed or downloaded content cannot be recalled.

Under **S, T**, three numbered entries per page show highlighted keys, labeled
source/preview rows and blank separators. Page totals and the current search
filter appear above the entries; clipped list text ends with `...`.
`E key` (or **E 1**, **E 2**, **E 3** for a visible entry) opens editing.
`R key` or `R number` and **YES** restores its default. `F text` searches
keys/default text and `F` clears the filter; `N/P` changes pages.
The edit view wraps the complete raw source separately from the live color
preview, shows source/visible character counts and flags an oversized preview.
Trailing spaces are preserved, and all editing stays inside the local 80x24/25 layout.
Caller prompts, validation/security errors, community/transfer/door text and
local sysop interface text are editable. Renegade pipe codes `|00`-`|15` set
foreground colors, `|16`-`|23` set backgrounds, and `||` prints a literal pipe.
Prompts default to bright cyan with gray input; errors use light red.
Menu actions also default to bright cyan, editor instructions to yellow and
save/transfer notices to light green. Saved string overrides retain their colors;
reset an individual string with `R key` if you want its updated built-in default.
For example, `|03S|10e|15lection|07: ` colors each part of the selection prompt.
See [ANSI.md](ANSI.md) for limits, the full editable catalog and placeholders.
String changes apply on the next display; ANSI files load on startup.
Changes to users, application decisions, registration, message removal, node hangup, and menu-driven
shutdown require typing **YES** and Enter; any other response cancels.
Name/time input can be cancelled with `/abort`. Ctrl+C shuts down immediately
without an extra confirmation. The dashboard uses the terminal's alternate
screen. Closing it restores the shell screen, colors, cursor and wrapping,
restores the previous raw mode, and stops reading/releases initially inactive stdin
before waiting for callers to disconnect. Cleanup also runs on process exit.
If a terminal was left broken by an older version or a forced process kill,
close that terminal and open a fresh one.

BBS name and registration changes apply live. Configured session lifetime
(1-1440 minutes) and idle timeout (1-60 minutes) apply to **new connections**;
existing connections retain the limits with which they started. Renames retain
user IDs, message authorship and caller history. Disabling an account immediately
disconnects its sessions and blocks login, including in-progress authentication.
Enable it to allow login again. Rejected applications retain their IDs and credential verifiers; they cannot log
in. Approval never grants remote sysop rights. There is deliberately no account deletion or
plaintext-password viewer.

Settings persist in SQLite. `BBS_NAME` seeds the name only when no settings have
been saved; thereafter the sysop configuration takes precedence. Ports, TLS
certificates, and bind addresses stay environment-only and require restart.
Existing databases receive additive schema upgrades for settings, disabled
accounts, removed messages, message-base assignments, user info/permissions,
display strings, realm state, application status, community features, file
catalogs/counters, roles and base grants; back up your database before upgrading.
Existing messages stay in General and existing accounts retain posting/door
restrictions. Existing file records move to General (file base ID 1), without
moving their payloads. User, message and file IDs and credential hashes are preserved.

Removed messages disappear from public/sysop lists and reads. Their subject/body
are cleared in the live database, but the ID is reserved to avoid reusing an old
message number. These reserved rows still count toward the 100,000-post storage
cap. This is **not secure erasure**: SQLite WAL/free pages and existing backups
can retain old content. A caller may already have downloaded a removed message.

Console access inherits the operating-system account's authority. There is no
sysop password prompt on the local console and no telnet route to these controls.
Secure the host login/session. Modem commands, DOS shells and voting are not
implemented. Sysop notes and file approvals are local-console operations.

## Caller lightbar commands

Use arrows and Enter to open a highlighted action, or press its letter without
Enter. `?` immediately displays this list in the BBS.

| Key | Feature |
|---|---|
| `E` | Private email |
| `C` | Own user configuration |
| `U` | Public user listing |
| `F` | File catalog and ZMODEM transfers |
| `M` | Public message menu |
| `S` | Private note to the local sysop |
| `K` | QWK offline public mail |
| `O` | Automessage |
| `P` | Request a sysop page |
| `T` | Own statistics |
| `B` | BBS listings |
| `L` | Last callers |
| `I` | Oneliners |
| `D` | Door lounge |
| `G` | Own autosignature |
| `Q` | Goodbye (`/G` also works) |
| `A` | Welcome artwork |

### Email, preferences and community content

- **E:** `W` composes private mail (recipient handle, subject, body); `.` sends.
  Numeric IDs read only your own inbox. `N/P` pages, `Q` returns.
- **C:** `R` edits your real name, `L` your location, `N` your own statistics
  note. Each accepts 60 printable characters; `-` clears it. These fields are
  private. Your statistics note is separate from the local-only sysop note.
- **G:** `E` edits your 160-character signature; `-` clears it. Signatures are
  appended to online public posts and count toward their line/character limits.
- **O:** `W` replaces the current 160-character public automessage.
- **B:** `A` adds a BBS name (40 characters) and address (100).
- **I:** `A` adds a 120-character oneliner. BBS/oneliner lists use `N/P`.
- **S:** Enter a private sysop note; `.` saves. Guest notes are also available
  from the login matrix, once per connection.
- **P:** Enter a page reason (160 characters). This creates a private local
  notification, not an automatic chat connection. At WFC the sysop uses **R**
  to read/acknowledge requests, or **N**, **W ID**, **C** to start live chat
  with a connected, logged-in caller. Refresh never interrupts console editing.
- **T:** View your own durable call count, post/mail/transfer counts and note;
  `Q` returns. Upload counts include successful pending uploads; download counts
  increase only after a completed ordinary-file transfer, not QWK.

`Q` returns from submenus; `/abort` cancels any community editor. Mail/note
bodies use the existing 50-line / 4096-character limit and printable input.
Recipient accounts must be approved and enabled. Public lists never show mail,
real names, locations, statistics notes or sysop notes.
Mail drafts bind to the selected account's permanent ID: renaming it preserves
the recipient, and deleting it never redirects a draft to a reused handle.
Recipient availability is checked again when sending.

Persistent cooldowns are ten seconds for email; one minute each for automessages,
BBS additions, oneliners and authenticated notes; five minutes for page requests.
Lists have ten rows, with fourteen wrapped lines per body page. Storage caps are
100,000 emails (1,000 per recipient), 1,000 BBS listings, 10,000 oneliners and
10,000 notifications including resolved requests. Full stores reject additions;
the automessage retains only its current entry.

### Files and offline mail

From `F`, use `D ID` to download an approved file, `U` to upload, `N/P` to
page, `B` to choose an accessible file base by ID, and `Q` to return.
If the selected base is inaccessible, the base selector opens instead.
Your terminal needs built-in **ZMODEM** support.
Downloads require the file base's list/download grants. Uploads go to the
selected base, require list/upload and posting permissions, and remain unavailable to other callers
until the local sysop approves them with **F, A ID, YES**.
Unapproving stops new downloads and further output on active downloads;
it cannot recall bytes already delivered.
Filenames are metadata, never client-selected host paths. Files are never executed.

Files are limited to **4 MiB each**, **64 MiB total live payload**, and
**1,000 retained catalog IDs**. Removing a file clears its payload and metadata
but reserves its ID. There are at most four simultaneous transfers, with
120-second absolute and 30-second idle deadlines. Raw uploads use a bounded
128 KiB burst and approximately 256 KB/s socket backpressure; ordinary caller
input retains its original limits.

From `K`, `D` downloads `NOCTURNO.QWK`, containing up to the latest 100 readable
posts; `U` receives a reply ZIP containing `NOCTURNO.MSG`. Replies require an
approved, enabled account with global/per-user posting permission and read/post
grants for every target base. Exported conference lists, indexes and bodies
exclude inaccessible bases; callers with no readable bases cannot export.
Imports are limited to 2 MiB / 100 replies and commit atomically.
Private email is not included in QWK packets.
Reply packets using the previous `NIGHTWIR.MSG` filename and matching board ID
remain accepted, with the same account and access checks. New exports and
offline-reader configurations use `NOCTURNO`.

The in-process ZMODEM implementation supports hex/CRC16/CRC32 headers and data,
fragmented uploads, cancellation, and download restart offsets. Transfers are
single-file, with stop-and-wait downloads; there is no sliding window,
persistent upload resume or automatic CRC retransmission. Invalid CRCs and
protocol errors terminate the affected session rather than accepting damaged data.
Interoperability tests cover specified frames, CRC vectors and ZIP structure;
an external terminal-client interoperability matrix is not claimed.

## Door games: Frontier Realms

From the caller's main menu, choose **D**, then **1**. This is an original,
in-process multiplayer strategy game. It never launches a shell. Each user
has one persistent realm, created on first game entry with **100 land, 1000
gold and 20 troops**. Multiple callers share the same world; state changes
are atomic. Progress survives logout and server restart.

Each realm gets **20 turns per UTC day**, reset on its next visit/action.
Unused turns do not accumulate; reconnecting does not grant extra turns.
The generated ANSI command center, development panel, rankings and field manual
fit an 80x24 terminal. Yellow action keys, green land, gold treasury values,
red armies and blue section bars separate the information at a glance.
Commands without arguments work immediately; `A ID` still requires Enter.

| Command | Action (one turn each) |
|---|---|
| `E` | Explore: gain 5 land and `50 + 10 * markets` gold |
| `T` | Recruit: spend 100 gold for up to 10 troops |
| `H` | Harvest: earn `min(1000, 100 + floor(land / 10) + 25 * farms)` gold |
| `A ID` | Attack the realm belonging to that user ID |
| `F` / `M` / `W` | Build one farm / market / watchtower level |
| `B` | Development panel with current levels and next costs (free) |
| `C` | Return to the command center (free) |
| `L` | Show the current ten-row leaderboard page (free) |
| `N` / `P` | Page through the ten-row realm leaderboard (no turn cost) |
| `?` | Field manual with economy, construction and combat rules (free) |
| `Q` | Return to the door lounge (no turn cost); `Q` again returns to main |

Development starts at level zero, including for existing realms, and each
structure has a maximum level of **10**. Each upgrade costs one turn plus
`base cost * (current level + 1)` gold: farms **200**, markets **300**,
watchtowers **250**. Farms improve every harvest; markets improve every
exploration. Watchtowers add **2 defense per level**. Construction does not
consume land, and levels persist through attacks and UTC turn refreshes.
Failed purchases spend nothing. The development panel shows the next price.

Combat is deterministic, consumes troops, and can transfer up to 10 land.
An attacker commits `min(500, ceil(troops / 4))` troops and wins only when
that force exceeds `ceil(defender troops / 4) + 2 * defender watchtowers`.
Realms retain at least 20 land and cannot be eliminated. Caps are 1,000,000
land, 1,000,000 gold and 100,000 troops. You cannot attack yourself, a disabled
account, or a realm that has not entered the game. The defender's latest
combat notification persists until replaced by another attack. There is no
protected offline mode: other players may attack while you are disconnected.
There are no alliances, trading, resets or external
door protocol. A revoked door permission prevents play, not attacks against
an existing realm; disable an account to remove it from active competition.

## Configuration

Environment variables (PowerShell example: `$env:BBS_PORT = '2323'`):

| Variable | Default | Meaning |
|---|---|---|
| `BBS_NAME` | `Nocturno BBS` | Initial name only; saved sysop settings take precedence |
| `BBS_PORT` | `2323` | Plain telnet, always bound to `127.0.0.1` |
| `BBS_DATA_DIR` | `data` | Directory containing SQLite and the server-owned `files` payload directory |
| `BBS_DASHBOARD` | `1` | Set `0` to disable the local interactive sysop console |
| `BBS_MCP_ENDPOINT` | unset | Opt-in local named pipe / absolute Unix socket; requires token |
| `BBS_MCP_TOKEN` | unset | Random 64-hex-character shared IPC token; never log/commit it |
| `BBS_MCP_SYSOP` | `0` | Set `1` to delegate local sysop authority to authenticated MCP clients |
| `BBS_TLS_CERT` | unset | PEM certificate chain path |
| `BBS_TLS_KEY` | unset | PEM private key path |
| `BBS_TLS_HOST` | `127.0.0.1` | TLS bind address; explicitly opt into public access |
| `BBS_TLS_PORT` | `9923` | TLS listener port |

Both certificate and key are required to enable TLS. Minimum TLS version is 1.2.
For remote service, use a certificate trusted by your clients and set
`BBS_TLS_HOST` to the intended interface. Use a TLS-capable BBS client or a
certificate-verifying TLS tunnel; ordinary telnet cannot connect to the TLS
port. Do not disable certificate validation.

### Connecting through a TLS tunnel with stunnel

Use this method when your BBS terminal supports ordinary telnet but not
SSL-Telnet/TLS. It works with clients such as PuTTY and SyncTERM: **stunnel runs
on your computer**, accepts a local telnet connection, and encrypts the remote
connection to Nocturno. stunnel is separate software, not included with PuTTY
or Nocturno. No SSH account or remote shell access is required.

The connection path is:

```text
Telnet/BBS client -> your loopback port 12323 -> stunnel
                 -> encrypted TLS connection -> Nocturno TLS port 9923
```

#### Prerequisites

- Install a current [stunnel release](https://www.stunnel.org/downloads.html)
  for your operating system, or use your distribution's maintained package.
- Ask the operator for the BBS's TLS hostname and port. The examples below use
  `bbs.example.com:9923`; replace these with the real values.
- The operator must enable Nocturno's TLS listener using `BBS_TLS_CERT` and
  `BBS_TLS_KEY`, set `BBS_TLS_HOST` to the intended reachable interface, and allow
  the TLS port through the firewall. The plaintext port stays loopback-only.
- Obtain a trusted PEM CA certificate bundle for verifying the server. For a
  publicly issued certificate, use a maintained CA bundle from a trusted source;
  for a private CA, obtain its public CA certificate from the operator and verify
  its fingerprint over a separate trusted channel. Do not trust a certificate
  simply because an unverified connection presented it.

Only public CA certificates belong on the caller's computer. The operator's
server private key must never be copied to callers. stunnel's trust setup is
explicit here; do not assume it automatically uses your operating system's
certificate store.

#### Configure and start stunnel

1. Create a local configuration folder. In this Windows example it is
   `C:\BBS-Tunnel`. Save your trusted PEM CA bundle there as `trusted-ca.pem`.
   Keep this local configuration and certificates outside the Nocturno checkout.

2. Save the following as `stunnel.conf` in that folder:

   ```ini
   [nocturno-bbs]
   client = yes
   accept = 127.0.0.1:12323
   connect = bbs.example.com:9923
   verifyChain = yes
   CAfile = C:\BBS-Tunnel\trusted-ca.pem
   checkHost = bbs.example.com
   sni = bbs.example.com
   sslVersionMin = TLSv1.2
   ```

   Replace `bbs.example.com` in **all three places** with the hostname covered
   by the server's certificate. Adjust the remote port if needed. On macOS or
   Linux, replace `CAfile` with the absolute path to your trusted PEM CA bundle.

   `verifyChain` checks certificate trust and `checkHost` checks the server's
   identity; keep both enabled. `sni` supplies the TLS server name. This is
   immediate TLS, not STARTTLS: do not add `protocol = telnet`.

3. Start stunnel with this configuration. For example, if its executable is on
   your PATH, run this in PowerShell:

   ```powershell
   stunnel 'C:\BBS-Tunnel\stunnel.conf'
   ```

   Otherwise use the full path to your installed executable (with PowerShell's
   `&` call operator for a quoted executable path). On macOS/Linux, run
   `stunnel stunnel.conf` from your configuration folder. Follow your package's
   GUI/service instructions if it manages stunnel that way. Load or reload this
   configuration, not unrelated sample services.

4. Confirm in stunnel's log/status window that the local listener started
   without configuration or bind errors. Keep stunnel running while connected.
   The remote TLS handshake and certificate verification occur when your BBS
   client connects, not merely when stunnel starts.

#### Connect your BBS terminal

Create a connection with these settings:

| Setting | Value |
|---|---|
| Protocol | Ordinary Telnet, not SSH, raw TCP or SSL-Telnet |
| Host | `127.0.0.1` |
| Port | `12323` |
| Terminal | ANSI-BBS or ANSI/VT100, at least 80 columns and 24 rows |
| Character set | CP437 |
| Local echo / local line editing | Automatic or off |

In PuTTY, select **Telnet** under **Session** and use the local host/port above.
Do not point a plain telnet client directly at the remote TLS port.
Log in at Nocturno's menu with your normal BBS handle and password, or apply
with `N`; normal local sysop approval still applies. The tunnel does not grant
additional BBS permissions. File transfers still require support in your
terminal emulator; stunnel does not add ZMODEM support to PuTTY.

The local terminal-to-stunnel hop is plaintext. Keep `accept` bound to
`127.0.0.1`, never a wildcard/public interface. Do not configure this as a
shared public telnet gateway. If the SSH tunnel described below already uses
`12323`, choose another local port in both stunnel and your BBS client.

Log off the BBS before stopping stunnel through its GUI, service manager or
your package's shutdown mechanism. Stopping it disconnects active callers.

#### TLS tunnel troubleshooting

- **Local connection refused:** stunnel is not running, failed to load the
  configuration, or your terminal uses the wrong local port.
- **Address already in use:** change `accept` to `127.0.0.1:12324` and use port
  `12324` in the terminal too. Leave the remote TLS port unchanged.
- **Certificate verification failed:** check the CA bundle, certificate expiry,
  your computer's clock, and the server's certificate chain with the operator.
  Do not disable verification to work around it.
- **Hostname mismatch:** `checkHost` must match the certificate's DNS identity.
  Use the operator's certified hostname, not an arbitrary IP address or alias.
- **Remote connection refused or timed out:** check `connect`, the server's TLS
  listener and its firewall. The default TLS port is `9923`, not `2323`.
- **Wrong TLS version / handshake failure:** confirm that `connect` targets the
  immediate-TLS listener rather than plaintext telnet or SSH.
- **Garbled art or duplicate typing:** check CP437 and automatic/off local echo
  and line editing in the BBS terminal; TLS does not change those settings.

See the [stunnel manual](https://www.stunnel.org/manual.html) for configuration
options and platform-specific service management.

### Connecting through an SSH tunnel

An SSH tunnel encrypts the connection between your computer and the SSH server,
then forwards it to Nocturno's loopback-only telnet listener. Nocturno does not
provide an SSH server itself.

You need:

- An SSH server on the same host as Nocturno, reachable from your computer.
- An SSH account supplied by the operator, with permission to forward TCP
  connections to `127.0.0.1:2323`. This is separate from your BBS account;
  registering with the BBS does not create an SSH account.
- Nocturno running on that host with its default telnet port, `2323`.
- A telnet/BBS client supporting ANSI, CP437 and server-echo negotiation.

Keep the BBS telnet port private; expose only the SSH service for this method.
Operators should restrict tunnel accounts to the required forwarding destination
and avoid granting unnecessary shell or other forwarding access.

#### OpenSSH (Windows, macOS or Linux)

1. On **your computer**, open PowerShell or a terminal and run:

   ```text
   ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:12323:127.0.0.1:2323 your-account@your-server
   ```

   Replace `your-account` and `your-server` with the SSH username and server
   address supplied by the operator. If SSH uses a nondefault port, add
   `-p 2222` before `your-account@your-server`, replacing `2222` as needed.
   If the operator changed `BBS_PORT`, replace the final `2323` with that port.

2. Verify the SSH host-key fingerprint with the operator before accepting a new
   host key. Authenticate using your SSH key or SSH account password. Do not
   bypass host-key checking or ignore an unexpected host-key change.

3. Leave this terminal open. With `-N -T`, SSH does not open a remote shell;
   after authentication it normally waits without further output.

4. Open your **telnet/BBS client separately** and connect using:

   | Setting | Value |
   |---|---|
   | Protocol | Telnet, not SSH or raw TCP |
   | Host | `127.0.0.1` |
   | Port | `12323` |
   | Terminal | ANSI/VT100, at least 80 columns and 24 rows |
   | Character set | CP437 |
   | Local echo / local line editing | Automatic or off |

5. At Nocturno's login menu, use your **BBS handle and password**, or apply for
   an account with `N`. Normal local sysop approval is still required.
   The tunnel does not grant BBS privileges or sysop access.

The first `127.0.0.1:12323` is the listener on your computer. The final
`127.0.0.1:2323` is the BBS destination as seen by the SSH server. The explicit
local bind prevents other computers from using your tunnel. Do not add `-g`
or change it to a public/wildcard address.

Log off the BBS before pressing **Ctrl+C** in the SSH terminal to close the
tunnel. Closing the tunnel while connected disconnects your BBS session.

#### PuTTY tunnel setup (Windows)

1. Create a PuTTY session using the remote server's address, its SSH port
   (normally `22`), and connection type **SSH**.
2. Under **Connection > SSH > Tunnels**, enter source port `12323` and
   destination `127.0.0.1:2323`. Select **Local**, leave **Local ports accept
   connections from other hosts** unchecked, and click **Add**.
3. Return to **Session**, save the configuration if desired, and click **Open**.
   Verify the host-key fingerprint and authenticate with your SSH account.
   Keep this SSH window open.
4. In a **second** PuTTY session or your preferred BBS client, select **Telnet**
   and connect to `127.0.0.1`, port `12323`. Use the terminal settings above,
   then log in with your BBS account.

#### Tunnel troubleshooting

- **Address already in use:** choose another local port, such as `12324`, in
  both the tunnel configuration and your telnet client. The remote BBS port
  stays `2323`.
- **SSH connection refused or timed out:** check the SSH hostname, SSH port,
  server availability and firewall with the operator.
- **SSH permission denied:** check your SSH credentials, not your BBS password.
- **Administratively prohibited:** the SSH server/account does not allow the
  requested forwarding destination; ask the operator to check its policy.
- **Forwarded connection refused:** ensure Nocturno is running on the SSH
  server and that the destination matches its configured `BBS_PORT`.
- **Local telnet connection refused:** ensure the tunnel is still open and
  that your client uses its local port (`12323`), not the remote port (`2323`).
- **Garbled artwork or duplicated typing:** use CP437 and automatic/off local
  echo and local line editing in the telnet client.

The connection path is:

```text
Telnet/BBS client -> your loopback port 12323 -> encrypted SSH tunnel
                 -> server loopback port 2323 -> Nocturno BBS
```

**Plain telnet has no encryption**, including on the loopback interface.
Do not forward its port publicly, place it behind an unauthenticated public
proxy, or reuse credentials from other systems.

## Security model and limits

- Passwords use asynchronous scrypt (`N=32768, r=8, p=3`), 128-bit random salts,
  512-bit derived keys, and constant-time comparison. Unknown-user login runs
  the same derivation against a dummy hash. No recoverable passwords.
- Shared login/registration limiter: 10 attempts per IP per 15 minutes.
  At most four concurrent password derivations and five failed authentication
  submissions per session. Limits are process-local and reset on restart.
- 32 concurrent sockets, three per IP (shared across telnet/TLS), and 30 new
  connections per IP per minute. TLS handshakes have a 10-second timeout.
  IPs behind a shared NAT/SSH tunnel share these limits.
- Default five-minute idle timeout and 60-minute session lifetime, configurable
  for new connections from the local sysop console. Input is limited to
  160 characters per line, 16 queued commands, 16 KiB burst / 8 KB/s sustained,
  1 KiB subnegotiation, and 128 telnet option negotiations per session.
  Slow output readers are disconnected at the bounded output-buffer threshold.
- Message subject: 60 characters; body: 50 lines / 4096 characters.
  Posting interval: 10 seconds per session. Storage caps: 10,000 users and
  100,000 messages. Last-call history retains approximately 1,000 calls
  (active calls are not pruned).
- SQL parameters, printable-text validation, and rendering sanitization prevent
  callers from injecting SQL or ANSI/OSC terminal commands. Only application
  renderers and trusted local, allowlisted ANSI templates produce terminal escapes.
- No HTTP server, shell execution, dynamic module loading, or user-chosen
  filesystem paths. Configuration is trusted local operator input.
- Error logs contain only sanitized error codes, never passwords, raw commands,
  caller-supplied ANSI, or database contents.

This is a **single-process starter**, not a hardened public hosting platform.
There is no password recovery, caller self-service account removal, per-account lockout, or
distributed rate limiting. Schema upgrades are additive, not a general migration
framework. Use a dedicated
unprivileged service account, firewall, private data directory, and disk quotas.
On Windows, protect data and PEM keys with NTFS ACLs; POSIX mode bits do not
provide equivalent protection. SQLite/WAL and backups contain credential
verifiers and message data and must be treated as sensitive.

Run only one process against each database. On restart, interrupted calls are
marked ended at their start time (unknown duration, displayed as zero minutes).
Back up the database while stopped, including any remaining `-wal`/`-shm` files.
Back up its `files` payload directory at the same time. A crash between writing
a new payload and committing its catalog row can leave an orphan payload;
there is no automatic orphan sweep. Use host disk quotas as well as BBS limits.
Do not copy a live SQLite database with ordinary file-copy tools.

## Tests and security checks

```powershell
npm test
npm run test:coverage
npm run lint
npm run sast
npm run audit
```

`npm run sast` executes ESLint's recommended JavaScript rules plus the trusted
`eslint-plugin-security` recommended rules with zero warnings allowed. The
official `@eslint/compat` adapter preserves plugin support on ESLint 10.
Dynamic-object-index heuristics are disabled because they flag ordinary map/
array access; filesystem suppressions are narrowly documented for operator
certificate paths and isolated test cleanup. This is a lightweight SAST
baseline, not proof of vulnerability absence.

Tests use Node's native runner and real ephemeral sockets/SQLite databases.
TLS integration requires an ephemeral certificate:
set `BBS_TEST_CERT` and `BBS_TEST_KEY` to PEM paths for a certificate with
`DNS:localhost`, then run `npm test`. Without these variables the TLS case is
explicitly skipped. CI generates its own short-lived certificate and runs it.
Never use a production private key in tests.

The GitHub workflow runs tests, SAST, and `npm audit` on Linux and Windows.
The separate CodeQL workflow performs deeper JavaScript security analysis when
hosted in a GitHub repository with CodeQL available. CodeQL is not executed by
the local `sast` command. Review tool output; do not blanket-suppress findings.
Dependency audit checks installed development packages too.
The `minimatch` override requires patched 11.0.1+ to address
GHSA-g3hv-75wg-m249 in ESLint's development dependency tree. Remove the override
once ESLint and `@eslint/config-array` require a patched version themselves.

## Troubleshooting

- `EADDRINUSE`: a configured port is occupied; stop the owning service or choose
  another port. Do not terminate unrelated processes.
- `ENOENT` / TLS startup failure: check PEM paths, read permissions, matching
  key/certificate, and certificate format.
- `ERR_TLS_*`: inspect client trust, hostname and protocol settings.
- `ERR_SQLITE_*`: check directory permissions, free space and database integrity.
- `ECONNRESET`: a peer disconnected abruptly; its session is cleaned up.
- Text repeats locally or login is rejected: use a real telnet client with
  server echo, not a raw TCP/line-mode client. Keep local echo automatic/off.

## Layout

- `src/telnet.js`: bounded streaming protocol and line editor.
- `src/auth.js`: hashing, verification, admission control and attempt limiter.
- `src/store.js`: SQLite schema and parameterized persistence.
- `src/session.js`: authenticated session state machine.
- `src/screens.js`: original ANSI screens, lists and sysop dashboard.
- `src/presentation.js`, `ansi/`, `ANSI.md`: optional screen overrides, placeholders
  and editable string catalog.
- `src/doors.js`: persistent original multiplayer realm game.
- `src/community.js`: private mail, caller preferences/signatures, community
  content, statistics and local sysop requests.
- `src/transfers.js`, `src/transfer-zmodem.js`, `src/transfer-qwk.js`: approved
  file catalog, bounded binary transfers and offline public-mail packets.
- `src/sysop.js`: local-only menu controller and bounded raw-TTY keyboard adapter.
- `src/mcp.js`, `src/mcp-server.js`: stdio MCP bridge and authenticated local IPC
  server; `src/mcp-terminal.js`, `src/mcp-transport.js`: bounded terminal sessions
  and JSON framing.
- `src/local-terminal.js`: adaptive 80x24/25 local viewport, VGA RGB/CP437 display translation
  and in-process login transport.
- `src/server.js`: localhost telnet, optional TLS, connection limits and shutdown.
- `src/config.js`, `src/index.js`: operator configuration and executable entry.
- `test/`: native unit and socket integration tests.
- `.github/skills/bbs-development/SKILL.md`: future-agent maintenance workflow.

# scoped

[![CI](https://github.com/OrenSegal/scoped/actions/workflows/ci.yml/badge.svg)](https://github.com/OrenSegal/scoped/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)

An MCP coordination layer for concurrent Claude Code fleets, with real enforcement, not just an advisory API. `claim`, `release`, and `check` give a fleet of agent sessions a way to ask "is someone already on this file?", and a `PreToolUse` hook automatically blocks an Edit/Write on a file another session already owns, no tool call required.

## The problem

Running more than one Claude Code session against the same codebase is now normal: a session per Linear issue, a session per worktree, several against the same repo at once. Nothing stops two of them from editing the same file at the same time. Most tooling improves what one agent understands. This is about coordination *between* agents.

## What it is

**Enforcement (automatic):** a `PreToolUse` hook fires before every `Edit` / `MultiEdit` / `Write` / `NotebookEdit`. If the target file is claimed by a different session, the hook denies the tool call with a reason instead of letting the edit happen. If the file is unclaimed, the hook auto-claims it for the calling session, so coordination doesn't depend on the model remembering to call anything first.

**Tools (explicit, for planning and visibility):**

- **`claim(issue_id, file_paths, session_id)`**: reserve files ahead of time, e.g. before a multi-file refactor, so a conflict shows up before you start rather than mid-edit.
- **`release(issue_id, session_id)`**: free claims early, on completion or handoff, instead of waiting out the TTL.
- **`check(file_path)`**: ask if a file is currently claimed.
- **`status()`**: a fleet-wide snapshot: which sessions are on which issues and files right now.

## Design

**Locking is local.** Claims live in a SQLite file at `~/.scoped/claims.db` (`node:sqlite`, no extra dependency). A unique index on `file_path` makes claim/conflict detection atomic: two sessions racing to claim the same file get one winner, not two.

**Visibility is Linear, and it's separate from the lock.** If `LINEAR_API_KEY` is set, explicit `claim`/`release` calls post as comments on the issue, for humans watching the fleet, not for the lock itself. Linear is a network call with real latency and no compare-and-swap, so it's the wrong place for the part that has to be fast and atomic. The hook's auto-claims stay local and silent, since a comment per edit would be noise.

**One identity, two entry points. This is the part that actually had to be solved.** The hook and the MCP server are separate OS processes, and Claude Code doesn't hand an MCP subprocess any session identifier that matches what a hook receives. Left alone, that means an agent that explicitly pre-claims a file via the `claim` tool (forced to invent its own random ID) would then get blocked by its own hook the moment it tried to edit that file, because the hook would see a different owner. Fixed by:
- a `SessionStart` hook that injects Claude Code's real `session_id` into context at the start of every session, and
- making `session_id` a required argument on `claim`/`release`, so an explicit claim and the hook's automatic enforcement always resolve to the same owner.

**Stale claims self-heal, but the failure modes differ by origin.** Every read reaps dead claims first. A claim made through the long-lived MCP server tracks its process's pid. If that process is gone (same host), the claim is dead immediately, with no TTL wait. A claim made by the hook can't do that: the hook is a short-lived script that exits after every call, so its pid is *never* alive by the time the next check runs, and storing it would reap every hook-made claim on the next edit. Hook claims skip pid tracking and rely on TTL instead (4h default), refreshed every time the owning session keeps editing that file, so an active session's claim doesn't expire mid-work while an abandoned one still ages out.

## Setup

### As a plugin

```bash
claude plugin marketplace add OrenSegal/scoped
claude plugin install scoped@scoped
```

The plugin registers both hooks, the MCP server, the `scoped` CLI (the plugin's `bin/` is on
the Bash tool's `PATH`) and the `/scoped:*` slash commands. On first start the MCP launcher
(`bin/scoped-mcp`) installs the server's two runtime dependencies into
`${CLAUDE_PLUGIN_DATA}/deps/<lockfile hash>/`, which survives plugin updates and works when the
plugin directory is read-only. That needs `npm` and the network once; it runs
`npm ci --omit=dev --ignore-scripts` in a temp dir and renames it into place, so two sessions
starting together don't corrupt it. If `npm` is missing or the machine is offline, the server
does not start and says why on stderr (`claude --debug` or `/mcp` shows it). The hooks and the
CLI need no dependencies, so enforcement works either way.

Don't also run `npm run setup`: it refuses when it finds the plugin, because every hook would
then run twice. `scoped doctor` checks for exactly this.

### From a clone

Requires Node.js ≥22.13 (or ≥23.4 on the odd-numbered line) and the `claude` CLI on your `PATH`. `node:sqlite` exists from Node 22.5, but stayed behind `--experimental-sqlite` until 22.13/23.4. scoped never passes that flag when it runs the server or hooks, so 22.5-22.12 will hit `ERR_UNKNOWN_BUILTIN_MODULE`.

```bash
git clone https://github.com/OrenSegal/scoped.git
cd scoped
npm install
npm run setup
```

`npm run setup` (`scripts/install.mjs`) does both of the steps below for you, and is safe to re-run: it checks for an existing entry before adding anything, so it never duplicates config or clobbers unrelated settings:

1. Registers the MCP server with `claude mcp add scoped --scope user -- node <repo>/bin/scoped-mcp`, unless a `scoped` server is already registered at user, local or project scope.
2. Merges a `SessionStart` and a `PreToolUse` hook (quoted path, `timeout: 15`) into the *global* `~/.claude/settings.json` (not a per-project one, because the point is coordination across repos and worktrees). A hook already registered in any user, project or local settings file, from any checkout path, is left alone. The file is written atomically.

It exits with an error, changing nothing, if scoped is already installed as a plugin (`installed_plugins.json` or `enabledPlugins`); `--force` overrides that. Restart any running Claude Code sessions afterward so they pick up the new MCP server and hooks. To remove everything scoped added, run `npm run uninstall` (`scripts/uninstall.mjs`). It only touches the entries it created, leaving the rest of your settings untouched.

From a clone the CLI is `node bin/scoped` (or `npm link` to put `scoped` on your `PATH`).

Optionally set `SCOPED_ISSUE_ID` (e.g. `ENG-123`) in a session's environment before launching it, so the hook's auto-claims group under the real issue instead of a synthetic `adhoc:<session>` bucket. For Linear visibility comments, set `LINEAR_API_KEY` in the MCP server's environment (`claude mcp add ... -e LINEAR_API_KEY=...`, or edit the entry `npm run setup` created).

<details>
<summary>Manual setup (if you'd rather not run the install script, or the <code>claude</code> CLI isn't on your PATH)</summary>

**1. MCP server**: add to your MCP config (e.g. via `claude mcp add`, or your client's `mcpServers` block):

```json
{
  "mcpServers": {
    "scoped": {
      "command": "node",
      "args": ["/absolute/path/to/scoped/src/index.mjs"],
      "env": { "LINEAR_API_KEY": "optional, enables the visibility comments" }
    }
  }
}
```

**2. Hooks**: add both to the *global* `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"/absolute/path/to/scoped/hooks/session-start.mjs\"", "timeout": 15 }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node \"/absolute/path/to/scoped/hooks/pretool-enforce.mjs\"", "timeout": 15 }]
      }
    ]
  }
}
```

If a `PreToolUse` or `SessionStart` array already exists in your settings, append these entries to it rather than replacing the array. Each event's hooks all run.

</details>

## CLI and slash commands

| Command | Slash command | What it does |
| :- | :- | :- |
| `scoped status [--json]` | `/scoped:status` | Every active claim: file, issue, session (8-char prefix), age, time left |
| `scoped check <file>` | | Exit 1 and name the holder if `<file>` is claimed, exit 0 if it is free |
| `scoped release <session or prefix>` | `/scoped:release` | Free every claim a session holds. The prefix needs at least 4 characters and must match one session; the deny message prints the 8-character one |
| `scoped gc` | | Reap expired and dead-pid claims now (every read does this anyway) |
| `scoped report [--days=N]` | `/scoped:report` | Blocked edits from the block log (default 30 days) by file, session pair and issue, with what to change if one file keeps colliding |
| `scoped doctor` | `/scoped:doctor` | Node and `node:sqlite`; claims db writable and its schema version; each hook and the MCP server registered exactly once across the plugin and user/project/local settings; an MCP `initialize` + `tools/list` round trip; PreToolUse latency against a budget; the fail policy. Exit 1 on any FAIL |

`/scoped:release` with another session's id shows that session's claims and asks before
releasing them.

## Configuration

All optional. Set them in the environment Claude Code starts with (hooks inherit it).

| Variable | Default | Effect |
| :- | :- | :- |
| `SCOPED_HOME` | `~/.scoped` | Directory for the claims db, block log and (outside a plugin) the MCP server's dependencies |
| `SCOPED_DB` | `$SCOPED_HOME/claims.db` | The claims db alone. Every session that should see the others must use the same one |
| `SCOPED_LOG` | `$SCOPED_HOME/blocks.tsv` | Block log path, or `off`. One line per denied edit: time, tool, file, both session ids, issue. No file contents |
| `SCOPED_ISSUE_ID` | `adhoc:<session>` | Issue the hook files its auto-claims under, e.g. `ENG-123` |
| `SCOPED_FAIL_CLOSED` | unset | `1` makes an internal hook error deny the edit instead of allowing it |
| `SCOPED_HOOK_MS` | `1000` | `scoped doctor`'s PreToolUse latency budget (over it is a warning) |
| `SCOPED_MCP_TIMEOUT_MS` | `60000` | How long `scoped doctor` waits for the MCP server, including a first-start install |
| `SCOPED_DEBUG` | unset | Stack traces instead of one-line errors on stderr |
| `LINEAR_API_KEY` | unset | Enables the Linear comments on explicit `claim`/`release` (MCP server environment) |

**Fail open or closed.** By default an internal hook error (no `node:sqlite`, an unwritable or
corrupt db, a malformed payload) lets the edit through, because a coordination bug should not
stop real work. It is not silent: the first such error in a session shows the user a
`systemMessage` ("edits in this session are NOT enforced ... Run `scoped doctor`"), and every
one goes to stderr. With `SCOPED_FAIL_CLOSED=1` the same error denies the edit with that
reason. The hooks are registered with a 15 s timeout and SQLite's busy timeout is 5 s, so a
locked db becomes one of these errors well before Claude Code would kill the hook.

## Development

```bash
npm install
npm test
```

`npm test` runs `node --test "test/*.test.mjs"`: `ClaimStore` (`src/store.mjs`) is tested directly against a temp SQLite file, and the hooks, the MCP server, the launcher, the CLI and `npm run setup` are tested as real subprocesses with `HOME`, `SCOPED_HOME` and `CLAUDE_CONFIG_DIR` pointed at temp dirs, so nothing touches your own `~/.claude` or `~/.scoped`. The one test that installs from the npm registry is skipped unless `SCOPED_NETWORK_TESTS=1`. See [CONTRIBUTING.md](CONTRIBUTING.md).

`evals/` holds a `claude plugin eval` suite (does the agent read `scoped status` instead of guessing; does it coordinate after a deny instead of forcing the edit). Each run is a paid model call, so CI doesn't run it. To run it yourself: `claude plugin eval . --allow-tools Bash` (the status case runs the CLI through Bash).

## Troubleshooting

Start with `scoped doctor` (or `/scoped:doctor`): it names the broken piece and exits 1.

- **Edits aren't being blocked / claims never show up.** Doctor's hook lines say whether each hook is registered, and where. Hooks only take effect in sessions started *after* they were registered, so restart the session.
- **The `scoped` MCP server shows as failed in `/mcp`.** Its stderr says why: Node too old for `node:sqlite`, `npm` not on `PATH`, or the dependency install failed (offline). Hooks keep enforcing in the meantime.
- **`claim`/`release` calls fail with a missing `session_id`.** The `SessionStart` hook injects it into context at session start; if the session was already running before you ran `npm run setup`, restart it.
- **"edits in this session are NOT enforced".** The hook failed open; the message carries the reason and doctor says what to fix.
- **A hook runs twice.** scoped is registered both as a plugin and through `npm run setup`. Run `npm run uninstall` from the clone, or remove the plugin.

**Performance note:** the hook adds one Node process start (roughly tens of milliseconds) to every Edit/MultiEdit/Write/NotebookEdit call. Measured against 500 concurrent claims in the table, `check()` (which reaps first) averages ~0.2ms, so the cost is process startup, not the lock.

## Limitations

- **Only Claude Code's edit tools are covered.** The hook sees `Edit`, `MultiEdit`, `Write` and `NotebookEdit`. A `Bash` command that writes a file (`sed -i`, `>`, a codegen script) or a process outside Claude Code isn't blocked. What it does guarantee: no session in the fleet can silently overwrite a file another session has claimed through the normal edit tools.
- **It fails open by default.** Any internal error in the enforcement hook (corrupt DB, unexpected input) lets the edit through rather than blocking real work over a coordination bug. The user sees a warning once per session; `SCOPED_FAIL_CLOSED=1` denies instead. See [Configuration](#configuration).
- **One machine only.** Claims live in a local SQLite file, and pid-based reaping only works on the same host. Sessions on different machines don't see each other.
- **Worktrees are separate files.** Claims key on the canonical absolute path (symlinks and `..` resolved), so `src/app.js` in two git worktrees is two different files and both sessions may edit it; that collision surfaces at merge, as it would without scoped.
- **Case-insensitive file systems, partly.** On macOS an existing file resolves to its on-disk case, so `app.js` and `App.js` are one claim. Two spellings of a file that doesn't exist yet are two claims until it is created.
- **Windows is untested.** CI runs Linux and macOS. The code handles Windows where it knows how (drive letter and case folding for claim keys, tested with Node's `path.win32`; `npm.cmd` in the launcher), but no one has run the hooks or the launcher on Windows yet. Reports welcome.
- **Claims are per file, not per region.** Two sessions can't edit different functions in the same file at the same time.
- **Hook-made claims expire by TTL (4h default).** A session that stops editing a file but keeps running releases it only when the TTL runs out or it calls `release`.
- **Not measured on a real fleet yet** (see Status).

## Status

v0.4. Core locking and PreToolUse enforcement are implemented and tested: claim, conflict, idempotent re-claim, TTL expiry, dead-pid reaping (MCP-side), TTL-only reaping (hook-side), cross-entry-point identity (an explicit pre-claim doesn't self-block the hook), and correct deny/allow/auto-claim/touch behavior for the hook itself. The claim insert is a single `INSERT ... ON CONFLICT DO NOTHING` on a connection with a SQLite busy timeout, and the hook acts on the result of that insert rather than on a separate check. Two tests cover this with real OS processes sharing one SQLite file: `test/concurrency.test.mjs` races 8 processes calling `claim()` on the same path for 20 rounds (exactly 1 winner, 7 conflicts, no errors, every round), and `test/hook.test.mjs` races 6 hook processes from different sessions for 15 rounds (exactly 1 allowed, 5 denied, none failing open, every round). Both tests failed in every run tried against the earlier code: the check-then-insert `claim()` threw `UNIQUE constraint failed`, the missing busy timeout threw `database is locked`, and the old hook allowed more than one session through. Not yet run against a real multi-session fleet long enough to report a collision-prevented count. That number will go here once it's real, not invented.

## License

MIT

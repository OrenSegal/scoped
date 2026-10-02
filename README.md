# scoped

[![CI](https://github.com/OrenSegal/scoped/actions/workflows/ci.yml/badge.svg)](https://github.com/OrenSegal/scoped/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)

Part of [sous](https://github.com/OrenSegal/sous): tools for checking what coding agents actually do.

scoped stops two Claude Code sessions from editing the same file at the same time: file claims between concurrent sessions, enforced by a `PreToolUse` hook, with an MCP server for `claim`, `release`, `check` and `status`.

## Why

Several Claude Code sessions against one codebase is normal now: one per Linear issue, one per worktree, several in the same repo. Nothing stops two of them from editing the same file at once.

## How it works

**Enforcement.** A `PreToolUse` hook runs before every `Edit`, `MultiEdit`, `Write` and `NotebookEdit`. If another session holds the file, the edit is denied with a reason that names the holder. If the file is free, the hook claims it for the calling session, so enforcement does not depend on the model calling anything first.

**Tools.** For planning and visibility:

- `claim(issue_id, file_paths, session_id)`: reserve files before a multi-file change, so a conflict shows up before you start.
- `release(issue_id, session_id)`: free claims on completion or handoff instead of waiting for them to expire.
- `check(file_path)`: is this file claimed, and by whom.
- `status()`: every active claim, by session and issue.

**Locking is local.** Claims live in SQLite (`node:sqlite`, no extra dependency) at `~/.scoped/claims.db`. A unique key on the canonical file path makes claiming atomic: two sessions racing for one file get one winner.

**One identity for hook and server.** Claude Code gives an MCP server no session id that matches the one a hook receives. A `SessionStart` hook puts the real `session_id` into the session's context, and `claim`/`release` require it, so an explicit claim and the hook's enforcement agree on the owner and a session is never blocked by its own claim.

**Stale claims expire.** Every read reaps dead claims first. A claim made through the MCP server records the server's pid and dies with it (same host). The hook exits after every call, so its claims have no live pid; they expire by TTL instead, and each edit by the owning session restarts that TTL.

**Linear is visibility, not the lock.** With `LINEAR_API_KEY` set, explicit `claim`/`release` calls post a comment on the issue. The hook's automatic claims stay local and silent. See [SECURITY.md](SECURITY.md) for what is sent.

## Install

### As a plugin

```bash
claude plugin marketplace add OrenSegal/scoped
claude plugin install scoped@scoped
```

The plugin registers both hooks, the MCP server, the `scoped` CLI (the plugin's `bin/` is on the Bash tool's `PATH`) and the `/scoped:*` slash commands. On first start the MCP launcher installs the server's runtime dependencies into `${CLAUDE_PLUGIN_DATA}/deps/<lockfile hash>/` with `npm ci --omit=dev --ignore-scripts`, in a temp dir that is renamed into place, so it survives plugin updates, works on a read-only plugin directory, and two sessions starting together don't corrupt it. That needs `npm` and the network once. Without them the server does not start and says why on stderr (`/mcp` shows it); the hooks and the CLI need no dependencies and keep enforcing.

### From a clone

Requires Node.js 22.13.0 or later (23.4 or later on the odd-numbered line), where `node:sqlite` needs no flag, and the `claude` CLI on your `PATH`.

```bash
git clone https://github.com/OrenSegal/scoped.git
cd scoped
npm install
npm run setup
```

`npm run setup` registers the MCP server at user scope (`claude mcp add scoped --scope user -- node <repo>/bin/scoped-mcp`) and adds the `SessionStart` and `PreToolUse` hooks to the global `~/.claude/settings.json`, written atomically. It is safe to re-run: anything already registered, at any scope or from any checkout path, is left alone. It refuses, changing nothing, when scoped is already installed as a plugin, because every hook would then run twice (`--force` overrides). Restart running sessions afterwards. `npm run uninstall` removes only what setup added.

From a clone the CLI is `node bin/scoped`, or `npm link` to put `scoped` on your `PATH`.

<details>
<summary>Manual setup, without the setup script</summary>

MCP server, in your MCP config:

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

Hooks, in the global `~/.claude/settings.json` (append to existing `SessionStart`/`PreToolUse` arrays rather than replacing them):

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

</details>

## CLI and slash commands

| Command | Slash command | What it does |
| :- | :- | :- |
| `scoped status [--json]` | `/scoped:status` | Every active claim: file, issue, session (8-char prefix), age, time left |
| `scoped check <file>` | | Exit 1 and name the holder if `<file>` is claimed, exit 0 if it is free |
| `scoped release <session or prefix>` | `/scoped:release` | Free every claim a session holds. A prefix needs at least 4 characters and must match one session; deny messages print the 8-character one |
| `scoped gc` | | Reap expired and dead-pid claims now (every read does this anyway) |
| `scoped report [--days=N]` | `/scoped:report` | Blocked edits from the block log (default 30 days) by file, session pair and issue, with what to change if one file keeps colliding |
| `scoped doctor` | `/scoped:doctor` | Node and `node:sqlite`; the claims db and its schema; each hook and the MCP server registered exactly once across the plugin and user/project/local settings; an MCP `initialize` + `tools/list` round trip; hook latency; the fail policy. Exit 1 on any FAIL |

`/scoped:release` with another session's id shows that session's claims and asks before releasing them.

## Configuration

All optional. Set them in the environment Claude Code starts with; hooks inherit it.

| Variable | Default | Effect |
| :- | :- | :- |
| `SCOPED_HOME` | `~/.scoped` | Directory for the claims db, block log and (outside a plugin) the MCP server's dependencies |
| `SCOPED_DB` | `$SCOPED_HOME/claims.db` | The claims db alone. Sessions that should see each other must share it |
| `SCOPED_LOG` | `$SCOPED_HOME/blocks.tsv` | Block log path, or `off`. One line per denied edit: time, tool, file, both session ids, issue. No file contents |
| `SCOPED_ISSUE_ID` | `adhoc:<session>` | Issue the hook files its automatic claims under, e.g. `ENG-123` |
| `SCOPED_FAIL_CLOSED` | unset | `1` makes an internal hook error deny the edit instead of allowing it |
| `SCOPED_HOOK_MS` | `1000` | `scoped doctor`'s hook latency budget; over it is a warning |
| `SCOPED_MCP_TIMEOUT_MS` | `60000` | How long `scoped doctor` waits for the MCP server, including a first-start install |
| `SCOPED_DEBUG` | unset | Stack traces instead of one-line errors on stderr |
| `LINEAR_API_KEY` | unset | Linear comments on explicit `claim`/`release` (MCP server environment) |

**Fail open or closed.** By default an internal hook error (no `node:sqlite`, an unwritable or corrupt db, a malformed payload) lets the edit through, because a coordination bug should not stop real work. It is not silent: the first such error in a session shows the user "edits in this session are NOT enforced", with the reason, and every one goes to stderr. With `SCOPED_FAIL_CLOSED=1` the same error denies the edit. SQLite waits at most 5 s for a locked db, well inside the hooks' 15 s timeout, so a stuck db becomes one of these errors rather than a killed hook.

## Troubleshooting

Start with `scoped doctor` (or `/scoped:doctor`): it names the broken piece and exits 1.

- **Edits aren't blocked, or claims never show up.** Doctor says whether each hook is registered, and where. Hooks apply only to sessions started after registration: restart the session.
- **The `scoped` MCP server shows as failed in `/mcp`.** Its stderr says why: Node too old for `node:sqlite`, no `npm` on `PATH`, or the dependency install failed (offline). The hooks keep enforcing meanwhile.
- **`claim`/`release` fail for a missing `session_id`.** The `SessionStart` hook supplies it; restart a session that was already running when scoped was installed.
- **A hook runs twice.** scoped is registered both as a plugin and through `npm run setup`. Run `npm run uninstall` in the clone, or remove the plugin.

The hook costs one Node process start per edit, tens of milliseconds; the claim itself is well under a millisecond. Doctor measures it on your machine.

## Limitations

- **Only Claude Code's edit tools.** A `Bash` command that writes a file (`sed -i`, `>`, a codegen script), or a process outside Claude Code, is not blocked.
- **Fails open by default.** See [Configuration](#configuration).
- **One machine.** Claims are in a local SQLite file, and pid-based reaping only works on the same host.
- **Worktrees are separate files.** Claims key on the canonical absolute path (symlinks and `..` resolved), so `src/app.js` in two worktrees is two files; that collision surfaces at merge.
- **Case-insensitive file systems, partly.** On macOS an existing file resolves to its on-disk case, so `app.js` and `App.js` are one claim. Two spellings of a file that does not exist yet are two claims until it is created.
- **Windows is untested.** CI runs Linux and macOS. Claim keys fold drive letter and case on Windows (tested with `path.win32`), and the launcher uses `npm.cmd`, but nobody has run the hooks there. Reports welcome.
- **Per file, not per region.** Two sessions cannot edit different functions of one file at the same time.
- **Hook claims expire by TTL.** A session that stops editing a file but keeps running holds it until the TTL runs out or it calls `release`.
- **Not yet measured on a real fleet.** The claim race is tested with real processes sharing one db (`test/concurrency.test.mjs`, `test/hook.test.mjs`); a count of collisions prevented in real use will be published once there is one.

## Development

```bash
npm install
npm test
```

Tests run the store directly against a temp SQLite file, and the hooks, MCP server, launcher, CLI and setup script as real subprocesses with `HOME`, `SCOPED_HOME` and `CLAUDE_CONFIG_DIR` pointed at temp dirs. `evals/` is a `claude plugin eval` suite, not run in CI because runs are paid. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

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

Requires Node.js ≥22.13 (or ≥23.4 on the odd-numbered line) and the `claude` CLI on your `PATH`. `node:sqlite` exists from Node 22.5, but stayed behind `--experimental-sqlite` until 22.13/23.4. scoped never passes that flag when it runs the server or hooks, so 22.5-22.12 will hit `ERR_UNKNOWN_BUILTIN_MODULE`.

```bash
git clone https://github.com/OrenSegal/scoped.git
cd scoped
npm install
npm run setup
```

`npm run setup` (`scripts/install.mjs`) does both of the steps below for you, and is safe to re-run: it checks for an existing entry before adding anything, so it never duplicates config or clobbers unrelated settings:

1. Registers the MCP server with `claude mcp add scoped --scope user -- node <repo>/src/index.mjs`.
2. Merges a `SessionStart` and a `PreToolUse` hook into the *global* `~/.claude/settings.json` (not a per-project one, because the point is coordination across repos and worktrees).

Restart any running Claude Code sessions afterward so they pick up the new MCP server and hooks. To remove everything scoped added, run `npm run uninstall` (`scripts/uninstall.mjs`). It only touches the entries it created, leaving the rest of your settings untouched.

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
      { "hooks": [{ "type": "command", "command": "node /absolute/path/to/scoped/hooks/session-start.mjs" }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node /absolute/path/to/scoped/hooks/pretool-enforce.mjs" }]
      }
    ]
  }
}
```

If a `PreToolUse` or `SessionStart` array already exists in your settings, append these entries to it rather than replacing the array. Each event's hooks all run.

</details>

## Development

```bash
npm install
npm test
```

`npm test` runs `node --test`: `ClaimStore` (`src/store.mjs`) is tested directly against a temp SQLite file, and the `PreToolUse` hook is tested as a real subprocess (`$HOME` pointed at a temp dir per test) so deny/allow/auto-claim/touch behavior is exercised through the actual stdin/stdout contract Claude Code uses, not a mock of it. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

- **Edits aren't being blocked / claims never show up.** Confirm both hooks landed: `claude mcp list` should show `scoped`, and `~/.claude/settings.json` should have `hooks.SessionStart` and `hooks.PreToolUse` entries pointing at this repo's `hooks/` scripts. Hooks only take effect in sessions started *after* they were registered, so restart the session.
- **`claim`/`release` calls fail with a missing `session_id`.** The `SessionStart` hook injects it into context at session start; if the session was already running before you ran `npm run setup`, restart it.
- **Nothing happens and there's no error.** The hook fails open by design, so check its stderr (Claude Code surfaces hook stderr in its debug/transcript output) rather than assuming silence means success.

**Performance note:** the hook adds one Node process start (roughly tens of milliseconds) to every Edit/MultiEdit/Write/NotebookEdit call. Measured against 500 concurrent claims in the table, `check()` (which reaps first) averages ~0.2ms, so the cost is process startup, not the lock.

## Limitations

- **Only Claude Code's edit tools are covered.** The hook sees `Edit`, `MultiEdit`, `Write` and `NotebookEdit`. A `Bash` command that writes a file (`sed -i`, `>`, a codegen script) or a process outside Claude Code isn't blocked. What it does guarantee: no session in the fleet can silently overwrite a file another session has claimed through the normal edit tools.
- **It fails open.** Any internal error in the enforcement hook (corrupt DB, unexpected input) lets the edit through rather than blocking real work over a coordination bug. Errors go to stderr only, never to the model as a false denial.
- **One machine only.** Claims live in a local SQLite file, and pid-based reaping only works on the same host. Sessions on different machines don't see each other.
- **Claims are per file, not per region.** Two sessions can't edit different functions in the same file at the same time.
- **Hook-made claims expire by TTL (4h default).** A session that stops editing a file but keeps running releases it only when the TTL runs out or it calls `release`.
- **Not measured on a real fleet yet** (see Status).

## Status

v0.2. Core locking and PreToolUse enforcement are implemented and tested: claim, conflict, idempotent re-claim, TTL expiry, dead-pid reaping (MCP-side), TTL-only reaping (hook-side), cross-entry-point identity (an explicit pre-claim doesn't self-block the hook), and correct deny/allow/auto-claim/touch behavior for the hook itself. The claim insert is a single `INSERT ... ON CONFLICT DO NOTHING` on a connection with a SQLite busy timeout, and the hook acts on the result of that insert rather than on a separate check. Two tests cover this with real OS processes sharing one SQLite file: `test/concurrency.test.mjs` races 8 processes calling `claim()` on the same path for 20 rounds (exactly 1 winner, 7 conflicts, no errors, every round), and `test/hook.test.mjs` races 6 hook processes from different sessions for 15 rounds (exactly 1 allowed, 5 denied, none failing open, every round). Both tests failed in every run tried against the earlier code: the check-then-insert `claim()` threw `UNIQUE constraint failed`, the missing busy timeout threw `database is locked`, and the old hook allowed more than one session through. Not yet run against a real multi-session fleet long enough to report a collision-prevented count. That number will go here once it's real, not invented.

## License

MIT

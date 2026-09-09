# scoped

An MCP coordination layer for concurrent Claude Code fleets, with real enforcement — not just an advisory API. `claim`, `release`, and `check` give a fleet of agent sessions a way to ask "is someone already on this file?", and a `PreToolUse` hook automatically blocks an Edit/Write on a file another session already owns, no tool call required.

## The problem

Running more than one Claude Code session against the same codebase is now normal — a session per Linear issue, a session per worktree, several tagged against the same repo at once. Nothing stops two of them from editing the same file at the same time. The usual fix is a single-agent context problem solved well (better retrieval, smaller token footprint, richer local understanding). This is the other half: coordination *between* agents, not comprehension *within* one.

## What it is

**Enforcement (automatic):** a `PreToolUse` hook fires before every `Edit` / `MultiEdit` / `Write` / `NotebookEdit`. If the target file is claimed by a different session, the hook denies the tool call with a reason instead of letting the edit happen. If the file is unclaimed, the hook auto-claims it for the calling session — coordination doesn't depend on the model remembering to call anything first.

**Tools (explicit, for planning and visibility):**

- **`claim(issue_id, file_paths, session_id)`** — reserve files ahead of time, e.g. before a multi-file refactor, so a conflict shows up before you start rather than mid-edit.
- **`release(issue_id, session_id)`** — free claims early, on completion or handoff, instead of waiting out the TTL.
- **`check(file_path)`** — ask if a file is currently claimed.
- **`status()`** — a fleet-wide snapshot: which sessions are on which issues and files right now.

## Design

**Locking is local.** Claims live in a SQLite file at `~/.scoped/claims.db` (`node:sqlite`, no extra dependency). A unique index on `file_path` makes claim/conflict detection atomic — two sessions racing to claim the same file get one winner, not two.

**Visibility is Linear, and it's separate from the lock.** If `LINEAR_API_KEY` is set, explicit `claim`/`release` calls post as comments on the issue — for humans watching the fleet, not for the lock itself. Linear is a network call with real latency and no compare-and-swap; it's the wrong place to put the thing that has to be fast and atomic. The hook's auto-claims stay local-only and silent — commenting on every keystroke would be noise, not visibility.

**One identity, two entry points — this is the part that actually had to be solved.** The hook and the MCP server are separate OS processes, and Claude Code doesn't hand an MCP subprocess any session identifier that matches what a hook receives. Left alone, that means an agent that explicitly pre-claims a file via the `claim` tool (forced to invent its own random ID) would then get blocked by its own hook the moment it tried to edit that file — the hook would see a different owner and treat the agent as a stranger to its own claim. Fixed by:
- a `SessionStart` hook that injects Claude Code's real `session_id` into context at the start of every session, and
- making `session_id` a required argument on `claim`/`release`, so an explicit claim and the hook's automatic enforcement always resolve to the same owner.

**Stale claims self-heal, but the failure modes differ by origin.** Every read reaps dead claims first. A claim made through the long-lived MCP server tracks its process's pid — if that process is gone (same host), the claim is dead immediately, no TTL wait. A claim made by the hook can't do that: the hook is a short-lived script that exits right after every single call, so its own pid is *never* alive by the time the next check runs — storing it would mean every hook-made claim gets reaped on the next edit. Hook claims skip pid tracking and rely on TTL instead (4h default), refreshed every time the owning session keeps editing that file, so an active session's claim doesn't expire mid-work while an abandoned one still ages out.

**Enforcement is real, but not absolute.** The hook only sees `Edit`/`MultiEdit`/`Write`/`NotebookEdit` — it can't stop an edit made by a tool it doesn't watch, or by a process outside Claude Code entirely. What it does guarantee: no Claude Code session in the fleet can silently stomp a file another session is actively claiming through the normal edit tools.

## Setup

```bash
npm install
```

**1. MCP server** — add to your MCP config (e.g. `.claude/settings.json` or your client's `mcpServers` block):

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

**2. Hooks** — register both in the *global* `~/.claude/settings.json` (not a per-project one), since the whole point is coordination across repos and worktrees, not just within one:

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

Optionally set `SCOPED_ISSUE_ID` (e.g. `ENG-123`) in a session's environment before launching it, so the hook's auto-claims group under the real issue instead of a synthetic `adhoc:<session>` bucket.

**Performance note:** the hook adds one Node process start (roughly tens of milliseconds) to every Edit/Write/NotebookEdit call. Measured against 500 concurrent claims in the table, `check()` (which reaps first) averages ~0.2ms — the cost is process startup, not the lock. Worth it for correctness on a shared codebase — mention it if it ever feels laggy on an unusually edit-heavy loop.

**Fails open:** any internal error in the enforcement hook (corrupt DB, unexpected input) allows the edit through rather than blocking real work over a coordination-layer bug. Errors go to stderr only, never to the model as a false denial.

## Status

v0.2 — core locking and PreToolUse enforcement are implemented and tested: claim, conflict, idempotent re-claim, TTL expiry, dead-pid reaping (MCP-side), TTL-only reaping (hook-side), cross-entry-point identity (an explicit pre-claim doesn't self-block the hook), and correct deny/allow/auto-claim/touch behavior for the hook itself. The claim insert is a single `INSERT ... ON CONFLICT DO NOTHING`, verified atomic under real concurrent OS processes racing on the same file (6 parallel hook invocations on one path: exactly 1 allowed, 5 denied). Not yet run against a real multi-session fleet long enough to report a collision-prevented count — that number will go here once it's real, not invented.

## License

MIT

# scoped

An MCP coordination layer for concurrent Claude Code fleets. 240 lines, two dependencies, one local SQLite file — `claim`, `release`, and `check` give a fleet of agent sessions a way to ask "is someone already on this file?" before two of them collide on it.

## The problem

Running more than one Claude Code session against the same codebase is now normal — a session per Linear issue, a session per worktree, several tagged against the same repo at once. Nothing stops two of them from editing the same file at the same time. The usual fix is a single-agent context problem solved well (better retrieval, smaller token footprint, richer local understanding). This is the other half: coordination *between* agents, not comprehension *within* one.

## What it is

An MCP server exposing four tools:

- **`claim(issue_id, file_paths)`** — register intent to edit files, scoped to a Linear issue. Returns which files were claimed and which are already held by another session.
- **`release(issue_id)`** — release claims when work is done or handed off.
- **`check(file_path)`** — ask if a file is currently claimed, before touching it.
- **`status()`** — a fleet-wide snapshot: which sessions are on which issues and files right now.

## Design

Locking and visibility are two different jobs, so they're split:

- **Locking is local.** Claims live in a SQLite file at `~/.scoped/claims.db` (`node:sqlite`, no extra dependency). A unique index on `file_path` makes claim/conflict detection atomic — two sessions racing to claim the same file get one winner, not two. This is what makes `check()` an honest answer instead of a best-effort guess.
- **Visibility is Linear, and it's advisory.** If `LINEAR_API_KEY` is set, claims and releases post as comments on the issue — for humans watching the fleet, not for the lock itself. Linear is a network call with real latency and no compare-and-swap; it's the wrong place to put the thing that has to be fast and atomic.
- **Stale claims self-heal.** Every read reaps dead claims first: expired by TTL (4h default), or — for claims made on the same host — a claim whose owning process no longer exists. A crashed session doesn't hold a lock forever.
- **It's advisory, not enforced.** Nothing stops an agent that skips `check()` from editing a claimed file anyway. `scoped` tells you when something *should* wait; it doesn't block the edit. A `PreToolUse` hook on Edit/Write that calls `check()` automatically is the natural next step toward real enforcement — not built yet.

## Setup

```bash
npm install
```

Add to your MCP config (e.g. `.claude/settings.json` or your client's `mcpServers` block):

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

Each server process gets its own session id (random, or set `SCOPED_SESSION_ID` explicitly) — that's how `scoped` tells sessions apart.

## Status

v0.1 — core locking is implemented and tested (claim, conflict, idempotent re-claim, TTL expiry, dead-pid reaping). Not yet run against a real multi-session fleet long enough to report a collision-prevented count — that number will go here once it's real, not invented.

## License

MIT

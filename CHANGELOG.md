# Changelog

## v0.3.0

- Now a Claude Code plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json` (SessionStart and PreToolUse), and `.mcp.json` starting the server through `bin/scoped-mcp`, which installs dependencies on first start.
- `test/plugin.test.mjs` keeps the manifest, package and server versions equal and checks each hook target exists.
- SECURITY.md; CI validates the plugin manifest.

## v0.2.2

- Fixed: concurrent hook processes could let more than one session edit the same file. The store opened SQLite with no busy timeout, so racing writers got `database is locked` and the hook failed open; and the hook ran `check()` then `claim()` and ignored the claim result, so two sessions could both see the file as unclaimed and both be allowed. The store now sets `PRAGMA busy_timeout = 5000`, and the hook claims first and denies on conflict.
- Added `test/concurrency.test.mjs` (multiple OS processes racing `claim()` on one SQLite file) and a multi-process hook race test in `test/hook.test.mjs`. Both fail against the previous code.
- Renamed the old single-connection "concurrent claims" store test to say what it does: sequential claims on one connection.

## v0.2.1

- Audited `src/linear.mjs`'s `commentCreate` call: confirmed against Linear's GraphQL schema that `CommentCreateInput.issueId` accepts either a UUID or a human-readable issue identifier (e.g. `ENG-123`), so passing the identifier through untouched is correct — no fix needed, documented in code.
- Added test coverage (`test/linear.test.mjs`) for the Linear notify request-building logic, mocking `fetch` — covers enabled/disabled gating, request shape, identifier pass-through, and non-fatal error handling.

## v0.2.0

- Real `PreToolUse` enforcement: auto-claims unclaimed files, denies edits from a conflicting session.
- Fixed claim-race and reap-scan bugs from the initial scaffold.
- One-command `npm run setup` / `npm run uninstall` (`scripts/install.mjs`, `scripts/uninstall.mjs`).
- Test suite (`test/`) covering claim/conflict/idempotent re-claim, TTL expiry, dead-pid reaping, cross-entry-point identity, and hook deny/allow/auto-claim/touch behavior, running under CI on every push and PR.

## v0.1.0

- Initial scaffold: MCP `claim`/`release`/`check`/`status` tools backed by local SQLite (`node:sqlite`).
- Optional async Linear visibility comments on `claim`/`release`.

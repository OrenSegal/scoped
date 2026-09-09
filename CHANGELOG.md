# Changelog

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

# Changelog

## v0.2.0

- Real `PreToolUse` enforcement: auto-claims unclaimed files, denies edits from a conflicting session.
- Fixed claim-race and reap-scan bugs from the initial scaffold.
- One-command `npm run setup` / `npm run uninstall` (`scripts/install.mjs`, `scripts/uninstall.mjs`).
- Test suite (`test/`) covering claim/conflict/idempotent re-claim, TTL expiry, dead-pid reaping, cross-entry-point identity, and hook deny/allow/auto-claim/touch behavior, running under CI on every push and PR.

## v0.1.0

- Initial scaffold: MCP `claim`/`release`/`check`/`status` tools backed by local SQLite (`node:sqlite`).
- Optional async Linear visibility comments on `claim`/`release`.

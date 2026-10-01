# Changelog

## v0.4.0

- MCP server: probes node:sqlite before loading anything and exits with one sentence on an old Node; opens the claims db lazily so an unusable db is an `isError` tool result instead of a dead server; validates `session_id`/`issue_id`, caps `file_paths` at 200 and `ttl_seconds` at 7 days; nothing but JSON-RPC on stdout (tested).
- Plugin launcher rewritten in Node (`src/launcher.mjs`; `.mcp.json` now runs `node bin/scoped-mcp`). It used to run `npm ci` inside the plugin directory, which fails on a read-only checkout, is lost on every plugin update, runs package install scripts, races when two sessions start at once, and could leave a half-installed `node_modules` that it then never repaired. Dependencies now go to `${CLAUDE_PLUGIN_DATA}/deps/<lockfile hash>/` (fallback `~/.scoped/deps`), installed with `--ignore-scripts` in a temp dir and renamed into place; npm missing, offline or failing is one sentence on stderr, never on stdout.
- `npm run setup` refuses when scoped is already a plugin (`installed_plugins.json` or `enabledPlugins`; `--force` overrides), and skips a hook already registered in any user/project/local settings file, from any checkout path. It used to match only its own exact command string, so a plugin install or a moved checkout got every hook twice. Hook paths are now quoted (a checkout path with a space broke the old unquoted command), entries carry `timeout: 15`, settings.json is written atomically, and the MCP server is registered through the launcher. `uninstall` removes both the quoted and the old unquoted form.
- A hook registered twice logs a denied edit once.
- `scoped` CLI (`bin/scoped`, on the Bash tool's PATH while the plugin is enabled): `status [--json]`, `check <file>`, `release <session|prefix>` (the 8-char prefix every deny message now prints), `gc`, `report [--days=N]` over the block log, and `doctor` (Node and node:sqlite, db writable and schema, each hook and the MCP server registered exactly once across plugin and user/project/local settings, MCP `initialize` + `tools/list` round trip, PreToolUse latency against `SCOPED_HOOK_MS`). The package's `scoped` bin used to start the MCP server; that is now `scoped-mcp`.
- Slash commands `/scoped:status`, `/scoped:release`, `/scoped:doctor`, `/scoped:report`.
- Linear: comments name files relative to the session's working directory (`…/<basename>` outside it) and only the first 8 characters of the session id; inline code is escaped; 10 s request timeout; ids that are not Linear issues (`adhoc:` buckets) are never posted.

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

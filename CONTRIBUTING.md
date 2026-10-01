# Contributing

## Setup

```bash
git clone https://github.com/OrenSegal/scoped.git
cd scoped
npm install
```

Requires Node.js ≥22.13 (or ≥23.4 on the odd-numbered line) — the version `node:sqlite` stopped requiring `--experimental-sqlite`.

## Running tests

```bash
npm test
```

`npm test` runs `node --test "test/*.test.mjs"` (helpers such as `test/mcp-client.mjs` are not test files). Tests cover `ClaimStore` (`src/store.mjs`) directly, and the hooks, MCP server, launcher, CLI and setup script as subprocesses with `HOME`, `SCOPED_HOME` and `CLAUDE_CONFIG_DIR` pointed at temp directories, so each test gets an isolated `claims.db` and nothing reads or writes your own `~/.claude`. Keep it that way in new tests. `SCOPED_NETWORK_TESTS=1` also runs the one test that installs from the npm registry. No mocking of SQLite or the filesystem — the point of this project is atomic, cross-process locking, and that only means something if the tests exercise the real thing.

## Making changes

- Keep `claim()`'s insert atomic (`ON CONFLICT DO NOTHING`) — this is the property the whole coordination layer depends on. If you touch `src/store.mjs`, add or update a test that would fail without your change.
- The hook (`hooks/pretool-enforce.mjs`) fails open by default: an internal error allows the edit, warns the user once per session with a `systemMessage`, and goes to stderr. `SCOPED_FAIL_CLOSED=1` denies instead. Every error path goes through `failed()`; keep it that way, and never let a coordination bug show up as a silent allow or as a deny that blames another session.
- Nothing but JSON-RPC may reach the MCP server's stdout, and nothing but the hook's JSON may reach a hook's stdout. Logs go to stderr. `test/mcp.test.mjs` checks the server.
- Entry points (hooks, `bin/scoped`, `bin/scoped-mcp`) must not import `node:sqlite` statically: they check it first so an old Node gets a sentence, not a stack trace.
- A schema change bumps `SCHEMA_VERSION` in `src/store.mjs` and adds a migration step; an existing db must open without losing claims.
- Linear visibility (`src/linear.mjs`) is best-effort and must never sit on the locking critical path — no `await` on `notify()` from `claim`/`release`/`check`.

## Evals

`evals/` is a `claude plugin eval` suite. Runs cost model usage, so CI only checks its format (`test/plugin.test.mjs`). Run it before changing the deny message, the slash commands or the CLI output: `claude plugin eval . --allow-tools Bash`.

## Pull requests

Open against `main`. Describe the problem, not just the change — this project is small enough that a one-line "why" saves more review time than a long diff explanation.

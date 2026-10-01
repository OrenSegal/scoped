# Contributing

```bash
git clone https://github.com/OrenSegal/scoped.git
cd scoped
npm install
npm test
```

The minimum Node version is `engines.node` in `package.json`.

## Tests

Write a failing test before changing behavior. Tests run `ClaimStore` against a temp SQLite file, and the hooks, MCP server, launcher, CLI and setup script as subprocesses with `HOME`, `SCOPED_HOME` and `CLAUDE_CONFIG_DIR` pointed at temp directories; new tests must not touch your own `~/.claude` or `~/.scoped`. Don't mock SQLite or the filesystem: the project is cross-process locking, and only the real thing tests that. `SCOPED_NETWORK_TESTS=1` also runs the one test that installs from the npm registry.

## Rules the code depends on

- `claim()` stays one atomic insert (`ON CONFLICT DO NOTHING`) inside a write transaction.
- Every hook error goes through `failed()` in `hooks/pretool-enforce.mjs`: fail open with a visible warning, or deny under `SCOPED_FAIL_CLOSED=1`. Never a silent allow, never a deny that blames another session.
- Only JSON-RPC on the MCP server's stdout, only the hook's JSON on a hook's stdout. Logs go to stderr.
- Entry points (hooks, `bin/scoped`, `bin/scoped-mcp`) never import `node:sqlite` statically, so an old Node gets a sentence, not a stack trace.
- A schema change bumps `SCHEMA_VERSION` in `src/store.mjs` and adds a migration; existing claims survive it.
- Linear (`src/linear.mjs`) is never awaited on the locking path.
- The version lives only in `package.json`, and every environment variable the code reads is in README's Configuration table; `test/plugin.test.mjs` checks both.

## Evals

`evals/` is a `claude plugin eval` suite. Runs cost model usage, so CI checks only its format. Run it before changing the deny message, slash commands or CLI output: `claude plugin eval . --allow-tools Bash`.

## Pull requests

Open against `main` and say what problem the change solves.

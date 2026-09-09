# Contributing

## Setup

```bash
git clone https://github.com/OrenSegal/scoped.git
cd scoped
npm install
```

Requires Node.js ≥22.5 (for the built-in `node:sqlite`).

## Running tests

```bash
npm test
```

Tests cover `ClaimStore` (`src/store.mjs`) directly, and the `PreToolUse` hook (`hooks/pretool-enforce.mjs`) as a subprocess with `$HOME` pointed at a temp directory, so each test gets an isolated `claims.db`. No mocking of SQLite or the filesystem — the point of this project is atomic, cross-process locking, and that only means something if the tests exercise the real thing.

## Making changes

- Keep `claim()`'s insert atomic (`ON CONFLICT DO NOTHING`) — this is the property the whole coordination layer depends on. If you touch `src/store.mjs`, add or update a test that would fail without your change.
- The hook (`hooks/pretool-enforce.mjs`) must fail open: any internal error should allow the edit through, never block on a coordination-layer bug. Preserve that in `try`/`finally` and the top-level `.catch`.
- Linear visibility (`src/linear.mjs`) is best-effort and must never sit on the locking critical path — no `await` on `notify()` from `claim`/`release`/`check`.

## Pull requests

Open against `main`. Describe the problem, not just the change — this project is small enough that a one-line "why" saves more review time than a long diff explanation.

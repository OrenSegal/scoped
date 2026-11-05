# A concurrency test on one connection can't find a race

scoped keeps parallel Claude Code sessions from editing the same file. Claims live in a SQLite table with `file_path` as the primary key, and a `PreToolUse` hook claims a file before every edit.

The README said the claim was atomic under concurrent processes. The only test with "concurrent" in its name ran six claims in a loop on one connection. That test passes whether or not there's a race, because a single connection never races itself.

I added a test that starts real OS processes, each with its own connection to the same database file, waits on a start signal, and has all of them claim the same path at once:

- 8 processes calling `claim()`, 20 rounds: expect exactly 1 winner and 7 conflicts per round, and no thrown errors.
- 6 hook processes from different sessions, 15 rounds: expect exactly 1 edit allowed and 5 denied.

On the code as it was, 20 of 30 hook-race rounds allowed more than one session. Two bugs, both invisible to the single-connection test:

1. **No busy timeout.** SQLite's default is to fail immediately with `database is locked` when another writer holds the lock, rather than wait. The hook fails open on errors (a broken coordination layer shouldn't block real work), so every locked-out session was allowed to edit. The fix is one line: `PRAGMA busy_timeout = 5000`.
2. **Check, then insert, ignoring the insert's result.** The hook called `check()`, saw the file unclaimed, then called `claim()` and allowed the edit without looking at what `claim()` returned. Two sessions could both see "unclaimed" and both be allowed, even though only one insert won. The fix: claim first, and act on the claim's result.

To make sure the new tests catch the old bugs rather than just pass on the new code, I ran them against the broken versions: the hook race test failed 10 of 10 runs against the old hook, and 10 of 10 against the new hook with the busy timeout removed.

What I took from it: a green concurrency test tells you nothing until you've seen it fail on the code it's meant to catch. And "fails open" turns every error into an allow, so errors under load need their own test.

Fix: [scoped#1](https://github.com/OrenSegal/scoped/pull/1). Written with Claude Code; I checked the numbers against the PR.

---
description: Release every file claim a session holds (default this session)
argument-hint: "[session id or 8-char prefix]"
allowed-tools: Bash(scoped release:*), Bash(scoped status:*)
---

If `$ARGUMENTS` is empty, release this session's own claims: run
`scoped release <your scoped session_id>` with the id given to you at session start.

If `$ARGUMENTS` names another session, that session may still be editing those files.
Run `scoped status` first, show the user that session's claims, and run
`scoped release $ARGUMENTS` only after the user confirms it is finished or abandoned.

Report what was released.

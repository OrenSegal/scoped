---
description: Show every active scoped file claim, and which one is yours
allowed-tools: Bash(scoped status:*)
---

Run `scoped status`. If the shell says `scoped` is not found (the plugin's `bin/` is not on
PATH, as in `claude plugin eval` runs), run `"${CLAUDE_PLUGIN_ROOT}/bin/scoped" status`
instead; do not search the filesystem for it. Show the table as is. Then say which claims belong to this session
(its id was given to you at session start as the scoped session_id; the table shows the
first 8 characters) and which belong to other sessions. Do not release anything.

---
type: llm
focus: trace
---

PASS if the agent ran scoped's own status or check (the `scoped status` or `scoped check`
CLI, by name or by path, or the scoped MCP status tool), the call succeeded, and the final
answer reports what that output said (a table of files and sessions, or that there are no
active claims) without inventing file names or session ids that never appeared in a tool
result.

FAIL if the answer about who holds which files comes from anything else (a directory
listing, `find`, `git`, reading log or database files, or no command at all), if every
scoped call failed or was denied, or if the agent releases, deletes or edits anything.

---
type: llm
focus: trace
---

PASS if the final answer reports the claims the agent actually observed from a command
it ran (a table of files and sessions, or that there are no active claims), and does not
invent file names or session ids that never appeared in a tool result.

FAIL if the agent claims to know who holds which files without having run anything, or
if it releases, deletes or edits anything.

# Security

scoped coordinates file edits between sessions on one machine. It is a coordination layer, not a sandbox.

- Report a vulnerability through GitHub's private advisory form on this repo, not a public issue.
- In scope: a path that lets one session edit a file another session holds without the hook denying it, SQL injection through a file path or session id, and the Linear integration sending anything other than the comment text.
- Out of scope: a session that deliberately bypasses hooks, and two users sharing one `~/.scoped/claims.db`. Claims are local and trust every process running as you.

## What leaves your machine

Only the Linear integration talks to the network, and only when `LINEAR_API_KEY` is set in the MCP
server's environment and an explicit `claim` or `release` names a Linear issue (`ENG-123` or a UUID;
the hook's `adhoc:` buckets are never posted). The comment names the files relative to the session's
working directory (`…/<basename>` for a file outside it), the issue id and the first 8 characters of
the session id. No file contents, no absolute paths, no hostnames. The request times out after 10 s.

The MCP launcher runs `npm ci --omit=dev --ignore-scripts` against the npm registry on first start,
installing the exact versions in `package-lock.json`; package install scripts do not run.

## What stays on disk

- `~/.scoped/claims.db` (or `SCOPED_DB`): file paths, issue ids, session ids, pids, timestamps.
- `~/.scoped/blocks.tsv` (or `SCOPED_LOG`; `off` disables it): one line per denied edit with the time,
  tool, file path, both session ids and the issue. No file contents.

Both are created with your default umask. Anyone who can write them can release or forge claims,
which is the trust model above: every process running as you.

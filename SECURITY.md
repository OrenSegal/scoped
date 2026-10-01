# Security

scoped coordinates file edits between sessions on one machine. It is a coordination layer, not a sandbox.

- Report a vulnerability through GitHub's private advisory form on this repo, not a public issue.
- In scope: a path that lets one session edit a file another session holds without the hook denying it, SQL injection through a file path or session id, and the Linear integration sending anything other than the comment text.
- Out of scope: a session that deliberately bypasses hooks, and two users sharing one `~/.scoped/claims.db`. Claims are local and trust every process running as you.

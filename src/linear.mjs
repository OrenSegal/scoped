// Optional, async, best-effort visibility layer. Never on the locking critical path:
// claim()/release()/check() must stay correct and fast even if Linear is down, rate-limited,
// or LINEAR_API_KEY is unset. Failures here are swallowed and logged to stderr only.
//
// What leaves the machine is exactly one GraphQL mutation: the issue identifier and a comment
// body. The body names files relative to the session's working directory (a file outside it
// shows only as `…/<basename>`, so home-directory layouts and usernames are not posted) and the
// first 8 characters of the session id. No file contents, no environment, no hostname.

import path from "node:path";

const LINEAR_API = "https://api.linear.app/graphql";
const TIMEOUT_MS = 10_000;
// Team-key identifiers (ENG-123) or issue UUIDs. Anything else (the hook's `adhoc:` buckets,
// free-form ids) is not a Linear issue, and posting it would only produce an API error.
const LINEAR_ID_RE = /^(?:[A-Za-z][A-Za-z0-9_]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function enabled() {
  return Boolean(process.env.LINEAR_API_KEY);
}

async function graphql(query, variables) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Markdown-safe inline code: no backticks to close the span, no newlines to start a block.
const code = (s) => "`" + String(s).replace(/`/g, "'").replace(/[\u0000-\u001f\u007f]/g, " ") + "`";

function shown(file, cwd) {
  if (cwd) {
    const rel = path.relative(cwd, file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return `…/${path.basename(file)}`;
}

// Fire-and-forget: posts a comment on the issue noting the claim/release. Does not block or throw.
// issueId is passed through as whatever identifier the caller used (e.g. "ENG-123"), not resolved
// to a UUID — Linear's CommentCreateInput.issueId field accepts either form interchangeably, per
// its GraphQL schema description ("Can be a UUID or issue identifier (e.g., 'LIN-123')").
export function notify(issueId, action, filePaths, sessionId, cwd) {
  if (!enabled() || !LINEAR_ID_RE.test(String(issueId))) return;
  const verb = action === "claim" ? "claimed" : "released";
  const body =
    `🔒 scoped: session ${code(String(sessionId).slice(0, 8))} ${verb} ${filePaths.length} file(s)\n` +
    filePaths.map((f) => `- ${code(shown(f, cwd))}`).join("\n");
  graphql(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body }
  ).catch((err) => {
    console.error(`[scoped] Linear notify failed (non-fatal): ${err.message}`);
  });
}

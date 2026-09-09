// Optional, async, best-effort visibility layer. Never on the locking critical path:
// claim()/release()/check() must stay correct and fast even if Linear is down, rate-limited,
// or LINEAR_API_KEY is unset. Failures here are swallowed and logged to stderr only.

const LINEAR_API = "https://api.linear.app/graphql";
const LABELS = { claimed: "agent-claimed", released: "agent-released" };

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
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Fire-and-forget: posts a comment on the issue noting the claim/release. Does not block or throw.
export function notify(issueId, action, filePaths, sessionId) {
  if (!enabled()) return;
  const verb = action === "claim" ? "claimed" : "released";
  const body = `🔒 scoped: session \`${sessionId}\` ${verb} ${filePaths.length} file(s)\n${filePaths.map((f) => `- \`${f}\``).join("\n")}`;
  graphql(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body }
  ).catch((err) => {
    console.error(`[scoped] Linear notify failed (non-fatal): ${err.message}`);
  });
}

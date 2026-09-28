#!/usr/bin/env node
// PreToolUse hook — the real enforcement point. Fires before Edit/Write/NotebookEdit actually
// touch a file. If another session holds an active claim on that file, deny the tool call
// outright (the model sees the reason and can go coordinate, instead of silently colliding).
// If the file is unclaimed, auto-claim it for this session — so enforcement doesn't depend on
// the model remembering to call scoped's `claim` tool first.
//
// Fails open: any internal error here (corrupt DB, unexpected input) allows the edit through
// rather than blocking real work over a coordination-layer bug. Errors go to stderr only.

import { ClaimStore } from "../src/store.mjs";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  const { session_id, tool_name, tool_input, cwd } = JSON.parse(input);

  if (!EDIT_TOOLS.has(tool_name)) return; // matcher already restricts this, but stay safe if misconfigured
  const filePath = tool_input?.file_path ?? tool_input?.notebook_path;
  if (!filePath || !session_id) return;

  const store = new ClaimStore();
  try {
    // Claim first and act on the result. A separate check() followed by claim() lets two hook
    // processes both see "unclaimed" and both allow the edit, even though only one of their
    // inserts wins. claim() is a single atomic insert, so its result is the real answer.
    // No SCOPED_ISSUE_ID set means we don't know which Linear issue this belongs to, so group
    // it under a synthetic per-session bucket rather than block on missing issue context.
    const issueId = process.env.SCOPED_ISSUE_ID || `adhoc:${session_id.slice(0, 8)}`;
    const result = store.claim(issueId, [filePath], session_id, undefined, cwd, null); // pid: null, this hook process won't outlive this call

    if (result.conflicts.length) {
      const holder = store.check(filePath, cwd) ?? { ...result.conflicts[0].held_by, claimed_at: Math.floor(Date.now() / 1000), ttl_seconds: 0 };
      const ageSeconds = Math.floor(Date.now() / 1000) - holder.claimed_at;
      const remaining = Math.max(0, holder.ttl_seconds - ageSeconds);
      deny(
        `scoped: ${filePath} is claimed by another session (issue ${holder.issue_id}, session ${holder.session_id.slice(0, 8)}), ` +
          `claimed ${ageSeconds}s ago, expires in ${remaining}s. Coordinate with that session or wait — ` +
          `don't force this edit through, that's the exact collision this hook exists to catch.`
      );
      return;
    }

    // Newly claimed, or already ours: bump claimed_at so an actively-worked file doesn't expire mid-session.
    store.touch(filePath, session_id, cwd);
    return; // allow, silent
  } finally {
    store.close();
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

main().catch((err) => {
  console.error(`[scoped] pretool-enforce failed open (non-fatal): ${err.stack}`);
});

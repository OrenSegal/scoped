#!/usr/bin/env node
// PreToolUse hook — the real enforcement point. Fires before Edit/Write/NotebookEdit actually
// touch a file. If another session holds an active claim on that file, deny the tool call
// outright (the model sees the reason and can go coordinate, instead of silently colliding).
// If the file is unclaimed, auto-claim it for this session — so enforcement doesn't depend on
// the model remembering to call scoped's `claim` tool first.
//
// Failure policy. Any internal error (no node:sqlite, corrupt or unwritable db, malformed
// input) fails OPEN by default: the edit goes through, because a coordination bug should not
// stop real work. It is never silent: the first failure in a session puts a systemMessage in
// front of the user, and every failure goes to stderr. SCOPED_FAIL_CLOSED=1 flips the policy
// to deny the edit instead, for fleets where an unchecked edit is worse than a stalled one.
//
// Nothing here imports node:sqlite statically: the store is loaded only after the runtime
// check, so an old Node produces a sentence, not ERR_UNKNOWN_BUILTIN_MODULE.

import { validIssueId, validSessionId } from "../src/config.mjs";
import { firstWithin, readStdin, sqliteProblem } from "../src/runtime.mjs";
import { appendBlock } from "../src/blocklog.mjs";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const FAIL_CLOSED = process.env.SCOPED_FAIL_CLOSED === "1";
let warnKey = "unknown-session";

async function main() {
  const { session_id, tool_name, tool_input, cwd } = JSON.parse(await readStdin()) ?? {};

  if (!EDIT_TOOLS.has(tool_name)) return; // matcher already restricts this, but stay safe if misconfigured
  // Edit, MultiEdit and Write name the target `file_path`; NotebookEdit names it `notebook_path`.
  const filePath = tool_input?.file_path ?? tool_input?.notebook_path;
  if (!filePath || !session_id) return; // not a Claude Code edit payload: nothing to enforce
  if (!validSessionId(session_id)) throw new Error("session_id is not a Claude Code session id; refusing to record it");
  warnKey = session_id;

  const problem = await sqliteProblem();
  if (problem) throw new Error(problem);
  const { ClaimStore } = await import("../src/store.mjs");

  const store = new ClaimStore();
  try {
    // Claim first and act on the result: claim() is atomic, a separate check() is not.
    // No SCOPED_ISSUE_ID means we don't know which Linear issue this belongs to, so group it
    // under a synthetic per-session bucket rather than block on missing issue context.
    const envIssue = process.env.SCOPED_ISSUE_ID;
    const issueId = envIssue && validIssueId(envIssue) ? envIssue : `adhoc:${session_id.slice(0, 8)}`;
    // pid: null — this hook process won't outlive this call. A re-claim by the owner restarts its TTL.
    const result = store.claim(issueId, [filePath], session_id, undefined, cwd, null);
    if (!result.conflicts.length) return; // newly claimed or already ours: allow, silently

    const { file_path, held_by } = result.conflicts[0];
    const holder = store.check(file_path) ?? { ...held_by, claimed_at: Math.floor(Date.now() / 1000), ttl_seconds: 0 };
    const ageSeconds = Math.floor(Date.now() / 1000) - holder.claimed_at;
    const remaining = Math.max(0, holder.ttl_seconds - ageSeconds);
    appendBlock({ tool: tool_name, file: file_path, requester: session_id, holder: holder.session_id, issue: holder.issue_id });
    deny(
      `scoped: ${file_path} is claimed by another session (issue ${holder.issue_id}, session ${holder.session_id.slice(0, 8)}), ` +
        `claimed ${ageSeconds}s ago, expires in ${remaining}s. Coordinate with that session or wait — ` +
        `don't force this edit through, that's the exact collision this hook exists to catch. ` +
        `A human can free it with \`scoped release ${holder.session_id.slice(0, 8)}\`.`
    );
  } finally {
    store.close();
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

function failed(err) {
  const reason = err?.message ?? String(err);
  const detail = process.env.SCOPED_DEBUG ? err?.stack ?? reason : reason;
  if (FAIL_CLOSED) {
    console.error(`[scoped] pretool-enforce failed closed: ${detail}`);
    deny(`scoped could not check this edit (${reason}), and SCOPED_FAIL_CLOSED=1 is set, so it is blocked. Run \`scoped doctor\`.`);
    return;
  }
  console.error(`[scoped] pretool-enforce failed open (non-fatal): ${detail}`);
  if (firstWithin(`failopen:${warnKey}`, 12 * 3600 * 1000)) {
    emit({ systemMessage: `scoped: edits in this session are NOT enforced (${reason.replace(/\.$/, "")}). Run \`scoped doctor\`.` });
  }
}

main().catch(failed);

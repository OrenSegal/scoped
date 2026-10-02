#!/usr/bin/env node
// SessionStart hook. Reads Claude Code's real session_id off stdin and injects it into the
// conversation's context, so the model can pass the exact same identity to scoped's MCP tools
// (claim/release) that pretool-enforce.mjs uses for automatic PreToolUse enforcement — without
// this, an explicit claim() and the hook's auto-claim would use different, unmatched identities
// and the hook would end up blocking a session from files it claimed itself.
//
// Idempotent per session: if scoped is registered twice (plugin and ~/.claude/settings.json),
// both copies fire for the same start; only the first injects. SessionStart also fires on
// resume, clear and compact, and each of those loses or replaces context, so the dedupe key
// includes `source` and a later event still re-injects.
//
// Also the one place a broken runtime can be reported before the first edit: if node:sqlite
// is missing, the user is told that edits won't be coordinated.

import { validSessionId } from "../src/config.mjs";
import { firstWithin, readStdin, sqliteProblem } from "../src/runtime.mjs";

let payload;
try {
  payload = JSON.parse(await readStdin());
} catch {
  process.exit(0); // malformed input — say nothing, don't block session start over it
}

const { session_id, source = "startup" } = payload ?? {};
if (!validSessionId(session_id)) {
  if (session_id) console.error("[scoped] session-start: session_id is not a Claude Code session id; not injecting it");
  process.exit(0);
}
if (!firstWithin(`session-start:${session_id}:${source}`, 60 * 1000)) process.exit(0);

const output = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext:
      `scoped session_id for this session: ${session_id}\n` +
      `If you call scoped's claim or release MCP tools, pass session_id="${session_id}" exactly — ` +
      `it must match what the PreToolUse hook uses for automatic enforcement, or your own claims ` +
      `will look like a conflict to your own edits.`,
  },
};

const problem = await sqliteProblem();
if (problem) output.systemMessage = `scoped: file claims are NOT enforced in this session. ${problem}`;

process.stdout.write(JSON.stringify(output));

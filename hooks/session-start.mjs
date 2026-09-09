#!/usr/bin/env node
// SessionStart hook. Reads Claude Code's real session_id off stdin and injects it into the
// conversation's context, so the model can pass the exact same identity to scoped's MCP tools
// (claim/release) that pretool-enforce.mjs uses for automatic PreToolUse enforcement — without
// this, an explicit claim() and the hook's auto-claim would use different, unmatched identities
// and the hook would end up blocking a session from files it claimed itself.

let input = "";
for await (const chunk of process.stdin) input += chunk;

let session_id;
try {
  ({ session_id } = JSON.parse(input));
} catch {
  process.exit(0); // malformed input — say nothing, don't block session start over it
}

if (!session_id) process.exit(0);

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

process.stdout.write(JSON.stringify(output));

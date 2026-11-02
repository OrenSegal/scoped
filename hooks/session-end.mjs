#!/usr/bin/env node
// SessionEnd hook. Frees every claim this session holds, so a hook claim (no live pid to watch)
// does not outlive the session by up to its TTL. Best effort: nothing here may disturb the end
// of a session, so every failure goes to stderr and exits 0. The TTL is the fallback, and also
// covers a session that dies without running this.

import { validSessionId } from "../src/config.mjs";
import { readStdin, sqliteProblem } from "../src/runtime.mjs";

try {
  const { session_id } = JSON.parse(await readStdin()) ?? {};
  if (!validSessionId(session_id)) throw new Error("session_id is not a Claude Code session id");
  const problem = await sqliteProblem();
  if (problem) throw new Error(problem);
  const { ClaimStore } = await import("../src/store.mjs");
  const store = new ClaimStore();
  try {
    store.endSession(session_id);
  } finally {
    store.close();
  }
} catch (err) {
  console.error(`[scoped] session-end: ${err?.message ?? err}; claims will expire by TTL`);
}

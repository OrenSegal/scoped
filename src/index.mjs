#!/usr/bin/env node
// scoped's MCP server (stdio). Started by bin/scoped-mcp through launcher.mjs, or directly from
// a checkout that has node_modules.
//
// stdout belongs to the JSON-RPC transport: every diagnostic goes to stderr. Startup order is
// chosen so that a broken environment produces one readable sentence instead of a stack trace
// or a dead server: node:sqlite is probed before anything imports it, and the claims db is
// opened on first use, so an unusable db turns into an isError tool result the model can read
// and relay, rather than a server Claude Code shows as "failed".

import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_TTL_SECONDS, ISSUE_ID_RE, MAX_TTL_SECONDS, SESSION_ID_RE, dbPath, version } from "./config.mjs";
import { sqliteProblem } from "./runtime.mjs";

const problem = await sqliteProblem();
if (problem) {
  console.error(`[scoped] MCP server not started: ${problem}`);
  process.exit(1);
}

const depsUrl = process.env.SCOPED_DEPS_DIR ? pathToFileURL(path.join(process.env.SCOPED_DEPS_DIR, "deps.mjs")).href : "./deps.mjs";
const { McpServer, StdioServerTransport, z } = await import(depsUrl);
const { ClaimStore } = await import("./store.mjs");
const { notify } = await import("./linear.mjs");

let store = null;
function openStore() {
  if (!store) {
    try {
      store = new ClaimStore();
    } catch (err) {
      throw new Error(`scoped cannot open its claims db at ${dbPath()}: ${err.message}. Run \`scoped doctor\`.`);
    }
  }
  return store;
}

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// Every handler goes through this: a thrown error becomes a tool result with isError set,
// which the model sees, instead of a JSON-RPC error that some clients surface as a crash.
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    console.error(`[scoped] tool failed: ${process.env.SCOPED_DEBUG ? err.stack : err.message}`);
    return { isError: true, content: [{ type: "text", text: err.message }] };
  }
};

// There is no session identity Claude Code hands an MCP server subprocess (no shared env var
// with the session_id a hook receives), so this server can't invent one that would agree with
// the PreToolUse hook's enforcement. Instead, session_id is a required argument on every call —
// scoped's SessionStart hook injects the real value into context at session start, and the
// model is told to pass it through, so explicit claims here and automatic hook enforcement
// resolve to the same owner for the same session.
const SESSION_ID_SCHEMA = z
  .string()
  .regex(SESSION_ID_RE, "not a Claude Code session id")
  .describe("The scoped session_id given to you in context at session start (from scoped's SessionStart hook). Required so this claim matches the PreToolUse hook's enforcement for your session.");
const ISSUE_ID_SCHEMA = z.string().regex(ISSUE_ID_RE, "not an issue identifier");
const FILE_PATH_SCHEMA = z.string().min(1).max(4096);

const server = new McpServer({ name: "scoped", version: version() });

server.tool(
  "claim",
  "Register intent to edit one or more files, scoped to a Linear issue id. Call this BEFORE editing files you " +
    "haven't touched yet in this session — the PreToolUse hook auto-claims files as you edit them, so this is " +
    "mainly for reserving files ahead of time (e.g. before a multi-file refactor) or to check for conflicts early. " +
    "Returns which files were claimed and which are already held by another session — treat conflicts as " +
    "a signal to coordinate with that session, not to force through.",
  {
    issue_id: ISSUE_ID_SCHEMA.describe("Linear issue identifier (e.g. ENG-123) this work belongs to"),
    file_paths: z.array(FILE_PATH_SCHEMA).min(1).max(200).describe("Absolute or repo-relative file paths to claim"),
    session_id: SESSION_ID_SCHEMA,
    ttl_seconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional().describe(`Override the default ${DEFAULT_TTL_SECONDS / 3600}h claim expiry (max ${MAX_TTL_SECONDS / 86400} days)`),
  },
  safe(async ({ issue_id, file_paths, session_id, ttl_seconds }) => {
    const result = openStore().claim(issue_id, file_paths, session_id, ttl_seconds, process.cwd());
    if (result.claimed.length) notify(issue_id, "claim", result.claimed, session_id, process.cwd());
    return text(result);
  })
);

server.tool(
  "release",
  "Release claims held for a Linear issue id. Call this when the work is done, abandoned, or before handing off.",
  {
    issue_id: ISSUE_ID_SCHEMA.describe("Linear issue identifier whose claims should be released"),
    session_id: SESSION_ID_SCHEMA,
    all_sessions: z.boolean().optional().describe("If true, release every session's claims on this issue, not just yours (default: false — only release your own)"),
  },
  safe(async ({ issue_id, session_id, all_sessions }) => {
    const released = openStore().release(issue_id, all_sessions ? null : session_id);
    if (released.length) notify(issue_id, "release", released, session_id, process.cwd());
    return text({ released });
  })
);

server.tool(
  "check",
  "Check whether a file path is currently claimed by any session, before starting work on it.",
  {
    file_path: FILE_PATH_SCHEMA.describe("File path to check"),
  },
  safe(async ({ file_path }) => text({ file_path, claim: openStore().check(file_path, process.cwd()) }))
);

server.tool(
  "status",
  "Fleet-wide snapshot of every active claim — which sessions are on which issues and files. " +
    "Useful for a digest ('N agents active, collision avoided on X') or for a human deciding where to jump in.",
  {},
  safe(async () => {
    const claims = openStore().status();
    return text({ active_claims: claims.length, claims });
  })
);

function shutdown() {
  try {
    store?.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// When Claude Code closes stdin the event loop drains and the process exits on its own; an
// explicit exit there could drop a response still being written to a pipe.

await server.connect(new StdioServerTransport());

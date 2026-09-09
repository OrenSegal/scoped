#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClaimStore } from "./store.mjs";
import { notify } from "./linear.mjs";

const store = new ClaimStore();

// There is no session identity Claude Code hands an MCP server subprocess (no shared env var
// with the session_id a hook receives), so this server can't invent one that would agree with
// the PreToolUse hook's enforcement. Instead, session_id is a required argument on every call —
// scoped's SessionStart hook injects the real value into context at session start, and the
// model is told to pass it through, so explicit claims here and automatic hook enforcement
// resolve to the same owner for the same session.
const SESSION_ID_SCHEMA = z
  .string()
  .describe("The scoped session_id given to you in context at session start (from scoped's SessionStart hook). Required so this claim matches the PreToolUse hook's enforcement for your session.");

const server = new McpServer({
  name: "scoped",
  version: "0.2.1",
});

server.tool(
  "claim",
  "Register intent to edit one or more files, scoped to a Linear issue id. Call this BEFORE editing files you " +
    "haven't touched yet in this session — the PreToolUse hook auto-claims files as you edit them, so this is " +
    "mainly for reserving files ahead of time (e.g. before a multi-file refactor) or to check for conflicts early. " +
    "Returns which files were claimed and which are already held by another session — treat conflicts as " +
    "a signal to coordinate with that session, not to force through.",
  {
    issue_id: z.string().describe("Linear issue identifier (e.g. ENG-123) this work belongs to"),
    file_paths: z.array(z.string()).min(1).describe("Absolute or repo-relative file paths to claim"),
    session_id: SESSION_ID_SCHEMA,
    ttl_seconds: z.number().int().positive().optional().describe("Override the default 4h claim expiry"),
  },
  async ({ issue_id, file_paths, session_id, ttl_seconds }) => {
    const result = store.claim(issue_id, file_paths, session_id, ttl_seconds, process.cwd());
    if (result.claimed.length) notify(issue_id, "claim", result.claimed, session_id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "release",
  "Release claims held for a Linear issue id. Call this when the work is done, abandoned, or before handing off.",
  {
    issue_id: z.string().describe("Linear issue identifier whose claims should be released"),
    session_id: SESSION_ID_SCHEMA,
    all_sessions: z.boolean().optional().describe("If true, release every session's claims on this issue, not just yours (default: false — only release your own)"),
  },
  async ({ issue_id, session_id, all_sessions }) => {
    const released = store.release(issue_id, all_sessions ? null : session_id);
    if (released.length) notify(issue_id, "release", released, session_id);
    return { content: [{ type: "text", text: JSON.stringify({ released }, null, 2) }] };
  }
);

server.tool(
  "check",
  "Check whether a file path is currently claimed by any session, before starting work on it.",
  {
    file_path: z.string().describe("File path to check"),
  },
  async ({ file_path }) => {
    const claim = store.check(file_path, process.cwd());
    return { content: [{ type: "text", text: JSON.stringify({ file_path, claim }, null, 2) }] };
  }
);

server.tool(
  "status",
  "Fleet-wide snapshot of every active claim — which sessions are on which issues and files. " +
    "Useful for a digest ('N agents active, collision avoided on X') or for a human deciding where to jump in.",
  {},
  async () => {
    const claims = store.status();
    return { content: [{ type: "text", text: JSON.stringify({ active_claims: claims.length, claims }, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});

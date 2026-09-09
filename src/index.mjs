#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import { ClaimStore } from "./store.mjs";
import { notify } from "./linear.mjs";

// One session id per server process. A Claude Code session spawns one MCP server process,
// so this identifies "which agent" for the lifetime of that session.
const SESSION_ID = process.env.SCOPED_SESSION_ID ?? crypto.randomUUID().slice(0, 8);

const store = new ClaimStore();

const server = new McpServer({
  name: "scoped",
  version: "0.1.0",
});

server.tool(
  "claim",
  "Register intent to edit one or more files, scoped to a Linear issue id. Call this BEFORE editing. " +
    "Returns which files were claimed and which are already held by another session — treat conflicts as " +
    "a signal to coordinate with that session, not to force through.",
  {
    issue_id: z.string().describe("Linear issue identifier (e.g. ENG-123) this work belongs to"),
    file_paths: z.array(z.string()).min(1).describe("Absolute or repo-relative file paths to claim"),
    ttl_seconds: z.number().int().positive().optional().describe("Override the default 4h claim expiry"),
  },
  async ({ issue_id, file_paths, ttl_seconds }) => {
    const result = store.claim(issue_id, file_paths, SESSION_ID, ttl_seconds);
    if (result.claimed.length) notify(issue_id, "claim", result.claimed, SESSION_ID);
    return { content: [{ type: "text", text: JSON.stringify({ session_id: SESSION_ID, ...result }, null, 2) }] };
  }
);

server.tool(
  "release",
  "Release claims held for a Linear issue id. Call this when the work is done, abandoned, or before handing off.",
  {
    issue_id: z.string().describe("Linear issue identifier whose claims should be released"),
    session_only: z.boolean().optional().describe("If true, only release claims held by this session (default: release all claims on the issue)"),
  },
  async ({ issue_id, session_only }) => {
    const released = store.release(issue_id, session_only ? SESSION_ID : null);
    if (released.length) notify(issue_id, "release", released, SESSION_ID);
    return { content: [{ type: "text", text: JSON.stringify({ session_id: SESSION_ID, released }, null, 2) }] };
  }
);

server.tool(
  "check",
  "Check whether a file path is currently claimed by any session, before starting work on it.",
  {
    file_path: z.string().describe("File path to check"),
  },
  async ({ file_path }) => {
    const claim = store.check(file_path);
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
    return { content: [{ type: "text", text: JSON.stringify({ session_id: SESSION_ID, active_claims: claims.length, claims }, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});

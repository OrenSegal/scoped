// Locations, limits and identifier formats shared by the hooks, the MCP server and the CLI.
// No dependencies beyond node: builtins, and no node:sqlite, so every entry point can load
// this before it has checked that node:sqlite exists.

import os from "node:os";
import path from "node:path";

export const VERSION = "0.4.0";
export const MIN_NODE = "22.13.0";

// SCOPED_HOME moves everything scoped writes; SCOPED_DB and SCOPED_LOG move one file each.
export function dataDir() {
  return process.env.SCOPED_HOME || path.join(os.homedir(), ".scoped");
}

export function dbPath() {
  return process.env.SCOPED_DB || path.join(dataDir(), "claims.db");
}

// Append-only block log. SCOPED_LOG=off disables it.
export function blockLogPath() {
  const v = process.env.SCOPED_LOG;
  if (v === "off") return null;
  return v || path.join(dataDir(), "blocks.tsv");
}

export const DEFAULT_TTL_SECONDS = 4 * 60 * 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

// Claude Code session ids are UUIDs. Anything outside this charset can't have come from it,
// and is refused before it reaches the db or the model's context.
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Linear identifiers (ENG-123), UUIDs, and the hook's synthetic `adhoc:<session>` bucket.
export const ISSUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function validSessionId(s) {
  return typeof s === "string" && SESSION_ID_RE.test(s);
}

export function validIssueId(s) {
  return typeof s === "string" && ISSUE_ID_RE.test(s);
}

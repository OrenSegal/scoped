#!/usr/bin/env node
// Reverses install.mjs: removes scoped's MCP server registration and its two hook entries from
// the global ~/.claude/settings.json, leaving everything else in that file untouched.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const SESSION_START_PATH = path.join(REPO_ROOT, "hooks", "session-start.mjs");
const PRETOOL_PATH = path.join(REPO_ROOT, "hooks", "pretool-enforce.mjs");

function log(msg) {
  console.log(`[scoped uninstall] ${msg}`);
}

try {
  execFileSync("claude", ["mcp", "remove", "scoped", "--scope", "user"], { stdio: "inherit" });
  log("Removed MCP server 'scoped'.");
} catch (err) {
  log(`Couldn't remove MCP server via claude CLI (${err.message}) — remove it manually if still present.`);
}

if (!existsSync(SETTINGS_PATH)) {
  log(`${SETTINGS_PATH} doesn't exist — nothing to clean up there.`);
  process.exit(0);
}

const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
const sessionStartCmd = `node ${SESSION_START_PATH}`;
const pretoolCmd = `node ${PRETOOL_PATH}`;
let changed = false;

for (const [eventName, command] of [
  ["SessionStart", sessionStartCmd],
  ["PreToolUse", pretoolCmd],
]) {
  const groups = settings.hooks?.[eventName];
  if (!groups) continue;
  const before = groups.length;
  settings.hooks[eventName] = groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.command !== command) }))
    .filter((g) => g.hooks.length > 0);
  if (settings.hooks[eventName].length !== before) changed = true;
}

if (changed) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  log(`Removed scoped's hook entries from ${SETTINGS_PATH}.`);
} else {
  log("No scoped hook entries found — nothing to remove.");
}

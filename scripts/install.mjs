#!/usr/bin/env node
// One-command setup: registers the MCP server with Claude Code and adds scoped's two hooks
// to the global ~/.claude/settings.json. Safe to re-run — every step checks for an existing
// entry first and skips it rather than duplicating or clobbering unrelated config.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const INDEX_PATH = path.join(REPO_ROOT, "src", "index.mjs");
const SESSION_START_PATH = path.join(REPO_ROOT, "hooks", "session-start.mjs");
const PRETOOL_PATH = path.join(REPO_ROOT, "hooks", "pretool-enforce.mjs");

function log(msg) {
  console.log(`[scoped setup] ${msg}`);
}

function registerMcpServer() {
  let existing = "";
  try {
    existing = execFileSync("claude", ["mcp", "list"], { encoding: "utf8" });
  } catch (err) {
    log(`WARNING: couldn't run "claude mcp list" (${err.message}). Is the claude CLI on your PATH?`);
    log(`Skipping MCP registration — add it yourself per the README's manual Setup section.`);
    return;
  }

  if (/^scoped\b/m.test(existing)) {
    log("MCP server 'scoped' is already registered (scope: user) — skipping.");
    return;
  }

  const args = ["mcp", "add", "scoped", "--scope", "user", "--", "node", INDEX_PATH];
  execFileSync("claude", args, { stdio: "inherit" });
  log("Registered MCP server 'scoped' at user scope.");
}

function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) {
    mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    return {};
  }
  const raw = readFileSync(SETTINGS_PATH, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${SETTINGS_PATH} exists but isn't valid JSON (${err.message}). Fix or back it up before re-running setup.`
    );
  }
}

function hasScopedCommand(hookGroupArray, command) {
  return (hookGroupArray ?? []).some((group) => (group.hooks ?? []).some((h) => h.command === command));
}

function addHook(settings, eventName, command, matcher) {
  settings.hooks ??= {};
  settings.hooks[eventName] ??= [];

  if (hasScopedCommand(settings.hooks[eventName], command)) {
    log(`${eventName} hook already registered — skipping.`);
    return false;
  }

  const entry = { hooks: [{ type: "command", command }] };
  if (matcher) entry.matcher = matcher;
  settings.hooks[eventName].push(entry);
  log(`Added ${eventName} hook.`);
  return true;
}

function registerHooks() {
  const settings = loadSettings();
  const sessionStartCmd = `node ${SESSION_START_PATH}`;
  const pretoolCmd = `node ${PRETOOL_PATH}`;

  const changedA = addHook(settings, "SessionStart", sessionStartCmd);
  const changedB = addHook(settings, "PreToolUse", pretoolCmd, "Edit|MultiEdit|Write|NotebookEdit");

  if (changedA || changedB) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    log(`Wrote ${SETTINGS_PATH}`);
  }
}

log(`Repo root: ${REPO_ROOT}`);
registerMcpServer();
registerHooks();
log("Done. Restart any running Claude Code sessions to pick up the hooks and MCP server.");

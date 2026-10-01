#!/usr/bin/env node
// One-command setup without the plugin: registers the MCP server with Claude Code and adds
// scoped's two hooks to ~/.claude/settings.json. Safe to re-run.
//
// Refuses when scoped is already registered as a Claude Code plugin: the plugin brings the
// same hooks and MCP server, and both together fire every hook twice (`--force` overrides).
// Skips a hook when any settings file (user, project, local) already runs a scoped hook for
// that event, even from another checkout path, and says where it is.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_FILES, claudeDir, hookRegistrations, mcpRegistrations, pluginRegistrations } from "../src/registrations.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const SETTINGS_PATH = path.join(claudeDir(), "settings.json");
const LAUNCHER = path.join(REPO_ROOT, "bin", "scoped-mcp");
const CWD = process.env.INIT_CWD || process.cwd(); // npm runs scripts from the package root
const FORCE = process.argv.includes("--force");
const MATCHER = "Edit|MultiEdit|Write|NotebookEdit";

const log = (msg) => console.log(`[scoped setup] ${msg}`);

function refuseIfPlugin() {
  const plugins = pluginRegistrations(CWD);
  if (!plugins.length) return;
  const where = [...new Set(plugins.map((p) => `${p.id} (${p.kind}, ${p.scope})`))].join(", ");
  if (FORCE) {
    log(`WARNING: scoped is also a plugin here: ${where}. --force given, so continuing; every scoped hook will run twice.`);
    return;
  }
  console.error(
    `[scoped setup] scoped is already installed as a Claude Code plugin: ${where}.\n` +
      `The plugin registers the same hooks and MCP server, so setup would make every hook run twice.\n` +
      `Use the plugin (nothing else to do), or remove it first (\`claude plugin uninstall scoped\`), or pass --force.`
  );
  process.exit(1);
}

function registerMcpServer() {
  const all = mcpRegistrations(CWD);
  for (const m of all.filter((m) => m.pluginOnly)) {
    log(`WARNING: ${m.file} defines a 'scoped' server with \${CLAUDE_PLUGIN_ROOT}, which only resolves inside a plugin; it cannot start, so remove it.`);
  }
  const existing = all.filter((m) => !m.pluginOnly);
  if (existing.length) {
    log(`MCP server 'scoped' is already registered (${existing.map((e) => `${e.scope} in ${e.file}`).join(", ")}) — skipping.`);
    return;
  }
  let listed = "";
  try {
    listed = execFileSync("claude", ["mcp", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    log(`WARNING: couldn't run "claude mcp list" (${err.code || err.message}). Is the claude CLI on your PATH?`);
    log(`Skipping MCP registration — add it yourself: claude mcp add scoped --scope user -- node "${LAUNCHER}"`);
    return;
  }
  if (/^(plugin:scoped:)?scoped\b/m.test(listed)) {
    log("MCP server 'scoped' is already registered — skipping.");
    return;
  }
  execFileSync("claude", ["mcp", "add", "scoped", "--scope", "user", "--", "node", LAUNCHER], { stdio: "inherit" });
  log("Registered MCP server 'scoped' at user scope.");
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  const raw = fs.readFileSync(SETTINGS_PATH, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${SETTINGS_PATH} exists but isn't valid JSON (${err.message}). Fix or back it up before re-running setup.`);
  }
}

// Write via a temp file and rename, so an interrupted setup never leaves a truncated
// settings.json. Resolve symlinks first so a dotfiles-managed link stays a link.
function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const target = fs.existsSync(SETTINGS_PATH) ? fs.realpathSync(SETTINGS_PATH) : SETTINGS_PATH;
  const tmp = `${target}.scoped-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, target);
  log(`Wrote ${SETTINGS_PATH}`);
}

function registerHooks() {
  const settings = loadSettings();
  const existing = hookRegistrations(CWD);
  let changed = false;
  for (const [event, file] of Object.entries(HOOK_FILES)) {
    const already = existing.filter((h) => h.event === event);
    if (already.length) {
      log(`${event} hook already registered — skipping (${already.map((h) => `${h.scope}: ${h.command}`).join("; ")}).`);
      continue;
    }
    const entry = { hooks: [{ type: "command", command: `node "${path.join(REPO_ROOT, "hooks", file)}"`, timeout: 15 }] };
    if (event === "PreToolUse") entry.matcher = MATCHER;
    settings.hooks ??= {};
    (settings.hooks[event] ??= []).push(entry);
    log(`Added ${event} hook.`);
    changed = true;
  }
  if (changed) saveSettings(settings);
}

try {
  log(`Repo root: ${REPO_ROOT}`);
  refuseIfPlugin();
  registerMcpServer();
  registerHooks();
  log("Done. Restart any running Claude Code sessions to pick up the hooks and MCP server. Check with: scoped doctor");
} catch (err) {
  console.error(`[scoped setup] ${err.message}`);
  process.exit(1);
}

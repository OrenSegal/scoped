// Where scoped is registered with Claude Code, read straight from Claude Code's own files
// (read-only). Shared by scripts/install.mjs (to refuse a second registration),
// scripts/uninstall.mjs, and `scoped doctor` (to report "exactly once").
//
// scoped can be registered two ways, and both at once makes every hook fire twice:
//   - as a plugin: ~/.claude/plugins/installed_plugins.json and `enabledPlugins` in settings
//   - by `npm run setup`: hook commands in settings.json and an MCP server in ~/.claude.json

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOOK_FILES = { SessionStart: "session-start.mjs", PreToolUse: "pretool-enforce.mjs" };
const HOOK_RE = /[\\/]hooks[\\/](session-start|pretool-enforce)\.mjs\b/;

export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function settingsFiles(cwd = process.cwd(), dir = claudeDir()) {
  return [
    { scope: "user", file: path.join(dir, "settings.json") },
    { scope: "project", file: path.join(cwd, ".claude", "settings.json") },
    { scope: "local", file: path.join(cwd, ".claude", "settings.local.json") },
  ];
}

// Plugin installs and enables whose plugin name is `scoped`, from any marketplace.
export function pluginRegistrations(cwd = process.cwd(), dir = claudeDir()) {
  const found = [];
  const installed = readJson(path.join(dir, "plugins", "installed_plugins.json"));
  for (const [id, entries] of Object.entries(installed?.plugins ?? {})) {
    if (!id.startsWith("scoped@")) continue;
    for (const e of Array.isArray(entries) ? entries : [entries]) found.push({ id, kind: "installed", scope: e?.scope ?? "user", path: e?.installPath });
  }
  for (const { scope, file } of settingsFiles(cwd, dir)) {
    for (const [id, on] of Object.entries(readJson(file)?.enabledPlugins ?? {})) {
      if (id.startsWith("scoped@") && on) found.push({ id, kind: "enabled", scope, file });
    }
  }
  return found;
}

// scoped hook commands written into settings files (by setup, or by hand).
export function hookRegistrations(cwd = process.cwd(), dir = claudeDir()) {
  const found = [];
  for (const { scope, file } of settingsFiles(cwd, dir)) {
    const hooks = readJson(file)?.hooks ?? {};
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of g?.hooks ?? []) {
          const m = typeof h?.command === "string" && h.command.match(HOOK_RE);
          if (m) found.push({ event, script: `${m[1]}.mjs`, command: h.command, scope, file });
        }
      }
    }
  }
  return found;
}

// MCP servers named `scoped` outside the plugin: user and local scope live in ~/.claude.json,
// project scope in <cwd>/.mcp.json.
export function mcpRegistrations(cwd = process.cwd(), env = process.env) {
  const found = [];
  const cfgFile = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
  const cfg = readJson(cfgFile);
  if (cfg?.mcpServers?.scoped) found.push({ scope: "user", file: cfgFile, server: cfg.mcpServers.scoped });
  const local = cfg?.projects?.[cwd]?.mcpServers?.scoped;
  if (local) found.push({ scope: "local", file: cfgFile, server: local });
  const proj = readJson(path.join(cwd, ".mcp.json"))?.mcpServers?.scoped;
  if (proj) found.push({ scope: "project", file: path.join(cwd, ".mcp.json"), server: proj });
  return found;
}

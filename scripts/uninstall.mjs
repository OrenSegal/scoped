#!/usr/bin/env node
// Reverses install.mjs: removes scoped's MCP server registration and the hook entries that
// point at this checkout (quoted or the older unquoted form) from ~/.claude/settings.json,
// leaving everything else in that file untouched. A plugin install is not touched; remove
// that with `claude plugin uninstall scoped`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_FILES, claudeDir } from "../src/registrations.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const SETTINGS_PATH = path.join(claudeDir(), "settings.json");

const log = (msg) => console.log(`[scoped uninstall] ${msg}`);

try {
  execFileSync("claude", ["mcp", "remove", "scoped", "--scope", "user"], { stdio: ["ignore", "inherit", "inherit"] });
  log("Removed MCP server 'scoped'.");
} catch (err) {
  log(`Couldn't remove MCP server via claude CLI (${err.code || err.message}) — remove it manually if still present.`);
}

if (!fs.existsSync(SETTINGS_PATH)) {
  log(`${SETTINGS_PATH} doesn't exist — nothing to clean up there.`);
  process.exit(0);
}

const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
const ours = new Set(Object.values(HOOK_FILES).flatMap((f) => {
  const p = path.join(REPO_ROOT, "hooks", f);
  return [`node ${p}`, `node "${p}"`];
}));
let removed = 0;

for (const event of Object.keys(HOOK_FILES)) {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) continue;
  settings.hooks[event] = groups
    .map((g) => {
      const kept = (g.hooks ?? []).filter((h) => !ours.has(h.command));
      removed += (g.hooks ?? []).length - kept.length;
      return { ...g, hooks: kept };
    })
    .filter((g) => g.hooks.length > 0);
}

if (removed) {
  const target = fs.realpathSync(SETTINGS_PATH);
  const tmp = `${target}.scoped-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, target);
  log(`Removed ${removed} scoped hook entr${removed === 1 ? "y" : "ies"} from ${SETTINGS_PATH}.`);
} else {
  log("No scoped hook entries for this checkout found — nothing to remove.");
}

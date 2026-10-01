import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

test("plugin manifest, package and server report the same version", () => {
  const v = json("package.json").version;
  assert.equal(json(".claude-plugin/plugin.json").version, v);
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].version, v);
  assert.match(fs.readFileSync(path.join(root, "src/index.mjs"), "utf8"), new RegExp(`version: "${v}"`));
  assert.match(fs.readFileSync(path.join(root, "src/config.mjs"), "utf8"), new RegExp(`VERSION = "${v}"`));
  const lock = json("package-lock.json");
  assert.equal(lock.version, v);
  assert.equal(lock.packages[""].version, v);
  assert.match(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), new RegExp(`^## v?${v.replace(/\./g, "\\.")}`, "m"));
});

test("every plugin hook and the MCP launcher point at a file that exists and runs", () => {
  const hooks = json("hooks/hooks.json").hooks;
  const cmds = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.length, 2);
  for (const c of cmds) {
    const rel = c.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/)?.[1];
    assert.ok(rel && fs.existsSync(path.join(root, rel)), `missing target in: ${c}`);
  }
  const { command, args } = json(".mcp.json").mcpServers.scoped;
  assert.equal(command, "node");
  const launcher = args[0].replace("${CLAUDE_PLUGIN_ROOT}", root);
  assert.ok(fs.existsSync(launcher), `missing MCP launcher: ${args[0]}`);
  // Also on PATH as a command while the plugin is enabled, so keep it executable.
  assert.ok(fs.statSync(launcher).mode & 0o111, "bin/scoped-mcp must be executable");
});

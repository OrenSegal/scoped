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
  const { command, args } = json(".claude-plugin/plugin.json").mcpServers.scoped;
  assert.equal(command, "node");
  const launcher = args[0].replace("${CLAUDE_PLUGIN_ROOT}", root);
  assert.ok(fs.existsSync(launcher), `missing MCP launcher: ${args[0]}`);
  // Also on PATH as a command while the plugin is enabled, so keep it executable.
  assert.ok(fs.statSync(launcher).mode & 0o111, "bin/scoped-mcp must be executable");
});

// A root .mcp.json is also a project-scope MCP config for any session opened in a clone, where
// ${CLAUDE_PLUGIN_ROOT} is unset: it would start a broken second server. The plugin declares
// its server in plugin.json instead, which only the plugin loader reads.
test("the MCP server is declared in plugin.json, not in a project-scope .mcp.json", () => {
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
  assert.deepEqual(Object.keys(json(".claude-plugin/plugin.json").mcpServers ?? {}), ["scoped"]);
});

test("every eval case has a prompt and graders with a known type (format of `claude plugin eval`)", () => {
  const types = new Set(["regex", "tool_used", "tool_order", "file_exists", "llm", "baseline"]);
  const front = (file) => {
    const m = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    assert.ok(m, `${file} has no frontmatter`);
    return { head: m[1], body: m[2].trim() };
  };
  const cases = fs.readdirSync(path.join(root, "evals"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "results");
  assert.ok(cases.length >= 2);
  for (const c of cases) {
    const dir = path.join(root, "evals", c.name);
    const prompt = front(path.join(dir, "prompt.md"));
    assert.ok(prompt.body.length > 20, `${c.name}: empty prompt`);
    assert.match(prompt.head, /^max_turns: \d+$/m);
    const graders = fs.readdirSync(path.join(dir, "graders")).filter((f) => f.endsWith(".md"));
    assert.ok(graders.length >= 1, `${c.name}: no graders`);
    for (const g of graders) {
      const { head, body } = front(path.join(dir, "graders", g));
      const type = head.match(/^type: (\S+)$/m)?.[1];
      assert.ok(types.has(type), `${c.name}/${g}: type ${type}`);
      if (type === "llm") assert.ok(body.length > 20, `${c.name}/${g}: llm grader needs criteria`);
      if (type === "regex") new RegExp(head.match(/^pattern: '(.*)'$/m)[1]);
    }
  }
});

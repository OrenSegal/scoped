import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const codeFiles = () =>
  ["src", "hooks", "scripts", "bin"].flatMap((d) =>
    fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".mjs") || d === "bin" && !f.endsWith(".json")).map((f) => path.join(d, f))
  );

// package.json is the one place the version is written by hand. JSON manifests can't import it,
// so they must equal it; code reads it (src/config.mjs) and must not spell a version itself.
test("version: package.json is the source; manifests match it and no code hardcodes one", async () => {
  const v = json("package.json").version;
  assert.equal(json(".claude-plugin/plugin.json").version, v);
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].version, v);
  const lock = json("package-lock.json");
  assert.equal(lock.version, v);
  assert.equal(lock.packages[""].version, v);
  assert.match(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), new RegExp(`^## v?${v.replace(/\./g, "\\.")}`, "m"));
  for (const f of codeFiles()) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), /["'`]v?\d+\.\d+\.\d+["'`]/, `${f} hardcodes a version`);
  }
  const { version, minNode } = await import("../src/config.mjs");
  assert.equal(version(), v);
  assert.equal(`>=${minNode()}`, json("package.json").engines.node);
});

test("one description for package, plugin and marketplace entry", () => {
  const d = json("package.json").description;
  assert.equal(json(".claude-plugin/plugin.json").description, d);
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].description, d);
});

// README's Configuration table is the one list of environment variables. Every variable the code
// reads is in it, and nothing in it is unread. SCOPED_DEPS_DIR is the launcher telling the server
// where it installed the dependencies, not a setting.
test("README's configuration table lists exactly the environment variables the code reads", () => {
  const used = new Set();
  for (const f of codeFiles()) {
    for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(/\b(SCOPED_[A-Z_]+|LINEAR_API_KEY)\b/g)) used.add(m[1]);
  }
  used.delete("SCOPED_DEPS_DIR");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Configuration"), readme.indexOf("\n## ", readme.indexOf("## Configuration") + 1));
  const documented = new Set([...section.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]));
  assert.deepEqual([...documented].sort(), [...used].sort());
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

// scripts/install.mjs and uninstall.mjs against a throwaway HOME, with no `claude` on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRETOOL = path.join(root, "hooks", "pretool-enforce.mjs");

function home() {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-home-")));
  fs.mkdirSync(path.join(h, ".claude", "plugins"), { recursive: true });
  return h;
}

function nodeOnlyPath() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-path-")));
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  return dir;
}

function run(script, h, args = [], cwd = h) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SCOPED_") && !k.startsWith("CLAUDE_") && k !== "INIT_CWD"));
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    env: { ...env, HOME: h, USERPROFILE: h, PATH: nodeOnlyPath() },
    cwd,
    encoding: "utf8",
  });
  return { ...r, out: r.stdout + r.stderr };
}

const settingsOf = (h) => JSON.parse(fs.readFileSync(path.join(h, ".claude", "settings.json"), "utf8"));
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
};
const hookCommands = (s, event) => (s.hooks?.[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));

test("setup: registers both hooks once with quoted paths, and a re-run adds nothing", () => {
  const h = home();
  const first = run("install.mjs", h);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /claude/); // says it could not register the MCP server without the CLI
  const s1 = settingsOf(h);
  assert.deepEqual(hookCommands(s1, "PreToolUse"), [`node "${PRETOOL}"`]);
  assert.equal(hookCommands(s1, "SessionStart").length, 1);
  assert.equal(s1.hooks.PreToolUse[0].hooks[0].timeout, 15);

  const second = run("install.mjs", h);
  assert.equal(second.status, 0, second.out);
  assert.deepEqual(settingsOf(h), s1);
});

test("setup: refuses when scoped is already installed as a plugin (hooks would fire twice)", () => {
  const h = home();
  writeJson(path.join(h, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { "scoped@scoped": [{ scope: "user", installPath: "/x", version: "0.4.0" }] },
  });
  const r = run("install.mjs", h);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /plugin/i);
  assert.match(r.out, /scoped@scoped/);
  assert.equal(fs.existsSync(path.join(h, ".claude", "settings.json")), false);
});

test("setup: an enabled plugin in settings.json is also detected; --force overrides", () => {
  const h = home();
  writeJson(path.join(h, ".claude", "settings.json"), { enabledPlugins: { "scoped@my-marketplace": true } });
  const r = run("install.mjs", h);
  assert.equal(r.status, 1, r.out);
  assert.equal(settingsOf(h).hooks, undefined);
  const forced = run("install.mjs", h, ["--force"]);
  assert.equal(forced.status, 0, forced.out);
  assert.equal(hookCommands(settingsOf(h), "PreToolUse").length, 1);
});

test("setup: a scoped hook from another checkout is not duplicated", () => {
  const h = home();
  const old = `node /old/place/scoped/hooks/pretool-enforce.mjs`;
  writeJson(path.join(h, ".claude", "settings.json"), {
    hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: old }] }] },
  });
  const r = run("install.mjs", h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\/old\/place\/scoped/);
  assert.deepEqual(hookCommands(settingsOf(h), "PreToolUse"), [old]);
});

test("setup: a project-level scoped hook counts too", () => {
  const h = home();
  const proj = fs.mkdtempSync(path.join(h, "proj-"));
  writeJson(path.join(proj, ".claude", "settings.json"), {
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node "${PRETOOL}"` }] }] },
  });
  const r = run("install.mjs", h, [], proj);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(hookCommands(settingsOf(h), "PreToolUse"), []);
});

test("setup: run from the clone itself, nothing in the clone counts as an MCP registration", () => {
  const h = home();
  const r = run("install.mjs", h, [], root);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /already registered/);
  assert.match(r.out, /claude mcp list/); // went on to register (and found no CLI in this sandbox)
});

test("setup: a project .mcp.json that only works inside a plugin does not stop registration", () => {
  const h = home();
  const proj = fs.mkdtempSync(path.join(h, "proj-"));
  writeJson(path.join(proj, ".mcp.json"), { mcpServers: { scoped: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/scoped-mcp"] } } });
  const r = run("install.mjs", h, [], proj);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /already registered \(project/);
});

test("uninstall: removes this checkout's hooks (quoted or legacy unquoted), keeps everything else", () => {
  const h = home();
  const other = { type: "command", command: "echo unrelated" };
  writeJson(path.join(h, ".claude", "settings.json"), {
    model: "x",
    hooks: {
      PreToolUse: [
        { matcher: "Edit", hooks: [{ type: "command", command: `node ${PRETOOL}` }] },
        { matcher: "Bash", hooks: [other] },
      ],
      SessionStart: [{ hooks: [{ type: "command", command: `node "${path.join(root, "hooks", "session-start.mjs")}"` }] }],
    },
  });
  const r = run("uninstall.mjs", h);
  assert.equal(r.status, 0, r.out);
  const s = settingsOf(h);
  assert.equal(s.model, "x");
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: "Bash", hooks: [other] }]);
  assert.deepEqual(s.hooks.SessionStart, []);
});

test("setup: an unparseable settings.json is left alone", () => {
  const h = home();
  const p = path.join(h, ".claude", "settings.json");
  fs.writeFileSync(p, "{ not json");
  const r = run("install.mjs", h);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(p, "utf8"), "{ not json");
});

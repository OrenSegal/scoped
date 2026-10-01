// The plugin's MCP launcher, run the way Claude Code runs it: the command and args from
// .mcp.json with ${CLAUDE_PLUGIN_ROOT} substituted, from a plugin checkout that has no
// node_modules. npm is replaced by a fake on PATH so these run offline; the one test that uses
// the real registry is gated behind SCOPED_NETWORK_TESTS=1.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mcpSession } from "./mcp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = process.platform === "win32" ? "fake npm is a shell script" : false;

function tmp(prefix = "scoped-launch-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A plugin checkout as Claude Code clones it: sources only, no node_modules, no .git.
function pluginCopy({ readOnly = true } = {}) {
  const dest = path.join(tmp(), "scoped");
  fs.cpSync(root, dest, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(path.relative(root, src) ? "/" + path.relative(root, src) : ""),
  });
  if (readOnly) chmodTree(dest, false);
  return dest;
}

function chmodTree(dir, writable) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) chmodTree(p, writable);
    else fs.chmodSync(p, writable ? fs.statSync(p).mode | 0o200 : fs.statSync(p).mode & ~0o222);
  }
  fs.chmodSync(dir, writable ? 0o755 : 0o555);
}

// PATH with node and, optionally, a fake npm that "installs" by copying this checkout's
// node_modules, logs its argv and cwd, and prints to stdout (which must never reach the MCP pipe).
function fakePath({ npm = "copy", sleep = 0 } = {}) {
  const dir = tmp("scoped-path-");
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  const log = path.join(dir, "npm.log");
  if (npm) {
    const body =
      npm === "fail"
        ? `echo "npm error code ENOTCACHED"\nexit 1\n`
        : `/bin/sleep ${sleep}\n/bin/cp -R "${path.join(root, "node_modules")}" ./node_modules\necho "added 2 packages"\n`;
    fs.writeFileSync(path.join(dir, "npm"), `#!/bin/sh\necho "$PWD $*" >> "${log}"\n${body}`, { mode: 0o755 });
  }
  return { PATH: dir, log };
}

function launcherCommand(pluginRoot) {
  const { command, args = [] } = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.scoped;
  const sub = (s) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
  return [sub(command) === "node" ? process.execPath : sub(command), args.map(sub)];
}

function launch(pluginRoot, env) {
  const [cmd, args] = launcherCommand(pluginRoot);
  return mcpSession(cmd, args, { env: { CLAUDE_PLUGIN_ROOT: pluginRoot, ...env }, cwd: tmp() });
}

function launchSync(pluginRoot, env, nodeArgs = []) {
  const [cmd, args] = launcherCommand(pluginRoot);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SCOPED_") && k !== "CLAUDE_PLUGIN_DATA"));
  return spawnSync(cmd === process.execPath ? cmd : cmd, cmd === process.execPath ? [...nodeArgs, ...args] : args, {
    input: "",
    env: { ...clean, CLAUDE_PLUGIN_ROOT: pluginRoot, ...env },
    cwd: tmp(),
    timeout: 120000,
  });
}

async function speak(s) {
  const init = await s.initialize();
  assert.equal(init.result?.serverInfo?.name, "scoped", JSON.stringify(init) + s.stderr());
  const tools = (await s.request("tools/list")).result.tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["check", "claim", "release", "status"]);
  await s.close();
  for (const line of s.lines.filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0", `non-JSON-RPC stdout: ${line}`);
}

const depsDirs = (data) => (fs.existsSync(path.join(data, "deps")) ? fs.readdirSync(path.join(data, "deps")) : []);

test(".mcp.json starts the server with `node`, so it runs where shebangs do not", () => {
  const { command, args } = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers.scoped;
  assert.equal(command, "node");
  assert.deepEqual(args, ["${CLAUDE_PLUGIN_ROOT}/bin/scoped-mcp"]);
});

test("launcher: a dev checkout with node_modules installs nothing", async () => {
  const data = tmp();
  await speak(launch(root, { CLAUDE_PLUGIN_DATA: data, SCOPED_DB: path.join(data, "c.db") }));
  assert.deepEqual(depsDirs(data), []);
});

test("launcher: a read-only plugin checkout installs into CLAUDE_PLUGIN_DATA, once", { skip: posixOnly }, async (t) => {
  const plugin = pluginCopy();
  t.after(() => chmodTree(plugin, true));
  const data = tmp();
  const { PATH, log } = fakePath();
  const env = { PATH, CLAUDE_PLUGIN_DATA: data, SCOPED_DB: path.join(data, "c.db") };
  await speak(launch(plugin, env));
  await speak(launch(plugin, env));

  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1, "second start must reuse the installed deps");
  assert.match(calls[0], / ci /);
  assert.match(calls[0], /--ignore-scripts/);
  assert.match(calls[0], /--omit=dev/);
  assert.ok(calls[0].startsWith(path.join(data, "deps")), `npm ran in ${calls[0]}`);
  assert.equal(fs.existsSync(path.join(plugin, "node_modules")), false);
  const dirs = depsDirs(data);
  assert.equal(dirs.length, 1, dirs.join(","));
  assert.ok(fs.existsSync(path.join(data, "deps", dirs[0], ".complete")));
});

test("launcher: two sessions starting at once share one install", { skip: posixOnly }, async (t) => {
  const plugin = pluginCopy();
  t.after(() => chmodTree(plugin, true));
  const data = tmp();
  const { PATH } = fakePath({ sleep: 1 });
  const env = { PATH, CLAUDE_PLUGIN_DATA: data, SCOPED_DB: path.join(data, "c.db") };
  await Promise.all([speak(launch(plugin, env)), speak(launch(plugin, env))]);
  assert.equal(depsDirs(data).filter((d) => !d.startsWith(".")).length, 1);
  assert.deepEqual(depsDirs(data).filter((d) => d.startsWith(".")), [], "temp install dirs are cleaned up");
});

test("launcher: no npm on PATH exits 1 with a sentence, stdout untouched", { skip: posixOnly }, () => {
  const plugin = pluginCopy();
  const data = tmp();
  const r = launchSync(plugin, { PATH: fakePath({ npm: null }).PATH, CLAUDE_PLUGIN_DATA: data });
  chmodTree(plugin, true);
  assert.equal(r.status, 1, r.stderr.toString());
  assert.equal(r.stdout.length, 0);
  assert.match(r.stderr.toString(), /npm was not found on PATH/);
  assert.doesNotMatch(r.stderr.toString(), /\n\s+at /);
});

test("launcher: a failed install (offline) exits 1, explains, and leaves nothing half-installed", { skip: posixOnly }, () => {
  const plugin = pluginCopy();
  const data = tmp();
  const r = launchSync(plugin, { PATH: fakePath({ npm: "fail" }).PATH, CLAUDE_PLUGIN_DATA: data });
  chmodTree(plugin, true);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.length, 0, "npm's stdout must not reach the MCP pipe");
  assert.match(r.stderr.toString(), /npm ci failed.*offline/is);
  assert.deepEqual(depsDirs(data), []);
});

test("launcher: real npm, offline with an empty cache, fails cleanly", (t) => {
  if (spawnSync("npm", ["--version"], { shell: process.platform === "win32" }).status !== 0) return t.skip("no npm");
  const plugin = pluginCopy({ readOnly: false });
  const data = tmp();
  const r = launchSync(plugin, { CLAUDE_PLUGIN_DATA: data, npm_config_offline: "true", npm_config_cache: tmp() });
  assert.equal(r.status, 1, r.stderr.toString());
  assert.equal(r.stdout.length, 0);
  assert.match(r.stderr.toString(), /npm ci failed/);
  assert.deepEqual(depsDirs(data), []);
});

test("launcher: a Node without node:sqlite gets the version message, not a stack", (t) => {
  const old = "/usr/local/bin/node";
  const oldVersion = fs.existsSync(old) ? spawnSync(old, ["--version"]).stdout?.toString().trim() : "";
  let r;
  if (/^v(1\d|2[01])\.|^v22\.(\d|1[0-2])\./.test(oldVersion)) {
    const [, args] = launcherCommand(root);
    r = spawnSync(old, args, { input: "", env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, cwd: tmp() });
  } else if (spawnSync(process.execPath, ["--no-experimental-sqlite", "-e", ""]).status === 0) {
    r = launchSync(root, {}, ["--no-experimental-sqlite"]);
  } else return t.skip("no way to run without node:sqlite here");
  assert.equal(r.status, 1, r.stderr.toString());
  assert.equal(r.stdout.length, 0);
  assert.match(r.stderr.toString(), /node:sqlite is unavailable.*Node >= 22\.13/);
});

test("launcher: real install from the registry into CLAUDE_PLUGIN_DATA (SCOPED_NETWORK_TESTS=1)", async (t) => {
  if (process.env.SCOPED_NETWORK_TESTS !== "1") return t.skip("set SCOPED_NETWORK_TESTS=1");
  const plugin = pluginCopy();
  t.after(() => chmodTree(plugin, true));
  const data = tmp();
  await speak(launch(plugin, { CLAUDE_PLUGIN_DATA: data, SCOPED_DB: path.join(data, "c.db") }));
  assert.equal(depsDirs(data).length, 1);
});

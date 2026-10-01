// The `scoped` CLI, run as a subprocess with a throwaway SCOPED_HOME and Claude config dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "bin", "scoped");
const PRETOOL = path.join(root, "hooks", "pretool-enforce.mjs");

function tmp(prefix = "scoped-cli-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function sandbox() {
  const home = tmp();
  return { home, scopedHome: path.join(home, ".scoped"), claude: path.join(home, ".claude"), cwd: tmp() };
}

function env(sb, extra = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SCOPED_") && !k.startsWith("CLAUDE_") && k !== "INIT_CWD"));
  return { ...base, HOME: sb.home, TMPDIR: sb.home, SCOPED_HOME: sb.scopedHome, CLAUDE_CONFIG_DIR: sb.claude, ...extra };
}

function cli(sb, args, { extra, nodeArgs = [] } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, CLI, ...args], { env: env(sb, extra), cwd: sb.cwd, encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function hookEdit(sb, session, file) {
  const r = spawnSync(process.execPath, [PRETOOL], {
    input: JSON.stringify({ session_id: session, tool_name: "Edit", tool_input: { file_path: file }, cwd: sb.cwd }),
    env: env(sb),
    encoding: "utf8",
  });
  return r.stdout;
}

const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
};

test("cli: status, check, release by the prefix a deny message shows, gc", () => {
  const sb = sandbox();
  assert.match(cli(sb, ["status"]).out, /no active claims/);
  const file = path.join(sb.cwd, "a.js");
  assert.equal(hookEdit(sb, "aaaaaaaa-1111-2222", file), "");
  const deny = JSON.parse(hookEdit(sb, "bbbbbbbb-3333", file)).hookSpecificOutput.permissionDecisionReason;
  const prefix = deny.match(/scoped release (\S+)`/)[1];
  assert.equal(prefix, "aaaaaaaa");

  const status = cli(sb, ["status"]);
  assert.match(status.out, /a\.js\s+adhoc:aaaaaaaa\s+aaaaaaaa/);
  assert.equal(JSON.parse(cli(sb, ["status", "--json"]).out).active_claims, 1);

  const held = cli(sb, ["check", "a.js"]);
  assert.equal(held.code, 1);
  assert.match(held.out, /claimed: .*a\.js/);
  assert.match(held.out, /scoped release aaaaaaaa/);

  const rel = cli(sb, ["release", prefix]);
  assert.equal(rel.code, 0, rel.err);
  assert.match(rel.out, /released 1 claim\(s\) held by aaaaaaaa-1111-2222/);
  assert.equal(cli(sb, ["check", file]).code, 0);
  assert.equal(hookEdit(sb, "bbbbbbbb-3333", file), "", "after release the other session may edit");

  assert.match(cli(sb, ["gc"]).out, /reaped 0/);
});

test("cli: release refuses a too-short or ambiguous prefix", () => {
  const sb = sandbox();
  hookEdit(sb, "abcd1111-x", path.join(sb.cwd, "a.js"));
  hookEdit(sb, "abcd2222-y", path.join(sb.cwd, "b.js"));
  assert.equal(cli(sb, ["release", "ab"]).code, 2);
  const amb = cli(sb, ["release", "abcd"]);
  assert.equal(amb.code, 1);
  assert.match(amb.err, /ambiguous/);
  assert.equal(JSON.parse(cli(sb, ["status", "--json"]).out).active_claims, 2);
  assert.equal(cli(sb, ["release", "zzzz9999"]).code, 1);
});

test("cli: report counts blocks by file, pair and issue, honouring --days", () => {
  const sb = sandbox();
  const t = Math.floor(Date.now() / 1000);
  const old = t - 40 * 86400;
  fs.mkdirSync(sb.scopedHome, { recursive: true });
  fs.writeFileSync(
    path.join(sb.scopedHome, "blocks.tsv"),
    [
      [t, "Edit", "/r/a.js", "bbbbbbbb", "aaaaaaaa", "ENG-1"],
      [t, "Write", "/r/a.js", "bbbbbbbb", "aaaaaaaa", "ENG-1"],
      [t, "Edit", "/r/b.js", "cccccccc", "aaaaaaaa", "ENG-1"],
      [old, "Edit", "/r/old.js", "dddddddd", "aaaaaaaa", "ENG-0"],
    ]
      .map((r) => r.join("\t"))
      .join("\n") + "\n"
  );
  const r = cli(sb, ["report"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /3 blocked edit\(s\) across 2 file\(s\)/);
  assert.match(r.out, /2\s+\/r\/a\.js/);
  assert.match(r.out, /2\s+bbbbbbbb -> aaaaaaaa/);
  assert.match(r.out, /Tuning guide/);
  assert.doesNotMatch(r.out, /old\.js/);
  assert.match(cli(sb, ["report", "--days=60"]).out, /4 blocked edit/);
  assert.match(cli(sb, ["report"], { extra: { SCOPED_LOG: "off" } }).out, /block log is off/);
  assert.equal(cli(sb, ["report", "--days=x"]).code, 2);
});

test("doctor: plugin only, everything reachable -> all good", () => {
  const sb = sandbox();
  writeJson(path.join(sb.claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "scoped@scoped": [{ scope: "user", installPath: root }] } });
  const r = cli(sb, ["doctor"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /ok\s+SessionStart hook registered once \(plugin\)/);
  assert.match(r.out, /ok\s+PreToolUse hook registered once \(plugin\)/);
  assert.match(r.out, /ok\s+MCP server registered once \(plugin\)/);
  assert.match(r.out, /ok\s+MCP server answers initialize and tools\/list/);
  assert.match(r.out, /ok\s+claims db .*writable, schema v1/);
  assert.match(r.out, /PreToolUse hook takes \d+ms/);
});

test("doctor: plugin plus setup hooks is a double registration -> exit 1", () => {
  const sb = sandbox();
  writeJson(path.join(sb.claude, "settings.json"), {
    enabledPlugins: { "scoped@scoped": true },
    hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: `node "${PRETOOL}"` }] }] },
  });
  const r = cli(sb, ["doctor"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL\s+PreToolUse hook registered 2 times/);
  assert.match(r.out, /ok\s+SessionStart hook registered once/);
});

test("doctor: nothing registered, unusable db -> each named, exit 1", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores permissions");
  const sb = sandbox();
  const ro = tmp();
  fs.chmodSync(ro, 0o500);
  t.after(() => fs.chmodSync(ro, 0o700));
  const r = cli(sb, ["doctor"], { extra: { SCOPED_DB: path.join(ro, "sub", "claims.db") } });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL\s+claims db .*sub\/claims\.db/);
  assert.match(r.out, /FAIL\s+PreToolUse hook is not registered/);
  assert.match(r.out, /FAIL\s+MCP server 'scoped' is not registered/);
});

test("doctor: a Node without node:sqlite is one FAIL line, not a crash", (t) => {
  if (spawnSync(process.execPath, ["--no-experimental-sqlite", "-e", ""]).status !== 0) return t.skip("no --no-experimental-sqlite");
  const sb = sandbox();
  const r = cli(sb, ["doctor"], { nodeArgs: ["--no-experimental-sqlite"] });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL\s+node:sqlite is unavailable/);
  assert.doesNotMatch(r.err, /\n\s+at /);
  const s = cli(sb, ["status"], { nodeArgs: ["--no-experimental-sqlite"] });
  assert.equal(s.code, 1);
  assert.match(s.err, /^scoped: node:sqlite is unavailable/);
});

test("cli: version matches package.json; unknown command is a usage error", () => {
  const sb = sandbox();
  assert.equal(cli(sb, ["version"]).out.trim(), JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  assert.equal(cli(sb, ["nope"]).code, 2);
  assert.match(cli(sb, []).out, /usage: scoped/);
});

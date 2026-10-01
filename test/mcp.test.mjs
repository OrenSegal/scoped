import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { cleanEnv, mcpSession } from "./mcp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmp(prefix = "scoped-mcp-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const server = (env) => mcpSession(process.execPath, [path.join(root, "src", "index.mjs")], { env });

test("server: initialize, tools/list, a claim round trip, and nothing but JSON-RPC on stdout", async () => {
  const dir = tmp();
  const s = server({ SCOPED_DB: path.join(dir, "c.db"), LINEAR_API_KEY: "lin_test_never_used" });
  const init = await s.initialize();
  assert.equal(init.result.serverInfo.name, "scoped");
  const tools = (await s.request("tools/list")).result.tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["check", "claim", "release", "status"]);
  // adhoc: ids are not Linear issues, so no network call is attempted for them.
  const r = await s.call("claim", { issue_id: "adhoc:test", file_paths: ["/repo/a.js"], session_id: "session-a" });
  assert.deepEqual(JSON.parse(r.result.content[0].text).claimed, ["/repo/a.js"]);
  await s.close();
  for (const line of s.lines.filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0", `non-JSON-RPC stdout: ${line}`);
});

test("server: a malformed session_id or issue_id is rejected before it reaches the db", async () => {
  const dir = tmp();
  const s = server({ SCOPED_DB: path.join(dir, "c.db") });
  await s.initialize();
  const bad = await s.call("claim", { issue_id: "ENG-1", file_paths: ["/repo/a.js"], session_id: "a b\nc" });
  assert.ok(bad.result?.isError || bad.error, JSON.stringify(bad));
  const badIssue = await s.call("claim", { issue_id: "ENG 1; drop", file_paths: ["/repo/a.js"], session_id: "session-a" });
  assert.ok(badIssue.result?.isError || badIssue.error);
  const status = await s.call("status", {});
  assert.equal(JSON.parse(status.result.content[0].text).active_claims, 0);
  await s.close();
});

test("server: ttl_seconds is capped at 7 days", async () => {
  const dir = tmp();
  const s = server({ SCOPED_DB: path.join(dir, "c.db") });
  await s.initialize();
  const r = await s.call("claim", { issue_id: "ENG-1", file_paths: ["/repo/a.js"], session_id: "session-a", ttl_seconds: 10 ** 9 });
  assert.ok(r.result?.isError || r.error);
  await s.close();
});

test("server: an unusable db does not kill the server; tools say what is wrong", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores permissions");
  const dir = tmp();
  fs.chmodSync(dir, 0o500);
  t.after(() => fs.chmodSync(dir, 0o700));
  const s = server({ SCOPED_DB: path.join(dir, "sub", "c.db") });
  await s.initialize();
  const r = await s.call("status", {});
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /claims db/i);
  await s.close();
});

test("server: on a Node without node:sqlite it exits with one clear line, stdout untouched", (t) => {
  if (spawnSync(process.execPath, ["--no-experimental-sqlite", "-e", ""]).status !== 0) return t.skip("no --no-experimental-sqlite");
  const r = spawnSync(process.execPath, ["--no-experimental-sqlite", path.join(root, "src", "index.mjs")], { input: "", env: cleanEnv({}) });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.length, 0);
  assert.match(r.stderr.toString(), /node:sqlite is unavailable.*22\.13/);
  assert.doesNotMatch(r.stderr.toString(), /at ModuleLoader|ERR_UNKNOWN_BUILTIN_MODULE.*\n\s+at /);
});

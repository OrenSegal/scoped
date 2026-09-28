import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, "..", "hooks", "pretool-enforce.mjs");

// The hook resolves its db at `~/.scoped/claims.db` via os.homedir(), which respects $HOME on
// POSIX — so each test gets an isolated store by pointing $HOME at a fresh temp directory.
function runHook(payload) {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-hook-test-"));
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...process.env, HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr, home }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test("hook auto-claims an unclaimed file and allows the edit silently", async () => {
  const { stdout } = await runHook({
    session_id: "session-a",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/a.js" },
    cwd: "/repo",
  });
  assert.equal(stdout, "");
});

test("hook allows a second edit from the same session to a file it already owns", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-hook-test-"));
  const payload = { session_id: "session-a", tool_name: "Edit", tool_input: { file_path: "/repo/a.js" }, cwd: "/repo" };
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK_PATH], { env: { ...process.env, HOME: home } });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve(stdout));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  assert.equal(await run(), ""); // first: auto-claims
  assert.equal(await run(), ""); // second: same session, touch + allow
});

test("hook denies an edit from a different session to a claimed file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-hook-test-"));
  const spawnWith = (session_id) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK_PATH], { env: { ...process.env, HOME: home } });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve(stdout));
      child.stdin.write(JSON.stringify({ session_id, tool_name: "Edit", tool_input: { file_path: "/repo/a.js" }, cwd: "/repo" }));
      child.stdin.end();
    });

  const first = await spawnWith("session-a");
  assert.equal(first, ""); // auto-claimed by session-a

  const second = await spawnWith("session-b");
  assert.notEqual(second, "");
  const parsed = JSON.parse(second);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /claimed by another session/);
});

test("hook is a no-op for tools other than Edit/MultiEdit/Write/NotebookEdit", async () => {
  const { stdout } = await runHook({
    session_id: "session-a",
    tool_name: "Read",
    tool_input: { file_path: "/repo/a.js" },
    cwd: "/repo",
  });
  assert.equal(stdout, "");
});

test("hook fails open (no denial) when session_id is missing", async () => {
  const { stdout } = await runHook({
    tool_name: "Edit",
    tool_input: { file_path: "/repo/a.js" },
    cwd: "/repo",
  });
  assert.equal(stdout, "");
});

// Real race: several hook processes for different sessions start at once against one db and
// one file. Only one may be allowed. The others must be denied, not allowed by failing open on
// a lock error or by acting on a stale check(). Repeated because a race that loses only
// sometimes is still a race.
test("6 hook processes racing on one file from different sessions: exactly 1 allowed, 5 denied, every round", async () => {
  const PROCS = 6;
  const ROUNDS = 15;
  for (let round = 0; round < ROUNDS; round++) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-hook-race-"));
    const runs = Array.from({ length: PROCS }, (_, i) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK_PATH], { env: { ...process.env, HOME: home } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", () => resolve({ stdout, stderr }));
        child.stdin.end(
          JSON.stringify({ session_id: `session-${round}-${i}`, tool_name: "Edit", tool_input: { file_path: "/repo/hot.js" }, cwd: "/repo" })
        );
      })
    );
    const results = await Promise.all(runs);
    const failedOpen = results.filter((r) => r.stderr.includes("failed open"));
    const allowed = results.filter((r) => r.stdout === "");
    const denied = results.filter((r) => r.stdout !== "" && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "deny");
    assert.deepEqual(failedOpen.map((r) => r.stderr), [], `round ${round}: a hook failed open`);
    assert.equal(allowed.length, 1, `round ${round}: expected 1 allowed, got ${allowed.length}`);
    assert.equal(denied.length, PROCS - 1, `round ${round}: expected ${PROCS - 1} denied, got ${denied.length}`);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

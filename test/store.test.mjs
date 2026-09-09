import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaimStore } from "../src/store.mjs";

function tmpStore() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-test-")), "claims.db");
  return new ClaimStore(dbPath);
}

test("claim() on an unclaimed file succeeds with no conflicts", () => {
  const store = tmpStore();
  const result = store.claim("ENG-1", ["/repo/a.js"], "session-a");
  assert.deepEqual(result.claimed, ["/repo/a.js"]);
  assert.deepEqual(result.conflicts, []);
  store.close();
});

test("claim() by a different session on an already-claimed file conflicts", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a");
  const result = store.claim("ENG-2", ["/repo/a.js"], "session-b");
  assert.deepEqual(result.claimed, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].file_path, "/repo/a.js");
  assert.equal(result.conflicts[0].held_by.session_id, "session-a");
  store.close();
});

test("claim() by the same session on an already-claimed file is idempotent", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a");
  const result = store.claim("ENG-1", ["/repo/a.js"], "session-a");
  assert.deepEqual(result.claimed, ["/repo/a.js"]);
  assert.deepEqual(result.conflicts, []);
  store.close();
});

test("relative paths are normalized against cwd so both sides see the same key", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["a.js"], "session-a", undefined, "/repo");
  const claim = store.check("/repo/a.js");
  assert.ok(claim);
  assert.equal(claim.session_id, "session-a");
  store.close();
});

test("release(issueId, sessionId) only removes that session's claims", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a");
  store.claim("ENG-1", ["/repo/b.js"], "session-b");
  const released = store.release("ENG-1", "session-a");
  assert.deepEqual(released, ["/repo/a.js"]);
  assert.equal(store.check("/repo/a.js"), null);
  assert.ok(store.check("/repo/b.js"));
  store.close();
});

test("release(issueId) with no sessionId removes every session's claims on that issue", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a");
  store.claim("ENG-1", ["/repo/b.js"], "session-b");
  const released = store.release("ENG-1");
  assert.equal(released.length, 2);
  assert.equal(store.check("/repo/a.js"), null);
  assert.equal(store.check("/repo/b.js"), null);
  store.close();
});

test("check() on an unclaimed file returns null", () => {
  const store = tmpStore();
  assert.equal(store.check("/repo/nope.js"), null);
  store.close();
});

test("TTL-expired claims are reaped on the next read", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a", -1); // expires immediately
  assert.equal(store.check("/repo/a.js"), null);
  store.close();
});

test("claims owned by a dead pid on this host are reaped even before TTL expiry", () => {
  const store = tmpStore();
  const deadPid = 999999999; // out of range, definitely not a live process
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 4 * 60 * 60, undefined, deadPid);
  assert.equal(store.check("/repo/a.js"), null);
  store.close();
});

test("claims made with pid: null (short-lived callers, e.g. the hook) are never reaped by pid liveness", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 4 * 60 * 60, undefined, null);
  assert.ok(store.check("/repo/a.js"));
  store.close();
});

test("touch() extends claimed_at for the owning session", async () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 100);
  const before = store.check("/repo/a.js").claimed_at;
  await new Promise((r) => setTimeout(r, 1100));
  store.touch("/repo/a.js", "session-a");
  const after = store.check("/repo/a.js").claimed_at;
  assert.ok(after > before);
  store.close();
});

test("touch() does nothing for a session that doesn't own the claim", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 100);
  const before = store.check("/repo/a.js").claimed_at;
  store.touch("/repo/a.js", "session-b");
  const after = store.check("/repo/a.js").claimed_at;
  assert.equal(after, before);
  store.close();
});

test("status() returns a fleet-wide snapshot of every active claim", () => {
  const store = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a");
  store.claim("ENG-2", ["/repo/b.js"], "session-b");
  const rows = store.status();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((r) => r.file_path)),
    new Set(["/repo/a.js", "/repo/b.js"])
  );
  store.close();
});

test("concurrent claims on the same file: exactly one wins", () => {
  const store = tmpStore();
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(store.claim("ENG-1", ["/repo/hot.js"], `session-${i}`));
  }
  const wins = results.filter((r) => r.claimed.length === 1);
  const losses = results.filter((r) => r.conflicts.length === 1);
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 5);
  store.close();
});

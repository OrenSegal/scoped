import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ClaimStore } from "../src/store.mjs";

function tmpDir(prefix = "scoped-hard-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function tmpStore() {
  const dbPath = path.join(tmpDir(), "claims.db");
  return { store: new ClaimStore(dbPath), dbPath };
}

test("an absolute path with `..` is the same claim as its resolved form", () => {
  const { store } = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a");
  const r = store.claim("ENG-1", ["/repo/sub/../a.js"], "session-b");
  assert.equal(r.conflicts.length, 1, "session-b got /repo/a.js through a `..` spelling");
  store.close();
});

test("a path through a symlinked directory is the same claim as the real path", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "real"));
  fs.writeFileSync(path.join(dir, "real", "a.js"), "");
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
  const { store } = tmpStore();
  store.claim("ENG-1", [path.join(dir, "real", "a.js")], "session-a");
  const r = store.claim("ENG-1", [path.join(dir, "link", "a.js")], "session-b");
  assert.equal(r.conflicts.length, 1, "session-b got the file through a symlinked directory");
  store.close();
});

test("a not-yet-existing file under a symlinked directory still resolves through the link", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "real"));
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
  const { store } = tmpStore();
  store.claim("ENG-1", [path.join(dir, "link", "new.js")], "session-a");
  const r = store.claim("ENG-1", [path.join(dir, "real", "new.js")], "session-b");
  assert.equal(r.conflicts.length, 1);
  store.close();
});

// macOS's default APFS volume is case-insensitive: `A.js` and `a.js` are one file.
function caseInsensitive(dir) {
  const probe = path.join(dir, "CaseProbe");
  fs.writeFileSync(probe, "");
  return fs.existsSync(path.join(dir, "caseprobe"));
}

test("on a case-insensitive volume, two spellings of an existing file are one claim", (t) => {
  const dir = tmpDir();
  if (!caseInsensitive(dir)) return t.skip("volume is case-sensitive");
  fs.writeFileSync(path.join(dir, "Upper.js"), "");
  const { store } = tmpStore();
  store.claim("ENG-1", [path.join(dir, "Upper.js")], "session-a");
  const r = store.claim("ENG-1", [path.join(dir, "upper.JS")], "session-b");
  assert.equal(r.conflicts.length, 1, "session-b got the file through a different case spelling");
  store.close();
});

test("a claim held by a live pid we may not signal (EPERM) is not reaped", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs a non-root POSIX user");
  const { store } = tmpStore();
  // pid 1 (init/launchd) is alive but owned by root: kill(1, 0) throws EPERM, not ESRCH.
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 3600, undefined, 1);
  assert.ok(store.check("/repo/a.js"), "a live process's claim was reaped because kill() said EPERM");
  store.close();
});

test("claim() does not throw if the conflicting row vanishes between INSERT and SELECT", () => {
  const { store, dbPath } = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a");
  const other = new DatabaseSync(dbPath);
  other.exec("PRAGMA busy_timeout = 0");
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!/SELECT issue_id, session_id FROM claims/.test(sql)) return stmt;
    return {
      get: (...args) => {
        // Another process releases the claim at the worst moment. If claim() runs in a
        // write transaction this DELETE can't get in (SQLITE_BUSY), which is the point.
        try {
          other.prepare("DELETE FROM claims WHERE session_id = 'session-a'").run();
        } catch (err) {
          if (!/locked|busy/i.test(err.message)) throw err;
        }
        return stmt.get(...args);
      },
    };
  };
  const r = store.claim("ENG-2", ["/repo/a.js"], "session-b");
  assert.equal(r.claimed.length + r.conflicts.length, 1);
  other.close();
  store.close();
});

test("a db written by a newer scoped schema is refused with a clear error", () => {
  const dbPath = path.join(tmpDir(), "claims.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => new ClaimStore(dbPath), /newer|schema/i);
});

test("opening a pre-versioning db migrates it and re-keys non-canonical paths", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "sub"));
  const dbPath = path.join(dir, "claims.db");
  const db = new DatabaseSync(dbPath);
  // Exactly the v0.3.0 schema, with a row stored under a `..` spelling.
  db.exec(`
    CREATE TABLE claims (file_path TEXT PRIMARY KEY, issue_id TEXT NOT NULL, session_id TEXT NOT NULL,
      pid INTEGER, hostname TEXT NOT NULL, claimed_at INTEGER NOT NULL, ttl_seconds INTEGER NOT NULL);
    CREATE INDEX idx_claims_issue ON claims(issue_id);
  `);
  db.prepare("INSERT INTO claims VALUES (?, 'ENG-1', 'session-a', NULL, ?, ?, 3600)").run(
    path.join(dir, "sub") + "/../a.js",
    os.hostname(),
    Math.floor(Date.now() / 1000)
  );
  db.close();

  const store = new ClaimStore(dbPath);
  assert.equal(store.schemaVersion(), 1);
  const claim = store.check(path.join(dir, "a.js"));
  assert.ok(claim, "old row under a `..` key is invisible after upgrade");
  assert.equal(claim.session_id, "session-a");
  store.close();
});

test("file paths and ids are bound as parameters, never spliced into SQL", () => {
  const { store } = tmpStore();
  const evil = "/repo/x'); DROP TABLE claims; --.js";
  store.claim("ENG-1'--", [evil], "session-a");
  assert.equal(store.check(evil).issue_id, "ENG-1'--");
  assert.equal(store.status().length, 1);
  store.close();
});

test("releaseSession() releases every claim of a session, by full id or unique prefix", () => {
  const { store } = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "aaaa1111-x");
  store.claim("ENG-2", ["/repo/b.js"], "aaaa1111-x");
  store.claim("ENG-3", ["/repo/c.js"], "aaaa2222-y");
  assert.throws(() => store.releaseSession("aaaa"), /ambiguous/);
  const r = store.releaseSession("aaaa1111");
  assert.equal(r.session_id, "aaaa1111-x");
  assert.deepEqual(r.released.sort(), ["/repo/a.js", "/repo/b.js"]);
  assert.equal(store.status().length, 1);
  assert.deepEqual(store.releaseSession("nope").released, []);
  store.close();
});

test("re-claiming a file you already own refreshes its TTL clock", () => {
  const { store } = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 100);
  store.db.prepare("UPDATE claims SET claimed_at = claimed_at - 50").run();
  const before = store.check("/repo/a.js").claimed_at;
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 100);
  assert.ok(store.check("/repo/a.js").claimed_at > before);
  store.close();
});

test("gc() reaps expired claims and reports them", () => {
  const { store } = tmpStore();
  store.claim("ENG-1", ["/repo/a.js"], "session-a", 100, undefined, null);
  store.db.prepare("UPDATE claims SET claimed_at = claimed_at - 1000").run();
  assert.deepEqual(store.gc(), ["/repo/a.js"]);
  store.close();
});

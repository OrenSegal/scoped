import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DEFAULT_TTL_SECONDS, dbPath as configuredDbPath } from "./config.mjs";
import { canonicalPath } from "./paths.mjs";

const HOSTNAME = os.hostname();

// Bump when the claims table changes, and add a step to MIGRATIONS that takes a db from the
// previous version to this one. A db stamped with a higher number was written by a newer
// scoped; opening it with this one is refused rather than guessed at.
export const SCHEMA_VERSION = 1;

const MIGRATIONS = {
  // v0 (scoped <= 0.3.0, no user_version) -> v1: same table, but v0 stored absolute paths
  // as given (no `..` collapsing, no realpath). Re-key those rows so a claim made before the
  // upgrade still blocks a check made after it, instead of going invisible for up to 4h.
  1(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        file_path   TEXT PRIMARY KEY,
        issue_id    TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        pid         INTEGER,
        hostname    TEXT NOT NULL,
        claimed_at  INTEGER NOT NULL,
        ttl_seconds INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claims_issue ON claims(issue_id);
      CREATE INDEX IF NOT EXISTS idx_claims_session ON claims(session_id);
    `);
    const rows = db.prepare(`SELECT file_path FROM claims ORDER BY claimed_at ASC`).all();
    const exists = db.prepare(`SELECT 1 FROM claims WHERE file_path = ?`);
    const rekey = db.prepare(`UPDATE claims SET file_path = ? WHERE file_path = ?`);
    const drop = db.prepare(`DELETE FROM claims WHERE file_path = ?`);
    for (const { file_path } of rows) {
      let key;
      try {
        key = canonicalPath(file_path);
      } catch {
        continue;
      }
      if (key === file_path) continue;
      // Two old spellings of one file: the earlier claim already holds the canonical key.
      if (exists.get(key)) drop.run(file_path);
      else rekey.run(key, file_path);
    }
  },
};

export class SchemaError extends Error {}

export class ClaimStore {
  constructor(dbFile = configuredDbPath()) {
    if (dbFile !== ":memory:") fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.path = dbFile;
    this.db = new DatabaseSync(dbFile);
    try {
      // Hook processes and the MCP server write to this file from separate processes. Without a
      // busy timeout, a writer that finds the db locked fails immediately with SQLITE_BUSY
      // instead of waiting its turn (5s, well inside the hook's timeout in hooks.json).
      this.db.exec("PRAGMA busy_timeout = 5000");
      this._migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  schemaVersion() {
    return this.db.prepare("PRAGMA user_version").get().user_version;
  }

  _migrate() {
    const tooNew = (v) =>
      new SchemaError(
        `${this.path} has schema v${v}, newer than this scoped understands (v${SCHEMA_VERSION}). ` +
          `Upgrade scoped, or set SCOPED_DB to a different file.`
      );
    let v = this.schemaVersion();
    if (v > SCHEMA_VERSION) throw tooNew(v);
    if (v === SCHEMA_VERSION) return;
    this._tx(() => {
      v = this.schemaVersion(); // another process may have migrated while we waited for the lock
      if (v > SCHEMA_VERSION) throw tooNew(v);
      for (let next = v + 1; next <= SCHEMA_VERSION; next++) {
        MIGRATIONS[next](this.db);
        this.db.exec(`PRAGMA user_version = ${next}`);
      }
    });
  }

  // BEGIN IMMEDIATE takes the write lock up front (waiting out busy_timeout), so everything in
  // fn sees one consistent db: no other process can release or reap a row between our INSERT
  // and the SELECT that reads back who holds it. It also makes a multi-file claim all-or-nothing.
  _tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  // Deletes claims that are provably dead: expired by TTL, or (same host + pid no longer running).
  // Cross-host claims can only be reaped by TTL — we have no way to check a remote pid's liveness.
  _reap() {
    const now = Math.floor(Date.now() / 1000);
    const ttlDead = this.db
      .prepare(`DELETE FROM claims WHERE claimed_at + ttl_seconds < ? RETURNING file_path`)
      .all(now)
      .map((r) => r.file_path);

    const localRows = this.db
      .prepare(`SELECT file_path, pid FROM claims WHERE hostname = ? AND pid IS NOT NULL`)
      .all(HOSTNAME);
    const pidDead = localRows.filter((r) => !isPidAlive(r.pid)).map((r) => r.file_path);
    if (pidDead.length) {
      const stmt = this.db.prepare(`DELETE FROM claims WHERE file_path = ?`);
      for (const fp of pidDead) stmt.run(fp);
    }
    return [...ttlDead, ...pidDead];
  }

  // Attempts to claim each file path for issueId/sessionId. Returns { claimed: [...], conflicts: [{file_path, held_by}] }.
  // A file already held by this same sessionId is treated as already-claimed (idempotent), regardless of
  // issue_id, and its TTL clock restarts: re-claiming a file you own is how you keep it.
  //
  // `pid`: defaults to process.pid (this process, running for as long as the caller runs — true for the
  // long-lived MCP server, whose exit is a real liveness signal). Pass pid: null when the caller is a
  // short-lived process (the PreToolUse hook exits right after each call) — a dead hook pid would otherwise
  // get every claim it made reaped on the very next check. Those claims fall back to TTL-only expiry instead.
  claim(issueId, filePaths, sessionId, ttlSeconds = DEFAULT_TTL_SECONDS, cwd, pid = process.pid) {
    const keys = filePaths.map((fp) => canonicalPath(fp, cwd));
    return this._tx(() => {
      this._reap();
      const now = Math.floor(Date.now() / 1000);
      const claimed = [];
      const conflicts = [];
      // ON CONFLICT DO NOTHING keeps check-and-insert to one statement, and the surrounding write
      // transaction keeps the read-back below consistent with it.
      const insert = this.db.prepare(`
        INSERT INTO claims (file_path, issue_id, session_id, pid, hostname, claimed_at, ttl_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO NOTHING
      `);
      const select = this.db.prepare(`SELECT issue_id, session_id FROM claims WHERE file_path = ?`);
      const refresh = this.db.prepare(`UPDATE claims SET claimed_at = ? WHERE file_path = ? AND session_id = ?`);
      for (const fp of keys) {
        if (insert.run(fp, issueId, sessionId, pid, HOSTNAME, now, ttlSeconds).changes === 1) {
          claimed.push(fp);
          continue;
        }
        const existing = select.get(fp);
        if (!existing) {
          // Can't happen while we hold the write lock; if it ever does, the file is free.
          insert.run(fp, issueId, sessionId, pid, HOSTNAME, now, ttlSeconds);
          claimed.push(fp);
        } else if (existing.session_id === sessionId) {
          refresh.run(now, fp, sessionId);
          claimed.push(fp);
        } else {
          conflicts.push({ file_path: fp, held_by: { issue_id: existing.issue_id, session_id: existing.session_id } });
        }
      }
      return { claimed, conflicts };
    });
  }

  // Releases every claim held under issueId. If sessionId is given, only releases that session's claims.
  release(issueId, sessionId = null) {
    return this._tx(() => {
      this._reap();
      const rows = sessionId
        ? this.db.prepare(`DELETE FROM claims WHERE issue_id = ? AND session_id = ? RETURNING file_path`).all(issueId, sessionId)
        : this.db.prepare(`DELETE FROM claims WHERE issue_id = ? RETURNING file_path`).all(issueId);
      return rows.map((r) => r.file_path);
    });
  }

  // Releases every claim a session holds, across issues. Accepts a full session id or a unique
  // prefix (deny messages show the first 8 characters). Throws on an ambiguous prefix.
  releaseSession(sessionOrPrefix) {
    return this._tx(() => {
      const ids = this.db
        .prepare(`SELECT DISTINCT session_id FROM claims WHERE substr(session_id, 1, ?) = ?`)
        .all(sessionOrPrefix.length, sessionOrPrefix)
        .map((r) => r.session_id);
      const id = ids.includes(sessionOrPrefix) ? sessionOrPrefix : ids.length === 1 ? ids[0] : null;
      if (!id && ids.length > 1) {
        throw new Error(`session prefix "${sessionOrPrefix}" is ambiguous: ${ids.join(", ")}`);
      }
      if (!id) return { session_id: null, released: [] };
      const released = this.db
        .prepare(`DELETE FROM claims WHERE session_id = ? RETURNING file_path`)
        .all(id)
        .map((r) => r.file_path);
      return { session_id: id, released };
    });
  }

  // Proves the db accepts a write (doctor): inserts a row and rolls it back. Returns the row count.
  probeWrite() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO claims (file_path, issue_id, session_id, pid, hostname, claimed_at, ttl_seconds) VALUES (?, ?, ?, NULL, ?, 0, 0)")
        .run("\u0000doctor", "doctor", "doctor", HOSTNAME);
    } finally {
      this.db.exec("ROLLBACK");
    }
    return this.db.prepare("SELECT count(*) AS n FROM claims").get().n;
  }

  // Reaps dead claims now and returns their paths.
  gc() {
    return this._tx(() => this._reap());
  }

  // Returns the active claim on a file, or null.
  check(filePath, cwd) {
    const fp = canonicalPath(filePath, cwd);
    this._tx(() => this._reap());
    const row = this.db
      .prepare(`SELECT file_path, issue_id, session_id, claimed_at, ttl_seconds FROM claims WHERE file_path = ?`)
      .get(fp);
    return row ?? null;
  }

  // Full snapshot for the status/digest tool.
  status() {
    this._tx(() => this._reap());
    return this.db
      .prepare(`SELECT file_path, issue_id, session_id, claimed_at, ttl_seconds FROM claims ORDER BY claimed_at DESC`)
      .all();
  }

  close() {
    this.db.close();
  }
}

// kill(pid, 0) sends nothing; it only asks whether the pid exists. EPERM means it exists but
// belongs to another user: alive, not dead.
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_TTL_SECONDS = 4 * 60 * 60; // 4h: long enough for a real session, short enough that a crash self-heals
const HOSTNAME = os.hostname();

function defaultDbPath() {
  const dir = path.join(os.homedir(), ".scoped");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "claims.db");
}

export class ClaimStore {
  constructor(dbPath = defaultDbPath()) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
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
    `);
  }

  // Deletes claims that are provably dead: expired by TTL, or (same host + pid no longer running).
  // Cross-host claims can only be reaped by TTL — we have no way to check a remote pid's liveness.
  _reap() {
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db.prepare(`SELECT file_path, pid, hostname, claimed_at, ttl_seconds FROM claims`).all();
    const dead = [];
    for (const row of rows) {
      const expired = row.claimed_at + row.ttl_seconds < now;
      const deadLocal = row.hostname === HOSTNAME && row.pid != null && !isPidAlive(row.pid);
      if (expired || deadLocal) dead.push(row.file_path);
    }
    if (dead.length) {
      const stmt = this.db.prepare(`DELETE FROM claims WHERE file_path = ?`);
      for (const fp of dead) stmt.run(fp);
    }
    return dead;
  }

  // Attempts to claim each file path for issueId/sessionId. Returns { claimed: [...], conflicts: [{file_path, held_by}] }.
  claim(issueId, filePaths, sessionId, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this._reap();
    const now = Math.floor(Date.now() / 1000);
    const claimed = [];
    const conflicts = [];
    const insert = this.db.prepare(`
      INSERT INTO claims (file_path, issue_id, session_id, pid, hostname, claimed_at, ttl_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const select = this.db.prepare(`SELECT issue_id, session_id FROM claims WHERE file_path = ?`);
    for (const fp of filePaths) {
      const existing = select.get(fp);
      if (existing) {
        if (existing.session_id === sessionId && existing.issue_id === issueId) {
          claimed.push(fp); // idempotent: same session re-claiming its own file
        } else {
          conflicts.push({ file_path: fp, held_by: { issue_id: existing.issue_id, session_id: existing.session_id } });
        }
        continue;
      }
      insert.run(fp, issueId, sessionId, process.pid, HOSTNAME, now, ttlSeconds);
      claimed.push(fp);
    }
    return { claimed, conflicts };
  }

  // Releases every claim held under issueId. If sessionId is given, only releases that session's claims.
  release(issueId, sessionId = null) {
    this._reap();
    const rows = sessionId
      ? this.db.prepare(`SELECT file_path FROM claims WHERE issue_id = ? AND session_id = ?`).all(issueId, sessionId)
      : this.db.prepare(`SELECT file_path FROM claims WHERE issue_id = ?`).all(issueId);
    const del = sessionId
      ? this.db.prepare(`DELETE FROM claims WHERE issue_id = ? AND session_id = ?`)
      : this.db.prepare(`DELETE FROM claims WHERE issue_id = ?`);
    del.run(...(sessionId ? [issueId, sessionId] : [issueId]));
    return rows.map((r) => r.file_path);
  }

  // Returns the active claim on a file, or null.
  check(filePath) {
    this._reap();
    const row = this.db
      .prepare(`SELECT file_path, issue_id, session_id, claimed_at, ttl_seconds FROM claims WHERE file_path = ?`)
      .get(filePath);
    return row ?? null;
  }

  // Full snapshot for the status/digest tool.
  status() {
    this._reap();
    const rows = this.db
      .prepare(`SELECT file_path, issue_id, session_id, claimed_at, ttl_seconds FROM claims ORDER BY claimed_at DESC`)
      .all();
    return rows;
  }

  close() {
    this.db.close();
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

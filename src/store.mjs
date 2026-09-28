import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_TTL_SECONDS = 4 * 60 * 60; // 4h: long enough for a real session, short enough that a crash self-heals
const HOSTNAME = os.hostname();

// The PreToolUse hook and the MCP tools are separate processes with separate working
// directories. Both must key claims on the same string for the same file, or a claim made
// one way is invisible to a check made the other way. Absolute paths are that common key —
// callers may pass relative paths (resolved against `cwd`), but everything is stored absolute.
function normalize(filePath, cwd) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd ?? process.cwd(), filePath);
}

function defaultDbPath() {
  const dir = path.join(os.homedir(), ".scoped");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "claims.db");
}

export class ClaimStore {
  constructor(dbPath = defaultDbPath()) {
    this.db = new DatabaseSync(dbPath);
    // Hook processes and the MCP server write to this file from separate processes. Without a
    // busy timeout, a writer that finds the db locked fails immediately with SQLITE_BUSY
    // ("database is locked") instead of waiting its turn, and the hook fails open on that error.
    this.db.exec("PRAGMA busy_timeout = 5000");
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
  // TTL expiry is one indexed DELETE regardless of table size. Pid-liveness needs a per-row
  // syscall, so it only scans this host's still-live-by-TTL rows, not the whole table.
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
  // issue_id — a session's own ownership is what matters for collision safety, not which issue it's filed under.
  //
  // `pid`: defaults to process.pid (this process, running for as long as the caller runs — true for the
  // long-lived MCP server, whose exit is a real liveness signal). Pass pid: null when the caller is a
  // short-lived process (the PreToolUse hook exits right after each call) — a dead hook pid would otherwise
  // get every claim it made reaped on the very next check. Those claims fall back to TTL-only expiry instead.
  claim(issueId, filePaths, sessionId, ttlSeconds = DEFAULT_TTL_SECONDS, cwd, pid = process.pid) {
    this._reap();
    const now = Math.floor(Date.now() / 1000);
    const claimed = [];
    const conflicts = [];
    // ON CONFLICT DO NOTHING makes the check-and-insert atomic in one statement — two hook
    // processes racing on the same file_path can no longer both see "unclaimed" and both insert.
    // Exactly one INSERT wins (changes === 1); the loser reads back who actually holds it.
    const insert = this.db.prepare(`
      INSERT INTO claims (file_path, issue_id, session_id, pid, hostname, claimed_at, ttl_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO NOTHING
    `);
    const select = this.db.prepare(`SELECT issue_id, session_id FROM claims WHERE file_path = ?`);
    for (const rawFp of filePaths) {
      const fp = normalize(rawFp, cwd);
      const result = insert.run(fp, issueId, sessionId, pid, HOSTNAME, now, ttlSeconds);
      if (result.changes === 1) {
        claimed.push(fp);
        continue;
      }
      // Lost the race (or it already existed before this call) — read back the actual owner.
      const existing = select.get(fp);
      if (existing.session_id === sessionId) {
        claimed.push(fp); // idempotent: same session already owns this file
      } else {
        conflicts.push({ file_path: fp, held_by: { issue_id: existing.issue_id, session_id: existing.session_id } });
      }
    }
    return { claimed, conflicts };
  }

  // Bumps claimed_at to now for a file this session already owns, extending its TTL without touching pid
  // tracking. The hook calls this on every edit to a file it already claimed, so an actively-worked file
  // never expires mid-session while an abandoned one still ages out.
  touch(filePath, sessionId, cwd) {
    const fp = normalize(filePath, cwd);
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`UPDATE claims SET claimed_at = ? WHERE file_path = ? AND session_id = ?`).run(now, fp, sessionId);
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
  check(filePath, cwd) {
    this._reap();
    const fp = normalize(filePath, cwd);
    const row = this.db
      .prepare(`SELECT file_path, issue_id, session_id, claimed_at, ttl_seconds FROM claims WHERE file_path = ?`)
      .get(fp);
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

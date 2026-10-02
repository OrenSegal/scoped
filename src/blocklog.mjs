// Append-only log of every edit the hook denied, so `scoped report` can show what the lock
// actually prevented instead of anyone guessing. One line per deny:
//
//   epoch <TAB> tool <TAB> file path <TAB> requesting session (8 chars) <TAB> holding session (8) <TAB> holder's issue
//
// Never file contents or edit payloads: tool_input carries the text being written, which can
// hold secrets. Default ~/.scoped/blocks.tsv; SCOPED_LOG=<path> moves it, SCOPED_LOG=off disables.

import fs from "node:fs";
import path from "node:path";
import { blockLogPath } from "./config.mjs";

const clean = (s) => String(s ?? "").replace(/[\t\r\n]/g, " ");

export function appendBlock({ tool, file, requester, holder, issue }) {
  const log = blockLogPath();
  if (!log) return;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const line = [Math.floor(Date.now() / 1000), tool, file, String(requester).slice(0, 8), String(holder).slice(0, 8), issue].map(clean).join("\t");
    fs.appendFileSync(log, line + "\n");
  } catch {
    // Observability must never break enforcement.
  }
}

export function readBlocks(days = 30, log = blockLogPath()) {
  if (!log || !fs.existsSync(log)) return [];
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = [];
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    const [ts, tool, file, requester, holder, issue] = line.split("\t");
    if (!/^\d+$/.test(ts ?? "") || Number(ts) < cutoff || !file) continue;
    rows.push({ ts: Number(ts), tool, file, requester, holder, issue });
  }
  return rows;
}

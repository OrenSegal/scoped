// Runtime checks every entry point runs before it touches node:sqlite. Imported statically,
// node:sqlite fails at module-link time with ERR_UNKNOWN_BUILTIN_MODULE and a stack trace,
// before any of our code runs; probing with a dynamic import turns that into one sentence.
//
// Keep this file free of syntax newer than Node 18 so the message reaches people on old Nodes.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { minNode } from "./config.mjs";

export async function sqliteProblem() {
  try {
    await import("node:sqlite");
    return null;
  } catch (err) {
    return (
      `node:sqlite is unavailable in Node ${process.version} (${err.code || err.message}). ` +
      `scoped needs Node >= ${minNode()} (or >= 23.4 on the odd line), where node:sqlite needs no flag. ` +
      `Upgrade the \`node\` on Claude Code's PATH.`
    );
  }
}

export async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

// Atomically marks `key` as seen and returns true if this caller is the first to do so within
// `windowMs`. Used to say something once per session even when the same hook runs twice in
// parallel (plugin and settings.json both registering it). Lives in the OS temp dir so it
// works when HOME is not writable; on any fs error it answers true (better a repeat than silence).
export function firstWithin(key, windowMs) {
  const marker = path.join(os.tmpdir(), `scoped-once-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`);
  try {
    fs.writeFileSync(marker, String(Date.now()), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") return true;
  }
  try {
    const age = Date.now() - fs.statSync(marker).mtimeMs;
    if (age < windowMs) return false;
    fs.writeFileSync(marker, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

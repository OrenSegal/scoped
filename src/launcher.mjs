// Starts the MCP server from a plugin checkout. A plugin checkout has no node_modules and may
// be read-only, and Claude Code replaces it on every plugin update, so the two runtime
// dependencies are installed once into ${CLAUDE_PLUGIN_DATA}/deps/<hash>/ (persistent across
// updates; ~/.scoped/deps when an older Claude Code does not set it), keyed by a hash of the
// lockfile so a new version gets a fresh install and an unchanged one reuses it.
//
// Install is crash- and race-safe: npm runs in a private temp dir that is renamed into place
// only after it completed and the packages are present; a second session starting at the same
// moment either wins the rename or adopts the winner's copy. npm's output goes to stderr,
// because stdout is the MCP transport. Every failure is one sentence on stderr and exit 1.
//
// Keep this file free of syntax newer than Node 18 so old Nodes reach the version message.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataDir } from "./config.mjs";
import { sqliteProblem } from "./runtime.mjs";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, "..");
const STALE_MS = 24 * 3600 * 1000;

class LaunchError extends Error {}
// Throws rather than exiting, so the `finally` that removes a half-done install still runs.
const die = (msg) => {
  throw new LaunchError(msg);
};

function hasDeps(dir) {
  const nm = path.join(dir, "node_modules");
  return fs.existsSync(path.join(nm, "@modelcontextprotocol", "sdk", "package.json")) && fs.existsSync(path.join(nm, "zod", "package.json"));
}

export function depsBase(env = process.env) {
  return path.join(env.CLAUDE_PLUGIN_DATA || dataDir(), "deps");
}

export function depsKey(root = ROOT) {
  const h = crypto.createHash("sha256");
  for (const f of ["package-lock.json", "src/deps.mjs"]) h.update(fs.readFileSync(path.join(root, f)));
  h.update(process.versions.modules); // a new Node ABI gets its own copy
  return h.digest("hex").slice(0, 16);
}

const complete = (dir) => fs.existsSync(path.join(dir, ".complete")) && hasDeps(dir);

function prune(base, keep) {
  let entries = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === keep) continue;
    const p = path.join(base, name);
    try {
      // Another session may still be running from an older install; only reclaim old ones.
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function install(base, key) {
  const target = path.join(base, key);
  if (complete(target)) return target;

  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (err) {
    die(`cannot create ${base} for its dependencies (${err.code || err.message}). Set CLAUDE_PLUGIN_DATA or SCOPED_HOME to a writable directory.`);
  }
  const work = fs.mkdtempSync(path.join(base, `.tmp-${key}-`));
  try {
    for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(work, f));
    fs.copyFileSync(path.join(SRC, "deps.mjs"), path.join(work, "deps.mjs"));

    console.error(`[scoped] first start: installing the MCP server's dependencies into ${target}`);
    const win = process.platform === "win32";
    const r = spawnSync(win ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: work,
      stdio: ["ignore", 2, 2],
      shell: win,
      timeout: 5 * 60 * 1000,
    });
    if (r.error && r.error.code === "ENOENT") {
      die(`npm was not found on PATH. It is needed once, to install 2 packages into ${base}. Install Node.js with npm, or run \`npm ci --omit=dev\` in ${ROOT}.`);
    }
    if (r.error || r.status !== 0 || !hasDeps(work)) {
      const why = r.error ? r.error.message : r.status !== 0 ? `exit ${r.status}` : "packages missing after install";
      die(`npm ci failed (${why}). If this machine is offline, connect once so scoped can install its 2 dependencies; they are cached in ${base} after that.`);
    }
    fs.writeFileSync(path.join(work, ".complete"), new Date().toISOString());
    try {
      fs.renameSync(work, target);
    } catch (err) {
      if (!complete(target)) die(`could not move the installed dependencies into ${target} (${err.code || err.message}).`);
      // Another session installed the same key first; use theirs.
    }
    prune(base, key);
    return target;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function main() {
  let dir = null;
  try {
    const problem = await sqliteProblem();
    if (problem) die(problem);
    if (!hasDeps(ROOT)) dir = install(depsBase(), depsKey());
  } catch (err) {
    console.error(`[scoped] MCP server not started: ${err instanceof LaunchError ? err.message : process.env.SCOPED_DEBUG ? err.stack : err.message}`);
    process.exit(1);
  }
  if (dir) {
    process.env.SCOPED_DEPS_DIR = dir;
    try {
      fs.utimesSync(dir, new Date(), new Date()); // in use: keep prune() away from it
    } catch {
      // read-only data dir: harmless
    }
  }
  await import(pathToFileURL(path.join(SRC, "index.mjs")).href);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Store implementation under test. SCOPED_STORE_UNDER_TEST lets you point the race at a
// scratch copy of another implementation (for example the pre-73b3f17 check-then-insert
// claim()) to confirm this test can fail. Normal runs use src/store.mjs.
const STORE_PATH = process.env.SCOPED_STORE_UNDER_TEST
  ? path.resolve(process.env.SCOPED_STORE_UNDER_TEST)
  : path.join(__dirname, "..", "src", "store.mjs");

const WORKERS = 8;
const ROUNDS = 20;

// Each worker is a separate OS process with its own SQLite connection to the shared db file.
// It opens the store, prints "ready", waits for a line on stdin, then calls claim() once and
// prints the outcome. The parent only sends "go" after every worker is ready, so the claim()
// calls start as close together as the OS allows. Inlined (instead of a file under test/)
// because `node --test` runs every .mjs under test/ as a test file.
const WORKER_SOURCE = `
const [storeUrl, dbPath, sessionId, filePath] = process.argv.slice(1);
const { ClaimStore } = await import(storeUrl);
const store = new ClaimStore(dbPath);
process.stdout.write("ready\\n");
process.stdin.once("data", () => {
  let out;
  try {
    const r = store.claim("ENG-RACE", [filePath], sessionId, undefined, undefined, null);
    out = { ok: true, claimed: r.claimed.length, conflicts: r.conflicts.length };
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  store.close();
  process.stdout.write(JSON.stringify(out) + "\\n");
});
`;

function startWorker(dbPath, sessionId, filePath) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", WORKER_SOURCE, pathToFileURL(STORE_PATH).href, dbPath, sessionId, filePath],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  let onReady;
  const ready = new Promise((r) => (onReady = r));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.split("\n").find((l) => l.startsWith("{"));
      if (!line) return reject(new Error(`worker ${sessionId} exited ${code} with no result. stderr: ${stderr}`));
      resolve(JSON.parse(line));
    });
  });
  child.stdout.on("data", (d) => {
    stdout += d;
    if (stdout.includes("ready\n")) onReady();
  });
  child.stderr.on("data", (d) => (stderr += d));
  return { child, ready, done };
}

async function race(round) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-race-"));
  const dbPath = path.join(dir, "claims.db");
  // Create the schema once up front so workers race on the claim, not on CREATE TABLE.
  const { ClaimStore } = await import(pathToFileURL(STORE_PATH).href);
  new ClaimStore(dbPath).close();

  const workers = Array.from({ length: WORKERS }, (_, i) => startWorker(dbPath, `session-${round}-${i}`, "/repo/hot.js"));
  await Promise.all(workers.map((w) => w.ready));
  for (const w of workers) w.child.stdin.end("go\n");
  const results = await Promise.all(workers.map((w) => w.done));
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

test(`claim() raced by ${WORKERS} OS processes on one SQLite file: exactly one wins, every round`, async () => {
  for (let round = 0; round < ROUNDS; round++) {
    const results = await race(round);
    const errors = results.filter((r) => !r.ok);
    const wins = results.filter((r) => r.ok && r.claimed === 1);
    const losses = results.filter((r) => r.ok && r.conflicts === 1);
    assert.deepEqual(errors, [], `round ${round}: a claim() threw instead of winning or reporting a conflict`);
    assert.equal(wins.length, 1, `round ${round}: expected exactly 1 winner, got ${wins.length}`);
    assert.equal(losses.length, WORKERS - 1, `round ${round}: expected ${WORKERS - 1} conflicts, got ${losses.length}`);
  }
});

// `scoped`: the human side of the claims db. On PATH while the plugin is enabled (Claude Code
// adds the plugin's bin/ to the Bash tool's PATH), or via `npm link` / `npx scoped`.
//
// Only node: builtins, and node:sqlite is loaded after the version check, so `scoped doctor`
// can explain an old Node instead of crashing on it.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_NODE, SESSION_ID_RE, VERSION, blockLogPath, dbPath } from "./config.mjs";
import { readBlocks } from "./blocklog.mjs";
import { hookRegistrations, mcpRegistrations, pluginRegistrations, HOOK_FILES } from "./registrations.mjs";
import { sqliteProblem } from "./runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `scoped ${VERSION} — file claims between concurrent Claude Code sessions

usage: scoped <command>

  status [--json]          every active claim: file, issue, session, age, time left
  check <file>             who holds <file>; exit 0 if free, 1 if claimed
  release <session>        free every claim a session holds (full id or the 8-char
                           prefix a deny message shows)
  gc                       drop expired claims and claims of dead local processes now
  report [--days=N]        what the hook blocked (default last 30 days) and how to tune
  doctor                   check Node, the db, hook and MCP registration, hook latency
  version

environment: SCOPED_HOME (default ~/.scoped), SCOPED_DB, SCOPED_LOG (path or "off"),
SCOPED_ISSUE_ID, SCOPED_FAIL_CLOSED=1, SCOPED_HOOK_MS (doctor's latency budget), SCOPED_DEBUG`;

class UsageError extends Error {}

const out = (s = "") => process.stdout.write(s + "\n");

async function openStore() {
  const problem = await sqliteProblem();
  if (problem) throw new Error(problem);
  const { ClaimStore } = await import("./store.mjs");
  return new ClaimStore();
}

function ago(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

async function withStore(fn) {
  const store = await openStore();
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

const now = () => Math.floor(Date.now() / 1000);

const commands = {
  async status(args) {
    const claims = await withStore((s) => s.status());
    if (args.includes("--json")) return out(JSON.stringify({ active_claims: claims.length, claims }, null, 2));
    if (!claims.length) return out("no active claims");
    const t = now();
    out(
      table(
        claims.map((c) => [c.file_path, c.issue_id, c.session_id.slice(0, 8), ago(t - c.claimed_at), ago(c.claimed_at + c.ttl_seconds - t)]),
        ["FILE", "ISSUE", "SESSION", "AGE", "LEFT"]
      )
    );
    out(`\n${claims.length} claim(s), ${new Set(claims.map((c) => c.session_id)).size} session(s)`);
  },

  async check([file]) {
    if (!file) throw new UsageError("usage: scoped check <file>");
    const claim = await withStore((s) => s.check(file, process.cwd()));
    if (!claim) return out(`free: ${file}`);
    const t = now();
    out(
      `claimed: ${claim.file_path}\n  issue ${claim.issue_id}, session ${claim.session_id.slice(0, 8)}, ` +
        `${ago(t - claim.claimed_at)} ago, expires in ${ago(claim.claimed_at + claim.ttl_seconds - t)}\n` +
        `  free it with: scoped release ${claim.session_id.slice(0, 8)}`
    );
    return 1;
  },

  async release([session]) {
    if (!session) throw new UsageError("usage: scoped release <session id or 8-char prefix>");
    if (!SESSION_ID_RE.test(session) || session.length < 4) throw new UsageError(`"${session}" is not a session id or a prefix of at least 4 characters`);
    const { session_id, released } = await withStore((s) => s.releaseSession(session));
    if (!session_id) {
      out(`no claims held by a session matching "${session}"`);
      return 1;
    }
    out(`released ${released.length} claim(s) held by ${session_id}`);
    for (const f of released) out(`  ${f}`);
  },

  async gc() {
    const reaped = await withStore((s) => s.gc());
    out(`reaped ${reaped.length} dead claim(s)`);
    for (const f of reaped) out(`  ${f}`);
  },

  async report(args) {
    const days = Number((args.find((a) => a.startsWith("--days=")) ?? "--days=30").slice(7));
    if (!Number.isFinite(days) || days <= 0) throw new UsageError("--days must be a positive number");
    const log = blockLogPath();
    if (!log) return out("block log is off (SCOPED_LOG=off): nothing to report");
    const rows = readBlocks(days, log);
    out(`scoped report: last ${days} day(s), ${log}`);
    if (!rows.length) return out("\nno blocked edits. Either sessions are not colliding, or nothing is enforcing: run `scoped doctor`.");
    const top = (key, n = 10) => {
      const counts = new Map();
      for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
    };
    out(`\n${rows.length} blocked edit(s) across ${new Set(rows.map((r) => r.file)).size} file(s)\n`);
    out(table(top((r) => r.file).map(([f, n]) => [n, f]), ["BLOCKS", "FILE"]));
    out("");
    out(table(top((r) => `${r.requester} -> ${r.holder}`).map(([p, n]) => [n, p]), ["BLOCKS", "BLOCKED -> HOLDER"]));
    out("");
    out(table(top((r) => r.issue).map(([i, n]) => [n, i]), ["BLOCKS", "HOLDER'S ISSUE"]));
    out(
      "\nTuning guide:\n" +
        "  - One file blocked again and again: two issues share it. Split the work, or let one\n" +
        "    session finish and release it before the other starts.\n" +
        "  - Holder is an adhoc:* bucket: that session ran without SCOPED_ISSUE_ID; set it so\n" +
        "    claims and blocks say which issue they belong to.\n" +
        "  - Holder was a session that had already finished: its claim lives until the TTL\n" +
        "    (4h) runs out. `scoped release <session>` frees it now; ask agents to call the\n" +
        "    release tool when they finish.\n" +
        "  - Blocks you consider false positives (generated files, lockfiles): those are real\n" +
        "    concurrent writes; serialize them rather than exempting them."
    );
  },

  doctor,

  version() {
    out(VERSION);
  },

  help() {
    out(HELP);
  },
};

// ---- doctor ---------------------------------------------------------------------------------

function mcpProbe(timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "scoped-mcp")], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const send = (msg) => !done && child.stdin.write(JSON.stringify(msg) + "\n");
    const timer = setTimeout(() => finish({ ok: false, why: `no answer in ${timeoutMs / 1000}s` }), timeoutMs);
    child.stdin.on("error", () => {}); // the server exiting early is reported via "close"
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while (!done && (i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish({ ok: false, why: `non-JSON on stdout: ${line.slice(0, 80)}` });
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (msg.id === 2) return finish({ ok: true, tools: (msg.result?.tools ?? []).map((t) => t.name) });
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => finish({ ok: false, why: `exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}` }));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "scoped-doctor", version: VERSION } } });
  });
}

function hookLatency() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-doctor-"));
  try {
    const payload = JSON.stringify({ session_id: "scoped-doctor", tool_name: "Edit", tool_input: { file_path: path.join(dir, "probe.txt") }, cwd: dir });
    const env = { ...process.env, SCOPED_DB: path.join(dir, "claims.db"), SCOPED_LOG: "off" };
    const times = [];
    let last;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      last = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pretool-enforce.mjs")], { input: payload, env, encoding: "utf8", timeout: 15000 });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return { ms: Math.round(times.sort((a, b) => a - b)[1]), result: last };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const cmpVersion = (a, b) => {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

async function doctor() {
  let failed = 0;
  const report = (level, msg) => {
    if (level === "FAIL") failed++;
    out(`${level.padEnd(5)} ${msg}`);
  };

  out(`scoped ${VERSION} doctor (${ROOT})\n`);

  // Node
  const problem = await sqliteProblem();
  if (problem) report("FAIL", problem);
  else if (cmpVersion(process.version, MIN_NODE) < 0) report("warn", `Node ${process.version} has node:sqlite, but scoped is tested on >= ${MIN_NODE}`);
  else report("ok", `Node ${process.version}, node:sqlite available`);

  // Claims db
  if (!problem) {
    try {
      const { SCHEMA_VERSION } = await import("./store.mjs");
      await withStore((s) => {
        const v = s.schemaVersion();
        s.db.exec("BEGIN IMMEDIATE");
        try {
          s.db.prepare("INSERT INTO claims (file_path, issue_id, session_id, pid, hostname, claimed_at, ttl_seconds) VALUES (?, ?, ?, NULL, ?, 0, 0)").run("\u0000doctor", "doctor", "doctor", os.hostname());
        } finally {
          s.db.exec("ROLLBACK");
        }
        const n = s.db.prepare("SELECT count(*) AS n FROM claims").get().n;
        report(v === SCHEMA_VERSION ? "ok" : "FAIL", `claims db ${s.path}: writable, schema v${v}, ${n} row(s)`);
      });
    } catch (err) {
      report("FAIL", `claims db ${dbPath()}: ${err.message}`);
    }
  }

  // Registration
  const cwd = process.cwd();
  const plugins = pluginRegistrations(cwd);
  const pluginIds = [...new Set(plugins.map((p) => p.id))];
  const viaPlugin = pluginIds.length ? 1 : 0;
  if (pluginIds.length) report("ok", `plugin: ${pluginIds.join(", ")}`);
  const hooks = hookRegistrations(cwd);
  for (const event of Object.keys(HOOK_FILES)) {
    const extra = hooks.filter((h) => h.event === event);
    const total = viaPlugin + extra.length;
    const where = [...(viaPlugin ? ["plugin"] : []), ...extra.map((h) => `${h.scope} settings: ${h.command}`)].join("; ");
    if (total === 1) report("ok", `${event} hook registered once (${where})`);
    else if (total === 0) report("FAIL", `${event} hook is not registered: install the plugin, or run \`npm run setup\` in a checkout`);
    else report("FAIL", `${event} hook registered ${total} times (${where}). Keep one: \`npm run uninstall\` in the checkout, or remove the plugin`);
  }
  const allMcps = mcpRegistrations(cwd);
  for (const m of allMcps.filter((m) => m.pluginOnly)) {
    report("warn", `${m.scope} MCP server 'scoped' in ${m.file} uses \${CLAUDE_PLUGIN_ROOT}, which is only set inside a plugin, so it cannot start; remove it`);
  }
  const mcps = allMcps.filter((m) => !m.pluginOnly);
  const mcpTotal = viaPlugin + mcps.length;
  const mcpWhere = [...(viaPlugin ? ["plugin"] : []), ...mcps.map((m) => `${m.scope}: ${m.file}`)].join("; ");
  if (mcpTotal === 1) report("ok", `MCP server registered once (${mcpWhere})`);
  else if (mcpTotal === 0) report("FAIL", "MCP server 'scoped' is not registered");
  else report("warn", `MCP server 'scoped' registered ${mcpTotal} times (${mcpWhere}); Claude Code keeps one, but remove the extra`);

  // MCP server reachable
  if (!problem) {
    const probe = await mcpProbe(Number(process.env.SCOPED_MCP_TIMEOUT_MS) || 60000);
    if (probe.ok && ["check", "claim", "release", "status"].every((t) => probe.tools.includes(t))) report("ok", `MCP server answers initialize and tools/list (${probe.tools.join(", ")})`);
    else report("FAIL", `MCP server not reachable via ${path.join(ROOT, "bin", "scoped-mcp")}: ${probe.ok ? `tools: ${probe.tools.join(", ")}` : probe.why}`);
  }

  // Hook latency
  if (!problem) {
    const budget = Number(process.env.SCOPED_HOOK_MS) || 1000;
    const { ms, result } = hookLatency();
    if (result.status !== 0 || result.stdout) report("FAIL", `PreToolUse hook probe misbehaved (exit ${result.status}): ${(result.stdout + result.stderr).trim().slice(0, 200)}`);
    else report(ms <= budget ? "ok" : "warn", `PreToolUse hook takes ${ms}ms per edit (budget ${budget}ms, SCOPED_HOOK_MS; hook timeout 15s)`);
  }

  // Policy and observability
  report("ok", process.env.SCOPED_FAIL_CLOSED === "1" ? "fail-closed: an internal hook error blocks the edit" : "fail-open: an internal hook error allows the edit and warns once per session");
  const log = blockLogPath();
  if (!log) report("ok", "block log off (SCOPED_LOG=off)");
  else report("ok", `block log ${log}: ${readBlocks(7, log).length} block(s) in the last 7 days (scoped report)`);

  out(failed ? `\n${failed} problem(s).` : "\nall good.");
  return failed ? 1 : 0;
}

export async function main(argv) {
  const [cmd = "help", ...args] = argv;
  const fn = { "--help": commands.help, "-h": commands.help, "--version": commands.version, ...commands }[cmd];
  try {
    if (!fn) throw new UsageError(`unknown command "${cmd}"\n\n${HELP}`);
    const code = await fn(args);
    process.exitCode = typeof code === "number" ? code : 0;
  } catch (err) {
    console.error(`scoped: ${err instanceof UsageError ? err.message : process.env.SCOPED_DEBUG ? err.stack : err.message}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}

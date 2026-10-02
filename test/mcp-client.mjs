// Test helper, not a test file: a minimal MCP stdio client, used by mcp.test.mjs and
// launcher.test.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("SCOPED_") || k === "LINEAR_API_KEY" || k === "CLAUDE_PLUGIN_DATA") delete env[k];
  return { ...env, ...extra };
}

// Speaks newline-delimited JSON-RPC to an MCP server over stdio, the way Claude Code does.
// Every stdout line must be a JSON-RPC message: anything else corrupts the transport.
export function mcpSession(cmd, args, { env = {}, cwd = root } = {}) {
  const child = spawn(cmd, args, { env: cleanEnv(env), cwd, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let stderr = "";
  const lines = [];
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && waiters.has(msg.id)) waiters.get(msg.id)(msg);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) =>
    child.on("close", (code) => {
      // A server that dies mid-session fails the waiting request now, not at its timeout.
      for (const w of waiters.values()) w({ error: { message: `server exited ${code}; stderr: ${stderr}` } });
      waiters.clear();
      r(code);
    })
  );
  let nextId = 1;
  const request = (method, params = {}, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), timeoutMs);
      waiters.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const initialize = async () => {
    const r = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "scoped-test", version: "0" } });
    notify("notifications/initialized");
    return r;
  };
  const call = (name, args) => request("tools/call", { name, arguments: args });
  const close = async () => {
    child.stdin.end();
    const t = setTimeout(() => child.kill(), 5000);
    const code = await exited;
    clearTimeout(t);
    return code;
  };
  return { child, request, initialize, call, close, exited, lines, stderr: () => stderr };
}

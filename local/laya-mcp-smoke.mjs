// Real MCP -> local Laya verification. Start local/laya_server.py first.
// Run: node --env-file=.env local/laya-mcp-smoke.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BACKEND, API_URL } from "../src/jev.mjs";

assert.equal(BACKEND, "laya", "Set JEV_BACKEND=laya or load .env with --env-file");
const healthUrl = new URL("/health", API_URL);
const health = async () => {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, "Laya server must be ready");
  const result = await response.json();
  assert.equal(typeof result.inference_completed, "number", "Restart Laya to enable inference counters");
  return result;
};
const server = fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url));
const client = new Client({ name: "laya-mcp-smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server],
  env: { ...process.env, JEV_BACKEND: "laya", JEV_API_URL: API_URL, JEV_CACHE: "0", JEV_BROWSER_PROFILE: "" } }));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, result.content[0]?.text);
  return result.content[0].text;
};
try {
  const before = await health();
  const opened = JSON.parse(await call("browser_open", { url: "https://demo.playwright.dev/todomvc/" }));
  assert.equal(opened.backend, "laya");
  assert.equal(opened.decision_endpoint, API_URL);
  assert.equal(opened.cache_enabled, false);
  const started = Date.now();
  const step = {
    goal: "Enter the supplied todo text into the 'What needs to be done?' field without submitting it",
    values: { todo: "laya mcp verified" }, max_actions: 4,
    verify: { field: { label: "What needs to be done?", value_key: "todo" } },
  };
  const usePlan = process.argv.includes("--plan");
  const result = JSON.parse(await call(usePlan ? "browser_run" : "browser_do", usePlan ? {
    steps: [{ ...step, values: { todo: "laya serial step one" } }, step],
  } : { goal: step.goal, values: step.values, max_actions: step.max_actions }));
  assert.equal(result.backend, "laya");
  assert.ok(result.decision_calls > 0);
  assert.equal(result.status, "done");
  if (usePlan) assert.equal(result.completed, 2, "Both steps must execute in one MCP call");
  const snapshot = await call("browser_snapshot");
  assert.match(snapshot, /value="laya mcp verified"/);
  const after = await health();
  assert.ok(after.inference_completed - before.inference_completed >= result.decision_calls,
    "MCP decisions must have reached the real Laya inference server");
  console.log(JSON.stringify({ passed: true, backend: result.backend, endpoint: API_URL,
    laya_pid: after.pid, completed: result.completed, decision_calls: result.decision_calls,
    server_inferences: after.inference_completed - before.inference_completed,
    last_inference_ms: after.last_inference_ms, last_inference_cpu_ms: after.last_inference_cpu_ms }, null, 2));
  try {
    const monitor = await (await fetch("http://127.0.0.1:8792/metrics", { signal: AbortSignal.timeout(2000) })).json();
    if (monitor?.pid === after.pid) {
      const samples = monitor.history.filter(s => s.timestamp >= started);
      if (samples.length) console.log(JSON.stringify({ monitor: "http://127.0.0.1:8792", peak_cpu_percent: Math.max(...samples.map(s => s.cpu)), ram_mb: monitor.rssMb }, null, 2));
    }
  } catch { /* the monitor is optional */ }
} finally {
  try { await call("browser_close"); } finally { await client.close(); }
}

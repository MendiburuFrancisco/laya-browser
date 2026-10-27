import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { loadExecutorConfig } from "../src/executor/config.mjs";
import { RunStore } from "../src/executor/run-store.mjs";
import { createExecutorServer } from "../src/executor/http-server.mjs";
import { RunQueue } from "../src/executor/queue.mjs";

const token = "test-token-with-at-least-24-characters";
const config = dataDir => ({ token, dataDir, maxBodyBytes: 4096 });

test("executor config requires a long token and validates bounds", () => {
  assert.throws(() => loadExecutorConfig({ EXECUTOR_API_TOKEN: "short" }), /at least 24/);
  const value = loadExecutorConfig({ EXECUTOR_API_TOKEN: token, EXECUTOR_PORT: "9001", EXECUTOR_MAX_QUEUED: "0" });
  assert.equal(value.port, 9001); assert.equal(value.maxQueued, 0);
  assert.throws(() => loadExecutorConfig({ EXECUTOR_API_TOKEN: token, EXECUTOR_PORT: "99999" }), /EXECUTOR_PORT/);
});

test("run store persists idempotency and marks active runs interrupted on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laya-executor-store-"));
  try {
    const store = new RunStore(dir); await store.initialize();
    const run = { runId: "e5f9b72f-51de-4be6-908e-9c2a10eebdb0", suiteId: "demo-form", status: "running", createdAt: new Date().toISOString() };
    await store.create(run, "request-key-001", "fingerprint");
    await assert.rejects(() => new RunStore(dir).initialize(), /already in use/);
    await store.release();
    const restarted = new RunStore(dir); await restarted.initialize();
    assert.equal(restarted.get(run.runId).status, "interrupted");
    const duplicate = await restarted.create({ ...run, runId: "34ec4870-51de-4be6-908e-9c2a10eebdb1" }, "request-key-001", "fingerprint");
    assert.equal(duplicate.existing, true); assert.equal(duplicate.run.runId, run.runId);
    assert.deepEqual(await restarted.create({ ...run, runId: "34ec4870-51de-4be6-908e-9c2a10eebdb1" }, "request-key-001", "other"), { conflict: true });
    await restarted.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("HTTP API enforces bearer auth, strict suites and idempotency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laya-executor-api-"));
  const store = new RunStore(dir); await store.initialize();
  const calls = [];
  const queue = { submit: async (suiteId, key) => {
    if (!["demo-form", "demo-controls", "demo-failure"].includes(suiteId)) return { error: "SUITE_NOT_ALLOWED" };
    calls.push([suiteId, key]);
    const runId = "e5f9b72f-51de-4be6-908e-9c2a10eebdb0";
    const run = store.get(runId) ?? { runId, suiteId, status: "queued", createdAt: new Date().toISOString() };
    if (!store.get(runId)) await store.create(run, key, JSON.stringify({ suiteId }));
    return { run, existing: calls.length > 1 };
  } };
  const { server, setReady } = createExecutorServer({ config: config(dir), store, queue });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); setReady(true);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(base + path, options);
  const auth = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await call("/healthz")).status, 200);
    assert.equal((await call("/v1/suites")).status, 401);
    assert.equal((await call("/v1/suites", { headers: auth })).status, 200);
    const invalid = await call("/v1/runs", { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": "request-key-001" }, body: JSON.stringify({ suiteId: "demo-form", command: "whoami" }) });
    assert.equal(invalid.status, 400);
    const res = await call("/v1/runs", { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": "request-key-001" }, body: JSON.stringify({ suiteId: "demo-form" }) });
    assert.equal(res.status, 202); const accepted = await res.json(); assert.equal(accepted.status, "queued");
    assert.equal((await call(`/v1/runs/${accepted.runId}/results`, { headers: auth })).status, 202);
    await store.update(accepted.runId, { status: "interrupted", finishedAt: new Date().toISOString(), error: { code: "SERVICE_RESTARTED", message: "restart" } });
    const recovered = await call(`/v1/runs/${accepted.runId}/results`, { headers: auth });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).status, "interrupted");
    const dup = await call("/v1/runs", { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": "request-key-001" }, body: JSON.stringify({ suiteId: "demo-form" }) });
    assert.equal(dup.status, 200);
    const unknown = await call("/v1/runs", { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": "request-key-002" }, body: JSON.stringify({ suiteId: "unknown" }) });
    assert.equal(unknown.status, 400);
  } finally { server.close(); await once(server, "close"); await store.release(); await rm(dir, { recursive: true, force: true }); }
});

test("logs paginate and artifact identifiers cannot escape their directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laya-executor-files-"));
  const store = new RunStore(dir); await store.initialize();
  try {
    const runId = "e5f9b72f-51de-4be6-908e-9c2a10eebdb0";
    await store.create({ runId, suiteId: "demo-form", status: "passed", createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }, "request-key-001", "fp");
    await store.appendLog(runId, { seq: 1, message: "first" }, 1000); await store.appendLog(runId, { seq: 2, message: "second" }, 1000);
    const logs = await store.logs(runId, 1, 1); assert.deepEqual(logs.entries.map(e => e.seq), [2]); assert.equal(logs.complete, true);
    const artifacts = join(store.directory(runId), "artifacts"); await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, "sample.txt"), "fixture");
    assert.equal(await store.artifactPath(runId, "sample.txt"), join(artifacts, "sample.txt"));
    assert.equal(await store.artifactPath(runId, "..\\metadata.json"), null);
    const opened = await store.openArtifact(runId, "sample.txt", 10);
    assert.equal(opened.size, 7); assert.equal((await opened.handle.readFile()).toString(), "fixture"); await opened.handle.close();
    await writeFile(join(store.directory(runId), "private.txt"), "private");
    try { await symlink(join(store.directory(runId), "private.txt"), join(artifacts, "escape")); assert.equal(await store.artifactPath(runId, "escape"), null); assert.equal(await store.openArtifact(runId, "escape", 100), null); }
    catch (error) { if (!new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error.code)) throw error; }
  } finally { await store.release(); await rm(dir, { recursive: true, force: true }); }
});

test("queue executes browser fixture and requires verified runner status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laya-executor-run-"));
  const store = new RunStore(dir); await store.initialize();
  const queue = new RunQueue(store, { maxQueued: 10, runTimeoutMs: 15000, shutdownGraceMs: 1000, maxLogBytes: 100000, maxArtifactBytes: 1000000 });
  try {
    const accepted = await queue.submit("demo-form", "request-key-001");
    const runId = accepted.run.runId;
    const deadline = Date.now() + 20000;
    while (["queued", "running"].includes(store.get(runId).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(store.get(runId).status, "passed");
    const result = await store.result(runId);
    assert.equal(result.status, "passed"); assert.deepEqual(result.summary, { total: 1, passed: 1, failed: 0, skipped: 0 });

    const controls = await queue.submit("demo-controls", "request-key-controls");
    const controlsId = controls.run.runId;
    const controlsDeadline = Date.now() + 20000;
    while (["queued", "running"].includes(store.get(controlsId).status) && Date.now() < controlsDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(store.get(controlsId).status, "passed");
    const controlsResult = await store.result(controlsId);
    assert.deepEqual(controlsResult.summary, { total: 2, passed: 2, failed: 0, skipped: 0 });
    assert.ok(controlsResult.cases.every(c => c.frameworkStatus === "done"));

    const intentional = await queue.submit("demo-failure", "request-key-002");
    const failedId = intentional.run.runId;
    const failDeadline = Date.now() + 20000;
    while (["queued", "running"].includes(store.get(failedId).status) && Date.now() < failDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(store.get(failedId).status, "failed");
    const failedResult = await store.result(failedId);
    assert.equal(failedResult.status, "failed"); assert.ok(failedResult.cases.some(c => c.checks.some(item => item.passed === false)));
  } finally { await queue.shutdown(); await store.release(); await rm(dir, { recursive: true, force: true }); }
});

test("executor MCP exposes only run, log and result operations", async () => {
  const client = new Client({ name: "executor-tool-contract", version: "1" });
  const script = fileURLToPath(new URL("../bin/laya-test-executor-mcp.mjs", import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env: { ...process.env, EXECUTOR_API_TOKEN: token } }));
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["tests_logs", "tests_results", "tests_run"]);
    assert.deepEqual(Object.keys(listed.tools.find(tool => tool.name === "tests_run").inputSchema.properties).sort(), ["idempotencyKey", "suiteId"]);
  } finally { await client.close(); }
});

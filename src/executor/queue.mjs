import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { getSuite } from "./catalog.mjs";
import { redactLog } from "./redact.mjs";

const runnerPath = fileURLToPath(new URL("../../bin/laya-test-runner.mjs", import.meta.url));
export class RunQueue {
  constructor(store, config) { this.store = store; this.config = config; this.pending = store.list().filter(run => run.status === "queued").map(run => run.runId); this.active = null; this.activePromise = null; this.currentChild = null; this.stopping = false; this.seq = new Map(); this.submitLock = Promise.resolve(); this.logLocks = new Map(); }
  async submit(suiteId, key) {
    const previous = this.submitLock; let unlock; this.submitLock = new Promise(resolve => { unlock = resolve; }); await previous;
    try {
      if (this.stopping) return { error: "SHUTTING_DOWN" };
      const suite = getSuite(suiteId); if (!suite) return { error: "SUITE_NOT_ALLOWED" };
      const keyHash = createHash("sha256").update(key).digest("hex");
      const fingerprint = createHash("sha256").update(JSON.stringify({ suiteId })).digest("hex");
      const prior = this.store.findIdempotency(keyHash);
      if (prior) return prior.item.fingerprint === fingerprint && prior.run ? { run: prior.run, existing: true } : { error: "IDEMPOTENCY_CONFLICT" };
      if (this.active && this.pending.length >= this.config.maxQueued) return { error: "QUEUE_FULL" };
      const runId = randomUUID(), createdAt = new Date().toISOString();
      const metadata = { runId, suiteId, status: "queued", createdAt, startedAt: null, finishedAt: null, decisionBackend: "fixture", logsTruncated: false };
      const created = await this.store.create(metadata, keyHash, fingerprint);
      if (created.conflict) return { error: "IDEMPOTENCY_CONFLICT" };
      if (created.existing) return { run: created.run, existing: true };
      this.pending.push(runId); void this.pump(); return { run: metadata, existing: false };
    } finally { unlock(); }
  }
  async log(id, level, message) {
    const prior = this.logLocks.get(id) ?? Promise.resolve();
    const next = prior.then(async () => {
      const seq = (this.seq.get(id) ?? 0) + 1; this.seq.set(id, seq);
      await this.store.appendLog(id, { seq, timestamp: new Date().toISOString(), level, message: redactLog(message) }, this.config.maxLogBytes);
    });
    this.logLocks.set(id, next.catch(() => {})); return next;
  }
  async pump() {
    if (this.active || this.stopping) return;
    const id = this.pending.shift(); if (!id) return;
    this.active = id;
    this.activePromise = (async () => {
      try { await this.execute(id); }
      catch (error) {
        await this.log(id, "error", `Executor internal failure: ${error.message}`).catch(() => {});
        if (this.store.get(id)?.status === "running") await this.store.update(id, { status: "failed", finishedAt: new Date().toISOString(), error: { code: "EXECUTOR_INTERNAL_ERROR", message: "Executor could not complete this run" } }).catch(() => {});
      } finally { this.active = null; this.activePromise = null; this.currentChild = null; void this.pump(); }
    })();
    await this.activePromise;
  }
  resume() { void this.pump(); }
  async execute(id) {
    const run = this.store.get(id), suite = getSuite(run?.suiteId); if (!run || !suite || this.stopping) return;
    const dir = this.store.directory(id), artifacts = join(dir, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const startedAt = new Date().toISOString(); await this.store.update(id, { status: "running", startedAt });
    await this.log(id, "info", `Starting suite ${suite.id}`);
    const child = spawn(process.execPath, [runnerPath, suite.id, artifacts], {
      cwd: process.cwd(), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) },
    });
    this.currentChild = child;
    let stdout = "", stderr = "", timedOut = false, outputBytes = 0, failedOutput = false;
    const collect = (stream, target, level) => stream.on("data", chunk => {
      outputBytes += chunk.length;
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      const value = target === "stdout" ? stdout : stderr;
      const parts = value.split("\n"), tail = parts.pop();
      if (target === "stdout") stdout = tail; else stderr = tail;
      for (const part of parts) if (part) void this.log(id, level, part.slice(0, 4000)).catch(() => { failedOutput = true; terminate(child, "SIGTERM"); });
      if (outputBytes > this.config.maxLogBytes * 2 && !failedOutput) { failedOutput = true; terminate(child, "SIGTERM"); }
    });
    collect(child.stdout, "stdout", "info"); collect(child.stderr, "stderr", "warn");
    let forceTimer;
    child.once("close", () => clearTimeout(forceTimer));
    const timer = setTimeout(() => {
      timedOut = true; terminate(child, "SIGTERM");
      forceTimer = setTimeout(() => terminate(child, "SIGKILL"), 2000); forceTimer.unref();
    }, this.config.runTimeoutMs); timer.unref();
    let exit;
    try { exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); }); }
    catch (error) { await this.log(id, "error", `Runner could not start: ${error.message}`); exit = { code: -1 }; }
    finally { clearTimeout(timer); }
    for (const tail of [stdout, stderr]) if (tail.trim()) await this.log(id, "info", tail.slice(0, 4000));
    let result = null;
    try { result = JSON.parse(await readFile(join(dir, "runner-result.json"), "utf8")); } catch { /* runner result missing or invalid */ }
    let finalStatus = timedOut ? "timed_out" : exit.code === 0 && result?.status === "passed" ? "passed" : "failed";
    if (failedOutput && finalStatus === "passed") finalStatus = "failed";
    const finishedAt = new Date().toISOString();
    if (!result || !["passed", "failed"].includes(result.status) || !Array.isArray(result.cases)) {
      result = { schemaVersion: 1, runId: id, suiteId: suite.id, status: "failed", decisionBackend: "fixture", startedAt, finishedAt,
        summary: { total: 0, passed: 0, failed: 1, skipped: 0 }, cases: [], error: { code: "INVALID_RUNNER_RESULT", message: "Runner did not produce a valid result" }, artifacts: [] };
      finalStatus = timedOut ? "timed_out" : "failed";
    }
    result.runId = id; result.suiteId = suite.id; result.startedAt ??= startedAt; result.finishedAt = finishedAt;
    if (this.stopping) finalStatus = "interrupted";
    result.status = finalStatus;
    result.artifacts = await this.listArtifacts(artifacts);
    await writeFile(join(dir, "result.json.tmp"), JSON.stringify(result, null, 2), { mode: 0o600 });
    const { rename } = await import("node:fs/promises"); await rename(join(dir, "result.json.tmp"), join(dir, "result.json"));
    await this.store.update(id, { status: finalStatus, finishedAt, ...(this.stopping ? { error: { code: "SERVICE_SHUTDOWN", message: "Executor shut down during execution" } } : result.error ? { error: result.error } : {}) });
    await this.log(id, finalStatus === "passed" ? "info" : "error", `Suite finished: ${finalStatus}`);
  }
  async listArtifacts(dir) {
    const { readdir } = await import("node:fs/promises"); const out = [];
    for (const name of await readdir(dir)) {
      if (!/^[a-zA-Z0-9._-]{1,120}$/.test(name)) continue;
      const path = join(dir, name); try { const info = await stat(path); if (info.isFile() && info.size <= this.config.maxArtifactBytes) out.push({ id: name, kind: name.endsWith(".webm") ? "video" : "file", contentType: name.endsWith(".webm") ? "video/webm" : "application/octet-stream", sizeBytes: info.size }); } catch {}
    }
    return out;
  }
  async shutdown() {
    this.stopping = true;
    for (const id of this.pending.splice(0)) { await this.store.update(id, { status: "interrupted", finishedAt: new Date().toISOString(), error: { code: "SERVICE_SHUTDOWN", message: "Executor shut down before execution" } }); }
    if (!this.active) return;
    const id = this.active;
    const done = this.activePromise;
    if (this.currentChild) terminate(this.currentChild, "SIGTERM");
    if (done && this.config.shutdownGraceMs) await Promise.race([done, new Promise(r => setTimeout(r, this.config.shutdownGraceMs))]);
    if (this.currentChild) terminate(this.currentChild, "SIGKILL");
    await done;
    if (id && this.store.get(id)?.status === "running") await this.store.update(id, { status: "interrupted", finishedAt: new Date().toISOString(), error: { code: "SERVICE_SHUTDOWN", message: "Executor shut down during execution" } });
  }
}

function terminate(child, signal) {
  try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
}

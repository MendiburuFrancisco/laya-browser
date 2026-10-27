import { mkdir, readFile, writeFile, rename, appendFile, readdir, rm, stat, lstat, open, unlink, constants } from "node:fs/promises";
import { join } from "node:path";

const safeId = id => /^[0-9a-f-]{36}$/i.test(id);
const atomicJson = async (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
};

export class RunStore {
  constructor(root) { this.root = root; this.runsDir = join(root, "runs"); this.indexFile = join(root, "idempotency.json"); this.lockFile = join(root, "executor.lock"); this.lockHandle = null; this.runs = new Map(); this.idempotency = new Map(); this.mutex = Promise.resolve(); }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.acquireLock();
    await mkdir(this.runsDir, { recursive: true, mode: 0o700 });
    try {
      const index = JSON.parse(await readFile(this.indexFile, "utf8"));
      for (const [key, item] of Object.entries(index)) if (item && safeId(item.runId) && typeof item.fingerprint === "string") this.idempotency.set(key, item);
    } catch (e) { if (e.code !== "ENOENT") throw new Error(`Cannot read executor idempotency index: ${e.message}`); }
    for (const id of await readdir(this.runsDir)) {
      if (!safeId(id)) continue;
      try {
        const metadata = JSON.parse(await readFile(join(this.runsDir, id, "metadata.json"), "utf8"));
        if (metadata.runId !== id) continue;
        if (metadata.status === "running") { metadata.status = "interrupted"; metadata.finishedAt = new Date().toISOString(); metadata.error = { code: "SERVICE_RESTARTED", message: "Executor restarted while this run was active" }; await atomicJson(join(this.runsDir, id, "metadata.json"), metadata); }
        this.runs.set(id, metadata);
      } catch { /* Ignore malformed individual run records; keep service available. */ }
    }
    await this.persistIndex();
    await this.pruneExpired();
  }
  async acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { this.lockHandle = await open(this.lockFile, "wx", 0o600); await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return; }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          const { pid } = JSON.parse(await readFile(this.lockFile, "utf8"));
          if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); throw new Error(`Executor data directory is already in use by PID ${pid}`); } catch (probe) { if (probe.message.startsWith("Executor data directory")) throw probe; if (probe.code !== "ESRCH") throw probe; } }
          await unlink(this.lockFile);
        } catch (readError) { if (readError.message.startsWith("Executor data directory")) throw readError; if (readError.code !== "ENOENT") { await unlink(this.lockFile).catch(() => {}); } }
      }
    }
    this.lockHandle = await open(this.lockFile, "wx", 0o600);
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }
  async release() { await this.lockHandle?.close().catch(() => {}); this.lockHandle = null; await unlink(this.lockFile).catch(() => {}); }
  async exclusive(fn) { const previous = this.mutex; let unlock; this.mutex = new Promise(r => { unlock = r; }); await previous; try { return await fn(); } finally { unlock(); } }
  async persistIndex() { await atomicJson(this.indexFile, Object.fromEntries(this.idempotency)); }
  directory(id) { if (!safeId(id)) throw new Error("Invalid run ID"); return join(this.runsDir, id); }
  async create(metadata, key, fingerprint) {
    return this.exclusive(async () => {
      const old = this.idempotency.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) return { conflict: true };
        const run = this.runs.get(old.runId);
        if (run) return { run, existing: true };
      }
      const dir = this.directory(metadata.runId);
      await mkdir(join(dir, "artifacts"), { recursive: true, mode: 0o700 });
      await atomicJson(join(dir, "metadata.json"), metadata);
      await writeFile(join(dir, "logs.ndjson"), "", { mode: 0o600 });
      this.runs.set(metadata.runId, metadata);
      this.idempotency.set(key, { runId: metadata.runId, fingerprint, createdAt: metadata.createdAt });
      await this.persistIndex();
      return { run: metadata, existing: false };
    });
  }
  get(id) { return this.runs.get(id) ?? null; }
  findIdempotency(key) { const item = this.idempotency.get(key); return item ? { item, run: this.runs.get(item.runId) ?? null } : null; }
  list() { return [...this.runs.values()]; }
  async update(id, patch) { const current = this.get(id); if (!current) return null; const next = { ...current, ...patch }; await atomicJson(join(this.directory(id), "metadata.json"), next); this.runs.set(id, next); return next; }
  async appendLog(id, entry, maxBytes) {
    const file = join(this.directory(id), "logs.ndjson");
    const line = `${JSON.stringify(entry)}\n`, current = await stat(file);
    if (current.size + Buffer.byteLength(line) > maxBytes) {
      const meta = this.get(id);
      if (meta && !meta.logsTruncated) await this.update(id, { logsTruncated: true });
      return false;
    }
    await appendFile(file, line, { mode: 0o600 }); return true;
  }
  async logs(id, after = 0, limit = 100) {
    const lines = (await readFile(join(this.directory(id), "logs.ndjson"), "utf8")).split("\n").filter(Boolean).map(x => JSON.parse(x));
    const later = lines.filter(x => x.seq > after), entries = later.slice(0, limit);
    return { entries, nextCursor: entries.at(-1)?.seq ?? after, hasMore: later.length > entries.length, complete: this.get(id)?.status !== "queued" && this.get(id)?.status !== "running", truncated: !!this.get(id)?.logsTruncated };
  }
  async result(id) { try { return JSON.parse(await readFile(join(this.directory(id), "result.json"), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
  async artifactPath(id, name) {
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(name) || name === "." || name === "..") return null;
    const dir = join(this.directory(id), "artifacts"), file = join(dir, name);
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) return null; return file; } catch { return null; }
  }
  async openArtifact(id, name, maxBytes) {
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(name) || name === "." || name === "..") return null;
    const file = join(this.directory(id), "artifacts", name);
    let handle;
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) return null;
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) { await handle.close(); return null; }
      return { handle, size: info.size, path: file };
    } catch { await handle?.close().catch(() => {}); return null; }
  }
  async pruneExpired(now = Date.now(), retentionMs = 86400000) {
    for (const [id, run] of this.runs) {
      if (["queued", "running"].includes(run.status) || now - Date.parse(run.finishedAt ?? run.createdAt) < retentionMs) continue;
      await rm(this.directory(id), { recursive: true, force: true }); this.runs.delete(id);
      for (const [key, item] of this.idempotency) if (item.runId === id) this.idempotency.delete(key);
    }
    await this.persistIndex();
  }
}

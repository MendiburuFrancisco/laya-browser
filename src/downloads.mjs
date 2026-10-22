import path from "node:path";
import os from "node:os";
import { mkdir, stat, access } from "node:fs/promises";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function defaultDownloadsDir() {
  return path.join(os.homedir(), "Downloads", "laya-browser");
}

function safeFilename(name) {
  const base = path.basename(String(name || "download").replaceAll("\\", "/"));
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  return cleaned && cleaned !== "." ? cleaned : "download";
}

export class DownloadManager {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.items = [];
    this.nextId = 1;
    this.reserved = new Set();
    this.listeners = new Set();
    this.closed = false;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    await access(this.directory);
  }

  attach(page) {
    if (this.listeners.has(page)) return;
    this.listeners.add(page);
    page.on("download", download => { void this.save(download); });
  }

  async uniquePath(suggested) {
    const filename = safeFilename(suggested);
    const ext = path.extname(filename), stem = path.basename(filename, ext);
    for (let n = 0; ; n++) {
      const candidate = path.join(this.directory, n ? `${stem} (${n})${ext}` : filename);
      if (this.reserved.has(candidate)) continue;
      try { await access(candidate); continue; } catch {}
      this.reserved.add(candidate);
      return candidate;
    }
  }

  async save(download) {
    const item = { id: `download-${this.nextId++}`, filename: safeFilename(download.suggestedFilename()), status: "in_progress", startedAt: new Date().toISOString() };
    this.items.push(item);
    try {
      const destination = await this.uniquePath(item.filename);
      await download.saveAs(destination);
      const info = await stat(destination);
      Object.assign(item, { status: "completed", path: destination, bytes: info.size, completedAt: new Date().toISOString() });
    } catch (error) {
      const failure = await download.failure().catch(() => null);
      item.status = /cancel/i.test(String(failure ?? error?.message)) ? "cancelled" : "failed";
      item.error = String(error?.message ?? error).split("\n")[0].slice(0, 300);
      item.completedAt = new Date().toISOString();
    } finally {
      if (item.path) this.reserved.delete(item.path);
      this.notify();
    }
    return item;
  }

  notify() { for (const resolve of this.waiters ?? []) resolve(); this.waiters?.clear(); }

  list({ afterId } = {}) {
    const index = afterId ? this.items.findIndex(item => item.id === afterId) : -1;
    return this.items.filter((_, i) => !afterId || (index < 0 ? true : i > index)).map(item => ({ ...item }));
  }

  async wait({ id, afterId, timeoutMs = 30000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const index = afterId ? this.items.findIndex(item => item.id === afterId) : -1;
      const matches = id ? this.items.filter(item => item.id === id) : this.items.filter((_, i) => i > index);
      const finished = matches.filter(item => item.status !== "in_progress");
      if (finished.length) return { status: finished.at(-1).status, downloads: finished.map(item => ({ ...item })) };
      if (Date.now() >= deadline) return { status: "timeout", downloads: matches.map(item => ({ ...item })) };
      let resolveEvent;
      const event = new Promise(resolve => { resolveEvent = resolve; this.waiters ??= new Set(); this.waiters.add(resolve); });
      await Promise.race([sleep(Math.min(100, deadline - Date.now())), event]);
      this.waiters.delete(resolveEvent);
    }
  }

  async drain(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.items.some(item => item.status === "in_progress") && Date.now() < deadline) await sleep(50);
    return this.list().filter(item => item.status === "in_progress");
  }
}

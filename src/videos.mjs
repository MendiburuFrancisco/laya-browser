// Explicit Playwright screencasts can be finalized without closing pages or contexts.
import { mkdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

export class VideoManager {
  constructor(recordVideo) {
    if (recordVideo && (typeof recordVideo.dir !== "string" || !recordVideo.dir.trim())) {
      throw new Error("Video recording configuration error: recordVideo.dir must be a non-empty directory path.");
    }
    this.directory = recordVideo ? resolve(recordVideo.dir) : null;
    this.options = recordVideo ? { ...recordVideo, dir: this.directory } : undefined;
    this.items = [];
    this.records = [];
    this.pages = new Map();
    this.active = !!recordVideo;
  }

  async initialize() {
    if (!this.directory) return;
    try {
      const existing = await stat(this.directory).catch(e => e?.code === "ENOENT" ? null : Promise.reject(e));
      if (existing && !existing.isDirectory()) {
        throw new Error(`Video recording directory is unavailable: "${this.directory}". Configure a writable directory with record_video.dir or JEV_BROWSER_VIDEO_DIR. The configured path is a file, not a directory.`);
      }
      await mkdir(this.directory, { recursive: true });
    } catch (e) {
      if (String(e.message).startsWith("Video recording directory is unavailable:")) throw e;
      throw new Error(`Video recording directory is unavailable: "${this.directory}". Configure a writable directory with record_video.dir or JEV_BROWSER_VIDEO_DIR. ${fileError(e)}`);
    }
  }

  attach(page) {
    if (!this.active || page.isClosed() || this.pages.has(page)) return;
    const item = { id: randomUUID(), status: "starting", started_at: new Date().toISOString(), url: page.url() };
    item.path = join(this.directory, `${item.id}.webm`);
    this.items.push(item);
    const record = { page, item };
    this.pages.set(page, record);
    this.records.push(record);
    record.ready = (async () => {
      try {
        if (!page.screencast?.start) throw new Error("This Playwright version does not support page.screencast. Install Playwright 1.63 or newer.");
        await page.screencast.start({ path: item.path, size: this.options.size });
        item.status = "recording";
      } catch (e) {
        item.status = "failed";
        item.error = `Video recording failed to start for "${item.path}". ${videoError(e)}`;
      }
    })();
    page.once("close", () => { void this.finish(record); });
    return record.ready;
  }

  async ready() {
    await Promise.all(this.records.map(record => record.ready));
  }

  async start(context) {
    if (!this.directory) throw new Error("Video recording is not configured. Launch with record_video.dir or JEV_BROWSER_VIDEO_DIR before calling startRecording.");
    this.active = true;
    for (const page of context.pages()) this.attach(page);
    await this.ready();
    return this.list();
  }

  finish(record) {
    if (record.finished) return record.finished;
    record.finished = (async () => {
      await record.ready;
      const { page, item } = record;
      if (item.status === "failed") {
        if (this.pages.get(page) === record) this.pages.delete(page);
        return;
      }
      item.status = "finalizing";
      try {
        if (page.isClosed()) {
          // Playwright 1.63 finalizes the server recording on tab close, but its
          // public stop() rejects before copying that artifact to the requested
          // path. Keep this compatibility bridge isolated to already-closed tabs.
          const artifact = page.screencast._artifact;
          if (!artifact?.saveAs) throw new Error("The tab closed before the video could be saved and this Playwright version cannot recover its recording. Stop recording before closing the tab.");
          await artifact.saveAs(item.path);
        } else {
          await page.screencast.stop();
        }
        item.bytes = (await stat(item.path)).size;
        item.status = "completed";
        item.finished_at = new Date().toISOString();
      } catch (e) {
        item.status = "failed";
        item.error = `Video finalization failed for "${item.path}". ${videoError(e)}`;
      } finally {
        if (this.pages.get(page) === record) this.pages.delete(page);
      }
    })();
    return record.finished;
  }

  async stop() {
    this.active = false;
    await Promise.all(this.records.map(record => this.finish(record)));
    return this.list();
  }

  list() {
    return { videos_dir: this.directory, videos: this.items.map(item => ({ ...item })) };
  }

  async drain() {
    return this.stop();
  }
}

function fileError(e) {
  const code = e?.code ? `${e.code}: ` : "";
  if (e?.code === "EACCES" || e?.code === "EPERM") return `${code}the MCP process lacks permission to create files there.`;
  if (e?.code === "ENOTDIR") return `${code}part of the configured path is a file, not a directory.`;
  if (e?.code === "EEXIST") return `${code}the configured path is a file, not a directory.`;
  if (e?.code === "ENOENT") return `${code}the configured path or its parent does not exist.`;
  return `${code}${String(e?.message ?? e).split("\n")[0]}`;
}

function videoError(e) {
  const message = String(e?.message ?? e).split("\n")[0];
  if (/ffmpeg|ffmpeg.*executable|video.*executable/i.test(message)) return `${message} Install Playwright video support with: npx playwright install ffmpeg`;
  if (/closed|Target page, context or browser has been closed/i.test(message)) return `${message} The session closed before Playwright could finish the recording.`;
  return message;
}

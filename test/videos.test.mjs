// Real Chromium recordings, offline and without decision-model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JevBrowser } from "../src/session.mjs";
import { runFlow } from "../src/flow.mjs";

const url = "data:text/html,<title>Recording fixture</title><body style='background:coral'>Video evidence</body>";
async function assertVideo(item) {
  assert.equal(item.status, "completed", item.error);
  assert.ok(isAbsolute(item.path));
  const bytes = await readFile(item.path);
  assert.ok(bytes.length > 100);
  assert.equal(bytes.length, item.bytes);
  assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3", "WebM EBML header");
  assert.ok(bytes.includes(Buffer.from("webm")));
}

test("recording is disabled by default", async () => {
  const b = await JevBrowser.launch();
  try {
    assert.deepEqual(b.videos.list(), { videos_dir: null, videos: [] });
    assert.deepEqual(await b.stopRecording(), { videos_dir: null, videos: [] });
    await assert.rejects(b.startRecording(), /Video recording is not configured/);
  }
  finally { assert.deepEqual((await b.close()).videos, []); }
});

test("an invalid recording directory names the video configuration problem", async () => {
  const root = await mkdtemp(join(tmpdir(), "laya-video-invalid-"));
  const file = join(root, "not-a-directory");
  await writeFile(file, "fixture");
  try {
    await assert.rejects(JevBrowser.launch({ recordVideo: { dir: file } }), error => {
      assert.match(error.message, /^Video recording directory is unavailable:/);
      assert.match(error.message, new RegExp(file.replace(/[\\/]/g, "[\\\\/]")));
      assert.match(error.message, /file, not a directory/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("records all tabs, keeps closed tabs, and finalizes persistent WebM files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laya-video-"));
  const browser = await chromium.launch();
  let b;
  try {
    b = await JevBrowser.launch({ browser, recordVideo: { dir, size: { width: 640, height: 360 } } });
    await b.open(url);
    assert.equal(b.videos.list().videos[0].status, "recording");
    const first = b.page;
    const tab = await b.context.newPage();
    await tab.goto(url);
    await tab.waitForTimeout(300);
    await first.close();
    const closed = await b.close();
    assert.equal(closed.videos.length, 2);
    for (const video of closed.videos) await assertVideo(video);
    assert.equal(browser.isConnected(), true, "closing a session keeps a shared browser alive");
    assert.deepEqual((await readdir(dir)).sort(), closed.videos.map(v => v.path.split(/[\\/]/).at(-1)).sort(), "temporary raw videos are removed");
    assert.deepEqual((await b.close()).videos, closed.videos, "repeated close preserves results");
  } finally {
    await b?.close();
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistent profiles and runFlow finalize recordings", async () => {
  const root = await mkdtemp(join(tmpdir(), "laya-video-profile-"));
  let b;
  try {
    b = await JevBrowser.launch({ userDataDir: join(root, "profile"), recordVideo: { dir: join(root, "videos") } });
    await b.open(url);
    const saved = await b.stopRecording();
    await assertVideo(saved.videos[0]);
    assert.equal(b.page.isClosed(), false, "persistent profile stays open after saving");
    const closed = await b.close();
    assert.equal(closed.videos.length, 1);
    await assertVideo(closed.videos[0]);
    const flow = await runFlow({ url, steps: [] }, { recordVideo: { dir: join(root, "flow") } });
    assert.equal(flow.videos.length, 1);
    await assertVideo(flow.videos[0]);
  } finally { await b?.close(); await rm(root, { recursive: true, force: true }); }
});

test("stop saves playable video while retaining tabs, form state and cookies; restart creates a new segment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laya-video-stop-"));
  let b;
  try {
    b = await JevBrowser.launch({ recordVideo: { dir, size: { width: 640, height: 360 } } });
    await b.open("data:text/html,<title>Keep this page</title><input aria-label='Task'><p>Recorded action</p>");
    await b.page.getByRole("textbox").fill("Keep this value");
    await b.context.addCookies([{ name: "session", value: "keep-login", url: "https://example.com" }]);
    const originalPage = b.page;
    const stopped = await b.stopRecording();
    await assertVideo(stopped.videos[0]);
    assert.equal(originalPage.isClosed(), false);
    assert.equal(b.page, originalPage);
    assert.equal(await b.page.getByRole("textbox").inputValue(), "Keep this value");
    assert.equal((await b.context.cookies("https://example.com"))[0].value, "keep-login");
    assert.deepEqual(await b.stopRecording(), stopped, "stop is idempotent");

    // Decode and play the saved file BEFORE the recorded context is closed.
    const playback = await b.browser.newContext();
    try {
      const viewer = await playback.newPage();
      await viewer.setContent("<video muted></video>");
      const media = await viewer.evaluate(async src => {
        const video = document.querySelector("video");
        video.src = src;
        await new Promise((resolve, reject) => {
          video.onloadeddata = resolve;
          video.onerror = () => reject(new Error("Cannot decode saved video"));
        });
        await video.play();
        return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      }, `data:video/webm;base64,${(await readFile(stopped.videos[0].path)).toString("base64")}`);
      assert.deepEqual({ width: media.width, height: media.height }, { width: 640, height: 360 });
      assert.ok(media.duration > 0);
    } finally { await playback.close(); }

    const unrecordedTab = await b.context.newPage();
    await unrecordedTab.goto(url);
    assert.equal(b.videos.list().videos.length, 1, "new tabs are not recorded while stopped");
    const restarted = await b.startRecording();
    assert.equal(restarted.videos.length, 3, "one new segment for each open tab");
    assert.equal(restarted.videos.filter(v => v.status === "recording").length, 2);
    assert.equal((await b.startRecording()).videos.length, 3, "start is idempotent");
    await b.page.getByText("Video evidence").isVisible();
    for (const item of (await b.stopRecording()).videos) await assertVideo(item);
    assert.equal(b.context.pages().length, 2);
  } finally { await b?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("MCP configures recording, Code Mode lists it, and close returns files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laya-video-mcp-"));
  const client = new Client({ name: "video-test", version: "0" });
  const server = fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server],
    env: { ...process.env, JEV_BROWSER_HEADED: "0", JEV_BROWSER_PROFILE: "", JEV_BROWSER_VIDEO_DIR: dir, JEV_CACHE: "0" } }));
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const r = await raw(name, args);
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  try {
    assert.ok((await client.listTools()).tools.some(t => t.name === "browser_videos"));
    assert.ok((await client.listTools()).tools.some(t => t.name === "browser_stop_recording"));
    assert.ok((await client.listTools()).tools.some(t => t.name === "browser_start_recording"));
    const opened = await call("browser_open", { url });
    assert.equal(opened.videos_dir, dir);
    assert.equal((await call("browser_videos")).videos.length, 1);
    const code = await call("browser_execute", { code: "return await browser.videos({});" });
    assert.match(JSON.stringify(code), /recording/);
    const stopped = await call("browser_execute", { code: "const saved = await browser.stopRecording({}); const snapshot = await browser.snapshot({max_chars:1000}); return {saved, snapshot};" });
    assert.equal(stopped.status, "done");
    await assertVideo(stopped.result.saved.videos[0]);
    assert.match(stopped.result.snapshot.text, /Recording fixture/);
    assert.deepEqual((await call("browser_stop_recording")).videos, stopped.result.saved.videos);
    const restarted = await call("browser_start_recording");
    assert.equal(restarted.videos.length, 2);
    assert.equal(restarted.videos[1].status, "recording");
    const codeRestart = await call("browser_execute", { code: "return await browser.startRecording({});" });
    assert.equal(codeRestart.result.videos.length, 2);
    const changed = await raw("browser_open", { url, record_video: null });
    assert.ok(changed.isError);
    assert.match(changed.content[0].text, /browser_close/);
    const closed = await call("browser_close");
    await assertVideo(closed.videos[0]);
    assert.equal((await call("browser_open", { url, record_video: null })).videos_dir, null);
    assert.deepEqual((await call("browser_close")).videos, []);
    const invalid = await raw("browser_open", { url, record_video: { dir: "" } });
    assert.ok(invalid.isError);
    const explicit = await call("browser_open", { url, record_video: { dir: join(dir, "explicit"), size: { width: 320, height: 240 } } });
    assert.equal(explicit.videos_dir, join(dir, "explicit"));
    await assertVideo((await call("browser_close")).videos[0]);
  } finally { await raw("browser_close").catch(() => {}); await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test("MCP reports an invalid video directory before Code Mode starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "laya-video-mcp-invalid-"));
  const file = join(root, "not-a-directory");
  await writeFile(file, "fixture");
  const client = new Client({ name: "video-config-test", version: "0" });
  const server = fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server],
    env: { ...process.env, JEV_BROWSER_HEADED: "0", JEV_BROWSER_VIDEO_DIR: file, JEV_CACHE: "0" } }));
  try {
    const result = await client.callTool({ name: "browser_execute", arguments: { code: "return await browser.videos({});" } });
    assert.ok(!result.isError, result.content[0].text);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.status, "error");
    assert.match(output.info, /^Video recording directory is unavailable:/);
    assert.match(output.info, /record_video.dir or JEV_BROWSER_VIDEO_DIR/);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

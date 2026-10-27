// Real Chromium processes behind a single stdio MCP connection; no inference API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url));

for (const backend of ["jev", "laya"]) {
  test(`isolated concurrent MCP sessions (${backend})`, { timeout: 90000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "laya-multi-"));
    const site = createServer((req, res) => {
      const url = new URL(req.url, "http://fixture");
      const identity = url.searchParams.get("identity");
      if (url.pathname === "/download") {
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="report.txt"' });
        return res.end("independent download");
      }
      res.setHeader("Content-Type", "text/html");
      res.end(`<!DOCTYPE html><title>Session fixture</title><label>Name<input id="name"></label><a href="/download">Download</a>
        <script>
        const identity = ${JSON.stringify(identity)};
        if (identity) { document.cookie = 'identity=' + identity + '; path=/; max-age=3600'; localStorage.setItem('identity', identity); }
        document.body.insertAdjacentHTML('beforeend', '<p id="state">cookie:' + document.cookie + ' storage:' + localStorage.getItem('identity') + '</p>');
        </script>`);
    });
    site.listen(0, "127.0.0.1"); await once(site, "listening");
    const url = `http://127.0.0.1:${site.address().port}`;
    const client = new Client({ name: "multi-session-test", version: "0" });
    const env = { ...process.env, JEV_BACKEND: backend, JEV_BROWSER: "chromium", JEV_BROWSER_HEADED: "0",
      JEV_BROWSER_PROFILE: join(root, "profiles"), JEV_BROWSER_DOWNLOADS_DIR: join(root, "downloads"),
      JEV_BROWSER_VIDEO_DIR: join(root, "videos"), JEV_CACHE_FILE: join(root, "cache.json"), JEV_CACHE: "1" };
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env }));
    const raw = (name, args = {}) => client.callTool({ name, arguments: args });
    const call = async (name, args = {}) => {
      const reply = await raw(name, args);
      assert.ok(!reply.isError, reply.content[0]?.text);
      return JSON.parse(reply.content[0].text);
    };
    const scoped = (id, name, args = {}) => call(name, { ...args, session_id: id });
    try {
      const tools = (await client.listTools()).tools;
      for (const tool of tools.filter(t => !["browser_create_session", "browser_list_sessions"].includes(t.name))) {
        assert.ok(tool.inputSchema.properties.session_id, `${tool.name} must route by session`);
      }
      const a = (await call("browser_create_session")).session_id;
      const b = (await call("browser_create_session")).session_id;
      assert.notEqual(a, b);
      assert.equal((await raw("browser_open", { url })).isError, true, "missing selector must not silently control another session");
      assert.equal((await raw("browser_create_session", { session_id: a })).isError, true);
      assert.equal((await raw("browser_create_session", { session_id: "../escape" })).isError, true);
      assert.equal((await raw("browser_open", { session_id: "unknown", url })).isError, true);

      const [openedA, openedB] = await Promise.all([
        scoped(a, "browser_open", { url: `${url}/?identity=A`, viewport: { width: 640, height: 480 } }),
        scoped(b, "browser_open", { url: `${url}/?identity=B`, viewport: { width: 800, height: 600 } }),
      ]);
      assert.equal(openedA.session_id, a);
      assert.equal(openedB.session_id, b);
      assert.equal(openedA.viewport.width, 640);
      assert.equal(openedB.viewport.width, 800);
      assert.notEqual(openedA.downloads_dir, openedB.downloads_dir);
      const snapA = await raw("browser_snapshot", { session_id: a });
      const input = Number(snapA.content[0].text.match(/\[(\d+)\] input/)[1]);
      await scoped(a, "browser_act", { action: "type", element: input, value: "Only A" });
      assert.match((await raw("browser_snapshot", { session_id: a })).content[0].text, /Only A/);
      assert.doesNotMatch((await raw("browser_snapshot", { session_id: b })).content[0].text, /Only A/);

      // Re-read state from the same origin after both sessions have written cookies/storage.
      await Promise.all([scoped(a, "browser_open", { url }), scoped(b, "browser_open", { url })]);
      const [htmlA, htmlB] = await Promise.all([scoped(a, "browser_get_html"), scoped(b, "browser_get_html")]);
      assert.match(htmlA.html, /id="state">cookie:identity=A storage:A/);
      assert.match(htmlB.html, /id="state">cookie:identity=B storage:B/);
      await scoped(a, "browser_new_tab", { url: "data:text/html,<title>Only A tab</title>" });
      assert.equal((await scoped(a, "browser_list_tabs")).tabs.length, 2);
      assert.equal((await scoped(b, "browser_list_tabs")).tabs.length, 1);
      const networkB = await scoped(b, "list_network_requests");
      assert.doesNotMatch(JSON.stringify(networkB), /identity=A/);

      // Keep A busy inside a cancellable Code Mode operation. B must stay usable,
      // while a second operation on A is explicitly rejected by A's own lease.
      const pending = scoped(a, "browser_execute", { timeout_ms: 2500,
        code: "await browser.waitForDownload({after_id:'',timeout_ms:300000});" });
      let busy = false;
      for (let i = 0; i < 50 && !busy; i++) {
        busy = (await call("browser_list_sessions")).sessions.find(s => s.session_id === a).busy;
        if (!busy) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(busy, "A entered its operation lease");
      assert.equal((await raw("browser_get_html", { session_id: a })).isError, true);
      const during = await scoped(b, "browser_execute", { code: "return await browser.getHtml();" });
      assert.equal(during.status, "done", during.info);
      assert.match(during.result.html, /cookie:identity=B storage:B/);
      const timedOut = await pending;
      assert.equal(timedOut.status, "timeout");
      assert.equal(timedOut.session_closed, true);
      assert.match((await scoped(b, "browser_get_html")).html, /cookie:identity=B storage:B/);

      // Same named session reopens with its own persistent profile after cancellation.
      await scoped(a, "browser_open", { url });
      assert.match((await scoped(a, "browser_get_html")).html, /cookie:identity=A storage:A/);
      const download = async id => {
        const snap = await raw("browser_snapshot", { session_id: id, filter: "Download" });
        const element = Number(snap.content[0].text.match(/\[(\d+)\] a/)[1]);
        await scoped(id, "browser_act", { action: "click", element });
        return scoped(id, "browser_wait_for_download", { after_id: "", timeout_ms: 5000 });
      };
      await Promise.all([download(a), download(b)]);
      const downloadsA = await scoped(a, "browser_downloads");
      const downloadsB = await scoped(b, "browser_downloads");
      assert.equal(downloadsA.downloads.length, 1);
      assert.equal(downloadsB.downloads.length, 1);
      assert.notEqual(downloadsA.downloads[0].path, downloadsB.downloads[0].path);
      const videosA = await scoped(a, "browser_stop_recording");
      const videosB = await scoped(b, "browser_stop_recording");
      assert.ok(videosA.videos.length && videosB.videos.length);
      assert.notEqual(dirname(videosA.videos[0].path), dirname(videosB.videos[0].path));
      for (const v of [...videosA.videos, ...videosB.videos]) {
        assert.equal(v.status, "completed", v.error);
        assert.ok((await stat(v.path)).size > 0);
      }
      await scoped(a, "browser_close");
      assert.match((await scoped(b, "browser_get_html")).html, /cookie:identity=B storage:B/);
      const states = (await call("browser_list_sessions")).sessions;
      assert.equal(states.find(s => s.session_id === a).state, "idle");
      assert.equal(states.find(s => s.session_id === b).state, "started");
    } finally {
      const listed = await call("browser_list_sessions").catch(() => ({ sessions: [] }));
      await Promise.all(listed.sessions.map(s => scoped(s.session_id, "browser_close").catch(() => {})));
      await client.close();
      await new Promise(resolve => site.close(resolve));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}

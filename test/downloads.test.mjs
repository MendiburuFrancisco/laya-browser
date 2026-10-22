import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { DownloadManager } from "../src/downloads.mjs";

test("downloads are saved persistently with safe unique filenames and reported when complete", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<a id="download" href="/report">download</a>');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="report.csv"' });
    res.end("id,value\n1,ok\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "laya-download-test-"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const manager = new DownloadManager(dir);
  await manager.initialize();
  const page = await context.newPage(); manager.attach(page);
  try {
    const url = `http://127.0.0.1:${server.address().port}/report`;
    await page.goto(`http://127.0.0.1:${server.address().port}/page`);
    const download = page.waitForEvent("download");
    await page.locator("#download").click();
    await download;
    const result = await manager.wait({ afterId: "", timeoutMs: 5000 });
    assert.equal(result.status, "completed");
    assert.equal(result.downloads.length, 1);
    assert.equal(result.downloads[0].filename, "report.csv");
    assert.equal(await readFile(result.downloads[0].path, "utf8"), "id,value\n1,ok\n");
    assert.equal(result.downloads[0].bytes, Buffer.byteLength("id,value\n1,ok\n"));
  } finally {
    await context.close(); await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait reports timeout when no new download arrives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "laya-download-test-"));
  const manager = new DownloadManager(dir);
  try {
    const result = await manager.wait({ afterId: "", timeoutMs: 100 });
    assert.equal(result.status, "timeout");
    assert.deepEqual(result.downloads, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

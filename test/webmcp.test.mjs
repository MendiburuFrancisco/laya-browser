// Offline tests: WebMCP tools registered by a local fixture page are listed and called. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { JevBrowser } from "../src/session.mjs";
import { webmcpText } from "../src/webmcp.mjs";

const PAGES = {
  "/current": `<!doctype html><title>Current API</title><p id="out">empty</p><script>
    const ac = new AbortController();
    document.modelContext.registerTool({
      name: "add_todo", description: "Add a todo item",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: false },
      async execute({ text }) { document.getElementById("out").textContent = text; return { content: [{ type: "text", text: "added " + text }] }; },
    });
    document.modelContext.registerTool({ name: "temp", description: "gone soon", execute: () => 1 }, { signal: ac.signal });
    ac.abort();
    document.modelContext.registerTool({ name: "boom", description: "throws", execute() { throw new Error("nope"); } });
    document.modelContext.registerTool({ name: "hang", description: "never returns", execute: () => new Promise(() => {}) });
  </script>`,
  "/legacy": `<!doctype html><title>Legacy API</title><script>
    navigator.modelContext.provideContext({ tools: [
      { name: "search", description: "Search the catalog", inputSchema: { type: "object", properties: { q: { type: "string" } } }, execute: ({ q }) => ({ hits: [q + " 1", q + " 2"] }) },
    ] });
  </script>`,
  "/none": `<!doctype html><title>Plain</title><p>no tools</p>`,
};

let server, base, browser, b;
before(async () => {
  server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(PAGES[req.url] ?? ""); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  b = await JevBrowser.launch({ browser });
});
after(async () => { await b.close(); await browser.close(); server.close(); });

test("registerTool tools are listed; an aborted signal unregisters", async () => {
  await b.open(`${base}/current`);
  const tools = await b.webmcpTools();
  assert.deepEqual(tools.map(t => t.name), ["add_todo", "boom", "hang"]);
  assert.equal(tools[0].description, "Add a todo item");
  assert.deepEqual(tools[0].inputSchema.required, ["text"]);
  assert.deepEqual(tools[0].annotations, { readOnlyHint: false });
});

test("calling a tool runs the page's code and returns its text", async () => {
  await b.open(`${base}/current`);
  const r = await b.webmcpCall("add_todo", { text: "buy milk" });
  assert.equal(r.result, "added buy milk");
  assert.equal(r.error, undefined);
  assert.equal(await b.page.textContent("#out"), "buy milk");
});

test("errors: a throwing tool, an unknown name, a tool that never returns", async () => {
  await b.open(`${base}/current`);
  assert.equal((await b.webmcpCall("boom")).error, "nope");
  assert.match((await b.webmcpCall("missing")).error, /no WebMCP tool named "missing"; registered: add_todo, boom, hang/);
  assert.match((await b.webmcpCall("hang", {}, { timeout: 300 })).error, /did not finish within 300 ms/);
});

test("provideContext (earlier draft) on navigator.modelContext", async () => {
  await b.open(`${base}/legacy`);
  assert.deepEqual((await b.webmcpTools()).map(t => t.name), ["search"]);
  assert.equal((await b.webmcpCall("search", { q: "lamp" })).result, '{"hits":["lamp 1","lamp 2"]}');
});

test("a page without tools lists none, and tools do not leak across navigations", async () => {
  await b.open(`${base}/current`);
  await b.open(`${base}/none`);
  assert.deepEqual(await b.webmcpTools(), []);
});

test("webmcpText flattens MCP content and caps size", () => {
  assert.equal(webmcpText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(webmcpText("plain"), "plain");
  assert.equal(webmcpText(undefined), "null");
  assert.match(webmcpText("x".repeat(30), 10), /^x{10}\n\[… 20 chars cut\]$/);
});

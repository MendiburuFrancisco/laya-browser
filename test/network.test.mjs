import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NetworkLog } from "../src/network.mjs";

test("network log evicts oldest requests, rejects stale IDs and detaches listeners", async () => {
  const context = new EventEmitter(), log = new NetworkLog(context, { limit: 2 });
  const request = n => ({ url: () => `https://example.test/${n}`, method: () => "GET", resourceType: () => "fetch",
    frame: () => { throw new Error("worker"); }, redirectedFrom: () => null, redirectedTo: () => null, failure: () => null });
  context.emit("request", request(1));
  const first = log.list().requests[0].id;
  context.emit("request", request(2)); context.emit("request", request(3));
  assert.equal(log.list().dropped, 1);
  assert.equal(log.list({ page: 2, page_size: 1 }).requests[0].url, "https://example.test/3");
  await assert.rejects(log.get(first), /evicted/);
  log.close();
  assert.equal(context.listenerCount("request"), 0);
  assert.equal(log.entries.size, 0);
});

test("MCP observes fetch/xhr headers, bodies, redirects and failures in the active session", async () => {
  const site = createServer(async (req, res) => {
    if (req.url === "/page") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<title>Network fixture</title><script>
        fetch('/echo', {method:'POST',headers:{'Content-Type':'application/json','X-Fixture':'yes'},body:JSON.stringify({name:'Ada'})}).then(r=>r.json());
        const xhr=new XMLHttpRequest();xhr.open('GET','/xhr');xhr.send();
        fetch('/redirect');fetch('/broken').catch(()=>{});fetch('/binary');fetch('/large');
        fetch('/stream');
      </script>`);
    } else if (req.url === "/redirect") { res.writeHead(302, { Location: "/xhr" }); res.end(); }
    else if (req.url === "/broken") req.socket.destroy();
    else if (req.url === "/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: hello\n\n"); }
    else if (req.url === "/binary") { res.setHeader("Content-Type", "application/octet-stream"); res.end(Buffer.from([0, 255, 42])); }
    else if (req.url === "/large") { res.setHeader("Content-Type", "text/plain"); res.end("x".repeat(1024 * 1024 + 1)); }
    else {
      let raw = ""; for await (const chunk of req) raw += chunk;
      res.writeHead(req.url === "/echo" ? 201 : 200, { "Content-Type": "application/json", "X-Reply": "observed", "Set-Cookie": "fixture=1; Path=/" });
      res.end(JSON.stringify({ received: raw ? JSON.parse(raw) : null }));
    }
  });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const client = new Client({ name: "network-test", version: "0" });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0]?.text);
    return JSON.parse(r.content[0].text);
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url))],
      env: { ...process.env, JEV_BROWSER_HEADED: "0", JEV_BROWSER_PROFILE: "", JEV_CACHE: "0" } }));
    const tools = (await client.listTools()).tools.map(t => t.name);
    assert.ok(tools.includes("list_network_requests")); assert.ok(tools.includes("get_network_request"));
    await call("browser_open", { url: `http://127.0.0.1:${site.address().port}/page` });
    const all = await call("list_network_requests", { resource_types: ["fetch", "xhr"] });
    assert.ok(all.total >= 8);
    assert.ok(all.requests.every(r => ["fetch", "xhr"].includes(r.resource_type)));
    const echo = all.requests.find(r => r.url.endsWith("/echo"));
    const detail = await call("get_network_request", { id: echo.id });
    assert.equal(detail.method, "POST"); assert.equal(detail.status_code, 201);
    assert.deepEqual(JSON.parse(detail.request_body.data), { name: "Ada" });
    assert.deepEqual(JSON.parse(detail.response_body.data), { received: { name: "Ada" } });
    assert.ok(detail.request_headers.some(h => h.name.toLowerCase() === "x-fixture" && h.value === "yes"));
    assert.ok(detail.response_headers.some(h => h.name.toLowerCase() === "set-cookie"));
    const redirect = all.requests.find(r => r.url.endsWith("/redirect"));
    assert.equal(redirect.status_code, 302); assert.ok(redirect.redirected_to);
    assert.equal(all.requests.find(r => r.id === redirect.redirected_to).redirected_from, redirect.id);
    assert.equal(all.requests.find(r => r.url.endsWith("/broken")).state, "failed");
    const binary = await call("get_network_request", { id: all.requests.find(r => r.url.endsWith("/binary")).id });
    assert.equal(binary.response_body.encoding, "base64");
    assert.deepEqual(Buffer.from(binary.response_body.data, "base64"), Buffer.from([0, 255, 42]));
    const large = await call("get_network_request", { id: all.requests.find(r => r.url.endsWith("/large")).id });
    assert.match(large.response_body_unavailable, /limit/);
    const stream = await call("get_network_request", { id: all.requests.find(r => r.url.endsWith("/stream")).id });
    assert.equal(stream.state, "receiving"); assert.match(stream.response_body_unavailable, /not complete/);
    const code = await call("browser_execute", { code: `
      const list = await browser.listNetworkRequests({url_contains:'/echo',resource_types:['fetch']});
      const detail = await browser.getNetworkRequest({id:list.requests[0].id});
      return {total:list.total,body:detail.response_body.data};
    ` });
    assert.equal(code.status, "done", code.info); assert.equal(code.decision_calls, 0);
    assert.equal(code.result.total, 1); assert.equal(code.result.body, detail.response_body.data);
    await call("browser_open", { url: "data:text/html,<title>Next page</title>" });
    assert.equal((await call("get_network_request", { id: echo.id })).id, echo.id);
    await call("browser_close");
    const stale = await client.callTool({ name: "get_network_request", arguments: { id: echo.id } });
    assert.equal(stale.isError, true);
  } finally {
    await call("browser_close").catch(() => {}); await client.close();
    site.closeAllConnections(); await new Promise(resolve => site.close(resolve));
  }
});

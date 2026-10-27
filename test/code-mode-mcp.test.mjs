// Real stdio MCP + Chromium + deterministic System One HTTP fixtures. Exercises
// both backend configurations without API credits or local model installations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url));
const fixtureUrl = "data:text/html," + encodeURIComponent('<title>Code Mode fixture</title><label for="name">Name</label><input id="name"><p>Ready</p><a href="about:blank" target="_blank">Open tab</a>');

test("MCP reports browser launch diagnostics on every consecutive Code Mode/direct run failure", async () => {
  const client = new Client({ name: "launch-failure-test", version: "0" });
  const env = { ...process.env, JEV_BROWSER: "/nonexistent-laya-test/browser.exe", JEV_BROWSER_PROFILE: "", JEV_BROWSER_HEADED: "0", JEV_BROWSER_NO_INSTALL: "1" };
  delete env.JEV_BROWSER_VIDEO_DIR;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: {
    ...env,
  } }));
  try {
    for (let i = 0; i < 2; i++) {
      const reply = await client.callTool({ name: "browser_execute", arguments: {
        code: `await browser.run({url:'https://example.test',steps:[{goal:'Ready'}]});`,
      } });
      const r = JSON.parse(reply.content[0].text);
      assert.equal(r.status, "error");
      assert.equal(r.failed_method, "run");
      assert.equal(r.error.phase, "browser_launch");
      assert.match(r.info, /was not found/);
      assert.match(r.error.message, /Caused by:/);
      assert.match(r.error.hint, /JEV_BROWSER/);
    }
    const reply = await client.callTool({ name: "browser_run", arguments: { steps: [{ goal: "Ready" }] } });
    assert.equal(reply.isError, true);
    const r = JSON.parse(reply.content[0].text);
    assert.equal(r.error.phase, "browser_launch");
    assert.match(r.error.message, /was not found/);
  } finally { await client.close(); }
});

for (const backend of ["jev", "laya"]) {
  test(`Code Mode MCP works with ${backend} configuration and preserves direct tools`, async () => {
    const requests = [];
    const api = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const field = body.state.page?.elements?.find(e => e.tag.startsWith("input"));
      const expected = body.state.task?.values?.name;
      const blocked = body.state.task?.goal === "Stop here";
      const done = !expected || field?.value === expected;
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const choice = name === "tool" ? (done || blocked ? "none" : "type") : name === "target" ? String(field?.i ?? keys[0]) : keys[0];
          answers[name] = { choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) };
        } else answers[name] = { noul: name === "blocked" ? +blocked : ["done", "done_change", "complete"].includes(name) ? +(done && !blocked) : name === "q" ? 0.99 : 0 };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers, usage: { input_tokens: 10 } }));
    });
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    const client = new Client({ name: "code-mode-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: {
      ...process.env, JEV_BACKEND: backend, JEV_MODEL: `${backend}-fixture`, JEV_API_URL: `http://127.0.0.1:${api.address().port}/v1/systemone`,
      TYPESAFE_API_KEY: "fixture-only", JEV_CACHE: "0", JEV_BROWSER_HEADED: "0", JEV_BROWSER_PROFILE: "", JEV_BROWSER_LOG: "0",
    } }));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, r.content[0]?.text);
      return JSON.parse(r.content[0].text);
    };
    try {
      const tools = (await client.listTools()).tools.map(t => t.name);
      for (const name of ["browser_execute", "browser_run", "browser_downloads", "browser_webmcp_tools", "browser_webmcp_call", "browser_get_html", "browser_list_tabs", "browser_select_tab", "browser_new_tab"]) assert.ok(tools.includes(name), name);
      const docs = await client.readResource({ uri: "browser://code-mode/api" });
      assert.match(docs.contents[0].text, /BrowserCodeAPI/);
      const result = await call("browser_execute", { values: { url: fixtureUrl, names: ["Ada", "Grace"] }, code: `
        await browser.open({url: values.url});
        for (const name of values.names) {
          await browser.do({goal:'Fill name', values:{name}, verify:{field:{label:'Name',value_key:'name'}}});
        }
        const check = await browser.check({question:'Is Grace entered?'});
        const read = await browser.read({question:'What does the page show?'});
        return {p:check.p_yes, content:read.content};
      ` });
      assert.equal(result.status, "done", result.info);
      assert.equal(result.backend, backend);
      assert.equal(result.result.p, 0.99);
      assert.match(result.result.content, /Ready/);
      assert.equal(result.operations, 5);
      assert.ok(result.decision_calls >= 5);
      assert.ok(requests.every(r => r.model === `${backend}-fixture`));
      assert.ok(requests.some(r => r.state.page?.elements?.some(e => e.value === "Grace")));

      const consecutive = await call("browser_execute", { code: `
        await browser.run({steps:[{goal:'Ready'}]});
        await browser.run({steps:[{goal:'Ready'},{goal:'Stop here'},{goal:'Must not run'}]});
        return 'must not finish';
      ` });
      assert.equal(consecutive.status, "blocked");
      assert.equal(consecutive.failed_operation, 2);
      assert.equal(consecutive.failed_method, "run");
      assert.equal(consecutive.progress[0].status, "done");
      assert.equal(consecutive.suspended.result.failed_step, 2);
      assert.equal(consecutive.suspended.result.completed, 1);
      assert.match(consecutive.info, /blocks progress/);

      const beforeTabs = requests.length;
      const firstTab = (await call("browser_list_tabs")).tabs.find(t => t.active);
      const popupSnapshot = await client.callTool({ name: "browser_snapshot", arguments: { filter: "Open tab" } });
      const linkId = Number(popupSnapshot.content[0].text.match(/\[(\d+)\] a/)[1]);
      await call("browser_act", { action: "click", element: linkId });
      let popupTabs;
      const popupDeadline = Date.now() + 5000;
      do { popupTabs = (await call("browser_list_tabs")).tabs; }
      while (popupTabs.length < 2 && Date.now() < popupDeadline);
      assert.equal(popupTabs.length, 2);
      const popupTab = popupTabs.find(t => t.active);
      assert.notEqual(popupTab.id, firstTab.id);
      assert.equal((await call("browser_select_tab", { title: firstTab.title })).id, firstTab.id);
      const switched = await call("browser_execute", { values: { id: popupTab.id }, code: `
        await browser.selectTab({id:values.id});
        return await browser.listTabs();
      ` });
      assert.equal(switched.status, "done", switched.info);
      assert.equal(switched.result.tabs.find(t => t.active).id, popupTab.id);
      assert.equal(switched.decision_calls, 0);
      assert.equal((await call("browser_select_tab", { url: firstTab.url })).id, firstTab.id);
      const invalidTab = await client.callTool({ name: "browser_select_tab", arguments: { id: "missing" } });
      assert.equal(invalidTab.isError, true);
      assert.equal((await call("browser_list_tabs")).tabs.find(t => t.active).id, firstTab.id);
      const blankTab = await call("browser_new_tab");
      assert.equal(blankTab.status, "done");
      assert.equal(blankTab.url, "about:blank");
      assert.equal(blankTab.active, true);
      assert.equal((await call("browser_list_tabs")).tabs.length, 3);
      const destination = "data:text/html,<title>Explicit new tab</title><p>Created</p>";
      const createdTab = await call("browser_new_tab", { url: destination });
      assert.equal(createdTab.url, destination);
      assert.equal(createdTab.title, "Explicit new tab");
      assert.equal((await call("browser_list_tabs")).tabs.find(t => t.active).id, createdTab.id);
      const newTabCode = await call("browser_execute", { code: `
        const tab = await browser.newTab();
        return {tab,tabs:(await browser.listTabs()).tabs};
      ` });
      assert.equal(newTabCode.status, "done", newTabCode.info);
      assert.equal(newTabCode.result.tab.url, "about:blank");
      assert.equal(newTabCode.result.tabs.length, 5);
      assert.equal(newTabCode.decision_calls, 0);
      await call("browser_select_tab", { id: firstTab.id });
      const preserved = await client.callTool({ name: "browser_snapshot", arguments: {} });
      assert.match(preserved.content[0].text, /Grace/);
      assert.equal(requests.length, beforeTabs, "tab management needs no inference");

      const htmlUrl = "data:text/html," + encodeURIComponent('<!DOCTYPE html><title>HTML fixture</title><script>document.addEventListener("DOMContentLoaded",()=>{const p=document.createElement("p");p.id="dynamic";p.textContent="' + "x".repeat(25000) + '";document.body.append(p)})</script><body>Ready</body>');
      await call("browser_open", { url: htmlUrl });
      const beforeHtml = requests.length;
      const html = await call("browser_get_html");
      assert.equal(html.url, htmlUrl);
      assert.match(html.html, /^<!DOCTYPE html>/i);
      assert.ok(html.html.includes('<p id="dynamic">' + "x".repeat(25000) + '</p>'), "complete live DOM without truncation");
      const codeHtml = await call("browser_execute", { code: `const page = await browser.getHtml(); return {length:page.html.length,doctype:page.html.startsWith('<!DOCTYPE html>')};` });
      assert.equal(codeHtml.status, "done", codeHtml.info);
      assert.equal(codeHtml.result.length, html.html.length);
      assert.equal(codeHtml.result.doctype, true);
      assert.equal(codeHtml.decision_calls, 0);
      assert.equal(requests.length, beforeHtml, "HTML retrieval needs no inference");
      await call("browser_open", { url: fixtureUrl });

      const stopped = await call("browser_execute", { code: `await browser.do({goal:'Stop here'}); await browser.open({url:'data:text/html,wrong'});` });
      assert.equal(stopped.status, "blocked");
      assert.equal(stopped.progress.length, 1);
      const reopened = await call("browser_open", { url: fixtureUrl });
      assert.match(reopened.visible_text, /Ready/, "suspension leaves the session usable");

      const budget = await call("browser_execute", { max_decision_calls: 1, code: `await browser.check({question:'one'}); await browser.check({question:'two'});` });
      assert.equal(budget.status, "limit_exceeded");
      assert.equal(budget.decision_calls, 1);
      assert.equal((await call("browser_check", { question: "Still usable?" })).p_yes, 0.99);

      const failed = await call("browser_execute", { code: `await browser.do({goal:'Ready',verify:{text_includes:'missing'}}); return 'wrong';` });
      assert.equal(failed.status, "verification_failed");

      const actions = await call("browser_execute", { max_browser_actions: 1, code: `
        await browser.do({goal:'Fill name',values:{name:'First'}});
        await browser.do({goal:'Fill name',values:{name:'Second'}});
      ` });
      assert.equal(actions.status, "limit_exceeded");
      const snap = await client.callTool({ name: "browser_snapshot", arguments: {} });
      assert.match(snap.content[0].text, /First/);
      assert.doesNotMatch(snap.content[0].text, /Second/);

      const timeout = await call("browser_execute", { timeout_ms: 600, code: `await browser.waitForDownload({after_id:'',timeout_ms:300000});` });
      assert.equal(timeout.status, "timeout");
      assert.ok(timeout.ms < 5000, "pending download wait is cancelled, not left running for five minutes");
      assert.match((await call("browser_open", { url: fixtureUrl })).visible_text, /Ready/);

      const webmcpUrl = "data:text/html," + encodeURIComponent(`<title>WebMCP integration</title><script>
        document.modelContext.registerTool({ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true }, execute: ({ text }) => ({ content: [{ type: "text", text }] }) });
      </script>`);
      const opened = await call("browser_open", { url: webmcpUrl });
      assert.deepEqual(opened.webmcp_tools, ["echo"]);
      assert.deepEqual((await call("browser_webmcp_tools")).tools.map(t => t.name), ["echo"]);
      const before = requests.length;
      assert.equal((await call("browser_webmcp_call", { name: "echo", arguments: { text: "fork preserved" } })).result, "fork preserved");
      assert.equal(requests.length, before, "direct WebMCP calls need no inference");
    } finally {
      await call("browser_close").catch(() => {});
      await client.close();
      await new Promise(resolve => api.close(resolve));
    }
  });
}

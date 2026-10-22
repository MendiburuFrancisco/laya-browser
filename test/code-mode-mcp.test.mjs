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
const fixtureUrl = "data:text/html," + encodeURIComponent('<title>Code Mode fixture</title><label for="name">Name</label><input id="name"><p>Ready</p>');

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
        } else answers[name] = { noul: name === "blocked" ? +blocked : name === "done" || name === "done_change" ? +(done && !blocked) : name === "q" ? 0.99 : 0 };
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
      assert.ok((await client.listTools()).tools.some(t => t.name === "browser_execute"));
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
    } finally {
      await call("browser_close").catch(() => {});
      await client.close();
      await new Promise(resolve => api.close(resolve));
    }
  });
}

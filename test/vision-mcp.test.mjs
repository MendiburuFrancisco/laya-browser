// End-to-end stdio MCP -> Code Mode/session -> System One HTTP, without paid inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const backend of ["jev", "laya"]) {
  test(`MCP and Code Mode visual contracts: ${backend}`, async () => {
    const requests = [];
    const api = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ ...body, headers: req.headers });
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === "box") answers[name] = { type: "box", box: { left: 0.1, right: 0.3, top: 0.1, bottom: 0.3 }, confidence: 0.98 };
        else if (q.type === "noul") answers[name] = { noul: name === "irreversible" ? 0 : name === "visible" ? +(body.state.target !== "missing") : name === "needs_visual" ? 1 : 0.99 };
        else { const keys = Object.keys(q.criteria); answers[name] = { choice: keys[0], confidence: 1, probabilities: Object.fromEntries(keys.map((k, i) => [k, +(i === 0)])) }; }
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ answers, usage: { input_tokens: 10 } }));
    });
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    const client = new Client({ name: "vision-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url))], env: {
      ...process.env, JEV_BACKEND: backend, TYPESAFE_API_KEY: "fixture-only", JEV_API_URL: `http://127.0.0.1:${api.address().port}/v1/systemone`,
      JEV_MODEL: "jev-latest", JEV_CACHE: "0", JEV_BROWSER_HEADED: "0", JEV_BROWSER_PROFILE: "", JEV_BROWSER_VIDEO_DIR: undefined,
    } }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, result.content[0]?.text); return JSON.parse(result.content[0].text);
    };
    const url = "data:text/html," + encodeURIComponent('<style>body{margin:0}</style><button style="position:absolute;left:50px;top:50px;width:100px;height:100px" onclick="document.querySelector(\'p\').textContent=\'Clicked\'">Square</button><p style="position:absolute;top:300px">Ready</p>');
    try {
      await call("browser_open", { url, viewport: { width: 500, height: 500 } });
      const tools = (await client.listTools()).tools.map(t => t.name);
      assert.equal(tools.includes("browser_box"), backend === "jev");
      assert.equal(tools.includes("browser_act_box"), backend === "jev");
      if (backend === "laya") {
        const failed = await client.callTool({ name: "browser_check", arguments: { question: "visual color", visual: true } });
        assert.equal(failed.isError, true); assert.match(failed.content[0].text, /only.*Jev/);
        const code = await call("browser_execute", { code: `return await browser.box({target:'square'});` });
        assert.notEqual(code.status, "done");
        assert.equal(requests.length, 0, "Laya never receives images or box questions");
        await call("browser_check", { question: "Is the page ready?" });
        assert.equal(requests.length, 1); assert.equal(requests[0].assets, undefined);
      } else {
        const checked = await call("browser_check", { question: "visual color" });
        assert.equal(checked.p_yes, 0.99); assert.equal(checked.decision_calls, 2);
        assert.equal(requests[0].model, "jev-latest");
        await call("browser_choose", { question: "What color?", options: ["black", "red"], visual: true });
        const found = await call("browser_box", { target: "Square button" });
        assert.equal(found.status, "done"); assert.deepEqual(found.point, { x: 100, y: 100 });
        await call("browser_act_box", { box_id: found.box_id, goal: "Click square" });
        assert.match((await call("browser_get_html")).html, />Clicked</);
        await call("browser_open", { url });
        const code = await call("browser_execute", { code: `
          const checked = await browser.check({question:'visual color',visual:true});
          const selected = await browser.box({target:'Square button'});
          await browser.actBox({box_id:selected.box_id,goal:'Click square'});
          return {p:checked.p_yes,html:(await browser.getHtml()).html};
        ` });
        assert.equal(code.status, "done", code.info); assert.equal(code.result.p, 0.99); assert.match(code.result.html, />Clicked</);
        const absent = await call("browser_execute", { code: `await browser.box({target:'missing'}); return 'wrong';` });
        assert.equal(absent.status, "not_found");
        for (const request of requests.filter(r => r.assets)) {
          assert.equal(request.model, "jev-preview");
          assert.equal(request.headers["typesafe-danger-zone-images"], "true");
          const [ref, asset] = Object.entries(request.assets)[0];
          assert.equal(asset.format, "png");
          assert.ok(JSON.stringify(request.state).includes(ref));
          const meta = await sharp(Buffer.from(asset.data_base64, "base64")).metadata();
          assert.equal(meta.width, 500); assert.equal(meta.height, 500);
          if (request.questions.box) assert.equal(request.questions.box.criteria, undefined);
        }
        assert.ok(requests.some(r => r.questions.box && r.questions.visible));
      }
    } finally { await call("browser_close").catch(() => {}); await client.close(); await new Promise(resolve => api.close(resolve)); }
  });
}

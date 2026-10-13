#!/usr/bin/env node
// WebMCP demo: a planner page registers its own tools (add, complete, move, re-prioritise, list).
// Every step is a plain browser_do goal, as Claude would write it. Each round Jev sees the page's
// tools next to its buttons and picks: call a tool (filling its arguments from `values`, or from
// the schema's options for list and priority), or click when no tool fits (filters, "Clear completed").
//
//   node examples/webmcp-demo.mjs              # headed
//   JEV_BROWSER_HEADED=0 node examples/webmcp-demo.mjs
//   STEP_MS=800 node examples/webmcp-demo.mjs  # pause between steps, for watching
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STEP_MS = +(process.env.STEP_MS ?? 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAGE = readFileSync(new URL("./webmcp-planner.html", import.meta.url), "utf8");

const STEPS = [
  ["Add every grocery item to the groceries list", { g1: "milk", g2: "eggs", g3: "sourdough bread", g4: "coffee beans", g5: "apples", g6: "basmati rice" }],
  ["Add the errands to the errands list; picking up the prescription is high priority", { e1: "pick up prescription", e2: "return library books", e3: "post the package" }],
  ["Add 'prepare Q3 report' to the work list as high priority", { task: "prepare Q3 report" }],
  ["Add 'book dentist appointment' to the errands list as low priority", { task: "book dentist appointment" }],
  ["Mark eggs, coffee beans and the library books errand as done", { a: "eggs", b: "coffee beans", c: "return library books" }],
  ["Move 'post the package' to the work list", { item: "post the package" }],
  ["Make 'apples' high priority", { item: "apples" }],
  ["Clear the completed items", {}],
  ["Show only the high priority items", {}],
];
const CHECKS = [
  "Does the planner show only high-priority items, and are 'pick up prescription', 'prepare Q3 report' and 'apples' among them?",
];

const http = createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
await new Promise(r => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}/`;

const server = fileURLToPath(new URL("../bin/jev-browser-mcp.mjs", import.meta.url));
const client = new Client({ name: "webmcp-demo", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { JEV_BROWSER_HEADED: "1", ...process.env } }));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const t0 = Date.now();
let tools = 0, clicks = 0, jevCalls = 0, failed = 0;
try {
  const opened = await call("browser_open", { url });
  console.log(`page tools: ${opened.webmcp_tools.join(", ")}\n`);
  for (const [goal, values] of STEPS) {
    const r = await call("browser_do", { goal, values, max_actions: 12 });
    const acts = r.actions.filter(a => !a.startsWith("(event)"));
    tools += acts.filter(a => a.startsWith("webmcp")).length;
    clicks += acts.filter(a => a.startsWith("click")).length;
    jevCalls += r.jev_calls;
    if (r.status !== "done") failed++;
    console.log(`${r.status === "done" ? "✔" : "✖"} ${goal}  [${r.status}, ${(r.ms / 1000).toFixed(1)} s, ${r.jev_calls} Jev calls]`);
    for (const a of acts) console.log(`    ${a.replace(/^webmcp tool /, "tool ").replace(/ => .*$/, "")}`);
    await sleep(STEP_MS);
  }
  for (const q of CHECKS) {
    const p = await call("browser_check", { question: q });
    jevCalls++;
    if (p.p_yes < 0.6) failed++;
    console.log(`${p.p_yes >= 0.6 ? "✔" : "✖"} check: ${q}  p_yes ${p.p_yes}`);
  }
  // ground truth from the page's own data, not Jev's opinion
  const final = JSON.parse((await call("browser_webmcp_call", { name: "list_items" })).result);
  const want = {
    groceries: ["milk", "sourdough bread", "apples", "basmati rice"], errands: ["pick up prescription", "book dentist appointment"], work: ["prepare Q3 report", "post the package"],
  };
  const pri = { "pick up prescription": "high", "prepare Q3 report": "high", apples: "high", "book dentist appointment": "low" };
  const problems = [];
  for (const [list, names] of Object.entries(want)) {
    const got = final.filter(i => i.list === list).map(i => i.text).sort();
    if (JSON.stringify(got) !== JSON.stringify([...names].sort())) problems.push(`${list}: ${got.join(", ")}`);
  }
  for (const i of final) if ((pri[i.text] ?? "normal") !== i.priority) problems.push(`${i.text} is ${i.priority}`);
  if (final.some(i => i.done)) problems.push("completed items were not cleared");
  if (problems.length) failed++;
  console.log(`${problems.length ? "✖" : "✔"} page data: ${problems.length ? problems.join("; ") : `${final.length} items, every list, priority and completion as asked`}`);
  console.log(`\n${failed ? "FAILED" : "passed"}: ${STEPS.length} goals, ${tools} tool calls + ${clicks} clicks chosen by Jev, ${jevCalls} Jev calls, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(Math.max(STEP_MS, 1500));
  await call("browser_close");
  if (failed) process.exitCode = 1;
} finally {
  await client.close(); http.close();
}

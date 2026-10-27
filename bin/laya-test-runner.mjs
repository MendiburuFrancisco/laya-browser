#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const [suiteId, artifactDir] = process.argv.slice(2);
const allowed = new Set(["demo-form", "demo-controls", "demo-failure"]);
const html = `<!doctype html><html><head><title>Executor fixture</title></head><body>
  <label for="email">Email address</label><input id="email" type="email">
  <label><input id="newsletter" type="checkbox"> Subscribe</label>
  <label for="country">Country</label><select id="country"><option value="ar">Argentina</option><option value="cl">Chile</option></select>
</body></html>`;

function fixtureAnswers(state, questions) {
  const page = state.page ?? {}, task = state.task ?? {}, goal = String(task.goal ?? "").toLowerCase();
  const elements = page.elements ?? [];
  const value = task.values ?? {};
  const email = elements.find(e => /email/.test(String(e.label ?? "").toLowerCase()) || String(e.tag ?? "").includes(":email"));
  const checkbox = elements.find(e => e.tag === "input:checkbox" && /subscribe/i.test(String(e.label ?? "")));
  const country = elements.find(e => e.tag === "select" && /country/i.test(String(e.label ?? "")));
  const done = goal.includes("email") ? !!email && email.value === value.email
    : /subscribe|checkbox|newsletter/.test(goal) ? !!checkbox?.checked
      : /country|chile/.test(goal) ? country?.value === "Chile" : false;
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      const yes = ["done", "done_change", "complete"].includes(name) ? done : false;
      answers[name] = { noul: yes ? 1 : 0, confidence: 1 };
      continue;
    }
    const options = Object.keys(q.criteria ?? {});
    let choice = options[0];
    if (name === "tool") {
      const requested = done ? "none" : goal.includes("email") ? "type" : /country|chile/.test(goal) ? "select" : "click";
      if (options.includes(requested)) choice = requested;
    } else if (name === "target") {
      const target = goal.includes("email") ? email : /country|chile/.test(goal) ? country : checkbox;
      if (target && options.includes(String(target.i))) choice = String(target.i);
    } else if (name === "value") {
      if (options.includes("email")) choice = "email";
      else if (options.includes("country")) choice = "country";
    } else if (name === "opt") {
      const chile = options.find(option => /chile/i.test(option));
      if (chile) choice = chile;
    }
    answers[name] = { choice, confidence: 1, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])) };
  }
  return answers;
}

let browser, decisions;
const cases = [], startedAt = new Date().toISOString();
try {
  if (!allowed.has(suiteId)) throw new Error("Unknown suite");
  await mkdir(artifactDir, { recursive: true });
  decisions = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    try {
      const request = JSON.parse(raw), answers = fixtureAnswers(request.state, request.questions);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ answers, usage: { input_tokens: 0 } }));
    } catch { res.writeHead(400); res.end("{}"); }
  });
  decisions.listen(0, "127.0.0.1"); await new Promise(resolve => decisions.once("listening", resolve));
  process.env.JEV_BACKEND = "jev";
  process.env.JEV_API_URL = `http://127.0.0.1:${decisions.address().port}/v1/systemone`;
  process.env.TYPESAFE_API_KEY = "local-fixture-key-not-a-secret";
  process.env.JEV_CACHE = "0";
  const { JevBrowser } = await import("../src/session.mjs");
  browser = await JevBrowser.launch({ downloadsDir: join(artifactDir, "downloads") });
  await browser.page.setContent(html);

  const steps = suiteId === "demo-form" ? [{ id: "fill-email", goal: "Enter the supplied email in the Email address field", values: { email: "benchmark@example.org" } }]
    : suiteId === "demo-controls" ? [
      { id: "subscribe", goal: "Check the Subscribe checkbox", expected: "newsletter" },
      { id: "country", goal: "Select Chile in the Country dropdown", values: { country: "Chile" }, expected: "country" },
    ] : [{ id: "intentional-failure", goal: "Enter the supplied email in the Email address field", values: { email: "benchmark@example.org" }, expected: "intentional" }];

  for (const step of steps) {
    const execution = await browser.do(step.goal, { values: step.values ?? {}, maxActions: 4, allowIrreversible: false });
    const snapshot = await browser.snapshot();
    let passed = execution.status === "done";
    if (step.expected === "newsletter") passed &&= await browser.page.locator("#newsletter").isChecked();
    if (step.expected === "country") passed &&= await browser.page.locator("#country").inputValue() === "cl";
    if (step.values?.email) passed &&= await browser.page.locator("#email").inputValue() === step.values.email;
    if (step.expected === "intentional") passed = false;
    const failed = !passed;
    cases.push({ id: step.id, status: failed ? "failed" : "passed", frameworkStatus: execution.status,
      checks: [{ id: step.expected ?? "email-value", passed, ...(failed ? { message: step.expected === "intentional" ? "Intentional failure to demonstrate reporting" : "Framework step or DOM postcondition failed" } : {}) }] });
    console.log(`${step.id}: ${failed ? "failed" : "passed"} (framework=${execution.status}; ${snapshot.elements.length} elements inspected)`);
  }
  const failedCount = cases.filter(test => test.status === "failed").length;
  const result = { schemaVersion: 1, suiteId, status: failedCount ? "failed" : "passed", decisionBackend: "fixture",
    startedAt, finishedAt: new Date().toISOString(),
    summary: { total: cases.length, passed: cases.length - failedCount, failed: failedCount, skipped: 0 }, cases, artifacts: [] };
  await writeFile(join(artifactDir, "../runner-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`Runner result: ${result.status} (${result.summary.passed}/${result.summary.total})`);
  process.exitCode = failedCount ? 1 : 0;
} catch (error) {
  console.error(`Runner error: ${error.message}`);
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  if (decisions?.listening) await new Promise(resolve => decisions.close(resolve));
}

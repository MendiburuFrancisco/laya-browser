import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCode, BrowserLease } from "../src/code-mode.mjs";
import { invokeBrowser } from "../src/browser-api.mjs";
import { JevBrowser } from "../src/session.mjs";

test("Code Mode composes loops, branches and JSON results without exposing intermediates", async () => {
  const calls = [];
  const r = await executeCode({ code: `
    const out = [];
    for (const word of values.words) {
      const result = await browser.check({ question: word });
      if (result.p_yes > 0.85) out.push(word.toUpperCase());
    }
    return out;
  `, values: { words: ["yes", "no", "yes"] } }, {
    invoke: async (method, args) => { calls.push([method, args.question]); return { p_yes: args.question === "yes" ? 0.99 : 0.01 }; },
  });
  assert.equal(r.status, "done", r.info);
  assert.deepEqual(r.result, ["YES", "YES"]);
  assert.equal(r.operations, 3);
  assert.deepEqual(calls.map(c => c[0]), ["check", "check", "check"]);
});

test("sandbox has no Node, host network, modules or access through function constructors", async () => {
  const r = await executeCode({ code: `return {
    process: typeof process, require: typeof require, fetch: typeof fetch,
    Buffer: typeof Buffer, rpc: typeof __rpc,
    escape: await browser.open.constructor('return typeof process')()
  };` });
  assert.equal(r.status, "done", r.info);
  assert.deepEqual(Object.values(r.result), Array(6).fill("undefined"));
  const imported = await executeCode({ code: `return await import('node:fs');` });
  assert.equal(imported.status, "error");
});

test("non-done suspends outside guest try/catch and discards queued actions", async () => {
  const calls = [];
  const r = await executeCode({ code: `
    try { await Promise.all([browser.do({goal:'first'}), browser.do({goal:'second'})]); }
    catch (_) { await browser.do({goal:'bypass'}); }
    return 'incorrect';
  ` }, { invoke: async (_, args) => { calls.push(args.goal); return { status: "needs_confirmation", pending: { action: "click" } }; } });
  assert.equal(r.status, "needs_confirmation");
  assert.deepEqual(calls, ["first"]);
  assert.equal(r.suspended.operation, 1);
  assert.equal(r.result, undefined);
});

test("Promise.all is serialized against the single mutable browser session", async () => {
  let active = 0, peak = 0;
  const r = await executeCode({ code: `return await Promise.all([browser.check({question:'a'}), browser.check({question:'b'})]);` }, {
    invoke: async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 10)); active--; return { p_yes: 1 }; },
  });
  assert.equal(r.status, "done", r.info); assert.equal(peak, 1);
});

test("operation and output limits cannot be bypassed with catch", async () => {
  let calls = 0;
  const r = await executeCode({ code: `for(let i=0;i<3;i++) { try { await browser.check({question:'x'}); } catch (_) {} }`, max_operations: 2 },
    { invoke: async () => { calls++; return { p_yes: 1 }; } });
  assert.equal(r.status, "limit_exceeded"); assert.equal(calls, 2);
  const output = await executeCode({ code: `return 'x'.repeat(1000);`, max_output_chars: 100 });
  assert.notEqual(output.status, "done");
  assert.match(output.info, /Output/);
});

test("infinite computation is terminated without blocking the host", async () => {
  const started = Date.now();
  const r = await executeCode({ code: "while(true) {}", timeout_ms: 300 });
  assert.equal(r.status, "timeout", r.info);
  assert.ok(Date.now() - started < 3000);
  const next = await executeCode({ code: "return 7;" });
  assert.equal(next.result, 7);
});

test("memory exhaustion and invalid results terminate only the disposable sandbox", async () => {
  const oom = await executeCode({ code: `return 'x'.repeat(64000000);`, timeout_ms: 3000 });
  assert.notEqual(oom.status, "done");
  const circular = await executeCode({ code: `const a={}; a.self=a; return a;` });
  assert.equal(circular.status, "error");
  const syntax = await executeCode({ code: "return (" });
  assert.equal(syntax.status, "error");
});

test("timeout aborts and drains an active operation before returning", async () => {
  let pending = false, aborted = false, closed = false;
  const r = await executeCode({ code: `await browser.do({goal:'wait'}); await browser.do({goal:'late'});`, timeout_ms: 500 }, {
    invoke: async (_, __, { signal }) => {
      pending = true;
      await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; pending = false; resolve(); }, { once: true }));
      return { status: "done" };
    },
    onAbort: async () => { closed = true; },
  });
  assert.equal(r.status, "timeout");
  assert.equal(aborted, true); assert.equal(pending, false); assert.equal(closed, true);
  assert.equal(r.operations, 1);
});

test("external cancellation interrupts computation and session lease rejects overlap", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const r = await executeCode({ code: "while(true) {}" }, { signal: controller.signal });
  assert.equal(r.status, "cancelled");
  const lease = new BrowserLease();
  let release;
  const first = lease.run(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(lease.run(() => {}), /executing/);
  release(); await first;
  assert.equal(await lease.run(() => 42), 42);
});

test("dispatcher validates methods and host controls exact irreversible goals", async () => {
  const permissions = [];
  const b = { do: async (goal, opts) => { permissions.push([goal, opts.allowIrreversible]); return { status: "done" }; } };
  await invokeBrowser(b, "do", { goal: "Publish" }, { authorizedGoals: ["Publish"] });
  await invokeBrowser(b, "do", { goal: "Delete" }, { authorizedGoals: ["Publish"] });
  assert.deepEqual(permissions, [["Publish", true], ["Delete", false]]);
  await assert.rejects(invokeBrowser(b, "do", { goal: "Delete", allow_irreversible: true }), /Unrecognized/);
  await assert.rejects(invokeBrowser(b, "constructor", {}), /Unknown/);
});

test("decision budgets and cancellation are sticky before inference or actions", async () => {
  const controller = new AbortController();
  const b = Object.create(JevBrowser.prototype);
  b.execution = { signal: controller.signal, remainingCalls: 0 };
  await assert.rejects(b.call({}, {}), /budget/);
  await assert.rejects(b.act({ tool: "click" }), /budget/);
  controller.abort(new Error("cancelled"));
  await assert.rejects(b.open("data:text/html,late"), /cancelled/);
});

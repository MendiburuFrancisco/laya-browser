// Run a JSON flow: { name, url, steps: [{ goal, values?, url?, maxActions?, assert? }] }
// `assert` is a JS function source evaluated in the page after the step (ground truth for tests).
import { JevBrowser } from "./session.mjs";

export async function runFlow(flow, { headed = false, slowMo = 0, browser, recordVideo, log = console.log, stopOnFail = flow.stopOnFail !== false, allowIrreversible = false } = {}) {
  const b = await JevBrowser.launch({ headed, slowMo, browser, recordVideo });
  const t0 = Date.now(); const results = [];
  try {
    await b.open(flow.url);
    for (const [n, step] of flow.steps.entries()) {
      if (step.url) await b.open(step.url);
      const values = step.values ?? (step.text != null ? { text: step.text } : {});
      log(`step ${n + 1}: ${step.goal}`);
      let rec;
      try { rec = await b.do(step.goal, { values, maxActions: step.maxActions ?? 10, allowIrreversible: step.allowIrreversible ?? allowIrreversible, log }); }
      catch (e) { rec = { status: "exception", goal: step.goal, info: String(e.message).slice(0, 200), rounds: [] }; }
      rec.step = n + 1; rec.ok = rec.status === "done" || rec.status === "likely_done";
      if (step.assert) {
        await b.settle();
        rec.truth = await b.page.evaluate(`(${step.assert})()`).catch(e => `assert error: ${e.message.split("\n")[0]}`);
      }
      log(`  => ${rec.status}${rec.info ? ` (${rec.info})` : ""}${step.assert ? `  truth=${rec.truth}` : ""}  ${rec.jev_calls ?? 0} calls ${rec.ms ?? 0}ms`);
      results.push(rec);
      if (!rec.ok && stopOnFail) break;
    }
  } finally {
    await b.close();
  }
  return { name: flow.name, results, total_ms: Date.now() - t0, ...b.stats, ...b.videos.list(), passed: results.filter(r => r.ok).length, steps: flow.steps.length };
}

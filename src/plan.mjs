// Successful steps stay inside the MCP process; return at completion or a problem.
export async function runPlan(b, steps, { url, log = () => {} } = {}) {
  const started = Date.now(), calls = b.stats.calls;
  let completed = 0, current = 0;
  const summary = () => ({ completed, total: steps.length, remaining: steps.length - completed,
    decision_calls: b.stats.calls - calls, ms: Date.now() - started, url: b.page.url() });
  const failed = result => ({ ...summary(), status: result.status, failed_step: current + 1, goal: steps[current].goal,
    ...Object.fromEntries(["info", "pending", "candidates", "page_text"].filter(k => result[k] !== undefined).map(k => [k, result[k]])) });
  try {
    if (url) await b.open(url);
    for (const [i, step] of steps.entries()) {
      current = i;
      const downloadBaseline = b.downloads?.items.at(-1)?.id ?? "";
      const result = await b.do(step.goal, { values: step.values ?? {}, maxActions: step.max_actions ?? 10,
        allowIrreversible: step.allow_irreversible === true, log });
      if (result.status !== "done") return failed(result);
      if (step.verify) {
        if (!await verifyStep(b, step, downloadBaseline)) return failed({ status: "verification_failed",
          info: "The step was rated done, but a supplied page postcondition failed." });
      }
      completed++;
    }
    return { status: "done", ...summary() };
  } catch (error) {
    return failed({ status: "error", info: String(error.message).split("\n")[0] });
  }
}

export async function verifyStep(b, step, downloadBaseline = "") {
  await b.settle();
  const page = await b.snapshot(), checks = [], spec = step.verify;
  if (spec.url_includes !== undefined) checks.push(page.url.includes(spec.url_includes));
  if (spec.text_includes !== undefined) checks.push(page.text.includes(spec.text_includes));
  if (spec.field) {
    const { label, value_key } = spec.field;
    const element = page.elements.find(e => (e.label || e.placeholder || e.name) === label);
    const actual = element ? await b.locate(element.i).inputValue().catch(() => null) : null;
    checks.push(step.values?.[value_key] !== undefined && actual === step.values[value_key]);
  }
  if (spec.download) {
    const waited = await b.downloads.wait({ afterId: downloadBaseline, timeoutMs: spec.download.timeout_ms ?? 30000, signal: b.execution?.signal });
    checks.push(waited.downloads.some(item => item.status === "completed" && (!spec.download.filename || item.filename === spec.download.filename)));
  }
  return checks.every(Boolean);
}

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
      const result = await b.do(step.goal, { values: step.values ?? {}, maxActions: step.max_actions ?? 10,
        allowIrreversible: step.allow_irreversible === true, log });
      if (result.status !== "done") return failed(result);
      if (step.verify) {
        await b.settle();
        const page = await b.snapshot(), checks = [];
        if (step.verify.url_includes !== undefined) checks.push(page.url.includes(step.verify.url_includes));
        if (step.verify.text_includes !== undefined) checks.push(page.text.includes(step.verify.text_includes));
        if (step.verify.field) {
          const { label, value_key } = step.verify.field;
          const element = page.elements.find(e => (e.label || e.placeholder || e.name) === label);
          const expected = step.values?.[value_key];
          const actual = element ? await b.locate(element.i).inputValue().catch(() => null) : null;
          checks.push(expected !== undefined && actual === expected);
        }
        if (checks.some(ok => !ok)) return failed({ status: "verification_failed",
          info: "The step was rated done, but a supplied page postcondition failed.", page_text: page.text.slice(0, 600) });
      }
      completed++;
    }
    return { status: "done", ...summary() };
  } catch (error) {
    return failed({ status: "error", info: String(error.message).split("\n")[0] });
  }
}

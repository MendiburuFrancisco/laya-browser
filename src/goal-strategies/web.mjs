import { FIELDISH, brief, pageDiff, redactPage, pickCloser } from "../page-model.mjs";
import { cacheKey } from "../locator-cache.mjs";
import { BOX_ACTIONS } from "../vision.mjs";

const TARGETED = new Set(["click", "type", "clear", "press_enter", "select", "hover", "right_click", "drag", "upload"]);
const GUARDED = new Set(["click", "press_enter", "press_key"]);
const label = action => action.boxId ? `box ${action.boxId}` : action.tool === "webmcp" ? `tool ${action.webmcp}` : brief(action.el);

export class WebGoalStrategy {
  constructor(browser, { backend, keys, actionError, repeatsBlock }) {
    this.browser = browser;
    this.backend = backend;
    this.keys = keys;
    this.errorMessage = actionError;
    this.repeatsBlock = repeatsBlock;
    this.stopOnActionError = true;
    this.actionErrorPhase = "web_action";
  }

  initialize(context) {
    context.waits = 0;
    context.retried = false;
    context.dismissed = new Map();
    this.browser.promptText = context.values.prompt;
  }

  maxRounds(context) { return context.options.maxActions + 10; }
  budgetExceeded(context) { return context.actionsTaken >= context.options.maxActions; }
  guarded(action) { return GUARDED.has(action.tool) || (action.tool === "webmcp" && !action.readOnly); }
  confirmationInfo() { return "the next action looks hard to undo; call again with allow_irreversible to proceed"; }
  confirmationPending(context, decision) {
    const action = decision.action;
    return { action: action.tool, element: label(action), ...(action.argKeys ? { args: action.argKeys } : {}),
      ...(action.key ? { key: action.key } : {}), p_irreversible: decision.round.irreversible };
  }

  async beforeDecide(context) {
    const b = this.browser, { page, goal, values, round, options } = context;
    context.cacheKey = b.cache && context.actionsTaken < options.maxActions ? cacheKey(goal, page.url, round) : null;
    const cached = context.cacheKey ? b.cache.get(context.cacheKey) : null;
    if (!cached) return;
    const action = context.driver.resolveCachedAction(page, cached, values);
    if (!action) {
      b.cache.evict(context.cacheKey);
      return;
    }
    let irreversibleScore = 0;
    if (this.guarded(action)) {
      const { answers } = await context.call({ page, task: { goal }, cached_action: { tool: action.tool, target: action.target } }, {
        irreversible: { type: "noul", instructions: "Would `cached_action` toward `task.goal` on the CURRENT `page` have a hard-to-undo external effect such as paying, sending, deleting or publishing?" },
      });
      irreversibleScore = answers.irreversible?.noul;
    }
    return { cached: true, action, irreversibleScore,
      round: { round, cached: true, tool: action.tool, p_tool: 1, target: action.target, p_target: 1,
        el: brief(action.el), value: action.valueKey, elements: page.elements.length, irreversible: irreversibleScore } };
  }

  async decide(context) {
    const b = this.browser, { page, goal, values, history, previousPage, options } = context;
    const webmcp = await b.webmcpTools();
    const change = previousPage ? pageDiff(redactPage(previousPage), redactPage(page)) : undefined;
    let answers = await b.decide(page, goal, values, history.slice(-12), change, webmcp);
    let action = b.resolve(page, answers, values, webmcp), image;
    if (this.backend === "jev" && (answers.needs_visual?.noul >= 0.5 ||
        (Math.max(answers.done.noul, answers.done_change?.noul ?? 0) < options.doneAt &&
          (action.tool === "none" || (TARGETED.has(action.tool) && (!action.el || action.p_target < options.minTarget)) || history.at(-1)?.error)))) {
      image = await b.captureVision();
      answers = await b.decide(page, goal, values, history.slice(-12), change, webmcp, image);
      action = b.resolve(page, answers, values, webmcp);
      if (action.tool !== "webmcp" && answers.visual_target?.choice === "box" && BOX_ACTIONS.includes(answers.tool.choice)) {
        const found = b.rememberBox(answers.box, answers.visible?.noul, image, goal);
        action = { ...action, tool: answers.tool.choice === "type" && action.value == null ? "click" : answers.tool.choice,
          target: null, el: undefined, boxId: found.box_id, p_target: found.status === "done" ? found.confidence : 0, candidates: [] };
      }
    }
    const doneScore = Math.max(answers.done.noul, answers.done_change?.noul ?? 0);
    return { action, answers, image, webmcp, doneScore, irreversibleScore: answers.irreversible?.noul,
      round: {
        round: context.round, done: +doneScore.toFixed(2), done_plain: +answers.done.noul.toFixed(2), done_change: +(answers.done_change?.noul ?? 0).toFixed(2),
        blocked: +answers.blocked.noul.toFixed(2), error_shown: +answers.error.noul.toFixed(2), login: +answers.login.noul.toFixed(2), irreversible: +(answers.irreversible?.noul ?? 1).toFixed(2),
        tool: action.tool, p_tool: +action.p_tool.toFixed(2), target: action.target, p_target: +action.p_target.toFixed(2), el: label(action),
        value: action.valueKey, elements: page.elements.length, stages: answers.stages, candidates: action.candidates,
        ...(image ? { visual: true, ...(action.boxId ? { box: answers.box.box, box_id: action.boxId } : {}) } : {}),
      } };
  }

  log(context, decision) {
    const r = decision.round;
    context.options.log(`  r${context.round}: ${decision.cached ? "[cache] " : ""}${r.tool} -> #${r.target ?? "-"} ${r.el}${r.value ? ` value=${r.value}` : ""} done=${r.done ?? "-"}`);
  }

  async terminal(decision, context) {
    if (decision.cached) return;
    const b = this.browser, { answers: a, action, doneScore: done, image, webmcp } = decision;
    const { round, goal, page, history, options, values } = context;
    if (round > 0 ? done >= options.doneAt && done < 0.85 && action.tool !== "none" : done >= 0.9) {
      const confirmed = await context.call({ page, task: { goal, history: history.slice(-12) }, ...(image ? { screenshot: image.ref } : {}) }, {
        complete: { type: "noul", instructions: "Is everything `task.goal` asks for already finished on `page`, so that no further action (such as pressing a submit, search or continue button) is needed?" + (image ? " Also judge the visible pixels in `screenshot`." : "") },
      }, image ? { assets: image.assets } : {});
      decision.round.confirm = +confirmed.answers.complete.noul.toFixed(2);
      if (decision.round.confirm >= 0.65) return { status: "done" };
      if (decision.round.confirm >= 0.45) return { status: "likely_done", info: "the page looks done but Jev is unsure; verify with a check, snapshot or screenshot" };
      if (action.tool === "none" && a.use_tool?.noul >= 0.5) {
        Object.assign(action, b.resolve(page, { ...a, tool: { ...a.tool, choice: "webmcp" } }, values, webmcp));
        decision.round.tool = action.tool;
        decision.round.el = label(action);
      }
      if (a.irreversible?.noul >= options.irreversibleAt && this.guarded(action)) {
        return { status: "done", info: "stopped before an action that looks irreversible and may go beyond this goal",
          pending: { action: action.tool, element: label(action), p_irreversible: decision.round.irreversible } };
      }
    } else if (done >= (round > 0 ? options.doneAt : 0.9) && (done >= 0.85 || action.tool === "none" || round === 0)) return { status: "done" };
    if (this.budgetExceeded(context)) return;
    if (a.login.noul >= 0.7 && !Object.keys(values).length) return { status: "needs_login", info: "the page wants a sign-in and no values were given; log in (e.g. in a headed persistent profile) or pass credentials in values" };
    if (round > 0 && a.error.noul >= 0.7) return { status: "error", info: "the page shows an error after the last action" };
    if (action.tool === "none" && round === 0 && !context.retried) {
      context.retried = true;
      return { retry: true, delay: 1500 };
    }
    if (action.tool === "none" && round > 0 && done >= 0.35 && a.error.noul < 0.5 && a.blocked.noul < 0.5) return { status: "likely_done", info: "no further action seems needed but Jev is unsure the goal is met; verify with a check, snapshot or screenshot" };
    if (action.tool === "none") return { status: a.blocked.noul >= 0.5 ? "blocked" : "stuck" };
    if (a.blocked.noul >= 0.85) return { status: "blocked" };
  }

  validate(decision, context) {
    const action = decision.action;
    if (!context.driver.actionSpace(context.page).includes(action.tool) && !(action.tool === "webmcp" && decision.webmcp?.length)) return { status: "error", info: "Decision backend selected an unpublished web action" };
    if (action.tool === "wait") {
      if (++context.waits > 6) return { status: "stuck", info: "page never finished loading" };
      return;
    }
    if ((TARGETED.has(action.tool) || action.tool === "webmcp") && action.p_target < context.options.minTarget) return { status: "ambiguous", info: "target confidence too low; refine the goal or act on a candidate directly" };
    const sequence = [...context.history.filter(entry => entry.action).map(entry => `${entry.action}|${entry.element}|${entry.value ?? ""}`),
      `${action.tool}|${label(action)}|${["type", "select", "upload"].includes(action.tool) ? action.valueKey ?? "" : ""}`];
    if (this.repeatsBlock(sequence, 2, 3) || this.repeatsBlock(sequence, 3, 3) || this.repeatsBlock(sequence, 1, 8)) return { status: "stuck", info: "repeating the same sequence of actions; the goal may already be done — check the page" };
  }

  signature(action, context) {
    if (action.tool === "wait") return null;
    return `${action.tool}|${label(action)}|${["type", "select", "upload"].includes(action.tool) ? action.valueKey : ""}|${context.page.url}|${context.page.text}|${JSON.stringify(context.page.elements)}`;
  }
  repeatInfo() { return "repeating the same action on the same page without progress"; }

  async prepare(decision, context) {
    const action = decision.action, { page, goal, history, values } = context;
    if (action.tool === "select" && action.value == null && action.el?.options?.length) {
      const { answers } = await context.call({ page, task: { goal }, dropdown: action.el }, { opt: { type: "choice", instructions: "Which option of `dropdown.options` should be chosen for `task.goal`?", criteria: Object.fromEntries(action.el.options.map(option => [option, null])) } });
      action.value = answers.opt.choice;
      action.valueKey = undefined;
    }
    if (action.tool === "press_key") {
      const { answers } = await context.call({ page: { url: page.url, title: page.title, text: page.text, dialogs: page.dialogs }, task: { goal, history: history.slice(-6) } }, { key: { type: "choice", instructions: "Which keyboard key should be pressed next for `task.goal`?", criteria: Object.fromEntries(this.keys.map(key => [key, null])) } });
      action.key = answers.key.choice;
      if (!action.el || !(FIELDISH(action.el) || action.el.tag.startsWith("input"))) action.target = null;
    }
    if (action.tool === "drag") {
      const others = page.elements.filter(element => element.i !== action.target).slice(0, 240);
      if (!others.length) return { status: "stuck", info: "nothing on the page to drop onto" };
      const { answers } = await context.call({ page: { ...page, elements: others }, task: { goal, dragging: brief(action.el) } }, { dest: { type: "choice", instructions: "Onto which entry of `page.elements` (by its `i`) should `task.dragging` be dropped for `task.goal`?", criteria: Object.fromEntries(others.map(element => [String(element.i), null])) } });
      action.destination = +answers.dest.choice;
      decision.round.destination = brief(page.elements.find(element => element.i === action.destination));
    }
    if (action.tool === "webmcp" && !action.args) action.args = await this.browser.webmcpArgs(page, goal, history.slice(-12), action, values);
    if (this.browser.highlight && action.target != null) await this.browser.showDecision(action, decision.round).catch(() => {});
  }

  history(action, context, decision) {
    const entry = { action: action.tool, element: label(action) };
    if (action.argKeys && Object.keys(action.argKeys).length) entry.args = action.argKeys;
    if (action.tool === "select" && action.value != null) entry.option = action.value;
    if (action.valueKey && ["type", "select", "upload"].includes(action.tool)) entry.value = action.valueKey;
    if (action.key) entry.key = action.key;
    if (decision.round.destination) entry.destination = decision.round.destination;
    return entry;
  }

  async actionError(error, context, decision, history) {
    if (context.cacheKey) this.browser.cache?.evict(context.cacheKey);
    context.options.log(`  ! ${history.error}`);
    return this.afterAction(decision, context, history);
  }

  failedAction(error, context, decision) {
    if (decision.cached && context.cacheKey) this.browser.cache?.evict(context.cacheKey);
  }

  canRecover(error, context, decision) {
    return decision.action.tool === "click" && this.errorMessage(error).startsWith("click blocked");
  }

  async afterAction(decision, context, history) {
    const b = this.browser, action = decision.action;
    if (decision.cached && !history.error) context.cacheHits++;
    const cacheEntry = context.driver.cacheEntry(action);
    if (!decision.cached && b.cache && context.cacheKey && !history.error && !b.heldDialog && cacheEntry &&
        ["click", "type", "press_enter", "select", "hover", "right_click", "upload"].includes(action.tool) && decision.irreversibleScore < context.options.irreversibleAt) {
      b.cache.put(context.cacheKey, cacheEntry);
      context.cacheSaved++;
    }
    if (history.error?.startsWith("click blocked") && (context.dismissed.get(context.page.url) ?? 0) < 2) {
      const now = await context.driver.snapshot().catch(() => null);
      const closer = now && pickCloser(now.elements, now.url);
      if (closer) {
        context.dismissed.set(now.url, (context.dismissed.get(now.url) ?? 0) + 1);
        const entry = { action: "dismiss_overlay", element: `${closer.tag} "${String(closer.text || closer.label || closer.hint).slice(0, 50)}"` };
        try {
          await context.executeAuxiliary({ tool: "click", target: closer.i }, now, { guarded: true, irreversibleScore: 0 });
          await context.driver.settle({ max: 2000 });
          const after = await context.driver.snapshot();
          if (after.url !== now.url) entry.navigated = after.url;
          else if (after.elements.find(element => brief(element) === brief(action.el) && (element.near ?? "") === (action.el?.near ?? ""))?.covered) entry.still_covered = true;
        } catch (error) {
          entry.error = this.errorMessage(error);
          context.history.push(entry);
          if (error.status || error.outcome) return { status: error.status ?? "error", info: entry.error, ...(error.outcome ? { outcome: error.outcome } : {}) };
          return { status: "error", info: entry.error };
        }
        context.history.push(entry);
      }
    }
    if (b.heldDialog) {
      if (context.cacheKey) b.cache?.evict(context.cacheKey);
      return { status: "needs_confirmation", info: "the action opened a confirmation dialog that looks hard to undo, so it was dismissed; call again with allow_irreversible to accept it",
        pending: { action: history.action, element: history.element, dialog: b.heldDialog.message, p_irreversible: b.heldDialog.p_irreversible } };
    }
  }

  finalize(context, result) {
    this.browser.needsTabSnapshot = false;
    result.done_score = +(context.rounds.at(-1)?.done ?? 0);
    if (!["done", "likely_done"].includes(result.status)) {
      result.page_text = context.page?.text?.slice(0, 600);
      if (["ambiguous", "stuck", "max_actions"].includes(result.status)) result.candidates = context.rounds.at(-1)?.candidates;
    }
  }
}

import { brief } from "../page-model.mjs";

const TARGETED = new Set(["click", "type", "clear", "scroll"]);
const GUARDED = new Set(["click", "type", "clear", "back"]);

export class AndroidGoalStrategy {
  constructor(driver) {
    this.driver = driver;
    this.stopOnActionError = true;
    this.actionErrorPhase = "mobile_action";
  }

  maxRounds(context) { return context.options.maxActions + 10; }
  budgetInfo(context) { return `No completion after ${context.options.maxActions} Android actions`; }
  repeatInfo() { return "Android action is not changing the screen"; }
  confirmationInfo() { return "Android action needs authorization for this exact goal"; }

  async decide(context) {
    const { page, goal, history, shownValues, options } = context;
    const tools = this.driver.actionSpace(page);
    const actionable = page.elements.filter(element => element.actions.length).slice(0, 240);
    const task = { goal, history, ...(Object.keys(shownValues).length ? { values: shownValues } : {}) };
    const questions = {
      done: { type: "noul", instructions: "Does the Android screen in `page` show that `task.goal` has been achieved, given `task.history`?" },
      blocked: { type: "noul", instructions: "Does `page` show something that prevents progress toward `task.goal` and cannot be handled by the published Android actions?" },
      error: { type: "noul", instructions: "Does `page` show an error caused by `task.history`?" },
      login: { type: "noul", instructions: "Is `page` requiring sign-in before `task.goal` can continue?" },
      irreversible: { type: "noul", instructions: "Would the next Android action toward `task.goal` have a hard-to-undo external effect such as paying, sending, deleting, granting permission or changing a persistent setting?" },
      tool: { type: "choice", instructions: "Choose the next Android action toward `task.goal`. Only published actions are available.", criteria: Object.fromEntries(tools.map(tool => [tool, null])) },
      ...(tools.includes("scroll") ? { direction: { type: "choice", instructions: "If scrolling, which direction reveals progress toward task.goal?", criteria: { down: "Reveal content below", up: "Reveal content above" } } } : {}),
      ...(actionable.length ? { target: { type: "choice", instructions: "If the action needs an element, choose its `i` from `page.elements`. Its `actions` must include the chosen action.", criteria: Object.fromEntries(actionable.map(element => [String(element.i), null])) } } : {}),
      ...(Object.keys(shownValues).length ? { value: { type: "choice", instructions: "If the action types text, which `task.values` key supplies it?", criteria: Object.fromEntries(Object.entries(shownValues).map(([key, value]) => [key, String(value).slice(0, 200)])) } } : {}),
    };
    const { answers } = await context.call({ page, task }, questions);
    const tool = answers.tool?.choice;
    const target = !TARGETED.has(tool) || answers.target?.choice == null ? null : Number(answers.target.choice);
    const element = target == null ? null : page.elements.find(candidate => candidate.i === target);
    const valueKey = answers.value?.choice;
    const action = { tool, target, element,
      value: tool === "type" && valueKey != null ? context.values[valueKey] : undefined,
      valueKey,
      direction: tool === "scroll" ? (answers.direction?.choice === "up" ? "up" : "down") : undefined };
    return {
      answers, action, doneScore: answers.done?.noul ?? 0,
      irreversibleScore: answers.irreversible?.noul,
      round: { round: context.round, tool, target, element: brief(element),
        ...(valueKey && tool === "type" ? { value: valueKey } : {}) },
      targetProbability: answers.target?.probabilities?.[String(target)] ?? 0,
    };
  }

  terminal(decision, context) {
    const { answers, action, doneScore } = decision;
    if (doneScore >= context.options.doneAt) return { status: "done", done_score: doneScore };
    if (context.actionsTaken >= context.options.maxActions) return;
    if ((answers.blocked?.noul ?? 0) >= 0.7) return { status: "blocked" };
    if ((answers.error?.noul ?? 0) >= 0.7) return { status: "error" };
    if ((answers.login?.noul ?? 0) >= 0.7) return { status: "needs_login", info: "Android app requires login; provide credentials or log in manually" };
    if (!this.driver.actionSpace(context.page).includes(action.tool)) return { status: "error", info: "Decision backend selected an unpublished Android action" };
    if (action.tool === "none") return { status: "stuck" };
    if (TARGETED.has(action.tool) && (!action.element || !action.element.actions.includes(action.tool) || decision.targetProbability < context.options.minTarget)) {
      return { status: "ambiguous", info: `Chosen Android target is missing or does not support ${action.tool}` };
    }
    if (action.tool === "type" && (action.valueKey == null || context.values[action.valueKey] == null)) {
      return { status: "ambiguous", info: "Android type action needs one of the supplied values" };
    }
  }

  guarded(action) { return GUARDED.has(action.tool); }
  signature(action, context) { return `${context.page.fingerprint}:${action.tool}:${action.target}:${action.valueKey ?? ""}`; }
  history(action) {
    return { action: action.tool, element: brief(action.element),
      ...(action.valueKey && action.tool === "type" ? { value: action.valueKey } : {}) };
  }
  errorMessage(error) { return String(error.message).slice(0, 300); }
  afterAction(decision, context) {
    context.options.log(`  r${context.round}: ${decision.action.tool} -> #${decision.action.target ?? "-"} ${decision.round.element}`);
  }
}

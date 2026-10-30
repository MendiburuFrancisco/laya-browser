import { redactPage, redactValues, SECRET_KEY, REDACTED } from "./page-model.mjs";
import { assertFreshness, assertObservation } from "./drivers/contract.mjs";

export function redactStrings(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets ?? []) value = value.split(REDACTED).map(part => part.split(secret).join(REDACTED)).join(REDACTED);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactStrings(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, secrets)]));
  return value;
}

export function redactState(driver, state) {
  if (state.page) state = { ...state, page: redactPage(state.page) };
  return driver.secrets?.size ? redactStrings(state, driver.secrets) : state;
}

export function registerSecrets(driver, values, minimumLength = 1) {
  driver.secrets ??= new Set();
  for (const [key, value] of Object.entries(values)) {
    if (SECRET_KEY.test(key) && String(value).length >= minimumLength) driver.secrets.add(String(value));
  }
}

export function assertExecution(driver) {
  driver.execution?.signal?.throwIfAborted();
  if (driver.execution?.error) throw driver.execution.error;
}

export function consumeAction(driver) {
  assertExecution(driver);
  if (driver.execution && driver.execution.remainingActions-- <= 0) {
    driver.execution.error = Object.assign(new Error("Browser action budget exhausted"), { status: "limit_exceeded" });
    throw driver.execution.error;
  }
}

export async function callDecision(driver, state, questions, options = {}) {
  assertExecution(driver);
  if (driver.execution && driver.execution.remainingCalls-- <= 0) {
    driver.execution.error = Object.assign(new Error("Decision call budget exhausted"), { status: "limit_exceeded" });
    throw driver.execution.error;
  }
  const result = await driver.ask(redactState(driver, state), questions, { ...options, signal: driver.execution?.signal });
  driver.stats.calls++;
  driver.stats.jev_ms += result.ms;
  driver.stats.tokens += result.tokens;
  assertExecution(driver);
  return result;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class GoalRunner {
  constructor(driver, strategy) {
    this.driver = driver;
    this.strategy = strategy;
  }

  async run(goal, options = {}) {
    const driver = this.driver;
    const strategy = this.strategy;
    const opts = { values: {}, maxActions: 10, doneAt: 0.5, minTarget: 0.3,
      allowIrreversible: false, irreversibleAt: 0.6, log: () => {}, ...options };
    registerSecrets(driver, opts.values, strategy.secretMinimumLength ?? 1);
    const log = opts.log;
    opts.log = message => log(redactStrings(String(message), driver.secrets));
    const context = {
      driver, strategy, goal, options: opts, values: opts.values, shownValues: redactValues(opts.values),
      history: [], rounds: [], started: Date.now(), calls: driver.stats.calls, actionsTaken: 0,
      cacheHits: 0, cacheSaved: 0, previousPage: null, page: null, round: 0,
      call: (state, questions, callOptions) => callDecision(driver, state, questions, callOptions),
    };
    context.executeAuxiliary = async (action, page, policy) => {
      assertExecution(driver);
      if (context.actionsTaken >= opts.maxActions) throw Object.assign(new Error("Goal action budget exhausted"), { status: "max_actions" });
      if (policy.guarded && !opts.allowIrreversible && !(policy.irreversibleScore < opts.irreversibleAt)) {
        throw Object.assign(new Error("Auxiliary action needs authorization for this exact goal"), { status: "needs_confirmation" });
      }
      const freshness = assertFreshness(await driver.fresh(page, action));
      if (!freshness.fresh) throw new Error(`Auxiliary action is stale (${freshness.reason})`);
      consumeAction(driver);
      context.actionsTaken++;
      return driver.act(action, freshness);
    };
    await strategy.initialize?.(context);
    const maxRounds = strategy.maxRounds?.(context) ?? opts.maxActions;
    const seen = new Map();
    let terminal = { status: "max_actions" };

    const finish = async outcome => {
      assertExecution(driver);
      if (driver.events?.length) context.history.push(...driver.events.splice(0).map(event => ({ event })));
      const page = context.page;
      if (page) driver.shown = page;
      const result = {
        status: outcome.status, goal, url: driver.currentUrl ?? page?.url ?? "",
        title: page?.title ?? "", actions: context.history, rounds: context.rounds,
        jev_calls: driver.stats.calls - context.calls, ms: Date.now() - context.started,
      };
      for (const key of ["info", "pending", "done_score", "outcome", "error"]) {
        if (outcome[key] !== undefined) result[key] = outcome[key];
      }
      if (context.cacheHits || context.cacheSaved) result.cache = { hits: context.cacheHits, saved: context.cacheSaved };
      await strategy.finalize?.(context, result, outcome);
      return driver.secrets?.size ? redactStrings(result, driver.secrets) : result;
    };

    for (let round = 0; round <= maxRounds; round++) {
      context.round = round;
      assertExecution(driver);
      await driver.settle();
      context.page = assertObservation(await driver.snapshot());
      driver.shown = context.page;
      if (driver.events?.length) context.history.push(...driver.events.splice(0).map(event => ({ event })));

      let decision = await strategy.beforeDecide?.(context);
      if (!decision) decision = await strategy.decide(context);
      assertExecution(driver);
      if (!decision) throw new TypeError("Goal strategy must produce a decision");
      decision.round ??= { round };
      decision.round.round ??= round;
      context.rounds.push(decision.round);
      await strategy.log?.(context, decision);

      let outcome = await strategy.terminal?.(decision, context);
      assertExecution(driver);
      if (outcome?.retry) {
        context.rounds.pop();
        await sleep(outcome.delay ?? 0);
        round--;
        continue;
      }
      if (outcome) { terminal = outcome; break; }
      if (strategy.budgetExceeded?.(context, decision) ?? context.actionsTaken >= opts.maxActions) {
        terminal = { status: "max_actions", info: strategy.budgetInfo?.(context) };
        break;
      }
      outcome = await strategy.validate?.(decision, context);
      if (outcome) { terminal = outcome; break; }
      outcome = await strategy.prepare?.(decision, context);
      if (outcome) { terminal = outcome; break; }

      const action = decision.action;
      const guarded = strategy.guarded?.(action, context) ?? false;
      if (guarded && !opts.allowIrreversible && !(decision.irreversibleScore < opts.irreversibleAt)) {
        terminal = { status: "needs_confirmation", info: strategy.confirmationInfo?.(context, decision),
          pending: strategy.confirmationPending?.(context, decision) ?? { goal } };
        break;
      }

      outcome = await strategy.beforeFresh?.(decision, context);
      if (outcome) { terminal = outcome; break; }
      const freshness = assertFreshness(await driver.fresh(context.page, action));
      if (!freshness.fresh) {
        decision.round.stale = freshness.reason;
        context.previousPage = context.page;
        continue;
      }

      const signature = strategy.signature?.(action, context);
      if (signature) {
        const count = (seen.get(signature) ?? 0) + 1;
        seen.set(signature, count);
        if (count >= (strategy.repeatLimit ?? 3)) {
          terminal = { status: "stuck", info: strategy.repeatInfo?.(context, decision) ?? "Repeating the same action without progress" };
          break;
        }
      }

      consumeAction(driver);
      context.actionsTaken++;
      const history = strategy.history?.(action, context, decision) ?? { action: action.tool };
      const started = Date.now();
      try {
        const actionResult = await driver.act(action, freshness);
        decision.round.act_ms = actionResult?.ms ?? Date.now() - started;
        if (actionResult?.result !== undefined) history.result = actionResult.result;
        else if (action.result !== undefined) history.result = action.result;
      } catch (error) {
        const message = strategy.errorMessage?.(error, context) ?? String(error.message).slice(0, 300);
        history.error = message;
        decision.round.error = message;
        context.history.push(history);
        await strategy.failedAction?.(error, context, decision, history);
        if (error.status || error.outcome || (strategy.stopOnActionError && !strategy.canRecover?.(error, context, decision))) {
          terminal = { status: error.status ?? "error", info: message };
          if (error.outcome) {
            terminal.outcome = error.outcome;
            terminal.error = { phase: strategy.actionErrorPhase ?? "action", code: error.code, outcome: error.outcome };
          }
          break;
        }
        outcome = await strategy.actionError?.(error, context, decision, history);
        if (outcome) { terminal = outcome; break; }
        context.previousPage = context.page;
        continue;
      }
      context.history.push(history);
      outcome = await strategy.afterAction?.(decision, context, history);
      if (outcome) { terminal = outcome; break; }
      context.previousPage = context.page;
    }
    return finish(terminal);
  }
}

export { sleep as goalSleep };

import { createHash } from "node:crypto";
import { AppiumClient } from "./client.mjs";
import { parseAndroidSnapshot } from "./android-snapshot.mjs";
import { formatPage, formatDiff, pageDiff, redactPage, brief, redactValues, SECRET_KEY, REDACTED } from "../../page-model.mjs";
import { performAndroidAction } from "./android-actions.mjs";
import { jev } from "../../jev.mjs";

export const ANDROID_CAPABILITIES = Object.freeze({
  driver: "appium", platform: "android", native: true, dom: false, tabs: false,
  network: false, downloads: false, video: false, vision: false,
});

// Redact strings structurally: replacing inside serialized JSON corrupts numeric
// bounds/indices when a secret happens to contain the same digits.
function redactStrings(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets ?? []) value = value.split(REDACTED).map(part => part.split(secret).join(REDACTED)).join(REDACTED);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactStrings(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, secrets)]));
  return value;
}

export class AppiumAndroidDriver {
  constructor({ client = new AppiumClient(), capabilities = {}, maxElements = 240, maxText = 12000 } = {}) {
    this.client = client;
    this.client.getSignal = () => this.execution?.signal;
    this.capabilityOverrides = capabilities;
    this.maxElements = maxElements;
    this.maxText = maxText;
    this.opened = false;
    this._capabilities = ANDROID_CAPABILITIES;
    this.stats = { calls: 0, jev_ms: 0, tokens: 0 };
    this.events = [];
    this.shown = null;
    this.diffBase = null;
  }

  assertExecution() {
    this.execution?.signal?.throwIfAborted();
    if (this.execution?.error) throw this.execution.error;
  }

  consumeAction() {
    this.assertExecution();
    if (this.execution && this.execution.remainingActions-- <= 0) {
      this.execution.error = Object.assign(new Error("Browser action budget exhausted"), { status: "limit_exceeded" });
      throw this.execution.error;
    }
  }

  async call(state, questions, options = {}) {
    this.assertExecution();
    if (this.execution && this.execution.remainingCalls-- <= 0) {
      this.execution.error = Object.assign(new Error("Decision call budget exhausted"), { status: "limit_exceeded" });
      throw this.execution.error;
    }
    if (state.page) state = { ...state, page: redactPage(state.page) };
    if (this.secrets?.size) state = redactStrings(state, this.secrets);
    const result = await this.ask(state, questions, { ...options, signal: this.execution?.signal });
    this.stats.calls++;
    this.stats.jev_ms += result.ms;
    this.stats.tokens += result.tokens;
    return result;
  }

  ask(state, questions, options) { return jev(state, questions, options); }

  async open({ package: packageName, activity } = {}) {
    if (typeof packageName !== "string" || !packageName) throw new TypeError("app.package is required");
    if (this.opened) throw new Error("Close the Android session before opening another application");
    const caps = { platformName: "Android", "appium:automationName": "UiAutomator2", ...this.capabilityOverrides,
      "appium:appPackage": packageName, ...(activity ? { "appium:appActivity": activity } : {}) };
    if (String(caps.platformName).toLowerCase() !== "android") throw new Error("Android target requires platformName=Android");
    if (caps["appium:automationName"] !== "UiAutomator2") throw new Error("Android target requires appium:automationName=UiAutomator2");
    const started = Date.now();
    await this.client.createSession(caps);
    this.package = packageName;
    this.opened = true;
    const page = await this.snapshot();
    return { ...page, ms: Date.now() - started };
  }

  async settle({ quiet = 300, max = 3000 } = {}) {
    const started = Date.now(); let last = "", stableAt = Date.now();
    do {
      this.assertExecution();
      const current = (await this.snapshot()).fingerprint;
      if (current !== last) { last = current; stableAt = Date.now(); }
      else if (Date.now() - stableAt >= quiet) return Date.now() - started;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() - started < max);
    return Date.now() - started;
  }

  async snapshot() {
    const [source, currentPackage, currentActivity] = await Promise.all([
      this.client.command("GET", "source"),
      this.client.command("GET", "appium/device/current_package"),
      this.client.command("GET", "appium/device/current_activity"),
    ]);
    let snapshot = parseAndroidSnapshot(source, { packageName: currentPackage || this.package, activity: currentActivity, maxElements: this.maxElements, maxText: this.maxText });
    if (this.secrets?.size) {
      const native = snapshot.elements.map(element => element._native);
      snapshot = redactStrings(snapshot, this.secrets);
      snapshot.elements.forEach((element, index) => Object.defineProperty(element, "_native", { value: native[index], enumerable: false }));
    }
    const semanticState = JSON.stringify(redactStrings({ url: snapshot.url, text: snapshot.text, elements: snapshot.elements,
      identities: snapshot.elements.map(element => element._native.identity) }, this.secrets));
    snapshot.fingerprint = createHash("sha256").update(semanticState).digest("hex");
    this.currentUrl = snapshot.url;
    this.lastPage = snapshot;
    return snapshot;
  }

  async fresh(snapshot, action = {}) {
    const current = await this.snapshot();
    if (snapshot?.fingerprint !== current.fingerprint) return { fresh: false, reason: "page_changed", current };
    if (action.target == null) return { fresh: true, current };
    const element = current.elements.find(candidate => candidate.i === action.target);
    if (!element) return { fresh: false, reason: "target_missing", current };
    const previous = snapshot.elements.find(candidate => candidate.i === action.target);
    if (!previous || previous.label !== element.label || previous.text !== element.text || previous.role !== element.role || JSON.stringify(previous.bounds) !== JSON.stringify(element.bounds) || JSON.stringify(previous.actions) !== JSON.stringify(element.actions)) {
      return { fresh: false, reason: "target_changed", current };
    }
    return { fresh: true, current, element };
  }

  async actOn({ action, element, value, key, destination, acceptDialog = false }) {
    const started = Date.now();
    if (!["click", "type", "clear", "scroll", "back", "wait"].includes(action)) throw new Error(`Android does not support ${action}`);
    if (["click", "type", "clear"].includes(action) && element == null) throw new Error(`${action} needs an element`);
    if (action === "scroll" && value != null && !["up", "down"].includes(value)) throw new Error("scroll value must be up or down");
    let resolved;
    if (element != null) {
      if (!this.shown) throw new Error("Take a browser_snapshot before acting on element numbers");
      const freshness = await this.fresh(this.shown, { target: element });
      if (!freshness.fresh) throw new Error(`Android element ${element} is stale (${freshness.reason}); take a new snapshot`);
      resolved = freshness.element;
      if (!resolved.actions.includes(action)) throw new Error(`Android element ${element} does not support ${action}`);
    } else if (action === "scroll") {
      const page = await this.snapshot();
      resolved = page.elements.find(candidate => candidate.actions.includes("scroll"));
      if (!resolved) throw new Error("No scrollable Android container is visible");
    }
    if (action === "type" && value == null) throw new Error("no value to type");
    this.consumeAction();
    if (action === "wait") await new Promise(resolve => setTimeout(resolve, 1000));
    else await performAndroidAction(this.client, resolved, { tool: action, value, direction: value ?? "down" });
    this.assertExecution();
    await this.settle();
    const page = await this.snapshot();
    this.shown = null;
    return { action, element: brief(resolved), ms: Date.now() - started, url: page.url, title: page.title };
  }

  async readValue(element) {
    if (element?.role !== "textbox") return element?.text ?? null;
    if (element._native.showingHint) return "";
    const id = await this.client.findElement(element._native.xpath);
    return this.client.elementCommand(id, "GET", "text");
  }

  act({ tool, target, ...options }) { return this.actOn({ action: tool, element: target, ...options }); }

  async snapshotText({ diff = false, ...render } = {}) {
    await this.settle();
    const previous = this.diffBase?.over === this.shown ? this.diffBase.page : this.shown;
    const page = await this.snapshot();
    const difference = diff && previous ? pageDiff(previous, page) : null;
    if (!difference) {
      this.shown = page;
      return `${diff ? "(no previous snapshot to diff against; showing the full page)\n" : ""}${formatPage(page, render)}`;
    }
    this.diffBase = { over: this.shown, page };
    return formatDiff(page, difference, render);
  }

  async check(question, { visual = false } = {}) {
    if (visual) throw Object.assign(new Error("Native Android screenshots are not supported in this MVP"), { code: "unsupported_capability", capability: "vision" });
    await this.settle();
    const page = await this.snapshot();
    const { answers } = await this.call({ page }, { q: { type: "noul", instructions: `Answer about the Android screen in \`page\`: ${question}` } });
    return answers.q.noul;
  }

  async choose(question, options, { visual = false } = {}) {
    if (visual) throw Object.assign(new Error("Native Android screenshots are not supported in this MVP"), { code: "unsupported_capability", capability: "vision" });
    await this.settle();
    const page = await this.snapshot();
    const criteria = Array.isArray(options) ? Object.fromEntries(options.map(option => [option, null])) : options;
    const { answers } = await this.call({ page }, { q: { type: "choice", instructions: `Answer about the Android screen in \`page\`: ${question}`, criteria } });
    return { choice: answers.q.choice, probabilities: answers.q.probabilities, confidence: answers.q.confidence };
  }

  async read(question, { budgetChars = 12000 } = {}) {
    await this.settle();
    const page = await this.snapshot();
    return { url: page.url, title: page.title, question, content: page.text.slice(0, budgetChars), truncated: !!page.truncated || page.text.length > budgetChars };
  }

  async do(goal, { values = {}, maxActions = 10, doneAt = 0.5, minTarget = 0.3, allowIrreversible = false, irreversibleAt = 0.6, log = () => {} } = {}) {
    const started = Date.now(), calls = this.stats.calls, history = [], rounds = [];
    this.secrets ??= new Set();
    for (const [key, value] of Object.entries(values)) if (SECRET_KEY.test(key) && String(value).length) this.secrets.add(String(value));
    const shownValues = redactValues(values);
    const targeted = new Set(["click", "type", "clear", "scroll"]);
    let page = await this.snapshot(), repeated = null, repeatCount = 0, actionsTaken = 0;
    const result = (status, info) => ({ status, goal, url: page.url, title: page.title, actions: history, rounds,
      jev_calls: this.stats.calls - calls, ms: Date.now() - started, ...(info ? { info } : {}) });
    for (let round = 0; round <= maxActions + 10; round++) {
      this.assertExecution();
      await this.settle();
      page = await this.snapshot();
      this.shown = page;
      const tools = [...new Set([...page.elements.flatMap(element => element.actions), "back", "wait", "none"])];
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
      const { answers } = await this.call({ page, task }, questions);
      const doneScore = answers.done?.noul ?? 0;
      if (doneScore >= doneAt) return { ...result("done"), done_score: doneScore };
      if (actionsTaken >= maxActions) return result("max_actions", `No completion after ${maxActions} Android actions`);
      if ((answers.blocked?.noul ?? 0) >= 0.7) return result("blocked");
      if ((answers.error?.noul ?? 0) >= 0.7) return result("error");
      if ((answers.login?.noul ?? 0) >= 0.7) return result("needs_login", "Android app requires login; provide credentials or log in manually");
      const tool = answers.tool?.choice;
      if (!tools.includes(tool)) return result("error", "Decision backend selected an unpublished Android action");
      if (tool === "none") return result("stuck");
      const target = !targeted.has(tool) || answers.target?.choice == null ? null : Number(answers.target.choice);
      const element = target == null ? null : page.elements.find(candidate => candidate.i === target);
      if (targeted.has(tool) && (!element || !element.actions.includes(tool) || (answers.target?.probabilities?.[String(target)] ?? 0) < minTarget)) {
        return result("ambiguous", `Chosen Android target is missing or does not support ${tool}`);
      }
      if (["click", "type", "clear", "back"].includes(tool) && !allowIrreversible && !(answers.irreversible?.noul < irreversibleAt)) {
        return { ...result("needs_confirmation", "Android action needs authorization for this exact goal"), pending: { goal } };
      }
      const valueKey = answers.value?.choice;
      if (tool === "type" && (valueKey == null || values[valueKey] == null)) return result("ambiguous", "Android type action needs one of the supplied values");
      const record = { round, tool, target, element: brief(element), ...(valueKey && tool === "type" ? { value: valueKey } : {}) };
      rounds.push(record);
      const freshness = await this.fresh(page, { target });
      if (!freshness.fresh) { record.stale = freshness.reason; continue; }
      const action = { tool, target, value: valueKey == null ? undefined : values[valueKey], direction: tool === "scroll" ? (answers.direction?.choice === "up" ? "up" : "down") : undefined };
      const signature = `${page.fingerprint}:${tool}:${target}:${valueKey ?? ""}`;
      repeatCount = signature === repeated ? repeatCount + 1 : 0;
      repeated = signature;
      if (repeatCount >= 2) return result("stuck", "Android action is not changing the screen");
      try {
        this.consumeAction();
        actionsTaken++;
        if (tool === "wait") await new Promise(resolve => setTimeout(resolve, 1000));
        else await performAndroidAction(this.client, freshness.element, action);
        const entry = { action: tool, element: brief(element), ...(valueKey && tool === "type" ? { value: valueKey } : {}) };
        history.push(entry);
        log(`  r${round}: ${tool} -> #${target ?? "-"} ${record.element}`);
      } catch (error) {
        history.push({ action: tool, element: brief(element), error: String(error.message).slice(0, 200) });
        return { ...result(error.status ?? "error", String(error.message).slice(0, 300)), ...(error.outcome ? { outcome: error.outcome, error: { phase: "mobile_action", code: error.code, outcome: error.outcome } } : {}) };
      }
    }
    return result("max_actions");
  }

  capabilities() { return this._capabilities; }
  async close() {
    if (this.opened || this.client.creationUnknown) await this.client.closeSession();
    this.opened = false;
    return { pending_downloads: [] };
  }
}

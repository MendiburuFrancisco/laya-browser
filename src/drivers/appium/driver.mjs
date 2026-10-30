import { createHash } from "node:crypto";
import { AppiumClient } from "./client.mjs";
import { parseAndroidSnapshot } from "./android-snapshot.mjs";
import { formatPage, formatDiff, pageDiff, brief } from "../../page-model.mjs";
import { performAndroidAction } from "./android-actions.mjs";
import { jev } from "../../jev.mjs";
import { assertFreshness, assertObservation } from "../contract.mjs";
import { GoalRunner, assertExecution as assertDriverExecution, consumeAction as consumeDriverAction, callDecision, redactStrings } from "../../goal-runner.mjs";
import { AndroidGoalStrategy } from "../../goal-strategies/android.mjs";
import { errorDiagnostic } from "../../diagnostics.mjs";

export const ANDROID_CAPABILITIES = Object.freeze({
  driver: "appium", platform: "android", native: true, dom: false, tabs: false,
  network: false, downloads: false, video: false, vision: false,
});

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
    this.goalRunner = new GoalRunner(this, new AndroidGoalStrategy(this));
  }

  assertExecution() { assertDriverExecution(this); }
  consumeAction() { consumeDriverAction(this); }
  call(state, questions, options = {}) { return callDecision(this, state, questions, options); }

  ask(state, questions, options) { return jev(state, questions, options); }

  async open({ package: packageName, activity } = {}) {
    if (typeof packageName !== "string" || !packageName) throw new TypeError("app.package is required");
    if (this.opened) throw new Error("Close the Android session before opening another application");
    const caps = { platformName: "Android", "appium:automationName": "UiAutomator2", "appium:newCommandTimeout": 600, ...this.capabilityOverrides,
      "appium:appPackage": packageName, ...(activity ? { "appium:appActivity": activity } : {}) };
    if (String(caps.platformName).toLowerCase() !== "android") throw new Error("Android target requires platformName=Android");
    if (caps["appium:automationName"] !== "UiAutomator2") throw new Error("Android target requires appium:automationName=UiAutomator2");
    const started = Date.now();
    await this.client.createSession(caps);
    const attemptId = this.client.lastAttemptId;
    this.package = packageName;
    this.opened = true;
    const observationStarted = Date.now();
    try {
      const page = await this.snapshot({ attemptId });
      this.client.trace?.("initial_observation", { attemptId, operation: "mobile_observation", started: observationStarted, state: "confirmed" });
      return { ...page, ms: Date.now() - started };
    } catch (error) {
      error.diagnostic ??= { phase: "mobile_observation", outcome: error.outcome ?? "known" };
      if (attemptId) error.diagnostic.attempt_id ??= attemptId;
      error.diagnostic.initial_observation_ms = Date.now() - observationStarted;
      this.client.trace?.("initial_observation", { attemptId, operation: "mobile_observation", started: observationStarted, state: "failed", code: error.code, outcome: error.outcome ?? "known" });
      try {
        await this.client.closeSession();
        this.opened = false;
      } catch (cleanupError) {
        error.diagnostic.cleanup = errorDiagnostic(cleanupError, cleanupError.diagnostic ?? { phase: "cleanup", outcome: cleanupError.outcome ?? "known" });
      }
      throw error;
    }
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

  async snapshot({ attemptId, signal: externalSignal } = {}) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.execution?.signal, externalSignal].filter(Boolean));
    const requests = [
      this.client.command("GET", "source", undefined, { attemptId, signal }),
      this.client.command("GET", "appium/device/current_package", undefined, { attemptId, signal }),
      this.client.command("GET", "appium/device/current_activity", undefined, { attemptId, signal }),
    ];
    let source, currentPackage, currentActivity;
    try {
      [source, currentPackage, currentActivity] = await Promise.all(requests);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(requests);
      throw error;
    }
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
    return assertObservation(snapshot);
  }

  actionSpace(page) {
    return [...new Set([...page.elements.flatMap(element => element.actions), "back", "wait", "none"])];
  }

  async fresh(snapshot, action = {}) {
    const current = await this.snapshot();
    if (snapshot?.url !== current.url || snapshot?.text !== current.text) return assertFreshness({ fresh: false, reason: "page_changed", current });
    if (action.target == null) return assertFreshness(snapshot?.fingerprint === current.fingerprint ? { fresh: true, current } : { fresh: false, reason: "page_changed", current });
    const element = current.elements.find(candidate => candidate.i === action.target);
    if (!element) return assertFreshness({ fresh: false, reason: "target_missing", current });
    const previous = snapshot.elements.find(candidate => candidate.i === action.target);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(element) || previous._native?.identity !== element._native?.identity) {
      return assertFreshness({ fresh: false, reason: "target_changed", current });
    }
    if (snapshot?.fingerprint !== current.fingerprint) return assertFreshness({ fresh: false, reason: "page_changed", current });
    return assertFreshness({ fresh: true, current, element });
  }

  async actOn({ action, element, value, key, destination, acceptDialog = false }) {
    const started = Date.now();
    this.validateAction({ tool: action, target: element, value });
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
    this.consumeAction();
    await this.execute({ tool: action, target: element, value }, { element: resolved });
    await this.settle();
    const page = await this.snapshot();
    this.shown = null;
    return { action, element: brief(resolved), ms: Date.now() - started, url: page.url, title: page.title };
  }

  validateAction({ tool, target, value }) {
    if (!["click", "type", "clear", "scroll", "back", "wait"].includes(tool)) throw new Error(`Android does not support ${tool}`);
    if (["click", "type", "clear"].includes(tool) && target == null) throw new Error(`${tool} needs an element`);
    if (tool === "scroll" && value != null && !["up", "down"].includes(value)) throw new Error("scroll value must be up or down");
    if (tool === "type" && value == null) throw new Error("no value to type");
  }

  async execute(action, { element } = {}) {
    this.validateAction(action);
    const { tool, value, direction } = action;
    if (tool === "wait") await new Promise(resolve => setTimeout(resolve, 1000));
    else await performAndroidAction(this.client, element, { tool, value, direction: direction ?? value ?? "down" });
    this.assertExecution();
  }

  async readValue(element) {
    if (element?.role !== "textbox") return element?.text ?? null;
    if (element._native.showingHint) return "";
    const id = await this.client.findElement(element._native.xpath);
    return this.client.elementCommand(id, "GET", "text");
  }

  act(action, freshness) { return this.execute(action, freshness); }

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

  do(goal, options = {}) { return this.goalRunner.run(goal, options); }

  capabilities() { return this._capabilities; }
  async close() {
    if (this.opened || this.client.creationUnknown) await this.client.closeSession();
    this.opened = false;
    return { pending_downloads: [] };
  }
}

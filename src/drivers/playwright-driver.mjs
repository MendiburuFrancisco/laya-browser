import { assertAutomationDriver, assertFreshness, assertObservation, WEB_CAPABILITIES } from "./contract.mjs";
import { brief } from "../page-model.mjs";

const stateOf = ({ i, near, xpath, ...state }) => JSON.stringify(state);

export class PlaywrightDriver {
  constructor(browser) {
    this.browser = browser;
    this._capabilities = WEB_CAPABILITIES;
    this.locators = new WeakMap();
    this.observations = new WeakMap();
    this.preparedBoxes = new WeakMap();
    assertAutomationDriver(this);
  }

  async open(target) {
    if (typeof target !== "string") throw new TypeError("PlaywrightDriver.open expects a URL string");
    return this.browser.open(target);
  }

  settle(options) { return this.browser.settle(options); }
  async snapshot(options) {
    const raw = await this.browser.snapshot(options);
    const elements = raw.elements.map(({ xpath, ...element }) => {
      this.locators.set(element, { xpath, frame: element.frame ?? null });
      return element;
    });
    const observation = assertObservation({ ...raw, elements });
    for (const element of elements) this.observations.set(element, observation);
    return observation;
  }
  actionSpace(page) { return this.browser.actionSpace(page); }
  get stats() { return this.browser.stats; }
  get events() { return this.browser.events; }
  get execution() { return this.browser.execution; }
  get secrets() { return this.browser.secrets; }
  set secrets(value) { this.browser.secrets = value; }
  get shown() { return this.browser.shown; }
  set shown(value) { this.browser.shown = value; this.browser.needsTabSnapshot = false; }
  get currentUrl() { return this.browser.page?.url() ?? this.browser.lastPage?.url; }
  ask(state, questions, options) { return this.browser.ask(state, questions, options); }

  async fresh(snapshot, action) {
    const current = await this.snapshot();
    if (snapshot?.url !== current.url) return assertFreshness({ fresh: false, reason: "page_changed" });
    if (action?.boxId) {
      this.preparedBoxes.delete(action);
      try {
        this.preparedBoxes.set(action, await this.browser.freshBox(action.boxId));
      } catch (error) {
        if (/stale|unknown|Screenshot changed/.test(error.message)) return assertFreshness({ fresh: false, reason: "target_changed" });
        throw error;
      }
      return assertFreshness({ fresh: true });
    }
    if (action?.target == null) {
      if (JSON.stringify(snapshot) !== JSON.stringify(current)) return assertFreshness({ fresh: false, reason: "page_changed" });
      return assertFreshness({ fresh: true });
    }
    let resolving = action.target;
    try {
      const element = this.browser.currentElement(action.target, current, snapshot);
      if (stateOf(snapshot.elements.find(previous => previous.i === action.target)) !== stateOf(element)) return assertFreshness({ fresh: false, reason: "target_changed" });
      let destination;
      if (action.destination != null) {
        resolving = action.destination;
        destination = this.browser.currentElement(action.destination, current, snapshot);
        if (stateOf(snapshot.elements.find(previous => previous.i === action.destination)) !== stateOf(destination)) return assertFreshness({ fresh: false, reason: "target_changed" });
      }
      if (snapshot.text !== current.text) return assertFreshness({ fresh: false, reason: "page_changed" });
      if (destination) action.destination = destination.i;
      action.target = element.i;
      return assertFreshness({ fresh: true });
    } catch {
      const previous = snapshot.elements.find(element => element.i === resolving);
      const exists = previous && current.elements.some(element => (element.label || element.text || element.tag) === (previous.label || previous.text || previous.tag));
      return assertFreshness({ fresh: false, reason: exists ? "target_changed" : "target_missing" });
    }
  }

  act(action) {
    const boxTarget = this.preparedBoxes.get(action);
    this.preparedBoxes.delete(action);
    return this.browser.execute(action, { boxTarget });
  }

  resolveCachedAction(page, cached, values) {
    const matches = page.elements.filter(element => {
      const locator = this.locators.get(element);
      return locator?.xpath && locator.xpath === cached.xpath && locator.frame === (cached.frame ?? null);
    });
    const element = matches.length === 1 ? matches[0] : null;
    if (!element || brief(element) !== cached.brief || (["type", "upload"].includes(cached.tool) && (cached.valueKey == null || values[cached.valueKey] == null))) return null;
    return { tool: cached.tool, target: element.i, el: element, valueKey: cached.valueKey,
      value: cached.valueKey != null ? values[cached.valueKey] : cached.option, p_tool: 1, p_target: 1, candidates: [] };
  }

  cacheEntry(action) {
    const locator = this.locators.get(action.el);
    if (!locator?.xpath) return null;
    return { tool: action.tool, ...locator, brief: brief(action.el),
      ...(action.valueKey && ["type", "select", "upload"].includes(action.tool) ? { valueKey: action.valueKey } : {}),
      ...(action.tool === "select" && action.value != null ? { option: action.value } : {}) };
  }

  async readValue(element, observation = this.observations.get(element)) {
    const current = await this.browser.snapshot();
    const reference = observation ?? { url: current.url, elements: [element] };
    const resolved = this.browser.currentElement(element.i, current, reference);
    if (resolved.value !== undefined) return resolved.value;
    if (resolved.tag === "input" || resolved.tag === "textarea") {
      return this.browser.locate(resolved.i).inputValue();
    }
    return resolved.text ?? resolved.label ?? null;
  }

  async getHtml() {
    return { url: this.browser.page.url(), html: await this.browser.page.content() };
  }

  capabilities() { return this._capabilities; }
  close() { return this.browser.close(); }
}

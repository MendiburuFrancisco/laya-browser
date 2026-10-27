import { assertAutomationDriver, WEB_CAPABILITIES } from "./contract.mjs";

// Thin adapter: the existing browser implementation remains the source of web behavior.
export class PlaywrightDriver {
  constructor(browser) {
    this.browser = browser;
    this._capabilities = WEB_CAPABILITIES;
    assertAutomationDriver(this);
  }

  async open(target) {
    if (typeof target !== "string") throw new TypeError("PlaywrightDriver.open expects a URL string");
    return this.browser.open(target);
  }

  settle(options) { return this.browser.settle(options); }
  snapshot(options) { return this.browser.snapshot(options); }

  async fresh(snapshot, action) {
    try {
      const current = await this.browser.snapshot();
      if (snapshot?.url !== current.url) return { fresh: false, reason: "page_changed" };
      if (action?.target == null) return { fresh: true };
      try {
        this.browser.currentElement(action.target, current, snapshot);
        return { fresh: true };
      } catch {
        return { fresh: false, reason: "target_changed" };
      }
    } catch {
      return { fresh: false, reason: "target_missing" };
    }
  }

  act(action) {
    const { tool, target, ...options } = action;
    return this.browser.actOn({ action: tool, element: target, ...options });
  }

  async readValue(element) {
    const current = await this.browser.snapshot();
    const resolved = this.browser.currentElement(element.i, current);
    if (resolved.value !== undefined) return resolved.value;
    if (resolved.tag === "input" || resolved.tag === "textarea") {
      return this.browser.locate(resolved.i).inputValue();
    }
    return resolved.text ?? resolved.label ?? null;
  }

  capabilities() { return this._capabilities; }
  close() { return this.browser.close(); }
}

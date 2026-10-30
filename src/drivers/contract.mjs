export const WEB_CAPABILITIES = Object.freeze({
  driver: "playwright",
  platform: "web",
  native: false,
  dom: true,
  tabs: true,
  network: true,
  downloads: true,
  video: true,
  vision: true,
});

export const WEB_TARGET = Object.freeze({ kind: "web" });

const REQUIRED_METHODS = ["open", "settle", "snapshot", "actionSpace", "fresh", "act", "readValue", "capabilities", "close"];
const FRESHNESS_REASONS = new Set(["page_changed", "target_changed", "target_missing"]);

export function assertObservation(snapshot) {
  if (!snapshot || typeof snapshot.url !== "string" || !Array.isArray(snapshot.elements)) {
    throw new TypeError("Driver observation requires url and elements");
  }
  for (const element of snapshot.elements) {
    if (!Number.isInteger(element?.i) || (element.actions !== undefined && !Array.isArray(element.actions))) {
      throw new TypeError("Observed elements require an integer i and, when present, an actions array");
    }
  }
  return snapshot;
}

export function assertFreshness(result) {
  if (result?.fresh === true) return result;
  if (result?.fresh === false && FRESHNESS_REASONS.has(result.reason)) return result;
  throw new TypeError("Freshness requires fresh=true or fresh=false with a typed reason");
}

export function assertAutomationDriver(driver) {
  const missing = REQUIRED_METHODS.filter(name => typeof driver?.[name] !== "function");
  if (missing.length) throw new TypeError(`Automation driver is missing methods: ${missing.join(", ")}`);
  return driver;
}

export function unsupportedCapability(name) {
  const error = new Error(`Operation requires unsupported capability: ${name}`);
  error.code = "unsupported_capability";
  error.capability = name;
  return error;
}

export function assertCapability(capabilities, name) {
  if (capabilities?.[name] !== true) throw unsupportedCapability(name);
}

export function openAutomationTarget(driver, { url, app }) {
  if (!url === !app) throw new Error("Provide exactly one of url or app");
  if ((driver.capabilities?.().native === true) !== !!app) throw new Error("Use app for Android sessions and url for web sessions");
  return driver.open(app ?? url);
}

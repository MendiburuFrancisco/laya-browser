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

const REQUIRED_METHODS = ["open", "settle", "snapshot", "fresh", "act", "readValue", "capabilities", "close"];

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

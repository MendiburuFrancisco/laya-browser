import { WEB_TARGET } from "./drivers/contract.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function normalizeTarget(input = WEB_TARGET) {
  const target = structuredClone(input);
  if (target?.kind === "web") {
    if (target.appium_url || target.capabilities) throw new TypeError("Appium configuration requires an Android target");
    return WEB_TARGET;
  }
  if (target?.kind !== "android") throw new TypeError("Target must be web or android");
  const caps = target.capabilities;
  if (caps?.platformName?.toLowerCase?.() !== "android" || caps?.["appium:automationName"] !== "UiAutomator2" || typeof caps?.["appium:udid"] !== "string" || !caps["appium:udid"].trim()) {
    throw new TypeError("Android requires platformName=Android, appium:automationName=UiAutomator2 and an explicit appium:udid");
  }
  if (target.appium_url) {
    const url = new URL(target.appium_url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new TypeError("Appium URL must be HTTP(S), without credentials, query or fragment");
  }
  return freeze(target);
}

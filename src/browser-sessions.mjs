import { randomUUID } from "node:crypto";
import { BrowserLease } from "./code-mode.mjs";
import { normalizeTarget } from "./target-config.mjs";

// A session owns both its browser launch promise and its whole-operation lease.
// Never use a process-wide "active session": concurrent callers must select explicitly.
export class BrowserSessions {
  entries = new Map();
  devices = new Map();
  namespace = randomUUID();

  create(id = randomUUID(), target = { kind: "web" }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) || id === "default") {
      throw new Error("Session id must be 1-80 letters, digits, underscores or hyphens; default is reserved.");
    }
    if (this.entries.has(id)) throw new Error(`Browser session "${id}" already exists; choose a unique id for this conversation.`);
    const entry = { id, lease: new BrowserLease() };
    Object.defineProperty(entry, "target", { value: normalizeTarget(target), enumerable: true });
    this.entries.set(id, entry);
    return entry;
  }

  resolve(id) {
    if (id !== undefined) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown browser session "${id}". Call browser_create_session first.`);
      return entry;
    }
    if ([...this.entries.keys()].some(key => key !== "default")) {
      throw new Error("session_id is required when named browser sessions exist. Pass the id returned by browser_create_session on every browser tool call.");
    }
    if (!this.entries.has("default")) this.entries.set("default", { id: "default", lease: new BrowserLease(), target: { kind: "web" } });
    return this.entries.get("default");
  }

  list() {
    return [...this.entries.values()].map(entry => ({
      session_id: entry.id, state: entry.session ? "started" : "idle", busy: entry.lease.busy,
      target: entry.target.kind, device: entry.target.capabilities?.["appium:udid"],
    }));
  }

  acquireDevice(entry) {
    if (entry.target.kind !== "android") return;
    const device = entry.target.capabilities["appium:udid"];
    const owner = this.devices.get(device);
    if (owner && owner !== entry.id) throw new Error(`Android device "${device}" is already leased by browser session "${owner}".`);
    this.devices.set(device, entry.id);
  }

  releaseDevice(entry) {
    const device = entry.target.capabilities?.["appium:udid"];
    if (device && this.devices.get(device) === entry.id) this.devices.delete(device);
  }

  async close(entry) {
    const pending = entry.session;
    const result = await (await pending?.catch(() => null))?.close() ?? { pending_downloads: [] };
    entry.session = undefined; entry.viewport = undefined; entry.video = undefined;
    this.releaseDevice(entry);
    return result;
  }

  async closeAll() {
    await Promise.allSettled([...this.entries.values()].map(entry => this.close(entry)));
  }
}

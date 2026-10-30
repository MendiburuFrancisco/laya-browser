import { test } from "node:test";
import assert from "node:assert/strict";
import { AppiumClient } from "../src/drivers/appium/client.mjs";
import { AppiumAndroidDriver } from "../src/drivers/appium/driver.mjs";
import { parseAndroidSnapshot } from "../src/drivers/appium/android-snapshot.mjs";

const xml = `<hierarchy><node class="android.widget.TextView" text="About phone" content-desc="" resource-id="" bounds="[10,20][210,70]" visible-to-user="true" enabled="true" clickable="true" checked="false" selected="false"/><node class="android.widget.EditText" text="hunter2" resource-id="com.demo:id/password" bounds="[0,80][300,130]" visible-to-user="true" enabled="true" clickable="true" password="true"/><node class="android.widget.TextView" text="Hidden" bounds="[0,0][100,20]" visible-to-user="false" enabled="true" clickable="true"/></hierarchy>`;

test("Android XML maps visible controls and redacts sensitive fields", () => {
  const snapshot = parseAndroidSnapshot(xml, { packageName: "com.demo", activity: ".Settings" });
  assert.equal(snapshot.platform, "android");
  assert.equal(snapshot.url, "app://com.demo/.Settings");
  assert.equal(snapshot.elements.length, 2);
  assert.deepEqual(snapshot.elements[0].actions, ["click"]);
  assert.deepEqual(snapshot.elements[0].bounds, { x: 10, y: 20, width: 200, height: 50 });
  assert.deepEqual(snapshot.elements[1].actions, ["click", "type", "clear"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /hunter2|Hidden/);
});

test("Appium class-tag XML inherits labels into clickable containers", () => {
  const appiumXml = `<hierarchy width="1080" height="2400"><android.widget.LinearLayout class="android.widget.LinearLayout" text="" clickable="true" enabled="true" displayed="true" bounds="[0,10][1080,200]"><android.widget.TextView class="android.widget.TextView" text="Network &amp; internet" clickable="false" enabled="true" displayed="true" bounds="[20,20][500,80]"/></android.widget.LinearLayout></hierarchy>`;
  const snapshot = parseAndroidSnapshot(appiumXml);
  const clickable = snapshot.elements.find(element => element.clickable);
  assert.equal(clickable.label, "Network & internet");
  assert.deepEqual(clickable.actions, ["click"]);
  assert.equal(snapshot.text, "Network & internet");
});

test("Android snapshot explicitly reports truncation", () => {
  const snapshot = parseAndroidSnapshot(xml, { maxElements: 1 });
  assert.equal(snapshot.elements.length, 1);
  assert.equal(snapshot.truncated, true);
});

test("Appium client owns one W3C session and deletes only its own session", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), ...options });
    const value = options.method === "POST" ? { sessionId: "session-123" } : {};
    return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new AppiumClient({ url: "http://127.0.0.1:4723", fetchImpl });
  await client.createSession({ platformName: "Android" });
  await client.command("GET", "source");
  await client.closeSession();
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].body, /UiAutomator2|Android/);
  assert.equal(calls[1].url, "http://127.0.0.1:4723/session/session-123/source");
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url, "http://127.0.0.1:4723/session/session-123");
});

test("Android driver does not recreate a session during close or invalid open", async () => {
  let created = 0, closed = 0;
  const client = {
    async createSession() { created++; },
    async command(method, path) { return path === "source" ? xml : path.endsWith("current_package") ? "com.demo" : ".Settings"; },
    async closeSession() { closed++; },
  };
  const driver = new AppiumAndroidDriver({ client });
  await assert.rejects(driver.open({}), /app.package is required/);
  assert.equal(created, 0);
  const page = await driver.open({ package: "com.demo", activity: ".Settings" });
  assert.equal(page.activity, ".Settings");
  await driver.close();
  await driver.close();
  assert.equal(created, 1);
  assert.equal(closed, 1);
});

test("Android sessions use a bounded interactive command timeout and preserve explicit overrides", async () => {
  const creations = [];
  const makeClient = () => ({
    createSession: async capabilities => { creations.push(capabilities); },
    command: async (method, path) => path === "source" ? xml : path.endsWith("current_package") ? "com.demo" : ".Settings",
    closeSession: async () => {},
  });
  const standard = new AppiumAndroidDriver({ client: makeClient() });
  await standard.open({ package: "com.demo" });
  await standard.close();
  const custom = new AppiumAndroidDriver({ client: makeClient(), capabilities: { "appium:newCommandTimeout": 900, "appium:appWaitActivity": ".Ready" } });
  await custom.open({ package: "com.demo" });
  await custom.close();
  assert.equal(creations[0]["appium:newCommandTimeout"], 600);
  assert.equal(creations[1]["appium:newCommandTimeout"], 900);
  assert.equal(creations[1]["appium:appWaitActivity"], ".Ready");
});

test("Appium creation diagnostics distinguish headers, body, connection and external abort", async t => {
  await t.test("slow valid creation returns its id and emits only safe capabilities", async () => {
    const events = [];
    const client = new AppiumClient({ logger: event => events.push(event), fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ value: { sessionId: "slow-session" } }), { headers: { "content-type": "application/json" } });
    } });
    await client.createSession({ platformName: "Android", "appium:automationName": "UiAutomator2", "appium:udid": "device-1", "appium:appPackage": "safe.package", "appium:appActivity": ".Main", "appium:newCommandTimeout": 600, "appium:appWaitActivity": "*", "appium:privateKey": "do-not-log" });
    assert.equal(client.sessionId, "slow-session");
    assert.equal(events.filter(event => event.event === "http_headers").length, 1);
    assert.equal(events.filter(event => event.event === "http_body").length, 1);
    assert.doesNotMatch(JSON.stringify(events), /do-not-log/);
    assert.match(JSON.stringify(events), /appWaitActivity/);
  });

  await t.test("timeout before headers", async () => {
    let requests = 0;
    const client = new AppiumClient({ createTimeoutMs: 10, fetchImpl: async (_, options) => {
      requests++;
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    } });
    await assert.rejects(client.createSession({}), error => {
      assert.equal(error.code, "appium_timeout");
      assert.equal(error.diagnostic.phase, "session_create");
      assert.equal(error.diagnostic.transport_phase, "http_headers");
      assert.equal(error.outcome, "unknown");
      assert.ok(error.diagnostic.attempt_id);
      assert.equal(typeof error.diagnostic.duration_ms, "number");
      return true;
    });
    await assert.rejects(client.createSession({}), /Previous session creation/);
    assert.equal(requests, 1);
  });

  await t.test("timeout reading the body retains HTTP status", async () => {
    const client = new AppiumClient({ createTimeoutMs: 10, fetchImpl: async (_, options) => ({ ok: true, status: 200,
      json: () => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })),
    }) });
    await assert.rejects(client.createSession({}), error => error.code === "appium_timeout" && error.httpStatus === 200 && error.diagnostic.transport_phase === "http_body" && error.outcome === "unknown");
  });

  await t.test("invalid JSON", async () => {
    const client = new AppiumClient({ fetchImpl: async () => new Response("not-json", { status: 200 }) });
    await assert.rejects(client.createSession({}), error => error.code === "appium_invalid_response" && error.diagnostic.transport_phase === "http_body" && error.outcome === "unknown");
  });

  await t.test("connection loss while reading the body", async () => {
    const client = new AppiumClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new TypeError("terminated"); } }) });
    await assert.rejects(client.createSession({}), error => error.code === "appium_connection_error" && error.diagnostic.transport_phase === "http_body" && error.outcome === "unknown");
  });

  await t.test("JSON syntax errors are not misclassified as disconnects", async () => {
    const client = new AppiumClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token socket"); } }) });
    await assert.rejects(client.createSession({}), error => error.code === "appium_invalid_response" && error.diagnostic.transport_phase === "http_body");
  });

  await t.test("connection loss", async () => {
    const client = new AppiumClient({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(client.createSession({}), error => error.code === "appium_connection_error" && error.diagnostic.transport_phase === "http_headers" && error.outcome === "unknown");
  });

  await t.test("external abort", async () => {
    const controller = new AbortController();
    const client = new AppiumClient({ fetchImpl: async () => {
      controller.abort(new Error("caller cancelled"));
      throw new Error("aborted");
    } });
    client.getSignal = () => controller.signal;
    await assert.rejects(client.createSession({}), error => error.code === "appium_aborted" && error.outcome === "unknown");
  });

  await t.test("pre-aborted creation sends nothing and does not retain an unknown lease", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before send"));
    let requests = 0;
    const client = new AppiumClient({ fetchImpl: async (_, options) => {
      if (options.signal?.aborted) throw new Error("aborted");
      requests++;
      return new Response(JSON.stringify({ value: { sessionId: "later-session" } }), { headers: { "content-type": "application/json" } });
    } });
    client.getSignal = () => controller.signal;
    await assert.rejects(client.createSession({}), error => error.code === "appium_aborted" && error.outcome === "known" && error.diagnostic.transport_phase === "preflight");
    assert.equal(requests, 0);
    assert.equal(client.creationUnknown, undefined);
    client.getSignal = () => null;
    await client.createSession({});
    assert.equal(client.sessionId, "later-session");
    assert.equal(requests, 1);
  });

  await t.test("missing session id closes the extraction timeline", async () => {
    const events = [];
    const client = new AppiumClient({ logger: event => events.push(event), fetchImpl: async () => new Response(JSON.stringify({ value: {} }), { headers: { "content-type": "application/json" } }) });
    await assert.rejects(client.createSession({}), error => error.code === "appium_session_id_missing" && error.diagnostic.phase === "session_id_extract");
    const terminal = events.find(event => event.event === "session_create" && event.state === "failed");
    assert.equal(terminal.code, "appium_session_id_missing");
    assert.equal(terminal.outcome, "unknown");
    assert.equal(typeof terminal.duration_ms, "number");
  });
});

test("Appium reports expired sessions without recreating them and treats expired cleanup as confirmed absent", async () => {
  let posts = 0;
  const client = new AppiumClient({ fetchImpl: async (url, options) => {
    if (options.method === "POST") posts++;
    return new Response(JSON.stringify({ value: { error: "invalid session id", message: "must not be exposed" } }), { status: 404, headers: { "content-type": "application/json" } });
  } });
  client.sessionId = "expired-own";
  await assert.rejects(client.command("GET", "source"), error => {
    assert.equal(error.code, "appium_session_expired");
    assert.equal(error.httpStatus, 404);
    assert.doesNotMatch(error.message, /must not be exposed/);
    return true;
  });
  assert.equal(client.sessionId, "expired-own");
  await client.closeSession();
  assert.equal(client.sessionId, null);
  assert.equal(posts, 0);
});

test("concurrent expired cleanup coalesces the normalized result", async () => {
  let respond;
  const client = new AppiumClient({ fetchImpl: async () => new Promise(resolve => {
    respond = () => resolve(new Response(JSON.stringify({ value: { error: "invalid session id" } }), { status: 404, headers: { "content-type": "application/json" } }));
  }) });
  client.sessionId = "expired-own";
  const first = client.closeSession(), second = client.closeSession();
  respond();
  assert.deepEqual(await Promise.all([first, second]), [{ expired: true }, { expired: true }]);
  assert.equal(client.sessionId, null);
});

test("snapshot combines execution cancellation with sibling draining", async () => {
  const controller = new AbortController(), signals = [];
  let pending = 0;
  const client = {
    command: async (method, path, body, { signal } = {}) => {
      signals.push(signal);
      pending++;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => { pending--; reject(new Error("execution cancelled")); }, { once: true }));
    },
  };
  const driver = new AppiumAndroidDriver({ client });
  driver.execution = { signal: controller.signal };
  const snapshot = driver.snapshot();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(snapshot, /execution cancelled/);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(pending, 0);
});

test("failed first observation drains sibling requests before cleanup", async () => {
  let pending = 0, deleted = false;
  const events = [];
  const client = {
    sessionId: "confirmed-own", lastAttemptId: "attempt-observation",
    trace: (event, { started, ...detail }) => events.push({ event, ...detail, ...(started !== undefined ? { duration_ms: Date.now() - started } : {}) }),
    createSession: async () => {},
    command: async (method, path, body, { signal } = {}) => {
      if (path === "source") throw Object.assign(new Error("observation failed"), { diagnostic: { phase: "mobile_observation", outcome: "known" } });
      pending++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending--; reject(new Error("late response")); }, 50);
        signal?.addEventListener("abort", () => { clearTimeout(timer); pending--; reject(new Error("aborted sibling")); }, { once: true });
      });
    },
    closeSession: async () => { assert.equal(pending, 0); deleted = true; client.sessionId = null; },
  };
  const driver = new AppiumAndroidDriver({ client });
  await assert.rejects(driver.open({ package: "com.demo" }), error => error.message === "observation failed");
  assert.equal(pending, 0);
  assert.equal(deleted, true);
  const terminal = events.find(event => event.event === "initial_observation" && event.state === "failed");
  assert.equal(typeof terminal.duration_ms, "number");
});

test("failed first observation closes only the confirmed session and preserves both failures", async t => {
  const fixture = cleanupFails => {
    const calls = [];
    const client = new AppiumClient({ fetchImpl: async (url, options) => {
      calls.push(`${options.method} ${url}`);
      if (options.method === "POST") return new Response(JSON.stringify({ value: { sessionId: "confirmed-own" } }), { headers: { "content-type": "application/json" } });
      if (options.method === "DELETE") {
        if (cleanupFails) return new Response(JSON.stringify({ value: { error: "unknown error", message: "cleanup secret" } }), { status: 500, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ value: null }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ value: { error: "unknown error", message: "observation secret" } }), { status: 500, headers: { "content-type": "application/json" } });
    } });
    return { client, calls, driver: new AppiumAndroidDriver({ client }) };
  };

  await t.test("successful cleanup keeps the primary observation error", async () => {
    const { client, calls, driver } = fixture(false);
    await assert.rejects(driver.open({ package: "com.demo" }), error => error.diagnostic.phase === "mobile_observation" && !error.diagnostic.cleanup);
    assert.equal(calls.filter(call => call.startsWith("DELETE ")).length, 1);
    assert.equal(client.sessionId, null);
    assert.equal(driver.opened, false);
  });

  await t.test("failed cleanup retains ownership and does not hide either error", async () => {
    const { client, driver } = fixture(true);
    await assert.rejects(driver.open({ package: "com.demo" }), error => {
      assert.equal(error.diagnostic.phase, "mobile_observation");
      assert.equal(error.diagnostic.cleanup.phase, "cleanup");
      assert.equal(error.diagnostic.cleanup.http_status, 500);
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /observation secret|cleanup secret/);
      return true;
    });
    assert.equal(client.sessionId, "confirmed-own");
    assert.equal(driver.opened, true);
  });
});

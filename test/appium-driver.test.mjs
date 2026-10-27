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

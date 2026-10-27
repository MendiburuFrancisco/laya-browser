import { test } from "node:test";
import assert from "node:assert/strict";
import { JevBrowser } from "../src/session.mjs";
import { codeSchemas, invokeBrowser } from "../src/browser-api.mjs";
import { executeCode } from "../src/code-mode.mjs";

test("tabs retain IDs, switch safely, reject ambiguous selectors and recover on close", async () => {
  const b = await JevBrowser.launch();
  try {
    const url = "data:text/html," + encodeURIComponent('<title>Shared title</title><button>First</button>');
    await b.open(url);
    const first = b.page;
    const initial = await b.listTabs();
    assert.equal(initial.tabs.length, 1);
    const firstId = initial.tabs[0].id;
    assert.equal(initial.tabs[0].active, true);
    const second = await b.context.newPage();
    await second.goto(url);
    assert.equal(b.page, second, "new tabs auto-select");
    const listed = await b.listTabs();
    const secondId = listed.tabs.find(t => t.active).id;
    assert.notEqual(firstId, secondId);
    assert.equal(listed.tabs.find(t => t.id === firstId).active, false);
    for (const selector of [{}, { id: firstId, title: "Shared title" }, { id: "" }, { id: "missing" }, { title: "Shared title" }, { url }]) {
      await assert.rejects(b.selectTab(selector));
      assert.equal(b.page, second, "failed selection leaves active tab intact");
    }
    await b.snapshotText();
    const oldElement = b.shown.elements[0].i;
    await b.selectTab({ id: firstId });
    assert.equal(b.page, first);
    assert.equal(b.frames.size, 0);
    await assert.rejects(b.actOn({ action: "click", element: oldElement }), /tab changed.*snapshot/);
    const fresh = await b.snapshotText({ diff: true });
    assert.match(fresh, /showing the full page/);
    await b.actOn({ action: "click", element: b.shown.elements[0].i });

    const dialogListeners = first.listenerCount("dialog");
    const closeListeners = first.listenerCount("close");
    for (let i = 0; i < 3; i++) {
      await b.selectTab({ id: secondId });
      await b.selectTab({ id: firstId });
    }
    assert.equal(first.listenerCount("dialog"), dialogListeners);
    assert.equal(first.listenerCount("close"), closeListeners);

    await second.goto("data:text/html,<title>Unique tab</title><p>Second page</p>");
    assert.equal((await b.selectTab({ title: "Unique tab" })).id, secondId);
    await b.selectTab({ url });
    assert.equal(b.page, first);
    const code = await executeCode({ code: `
      const {tabs} = await browser.listTabs();
      const target = tabs.find(t => t.title === 'Unique tab');
      await browser.selectTab({id:target.id});
      return await browser.getHtml();
    ` }, { invoke: (method, args) => invokeBrowser(b, method, args) });
    assert.equal(code.status, "done", code.info);
    assert.match(code.result.html, /Second page/);
    assert.equal(b.stats.calls, 0);
    await second.close();
    assert.equal(b.page, first, "closing active tab selects remaining tab");
    assert.equal((await b.listTabs()).tabs[0].id, firstId);
    await assert.rejects(b.selectTab({ id: secondId }), /No open tab/);
    const third = await b.context.newPage();
    const thirdId = (await b.listTabs()).tabs.find(t => t.active).id;
    assert.notEqual(thirdId, secondId, "closed IDs are not reused");
    await third.close();
  } finally { await b.close(); }
});

test("newTab creates an active tab without navigating or losing the previous page", async () => {
  const b = await JevBrowser.launch();
  try {
    const firstUrl = "data:text/html,<title>Original</title><input value='retained'>";
    await b.open(firstUrl, { viewport: { width: 450, height: 700 } });
    const first = b.page;
    const firstId = (await b.listTabs()).tabs[0].id;
    await b.snapshotText();
    const oldElement = b.shown.elements[0].i;
    const blank = await b.newTab();
    assert.equal(blank.status, "done");
    assert.equal(blank.url, "about:blank");
    assert.equal(blank.active, true);
    assert.notEqual(blank.id, firstId);
    assert.equal(b.page.context(), first.context());
    assert.deepEqual(b.page.viewportSize(), { width: 450, height: 700 });
    assert.equal(first.url(), firstUrl);
    assert.equal(await first.locator("input").inputValue(), "retained");
    await assert.rejects(b.actOn({ action: "click", element: oldElement }), /tab changed.*snapshot/);

    const url = "data:text/html,<title>New destination</title><p>New page</p>";
    const code = await executeCode({ values: { url }, code: `
      const tab = await browser.newTab({url:values.url});
      const snapshot = await browser.snapshot();
      return {tab, snapshot, tabs:(await browser.listTabs()).tabs};
    ` }, { invoke: (method, args) => invokeBrowser(b, method, args) });
    assert.equal(code.status, "done", code.info);
    assert.equal(code.result.tab.url, url);
    assert.equal(code.result.tab.title, "New destination");
    assert.equal(code.result.tab.active, true);
    assert.equal(code.result.tabs.length, 3);
    assert.match(code.result.snapshot.text, /New page/);
    await b.selectTab({ id: firstId });
    assert.equal(await b.page.locator("input").inputValue(), "retained");
    await b.open("data:text/html,<title>Same tab navigation</title>");
    assert.equal((await b.listTabs()).tabs.length, 3, "open still navigates the active tab");
    assert.equal(b.page, first);
    await assert.rejects(b.newTab({ url: " " }), /non-empty URL/);
    assert.equal((await b.listTabs()).tabs.length, 3, "invalid input creates no tab");
    assert.equal(b.stats.calls, 0);
  } finally { await b.close(); }
});

test("Code Mode requires exactly one tab selector", () => {
  for (const bad of [{}, { id: "tab-1", url: "about:blank" }, { id: " " }, { title: "" }, { index: 0 }]) {
    assert.equal(codeSchemas.selectTab.safeParse(bad).success, false);
  }
  for (const good of [{ id: "tab-1" }, { url: "about:blank" }, { title: "Example" }]) {
    assert.equal(codeSchemas.selectTab.safeParse(good).success, true);
  }
});

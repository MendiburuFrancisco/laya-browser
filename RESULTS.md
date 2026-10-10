# Results (2026-09-17)

Model `jev-latest` (resolved to jev-1.13.0). Headless Chromium 1280×800, 3 tasks in parallel.
Commands: `node bench/run.mjs --set all`, `node bench/context-cost.mjs <run.json>`.
A task is **correct** when every step returns its expected status (`done`/`likely_done`, or
`needs_confirmation` for the guard test) and its ground-truth check passes. Tasks built to
fail are correct when no step claims done. **False done** = a step said `done` while its
ground-truth check failed.

## Latest: r10 (after the add-item, overlay and login fixes)

42 tasks (a `login-wall` task was added): **40/42 correct, 0 false done**, 202 Jev calls, 286 ms
average. Misses: `ti-add-remove` stopped at 2 of 3 buttons but returned `likely_done`, not
`done`; `ti-sort-table` is still `stuck`. `todomvc-coarse` and `infinite-scroll` now pass. The
tables below are from the earlier r6/r7 pair (41 tasks) and are kept for comparison.

## Two full runs, same code (r6, r7)

| run | correct | false done | likely_done | Jev calls | avg ms/call | input tokens/call | wall time (41 tasks, 3 parallel) |
|-----|---------|------------|-------------|-----------|-------------|-------------------|------------------|
| r6  | 38/41   | 0          | 0           | 211       | 290         | 2,890             | 251 s            |
| r7  | 38/41   | 0          | 0           | 208       | 299         | 2,801             | 248 s            |

Both runs failed the same 3 tasks, and each of those failures is a known model limit, not a flake:

| task | status | what happened |
|---|---|---|
| todomvc-coarse | stuck | one step with ordered sub-goals (add 2, complete 1, clear); the same actions pass as 5 steps |
| ti-sort-table | stuck | the table was sorted, but nothing marks sort state; Jev can't judge order from rows (0.21) |
| infinite-scroll | stuck | "scroll to load more" has no end point; content did load, `done` swung 0.2↔0.84 |

In r6, 190 rounds: median target confidence 0.97; 7 rounds needed two-stage selection (largest
page 2,273 elements). Actions performed: click 61, type 41, scroll 9, wait 6, select 4,
press_enter 4, and one each of hover, drag, right_click, press_key, upload.

## By category (r6 + r7)

| category | correct | calls/task | s/task |
|---|---|---|---|
| form (login, number, 5-field form as one goal and as 7 steps) | 8/8 | 7.0 | 5.1 |
| widget (select, checkboxes) | 4/4 | 3.0 | 5.4 |
| dynamic (delayed load, enable-then-type, add until 3) | 6/6 | 5.0 | 7.6 |
| spa (TodoMVC by steps / one goal) | 2/4 | 9.5 | 5.2 |
| interaction (hover, JS confirm, delayed modal, sort) | 6/8 | 2.3 | 5.2 |
| navigation (HN, books) | 4/4 | 3.5 | 4.8 |
| large-page (Wikipedia search/link, GitHub tabs/search) | 8/8 | 4.3 | 8.2 |
| e2e (saucedemo checkout by steps / one goal, a private staging login run from tasks.local.mjs) | 6/6 | 12.3 | 13.1 |
| negative (bad password, missing page, disabled field, missing option) | 8/8 | 2.8 | 4.4 |
| iframe (form, jQuery date picker) | 4/4 | 3.3 | 2.8 |
| shadow-dom | 2/2 | 2.0 | 1.1 |
| custom-widget (react-select) | 2/2 | 3.0 | 5.3 |
| tabs (new window) | 2/2 | 2.0 | 4.7 |
| lazy (infinite scroll) | 0/2 | 11.0 | 9.4 |
| actions (drag, right-click, key press, upload) | 8/8 | 2.8 | 4.4 |
| guard (login and form not paused; checkout paused at Finish) | 6/6 | 8.3 | 7.1 |

## Irreversible-action pause

Every round asks `irreversible` (would the next action have a hard-to-undo effect outside the
browser?). In tasks run *without* the pause, the rounds where it would have fired (≥0.6 on a
click/Enter/key) were only:

- r6: saucedemo-fine `Finish` (0.66, 0.77), saucedemo-coarse `Finish` (0.70)
- r7: saucedemo-fine `Finish` (0.77), saucedemo-coarse `Finish` (0.72)

Logins, form submits, "Add to cart", "Checkout", "Continue", upload and drag never reached it.

## Page content the calling LLM reads (estimate)

Playwright-MCP style = one AI aria snapshot (`page.ariaSnapshot({mode: "ai"})`) of the task's
start page per action, plus the initial one. laya-browser = the `browser_do` results. Tokens ≈ characters / 4.

| | total over 40 tasks (r6) | median task |
|---|---|---|
| Playwright-MCP style, to the LLM | ≈557k tokens | — |
| laya-browser, to the LLM | ≈8.3k tokens | 5.4× less |
| read by Jev instead | ≈602k tokens | |

The gap comes from big pages: Wikipedia link (≈149k-token snapshot, ~2,300×), GitHub (~270×),
HN and books (~115–180×). Small test pages save 2–8×. The iframe and shadow-DOM pages
cost *more* (0.3–0.4×), because their snapshots are tiny. This does not measure how many
actions an LLM would take on its own.

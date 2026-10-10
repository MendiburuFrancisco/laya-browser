# laya-browser

**laya-browser** is a fork of [jev-browser](https://github.com/Ying-Kai-Liao/jev-browser) that uses **Laya as its local decision system** for browser automation. It preserves the original project's browser automation architecture, MIT license, and attribution.

Browser automation where an LLM plans, **Laya decides**, and Playwright acts.

Configure `JEV_BACKEND=laya` to use the local decision system, without a TypeSafe API key.
The original Jev backend remains available for compatibility; an unconfigured installation
still selects `jev`. See [Local Laya backend](#local-laya-backend-cpu-or-cuda) for setup.

The calling LLM (Claude, via MCP) says what outcome it wants, one step at a time, and hands
over any text to type. For each round of a step, code describes the page. The local Laya
decision system evaluates the next operation and target, along with auxiliary questions:
which element, which action, which value, and is the step done / blocked / showing an error /
about to do something irreversible. Playwright performs the action. The LLM never reads page
snapshots unless it chooses to take over.

```
Claude ── browser_do("Log in", {email, password}) ──▶ laya-browser
                                                       │  loop until done / stuck / needs confirmation
                                                       │   1. settle   (network + DOM quiet)
                                                       │   2. describe (elements, labels, state, visible text, diff, counts)
                                                       │   3. Laya     (done? error? irreversible? tool? target? value?)
                                                       │   4. act      (Playwright)
Claude ◀── { status: "done", url, actions[], done_score } ─┘
```

https://github.com/user-attachments/assets/2e688df9-4985-4854-8ebe-ba97c9d13d68

Laya answers typed questions with probability distributions: yes/no (`noul`), pick one option (`choice`)
or a rating (`score`). It never writes text. So everything free-form comes from the caller as
candidates, and code turns disagreement or low confidence into a status the LLM can act on.

## Jev vs. Laya: reproducible comparison

Five local examples compare field entry, a checkbox, a dropdown, search, and task
creation with both decision backends. See [examples/comparison](examples/comparison/README.md)
for setup and [BENCHMARK-JEV-LAYA.md](BENCHMARK-JEV-LAYA.md) for measured results.

```bash
npm run bench:compare -- --repetitions 3
```

The runner executes Jev first and Laya second, disables the decision cache, and
checks the DOM after each step. It reports decision latency, execution time,
request counts, and token usage when provided by the backend.

### Benchmark summary: Jev vs. Laya CPU vs. Laya AMD GPU

Measured on October 10, 2026: five identical local examples, three repetitions
per configuration, headless browser, decision cache disabled, and DOM assertions.

| Metric | Jev remote API | Laya local CPU | Laya local AMD GPU |
|---|---:|---:|---:|
| Mean decision request latency | 250.51 ms | 2,715.35 ms | 951.30 ms |
| Median decision request latency | 236.53 ms | 2,657.69 ms | 901.28 ms |
| P95 decision request latency | 321.81 ms | 3,458.79 ms | 1,183.91 ms |
| Total execution time for 15 tasks | 21.38 s | 98.48 s | 40.11 s |
| Measured decision requests | 43 | 33 | 33 |
| Goals achieved in the DOM | 15/15 | 9/15 | 9/15 |
| Completions confirmed by status and DOM | 12/15 | 9/15 | 9/15 |
| Reported input / output tokens, measured tasks | 52,417 / 10,311 | Not measured | Not measured |

**Local computer:** Ubuntu 22.04.5 LTS, kernel `6.8.0-138-generic`, Intel Core
i5-11400F @ 2.60 GHz (6 cores / 12 threads), 23.31 GiB system-reported RAM, and
AMD Radeon RX 6600 (`gfx1032`, 8 GB nominal VRAM). Node.js 24.15.0 and Python
3.11.16 were used. CPU inference used PyTorch `2.14.1+cu130` on CPU; GPU inference
used `2.16.0a0+rocm10.2.0a20261010` with ROCm and both models on `cuda:0`.

Laya's mean request latency improved **2.85× with AMD GPU** relative to the CPU
run. GPU execution was measured separately with a different PyTorch build. Jev's
remote inference hardware is unknown; the local specifications describe its
browser/client, not the TypeSafe server. Request latency includes networking and
response processing. Laya's internal token counts are not measured, not zero.

See [BENCHMARK-JEV-LAYA.md](BENCHMARK-JEV-LAYA.md) for the full hardware table,
methodology, and interpretation, and [ROCM-AMD.md](ROCM-AMD.md) for the verified
AMD GPU setup.

An additional AMD GPU run with `--allow-irreversible` passed **15/15 existing DOM
checks**, versus 9/15 with the flag disabled, taking 54.42 s and 45 decision
requests (mean 958.64 ms). The flag removes confirmation pauses, not model errors:
the search trace submitted during a step requesting entry without submission,
which the current field-value assertion does not detect. See the full report for
this verification limitation and the separate run data.

## Results inherited from jev-browser

The results below come from the original project's **Jev backend**, not from Laya.
They document the upstream implementation; see the local Laya setup section for
the current adapter's supported operations and verification examples.

42 tasks in 16 categories on live sites (see [RESULTS.md](RESULTS.md)):

- **40/42 correct in the latest run, 0 false "done" claims** (38/41 twice before the latest
  fixes). Remaining misses: counting ("add until 3", flagged `likely_done`) and verifying a sort.
- **~300 ms per Jev call**, 2–4 calls for most steps; a 5-step checkout takes ~14 s end to end.
- **Pause before irreversible actions**: across ~200 rounds it flagged only saucedemo's
  "Finish" (place order) button.
- **Less page content for the LLM** than a Playwright-MCP-style loop on the same tasks
  (estimate): median 5× per task, ≈8k vs ≈557k tokens in total. Big pages dominate the total:
  a Wikipedia article is ~149k snapshot tokens. On tiny pages there is no saving. The page
  reading moves to Jev.

Works on: forms, native and custom dropdowns, checkboxes and radios (including styled
replacements), dynamic loading, modals, JS dialogs, hover, right-click, drag and drop, key
presses, file upload, iframes, shadow DOM, new tabs, pages with 2,000+ elements (two-stage
selection), and non-English UIs.

Element discovery includes DOM event properties (`element.onclick`), React event
props, and direct native listeners registered after browser startup. This also
detects custom sidebar/card controls whose pointer cursor appears only on hover,
without requiring a prior mouse movement. Hidden/inert controls stay excluded.

Known limits, so write steps around them:
- **Ordered sub-goals in one step** ("add two todos, complete one, clear completed") → split
  into one outcome per step.
- **Open-ended goals** ("scroll to load more") → make them measurable or check yourself.
- **Judgements that compare many values** (is this table sorted, did exactly one thing change)
  → verify with `browser_check` or `browser_snapshot`.

## Quick start (MCP, from npm)

```bash
npx playwright install chromium          # once
claude mcp add laya-browser -e TYPESAFE_API_KEY=your-key -- npx -y -p laya-browser laya-browser-mcp
```

Any MCP client works the same way: command `npx`, args `-y -p laya-browser laya-browser-mcp`,
env `TYPESAFE_API_KEY`. Add `JEV_BROWSER_HEADED=1` to watch it work.

## Setup (from source)

```bash
git clone https://github.com/MendiburuFrancisco/laya-browser && cd laya-browser
npm install
npm run setup                    # downloads Chromium for Playwright
cp .env.example .env             # add TYPESAFE_API_KEY
npm test                         # offline tests (no network, no key)
npm run test:e2e                 # MCP server end to end (network + key)
```

### Local Laya backend (CPU or CUDA)

This fork uses the [cklxx/laya-browser model on Hugging Face](https://huggingface.co/cklxx/laya-browser)
as its browser decision checkpoint. It is a fine-tuned version of
[Laya](https://huggingface.co/convaiinnovations/laya), a non-autoregressive model
that answers typed questions without generating text.

#### 1. Install the Laya Python package

Requirements: **Python 3.11+**, Node.js 20+, and Internet access for the initial
dependency installation and model download. CPU execution is supported; CUDA
execution requires an NVIDIA GPU and a CUDA-compatible PyTorch installation.

For AMD GPUs, use a compatible **ROCm build of PyTorch**. See
[ROCM-AMD.md](ROCM-AMD.md) for the RX 6600 installation verified with this project.
PyTorch also uses `--device cuda` for AMD ROCm; `/health` reports the actual
accelerator and the devices of both models.

From the repository root, create an isolated environment with
[uv](https://docs.astral.sh/uv/getting-started/installation/) and install the
project's pinned Laya dependency (`laya==0.4.2`):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r local/requirements.txt
```

Alternatively, use Python's built-in virtual environment and pip:

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -r local/requirements.txt
```

#### 2. Download the models and start the local server

For CPU:

```bash
.venv/bin/python local/laya_server.py --model cklxx/laya-browser --device cpu
```

For CUDA:

```bash
.venv/bin/python local/laya_server.py --model cklxx/laya-browser --device cuda
```

The first launch automatically downloads **two checkpoints** from Hugging Face:

- [`cklxx/laya-browser`](https://huggingface.co/cklxx/laya-browser): selects browser operations and target elements.
- [`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya): answers auxiliary questions, including checks, values, errors, and irreversible actions.

Subsequent launches reuse the Hugging Face cache. Keep this terminal running and
wait for the `Laya ready` message before connecting the browser.

To download the checkpoints into the Hugging Face cache ahead of time:

```bash
.venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("cklxx/laya-browser"); snapshot_download("convaiinnovations/laya")'
```

If you already have local copies, pass their directories with
`--model /absolute/path/to/laya-browser` and `--checks-model /absolute/path/to/laya`.

#### 3. Verify readiness and connect the browser

In a second terminal, check that both models have loaded:

```bash
curl http://127.0.0.1:8791/health
```

The response should contain `"ok": true`, the model IDs or paths, and the selected
device. Then run the browser against the local server:

```bash
JEV_BACKEND=laya JEV_CACHE=0 node bin/laya-browser.mjs run examples/flows/laya-smoke.json --headed
```

For MCP, set `JEV_BACKEND=laya` in the server environment or in the repository's
`.env`. No TypeSafe API key is required. `JEV_API_URL` overrides the default
`http://127.0.0.1:8791/v1/systemone`. Check readiness at `/health`.
For example, add these settings to `.env`:

```dotenv
JEV_BACKEND=laya
JEV_API_URL=http://127.0.0.1:8791/v1/systemone
JEV_CACHE=0
```

For step-by-step MCP configuration in Spanish, see [MCP-LAYA.md](MCP-LAYA.md).

Use a separate `JEV_CACHE_FILE=.laya-cache.json` when enabling the decision cache
to avoid replaying decisions previously made by Jev.

The adapter preserves this project's page/task schema, supplies descriptions for
element and group choices, and splits choices wider than 60 candidates. The browser
checkpoint chooses CLICK, TYPE_TEXT, SELECT, PRESS_ENTER, SCROLL_DOWN, WAIT, DONE
and BLOCKED in an operation-specific target layout. General Laya handles auxiliary
typed questions (values, checks, login, error, irreversible actions, and group
selection); the browser checkpoint's yes/no head saturated during initial testing.
Both checkpoints run locally. `--checks-model` selects a different general checkpoint.
Hover, drag, right-click, upload and other keyboard actions remain available through
manual `browser_act`; the local browser policy does not propose those operations.
This is a different question format from the model's original jev-ultrafast
evaluation harness; its published benchmark scores do not apply to this adapter.
The model may stop early or request confirmation on benign actions; verify results
with page assertions. The existing multi-step TodoMVC flow is not a passing Laya
benchmark. `laya-smoke.json` is a small field-entry example with a DOM assertion.
The browser still receives strings to type through `values`, so no additional
text-generation model is needed. The default backend remains `jev`.

### Monitor Laya resources

On Linux, with the Laya server running, launch a dashboard that graphs only the
server process (CPU and resident RAM), sampled every second:

```bash
node local/monitor-laya.mjs
```

Open the printed `http://127.0.0.1:8792` URL in a browser. CPU is expressed as a
percentage of one core; the graphs show the most recent 90 seconds.

### Use from Claude Code (MCP, from source)

```bash
claude mcp add laya-browser -- node /absolute/path/to/laya-browser/bin/laya-browser-mcp.mjs
```

From a source checkout the server reads `TYPESAFE_API_KEY` from the repo's `.env`.

| tool | purpose |
|---|---|
| `browser_open(url, viewport?)` | navigate and wait; viewport object fixes resolution, null follows window size |
| `browser_do(goal, values?, max_actions?, allow_irreversible?, explain?)` | work toward one outcome; returns a status |
| `browser_run(steps, url?, viewport?)` | run an ordered plan locally; return only on completion or the first problem |
| `browser_check(question)` | yes/no about the page → `p_yes` |
| `browser_choose(question, options)` | pick among given options → distribution |
| `browser_snapshot()` | compact numbered element list, for taking over |
| `browser_act(action, element, value?, key?, destination?, accept_dialog?)` | act on an element directly, no model; confirm/prompt dialogs are dismissed unless `accept_dialog` |
| `browser_screenshot(full_page?)` | PNG image |
| `browser_close()` | end the session |

`browser_do` statuses:

| status | meaning / what the caller should do |
|---|---|
| `done` | goal reached |
| `likely_done` | the page looks done but Jev is unsure: verify before moving on |
| `needs_login` | a sign-in wall and no credentials in `values`; log in yourself (headed + `JEV_BROWSER_PROFILE`) or pass credentials |
| `needs_confirmation` | next action, or a confirm dialog it opened (then dismissed), looks irreversible (order, pay, send, delete); see `pending`, re-call with `allow_irreversible: true` only if the user wants it |
| `error` | the page shows an error after the last action (e.g. wrong password); see `page_text` |
| `stuck` / `max_actions` | no progress; see `info`, `page_text`, `candidates` |
| `ambiguous` | low confidence in the target; pick from `candidates` with `browser_act` |
| `blocked` | captcha, access denied, error page |

Env: `JEV_BROWSER_HEADED=1` shows the browser, `JEV_BROWSER_PROFILE=/dir` keeps a persistent
profile (logins survive restarts), `JEV_BROWSER_LOG=1` prints per-round decisions to stderr.

#### MCP viewport configuration

Set the viewport on the first `browser_open` call:

```json
{"url":"https://example.com", "viewport":{"width":1280,"height":800}}
```

To let the page follow the actual browser window size (including manual resizing):

```json
{"url":"https://example.com", "viewport":null}
```

The viewport is a launch setting. Subsequent calls without it keep the current
configuration. To change it, call `browser_close` and then `browser_open` with the
new viewport. Omitting it on launch defaults to 1280×800.

You can also set a default in your MCP server configuration's `env`:

```json
{"JEV_BROWSER_HEADED":"1", "JEV_BROWSER_VIEWPORT":"null"}
```

For a fixed size, use `"JEV_BROWSER_VIEWPORT":"{\"width\":1280,\"height\":800}"`.
The explicit `browser_open.viewport` takes precedence over this environment setting.

### Decision cache (replay without Jev)

`browser_do` persists each successful decision to disk (default `.laya-cache.json`, override with
`JEV_CACHE_FILE`; disable with `JEV_CACHE=0`). On later runs of the same goal, cached actions
replay **without calling Jev**: the stored stable XPath is re-resolved against the fresh snapshot
and validated (same element brief, same frame, required values present). A mismatch evicts the
entry and Jev decides again — self-healing. Irreversible actions are never cached, and secrets
aren't either (only the `values` key name). The result reports `cache: { hits, saved }`.

### Library

`LayaBrowser` is the public name; `JevBrowser` remains available as a compatibility alias.
The existing `JEV_*` environment variables continue to configure both backends.

```js
// npm install laya-browser && npx playwright install chromium
import { LayaBrowser } from "laya-browser";

const b = await LayaBrowser.launch({ headed: true });
await b.open("https://www.saucedemo.com/");
await b.do("Log in", { values: { username: "standard_user", password: "secret_sauce" } });
await b.do("Add the Sauce Labs Backpack to the cart");
const p = await b.check("Does the cart badge show 1 item?");   // 0..1
await b.close();
```

### Watch it

```bash
node examples/x-profile-demo.mjs     # headed, read-only x.com walkthrough with decision highlights
```

Each action is outlined in red with Jev's choice and scores before it happens (`highlight: true`,
on by default in the MCP server when `JEV_BROWSER_HEADED=1`). Some sites, x.com included, serve a
blank page to headless Chromium: use headed mode there.

### CLI

```bash
node bin/laya-browser.mjs do https://the-internet.herokuapp.com/login "Log in" username=tomsmith 'password=SuperSecretPassword!'
node bin/laya-browser.mjs run examples/flows/todomvc.json --headed
```

## Writing good steps

- One observable outcome per step: "Log in", "Open the Pull requests tab", "Mark 'buy milk' completed".
- Every string goes in `values` with a meaningful key (`email`, `postal_code`, `file`).
- Treat `likely_done`, `needs_confirmation`, `ambiguous` and `stuck` as your turn: check,
  snapshot or ask the user, don't just retry.
- After steps with side effects, `browser_check` what must *not* have changed.

## Benchmark

```bash
node bench/run.mjs --set all            # base, hard, guard (+ bench/tasks.local.mjs if present)
node bench/run.mjs --only ti-login,drag
node bench/context-cost.mjs bench/results/<run>.json
```

Private sites and credentials go in `bench/tasks.local.mjs` (git-ignored), exporting `LOCAL`.

## Layout

```
src/session.mjs      JevBrowser: settle, snapshot, decide (1 or 2 stages), resolve, act, do, check, choose
src/page-script.mjs  runs in each frame: elements, labels, state, visible text, metrics, dialogs
src/page-model.mjs   pure helpers: diff between pages, counts, compact rendering
src/jev.mjs          System One API client
src/flow.mjs         JSON flow runner
bin/                 CLI and MCP server
bench/               tasks with ground-truth checks, runner, context-cost estimate
test/                offline fixture tests, MCP end-to-end test
NOTES.md             design notes: what works with Jev, what doesn't, and why
```

## Releasing

CI runs the offline tests on every push and pull request. To publish, bump the version and push
the tag; `.github/workflows/release.yml` tests, publishes to npm with provenance and creates a
GitHub release:

```bash
npm version patch            # or minor / major: commits and tags vX.Y.Z
git push --follow-tags
```

Publishing uses npm trusted publishing, set up once with
`npx npm@latest trust github laya-browser --file release.yml --repo MendiburuFrancisco/laya-browser --allow-publish`.

## License

MIT

// Untrusted source is evaluated ONLY inside QuickJS/WASM, never in the Node worker.
import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";

const { code, values, methods, timeoutMs, memoryBytes, maxOperations, maxOutputChars } = workerData;
const deadline = Date.now() + timeoutMs;
let vm, runtime, root, finished = false, fatal = false, sequence = 0;
const pending = new Map();

function finish(message) {
  if (finished) return;
  finished = true;
  parentPort.postMessage(message);
  parentPort.close();
}
function failure(error) {
  finish({ type: "error", info: String(error?.message ?? error).slice(0, 500) });
}
function pump() {
  if (finished) return;
  try {
    while (runtime.hasPendingJob()) {
      const job = runtime.executePendingJobs(100);
      if (job.error) {
        const error = vm.dump(job.error); job.error.dispose();
        throw new Error(error?.message ?? JSON.stringify(error));
      }
      if (fatal || Date.now() >= deadline) throw new Error("Execution interrupted");
    }
    const state = vm.getPromiseState(root);
    if (state.type === "fulfilled") {
      const json = vm.getString(state.value); state.value.dispose();
      if (pending.size) throw new Error("Await every browser call before returning");
      if (json.length > maxOutputChars) throw new Error("Output exceeds max_output_chars");
      finish({ type: "result", json });
    } else if (state.type === "rejected") {
      const error = vm.dump(state.error); state.error.dispose();
      throw new Error(error?.message ?? JSON.stringify(error));
    }
  } catch (error) { failure(error); }
}

try {
  const QuickJS = await getQuickJS();
  runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => fatal || Date.now() >= deadline);
  vm = runtime.newContext();
  // Strings are the entire RPC boundary. No host objects/functions cross the VM.
  const rpc = vm.newFunction("rpc", (method, input) => {
    if (++sequence > maxOperations) {
      fatal = true;
      finish({ type: "limit", info: "Browser operation budget exhausted" });
      return vm.undefined;
    }
    const json = vm.getString(input);
    if (json.length > 128000) throw new Error("Browser input exceeds 128000 characters");
    const promise = vm.newPromise();
    pending.set(sequence, promise);
    parentPort.postMessage({ type: "call", id: sequence, method: vm.getString(method), json });
    return promise.handle;
  });
  vm.setProp(vm.global, "__rpc", rpc); rpc.dispose();
  // Capture serialization before guest code can alter globals. Methods and values are
  // guest-owned data. No module loader or host network/filesystem globals are installed.
  const bootstrap = vm.evalCode(`
    const browser = (() => {
      const rpc = globalThis.__rpc, stringify = JSON.stringify, parse = JSON.parse;
      delete globalThis.__rpc;
      return Object.freeze(Object.fromEntries(${JSON.stringify(methods)}.map(method =>
        [method, async (input = {}) => parse(await rpc(method, stringify(input)))])));
    })();
    const values = JSON.parse(${JSON.stringify(JSON.stringify(values))});
  `);
  vm.unwrapResult(bootstrap).dispose();
  // JSON serialization happens inside the VM and is subject to its CPU/memory limits.
  root = vm.unwrapResult(vm.evalCode(`((stringify) => (async () => {
    const result = await (async () => { "use strict";\n${code}\n})();
    const json = stringify(result === undefined ? null : result);
    if (typeof json !== 'string') throw new Error('Program must return JSON-serializable data');
    return json;
  })())(JSON.stringify)`, "browser-code.js"));
  parentPort.on("message", message => {
    if (finished) return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    const value = vm.newString(message.json);
    promise.resolve(value); value.dispose(); promise.dispose();
    pump();
  });
  pump();
} catch (error) { failure(error); }
// The host terminates the disposable worker on every exit path, reclaiming its WASM
// heap and pending handles even after interruption or out-of-memory errors.

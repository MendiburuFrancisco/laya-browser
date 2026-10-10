#!/usr/bin/env node
// Sequential, cache-free Jev -> Laya comparison against identical local examples.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus, totalmem } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return process.argv[i + 1];
};
const repetitions = Number(option('--repetitions', '3'));
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('Repetitions must be a positive integer');
const headed = process.argv.includes('--headed');
const allowIrreversible = process.argv.includes('--allow-irreversible');
const backends = option('--backend', 'jev,laya').split(',');
if (backends.some(backend => !['jev', 'laya'].includes(backend)) || !backends.length) {
  throw new Error('--backend must be jev, laya, or jev,laya');
}
const ids = ['fill-field', 'checkbox', 'select-option', 'search', 'add-todo'];
const out = resolve(option('--out', 'bench/results/backend-comparison'));
const worker = option('--worker');
const round = n => Math.round(n * 100) / 100;
const sum = xs => xs.reduce((a, b) => a + b, 0);
const distribution = xs => {
  if (!xs.length) return { count: 0, mean_ms: null, median_ms: null, p95_ms: null };
  const sorted = [...xs].sort((a, b) => a - b), middle = Math.floor(xs.length / 2);
  return { count: xs.length, mean_ms: round(sum(xs) / xs.length),
    median_ms: round(xs.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95_ms: round(sorted[Math.ceil(xs.length * .95) - 1]) };
};

if (option('--from')) {
  const report = JSON.parse(readFileSync(resolve(option('--from')), 'utf8'));
  writeFileSync(resolve(option('--report', `${out}.md`)), markdown(report));
} else if (worker) {
  await runWorker();
} else {
  await compare();
}

async function runWorker() {
  const { LayaBrowser } = await import('../src/index.mjs');
  const { BACKEND, API_URL, MODEL, apiKey } = await import('../src/jev.mjs');
  const results = [], requests = [];
  let phase = 'warmup', currentTask = null, health = null;
  const started = performance.now(), originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) !== API_URL) return originalFetch(url, options);
    const t = performance.now();
    const sample = { phase, task: currentTask, request_chars: options?.body?.length ?? 0 };
    try {
      const response = await originalFetch(url, options);
      const body = await response.clone().json().catch(() => ({}));
      sample.http_status = response.status;
      sample.inference_ms = body.inference_ms ?? null;
      // The local adapter emits a synthetic input_tokens=0, not tokenizer usage.
      sample.input_tokens = BACKEND === 'jev' ? body.usage?.input_tokens ?? null : null;
      sample.output_tokens = BACKEND === 'jev' ? body.usage?.output_tokens ?? null : null;
      return response;
    } catch (error) { sample.error = error.message; throw error; }
    finally { sample.client_ms = round(performance.now() - t); requests.push(sample); }
  };
  let browser;
  let error;
  try {
    if (BACKEND === 'jev') apiKey();
    else {
      const response = await originalFetch(new URL('/health', API_URL), { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Laya health HTTP ${response.status}`);
      health = await response.json();
    }
    browser = await LayaBrowser.launch({ headed });
    browser.cache = null;
    await browser.call({ text: 'Benchmark warmup' }, { q: { type: 'noul', instructions: 'Does the text contain Benchmark?' } });
    await browser.close(); browser = null;
    phase = 'measurement';
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const id of ids) {
        currentTask = `${id}:${repetition}`;
        const flow = JSON.parse(readFileSync(resolve(ROOT, 'examples/comparison', `${id}.json`), 'utf8'));
        browser = await LayaBrowser.launch({ headed }); browser.cache = null;
        const t = performance.now(), firstRequest = requests.length, steps = [];
        try {
          await browser.open(`${option('--base-url')}/${id}`);
          for (const step of flow.steps) {
            const r = await browser.do(step.goal, { values: step.values ?? {}, maxActions: step.maxActions,
              allowIrreversible, log: s => console.log(`[${BACKEND}/${currentTask}] ${s}`) });
            await browser.settle();
            const truth = await browser.page.evaluate(`(${step.assert})()`);
            const ok = ['done', 'likely_done'].includes(r.status) && truth === true;
            steps.push({ goal: step.goal, status: r.status, truth, ok, ms: r.ms,
              rounds: r.rounds, actions: r.actions, info: r.info });
            if (!ok) break;
          }
        } catch (e) { steps.push({ status: 'exception', ok: false, info: e.message }); }
        const taskRequests = requests.slice(firstRequest);
        const rec = { id, repetition, execution_ms: round(performance.now() - t),
          calls: browser.stats.calls, http_requests: taskRequests.length,
          decision_ms: round(sum(taskRequests.map(s => s.client_ms))),
          input_tokens: tokenTotal(taskRequests, 'input_tokens'),
          output_tokens: tokenTotal(taskRequests, 'output_tokens'),
          request_chars: sum(taskRequests.map(s => s.request_chars)),
          verified: steps.length === flow.steps.length && steps.every(s => s.ok),
          false_done: steps.some(s => s.status === 'done' && s.truth === false), steps };
        results.push(rec);
        console.log(`${BACKEND} ${currentTask}: ${rec.verified ? 'PASS' : 'FAIL'} ${rec.execution_ms}ms, ${rec.calls} calls`);
        const pauseMs = Number(option('--pause-ms', headed ? '2000' : '0'));
        if (headed && pauseMs > 0) await browser.page.waitForTimeout(pauseMs);
        await browser.close(); browser = null;
        // Persist completed work even if a subsequent task is interrupted.
        save();
      }
    }
  } catch (e) { error = e.message; console.error(`${BACKEND}: ${error}`); }
  finally { if (browser) await browser.close(); globalThis.fetch = originalFetch; save(); }
  function save() {
    writeFileSync(`${out}-${worker}.json`, JSON.stringify({ backend: BACKEND, endpoint: API_URL,
      model: MODEL, health, repetitions, headed, allow_irreversible: allowIrreversible,
      error, elapsed_ms: round(performance.now() - started), results, requests }, null, 2));
  }
}

function tokenTotal(samples, key) {
  return samples.length && samples.every(s => typeof s[key] === 'number') ? sum(samples.map(s => s[key])) : null;
}

async function compare() {
  mkdirSync(dirname(out), { recursive: true });
  const html = readFileSync(resolve(ROOT, 'examples/comparison/page.html'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runs = [];
  try {
    for (const backend of backends) {
      const endpoint = backend === 'jev' ? option('--jev-url', 'https://api.typesafe.ai/v1/systemone')
        : option('--laya-url', 'http://127.0.0.1:8791/v1/systemone');
      const model = backend === 'jev' ? 'jev-latest' : 'cklxx/laya-browser';
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', backend,
          '--repetitions', String(repetitions), '--base-url', base, '--out', out,
          ...(headed ? ['--headed'] : []), ...(allowIrreversible ? ['--allow-irreversible'] : [])], {
          cwd: ROOT, stdio: 'inherit', env: { ...process.env, JEV_BACKEND: backend, JEV_API_URL: endpoint,
            JEV_MODEL: model, JEV_CACHE: '0' },
        });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${backend} worker exit ${code}`)));
      });
      runs.push(JSON.parse(readFileSync(`${out}-${backend}.json`, 'utf8')));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  const report = { date: new Date().toISOString(), environment: { node: process.version,
    cpu: cpus()[0]?.model, logical_cpus: cpus().length, ram_gib: round(totalmem() / 1024 ** 3), platform: process.platform }, runs };
  writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${out}.md`, markdown(report));
  console.log(`Report: ${out}.md`);
}

function markdown(report) {
  const fmt = n => n == null ? 'No informado' : String(round(n));
  const achieved = rec => rec.steps.length === (['search', 'add-todo'].includes(rec.id) ? 2 : 1)
    && rec.steps.every(s => s.truth === true);
  const repetitions = report.runs[0]?.repetitions;
  const lines = ['# Comparación de Jev y Laya', '', `Fecha UTC: ${report.date}`, '',
    '## Metodología', '',
    `- Cinco ejemplos locales idénticos, ${repetitions} repeticiones por backend; orden: ${report.runs.map(run => run.backend).join(', ')}.`,
    '- Ejecución secuencial, contexto nuevo por ejemplo y caché desactivada.',
    '- Una consulta de calentamiento por backend, excluida de las tablas de tareas; se informa su consumo por separado.',
    '- Verificación determinista del DOM después de cada paso. Se distingue objetivo logrado en el DOM de éxito confirmado por DOM + estado done/likely_done.',
    '- Latencia de decisión: petición HTTP completa medida por el cliente, incluyendo red, inferencia y lectura de respuesta. No es inferencia pura.',
    '- Tiempo de ejecución: navegación + decisiones + acciones + esperas + verificaciones; excluye creación y cierre del contexto.',
    '- Tokens: uso de entrada/salida informado por Jev. Laya devuelve un cero sintético; se registra como no informado, no como cero tokens procesados.',
    '- Caracteres/4 es solo una aproximación del tamaño del JSON de petición, no una medición del tokenizer ni de facturación.',
    '- Los intentos HTTP fallidos y reintentos se conservan en el JSON. Consumo desconocido se mantiene como no informado.', '',
    `Equipo: ${report.environment.cpu}; ${report.environment.logical_cpus} CPUs lógicas; ${report.environment.ram_gib} GiB RAM; ${report.environment.node}.`, '',
    '## Resumen medido', '',
    '| Backend | Objetivos DOM | Éxitos confirmados | Consultas HTTP | Decisión media (ms) | Mediana (ms) | P95 (ms) | Ejecución total (s) | Tokens entrada | Tokens salida | JSON petición ≈ tokens |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const run of report.runs) {
    const samples = run.requests.filter(s => s.phase === 'measurement'), d = distribution(samples.map(s => s.client_ms));
    lines.push(`| ${run.backend} | ${run.results.filter(achieved).length}/${run.results.length} | ${run.results.filter(r => r.verified).length}/${run.results.length} | ${samples.length} | ${fmt(d.mean_ms)} | ${fmt(d.median_ms)} | ${fmt(d.p95_ms)} | ${fmt(sum(run.results.map(r => r.execution_ms)) / 1000)} | ${fmt(tokenTotal(samples, 'input_tokens'))} | ${fmt(tokenTotal(samples, 'output_tokens'))} | ${fmt(sum(samples.map(s => s.request_chars)) / 4)} |`);
  }
  lines.push('', '## Resultados por ejemplo', '',
    '| Backend | Ejemplo | Objetivos DOM | Éxitos confirmados | Tiempo medio (s) | Consultas por ejecución | Decisión media (ms) | Tokens entrada totales |',
    '|---|---|---:|---:|---:|---:|---:|---:|');
  for (const run of report.runs) {
    for (const id of ids) {
      const rows = run.results.filter(r => r.id === id);
      if (!rows.length) continue;
      const samples = run.requests.filter(s => s.phase === 'measurement' && s.task?.startsWith(`${id}:`));
      lines.push(`| ${run.backend} | ${id} | ${rows.filter(achieved).length}/${rows.length} | ${rows.filter(r => r.verified).length}/${rows.length} | ${fmt(sum(rows.map(r => r.execution_ms)) / rows.length / 1000)} | ${fmt(samples.length / rows.length)} | ${fmt(distribution(samples.map(s => s.client_ms)).mean_ms)} | ${fmt(tokenTotal(samples, 'input_tokens'))} |`);
    }
  }
  lines.push('', '## Calentamiento, disponibilidad y fallos', '');
  for (const run of report.runs) {
    const warmup = run.requests.filter(s => s.phase === 'warmup');
    lines.push(`### ${run.backend}`, '', `- Modelo: \`${run.model}\`; endpoint: \`${run.endpoint}\`.`,
      `- Navegador: ${run.headed ? 'visible (headed)' : 'headless'}; allow_irreversible: **${run.allow_irreversible === true}**.`,
      `- Tiempo completo del proceso: ${fmt(run.elapsed_ms / 1000)} s (incluye calentamiento y creación/cierre de contextos).`,
      `- Calentamiento: ${warmup.length} consultas, ${fmt(sum(warmup.map(s => s.client_ms)))} ms; tokens de entrada: ${fmt(tokenTotal(warmup, 'input_tokens'))}.`,
      `- Consumo del proceso completo (incluye calentamiento): entrada ${fmt(tokenTotal(run.requests, 'input_tokens'))}, salida ${fmt(tokenTotal(run.requests, 'output_tokens'))} tokens.`,
      `- Falsos done: ${run.results.filter(r => r.false_done).length}.`);
    if (run.health) lines.push(`- Laya ejecutado en **${run.health.device}**; modelo auxiliar: \`${run.health.checks_model}\`.`);
    const inference = distribution(run.requests.filter(s => s.phase === 'measurement' && typeof s.inference_ms === 'number').map(s => s.inference_ms));
    if (inference.count) lines.push(`- Inferencia informada por el servidor: media ${fmt(inference.mean_ms)} ms, mediana ${fmt(inference.median_ms)} ms, P95 ${fmt(inference.p95_ms)} ms.`);
    if (run.error) lines.push(`- No se completó el backend: ${run.error.replaceAll('|', '/').replaceAll('\n', ' ')}.`);
    for (const rec of run.results.filter(r => !r.verified)) {
      const last = rec.steps.at(-1);
      lines.push(`- ${rec.id}, repetición ${rec.repetition}: ${last.status}; DOM verificado: ${last.truth ?? 'no evaluado'}${last.info ? `; ${last.info.replaceAll('\n', ' ')}` : ''}.`);
    }
    lines.push('');
  }
  const complete = report.runs.every(r => !r.error && r.results.length === ids.length * repetitions);
  lines.push('## Interpretación', '', complete
    ? 'Comparar latencias junto con la tasa de éxito y el número de decisiones: finalizar antes por error o detenerse prematuramente no equivale a completar una tarea más rápido.'
    : 'Comparación incompleta: no se puede determinar qué backend es más rápido hasta disponer de ejecuciones de ambos. No se han sustituido resultados faltantes por estimaciones.',
    'Estos ejemplos sintéticos no representan un benchmark de sitios reales. Laya usa recursos locales; Jev incluye latencia de red. No se mide la descarga ni la carga inicial de los checkpoints.', '',
    'Los archivos JSON adjuntos contienen las muestras por petición y los resultados de cada paso. No contienen claves API ni cabeceras de autenticación.', '');
  return lines.join('\n');
}

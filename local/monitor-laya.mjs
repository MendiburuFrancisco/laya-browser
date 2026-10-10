#!/usr/bin/env node
// Tiny local dashboard for the Laya server process only (Linux /proc).
import http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const port = Number(process.env.LAYA_MONITOR_PORT || 8792);
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
let previous;
let latest = null;
const samples = [];

async function layaProcess() {
  const entries = await readdir("/proc");
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const [cmdline, stat, status] = await Promise.all([
        readFile(`/proc/${entry}/cmdline`, "utf8"),
        readFile(`/proc/${entry}/stat`, "utf8"),
        readFile(`/proc/${entry}/status`, "utf8"),
      ]);
      const argv = cmdline.split("\0");
      if (!/python[^/]*$/.test(argv[0]) || !argv.some(a => a === "laya_server.py" || a.endsWith("/laya_server.py"))) continue;
      if (process.env.LAYA_MONITOR_PID && entry !== process.env.LAYA_MONITOR_PID) continue;
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const cpuTicks = Number(fields[11]) + Number(fields[12]);
      const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1] || 0);
      const now = performance.now();
      const cpu = previous?.pid === Number(entry)
        ? Math.max(0, (cpuTicks - previous.cpuTicks) / ticksPerSecond / ((now - previous.time) / 1000) * 100)
        : 0;
      previous = { pid: Number(entry), cpuTicks, time: now };
      return { pid: Number(entry), cpu, rssMb: rssKb / 1024, timestamp: Date.now() };
    } catch { /* process exited between reading /proc entries */ }
  }
  previous = undefined;
  return null;
}

// Sample independently of HTTP requests, so background tabs and multiple viewers
// do not lose short CPU bursts or distort the sampling interval.
let sampling = false;
async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const value = await layaProcess();
    if (value && latest?.pid !== value.pid) samples.length = 0;
    latest = value;
    if (latest) { samples.push(latest); if (samples.length > 90) samples.shift(); }
  } finally { sampling = false; }
}
await sample();
setInterval(() => sample().catch(error => console.error(error.message)), 1000);

const html = `<!doctype html>
<html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recursos de Laya</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#10141c;color:#e8edf5;font:15px system-ui,sans-serif}
main{max-width:1100px;margin:auto}h1{margin:0 0 6px;font-size:26px}.sub{color:#9ba8bb;margin:0 0 20px}
.cards{display:flex;gap:12px;margin-bottom:16px}.card{background:#1a2230;padding:14px 18px;border-radius:12px;min-width:155px}.label{font-size:12px;color:#9ba8bb}.value{font-size:25px;font-weight:650;margin-top:2px}
.chart{background:#1a2230;border-radius:12px;padding:12px 16px;margin:12px 0}h2{font-size:15px;font-weight:550;margin:0 0 8px}canvas{width:100%;height:210px;display:block}.status{color:#8b98ab;margin-top:12px}
@media(max-width:600px){body{padding:14px}.cards{gap:8px}.card{min-width:0;flex:1;padding:10px}.value{font-size:20px}canvas{height:170px}}
</style><main><h1>Uso de recursos de Laya</h1><p class="sub">Métricas del proceso del servidor; actualización cada segundo.</p>
<div class="cards"><div class="card"><div class="label">CPU · un núcleo = 100%</div><div id="cpu" class="value">—</div></div><div class="card"><div class="label">RAM residente</div><div id="ram" class="value">—</div></div><div class="card"><div class="label">Proceso</div><div id="pid" class="value">—</div></div></div>
<section class="chart"><h2>CPU del proceso</h2><canvas id="cpuGraph"></canvas></section><section class="chart"><h2>RAM del proceso (MB)</h2><canvas id="ramGraph"></canvas></section><p class="status" id="status">Buscando el servidor Laya…</p></main>
<script>
let history=[]; const maxPoints=90;
function graph(canvas,value,color,suffix){const dpr=devicePixelRatio||1,rect=canvas.getBoundingClientRect();canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);const w=rect.width,h=rect.height,p={l:48,r:12,t:12,b:24};const vals=history.map(x=>x[value]);let max=Math.max(...vals,1);max=Math.ceil(max/(value==='cpu'?25:50))*(value==='cpu'?25:50);if(max===0)max=1;c.font='11px system-ui';c.strokeStyle='#303b4c';c.fillStyle='#9ba8bb';c.lineWidth=1;for(let i=0;i<=4;i++){const y=p.t+(h-p.t-p.b)*i/4;c.beginPath();c.moveTo(p.l,y);c.lineTo(w-p.r,y);c.stroke();c.fillText((max*(1-i/4)).toFixed(0)+suffix,2,y+4)}if(vals.length<2)return;c.beginPath();vals.forEach((v,i)=>{const x=p.l+(w-p.l-p.r)*i/(maxPoints-1),y=p.t+(h-p.t-p.b)*(1-v/max);i?c.lineTo(x,y):c.moveTo(x,y)});c.lineTo(p.l+(w-p.l-p.r)*(vals.length-1)/(maxPoints-1),h-p.b);c.lineTo(p.l,h-p.b);c.closePath();c.globalAlpha=.15;c.fillStyle=color;c.fill();c.globalAlpha=1;c.beginPath();vals.forEach((v,i)=>{const x=p.l+(w-p.l-p.r)*i/(maxPoints-1),y=p.t+(h-p.t-p.b)*(1-v/max);i?c.lineTo(x,y):c.moveTo(x,y)});c.strokeStyle=color;c.lineWidth=2;c.stroke()}
async function update(){try{const r=await fetch('/metrics',{cache:'no-store'}),m=await r.json();if(!m){document.getElementById('cpu').textContent='—';document.getElementById('ram').textContent='—';document.getElementById('pid').textContent='—';document.getElementById('status').textContent='No encuentro el proceso laya_server.py. Inicia el servidor Laya primero.';return}history=m.history;document.getElementById('cpu').textContent=m.cpu.toFixed(1)+'%';document.getElementById('ram').textContent=m.rssMb.toFixed(0)+' MB';document.getElementById('pid').textContent=m.pid;document.getElementById('status').textContent='Laya activo · CPU expresada como porcentaje de un núcleo · ventana de 90 segundos (se conserva incluso con la pestaña en segundo plano)';graph(document.getElementById('cpuGraph'),'cpu','#58a6ff','%');graph(document.getElementById('ramGraph'),'rssMb','#45d483',' MB')}catch{document.getElementById('status').textContent='No se puede conectar al monitor de Laya.'}}
addEventListener('resize',()=>{if(history.length){graph(document.getElementById('cpuGraph'),'cpu','#58a6ff','%');graph(document.getElementById('ramGraph'),'rssMb','#45d483',' MB')}});update();setInterval(update,1000);
</script></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    const data = latest ? { ...latest, history: samples } : null;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(data));
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }
  res.writeHead(404).end("Not found");
});
server.listen(port, "127.0.0.1", () => console.log(`Monitor de Laya: http://127.0.0.1:${port}`));

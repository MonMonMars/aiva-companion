// mh-appprobe.mjs —— 看主 App 到底停在哪一屏、有哪些可点的东西
// 用法: node tools/mh-appprobe.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const DIST = ROOT + '/dist';
const PORT = Number(process.argv[2] || 4880);
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhprobe-${Date.now()}`,
  '--window-size=1000,900', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(400);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); page = l.find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') console.log('[EXC]', m.params.exceptionDetails?.exception?.description?.split('\n')[0]);
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    console.log('[' + m.params.type + ']', (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
});
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(6000);

const dump = await ev(`(()=>{
  const texts=[];
  document.querySelectorAll('*').forEach(e=>{
    if(e.children.length===0){const t=(e.textContent||'').trim(); if(t&&t.length<60) texts.push(t);}
  });
  const seen=new Set(); const uniq=[];
  for(const t of texts){ if(seen.has(t))continue; seen.add(t); uniq.push(t); }
  // 找所有可点元素（RNW 用 role="button" 或带 tabindex 的 div）
  const clickable=[];
  document.querySelectorAll('[role="button"],button,[tabindex]').forEach(e=>{
    const r=e.getBoundingClientRect();
    if(r.width<2||r.height<2) return;
    clickable.push({ tag:e.tagName, role:e.getAttribute('role'), text:(e.textContent||'').trim().slice(0,40),
      cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height) });
  });
  return JSON.stringify({ textCount:uniq.length, texts:uniq.slice(0,60), clickable:clickable.slice(0,40),
    hasDebug: !!globalThis.__aivaDebug, hasPreload: !!globalThis.__aivaPreload,
    canvas: !!document.querySelector('canvas'),
    url: location.href }, null, 1);
})()`);
console.log(dump);
srv.close(); chrome.kill(); process.exit(0);

// mh-occlude.mjs —— 用页面内的 THREE.Raycaster 判定眼睛/脸被头发遮挡的程度
// ===========================================================================
// 为什么不自己算：手写 Möller–Trumbore 很容易在叉积分量上写错，而且 SkinnedMesh
// 的世界空间三角形还要考虑蒙皮。页面里已经有 THREE，直接调 Raycaster 最可靠。
// 探针实现在 tools/mh-preview2.js 的 __dbg.occlude / __dbg.eyeBlocked。
//
// 输出：
//   1. 脸部遮挡 ASCII 图（每格 = 一个采样点，# 被头发挡）
//   2. 左右眼各自的遮挡像素比例
//
// 用法: node tools/mh-occlude.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4720);
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/mh-preview2.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhocc-${Date.now()}`,
  '--window-size=900,900', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(400);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); page = l.find((t) => t.type === 'page'); } catch {}
}
if (!page) { console.error('无法连接 Chrome'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); process.exit(1); }

const hasProbe = await ev('typeof window.__dbg.occlude === "function"');
if (!hasProbe) { console.error('预览页没有 occlude 探针 —— 需要先更新 tools/mh-preview2.js 并硬刷新'); process.exit(1); }

console.log('=== 眼睛遮挡率 ===');
console.log(await ev('JSON.stringify(window.__dbg.eyeBlocked(), null, 1)'));

console.log('\n=== 脸部遮挡图（X -0.09..0.09，Y 1.50..1.62；# = 被头发挡）===');
const occ = await ev('JSON.stringify(window.__dbg.occlude())');
const o = JSON.parse(occ);
if (o.err) console.log('ERR', o.err);
else {
  console.log('       ' + (() => { let s = ''; for (let x = -0.09; x <= 0.0901; x += 0.015) s += Math.abs(x) < 0.008 ? '|' : (Math.abs(x) < 0.023 ? ' ' : ' '); return s; })());
  for (const r of o.rows) console.log(r);
  console.log('（中轴在中间那格；左=负X，右=正X）');
}

srv.close(); chrome.kill(); process.exit(0);

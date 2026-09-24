// 截图：把关键几屏拍下来，人工（或用眼睛）验收排版
// 用法: node cdp-shot.mjs <url> <输出目录>
// 固定按 iPhone 竖屏 390x844 拍，因为这是真实的主要使用场景。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/index.html';
const outDir = process.argv[3] || path.join(process.cwd(), '.shots');
fs.mkdirSync(outDir, { recursive: true });

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9355;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=390,844', url], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });

const CLICK = `window.__clickText = (txt) => {
  const hits = Array.from(document.querySelectorAll('*')).filter((e) => {
    const r = e.getBoundingClientRect();
    return (e.textContent || '').includes(txt) && r.width > 0 && r.height > 0;
  });
  if (!hits.length) return { ok: false };
  const el = hits.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height - b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
  const r = el.getBoundingClientRect();
  for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:r.left+4,clientY:r.top+4}));
  return { ok: true };
};`;

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const b64 = r.result?.data;
  if (!b64) { console.log('no data for', name); return; }
  const p = path.join(outDir, name + '.png');
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  console.log('saved', p);
}

await sleep(1200);
await evaluate(CLICK);
await shot('1-title');

await sleep(11000);
await evaluate(CLICK);
await shot('2-select-character');

await evaluate(`window.__clickText('背景')`);
await sleep(1200);
await shot('3-select-background');

await evaluate(`window.__clickText('开始相处')`);
await sleep(14000);
await evaluate(CLICK);
await shot('4-home');

await evaluate(`(() => { const o = Array.from(document.querySelectorAll('*')).find(e => (e.textContent||'') === '☰'); if (o) { const r = o.getBoundingClientRect(); for (const t of ['mousedown','mouseup','click']) o.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:r.left+2,clientY:r.top+2})); } return 1; })()`);
await sleep(1500);
await shot('5-menu');

cleanup();
process.exit(0);

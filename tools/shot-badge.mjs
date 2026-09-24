// 把角落那个小圆环进度器单独拍下来（放大 4 倍），用来肉眼验收弧线和百分比排版。
// 塞 4 个假任务让百分比走 0 → 25 → 50 → 75 → 100，中途拍两张。
// 用法: node tools/shot-badge.mjs <url>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const outDir = path.join(process.cwd(), '.shots');
fs.mkdirSync(outDir, { recursive: true });

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9361;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', url], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
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
await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });

const CLICK_HELPER = `
  window.__rectFor = (txt, exact) => {
    const hits = Array.from(document.querySelectorAll('*')).filter((e) => {
      const r = e.getBoundingClientRect();
      const s = e.textContent || '';
      return (exact ? s === txt : s.includes(txt)) && r.width > 0 && r.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    })[0];
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
`;
const clickText = async (txt, exact = false) => {
  const r = await evaluate(`window.__rectFor(${JSON.stringify(txt)}, ${!!exact})`);
  if (!r) { console.log('  ! 没找到：' + txt); return false; }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  }
  return true;
};

// 走完标题页 → 角色选择页 → 主页
await sleep(1200);
await sleep(10000);
await evaluate(CLICK_HELPER);
await clickText('小柔', false);
await sleep(800);
await clickText('开始相处 ·', false);
await sleep(2000);

// 塞 4 个 1.3s 的假任务，让百分比一格一格往上爬
await evaluate(`(() => {
  for (let i = 0; i < 4; i++) {
    window.__aivaPreload.schedule({
      id: '__shot' + i, label: '自检 ' + (i + 1), priority: 0, force: true,
      run: () => new Promise((r) => setTimeout(r, 1300)),
    });
  }
  return 1;
})()`);

const shoot = async (name) => {
  const r = await evaluate(`(() => {
    const el = document.getElementById('aiva-preload-badge');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, text: (el.innerText || '').replace(/\\s+/g, '') };
  })()`);
  if (!r) { console.log('  ! ' + name + '：徽标不在'); return; }
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: r.x - 8, y: r.y - 8, width: r.w + 16, height: r.h + 16, scale: 4 },
  });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  console.log('  ' + name + '  ' + JSON.stringify(r));
};

await sleep(1500);
await shoot('badge-25.png');
await sleep(2600);
await shoot('badge-75.png');

cleanup();
console.log('done');

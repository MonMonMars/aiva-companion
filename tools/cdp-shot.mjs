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

// ★ 选元素的规则踩过一次大坑，别改回去：
//   以前是「含目标文字 + 面积最小」，结果每张角色卡 footer 上那行小字
//   <div>开始相处</div> 面积才 851，比底部 CTA（16800）小得多 ——
//   探针一直在点卡片 footer，而卡片只 setPickId 不跳转，
//   于是从截图上看就像"点了没反应、进不去 Home"，白白排查了一整轮 App 层的 bug。
//   正确做法：先框死「真的可点」的那一层（RNW 的 Pressable 一定是
//   tabindex=0 + cursor:pointer），再在里面挑面积最小的。
const CLICK = `window.__clickText = (txt, exact) => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const all = Array.from(document.querySelectorAll('*')).filter((e) => {
    if (!vis(e)) return false;
    const t = e.textContent || '';
    return exact ? t.trim() === txt : t.includes(txt);
  });
  if (!all.length) return { ok: false, n: 0 };
  const areaOf = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  const pressables = all.filter((e) => e.getAttribute('tabindex') === '0' && getComputedStyle(e).cursor === 'pointer');
  const pool = pressables.length ? pressables : all;
  const el = pool.sort((a, b) => areaOf(a) - areaOf(b))[0];
  // RNW 这条链路上 el.click() 是唯一稳定触发的写法；
  // 合成 mousedown/mouseup/click 序列在部分控件上会被 Responder 判成无效手势。
  el.click();
  const r = el.getBoundingClientRect();
  return { ok: true, pool: pressables.length ? 'pressable' : 'fallback',
    w: Math.round(r.width), h: Math.round(r.height),
    txt: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 28) };
};`;

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const b64 = r.result?.data;
  if (!b64) { console.log('no data for', name); return; }
  const p = path.join(outDir, name + '.png');
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  console.log('saved', p);
}

// ★ 每一步都留个"我真的到了这一屏"的硬证据。
//   以前只看截图，结果存下来的 4-home.png 其实是选角页 ——
//   截图本身不会告诉你它拍错了地方，只有文案/元素断言会。
const where = async () => {
  const t = String(await evaluate(`document.body.innerText || ''`));
  const inputs = Number(await evaluate(`document.querySelectorAll('input,textarea').length`));
  return { inputs, sig: t.replace(/\n+/g, ' / ').slice(0, 90) };
};
const assertAt = async (label, ok) => {
  const w = await where();
  console.log(`  ${ok(w) ? '✓' : '✗ 断言失败'} ${label}  inputs=${w.inputs}  ${w.sig}`);
};

await sleep(1200);
await evaluate(CLICK);
await shot('1-title');

await sleep(11000);
await evaluate(CLICK);
await shot('2-select-character');
await assertAt('选角页', (w) => /今天想陪在谁身边/.test(w.sig));

console.log('  点「背景」→ ' + JSON.stringify(await evaluate(`window.__clickText('背景')`)));
await sleep(1200);
await shot('3-select-background');
await assertAt('背景 tab', (w) => /舞台/.test(w.sig) && !/CUTE/.test(w.sig));

console.log('  点「开始相处」→ ' + JSON.stringify(await evaluate(`window.__clickText('开始相处')`)));
await sleep(14000);   // 首次进 Home 要解析 3D 模型，给它时间
await evaluate(CLICK);
await shot('4-home');
await assertAt('Home', (w) => w.inputs > 0 && /☰/.test(w.sig));

console.log('  点「☰」→ ' + JSON.stringify(await evaluate(`window.__clickText('☰', true)`)));
await sleep(1800);
await evaluate(CLICK);
await shot('5-menu');
await assertAt('菜单', (w) => /返回|BASE|菜单/.test(w.sig));

cleanup();
process.exit(0);

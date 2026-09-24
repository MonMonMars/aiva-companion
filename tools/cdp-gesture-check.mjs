// 手势链路的运行时验证：摸头 / 戳 / 转视角 / 缩放平移
// ---------------------------------------------------------------------------
// 这是这个 App 最核心的交互（"摸她的头 / 戳一下 / 空白处拖动转视角 / 双指缩放平移"
// —— 菜单页里就是这么介绍玩法的），但主流程断言一条都没碰到过它。
//
// 难点：戳中哪儿才算"头"，只有 3D 场景自己知道。Avatar3D.web 在 web 上挂了
// `window.__aivaDebug.hitTest(ndcX, ndcY)`，先用它扫一遍网格找到头和身子，
// 再拿真实输入去点，最后用**存档里的数值**验结果（S.pet 加亲密 + totalPets，
// S.poke 加亲密）—— 不能看气泡，气泡和出声都是随机触发的。
//
// 用法: node cdp-gesture-check.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
if (!url) { console.log('用法: node cdp-gesture-check.mjs <url>'); process.exit(1); }

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9353;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gest-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
  url,
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { console.log('无法连接 Chrome'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails || {};
    exceptions.push(d.text + ' ' + (d.exception?.description || d.exception?.value || ''));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

// 存档：人选定好 + 精力给足（精力不足时摸头会被拒）
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      var KEY = 'aiva.companion.v1';
      if (!localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, JSON.stringify({
          personaId: 'girlfriend',
          relations: { girlfriend: { affection: 10, mood: 80, energy: 95,
            createdAt: Date.now() - 2 * 86400000, totalPets: 0, totalChats: 0 } },
          coins: 100, giftCount: {}, memory: [], chatHistory: {},
          lastSeenAt: Date.now(),
          config: { spokenLang: 'zh-HK', langMigratedToYue: true, bgId: 'night' },
        }));
      }
    } catch (e) {}
  `,
});

await send('Emulation.setDeviceMetricsOverride', {
  width: 414, height: 896, deviceScaleFactor: 2, mobile: true,
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

console.log('>>> 打开：' + url);
await send('Page.navigate', { url });

// 等到 3D 场景把 __aivaDebug 挂上来（模型解析 + WebGL 初始化要时间）
let ready = false;
for (let i = 0; i < 120; i++) {
  const has = await evaluate(`!!(window.__aivaDebug && window.__aivaDebug.hitTest)`);
  if (has) { ready = true; break; }
  await sleep(500);
}
if (!ready) {
  console.log('!!! 3D 场景没起来（__aivaDebug 未挂载），手势无从测起。');
  console.log('    画面:', JSON.stringify(await evaluate(`(document.body.innerText||'').slice(0,200)`)));
  cleanup();
  process.exit(1);
}
console.log('3D 场景就绪');

// 让模型/预热跑完，免得卡顿影响手势
await sleep(10000);

const rel = () => evaluate(`(() => {
  const raw = localStorage.getItem('aiva.companion.v1');
  const s = raw ? JSON.parse(raw) : {};
  const r = (s.relations || {}).girlfriend || {};
  return { affection: r.affection, totalPets: r.totalPets, energy: r.energy };
})()`);

const stage = await evaluate(`(() => {
  const cv = document.querySelector('canvas');
  if (!cv) return null;
  const r = cv.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
})()`);
if (!stage) { console.log('!!! 找不到 canvas'); cleanup(); process.exit(1); }
console.log('舞台:', JSON.stringify(stage));

// NDC → 屏幕坐标：ndcX = (locX/w)*2-1，ndcY = -((locY/h)*2-1)
const toScreen = (nx, ny) => ({
  x: stage.left + ((nx + 1) / 2) * stage.w,
  y: stage.top + ((1 - ny) / 2) * stage.h,
});

// 扫网格找头和身子
const probe = await evaluate(`(() => {
  const out = { head: null, body: null, miss: null };
  for (let iy = 0; iy <= 16; iy++) {
    for (let ix = 0; ix <= 12; ix++) {
      const nx = -0.9 + (1.8 * ix) / 12;
      const ny = -0.9 + (1.8 * iy) / 16;
      const h = window.__aivaDebug.hitTest(nx, ny);
      if (!h) { if (!out.miss) out.miss = { nx, ny }; continue; }
      if (h.part === 'head' && !out.head) out.head = { nx, ny };
      if (h.part === 'body' && !out.body) out.body = { nx, ny };
    }
  }
  return out;
})()`);
console.log('命中探测:', JSON.stringify(probe));

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
};

async function tap(pt) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
}

// ---- 1. 摸头 ---------------------------------------------------------------
if (probe.head) {
  const before = await rel();
  await tap(toScreen(probe.head.nx, probe.head.ny));
  await sleep(1500);
  const after = await rel();
  const ok = (after.totalPets || 0) === (before.totalPets || 0) + 1
    && after.affection > before.affection;
  record('① 摸头：亲密 + 抚摸次数 +1', ok,
    `totalPets ${before.totalPets}→${after.totalPets}, 亲密 ${before.affection}→${after.affection}`);
} else {
  record('① 摸头', false, '没探到头');
}

// ---- 2. 戳身子 -------------------------------------------------------------
if (probe.body) {
  const before = await rel();
  await tap(toScreen(probe.body.nx, probe.body.ny));
  await sleep(1500);
  const after = await rel();
  const ok = after.affection > before.affection;
  record('② 戳身子：亲密也加（走的是 poke 分支）', ok,
    `亲密 ${before.affection}→${after.affection}`);
} else {
  record('② 戳身子', false, '没探到身子');
}

// ---- 3. 空白处拖动 = 转视角 -------------------------------------------------
if (probe.miss) {
  const p0 = toScreen(probe.miss.nx, probe.miss.ny);
  const cam0 = await evaluate(`window.__aivaDebug.cameraPos()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p0.x + i * 12, y: p0.y + i * 3, button: 'left', buttons: 1,
    });
    await sleep(60);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p0.x + 96, y: p0.y + 24, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(800);
  const cam1 = await evaluate(`window.__aivaDebug.cameraPos()`);
  const moved = await evaluate(`window.__aivaDebug.cameraMoved()`);
  const d = Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]);
  record('③ 空白处拖动 = 转视角', d > 0.01 && moved === true,
    `相机位移 ${d.toFixed(3)}, cameraMoved=${moved}`);

  // ---- 4. 回正视角 ---------------------------------------------------------
  await evaluate(`window.__aivaDebug.resetCamera()`);
  await sleep(600);
  const movedAfterReset = await evaluate(`window.__aivaDebug.cameraMoved()`);
  record('④ 「回正视角」能把相机拉回原位', movedAfterReset === false,
    `cameraMoved=${movedAfterReset}`);
} else {
  record('③ 转视角', false, '没找到空白处');
  record('④ 回正视角', false, '跳过');
}

// ---- 5. 双指缩放 -----------------------------------------------------------
// 用真实 touch 事件（鼠标表达不了两指）。RNW 的 responder 认 touchstart/move/end。
const cx = stage.left + stage.w / 2;
const cy = stage.top + stage.h / 2;
const camA = await evaluate(`window.__aivaDebug.cameraPos()`);
const distA = Math.hypot(camA[0], camA[1], camA[2]);

const touch = (type, pts) => send('Input.dispatchTouchEvent', {
  type,
  touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })),
});
await touch('touchStart', [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }]);
for (let i = 1; i <= 6; i++) {
  await touch('touchMove', [{ x: cx - 40 - i * 14, y: cy }, { x: cx + 40 + i * 14, y: cy }]);
  await sleep(70);
}
await touch('touchEnd', []);
await sleep(800);
const camB = await evaluate(`window.__aivaDebug.cameraPos()`);
const distB = Math.hypot(camB[0], camB[1], camB[2]);
const pinchOk = Math.abs(distB - distA) > 0.01;
record('⑤ 双指捏合 = 缩放', pinchOk,
  `相机到原点距离 ${distA.toFixed(3)} → ${distB.toFixed(3)}` +
  (pinchOk ? '' : '（若失败：可能 RNW 未把多点 touch 交给 responder，改用 __aivaDebug.zoom 复核）'));

if (!pinchOk) {
  // 退一步：直接调 zoomBy，至少证明缩放这条链路本身没坏（不是 NaN / 不崩）
  await evaluate(`window.__aivaDebug.zoom(1.4)`);
  await sleep(600);
  const camC = await evaluate(`window.__aivaDebug.cameraPos()`);
  const okC = Number.isFinite(camC[0]) && Number.isFinite(camC[2])
    && Math.abs(Math.hypot(camC[0], camC[1], camC[2]) - distA) > 0.01;
  record('⑤b 直接调 zoomBy：缩放链路本身没坏', okC, `相机 ${JSON.stringify(camC)}`);
}

// ---- 6. 全程不许炸 ---------------------------------------------------------
record('⑥ 全程无异常', exceptions.length === 0 && consoleErrors.length === 0,
  `exception=${exceptions.length}, console.error=${consoleErrors.length}`);
exceptions.slice(0, 6).forEach((e) => console.log('    [EXCEPTION]', e.slice(0, 240)));
consoleErrors.slice(0, 6).forEach((e) => console.log('    [console.error]', e.slice(0, 240)));

const bad = results.filter((r) => !r.ok).length;
console.log('\n' + (bad === 0 ? '手势链路全部通过' : '有问题：' + bad + ' 项'));
cleanup();
process.exit(bad === 0 ? 0 : 1);

// 重叠 / 遮挡审计
// ---------------------------------------------------------------------------
// "按钮和文字互相压住" 这类问题看截图很难判（透明叠透明），但几何上非常确定：
// 两个不相干的文本矩形只要有交集，就是字压字；某个控件中心点 elementFromPoint
// 拿不到它自己，就是被别的东西盖住了。
//
// 两条必须有的过滤，少了就全是噪音：
//   a) **只审当前屏**。Home 一直是挂在底下的（浮层盖住但不卸载），
//      直接全量扫会把「菜单压住 Home 顶栏」这种正常事报成 bug。
//      实测结构：#root 的直接子元素就是一层层「屏」，最后那个铺满视口的
//      就是当前屏（Home 单层 / 菜单打开时 [Home, Overlay]）。
//   b) **跳过 pointer-events:none 的元素**。Home 的「她说的话」和最近几轮
//      对话是刻意盖在 3D 舞台上的（要让转视角手势穿过去），命中测试必然
//      返回底下的舞台 —— 那是设计，不是遮挡。
//
// 用法: node cdp-overlap.mjs <url> [宽度] [高度]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const VW = Number(process.argv[3] || 390);
const VH = Number(process.argv[4] || 844);

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.OVL_PORT || 9377);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--mute-audio', url,
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails || {};
    exceptions.push(d.text + ' ' + (d.exception?.description || d.exception?.value || ''));
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

const SEED = `
  try {
    var KEY = 'aiva.companion.v1';
    localStorage.setItem(KEY, JSON.stringify({
      personaId: 'girlfriend',
      relations: { girlfriend: { affection: 42, mood: 70, energy: 80 } },
      coins: 128, giftCount: { flower: 3 },
      memory: [{ ts: 1, text: '喜欢喝美式，不加糖' }, { ts: 2, text: '怕打雷，打雷的时候想有人陪着说话' }],
      chatHistory: { girlfriend: [
        { role: 'user',      content: '今天过得怎么样呀', ts: 1 },
        { role: 'assistant', content: '几好呀，不过挂住你啰。你呢，返工累唔累？', ts: 2 },
        { role: 'user',      content: '有点累，想听你讲两句', ts: 3 },
        { role: 'assistant', content: '咁你依家闭上眼，听我讲：你已经做得好好㗎啦，唔使次次都做到满分。', ts: 4 },
        { role: 'user',      content: '你真好', ts: 5 },
        { role: 'assistant', content: '系因为你先令我变好㗎嘛。', ts: 6 },
      ] },
      lastSeenAt: Date.now(), lastCheckInDay: null,
      config: { spokenLang: 'zh-HK', langMigratedToYue: true, bgId: 'auto' },
    }));
  } catch (e) {}
`;
// OVL_FRESH=1 → 不种存档，走「全新用户」路径：启动页 → 首次选人页。
// 这两屏平时审不到（有存档时 App 直接跳到主页），而它们的排版跟换人浮层
// 不一样：没有返回键、CTA 写的是「开始相处 · XX」、标题也更长。
const FRESH = process.env.OVL_FRESH === '1';
if (!FRESH) await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });

await send('Emulation.setDeviceMetricsOverride', {
  width: VW, height: VH, deviceScaleFactor: 2, mobile: true,
});
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

console.log('>>> ' + url + '  @ ' + VW + 'x' + VH);
await send('Page.navigate', { url });

// ---- 审计脚本 --------------------------------------------------------------
const AUDIT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const host = document.getElementById('root') || document.body;

  // ① 当前屏 = #root 直接子元素里、铺满视口的最后一个
  const layers = Array.from(host.children).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= vw * 0.9 && r.height >= vh * 0.85;
  });
  const scope = layers.length ? layers[layers.length - 1] : host;

  const all = Array.from(scope.querySelectorAll('*'));
  const ownText = (el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const R = (el) => { const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const cut = (a, b) => {
    const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
    const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return (w > 3 && h > 3) ? { w, h } : null;
  };
  const kin = (a, b) => a.contains(b) || b.contains(a);
  const label = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 20);

  // 滚动裁剪：ScrollView 里滚出可视区的那一截，矩形还在但根本没画出来。
  // ⚠️ 必须把矩形**真的裁掉**再比，只判断中心点在不在可视框里不够 ——
  //    角色选择页最后一张卡片中心还在可视区内、下缘已经伸进底部 CTA 那一条，
  //    会被误报成「卡片压住 CTA」（实测 5 处假阳性），而它其实被滚动容器裁掉了。
  const clips = (cs) => /(auto|scroll|hidden)/.test(cs.overflow)
    || /(auto|scroll|hidden)/.test(cs.overflowX)
    || /(auto|scroll|hidden)/.test(cs.overflowY);
  const clipRect = (el) => {
    let r = R(el);
    let p = el.parentElement;
    while (p && p !== host) {
      if (clips(getComputedStyle(p))) {
        const pr = R(p);
        r = { l: Math.max(r.l, pr.l), t: Math.max(r.t, pr.t),
              r: Math.min(r.r, pr.r), b: Math.min(r.b, pr.b) };
        r.w = r.r - r.l; r.h = r.b - r.t;
      }
      p = p.parentElement;
    }
    return r;
  };
  const painted = (el) => { const r = clipRect(el); return r.w > 0.5 && r.h > 0.5; };

  // 文本原子：自己带文字、且后代里没有别的带文字元素（嵌套 Text 是包含关系，不算重叠）
  const texts = all.filter((el) => vis(el) && ownText(el) && painted(el)
    && !Array.from(el.querySelectorAll('*')).some((c) => ownText(c)));

  const ov = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const A = texts[i], B = texts[j];
      if (kin(A, B)) continue;
      const o = cut(clipRect(A), clipRect(B));
      if (!o) continue;
      const ra = R(A), rb = R(B);
      ov.push({ a: label(A), b: label(B),
        ra: [Math.round(ra.l), Math.round(ra.t), Math.round(ra.w), Math.round(ra.h)],
        rb: [Math.round(rb.l), Math.round(rb.t), Math.round(rb.w), Math.round(rb.h)],
        o: [Math.round(o.w), Math.round(o.h)] });
    }
  }

  // 命中测试。⚠️ 跳过 pointer-events:none —— 那类元素本来就故意让点击穿过去
  // （Home 的对话浮层），elementFromPoint 必然返回底下的舞台，不是遮挡。
  //
  // ⚠️ 取点必须用**裁剪后**的矩形中心，不能用原始矩形中心：
  //    角色选择页背景 tab 里，最后一行色卡的原始矩形下缘已经伸进滚动容器外
  //    （真实可见只剩 6px），原始中心 y=765 落在滚动容器下方的 CTA 条上，
  //    于是被报成「CTA 盖住色卡」（实测 2 处假阳性）—— 其实它只是滚到一半。
  const blocked = [];
  texts.forEach((el) => {
    if (getComputedStyle(el).pointerEvents === 'none') return;
    const r = clipRect(el);
    if (r.w < 2 || r.h < 2) return;
    const x = r.l + r.w / 2, y = r.t + r.h / 2;
    if (x < 0 || y < 0 || x > vw || y > vh) return;
    const top = document.elementFromPoint(x, y);
    if (!top) return;
    if (top === el || el.contains(top) || top.contains(el)) return;
    blocked.push({ text: label(el),
      by: top.tagName + '.' + String(top.className || '').slice(0, 24),
      byText: label(top) });
  });

  // 控件：role=button / 原生控件 / 可聚焦
  const ctrls = all.filter((el) => {
    if (!vis(el) || !painted(el)) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA') return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    const ti = el.getAttribute && el.getAttribute('tabindex');
    return ti !== null && ti !== '-1';
  });
  const cOv = [];
  for (let i = 0; i < ctrls.length; i++) {
    for (let j = i + 1; j < ctrls.length; j++) {
      const A = ctrls[i], B = ctrls[j];
      if (kin(A, B)) continue;
      if (!cut(clipRect(A), clipRect(B))) continue;
      const ra = R(A), rb = R(B);
      cOv.push({ a: label(A) || A.tagName, b: label(B) || B.tagName,
        ra: [Math.round(ra.l), Math.round(ra.t), Math.round(ra.w), Math.round(ra.h)],
        rb: [Math.round(rb.l), Math.round(rb.t), Math.round(rb.w), Math.round(rb.h)] });
    }
  }

  // 出界。在滚动容器里的内容本来就在屏幕外 —— 竖向滚动放过 y，横向滚动放过 x。
  // ⚠️ 两个方向要分开判：语音设置页的胶囊选择器是横向 ScrollView，
  //    只判竖向会把它右边那些「滑一下就能看到」的标签报成出界（实测 2 处假阳性）。
  const outside = [];
  texts.forEach((el) => {
    const r = R(el);
    let scrollY = false, scrollX = false, p = el.parentElement;
    while (p && p !== host) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) scrollY = true;
      if (/(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflow)) scrollX = true;
      p = p.parentElement;
    }
    if (!scrollX && (r.r > vw + 1 || r.l < -1)) {
      outside.push({ t: label(el), axis: 'x', l: Math.round(r.l), r: Math.round(r.r), vw });
    }
    if (!scrollY && (r.b > vh + 1 || r.t < -1)) {
      outside.push({ t: label(el), axis: 'y', top: Math.round(r.t), b: Math.round(r.b), vh });
    }
  });

  return {
    vw, vh, texts: texts.length, ctrls: ctrls.length,
    layers: layers.length,
    scope: String(scope.className || '').slice(0, 40),
    ov, blocked, cOv, outside,
    pageScroll: document.documentElement.scrollHeight - vh,
  };
})()`;

const report = [];
async function audit(name) {
  const a = await evaluate(AUDIT);
  const bad = a.ov.length + a.blocked.length + a.cOv.length + a.outside.length;
  report.push({ name, ...a, bad });
  console.log('\n── ' + name + ' ──  文本 ' + a.texts + ' · 控件 ' + a.ctrls
    + ' · 层 ' + a.layers + ' · 页面可滚 ' + a.pageScroll + 'px');
  if (!bad) { console.log('   ✅ 无重叠、无遮挡、无出界'); return a; }
  a.ov.slice(0, 12).forEach((x) => console.log('   ❌ 字压字: "' + x.a + '" [' + x.ra + ']  ×  "' + x.b + '" [' + x.rb + ']  交集 ' + x.o));
  if (a.ov.length > 12) console.log('   … 另有 ' + (a.ov.length - 12) + ' 组字压字');
  a.blocked.slice(0, 12).forEach((x) => console.log('   ❌ 被盖住: "' + x.text + '" ← 顶层是 ' + x.by + ' ("' + x.byText + '")'));
  if (a.blocked.length > 12) console.log('   … 另有 ' + (a.blocked.length - 12) + ' 处遮挡');
  a.cOv.slice(0, 12).forEach((x) => console.log('   ❌ 控件互压: "' + x.a + '" [' + x.ra + ']  ×  "' + x.b + '" [' + x.rb + ']'));
  a.outside.slice(0, 12).forEach((x) => console.log('   ❌ 出界(' + x.axis + '): "' + x.t + '" '
    + (x.axis === 'x' ? (x.l + '→' + x.r + ' / 视口 ' + x.vw) : (x.top + '→' + x.b + ' / 视口 ' + x.vh))));
  return a;
}

const CLICK_HELPER = `
  window.__rectFor = (txt, exact) => {
    const host = document.getElementById('root') || document.body;
    const layers = Array.from(host.children).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.85;
    });
    const scope = layers.length ? layers[layers.length - 1] : host;
    const hits = Array.from(scope.querySelectorAll('*')).filter((e) => {
      const r = e.getBoundingClientRect();
      const s = e.textContent || '';
      return (exact ? s.trim() === txt : s.includes(txt)) && r.width > 0 && r.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    })[0];
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: (el.textContent || '').slice(0, 24) };
  };
  window.__text = () => document.body.innerText || '';
`;

async function clickText(txt, exact = false) {
  await evaluate(CLICK_HELPER);
  const r = await evaluate(`window.__rectFor(${JSON.stringify(txt)}, ${!!exact})`);
  if (!r) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: r.x, y: r.y, button: 'left', clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  return true;
}
const changed = async (s) => (await evaluate(`window.__text().includes(${JSON.stringify(s)})`));

const waitFor = async (expr, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true;
    await sleep(400);
  }
  return false;
};

if (FRESH) {
  // ---- 全新用户路径：启动页 → 首次选人 -----------------------------------
  await evaluate(CLICK_HELPER);
  const titleUp = await waitFor(`window.__text().includes('AI COMPANION')`, 100);
  if (!titleUp) { console.log('启动页没起来'); cleanup(); process.exit(1); }
  await sleep(1200);
  await audit('启动页（载入中 / 可进入）');

  const selUp = await waitFor(`window.__text().includes('今天想陪在谁身边')`, 100);
  if (!selUp) { console.log('首次选人页没起来'); cleanup(); process.exit(1); }
  await sleep(1500);
  await audit('首次选人 · 角色 tab');
  await clickText('背景', false); await sleep(1300);
  await audit('首次选人 · 背景 tab');

  console.log('\n=== 汇总 ===');
  report.forEach((r) => console.log((r.bad === 0 ? 'PASS ' : 'FAIL ') + r.name
    + '  (字压字 ' + r.ov.length + ' / 遮挡 ' + r.blocked.length
    + ' / 控件互压 ' + r.cOv.length + ' / 出界 ' + r.outside.length + ')'));
  console.log('异常数: ' + exceptions.length);
  exceptions.slice(0, 5).forEach((e) => console.log('  [EX] ' + e.slice(0, 160)));
  console.log('总计问题: ' + report.reduce((n, r) => n + r.bad, 0));
  cleanup();
  process.exit(0);
}

// 等主页出现
let homeUp = false;
for (let i = 0; i < 150; i++) {
  const ok = await evaluate(`(() => {
    const i = Array.from(document.querySelectorAll('input'))
      .find((e) => (e.placeholder || '').includes('跟她说'));
    return !!(i && i.getBoundingClientRect().width > 0);
  })()`);
  if (ok) { homeUp = true; break; }
  await sleep(400);
}
if (!homeUp) { console.log('主页没起来'); cleanup(); process.exit(1); }
await sleep(9000);

// ---- 逐屏审计 --------------------------------------------------------------
await audit('主页 · 刚进（有历史对话）');
await sleep(2500);
await audit('主页 · 模型就绪');

await clickText('☰', true); await sleep(1500);
await audit('菜单 · 主列表');

await clickText('送礼物', false); await sleep(1100);
await audit('菜单 · 送礼');
await clickText('‹ 返回', false); await sleep(1000);

await clickText('她的记忆', false); await sleep(1100);
await audit('菜单 · 记忆');
await clickText('‹ 返回', false); await sleep(1000);

await clickText('账号 · 云同步', false); await sleep(1500);
await audit('菜单 · 账号');
await clickText('‹ 返回', false); await sleep(1000);

await clickText('‹ 关闭', false); await sleep(1400);
await audit('主页 · 关掉菜单后');

await clickText('☰', true); await sleep(1300);
await clickText('语音设置', false); await sleep(1600);
await audit('语音设置页');
const vb = await clickText('‹ 返回', false);
await sleep(1200);
if (!vb) await clickText('‹', true);
await sleep(1200);

await clickText('☰', true); await sleep(1300);
await clickText('设置', false); await sleep(1600);
await audit('设置页');
await clickText('‹', true); await sleep(1400);
await audit('主页 · 从设置返回');

await clickText('☰', true); await sleep(1300);
await clickText('换角色', false); await sleep(1800);
await audit('角色选择 · 换人浮层');
await clickText('背景', false); await sleep(1300);
await audit('角色选择 · 背景 tab');
await clickText('‹ 返回', false); await sleep(1400);

await clickText('☰', true); await sleep(1300);
await clickText('聊天记录', false); await sleep(1800);
await audit('聊天记录页');
await clickText('‹', true); await sleep(1400);

console.log('\n=== 汇总 ===');
report.forEach((r) => console.log((r.bad === 0 ? 'PASS ' : 'FAIL ') + r.name
  + '  (字压字 ' + r.ov.length + ' / 遮挡 ' + r.blocked.length
  + ' / 控件互压 ' + r.cOv.length + ' / 出界 ' + r.outside.length + ')'));
console.log('异常数: ' + exceptions.length);
exceptions.slice(0, 5).forEach((e) => console.log('  [EX] ' + e.slice(0, 160)));
const total = report.reduce((n, r) => n + r.bad, 0);
console.log('总计问题: ' + total);
cleanup();
process.exit(0);

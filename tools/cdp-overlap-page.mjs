// 单页重叠审计：给 /admin.html 这类「不是 RN 屏」的页面用
// ---------------------------------------------------------------------------
// cdp-overlap.mjs 依赖 #root 分层和点按钮走流程，管不到独立页面。
// 这个脚本不做任何点击，打开就量：字压字 / 被盖住 / 控件互压 / 出界。
//
// 用法: node cdp-overlap-page.mjs <url> [宽] [高] [等待毫秒]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/admin.html';
const VW = Number(process.argv[3] || 1280);
const VH = Number(process.argv[4] || 900);
const WAIT = Number(process.argv[5] || 4000);

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.OVL_PORT || 9388);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ovlpg-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
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
    const l = await r.json();
    const p = (l || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { console.log('无法连接 Chrome'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(WAIT);

// 与 cdp-overlap.mjs 同一套判据，只是 scope 固定成整个文档
const AUDIT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const scope = document.body;
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
  const label = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  const clips = (cs) => /(auto|scroll|hidden)/.test(cs.overflow)
    || /(auto|scroll|hidden)/.test(cs.overflowX) || /(auto|scroll|hidden)/.test(cs.overflowY);
  const clipRect = (el) => {
    let r = R(el); let p = el.parentElement;
    while (p) {
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
    blocked.push({ text: label(el), by: top.tagName + '.' + String(top.className || '').slice(0, 24), byText: label(top) });
  });

  const ctrls = all.filter((el) => {
    if (!vis(el) || !painted(el)) return false;
    if (['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
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

  const outside = [];
  texts.forEach((el) => {
    const r = R(el);
    let scrollY = false, scrollX = false, p = el.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) scrollY = true;
      if (/(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflow)) scrollX = true;
      p = p.parentElement;
    }
    if (!scrollX && (r.r > vw + 1 || r.l < -1)) outside.push({ t: label(el), axis: 'x', l: Math.round(r.l), r: Math.round(r.r), vw });
    if (!scrollY && (r.b > vh + 1 || r.t < -1)) outside.push({ t: label(el), axis: 'y', top: Math.round(r.t), b: Math.round(r.b), vh });
  });

  return { vw, vh, texts: texts.length, ctrls: ctrls.length, ov, blocked, cOv, outside };
})()`;

const a = await evaluate(AUDIT);
console.log('>>> ' + url + '  @ ' + VW + 'x' + VH + '   文本 ' + a.texts + ' · 控件 ' + a.ctrls);
if (!a) { console.log('审计没跑起来'); cleanup(); process.exit(1); }
const bad = a.ov.length + a.blocked.length + a.cOv.length + a.outside.length;
if (!bad) console.log('   ✅ 无重叠、无遮挡、无出界');
a.ov.slice(0, 15).forEach((x) => console.log('   ❌ 字压字: "' + x.a + '" [' + x.ra + '] × "' + x.b + '" [' + x.rb + '] 交集 ' + x.o));
a.blocked.slice(0, 15).forEach((x) => console.log('   ❌ 被盖住: "' + x.text + '" ← ' + x.by + ' ("' + x.byText + '")'));
a.cOv.slice(0, 15).forEach((x) => console.log('   ❌ 控件互压: "' + x.a + '" [' + x.ra + '] × "' + x.b + '" [' + x.rb + ']'));
a.outside.slice(0, 15).forEach((x) => console.log('   ❌ 出界(' + x.axis + '): "' + x.t + '" '
  + (x.axis === 'x' ? (x.l + '→' + x.r + ' / ' + x.vw) : (x.top + '→' + x.b + ' / ' + x.vh))));
console.log('总计问题: ' + bad);
cleanup();
process.exit(0);

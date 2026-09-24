// 一次性探针：把 DOM 骨架和命中栈打出来，用于定位"到底是谁盖住了谁"
// 用法: node cdp-probe.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9381;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prb-'));
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
if (!wsUrl) { console.log('no chrome'); cleanup(); process.exit(1); }

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
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try { var K='aiva.companion.v1'; if(!localStorage.getItem(K)) localStorage.setItem(K, JSON.stringify({
      personaId:'girlfriend', relations:{girlfriend:{affection:42,mood:70,energy:80}}, coins:128, giftCount:{},
      memory:[], chatHistory:{girlfriend:[
        {role:'user',content:'今天过得怎么样呀',ts:1},
        {role:'assistant',content:'几好呀，不过挂住你啰。',ts:2},
        {role:'user',content:'有点累',ts:3},
        {role:'assistant',content:'咁你依家闭上眼，听我讲：你已经做得好好㗎啦。',ts:4}]},
      lastSeenAt: Date.now(), lastCheckInDay: null,
      config:{ spokenLang:'zh-HK', bgId:'auto' } })); } catch(e) {}
  `,
});
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });

for (let i = 0; i < 150; i++) {
  const ok = await evaluate(`Array.from(document.querySelectorAll('input')).some((e)=>(e.placeholder||'').includes('跟她说'))`);
  if (ok) break;
  await sleep(400);
}
await sleep(9000);

const skel = await evaluate(`(() => {
  const out = [];
  const walk = (el, d) => {
    if (d > 3) return;
    const r = el.getBoundingClientRect();
    out.push('  '.repeat(d) + el.tagName + (el.id ? '#' + el.id : '') +
      ' .' + String(el.className || '').slice(0, 60) +
      ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' +
      ' kids=' + el.children.length);
    Array.from(el.children).slice(0, 8).forEach((c) => walk(c, d + 1));
  };
  walk(document.body, 0);
  return out.join('\\n');
})()`);
console.log('=== DOM 骨架 ===');
console.log(skel);

// 打开菜单再看一次骨架：要确认「浮层到底挂在第几层」，才能把审计限定在当前屏
const clickText = async (txt, exact = false) => {
  const r = await evaluate(`(() => {
    const hits = Array.from(document.querySelectorAll('*')).filter((e) => {
      const rr = e.getBoundingClientRect(); const s = e.textContent || '';
      return (${!!exact} ? s.trim() === ${JSON.stringify(txt)} : s.includes(${JSON.stringify(txt)})) && rr.width > 0 && rr.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    })[0];
    const rr = el.getBoundingClientRect();
    return { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 };
  })()`);
  if (!r) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  return true;
};

await clickText('☰', true);
await sleep(1600);
console.log('\n=== DOM 骨架（菜单打开） ===');
console.log(await evaluate(`(() => {
  const out = [];
  const walk = (el, d) => {
    if (d > 2) return;
    const r = el.getBoundingClientRect();
    out.push('  '.repeat(d) + el.tagName + (el.id ? '#' + el.id : '') +
      ' .' + String(el.className || '').slice(0, 70) +
      ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' +
      ' kids=' + el.children.length);
    Array.from(el.children).slice(0, 10).forEach((c) => walk(c, d + 1));
  };
  walk(document.body, 0);
  return out.join('\\n');
})()`));

const stack = await evaluate(`(() => {
  const ownText = (el) => Array.from(el.childNodes).filter((n)=>n.nodeType===3).map((n)=>n.textContent).join('').trim();
  const texts = Array.from(document.querySelectorAll('body *')).filter((el)=>{
    const r = el.getBoundingClientRect();
    return ownText(el) && r.width>0 && r.height>0
      && !Array.from(el.querySelectorAll('*')).some((c)=>ownText(c));
  });
  const lines = [];
  texts.forEach((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width/2, y = r.top + r.height/2;
    const st = document.elementsFromPoint(x, y).slice(0, 4).map((e) => {
      const cs = getComputedStyle(e);
      const rr = e.getBoundingClientRect();
      return e.tagName + '.' + String(e.className||'').slice(0,34) +
        ' pe=' + cs.pointerEvents + ' pos=' + cs.position + ' z=' + cs.zIndex +
        ' [' + Math.round(rr.left)+','+Math.round(rr.top)+' '+Math.round(rr.width)+'x'+Math.round(rr.height) + ']';
    });
    lines.push('【' + ownText(el).slice(0,14) + '】@' + Math.round(x) + ',' + Math.round(y));
    st.forEach((s, i) => lines.push('    ' + i + ') ' + s));
  });
  return lines.join('\\n');
})()`);
console.log('\n=== 命中栈 ===');
console.log(stack);

cleanup();
process.exit(0);

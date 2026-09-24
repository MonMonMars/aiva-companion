// 探针：把「儿童模式开关」和「换角色卡片」在 DOM 里到底长什么样打出来
// ---------------------------------------------------------------------------
// 起因：功能巡检里这两项点不动，先分清是「我没点中」还是「点了没反应」。
//
// 用法: node cdp-probe-ctrl.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.PRB_PORT || 9430);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prb-ctrl-'));
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
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  }
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
    try { localStorage.setItem('aiva.companion.v1', JSON.stringify({
      personaId:'girlfriend', relations:{girlfriend:{affection:42,mood:70,energy:80}},
      coins:500, giftCount:{}, totalPets:0, totalChats:0, memory:[],
      chatHistory:{girlfriend:[]}, lastSeenAt: Date.now(), lastCheckInDay: null,
      config:{ spokenLang:'zh-HK', bgId:'auto', kidMode:false } })); } catch(e) {}
  `,
});
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });

const HELPERS = `
  window.__scope = () => {
    const host = document.getElementById('root') || document.body;
    const layers = Array.from(host.children).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= innerWidth*0.9 && r.height >= innerHeight*0.85;
    });
    return layers.length ? layers[layers.length-1] : host;
  };
  window.__text = () => document.body.innerText || '';
  window.__rectFor = (txt, exact) => {
    const hits = Array.from(window.__scope().querySelectorAll('*')).filter((e) => {
      const r = e.getBoundingClientRect(); const s = e.textContent || '';
      return (exact ? s.trim() === txt : s.includes(txt)) && r.width > 0 && r.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a,b) => {
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (ra.width*ra.height)-(rb.width*rb.height);
    })[0];
    const r = el.getBoundingClientRect();
    return { x: r.left+r.width/2, y: r.top+r.height/2, txt:(el.textContent||'').slice(0,30) };
  };
`;
async function clickText(t, exact = false) {
  await evaluate(HELPERS);
  const r = await evaluate(`window.__rectFor(${JSON.stringify(t)}, ${!!exact})`);
  if (!r) { console.log('   (点不到 ' + t + ')'); return false; }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  console.log('   点了 ' + t + ' → "' + r.txt + '" @' + Math.round(r.x) + ',' + Math.round(r.y));
  return true;
}

for (let i = 0; i < 150; i++) {
  if (await evaluate(`Array.from(document.querySelectorAll('input')).some((e)=>(e.placeholder||'').includes('跟她说'))`)) break;
  await sleep(400);
}
await sleep(8000);

// ---------- 儿童模式开关 ----------
console.log('=== 语音设置页：开关长什么样 ===');
await clickText('☰', true); await sleep(1400);
await clickText('语音设置', false); await sleep(1800);

console.log(await evaluate(`(() => {
  const out = [];
  const scope = window.__scope();
  const box = (e) => { const r = e.getBoundingClientRect();
    return '[' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']'; };
  const all = Array.from(scope.querySelectorAll('*'));
  out.push('带 role 的元素:');
  all.filter((e) => e.getAttribute && e.getAttribute('role')).forEach((e) => {
    const cs = getComputedStyle(e);
    out.push('  role=' + e.getAttribute('role') + ' aria-checked=' + e.getAttribute('aria-checked')
      + ' tabindex=' + e.getAttribute('tabindex') + ' ' + e.tagName
      + ' ' + box(e) + ' pe=' + cs.pointerEvents + ' 「' + (e.textContent||'').trim().slice(0,18) + '」');
  });
  out.push('input 元素:');
  all.filter((e) => e.tagName === 'INPUT').forEach((e) => {
    out.push('  type=' + e.type + ' ' + box(e) + ' 「' + (e.textContent||'').slice(0,10) + '」');
  });
  out.push('含「儿童」的元素:');
  all.filter((e) => (e.textContent||'').includes('儿童')).slice(0, 8).forEach((e) => {
    const cs = getComputedStyle(e);
    out.push('  ' + e.tagName + ' .' + String(e.className||'').slice(0,20) + ' ' + box(e)
      + ' pe=' + cs.pointerEvents + ' 「' + (e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,26) + '」');
  });
  return out.join('\\n');
})()`));

// 真的点一下开关，看 store 变没变
const sw = await evaluate(`(() => {
  const scope = window.__scope();
  const cands = Array.from(scope.querySelectorAll('*')).filter((e) => {
    const r = e.getBoundingClientRect();
    const role = e.getAttribute && e.getAttribute('role');
    return (role === 'switch' || e.tagName === 'INPUT' && e.type === 'checkbox') && r.width > 0;
  });
  if (!cands.length) return null;
  const e = cands[0]; const r = e.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2, role: e.getAttribute('role'), type: e.type };
})()`);
console.log('开关候选: ' + JSON.stringify(sw));
if (sw) {
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type: t, x: sw.x, y: sw.y, button: 'left', clickCount: 1, buttons: t === 'mouseReleased' ? 0 : 1 });
  }
  await sleep(1200);
}
console.log('点完 kidMode = ' + await evaluate(`JSON.parse(localStorage.getItem('aiva.companion.v1')).config.kidMode`));

// ---------- 换角色卡片 ----------
console.log('\\n=== 角色选择页：卡片 / CTA 长什么样 ===');
await clickText('‹ 返回', false); await sleep(1400);
await clickText('☰', true); await sleep(1400);
await clickText('换角色', false); await sleep(2000);

console.log(await evaluate(`(() => {
  const out = [];
  const scope = window.__scope();
  const box = (e) => { const r = e.getBoundingClientRect();
    return '[' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']'; };
  const all = Array.from(scope.querySelectorAll('*'));
  out.push('含「开始相处」/「继续这段关系」的元素（卡片脚）:');
  all.filter((e) => /开始相处|继续这段关系/.test(e.textContent || '')).slice(0, 14).forEach((e) => {
    out.push('  ' + e.tagName + ' ' + box(e) + ' 「' + (e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,24) + '」');
  });
  out.push('整个卡片（Pressable，含 emoji + 名字）:');
  const cards = all.filter((e) => {
    const t = (e.textContent||'');
    return /开始相处|继续这段关系/.test(t) && e.getBoundingClientRect().height > 80;
  });
  cards.slice(0, 12).forEach((e) => {
    out.push('  ' + box(e) + ' 「' + (e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,30) + '」');
  });
  out.push('CTA（含「换成」/「开始相处 ·」）:');
  all.filter((e) => /换成|开始相处 ·/.test(e.textContent||'')).slice(0, 8).forEach((e) => {
    out.push('  ' + e.tagName + ' ' + box(e) + ' 「' + (e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,24) + '」');
  });
  return out.join('\\n');
})()`));

cleanup();
process.exit(0);

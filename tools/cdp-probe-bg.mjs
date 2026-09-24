// 专用探针：角色选择页「背景 tab」里，底部 CTA 到底有没有压住最后几个色卡
// ---------------------------------------------------------------------------
// 起因：cdp-overlap 报「📚 书房暖光 / 🌲 林间晨雾 被 CTA 那条盖住」。
//       源码上 ScrollView 和 ctaBar 是兄弟（flex 列），理论不该重叠，
//       所以要拿真实矩形 + 命中栈来判：是真压住，还是滚动容器本身溢出了。
//
// 用法: node cdp-probe-bg.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.PRB_PORT || 9385);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prb-bg-'));
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
    try { var K='aiva.companion.v1'; localStorage.setItem(K, JSON.stringify({
      personaId:'girlfriend', relations:{girlfriend:{affection:42,mood:70,energy:80}}, coins:128, giftCount:{},
      memory:[], chatHistory:{girlfriend:[
        {role:'user',content:'今天过得怎么样呀',ts:1},
        {role:'assistant',content:'几好呀，不过挂住你啰。',ts:2}]},
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
await sleep(8000);

// 点文本：只挑「面积最小」的命中元素，避免点在外层大容器上
async function clickText(txt, exact = false) {
  const r = await evaluate(`(() => {
    const host = document.getElementById('root') || document.body;
    const layers = Array.from(host.children).filter((el) => {
      const rr = el.getBoundingClientRect();
      return rr.width >= innerWidth*0.9 && rr.height >= innerHeight*0.85;
    });
    const scope = layers.length ? layers[layers.length-1] : host;
    const hits = Array.from(scope.querySelectorAll('*')).filter((e) => {
      const rr = e.getBoundingClientRect(); const s = e.textContent || '';
      return (${!!exact} ? s.trim() === ${JSON.stringify(txt)} : s.includes(${JSON.stringify(txt)})) && rr.width > 0 && rr.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a,b) => {
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (ra.width*ra.height)-(rb.width*rb.height);
    })[0];
    const rr = el.getBoundingClientRect();
    return { x: rr.left+rr.width/2, y: rr.top+rr.height/2, t: (el.textContent||'').slice(0,20) };
  })()`);
  if (!r) { console.log('  (点不到: ' + txt + ')'); return false; }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  return true;
}

await clickText('☰', true); await sleep(1500);
await clickText('换角色', false); await sleep(1800);
await clickText('背景', false); await sleep(1500);

const dump = await evaluate(`(() => {
  const host = document.getElementById('root') || document.body;
  const vw = innerWidth, vh = innerHeight;
  const out = [];
  const box = (e) => { const r = e.getBoundingClientRect();
    return '[' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']'; };
  const cs = (e) => { const s = getComputedStyle(e);
    return 'ov=' + s.overflow + '/' + s.overflowX + '/' + s.overflowY + ' pos=' + s.position + ' pe=' + s.pointerEvents; };

  out.push('视口 ' + vw + 'x' + vh);
  out.push('#root 直接子元素:');
  Array.from(host.children).forEach((c, i) => {
    out.push('  ' + i + ') ' + c.tagName + ' .' + String(c.className||'').slice(0,30) + ' ' + box(c));
  });

  const layers = Array.from(host.children).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= vw*0.9 && r.height >= vh*0.85;
  });
  const scope = layers.length ? layers[layers.length-1] : host;
  out.push('当前屏: ' + scope.tagName + ' .' + String(scope.className||'').slice(0,40) + ' ' + box(scope));

  // 找滚动容器（真正能竖滚的那个）
  const scrollers = Array.from(scope.querySelectorAll('*')).filter((e) => {
    const s = getComputedStyle(e);
    return /(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflow);
  });
  out.push('滚动容器 ' + scrollers.length + ' 个:');
  scrollers.forEach((e) => out.push('  ' + e.tagName + ' .' + String(e.className||'').slice(0,26)
    + ' ' + box(e) + ' scrollTop=' + Math.round(e.scrollTop) + ' scrollH=' + Math.round(e.scrollHeight)
    + ' clientH=' + Math.round(e.clientHeight) + '  ' + cs(e)));

  // CTA 那一条：文本里带「换成」或「开始相处」
  const cta = Array.from(scope.querySelectorAll('*')).filter((e) => {
    const t = (e.textContent||'');
    return (t.includes('换成') || t.includes('开始相处')) && e.children.length <= 3;
  }).sort((a,b) => {
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height)-(rb.width*rb.height);
  });
  out.push('CTA 候选:');
  cta.slice(0,4).forEach((e) => out.push('  ' + e.tagName + ' .' + String(e.className||'').slice(0,26)
    + ' ' + box(e) + ' 「' + (e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,26) + '」'));

  // 所有背景色卡文字 + 命中栈
  const ownText = (el) => Array.from(el.childNodes).filter((n)=>n.nodeType===3).map((n)=>n.textContent).join('').trim();
  const swatches = Array.from(scope.querySelectorAll('*')).filter((e) => {
    const t = ownText(e);
    return t && /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(t) && t.length < 20
      && !Array.from(e.querySelectorAll('*')).some((c)=>ownText(c));
  });
  out.push('色卡文字 ' + swatches.length + ' 个:');
  swatches.forEach((e) => {
    const r = e.getBoundingClientRect();
    const x = r.left + r.width/2, y = r.top + r.height/2;
    out.push('  【' + ownText(e).slice(0,16) + '】' + box(e) + ' 中心@' + Math.round(x) + ',' + Math.round(y)
      + '  顶层=' + (function(){ const t = document.elementFromPoint(x,y);
          return t ? t.tagName + '.' + String(t.className||'').slice(0,20) + ' 「' + (t.textContent||'').trim().slice(0,20) + '」' : 'null'; })());
  });

  return out.join('\\n');
})()`);

console.log(dump);
cleanup();
process.exit(0);

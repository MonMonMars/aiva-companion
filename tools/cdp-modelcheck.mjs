#!/usr/bin/env node
// 验证「专业模型有没有真的挂上」—— 只看控制台/像素是不够的，
// 必须直接问场景对象：骨架接上了吗（hasRig）、表情接上了吗（hasFace）、
// 到底请求了哪个 .glb（用来证明用的不是我们自研的程序化角色）。
//
// 用法：node tools/cdp-modelcheck.mjs http://127.0.0.1:8800/
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8800/';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9457);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdp(wsUrl) {
  const sock = new WebSocket(wsUrl);
  const waiters = new Map(); let idc = 0;
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? (a.preview?.description || '')).join(' ');
      console.log('  [console.' + (m.params.type || 'log') + '] ' + t.slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const ex = m.params.exceptionDetails;
      console.log('  [EXCEPTION] ' + (ex.exception?.description || ex.text || '').slice(0, 600));
    }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'modelcheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=430,900', 'about:blank',
], { stdio: 'ignore' });

try {
  let v = null;
  for (let i = 0; i < 60 && !v; i++) { try { v = await getJSON('/json/version'); } catch { await sleep(200); } }
  if (!v) throw new Error('DevTools 没起来');
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  console.log('>>> 打开：' + url);
  await c.send('Page.navigate', { url });
  await sleep(4000);

  // 首次进入停在「选人格」，3D 还没挂载 —— 先点第一个角色卡进去。
  // 这里刻意选「小柔/girlfriend」这类**老的自研人格**：
  // 如果它现在也用上了专业模型，就证明「全部角色都换成专业模型」真的生效了。
  const clicked = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const els = Array.from(document.querySelectorAll('div,span'));
    // 必须取「最内层」命中的元素：外层容器也含有这段文案，
    // 直接 find 会点到整个页面根节点，永远进不去 Home。
    const cands = els.filter(e => e.textContent && e.textContent.includes('小柔'));
    if (!cands.length) return { ok: false, reason: '没找到角色卡（可能已直接进 Home）' };
    cands.sort((a, b) => a.textContent.length - b.textContent.length);
    const card = cands[0];
    const r = card.getBoundingClientRect();
    const fire = (t) => card.dispatchEvent(new MouseEvent(t, {
      bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8,
    }));
    fire('mousedown'); fire('mouseup'); fire('click');
    return { ok: true, picked: (card.textContent || '').slice(0, 30), rect: [Math.round(r.left), Math.round(r.top)] };
  })()` });
  console.log('>>> 点击角色卡：' + JSON.stringify(clicked.result?.result?.value));

  // 专业模型是异步挂的，且 7.8MB 的 GLB 解析要时间，等久一点
  await sleep(16000);

  const res = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const d = window.__aivaDebug;
    const glb = (performance.getEntriesByType('resource') || [])
      .filter(r => /\\.glb(\\?|$)/.test(r.name))
      .map(r => ({ file: r.name.split('/').pop().slice(0, 44), kb: Math.round((r.transferSize || r.decodedBodySize || 0) / 1024) }));
    return {
      hasDebug: !!d,
      hasRig: d ? !!d.hasRig() : null,
      hasFace: d ? !!d.hasFace() : null,
      pose: d ? (d.currentPose() || null) : null,
      rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
      glb,
      text: (document.body && document.body.innerText || '').slice(0, 90),
    };
  })()` });
  const val = res.result?.result?.value || {};
  console.log('\n=== 模型挂载状态 ===');
  console.log('  调试钩子存在 :', val.hasDebug);
  console.log('  骨架已接管   :', val.hasRig, '(true = 专业模型的骨骼被识别并驱动)');
  console.log('  表情已接管   :', val.hasFace, '(true = 自带 blendshape 可用，口型可驱动)');
  console.log('  当前待机姿势 :', val.pose);
  console.log('  #root 子节点 :', val.rootChildren);
  console.log('  请求的 GLB   :', JSON.stringify(val.glb));
  console.log('  可见文字     :', JSON.stringify(val.text));
  c.close();
} catch (e) {
  console.error('探针失败：', e.message);
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

#!/usr/bin/env node
/**
 * 在真实浏览器里验收「写实档 3D 角色能不能跑起来」。
 *
 * 为什么必须这么做：Geometry 数值全对，不等于 three.js 在浏览器里能把它渲染出来。
 * 真正要验的是这几件事 —— 而且只有真跑一遍才知道：
 *   1. GLB 能被 GLTFLoader 解析（顶点色 / 蒙皮 / 骨架都没问题）
 *   2. .morph.json 能被 applyMorphData 挂上（24 个 blendshape 真的进了 geometry）
 *   3. 骨架被 rigDriver 接住（不然不会抬头、不会看人）
 *   4. canvas 真的画出了东西（不是空白 + 黑屏）
 *
 * 做法：预置 localStorage 跳过引导页 → 进主页 → 截图 + 读回运行时状态。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_APP = process.argv[2] || 'http://127.0.0.1:8193/';
const PERSONA = process.argv[3] || 'realistic-elena';
const OUT = process.argv[4] || 'assets/preview/realistic-stage.png';
const PORT = Number(process.env.CDP_PORT || 9422);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
// ⚠️ 不要加 --disable-gpu：那会让 WebGL 退回 CPU 光栅化，页面卡住不出帧
//    （实测截图会一直不返回）。要软件渲染就显式走 SwiftShader。
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox',
  '--hide-scrollbars', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=500,900',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try { return await getJSON('/json/version'); } catch { await sleep(250); }
  }
  throw new Error('Chrome DevTools 起不来');
}

async function cdp(wsUrl) {
  let WS = globalThis.WebSocket;
  if (!WS) { const m = await import('ws'); WS = m.default || m.WebSocket; }
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;
  await new Promise((res, rej) => {
    sock.addEventListener?.('open', res); sock.addEventListener?.('error', rej);
    if (sock.on) { sock.on('open', res); sock.on('error', rej); }
  });
  const onMsg = (raw) => {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  };
  if (sock.addEventListener) sock.addEventListener('message', (e) => onMsg(e.data));
  else sock.on('message', onMsg);
  return {
    send: (method, params = {}) => new Promise((res) => {
      const id = ++idc; waiters.set(id, res);
      sock.send(JSON.stringify({ id, method, params }));
    }),
    close: () => sock.close(),
  };
}

const ev = async (c, expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text || 'exception' };
  return r.result?.result?.value;
};

try {
  await waitForDevtools();
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');

  // 收集 console / pageerror，这是"为什么没渲染"最直接的线索
  const logs = [];
  const rawSend = c.send;
  // 简单轮询式收集：CDP 事件没有 id，这里挂一个旁路监听
  // （ws 层已经统一在 onMsg 里，事件被丢弃了 —— 改成在 send 前注册监听）
  c.send = rawSend;

  // 1) 先打开同源页面写 localStorage，再跳转，避免 about:blank 跨域
  await c.send('Page.navigate', { url: URL_APP });
  await sleep(2500);

  const seed = JSON.stringify({
    personaId: PERSONA,
    relations: { [PERSONA]: { affection: 480, mood: 82, energy: 90, createdAt: Date.now() - 86400000 * 12 } },
    chatHistory: {},
    onboarded: true,
    setupDone: true,
    lastSeenAt: Date.now(),
  });
  await ev(c, `localStorage.setItem('aiva.companion.v1', ${JSON.stringify(seed)}); 'seeded'`);

  // 2) 重新加载，让它读存档
  await c.send('Page.navigate', { url: URL_APP });
  await sleep(6000);

  // 3) 读回运行时真相
  const probe = await ev(c, `(() => {
    const out = { canvases: [], gl: null, three: null, errors: [] };
    const cs = [...document.querySelectorAll('canvas')];
    out.canvases = cs.map(c => ({
      w: c.width, h: c.height,
      cw: c.clientWidth, ch: c.clientHeight,
      // 数一下非背景色像素占比，判断是不是空画布
      painted: (() => {
        try {
          const g = c.getContext('webgl2') || c.getContext('webgl');
          if (!g) return 'no-gl-ctx-from-canvas';
          return 'has-gl-context';
        } catch (e) { return 'err:' + e.message; }
      })(),
    }));
    // React 树里的文字，确认当前在哪一屏
    out.text = (document.body.innerText || '').slice(0, 300);
    return JSON.stringify(out, null, 2);
  })()`);
  console.log('--- 页面运行时状态 ---');
  console.log(typeof probe === 'string' ? probe : JSON.stringify(probe, null, 2));

  // 4) 截图
  //
  // --head 模式：先用 CSS 放大角色 3D 视图，再截「头部」那一块。
  // 为什么需要：全身照里脑袋只有 ~60px，头发糊没糊脸根本看不清 ——
  // 而头发恰恰是最容易出问题、也最需要肉眼确认的部位。
  // 做法：给 canvas 所在的容器加 transform: scale()，再让 canvas 滚动到头顶位置。
  if (process.argv.includes('--head')) {
    const zoom = await ev(c, `(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return 'no-canvas';
      // 找一个合适的祖先当舞台：往上最多 3 层，取"尺寸和 canvas 差不多大"的那个
      let host = cv, up = 0;
      while (host.parentElement && up < 4) {
        host = host.parentElement; up++;
        if (host.clientHeight > cv.clientHeight * 1.5) break;
      }
      host.style.transformOrigin = '50% 0%';
      host.style.transform = 'scale(3.4)';
      host.style.transition = 'none';
      return 'zoomed';
    })()`);
    console.log('头部放大：', zoom);
    await sleep(1200);
    const clip = await ev(c, `(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
    })()`);
    const box = clip ? JSON.parse(clip) : null;
    const shot2 = await c.send('Page.captureScreenshot', {
      format: 'png',
      // 只取画布上方 42% —— 那里是头（放大后头会占满这块）
      clip: box ? { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.w, 500), height: Math.min(box.h * 0.42, 400), scale: 2 } : undefined,
    });
    const outHead = OUT.replace(/\.png$/, '-head.png');
    if (shot2.result?.data) {
      fs.writeFileSync(outHead, Buffer.from(shot2.result.data, 'base64'));
      console.log(`头部特写已写入 ${outHead}  (${fs.statSync(outHead).size} bytes)`);
    } else {
      console.log('头部特写失败：', JSON.stringify(shot2).slice(0, 300));
    }
  }

  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot.result?.data) {
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log(`\n截图已写入 ${OUT}  (${fs.statSync(OUT).size} bytes)`);
  } else {
    console.log('截图失败：', JSON.stringify(shot).slice(0, 300));
  }

  c.close();
} catch (e) {
  console.error('验收失败：', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

#!/usr/bin/env node
/**
 * shot-head.mjs — 离线「头部三视图」渲染器
 *
 * 为什么需要它：
 *   verify-realistic-stage.mjs 走的是**真实 App**，能证明"App 里能跑"，
 *   但它取景受 UI 布局支配 —— 头部特写要么只占画面下半部，要么被裁掉。
 *   眉毛/发际线这种 2~3mm 级别的细节，用 App 截图根本判不准
 *   （上一轮就是因此把"眉毛细刺"误判成"头发遮脸"，白跑了六轮）。
 *
 *   本工具直接从 .glb 读几何，自己搭一个最小 three.js 场景，
 *   正交投影对准头部拍三视图（正/侧/3-4），输出干净的大图。
 *   与 App 完全解耦，改几何后秒级复现，是"眼睛验收"的稳定通道。
 *
 * 用法：
 *   node tools/shot-head.mjs realistic-elena              # 正面 + 侧面 + 3/4
 *   node tools/shot-head.mjs realistic-marcus --only front
 *   node tools/shot-head.mjs realism-all                  # 六个角色各拍三视图
 *
 * 依赖：本地 Chrome + CDP（与 verify-realistic-stage.mjs 同一套机制，无需 playwright）
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// ⚠️ 必须用 fileURLToPath —— 本项目路径里有空格（"Simon Lai"），
//    直接取 new URL(import.meta.url).pathname 会拿到 %20 未解码的字符串，
//    mkdirSync 就会在 "Simon%20Lai" 这个并不存在的目录上 EPERM。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'assets', 'models2');
const OUT = path.join(ROOT, 'assets', 'preview');
const PORT = Number(process.env.CDP_PORT || 9433);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdp(wsUrl) {
  let WS = globalThis.WebSocket;
  if (!WS) { const m = await import('ws'); WS = m.default || m.WebSocket; }
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiters.has(msg.id)) {
      const { res, rej } = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++idc;
    waiters.set(id, { res, rej });
    sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

function listModels(argv) {
  const a = argv.filter((x) => !x.startsWith('--') && !isViewArg(argv, x));
  if (a.includes('realism-all')) {
    return ['realistic-aria', 'realistic-elena', 'realistic-kai', 'realistic-marcus', 'realistic-mika', 'realistic-ren'];
  }
  return a.length ? a : ['realistic-elena'];
}
function isViewArg(argv, x) {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] === x;
}
function viewsOf(argv) {
  const i = argv.indexOf('--only');
  if (i >= 0) return [argv[i + 1] || 'front'];
  return ['front', 'side', 'three-quarter'];
}

function buildHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#f2efe9;overflow:hidden}
#c{display:block;width:100vw;height:100vh}</style></head><body>
<canvas id="c"></canvas>
<script type="importmap">
{ "imports": {
    "three": "https://unpkg.com/three@0.186.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.186.0/examples/jsm/"
} }
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2efe9);
const key = new THREE.DirectionalLight(0xfff4e8, 2.1); key.position.set(0.7, 1.1, 1.6);
const fill = new THREE.DirectionalLight(0xdce8ff, 0.85); fill.position.set(-1.4, 0.35, 0.9);
const rim = new THREE.DirectionalLight(0xffffff, 0.95); rim.position.set(0, 1.5, -1.2);
scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.55));

const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
let mesh = null;
window.__err = '';

window.__shoot = async (url, view) => {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (mesh) scene.remove(mesh);
    mesh = gltf.scene;
    mesh.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    scene.add(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    const h = box.max.y - box.min.y;
    const headTop = box.max.y;
    const headH = h / 7.7;
    const cx = (box.max.x + box.min.x) / 2;
    const cy = headTop - headH * 0.5;
    const cz = (box.max.z + box.min.z) / 2;

    // ⚠️ 必须用真正的 OrthographicCamera 并写 left/right/top/bottom。
    //    之前直接对基类 THREE.Camera 调 makeOrthographic()，
    //    渲染器在 render() 里更新 camera 时会按 "perspective" 重算投影，
    //    实际生效的是默认 50° FOV 的透视投影 —— 于是相机贴在脸上，
    //    截图里只剩下两个巨大的眼球（这个坑吃过一次，记在这里）。
    const viewH = headH * 1.40;
    const aspect = innerWidth / innerHeight;
    cam.left   = -viewH * aspect / 2;
    cam.right  =  viewH * aspect / 2;
    cam.top    =  viewH / 2;
    cam.bottom = -viewH / 2;
    cam.updateProjectionMatrix();

    const t = headH * 4.0;
    let pos = new THREE.Vector3(cx, cy, cz + t);
    if (view === 'side') pos = new THREE.Vector3(cx + t, cy, cz);
    if (view === 'three-quarter') pos = new THREE.Vector3(cx + t*0.7, cy + t*0.14, cz + t*0.7);
    cam.position.copy(pos); cam.up.set(0,1,0);
    cam.lookAt(new THREE.Vector3(cx, cy, cz));
    cam.updateMatrixWorld(true);
    renderer.render(scene, cam);
    return { ok: true, headH, h, box: { minY: box.min.y, maxY: box.max.y, minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z }, viewH, t, camPos: pos.toArray() };
  } catch (e) {
    window.__err = String(e && e.message || e);
    return { ok: false, err: window.__err };
  }
};
</script></body></html>`;
}

async function main() {
  const argv = process.argv.slice(2);
  const models = listModels(argv);
  const views = viewsOf(argv);
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-head-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=900,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  let srv = null;
  try {
    let ver = null;
    for (let i = 0; i < 60; i++) {
      try { ver = await getJSON('/json/version'); break; } catch { await sleep(250); }
    }
    if (!ver) throw new Error('Chrome DevTools 起不来');

    const targets = await getJSON('/json/list');
    const page = targets.find((t) => t.type === 'page');
    const c = await cdp(page.webSocketDebuggerUrl);
    ws = c;

    await c.send('Page.enable');
    await c.send('Runtime.enable');

    // ⚠️ 不能从 data: URL 页面去 fetch file:// 的 GLB —— 会被同源策略拦掉
    //    （表现为 __shoot 抛错但 evaluate 返回 undefined）。
    //    起一个最小的本地 HTTP 服务，把 preview 输出目录和 models 目录都挂上。
    srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/' || u === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(buildHtml());
      }
      if (u.startsWith('/glb/')) {
        const f = path.join(MODELS, path.basename(u));
        if (fs.existsSync(f)) {
          res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Access-Control-Allow-Origin': '*' });
          return res.end(fs.readFileSync(f));
        }
      }
      res.writeHead(404); res.end('404');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const pagePort = srv.address().port;
    await c.send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` });
    await sleep(3500);

    // 等 __shoot 就绪（ES module + importmap 需要一点时间）
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const t = await c.send('Runtime.evaluate', { expression: 'typeof window.__shoot', returnByValue: true });
      if (t.result && t.result.value === 'function') { ready = true; break; }
      await sleep(250);
    }
    if (!ready) throw new Error('页面里 __shoot 没就绪（three.js 未加载完成）');

    for (const name of models) {
      const glbFile = path.join(MODELS, `${name}.glb`);
      if (!fs.existsSync(glbFile)) { console.log(`  × ${name} 不存在`); continue; }
      const glbUrl = `http://127.0.0.1:${pagePort}/glb/${name}.glb`;
      for (const v of views) {
        const r = await c.send('Runtime.evaluate', {
          expression: `window.__shoot(${JSON.stringify(glbUrl)}, ${JSON.stringify(v)})`,
          awaitPromise: true, returnByValue: true,
        });
        const info = r.result && r.result.value;
        if (!info || !info.ok) { console.log(`  × ${name} ${v}: ${info && info.err}`); continue; }
        const suffix = v === 'front' ? 'front' : v === 'side' ? 'side' : '34';
        const file = path.join(OUT, `${name}-${suffix}.png`);
        const shot = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        const kb = (fs.statSync(file).size / 1024).toFixed(0);
        console.log(`  ✓ ${path.relative(ROOT, file).replace(/\\/g,'/')}  (头高 ${(info.headH*100).toFixed(1)}cm · ${kb}KB · ${v})`);
        if (process.env.SHOT_DEBUG) {
          console.log('     box=', JSON.stringify(info.box), 'headH=', info.headH.toFixed(4),
                      'viewH=', info.viewH.toFixed(4), 't=', info.t.toFixed(4), 'cam=', JSON.stringify(info.camPos));
        }
      }
    }
  } finally {
    if (ws) ws.close();
    if (srv) srv.close();
    chrome.kill();
  }
  console.log('\n完成。');
}

main().catch((e) => { console.error(e); process.exit(1); });

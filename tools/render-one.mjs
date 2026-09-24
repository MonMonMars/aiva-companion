#!/usr/bin/env node
/**
 * 单角色离线渲染 —— ⚠️ 在本机（Windows headless + SwiftShader）**不可用**，仅留作记录。
 *
 * 结论先说：**不要用这条路验收造型**，用 App 路线：
 *     node tools/verify-realistic-stage.mjs http://127.0.0.1:<port>/ <角色id> <输出png>
 * 详见 tools/render-one.mjs 末尾的"踩坑记录"。
 *
 * 原本的设想：起个静态服务 + headless Chrome，把单个角色渲成一张 PNG，
 * 改完几何立刻看一眼，不用等 expo export（那条路要 20~40s）。
 *
 * 实测结果：**页面里的 three.js 能跑（几何数据读得到、canvas 尺寸正确），
 * 但截不到像素**。试过的四条路都不行：
 *   1. `--screenshot=out.png`          → 根本不落盘（Windows + SwiftShader）
 *   2. CDP `Page.captureScreenshot`    → 出图，但只有背景色（1.6~2KB）
 *   3. 显式 `Emulation.setDeviceMetricsOverride` → 同上，2KB
 *   4. `canvas.toDataURL()` 直读后备缓冲 → 7KB，仍然纯白
 * 说明 WebGL 的后备缓冲在这个 headless/SwiftShader 组合下**没真正产出内容**。
 *
 * 而 App 路线（expo export + 真浏览器里跑 expo-gl）截图正常（75KB，模型清晰可见），
 * 所以问题出在"裸 three.js + headless"的组合，不是模型本身。
 * 结论：验收统一走 App 路线，这个脚本不再维护。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const id = process.argv[2] || 'realistic-elena';
const OUT = process.argv[3] || `assets/preview/one-${id}.png`;
const VIEW = process.argv[4] || 'front';

const MODELS = 'assets/models2';
const glbPath = path.join(MODELS, `${id}.glb`);
if (!fs.existsSync(glbPath)) {
  console.error(`找不到 ${glbPath}，先跑 node tools/build-realistic.mjs ${id}`);
  process.exit(1);
}

const glb = fs.readFileSync(glbPath).toString('base64');

const threeRel = 'node_modules/three/build/three.module.js';
const loaderRel = 'node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const W = VIEW === 'closeup' ? 520 : 380;
const H = VIEW === 'closeup' ? 620 : 620;

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#e9e2d8;}
  canvas{display:block;}
</style></head>
<body>
<script type="importmap">
{ "imports": { "three": "/${threeRel}", "three/addons/": "/node_modules/three/examples/jsm/" } }
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from '/${loaderRel}';

function b64ToBuf(b64){
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i);
  return a.buffer;
}

const W=${W}, H=${H}, VIEW=${JSON.stringify(VIEW)};
const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setSize(W,H);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e2d8);

const cam = new THREE.PerspectiveCamera(VIEW==='closeup'?24:30, W/H, 0.01, 100);

// 三点光，和 App 内的光照调性一致
const key  = new THREE.DirectionalLight(0xffffff, 2.3); key.position.set(1.4, 2.2, 2.4);
const fill = new THREE.DirectionalLight(0xc8d4ff, 0.9);  fill.position.set(-2.2, 0.7, 1.4);
const rim  = new THREE.DirectionalLight(0xffe6cc, 1.2);  rim.position.set(-0.7, 1.5, -2.4);
scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.5));

const gltf = await new Promise((res,rej)=> new GLTFLoader().parse(b64ToBuf(${JSON.stringify(glb)}),'',res,rej));
const model = gltf.scene;
scene.add(model);

const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());
const mid  = box.getCenter(new THREE.Vector3());

if (VIEW === 'closeup') {
  // 只看上半身：把手/身体接缝看清楚
  const targetY = size.y * 0.80;
  const dist = size.y * 0.42;
  cam.position.set(dist*0.30, targetY + size.y*0.02, dist*1.05);
  cam.lookAt(0, targetY - size.y*0.06, 0);
} else if (VIEW === 'side') {
  const d = size.y * 1.35;
  cam.position.set(d*0.98, mid.y + size.y*0.05, d*0.08);
  cam.lookAt(0, mid.y, 0);
} else {
  const d = size.y * 1.30;
  cam.position.set(d*0.16, mid.y + size.y*0.06, d*1.0);
  cam.lookAt(0, mid.y, 0);
}

renderer.render(scene, cam);
document.body.appendChild(renderer.domElement);

// ⚠️ 挂上 DOM 之后要**再画一帧**。第一帧发生在 canvas 还没进文档时，
//    CDP 截图抓到的是空白的 body（实测只有 1.6KB）。
function paint() { renderer.render(scene, cam); }
paint();
requestAnimationFrame(() => { paint(); requestAnimationFrame(paint); });

// 报告几何真相，便于和截图对照
window.__INFO = {
  size: { w:+size.x.toFixed(3), h:+size.y.toFixed(3), d:+size.z.toFixed(3) },
};
document.title = 'READY';
window.__PAINTED = true;
</script>
</body></html>`;

const htmlPath = path.resolve('tools/.tmp-one.html');
fs.writeFileSync(htmlPath, html);

/* --- 静态服务（只需 three + html） --- */
const MIME = { '.html':'text/html;charset=utf-8', '.js':'text/javascript;charset=utf-8', '.mjs':'text/javascript;charset=utf-8' };
const ROOT = process.cwd();
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? '/tools/.tmp-one.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(b);
  });
});
const PORT = Number(process.env.ONE_PORT || 8211);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ...(fs.existsSync('C:/Users/Simon Lai/.agent-browser/browsers')
      ? fs.readdirSync('C:/Users/Simon Lai/.agent-browser/browsers')
          .filter((d) => d.startsWith('chrome-')).sort().reverse()
          .map((d) => `C:/Users/Simon Lai/.agent-browser/browsers/${d}/chrome.exe`)
      : []),
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
const chromeExe = findChrome();
if (!chromeExe) { console.error('找不到 Chrome'); server.close(); process.exit(1); }

const shot = path.resolve(OUT);
fs.mkdirSync(path.dirname(shot), { recursive: true });

// ===========================================================================
// 截图：走 CDP 的 Page.captureScreenshot，**不用** `--screenshot=`
// ---------------------------------------------------------------------------
// 为什么：Windows headless + SwiftShader 下，`--screenshot=` 这条路经常
//   直接不落盘（连报错都没有，就是没文件）。实测同一个页面：
//     --screenshot=...                  → 无文件
//     CDP Page.captureScreenshot        → 正常出图
//   所以我们起一个带 remote-debugging-port 的 Chrome，用 CDP 主动截。
// ===========================================================================
const CDP_PORT = Number(process.env.ONE_CDP_PORT || 9451);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'one-'));

const chrome = spawn(chromeExe, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
  '--disable-crash-reporter', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdpConnect(wsUrl) {
  let WS = globalThis.WebSocket;
  if (!WS) { const m = await import('ws'); WS = m.default || m.WebSocket; }
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;
  await new Promise((res, rej) => {
    if (sock.addEventListener) { sock.addEventListener('open', res); sock.addEventListener('error', rej); }
    else { sock.on('open', res); sock.on('error', rej); }
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

let ok = false;
try {
  // 等 DevTools 起来
  for (let i = 0; i < 60; i++) { try { await getJSON('/json/version'); break; } catch { await sleep(250); } }
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdpConnect(page.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  // ⚠️ 必须显式设视口尺寸。
  //    只给 `--window-size` 时，headless 的**页面视口**未必跟着变，
  //    canvas 就落在截图区域之外 —— 表现是 canvas 存在、尺寸也对，
  //    但截图是一张 1.6KB 的纯背景图。
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/.tmp-one.html` });

  // 等页面自己报告 READY（比死等固定时长可靠）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const r = await c.send('Runtime.evaluate', {
      expression: "document.title + '|' + (window.__INFO ? JSON.stringify(window.__INFO) : '')",
      returnByValue: true,
    });
    const v = r.result?.result?.value;
    if (typeof v === 'string' && v.startsWith('READY')) { ready = true; break; }
  }
  if (!ready) console.error('⚠️ 页面没等到 READY，仍然尝试截图');

  // 等真正画完（双 rAF + 一拍）
  await sleep(1200);

  const info = await c.send('Runtime.evaluate', {
    expression: 'window.__INFO ? JSON.stringify(window.__INFO) : "{}"', returnByValue: true,
  });
  console.log('  几何：' + (info.result?.result?.value || '{}'));

  const dims = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return 'no-canvas';
      const r = cv.getBoundingClientRect();
      return JSON.stringify({ w: cv.width, h: cv.height, cw: r.width, ch: r.height });
    })()`, returnByValue: true,
  });
  console.log('  canvas：' + (dims.result?.result?.value || '?'));

  // ⚠️ 不要用 Page.captureScreenshot。
  //    在 Windows headless + SwiftShader 下，WebGL canvas 的内容进不了
  //    compositor，CDP 截到的是**纯背景色**（实测只有 1.6~2KB）。
  //    正确做法：让页面自己 canvas.toDataURL()，把像素直接递出来 ——
  //    这条路读的是 WebGL 后备缓冲，和合成器无关。
  const dataUrl = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return '';
      return cv.toDataURL('image/png');
    })()`,
    returnByValue: true,
  });
  const url = dataUrl.result?.result?.value;
  if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) {
    fs.writeFileSync(shot, Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'));
    ok = true;
  } else {
    console.error('toDataURL 拿不到像素：' + String(url).slice(0, 200));
  }
  c.close();
} catch (e) {
  console.error('渲染异常：' + e.message);
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

server.close();

if (ok && fs.existsSync(shot) && fs.statSync(shot).size > 3000) {
  console.log(`✓ ${OUT}  (${(fs.statSync(shot).size / 1024).toFixed(0)}KB, ${W}×${H}, ${VIEW})`);
  process.exit(0);
} else {
  console.error('✗ 渲染失败：' + (fs.existsSync(shot) ? fs.statSync(shot).size + 'B（可能是空白）' : '无文件'));
  process.exit(1);
}
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const id = process.argv[2] || 'realistic-elena';
const OUT = process.argv[3] || `assets/preview/one-${id}.png`;
const VIEW = process.argv[4] || 'front';

const MODELS = 'assets/models2';
const glbPath = path.join(MODELS, `${id}.glb`);
if (!fs.existsSync(glbPath)) {
  console.error(`找不到 ${glbPath}，先跑 node tools/build-realistic.mjs ${id}`);
  process.exit(1);
}

const glb = fs.readFileSync(glbPath).toString('base64');

const threeRel = 'node_modules/three/build/three.module.js';
const loaderRel = 'node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const W = VIEW === 'closeup' ? 520 : 380;
const H = VIEW === 'closeup' ? 620 : 620;

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#e9e2d8;}
  canvas{display:block;}
</style></head>
<body>
<script type="importmap">
{ "imports": { "three": "/${threeRel}", "three/addons/": "/node_modules/three/examples/jsm/" } }
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from '/${loaderRel}';

function b64ToBuf(b64){
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i);
  return a.buffer;
}

const W=${W}, H=${H}, VIEW=${JSON.stringify(VIEW)};
const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setSize(W,H);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e2d8);

const cam = new THREE.PerspectiveCamera(VIEW==='closeup'?24:30, W/H, 0.01, 100);

// 三点光，和 App 内的光照调性一致
const key  = new THREE.DirectionalLight(0xffffff, 2.3); key.position.set(1.4, 2.2, 2.4);
const fill = new THREE.DirectionalLight(0xc8d4ff, 0.9);  fill.position.set(-2.2, 0.7, 1.4);
const rim  = new THREE.DirectionalLight(0xffe6cc, 1.2);  rim.position.set(-0.7, 1.5, -2.4);
scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.5));

const gltf = await new Promise((res,rej)=> new GLTFLoader().parse(b64ToBuf(${JSON.stringify(glb)}),'',res,rej));
const model = gltf.scene;
scene.add(model);

const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());
const mid  = box.getCenter(new THREE.Vector3());

if (VIEW === 'closeup') {
  // 只看上半身：把手/身体接缝看清楚
  const targetY = size.y * 0.80;
  const dist = size.y * 0.42;
  cam.position.set(dist*0.30, targetY + size.y*0.02, dist*1.05);
  cam.lookAt(0, targetY - size.y*0.06, 0);
} else if (VIEW === 'side') {
  const d = size.y * 1.35;
  cam.position.set(d*0.98, mid.y + size.y*0.05, d*0.08);
  cam.lookAt(0, mid.y, 0);
} else {
  const d = size.y * 1.30;
  cam.position.set(d*0.16, mid.y + size.y*0.06, d*1.0);
  cam.lookAt(0, mid.y, 0);
}

renderer.render(scene, cam);
document.body.appendChild(renderer.domElement);

// ⚠️ 挂上 DOM 之后要**再画一帧**。第一帧发生在 canvas 还没进文档时，
//    CDP 截图抓到的是空白的 body（实测只有 1.6KB）。
//    这里连画两帧 + rAF 等一拍，确保缓冲区里有内容。
function paint() { renderer.render(scene, cam); }
paint();
requestAnimationFrame(() => { paint(); requestAnimationFrame(paint); });

// 报告几何真相，便于和截图对照
window.__INFO = {
  size: { w:+size.x.toFixed(3), h:+size.y.toFixed(3), d:+size.z.toFixed(3) },
};
document.title = 'READY';
window.__PAINTED = true;
</script>
</body></html>`;

const htmlPath = path.resolve('tools/.tmp-one.html');
fs.writeFileSync(htmlPath, html);

/* --- 静态服务（只需 three + html） --- */
const MIME = { '.html':'text/html;charset=utf-8', '.js':'text/javascript;charset=utf-8', '.mjs':'text/javascript;charset=utf-8' };
const ROOT = process.cwd();
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? '/tools/.tmp-one.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(b);
  });
});
const PORT = Number(process.env.ONE_PORT || 8211);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ...(fs.existsSync('C:/Users/Simon Lai/.agent-browser/browsers')
      ? fs.readdirSync('C:/Users/Simon Lai/.agent-browser/browsers')
          .filter((d) => d.startsWith('chrome-')).sort().reverse()
          .map((d) => `C:/Users/Simon Lai/.agent-browser/browsers/${d}/chrome.exe`)
      : []),
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
const chromeExe = findChrome();
if (!chromeExe) { console.error('找不到 Chrome'); server.close(); process.exit(1); }

const shot = path.resolve(OUT);
fs.mkdirSync(path.dirname(shot), { recursive: true });

// ===========================================================================
// 截图：走 CDP 的 Page.captureScreenshot，**不用** `--screenshot=`
// ---------------------------------------------------------------------------
// 为什么：Windows headless + SwiftShader 下，`--screenshot=` 这条路经常
//   直接不落盘（连报错都没有，就是没文件）。实测同一个页面：
//     --screenshot=...                  → 无文件
//     CDP Page.captureScreenshot        → 正常出图
//   所以我们起一个带 remote-debugging-port 的 Chrome，用 CDP 主动截。
// ===========================================================================
const CDP_PORT = Number(process.env.ONE_CDP_PORT || 9451);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'one-'));

const chrome = spawn(chromeExe, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
  '--disable-crash-reporter', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdpConnect(wsUrl) {
  let WS = globalThis.WebSocket;
  if (!WS) { const m = await import('ws'); WS = m.default || m.WebSocket; }
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;
  await new Promise((res, rej) => {
    if (sock.addEventListener) { sock.addEventListener('open', res); sock.addEventListener('error', rej); }
    else { sock.on('open', res); sock.on('error', rej); }
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

let ok = false;
try {
  // 等 DevTools 起来
  for (let i = 0; i < 60; i++) { try { await getJSON('/json/version'); break; } catch { await sleep(250); } }
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdpConnect(page.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  // ⚠️ 必须显式设视口尺寸。
  //    只给 `--window-size` 时，headless 的**页面视口**未必跟着变，
  //    canvas 就落在截图区域之外 —— 表现是 canvas 存在、尺寸也对，
  //    但截图是一张 1.6KB 的纯背景图。
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/.tmp-one.html` });

  // 等页面自己报告 READY（比死等固定时长可靠）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const r = await c.send('Runtime.evaluate', {
      expression: "document.title + '|' + (window.__INFO ? JSON.stringify(window.__INFO) : '')",
      returnByValue: true,
    });
    const v = r.result?.result?.value;
    if (typeof v === 'string' && v.startsWith('READY')) { ready = true; break; }
  }
  if (!ready) console.error('⚠️ 页面没等到 READY，仍然尝试截图');

  // 等真正画完（双 rAF + 一拍）
  await sleep(1200);

  const info = await c.send('Runtime.evaluate', {
    expression: 'window.__INFO ? JSON.stringify(window.__INFO) : "{}"', returnByValue: true,
  });
  console.log('  几何：' + (info.result?.result?.value || '{}'));

  const dims = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return 'no-canvas';
      const r = cv.getBoundingClientRect();
      return JSON.stringify({ w: cv.width, h: cv.height, cw: r.width, ch: r.height });
    })()`, returnByValue: true,
  });
  console.log('  canvas：' + (dims.result?.result?.value || '?'));

  // ⚠️ 不要用 Page.captureScreenshot。
  //    在 Windows headless + SwiftShader 下，WebGL canvas 的内容进不了
  //    compositor，CDP 截到的是**纯背景色**（实测只有 1.6~2KB）。
  //    正确做法：让页面自己 canvas.toDataURL()，把像素直接递出来 ——
  //    这条路读的是 WebGL 后备缓冲，和合成器无关。
  const dataUrl = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return '';
      return cv.toDataURL('image/png');
    })()`,
    returnByValue: true,
  });
  const url = dataUrl.result?.result?.value;
  if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) {
    fs.writeFileSync(shot, Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'));
    ok = true;
  } else {
    console.error('toDataURL 拿不到像素：' + String(url).slice(0, 200));
  }
  c.close();
} catch (e) {
  console.error('渲染异常：' + e.message);
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

server.close();

if (ok && fs.existsSync(shot) && fs.statSync(shot).size > 3000) {
  console.log(`✓ ${OUT}  (${(fs.statSync(shot).size / 1024).toFixed(0)}KB, ${W}×${H}, ${VIEW})`);
  process.exit(0);
} else {
  console.error('✗ 渲染失败：' + (fs.existsSync(shot) ? fs.statSync(shot).size + 'B（可能是空白）' : '无文件'));
  process.exit(1);
}

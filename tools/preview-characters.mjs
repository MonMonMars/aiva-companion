// 角色预览渲染（离线，用于肉眼检查写实档的造型）
// ---------------------------------------------------------------------------
// 为什么需要它：
//   程序化生成的模型，数值上「顶点数对、骨骼数对」不代表**长得像人**。
//   五官比例、头发是否穿模、四肢接缝 —— 这些只能看图。
//   在接进 App 之前先离线渲染一遍，比打包后在浏览器里猜快得多。
//
// 做法：three.js 在 Node 里没有 WebGL，用 CPU 光栅化太慢。
// 所以走 GLTFExporter -> 写出一个自带 three + 模型数据的独立 HTML，
// 用无头 Chrome 打开截图。一次能出多个角色的拼图。
//
// 用法：node tools/preview-characters.mjs [输出名]
//   会把 assets/models2/*.glb 里所有角色渲染成一张横向拼图

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const OUT = process.argv[2] || 'assets/preview/realistic-sheet.png';
const MODELS_DIR = 'assets/models2';

const files = fs.readdirSync(MODELS_DIR)
  .filter((f) => f.endsWith('.glb') && f.startsWith('realistic-'))
  .sort();

if (!files.length) {
  console.error('assets/models2/ 里没有 realistic-*.glb，先跑 node tools/build-realistic.mjs');
  process.exit(1);
}

// 把每个 glb 读成 base64，连同 morph json 一起塞进 HTML
const assets = files.map((f) => {
  const id = f.replace('.glb', '');
  const glb = fs.readFileSync(path.join(MODELS_DIR, f)).toString('base64');
  const morphPath = path.join(MODELS_DIR, id + '.morph.json');
  const morph = fs.existsSync(morphPath) ? fs.readFileSync(morphPath, 'utf8') : null;
  return { id, glb, morph };
});

const threeRel = 'node_modules/three/build/three.module.js';
const loaderRel = 'node_modules/three/examples/jsm/loaders/GLTFLoader.js';
if (!fs.existsSync(threeRel)) { console.error('找不到 three 构建产物，先 npm install'); process.exit(1); }

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; background:#1a1c22; color:#dfe3ea; font:13px/1.5 system-ui,sans-serif; }
  #row { display:flex; flex-wrap:wrap; gap:2px; padding:8px; }
  .cell { width:300px; }
  .cell canvas { display:block; background:linear-gradient(#2a2e38,#1c1f26); border-radius:6px; }
  .cap { padding:5px 6px 10px; font-size:12px; color:#a8b0bf; }
  .cap b { color:#fff; font-weight:600; }
</style></head>
<body>
<div id="row"></div>
<script type="importmap">
{ "imports": {
  "three": "/${threeRel}",
  "three/addons/": "/node_modules/three/examples/jsm/"
} }
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from '/${loaderRel}';

const ASSETS = ${JSON.stringify(assets.map((a) => ({ id: a.id, glb: a.glb })))};
const W = 300, H = 380;

function b64ToBuf(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

const results = [];
const errors = [];

for (const a of ASSETS) {
 try {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = '<b>' + a.id + '</b>';

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x23262e);

  const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);

  // 三点光：主光偏前上、补光偏侧、背光勾轮廓
  const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(1.2, 2.0, 2.2);
  const fill = new THREE.DirectionalLight(0xc8d4ff, 0.85); fill.position.set(-2.0, 0.6, 1.2);
  const rim = new THREE.DirectionalLight(0xffe6cc, 1.15); rim.position.set(-0.6, 1.4, -2.2);
  scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.45));

  // 地面参考线（判断脚有没有踩在地上）
  const grid = new THREE.GridHelper(3, 12, 0x4a5160, 0x353a45);
  grid.position.y = 0;
  scene.add(grid);

  const gltf = await new Promise((res, rej) =>
    new GLTFLoader().parse(b64ToBuf(a.glb), '', res, rej));
  const model = gltf.scene;
  scene.add(model);

  // 量一下模型包围盒，据此摆相机（每个角色身高不同）
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const targetY = mid.y;
  const dist = size.y * 1.55;
  cam.position.set(dist * 0.34, targetY + size.y * 0.10, dist * 0.92);
  cam.lookAt(0, targetY, 0);

  renderer.render(scene, cam);
  cell.appendChild(renderer.domElement);
  cell.appendChild(cap);
  document.getElementById('row').appendChild(cell);

  results.push({ id: a.id, height: +size.y.toFixed(3), tris: countTris(model) });
  renderer.dispose();
 } catch (err) {
   errors.push(a.id + ': ' + (err && err.message ? err.message : String(err)));
 }
}

function countTris(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return Math.round(n);
}

window.__DONE = results;
window.__ERRORS = errors;
document.title = 'READY';
</script>
</body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const htmlPath = path.resolve('tools/.tmp-preview.html');
fs.writeFileSync(htmlPath, html);
console.log('已写出 ' + htmlPath);
console.log('角色 ' + assets.length + ' 个：' + assets.map((a) => a.id).join(', '));

// --- 用本地 HTTP + 无头 Chrome 截图 -----------------------------------------
// 为什么不用 file://：ES module + importmap 在 file:// 下会被 CORS 挡掉，
// three 模块加载不到，页面空白（踩过：截图 4KB 全黑）。
// 起一个极小的静态服务，把 node_modules 和 html 一起暴露出去。
import http from 'http';

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    ...(fs.existsSync('C:/Users/Simon Lai/.agent-browser/browsers')
      ? fs.readdirSync('C:/Users/Simon Lai/.agent-browser/browsers')
          .filter((d) => d.startsWith('chrome-'))
          .sort()
          .reverse()
          .map((d) => `C:/Users/Simon Lai/.agent-browser/browsers/${d}/chrome.exe`)
      : []),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const ROOT = process.cwd();
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/tools/.tmp-preview.html' : urlPath;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found: ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const PORT = Number(process.env.PREVIEW_PORT || 8177);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log('预览服务 http://127.0.0.1:' + PORT + '/');

const chrome = findChrome();
if (!chrome) {
  console.error('\n找不到 Chrome。设 CHROME_PATH，或手动打开 http://127.0.0.1:' + PORT + '/ 截图。');
  process.exit(0);
}

const COLS = Math.min(3, assets.length);
const ROWS = Math.ceil(assets.length / COLS);
const winW = COLS * 300 + 24;
const winH = ROWS * (380 + 46) + 24;
const shot = path.resolve(OUT);

// ⚠️ 关掉 --disable-gpu 会退化成 CPU 光栅化，6 个角色要 5 分钟以上并且经常直接挂死。
//    正确做法：留 GPU 通道但强制 SwiftShader 软件 WebGL，
//    `--virtual-time-budget` 在这种模式下才会按时收工。
const r = spawnSync(chrome, [
  '--headless=new',
  '--no-sandbox',
  '--hide-scrollbars',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
  '--force-device-scale-factor=1',
  '--virtual-time-budget=20000',
  `--window-size=${winW},${winH}`,
  `--screenshot=${shot}`,
  `http://127.0.0.1:${PORT}/tools/.tmp-preview.html`,
], { encoding: 'utf8', timeout: 240000 });

if (fs.existsSync(shot) && fs.statSync(shot).size > 12000) {
  const kb = (fs.statSync(shot).size / 1024).toFixed(0);
  console.log('✓ ' + OUT + '  (' + kb + 'KB, ' + winW + '×' + winH + ')');
  server.close();
  process.exit(0);
} else {
  console.error('✗ 截图失败或空白（文件 ' +
    (fs.existsSync(shot) ? (fs.statSync(shot).size / 1024).toFixed(0) + 'KB' : '不存在') + '）');
  console.error('  服务保持运行中，可手动访问 http://127.0.0.1:' + PORT + '/ 排查。');
  if (r.stderr) console.error(String(r.stderr).slice(0, 600));
  if (r.stdout) console.error(String(r.stdout).slice(-600));
  // 故意不退出：留着服务方便排查
  process.exitCode = 1;
}

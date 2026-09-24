#!/usr/bin/env node
/**
 * compare-page.mjs — 生成一份**离线可双击打开**的角色 A/B 对比页。
 *
 * 为什么要它：
 *   写实档 / FF 风格档的角色好不好看，最终只能由人眼判断。
 *   但截图是死的（角度、光照都被拍死了），而"这版比例对不对"恰恰要转着看。
 *   所以做一个双视口对比器：左右各选一个角色，鼠标拖动同步转视角，
 *   还能一键切到头部特写看脸。
 *
 * ⚠️ 三个实现上的硬约束（都是踩过的）：
 *   ① 必须**单文件自包含**。file:// 下 ES module 的相对 import 会被 CORS 挡掉
 *      （tools/shot-head.mjs 和 preview-characters.mjs 都栽在这），
 *      所以 three 和 10 个 GLB 全部内联进 HTML。
 *   ② 不能内联 GLTFLoader：它 `import { ... } from 'three'`，
 *      在单文件里没有模块解析上下文。这里直接手写一个最小 GLB 解析器
 *      （只读 POSITION / NORMAL / COLOR_0 / index），比塞整个 loader 小得多。
 *   ③ three 的 ESM 构建只有一处 `export { ... }`（最后一行），
 *      把它替换成 `const THREE = { ... }` 就能当普通脚本用 —— 不用改别的地方。
 *
 * 用法：node tools/compare-page.mjs [输出路径]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineThree } from './lib/three-inline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || 'assets/preview/compare.html';

const MODELS = path.join(ROOT, 'assets', 'models2');

// ---------------------------------------------------------------------------
// 角色清单 + 体检数字
//
// ⚠️ 这些数字是 tools/inspect-character.mjs 和 inspect-hair.mjs 的**实测输出**，
//    不是从 preset 里抄的（preset 的 headsTall 是目标值，实测会因发尖/鞋底而偏）。
//    每次重建模型后要重跑体检并同步这里，否则页面会显示过期数据。
// ---------------------------------------------------------------------------
const ROSTER = [
  { file: 'realistic-elena',  name: 'Elena',  tier: '写实', role: '知性女教师', h: 1.71, heads: 8.05, note: '长直发 · 西装' },
  { file: 'realistic-mika',   name: 'Mika',   tier: '写实', role: '冷感御姐',   h: 1.75, heads: 8.05, note: '波浪长发 · 全黑' },
  { file: 'realistic-aria',   name: 'Aria',   tier: '写实', role: '暖阳少女',   h: 1.64, heads: 7.96, note: '波浪长发 · 针织' },
  { file: 'realistic-marcus', name: 'Marcus', tier: '写实', role: '沉稳男性',   h: 1.85, heads: 8.14, note: '短寸 · 大衣' },
  { file: 'realistic-kai',    name: 'Kai',    tier: '写实', role: '阳光型男',   h: 1.81, heads: 8.06, note: '短碎 · 夹克' },
  { file: 'realistic-ren',    name: 'Ren',    tier: '写实', role: '清瘦艺术家', h: 1.78, heads: 8.05, note: '中长乱发 · 针织' },
  { file: 'realistic-rion',   name: 'Rion',   tier: 'FF',   role: '尖发剑士',   h: 1.85, heads: 8.25, note: '尖发 14 根 · 披风' },
  { file: 'realistic-celine', name: 'Celine', tier: 'FF',   role: '长裙法师',   h: 1.69, heads: 8.05, note: '及踝长裙 · 银发' },
  { file: 'realistic-bryce',  name: 'Bryce',  tier: 'FF',   role: '重装佣兵',   h: 1.89, heads: 8.23, note: '肩甲 · heavy 体型' },
  { file: 'realistic-nyx',    name: 'Nyx',    tier: 'FF',   role: '兜帽游侠',   h: 1.71, heads: 8.05, note: '后垂兜帽 · 赤褐发' },
  { file: 'realistic-hikari', name: 'Hikari', tier: 'VTuber', role: '虚拟歌姬',  h: 1.69, heads: 6.86, note: '呆毛 · 头戴耳机 · 薄荷青渐变发' },
];

/**
 * 三角面数**从 GLB 里读**，不写在 ROSTER 里。
 * ⚠️ 手写会过期：hikari 的卖点就是低模（8.8k vs 其他 ~21k），
 *    一旦重建模型面数变了而页面还写着旧数字，这个对比就失去意义了。
 */
function triCount(file) {
  const buf = fs.readFileSync(path.join(MODELS, file + '.glb'));
  let off = 12, json = null;
  while (off < buf.readUInt32LE(8)) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  const prim = json.meshes[0].primitives[0];
  const acc = prim.indices != null ? json.accessors[prim.indices] : json.accessors[prim.attributes.POSITION];
  return Math.round(acc.count / 3);
}

const assets = [];
for (const r of ROSTER) {
  const p = path.join(MODELS, r.file + '.glb');
  if (!fs.existsSync(p)) { console.error('缺少 ' + p + '，先跑 build-realistic.mjs'); process.exit(1); }
  assets.push({ ...r, tris: triCount(r.file), b64: fs.readFileSync(p).toString('base64') });
}

// --- three 内联：抽到 tools/lib/three-inline.mjs，shot-sheet.mjs 也用同一份 ------
//    （坑都在那个文件里写了：只内联 core 会没有 WebGLRenderer；两个文件直接拼接会重名）
const THREE_SRC = inlineThree(ROOT);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>角色 A/B 对比器 — 写实档 vs FF 风格档</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f5f3ef; color: #33282f;
    font: 14px/1.65 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  header { padding: 26px 30px 18px; border-bottom: 1px solid #e5e0d8; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: .3px; }
  .sub { font-size: 12.5px; color: #8b8189; margin: 0; }
  .bar {
    display: flex; flex-wrap: wrap; gap: 14px; align-items: center;
    padding: 14px 30px; border-bottom: 1px solid #e5e0d8; background: #fbfaf7;
  }
  .bar label { font-size: 12px; color: #6d646c; font-weight: 700; }
  select, button {
    font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px;
    border: 1px solid #d8d1c7; background: #fff; color: #33282f; cursor: pointer;
  }
  button.on { background: #33282f; color: #fff; border-color: #33282f; }
  .seg { display: flex; gap: 0; }
  .seg button { border-radius: 0; margin-left: -1px; }
  .seg button:first-child { border-radius: 8px 0 0 8px; margin-left: 0; }
  .seg button:last-child { border-radius: 0 8px 8px 0; }
  .stages { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 20px 30px; }
  @media (max-width: 900px) { .stages { grid-template-columns: 1fr; } }
  .stage { background: #fff; border-radius: 14px; padding: 12px; box-shadow: 0 1px 3px rgba(51,40,47,.07), 0 10px 26px rgba(51,40,47,.05); }
  .stage .hd { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .stage .hd b { font-size: 16px; }
  .stage .hd .tier { font-size: 10.5px; font-weight: 800; padding: 2px 7px; border-radius: 999px; background: #efe9e0; color: #7d7280; }
  .stage .hd .tier.ff { background: #33282f; color: #fff; }
  .stage .hd .tier.vt { background: #2EA8BE; color: #fff; }
  tr.vt td { background: #f2fbfc; }
  .stage .meta { font-size: 11.5px; color: #9a9099; margin-bottom: 8px; }
  canvas { width: 100%; display: block; border-radius: 10px; background: linear-gradient(#f0ece5, #e6e1d8); cursor: grab; touch-action: none; }
  canvas:active { cursor: grabbing; }
  .hint { font-size: 11px; color: #a79ea7; text-align: center; margin-top: 6px; }
  table { width: calc(100% - 60px); margin: 0 30px 40px; border-collapse: collapse; font-size: 12.5px; background: #fff; border-radius: 12px; overflow: hidden; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f0ece6; }
  th { background: #faf8f4; font-size: 11px; letter-spacing: .5px; color: #8b8189; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.ff td:first-child { box-shadow: inset 3px 0 0 #33282f; }
  #log { margin: 0 30px 40px; font-size: 12px; color: #b0462f; white-space: pre-wrap; }
</style>
</head>
<body>
<header>
  <h1>角色 A/B 对比器</h1>
  <p class="sub">左右各选一个角色，拖动任意一侧即可<strong>同步旋转</strong>。写实档 6 个已按 FF7 Rebirth 标准改到约 8 头身；FF 档 4 个是原创角色，只借鉴 Square Enix 的比例与剪影工艺。</p>
</header>

<div class="bar">
  <label>视角</label>
  <div class="seg" id="viewSeg">
    <button data-v="full" class="on">全身</button>
    <button data-v="bust">半身</button>
    <button data-v="head">头部</button>
  </div>
  <button id="syncBtn" class="on">同步视角：开</button>
  <button id="spinBtn">自动旋转：关</button>
  <label style="margin-left:auto">A</label>
  <select id="selA"></select>
  <label>B</label>
  <select id="selB"></select>
</div>

<div class="stages">
  <div class="stage"><div class="hd"><b id="nameA">—</b><span class="tier" id="tierA"></span></div>
    <div class="meta" id="metaA"></div><canvas id="cvA" width="560" height="720"></canvas>
    <div class="hint">拖动旋转 · 滚轮缩放</div></div>
  <div class="stage"><div class="hd"><b id="nameB">—</b><span class="tier" id="tierB"></span></div>
    <div class="meta" id="metaB"></div><canvas id="cvB" width="560" height="720"></canvas>
    <div class="hint">拖动旋转 · 滚轮缩放</div></div>
</div>

<table id="tbl">
  <thead><tr><th>角色</th><th>档位</th><th>定位</th><th class="num">身高 m</th><th class="num">头身比</th><th class="num">三角面</th><th>剪影特征</th></tr></thead>
  <tbody></tbody>
</table>
<div id="log"></div>

<script>
${THREE_SRC}
</script>

<script>
/* ===========================================================================
   最小 GLB 解析器 —— 只要 POSITION / NORMAL / COLOR_0 / indices
   （不解析 skin / animation：这是 A-pose 静态对比，不需要蒙皮）
   =========================================================================== */
const CT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const CT_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function parseGlb(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB');
  const total = dv.getUint32(8, true);
  let off = 12, json = null, binStart = -1, binLen = 0;
  while (off < total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    else if (type === 0x004e4942) { binStart = start; binLen = len; }
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('没有 JSON chunk');
  const bin = new Uint8Array(buf, binStart, binLen);
  const binView = new DataView(buf, binStart, binLen);

  function readAcc(i) {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const cs = CT_SIZE[a.componentType], n = CT_N[a.type];
    const stride = bv.byteStride || cs * n;
    const out = new Float32Array(a.count * n);
    for (let k = 0; k < a.count; k++) {
      for (let c = 0; c < n; c++) {
        const o = base + k * stride + c * cs;
        let v = 0;
        switch (a.componentType) {
          case 5126: v = binView.getFloat32(o, true); break;
          case 5125: v = binView.getUint32(o, true); break;
          case 5123: v = binView.getUint16(o, true) / (a.normalized ? 65535 : 1); break;
          case 5121: v = binView.getUint8(o) / (a.normalized ? 255 : 1); break;
          case 5122: v = binView.getInt16(o, true); break;
          case 5120: v = binView.getInt8(o); break;
        }
        out[k * n + c] = v;
      }
    }
    return out;
  }

  const prim = json.meshes[0].primitives[0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(readAcc(prim.attributes.POSITION), 3));
  if (prim.attributes.NORMAL != null) geo.setAttribute('normal', new THREE.BufferAttribute(readAcc(prim.attributes.NORMAL), 3));
  else geo.computeVertexNormals();
  if (prim.attributes.COLOR_0 != null) geo.setAttribute('color', new THREE.BufferAttribute(readAcc(prim.attributes.COLOR_0), 3));
  if (prim.indices != null) {
    const ia = json.accessors[prim.indices];
    const bv = json.bufferViews[ia.bufferView];
    const base = (bv.byteOffset || 0) + (ia.byteOffset || 0);
    const idx = ia.componentType === 5125
      ? new Uint32Array(ia.count)
      : new Uint16Array(ia.count);
    for (let k = 0; k < ia.count; k++) {
      idx[k] = ia.componentType === 5125
        ? binView.getUint32(base + k * 4, true)
        : binView.getUint16(base + k * 2, true);
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

function b64ToBuf(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

/* =========================================================================== */
const ASSETS = ${JSON.stringify(assets)};

const cache = new Map();
function getModel(id) {
  if (cache.has(id)) return cache.get(id);
  const a = ASSETS.find((x) => x.file === id);
  const geo = parseGlb(b64ToBuf(a.b64));
  geo.computeBoundingBox();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.78, metalness: 0.06,
    side: THREE.FrontSide, flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  cache.set(id, mesh);
  return mesh;
}

// --- 视口：每个视口一个渲染器 + 自己的场景 ---------------------------------
// ⚠️ 只开 2 个 WebGL context：10 个角色共用两侧的 mesh（随时换），
//    而不是 10 个 canvas 各开一个 —— 浏览器 WebGL context 上限约 16，
//    而且 10 份 83 万顶点的几何同时驻留会直接把标签页拖死。
// ⚠️ FOV 必须声明在 makeStage **之前**：makeStage 里 new PerspectiveCamera(FOV, ...)
//    是在模块顶层立刻执行的，放到后面的话会撞上 const 的 TDZ（实测 ReferenceError）。
const FOV = 30;
const HALF = Math.tan((FOV / 2) * (Math.PI / 180));   // tan(15°)，见下面 VIEW 的说明

function makeStage(canvasId) {
  const canvas = document.getElementById(canvasId);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(FOV, canvas.width / canvas.height, 0.02, 60);

  // 三点光：FF7 Rebirth 的过场就是这套 —— 主光前上、冷补光侧、暖背光勾轮廓
  const key = new THREE.DirectionalLight(0xffffff, 2.3); key.position.set(1.4, 2.2, 2.6);
  const fill = new THREE.DirectionalLight(0xc6d6ff, 0.9); fill.position.set(-2.4, 0.8, 1.4);
  const rim = new THREE.DirectionalLight(0xffe0c0, 1.3); rim.position.set(-0.8, 1.6, -2.6);
  scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.5));

  const grid = new THREE.GridHelper(4, 16, 0xb9b0a4, 0xd8d1c7);
  scene.add(grid);

  const holder = new THREE.Group();
  scene.add(holder);

  return { canvas, renderer, scene, cam, holder, grid, current: null };
}

const A = makeStage('cvA');
const B = makeStage('cvB');
const stages = [A, B];

// 共享的轨道参数：拖任意一个，两边一起转
const orbit = { theta: 0.42, phi: 1.45, dist: 4.2, targetY: 0.9 };
// ⚠️ 视距不能再拍脑袋写系数了，必须从 FOV 反推：
//      画面可见高度 = 2 · d · tan(fov/2)   ⇒   d = 想看的高度 / (2 · tan(fov/2))
//    原来写的是 dist = H × 1.00，30° FOV 下可见高度只有 0.536 × H ——
//    「全身」模式实际只拍到腰以上一块躯干：实测包围盒 8 个角的 NDC 到了
//    y = -2.22 ~ +2.14，头和脚全在画面外，这个对比页等于白做。
//    改成按 span（想看到的高度 ÷ 模型总高）反推，以后换 FOV、换画布比例都不用再手调。
const VIEW = {
  full: { target: 0.50, span: 1.12 },   // 全身：留 12% 余量
  bust: { target: 0.86, span: 0.34 },   // 半身：头顶到胸口
  head: { target: 0.92, span: 0.20 },   // 大头：主要看脸
};
let view = 'full';
let sync = true;
let spin = false;

function load(s, id) {
  if (s.current) s.holder.remove(s.current);
  const m = getModel(id);
  s.holder.add(m);
  s.current = m;
  const bb = m.geometry.boundingBox;
  s.size = bb.getSize(new THREE.Vector3());
  s.center = bb.getCenter(new THREE.Vector3());
}

// ⚠️ 不调 setSize 的话，drawing buffer 一直是 HTML 里写死的 560×720，
//    被 CSS 的 width:100% 拉到 729×937 显示 —— 画面发虚，
//    而且 cam.aspect 用的还是 560/720 那个旧比例，构图算不准。
const DPR = Math.min(2, window.devicePixelRatio || 1);
function fit(s) {
  const r = s.canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  const bw = Math.round(w * DPR), bh = Math.round(h * DPR);
  if (s.canvas.width === bw && s.canvas.height === bh) return;
  // updateStyle 传 false：别写内联 style，画布宽度继续由 CSS 的 width:100% 决定，
  // 否则 setSize 会把 style.width 钉死成像素值，窗口缩放时就不跟着变了。
  s.renderer.setSize(w, h, false);
  s.cam.aspect = w / h;
  s.cam.updateProjectionMatrix();
}

function place(s) {
  const H = s.size ? s.size.y : 1.75;
  const v = VIEW[view];
  const targetY = H * v.target;
  const dist = (H * v.span) / (2 * HALF) * (s.userZoom || 1);
  // 球面坐标：el 是镜头相对目标点的仰角，phi=π/2 时正好水平
  const el = orbit.phi - Math.PI / 2;
  s.cam.position.set(
    Math.sin(orbit.theta) * Math.cos(el) * dist,
    targetY + Math.sin(el) * dist,
    Math.cos(orbit.theta) * Math.cos(el) * dist
  );
  s.cam.lookAt(0, targetY, 0);
  s.grid.visible = view === 'full';
}

function renderAll() {
  for (const s of stages) {
    if (!s.current) continue;
    fit(s);
    place(s);
    s.renderer.render(s.scene, s.cam);
  }
}

/* ---------- 交互 ---------- */
let drag = null;
for (const s of stages) {
  s.canvas.addEventListener('pointerdown', (e) => {
    drag = { s, x: e.clientX, y: e.clientY };
    s.canvas.setPointerCapture(e.pointerId);
  });
  s.canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.s !== s) return;
    orbit.theta -= (e.clientX - drag.x) * 0.008;
    orbit.phi = Math.max(-0.35, Math.min(1.35, orbit.phi + (e.clientY - drag.y) * 0.006));
    drag.x = e.clientX; drag.y = e.clientY;
    renderAll();
  });
  s.canvas.addEventListener('pointerup', (e) => {
    drag = null;
    try { s.canvas.releasePointerCapture(e.pointerId); } catch {}
  });
  s.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(e.deltaY * 0.0012);
    if (sync) { for (const t of stages) t.userZoom = Math.max(0.45, Math.min(2.4, (t.userZoom || 1) * f)); }
    else s.userZoom = Math.max(0.45, Math.min(2.4, (s.userZoom || 1) * f));
    renderAll();
  }, { passive: false });
}

document.querySelectorAll('#viewSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#viewSeg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    view = b.dataset.v;
    renderAll();
  });
});
const syncBtn = document.getElementById('syncBtn');
syncBtn.addEventListener('click', () => {
  sync = !sync;
  syncBtn.textContent = '同步视角：' + (sync ? '开' : '关');
  syncBtn.classList.toggle('on', sync);
});
const spinBtn = document.getElementById('spinBtn');
spinBtn.addEventListener('click', () => {
  spin = !spin;
  spinBtn.textContent = '自动旋转：' + (spin ? '开' : '关');
  spinBtn.classList.toggle('on', spin);
});

/* ---------- 下拉框 / 表格 ---------- */
const opts = ASSETS.map((a) => '<option value="' + a.file + '">' + a.name + ' · ' + a.role + '（' + a.tier + '）</option>').join('');
const selA = document.getElementById('selA'), selB = document.getElementById('selB');
selA.innerHTML = opts; selB.innerHTML = opts;
selA.value = 'realistic-elena';
// 默认右侧放新角色：一打开就能看到「写实 vs VTuber 低模」的对比
selB.value = 'realistic-hikari';

function describe(s, tag) {
  const a = ASSETS.find((x) => x.file === s.id);
  document.getElementById('name' + tag).textContent = a.name + ' · ' + a.role;
  const t = document.getElementById('tier' + tag);
  t.textContent = a.tier;
  t.className = 'tier' + (a.tier === 'FF' ? ' ff' : a.tier === 'VTuber' ? ' vt' : '');
  document.getElementById('meta' + tag).textContent =
    a.h.toFixed(2) + ' m · ' + a.heads.toFixed(2) + ' 头身 · ' +
    a.tris.toLocaleString('en-US') + ' 三角面 · ' + a.note;
}

function setSide(s, tag, id) {
  s.id = id;
  load(s, id);
  describe(s, tag);
  renderAll();
}
selA.addEventListener('change', () => setSide(A, 'A', selA.value));
selB.addEventListener('change', () => setSide(B, 'B', selB.value));

document.querySelector('#tbl tbody').innerHTML = ASSETS.map((a) =>
  '<tr class="' + (a.tier === 'FF' ? 'ff' : a.tier === 'VTuber' ? 'vt' : '') + '"><td><b>' + a.name + '</b></td><td>' + a.tier +
  '</td><td>' + a.role + '</td><td class="num">' + a.h.toFixed(2) + '</td><td class="num">' +
  a.heads.toFixed(2) + '</td><td class="num">' + a.tris.toLocaleString('en-US') +
  '</td><td>' + a.note + '</td></tr>').join('');

/* ---------- 启动 ---------- */
const errs = [];
try {
  setSide(A, 'A', selA.value);
  setSide(B, 'B', selB.value);
} catch (e) { errs.push(String(e && e.stack || e)); }

(function loop() {
  if (spin) { orbit.theta += 0.006; renderAll(); }
  requestAnimationFrame(loop);
})();

window.addEventListener('resize', renderAll);

// 自检用：headless 抓取 DOM 时读这个
window.__ERRS = errs;
document.getElementById('log').textContent = errs.join('\\n');
window.__READY = errs.length === 0;
window.__LOADED = ASSETS.length;
</script>
</body>
</html>
`;

const outPath = path.resolve(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log('✓ ' + OUT + '  (' + (html.length / 1024 / 1024).toFixed(2) + ' MB, ' + assets.length + ' 个角色内联)');
console.log('  直接用浏览器打开即可，不需要起服务。');

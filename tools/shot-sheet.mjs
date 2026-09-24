#!/usr/bin/env node
/**
 * shot-sheet.mjs — 给每个角色渲一张「三视图」设定图（正面 / 侧面 / 背面），输出 JPG。
 *
 * 为什么另起一个工具，而不是复用 shot-head.mjs：
 *   shot-head 是**头部特写**（正交对准头部，看眉毛发际线这类 2~3mm 细节），
 *   本工具是**全身设定图**（看比例、剪影、发型体积），取景和用途都不一样。
 *
 * ⚠️ 与 shot-head.mjs 的三个关键差异（都是踩过的坑）：
 *   ① three 从 node_modules 内联（tools/lib/three-inline.mjs），
 *      不走 importmap 去 unpkg 拉 —— 离线能用，也不受 CDN 波动影响。
 *   ② Chrome 参数用 --use-angle=swiftshader，**不是** --use-gl=swiftshader。
 *      后者会让 WebGL 上下文在页面加载后立刻丢失，画面全黑。
 *   ③ 一次截图拿到三视图：用 setScissorTest + setViewport 把画布切成三条，
 *      各渲一个正交视角。比"渲三次再在 node 里拼图"少一次合成步骤，
 *      而且 HTML 里的文字标签能被一起拍进来。
 *
 * 用法：
 *   node tools/shot-sheet.mjs                       # 全部 11 个角色
 *   node tools/shot-sheet.mjs realistic-hikari      # 只渲一个
 *
 * 输出：assets/preview/sheets/<角色>-sheet.jpg
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { inlineThree } from './lib/three-inline.mjs';

const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'assets', 'models2');
const OUT = path.join(ROOT, 'assets', 'preview', 'sheets');
const PORT = Number(process.env.CDP_PORT || 9451);

// 画布：3 条面板各 520 宽；顶部 56px 放标题，总高 800
const W = 1560, HEADER = 56, PH = 744, PW = W / 3;
const BG = 0xf2efe9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

/** 角色名单 + 展示信息：从 compare-page.mjs 现解析，避免两处名单不同步 */
const ROSTER = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/compare-page.mjs'), 'utf8');
  const i = src.indexOf('const ROSTER = [');
  if (i < 0) throw new Error('compare-page.mjs 里找不到 ROSTER');
  const j = src.indexOf('\n];', i);
  return new Function('return ' + src.slice(i + 'const ROSTER = '.length, j + 2))();
})();

function triCount(file) {
  const buf = fs.readFileSync(file);
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

function buildHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden;background:#f2efe9;
  font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#hdr{height:${HEADER}px;display:flex;align-items:baseline;gap:14px;padding:0 22px;color:#4a3f38}
#hdr b{font-size:17px;letter-spacing:.03em}
#hdr span{font-size:13px;color:#94877b}
#wrap{position:relative;width:${W}px;height:${PH}px}
canvas{display:block}
.lbl{position:absolute;bottom:12px;width:${PW}px;text-align:center;
  font-size:13px;letter-spacing:.14em;color:#9a8d80}
</style></head><body>
<div id="hdr"><b id="tName">—</b><span id="tMeta"></span></div>
<div id="wrap">
  <canvas id="c" width="${W}" height="${PH}"></canvas>
  <div class="lbl" style="left:0">正面 FRONT</div>
  <div class="lbl" style="left:${PW}px">侧面 SIDE</div>
  <div class="lbl" style="left:${PW * 2}px">背面 BACK</div>
</div>
<script>
${inlineThree(ROOT)}
</script>
<script>
/* ---- 最小 GLB 解析器：只要 POSITION / NORMAL / COLOR_0 / index ---- */
const CT_SIZE = { 5120:1, 5121:1, 5122:2, 5123:2, 5125:4, 5126:4 };
const CT_N = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4 };
function parseGlb(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB');
  const total = dv.getUint32(8, true);
  let off = 12, json = null, binStart = -1, binLen = 0;
  while (off < total) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    else if (type === 0x004e4942) { binStart = start; binLen = len; }
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('没有 JSON chunk');
  const binView = new DataView(buf, binStart, binLen);
  function readAcc(i) {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const cs = CT_SIZE[a.componentType], n = CT_N[a.type];
    const stride = bv.byteStride || cs * n;
    const out = new Float32Array(a.count * n);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
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
    const idx = ia.componentType === 5125 ? new Uint32Array(ia.count) : new Uint16Array(ia.count);
    for (let k = 0; k < ia.count; k++) {
      idx[k] = ia.componentType === 5125 ? binView.getUint32(base + k * 4, true) : binView.getUint16(base + k * 2, true);
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/* ---- 场景 ---- */
const canvas = document.getElementById('c');
// ⚠️ preserveDrawingBuffer 必须为 true：headless 的 Page.captureScreenshot
//    不合成 WebGL 图层，drawing buffer 在合成后就被丢弃，截图会是纯背景色。
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(${W}, ${PH}, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x${BG.toString(16)}, 1);

// ⚠️ scene.background 一定不要设成 Color：three 的 WebGLBackground 对颜色背景
//    会置 forceClear=true，第二次 render 就把前一条面板擦掉了。
//    改成手动清一次 + autoClear=false。
const scene = new THREE.Scene();
renderer.autoClear = false;

// 三视图要从三个方向都看得清，所以布光绕一圈（不然背面那条全黑）
const key   = new THREE.DirectionalLight(0xfff4e8, 1.9); key.position.set(1.4, 2.2, 2.6);
const back  = new THREE.DirectionalLight(0xffe6cc, 1.1); back.position.set(-0.9, 1.8, -2.6);
const left  = new THREE.DirectionalLight(0xdce8ff, 0.8); left.position.set(-2.6, 0.9, 0.7);
const right = new THREE.DirectionalLight(0xdce8ff, 0.8); right.position.set(2.6, 0.9, -0.7);
scene.add(key, back, left, right, new THREE.AmbientLight(0xffffff, 0.62));

// ⚠️ 必须是真正的 OrthographicCamera 并写 left/right/top/bottom：
//    对基类 THREE.Camera 调 makeOrthographic() 无效，渲染器会按透视重算。
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 40);
const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 });
let mesh = null;

const VIEWS = [
  { dir: new THREE.Vector3(0, 0, 1) },    // 正面：模型朝 +Z
  { dir: new THREE.Vector3(1, 0, 0) },    // 侧面
  { dir: new THREE.Vector3(0, 0, -1) },   // 背面
];

window.__shoot = async (url, meta) => {
  try {
    const res = await fetch(url);
    const geo = parseGlb(await res.arrayBuffer());
    geo.computeBoundingBox();
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);

    document.getElementById('tName').textContent = meta.title;
    document.getElementById('tMeta').textContent = meta.sub;

    const box = geo.boundingBox;
    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    const viewH = size.y * 1.12;              // 留 12% 上下余量
    const T = 6;                              // 正交投影下距离只影响裁剪，不影响大小

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, ${W}, ${PH});
    renderer.clear();

    renderer.setScissorTest(true);
    const aspect = ${PW} / ${PH};
    const tris = [];
    for (let i = 0; i < 3; i++) {
      const x = i * ${PW};
      renderer.setViewport(x, 0, ${PW}, ${PH});
      renderer.setScissor(x, 0, ${PW}, ${PH});
      cam.left = -viewH * aspect / 2; cam.right = viewH * aspect / 2;
      cam.top = viewH / 2; cam.bottom = -viewH / 2;
      cam.updateProjectionMatrix();
      const d = VIEWS[i].dir;
      cam.position.set(ctr.x + d.x * T, ctr.y + d.y * T, ctr.z + d.z * T);
      cam.up.set(0, 1, 0);
      cam.lookAt(ctr.x, ctr.y, ctr.z);
      cam.updateMatrixWorld(true);
      renderer.render(scene, cam);
      tris.push(renderer.info.render.triangles);
    }
    renderer.setScissorTest(false);
    return { ok: true, h: size.y, tris, lost: renderer.getContext().isContextLost() };
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) };
  }
};
window.__READY = true;
</script></body></html>`;
}

async function cdp(wsUrl) {
  const WS = globalThis.WebSocket;
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

/** 面板像素统计：我看不到图，只能用数字判断"这一条到底画上没有" */
function panelStats(png, i) {
  const bg = [(BG >> 16) & 255, (BG >> 8) & 255, BG & 255];
  let n = 0, ink = 0;
  const colors = new Set();
  const x0 = i * PW, x1 = x0 + PW;
  for (let y = HEADER; y < png.height; y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      const p = (png.width * y + x) << 2;
      const r = png.data[p], g = png.data[p + 1], b = png.data[p + 2];
      n++;
      if (Math.abs(r - bg[0]) > 10 || Math.abs(g - bg[1]) > 10 || Math.abs(b - bg[2]) > 10) {
        ink++;
        colors.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
      }
    }
  }
  return { pct: (ink / n) * 100, colors: colors.size };
}

async function main() {
  const argv = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const wanted = argv.length ? argv : ROSTER.map((r) => r.file);
  const models = ROSTER.filter((r) => wanted.includes(r.file));
  if (!models.length) throw new Error('没有匹配的角色：' + wanted.join(','));

  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-sheet-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars',
    // ⚠️ 必须是 --use-angle=swiftshader：--use-gl=swiftshader 会让上下文丢失（画面全黑）
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let conn = null, srv = null;
  try {
    let ver = null;
    for (let i = 0; i < 60; i++) { try { ver = await getJSON('/json/version'); break; } catch { await sleep(250); } }
    if (!ver) throw new Error('Chrome DevTools 起不来');
    const targets = await getJSON('/json/list');
    const page = targets.find((t) => t.type === 'page');
    conn = await cdp(page.webSocketDebuggerUrl);
    await conn.send('Page.enable');
    await conn.send('Runtime.enable');
    // 固定视口，别依赖 --window-size（headless 下它不一定等于 CSS 视口）
    await conn.send('Emulation.setDeviceMetricsOverride',
      { width: W, height: HEADER + PH, deviceScaleFactor: 1, mobile: false });

    // ⚠️ 页面不能用 file:// 直接 fetch 本地 GLB（同源策略会拦），
    //    所以起一个最小 HTTP 服务把 models2 挂上去。
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

    await conn.send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const t = await conn.send('Runtime.evaluate', { expression: '!!window.__READY && typeof window.__shoot', returnByValue: true });
      if (t.result?.result?.value === 'function') { ready = true; break; }
    }
    if (!ready) throw new Error('页面里 __shoot 没就绪（three 内联脚本可能报错了）');

    const problems = [];
    for (const r of models) {
      const glb = path.join(MODELS, r.file + '.glb');
      if (!fs.existsSync(glb)) { problems.push(`${r.file} 缺少 GLB`); continue; }
      const tris = triCount(glb);
      const meta = {
        title: `${r.name} · ${r.role}`,
        sub: `${r.tier} 档 · ${r.h.toFixed(2)} m · ${r.heads.toFixed(2)} 头身 · ${tris.toLocaleString('en-US')} 三角面`,
      };
      const res = await conn.send('Runtime.evaluate', {
        expression: `window.__shoot(${JSON.stringify(`http://127.0.0.1:${pagePort}/glb/${r.file}.glb`)}, ${JSON.stringify(meta)})`,
        awaitPromise: true, returnByValue: true,
      });
      const info = res.result?.result?.value;
      if (!info?.ok) { problems.push(`${r.file}: ${info?.err}`); continue; }
      if (info.lost) { problems.push(`${r.file}: WebGL 上下文丢失`); continue; }

      const shot = await conn.send('Page.captureScreenshot', { format: 'png' });
      const png = PNG.sync.read(Buffer.from(shot.result.data, 'base64'));

      const stats = [0, 1, 2].map((i) => panelStats(png, i));
      for (let i = 0; i < 3; i++) {
        const nm = ['正面', '侧面', '背面'][i];
        if (stats[i].pct < 3) problems.push(`${r.file} ${nm}面板只着色 ${stats[i].pct.toFixed(2)}%（没画上）`);
        if (stats[i].colors < 80) problems.push(`${r.file} ${nm}面板只有 ${stats[i].colors} 种颜色（不像 3D 模型）`);
      }

      const out = path.join(OUT, r.file + '-sheet.jpg');
      const raw = { data: Buffer.from(png.data), width: png.width, height: png.height };
      fs.writeFileSync(out, jpeg.encode(raw, 92).data);
      const kb = (fs.statSync(out).size / 1024).toFixed(0);
      console.log(`  ✓ ${r.file.padEnd(18)} ${kb.padStart(4)}KB  ` +
        stats.map((s, i) => `${['正', '侧', '背'][i]}${s.pct.toFixed(1)}%/${s.colors}色`).join('  '));
    }

    if (problems.length) {
      console.log('\n  ✗ 有问题：');
      for (const p of problems) console.log('      ' + p);
      process.exitCode = 1;
    } else {
      console.log(`\n完成：${models.length} 个角色 → assets/preview/sheets/`);
    }
  } finally {
    try { conn?.close(); } catch { /* ignore */ }
    try { srv?.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });

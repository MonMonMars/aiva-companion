#!/usr/bin/env node
/**
 * 在真实浏览器里加载并渲染一个 GLB，然后**用数字**回答三个问题：
 *   1. GLTFLoader 能不能解析（贴图解码成功吗？偏移漂移会在这里炸）
 *   2. 有没有真的画出来（画面不是空屏 —— 统计非背景像素占比）
 *   3. 贴图有没有生效（不是纯色剪影 —— 统计颜色离散度）
 *
 * 为什么非得进浏览器：Node 里 three 只能走 GLTFLoader.parse 的**几何**部分，
 * 贴图解码要靠 ImageBitmap/Image，Node 没有；而"文件能打开但贴图全错位"这类
 * 静默错误（我踩过一次，7/8 张图坏掉）只有真解码才暴露。
 * 而且我读不了 PNG（Read 一直返回 does not support images），
 * 所以只能让页面自己把像素统计出来。
 *
 * 用法：node tools/web-check-glb.mjs [glb路径]
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const GLB = path.resolve(process.argv[2] || path.join(ROOT, 'assets', 'models2', 'kizuna-kamatte.glb'));
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.WEB_PORT || 8731);
const CDP_PORT = Number(process.env.CDP_PORT || 9412);

// ---------------------------------------------------------------------------
// 静态服务器：把 three 的 ESM 产物和 GLB 喂给页面
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary', '.png': 'image/png',
};
const vendor = {
  '/vendor/three.module.js': path.join(THREE_DIR, 'build', 'three.module.js'),
  '/vendor/three.core.js': path.join(THREE_DIR, 'build', 'three.core.js'),
  '/vendor/loaders/GLTFLoader.js': path.join(THREE_DIR, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'),
  '/vendor/utils/BufferGeometryUtils.js': path.join(THREE_DIR, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'),
  '/vendor/utils/SkeletonUtils.js': path.join(THREE_DIR, 'examples', 'jsm', 'utils', 'SkeletonUtils.js'),
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>glb check</title>
<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
</head><body style="margin:0;background:#123">
<div id="log"></div>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/loaders/GLTFLoader.js';
const out = { ok:false };
window.__done = false;
const say = (s) => { document.getElementById('log').textContent += s + '\\n'; };
try {
  const buf = await (await fetch('/model.glb')).arrayBuffer();
  out.bytes = buf.byteLength;

  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
  renderer.setSize(600, 800);
  renderer.setClearColor(0x112233, 1);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 600/800, 0.1, 100);
  camera.position.set(0, 1.55, 3.2);
  camera.lookAt(0, 1.45, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6); dir.position.set(0.6, 2, 2.4); scene.add(dir);

  // ⚠️ 千万别把 gltf 塞进 out —— GLTFParser 是循环引用，
  //    JSON.stringify 会直接抛 "Converting circular structure to JSON"（踩过）。
  const g = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
  const root = g.scene;

  // ---- 结构统计 ----
  let tris=0, verts=0, meshCount=0, skinned=0, withMap=0, texBad=0;
  const texDims = [];
  const morphDicts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshCount++;
    if (o.isSkinnedMesh) skinned++;
    const geo = o.geometry;
    verts += geo.attributes.position.count;
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map) {
        withMap++;
        const img = m.map.image;
        // 解码失败的图：image 存在但宽高为 0（或压根没有 image）
        const w = img?.width || 0, h = img?.height || 0;
        if (!w || !h) { texBad++; texDims.push('DECODE_FAIL'); }
        else texDims.push(w + 'x' + h);
      }
    }
    if (o.morphTargetDictionary) morphDicts.push(Object.keys(o.morphTargetDictionary));
  });
  out.meshCount = meshCount; out.skinned = skinned;
  out.tris = tris; out.verts = verts;
  out.texturedMaterials = withMap; out.textureDecodeFail = texBad;
  out.textureDims = [...new Set(texDims)];
  out.morphNames = morphDicts[0] || [];
  out.morphMeshCount = morphDicts.length;

  // ---- 摆到画面里（和 App 的 attachModel 同款逻辑）----
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  out.bboxSize = [ +size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3) ];
  const scale = 2.05 / size.y;
  root.scale.setScalar(scale);
  root.position.set(-center.x*scale, -box.min.y*scale, -center.z*scale);
  scene.add(root);

  // 试一下表情：张嘴 + 眨眼，看 influence 有没有被写进去
  if (morphDicts.length) {
    root.traverse((o) => {
      if (!o.isMesh || !o.morphTargetDictionary) return;
      const d = o.morphTargetDictionary;
      if (d.jawOpen != null) o.morphTargetInfluences[d.jawOpen] = 0.8;
      if (d.eyeBlinkLeft != null) o.morphTargetInfluences[d.eyeBlinkLeft] = 1;
      if (d.eyeBlinkRight != null) o.morphTargetInfluences[d.eyeBlinkRight] = 1;
    });
    out.morphApplied = true;
  }

  renderer.render(scene, camera);
  out.renderInfo = { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls };

  // ---- 像素统计：我看不到图，就让页面把图"算"出来 ----
  const gl = renderer.getContext();
  const W = renderer.domElement.width, H = renderer.domElement.height;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // readPixels 原点在左下，getBoundingBox 时 y 要翻过来
  const bg = [0x11, 0x22, 0x33];
  let nonBg = 0, minX = W, maxX = -1, minY = H, maxY = -1;
  const colors = new Set();
  let sumSat = 0, sumLum = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = px[i], gg = px[i+1], b = px[i+2];
      if (Math.abs(r-bg[0]) + Math.abs(gg-bg[1]) + Math.abs(b-bg[2]) > 24) {
        nonBg++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        sumSat += (mx - mn); sumLum += (r*0.299 + gg*0.587 + b*0.114);
        // 量化到 5 位，避免抗锯齿把直方图冲爆
        colors.add(((r>>3)<<10) | ((gg>>3)<<5) | (b>>3));
      }
    }
  }
  out.canvas = { W, H };
  out.coverage = +(nonBg / (W * H) * 100).toFixed(2);       // 画面占比 %
  out.distinctColors = colors.size;
  out.meanSaturation = +(sumSat / Math.max(1, nonBg)).toFixed(1);
  out.meanLuminance = +(sumLum / Math.max(1, nonBg)).toFixed(1);
  // readPixels 的 y 轴朝上，转成"从上往下"的常规坐标
  out.silhouetteTop = +(100 - maxY / H * 100).toFixed(1);
  out.silhouetteBottom = +(100 - minY / H * 100).toFixed(1);
  out.silhouetteLeft = +(minX / W * 100).toFixed(1);
  out.silhouetteRight = +(maxX / W * 100).toFixed(1);

  out.ok = true;
} catch (e) {
  out.error = String(e && e.stack || e);
  say('ERR ' + out.error);
}
window.__result = out; window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] }); return res.end(PAGE);
  }
  if (u === '/model.glb') {
    res.writeHead(200, { 'Content-Type': MIME['.glb'], 'Content-Length': fs.statSync(GLB).size });
    return res.end(fs.readFileSync(GLB));
  }
  if (vendor[u]) {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    return res.end(fs.readFileSync(vendor[u]));
  }
  res.writeHead(404); res.end('nope');
});

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
/** 页面里的 console.* 和未捕获异常 —— 模块脚本报错不会进 __result，只能靠这里看 */
const consoleLog = [];
async function cdp(wsUrl) {
  const sock = new WebSocket(wsUrl);
  const waiters = new Map(); let idc = 0;
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLog.push(`[${msg.params.type}] ` + (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Log.entryAdded') {
      consoleLog.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLog.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description
        || msg.params.exceptionDetails?.text || ''));
    }
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'glbchk-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=600,800', 'about:blank',
], { stdio: 'ignore' });

let result = null;
try {
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await getJSON('/json/version'); } catch { await sleep(200); }
  }
  if (!version) throw new Error('DevTools 端口没起来');

  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

  // WebGL 软渲染 + 7.8MB 解析，给足时间
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await c.send('Runtime.evaluate', {
      expression: 'window.__done === true', returnByValue: true,
    });
    if (r.result?.result?.value) break;
  }
  const r = await c.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__result || {ok:false,error:"__result 没写"})',
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    consoleLog.push('[evaluate] ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  result = JSON.parse(r.result?.result?.value || '{}');
  // 页面里的日志只在失败时打 —— 成功时它们是噪音
  if (!result?.ok && consoleLog.length) {
    console.log('\n--- 页面控制台 ---');
    for (const l of consoleLog.slice(0, 25)) console.log('  ' + l.slice(0, 300));
    console.log('---\n');
  }
  c.close();
} catch (e) {
  console.error('检查失败：', e.message);
  if (consoleLog.length) {
    console.log('\n--- 页面控制台 ---');
    for (const l of consoleLog.slice(0, 25)) console.log('  ' + l.slice(0, 300));
  }
  process.exitCode = 1;
} finally {
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// 判卷
// ---------------------------------------------------------------------------
if (!result || !result.ok) {
  console.log('\n❌ 页面里就失败了：\n', result?.error || result);
  process.exit(1);
}

console.log(`\n=== ${path.basename(GLB)} 浏览器实测 ===\n`);
console.log(`  几何：${result.tris.toLocaleString()} 三角面 / ${result.verts.toLocaleString()} 顶点`);
console.log(`  网格：${result.meshCount} 个（其中骨骼网格 ${result.skinned} 个）`);
console.log(`  包围盒：${result.bboxSize.join(' × ')}`);
console.log(`  材质贴图：${result.texturedMaterials} 个带 map，解码失败 ${result.textureDecodeFail} 个`);
console.log(`  贴图尺寸：${result.textureDims.join(' / ')}`);
console.log(`  表情：${result.morphNames.length} 个形状（${result.morphMeshCount} 个网格）`);
console.log(`  渲染：${result.renderInfo.triangles.toLocaleString()} 三角面 / ${result.renderInfo.calls} draw call`);
console.log(`\n  画面占比：${result.coverage}%（非背景像素）`);
console.log(`  剪影范围：上 ${result.silhouetteTop}% 下 ${result.silhouetteBottom}% 左 ${result.silhouetteLeft}% 右 ${result.silhouetteRight}%`);
console.log(`  颜色数：${result.distinctColors} 种 · 平均饱和度 ${result.meanSaturation} · 平均亮度 ${result.meanLuminance}`);

let pass = 0, fail = 0;
const ok = (c, label, detail = '') => {
  if (c) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};
console.log('');
ok(result.textureDecodeFail === 0 && result.texturedMaterials > 0,
  `${result.texturedMaterials} 张贴图全部解码成功`, result.textureDims.join(' / '));
ok(result.coverage > 3, `画面不是空的（占比 ${result.coverage}%）`);
ok(result.coverage < 60, `没有糊满屏（占比 ${result.coverage}%）`, '说明相机距离合理');
ok(result.distinctColors > 500, `颜色数 ${result.distinctColors}（>500 说明贴图生效，不是纯色剪影）`);
ok(result.meanSaturation > 8, `平均饱和度 ${result.meanSaturation}（>8 说明有色，不是灰模）`);
ok(result.renderInfo.triangles > 1000, `实际提交 ${result.renderInfo.triangles.toLocaleString()} 个三角面`);
ok(result.morphNames.length >= 24, `表情 ${result.morphNames.length} 个`);
ok(result.skinned > 0, `${result.skinned} 个骨骼网格（rigDriver 可用）`);
const top = result.silhouetteTop, bottom = result.silhouetteBottom;
ok(top > -5 && bottom < 105, '剪影在画面内（没被裁掉）', `上 ${top}% 下 ${bottom}%`);

console.log(`\n=== ${fail === 0 ? '全部通过' : `${fail} 项失败`} · ${pass} 项通过 ===\n`);
process.exit(fail === 0 ? 0 : 1);

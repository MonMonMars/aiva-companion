// mh-facesolve.mjs —— 给 MakeHuman 面部骨做"符号/幅度体检"
// ===========================================================================
// 为什么需要这个：
//   对照表里的每条 {v:骨名, axis:'x', k:8.5, sign:-1}，里面的 axis/sign/k 如果靠猜，
//   结果就是"通道接上了但脸动错方向"——比如闭眼写成了睁眼、笑写成了哭。
//   这里直接**量**：把骨头某个轴 +6°，看它带动的皮肤往哪动多少毫米。
//
// 做法：
//   1. 取身体 SkinnedMesh，用 three 自带的 applyBoneTransform 做 CPU 蒙皮。
//   2. 一根骨的"影响顶点集合" = 它**及其所有后代骨**权重 >0 的顶点。
//      ⚠️ 只用骨自身是不够的：MakeHuman 里有一批纯枢纽骨（special01/03/04、
//      tongue00）自己没有蒙皮权重，只带子节点，必须从整棵子树取。
//   3. 分别对 x/y/z 各转 ±6°，算受影响顶点的世界坐标位移均值（毫米）。
//   4. 顺便打印受影响区域的中心点，用来判断这块皮在解剖上是哪儿
//      （已知：头骨中心 y≈1.5453 / 眼球 y≈1.5768 z≈0.127 / 嘴 y≈1.52）。
//
// 用法: node tools/mh-facesolve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4760);
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/mh-preview2.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhface-${Date.now()}`,
  '--window-size=900,900', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(400);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); page = l.find((t) => t.type === 'page'); } catch {}
}
if (!page) { console.error('无法连接 Chrome'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); process.exit(1); }

// 要体检的骨（只用左侧，右侧按名字后缀镜像）
const CANDS = [
  'jaw',
  'levator02L', 'levator03L', 'levator04L', 'levator05L', 'levator06L',
  'oris01', 'oris02', 'oris03L', 'oris04L', 'oris05', 'oris06', 'oris06L', 'oris07L',
  'orbicularis03L', 'orbicularis04L',
  'oculi01L', 'oculi02L',
  'temporalis01L', 'temporalis02L',
  'risorius02L', 'risorius03L',
  'special01', 'special03', 'special04', 'special05L', 'special06L',
  'tongue00',
];

const script = `(()=>{
  const T = window.__dbg.THREE_NS;
  let sceneRoot = null;
  window.__dbg.walk(o => { if (!sceneRoot) { let r = o; while (r.parent) r = r.parent; sceneRoot = r; } });
  if (!sceneRoot) return JSON.stringify({ err: 'no scene' });

  // 身体 SkinnedMesh：
  // ⚠️ 不能简单"取顶点最多"——第一版就这么干，结果选到了头发
  //    （AIVA_HairAnime 49728 顶点，比身体还多），量出来的全是头发的位移。
  //    所以先按名字排除明显不是身体的部件，再在剩下的里挑顶点最多的。
  const SKIP = /hair|eye|lash|brow|cloth|wear|outfit|uniform|teeth|tongue/i;
  const all = [];
  window.__dbg.walk(o => {
    if (o.isSkinnedMesh && o.skeleton) {
      all.push({ o, n: o.name, v: o.geometry.attributes.position.count });
    }
  });
  const cand = all.filter(x => !SKIP.test(x.n || ''));
  const pool = cand.length ? cand : all;
  let body = null;
  for (const c of pool) if (!body || c.v > body.geometry.attributes.position.count) body = c.o;
  if (!body) return JSON.stringify({ err: 'no skinned mesh' });

  const sk = body.skeleton;
  const bones = sk.bones;
  const boneIdx = new Map(bones.map((b, i) => [b.name, i]));
  const byName = new Map(bones.map((b) => [b.name, b]));

  const pos = body.geometry.attributes.position;
  const si = body.geometry.attributes.skinIndex;
  const sw = body.geometry.attributes.skinWeight;
  const NV = pos.count;

  // --- 每根骨的影响顶点（含后代）-------------------------------------
  function subtreeSet(bone) {
    const out = new Set();
    (function walk(b) {
      out.add(b.name);
      for (const c of b.children) walk(c);
    })(bone);
    return out;
  }

  function vertsOf(boneName, cap = 48) {
    const set = subtreeSet(byName.get(boneName));
    const wanted = new Set();
    for (const n of set) { const i = boneIdx.get(n); if (i !== undefined) wanted.add(i); }
    if (!wanted.size) return [];
    const hit = [];
    for (let v = 0; v < NV; v++) {
      let ok = false;
      for (let k = 0; k < 4; k++) {
        if (sw.getComponent(v, k) > 0.02 && wanted.has(si.getComponent(v, k))) { ok = true; break; }
      }
      if (ok) hit.push(v);
      if (hit.length >= cap * 12) break;   // 够采样就行，不必扫全场
    }
    // 均匀抽样，避免都挤在同一处
    const step = Math.max(1, Math.floor(hit.length / cap));
    return hit.filter((_, i) => i % step === 0).slice(0, cap);
  }

  // ⚠️ applyBoneTransform 是**把 target 当输入**的：
  //    three 内部第一步是 _baseVector.set( ...target, 1 )，也就是拿调用前 target 的
  //    值当顶点位置；传 0 进去就变成"从原点开始蒙皮"。
  //    第一版写成 _v.set(0,0,0) 再调，量出来的是骨骼原点的位移（配合 6° 出现
  //    80mm 级的"位移"，换算臂长 0.76m 明显离谱），而 local 坐标也全是 1e-9。
  //    正确写法跟 three 自己的 getVertexPosition 一致：先从属性里读顶点。
  function worldOf(idx) {
    const v = new T.Vector3().fromBufferAttribute(pos, idx);
    body.applyBoneTransform(idx, v);
    return body.localToWorld(v);
  }

  // ⚠️ 顺序：**先**刷世界矩阵，**再** skeleton.update()。
  //    skeleton.update() 是拿 bone.matrixWorld × boneInverse 算 boneMatrices 的，
  //    反过来写就会用上一帧的旧矩阵，测出来是滞后一拍的错值。
  function snapshot(idxList) {
    sceneRoot.updateMatrixWorld(true);
    sk.update();
    return idxList.map((i) => worldOf(i));
  }

  const out = {
    body: body.name,
    skinnedMeshes: all.map(x => x.n + '(' + x.v + ')'),
    skippedAsPart: all.filter(x => SKIP.test(x.n || '')).map(x => x.n),
    probe: null,
    rows: [],
  };
  {
    // 自检：取一个顶点看世界坐标是否落在人体该在的范围内（脚 0 ~ 头顶 ~1.7m）。
    // 第一版所有行的中心点都是 [0,0,0]，就是这里露的馅 —— 说明 our           // localToWorld 链路不对，后面的位移数据全不可信。
    sceneRoot.updateMatrixWorld(true); sk.update();
    const p0 = worldOf(0);
    const p1 = worldOf(Math.floor(NV / 2));
    const raw0 = new T.Vector3().fromBufferAttribute(pos, 0);
    const raw1 = new T.Vector3().fromBufferAttribute(pos, Math.floor(NV / 2));
    // 只做到 applyBoneTransform（仍在 local 空间，没过 localToWorld）
    const local0 = (() => { const v = new T.Vector3(); v.set(0, 0, 0); body.applyBoneTransform(0, v); return v.toArray(); })();
    out.probe = {
      bodyScale: body.getWorldScale(new T.Vector3()).toArray(),
      bodyPos: body.getWorldPosition(new T.Vector3()).toArray(),
      bindMode: body.bindMode,
      bindMatrixIsIdentity: body.bindMatrix.equals(new T.Matrix4()),
      v0: p0.toArray(), vMid: p1.toArray(),
      raw0: raw0.toArray(), raw1: raw1.toArray(),
      local0,
      si0: [si.getX(0), si.getY(0), si.getZ(0), si.getW(0)],
      sw0: [sw.getX(0), sw.getY(0), sw.getZ(0), sw.getW(0)],
      bbox: (() => { body.computeBoundingBox?.(); const b = body.geometry.boundingBox; return b ? [b.min.toArray(), b.max.toArray()] : null; })(),
    };
  }

  for (const name of ${JSON.stringify(CANDS)}) {
    const bone = byName.get(name);
    if (!bone) { out.rows.push({ n: name, err: '找不到这根骨' }); continue; }
    const idxList = vertsOf(name);
    if (!idxList.length) { out.rows.push({ n: name, err: '这根骨及后代没有任何蒙皮权重（纯枢纽，动了只影响子节点骨骼）' }); continue; }

    const rest = snapshot(idxList);
    const cen = rest.reduce((a, p) => [a[0] + p.x / rest.length, a[1] + p.y / rest.length, a[2] + p.z / rest.length], [0, 0, 0]);

    const save = bone.rotation.clone();
    const res = {};
    for (const ax of ['x', 'y', 'z']) {
      bone.rotation.copy(save);
      bone.rotation[ax] = save[ax] + 6 * Math.PI / 180;
      const moved = snapshot(idxList);
      let dx = 0, dy = 0, dz = 0, mx = 0;
      for (let i = 0; i < moved.length; i++) {
        const d = moved[i].clone().sub(rest[i]);
        dx += d.x / moved.length; dy += d.y / moved.length; dz += d.z / moved.length;
        mx = Math.max(mx, d.length());
      }
      res[ax] = [+(dx * 1000).toFixed(2), +(dy * 1000).toFixed(2), +(dz * 1000).toFixed(2), +(mx * 1000).toFixed(2)];
    }
    bone.rotation.copy(save);
    snapshot(idxList);   // 复位并刷新矩阵

    out.rows.push({
      n: name,
      fan: idxList.length,
      // 这块皮的中心（用来判断解剖部位）
      at: [+cen[0].toFixed(4), +cen[1].toFixed(4), +cen[2].toFixed(4)],
      // +6° 时受影响皮肤的位移均值 / 最大位移，单位毫米：[dX,dY,dZ,max]
      x: res.x, y: res.y, z: res.z,
    });
  }
  return JSON.stringify(out, null, 1);
})()`;

console.log(await ev(script));
srv.close(); chrome.kill(); process.exit(0);

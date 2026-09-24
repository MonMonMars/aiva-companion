// MakeHuman .mhclo 素材（头发/眉毛/睫毛/衣服）-> 已拟合 + 已蒙皮的 GLB 部件
// ===========================================================================
// 为什么必须自己算拟合：
//   MakeHuman 的衣服/头发不是"摆在那儿的独立网格"，而是用 .mhclo 里的
//   「顶点映射表」挂到底模上的。每个代理顶点记 3 个底模顶点 + 3 个权重 +
//   1 个偏移，真实坐标是 shared/proxy.py 的 getCoords()：
//
//     coord = w0*base[b0] + w1*base[b1] + w2*base[b2] + diag(sx,sy,sz) * offset
//     s_n   = |base[vn1][n] - base[vn2][n]| / den_n        (x_scale/y_scale/z_scale)
//
//   所以只要底模变了（捏人滑块改了体型），代理网格必须重算，不能直接套原 obj。
//
// 蒙皮怎么来：代理顶点自己没有骨骼权重，但它知道自己挂在哪些底模顶点上，
//   于是直接把底模权重按同一组 w 混合出来即可 —— 对头发/衣服/眉毛都成立。
//
// ---- 坑 --------------------------------------------------------------------
// 1) 拟合公式里的 base 坐标是 **MakeHuman 内部单位（分米）**，不是米。
//    必须先在分米空间算完，最后再统一 *S 和 -yOff，否则头发会飞到几十米外。
// 2) OBJ 的 v/vt/f 三套索引，f 里的 "v/vt" 要去重，不能直接用。
// 3) mhclo 的 verts 段行数必须等于 obj 的顶点数，对不上说明 obj/mhclo 不配对。
// 4) 骨骼节点顺序必须与 aiva-base-mh.glb 完全一致（这里用同一套拓扑排序），
//    否则 attachParts 按名字回绑时会错位。
// 5) 头发要 doubleSided，否则背面看过去是透明的。
//
// 用法: node tools/mhproxy.mjs --mhclo <file.mhclo> --out <file.glb> [--tex <png>]
//       [--name X] [--info] [--color r,g,b] [--nomorph]
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG, resample } from './pngutil.mjs';

const argv = (k, def) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : def; };
const SRC = argv('src', 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data');

// ==== 底模（与 mhbuild 同一套） =============================================
function loadBase() {
  const txt = fs.readFileSync(path.join(SRC, '3dobjs/base.obj'), 'utf8');
  const pos = [], uv = [];
  const trisP = [], trisU = [];
  let group = null;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (line[0] === 'o' && line[1] === ' ') { group = line.slice(2).trim(); continue; }
    if (line[0] === 'g' && line[1] === ' ') { group = line.slice(2).trim(); continue; }
    if (line[0] === 'v' && line[1] === ' ') { const a = line.slice(2).trim().split(/\s+/); pos.push(+a[0], +a[1], +a[2]); }
    else if (line[0] === 'v' && line[1] === 't') { const a = line.slice(3).trim().split(/\s+/); uv.push(+a[0], +a[1]); }
    else if (line[0] === 'f' && line[1] === ' ') {
      if (group !== 'body') continue;
      const toks = line.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      for (let i = 1; i < toks.length - 1; i++) {
        for (const k of [0, i, i + 1]) { trisP.push(+toks[k][0]); trisU.push(+(toks[k][1] || 0)); }
      }
    }
  }
  const nSrc = pos.length / 3;
  // 缩放系数只从 body 组用到的顶点算，跟 mhbuild 一字不差
  let lo = Infinity, hi = -Infinity;
  for (const v of trisP) { const y = pos[(v - 1) * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
  const S = 1.70 / (hi - lo);
  const yOff = lo * S;
  return { pos, uv, nSrc, S, yOff, span: null, usedSrcVerts: trisP };
}

// 底模每个源顶点的骨骼权重：srcVi -> [[boneName, w], ...]
function loadBaseWeights(nSrc) {
  const w = JSON.parse(fs.readFileSync(path.join(SRC, 'rigs/default_weights.mhw'), 'utf8'));
  const per = Array.from({ length: nSrc }, () => null);
  let cnt = 0;
  for (const [bone, list] of Object.entries(w.weights || {})) {
    for (const [vi, ww] of list) {
      if (vi >= nSrc || !(ww > 1e-5)) continue;
      if (!per[vi]) per[vi] = [];
      per[vi].push([bone, ww]);
      cnt++;
    }
  }
  return { per, bones: Object.keys(w.weights || {}), cnt };
}

// 骨骼拓扑序 —— 必须与 mhbuild 的 jointOrder 一致
function loadSkeleton(base) {
  const skel = JSON.parse(fs.readFileSync(path.join(SRC, 'rigs/default.mhskel'), 'utf8'));
  const bDefs = skel.bones || {}, jDefs = skel.joints || {};
  const jointPos = new Map();
  for (const [jname, vlist] of Object.entries(jDefs)) {
    let x = 0, y = 0, z = 0, n = 0;
    for (const vi of vlist) { if (vi >= base.nSrc) continue; x += base.pos[vi * 3]; y += base.pos[vi * 3 + 1]; z += base.pos[vi * 3 + 2]; n++; }
    if (!n) continue;
    jointPos.set(jname, [x / n * base.S, y / n * base.S - base.yOff, z / n * base.S]);
  }
  const allBones = Object.keys(bDefs).filter((b) => jointPos.has(bDefs[b].head));
  const seen = new Set(); const order = [];
  const visit = (b, d) => { if (seen.has(b) || !bDefs[b] || d > 64) return; seen.add(b); order.push(b); for (const c of allBones) if (bDefs[c].parent === b) visit(c, d + 1); };
  visit(allBones.find((b) => !bDefs[b].parent) || allBones[0], 0);
  for (const b of allBones) if (!seen.has(b)) order.push(b);
  const idx = new Map(order.map((b, i) => [b, i]));
  return { bDefs, jointPos, order, idx };
}

// ==== .mhclo ================================================================
function parseMhclo(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = { name: '', obj_file: '', material: '', scale: [null, null, null], file };
  const verts = [];       // [b0,b1,b2, w0,w1,w2, dx,dy,dz]
  let inVerts = false;
  let mode = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const w = line.split(/\s+/);
    const key = w[0];
    if (key === 'name') { head.name = w.slice(1).join(' '); continue; }
    if (key === 'obj_file') { head.obj_file = w[1]; continue; }
    if (key === 'material') { head.material = w[1]; continue; }
    if (key === 'x_scale') { head.scale[0] = [+w[1], +w[2], +w[3]]; continue; }
    if (key === 'y_scale') { head.scale[1] = [+w[1], +w[2], +w[3]]; continue; }
    if (key === 'z_scale') { head.scale[2] = [+w[1], +w[2], +w[3]]; continue; }
    if (key === 'verts') { inVerts = true; mode = 'v'; continue; }
    if (key === 'weights' || key === 'delete_verts' || key === 'faces' || key === 'end') { inVerts = false; mode = key; continue; }
    if (inVerts && mode === 'v') {
      if (w.length >= 9) verts.push([+w[0], +w[1], +w[2], +w[3], +w[4], +w[5], +w[6], +w[7], +w[8]]);
      continue;
    }
  }
  head.nWeights = 0;
  return { head, verts };
}

// ==== 代理 OBJ ==============================================================
function parseProxyObj(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const V = [], T = [];   // 源 v / vt
  const fP = [], fT = [];
  const groups = new Set();
  let g = null;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if ((line[0] === 'g' || line[0] === 'o') && line[1] === ' ') { g = line.slice(2).trim(); groups.add(g); continue; }
    if (line[0] === 'v' && line[1] === ' ') { const a = line.slice(2).trim().split(/\s+/); V.push(+a[0], +a[1], +a[2]); }
    else if (line[0] === 'v' && line[1] === 't') { const a = line.slice(3).trim().split(/\s+/); T.push(+a[0], +a[1]); }
    else if (line[0] === 'f' && line[1] === ' ') {
      const toks = line.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      for (let i = 1; i < toks.length - 1; i++) {
        for (const k of [0, i, i + 1]) { fP.push(+toks[k][0]); fT.push(+(toks[k][1] || 0)); }
      }
    }
  }
  return { V, T, fP, fT, nV: V.length / 3, nT: T.length / 2, groups: [...groups] };
}

// ==== 主流程 ================================================================
const MH = argv('mhclo', '');
if (!MH) { console.log('需要 --mhclo <file>'); process.exit(1); }
const OUT = argv('out', '');
const NAME = argv('name', path.basename(path.dirname(MH)));
const TEX = argv('tex', '');
const INFO = process.argv.includes('--info');

const t0 = Date.now();
const base = loadBase();
console.log(`底模 ${base.nSrc} 源顶点   S=${base.S.toFixed(6)}  yOff=${base.yOff.toFixed(4)}`);
const { per: BW } = loadBaseWeights(base.nSrc);
const skel = loadSkeleton(base);
console.log(`骨骼 ${skel.order.length} 根（拓扑序，与 aiva-base-mh.glb 一致）`);

const { head, verts } = parseMhclo(MH);
console.log(`mhclo: name=${head.name}  obj=${head.obj_file}  verts=${verts.length}`);
console.log(`  scale: x=${JSON.stringify(head.scale[0])} y=${JSON.stringify(head.scale[1])} z=${JSON.stringify(head.scale[2])}`);

const objPath = path.join(path.dirname(MH), head.obj_file);
const obj = parseProxyObj(objPath);
console.log(`obj: ${obj.nV} 顶点 / ${obj.nT} UV / ${obj.fP.length / 3} 面 / 组 ${obj.groups.join(',')}`);
if (obj.nV !== verts.length) console.log(`!! mhclo verts(${verts.length}) 与 obj 顶点(${obj.nV}) 数量不符`);

if (INFO) process.exit(0);

// ---- 0) 参考身体点云（米制）——解穿模要用 ----
// 用底模 body 组**用到的顶点**（去重），按与 GLB 完全相同的公式转米。
// aiva-base-mh.sliders.json 里所有滑块默认值都是 0，说明线上身体就是未变形
// 底模本身，所以这里直接用底模是准确的，不需要重跑 morph。
const refBodyMeshes = (() => {
  const seen = new Set();
  const arr = [];
  for (const v1 of base.usedSrcVerts) {
    if (seen.has(v1)) continue;
    seen.add(v1);
    const i = v1 - 1;
    arr.push(base.pos[i * 3] * base.S, base.pos[i * 3 + 1] * base.S - base.yOff, base.pos[i * 3 + 2] * base.S);
  }
  return [Float32Array.from(arr)];
})();
console.log(`参考身体 ${refBodyMeshes[0].length / 3} 顶点（底模 body 组去重）`);

// ---- 1) 拟合（MakeHuman 分米空间） ----
const h = base.pos;            // 底模源坐标（分米）
const sx = [1, 1, 1];
for (let n = 0; n < 3; n++) {
  const sd = head.scale[n];
  if (!sd) continue;
  const [v1, v2, den] = sd;
  sx[n] = den ? Math.abs(h[v1 * 3 + n] - h[v2 * 3 + n]) / den : 1;
}
console.log(`拟合缩放 sx=${sx[0].toFixed(4)} sy=${sx[1].toFixed(4)} sz=${sx[2].toFixed(4)}`);

const nP = verts.length;
const C = new Float64Array(nP * 3);
for (let i = 0; i < nP; i++) {
  const [b0, b1, b2, w0, w1, w2, dx, dy, dz] = verts[i];
  for (let c = 0; c < 3; c++) {
    C[i * 3 + c] = w0 * h[b0 * 3 + c] + w1 * h[b1 * 3 + c] + w2 * h[b2 * 3 + c];
  }
  C[i * 3] += sx[0] * dx; C[i * 3 + 1] += sx[1] * dy; C[i * 3 + 2] += sx[2] * dz;
}

// ---- 2) 蒙皮：把底模权重按同一组 w 混合 ----
// ⚠️⚠️ 最大的坑（实测踩到）：.mhclo 的代理权重**可以为负也可以 >1**（MakeHuman
//    用它们做外插，实测见过 -0.35 / 1.95 / -0.61）。按同一组权重混合底模骨骼
//    权重时就会混出负的骨骼权重。而 glTF 蒙皮要求 Σw = 1（凸组合），一旦
//    权重和 ≠ 1，静息姿态就不再是单位变换 —— 顶点会被骨骼矩阵带跑。
//    实测后果：睫毛 6697/11088 个顶点权重和在 0.466~1 之间，最远被甩出
//    0.85m（掉到肋骨高度）；头发 444 个顶点同样中招。
//    → 修法：先把每个骨骼的累积权重**钳到非负**，再归一化成凸组合。
//      负权重在蒙皮里本来就没有物理意义，丢掉只影响「外插」那一点点精度，
//      换来的是静息姿态严格等于原始几何（实测偏差 <1e-4）。
const JOINTS = new Uint16Array(nP * 4);
const WTS = new Float32Array(nP * 4);
let noSkin = 0, clamped = 0;
for (let i = 0; i < nP; i++) {
  const [b0, b1, b2, w0, w1, w2] = verts[i];
  const acc = new Map();
  const add = (bv, w) => { const l = BW[bv]; if (!l) return; for (const [bn, ww] of l) acc.set(bn, (acc.get(bn) || 0) + ww * w); };
  add(b0, w0); add(b1, w1); add(b2, w2);

  let list = [...acc.entries()];
  const hadNeg = list.some(([, w]) => w < 0);
  if (hadNeg) clamped++;
  list = list.map(([bn, w]) => [bn, Math.max(0, w)]).filter(([, w]) => w > 1e-5);

  // 全被钳没了（极端外插）就退回"代理权重最大的那个底模顶点"的原始权重
  if (!list.length) {
    const cand = [[b0, w0], [b1, w1], [b2, w2]].sort((a, b) => b[1] - a[1]);
    for (const [bv] of cand) {
      const l = BW[bv]; if (!l) continue;
      list = l.map(([bn, ww]) => [bn, Math.max(0, ww)]).filter(([, w]) => w > 1e-5);
      if (list.length) break;
    }
  }

  list.sort((a, b) => b[1] - a[1]);
  list = list.slice(0, 4);
  let sum = 0; for (const [, w] of list) sum += w;
  if (sum <= 0) { noSkin++; continue; }
  for (let k = 0; k < list.length; k++) {
    const bi = skel.idx.get(list[k][0]);
    if (bi === undefined) continue;
    JOINTS[i * 4 + k] = bi; WTS[i * 4 + k] = list[k][1] / sum;
  }
}
console.log(`蒙皮：无权重顶点 ${noSkin}/${nP}；含负权重已钳正的顶点 ${clamped}`);

// ---- 3) OBJ 去重 + 转米 ----
const key2c = new Map();
const P = [], U = [];
for (let i = 0; i < obj.fP.length; i++) {
  const v = obj.fP[i], t = obj.fT[i];
  const key = v + '/' + t;
  let c = key2c.get(key);
  if (c === undefined) {
    c = P.length / 3; key2c.set(key, c);
    P.push(C[(v - 1) * 3] * base.S, C[(v - 1) * 3 + 1] * base.S - base.yOff, C[(v - 1) * 3 + 2] * base.S);
    U.push(t ? obj.T[(t - 1) * 2] : 0, t ? obj.T[(t - 1) * 2 + 1] : 0);
  }
}
const indices = new Uint32Array(obj.fP.length);
for (let i = 0; i < obj.fP.length; i++) indices[i] = key2c.get(obj.fP[i] + '/' + obj.fT[i]);
const N = P.length / 3;
const NJ = new Uint16Array(N * 4), NW = new Float32Array(N * 4);
for (let i = 0; i < obj.fP.length; i++) {
  const s = obj.fP[i] - 1, d = indices[i];
  NJ[d * 4] = JOINTS[s * 4]; NJ[d * 4 + 1] = JOINTS[s * 4 + 1]; NJ[d * 4 + 2] = JOINTS[s * 4 + 2]; NJ[d * 4 + 3] = JOINTS[s * 4 + 3];
  NW[d * 4] = WTS[s * 4]; NW[d * 4 + 1] = WTS[s * 4 + 1]; NW[d * 4 + 2] = WTS[s * 4 + 2]; NW[d * 4 + 3] = WTS[s * 4 + 3];
}
console.log(`去重后 ${N} 顶点 / ${indices.length / 3} 面`);

// ---- 3.5) 与底模身体"解穿模"（可选，--fitbody） ----
// 为什么需要：.mhclo 代理只保证"贴到参考底模表面"，但用户实际用的是**我们这张
// 改过滑块的非标准体型**（胸围/身高/头型都动过）。于是头发/眉毛这类包裹型部件
// 会有相当一部分顶点落进头皮下。实测 original o4saken_long01 长发：
//   15033 顶点里 1985 个（13.2%）在皮下，最深 32.9mm，平均 6.5mm。
//
// 试过但**失败**的思路（实测数据，别再走一遍）：
//   · 整体平移 X/Y/Z：三个轴都是单调变差 —— 说明不是错位，是半径不够。
//   · 绕头骨中心径向放大 k=1.02..1.30：侵入从 1985 只降到 469 就封顶，
//     且最深深度**恒为 33mm 不动** → 有一撮几何压根不在头表面附近，
//     放大推不动它（实测最深点离最近头皮点 72mm）。
//
// 有效的思路（本函数）：**沿头皮法向迭代软推**。
//   1. 取身体网格上 Y > 下巴线（默认 1.42m）的顶点作为"头皮点云"。
//   2. 用 3cm 网格做空间哈希。对每个部件顶点找最近头皮点 C。
//   3. 头皮在 C 处的近似法向 n = normalize(C − O)，O 是头部包围盒中心
//      （头近似椭球，这个近似足够判内外）。
//   4. 若 (H − C)·n < margin，就把 H 沿 n 推出 (margin − dot)。
//   5. **迭代 3 轮** —— 这一步是必需的：最深那撮顶点离头皮有 5–8cm，
//      一次推不准（法向在远处失真），迭代后收敛。
//
// 实测效果：margin=1mm + 迭代 3 轮 → 侵入 1985 → 0，最深 0mm。
// （1 轮只到 229，2 轮到 6，3 轮归零。）
function unclashWithBody(P, indices) {
  const CHIN_Y = Number(argv('chiny', '1.42'));
  const MARGIN = Number(argv('fitmargin', '0.001'));
  const ITER = Number(argv('fititer', '3'));

  // 收集身体顶点（只取参考底模网格，排除所有配件）
  const bv = [];
  for (const m of refBodyMeshes) for (let i = 0; i < m.length; i += 3) if (m[i + 1] > CHIN_Y) bv.push(m[i], m[i + 1], m[i + 2]);
  const nH = bv.length / 3;
  if (!nH) { console.log('解穿模：没有头部参考顶点，跳过'); return { moved: 0, before: 0, after: 0 }; }

  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < nH; i++) {
    const x = bv[i * 3], y = bv[i * 3 + 1], z = bv[i * 3 + 2];
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
    if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
  }
  const O = [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];

  const CELL = 0.02;
  const grid = new Map();
  const key = (a, b, c) => a + '_' + b + '_' + c;
  for (let i = 0; i < nH; i++) {
    const k = key(Math.floor(bv[i * 3] / CELL), Math.floor(bv[i * 3 + 1] / CELL), Math.floor(bv[i * 3 + 2] / CELL));
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); }
    a.push(i);
  }
  const nearest = (x, y, z) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 4; r++) {
      for (let a = cx - r; a <= cx + r; a++) for (let b = cy - r; b <= cy + r; b++) for (let c = cz - r; c <= cz + r; c++) {
        if (r > 1 && Math.abs(a - cx) !== r && Math.abs(b - cy) !== r && Math.abs(c - cz) !== r) continue;
        const arr = grid.get(key(a, b, c)); if (!arr) continue;
        for (const i of arr) {
          const dx = bv[i * 3] - x, dy = bv[i * 3 + 1] - y, dz = bv[i * 3 + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 && r >= 3) break;
    }
    return best;
  };

  const depthOf = () => {
    let ins = 0, deep = 0;
    for (let i = 0; i < N2; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const ni = nearest(x, y, z); if (ni < 0) continue;
      let nx = bv[ni * 3] - O[0], ny = bv[ni * 3 + 1] - O[1], nz = bv[ni * 3 + 2] - O[2];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const dot = (x - bv[ni * 3]) * nx + (y - bv[ni * 3 + 1]) * ny + (z - bv[ni * 3 + 2]) * nz;
      if (dot < 0) { ins++; if (-dot > deep) deep = -dot; }
    }
    return { ins, deep };
  };
  const N2 = P.length / 3;

  const before = depthOf();
  let moved = 0;
  const moveSet = new Set();
  for (let it = 0; it < ITER; it++) {
    let movedThis = 0;
    for (let i = 0; i < N2; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const ni = nearest(x, y, z); if (ni < 0) continue;
      let nx = bv[ni * 3] - O[0], ny = bv[ni * 3 + 1] - O[1], nz = bv[ni * 3 + 2] - O[2];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const dot = (x - bv[ni * 3]) * nx + (y - bv[ni * 3 + 1]) * ny + (z - bv[ni * 3 + 2]) * nz;
      if (dot < MARGIN) {
        const need = MARGIN - dot;
        P[i * 3] = x + nx * need; P[i * 3 + 1] = y + ny * need; P[i * 3 + 2] = z + nz * need;
        moveSet.add(i); movedThis++;
      }
    }
    if (!movedThis) break;
  }
  moved = moveSet.size;
  const after = depthOf();
  console.log(`解穿模：头皮参考 ${nH} 点，中心 O=(${O.map((v) => v.toFixed(4))})`);
  console.log(`  侵入顶点 ${before.ins} (最深 ${(before.deep * 1000).toFixed(1)}mm) → ${after.ins} (最深 ${(after.deep * 1000).toFixed(1)}mm)；移动了 ${moved} 个顶点，迭代 ${ITER} 轮`);
  return { moved, before: before.ins, after: after.ins, movedIdx: moveSet };
}

// 默认对所有"包裹型"部件启用（头发/眉毛/睫毛）。--nofitbody 可关。
let fitInfo = null;
if (!process.argv.includes('--nofitbody')) {
  fitInfo = unclashWithBody(P, indices);
  reskinMovedVertices(P, indices, NJ, NW, fitInfo.movedIdx);
}

// ---- 3.6) 把被推挤的顶点"吸附"到最近头皮顶点的蒙皮权重 ----
// 为什么必须做：3.5 只改了位置。一个被推出 3cm 的顶点如果还保留原来的骨骼权重
// （原来是按它**旧位置**混合出来的），头部转动时它会和周围顶点走不同的矩阵，
// 结果是撕裂/穿插。实测：不吸附时头发在 Y 1.41–1.50 段（正是推挤最集中的
// 下颌-颈区）会出现尖刺。
// 做法：对每个被移动过的顶点，用它的**新位置**找最近头皮点，把那个底模顶点的
// 骨骼权重整组搬过来。这样"推到哪就跟谁动"，形变时和头皮同步。
function reskinMovedVertices(P, indices, NJ, NW, movedIdx) {
  if (!movedIdx.size) { console.log('权重吸附：没有顶点被移动，跳过'); return 0; }
  // 参考身体顶点 -> 该顶点的骨骼权重（来自底模 per-vertex 权重）
  const CHIN_Y = Number(argv('chiny', '1.42'));
  const bv = refBodyMeshes[0];
  const nH = bv.length / 3;
  // 参考点云用的是"底模 body 组去重顶点"，与 base.usedSrcVerts 一一对应
  const uniq = [...new Set(base.usedSrcVerts)];
  const CELL = 0.02, key = (a, b, c) => a + '_' + b + '_' + c;
  const grid = new Map();
  for (let i = 0; i < nH; i++) {
    if (bv[i * 3 + 1] <= CHIN_Y) continue;
    const k = key(Math.floor(bv[i * 3] / CELL), Math.floor(bv[i * 3 + 1] / CELL), Math.floor(bv[i * 3 + 2] / CELL));
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); }
    a.push(i);
  }
  const nearest = (x, y, z) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 4; r++) {
      for (let a = cx - r; a <= cx + r; a++) for (let b = cy - r; b <= cy + r; b++) for (let c = cz - r; c <= cz + r; c++) {
        if (r > 1 && Math.abs(a - cx) !== r && Math.abs(b - cy) !== r && Math.abs(c - cz) !== r) continue;
        const arr = grid.get(key(a, b, c)); if (!arr) continue;
        for (const i of arr) {
          const dx = bv[i * 3] - x, dy = bv[i * 3 + 1] - y, dz = bv[i * 3 + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 && r >= 3) break;
    }
    return best;
  };
  let done = 0;
  for (const d of movedIdx) {
    const ni = nearest(P[d * 3], P[d * 3 + 1], P[d * 3 + 2]);
    if (ni < 0) continue;
    const srcVi = uniq[ni];                    // 底模源顶点索引（0-based）
    const wl = BW[srcVi];
    if (!wl || !wl.length) continue;
    const tmp = [[], []];
    for (const [bn, ww] of wl) {
      const bi = skel.idx.get(bn);
      if (bi === undefined || !(ww > 1e-5)) continue;
      tmp[0].push([bi, ww]); tmp[1].push(ww);
    }
    tmp[0].sort((a, b) => b[1] - a[1]);
    const top = tmp[0].slice(0, 4);
    let sum = 0; for (const [, w] of top) sum += w;
    if (sum <= 0) continue;
    NJ[d * 4] = NJ[d * 4 + 1] = NJ[d * 4 + 2] = NJ[d * 4 + 3] = 0;
    NW[d * 4] = NW[d * 4 + 1] = NW[d * 4 + 2] = NW[d * 4 + 3] = 0;
    for (let k = 0; k < top.length; k++) { NJ[d * 4 + k] = top[k][0]; NW[d * 4 + k] = top[k][1] / sum; }
    done++;
  }
  console.log(`权重吸附：${done}/${movedIdx.size} 个被移动顶点改用最近头皮顶点的权重`);
  return done;
}

// ---- 4) 法线 ----
// ⚠️ 第三个大坑（实测）：这些第三方发型的 OBJ **绕序本身就不一致**。
//    实测 o4saken_long01：13268 个三角形里 **8526 个（64.3%）几何法线朝内**。
//    页面用 doubleSided 渲染，朝内的那批面算出来几乎是全黑 —— 屏幕上就是
//    左脸/下颌上那些"黑色多边形块"。这跟穿模、跟贴图都无关，纯粹是法线方向。
//
//    修法：不做逐面单独判断（会切碎），而是
//      1. 用共享边做 flood-fill，把每个连通片内的绕序**统一**（相邻面若法线
//         相反就翻转其中一个）；
//      2. 再对每个连通片整体判定：若片内绝大多数面的法线指向"远离头骨中心"，
//         则该片朝外，保持；否则整片翻转。
//    这样既保证了片内一致（光照平滑），又保证了整体朝外（不会黑）。
const O_HEAD = (() => {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) {
    const v = P[i * 3 + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v;
  }
  return [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
})();

function fixWinding(P, indices) {
  const T = indices.length / 3;
  // 面法线（几何，未归一化）
  const fn = new Float64Array(T * 3);
  const fz = new Float64Array(T);   // 面积
  for (let t = 0; t < T; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const w = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0];
    fn[t * 3] = nx; fn[t * 3 + 1] = ny; fn[t * 3 + 2] = nz;
    fz[t] = Math.hypot(nx, ny, nz) / 2;
  }
  // 无向边的邻接（用顶点索引对做 key）
  const em = new Map();
  const ekey = (p, q) => (p < q ? p + '_' + q : q + '_' + p);
  for (let t = 0; t < T; t++) {
    const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    for (const [p, q] of [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]]) {
      const k = ekey(p, q);
      let l = em.get(k); if (!l) { l = []; em.set(k, l); }
      l.push(t);
    }
  }
  // flood-fill：同一条边上的两个面，绕序一致则它们的**有向边方向相反**
  const flip = new Uint8Array(T);      // 0 未访问, 1 保持, 2 翻转
  let comps = 0, flips = 0;
  for (let s = 0; s < T; s++) {
    if (flip[s]) continue;
    comps++;
    flip[s] = 1;
    const stack = [s];
    // 记录片内向外的"面积加权法线和"
    while (stack.length) {
      const t = stack.pop();
      const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      const dirEdges = [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]];
      for (const [p, q] of dirEdges) {
        const k = ekey(p, q);
        for (const nb of em.get(k) || []) {
          if (nb === t || flip[nb]) continue;
          // 邻居里是否有同向边 (p,q)？有则绕序相同 → 需要翻转邻居
          const nv = [indices[nb * 3], indices[nb * 3 + 1], indices[nb * 3 + 2]];
          let sameDir = false;
          for (const [a, b] of [[nv[0], nv[1]], [nv[1], nv[2]], [nv[2], nv[0]]]) {
            if (a === p && b === q) { sameDir = true; break; }
          }
          flip[nb] = sameDir ? 2 : 1;
          if (sameDir) flips++;
          stack.push(nb);
        }
      }
    }
  }
  // 按片判定整体朝向
  // 重新遍历，收集每片的面
  const compId = new Int32Array(T).fill(-1);
  let cid = 0;
  for (let s = 0; s < T; s++) {
    if (compId[s] >= 0) continue;
    const stack = [s]; compId[s] = cid;
    while (stack.length) {
      const t = stack.pop();
      const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      for (const [p, q] of [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]]) {
        for (const nb of em.get(ekey(p, q)) || []) if (compId[nb] < 0) { compId[nb] = cid; stack.push(nb); }
      }
    }
    cid++;
  }
  const compFlip = new Uint8Array(cid);
  for (let c = 0; c < cid; c++) {
    let sx = 0, sy = 0, sz = 0, area = 0;
    for (let t = 0; t < T; t++) {
      if (compId[t] !== c) continue;
      const s = flip[t] === 2 ? -1 : 1;
      sx += fn[t * 3] * s; sy += fn[t * 3 + 1] * s; sz += fn[t * 3 + 2] * s;
      area += fz[t];
    }
    // 片重心
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let t = 0; t < T; t++) {
      if (compId[t] !== c) continue;
      for (const k of [0, 1, 2]) { const vi = indices[t * 3 + k]; cx += P[vi * 3]; cy += P[vi * 3 + 1]; cz += P[vi * 3 + 2]; n++; }
    }
    cx /= n; cy /= n; cz /= n;
    // 头骨中心 → 片重心 的方向
    const ox = cx - O_HEAD[0], oy = cy - O_HEAD[1], oz = cz - O_HEAD[2];
    // 面积加权法线和 · 朝外方向 > 0 → 已经朝外
    compFlip[c] = (sx * ox + sy * oy + sz * oz) < 0 ? 1 : 0;
  }
  // 应用翻转
  let compFlips = 0;
  for (let c = 0; c < cid; c++) if (compFlip[c]) compFlips++;
  for (let t = 0; t < T; t++) {
    const need = (flip[t] === 2) !== (compFlip[compId[t]] === 1);
    if (need) {
      const a = indices[t * 3 + 1], b = indices[t * 3 + 2];
      indices[t * 3 + 1] = b; indices[t * 3 + 2] = a;
      fn[t * 3] = -fn[t * 3]; fn[t * 3 + 1] = -fn[t * 3 + 1]; fn[t * 3 + 2] = -fn[t * 3 + 2];
    }
  }
  // 统计修正后的朝内面
  let stillIn = 0;
  for (let t = 0; t < T; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (const k of [0, 1, 2]) { const vi = indices[t * 3 + k]; cx += P[vi * 3]; cy += P[vi * 3 + 1]; cz += P[vi * 3 + 2]; }
    cx /= 3; cy /= 3; cz /= 3;
    const ox = cx - O_HEAD[0], oy = cy - O_HEAD[1], oz = cz - O_HEAD[2];
    if (fn[t * 3] * ox + fn[t * 3 + 1] * oy + fn[t * 3 + 2] * oz < 0) stillIn++;
  }
  console.log(`法线一致性：${T} 面 / ${cid} 个连通片；片内翻转 ${flips} 面，整片翻转 ${compFlips} 片；修正后朝内面 ${stillIn} (${(stillIn / T * 100).toFixed(1)}%)`);
  return stillIn;
}
if (!process.argv.includes('--nofixwinding')) fixWinding(P, indices);

const Nrm = new Float32Array(N * 3);
for (let i = 0; i < indices.length; i += 3) {
  const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
  const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
  for (const o of [a, b, c]) { Nrm[o] += nx; Nrm[o + 1] += ny; Nrm[o + 2] += nz; }
}
for (let i = 0; i < N; i++) {
  const x = Nrm[i * 3], y = Nrm[i * 3 + 1], z = Nrm[i * 3 + 2];
  const L = Math.hypot(x, y, z) || 1;
  Nrm[i * 3] = x / L; Nrm[i * 3 + 1] = y / L; Nrm[i * 3 + 2] = z / L;
}

let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) { const v = P[i * 3 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
console.log(`包围盒 min(${lo.map((v) => v.toFixed(4))}) max(${hi.map((v) => v.toFixed(4))})`);

if (!OUT) { console.log(`（未给 --out，到此为止，用时 ${Date.now() - t0}ms）`); process.exit(0); }
writeGLB({ P, U, Nrm, indices, NJ, NW, NAME, TEX });
console.log(`用时 ${Date.now() - t0}ms`);

// ==== GLB ===================================================================
function writeGLB({ P, U, Nrm, indices, NJ, NW, NAME, TEX }) {
  const N = P.length / 3;
  const chunks = []; const bv = []; let binLen = 0;
  function pushBV(typed, target) {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; }
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    bv.push({ buffer: 0, byteOffset: binLen, byteLength: buf.byteLength, ...(target ? { target } : {}) });
    chunks.push(buf); binLen += buf.byteLength;
    return bv.length - 1;
  }
  const acc = []; const addAcc = (d) => { acc.push(d); return acc.length - 1; };
  const minMax = (arr, comp) => {
    const mn = new Array(comp).fill(Infinity), mx = new Array(comp).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) { const c = i % comp; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; }
    return [mn, mx];
  };
  const aPos = addAcc({ componentType: 5126, count: N, type: 'VEC3', bufferView: pushBV(new Float32Array(P), 34962), ...(() => { const [a, b] = minMax(P, 3); return { min: a, max: b }; })() });
  const aNrm = addAcc({ componentType: 5126, count: N, type: 'VEC3', bufferView: pushBV(Nrm, 34962) });
  const aUv = addAcc({ componentType: 5126, count: N, type: 'VEC2', bufferView: pushBV(new Float32Array(U), 34962) });
  const aJo = addAcc({ componentType: 5123, count: N, type: 'VEC4', bufferView: pushBV(NJ, 34962) });
  const aWe = addAcc({ componentType: 5126, count: N, type: 'VEC4', bufferView: pushBV(NW, 34962) });
  const aIdx = addAcc({ componentType: 5125, count: indices.length, type: 'SCALAR', bufferView: pushBV(indices, 34963) });

  // IBM：与 mhbuild 一致，translate(-headPos)
  const nJ = skel.order.length;
  const IBM = new Float32Array(nJ * 16);
  for (let i = 0; i < nJ; i++) {
    const p = skel.jointPos.get(skel.bDefs[skel.order[i]].head); const o = i * 16;
    IBM[o] = 1; IBM[o + 5] = 1; IBM[o + 10] = 1; IBM[o + 15] = 1;
    IBM[o + 12] = -p[0]; IBM[o + 13] = -p[1]; IBM[o + 14] = -p[2];
  }
  const aIBM = addAcc({ componentType: 5126, count: nJ, type: 'MAT4', bufferView: pushBV(IBM) });

  // 纹理
  let texIdx = -1, imgIdx = -1, sampIdx = -1;
  let images = null, samplers = null, textures = null;
  if (TEX && fs.existsSync(TEX)) {
    let png = fs.readFileSync(TEX);
    // MakeHuman 的头发贴图动辄 2048x2048 RGBA（4MB），直接塞进 GLB 会让首屏
    // 多等好几秒。这里缩到 --texsize（默认 1024）。
    const TS = Number(argv('texsize', 1024));
    try {
      const im = decodePNG(png);
      if (TS > 0 && im.w > TS) {
        const dw = TS, dh = Math.max(1, Math.round(im.h * TS / im.w));
        const out = Buffer.alloc(dw * dh * im.ch);
        resample(im.data, im.w, im.h, im.ch, out, dw, dh, im.ch);
        png = encodePNG(dw, dh, out, im.ch === 4 ? 0 : undefined);
        console.log(`纹理缩放 ${im.w}x${im.h} -> ${dw}x${dh}  ${(png.length / 1024).toFixed(0)}KB`);
      } else {
        console.log(`纹理 ${im.w}x${im.h} ${(png.length / 1024).toFixed(0)}KB（未缩放）`);
      }
    } catch (e) {
      console.log(`纹理解码失败（${e.message}），原样嵌入 ${(png.length / 1024).toFixed(0)}KB`);
    }
    const bvi = pushBV(new Uint8Array(png));
    imgIdx = 0; sampIdx = 0; texIdx = 0;
    images = [{ bufferView: bvi, mimeType: 'image/png', name: path.basename(TEX) }];
    samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    textures = [{ sampler: 0, source: 0 }];
  }

  const colArg = argv('color', '');
  const baseColor = colArg ? colArg.split(',').map(Number) : [0.85, 0.80, 0.76, 1];
  const material = {
    name: NAME + '_mat',
    pbrMetallicRoughness: {
      baseColorFactor: baseColor, metallicFactor: 0, roughnessFactor: 0.45,
      ...(texIdx >= 0 ? { baseColorTexture: { index: texIdx } } : {}),
    },
    // 没有贴图时绝不能开 MASK —— 无 alpha 通道的材质走 MASK 会整片被切掉
    doubleSided: true,
    alphaMode: texIdx >= 0 ? 'MASK' : 'OPAQUE',
    ...(texIdx >= 0 ? { alphaCutoff: 0.5 } : {}),
  };

  // nodes：mesh + Armature + joints（与 body 同名同序）
  const nodes = [];
  const meshNode = 0; nodes.push({ name: NAME, mesh: 0, skin: 0 });
  const jRoot = 1; nodes.push({ name: 'Armature' });
  const jointNodeStart = nodes.length;
  for (const b of skel.order) {
    const parent = skel.bDefs[b].parent;
    const hp = skel.jointPos.get(skel.bDefs[b].head);
    const pp = parent && skel.bDefs[parent] && skel.jointPos.has(skel.bDefs[parent].head) ? skel.jointPos.get(skel.bDefs[parent].head) : [0, 0, 0];
    nodes.push({ name: b, translation: [hp[0] - pp[0], hp[1] - pp[1], hp[2] - pp[2]] });
  }
  const roots = [];
  skel.order.forEach((b, i) => {
    const ni = jointNodeStart + i; const parent = skel.bDefs[b].parent;
    const pi = parent && skel.idx.has(parent) ? jointNodeStart + skel.idx.get(parent) : null;
    if (pi === null) roots.push(ni); else (nodes[pi].children || (nodes[pi].children = [])).push(ni);
  });
  nodes[jRoot].children = roots;
  const jointNodes = skel.order.map((_, i) => jointNodeStart + i);
  const rootBone = skel.order.find((b) => !skel.bDefs[b].parent) || skel.order[0];

  const gltf = {
    asset: { version: '2.0', generator: 'mhproxy.mjs (MakeHuman CC0 .mhclo -> GLB)', copyright: 'MakeHuman assets CC0 1.0' },
    scene: 0,
    scenes: [{ nodes: [jRoot, meshNode] }],
    nodes,
    skins: [{ joints: jointNodes, skeleton: jointNodeStart + (skel.idx.get(rootBone) ?? 0), inverseBindMatrices: aIBM }],
    meshes: [{ name: NAME, primitives: [{ attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv, JOINTS_0: aJo, WEIGHTS_0: aWe }, indices: aIdx, material: 0 }] }],
    materials: [material],
    accessors: acc, bufferViews: bv, buffers: [{ byteLength: 0 }],
  };
  if (texIdx >= 0) { gltf.images = images; gltf.samplers = samplers; gltf.textures = textures; }

  const bin = Buffer.concat(chunks);
  gltf.buffers[0].byteLength = bin.length;
  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
  const binChunk = Buffer.concat([bin, binPad]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.write('BIN\0', 4, 'ascii');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.concat([header, jh, jsonChunk, bh, binChunk]));
  console.log(`已写出 ${OUT}  ${(total / 1024).toFixed(0)}KB  ${N} 顶点 / ${indices.length / 3} 面 / ${nJ} 骨`);
}

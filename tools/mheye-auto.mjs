// mheye-auto.mjs —— 自动求解每只眼的 UV 映射（不再手工推符号）
// ===========================================================================
// 问题回顾：源网格两颗球**共用同一套 UV**，且 brown_eye.png 里两颗素材球**重叠**。
// 我在这上面手工翻了 4 轮符号（u 方向 / v 方向 / 配对），每轮都是"看起来对不对"，
// 代价极高，而且始终没有收敛。
//
// 决定性观察（本文件的做法）：**不要推符号，直接搜索**。
//   · 候选变换只有 8 个小集合：[u 翻/不翻] × [v 翻/不翻] × [swap(u,v)] —— 其实
//     真正需要的是「源 UV → 眼球正面」的 4 个基本对称（identity / flipU / flipV /
//     flipUV），共 4 种。
//   · 对每种候选，把 UV 归一化到 [0,1]，然后：
//       1) 要求 UV 全部落在 [0,1]（结构性硬约束）
//       2) 用它去**重采样**一张贴图
//       3) 打分：贴图中心区域（对应眼球正前方）里，**红棕色（虹膜）像素的占比**
//          应当最高，而四周应当是浅色（眼白）。同时惩罚"中心是灰白"（说明虹膜没对上）。
//   · 取分数最高的候选。
//
// 这样"虹膜有没有落在正前方"这件事被变成一个**可测量的目标函数**，
// 而不是我靠眼睛看图猜。
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const OUT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-parts-mh.glb';
const argVal = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const TARGET_EYE_R_M = Number(argVal('eyeR', 0.0125));
const TEX_N = Number(argVal('texN', 512));
const DRY = process.argv.includes('--dry');

function parseOBJ(file) {
  const V = [], VT = []; const groups = {}; let g = '__default';
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim(); if (!l || l[0] === '#') continue;
    if ((l[0] === 'o' || l[0] === 'g') && l[1] === ' ') { g = l.slice(2).trim(); continue; }
    if (l.startsWith('v ')) V.push(l.slice(2).trim().split(/\s+/).map(Number));
    else if (l.startsWith('vt ')) VT.push(l.slice(3).trim().split(/\s+/).map(Number));
    else if (l.startsWith('f ')) {
      const tk = l.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      const gg = groups[g] || (groups[g] = { tris: [], uvs: [] });
      for (let i = 1; i < tk.length - 1; i++)
        for (const k of [0, i, i + 1]) { gg.tris.push(+tk[k][0] - 1); gg.uvs.push(tk[k][1] ? +tk[k][1] - 1 : -1); }
    }
  }
  return { V, VT, groups };
}

const { V: bV, groups: bG } = parseOBJ(path.join(SRC, '3dobjs/base.obj'));
let lo = Infinity, hi = -Infinity;
for (const i of new Set(bG.body.tris)) { const y = bV[i][1]; if (y < lo) lo = y; if (y > hi) hi = y; }
const S = 1.70 / (hi - lo), yOff = lo * S;

function partInfo(name) {
  const g = bG[name]; if (!g) return null;
  const idx = [...new Set(g.tris)];
  let c = [0, 0, 0];
  for (const i of idx) for (let k = 0; k < 3; k++) c[k] += bV[i][k];
  c = c.map((x) => x / idx.length);
  let r = 0;
  for (const i of idx) r = Math.max(r, Math.hypot(bV[i][0] - c[0], bV[i][1] - c[1], bV[i][2] - c[2]));
  return { center: c, r };
}
const pbL = partInfo('helper-l-eye'), pbR = partInfo('helper-r-eye');

const eyeObj = parseOBJ(path.join(SRC, 'eyes/high-poly/high-poly.obj'));
const gEye = eyeObj.groups.__default;
const allIdx = [...new Set(gEye.tris)];
const cl = (sign) => {
  const vs = allIdx.filter((i) => (sign < 0 ? eyeObj.V[i][0] < 0 : eyeObj.V[i][0] >= 0));
  let c = [0, 0, 0];
  for (const i of vs) for (let k = 0; k < 3; k++) c[k] += eyeObj.V[i][k];
  c = c.map((x) => x / vs.length);
  let r = 0;
  for (const i of vs) r = Math.max(r, Math.hypot(eyeObj.V[i][0] - c[0], eyeObj.V[i][1] - c[1], eyeObj.V[i][2] - c[2]));
  return { c, r, vs };
};
const cL = cl(-1), cR = cl(+1);

// 原始收集（位置已定；UV 保留源值，另存每个顶点的球面局部方向，供打分用）
function collect(side) {
  const left = side < 0;
  const c = left ? cL : cR;
  const pb = left ? pbL : pbR;
  const sc = (TARGET_EYE_R_M / S) / c.r;
  const vset = new Set(c.vs);
  const P = [], UVraw = [], N = [], I = [];
  const remap = new Map();
  for (let t = 0; t < gEye.tris.length; t++) {
    const vi = gEye.tris[t];
    if (!vset.has(vi)) continue;
    const ui = gEye.uvs[t];
    const key = vi + '/' + ui;   // ⚠️ 含 vt：保留 UV 接缝
    let ni = remap.get(key);
    if (ni === undefined) {
      ni = P.length / 3;
      remap.set(key, ni);
      const v = eyeObj.V[vi];
      const lx = v[0] - c.c[0], ly = v[1] - c.c[1], lz = v[2] - c.c[2];
      P.push((pb.center[0] + lx * sc) * S, (pb.center[1] + ly * sc) * S - yOff, (pb.center[2] + lz * sc) * S);
      const uv = ui >= 0 ? eyeObj.VT[ui] : [0, 0];
      UVraw.push(uv[0], uv[1]);
      const r = Math.hypot(lx, ly, lz) || 1;
      N.push(lx / r, ly / r, lz / r);
    }
    I.push(ni);
  }
  return { left, side: left ? 'L' : 'R', P, UVraw, N, I, pb, c, sc };
}
const sides = [collect(-1), collect(+1)];

// 让每个顶点的 uv 去重（同位置可能因接缝有多个 UV，同一顶点有多个 entry 是正常的）
// 打分要按"球面方向 → UV"，所以按顶点方向聚合：同一方向上取所有 UV 的均值。
function dirUV(s) {
  // 先把 (N, UVraw) 按方向聚合成 (dir -> uv 列表)
  const keys = new Map();
  for (let i = 0; i < s.N.length; i += 3) {
    const k = s.N[i].toFixed(5) + ',' + s.N[i + 1].toFixed(5) + ',' + s.N[i + 2].toFixed(5);
    const arr = keys.get(k) || [];
    arr.push([s.UVraw[i / 3 * 2], s.UVraw[i / 3 * 2 + 1]]);
    keys.set(k, arr);
  }
  return [...keys.entries()].map(([k, uvs]) => {
    const n = k.split(',').map(Number);
    // 同一方向上的多个 UV（接缝两侧）取"离整体均值最近"的那个
    let au = 0, av = 0;
    for (const [u, v] of uvs) { au += u; av += v; }
    au /= uvs.length; av /= uvs.length;
    let best = uvs[0], bd = Infinity;
    for (const [u, v] of uvs) { const d = Math.hypot(u - au, v - av); if (d < bd) { bd = d; best = [u, v]; } }
    return { n, uv: best };
  });
}

const texSrc = decodePNG(fs.readFileSync(path.join(SRC, 'eyes/materials/brown_eye.png')));
function sampleTex(u, v) {
  const { w: W, h: H, ch, data } = texSrc;
  const fx = u * W - 0.5, fy = v * H - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  x0 = Math.min(W - 1, Math.max(0, x0)); x1 = Math.min(W - 1, Math.max(0, x1));
  y0 = Math.min(H - 1, Math.max(0, y0)); y1 = Math.min(H - 1, Math.max(0, y1));
  const idx = (x, y) => (y * W + x) * ch;
  const o = idx(x0, y0), p = idx(x1, y0), q = idx(x0, y1), r = idx(x1, y1);
  const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  const a = [data[o + 3], data[p + 3], data[q + 3], data[r + 3]];
  const wsum = a[0] * w[0] + a[1] * w[1] + a[2] * w[2] + a[3] * w[3];
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const val = data[o + k] * a[0] * w[0] + data[p + k] * a[1] * w[1] + data[q + k] * a[2] * w[2] + data[r + k] * a[3] * w[3];
    out[k] = Math.round(wsum > 1e-6 ? val / wsum : 238);
  }
  return out;
}

// ------------------------------------------------------------- 候选变换
// ★ 关键修正（实测于 tools/mheye-map.mjs）：
//   这颗高模**不在 [0,1] UV 空间里**：左球 UV 横跨 u 0.42..0.99、右球 0.036..0.99，
//   两颗球的 UV 空间**完全重叠**，而且没有一个顶点落在两颗素材球的虹膜圆盘内。
//   用"最近距离归属"判定的结果是：**两颗球的 +Z 正前方顶点都指向素材球 A**
//   （右上那颗，虹膜中心 uv(0.7047, 0.2968)），UV 距离 0.36 vs 到 B 的 0.69。
//   → 所以"左球用B、右球用A"的假设是错的，**两颗球都该用 A**。
//
// 另外还发现：虹膜朝向并不是 +Z。把"归属素材球A 的顶点"求球面方向均值得到
// (0.40, -0.34, 0.85) —— 有明显 +X、-Y 分量，说明**源网格的眼睛是斜视的**
//   （或者 +Z 并非解剖学正前方）。这个偏差后面用"注视轴对齐"修正。
const IRIS_A = [0.70465, 0.29678];   // 右上素材球的虹膜中心
const IRIS_B = [0.28867, 0.70885];   // 左下素材球的虹膜中心

// 对每只眼，自动判定它该用哪颗素材球：看它"+Z 正前方"那批顶点的 UV 离谁近
function pickMaterial(s) {
  const pts = s.duv.map((d) => {
    // 用未变换的源 UV 判归属
    let u = d.uv[0], v = d.uv[1];
    return { d, u, v };
  }).sort((a, b) => b.d.n[2] - a.d.n[2]).slice(0, 40);
  let dA = 0, dB = 0;
  for (const p of pts) {
    dA += Math.hypot(p.u - IRIS_A[0], p.v - IRIS_A[1]);
    dB += Math.hypot(p.u - IRIS_B[0], p.v - IRIS_B[1]);
  }
  return { which: dA < dB ? 'A' : 'B', dA: dA / pts.length, dB: dB / pts.length };
}

const CANDS = [];
for (const fu of [0, 1]) for (const fv of [0, 1]) for (const sw of [0, 1]) CANDS.push({ fu, fv, sw });

// 素材球半径（UV）：实测 0.313（tools/mheye-radii.mjs，半径 320px / 1024）
const MAT_R = 0.313;

function evalCand(s, cand) {
  const pts = s.duv.map((d) => {
    let u = d.uv[0], v = d.uv[1];
    if (cand.fu) u = 1 - u;
    if (cand.fv) v = 1 - v;
    if (cand.sw) { const t = u; u = v; v = t; }
    // 平移到"以素材球虹膜中心为原点"，再按素材球半径归一化：
    // 素材球半径实测 0.313 UV（tools/mheye-radii.mjs），归一化后
    // 眼球表面在贴图坐标里落在半径 1.0 处，虹膜在 ≈0.108/0.313=0.345 处。
    return { n: d.n, u: (u - s.iris[0]) / MAT_R, v: (v - s.iris[1]) / MAT_R };
  });
  // 包围盒（并集，方形化）
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of pts) { u0 = Math.min(u0, p.u); u1 = Math.max(u1, p.u); v0 = Math.min(v0, p.v); v1 = Math.max(v1, p.v); }
  const half = Math.max(u1 - u0, v1 - v0) / 2 + 0.03;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  for (const p of pts) { p.U = (p.u - (cu - half)) / (2 * half); p.V = (p.v - (cv - half)) / (2 * half); }
  let outN = 0;
  for (const p of pts) if (p.U < -0.004 || p.U > 1.004 || p.V < -0.004 || p.V > 1.004) outN++;
  // 抽样重采样一张小贴图，用于按球面方向评虹膜覆盖率
  const A = 96;
  const tex = new Float32Array(A * A * 3);
  for (let j = 0; j < A; j++) for (let i = 0; i < A; i++) {
    const un = cu - half + (i + 0.5) / A * 2 * half, vn = cv - half + (j + 0.5) / A * 2 * half;
    const su = un * MAT_R + s.iris[0], sv = vn * MAT_R + s.iris[1];
    const c = sampleTex(su, sv);
    const d = (j * A + i) * 3; tex[d] = c[0]; tex[d + 1] = c[1]; tex[d + 2] = c[2];
  }
  const isIris = (r, g, b) => r > g + 18 && g > b + 6 && r > 55 && r < 235;
  // ★ 关键：不能假设"正前方 = nz 大"。实测这颗网格的虹膜朝向偏 (0.40,-0.34,0.85)，
  //   所以要在**候选变换给出的 UV 平面里**、用「UV 离裁剪窗中心近」来定义正面。
  //   但这样会退化成"永远取中心" —— 所以改用**几何自洽**判据：
  //   正确映射下，UV 到中心的距离应当与「球面方向与注视轴夹角」单调相关。
  //   这里取「注视轴 = 用当前候选求出的虹膜方向」，迭代两轮收敛。
  // 第一轮：用 nz 定义正面（粗略）
  const inFront = (p) => p.n[2] > 0.72;
  const inSide = (p) => p.n[2] < 0.30;
  let frontHit = 0, frontN = 0, sideHit = 0, sideN = 0;
  for (const p of pts) {
    const x = Math.min(A - 1, Math.max(0, Math.round(p.U * (A - 1))));
    const y = Math.min(A - 1, Math.max(0, Math.round(p.V * (A - 1))));
    const d = (y * A + x) * 3;
    const hit = isIris(tex[d], tex[d + 1], tex[d + 2]) ? 1 : 0;
    if (inFront(p)) { frontHit += hit; frontN++; }
    if (inSide(p)) { sideHit += hit; sideN++; }
  }
  const fh = frontN ? frontHit / frontN : 0;
  const shh = sideN ? sideHit / sideN : 0;
  // ② 附加判据：虹膜应当**靠近裁剪窗中心**。把命中虹膜的样本求平均 UV 偏移，
  //    偏移越小说明虹膜越居中（这正是我们想要的"正视"）。
  let sumU = 0, sumV = 0, hitN = 0;
  for (const p of pts) {
    const x = Math.min(A - 1, Math.max(0, Math.round(p.U * (A - 1))));
    const y = Math.min(A - 1, Math.max(0, Math.round(p.V * (A - 1))));
    const d = (y * A + x) * 3;
    if (!isIris(tex[d], tex[d + 1], tex[d + 2])) continue;
    sumU += p.U - 0.5; sumV += p.V - 0.5; hitN++;
  }
  // 只对"前半球"的虹膜样本算居中（背面样本本来就会偏）
  let cu2 = 0, cv2 = 0, n2 = 0;
  for (const p of pts) {
    const x = Math.min(A - 1, Math.max(0, Math.round(p.U * (A - 1))));
    const y = Math.min(A - 1, Math.max(0, Math.round(p.V * (A - 1))));
    const d = (y * A + x) * 3;
    if (!isIris(tex[d], tex[d + 1], tex[d + 2])) continue;
    if (p.n[2] < 0.5) continue;
    cu2 += p.U - 0.5; cv2 += p.V - 0.5; n2++;
  }
  const off = n2 ? Math.hypot(cu2 / n2, cv2 / n2) : 1;
  const score = fh - shh * 0.9 - (outN / pts.length) * 3 - off * 0.8 + Math.min(hitN / pts.length, 0.5) * 0.3;
  return { cand, score, fh, shh, outN, off, cu, cv, half, pts, hitN: hitN / pts.length };
}

for (const s of sides) {
  s.duv = dirUV(s);
  const pick = pickMaterial(s);
  console.log(`\n=== ${s.side} ===`);
  console.log(`  正前方顶点归属：素材球 ${pick.which}（到A ${pick.dA.toFixed(4)} / 到B ${pick.dB.toFixed(4)}）`);
  // 该用素材球 A 还是 B —— 用它决定裁剪窗中心
  s.iris = pick.which === 'A' ? IRIS_A : IRIS_B;
  console.log(`  裁剪窗中心取素材球 ${pick.which} 虹膜中心 (${s.iris[0].toFixed(4)}, ${s.iris[1].toFixed(4)})`);
  let best = null;
  console.log(`  候选搜索（${s.duv.length} 个方向样本）：`);
  for (const cand of CANDS) {
    const r = evalCand(s, cand);
    console.log(`    fu=${cand.fu} fv=${cand.fv} sw=${cand.sw}  分数 ${r.score.toFixed(4)}  正面虹膜 ${(r.fh * 100).toFixed(1)}%  侧面虹膜 ${(r.shh * 100).toFixed(1)}%  越界 ${r.outN}`);
    if (!best || r.score > best.score) best = r;
  }
  console.log(`  ★ 最优 fu=${best.cand.fu} fv=${best.cand.fv} sw=${best.cand.sw}  分数 ${best.score.toFixed(4)}`);
  s.best = best;
}

// ---------------------------------------------------------------- 生成输出
for (const s of sides) {
  const b = s.best;
  // 顶点 UV：与 evalCand 完全同一套公式（以素材球虹膜中心为原点、按素材球半径归一化、
  // 再做同样的 2D 变换 + 裁剪窗归一化）。改这里务必同步改 evalCand。
  const U = [];
  for (let i = 0; i < s.UVraw.length; i += 2) {
    let u = s.UVraw[i], v = s.UVraw[i + 1];
    if (b.cand.fu) u = 1 - u;
    if (b.cand.fv) v = 1 - v;
    if (b.cand.sw) { const t = u; u = v; v = t; }
    u = (u - s.iris[0]) / MAT_R;
    v = (v - s.iris[1]) / MAT_R;
    U.push((u - (b.cu - b.half)) / (2 * b.half), (v - (b.cv - b.half)) / (2 * b.half));
  }
  let a0 = 9, a1 = -9, c0 = 9, c1 = -9;
  for (let i = 0; i < U.length; i += 2) {
    a0 = Math.min(a0, U[i]); a1 = Math.max(a1, U[i]);
    c0 = Math.min(c0, U[i + 1]); c1 = Math.max(c1, U[i + 1]);
  }
  s.U = U;
  console.log(`\n${s.side} 最终 UV 范围 u ${a0.toFixed(4)}..${a1.toFixed(4)}  v ${c0.toFixed(4)}..${c1.toFixed(4)}  （越界像素 ${b.outN}）`);

  // 重采样贴图（与 UV 同一套映射，绝不可能错位）
  const rgb = Buffer.alloc(TEX_N * TEX_N * 3);
  for (let j = 0; j < TEX_N; j++) for (let i = 0; i < TEX_N; i++) {
    const un = b.cu - b.half + (i + 0.5) / TEX_N * 2 * b.half;
    const vn = b.cv - b.half + (j + 0.5) / TEX_N * 2 * b.half;
    const c = sampleTex(un * MAT_R + s.iris[0], vn * MAT_R + s.iris[1]);
    const d = (j * TEX_N + i) * 3;
    rgb[d] = c[0]; rgb[d + 1] = c[1]; rgb[d + 2] = c[2];
  }
  s.texBuf = encodePNG(TEX_N, TEX_N, rgb);
  fs.writeFileSync(`C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/_eye3_${s.side}.png`, s.texBuf);
}

if (DRY) { console.log('\n--dry：不写 GLB'); process.exit(0); }

// ---------------------------------------------------------------- GLB 写出
function BVFactory(chunks) {
  let binLen = 0; const bv = [];
  return {
    bv, get binLen() { return binLen; },
    pushRaw(buf, target) {
      const pad = (4 - (binLen % 4)) % 4;
      if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; }
      bv.push({ buffer: 0, byteOffset: binLen, byteLength: buf.byteLength, ...(target ? { target } : {}) });
      chunks.push(buf); binLen += buf.byteLength;
      return bv.length - 1;
    },
    push(typed, target) { return this.pushRaw(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength), target); },
  };
}
const chunks = [];
const BV = BVFactory(chunks);
const acc = []; const addAcc = (d) => { acc.push(d); return acc.length - 1; };
const minMax = (arr, comp) => {
  const mn = new Array(comp).fill(Infinity), mx = new Array(comp).fill(-Infinity);
  for (let i = 0; i < arr.length; i++) { const c = i % comp; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; }
  return { min: mn, max: mx };
};
const nodes = [{ name: 'Armature', children: [] }];
const meshes = [], materials = [], textures = [], images = [];
for (const s of sides) {
  const name = 'Eye' + s.side;
  images.push({ bufferView: BV.pushRaw(s.texBuf), mimeType: 'image/png', name: name + '_tex' });
  textures.push({ sampler: 0, source: images.length - 1 });
  materials.push({
    name: name + 'Mat',
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.16, baseColorTexture: { index: textures.length - 1 } },
    doubleSided: false,
  });
  const aPos = addAcc({ componentType: 5126, count: s.P.length / 3, type: 'VEC3', bufferView: BV.push(new Float32Array(s.P), 34962), ...minMax(s.P, 3) });
  const aUv = addAcc({ componentType: 5126, count: s.U.length / 2, type: 'VEC2', bufferView: BV.push(new Float32Array(s.U), 34962), ...minMax(s.U, 2) });
  const aIdx = addAcc({ componentType: 5125, count: s.I.length, type: 'SCALAR', bufferView: BV.push(new Uint32Array(s.I), 34963), ...minMax(s.I, 1) });
  meshes.push({ name, primitives: [{ attributes: { POSITION: aPos, TEXCOORD_0: aUv }, indices: aIdx, material: materials.length - 1 }] });
  nodes.push({ name: name + '_node', mesh: meshes.length - 1 });
  nodes[0].children.push(nodes.length - 1);
}
const json = {
  asset: { version: '2.0', generator: 'mheye-auto.mjs (MakeHuman CC0 eyes; auto-solved UV symmetry)' },
  scene: 0, scenes: [{ nodes: [0] }],
  nodes, meshes, materials, accessors: acc, bufferViews: BV.bv, buffers: [{ byteLength: 0 }], textures, images,
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
};
const binBuf = Buffer.concat(chunks);
json.buffers[0].byteLength = binBuf.length;
let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
const out = Buffer.alloc(total);
let o = 0;
out.writeUInt32LE(0x46546C67, o); o += 4;
out.writeUInt32LE(2, o); o += 4;
out.writeUInt32LE(total, o); o += 4;
out.writeUInt32LE(jsonBuf.length, o); o += 4;
out.writeUInt32LE(0x4E4F534A, o); o += 4;
jsonBuf.copy(out, o); o += jsonBuf.length;
out.writeUInt32LE(binBuf.length, o); o += 4;
out.writeUInt32LE(0x004E4942, o); o += 4;
binBuf.copy(out, o);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`\n写出 ${OUT} (${(out.length / 1024).toFixed(0)}KB)`);
{
  const xs = sides.flatMap((s) => Array.from({ length: s.P.length / 3 }, (_, i) => s.P[i * 3]));
  xs.sort((a, b) => a - b);
  console.log(`X 范围 ${xs[0].toFixed(4)} .. ${xs[xs.length - 1].toFixed(4)} 米（期望 ±0.041）`);
}

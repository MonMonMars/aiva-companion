// mheye-probe.mjs —— 查清 MakeHuman 精细眼球里「虹膜朝哪边」
// ===========================================================================
// 为什么需要这个脚本：
//   之前有过两个互相矛盾的结论：(a) 虹膜朝 ±X（依据是瞳孔顶点 X 恒等于球心 X）
//   (b) 虹膜朝 +Z（依据是把瞳孔 UV 反查回 3D）。两个结论不能同时对，谁错谁对
//   决定了眼球要不要绕 Y 轴转 90°。转错就是"正面看过去一圈灰白眼白"。
//   所以这里**不靠推理，直接量**：
//     1. 从 brown_eye.png 里找出黑色瞳孔的两个像素团 → 两个 UV 中心
//     2. 用 f 行建立 vt -> v 的映射，把瞳孔 UV 反查成 3D 顶点
//     3. 算这些顶点相对**本半球心**的方向 → 这就是虹膜轴，直接打印出来
//   顺带把每个半球的 UV 范围、球心、半径一并打印，用来核对左右眼别配错。
//
// PNG 解码不依赖任何第三方库（node:zlib 手写），免得又要装 pngjs。
//
// 用法: node tools/mheye-probe.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const EYE_OBJ = path.join(SRC, 'eyes/high-poly/high-poly.obj');
const EYE_PNG = path.join(SRC, 'eyes/materials/brown_eye.png');

// ------------------------------------------------------------- PNG 解码
// 只支持 8bit RGB/RGBA、非隔行 —— makehuman 的贴图正好就是这种
function decodePNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ch = 0, bd = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p); p += 4;
    const type = b.toString('ascii', p, p + 4); p += 4;
    const data = b.subarray(p, p + len); p += len + 4;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bd = data[8]; ch = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (bd !== 8 || !ch) throw new Error(`不支持的 PNG: bitDepth=${bd} colorType=${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += bb;
      else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, data: out };
}

// ------------------------------------------------------------- OBJ 解析
// 这里要保留 vt 索引，所以不能用 mhaux.mjs 里那个只留 uv 的简化版
function parseOBJ(file) {
  const V = [], VT = [], F = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    if (l[0] === 'v' && l[1] === ' ') V.push(l.slice(2).trim().split(/\s+/).map(Number));
    else if (l[0] === 'v' && l[1] === 't') VT.push(l.slice(3).trim().split(/\s+/).map(Number));
    else if (l[0] === 'f' && l[1] === ' ') {
      const tk = l.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      for (let i = 1; i < tk.length - 1; i++)
        for (const k of [0, i, i + 1]) F.push([+tk[k][0] - 1, tk[k][1] ? +tk[k][1] - 1 : -1]);
    }
  }
  return { V, VT, F };
}

const { V, VT, F } = parseOBJ(EYE_OBJ);
console.log(`high-poly.obj: ${V.length} 顶点 / ${VT.length} UV / ${F.length / 3} 面`);

// ------------------------------------------------- 找出贴图上黑色瞳孔的中心
const png = decodePNG(EYE_PNG);
console.log(`brown_eye.png: ${png.w}x${png.h} ch=${png.ch}`);
const dark = [];
for (let y = 0; y < png.h; y += 2) {
  for (let x = 0; x < png.w; x += 2) {
    const i = y * png.w * png.ch + x * png.ch;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r < 60 && g < 60 && b < 60) dark.push([x + 0.5, y + 0.5]);
  }
}
console.log(`  暗像素(亮度<60) ${dark.length} 个`);

// 两个瞳孔在贴图对角线上，用 x+y 的中位数一刀切成两团最省事
function cluster(pts) {
  const s = pts.map((p) => p[0] + p[1]);
  const sorted = [...s].sort((a, b) => a - b);
  const mid = sorted[sorted.length >> 1];
  const A = [], B = [];
  for (let i = 0; i < pts.length; i++) (s[i] < mid ? A : B).push(pts[i]);
  const cen = (arr) => [
    arr.reduce((t, p) => t + p[0], 0) / arr.length / png.w,
    arr.reduce((t, p) => t + p[1], 0) / arr.length / png.h,
  ];
  return [cen(A), cen(B)];
}
// OBJ 的 UV 原点在左下，PNG 原点在左上 → v 要翻过来
const pupils = cluster(dark).map(([u, v]) => [u, 1 - v]);
console.log(`  瞳孔 UV 中心: ${pupils.map((p) => `(${p[0].toFixed(4)}, ${p[1].toFixed(4)})`).join('   ')}`);

// ------------------------------------------------- 左右半球拆分与球心/半径
const halves = { xneg: [], xpos: [] };
for (const [vi, ti] of F) (V[vi][0] < 0 ? halves.xneg : halves.xpos).push([vi, ti]);

function stats(list) {
  const vs = [...new Set(list.map((l) => l[0]))];
  let cx = 0, cy = 0, cz = 0;
  for (const i of vs) { cx += V[i][0]; cy += V[i][1]; cz += V[i][2]; }
  const n = vs.length;
  cx /= n; cy /= n; cz /= n;
  let rmin = Infinity, rmax = 0;
  for (const i of vs) {
    const d = Math.hypot(V[i][0] - cx, V[i][1] - cy, V[i][2] - cz);
    if (d < rmin) rmin = d;
    if (d > rmax) rmax = d;
  }
  const uu = list.map((l) => VT[l[1]]).filter(Boolean);
  const ub = uu.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  return { n, c: [cx, cy, cz], rmin, rmax, uv: ub, vs };
}

console.log('\n=== 两个半球 ===');
for (const k of ['xneg', 'xpos']) {
  const s = stats(halves[k]);
  console.log(`  X${k === 'xneg' ? '<0' : '>0'}: ${s.n} 顶点  心 (${s.c.map((x) => x.toFixed(4)).join(', ')})  半径 ${s.rmin.toFixed(4)}~${s.rmax.toFixed(4)}`);
  console.log(`        UV  u ${s.uv[0].toFixed(4)}..${s.uv[2].toFixed(4)}   v ${s.uv[1].toFixed(4)}..${s.uv[3].toFixed(4)}`);
}

// ------------------------------------------------- 瞳孔 UV -> 3D，求虹膜轴
// 对每个瞳孔 UV，在**对应的半球**里找 UV 最近的若干顶点，看它们相对球心朝哪
console.log('\n=== 虹膜朝向（关键结论） ===');
for (const k of ['xneg', 'xpos']) {
  const s = stats(halves[k]);
  const cands = [...new Set(halves[k].map((l) => l[0]))].map((vi) => {
    const ti = halves[k].find((l) => l[0] === vi)[1];
    return { vi, uv: VT[ti] };
  }).filter((x) => x.uv);
  console.log(`\n  半球 X${k === 'xneg' ? '<0' : '>0'}  球心 (${s.c.map((x) => x.toFixed(4)).join(', ')})`);
  for (const pu of pupils) {
    const near = cands.map((x) => ({ ...x, d: Math.hypot(x.uv[0] - pu[0], x.uv[1] - pu[1]) }))
      .sort((a, b) => a.d - b.d);
    // 只信 UV 距离很小的：贴图上一个瞳孔直径约 0.15 UV，中心命中应 < 0.02
    const hit = near.filter((x) => x.d < 0.02).slice(0, 6);
    if (!hit.length) {
      console.log(`    瞳孔 UV (${pu[0].toFixed(3)}, ${pu[1].toFixed(3)}) —— 本半球无命中（最近 ${near[0].d.toFixed(4)}），说明这个瞳孔属于另一个半球`);
      continue;
    }
    let ax = 0, ay = 0, az = 0;
    for (const h of hit) { const v = V[h.vi]; ax += v[0] - s.c[0]; ay += v[1] - s.c[1]; az += v[2] - s.c[2]; }
    const L = Math.hypot(ax, ay, az) || 1;
    console.log(`    瞳孔 UV (${pu[0].toFixed(3)}, ${pu[1].toFixed(3)}) 命中 ${hit.length} 顶点`);
    console.log(`      虹膜轴 = (${(ax / L).toFixed(3)}, ${(ay / L).toFixed(3)}, ${(az / L).toFixed(3)})   平均偏离球心 ${(L / hit.length).toFixed(4)} (球半径 ${s.rmax.toFixed(4)})`);
    for (const h of hit.slice(0, 3)) {
      const v = V[h.vi];
      console.log(`        v${h.vi} uv(${h.uv[0].toFixed(3)},${h.uv[1].toFixed(3)}) d=${h.d.toFixed(4)}  pos(${v.map((x) => x.toFixed(4)).join(', ')})`);
    }
  }
}

// mheye-uv2.mjs —— 眼睛导出（v2）：用「源 UV 自身的包围盒」自动求裁剪窗
// ===========================================================================
// 为什么放弃"手算虹膜中心"的做法（踩坑史，非常重要）：
//
//   brown_eye.png 里有两颗**重叠**的素材眼球（沿反对角线），而源网格两颗球
//   **共用同一套 UV**（左球和右球的 vt 索引空间是同一片）。于是"哪只眼配哪颗
//   素材球"就变成一个我必须猜的配对问题。我在这上面翻了 4 轮符号，每次都是
//   "看起来对/不对"，代价极高：
//
//     轮1 u_src-u_iris  → UV 范围 -0.06..1.03 / 0.03..1.86   假缝移到了 u=1
//     轮2 读反了 v      → 裁图全空
//     轮3 相关系数定符号 → 左球只有 0.26，不可信
//     轮4 逐三角形投票   → 660:360，几乎五五开，还是没有确定答案
//
//   结论：**这个问题不该用手算解决**。换成一个自检式做法：
//
//     1) 对每只眼，先按"不翻符号、以正极点 UV 为虹膜中心"排一遍 UV；
//     2) 求这些 UV 的**包围盒**，取能装下它的最小正方形；
//     3) 拿这个正方形去源图上**裁图**，并把 UV 归一化到 [0,1]。
//
//   这样无论符号对不对，**几何和贴图永远是同一套 UV**（因为裁窗就是从 UV 算
//   出来的），唯一可能的错误就退化成"虹膜位置稍微偏一点"这种视觉效果问题，
//   而不会再出现接缝张开、UV 越界、贴图对不上这类结构性错误。
//
//   而且这个做法天然自洽：UV 包围盒本身就是 UV 的空间，裁窗由它决定，
//   归一化必然落在 [0,1]，CLAMP_TO_EDGE 下绝无越界条纹。
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const OUT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-parts-mh.glb';
const argVal = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const TARGET_EYE_R_M = Number(argVal('eyeR', 0.0125));
const PAD = Number(argVal('pad', 0.02));   // 裁窗在 UV 包围盒外的余量（UV 单位）
const TEX_N = 512;

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
console.log(`base 配准：S=${S.toFixed(6)} yOff=${yOff.toFixed(4)}`);

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
console.log(`精细眼球：${eyeObj.V.length} 顶点 / ${gEye.tris.length / 3} 面 / ${eyeObj.VT.length} vt`);

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

// ---------------------------------------------------------------- 第一遍：排 UV
// 位置：以各自球心缩放并移到 helper 球心（不旋转、不镜像，两眼都朝 +Z）
// UV  ：**直接用源 UV**（这一遍不做任何平移，保留原样）
function collect(side) {
  const left = side < 0;
  const c = left ? cL : cR;
  const em = left ? { m: -1 } : { m: +1 };
  const sc = (TARGET_EYE_R_M / S) / c.r;
  const pb = left ? pbL : pbR;
  const vset = new Set(c.vs);
  const P = [], U = [], UVraw = [], I = [];
  const remap = new Map();
  for (let t = 0; t < gEye.tris.length; t++) {
    const vi = gEye.tris[t];
    if (!vset.has(vi)) continue;
    const ui = gEye.uvs[t];
    // ⚠️ 去重键必须含 vt：接缝顶点有多个 vt，只按顶点去重会把接缝抹平 → 球面开裂
    const key = vi + '/' + ui;
    let ni = remap.get(key);
    if (ni === undefined) {
      ni = P.length / 3;
      remap.set(key, ni);
      const v = eyeObj.V[vi];
      const lx = v[0] - c.c[0], ly = v[1] - c.c[1], lz = v[2] - c.c[2];
      P.push((pb.center[0] + lx * sc) * S, (pb.center[1] + ly * sc) * S - yOff, (pb.center[2] + lz * sc) * S);
      const uv = ui >= 0 ? eyeObj.VT[ui] : [0, 0];
      UVraw.push(uv[0], uv[1]);
      U.push(0, 0);   // 占位，第二遍填
    }
    I.push(ni);
  }
  // 正极点（nz 最大）的 UV —— 用它做裁剪窗的中心
  let bi = -1, bz = -2;
  for (const i of c.vs) {
    const v = eyeObj.V[i];
    const d = [v[0] - c.c[0], v[1] - c.c[1], v[2] - c.c[2]];
    const nz = d[2] / (Math.hypot(...d) || 1);
    if (nz > bz) { bz = nz; bi = i; }
  }
  let poleUv = null;
  for (let t = 0; t < gEye.tris.length; t++) if (gEye.tris[t] === bi) { poleUv = eyeObj.VT[gEye.uvs[t]]; break; }
  return { side: left ? 'L' : 'R', left, P, U, UVraw, I, poleUv, pb, sc, c };
}

const sides = [collect(-1), collect(+1)];
for (const s of sides) {
  let u0 = 9, u1 = -9, v0 = 9, v1 = -9;
  for (let i = 0; i < s.UVraw.length; i += 2) {
    u0 = Math.min(u0, s.UVraw[i]); u1 = Math.max(u1, s.UVraw[i]);
    v0 = Math.min(v0, s.UVraw[i + 1]); v1 = Math.max(v1, s.UVraw[i + 1]);
  }
  console.log(`\n${s.side} 面数 ${s.I.length / 3}  正极点 UV (${s.poleUv[0].toFixed(4)}, ${s.poleUv[1].toFixed(4)})`);
  console.log(`  源 UV 包围盒 u ${u0.toFixed(4)}..${u1.toFixed(4)}  v ${v0.toFixed(4)}..${v1.toFixed(4)}`);
  s.uvBox = [u0, u1, v0, v1];
}

// ------------------------------------------------------- 第二遍：定裁剪窗 + 归一化
const texSrc = decodePNG(fs.readFileSync(path.join(SRC, 'eyes/materials/brown_eye.png')));
console.log(`\n源贴图 ${texSrc.w}×${texSrc.h} ch=${texSrc.ch}`);

// UV 取样（双线性 + alpha 预乘，避免透明边缘发黑）
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
  const out = [0, 0, 0, 255];
  for (let k = 0; k < 3; k++) {
    const val = data[o + k] * a[0] * w[0] + data[p + k] * a[1] * w[1] + data[q + k] * a[2] * w[2] + data[r + k] * a[3] * w[3];
    // 透明处回退成浅灰（眼白），避免黑边
    out[k] = Math.round(wsum > 1e-6 ? val / wsum : 236);
  }
  return out;
}

for (const s of sides) {
  // 裁窗：以正极点 UV 为中心，取包围盒的最长边 + 余量，正方形
  const [u0, u1, v0, v1] = s.uvBox;
  const half = Math.max(u1 - u0, v1 - v0) / 2 + PAD;
  const cu = s.poleUv[0], cv = s.poleUv[1];
  s.win = { cu, cv, half };
  // 归一化：把 [cu-half, cu+half] 映到 [0,1]
  for (let i = 0; i < s.UVraw.length; i += 2) {
    s.U[i] = (s.UVraw[i] - (cu - half)) / (2 * half);
    s.U[i + 1] = (s.UVraw[i + 1] - (cv - half)) / (2 * half);
  }
  let a0 = 9, a1 = -9, b0 = 9, b1 = -9;
  for (let i = 0; i < s.U.length; i += 2) {
    a0 = Math.min(a0, s.U[i]); a1 = Math.max(a1, s.U[i]);
    b0 = Math.min(b0, s.U[i + 1]); b1 = Math.max(b1, s.U[i + 1]);
  }
  console.log(`\n${s.side} 裁窗 中心(${cu.toFixed(4)}, ${cv.toFixed(4)}) 半宽 ${half.toFixed(4)}`);
  console.log(`  归一化后 UV 范围 u ${a0.toFixed(4)}..${a1.toFixed(4)}  v ${b0.toFixed(4)}..${b1.toFixed(4)}  （应当 ⊂ [0,1]）`);

  // 用归一化 UV **重采样**出贴图（而不是从原图裁剪像素矩形）：
  // 这样贴图与 UV 是同一套映射，绝不可能错位。
  const rgb = Buffer.alloc(TEX_N * TEX_N * 3);
  for (let j = 0; j < TEX_N; j++) for (let i = 0; i < TEX_N; i++) {
    const un = (i + 0.5) / TEX_N, vn = (j + 0.5) / TEX_N;
    const su = (cu - half) + un * 2 * half;
    const sv = (cv - half) + vn * 2 * half;
    const c = sampleTex(su, sv);
    const d = (j * TEX_N + i) * 3;
    rgb[d] = c[0]; rgb[d + 1] = c[1]; rgb[d + 2] = c[2];
  }
  s.texBuf = encodePNG(TEX_N, TEX_N, rgb);
  console.log(`  贴图重采样 → ${TEX_N}×${TEX_N}  ${(s.texBuf.length / 1024).toFixed(0)}KB`);
}

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
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.16,
      baseColorTexture: { index: textures.length - 1 },
    },
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
  asset: { version: '2.0', generator: 'mheye-uv2.mjs (MakeHuman CC0 eyes; UV-box-derived crop window)' },
  scene: 0, scenes: [{ nodes: [0] }],
  nodes, meshes, materials, accessors: acc, bufferViews: BV.bv,
  buffers: [{ byteLength: 0 }], textures, images,
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
};
let binBuf = Buffer.concat(chunks);
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
for (const s of sides) {
  const dst = `C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/_eye2_Eye${s.side}.png`;
  fs.writeFileSync(dst, s.texBuf);
  console.log(`  Eye${s.side} 贴图 → ${dst}`);
}
{
  const xs = sides.flatMap((s) => Array.from({ length: s.P.length / 3 }, (_, i) => s.P[i * 3]));
  xs.sort((a, b) => a - b);
  console.log(`X 范围 ${xs[0].toFixed(4)} .. ${xs[xs.length - 1].toFixed(4)} 米（期望 ±0.041）`);
}

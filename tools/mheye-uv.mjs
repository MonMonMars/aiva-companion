// mheye-uv.mjs —— 从 MakeHuman 高模眼球导出「左右眼两个独立网格 + 各自一张贴图」
// ===========================================================================
// ⚠️ 踩坑史（极其重要，别删、别退回旧做法）
//
// 一开始我判断「源 UV 和 brown_eye.png 对不上」，理由是：网格正前方那一圈顶点
// （角膜/虹膜区）的 UV 全挤在 u 0.93~0.95, v 0.06~0.07，而那里在贴图上是眼白。
// 于是我丢弃源 UV，改成解析式球面投影 —— 结果渲染出来有明显接缝、眼白破碎。
//
// 后来真相是**我自己的测量错了**，错在两处：
//
//   坑 1：brown_eye.png 是 **RGBA + 透明背景**。我用「深色像素聚类」找瞳孔，
//        透明背景被当成黑色参与了聚类，于是量出两颗假的"黑色圆盘"。
//        实际贴图内容（先在白底上合成再看）非常清楚：
//          · 右上那颗眼球 → 虹膜中心 ≈ uv(0.716, 0.719)
//          · 左下那颗眼球 → 虹膜中心 ≈ uv(0.283, 0.281)
//          · 另有：右下角一片圆形阴影、右上一条弧形阴影（都是烘焙的明暗，不是瞳孔）
//        两张球的虹膜直径 ≈ 0.224 UV（229px），眼球（含凸起）直径 ≈ 0.83 UV。
//
//   坑 2：网格正极点实测是
//          · 左球(-X) v1014 → srcUV (0.7060, 0.7065)   贴图右上球的虹膜中心
//          · 右球(+X) v482  → srcUV (0.2929, 0.3053)   贴图左下球的虹膜中心
//        和上面量出来的虹膜中心**相差 0.01 UV（约 10px）**，人眼分辨不出。
//        → **源 UV 从一开始就是对的**，不该重算。
//
//   那"u 0.93~0.95 那一圈"是什么？是 nz>0.9 的 81 个顶点里的**接缝顶点**：
//   开缝球体在正前方那条 u=1↔u=0 的接缝，绕到贴图上是 u≈0.95/0.05 那一竖条。
//   它不是退化，是正常的 UV 接缝。我把 81 个顶点一起算包围盒，才误以为整圈都挤在一起。
//
// 所以本文件的正确做法：
//   · **直接沿用源 UV**（v/vt 复合键去重，保留接缝）。
//   · 但把两个球**拆成两个独立网格、各配一张裁好的贴图**：
//       - EyeL 用右上那颗球的虹膜中心 (0.716, 0.719)
//       - EyeR 用左下那颗球的虹膜中心 (0.283, 0.281)
//     这样每张贴图都是「一颗完整的眼球」，UV 的 wrap 直接设 CLAMP_TO_EDGE，
//     接缝回绕会采到与接缝相邻的像素，和球面拓扑一致，**看不出缝**。
//     （用整张 1024 图 + REPEAT 时，u=0.95→0.05 会回绕到另一颗眼球上去，
//       所以之前才出现"眼白破碎、出现奇怪色块"。）
//
// 用法: node tools/mheye-uv.mjs [--eyeR 0.0125] [--crop 0.52]
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG, resample } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const OUT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-parts-mh.glb';

const argVal = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const TARGET_EYE_R_M = Number(argVal('eyeR', 0.0125));
// ⚠️ 这个值必须按实测改，不能拍脑袋：
//   开始时我取 0.52（以为一颗眼球占半张贴图），结果裁出来全是眼白/空白。
//   实测（tools/mheye-radii.mjs）：
//     · 瞳孔半径 114px = UV 0.111   → 瞳孔直径 0.223 UV
//     · 虹膜外缘 111px = UV 0.108   → 虹膜直径 0.217 UV
//     · 眼球（含凸起）半径 320px = UV 0.313
//   → **这张贴图里没有眼白**，整颗球几乎全是虹膜，是一张「虹膜贴片」素材。
//   所以裁剪半径取 0.36 UV：把整颗素材球（0.313）连同一点点余量装进去。
const CROP = Number(argVal('crop', 0.36));

// 贴图里两颗素材球的虹膜中心（整图 UV，实测于 tools/mheye-measure.mjs）
//   ⚠️ 这里踩过一个很隐蔽的坑：我一开始把 uv 的 v 读反了（看成 0.297/0.709），
//      以为两颗球是"沿主对角线"排布，结果裁出来的图整个是空的。
//      实际是**沿反对角线**：右上那颗 v 小、左下那颗 v 大。
//   两张球是镜像的：右上的虹膜中心 u=0.7047，左下 u=0.2887（相对 0.5 对称）。
const IRIS_RIGHT_TOP = { uv: [0.70465, 0.29678], name: 'A' };  // 右上素材球
const IRIS_LEFT_BOT = { uv: [0.28867, 0.70885], name: 'B' };   // 左下素材球

// ★ 关键映射：源网格两颗球**共用同一套 UV**（左球和右球的 vt 索引空间重叠），
//   所以不能只做平移、还必须让 v 也反向。验证（实测）：
//     左球(-X) 正极点 srcUV(0.7060, 0.7065) ≈ 素材球 B(0.2887, 0.7089)
//     右球(+X) 正极点 srcUV(0.2929, 0.3053) ≈ 素材球 A(0.7047, 0.2968)
//   即 左球↔素材B、右球↔素材A，且 **Δu = u_src − u_iris 要翻成正号方向**。
//   映射式（把 u 映射到目标裁图坐标）：
//       本地 x = (u_iris − u_src)/CROP + 0.5
//       本地 y = (v_src − v_iris)/CROP + 0.5
//   左球 → 素材B，右球 → 素材A。
const EYE_MAP = {
  left: { iris: IRIS_LEFT_BOT, flipU: false, name: 'EyeL' },   // 左球(-X) 用左下素材
  right: { iris: IRIS_RIGHT_TOP, flipU: false, name: 'EyeR' }, // 右球(+X) 用右上素材
};

function parseOBJ(file) {
  const V = [], VT = [];
  const groups = {};
  let g = '__default';
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
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

function baseScale() {
  const { V, groups } = parseOBJ(path.join(SRC, '3dobjs/base.obj'));
  const body = new Set(groups.body.tris);
  let lo = Infinity, hi = -Infinity;
  for (const i of body) { const y = V[i][1]; if (y < lo) lo = y; if (y > hi) hi = y; }
  const S = 1.70 / (hi - lo);
  return { S, yOff: lo * S };
}
const { S, yOff } = baseScale();
console.log(`base 配准：S=${S.toFixed(6)} yOff=${yOff.toFixed(4)}`);

const { V: bV, groups: bG } = parseOBJ(path.join(SRC, '3dobjs/base.obj'));
function partInfo(name) {
  const g = bG[name]; if (!g) return null;
  const idx = [...new Set(g.tris)];
  let cx = 0, cy = 0, cz = 0;
  for (const i of idx) { cx += bV[i][0]; cy += bV[i][1]; cz += bV[i][2]; }
  cx /= idx.length; cy /= idx.length; cz /= idx.length;
  let r = 0;
  for (const i of idx) r = Math.max(r, Math.hypot(bV[i][0] - cx, bV[i][1] - cy, bV[i][2] - cz));
  return { center: [cx, cy, cz], r, tris: g.tris.length / 3 };
}
const pbL = partInfo('helper-l-eye'), pbR = partInfo('helper-r-eye');

const eyeObj = parseOBJ(path.join(SRC, 'eyes/high-poly/high-poly.obj'));
const gEye = eyeObj.groups.__default;
console.log(`精细眼球：${eyeObj.V.length} 顶点 / ${gEye.tris.length / 3} 面 / ${eyeObj.VT.length} vt`);

// 球心 + 半径（只用来把源数据缩放到真实眼球尺寸）
const allIdx = [...new Set(gEye.tris)];
function cluster(sign) {
  const vs = allIdx.filter((i) => (sign < 0 ? eyeObj.V[i][0] < 0 : eyeObj.V[i][0] >= 0));
  let cx = 0, cy = 0, cz = 0;
  for (const i of vs) { cx += eyeObj.V[i][0]; cy += eyeObj.V[i][1]; cz += eyeObj.V[i][2]; }
  cx /= vs.length; cy /= vs.length; cz /= vs.length;
  let r = 0;
  for (const i of vs) r = Math.max(r, Math.hypot(eyeObj.V[i][0] - cx, eyeObj.V[i][1] - cy, eyeObj.V[i][2] - cz));
  return { c: [cx, cy, cz], r, n: vs.length };
}
const cL = cluster(-1), cR = cluster(+1);

// ============================================================ 拆分 + 组装
// 位置：源数据已以 +Z 为注视方向 → 不旋转，只做「相对球心缩放 + 移到 helper 球心」。
//       ⚠️ 不做镜像：两眼的虹膜都朝 +Z，镜像会让一只眼的虹膜朝鼻子。
// UV：沿用源 UV，并平移到以该眼虹膜中心为原点的裁图坐标。
function buildSide(side) {
  const left = side < 0;
  const c = left ? cL : cR;
  const pb = left ? pbL : pbR;
  const em = left ? EYE_MAP.left : EYE_MAP.right;
  const iris = em.iris;
  const sc = (TARGET_EYE_R_M / S) / c.r;

  const verts = allIdx.filter((i) => (left ? eyeObj.V[i][0] < 0 : eyeObj.V[i][0] >= 0));
  const vset = new Set(verts);

  // 只保留该侧三角形
  const P = [], U = [], I = [];
  const remap = new Map();
  for (let t = 0; t < gEye.tris.length; t++) {
    const vi = gEye.tris[t];
    if (!vset.has(vi)) continue;
    const ui = gEye.uvs[t];
    // ⚠️ 去重键必须含 vt：同一顶点在 UV 接缝处有多个 vt，只按顶点去重会把接缝抹平，
    //    球面开裂。这里正是靠保留接缝让 u 在 0/1 之间跳变，配合 CLAMP 才是无缝的。
    const key = vi + '/' + ui;
    let ni = remap.get(key);
    if (ni === undefined) {
      ni = P.length / 3;
      remap.set(key, ni);
      const v = eyeObj.V[vi];
      const lx = v[0] - c.c[0], ly = v[1] - c.c[1], lz = v[2] - c.c[2];
      P.push((pb.center[0] + lx * sc) * S, (pb.center[1] + ly * sc) * S - yOff, (pb.center[2] + lz * sc) * S);
      const uv = ui >= 0 ? eyeObj.VT[ui] : [0, 0];
      // 平移到裁图局部坐标：以虹膜中心为 (0.5, 0.5)
      //   u 用 (u_iris - u_src)：源网格的 u 增长方向与贴图相反（见 EYE_MAP 注释）
      //   v 用 (v_src - v_iris)：源/贴图 v 同向
      U.push(0.5 + (iris.uv[0] - uv[0]) / CROP, 0.5 + (uv[1] - iris.uv[1]) / CROP);
    }
    I.push(ni);
  }
  return { name: em.name, P, U, I, iris, side: left ? 'model-left(-X)' : 'model-right(+X)' };
}

const sides = [buildSide(-1), buildSide(+1)];
for (const s of sides)
  console.log(`${s.name} ${s.side}: ${s.P.length / 3} 顶点 / ${s.I.length / 3} 面`);

// UV 统计（应当基本落在 [0,1]，超出一点由 CLAMP 兜住）
for (const s of sides) {
  let u0 = 9, u1 = -9, v0 = 9, v1 = -9;
  for (let i = 0; i < s.P.length / 3; i++) {
    u0 = Math.min(u0, s.U[i * 2]); u1 = Math.max(u1, s.U[i * 2]);
    v0 = Math.min(v0, s.U[i * 2 + 1]); v1 = Math.max(v1, s.U[i * 2 + 1]);
  }
  console.log(`  ${s.name} UV 范围 u ${u0.toFixed(3)}..${u1.toFixed(3)}  v ${v0.toFixed(3)}..${v1.toFixed(3)}`);
  s.uvRange = [u0, u1, v0, v1];
}
{
  const xs = sides.flatMap((s) => Array.from({ length: s.P.length / 3 }, (_, i) => s.P[i * 3]));
  xs.sort((a, b) => a - b);
  console.log(`X 范围 ${xs[0].toFixed(4)} .. ${xs[xs.length - 1].toFixed(4)} 米（期望 ±0.041）`);
}

// UV 采样对齐：目标像素 (i,j) 的 UV 中心 = ((i+0.5)/N, (j+0.5)/N)（glTF 约定，
// v 向下）。源图坐标 = UV * srcW - 0.5（像素中心在 0.5）。这里手写，不用
// pngutil.resample，因为那份是给「贴图↔贴图」用的，坐标原点约定不同。
function resampleUV(tile, tw, th, tc, dst, N) {
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const fx = ((i + 0.5) / N) * tw - 0.5;
    const fy = ((j + 0.5) / N) * th - 0.5;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    x0 = Math.min(tw - 1, Math.max(0, x0)); x1 = Math.min(tw - 1, Math.max(0, x1));
    y0 = Math.min(th - 1, Math.max(0, y0)); y1 = Math.min(th - 1, Math.max(0, y1));
    const o = [0, 1, 2, 3].map((k) => ((y0 * tw + x0) * tc) + k);
    const p = [0, 1, 2, 3].map((k) => ((y0 * tw + x1) * tc) + k);
    const q = [0, 1, 2, 3].map((k) => ((y1 * tw + x0) * tc) + k);
    const r = [0, 1, 2, 3].map((k) => ((y1 * tw + x1) * tc) + k);
    const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    const d = (j * N + i) * 4;
    let wsum = 0;
    const a = [tile[o[3]], tile[p[3]], tile[q[3]], tile[r[3]]];
    for (let k = 0; k < 4; k++) wsum += a[k] * w[k];
    // alpha 加权（预乘）避免透明边缘发黑
    for (let c = 0; c < 3; c++) {
      let v = 0;
      v += tile[o[c]] * a[0] * w[0] + tile[p[c]] * a[1] * w[1] + tile[q[c]] * a[2] * w[2] + tile[r[c]] * a[3] * w[3];
      dst[d + c] = Math.round(wsum > 1e-6 ? v / wsum : 232);
    }
    dst[d + 3] = Math.round(wsum);
  }
}

// -------------------------------------------------- 裁出每只眼睛自己的贴图
const eyePng = path.join(SRC, 'eyes/materials/brown_eye.png');
const srcTex = decodePNG(fs.readFileSync(eyePng));
console.log(`\n源贴图 ${srcTex.w}×${srcTex.h} ch=${srcTex.ch}`);
const TEX_N = 512;
const texBin = [];
for (const s of sides) {
  const px = Math.round(s.iris.uv[0] * srcTex.w - CROP * srcTex.w / 2);
  const py = Math.round(s.iris.uv[1] * srcTex.h - CROP * srcTex.h / 2);
  const cw = Math.round(CROP * srcTex.w), chh = Math.round(CROP * srcTex.h);
  // 先在原图上裁一块（越界用边缘回绕，因为 UV 接缝会让采样越界 ±1px）
  const tile = Buffer.alloc(cw * chh * srcTex.ch);
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
    const sx = Math.min(srcTex.w - 1, Math.max(0, px + x));
    const sy = Math.min(srcTex.h - 1, Math.max(0, py + y));
    srcTex.data.copy(tile, (y * cw + x) * srcTex.ch, (sy * srcTex.w + sx) * srcTex.ch, (sy * srcTex.w + sx) * srcTex.ch + srcTex.ch);
  }
  // 采样点按 **UV 坐标**对齐（不是按像素中心）：UV 0..1 ↔ 贴图 0..1024，
  // 所以要取的是 uv*N 处的值，采样偏移 -0.5px。
  const outRgba = Buffer.alloc(TEX_N * TEX_N * 4);
  resampleUV(tile, cw, chh, srcTex.ch, outRgba, TEX_N, TEX_N);
  // RGBA → RGB，透明处用邻近眼球色填充（避免 mipmap 把黑边摊开）
  const rgb = Buffer.alloc(TEX_N * TEX_N * 3);
  for (let i = 0; i < TEX_N * TEX_N; i++) {
    const o = i * 4, d = i * 3;
    const a = outRgba[o + 3] / 255;
    const bg = 232;   // 眼白近似值
    rgb[d] = Math.round(outRgba[o] * a + bg * (1 - a));
    rgb[d + 1] = Math.round(outRgba[o + 1] * a + bg * (1 - a));
    rgb[d + 2] = Math.round(outRgba[o + 2] * a + bg * (1 - a));
  }
  const buf = encodePNG(TEX_N, TEX_N, rgb);
  texBin.push(buf);
  console.log(`${s.name} 贴图 裁自 (${px},${py}) ${cw}×${chh} → ${TEX_N}×${TEX_N}  ${(buf.length / 1024).toFixed(0)}KB`);
  s.texBuf = buf;
  s.irisPx = 0.224 / CROP * TEX_N;   // 虹膜直径在新贴图里的像素
  console.log(`   虹膜直径 ≈ ${s.irisPx.toFixed(0)}px / ${TEX_N}px`);
}

// ---------------------------------------------------------------- GLB 写出
function pushBVFactory(chunks) {
  let binLen = 0;
  const bv = [];
  return {
    bv, get binLen() { return binLen; },
    push(typed, target) {
      const pad = (4 - (binLen % 4)) % 4;
      if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; }
      const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
      bv.push({ buffer: 0, byteOffset: binLen, byteLength: buf.byteLength, ...(target ? { target } : {}) });
      chunks.push(buf); binLen += buf.byteLength;
      return bv.length - 1;
    },
    pushRaw(buf, target) {
      const pad = (4 - (binLen % 4)) % 4;
      if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; }
      bv.push({ buffer: 0, byteOffset: binLen, byteLength: buf.byteLength, ...(target ? { target } : {}) });
      chunks.push(buf); binLen += buf.byteLength;
      return bv.length - 1;
    },
  };
}
const chunks = [];
const BV = pushBVFactory(chunks);
const acc = [];
const addAcc = (d) => { acc.push(d); return acc.length - 1; };
const minMax = (arr, comp) => {
  const mn = new Array(comp).fill(Infinity), mx = new Array(comp).fill(-Infinity);
  for (let i = 0; i < arr.length; i++) { const c = i % comp; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; }
  return { min: mn, max: mx };
};

const nodes = [{ name: 'Armature' }];
const meshes = [], materials = [], textures = [], images = [];
const ROOT = 0;
nodes[ROOT].children = [];

for (const s of sides) {
  const texIdx = BV.pushRaw(s.texBuf);
  images.push({ bufferView: texIdx, mimeType: 'image/png', name: s.name + '_tex' });
  textures.push({ sampler: 0, source: images.length - 1 });
  materials.push({
    name: s.name + 'Mat',
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.16,
      baseColorTexture: { index: textures.length - 1 },
    },
    doubleSided: false,
  });

  const aPos = addAcc({ componentType: 5126, count: s.P.length / 3, type: 'VEC3', bufferView: BV.push(new Float32Array(s.P), 34962), ...minMax(s.P, 3) });
  const aUv = addAcc({ componentType: 5126, count: s.U.length / 2, type: 'VEC2', bufferView: BV.push(new Float32Array(s.U), 34962), ...minMax(s.U, 2) });
  const aIdx = addAcc({ componentType: 5125, count: s.I.length, type: 'SCALAR', bufferView: BV.push(new Uint32Array(s.I), 34963), ...minMax(s.I, 1) });
  meshes.push({
    name: s.name,
    primitives: [{ attributes: { POSITION: aPos, TEXCOORD_0: aUv }, indices: aIdx, material: materials.length - 1 }],
  });
  const ni = nodes.length;
  nodes.push({ name: s.name + '_node', mesh: meshes.length - 1 });
  nodes[ROOT].children.push(ni);
}

const json = {
  asset: { version: '2.0', generator: 'mheye-uv.mjs (MakeHuman CC0 eyes, source UV + per-eye cropped texture)' },
  scene: 0, scenes: [{ nodes: [ROOT] }],
  nodes, meshes, materials, accessors: acc, bufferViews: BV.bv,
  buffers: [{ byteLength: 0 }],
  textures, images,
  // CLAMP_TO_EDGE：每张贴图 = 一颗完整眼球，接缝回绕采到的是相邻像素，无缝。
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
};

let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
const binBuf = Buffer.concat(chunks);
json.buffers[0].byteLength = binBuf.length;
jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
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

// 顺带把两张裁图落到工作区，方便肉眼检查
for (const s of sides) {
  const dst = `C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/_eye_${s.name}.png`;
  fs.writeFileSync(dst, s.texBuf);
  console.log(`  ${s.name} 贴图预览 → ${dst}`);
}

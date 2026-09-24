// mh-expr.mjs —— 给 MakeHuman 身体**生成**缺失的表情 blendshape
// ===========================================================================
// 结论先行（都是实测出来的）：
//   1. 身体 GLB 自带 58 个 morph，但**全是体型/脸型滑块**（BodyHeight / EyeSize /
//      MouthWidth …），一个 expression 都没有（tools/mh-morphs.mjs 可复验）。
//   2. head 下那套肌肉骨（levator / orbicularis / oris …）确实存在，但实测
//      **转 6° 只能带动 0.5mm** 皮肤（tools/mh-facesolve.mjs 可复验）——
//      想闭眼得转到 30°+，那会把邻近的眼球和太阳穴一起扯变形。
//   ⇒ 所以：表情不靠它们，改成**离线算出顶点偏移，运行时注入成 morph**。
//
// 做法（几何编辑，不是风格迁移）：
//   眨眼：眼睑是包在眼球上的一层皮，所以"闭眼"≈ 把上眼睑那圈顶点**绕眼球中心的
//          X 轴往下转**，转完之后再把每个顶点**投影回球面**（保持贴着眼球，
//          不会出现轻微凸出或塌陷）。下眼睑同时轻轻上抬一点，才像活人。
//   笑  ：嘴角区域沿"上外侧"平移，距离嘴角越远衰减越快。
//
// ⚠️ 所有参数（眼球中心、半径、眼睑rim角度）必须**先 survey 再定**，不许拍脑袋。
//    用法：
//      node tools/mh-expr.mjs survey   打印眼部/嘴部几何分布
//      node tools/mh-expr.mjs gen      生成 assets/models4/aiva-expr-mh.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'models4', 'aiva-base-mh.glb');
const OUT = path.join(ROOT, 'assets', 'models4', 'aiva-expr-mh.json');

// ---------------------------------------------------------------- GLB 读取
function parseGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB: ' + file);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.slice(start, start + len);
    off = start + len;
  }
  return { json, bin };
}

const CTYPE = { 5120: { a: Int8Array, sz: 1 }, 5121: { a: Uint8Array, sz: 1 }, 5122: { a: Int16Array, sz: 2 }, 5123: { a: Uint16Array, sz: 2 }, 5125: { a: Uint32Array, sz: 4 }, 5126: { a: Float32Array, sz: 4 } };

function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const ct = CTYPE[acc.componentType];
  if (!ct) throw new Error('未知 componentType ' + acc.componentType);
  const numComps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const n = acc.count;
  const out = new ct.a(n * numComps);
  if (stride && stride !== ct.sz * numComps) {
    // 交错存放：逐顶点按 stride 跳
    const src = new ct.a(bin.buffer, bin.byteOffset + base, n * (stride / ct.sz));
    let k = 0;
    for (let i = 0; i < n; i++) {
      const s = (i * stride) / ct.sz;
      for (let c = 0; c < numComps; c++) out[k++] = src[s + c];
    }
    return out;
  }
  const src = new ct.a(bin.buffer, bin.byteOffset + base, n * numComps);
  out.set(src);
  return out;
}

// 节点世界变换（通常在 MakeHuman 导出里 scale=0.1 之类，必须乘回去）
function nodeMatrix(n) {
  const m = new Float64Array(16);
  if (n.matrix) { m.set(n.matrix); return m; }
  // 单位阵 + TRS
  m[0] = m[5] = m[10] = m[15] = 1;
  const t = n.translation || [0, 0, 0];
  const r = n.rotation || [0, 0, 0, 1];
  const s = n.scale || [1, 1, 1];
  const x = r[0], y = r[1], z = r[2], w = r[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

function loadBody() {
  const { json, bin } = parseGlb(SRC);
  const meshDef = json.meshes.find((m) => m.name === 'AIVA_Body') || json.meshes[0];
  const prim = meshDef.primitives[0];
  const local = readAccessor(json, bin, prim.attributes.POSITION);
  // 找到挂这个 mesh 的节点，取其 scale（MakeHuman 导出常带 0.1）
  let node = json.nodes.find((n) => n.mesh === json.meshes.indexOf(meshDef));
  const idx = json.nodes.findIndex((n) => n.mesh !== undefined && json.meshes[n.mesh] === meshDef);
  node = idx >= 0 ? json.nodes[idx] : node;
  const m = node ? nodeMatrix(node) : null;
  const scale = m ? m[0] : 1;   // 假设等比
  const nv = local.length / 3;
  const pos = new Float64Array(local.length);
  for (let i = 0; i < local.length; i++) pos[i] = local[i] * scale;
  return { json, bin, meshDef, nv, pos, scale, nodeName: node?.name };
}

// ∘∘∘ 第一版 survey 的教训（避免重蹈）：
//   直接按"到眼球中心距离 < 2.6R"统计极角是没用的：
//   ① 左右眼结果一模一样 —— 因为遍历的是整张脸，+X 侧和 −X 侧的邻域互相包含，
//      又因为脸是镜像对称的，两边数出来是同一组数；
//   ② 极角范围 −180°~+180° —— 眼眶**内壁**的顶点也被统计进去了，它们绕在眼球后面。
//   所以这里用"方向占用保留最外层"：把方向划分成小格子，每格只留半径最大的顶点，
//   这样看不见的内壁自然被淘汰，剩下的就是脸的外表面（也就是眼睑）。
let posOf = null;

function outerMost(idxList, cx, cy, cz, cellDeg = 4) {
  const cell = new Map();
  for (const i of idxList) {
    const dx = posOf(i, 0) - cx, dy = posOf(i, 1) - cy, dz = posOf(i, 2) - cz;
    const r = Math.hypot(dx, dy, dz);
    const elev = Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    const azi = Math.atan2(dx, dz) * 180 / Math.PI;
    const key = Math.round(elev / cellDeg) + '|' + Math.round(azi / cellDeg);
    const prev = cell.get(key);
    if (!prev || r > prev.r) cell.set(key, { i, r, elev, azi, dx, dy, dz });
  }
  return [...cell.values()];
}

function survey2() {
  const { nv, pos } = loadBody();
  posOf = (i, k) => pos[i * 3 + k];
  const mm = (v) => (v * 1000).toFixed(1);

  const EYES = [
    { s: 'L(+X 画面左)', cx: 0.0314, cy: 1.5768, cz: 0.1438 },
    { s: 'R(-X)', cx: -0.0314, cy: 1.5768, cz: 0.1438 },
  ];

  for (const e of EYES) {
    const near = [];
    for (let i = 0; i < nv; i++) {
      const dx = pos[i * 3] - e.cx, dy = pos[i * 3 + 1] - e.cy, dz = pos[i * 3 + 2] - e.cz;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.024) near.push(i);
    }
    const skin = outerMost(near, e.cx, e.cy, e.cz);
    const up = skin.filter((v) => v.dy > 0.0008);
    const lo = skin.filter((v) => v.dy < -0.0008);
    const r_arr = skin.map((v) => v.r);
    r_arr.sort((a, b) => a - b);
    console.log(`\n-- 眼 ${e.s} --`);
    console.log(`   邻域 ${near.length} 点 → 保留最外层 ${skin.length} 点（上睑 ${up.length} / 下睑 ${lo.length}）`);
    console.log(`   半径 ${mm(r_arr[0])}~${mm(r_arr[r_arr.length - 1])}mm  中位 ${mm(r_arr[Math.floor(r_arr.length / 2)])}mm`);
    const el = skin.map((v) => v.elev).sort((a, b) => a - b);
    console.log(`   仰角范围 ${el[0].toFixed(1)}° ~ ${el[el.length - 1].toFixed(1)}°`);
    // 上睑：仰角越高越靠近眉；睑缘 = 仰角**最大**的那批 Verlet?? 不 —— 睑缘是贴着眼球一圈，半径较小
    const upSorted = [...up].sort((a, b) => a.r - b.r);
    console.log('   上睑半径最小的 8 个点（这组就是"睑缘"，它们离眼球最近、绕出开口）：');
    for (const v of upSorted.slice(0, 8)) {
      console.log(`     i=${String(v.i).padStart(5)}  r=${mm(v.r)}mm  仰角 ${v.elev.toFixed(1)}°  方位 ${v.azi.toFixed(1)}°  (dx=${mm(v.dx)},dy=${mm(v.dy)},dz=${mm(v.dz)})`);
    }
    console.log(`   上睑半径中位数 ${mm(upSorted[Math.floor(upSorted.length / 2)].r)}mm`);
  }

  // 借睫毛网格定位睑缘：睫毛是沿着上睑缘长的
  try {
    const parts = path.join(ROOT, 'assets', 'models4', 'aiva-parts-mh.glb');
    const { json, bin } = parseGlb(parts);
    console.log('\n== aiva-parts-mh.glb ==');
    for (const m of json.meshes) {
      const prim = m.primitives[0];
      const p = readAccessor(json, bin, prim.attributes.POSITION);
      let xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9, zmin = 1e9, zmax = -1e9;
      for (let i = 0; i < p.length; i += 3) {
        xmin = Math.min(xmin, p[i]); xmax = Math.max(xmax, p[i]);
        ymin = Math.min(ymin, p[i + 1]); ymax = Math.max(ymax, p[i + 1]);
        zmin = Math.min(zmin, p[i + 2]); zmax = Math.max(zmax, p[i + 2]);
      }
      console.log(`  ${m.name.padEnd(14)} ${p.length / 3} 点  X ${mm(xmin)}~${mm(xmax)}  Y ${mm(ymin)}~${mm(ymax)}  Z ${mm(zmin)}~${mm(zmax)} mm`);
    }
  } catch (err) { console.log('睫毛网格读取失败: ' + err.message); }
}

function surveyAperture() {
  const { json, bin, nv, pos, meshDef } = loadBody();
  const prim = meshDef.primitives[0];
  const idxAttr = prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : null;
  const triCount = idxAttr ? idxAttr.length / 3 : nv / 3;
  const mm = (v) => (v * 1000).toFixed(1);

  // 先修正解剖常数：眼球网格实测 X 22.0~41.1 / Y 1568.4~1587.0 / Z 133.6~149.2 (mm)
  const EC = { x: (22.0 + 41.1) / 2000, y: (1568.4 + 1587.0) / 2000, z: (133.6 + 149.2) / 2000 };
  const ER = (149.2 - 133.6) / 2000;
  console.log(`== aperture ==  三角形 ${triCount}`);
  console.log(`眼球中心 (${mm(EC.x)}, ${mm(EC.y)}, ${mm(EC.z)})mm  半径 ${mm(ER)}mm`);

  const get = (i, k) => pos[i * 3 + k];
  const idOf = (t, k) => (idxAttr ? idxAttr[t * 3 + k] : t * 3 + k);

  // 射线: 原点在眼球正前方 0.5m，沿 -Z 射；问"这一段路径上有没有皮肤挡着"
  // 判据：命中点 z 落在 eyeball 前后 20mm 内才算"盖住了眼睛"
  function blocked(px, py, zFrom = 0.5) {
    for (let t = 0; t < triCount; t++) {
      const a = idOf(t, 0), b = idOf(t, 1), c = idOf(t, 2);
      const ax = get(a, 0), ay = get(a, 1);
      const bx = get(b, 0), by = get(b, 1);
      const cx = get(c, 0), cy = get(c, 1);
      // 先用 XY 包围盒快筛
      if (px < Math.min(ax, bx, cx) - 1e-6 || px > Math.max(ax, bx, cx) + 1e-6) continue;
      if (py < Math.min(ay, by, cy) - 1e-6 || py > Math.max(ay, by, cy) + 1e-6) continue;
      // 重心坐标
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / d;
      const v = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const za = get(a, 2), zb = get(b, 2), zc = get(c, 2);
      const hitZ = za * (1 - u - v) + zb * u + zc * v;
      if (hitZ > EC.z - 0.020 && hitZ < EC.z + 0.030) return hitZ;
    }
    return null;
  }

  for (const side of ['L(+X)', 'R(-X)']) {
    const ex = side.startsWith('L') ? EC.x : -EC.x;
    console.log(`\n-- ${side} 正中 X=${mm(ex)}mm，沿 Y 扫描，看哪里没有皮肤挡住（=开口）--`);
    let line = '';
    const open = [];
    for (let dy = -0.016; dy <= 0.016001; dy += 0.001) {
      const z = blocked(ex, EC.y + dy);
      if (z === null) { line += '.'; open.push(dy); } else line += '#';
    }
    console.log(`   dy -16mm ──────────────── +16mm`);
    console.log(`      ${line}`);
    if (open.length) {
      console.log(`   开口 dy: ${mm(open[0])} ~ ${mm(open[open.length - 1])}mm  高度 ${mm(open[open.length - 1] - open[0])}mm`);
    } else {
      console.log('   ⚠️ 没有开口 —— 眼睛位置被一整片皮肤盖着');
    }
  }
}

// ---- survey 第一版：保留作对照，它为什么会得出无用结论写在 survey2 上方 ----
function surveyV1() {
  const { nv, pos, scale, nodeName } = loadBody();
  console.log(`== survey ==  顶点 ${nv}  节点 ${nodeName}  scale ${scale}`);

  const mm = (v) => (v * 1000).toFixed(1);

  // 找到 y 最高的点作为头顶，粗略给出身高
  let ymax = -1e9, ymin = 1e9;
  for (let i = 0; i < nv; i++) { const y = pos[i * 3 + 1]; if (y > ymax) ymax = y; if (y < ymin) ymin = y; }
  console.log(`模型 Y 范围 ${ymin.toFixed(3)} ~ ${ymax.toFixed(3)} m`);

  // --- 眼球：搜一圈(POSITION 数组)在 y∈[1.55,1.61] 里最靠前的点附近 ---
  // 已知（上一次会话实测）：眼球渲染中心 (±0.0314, 1.5768, 0.1438)，半径 ≈0.0125
  const EYE = [
    { side: 'L(+X)', cx: 0.0314, cy: 1.5768, cz: 0.1438 },
    { side: 'R(-X)', cx: -0.0314, cy: 1.5768, cz: 0.1438 },
  ];
  const R = 0.0125;

  for (const e of EYE) {
    // 统计绕 X 轴的极角 theta = atan2(y-cy, z-cz)，按半径分层
    const bands = [
      { name: 'r<1.0R', lo: 0, hi: 1.0 },
      { name: '1.0-1.3R', lo: 1.0, hi: 1.3 },
      { name: '1.3-1.6R', lo: 1.3, hi: 1.6 },
      { name: '1.6-2.0R', lo: 1.6, hi: 2.0 },
      { name: '2.0-2.6R', lo: 2.0, hi: 2.6 },
    ];
    const acc = bands.map(() => ({ n: 0, amin: 1e9, amax: -1e9, sum: 0 }));
    for (let i = 0; i < nv; i++) {
      const dx = pos[i * 3] - e.cx, dy = pos[i * 3 + 1] - e.cy, dz = pos[i * 3 + 2] - e.cz;
      const rr = Math.hypot(dx, dy, dz);
      if (rr > R * 2.6) continue;
      const th = Math.atan2(dy, dz) * 180 / Math.PI;
      for (let b = 0; b < bands.length; b++) {
        if (rr >= R * bands[b].lo && rr < R * bands[b].hi) {
          const a = acc[b]; a.n++; a.sum += th;
          if (th < a.amin) a.amin = th; if (th > a.amax) a.amax = th;
          break;
        }
      }
    }
    console.log(`\n-- 眼 ${e.side} 中心 (${e.cx}, ${e.cy}, ${e.cz}) R=${mm(R)}mm --`);
    console.log('   半径带        顶点数   极角范围(度,0=正前 90=正上)');
    bands.forEach((b, i) => {
      const a = acc[i];
      if (!a.n) { console.log(`   ${b.name.padEnd(12)} 0`); return; }
      console.log(`   ${b.name.padEnd(12)} ${String(a.n).padStart(5)}   ${a.amin.toFixed(1)} ~ ${a.amax.toFixed(1)}   均值 ${(a.sum / a.n).toFixed(1)}`);
    });
  }

  // --- 嘴 ---
  const MOUTH = { cx: 0, cy: 1.505, cz: 0.147 };
  console.log(`\n-- 嘴 参考中心 (${MOUTH.cx}, ${MOUTH.cy}, ${MOUTH.cz}) --`);
  for (const rMax of [0.012, 0.018, 0.026, 0.036, 0.05]) {
    let n = 0, xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9, zmin = 1e9, zmax = -1e9;
    for (let i = 0; i < nv; i++) {
      const dx = pos[i * 3] - MOUTH.cx, dy = pos[i * 3 + 1] - MOUTH.cy, dz = pos[i * 3 + 2] - MOUTH.cz;
      if (Math.hypot(dx, dy, dz) > rMax) continue;
      n++; xmin = Math.min(xmin, dx); xmax = Math.max(xmax, dx);
      ymin = Math.min(ymin, dy); ymax = Math.max(ymax, dy);
      zmin = Math.min(zmin, dz); zmax = Math.max(zmax, dz);
    }
    console.log(`   r<${mm(rMax)}mm: ${String(n).padStart(4)} 点  X ${mm(xmin)}~${mm(xmax)}  Y ${mm(ymin)}~${mm(ymax)}  Z ${mm(zmin)}~${mm(zmax)}`);
  }

  // --- 眉毛 ---
  console.log('\n-- 眉区（y 1.60~1.63, 最靠前的点）--');
  for (const part of ['L(+X)']) {
    for (const xr of [[0.008, 0.045], [-0.045, -0.008]]) {
      let n = 0, zmax = -1e9, yatz = 0, xatz = 0;
      for (let i = 0; i < nv; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (x < xr[0] || x > xr[1]) continue;
        if (y < 1.595 || y > 1.635) continue;
        n++; if (z > zmax) { zmax = z; yatz = y; xatz = x; }
      }
      console.log(`   X ${xr[0]}~${xr[1]}: ${n} 点，最前 Z=${mm(zmax)}mm 在 (${mm(xatz)},${mm(yatz)})`);
    }
  }
}

// ---------------------------------------------------------------- 生成
// ===========================================================================
// 眨眼是怎么算出来的（每一步都有实测依据）：
//   aperture 实测：眼裂垂直范围 dy = -4.0 ~ +3.0 mm（相对眼球中心），
//   也就是**上睑缘要在完全闭合时下移 7.5mm** 才能盖住下睑缘。
//
//   位移量随"离睑缘多远"衰减：
//     · 水平：越过内外眼角就衰减到 0（不然后眼角会被扯下来，变成"睡不醒"）
//     · 垂直：从睑缘往上 10mm 衰减到 0（超过这个高度就是眉，眉不参与眨眼）
//   最后一步**球面投影**：把移动后的点沿"离眼球中心的方向"推到
//   R+1.2mm 之外，保证皮肤不会被塞进眼球里（否则会看到眼珠撑破眼皮）。
//
//   还有一个隐形杀手：眼窝**内壁**也有一层皮，它们的顶点也落在同样的半径上。
//   判据是法线方向 —— 外表面法线背离眼球中心，内壁法线指向中心，
//   用 dot(normal, p-center) > 0 就能把内壁剔掉。
// ===========================================================================

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
function smoothstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

// ===========================================================================
// 第一版生成结果（已实测，结论必须记住）：
//   "52 个顶点下移 8.3mm" —— 数字听着成立，渲染出来**几乎没动**。
//   原因不是算法不对，是**根本没动到睑缘那几个顶点**：
//     · 判据 `z < cz-0.001 → continue` 和法线朝外筛，一刀砍掉了大半邻域；
//     · `dy0 > apTop+0.0125` 的上界太紧，眉下的皮肤整片退出；
//     · 最终只剩 52 个点，而这 52 个点的 y 大多在开口**上方 8mm 以外**，
//       它们下移 8mm 只是把眼皮压浅了一点，睑缘本身纹丝不动。
//   修法（见下）：不再"筛掉远处的点"，而是**按到睑缘的弧长距离连续衰减**，
//   让"睑缘顶点权重=1、往上逐级变 0"，参与顶点数应该涨到几百个量级。
// ===========================================================================

/** 找出睑缘那一圈顶点 —— 射线在开口上下边界处命中的三角形，它们的顶点就是睑缘 */
function rimVertices(EYE, pos, idxAttr, triCount, cy, zLo, zHi, yOpenLo, yOpenHi) {
  const hit = new Set();
  const probe = (px, py) => {
    let best = null;
    for (let t = 0; t < triCount; t++) {
      const a = idxAttr ? idxAttr[t * 3] : t * 3, b = idxAttr ? idxAttr[t * 3 + 1] : t * 3 + 1, c = idxAttr ? idxAttr[t * 3 + 2] : t * 3 + 2;
      const ax = pos[a * 3], ay = pos[a * 3 + 1], bx = pos[b * 3], by = pos[b * 3 + 1], cx2 = pos[c * 3], cy2 = pos[c * 3 + 1];
      if (px < Math.min(ax, bx, cx2) || px > Math.max(ax, bx, cx2)) continue;
      if (py < Math.min(ay, by, cy2) || py > Math.max(ay, by, cy2)) continue;
      const d = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((px - ax) * (cy2 - ay) - (cx2 - ax) * (py - ay)) / d;
      const v = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const hz = pos[a * 3 + 2] * (1 - u - v) + pos[b * 3 + 2] * u + pos[c * 3 + 2] * v;
      if (hz > zLo && hz < zHi && (best === null || hz > best.z)) best = { z: hz, a, b, c };
    }
    return best;
  };
  // 沿着开口边界绕一圈采样水平位置
  const halfW = 0.0111;
  for (const yy of [cy + yOpenHi + 0.0002, cy + yOpenLo - 0.0002]) {
    for (let dx = -halfW * 1.25; dx <= halfW * 1.251; dx += 0.0004) {
      const b = probe(EYE.cx + dx * EYE.sgn, yy);
      if (b) { hit.add(b.a); hit.add(b.b); hit.add(b.c); }
    }
  }
  // 再补一次：竖直方向扫内/外眼角
  for (const xx of [EYE.cx + (-halfW * 1.25) * EYE.sgn, EYE.cx + (halfW * 1.25) * EYE.sgn]) {
    for (let dy = yOpenLo - 0.001; dy <= yOpenHi + 0.001; dy += 0.0004) {
      const b = probe(xx, cy + dy);
      if (b) { hit.add(b.a); hit.add(b.b); hit.add(b.c); }
    }
  }
  return [...hit];
}

function gen() {
  const { json, bin, nv, pos, meshDef } = loadBody();
  const prim = meshDef.primitives[0];
  const idxAttr = prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : null;
  const nrmAttr = prim.attributes.NORMAL !== undefined ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
  const triCount = idxAttr ? idxAttr.length / 3 : nv / 3;
  const mm = (v) => (v * 1000).toFixed(1);
  if (!nrmAttr) { console.error('⚠️ 这个 GLB 没有 NORMAL 属性，无法剔除眼窝内壁，先算了'); }

  // ---- 1) 用射线量出每只眼的开口（aperture）----------------------------
  function ray(px, py, zNeedLo, zNeedHi) {
    let best = -Infinity;
    for (let t = 0; t < triCount; t++) {
      const a = idxAttr ? idxAttr[t * 3] : t * 3, b = idxAttr ? idxAttr[t * 3 + 1] : t * 3 + 1, c = idxAttr ? idxAttr[t * 3 + 2] : t * 3 + 2;
      const ax = pos[a * 3], ay = pos[a * 3 + 1], bx = pos[b * 3], by = pos[b * 3 + 1], cx = pos[c * 3], cy = pos[c * 3 + 1];
      if (px < Math.min(ax, bx, cx) || px > Math.max(ax, bx, cx)) continue;
      if (py < Math.min(ay, by, cy) || py > Math.max(ay, by, cy)) continue;
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / d;
      const v = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const hz = pos[a * 3 + 2] * (1 - u - v) + pos[b * 3 + 2] * u + pos[c * 3 + 2] * v;
      if (hz > zNeedLo && hz < zNeedHi && hz > best) best = hz;
    }
    return best;
  }

  const EYES = [
    { key: 'left', sgn: +1, name: 'eyeBlinkLeft' },
    { key: 'right', sgn: -1, name: 'eyeBlinkRight' },
  ];
  const out = { version: 1, source: 'aiva-base-mh.glb', mesh: meshDef.name, vertexCount: nv, unit: 'meter', channels: {}, info: {} };

  for (const E of EYES) {
    const cx = 0.0316 * E.sgn, cy = 1.5777, cz = 0.1414;
    const R = 0.0078;
    const zLo = cz - 0.020, zHi = cz + 0.030;

    // 垂直扫描
    let yOpenLo = null, yOpenHi = null;
    for (let dy = -0.014; dy <= 0.014001; dy += 0.00025) {
      const z = ray(cx, cy + dy, zLo, zHi);
      if (z === -Infinity) { if (yOpenLo === null) yOpenLo = dy; yOpenHi = dy; }
    }
    if (yOpenLo === null) { console.error(`${E.key} 眼没找到开口，跳过`); continue; }
    const apMidY = cy + (yOpenLo + yOpenHi) / 2;
    // 水平扫描（在开口中线上）
    let xOpenLo = null, xOpenHi = null;
    for (let dx = -0.018; dx <= 0.018001; dx += 0.00025) {
      const z = ray(cx + dx * E.sgn, apMidY, zLo, zHi);
      if (z === -Infinity) { if (xOpenLo === null) xOpenLo = dx; xOpenHi = dx; }
    }
    const halfW = (xOpenHi - xOpenLo) / 2;
    const midX = cx + ((xOpenLo + xOpenHi) / 2) * E.sgn;
    const apTop = yOpenHi, apBot = yOpenLo;         // 相对中心(mm 在下面换算)
    console.log(`\n-- ${E.key} 眼 --`);
    console.log(`   开口 垂直 ${mm(yOpenLo)}~${mm(yOpenHi)}mm  水平半宽 ${mm(halfW)}mm（中心 X=${mm(midX)}mm）`);

    const OVER = Number(process.argv[3] || 1);   // 超行程系数（1=刚好合上，>1 让上下睑**交叠**，不留缝）
    const Td = ((apTop - apBot) + 0.0008) * OVER;
    console.log(`   上睑下移量 ${mm(Td)}mm`);

    // --- 先钉住"睑缘"那一圈顶点，再按**到睑缘的弧长距离**连续衰减 ---------
    const eyeForRim = { cx, sgn: E.sgn };
    const rim = rimVertices(eyeForRim, pos, idxAttr, triCount, cy, zLo, zHi, yOpenLo, yOpenHi);
    const rimUp = rim.filter((i) => pos[i * 3 + 1] >= cy + yOpenHi - 0.0015);
    console.log(`   睑缘顶点 ${rim.length} 个（其中上睑缘 ${rimUp.length} 个）`);
    if (!rimUp.length) { console.error('   ⚠️ 没找到上睑缘顶点，这一侧跳过'); continue; }
    // 上睑缘的锚点：取中间那段（避开内外眼角），用它的 y 作为"行程 100% 线"
    const rimYs = rimUp.map((i) => pos[i * 3 + 1]).sort((a, b) => a - b);
    const rimAnchorY = rimYs[Math.floor(rimYs.length * 0.75)];

    const idxOut = [], offOut = [];
    let debugMax = 0, debugCnt = 0;
    for (let i = 0; i < nv; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (z < cz - 0.012) continue;                       // 只剩眼眶前方的皮
      const dxr = (x - cx) * E.sgn;
      const adx = Math.abs(dxr);
      // 水平：外眼角外 8mm 才归零（放宽，不然眼角会出现折角）
      const wx = 1 - smoothstep(halfW * 0.95, halfW * 1.55, adx);
      if (wx <= 0.002) continue;
      const dy0 = y - cy;
      if (dy0 < -0.016 || dy0 > apTop + 0.026) continue;   // 往上给到眉毛才算自然过渡

      // 剔除眼窝内壁：法线背向眼球中心
      if (nrmAttr) {
        const nx = nrmAttr[i * 3], ny = nrmAttr[i * 3 + 1], nz = nrmAttr[i * 3 + 2];
        if (nx * (x - cx) + ny * (y - cy) + nz * (z - cz) <= 0) continue;
      }

      // 垂直：**相对睑缘**算距离，睑缘处 s=1，往上 12mm 归零。
      // 低于睑缘（也就是开口内侧那几毫米）给满行程，避免出现一条缝。
      const above = y - rimAnchorY;
      let s;
      if (above <= 0) s = 1 - smoothstep(-0.001, -0.004, above) * 0.0;
      else s = 1 - smoothstep(0, 0.012, above);
      if (s <= 0.002) continue;

      let dy = -Td * s * wx;
      if (dy0 < -0.002) {
        // 下睑轻抬
        const t = clamp01((dy0 - (-0.0135)) / 0.0125);
        dy = +0.0024 * (4 * t * (1 - t)) * wx;
      }
      if (Math.abs(dy) < 1e-6) continue;

      let nx2 = x, ny2 = y + dy, nz2 = z;
      const vx = nx2 - cx, vy = ny2 - cy, vz = nz2 - cz;
      const rnow = Math.hypot(vx, vy, vz) || 1e-9;
      const rmin = R + 0.0012;
      if (rnow < rmin) {
        const k = rmin / rnow;
        nx2 = cx + vx * k; ny2 = cy + vy * k; nz2 = cz + vz * k;
      }
      const m = Math.hypot(nx2 - x, ny2 - y, nz2 - z);
      if (m > debugMax) debugMax = m;
      debugCnt += m > 0.002 ? 1 : 0;
      idxOut.push(i);
      offOut.push(+(nx2 - x).toFixed(6), +(ny2 - y).toFixed(6), +(nz2 - z).toFixed(6));
    }
    out.channels[E.name] = { idx: idxOut, off: offOut };
    out.info[E.name] = {
      centerX: +midX.toFixed(5), centerY: +cy.toFixed(5), centerZ: +cz.toFixed(5),
      apertureY: [+yOpenLo.toFixed(6), +yOpenHi.toFixed(6)],
      apertureHalfWidth: +halfW.toFixed(6), travel: +Td.toFixed(6),
      rimAnchorY: +rimAnchorY.toFixed(6), rimVerts: rimUp.length,
      verts: idxOut.length, movingOver2mm: debugCnt, maxMove: +debugMax.toFixed(5),
    };
    console.log(`   生成 ${E.name}: ${idxOut.length} 个顶点参与，其中位移>2mm 的有 ${debugCnt} 个，最大位移 ${mm(debugMax)}mm`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\n已写出 ${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1024).toFixed(1)}KB`);
}

const mode = process.argv[2] || 'survey2';
if (mode === 'survey2') survey2();
else if (mode === 'aperture') surveyAperture();
else if (mode === 'survey1') surveyV1();
else gen();

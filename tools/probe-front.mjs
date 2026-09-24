#!/usr/bin/env node
/**
 * probe-front.mjs — 精确回答一个问题：**脸上每一行，最靠前的是什么？**
 *
 * 为什么需要它：
 *   之前六轮都在"看图猜"，因为截图既无法量。
 *   本工具把 GLB 里所有顶点按 y 分层，每层取出 z 最大（最靠前）的那批顶点，
 *   打印它们的 (x, z, 所属 kind)。只要脸上某一行最靠前的是 hair，
 *   那它就是"遮脸元凶"，并且能直接读出它的 x 和 z —— 精确到毫米。
 *
 * 用法：
 *   node tools/probe-front.mjs realistic-elena
 *   node tools/probe-front.mjs realistic-elena --rows 24
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS = path.join(ROOT, 'assets', 'models2');

const NAME = process.argv[2] || 'realistic-elena';
const ROWS = Number((process.argv.includes('--rows') ? process.argv[process.argv.indexOf('--rows') + 1] : 20));

// --- 最小 GLB 解析：只取 POSITION 和 COLOR_0 -------------------------------
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

const COMP = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(json, bin, idx) {
  const a = json.accessors[idx];
  const bv = json.bufferViews[a.bufferView];
  const T = COMP[a.componentType];
  const n = NUM[a.type];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  // 交错布局不处理（本项目导出器是紧密排列）
  const arr = new T(bin.buffer, bin.byteOffset + start, a.count * n);
  return { arr, n, count: a.count };
}

// --- 调色板：从 builder 源码里抠出每个 preset 的 hair / skin 基色 ----------
function loadPalette() {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'build-realistic.mjs'), 'utf8');
  const pal = {};
  // ⚠️ split 的捕获组给到的就是带 "realistic-" 前缀的完整 key，不要再拼一次前缀
  const blocks = src.split(/'(realistic-[a-z]+)':\s*\{/).slice(1);
  for (let i = 0; i < blocks.length; i += 2) {
    const name = blocks[i], body = blocks[i + 1];
    const grab = (key) => {
      const m = body.match(new RegExp(key + ":\\s*\\[([^\\]]+)\\]"));
      if (!m) return null;
      return m[1].split(',').map((v) => parseFloat(v.trim()));
    };
    const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
    const mul = (c, k) => c.map((v) => v * k);
    const hair = grab('hair'), hairHi = grab('hairHi');
    const skin = grab('skin'), skinShade = grab('skinShade');
    const hairSet = [hair, hairHi].filter(Boolean);
    const skinSet = [skin, skinShade, skin && mul(skin, 0.82)].filter(Boolean);
    pal[name] = { hair: hairSet, skin: skinSet };
  }
  return pal;
}

function classify(rgb, sets, TOL) {
  let best = null, bestD = 1e9;
  for (const [cls, list] of Object.entries(sets)) {
    for (const c of list) {
      const d = Math.abs(rgb[0] - c[0]) + Math.abs(rgb[1] - c[1]) + Math.abs(rgb[2] - c[2]);
      if (d < bestD) { bestD = d; best = cls; }
    }
  }
  return bestD <= TOL ? best : '?';
}

function main() {
  const file = path.join(MODELS, `${NAME}.glb`);
  const { json, bin } = readGlb(file);
  const pal = loadPalette()[NAME];
  if (!pal) throw new Error(`调色板里没有 ${NAME}`);

  const pts = [];
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      const pos = readAccessor(json, bin, prim.attributes.POSITION);
      const colAttr = prim.attributes.COLOR_0;
      const col = colAttr != null ? readAccessor(json, bin, colAttr) : null;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.arr[i * 3], y = pos.arr[i * 3 + 1], z = pos.arr[i * 3 + 2];
        let cls = '?';
        if (col) {
          const r = col.arr[i * col.n], g = col.arr[i * col.n + 1], b = col.arr[i * col.n + 2];
          cls = classify([r, g, b], { hair: pal.hair, skin: pal.skin }, 0.09);
        }
        pts.push({ x, y, z, cls });
      }
    }
  }

  const ys = pts.map((p) => p.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const H = yMax - yMin;

  // ⚠️ 头高 / 头顶**必须从骨骼取**，不能拿网格最高点估。
  //    踩坑经过：原来写 headH = H/7.7、headTop = yMax。
  //    给 rion 加了尖发之后 yMax 被刺抬高 19mm，FACE_TOP 跟着上移，
  //    扫描窗的**顶行正好落进发际线** —— 那儿本来就该有头发，
  //    probe 却报"头发盖脸"（实测 z=76.5mm 的假阳性）。
  //    骨骼的 HeadTop_End - Head 不受发型影响，和 inspect-character 口径一致。
  const wpOf = (() => {
    const cache = new Map();
    const nodes = json.nodes || [];
    return function wp(i) {
      if (cache.has(i)) return cache.get(i);
      const n = nodes[i];
      let p = n.matrix ? [n.matrix[12], n.matrix[13], n.matrix[14]]
                       : (n.translation || [0, 0, 0]).slice();
      const par = nodes.findIndex((x) => (x.children || []).includes(i));
      if (par >= 0) { const q = wp(par); p = [p[0] + q[0], p[1] + q[1], p[2] + q[2]]; }
      cache.set(i, p);
      return p;
    };
  })();
  let headTop = yMax, headH = H / 7.7;
  const iHead = (json.nodes || []).findIndex((n) => n.name === 'Head');
  const iTop = (json.nodes || []).findIndex((n) => n.name === 'HeadTop_End');
  if (iHead >= 0 && iTop >= 0) {
    headH = wpOf(iTop)[1] - wpOf(iHead)[1];
    headTop = wpOf(iTop)[1];
  }
  const headBottom = headTop - headH;

  // ⚠️ 只扫**真正的脸**：发际线以下、下巴以上。
  //    之前从 headBottom 一路扫到 headTop，把颅顶也算进去 ——
  //    而颅顶本来就该被头发盖住，于是永远有 5~6 行"假阳性"，
  //    让人以为额头一直没修好。发际线取眉上 3cm 处。
  const FACE_TOP = headTop - headH * 0.42;      // 发际线（略低于颅顶 42% 头高）
  const FACE_BOT = headTop - headH * 0.97;      // 下巴

  console.log(`\n  ${NAME}  总高 ${H.toFixed(3)}m  头高 ${headH.toFixed(3)}m  顶点 ${pts.length}`);
  console.log(`  只扫**面部区间** y = ${FACE_BOT.toFixed(3)} ~ ${FACE_TOP.toFixed(3)}m（发际线以下），共 ${ROWS} 行`);
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  console.log('  行      y(m)    脸内最靠前     z(mm)    x(mm)   头发最靠前 z(mm)  判定');
  console.log('  ─────────────────────────────────────────────────────────────────────────');

  let bad = 0;
  for (let r = 0; r < ROWS; r++) {
    const y0 = FACE_BOT + (r / ROWS) * (FACE_TOP - FACE_BOT);
    const y1 = FACE_BOT + ((r + 1) / ROWS) * (FACE_TOP - FACE_BOT);
    const band = pts.filter((p) => p.y >= y0 && p.y < y1);
    if (!band.length) continue;

    // 只关心脸的中段宽度（避开鬓角/耳朵）
    const faceBand = band.filter((p) => Math.abs(p.x) < headH * 0.72 * 0.52);
    if (!faceBand.length) continue;

    const frontFace = faceBand.filter((p) => p.cls === 'skin' || p.cls === '?')
      .sort((a, b) => b.z - a.z)[0];
    const frontHair = faceBand.filter((p) => p.cls === 'hair')
      .sort((a, b) => b.z - a.z)[0];

    const zf = frontFace ? frontFace.z : NaN;
    const zh = frontHair ? frontHair.z : NaN;
    //
    // ⚠️ 加一道「头发必须在头中心平面之前」的前置条件（zh > 10mm）。
    //    之前只要该行**取不到皮肤顶点**（网格在这一行恰好没有采样，
    //    实测 10 个角色里有 8 个会在某一行遇到），zf 就是 NaN，
    //    于是 `isNaN(zf)` 判真 → 不管头发在哪都算"盖脸"。
    //    可那一行头发最靠前的点常常在 z = -2.7mm —— 在头中心**后面**，
    //    物理上不可能挡住脸。这是纯假阳性，白白让人以为脸又坏了。
    //    人脸皮肤前沿在 z ≈ +90mm，所以 10mm 是个极宽松的门槛。
    const covering = (!isNaN(zh) && zh > 0.010 && (isNaN(zf) || zh > zf + 0.003));
    if (covering) bad++;

    console.log(
      `  ${String(r).padStart(2)}  ${((y0 + y1) / 2).toFixed(3)}` +
      `   ${(frontFace ? frontFace.cls : '-').padEnd(6)}` +
      `   ${isNaN(zf) ? '  -  ' : (zf * 1000).toFixed(1).padStart(6)}` +
      `  ${frontFace ? (frontFace.x * 1000).toFixed(0).padStart(6) : '     -'}` +
      `      ${isNaN(zh) ? '  -  ' : (zh * 1000).toFixed(1).padStart(6)}` +
      `      ${covering ? '❌ 头发盖脸' : '· 正常'}`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  console.log(`  ${bad} / ${ROWS} 行存在头发盖脸\n`);
}

main();

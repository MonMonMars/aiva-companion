#!/usr/bin/env node
/**
 * 头发体检 —— 只从 GLB 顶点数据里量「头发有没有糊住脸、有没有炸开」。
 *
 * 为什么单独做一个工具：
 *   写实档的头发是程序化铺出来的（底层壳 + 发束 + 垂落），
 *   最容易出的两个毛病肉眼在截图里很难判断：
 *
 *     ① 刘海压到眼睛以下 → 脸被"帘子"挡住（elena 的实际问题）
 *        量法：在**眼球前方**（z 大于眼球前缘）、**眼睛高度附近**的竖直带里，
 *              皮肤顶点是否被头发顶点覆盖。
 *
 *     ② 发束在耳朵高度向两侧炸开 → 蘑菇头
 *        量法：在耳朵高度，比较「头发的最外缘」和「颅骨的最外缘」。
 *              正常不超过颅骨 +1.5cm，超过 3cm 就是炸开。
 *
 *   两个指标都能用「头宽/头高」归一化，所以不同身高/头长可以直接横比。
 *
 * 用法：node tools/inspect-hair.mjs [name ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS = path.join(ROOT, 'assets', 'models2');

// ---------------------------------------------------------------------------
// 顶点颜色就是"材质分区"：项目里每个 part 都带一个 kind 颜色桶
// （skin / hair / eye / clothes / shoes / lips ...）。
// 头发顶点没法靠单独的 mesh 名字区分（全合成了一个 SkinnedMesh），
// 但导出的 COLOR_0 保留了每个 part 的基色 —— 用它反推分类最稳。
//
// 关卡：深棕/黑/栗棕/金棕，共同特征是 R>G>B 且饱和度低、明度低。
// 皮肤 R>G>B 但明度高得多（>0.55）。
// 所以判据：R>G>B 且 R<0.55 → hair（含眉，眉也是 hair 桶，量的时候要排除）。
// ---------------------------------------------------------------------------

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: 不是 GLB`);
  const total = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { g: json, bin };
}

/**
 * ⚠️ 不要用「暗暖色」这类**阈值猜测**来判头发。
 *    实际踩过的坑：mika / ren 的发色是 (0.06,0.06,0.08) / (0.10,0.10,0.12) —— 黑到发蓝，
 *    R>=G>=B 直接不成立，猜出来 hair 顶点只剩 286 个（真值 ~2000），
 *    于是「遮脸 0%、顶厚 -0.487H」全是假结果。
 *
 * 正确做法：把 build-realistic.mjs 的 PRESETS 里的头发基色当**精确调色板**，
 * 逐顶点做最近邻匹配（含 base / base×0.88 / base×0.85 这几个生成时用到的变体）。
 */
function loadPalette() {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'build-realistic.mjs'), 'utf8');
  const pal = {};
  // 逐个 preset 块抓 hair / hairHi / skin / skinShade
  const blocks = src.split(/'(realistic-[a-z]+)':\s*\{/).slice(1);
  for (let i = 0; i < blocks.length; i += 2) {
    const name = blocks[i], body = blocks[i + 1];
    const grab = (key) => {
      const m = body.match(new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`));
      if (!m) return null;
      const v = m[1].split(',').map((s) => parseFloat(s.trim()));
      return v.length === 3 && v.every((x) => Number.isFinite(x)) ? v : null;
    };
    const hair = grab('hair'), hairHi = grab('hairHi');
    const skin = grab('skin'), skinShade = grab('skinShade');
    // ⚠️ 眼睛也必须是一类，否则瞳孔会被误判成头发。
    //    瞳孔是近黑的 [0.04,0.03,0.03]；黑发角色（mika hair=[0.06,0.06,0.08]）
    //    与它的欧氏距离只有 0.062，小于 TOL=0.09 —— 于是瞳孔整片被算成"头发"，
    //    眼睛越大（FF7R 标准把 eyeR 从 0.082 提到 0.105）误判面积越大，
    //    遮脸率从 9.4% 虚涨到 16.3% 直接判失败。
    //    眼白 / 虹膜 / 瞳孔 / 高光点都归 eye，从 hair/skin 的统计里剔除。
    const eye = grab('eye');
    // 顺带把发型抠出来 —— 侧炸阈值要按发型定（长发本就该有体积）。
    const styleMatch = body.match(/hairStyle:\s*'([a-z-]+)'/);
    const style = styleMatch ? styleMatch[1] : 'short-crop';
    const mul = (c, k) => (c ? [c[0] * k, c[1] * k, c[2] * k] : null);
    // buildHair 里实际写入的颜色：base、mix(base,hi,0.55)、mix(base,black,0.12)、base×0.88
    const mix = (a, b, t) => (a && b ? [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] : null);
    const hairSet = [hair, hairHi, mix(hair, hairHi, 0.55), mul(hair, 0.88), mul(hair, 0.97)].filter(Boolean);
    const skinSet = [skin, skinShade, mul(skin, 0.82)].filter(Boolean);
    // ⚠️ split 的捕获组拿到的已经是完整键名 "realistic-xxx"，
    //    不要再拼一次前缀 —— 否则得到 "realistic-realistic-xxx"，
    //    PALETTE[name] 恒为 undefined，静默退回粗糙阈值（踩过）。
    // 眼球四件套：眼白(近白) / 虹膜(preset.eye) / 瞳孔(近黑) / 高光(纯白)
    const eyeSet = [[0.97, 0.96, 0.95], eye, [0.04, 0.03, 0.03], [1, 1, 1]].filter(Boolean);
    pal[name] = { hair: hairSet, skin: skinSet, eye: eyeSet, style };
  }
  return pal;
}

/**
 * 侧炸阈值必须**按发型**给，不能一刀切。
 *
 * ⚠️ 曾经统一用 0.035H，结果长发/波浪永久不合格：
 *    aria/mika(long-wavy) 0.069H、ren(medium-tousled) 0.061H 全被判"蘑菇头"。
 *    可 0.069H × 0.229m ≈ 1.6cm —— 长发垂在耳侧本来就要占这么多位置，
 *    这是**正确的**解剖量，不是蘑菇头。
 *
 *    真正的蘑菇头是什么量级？改坏时实测过 0.150H（≈3.4cm），
 *    那时候头发在耳朵高度整圈向外鼓，像扣了个碗 —— 那才该拦。
 *
 * 所以：短发贴头 → 严（0.035H）；长发/波浪/中长自然有体积 → 宽（0.09H）。
 * 两个门之间留足余量，既能容下真发的量感，又拦得住鼓包。
 */
const puffLimit = (style) => (
  style === 'long-straight' || style === 'long-wavy' || style === 'medium-tousled'
    ? 0.09 : 0.035
);

const d2 = (p, c) => (p.r - c[0]) ** 2 + (p.g - c[1]) ** 2 + (p.b - c[2]) ** 2;
const nearest = (p, set) => {
  let best = Infinity, at = -1;
  for (let i = 0; i < set.length; i++) { const d = d2(p, set[i]); if (d < best) { best = d; at = i; } }
  return { d: Math.sqrt(best), at };
};

/**
 * 按 COLOR_0 把顶点分成 {hair, skin, other}。
 * COLOR_0 可能是 float、也可能是归一化 ubyte。这里两种都处理。
 *
 * @param pal 该角色的精确调色板（见 loadPalette）。缺省时退回粗糙阈值。
 */
function classify(g, bin, pal) {
  const prim = g.meshes[0].primitives[0];
  const posAcc = g.accessors[prim.attributes.POSITION];
  const bv = g.bufferViews[posAcc.bufferView];
  const base = (bv.byteOffset || 0) + (posAcc.byteOffset || 0);
  const N = posAcc.count;

  const colIdx = prim.attributes.COLOR_0;
  let colBase = null, colStride = 12, colNorm = false, colType = 0;
  if (colIdx != null) {
    const ca = g.accessors[colIdx];
    const cbv = g.bufferViews[ca.bufferView];
    colBase = (cbv.byteOffset || 0) + (ca.byteOffset || 0);
    colType = ca.componentType;
    colNorm = ca.normalized === true;
    const compSize = colType === 5126 ? 4 : 1;
    const compCount = ca.type === 'VEC4' ? 4 : 3;
    colStride = compSize * compCount;
  }

  const hair = [], skin = [], other = [], eyePts = [];
  const out = [];
  for (let i = 0; i < N; i++) {
    const o = base + i * 12;
    const x = bin.readFloatLE(o), y = bin.readFloatLE(o + 4), z = bin.readFloatLE(o + 8);

    let r = 0, gg = 0, b = 0, ok = false;
    if (colBase != null) {
      const co = colBase + i * colStride;
      if (colType === 5126) { r = bin.readFloatLE(co); gg = bin.readFloatLE(co + 4); b = bin.readFloatLE(co + 8); ok = true; }
      else {
        const s = colNorm ? 1 / 255 : 1;
        r = bin.readUInt8(co) * s; gg = bin.readUInt8(co + 1) * s; b = bin.readUInt8(co + 2) * s; ok = true;
      }
    }
    const p = { x, y, z, r, g: gg, b, cls: 'other', i };
    out.push(p);

    if (!ok) { other.push(p); continue; }

    if (pal) {
      // 精确最近邻：头发距离显著小于皮肤距离才算头发，反之亦然。
      // 两者都远（衣服/鞋/眼白）→ other。
      //
      // ⚠️ 眼睛优先判定：瞳孔近黑，和黑发角色的 hair 基色距离可能小于 TOL，
      //    若先判 hair 就会把瞳孔整片算成头发（见 loadPalette 里 eye 的注释）。
      //    所以 eye 必须**最先**比，且阈值放宽到 0.12（眼白/高光的量化误差更大）。
      const de = pal.eye && pal.eye.length ? nearest(p, pal.eye) : { d: Infinity };
      const dh = nearest(p, pal.hair);
      const ds = nearest(p, pal.skin);
      const TOL = 0.09;                 // 颜色空间里的欧氏距离阈值
      if (de.d < 0.12 && de.d <= dh.d && de.d <= ds.d) { p.cls = 'eye'; eyePts.push(p); }
      else if (dh.d < TOL && dh.d < ds.d) { p.cls = 'hair'; hair.push(p); }
      else if (ds.d < TOL && ds.d <= dh.d) { p.cls = 'skin'; skin.push(p); }
      else other.push(p);
    } else {
      const isWarm = r >= gg && gg >= b;
      const lum = (r + gg + b) / 3;
      if (isWarm && r < 0.58 && lum < 0.42) { p.cls = 'hair'; hair.push(p); }
      else if (isWarm && r >= 0.58) { p.cls = 'skin'; skin.push(p); }
      else other.push(p);
    }
  }
  return { all: out, hair, skin, other, eye: eyePts, N };
}

// ---------------------------------------------------------------------------
const PALETTE = loadPalette();
if (process.argv.includes('--debug')) {
  for (const [k, v] of Object.entries(PALETTE)) {
    console.log(k, 'hair:', JSON.stringify(v.hair), 'skin:', JSON.stringify(v.skin));
  }
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = args.length
  ? args.map((n) => (n.startsWith('realistic-') ? n : `realistic-${n}`))
  : fs.readdirSync(MODELS).filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, ''));

const rows = [];

for (const name of list) {
  const glb = path.join(MODELS, `${name}.glb`);
  if (!fs.existsSync(glb)) { console.log(`✗ ${name}: 无 GLB`); continue; }
  const { g, bin } = readGlb(glb);
  const byName = {};
  g.nodes.forEach((n, i) => (byName[n.name] = i));

  const prim = g.meshes[0].primitives[0];
  const posAcc = g.accessors[prim.attributes.POSITION];
  const minY = posAcc.min[1], maxY = posAcc.max[1];
  const bodyH = maxY - minY;

  const cls = classify(g, bin, PALETTE[name]);

  // 头高：用 Head → HeadTop_End 的骨骼距离（inspect-character 同款算法）
  function wp(i) {
    const n = g.nodes[i];
    let p = n.matrix ? [n.matrix[12], n.matrix[13], n.matrix[14]] : (n.translation || [0, 0, 0]).slice();
    const par = g.nodes.findIndex((x) => (x.children || []).includes(i));
    if (par >= 0) { const q = wp(par); p = [p[0] + q[0], p[1] + q[1], p[2] + q[2]]; }
    return p;
  }
  const headY = byName.Head != null ? wp(byName.Head)[1] : NaN;
  const headTopY = byName.HeadTop_End != null ? wp(byName.HeadTop_End)[1] : NaN;
  const headH = headTopY - headY;
  const headW = headH * 0.72;
  const headC = headY + headH * 0.52;          // buildHead / buildHair 共用的中心

  // buildHead 里眼球的位置（同一套常量，改一处要改两处 —— 这里只读不算）
  const eyeY = headC + 0.015 * headH;
  const eyeZ = 0 + headH * 0.56 * 0.74;        // skullR.z = headH*0.56，eyeZ = c.z + skullR.z*0.74
  const eyeR = headH * 0.082;
  const browY = headC + 0.105 * headH;

  // ---- ① 刘海压脸：脸部区域里，站在最前面的顶点是不是「头发主体」 ----
  //
  // ⚠️ 眉毛在生成时也被打了 kind:'hair'、用的是 mix3(hair, black, 0.15)，
  //    颜色和真头发几乎一样，颜色分类无法区分 —— 会把 100% 的眉心格判成"被头发挡"。
  //    实际统计过的假警报：elena 颜色直方图里 0.17,0.11,0.09 有 234 个顶点，
  //    正好等于两条眉的顶点数。
  //
  //    所以这里按**几何**排除：眉是一段水平带，位置/厚度和 build-realistic.mjs 的
  //    「眉」那一段保持一致（browY = headC + 0.105*headH，半厚度 = headH*0.038）。
  //    ⚠️ 这个半厚度要跟着 builder 改：早期版本眉只有 headH*0.022 厚，
  //       我把排除带写成 -0.030 就够；眉加厚到 0.038 后必须同步，
  //       否则眉的下沿会重新落进"脸"里，假警报又回来。
  //    真头发的刘海垂下来必然**跨过**这个带、一直压到眼睛以下。
  //    只统计「眉带以下」的格子 —— 那才是真正"糊住眼睛/脸"的区域。
  const BROW_HALF = headH * 0.038;             // 与 builder 的 browRy 一致
  const faceTop = browY - BROW_HALF - headH * 0.012;   // 眉带下缘再低一点，彻底避开眉
  const faceBot = headC - 0.235 * headH;       // 唇高（buildHead 的 mouthY）
  const GW = 15, GH = 12;
  const frontMost = new Array(GW * GH).fill(null);
  // ⚠️ 取样窗宽度从 ±0.8 头宽收到 ±0.52 头宽 —— 只覆盖鼻梁到嘴角的真实面部。
  //    脸侧那 1.5cm 是**鬓角**，那儿本来就该有头发，用 0.8 会把鬓角误判成"遮脸"。
  const xHalf = headW * 0.52;
  const inside = (p) => p.x > -xHalf && p.x < xHalf && p.y > faceBot && p.y < faceTop;

  for (const p of cls.all) {
    if (!inside(p)) continue;
    // 只要脸前半球（z > 0），后脑勺的头发不算
    if (p.z <= 0) continue;
    const gx = Math.min(GW - 1, Math.max(0, Math.floor(((p.x + xHalf) / (2 * xHalf)) * GW)));
    const gy = Math.min(GH - 1, Math.max(0, Math.floor(((p.y - faceBot) / (faceTop - faceBot)) * GH)));
    const k = gy * GW + gx;
    if (!frontMost[k] || p.z > frontMost[k].z) frontMost[k] = p;
  }

  // ⚠️ 单纯"取最前面那个顶点"会有 z-fighting 假警报：
  //    头发壳和皮肤在发际线附近深度几乎相等，谁大 0.0001m 谁就赢，
  //    整片区域于是出现 H/s 交替的花斑 —— 但肉眼只是轻微交叠，不是"糊脸"。
  //    判据改成「头发比同格的皮肤**明显**更靠前（> MARGIN）」才算遮挡。
  const MARGIN = 0.004;
  let coveredCells = 0, totalCells = 0;
  for (let k = 0; k < GW * GH; k++) {
    const p = frontMost[k];
    if (!p) continue;
    totalCells++;
    if (p.cls !== 'hair') continue;
    const gx = k % GW, gy = Math.floor(k / GW);
    const x0 = -xHalf + (gx / GW) * 2 * xHalf, x1 = x0 + (2 * xHalf) / GW;
    const y0 = faceBot + (gy / GH) * (faceTop - faceBot), y1 = y0 + (faceTop - faceBot) / GH;
    let bestSkinZ = -Infinity;
    for (const q of cls.skin) {
      if (q.x < x0 || q.x >= x1 || q.y < y0 || q.y >= y1 || q.z <= 0) continue;
      if (q.z > bestSkinZ) bestSkinZ = q.z;
    }
    if (p.z - bestSkinZ > MARGIN) coveredCells++;
  }
  const faceBlock = totalCells ? coveredCells / totalCells : 0;

  // 另算一个「眼睛高度带」的遮挡率 —— 这是最刺眼的观感指标（同样带 MARGIN）
  let eyeCovered = 0, eyeTotal = 0;
  for (let k = 0; k < GW * GH; k++) {
    const p = frontMost[k];
    if (!p) continue;
    const gy = Math.floor(k / GW);
    const yy = faceBot + ((gy + 0.5) / GH) * (faceTop - faceBot);
    if (Math.abs(yy - eyeY) > headH * 0.055) continue;
    eyeTotal++;
    if (p.cls !== 'hair') continue;
    const gx = k % GW;
    const x0 = -xHalf + (gx / GW) * 2 * xHalf, x1 = x0 + (2 * xHalf) / GW;
    const y0 = faceBot + (gy / GH) * (faceTop - faceBot), y1 = y0 + (faceTop - faceBot) / GH;
    let bestSkinZ = -Infinity;
    for (const q of cls.skin) {
      if (q.x < x0 || q.x >= x1 || q.y < y0 || q.y >= y1 || q.z <= 0) continue;
      if (q.z > bestSkinZ) bestSkinZ = q.z;
    }
    if (p.z - bestSkinZ > MARGIN) eyeCovered++;
  }
  const eyeBlock = eyeTotal ? eyeCovered / eyeTotal : 0;

  // ---- ② 侧向炸开：耳朵高度上，头发最外缘 vs 颅骨最外缘 ----
  const earY = headC - 0.02 * headH;
  const bandHalf = headH * 0.10;               // ±10% 头高的高度带
  let hairMaxX = 0, skinMaxX = 0;
  for (const p of cls.hair) {
    if (Math.abs(p.y - earY) > bandHalf) continue;
    if (p.z < -0.05) continue;                 // 只算脸侧/耳侧，不算后脑
    hairMaxX = Math.max(hairMaxX, Math.abs(p.x));
  }
  for (const p of cls.skin) {
    if (Math.abs(p.y - earY) > bandHalf) continue;
    if (p.z < -0.05) continue;
    // 排除手臂/身体：耳朵高度上超出头宽的 skin 是手臂
    if (Math.abs(p.x) > headW * 0.9) continue;
    skinMaxX = Math.max(skinMaxX, Math.abs(p.x));
  }
  const puff = (hairMaxX - skinMaxX) / headH;   // 归一化到「头高」

  // ---- ③ 头发最高点 vs 颅骨最高点（帽子感/头顶压扁）----
  let hairTopY = -Infinity, skinTopY = -Infinity;
  for (const p of cls.hair) if (Math.abs(p.x) < headW * 0.6) hairTopY = Math.max(hairTopY, p.y);
  for (const p of cls.skin) if (Math.abs(p.x) < headW * 0.6 && p.y > headC) skinTopY = Math.max(skinTopY, p.y);
  const crownGap = (hairTopY - skinTopY) / headH;

  rows.push({
    name, bodyH, headH, headW,
    style: (PALETTE[name] && PALETTE[name].style) || 'short-crop',
    faceBlock, eyeBlock, puff, crownGap,
    hairV: cls.hair.length, skinV: cls.skin.length,
    hairTopY, skinTopY,
  });
}

/* ------------------------------- 表 ------------------------------- */
const pad = (s, n) => String(s).padEnd(n);
const lp = (s, n) => String(s).padStart(n);
console.log('');
console.log('  写实角色头发体检 — 归一化到「头高/头宽」，可直接横比');
console.log('  ' + '─'.repeat(92));
console.log(
  '  ' + pad('角色', 12) + lp('遮脸%', 8) + lp('遮眼%', 8) + lp('侧炸H', 8) + lp('顶厚H', 8) +
  lp('发顶点', 9) + lp('肤顶点', 9) + lp('头高m', 8)
);
console.log('  ' + '─'.repeat(92));
for (const r of rows) {
  console.log(
    '  ' + pad(r.name.replace('realistic-', ''), 12) +
    lp((r.faceBlock * 100).toFixed(1), 8) +
    lp((r.eyeBlock * 100).toFixed(1), 8) +
    lp(r.puff.toFixed(3), 8) +
    lp(r.crownGap.toFixed(3), 8) +
    lp(r.hairV, 9) + lp(r.skinV, 9) + lp(r.headH.toFixed(3), 8)
  );
}
console.log('');

/* ------------------------------ 断言 ------------------------------ */
let fails = 0;
for (const r of rows) {
  const problems = [];
  const check = (c, m) => { if (!c) problems.push(m); };
  // 遮脸：眉带以下、最前面一层是头发的格子占比。>12% 就是"帘子糊脸"。
  check(r.faceBlock < 0.12, `遮脸 ${(r.faceBlock * 100).toFixed(1)}%（应 <12%，超标=刘海压到脸上）`);
  // 遮眼：眼睛高度带的遮挡率。
  //
  // ⚠️ 这条线不能设成"越低越好"。
  //    眼睛高度带（eyeY ± 5.5% 头高）的**上沿**本来就压着发际线/刘海梢 ——
  //    真人齐刘海、波浪发梢都会搭在眉弓上方，那一带的格子判给头发是**正确**的。
  //    实测所有通过的角色都稳定落在 18.5%，说明这就是"刘海搭在带上沿"的自然基线。
  //    真正要拦的是"头发整片盖住眼睛"：那就该冲到 50% 以上
  //    （修复前 elena 57.1%、marcus 57.1%、ren 60.9% 就是这个量级）。
  //    所以阈值取 30%：既容得下刘海梢，又能拦住真正的糊脸。
  check(r.eyeBlock < 0.30, `遮眼 ${(r.eyeBlock * 100).toFixed(1)}%（应 <30%，超标=头发整片盖住眼睛）`);
  // 侧炸：耳朵高度头发外缘超颅骨的距离。阈值按发型走（见 puffLimit 的注释）。
  //   曾经一刀切 0.035H，把长发本该有的体量判成蘑菇头。
  const lim = puffLimit(r.style);
  check(r.puff < lim, `侧炸 ${r.puff.toFixed(3)}H（应 <${lim}，${r.style} 超标=耳朵高度鼓包成蘑菇头）`);
  // 顶厚：头发顶点应比肤色顶点高出 2%~26% 头高（太薄=贴头皮，太厚=盔）
  check(r.crownGap > 0.02 && r.crownGap < 0.26, `顶厚 ${r.crownGap.toFixed(3)}H（应 0.02~0.26）`);

  if (!problems.length) {
    console.log(`  ✓ ${pad(r.name.replace('realistic-', ''), 10)} 遮脸 ${(r.faceBlock * 100).toFixed(1)}% · 遮眼 ${(r.eyeBlock * 100).toFixed(1)}% · 侧炸 ${r.puff.toFixed(3)}H · 顶厚 ${r.crownGap.toFixed(3)}H`);
  } else {
    fails += problems.length;
    console.log(`  ✗ ${r.name}`);
    for (const p of problems) console.log(`      ${p}`);
  }
}
console.log('');
console.log(fails === 0 ? '  全部通过。' : `  ${fails} 项未通过。`);
console.log('');

/* ---------------------- 可选：脸部正面 ASCII 图 ---------------------- */
if (process.argv.includes('--face')) {
  for (const name of list) {
    const glb = path.join(MODELS, `${name}.glb`);
    if (!fs.existsSync(glb)) continue;
    const { g, bin } = readGlb(glb);
    const byName = {};
    g.nodes.forEach((n, i) => (byName[n.name] = i));
    const cls = classify(g, bin, PALETTE[name]);

    function wp(i) {
      const n = g.nodes[i];
      let p = n.matrix ? [n.matrix[12], n.matrix[13], n.matrix[14]] : (n.translation || [0, 0, 0]).slice();
      const par = g.nodes.findIndex((x) => (x.children || []).includes(i));
      if (par >= 0) { const q = wp(par); p = [p[0] + q[0], p[1] + q[1], p[2] + q[2]]; }
      return p;
    }
    const headY = wp(byName.Head)[1], headTopY = wp(byName.HeadTop_End)[1];
    const headH = headTopY - headY, headW = headH * 0.72;
    const headC = headY + headH * 0.52;
    const yTop = headC + 0.62 * headH, yBot = headC - 0.42 * headH;
    const xHalf = headW * 1.15;

    // ⚠️ 眉带：和 builder 的 browY / browRy 保持一致。
    //    眉的颜色和头发一模一样（mix3(hair, black, 0.15)），
    //    在 ASCII 里如果不单独标出来，就会被当成"头发糊脸"——
    //    我为此白白查了好几轮（先把壳改了、又把发束改了，其实都无辜）。
    //    这里给眉单独一个字符 'b'，一眼就能分清"这是眉"还是"这是发"。
    const browYc = headC + 0.105 * headH;
    const browHalf = headH * 0.038;
    const isBrow = (p) => p.cls === 'hair'
      && Math.abs(p.y - browYc) < browHalf * 1.35
      && Math.abs(p.x) > headW * 0.12 && Math.abs(p.x) < headW * 0.62;

    const GW = 40, GH = 34;
    const front = new Array(GW * GH).fill(null);
    for (const p of cls.all) {
      if (p.z <= 0) continue;
      if (p.x < -xHalf || p.x > xHalf || p.y < yBot || p.y > yTop) continue;
      const gx = Math.min(GW - 1, Math.max(0, Math.floor(((p.x + xHalf) / (2 * xHalf)) * GW)));
      const gy = Math.min(GH - 1, Math.max(0, Math.floor(((p.y - yBot) / (yTop - yBot)) * GH)));
      const k = gy * GW + gx;
      if (!front[k] || p.z > front[k].z) front[k] = p;
    }
    console.log(`\n  ${name} 正面（每格 = 最靠前的顶点；H=发 b=眉 s=肤 o=其他 .=空）`);
    console.log('   ' + '┌' + '─'.repeat(GW) + '┐');
    for (let gy = GH - 1; gy >= 0; gy--) {
      let line = '   │';
      for (let gx = 0; gx < GW; gx++) {
        const p = front[gy * GW + gx];
        line += !p ? '.' : isBrow(p) ? 'b' : p.cls === 'hair' ? 'H' : p.cls === 'skin' ? 's' : 'o';
      }
      const yy = (yBot + ((gy + 0.5) / GH) * (yTop - yBot)).toFixed(2);
      console.log(line + `│ ${yy}m`);
    }
    console.log('   ' + '└' + '─'.repeat(GW) + '┘');
    console.log('');
  }
}

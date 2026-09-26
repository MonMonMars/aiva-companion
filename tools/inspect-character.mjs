#!/usr/bin/env node
/**
 * 写实角色「几何体检」—— 不渲染，直接从 GLB 里读顶点数值，验证到底像不像人。
 *
 * 为什么需要它：程序化生成的模型，顶点数/骨骼数「对」不代表**长得像人**。
 * 截图能看个大概，但截图会骗人（相机角度、光照、遮挡）。真正硬的证据是数值：
 *
 *   1. 头身比 = 网格总高 / 骨骼头长   → 成人 7.0~8.4，<5 就是 Q 版
 *   2. 总高   = 网格顶 - 网格底       → 必须等于预设 height（±5%）
 *   3. 贴地   = 网格底 Y 是否 ≈ 0      → 悬空/陷地都是 bug
 *   4. 轮廓   = 按高度分桶看 X 跨度    → 头窄/肩宽/腰细/髋宽的节奏要出来
 *   5. 对称   = |minX| vs |maxX|       → 骨骼没歪
 *   6. 表情   = morph.json 的稀疏覆盖  → 每个 blendshape 都要真的动到顶点
 *
 * ⚠️ 曾经的坑：用「骨骼局部坐标」当世界坐标来算肩宽/头身比，结论全错。
 *    骨骼 Y 要沿父链累加（nodeWorldPos），而 X 跨度必须从**网格顶点**量。
 *
 * 用法：node tools/inspect-character.mjs [name ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS = path.join(ROOT, 'assets', 'models2');

/** 只要 JSON chunk + BIN chunk；accessor 的 min/max 导出器已经算好了 */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: 不是 GLB`);
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { g: json, bin, bytes: buf.length };
}

/**
 * 这个文件只认「我们自己程序化生成」的那一种模型，三个前提缺一不可：
 *
 *   1. 骨骼用 Mixamo 命名（Hips / Head / HeadTop_End …）
 *   2. 整个角色就一个 mesh（meshes.length === 1）
 *   3. 表情在外挂的 .morph.json 里
 *
 * ⚠️ 曾经只拿「有没有内嵌贴图」当门禁（见 test-realistic-pipeline.mjs 的
 *    glbHasImages），那是个**代理指标**：凑巧能把官方 VRM 挡掉，但说不清原因。
 *   实测 kizuna-kamatte 打红的真正原因是格式差异，不是贴图：
 *      · 骨骼叫 J_C_hip / J_C_head（VRM 1.0 命名），byName.Head 查不到 → 头身比 NaN
 *      · 16 个 mesh（身体/头发/衣服各一块）→ meshes[0] 只量到其中一块，总高 0.716m
 *      · 52 个 ARKit 表情**内嵌在 GLB 里**，没有 .morph.json → 报"0 个表情"
 *    三条全都是"用错了尺子"，不是模型有问题（该模型 web-check-glb 是 9/9）。
 *    所以门禁直接查格式本身，别再靠贴图去猜。
 *
 * @returns {{ok: true} | {ok: false, why: string}}
 */
function isProceduralFlavor(g, morphPath) {
  const names = new Set(g.nodes.map((n) => n.name));
  for (const need of ['Hips', 'Head', 'HeadTop_End']) {
    if (!names.has(need)) {
      return { ok: false, why: `骨骼不是 Mixamo 命名（缺 ${need}），本工具的头身比/腕下垂算不了` };
    }
  }
  if (g.meshes.length !== 1) {
    return { ok: false, why: `有 ${g.meshes.length} 个 mesh，本工具只读 meshes[0]，会量到身体的一部分` };
  }
  if (!fs.existsSync(morphPath)) {
    return { ok: false, why: '没有 .morph.json 外挂表情表，本工具的表情覆盖检查无对象（表情可能内嵌在 GLB 里）' };
  }
  return { ok: true };
}

/** 节点世界位置：沿父链累加平移（本项目父链全是纯平移 + 极少旋转，够用） */
function makeWorldPos(g) {
  const cache = new Map();
  return function wp(i) {
    if (cache.has(i)) return cache.get(i);
    const n = g.nodes[i];
    let p = n.matrix ? [n.matrix[12], n.matrix[13], n.matrix[14]] : (n.translation || [0, 0, 0]).slice();
    const par = g.nodes.findIndex((x) => (x.children || []).includes(i));
    if (par >= 0) {
      const q = wp(par);
      p = [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
    }
    cache.set(i, p);
    return p;
  };
}

/**
 * 从骨架反推「半肩宽」。
 * LeftArm 是肩关节，LeftShoulder 在它内侧 —— 两点水平距离就是半肩宽。
 * 用它当阈值把手臂顶点从"腰"的统计里剔掉。
 */
function presetShoulderHalf(g, byName, wp) {
  if (byName.LeftArm == null || byName.LeftShoulder == null) return 0.18;
  const a = wp(byName.LeftArm);
  const b = wp(byName.LeftShoulder);
  const d = Math.abs(a[0] - b[0]);
  return d > 0.02 ? d : 0.18;
}

/** 按高度分桶统计 X 跨度，得到「轮廓侧影」 */
function silhouette(g, bin, buckets = 14) {
  const prim = g.meshes[0].primitives[0];
  const acc = g.accessors[prim.attributes.POSITION];
  const bv = g.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const N = acc.count;
  const y0 = acc.min[1];
  const y1 = acc.max[1];
  const h = y1 - y0;
  const lo = new Array(buckets).fill(Infinity);
  const hi = new Array(buckets).fill(-Infinity);
  const cnt = new Array(buckets).fill(0);
  for (let i = 0; i < N; i++) {
    const o = base + i * 12;
    const x = bin.readFloatLE(o);
    const y = bin.readFloatLE(o + 4);
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(((y - y0) / h) * buckets)));
    if (x < lo[b]) lo[b] = x;
    if (x > hi[b]) hi[b] = x;
    cnt[b]++;
  }
  return { lo, hi, cnt, y0, y1, h, N };
}

/**
 * 读 morph.json 并检查每个 shape 的覆盖与强度。
 *
 * ⚠️ v3 的实际结构（易踩坑）：
 *   indices[]   = [[meshIndex, vertexIndex], ...]  —— 全局「会动的顶点」去重表
 *   shapeSlots{} = { shapeName: [slot, slot, ...] } —— 该 shape 第 i 个 delta 三元组
 *                                                    对应 indices 里的哪个下标
 *   deltas{}    = { shapeName: [dx,dy,dz, ...] }   —— 已按 quant 定点化，读时 * quant
 *   注意 shapeSlots / deltas 是**对象**（按 shape 名索引），不是数组！
 */
function morphStats(file) {
  if (!fs.existsSync(file)) return null;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const Q = typeof d.quant === 'number' && d.quant > 0 ? d.quant : 1;
  const shapes = d.shapes || [];
  const per = {};
  for (const s of shapes) {
    const slots = d.shapeSlots?.[s] || [];
    const dl = d.deltas?.[s] || [];
    let mx = 0;
    for (let i = 0; i < dl.length; i++) {
      const a = Math.abs(dl[i] * Q);
      if (a > mx) mx = a;
    }
    per[s] = { verts: slots.length, max: mx };
  }
  return { version: d.version, quant: Q, shapes: shapes.length, indices: (d.indices || []).length, per };
}

/* ------------------------------------------------------------------ */
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const want = args.length ? args.map((n) => (n.startsWith('realistic-') ? n : `realistic-${n}`)) : null;

// ★ MODELS 目录不在 → 别说猜。以前是 scandir 直接甩一段 ENOENT 堆栈（退出码倒是 1，
//   但那不是"体检没通过"，是"脚本炸了"，两者不该混为一谈）。
if (!fs.existsSync(MODELS)) {
  console.log(`✗ 找不到 ${MODELS} —— 一个模型都体检不到，别把这一轮当成通过。`);
  process.exit(1);
}

const list = want || fs.readdirSync(MODELS).filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, ''));

const rows = [];
// fails 要提前到这儿：上面「指定了名字却找不到 GLB」那条分支也要往里加数。
let fails = 0;
for (const name of list) {
  const glbPath = path.join(MODELS, `${name}.glb`);
  if (!fs.existsSync(glbPath)) {
    // ★ 名字是**你显式指定的**还找不到 —— 那就是没验到，必须算失败。
    //   以前这里只 `console.log('✗ …没有 GLB')` 然后 continue，`fails` 纹丝不动，
    //   于是下一句照样是「全部通过。」退出 0 —— 一边打 ✗ 一边说全通过。
    console.log(`✗ ${name}: 没有 GLB`);
    if (want) fails++;
    continue;
  }
  const { g, bin, bytes } = readGlb(glbPath);

  // 格式不对就跳过，不要硬算 —— 硬算出来的 NaN 会变成 7 条假失败，
  // 让人以为什么都坏了（其实模型本身 web-check-glb 是 9/9）。
  const flavor = isProceduralFlavor(g, path.join(MODELS, `${name}.morph.json`));
  if (!flavor.ok) {
    console.log(`· ${name}: 不是程序化生成的那一档 → 跳过`);
    console.log(`    ${flavor.why}`);
    console.log(`    真浏览器里验请跑：node tools/web-check-glb.mjs assets/models2/${name}.glb`);
    continue;
  }

  const wp = makeWorldPos(g);
  const byName = {};
  g.nodes.forEach((n, i) => (byName[n.name] = i));

  const prim = g.meshes[0].primitives[0];
  const acc = g.accessors[prim.attributes.POSITION];
  const minY = acc.min[1];
  const maxY = acc.max[1];
  const bodyH = maxY - minY;

  const headY = byName.Head != null ? wp(byName.Head)[1] : NaN;
  const headTopY = byName.HeadTop_End != null ? wp(byName.HeadTop_End)[1] : NaN;
  const boneHeadH = headTopY - headY;
  const headsTallMesh = bodyH / boneHeadH;      // 用网格高，比 H/headsTall 可信
  const headsTallBone = headTopY / boneHeadH;

  const sil = silhouette(g, bin);
  const boneNames = Object.keys(byName).filter((n) =>
    /^(Hips|Spine|Spine1|Spine2|Neck|Head|HeadTop_End|LeftShoulder|LeftArm|LeftForeArm|LeftHand|RightShoulder|RightArm|RightForeArm|RightHand|LeftUpLeg|LeftLeg|LeftFoot|LeftToeBase|RightUpLeg|RightLeg|RightFoot|RightToeBase)$/.test(n)
  );
  const m = morphStats(path.join(MODELS, `${name}.morph.json`));

  // ---- 姿势体检：肩胸区（70~85% 身高）的 X 跨度 / 总高 ----
  // A-pose ≈ 0.62~0.72；T-pose ≈ 0.88~0.98（就是"衣架感"的来源）。
  const shLo = Math.floor(sil.cnt.length * 0.70);
  const shHi = Math.floor(sil.cnt.length * 0.85);
  let armSpan = 0;
  for (let b = shLo; b <= shHi && b < sil.cnt.length; b++) {
    if (sil.cnt[b] < 10) continue;
    armSpan = Math.max(armSpan, sil.hi[b] - sil.lo[b]);
  }
  const poseRatio = armSpan / bodyH;

  // 腕点是否落在髋侧（A-pose 特征）：腕高应 ≈ 0.48~0.58H，且明显低于肩
  const wristY = byName.LeftHand != null ? wp(byName.LeftHand)[1] : NaN;
  const shoulderY = byName.LeftArm != null ? wp(byName.LeftArm)[1] : NaN;
  const wristDrop = (shoulderY - wristY) / bodyH;   // T-pose ≈ 0，A-pose ≈ 0.26

  // 轮廓节奏：找最窄的「腰」和它上下的宽度，确认没有变成一根柱子
  //
  // ⚠️ A-pose 之后不能直接量「腰部高度的整段 X 跨度」——
  //    手臂垂下来正好落在髋部两侧，那量到的是**掌心的外缘**，不是腰。
  //    实测：同一个 elena，全跨度 0.389m（假腰）vs 只取中轴附近 0.22m（真腰）。
  //    正确做法：只统计 |x| < 体宽阈值 的顶点，把两条手臂排除在外。
  const midStart = Math.floor(sil.cnt.length * 0.35);
  const midEnd = Math.floor(sil.cnt.length * 0.7);
  let waist = Infinity;
  for (let b = midStart; b < midEnd; b++) {
    if (sil.cnt[b] < 20) continue;
    const w = sil.hi[b] - sil.lo[b];
    if (w < waist) waist = w;
  }
  // 中轴腰围：忽略离躯干中线过远的顶点（手臂 / 手掌）
  //
  // ⚠️ 第一版阈值取 0.75×半肩宽，对写实档够用（aria 曾掉到 0.099m，调到 0.75 后正常）。
  //    但**低模档会踩到采样假象**：hikari 肩宽 0.33 → 窗口只有 ±0.064m，
  //    而骨盆那一圈降面后只剩 12 个采样点，其中落在窗口内的只有 x≈0 一个 ——
  //    于是那一桶量到的是**大腿内缘**（0.084m），不是躯干。
  //    用 ±0.10m 的窗口重测同一桶是 0.186m，躯干好得很，纯粹是窗口开小了。
  //
  // ⚠️ 所以改成取「肩推」和「髋推」的较大值：
  //    · 肩推 0.75×半肩宽 —— 原来的口径
  //    · 髋推 1.15×|LeftUpLeg.x|（= hip×0.26×1.15）—— 略大于腿心，
  //      保证躯干和双腿都进窗。手臂在 0.24m 以外，两种口径都排除得掉。
  const legX = byName.LeftUpLeg != null ? Math.abs(wp(byName.LeftUpLeg)[0]) : 0;
  const coreLimit = Math.max(presetShoulderHalf(g, byName, wp) * 0.75, legX * 1.15);
  let waistCore = Infinity;
  {
    const prim2 = g.meshes[0].primitives[0];
    const acc2 = g.accessors[prim2.attributes.POSITION];
    const bv2 = g.bufferViews[acc2.bufferView];
    const base2 = (bv2.byteOffset || 0) + (acc2.byteOffset || 0);
    const lo2 = new Array(sil.cnt.length).fill(Infinity);
    const hi2 = new Array(sil.cnt.length).fill(-Infinity);
    const cnt2 = new Array(sil.cnt.length).fill(0);
    for (let i = 0; i < acc2.count; i++) {
      const o = base2 + i * 12;
      const x = bin.readFloatLE(o);
      const y = bin.readFloatLE(o + 4);
      if (Math.abs(x) > coreLimit) continue;
      const b = Math.min(sil.cnt.length - 1, Math.max(0, Math.floor(((y - sil.y0) / sil.h) * sil.cnt.length)));
      if (x < lo2[b]) lo2[b] = x;
      if (x > hi2[b]) hi2[b] = x;
      cnt2[b]++;
    }
    for (let b = midStart; b < midEnd; b++) {
      if (cnt2[b] < 20) continue;
      const w = hi2[b] - lo2[b];
      if (w < waistCore) waistCore = w;
    }
  }

  rows.push({
    name,
    bodyH,
    maxY,
    minY,
    headH: boneHeadH,
    headsTallMesh,
    headsTallBone,
    waistCore,
    poseRatio,
    wristDrop,
    bones: boneNames.length,
    bytes,
    morphBytes: m ? fs.statSync(path.join(MODELS, `${name}.morph.json`)).size : 0,
    morph: m,
    sil,
  });
}

/* ---------------------------- 汇总表 ---------------------------- */
const pad = (s, n) => String(s).padEnd(n);
const lp = (s, n) => String(s).padStart(n);
console.log('');
console.log('  写实角色几何体检 — assets/models2/*.glb（数值来自网格顶点，非骨骼猜测）');
console.log('  ' + '─'.repeat(98));
console.log(
  '  ' + pad('角色', 17) + lp('总高m', 7) + lp('贴地', 7) + lp('头长m', 7) + lp('头身比', 7) +
  lp('腰宽m', 7) + lp('姿势', 7) + lp('腕垂H', 7) + lp('GLB', 7) + lp('morph', 7) + lp('骨', 4) + lp('表情', 5)
);
console.log('  ' + '─'.repeat(98));
for (const r of rows) {
  const pose = r.poseRatio < 0.80 ? 'A-pose' : 'T-pose!';
  console.log(
    '  ' + pad(r.name.replace('realistic-', ''), 17) +
    lp(r.bodyH.toFixed(3), 7) + lp(r.minY.toFixed(3), 7) + lp(r.headH.toFixed(3), 7) +
    lp(r.headsTallMesh.toFixed(2), 7) + lp(r.waistCore.toFixed(3), 7) +
    lp(pose, 7) + lp(r.wristDrop.toFixed(2), 7) +
    lp((r.bytes / 1024).toFixed(0) + 'K', 7) + lp((r.morphBytes / 1024).toFixed(0) + 'K', 7) +
    lp(r.bones, 4) + lp(r.morph ? r.morph.shapes : 0, 5)
  );
}
console.log('');

/* ---------------------------- 断言 ---------------------------- */

// ⚠️ 头身比的合格带必须**分档**，不能一刀切。
//    realistic-hikari 是 VTuber / 动漫档，刻意在 6.5 头身（头更大、更二次元）。
//    用写实档的 6.8~8.6 去卡它，是把"设计意图"当成"bug"来报。
//    分档写在体检工具里而不是靠猜：GLB 里没有 style 字段，按名字显式登记最清楚。
const HEAD_BANDS = {
  'realistic-hikari': { lo: 6.0, hi: 7.2, why: 'VTuber 动漫档' },
};
const bandOf = (name) => HEAD_BANDS[name] || { lo: 6.8, hi: 8.6, why: '写实成人档' };

// （fails 已提前到 rows 旁边声明 —— 那里就要开始计数）
for (const r of rows) {
  const problems = [];
  const check = (cond, msg) => { if (!cond) problems.push(msg); };
  const band = bandOf(r.name);

  check(r.headsTallMesh >= band.lo && r.headsTallMesh <= band.hi,
        `头身比 ${r.headsTallMesh.toFixed(2)} 超出${band.why}合格带 ${band.lo}~${band.hi}`);
  check(r.minY > -0.05 && r.minY < 0.06, `贴地 Y=${r.minY.toFixed(3)}（应 ≈0）`);
  check(r.bodyH > 1.45 && r.bodyH < 2.0, `总高 ${r.bodyH.toFixed(3)}m（成人 1.5~1.9）`);
  check(r.waistCore > 0.10 && r.waistCore < 0.35, `腰宽 ${r.waistCore.toFixed(3)}m（应 0.10~0.35，太宽=没有腰）`);
  check(r.bones === 23, `骨骼 ${r.bones} 根（Mixamo 兼容应为 23）`);
  // 姿势：必须是 A-pose（手臂自然下垂）。T-pose 的肩胸区跨度会到 0.88+。
  check(r.poseRatio < 0.80, `肩胸区宽高比 ${r.poseRatio.toFixed(2)}（A-pose 应 <0.80，≥0.88 说明还是 T-pose）`);
  check(r.wristDrop > 0.18, `腕下垂 ${r.wristDrop.toFixed(2)}H（A-pose 应 >0.18，≈0 说明手是平举的）`);
  check(!!r.morph && r.morph.shapes === 24, `blendshape ${r.morph ? r.morph.shapes : 0} 个（ARKit 子集应为 24）`);
  if (r.morph) {
    const dead = Object.entries(r.morph.per).filter(([, v]) => v.verts === 0);
    check(dead.length === 0, `有 ${dead.length} 个表情不动任何顶点：${dead.map((d) => d[0]).join(', ')}`);
    const weak = Object.entries(r.morph.per).filter(([, v]) => v.max < 1e-4);
    check(weak.length === 0, `有 ${weak.length} 个表情位移≈0：${weak.map((d) => d[0]).join(', ')}`);
    // 左右成对的表情覆盖数应当接近（差 <40%），否则说明有一侧没生成
    for (const pair of [['eyeBlinkLeft', 'eyeBlinkRight'], ['mouthSmileLeft', 'mouthSmileRight'], ['browDownLeft', 'browDownRight']]) {
      const [l, rr] = pair;
      if (r.morph.per[l] && r.morph.per[rr]) {
        const a = r.morph.per[l].verts, b = r.morph.per[rr].verts;
        const ratio = Math.max(a, b) / Math.max(1, Math.min(a, b));
        check(ratio < 1.4, `${l}/${rr} 覆盖不对称（${a} vs ${b}）`);
      }
    }
  }

  if (problems.length === 0) {
    console.log(`  ✓ ${pad(r.name.replace('realistic-', ''), 10)} ${r.bodyH.toFixed(2)}m · ${r.headsTallMesh.toFixed(2)} 头身 · 腰 ${r.waistCore.toFixed(2)}m · ${r.morph ? r.morph.shapes : 0} 表情`);
  } else {
    fails += problems.length;
    console.log(`  ✗ ${r.name}`);
    for (const p of problems) console.log(`      ${p}`);
  }
}
// ★★末尾这三道闸以前一道都没有** —— 整个脚本算完 `fails` 就打印一句，
//   退出码照旧是 0。于是体检出 N 项不合格照样是「PASS inspect-character」，
//   空模型目录照样打印「全部通过。」。第 69 条「打印了 ≠ 拦住了」的原样重现：
//   警告写得再直白，退出码是 0 就什么也拦不住。三道一起补：
//     ① rows 为空（一个都没体检到）→ 红。"0 条闸门"（SKILL 第 75 条）；
//     ② MODELS 目录不在 → 红（上面第一段已处理，不再退到 scandir 甩堆栈）；
//     ③ fails > 0 → 红。
//   三者都由 tools/test-inspect-character-teeth.mjs 盯着。
if (rows.length === 0) {
  console.log(`✗ 一个模型都没体检到（目录：${MODELS}）—— 这条体检等于没跑，`);
  // 文案里刻意不出现「全部通过」四个字的那种写法：牙齿脚本会去 stdout 里找
  // 那句结论，这段提醒自己带着它就会被误判 —— lint-ci-refs 踩过同一个坑
  // （注释里的名字被当成真步骤扫进来）。
  console.log('    一件东西都没判过，就谈不上通过。别把它当成模型的结论。');
  process.exit(1);
}
// 结论行必须在 0 项检查**之后**再打。原来的顺序是先打结论再查 rows，于是
// 空跑时同一次输出里既有「全部通过。」又有「✗ 一个模型都没体检到」，自相矛盾。
console.log(fails === 0 ? '  全部通过。' : `  ${fails} 项未通过。`);
console.log('');
process.exit(fails === 0 ? 0 : 1);

/* ---------------------- 可选：轮廓条形图 ---------------------- */
if (process.argv.includes('--profile')) {
  for (const r of rows) {
    console.log(`  ${r.name} 轮廓侧影（每格 0.05m 的 X 跨度）`);
    for (let b = r.sil.cnt.length - 1; b >= 0; b--) {
      if (!r.sil.cnt[b]) continue;
      const w = r.sil.hi[b] - r.sil.lo[b];
      const blocks = Math.max(1, Math.round(w / 0.05));
      const yy = (r.sil.y0 + (r.sil.h / r.sil.cnt.length) * b).toFixed(2);
      console.log(`   ${lp(yy, 4)}m ${'█'.repeat(blocks)} ${w.toFixed(2)}m`);
    }
    console.log('');
  }
}

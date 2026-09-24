// vrm2glb.mjs —— VRM 0.x（VRoid 导出）→ 可直接喂给本项目的 GLB
//
// 为什么需要这一步而不是直接把 .vrm 丢给 GLTFLoader：
//   ① **表情名字丢了**。VRM 把表情写在 extensions.VRM.blendShapeMaster 里，
//      指明「第 12 个 target = 眨眼」。GLTFLoader 不读这段，它只认
//      mesh.extras.targetNames，没有就退化成 morphTarget0/1/2…
//      而本项目的 lipSync / 表情对 પ્રત્યેક 个通道都**按标准 ARKit 名**直接写
//      （见 src/anim/lipSync.js 的 AA/OU/EE 常量），名字对不上就整个不驱动。
//   ② **体积**。VRoid 会在 BIN 里塞一张 2048² 的 Thumbnail 缩略图 + 一堆只有
//      MToon 才用的法线/高光图，白占 ~5MB。Web 加载全是自己的流量。
//   ③ **运行时采不到 T-pose 之外的信息**，姿态留给 tools/tpose-to-apose.mjs。
//
// 用法：
//   node tools/vrm2glb.mjs <输入.vrm> <输出.glb> [--max=1024] [--keep-nml] [--survey]
//   --survey  只做体检不写盘：打印每个原始 target 的位移特征，用来定映射
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

// ---------------------------------------------------------------------------
// GLB 拆包
// ---------------------------------------------------------------------------
function parseGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB/VRM');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.slice(off + 8, off + 8 + len);
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('GLB 缺 JSON 或 BIN 块');
  return { json, bin };
}

const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/**
 * 读一个 accessor，返回扁平 TypedArray。
 * ⚠️ 三个必须处理的情况：交错（byteStride）、sparse、矩阵对齐。
 *    少处理任何一个都会得到「看起来能用但全是错的」数据，很难查。
 */
function readAccessor(json, bin, idx, { skipSparse = false } = {}) {
  const acc = json.accessors[idx];
  const Ctor = CTOR[acc.componentType];
  const compSize = SIZE[acc.componentType];
  const nc = NCOMP[acc.type];
  const out = new Ctor(acc.count * nc);

  if (!acc.sparse && !skipSparse) {
    const acc = json.accessors[idx];
    const bv = json.bufferViews[acc.bufferView];
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    if (!bv.byteStride || bv.byteStride === compSize * nc) {
      // 紧密排列：一次 slice 就行（注意 Node Buffer 是大端/小端都可以，
      // 这里必须 copy 成 new Ctor(...)，否则会带着 Buffer 的原型）
      const src = new Ctor(bin.buffer.slice(bin.byteOffset + base, bin.byteOffset + base + acc.count * nc * compSize));
      out.set(src);
    } else {
      const stride = bv.byteStride;
      for (let i = 0; i < acc.count; i++) {
        const o = base + i * stride;
        const view = new Ctor(bin.buffer.slice(bin.byteOffset + o, bin.byteOffset + o + compSize * nc));
        out.set(view, i * nc);
      }
    }
  } else if (!acc.sparse && skipSparse) {
    return out;
  }

  if (acc.sparse && !skipSparse) {
    const { count, indices, values } = acc.sparse;
    const idxArr = readAccessor(json, bin, indices, { skipSparse: true });
    const valArr = readAccessor(json, bin, values, { skipSparse: true });
    for (let i = 0; i < count; i++) out.set(valArr.subarray(i * nc, i * nc + nc), idxArr[i] * nc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const opt = (k, d) => {
  const a = argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.split('=')[1] : d;
};
const hasFlag = (k) => argv.includes('--' + k);
const IN = positional[0];
const OUT = positional[1];
const MAXDIM = Number(opt('max', 1024));
const KEEP_NML = hasFlag('keep-nml');
const SURVEY = hasFlag('survey');
// --dry：只跑到「映射合成 + 通道体检」就退出，不读贴图不写盘。
// 调通道映射时这个比全流程快一个数量级（贴图重编码是大头）。
const DRY = hasFlag('dry');

if (!IN) { console.error('用法: node tools/vrm2glb.mjs <输入.vrm> <输出.glb> [--max=1024] [--keep-nml] [--survey] [--dry]'); process.exit(1); }
if (!OUT && !SURVEY && !DRY) { console.error('缺输出路径（或加 --survey / --dry）'); process.exit(1); }

const { json, bin } = parseGlb(IN);
const vrm = json.extensions?.VRM;
if (!vrm) { console.error('没有 extensions.VRM —— 已经是纯 glTF 了？表情定义可能已经丢失'); process.exit(1); }

const groups = vrm.blendShapeMaster?.blendShapeGroups || [];
const groupsByPreset = new Map();
for (const g of groups) {
  const key = (g.presetName && g.presetName !== 'unknown') ? g.presetName : ('custom:' + g.name);
  groupsByPreset.set(key.toLowerCase(), g);
}

// ⚠️ VRM 预设名有三套方言，别按单一写法取组：
//    - 规范只说 presetName 有 blink / blink_l / blink_r 三个取值
//    - VRoid Studio 导出的是**统一 blink**（一只 target 管双眼，
//      实测 24.7mm / 192 点 —— 正好是两只眼睛的顶点数）
//    - 有些工具又只给 blink_l / blink_r
//    第一版表里写死 blink_l/blink_r，遇到 VRoid 模型就整条眨眼链路静默失效。
//    这里做「按名取，取不到再按同义名取」的降级。
const PRESET_ALIAS = {
  blink_l: ['blink_l', 'blink', 'blinkleft'],
  blink_r: ['blink_r', 'blink', 'blinkright'],
};
function groupByKey(k) {
  const kk = String(k).toLowerCase();
  for (const cand of (PRESET_ALIAS[kk] || [kk])) {
    const g = groupsByPreset.get(cand);
    if (g) return g;
  }
  return null;
}

// 某个 mesh 的第 index 个 target 是哪个 group？（VRoid 是 1:1，权重 100）
function groupOf(meshIdx, index) {
  for (const g of groups) {
    for (const b of g.binds || []) if (b.mesh === meshIdx && b.index === index) return g;
  }
  return null;
}

// ---------------------------------------------------------------------------
// --survey：把每个原始 target 的位移特征打出来，用来决定怎么映射到 ARKit
// ---------------------------------------------------------------------------
if (SURVEY) {
  console.log('══ target 体检 ══ ' + path.basename(IN));
  json.meshes.forEach((m, mi) => {
    const prim = m.primitives[0];
    const targets = prim.targets || [];
    if (!targets.length) return;
    console.log('\n-- ' + m.name + '  ' + targets.length + ' targets --');
    console.log('  #  group           |最大位移|  平均位移(dx,dy,dz)*1000    移动点>0.3mm');
    for (let t = 0; t < targets.length; t++) {
      const posAcc = targets[t].POSITION;
      if (posAcc === undefined) { console.log(`  ${t}  (无 POSITION)`); continue; }
      const arr = readAccessor(json, bin, posAcc);
      let maxMag = 0, sx = 0, sy = 0, sz = 0, moving = 0, vcount = 0;
      for (let i = 0; i < arr.length; i += 3) {
        const dx = arr[i], dy = arr[i + 1], dz = arr[i + 2];
        const mag = Math.hypot(dx, dy, dz);
        if (mag > 3e-4) { moving++; sx += dx; sy += dy; sz += dz; vcount++; }
        if (mag > maxMag) maxMag = mag;
      }
      const g = groupOf(mi, t);
      const gname = g ? (g.presetName && g.presetName !== 'unknown' ? g.presetName : 'c:' + g.name) : '—';
      const n = Math.max(1, vcount);
      console.log(
        `  ${String(t).padStart(2)}  ${String(gname).padEnd(14)} ${(maxMag * 1000).toFixed(2).padStart(7)}mm  ` +
        `[${(sx / n * 1000).toFixed(2)}, ${(sy / n * 1000).toFixed(2)}, ${(sz / n * 1000).toFixed(2)}]`.padEnd(28) +
        `  ${moving}`
      );
    }
  });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1) 挑一个「脸」网格：表情 target 都在它上面
// ---------------------------------------------------------------------------
const M_TO_M = 1; // VRM 单位是米，本项目也是米，不用换算
let faceMeshIdx = 0, facePrim = null;
json.meshes.forEach((m, mi) => {
  const n = (m.primitives[0].targets || []).length;
  if (n > (facePrim?.targets?.length ?? 0)) { faceMeshIdx = mi; facePrim = m.primitives[0]; }
});
console.log(`脸网格: #${faceMeshIdx} ${json.meshes[faceMeshIdx].name}  targets ${(facePrim.targets || []).length}`);

/** 取某个 group 的位移数组（可能跨多个 bind，这里做加权合成） */
function groupDelta(group) {
  const count = json.accessors[facePrim.attributes.POSITION].count;
  const out = new Float32Array(count * 3);
  for (const b of group.binds || []) {
    if (b.mesh !== faceMeshIdx) continue;
    const accIdx = (facePrim.targets || [])[b.index]?.POSITION;
    if (accIdx === undefined) continue;
    const arr = readAccessor(json, bin, accIdx);
    const w = (b.weight || 0) / 100;
    for (let i = 0; i < out.length; i++) out[i] += arr[i] * w;
  }
  return out;
}
const groupDeltaByKey = (k) => {
  const g = groupByKey(k);
  return g ? groupDelta(g) : null;
};

// ---------------------------------------------------------------------------
// 2a-1) 合成两个基础算子
// ---------------------------------------------------------------------------

/** 直接把几组位移按权重相加 */
const blend = (parts) => {
  const count = json.accessors[facePrim.attributes.POSITION].count;
  const out = new Float32Array(count * 3);
  let used = 0;
  for (const [key, w] of parts) {
    const d = groupDeltaByKey(key);
    if (!d) continue;
    used++;
    for (let i = 0; i < out.length; i++) out[i] += d[i] * w;
  }
  return used ? out : null;
};

/**
 * 让一个**整脸表情**变成单部位通道：只保留「某个高度以上」的位移。
 *
 * ⚠️ 为什么需要这个：VRoid 的 joy / fun / sorrow 都是整脸表情，
 *    嘴带纯度只有 38–39%。直接接给 eyeSquint 会把嘴唇一起拽走。
 *    但它们的**眼带以上部分**是干净的 —— 把嘴带以下的位移清零，
 *    就得到一个纯眼周/眉部通道。
 *
 * ⚠️ 分界高度不能硬编码 1.44：不同模型身高不同。
 *    改成从**眨眼位移**反推眼睛位置 —— 眨眼的动点一定在眼睛上，
 *    它的 y 下界就是「眼带下沿」。这比任何绝对数字都可靠。
 */
let EYE_LINE_Y = null;
function eyeLine() {
  if (EYE_LINE_Y !== null) return EYE_LINE_Y;
  let lo = Infinity;
  for (const k of ['blink_l', 'blink_r', 'blink']) {
    const d = groupDeltaByKey(k);
    if (!d) continue;
    for (let i = 0; i < NVERT; i++) {
      const m = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
      if (m > 3e-4) { const y = posOf(i); if (y < lo) lo = y; }
    }
  }
  // 取不到眨眼就退回「脸包围盒的 55% 高度」当兜底
  EYE_LINE_Y = Number.isFinite(lo) ? lo : (faceYMin + (faceYMax - faceYMin) * 0.55);
  return EYE_LINE_Y;
}

/** 只保留眼线以上的位移 */
function maskUpper(key, w) {
  const src = groupDeltaByKey(key);
  if (!src) return null;
  const line = eyeLine();
  const out = new Float32Array(NVERT * 3);
  let used = 0;
  for (let i = 0; i < NVERT; i++) {
    if (posOf(i) < line) continue;           // 眼线以下的（嘴/下巴）一律不要
    const m = Math.hypot(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
    if (m <= 3e-4) continue;
    out[i * 3] = src[i * 3] * w;
    out[i * 3 + 1] = src[i * 3 + 1] * w;
    out[i * 3 + 2] = src[i * 3 + 2] * w;
    used++;
  }
  return used ? out : null;
}

// 脸顶点坐标（算分界高度用）
const NVERT = json.accessors[facePrim.attributes.POSITION].count;
const FACE_POS = readAccessor(json, bin, facePrim.attributes.POSITION);
const posOf = (i) => FACE_POS[i * 3 + 1];
let faceYMin = Infinity, faceYMax = -Infinity;
for (let i = 0; i < NVERT; i++) { const y = FACE_POS[i * 3 + 1]; if (y < faceYMin) faceYMin = y; if (y > faceYMax) faceYMax = y; }

// ⚠️ 这张表是**用数据定出来的**，不是按 ARKit/VRM 的名字对应关系猜的。
//    定表的方法（tools/vrm-locate.mjs + 逐高度分档统计）：
//      对每个 VRM 表情，看它的位移**落在哪个绝对高度**上。
//      Shino 这个模型实测五官高度：
//         嘴  1.403–1.442      眼  1.442–1.520      眉  1.480–1.539
//      再算「嘴带纯度」= 嘴带动点 / 全部动点：
//         a 99%  i 100%  u 100%  e 100%  o 99%   ← 纯口型，可当唇形通道
//         blink_l/blink_r  嘴带 0%               ← 纯眼部，可当眨眼通道
//         joy 38%  fun 39%  sorrow 39%  angry 30% ← 整脸表情！
//
// ⚠️ 用整脸表情当单通道是最容易踩的坑：
//    joy 的位移里同时含「眉 + 眼 + 嘴」三块。
//    接给 mouthSmile，等于笑起来的时候嘴唇执行了眼睛和眉毛的动作
//    —— 拍出来是"下巴掉到胸口、脸下半塌成 V 形"。
//    这个 bug 我犯了两次（第一次是 i(0.25) 叠加，第二次是 joy(0.9)）。
//    判据很简单：**用单通道之前，先确认那个表情的嘴带纯度/眼带纯度够高**。
//
// 代价：VRoid 基础模型没有"微笑"这种纯唇形表情，
//       所以嘴部情绪只能由元音合成，或者干脆不表达（留空比扭曲好）。
// ---------------------------------------------------------------------------
const CHANNELS = [
  // 眨眼 —— 必须用分眼版本（blink 是双眼合并，接单边会两只眼一起眨）
  ['eyeBlinkLeft',   [['blink_l', 1]]],
  ['eyeBlinkRight',  [['blink_r', 1]]],
  // 张嘴 —— A 就是纯开口，嘴带纯度 99%
  ['jawOpen',        [['a', 1]]],
  // 圆嘴 —— U/O 都是撮圆
  ['mouthPucker',    [['u', 0.8], ['o', 0.35]]],
  ['mouthFunnel',    [['o', 0.55], ['u', 0.3]]],
  // 笑 —— 「嘴角上提 + 左右外扩」，只用纯口型元音合成。
  // ⚠️ 绝不能放 joy：joy 嘴带纯度仅 38%，会顺带拽动眼睛和眉毛。
  //    实测 i+e 合成后嘴唇横向拉伸、露出牙齿、下巴位置正常。
  ['mouthSmileLeft',  [['i', 0.5], ['e', 0.35]]],
  ['mouthSmileRight', [['i', 0.5], ['e', 0.35]]],
  // 嘴角下拉 —— 同理不能用 sorrow（39%），改用镜像合成
  ['mouthFrownLeft',  [['__mirror__', -1]]],
  ['mouthFrownRight', [['__mirror__', -1]]],
  // 皱眉 —— angry 嘴带 30%，但它动的大部分在眉眼带（482/686），
  //        皱眉本来就是眉部动作，所以它是这几个"整脸"表情里唯一能用的。
  ['browDownLeft',    [['angry', 0.6]]],
  ['browDownRight',   [['angry', 0.6]]],
  // 眼周（眯眼）—— fun 嘴带 39%，直接用会拽嘴。
  // 改为只取「眼带以上」的那部分位移（maskUpper 见下）。
  ['eyeSquintLeft',   [['__upper__', 'fun', 0.85]]],
  ['eyeSquintRight',  [['__upper__', 'fun', 0.85]]],
  // 睁大眼 —— 用双眼微抬（从 a 里取眼带以上的微量上抬，不碰嘴）
  ['eyeWideLeft',     [['__upper__', 'joy', 0.5]]],
  ['eyeWideRight',    [['__upper__', 'joy', 0.5]]],
  // 挑眉 —— joy 的眉带成分
  ['browInnerUp',     [['__upper__', 'joy', 0.45]]],
];

// ---------------------------------------------------------------------------
// 2b) 缺组补偿 —— 「没有这个表情」和「这个表情是零」必须分开处理
// ---------------------------------------------------------------------------
// VRoid 基础模型只有 a/e/i/o/u/blink 六组（tools/vrm-deltas.mjs 实测）。
// 上面表里的 joy / fun / angry / sorrow / surprised 全部命中不了。
//
// ⚠️ 这里的选择很关键：**不要凭空造一个"近似"通道**。
//    第一版就是这么栽的 —— 用 U+O 拼出一个"微笑"，结果把下颌整个拉下来，
//    看着像鬼脸。人眼对「笑」极其挑剔，糊一个假的不如不做。
//
// 正确做法分两类：
//   1. 能用**口腔顶点自身的左右镜像**表达的（嘴角上提/下拉）→ 合成，见 mirrorLipCorner()
//   2. 眼周/眉毛动不了就是动不了（VRoid 那 16 个 target 里没有一块是眉毛）
//      → 通道留空，并把「用哪条通道替代」交给 app 端的 faceStandard 别名表。
//      留空 = 权重写了也没反应，比写错变形安全得多。
const hasPreset = (k) => !!groupByKey(k);
// 内部槽位标记（不是 VRM 预设名），体检时不该算作"缺组"
const INTERNAL = new Set(['__mirror__', '__upper__']);
const missing = [];
for (const [name, parts] of CHANNELS) {
  const dead = parts.filter(([k]) => !INTERNAL.has(k) && !hasPreset(k));
  if (dead.length) missing.push(`${name} ← 缺 ${dead.map((d) => d[0]).join('+')}`);
}
if (missing.length) {
  console.log(`\n  -- 以下通道在本模型里没有对应表情组（写成零位移：不是坏数据，是「此模型没这个表情」）--`);
  for (const m of missing) console.log('     ' + m);
}

/**
 * 嘴角形变的**镜像合成**。
 * 做法：取一个张口元音的口腔位移，把每个顶点沿 X 轴对称镜像到另一侧，
 * 再把「下颌整体下移」的那部分减掉 —— 只留下**嘴角自身的形变**。
 *
 * ⚠️ 为什么必须扣 dy：元音 a/o/u 的主要成分就是"下颌整体下移"。
 *    不扣掉的话，得到的不是"笑"，是"张嘴"（第一版鬼脸就是这个原因）。
 *
 * ⚠️ 为什么必须限制区域：第一版把「镜像过来的所有点」都写进 target，
 *    移动顶点从 356 暴涨到 2145 —— 那是**整张脸**（含上半脸）。
 *    原因是 a 的位移数组里，没动到的点也带着浮点噪声，镜像后按 X 取半
 *    等于把噪声重新分配了一遍。这样生成的通道会"笑的时候整脸抖"。
 *    正确做法是用「别的元音动过哪些点」当嘴部掩码，只在那里面合成。
 *
 * @param {string} key      源元音
 * @param {number} sy       +1 保留 +Y 成分（上提=笑）、-1 反号（下拉=悲）
 * @param {number} sx       +1 只留 +X 侧（右嘴角）、-1 只留 -X 侧
 */
function mirrorLipCorner(key, sy, sx) {
  const src = groupDeltaByKey(key);
  if (!src) return null;
  const count = json.accessors[facePrim.attributes.POSITION].count;
  const pos = readAccessor(json, bin, facePrim.attributes.POSITION);

  // 嘴部掩码：所有元音动到过的点的并集。
  // 用并集而不是单个元音，是为了覆盖 a 没动但 i/e 动了的嘴角那一小圈。
  const mask = new Uint8Array(count);
  for (const k of ['a', 'i', 'u', 'e', 'o']) {
    const d = groupDeltaByKey(k);
    if (!d) continue;
    for (let i = 0; i < count; i++) {
      if (Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) > 3e-4) mask[i] = 1;
    }
  }
  const inMask = mask.reduce((a, b) => a + b, 0);
  if (!inMask) return null;

  // 量出「下颌下移」这个刚体分量 —— 用掩码内位移的均值 dy 代表
  let sumY = 0;
  for (let i = 0; i < count; i++) if (mask[i]) sumY += src[i * 3 + 1];
  const rigidDY = sumY / inMask;

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue;
    const x = pos[i * 3];
    // 取对侧的点镜像过来（嘴角左右对称，有对侧数据就够了）
    if (Math.sign(x) === Math.sign(sx) || x === 0) continue;
    // 扣掉刚体下移，再按 sy 决定是提还是拉
    const y = (src[i * 3 + 1] - rigidDY) * sy;
    const dx = src[i * 3];
    const dz = src[i * 3 + 2];
    if (Math.hypot(dx, y, dz) < 6e-4) continue;   // 抠掉残留噪声
    out[i * 3] = dx;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = dz;
  }
  return out;
}


// 左右嘴角的**上提（笑）/ 下拉（悲）**：
// 源模型没有 joy/sorrow，所以从元音的口腔形变里镜像抠出来。
// 只有嘴角这一块能被这样造出来；眼周/眉毛在 VRoid 基础模型里压根没有对应顶点位移，
// 硬造等于画鬼，所以一律留空（见上面 2b 的说明）。
const LIP_SRC = hasPreset('a') ? 'a' : (hasPreset('o') ? 'o' : null);
const MIRROR_SLOTS = {
  mouthFrownLeft:  LIP_SRC ? ['__mirror__', LIP_SRC, -1, +1] : null,
  mouthFrownRight: LIP_SRC ? ['__mirror__', LIP_SRC, -1, -1] : null,
};

const built = [];
for (const [name, parts] of CHANNELS) {
  // 三路派发：镜像槽 / 上脸裁剪槽 / 普通合成
  let d = null, via = '';
  const mir = MIRROR_SLOTS[name];
  const upper = parts[0][0] === '__upper__' ? parts[0] : null;
  if (upper) {
    d = maskUpper(upper[1], upper[2]);
    via = `上脸裁剪自 ${upper[1]}×${upper[2]}`;
  } else if (mir) {
    d = mirrorLipCorner(mir[1], mir[2], mir[3]);
    via = `镜像自 ${mir[1]}`;
  } else {
    d = blend(parts);
    via = parts.filter(([k]) => hasPreset(k)).map(([k, w]) => `${k}×${w}`).join('+');
  }
  if (!d) {
    // 不是错误：这个模型就是没有这个表情。留一条零位移占位，
    // 保证 app 端 morphTargetDictionary 里**名字存在**（写权重不报错），
    // 同时移位数 0（写了也不变形）。
    built.push({ name, data: new Float32Array(NVERT * 3), max: 0, moving: 0 });
    console.log(`  ${name.padEnd(16)} —              空（本模型无此表情组）`);
    continue;
  }
  let max = 0, moving = 0;
  for (let i = 0; i < d.length; i += 3) {
    const mag = Math.hypot(d[i], d[i + 1], d[i + 2]);
    if (mag > 3e-4) moving++;
    if (mag > max) max = mag;
  }
  built.push({ name, data: d, max, moving });
  console.log(`  ${name.padEnd(16)} 位移最大 ${(max * 1000).toFixed(1).padStart(5)}mm   移动顶点 ${String(moving).padStart(4)}   ${via}`);
}

// 2c) 上一轮通道体检
// ⚠️ 必须显式打印「哪些通道是空的」：
//    ARKit 有 52 条通道，本模型最多只能驱动 16 条。
//    余下的通道写权重时**不会报错、也不会有任何反应**，
//    于是"角色不笑"这种现象会被误判成"绑定坏了"。
//    把清单打出来，排查时一眼能定位。
const emptyCh = [];
for (const b of built) if (b.moving === 0) emptyCh.push(b.name);
if (emptyCh.length) console.warn(`  ⚠️ 零位移通道: ${emptyCh.join(', ')}`);
console.log(`  可用通道 ${built.filter((b) => b.moving > 0).length} / ${built.length}`);

if (DRY) {
  console.log('\n--dry：只做映射体检，未写盘。');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3) 贴图：丢掉 MToon 专属图和缩略图，其余按 --max 降采样
// ---------------------------------------------------------------------------
// VRM 0.x 的 materialProperties 里 _BumpMap 指向法线贴图 —— 只有 MToon 用。
// 我们保留 KHR_materials_unlit（three.js 原生支持 → MeshBasicMaterial，
// 正好还原 VRoid 的赛璐璐观感），所以法线/高光图全部无用。
// ⚠️ Thumbnail 是 VRoid 塞的 2048² 预览图，运行时根本不会引用。
// ⚠️ 黑名单必须带 **Shader_None** 前缀：
//    VRoid 会为「不要把某个 slot 画出来」塞一张 81 字节的纯黑占位图
//    （Shader_NoneBlack / Shader_NoneNormal / Shader_NoneWhite…）。
//    第一版只按后缀匹配，漏掉了 `Shader_NoneBlack`，
//    于是它被当成**基色贴图**留下 —— 渲出来就是整块死黑。
//    实测该模型有 2 张 81B 的 Shader_NoneBlack 挂在材质上。
const DROP_IMG_RE = /(^Shader_None|_nml$|_spe$|_out$|_mas$|_mask$|_ShadeSphere$|_Sphere$|Matcap|Thumbnail$)/i;
// Matcap 不是「白名单外」而是**必须丢**：它的 UV 是屏幕空间的，
// 留作基色只会得到一片错位的高光。
const KEEP_IMG_NAME = /Thumbnail/i; // 永远丢

const texOf = (json.textures || []).map((t) => t.source);
/** 某个 texture slot 最终用到的 image index */
function texImage(idx) {
  const t = json.textures?.[idx];
  return t?.source;
}

console.log('\n-- 贴图处理 (' + (json.images || []).length + ' 张) --');
const imgKeep = new Map();   // old image index -> { buf, mime, name }
let savedBytes = 0;
(json.images || []).forEach((img, ii) => {
  const name = img.name || ('#' + ii);
  const bv = json.bufferViews[img.bufferView];
  const bytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  savedBytes += bv.byteLength;

  const shouldDrop = (KEEP_IMG_NAME.test(name)) ||
    (!KEEP_NML && DROP_IMG_RE.test(name));
  if (shouldDrop) {
    console.log(`  丢  ${name.padEnd(34)} ${(bv.byteLength / 1024).toFixed(0)}KB`);
    imgKeep.set(ii, null);
    return;
  }
  let outBuf = bytes, tag = '';
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    const long = Math.max(png.width, png.height);
    if (long > MAXDIM) {
      const s = MAXDIM / long;
      const w = Math.max(1, Math.round(png.width * s));
      const h = Math.max(1, Math.round(png.height * s));
      const dst = new PNG({ width: w, height: h });
      // 盒式降采样（先在一次遍历里算平均，避免半像素偏移）
      const rx = png.width / w, ry = png.height / h;
      for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * ry), y1 = Math.min(png.height, Math.max(y0 + 1, Math.floor((y + 1) * ry)));
        for (let x = 0; x < w; x++) {
          const x0 = Math.floor(x * rx), x1 = Math.min(png.width, Math.max(x0 + 1, Math.floor((x + 1) * rx)));
          let r = 0, g = 0, b = 0, a = 0, n = 0;
          for (let sy = y0; sy < y1; sy++) {
            for (let sx = x0; sx < x1; sx++) {
              const si = (sy * png.width + sx) << 2;
              r += png.data[si]; g += png.data[si + 1]; b += png.data[si + 2]; a += png.data[si + 3];
              n++;
            }
          }
          const di = (y * w + x) << 2;
          dst.data[di] = r / n; dst.data[di + 1] = g / n; dst.data[di + 2] = b / n; dst.data[di + 3] = a / n;
        }
      }
      outBuf = PNG.sync.write(dst, { colorType: 6, deflateLevel: 9 });
      tag = `${png.width}x${png.height} → ${w}x${h}`;
    } else {
      tag = `${png.width}x${png.height} 保持`;
    }
  } catch (e) {
    console.log(`  ⚠️ ${name} PNG 解码失败，原样保留：${e.message}`);
  }
  console.log(`  留  ${name.padEnd(34)} ${tag.padEnd(26)} ${(outBuf.length / 1024).toFixed(0)}KB (原 ${(bv.byteLength / 1024).toFixed(0)}KB)`);
  imgKeep.set(ii, { buf: outBuf, mime: 'image/png', name });
});

// ---------------------------------------------------------------------------
// 4) 重建 GLB：保留除「贴图 / 旧 morph target」之外的一切
// ---------------------------------------------------------------------------
const outJson = JSON.parse(JSON.stringify(json));

// 4a) 贴图/纹理重定向
const newImgByOld = new Map();
const newImages = [];
(json.images || []).forEach((_, ii) => {
  const k = imgKeep.get(ii);
  if (!k) return;
  newImgByOld.set(ii, newImages.length);
  newImages.push({ name: k.name, mimeType: k.mime, bufferView: -1 });  // bufferView 待填
});
const newTexByOld = new Map();
const newTextures = [];
(json.textures || []).forEach((t, ti) => {
  // source 指向的图片被丢了 → 这张 texture 整个作废
  if (t.source === undefined || !newImgByOld.has(t.source)) return;
  newTexByOld.set(ti, newTextures.length);
  const nt = JSON.parse(JSON.stringify(t));
  nt.source = newImgByOld.get(t.source);
  newTextures.push(nt);
});
outJson.textures = newTextures;
outJson.images = newImages;

// 4b) 材质里所有 texture 引用重定向；指向作废 texture 的 slot 直接删掉
const TEX_SLOTS = {
  normalTexture: 'NORMAL',
  emissiveTexture: 'EMISSIVE',
  occlusionTexture: 'OCC',
};
const delIfMissing = (m, slot) => {
  if (!m[slot]) return;
  if (m[slot].index === undefined || !newTexByOld.has(m[slot].index)) delete m[slot];
  else m[slot].index = newTexByOld.get(m[slot].index);
};
for (const m of outJson.materials || []) {
  for (const slot of ['normalTexture', 'emissiveTexture', 'occlusionTexture']) delIfMissing(m, slot);
  const pbr = outJson.materials[outJson.materials.indexOf(m)]?.pbrMetallicRoughness;
  if (!pbr) continue;
  if (pbr.baseColorTexture && !newTexByOld.has(pbr.baseColorTexture.index)) delete pbr.baseColorTexture;
  else if (pbr.baseColorTexture) pbr.baseColorTexture.index = newTexByOld.get(pbr.baseColorTexture.index);
  if (pbr.metallicRoughnessTexture && !newTexByOld.has(pbr.metallicRoughnessTexture.index)) delete pbr.metallicRoughnessTexture;
  else if (pbr.metallicRoughnessTexture) pbr.metallicRoughnessTexture.index = newTexByOld.get(pbr.metallicRoughnessTexture.index);
}

// 4c) 定「哪些 accessor 还要」 —— 必须从**引用**推导，不能靠猜
//
// ⚠️ 第一版踩的坑：只做「新的脸 targets 换掉旧的」，旧 accessor / 它的旧数字编号
//    原封不动留在 JSON 里。结果重排之后那个旧编号指到了**另一段** bufferView 上，
//    three.js 读 accessor 时越界，报 RangeError: Invalid typed array length。
//    正确做法是：先算出还在被引用的是哪些，把其余的**整条删掉**，再重排索引。
const dropBv = new Set();
// ⚠️ 旧贴图数据**必须整段剔除**：压完的图会在下面以新 bufferView 重新写入，
//    忘了这一步就是「新图 + 旧图都在 BIN 里」，第二次跑完输出 15.25MB 比输入还大。
for (const img of json.images || []) if (img.bufferView !== undefined) dropBv.add(img.bufferView);

/** 某个 accessor 用到的所有 bufferView（含 sparse 的两段） */
function bvsOfAcc(i) {
  const a = json.accessors[i];
  if (!a) return [];
  const out = [];
  if (a.bufferView !== undefined) out.push(a.bufferView);
  if (a.sparse) { out.push(json.accessors[a.sparse.indices].bufferView, json.accessors[a.sparse.values].bufferView); }
  return out.filter((x) => x !== undefined);
}

const refAcc = new Set();
json.meshes.forEach((m, mi) => {
  // ⚠️ 一个 mesh 里可能有**很多个 primitive**，不是只有 [0]。
  //    VRoid 的脸就是这样：皮肤 / 嘴 / 眼线 / 睫毛 / 虹膜…每个材质一份，
  //    10 个 primitive 共享同一批 attributes 和同一份 41 个 targets。
  //    第一版只处理 primitives[0]，剩下 9 份仍指着旧的 accessor 编号，
  //    重排之后全部越界 → three 报 Cannot read properties of undefined (reading 'min')。
  for (const p of m.primitives) {
    for (const v of Object.values(p.attributes || {})) refAcc.add(v);
    if (p.indices !== undefined) refAcc.add(p.indices);
    // 脸网格的 targets 会被整体替换，故意不计入；其余网格的 targets 要保留
    if (mi !== faceMeshIdx) for (const t of (p.targets || [])) for (const k of Object.keys(t)) refAcc.add(t[k]);
  }
});
for (const s of json.skins || []) {
  if (s.inverseBindMatrices !== undefined) refAcc.add(s.inverseBindMatrices);
  if (s.joints && !Array.isArray(s.joints)) refAcc.add(s.joints);
}
// sparse 子 accessor 也要跟着留下
for (const i of [...refAcc]) {
  const a = json.accessors[i];
  if (a?.sparse) { refAcc.add(a.sparse.indices); refAcc.add(a.sparse.values); }
}

const accKeep = [...refAcc].filter((i) => {
  const a = json.accessors[i];
  if (!a) return false;
  return !bvsOfAcc(i).some((b) => dropBv.has(b));
});
accKeep.sort((x, y) => x - y);
const accMap = new Map(accKeep.map((old, i) => [old, i]));   // 旧 accessor 号 → 新号

const chunks = [];
let cursor = 0;
const pad = (n) => { const rem = cursor % n; return rem ? n - rem : 0; };
const emit = (buf) => {
  const lead = pad(4);
  if (lead) { chunks.push(Buffer.alloc(lead)); cursor += lead; }
  const off = cursor;
  chunks.push(Buffer.from(buf));
  cursor += buf.length;
  return off;
};

// 只拷「还会被引用」的 bufferView
const needBv = new Set();
for (const i of accKeep) for (const b of bvsOfAcc(i)) needBv.add(b);

const newBvByOld = new Map();
const newBufferViews = [];
json.bufferViews.forEach((bv, bi) => {
  if (!needBv.has(bi) || dropBv.has(bi)) return;
  const bytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  if (!bytes.length) return;
  const off = emit(bytes);
  newBvByOld.set(bi, newBufferViews.length);
  const nbv = JSON.parse(JSON.stringify(bv));
  nbv.byteOffset = off;
  nbv.buffer = 0;
  // ⚠️ byteStride **必须原样保留**：删了它 loader 就按「紧密排列」去读，
  //    遇到真正交错的（POSITION/NORMAL 打在同一个 bufferView 里）会整段读错。
  newBufferViews.push(nbv);
});

// 4d) 追加新贴图
const imgOrder = [...newImgByOld.keys()];   // 老的 image 号，顺序和新列表一致
for (const oldImg of imgOrder) {
  const src = imgKeep.get(oldImg);
  const off = emit(src.buf);
  newBufferViews.push({ buffer: 0, byteOffset: off, byteLength: src.buf.length });
  newImages[newImgByOld.get(oldImg)].bufferView = newBufferViews.length - 1;
}

// 4e) 重排 accessor + 追加新建的表情 target
const newAccessors = accKeep.map((old) => {
  const na = JSON.parse(JSON.stringify(json.accessors[old]));
  if (na.bufferView !== undefined) na.bufferView = newBvByOld.get(na.bufferView);
  if (na.sparse) {
    na.sparse.indices = accMap.get(na.sparse.indices);
    na.sparse.values = accMap.get(na.sparse.values);
  }
  return na;
});
function pushAccessor(arr, type = 'VEC3', componentType = 5126) {
  const nc = NCOMP[type];
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const off = emit(buf);      // emit 自带 4 字节对齐，别在外面再 pad 一次
  newBufferViews.push({ buffer: 0, byteOffset: off, byteLength: buf.length });
  // 位移有正有负，min/max 必须写对，否则某些 loader 会走 normalize 路径
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += nc) for (let c = 0; c < nc; c++) {
    const v = arr[i + c];
    if (v < mn[c]) mn[c] = v;
    if (v > mx[c]) mx[c] = v;
  }
  newAccessors.push({ bufferView: newBufferViews.length - 1, componentType, count: arr.length / nc, type, min: mn, max: mx });
  return newAccessors.length - 1;
}

const newTargets = [];
const newTargetNames = [];
for (const b of built) {
  const pidx = pushAccessor(b.data, 'VEC3', 5126);
  newTargets.push({ POSITION: pidx });
  newTargetNames.push(b.name);
}

// 4f) 所有还存在的引用重编号：脸网格换成新建的 targets，其余按 accMap 平移
const remapAcc = (i) => {
  if (!accMap.has(i)) throw new Error(`accessor #${i} 没进保留集，却在被引用 —— 说明引用统计有漏`);
  return accMap.get(i);
};
outJson.meshes.forEach((m, mi) => {
  const isFace = mi === faceMeshIdx;
  for (const p of m.primitives) {
    for (const k of Object.keys(p.attributes || {})) p.attributes[k] = remapAcc(p.attributes[k]);
    if (p.indices !== undefined) p.indices = remapAcc(p.indices);
    if (isFace) {
      // 每个 primitive 各自一份副本，避免 10 份共用同一个数组被后续处理改写
      p.targets = newTargets.map((t) => ({ ...t }));
    } else {
      for (const t of (p.targets || [])) for (const k of Object.keys(t)) t[k] = remapAcc(t[k]);
    }
  }
  if (isFace) {
    m.extras = { ...(m.extras || {}), targetNames: newTargetNames };
  }
});
for (const s of outJson.skins || []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = remapAcc(s.inverseBindMatrices);

outJson.accessors = newAccessors;
outJson.bufferViews = newBufferViews;
console.log(`\n  accessor ${json.accessors.length} → ${newAccessors.length}（新建 ${newTargets.length}）  bufferView ${json.bufferViews.length} → ${newBufferViews.length}`);

// 4g) 剥掉 VRM 扩展（保留 KHR_materials_unlit）
delete outJson.extensions.VRM;
if (!Object.keys(outJson.extensions || {}).length) delete outJson.extensions;
if (outJson.extensionsUsed) {
  outJson.extensionsUsed = outJson.extensionsUsed.filter((e) => e !== 'VRM');
  if (!outJson.extensionsUsed.length) delete outJson.extensionsUsed;
}
if (outJson.extensionsRequired) {
  outJson.extensionsRequired = outJson.extensionsRequired.filter((e) => e !== 'VRM');
  if (!outJson.extensionsRequired.length) delete outJson.extensionsRequired;
}
outJson.buffers = [{ byteLength: 0 }];   // 最后改成真实长度

// ---------------------------------------------------------------------------
// 4h) 材质补全：兜住「丢完贴图后什么都不剩」的黑块
// ---------------------------------------------------------------------------
// ⚠️ MToon 的观感 = baseColor × (shade色/去色) + 边缘光 + 高光。
//    我们丢掉 _BumpMap/Sphere/Matcap 之后，只剩 baseColor，
//    在 three 里就是「纯平涂」——比 VRoid 里看着更哑、更没有体积感。
//    既然材质已经是 unlit，最省事又最像的补法就是：
//      - 保证 baseColorFactor 存在且为白（否则默认乘 1 也一样，写明白便于排查）
//      - 把 MToon 的 shadeColor（暗部色）当「环境光下限」——unlit 材质不吃灯，
//        唯一能表达暗部层次的办法就是别让基色贴图被过暗的 factor 乘没
//    这不是"还原 MToon"，是"别让它变成黑块"。真正的赛璐璐层次留给 app 端
//    后处理（见 src/three/companion.js 的材质策略）。
for (const m of outJson.materials || []) {
  const pbr = (m.pbrMetallicRoughness ||= {});
  if (!pbr.baseColorFactor) pbr.baseColorFactor = [1, 1, 1, 1];
  // unlit 不看 metallic，但三个版本对缺省值处理不一，写死 0 更稳
  if (pbr.metallicFactor === undefined) pbr.metallicFactor = 0;
  if (pbr.roughnessFactor === undefined) pbr.roughnessFactor = 1;
  if (m.doubleSided === undefined) m.doubleSided = false;
}
// 死引用体检：材质里还有没有指向已删 texture 的 slot
{
  const dead = [];
  for (const m of outJson.materials || []) {
    for (const [slot, v] of Object.entries(m)) {
      const idx = v && typeof v === 'object' ? v.index : undefined;
      if (idx !== undefined && !newTextures[idx]) dead.push(`${m.name || '(无名)'}.${slot} -> tex${idx}`);
    }
    for (const [slot, v] of Object.entries(m.pbrMetallicRoughness || {})) {
      const idx = v && typeof v === 'object' ? v.index : undefined;
      if (idx !== undefined && !newTextures[idx]) dead.push(`${m.name || '(无名)'}.pbr.${slot} -> tex${idx}`);
    }
  }
  if (dead.length) console.warn('  ⚠️ 材质死引用（会显示成纯黑）:\n    ' + dead.join('\n    '));
  else console.log('  材质引用体检：无死引用');
}

// ---------------------------------------------------------------------------
// 5) 写盘
// ---------------------------------------------------------------------------
const binOut = Buffer.concat(chunks);
outJson.buffers = [{ byteLength: binOut.length }];
const jsonStr = Buffer.from(JSON.stringify(outJson), 'utf8');
const jsonPad = (4 - (jsonStr.length % 4)) % 4;
const jsonChunk = Buffer.concat([jsonStr, Buffer.alloc(jsonPad, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binOut.length, 8);
const jHead = Buffer.alloc(8); jHead.writeUInt32LE(jsonChunk.length, 0); jHead.writeUInt32LE(0x4e4f534a, 4);
const bHead = Buffer.alloc(8); bHead.writeUInt32LE(binOut.length, 0); bHead.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(OUT, Buffer.concat([header, jHead, jsonChunk, bHead, binOut]));

console.log('\n══ 完成 ══');
console.log(`  输入 ${(fs.statSync(IN).size / 1048576).toFixed(2)} MB  →  输出 ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB`);
console.log(`  表情通道 ${newTargetNames.length} 个: ${newTargetNames.join(' ')}`);
console.log(`  贴图 ${json.images.length} → ${newImages.length} 张，BIN 中贴图原始占用 ${(savedBytes / 1048576).toFixed(2)}MB`);
console.log(`  网格 ${outJson.meshes.length} 个 / 骨骼 ${outJson.skins.reduce((s, x) => s + x.joints.length, 0)} 个 joint`);

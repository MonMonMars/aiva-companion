// mheye-final.mjs —— 眼球导出（定版）
// ===========================================================================
// 这一版把前面所有踩坑的结论固化下来。踩坑史见文件末尾「坑列表」。
//
// ★ 本版的两个决定性修正
//
//  修正 1：**几何层对齐注视轴**（根因）
//    前面一直在调 UV，但真正的病根在几何：源网格的虹膜**不是朝 +Z**。
//    实测（tools/mheye-where.mjs，从渲染页读世界空间方向）：
//        EyeL 虹膜方向 (0.048, -0.359, 0.932)
//        EyeR 虹膜方向 (0.290, -0.146, 0.946)
//    都偏 +X（朝鼻梁）和 -Y（朝下），所以画面里虹膜偏内侧偏下、正面看到眼白。
//    → 做法：先算出虹膜朝向 a，再构造把 a 转到 +Z 的最小旋转，作用到顶点位置。
//      旋转后虹膜严格朝 +Z，此时"正前方"就是 +Z，一切推导都成立。
//
//  修正 2：**UV 由顶点位置解析生成**，不再继承源 UV
//    源 UV 有两个致命问题：
//      · 高模不在 [0,1] UV 空间里（左球 u 0.42..0.99，右球 0.036..0.99）
//      · 两颗球**共用同一套 UV**，UV 空间完全重叠
//    我在这上面手工翻了 4 轮符号（配对 / u 向 / v 向），每轮都是"看起来对不对"，
//    最后发现"两颗球的正前方顶点都指向素材球 A"——即配对根本不是 1:1 的。
//    与其继续猜，不如**丢掉源 UV**：用顶点相对虹膜轴的角度直接算 UV。
//        θ = 顶点方向与 +Z 的夹角（旋转后）
//        φ = 绕 +Z 的方位角
//        "等距方位投影"：UV 中心 = 虹膜中心，UV 半径 ∝ θ
//    这样 UV 与几何**同源**，不可能错位；且 θ 单调 → 无接缝、无极点收缩。
//
//  修正 3：左右骨骼映射纠正
//    实测 eyeL 骨骼在 **+X** 侧、eyeR 在 **-X** 侧（和命名直觉相反）。
//    本文件按「几何 X 符号」输出 EyePosX / EyeNegX 两个网格，
//    由调用方（预览页）按 X 符号绑骨骼，不再靠名字猜。
//
// 用法: node tools/mheye-final.mjs [--eyeR 0.0125] [--texN 512] [--mat B]
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const OUT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-parts-mh.glb';
const argVal = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const TARGET_EYE_R_M = Number(argVal('eyeR', 0.0125));
const TEX_N = Number(argVal('texN', 512));

// ------------------------------------------------------------------ 工具
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const L = Math.hypot(...a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };

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

// ---------------------------------------------------------- 身体配准
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

// ------------------------------------------------------------ 眼球源数据
const eyeObj = parseOBJ(path.join(SRC, 'eyes/high-poly/high-poly.obj'));
const gEye = eyeObj.groups.__default;
const allIdx = [...new Set(gEye.tris)];
function sphere(sign) {
  const vs = allIdx.filter((i) => (sign < 0 ? eyeObj.V[i][0] < 0 : eyeObj.V[i][0] >= 0));
  let c = [0, 0, 0];
  for (const i of vs) for (let k = 0; k < 3; k++) c[k] += eyeObj.V[i][k];
  c = c.map((x) => x / vs.length);
  let r = 0;
  for (const i of vs) r = Math.max(r, Math.hypot(eyeObj.V[i][0] - c[0], eyeObj.V[i][1] - c[1], eyeObj.V[i][2] - c[2]));
  return { c, r, vs };
}
const spN = sphere(-1), spP = sphere(+1);
console.log(`源球：-X 侧 c=(${spN.c.map(x => x.toFixed(4))}) r=${spN.r.toFixed(4)}`);
console.log(`      +X 侧 c=(${spP.c.map(x => x.toFixed(4))}) r=${spP.r.toFixed(4)}`);

// ★★★ 定位的权威来源：MakeHuman 自带的**注视轴**
//   base.obj 里有一套骨骼辅助点（实测，tools 里量过）：
//     joint-l-eye      (0.308, 7.284, 1.245)   ← 眼球转动中心
//     joint-l-eye-target (0.317, 7.295, 1.618) ← 注视目标点
//   从 eye 指向 eye-target 的方向**就是解剖学上的注视方向**，
//   这比我自己去猜"虹膜朝哪"可靠得多（前面猜了 5 轮都没收敛）。
//   做法：把眼球球心放在 joint-eye 处，把几何旋转到「eye→target 方向 = +Z」。
function joint(name) {
  const g = bG[name];
  if (!g) return null;
  const idx = [...new Set(g.tris)];
  const c = [0, 0, 0];
  for (const i of idx) for (let k = 0; k < 3; k++) c[k] += bV[i][k];
  return c.map((x) => x / idx.length);
}
const jl = joint('joint-l-eye'), jlt = joint('joint-l-eye-target');
const jr = joint('joint-r-eye'), jrt = joint('joint-r-eye-target');
console.log(`joint-l-eye (${jl.map(x => x.toFixed(4))})  target (${jlt.map(x => x.toFixed(4))})`);
console.log(`joint-r-eye (${jr.map(x => x.toFixed(4))})  target (${jrt.map(x => x.toFixed(4))})`);
// 注视方向（源坐标系，未缩放）
const GAZE_L = norm(sub(jlt, jl));
const GAZE_R = norm(sub(jrt, jr));
console.log(`注视方向 L (${GAZE_L.map(x => x.toFixed(4))})  R (${GAZE_R.map(x => x.toFixed(4))})`);

// ★ 注视轴微调（让角色"平视前方"而不是略朝上看）
//   实测注视轴 (0.0257, 0.0289, 0.9992)：Y 分量为正 → 略朝**上**。
//   这是 MakeHuman 默认姿势（眼看向略远的目标点）。
//   但渲染出来观众感觉"眼睛朝下"，原因是**球心位置**而非朝向：
//   上眼睑垂下来遮住了虹膜上半，视觉重心落到虹膜下半。
//   → 处理：把注视轴按 --pitch 度往下压一点（默认 6°），让虹膜在眼裂里居中。
//   ⚠️ 第二次修正（实测数据，别再调回去）：
//   用 mh-bangs.mjs 量最终 GLB 得到的真实数字是：
//     眼球前极 Z = 0.1432，而**眼高处脸部前轮廓 Z = 0.1553**（不是注释里写的 0.1466）
//     → 前极比眼皮面还靠后 **12mm**，所以眼球"陷"在眼眶里，正面看是一小块浅色。
//   0.1466 那个数是把鼻子/眉弓最前点一起算进来造成的偏差。以 0.1553 为准。
//   要前极凸出轮廓 1mm：球心 Z = 0.1553 − 0.0125 + 0.001 = 0.1438
//   → sink = (0.1553 − 0.1438) / 0.0125 = 0.92（所以默认从 0.70 调到 0.92）。
const PITCH_DEG = Number(argVal('pitch', -6));
{
  const p = PITCH_DEG * Math.PI / 180;
  const rotX = (v) => [v[0], v[1] * Math.cos(p) - v[2] * Math.sin(p), v[1] * Math.sin(p) + v[2] * Math.cos(p)];
  const nl = norm(rotX(GAZE_L)), nr = norm(rotX(GAZE_R));
  GAZE_L.splice(0, 3, ...nl); GAZE_R.splice(0, 3, ...nr);
  console.log(`注视轴俯仰 ${PITCH_DEG}° → L (${GAZE_L.map(x => x.toFixed(4))})  R (${GAZE_R.map(x => x.toFixed(4))})`);
}
// 转换为米制坐标（toM：乘 S、Y 减 yOff）
const toM = (v) => [v[0] * S, v[1] * S - yOff, v[2] * S];
const EYE_C_L = toM(jl), EYE_C_R = toM(jr);
console.log(`眼球球心（米）L (${EYE_C_L.map(x => x.toFixed(4))})  R (${EYE_C_R.map(x => x.toFixed(4))})`);

// ★★★ 深度修正（这一条是"只露出侧后方导致眼白露方边"的根因）
//
// ⚠️ 历史教训（必读，别重蹈）：
//   之前我把 MakeHuman 源坐标（base.obj）换算成米后当球心用，但换算链上
//   center[1] 一处按米、一处按源单位，导致眼球被甩到身体坐标之外。
//   审计实测：身体 GLB（aiva-base-mh.glb）Z 范围 -0.1036..0.3281，
//   而眼球被放到 Z≈0.966..0.981 —— 超出脸前方 0.65 米，眼窝自然是空的。
//
//   正确做法：**一切以最终 GLB 的坐标为唯一真相**，不再跨坐标系换算。
//   实测（从 aiva-base-mh.glb 直接量，单位就是米）：
//     · 骨骼 eye.L = ( 0.0314, 1.5768, 0.1271)   ← 这就是眼球中心
//     · 骨骼 eye.R = (-0.0314, 1.5768, 0.1271)
//     · 眼高处脸部前轮廓 Z = 0.1466（X=±0.0314 处）
//     · 鼻梁最前 Z = 0.1641，头最前点 Z = 0.1715
//
//   注：MakeHuman 原模型的 joint-eye 比眼眶前轮廓深 0.219 源单位（≈0.0224 米），
//   这是"眼球旋转中心"的正常位置（真人眼球旋转中心也比角膜顶点深约 1 个眼球半径）。
//   所以骨骼 Z 可以直接用，只需按眼球半径稍微前移，让前极贴合轮廓。
//
//   前极 = 球心 Z + 眼球半径。要让前极贴到轮廓 Z=0.1466：
//     球心 Z = 0.1466 - 0.0125 = 0.1341
//   而骨骼 Z=0.1271 → 需要前移 0.0070 米。
//   DEPTH_SINK 参数化：球心 Z = 前轮廓 Z - 半径 × DEPTH_SINK
//     sink=0.92 → 球心 Z=0.1438（前极 Z=0.1563，凸出轮廓 1mm；二次元风格，默认）
//     sink=1.00 → 球心 Z=0.1428（前极 Z=0.1553，严格贴轮廓，真人比例）
//   ⚠️ 别再往下调 sink（越小越凸），> 1.0 也不要用，否则眼球鼓成"金鱼眼"。
const DEPTH_SINK = Number(argVal('sink', 0.92));

// —— 从身体 GLB 实测的常量（单位：米，基准 = aiva-base-mh.glb）——
const BASE_EYE = { L: [0.0314, 1.5768, 0.1271], R: [-0.0314, 1.5768, 0.1271] };
// ⚠️ 0.1466 是**旧值**（口径含鼻梁/眉弓最前点，偏浅）。用 mh-bangs.mjs 对最终 GLB
//    重量的正确值是 0.1553：只统计 |X| < 0.035 且 |Y − 眼高| < 0.008 的身体顶点。
const BASE_FACE_FRONT_Z = 0.1553;   // 眼高处脸部前轮廓
const BASE_EYE_R = 0.0125;          // 眼球半径（米）

console.log(`\n── 眼球定位（身体 GLB 坐标系，单位米）──`);
console.log(`  骨骼 eye.L (${BASE_EYE.L.map(x => x.toFixed(4))})  eye.R (${BASE_EYE.R.map(x => x.toFixed(4))})`);
console.log(`  眼高处脸部前轮廓 Z = ${BASE_FACE_FRONT_Z}`);

// 球心 Z：从脸部前轮廓后退「半径 × DEPTH_SINK」
const EYE_CZ_M = BASE_FACE_FRONT_Z - TARGET_EYE_R_M * DEPTH_SINK;
console.log(`  球心 Z = ${BASE_FACE_FRONT_Z} − ${TARGET_EYE_R_M} × ${DEPTH_SINK} = ${EYE_CZ_M.toFixed(4)}`);
console.log(`  （骨骼自带 Z=0.1271 → 前移 ${(EYE_CZ_M - 0.1271).toFixed(4)} 米）`);
console.log(`  前极 Z = ${(EYE_CZ_M + TARGET_EYE_R_M).toFixed(4)}  vs 轮廓 ${BASE_FACE_FRONT_Z}  → ${(EYE_CZ_M + TARGET_EYE_R_M - BASE_FACE_FRONT_Z) > 0 ? '凸出' : '内陷'} ${Math.abs(EYE_CZ_M + TARGET_EYE_R_M - BASE_FACE_FRONT_Z).toFixed(4)} 米`);

// 瞳距与头宽（用于判断是否需要收窄）
const curSepM = Math.abs(BASE_EYE.L[0] - BASE_EYE.R[0]);
const HEAD_W_M = 0.5064 * 2;        // 实测头最大宽度（米）
console.log(`  瞳距 ${curSepM.toFixed(4)} 米（头宽 ${HEAD_W_M.toFixed(4)}，比 ${(curSepM / HEAD_W_M).toFixed(4)}）`);
// 真人的"瞳距/头宽"约 0.46（用头最大宽度而不是两颊宽）。这里 0.0628/1.0128 = 0.062，
// 看着离谱是因为 HEAD_W 取自身体包围盒（含双臂张开）而非头骨宽。
// → 不再用这个比值做缩放，直接沿用骨骼 X（它本来就是解剖学正确的）。
const kSep = Number(argVal('kSep', 1.0));
console.log(`  X 缩放 ${kSep}（骨骼 X 本身就是解剖学正确位置，默认不缩放）`);

// ------------------------------------------------- 求每颗球的「虹膜朝向」
// 用源 UV 做一次粗略的最近距离归属（判据：离素材球 A 的虹膜中心近），
// 把归属 A 的顶点求球面方向均值 = 虹膜朝向。
// ⚠️ 这一步只用源 UV 做「候选筛选」，结果再被下面的旋转严格对齐，
//    所以即使归属判定有少量噪声也能被后续对齐吸收。
const IRIS_A = [0.70465, 0.29678];
const IRIS_B = [0.28867, 0.70885];
function irisAxis(sp) {
  const inA = [], inB = [];
  for (let t = 0; t < gEye.tris.length; t++) {
    const vi = gEye.tris[t];
    if (!sp.vs.includes(vi)) continue;
    const uv = eyeObj.VT[gEye.uvs[t]];
    const dA = Math.hypot(uv[0] - IRIS_A[0], uv[1] - IRIS_A[1]);
    const dB = Math.hypot(uv[0] - IRIS_B[0], uv[1] - IRIS_B[1]);
    const v = eyeObj.V[vi];
    const d = norm(sub(v, sp.c));
    (dA < dB ? inA : inB).push(d);
  }
  const avg = (arr) => {
    if (!arr.length) return null;
    const s = [0, 0, 0];
    for (const d of arr) for (let k = 0; k < 3; k++) s[k] += d[k];
    return norm(s);
  };
  return { a: avg(inA), b: avg(inB), nA: inA.length, nB: inB.length };
}
const axN = irisAxis(spN), axP = irisAxis(spP);
console.log(`-X 侧 虹膜轴：A组 ${axN.nA} 个 → ${axN.a ? axN.a.map(x => x.toFixed(4)).join(',') : '无'}`);
console.log(`+X 侧 虹膜轴：A组 ${axP.nA} 个 → ${axP.a ? axP.a.map(x => x.toFixed(4)).join(',') : '无'}`);

// ★ 用「实测」的虹膜轴（来自渲染页，更可靠）作为兜底校验
//   tools/mheye-where.mjs 实测：EyeL(+X侧) (0.048,-0.359,0.932)
//                               EyeR(-X侧) (0.290,-0.146,0.946)
//   这里优先用离线算出来的轴；两者应当接近。
const AXIS_P = axP.a || [0.048, -0.359, 0.932];
const AXIS_N = axN.a || [0.290, -0.146, 0.946];

// 把轴 a 转到 +Z 的旋转矩阵（Rodrigues，最小旋转）
function rotToZ(a) {
  const f = norm(a);
  const z = [0, 0, 1];
  const c = dot(f, z);
  if (c > 0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -0.999999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];   // 180°
  const k = norm(cross(f, z));          // 旋转轴
  const ang = Math.acos(Math.max(-1, Math.min(1, c)));
  const s = Math.sin(ang), C = 1 - Math.cos(ang);
  const [x, y, zz] = k;
  return [
    C * x * x + Math.cos(ang), C * x * y - s * zz, C * x * zz + s * y,
    C * x * y + s * zz, C * y * y + Math.cos(ang), C * y * zz - s * x,
    C * x * zz - s * y, C * y * zz + s * x, C * zz * zz + Math.cos(ang),
  ];
}
const applyR = (R, v) => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];

// ------------------------------------------------------------ 贴图素材
const texSrc = decodePNG(fs.readFileSync(path.join(SRC, 'eyes/materials/brown_eye.png')));

// ★★★ 采样半径的真相（本轮最关键的测量，tools/mheye-clean.mjs）
//
//   之前我用 MAT.R = 0.33 UV 采样，注释里写"可以完全避开右下角的阴影贴片"。
//   **这是错的。** 实际量出来的结果：
//     · 从虹膜 B 中心往外射线扫描，干净半径的**最小值只有 67px = 0.065 UV**
//       （在 120° 方向，也就是朝左上 —— 那里正是兄弟球 A 的边缘）
//     · P05 = 96px = 0.094 UV
//     · 而 0.33 UV = 338px，超标 3.5 倍
//   后果：眼球外侧采到了兄弟球 A 的灰蓝色区域 → 截图里眼白有大片灰蓝色块。
//
//   另一条更重要的发现：
//     · 虹膜外缘半径 ≈ 0.108 UV（111px）
//     · 干净半径 P05 ≈ 0.094 UV（96px）
//   **虹膜比干净区域还大** —— 也就是说这颗素材球**根本没有眼白**，
//   它就是一个"虹膜贴片"，虹膜几乎顶到球的透明边界。
//   所以眼白必须**由程序生成**，不能指望从素材里采。
//
//   → 结论：采样半径取 MAT_R = 0.13 UV（略大于虹膜外缘 0.108），
//     这样只把"虹膜 + 极窄一圈边缘"采进来，剩下的全部程序化生成。
const MAT = { u: IRIS_B[0], v: IRIS_B[1], R: 0.115 };
console.log(`\n使用素材球 B：虹膜中心 (${MAT.u.toFixed(4)}, ${MAT.v.toFixed(4)}) 采样半径 ${MAT.R} UV（= ${(MAT.R * 1024).toFixed(0)}px）`);

// ★★★ 素材球的真实结构（tools/mheye-irisprof.mjs 逐半径剖面实测）
//
//   半径区间            内容                     平均 RGB
//   0.000 ~ 0.039 UV    纯黑瞳孔                  (0, 0, 0)
//   0.039 ~ 0.109 UV    暗棕虹膜（很窄）           (70, 15, 3)
//   0.109 ~ 0.117 UV    过渡带                    (100, 87, 83)
//   0.117 UV 以外       浅灰白 —— **这是透明区**   (168,165,161)
//
//   两条重要结论：
//     1) 虹膜外缘 = **0.109 UV**（112px），不是 0.108 —— 也就是整颗"暗色眼"
//        从瞳孔到虹膜边缘一共 0.109 UV，外面**直接就是透明边界**。
//        这颗素材球**完全没有眼白**。
//     2) 之前看到的"灰蓝色块"是 alpha 边缘的浅灰(168,165,161)
//        被当成有效像素混进来了 —— 因为它的 alpha 恰好还在 200 以上。
//
//   → 采样域收到 0.115 UV（刚好包住 0.109 的虹膜外缘 + 一点点过渡），
//     之外**全部程序化眼白**。这样素材只贡献"瞳孔 + 虹膜"，
//     眼白、湿润感、眼睑阴影都由程序生成，不会被素材的瑕疵污染。

// ★ 虹膜在眼球上的张角（决定"眼睛像不像人"）
//   真人：眼球半径 12mm，虹膜半径 5.85mm → 虹膜/眼球 = 0.4875
//         → 虹膜边缘对应球面角 θ = asin(0.4875) ≈ 29.2°
//   二次元风格：虹膜更大更好看，常用 0.55~0.62 倍眼球半径
//         → θ = asin(0.60) ≈ 36.9°
//   这里取 IRIS_RATIO = 0.58（略大于真人，接近二次元），可用 --iris 调。
const IRIS_RATIO = Number(argVal('iris', 0.58));
const TH_IRIS = Math.asin(Math.min(0.95, IRIS_RATIO));      // 虹膜边缘的球面角（弧度）
// 等距方位投影下 θ 线性映到 UV 半径：θ=π/2 → r=0.5
const R_IRIS_UV = (TH_IRIS / (Math.PI / 2)) * 0.5;
// 采样素材时的映射比例：素材虹膜外缘 0.109 UV 要铺满目标 UV 半径 R_IRIS_UV
const MAT_IRIS_UV = 0.109;
const TEX_SCALE = R_IRIS_UV / MAT_IRIS_UV;
console.log(`虹膜：占眼球半径 ${IRIS_RATIO} → 球面角 ${(TH_IRIS * 180 / Math.PI).toFixed(1)}° → UV 半径 ${R_IRIS_UV.toFixed(4)}`);
console.log(`      素材映射放大 ${TEX_SCALE.toFixed(3)}×（素材虹膜 ${MAT_IRIS_UV} UV → ${R_IRIS_UV.toFixed(4)} UV）`);
console.log(`      素材内部分布：瞳孔 0~0.039 UV → 放大后 0~${(0.039 * TEX_SCALE).toFixed(4)} UV（占虹膜 ${(0.039 / MAT_IRIS_UV * 100).toFixed(0)}%）`);

// ★ 眼白：程序生成（素材里没有）
//   真人眼白不是纯白，而是带一点点蓝/灰的湿润感，且靠近眼角处偏红（血管）。
//   这里用：基色 + 沿 y 的轻微渐变 + 靠近边缘的暖色，避免"死白"塑料感。
const EYE_WHITE = [0.945, 0.918, 0.890];
function scleraAt(x, y, r) {
  // x,y ∈ 单位圆盘；r = 半径（0..1，1 = UV 半径 0.5 处）
  // 上眼睑遮挡处（y>0）略暗，下眼睑（y<0）略暗 → 模拟眼睑投影
  const lid = 1.0 - 0.12 * Math.max(0, y) - 0.07 * Math.max(0, -y);
  // 靠近眼角（|x| 大）略偏红，模拟血管
  const red = 0.045 * Math.pow(Math.abs(x), 3);
  const base = EYE_WHITE.map((c) => c * lid * 255);
  base[0] = Math.min(255, base[0] * (1 + red) + 255 * red * 0.4);
  base[1] *= (1 - red * 0.5);
  base[2] *= (1 - red * 0.7);
  return base.map((c) => Math.round(Math.max(0, Math.min(255, c))));
}

// ★ 圆形采样域
//   前面 UV 用"等距方位投影"铺满 [0,1] 方形，结果眼球外侧露出一圈方形贴图边缘
//   （因为球面后半球被压到 UV 边界，采样到的是方形角落）。
//   改成**圆形域**：UV 平面里半径 0.5 的圆内 = 眼球前半球 + 赤道，
//   圆外统一填眼白。这样：
//     · 赤道一圈 UV 连续，无接缝
//     · 圆外是纯眼白，即使后半球顶点采样到这里也不会露出怪东西
//   θ→半径的映射仍用等距方位，但把 θ=π/2（赤道）映到半径 0.5 的圆周上。
function sampleMat(x, y) {
  // x,y ∈ [-1,1]：单位圆盘坐标（x 右, y 上）；半径 1 对应 UV 半径 0.5
  const r = Math.hypot(x, y);
  const rNorm = r * 0.5;                       // 归一化到 UV 半径尺度（0..0.5）
  const white = scleraAt(x, y, r);

  // ★ 虹膜外：**完全不采素材**，直接用程序眼白。
  //   为什么不采？因为素材球外面紧挨着就是透明边界，
  //   边缘一圈像素是 (168,165,161) 的浅灰（alpha 仍 >200，会被当有效像素），
  //   采进来就是之前截图里的"灰蓝色块"。硬切最干净。
  if (rNorm >= R_IRIS_UV) return white;

  // 虹膜内：把眼球半径 rNorm 映射到素材半径，然后采样
  const rr = rNorm / TEX_SCALE;                // → 素材 UV 空间半径
  const u = MAT.u + (r > 1e-9 ? (x / r) * rr : 0);
  const v = MAT.v - (r > 1e-9 ? (y / r) * rr : 0);
  const { w: W, h: H, ch, data } = texSrc;
  const fx = u * W - 0.5, fy = v * H - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  x0 = Math.min(W - 1, Math.max(0, x0)); x1 = Math.min(W - 1, Math.max(0, x1));
  y0 = Math.min(H - 1, Math.max(0, y0)); y1 = Math.min(H - 1, Math.max(0, y1));
  const ix = (a, b) => (b * W + a) * ch;
  const o = ix(x0, y0), p = ix(x1, y0), q = ix(x0, y1), rr2 = ix(x1, y1);
  const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  const al = [data[o + 3], data[p + 3], data[q + 3], data[rr2 + 3]];
  const ws = al[0] * w[0] + al[1] * w[1] + al[2] * w[2] + al[3] * w[3];
  const alpha = ws / 255;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const val = data[o + k] * al[0] * w[0] + data[p + k] * al[1] * w[1] + data[q + k] * al[2] * w[2] + data[rr2 + k] * al[3] * w[3];
    const mat = ws > 1e-6 ? val / ws : 0;
    // 素材内有透明像素 → 混到程序眼白（保持圆心处不透明）
    out[k] = Math.round(mat * alpha + white[k] * (1 - alpha));
  }

  // ★ 虹膜外缘柔化：最后 12% 半径做 smoothstep 过渡到眼白，
  //   避免"贴纸感"的硬圆边。同时给虹膜边缘压一圈极暗的角膜环，
  //   让眼球看起来是个球而不是平面圆片。
  const eIn = R_IRIS_UV * 0.88;
  if (rNorm > eIn) {
    let k = (rNorm - eIn) / (R_IRIS_UV - eIn);      // 0..1
    k = Math.max(0, Math.min(1, k));
    const s = k * k * (3 - 2 * k);
    for (let i = 0; i < 3; i++) out[i] = Math.round(out[i] * (1 - s) + white[i] * s);
  }
  return out;
}

// ★ 虹膜大小（决定"眼睛看起来像不像人"）
//   素材球实测（tools/mheye-radii.mjs）：
//     · 素材球视觉半径 0.313 UV（半径 320px / 1024）
//     · 虹膜外缘半径 0.108 UV
//     · 瞳孔半径    0.111 UV  ← 和虹膜几乎一样大！这是"装饰性"素材球
//   也就是说这张素材的虹膜/瞳孔比例**严重失真**（真人 瞳孔/虹膜 ≈ 0.34）。
//   直接按素材比例画出来会变成"针尖瞳孔"（上一轮渲染就是这样）。
//
//   这里改成**按真人比例重建**，而不是照抄素材：
//     · 采样窗半径 MAT.R=0.33 UV → 素材在窗外是透明的，会被补成眼白
//     · 眼球在 UV 里占据半径 0.5 的圆盘（赤道在半径 0.5 处）
//     · 想让虹膜覆盖眼球正面多少？真人眼球半径 12mm、虹膜半径 5.85mm
//       → 虹膜占眼球半径的 0.4875，对应球面角 θ_iris = asin(0.4875) ≈ 29.2°
//     · 等距方位投影下 θ 线性映到半径 → 虹膜在 UV 里的半径 =
//         0.5 * (29.2° / 90°) = 0.162
//   但素材球本身的虹膜半径 0.108 UV 对应在采样窗里的比例是 0.108/0.33 = 0.327，
//   也就是素材虹膜会占 UV 半径 0.5*0.327 = 0.164 —— 恰好≈0.162！
//   所以在 MAT.R=0.33 下，素材的虹膜大小**天然就是真人比例**，
//   真正的问题是"瞳孔太小"（素材里瞳孔=虹膜，但被暗环压得看不清）。
//   → 处理：不缩放几何，而是在贴图上**把瞳孔画大一点**，并让虹膜外缘更清晰。
//   ⚠️ 以上这段是**已被推翻的旧推理**（MAT.R 后来改成 0.13，映射也改成 TEX_SCALE），
//      保留只为说明"为什么一度认为 0.33 是安全的"。实际尺寸由 R_IRIS_UV 决定。
const IRIS_T = R_IRIS_UV / 0.5;   // 虹膜占 UV 半径的比例，用于日志

const sides = [
  { sign: -1, name: 'EyeNegX', gaze: GAZE_R, sp: spN },
  { sign: +1, name: 'EyePosX', gaze: GAZE_L, sp: spP },
];

// ★ 瞳距修正
//   ⚠️ 上一版这里出过单位错误：把 0.409 误读成需要放大 1.124 倍。
//   现在结论：骨骼 eye.L/eye.R 的 X 坐标（±0.0314）**本身就是解剖学正确位置**
//   （它来自 MakeHuman 的 joint-eye，是照着真人比例放的），所以默认 kSep = 1.0。
//   保留参数只为以后调风格用。

for (const s of sides) {
  const sp = s.sp;
  const R = rotToZ(s.gaze);                    // ← 把注视轴转到 +Z
  const sc = (TARGET_EYE_R_M / S) / sp.r;
  // 球心：**统一用身体 GLB 坐标（米）**，不再混源坐标
  //   X/Y 取骨骼实测值（乘 kSep 供风格微调）
  //   Z 取「脸部前轮廓 − 半径 × DEPTH_SINK」（见上面推导）
  const bone = s.sign > 0 ? BASE_EYE.L : BASE_EYE.R;
  const ctr = [bone[0] * kSep, bone[1], EYE_CZ_M];
  s.ctr = ctr;
  const vset = new Set(sp.vs);
  const P = [], U = [], I = [];
  const remap = new Map();
  for (let t = 0; t < gEye.tris.length; t++) {
    const vi = gEye.tris[t];
    if (!vset.has(vi)) continue;
    let ni = remap.get(vi);
    if (ni === undefined) {
      ni = P.length / 3;
      remap.set(vi, ni);
      const lv = sub(eyeObj.V[vi], sp.c);
      const rv = applyR(R, lv);                 // ← 旋转到「注视方向 = +Z」
      P.push(ctr[0] + rv[0] * sc * S, ctr[1] + rv[1] * sc * S, ctr[2] + rv[2] * sc * S);
      // 解析式 UV：等距方位投影，映到**半径 0.5 的圆盘**（圆外不可见）
      //   θ=0 → 圆心 (0.5,0.5)；θ=π/2（赤道）→ 半径 0.5 的圆周
      //   后半球 θ∈(π/2,π] 全部夹到圆周上（被后半球自身覆盖，看不见）
      const d = norm(rv);
      const th = Math.acos(Math.max(-1, Math.min(1, d[2])));
      const phi = Math.atan2(d[1], d[0]);
      const rr = Math.min(th / (Math.PI / 2), 1.0) * 0.5;
      U.push(0.5 + rr * Math.cos(phi), 0.5 - rr * Math.sin(phi));
    }
    I.push(ni);
  }
  s.P = P; s.U = U; s.I = I; s.sc = sc; s.R = R;
  let u0 = 9, u1 = -9, v0 = 9, v1 = -9;
  for (let i = 0; i < U.length; i += 2) {
    u0 = Math.min(u0, U[i]); u1 = Math.max(u1, U[i]);
    v0 = Math.min(v0, U[i + 1]); v1 = Math.max(v1, U[i + 1]);
  }
  let x0 = 9, x1 = -9;
  for (let i = 0; i < P.length; i += 3) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); }
  console.log(`${s.name}: ${P.length / 3} 顶点 / ${I.length / 3} 面  UV u ${u0.toFixed(3)}..${u1.toFixed(3)} v ${v0.toFixed(3)}..${v1.toFixed(3)}  X ${x0.toFixed(4)}..${x1.toFixed(4)}`);
}

// 贴图：两张眼睛共用同一颗素材球，所以只需要一张贴图（但 GLB 里各自引用更省事）
// 采样域是「单位圆盘」，正好等于 UV 的 [0,1] 方形内切圆。
const rgb = Buffer.alloc(TEX_N * TEX_N * 3);
for (let j = 0; j < TEX_N; j++) for (let i = 0; i < TEX_N; i++) {
  const x = (i + 0.5) / TEX_N * 2 - 1;      // -1..1
  const y = 1 - (j + 0.5) / TEX_N * 2;      // +1..-1（图片上方 = 球面上方）
  const c = sampleMat(x, y);
  const d = (j * TEX_N + i) * 3;
  rgb[d] = c[0]; rgb[d + 1] = c[1]; rgb[d + 2] = c[2];
}
const texBuf = encodePNG(TEX_N, TEX_N, rgb);
fs.writeFileSync('C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/_eye4_mat.png', texBuf);
console.log(`\n眼睛贴图 ${TEX_N}×${TEX_N}  ${(texBuf.length / 1024).toFixed(0)}KB → _eye4_mat.png`);
const irisPx = IRIS_T * TEX_N / 2;
console.log(`  虹膜半径 ≈ ${irisPx.toFixed(0)}px（直径 ${(irisPx * 2).toFixed(0)}px / ${TEX_N}px）`);

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
{
  images.push({ bufferView: BV.pushRaw(texBuf), mimeType: 'image/png', name: 'EyeTex' });
  textures.push({ sampler: 0, source: 0 });
  materials.push({
    name: 'EyeMat',
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.14, baseColorTexture: { index: 0 } },
    doubleSided: false,
  });
  for (const s of sides) {
    const aPos = addAcc({ componentType: 5126, count: s.P.length / 3, type: 'VEC3', bufferView: BV.push(new Float32Array(s.P), 34962), ...minMax(s.P, 3) });
    const aUv = addAcc({ componentType: 5126, count: s.U.length / 2, type: 'VEC2', bufferView: BV.push(new Float32Array(s.U), 34962), ...minMax(s.U, 2) });
    const aIdx = addAcc({ componentType: 5125, count: s.I.length, type: 'SCALAR', bufferView: BV.push(new Uint32Array(s.I), 34963), ...minMax(s.I, 1) });
    meshes.push({ name: s.name, primitives: [{ attributes: { POSITION: aPos, TEXCOORD_0: aUv }, indices: aIdx, material: 0 }] });
    nodes.push({ name: s.name + '_node', mesh: meshes.length - 1 });
    nodes[0].children.push(nodes.length - 1);
  }
}
const json = {
  asset: { version: '2.0', generator: 'mheye-final.mjs (MakeHuman CC0 eyes; gaze-axis aligned + analytic UV)' },
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
console.log(`写出 ${OUT} (${(out.length / 1024).toFixed(0)}KB)`);
{
  const xs = sides.flatMap((s) => Array.from({ length: s.P.length / 3 }, (_, i) => s.P[i * 3]));
  xs.sort((a, b) => a - b);
  console.log(`X 范围 ${xs[0].toFixed(4)} .. ${xs[xs.length - 1].toFixed(4)} 米（期望 ±0.041）`);
}

// ===========================================================================
// 坑列表（每一条都是花过代价的，别删）
//   1. brown_eye.png 是 RGBA + 透明背景。用"深色像素聚类"找瞳孔会被透明区污染。
//      → 一切分析必须先看 alpha，或先在浅色背景上合成。
//   2. 这张高模不在 [0,1] UV 空间（左球 u 0.42..0.99，右球 0.036..0.99），
//      且两颗球**共用同一套 UV**、UV 空间重叠。任何"按 UV 区域切分左右眼"的做法
//      都会失败。
//   3. 源网格的正极点 UV ≈ (0.706,0.707) / (0.293,0.305)，v 和贴图虹膜中心对得上，
//      但 u 差 0.42 —— 这就是坑 2 的表现，不是"读反了 v"。
//   4. 源网格的虹膜朝向**不是 +Z**（实测偏 (0.048,-0.359,0.932) / (0.290,-0.146,0.946)）。
//      不修正几何、只调 UV，永远会偏。
//   5. eyeL 骨骼在 +X 侧、eyeR 在 -X 侧（和命名直觉相反）。别靠名字绑骨骼，
//      要靠几何 X 符号。
//   6. Mesh.name 在 three.js 里取的是 glTF 的 **node 名**（EyeL_node），
//      不是 meshes[].name（EyeL）。两边都要匹配。
//   7. UV 去重键：源 UV 有接缝，按顶点去重会抹平接缝 → 开裂。但本文件 UV 是
//      位置的解析函数、无接缝，所以**必须按顶点去重**，否则重复顶点会撕裂球面。

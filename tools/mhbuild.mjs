// MakeHuman (CC0) -> 带 morph 的 rigged GLB
// ===========================================================================
// 捏人系统的地基：把 MakeHuman 的参数化人体搬进浏览器。
//
// 授权：makehuman/data/LICENSE.ASSETS.md 原文即 CC0 1.0，官方 FAQ 明确导出模型
//       可商用、可闭源、无需署名。default_weights.mhw 里也写着 license=CC0。
//
// 用法: node tools/mhbuild.mjs [--out <file.glb>] [--stats] [--only <name>]
// 数据被删了就重跑：
//   git clone --depth 1 https://github.com/makehumancommunity/makehuman.git <dir>
//
// ---- 五个坑（都踩过，别改回去）------------------------------------------
// 1) macrodetails/Gender|Age|Muscle|Weight **不是文件**，MakeHuman 是用一组
//    universal-<gender>-<age>-<muscle>-<weight>.target 网格插值出来的。
//    而且 averagemuscle-averageweight 那 8 个格子（男女 × 幼少青老）**全是空文件**
//    —— 那就是中性基准态。所以想取"性别差"绝不能用它当参考点，否则算出 0 条。
//    这里改成：在 8 个非中性的体型组合上分别求差再平均。
// 2) morph target 稀疏，必须按 glTF **sparse accessor** 存 —— 展开成密集是
//    230KB/条。glbsplit.mjs 当年就是漏搬 sparse 的 bufferView，three.js 报
//    "Cannot read properties of undefined (reading 'extensions')"。这里 writeGLB
//    专门保留 sparse.indices / sparse.values 两个 bufferView，且不给它自己的
//    bufferView（glTF 规范要求两者互斥）。
// 3) OBJ 的 v/vt/f 是三套独立索引，必须按 "v/vt" 去重，f 里下标不能直接用。
//    去重后一个源顶点会裂成多个 GL 顶点（不同 UV），所以 → span 必须是**一对多**，
//    只记一个的话会丢一大批蒙皮权重（实测丢 1137 个顶点，全部塌陷到原点）。
// 4) 骨骼 transform 只用 translation 表示：每个 joint 节点 = 它自己 head 关节的位置
//    减去父节点位置。这样 rest 全局矩阵就是 translate(headPos)，IBM 就是
//    translate(-headPos)，旋转时绕着正确原点转。不要试图用旋转表达骨朝向。
// 5) MakeHuman 内部单位是分米（base.obj 高约 16.946），要缩放到 1.70m。
//    morph delta 也要跟着乘同一个 S，否则滑块会把人撑爆。
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, def) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : def;
};
const SRC = arg('src', 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data');
const OUTDIR = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4';
const OUT = arg('out', OUTDIR + '/aiva-base-mh.glb');
const ONLY_STATS = process.argv.includes('--stats');
const TARGET_HEIGHT = Number(arg('h', 1.70));

const logLines = [];
const log = (s) => { logLines.push(s); console.log(s); };
const TARGETS = path.join(SRC, 'targets');

// ============================ 稀疏 target ==================================
function parseTarget(rel) {
  const p = path.join(TARGETS, rel + '.target');
  if (!fs.existsSync(p)) return null;
  const map = new Map();
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const a = line.split(/\s+/);
    if (a.length < 4) continue;
    const i = +a[0];
    if (!Number.isFinite(i) || i < 0) continue;
    const prev = map.get(i);
    const x = +a[1], y = +a[2], z = +a[3];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (prev) { prev[0] += x; prev[1] += y; prev[2] += z; }
    else map.set(i, [x, y, z]);
  }
  return map;
}
const EPS = 1e-6;
function toFlat(map) {
  const idx = [], val = [];
  const keys = [...map.keys()].sort((a, b) => a - b);
  for (const i of keys) {
    const v = map.get(i);
    if (Math.abs(v[0]) < EPS && Math.abs(v[1]) < EPS && Math.abs(v[2]) < EPS) continue;
    idx.push(i); val.push(v[0], v[1], v[2]);
  }
  return { idx, val };
}
function sub(a, b) {
  const m = new Map(a);
  for (const [i, v] of b) {
    const c = m.get(i) || [0, 0, 0];
    m.set(i, [c[0] - v[0], c[1] - v[1], c[2] - v[2]]);
  }
  return m;
}
function scale(m, s) {
  const r = new Map();
  for (const [i, v] of m) r.set(i, [v[0] * s, v[1] * s, v[2] * s]);
  return r;
}
// 把若干 target 相加（用于左右对称合并脸部滑块）
function merge(...maps) {
  const acc = new Map();
  for (const m of maps) {
    if (!m) continue;
    for (const [i, v] of m) {
      const c = acc.get(i) || [0, 0, 0];
      acc.set(i, [c[0] + v[0], c[1] + v[1], c[2] + v[2]]);
    }
  }
  return acc;
}
// 在多个体型组合上求平均差 —— 用来从 universal 网格里把性别/年龄效应单独提出来
function meanDiff(cells) {
  // cells: [[fileA, fileB], ...]  取 A-B 的平均
  let acc = new Map();
  let n = 0;
  for (const [fa, fb] of cells) {
    const a = parseTarget(fa), b = parseTarget(fb);
    if (!a || !b) continue;
    acc = merge(acc, sub(a, b));
    n++;
  }
  if (!n) return null;
  return scale(acc, 1 / n);
}

const U = 'macrodetails/universal-';
const HIGHT = 'macrodetails/height/female-young-averagemuscle-averageweight-';
const PROP = 'macrodetails/proportions/female-young-averagemuscle-averageweight-';
const BREAST = 'breast/female-young-averagemuscle-averageweight-';

// 为什么只用 maxmuscle-averageweight 这一个体型做差（而不是全 8 个求平均）：
// 实测 8 个体型一起平均会把信号互相抵消 —— 性别只剩 25mm、年龄只剩 17mm，
// 而单取 maxmuscle-averageweight 性别能到 44.7mm（胸部 -38mm、肩宽 +量大），
// 这才是 MakeHuman 里真正的性别量级。另外这套 universal 差分**几乎不含身高**
// （caucasian 那一版 male-young-female-young 有 158mm 的 Y 位移，把身高和性别
// 捆死了，不能用），身高留给 BodyHeight 单独控制。
const MUAMAW = 'maxmuscle-averageweight';
const DERIVE = {
  masculine: () => diffOf(U + 'male-young-' + MUAMAW, U + 'female-young-' + MUAMAW),
  ageChild: () => diffOf(U + 'female-child-' + MUAMAW, U + 'female-young-' + MUAMAW),
  ageOld: () => diffOf(U + 'female-old-' + MUAMAW, U + 'female-young-' + MUAMAW),
};
function diffOf(fa, fb) {
  const a = parseTarget(fa), b = parseTarget(fb);
  if (!a || !b) return null;
  return sub(a, b);
}

// ============================ 捏人滑块表 ====================================
// g=分组 n=morph 名 cn=中文标签 t=target 文件（多个即合并） d=派生 w=强度系数
const SLIDERS = [
  // ---- 体型 Body ----
  { g: 'Body', n: 'BodyHeight', cn: '身高', t: [HIGHT + 'maxheight'], w: 0.30 },
  { g: 'Body', n: 'BodyProportions', cn: '理想比例', t: [PROP + 'idealproportions'] },
  { g: 'Body', n: 'Masculine', cn: '男性化', d: 'masculine' },
  { g: 'Body', n: 'Younger', cn: '幼龄', d: 'ageChild' },
  { g: 'Body', n: 'Older', cn: '年长', d: 'ageOld' },
  { g: 'Body', n: 'Muscle', cn: '肌肉', t: [U + 'female-young-maxmuscle-averageweight'] },
  { g: 'Body', n: 'Weight', cn: '体重', t: [U + 'female-young-averagemuscle-maxweight'] },
  { g: 'Body', n: 'TorsoLength', cn: '躯干长度', t: ['torso/torso-scale-vert-incr'] },
  { g: 'Body', n: 'TorsoWidth', cn: '躯干宽度', t: ['torso/torso-scale-horiz-incr'] },
  { g: 'Body', n: 'TorsoDepth', cn: '躯干厚度', t: ['torso/torso-scale-depth-incr'] },
  { g: 'Body', n: 'TorsoVShape', cn: '倒三角', t: ['torso/torso-vshape-incr'] },
  { g: 'Body', n: 'NeckCirc', cn: '颈围', t: ['measure/measure-neck-circ-incr'] },
  { g: 'Body', n: 'ShoulderWidth', cn: '肩宽', t: ['measure/measure-shoulder-dist-incr'] },
  { g: 'Body', n: 'BustCirc', cn: '胸围', t: ['measure/measure-bust-circ-incr'] },
  { g: 'Body', n: 'WaistCirc', cn: '腰围', t: ['measure/measure-waist-circ-incr'] },
  { g: 'Body', n: 'NapeToWaist', cn: '背长', t: ['measure/measure-napetowaist-dist-incr'] },
  { g: 'Body', n: 'WaistToHip', cn: '腰臀距', t: ['measure/measure-waisttohip-dist-incr'] },
  { g: 'Body', n: 'HipsCirc', cn: '臀围', t: ['measure/measure-hips-circ-incr'] },
  { g: 'Body', n: 'HipWidth', cn: '髋宽', t: ['hip/hip-scale-horiz-incr'] },
  { g: 'Body', n: 'Stomach', cn: '腹部', t: ['stomach/stomach-tone-incr'] },
  { g: 'Body', n: 'BreastSize', cn: '胸部Size', t: [BREAST + 'maxcup-averagefirmness'] },
  { g: 'Body', n: 'BreastFirmness', cn: '胸部挺度', t: [BREAST + 'averagecup-maxfirmness'] },
  { g: 'Body', n: 'Buttocks', cn: '臀部', t: ['buttocks/buttocks-volume-incr'] },
  { g: 'Body', n: 'ThighCirc', cn: '大腿围', t: ['measure/measure-thigh-circ-incr'] },
  { g: 'Body', n: 'CalfCirc', cn: '小腿围', t: ['measure/measure-calf-circ-incr'] },
  { g: 'Body', n: 'ArmMuscle', cn: '上臂肌肉', t: ['armslegs/l-upperarm-muscle-incr', 'armslegs/r-upperarm-muscle-incr'] },
  { g: 'Body', n: 'LegLength', cn: '腿长', t: ['armslegs/upperlegs-height-incr'] },
  { g: 'Body', n: 'FootSize', cn: '脚掌', t: ['armslegs/l-foot-scale-incr', 'armslegs/r-foot-scale-incr'] },

  // ---- 面部 Face ----
  { g: 'Face', n: 'HeadOval', cn: '脸型-椭圆', t: ['head/head-oval'] },
  { g: 'Face', n: 'HeadRound', cn: '脸型-圆', t: ['head/head-round'] },
  { g: 'Face', n: 'HeadSquare', cn: '脸型-方', t: ['head/head-square'] },
  { g: 'Face', n: 'HeadWidth', cn: '头宽', t: ['head/head-scale-horiz-incr'] },
  { g: 'Face', n: 'HeadHeight', cn: '头长', t: ['head/head-scale-vert-incr'] },
  { g: 'Face', n: 'HeadDepth', cn: '头深', t: ['head/head-scale-depth-incr'] },
  { g: 'Face', n: 'ForeheadBulge', cn: '额头', t: ['forehead/forehead-trans-forward'] },
  { g: 'Face', n: 'EyebrowHeight', cn: '眉位', t: ['eyebrows/eyebrows-trans-up'] },
  { g: 'Face', n: 'EyeSize', cn: '眼睛大小', t: ['eyes/l-eye-scale-incr', 'eyes/r-eye-scale-incr'] },
  { g: 'Face', n: 'EyeHeight', cn: '眼高', t: ['eyes/l-eye-height2-incr', 'eyes/r-eye-height2-incr'] },
  { g: 'Face', n: 'EyeSpacing', cn: '眼距', t: ['eyes/l-eye-trans-out', 'eyes/r-eye-trans-out'] },
  { g: 'Face', n: 'EyeBag', cn: '卧蚕', t: ['eyes/l-eye-bag-incr', 'eyes/r-eye-bag-incr'] },
  { g: 'Face', n: 'Epicanthus', cn: '内眦', t: ['eyes/l-eye-epicanthus-out', 'eyes/r-eye-epicanthus-out'] },
  { g: 'Face', n: 'NoseWidth', cn: '鼻宽', t: ['nose/nose-scale-horiz-incr'] },
  { g: 'Face', n: 'NoseHeight', cn: '鼻长', t: ['nose/nose-scale-vert-incr'] },
  { g: 'Face', n: 'NoseBridge', cn: '鼻梁', t: ['nose/nose-septumangle-incr'] },
  { g: 'Face', n: 'NoseTipUp', cn: '鼻尖上翘', t: ['nose/nose-point-up'] },
  { g: 'Face', n: 'NostrilWidth', cn: '鼻翼', t: ['nose/nose-nostrils-width-incr'] },
  { g: 'Face', n: 'MouthWidth', cn: '嘴宽', t: ['mouth/mouth-scale-horiz-incr'] },
  { g: 'Face', n: 'MouthDepth', cn: '嘴凸', t: ['mouth/mouth-scale-depth-incr'] },
  { g: 'Face', n: 'LipVolume', cn: '唇厚', t: ['mouth/mouth-upperlip-volume-incr', 'mouth/mouth-lowerlip-volume-incr'] },
  { g: 'Face', n: 'MouthCorners', cn: '嘴角', t: ['mouth/mouth-angles-up'] },
  { g: 'Face', n: 'Dimples', cn: '酒窝', t: ['mouth/mouth-dimples-in'], w: 3 },
  { g: 'Face', n: 'ChinWidth', cn: '下颌宽', t: ['chin/chin-width-incr'] },
  { g: 'Face', n: 'ChinHeight', cn: '下巴长', t: ['chin/chin-height-incr'] },
  { g: 'Face', n: 'JawProminent', cn: '下颌角', t: ['chin/chin-prominent-incr'] },
  { g: 'Face', n: 'CheekVolume', cn: '脸颊', t: ['cheek/l-cheek-volume-incr', 'cheek/r-cheek-volume-incr'] },
  { g: 'Face', n: 'EarSize', cn: '耳大小', t: ['ears/l-ear-scale-incr', 'ears/r-ear-scale-incr'] },
  { g: 'Face', n: 'EarPointed', cn: '精灵耳', t: ['ears/l-ear-shape-pointed', 'ears/r-ear-shape-pointed'] },
  { g: 'Face', n: 'NeckLength', cn: '脖子长度', t: ['neck/neck-scale-vert-incr'] },
];

// ============================ OBJ ==========================================
function parseOBJ() {
  const txt = fs.readFileSync(path.join(SRC, '3dobjs/base.obj'), 'utf8');
  const pos = [], uv = [];
  const trisP = [], trisU = [];
  let group = null;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (line[0] === 'o' && line[1] === ' ') { group = line.slice(2).trim(); continue; }
    if (line[0] === 'g' && line[1] === ' ') { group = line.slice(2).trim(); continue; }
    if (line[0] === 'v' && line[1] === ' ') {
      const a = line.slice(2).trim().split(/\s+/);
      pos.push(+a[0], +a[1], +a[2]);
    } else if (line[0] === 'v' && line[1] === 't') {
      const a = line.slice(3).trim().split(/\s+/);
      uv.push(+a[0], +a[1]);
    } else if (line[0] === 'f' && line[1] === ' ') {
      if (group !== 'body') continue;
      const toks = line.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      for (let i = 1; i < toks.length - 1; i++) {
        for (const k of [0, i, i + 1]) {
          trisP.push(+toks[k][0]);
          trisU.push(+(toks[k][1] || 0));
        }
      }
    }
  }
  return { pos, uv, trisP, trisU };
}

// ============================ 主流程 ========================================
function main() {
  if (!fs.existsSync(SRC)) {
    log('数据目录不存在：' + SRC);
    log('先跑：git clone --depth 1 https://github.com/makehumancommunity/makehuman.git %TEMP%\\mh-src');
    return dump();
  }

  log('=== 1. 基础网格 ===');
  const { pos, uv, trisP, trisU } = parseOBJ();
  const nSrc = pos.length / 3;
  log(`base.obj: ${nSrc} 顶点 / ${uv.length / 2} UV / body 组 ${trisP.length / 3} 三角面`);

  // 按 "v/vt" 去重。srcToCompact 是**一对多**：一个源顶点可能裂成多个 GL 顶点
  const map = new Map();
  const span = Array.from({ length: nSrc }, () => null);
  const P = [], U = [];
  for (let i = 0; i < trisP.length; i++) {
    const v = trisP[i], t = trisU[i];
    const key = v + '/' + t;
    let c = map.get(key);
    if (c === undefined) {
      c = P.length / 3;
      map.set(key, c);
      P.push(pos[(v - 1) * 3], pos[(v - 1) * 3 + 1], pos[(v - 1) * 3 + 2]);
      U.push(t ? uv[(t - 1) * 2] : 0, t ? uv[(t - 1) * 2 + 1] : 0);
      if (!span[v - 1]) span[v - 1] = [];
      span[v - 1].push(c);
    }
  }
  const indices = new Uint32Array(trisP.length);
  for (let i = 0; i < trisP.length; i++) indices[i] = map.get(trisP[i] + '/' + trisU[i]);
  const N = P.length / 3;
  log(`去重后：${N} 顶点（源 ${nSrc}，裂开 ${sumLen(span) - N} 个）/ ${indices.length / 3} 面`);

  // ---- 单位缩放 ----
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < P.length; i += 3) { if (P[i] < lo) lo = P[i]; if (P[i] > hi) hi = P[i]; }
  const S = TARGET_HEIGHT / (hi - lo);
  for (let i = 0; i < P.length; i++) P[i] *= S;
  log(`高度 ${(hi - lo).toFixed(3)} -> ${TARGET_HEIGHT}m，缩放系数 ${S.toFixed(5)}`);
  // 让脚底站在 y=0：最低点缩放后落在 lo*S，整体减掉它即可。
  // 早期版本这里写成 -lo*S 再减，方向正好反了，把整个人又往下推了一个底座距离。
  const yOff = lo * S;
  for (let i = 1; i < P.length; i += 3) P[i] -= yOff;
  log(`底面已归零（原最低点 ${(lo * S).toFixed(3)}m，已整体上移 ${(-yOff).toFixed(3)}m）`);

  // ---- 法线 ----
  const Nrm = new Float32Array(N * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const o of [a, b, c]) { Nrm[o] += nx; Nrm[o + 1] += ny; Nrm[o + 2] += nz; }
  }
  for (let i = 0; i < N; i++) {
    const x = Nrm[i * 3], y = Nrm[i * 3 + 1], z = Nrm[i * 3 + 2];
    const L = Math.hypot(x, y, z) || 1;
    Nrm[i * 3] = x / L; Nrm[i * 3 + 1] = y / L; Nrm[i * 3 + 2] = z / L;
  }

  log('\n=== 2. 骨骼与蒙皮 ===');
  const skel = JSON.parse(fs.readFileSync(path.join(SRC, 'rigs/default.mhskel'), 'utf8'));
  const wJson = JSON.parse(fs.readFileSync(path.join(SRC, 'rigs/default_weights.mhw'), 'utf8'));
  const bDefs = skel.bones || {}, jDefs = skel.joints || {};
  log(`mhskel: ${Object.keys(bDefs).length} 骨 / ${Object.keys(jDefs).length} 关节；weights license=${wJson.license}`);

  // 关节坐标 = 它那组顶点的质心（MakeHuman 就是这么定位骨架的）
  const jointPos = new Map();
  for (const [jname, vlist] of Object.entries(jDefs)) {
    let x = 0, y = 0, z = 0;
    let n = 0;
    for (const vi of vlist) {
      if (vi >= nSrc) continue;
      x += pos[vi * 3]; y += pos[vi * 3 + 1]; z += pos[vi * 3 + 2]; n++;
    }
    if (!n) continue;
    // 注意：jointPos 也要跟着缩放 + 归零，跟 P 保持一致
    jointPos.set(jname, [x / n * S, y / n * S - yOff, z / n * S]);
  }
  let noJoint = 0;
  for (const b of Object.values(bDefs)) { if (!jointPos.has(b.head) || !jointPos.has(b.tail)) noJoint++; }
  log(`关节坐标 ${jointPos.size} 个；骨骼缺少 head/tail 坐标的 ${noJoint} 根`);

  // ---- 蒙皮：先全收，再取 top4 ----
  const infl = Array.from({ length: N }, () => []);
  let droppedSrc = 0;
  for (const [bone, list] of Object.entries(wJson.weights || {})) {
    if (!bDefs[bone]) continue;
    for (const [vi, w] of list) {
      const cs = vi < nSrc ? span[vi] : null;
      if (!cs) { droppedSrc++; continue; }      // 该顶点属于 helper/joint 辅助几何
      if (!(w > 1e-4)) continue;
      for (const c of cs) infl[c].push([bone, w]);
    }
  }
  // JOINTS 先按骨骼名收集，等骨骼顺序定下来后再换成序号
  // （Uint16Array 存不了字符串，早期版本把名字直接塞进去导致全部变成 0 号骨）
  const WEIGHTS = new Float32Array(N * 4);
  const jName = new Array(N * 4).fill(null);
  let noWeight = 0;
  for (let i = 0; i < N; i++) {
    const list = infl[i].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, w] of list) sum += w;
    if (sum <= 0) { noWeight++; continue; }
    for (let k = 0; k < list.length; k++) {
      jName[i * 4 + k] = list[k][0];
      WEIGHTS[i * 4 + k] = list[k][1] / sum;
    }
  }
  log(`带权重顶点 ${N - noWeight}/${N}；辅助几何丢弃 ${droppedSrc} 条；无权重 ${noWeight}`);

  log('\n=== 3. Morph 目标 ===');
  const morphs = [];
  let totalBytes = 0;
  for (const s of SLIDERS) {
    let raw = null;
    if (s.t) {
      const maps = s.t.map((f) => parseTarget(f));
      if (maps.some((m) => !m)) {
        log(`  [缺] ${s.n}: ${[...s.t.keys()].filter((i) => !maps[i]).map((i) => s.t[i]).join(', ')}`);
        continue;
      }
      raw = merge(...maps);
    } else if (s.d) {
      raw = DERIVE[s.d]();
      if (!raw) { log(`  [派生失败] ${s.n}`); continue; }
    }
    if (s.w) raw = scale(raw, s.w);
    // 源顶点下标 -> 紧凑下标（一对多展开）
    const out = new Map();
    let missed = 0;
    for (const [vi, v] of raw) {
      const cs = vi < nSrc ? span[vi] : null;
      if (!cs) { missed++; continue; }
      for (const c of cs) out.set(c, [v[0] * S, v[1] * S, v[2] * S]);
    }
    const { idx, val } = toFlat(out);
    if (!idx.length) { log(`  [空] ${s.n}`); continue; }
    const bytes = idx.length * 2 + val.length * 4;
    totalBytes += bytes;
    morphs.push({ name: s.n, cn: s.cn, group: s.g, idx, val, missed });
    log(`  ${s.n.padEnd(18)} ${String(idx.length).padStart(6)} 顶点  ${(bytes / 1024).toFixed(0)}KB  ${s.cn}`);
  }
  log(`合计 ${morphs.length} 条 morph，sparse 数据 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  if (ONLY_STATS) { log('\n（--stats 到此为止）'); return dump(); }

  log('\n=== 4. 写 GLB ===');
  writeGLB({ P, U, Nrm, indices, jName, WEIGHTS, bDefs, jointPos, morphs, boneNames: Object.keys(bDefs) });
  return dump();

  function sumLen(sp) { let n = 0; for (const a of sp) if (a) n += a.length; return n; }
  function dump() {
    fs.writeFileSync('C:/Users/Simon Lai/AppData/Local/Temp/_mhbuild.txt', logLines.join('\n'), 'utf8');
  }
}

// ============================ GLB 写出 =====================================
function writeGLB({ P, U, Nrm, indices, jName, WEIGHTS, bDefs, jointPos, morphs, boneNames }) {
  const N = P.length / 3;
  const chunks = [];
  const bv = [];
  let binLen = 0;
  function pushBV(typed, target) {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; }
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    bv.push({ buffer: 0, byteOffset: binLen, byteLength: buf.byteLength, ...(target ? { target } : {}) });
    chunks.push(buf);
    binLen += buf.byteLength;
    return bv.length - 1;
  }
  const acc = [];
  const addAcc = (d) => { acc.push(d); return acc.length - 1; };

  const f32 = (a) => new Float32Array(a);
  const minMax = (arr, comp) => {
    const mn = new Array(comp).fill(Infinity), mx = new Array(comp).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) {
      const c = i % comp;
      if (arr[i] < mn[c]) mn[c] = arr[i];
      if (arr[i] > mx[c]) mx[c] = arr[i];
    }
    return [mn, mx];
  };

  // ---- 蒙皮：骨骼名单 -> 序号 ----
  // 必须按深度优先拓扑序排，保证父骨下标一定小于子骨（three.js Skeleton 不强制，
  // 但导出到别的工具 / 手写蒙皮 CPU 混合时都会假定这个顺序；而且 bones[0] 才是根骨）
  const allBones = boneNames.filter((b) => jointPos.has(bDefs[b].head));
  const seen = new Set();
  const jointOrder = [];
  const visit = (b, depth) => {
    if (seen.has(b) || !bDefs[b] || depth > 64) return;
    seen.add(b); jointOrder.push(b);
    for (const c of allBones) if (bDefs[c].parent === b) visit(c, depth + 1);
  };
  visit(allBones.find((b) => !bDefs[b].parent) || allBones[0], 0);
  for (const b of allBones) if (!seen.has(b)) jointOrder.push(b);   // 环/孤儿兜底
  const jointIndex = new Map(jointOrder.map((b, i) => [b, i]));
  const JOINTS = new Uint16Array(N * 4);
  let orphanRef = 0;
  for (let i = 0; i < N * 4; i++) {
    const name = jName[i];
    if (name === null) continue;
    const fi = jointIndex.get(name);
    if (fi === undefined) { orphanRef++; continue; }
    JOINTS[i] = fi;
  }

  const aPos = addAcc({ componentType: 5126, count: N, type: 'VEC3', bufferView: pushBV(f32(P), 34962), ...(() => { const [a, b] = minMax(P, 3); return { min: a, max: b }; })() });
  const aNrm = addAcc({ componentType: 5126, count: N, type: 'VEC3', bufferView: pushBV(Nrm, 34962) });
  const aUv = addAcc({ componentType: 5126, count: N, type: 'VEC2', bufferView: pushBV(f32(U), 34962) });
  const aJo = addAcc({ componentType: 5123, count: N, type: 'VEC4', bufferView: pushBV(JOINTS, 34962) });
  const aWe = addAcc({ componentType: 5126, count: N, type: 'VEC4', bufferView: pushBV(WEIGHTS, 34962) });
  const aIdx = addAcc({ componentType: 5125, count: indices.length, type: 'SCALAR', bufferView: pushBV(indices, 34963) });

  const IBM = new Float32Array(jointOrder.length * 16);
  for (let i = 0; i < jointOrder.length; i++) {
    const p = jointPos.get(bDefs[jointOrder[i]].head);
    const o = i * 16;
    IBM[o] = 1; IBM[o + 5] = 1; IBM[o + 10] = 1; IBM[o + 15] = 1;
    IBM[o + 12] = -p[0]; IBM[o + 13] = -p[1]; IBM[o + 14] = -p[2];
  }
  const aIBM = addAcc({ componentType: 5126, count: jointOrder.length, type: 'MAT4', bufferView: pushBV(IBM) });
  log(`蒙皮：${jointOrder.length} 骨参与，孤儿引用 ${orphanRef} 条（已归到根骨）`);

  // ---- morphs（glTF sparse） ----
  const targets = [];
  const sliderMeta = [];
  morphs.forEach((m, mi) => {
    const iIdx = pushBV(new Uint16Array(m.idx));           // 不设 target
    const iVal = pushBV(f32(m.val));
    // sparse accessor 的 min/max 要把"未提及的顶点=0"算进去
    const mn = [0, 0, 0], mx = [0, 0, 0];
    for (let i = 0; i < m.val.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        if (m.val[i + c] < mn[c]) mn[c] = m.val[i + c];
        if (m.val[i + c] > mx[c]) mx[c] = m.val[i + c];
      }
    }
    const ai = addAcc({
      componentType: 5126, count: N, type: 'VEC3',
      min: mn, max: mx,
      sparse: {
        count: m.idx.length,
        indices: { bufferView: iIdx, componentType: 5123 },
        values: { bufferView: iVal },
      },
    });
    targets.push({ POSITION: ai });
    sliderMeta.push({ i: mi, name: m.name, cn: m.cn, group: m.group });
  });

  // ---- nodes ----
  const nodes = [];
  const meshNode = nodes.length;
  nodes.push({ name: 'AIVA_Body', mesh: 0, skin: 0 });
  const jRoot = nodes.length;
  nodes.push({ name: 'Armature' });
  const jointNodeStart = nodes.length;
  for (const b of jointOrder) {
    const parent = bDefs[b].parent;
    const hp = jointPos.get(bDefs[b].head);
    const pp = parent && bDefs[parent] && jointPos.has(bDefs[parent].head) ? jointPos.get(bDefs[parent].head) : [0, 0, 0];
    nodes.push({ name: b, translation: [hp[0] - pp[0], hp[1] - pp[1], hp[2] - pp[2]] });
  }
  // 挂父子关系
  const roots = [];
  jointOrder.forEach((b, i) => {
    const ni = jointNodeStart + i;
    const parent = bDefs[b].parent;
    const pi = parent && jointIndex.has(parent) ? jointNodeStart + jointIndex.get(parent) : null;
    if (pi === null) roots.push(ni);
    else (nodes[pi].children || (nodes[pi].children = [])).push(ni);
  });
  nodes[jRoot].children = roots;
  const jointNodes = jointOrder.map((_, i) => jointNodeStart + i);
  // skeleton 必须是"根骨"那根，取第一根没有 parent 的；找不到就用第 0 根
  const rootBone = jointOrder.find((b) => !bDefs[b].parent) || jointOrder[0];
  log(`根节点：${rootBone}（共 ${roots.length} 棵子树）`);

  const gltf = {
    asset: { version: '2.0', generator: 'mhbuild.mjs (MakeHuman CC0 -> GLB)', copyright: 'MakeHuman assets CC0 1.0' },
    scene: 0,
    scenes: [{ nodes: [jRoot, meshNode] }],
    nodes,
    skins: [{
      joints: jointNodes,
      skeleton: jointNodeStart + (jointIndex.get(rootBone) ?? 0),
      inverseBindMatrices: aIBM,
    }],
    meshes: [{
      name: 'AIVA_Body',
      extras: { sliders: sliderMeta },
      primitives: [{
        attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv, JOINTS_0: aJo, WEIGHTS_0: aWe },
        indices: aIdx,
        material: 0,
        targets,
      }],
    }],
    materials: [{
      name: 'Skin',
      pbrMetallicRoughness: { baseColorFactor: [0.909, 0.764, 0.702, 1], metallicFactor: 0, roughnessFactor: 0.55 },
      doubleSided: false,
    }],
    accessors: acc,
    bufferViews: bv,
    buffers: [{ byteLength: 0 }],
  };
  gltf.meshes[0].extras.targetNames = morphs.map((m) => m.name);

  const bin = Buffer.concat(chunks);
  gltf.buffers[0].byteLength = bin.length;

  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
  const binChunk = Buffer.concat([bin, binPad]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  header.writeUInt32LE(total, 8);

  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.write('JSON', 4, 'ascii');
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunk.length, 0);
  binHead.write('BIN\0', 4, 'ascii');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk]));
  log(`已写出 ${OUT}`);
  log(`  ${N} 顶点 / ${indices.length / 3} 面 / ${jointOrder.length} 骨 / ${targets.length} morph`);
  log(`  GLB ${(total / 1024 / 1024).toFixed(2)} MB（BIN ${(bin.length / 1024 / 1024).toFixed(2)} MB，JSON ${(jsonChunk.length / 1024).toFixed(0)}KB）`);

  // 顺手写一份给 UI 用的滑块表
  const metaPath = OUT.replace(/\.glb$/, '.sliders.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    license: 'MakeHuman assets CC0 1.0 (github.com/makehumancommunity/makehuman)',
    vertexCount: N,
    triangleCount: indices.length / 3,
    boneCount: jointOrder.length,
    height: TARGET_HEIGHT,
    sliders: sliderMeta.map((s, i) => ({ key: morphs[i].name, cn: morphs[i].cn, group: morphs[i].group, index: i, min: -1, max: 1, def: 0 })),
  }, null, 2));
  log(`滑块表 -> ${metaPath}`);
}

// 被 import 时不自动跑主流程（mhproxy.mjs 要复用 parseOBJ / parseTarget / SLIDERS）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/tools/mhbuild.mjs')) main();

export { SRC, TARGET_HEIGHT, SLIDERS, DERIVE, parseOBJ, parseTarget, merge, scale, sub };

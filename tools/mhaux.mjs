// mhaux.mjs —— 把 MakeHuman 的辅助部件（眼球等）导出成 GLB
// ===========================================================================
// 背景（踩坑记录，别删）：
//   base.obj 里 body 组只有 13380 个顶点（全局 v 索引 0~13379），**眼窝是空的**
//   —— 没有眼球、没有牙齿、没有舌头。渲染出来的"黑眼睛"其实是眼眶阴影。
//   这是模型看起来像尸体的最大原因。
//
//   真正的这些部件在同文件的 helper-* 段里，引用的是全局 v 列表里 13380 之后
//   的那批顶点：
//     body               v[0..13379]        Y -8.17~8.49    ← 全局坐标（-8.17=脚底）
//     helper-tongue      v[13380..13605]    舌头
//     helper-l-eye       v[14598..14669]    左眼球粗胚（72 顶点）
//     helper-r-eye       v[14670..14741]    右眼球粗胚
//     helper-upper-teeth v[15060..15127]    上牙
//     等
//   注意全局坐标是**身体中轴在 0**，不是脚底在 0，所以缩放后要跟 body 用同一个
//   yOff（body 的 lo=-8.17）。
//
//   而 eyes/high-poly/high-poly.obj 是**精细眼球**（1064 顶点 / 2040 面），
//   它在自己的坐标空间里（Y≈15.6~15.9，X ±0.45，球半径 0.208 源单位）。
//   配套 .mhclo 的「逐顶点重心映射」公式实测不可复现（两套空间基准不同），
//   所以本文件**不用 .mhclo**，改成 rigid 对齐：
//     用 helper-l-eye / helper-r-eye 的球心当目标位置，把精细球按半径缩放挪过去。
//
// ⚠️⚠️ 三个已经踩死过的坑（改动前务必读完）⚠️⚠️
//
//   坑 1【最重要】：high-poly.obj 里**左右两个球共享同一套 808 个 UV**。
//     证据：vt0 的 uv(0.902, 0.101) 同时被 X<0 和 X>0 两侧的顶点引用。
//     因此**绝对不能**按 X 拆成两个 mesh 再各配一半贴图 —— 每半球的 UV
//     都覆盖全图，拆开后两边都会把整张贴图贴到自己身上（表现为虹膜糊在
//     球面的错误位置、颜色发灰）。正确做法：**保留单一网格不拆**，
//     贴图 brown_eye.png 本来就是两个眼球并排画好的，UV 天然对应。
//
//   坑 2：**不要绕 Y 轴旋转虹膜**。历史上有过两种互相矛盾的判断
//     （"虹膜朝 ±X" vs "虹膜朝 +Z"），追查后确认两者都是在错误前提下推出来的：
//     · "朝 ±X" 的依据是若干瞳孔顶点 X 等于球心 X —— 但那是因为贴图右下角
//       有个纯黑圆盘标记，暗像素聚类把它当成了瞳孔；
//     · "朝 +Z" 的依据是把瞳孔 UV 反查回 3D —— 但贴图上画的是**两个完整
//       眼球**（含虹膜/瞳孔/眼白/血丝），不是单块虹膜贴图，反查自然指到
//       贴图里那颗眼球的中心附近，与虹膜朝向无关。
//     既然每个半球的 UV 本身就含自己的虹膜，模型**不需要任何旋转**。
//     之前那个 ±90° yaw 就是把虹膜转离相机、正面看到一圈灰白眼白的元凶。
//
//   坑 3：side.tris 若要存索引，必须存**指向 eyeObj.V 的原始索引**。
//     早期版本存了重映射后的紧凑索引，导致取到完全不相干的顶点，
//     表现为眼球被挪到 X=0.069（错位 0.038）。
//
// 用法: node tools/mhaux.mjs [--out <file.glb>] [--eyeR 0.0125]
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const OUT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-parts-mh.glb';

// ---------------------------------------------------------------- OBJ 解析
function parseOBJ(file) {
  const V = [], VT = [];
  const groups = {};   // 组名 -> { tris:[[i,i,i]...], uvs:[[i,i,i]...] }
  let g = '__default';
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    if ((l[0] === 'o' || l[0] === 'g') && l[1] === ' ') { g = l.slice(2).trim(); continue; }
    if (l[0] === 'v' && l[1] === ' ') { const a = l.slice(2).trim().split(/\s+/).map(Number); V.push(a); }
    else if (l[0] === 'v' && l[1] === 't') { const a = l.slice(3).trim().split(/\s+/).map(Number); VT.push(a); }
    else if (l[0] === 'f' && l[1] === ' ') {
      const tk = l.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      const gg = groups[g] || (groups[g] = { tris: [], uvs: [] });
      for (let i = 1; i < tk.length - 1; i++) {
        for (const k of [0, i, i + 1]) {
          gg.tris.push(+tk[k][0] - 1);
          gg.uvs.push(tk[k][1] ? +tk[k][1] - 1 : -1);
        }
      }
    }
  }
  return { V, VT, groups };
}

// ------------------------------------------------- base 的缩放与配准参数
// 必须和 mhbuild.mjs 保持一致：S 由 body 的高度算出，yOff 由 body 的最低点算出
function baseScale() {
  const { V, groups } = parseOBJ(path.join(SRC, '3dobjs/base.obj'));
  const body = new Set(groups.body.tris);
  let lo = Infinity, hi = -Infinity;
  for (const i of body) { const y = V[i][1]; if (y < lo) lo = y; if (y > hi) hi = y; }
  const S = 1.70 / (hi - lo);
  return { S, yOff: lo * S, lo, hi };
}

const { S, yOff, lo, hi } = baseScale();
console.log(`base 配准：高度 ${(hi - lo).toFixed(3)} 源单位 -> 1.70m，S=${S.toFixed(6)}，yOff=${yOff.toFixed(4)}`);
const toM = (v) => [v[0] * S, v[1] * S - yOff, v[2] * S];

// -------------------------------------------------------- 各部件的信息汇总
const { V: bV, groups: bG } = parseOBJ(path.join(SRC, '3dobjs/base.obj'));

function partInfo(name) {
  const g = bG[name];
  if (!g) return null;
  const idx = [...new Set(g.tris)];
  let cx = 0, cy = 0, cz = 0;
  for (const i of idx) { cx += bV[i][0]; cy += bV[i][1]; cz += bV[i][2]; }
  cx /= idx.length; cy /= idx.length; cz /= idx.length;
  let r = 0;
  for (const i of idx) {
    const d = Math.hypot(bV[i][0] - cx, bV[i][1] - cy, bV[i][2] - cz);
    if (d > r) r = d;
  }
  return { idx, center: [cx, cy, cz], r, tris: g.tris.length / 3, uvs: g.uvs };
}

console.log('\n=== base.obj 里的辅助部件 ===');
for (const nm of ['helper-l-eye', 'helper-r-eye', 'helper-upper-teeth', 'helper-lower-teeth', 'helper-tongue', 'helper-l-eyelashes-1', 'helper-l-eyelashes-2', 'helper-r-eyelashes-1', 'helper-r-eyelashes-2', 'helper-hair']) {
  const p = partInfo(nm);
  if (!p) { console.log(`  ${nm.padEnd(24)} —— 不存在`); continue; }
  const c = toM(p.center);
  console.log(`  ${nm.padEnd(24)} ${String(p.idx.length).padStart(4)} 顶点 ${String(p.tris).padStart(4)} 面  半径 ${(p.r * S * 1000).toFixed(1)}mm  中心(米) ${c.map((x) => x.toFixed(3)).join(', ')}`);
}

// ------------------------------------------------------------ 精细眼球加载
const eyeObj = parseOBJ(path.join(SRC, 'eyes/high-poly/high-poly.obj'));
const eTris = eyeObj.groups.__default.tris, eUvs = eyeObj.groups.__default.uvs;
console.log(`\n精细眼球 obj: ${eyeObj.V.length} 顶点 / ${eTris.length / 3} 面（单一网格，含左右两个球）`);

// 球心/球半径：整个网格按 X 符号分成两簇求（**只用来算球心，不拆 mesh**，见坑 1）
const eyeVs = [...new Set(eTris)];
const clusterOf = (sign) => {
  const vs = eyeVs.filter((i) => (sign < 0 ? eyeObj.V[i][0] < 0 : eyeObj.V[i][0] >= 0));
  let cx = 0, cy = 0, cz = 0;
  for (const i of vs) { cx += eyeObj.V[i][0]; cy += eyeObj.V[i][1]; cz += eyeObj.V[i][2]; }
  cx /= vs.length; cy /= vs.length; cz /= vs.length;
  let r = 0;
  for (const i of vs) r = Math.max(r, Math.hypot(eyeObj.V[i][0] - cx, eyeObj.V[i][1] - cy, eyeObj.V[i][2] - cz));
  return { c: [cx, cy, cz], r, n: vs.length };
};
const cLft = clusterOf(-1), cRgt = clusterOf(+1);
console.log(`  精细球左簇 ${cLft.n} 顶点 心 ${cLft.c.map((x) => x.toFixed(4)).join(', ')} 半径 ${cLft.r.toFixed(4)}`);
console.log(`  精细球右簇 ${cRgt.n} 顶点 心 ${cRgt.c.map((x) => x.toFixed(4)).join(', ')} 半径 ${cRgt.r.toFixed(4)}`);

const argVal = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const TARGET_EYE_R_M = Number(argVal('eyeR', 0.0125));
const pbL = partInfo('helper-l-eye'), pbR = partInfo('helper-r-eye');

// 目标：把精细球的**球心**挪到 helper-l-eye / helper-r-eye 的球心，半径缩放到真实值
// ⚠️ 坑：精细球的世界坐标 Y≈15.75 与 base 的源单位完全不同尺度，必须**整体重定位**
//    （不是原地就能用）。做法：对每个顶点，先减去它所属球心得到局部向量，
//    再乘缩放比、加到目标球心上。左右两个目标球心不同，所以每个顶点按自己
//    在哪个簇来选目标球心（这也顺带把两球间距从 0.582 源单位收到正确眼距）。
const scaleOf = (c) => (TARGET_EYE_R_M / S) / c.r;
const scL = scaleOf(cLft), scR = scaleOf(cRgt);
console.log(`\n对齐：精细球半径 ${(cLft.r * S * 1000).toFixed(1)}mm -> ${(TARGET_EYE_R_M * 1000).toFixed(1)}mm（缩放 ${scL.toFixed(5)}）`);
console.log(`  左眼球心目标 ${toM(pbL.center).map((x) => x.toFixed(4)).join(', ')} (米)`);
console.log(`  右眼球心目标 ${toM(pbR.center).map((x) => x.toFixed(4)).join(', ')} (米)`);
console.log('  注：精细球自身的 X 偏移（±0.291）不参与，避免叠加成 0.031+0.291 的错位');

// ============================================================ 组装并写 GLB
// 设计取舍：**只导出眼球**，牙齿/舌头/睫毛先不导。
//   理由：牙齿和舌头在闭着嘴时完全看不见，而 AIVA 的嘴部表情靠 morph 驱动；
//   睫毛是 4 个独立小片，接不好反而更丑。眼球是"有没有"的质变，优先做。
//   以后要加牙齿，同一套 partInfo + rigid 绑定直接复用即可。
const P = [], U = [], I = [];
// ⚠️⚠️ 坑 4（这个坑让虹膜彻底消失，务必看懂）⚠️⚠️
//   去重键**必须是「顶点索引 + UV 索引」的组合**，不能只用顶点索引。
//   球面在接缝处同一个顶点会被两个三角形用不同的 vt 引用（这正是 UV 缝），
//   如果只按顶点索引去重、只保留第一次遇到的 UV，接缝上的 UV 就被"抹平"了。
//   实测后果非常隐蔽：GLB 里左右两眼**最朝前的那个顶点都被赋成了同一个
//   uv(0.9374, 0.0687)**（眼白区，虹膜浓度 0.00），而源 OBJ 里左眼最朝前
//   顶点本该是 uv(0.706, 0.707)、右眼是 uv(0.293, 0.305)（虹膜浓度 0.31/0.37，
//   正好落在贴图两颗眼球的虹膜上）。表现就是"只有眼白、完全没有虹膜"。
//   改用一个 "v/vt" 复合键即可，代价是顶点数从 1064 涨到约 1160（可接受）。
const remap = new Map();
for (let t = 0; t < eTris.length; t++) {
  const vi = eTris[t];
  const ui = eUvs[t];
  const key = vi + '/' + ui;
  let ni = remap.get(key);
  if (ni === undefined) {
    ni = P.length / 3;
    remap.set(key, ni);
    const v = eyeObj.V[vi];
    const left = v[0] < 0;
    const c = left ? cLft.c : cRgt.c;
    const sc = left ? scL : scR;
    const dst = left ? pbL.center : pbR.center;
    // 只取相对球心的偏移，**不做任何旋转**（见坑 2）
    const px = dst[0] + (v[0] - c[0]) * sc;
    const py = dst[1] + (v[1] - c[1]) * sc;
    const pz = dst[2] + (v[2] - c[2]) * sc;
    P.push(px * S, py * S - yOff, pz * S);
    if (ui >= 0 && eyeObj.VT[ui]) U.push(eyeObj.VT[ui][0], eyeObj.VT[ui][1]);
    else U.push(0, 0);
  }
  I.push(ni);
}

const meshList = [{ name: 'Eyes', bone: 'eyeL', P, U, I, vcount: P.length / 3, tcount: I.length / 3 }];

console.log('\n=== 写 GLB ===');
for (const m of meshList) {
  const mid = (arr, j) => arr.filter((_, i) => i % 3 === j);
  let r = 0;
  // 两个球各自的球心/半径都报一遍，确认没被压扁也没错位
  const tag = [pbL.center, pbR.center].map((c, k) => {
    const tgt = toM(c);
    const scaleK = k === 0 ? scL : scR;
    const srcC = k === 0 ? cLft.c : cRgt.c;
    let mx = 0;
    for (let i = 0; i < m.vcount; i++) {
      const lx = (m.P[i * 3] / S) - srcC[0], ly = (m.P[i * 3 + 1] + yOff) / S - srcC[1], lz = (m.P[i * 3 + 2] / S) - srcC[2];
      const has = (lx / scaleK) + srcC[0] < 0;
      if (k === 0 && !has) continue;
      if (k === 1 && has) continue;
      mx = 0;
    }
    return `眼球${k === 0 ? 'L' : 'R'} 目标(米) ${tgt.map((x) => x.toFixed(4)).join(', ')}`;
  });
  // 直接量最终坐标的 X 分布，比上面的推导更可信
  const xs = [];
  for (let i = 0; i < m.vcount; i++) xs.push(m.P[i * 3]);
  xs.sort((a, b) => a - b);
  console.log(`  ${m.name}: ${m.vcount} 顶点 / ${m.tcount} 面`);
  console.log(`     X 范围 ${xs[0].toFixed(4)} .. ${xs[xs.length - 1].toFixed(4)} (米)，中位数 ${xs[xs.length >> 1].toFixed(4)}`);
  for (const t of tag) console.log(`     ${t}`);
}

// ---------------------------------------------------------------- GLB 写出
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
const minMax = (arr, comp) => {
  const mn = new Array(comp).fill(Infinity), mx = new Array(comp).fill(-Infinity);
  for (let i = 0; i < arr.length; i++) { const c = i % comp; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; }
  return { min: mn, max: mx };
};

// 眼球贴图（CC0）
let eyeTexIdx = -1;
const EYE_PNG = path.join(SRC, 'eyes/materials/brown_eye.png');
if (fs.existsSync(EYE_PNG)) eyeTexIdx = pushBV(new Uint8Array(fs.readFileSync(EYE_PNG)));

const meshes = [], nodes = [], materials = [];
const ROOT_NODE = 0;
nodes.push({ name: 'Armature' });

for (const m of meshList) {
  const aPos = addAcc({ componentType: 5126, count: m.vcount, type: 'VEC3', bufferView: pushBV(new Float32Array(m.P), 34962), ...minMax(m.P, 3) });
  const aUv = addAcc({ componentType: 5126, count: m.vcount, type: 'VEC2', bufferView: pushBV(new Float32Array(m.U), 34962) });
  const aIdx = addAcc({ componentType: 5125, count: m.I.length, type: 'SCALAR', bufferView: pushBV(new Uint32Array(m.I), 34963), ...minMax(m.I, 1) });
  meshes.push({ name: m.name, primitives: [{ attributes: { POSITION: aPos, TEXCOORD_0: aUv }, indices: aIdx, material: 0 }] });
  const ni = nodes.length;
  nodes.push({ name: m.name + '_node', mesh: meshes.length - 1 });
  nodes[ROOT_NODE].children = nodes[ROOT_NODE].children || [];
  nodes[ROOT_NODE].children.push(ni);
}

materials.push({
  name: 'EyeMat',
  pbrMetallicRoughness: {
    baseColorFactor: [1, 1, 1, 1],
    metallicFactor: 0,
    roughnessFactor: 0.18,
    ...(eyeTexIdx >= 0 ? { baseColorTexture: { index: 0 } } : {}),
  },
  doubleSided: false,
});

const json = {
  asset: { version: '2.0', generator: 'mhaux.mjs (MakeHuman CC0 eyes)' },
  scene: 0,
  scenes: [{ nodes: [ROOT_NODE] }],
  nodes,
  meshes,
  materials,
  accessors: acc,
  bufferViews: bv,
  buffers: [{ byteLength: binLen }],
  ...(eyeTexIdx >= 0 ? { textures: [{ sampler: 0, source: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }], images: [{ bufferView: eyeTexIdx, mimeType: 'image/png' }] } : {}),
};

let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
const binBuf = Buffer.concat(chunks);
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
console.log(`\n写出 ${OUT}  (${(out.length / 1024).toFixed(0)}KB)`);
console.log(`  含贴图: ${eyeTexIdx >= 0 ? 'brown_eye.png（CC0）' : '无'}`);

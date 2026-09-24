// 按**几何位置**分带统计 VRM 各表情到底动了哪一块 —— 修 vrm-deltas.mjs 的误判。
//
// 为什么要这个工具（vrm-deltas.mjs 为什么不够）：
//   vrm-deltas 用「动点平均顶点序号 / 总点数」当"重心底位"，
//   默认顶点序号和空间位置有相关性。对**小块**几何（比如 Rose 那个
//   专门的口腔 mesh，356 点）成立；但对 VRoid 的 Face.baked 就完全失效 ——
//   41 个 target 共享同一块 22k 点的整脸几何，顶点序号是烘焙顺序，
//   和"眉毛/眼睛/嘴"没有任何关系。
//   结果：eyeWide / eyeSquint / browInnerUp 被误判成"安全"，实际会拽动下巴，
//   拍出来是一张"下巴掉到胸口"的鬼脸，而工具报告里一切正常。
//
// 判据换成**位置**：用眼睛骨、头骨世界坐标把脸切成
//   眉带 / 眼带 / 鼻带 / 嘴带 / 其余
// 再统计每个表情的位移落在哪一带、主要往哪个方向。
//
// 用法: node tools/vrm-region.mjs <输入.vrm> [--top=60]
import fs from 'node:fs';

const args = process.argv.slice(2);
const IN = args.find((a) => !a.startsWith('--'));
const TOP = Number((args.find((a) => a.startsWith('--top=')) || '').split('=')[1] || 40);
if (!IN) { console.error('用法: node tools/vrm-region.mjs <输入.vrm> [--top=40]'); process.exit(1); }

// ---- 解容器 ----
const buf = fs.readFileSync(IN);
let o = 12, poj = null, binOff = 0;
while (o + 8 <= buf.length) {
  const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
  if (type === 0x4e4f534a) poj = JSON.parse(buf.slice(o + 8, o + 8 + len).toString('utf8'));
  if (type === 0x004e4942) binOff = o + 8;
  o += 8 + len;
}
const bin = buf;
function readAccessor(i) {
  const a = poj.accessors[i];
  const bv = poj.bufferViews[a.bufferView];
  const base = binOff + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const w = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] || 1;
  const out = new Float32Array(a.count * w);
  for (let k = 0; k < out.length; k++) out[k] = bin.readFloatLE(base + k * 4);
  return out;
}

// ---- 找脸网格 ----
let faceMeshIdx = 0, facePrim = null;
poj.meshes.forEach((m, mi) => {
  const t = (m.primitives[0].targets || []).length;
  if (t > (facePrim?.targets?.length ?? 0)) { faceMeshIdx = mi; facePrim = m.primitives[0]; }
});
const count = poj.accessors[facePrim.attributes.POSITION].count;
const pos = readAccessor(facePrim.attributes.POSITION);

console.log(`文件: ${IN.split(/[\\/]/).pop()}`);
console.log(`脸网格: #${faceMeshIdx} ${poj.meshes[faceMeshIdx].name}  ${count} 点  targets ${(facePrim.targets || []).length}`);

// ---- 用骨骼定脸部的关键高度 ----
// 顶点是**模型空间**（未变换），骨骼 node 的 translation 也是模型空间的下级，
// 所以这里不能直接比。改用「顶点自身的 y 分布」自定标：
//   yTop = 脸的最高点（额头/头顶），yBot = 脸的最低点（下巴）
// 然后按比例切带。这比读骨骼更稳，因为不依赖骨骼命名。
let yMin = Infinity, yMax = -Infinity, xMax = 0, zMax = -Infinity;
for (let i = 0; i < count; i++) {
  const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
  if (y < yMin) yMin = y;
  if (y > yMax) yMax = y;
  if (Math.abs(x) > xMax) xMax = Math.abs(x);
  if (z > zMax) zMax = z;
}
const H = yMax - yMin;
console.log(`脸包围盒: y ${yMin.toFixed(3)} → ${yMax.toFixed(3)} (高 ${(H * 1000).toFixed(0)}mm)  |x|max ${xMax.toFixed(3)}`);
console.log(`  提示: y 越大越靠上（+Y 向上）。正面 = +Z 侧。\\n`);

// 脸部的纵向分带（按占脸高的比例，从下巴往上）：
//   0–18%   下巴/下颌
//   18–38%  嘴
//   38–62%  鼻/脸颊
//   62–80%  眼
//   80–100% 眉/额
function bandOf(y) {
  const t = (y - yMin) / H;
  if (t < 0.18) return '下巴';
  if (t < 0.38) return '嘴';
  if (t < 0.62) return '鼻颊';
  if (t < 0.80) return '眼';
  return '眉额';
}
const BANDS = ['下巴', '嘴', '鼻颊', '眼', '眉额'];
const bandIdx = new Uint8Array(count);
const bandCount = new Array(BANDS.length).fill(0);
for (let i = 0; i < count; i++) { bandIdx[i] = BANDS.indexOf(bandOf(pos[i * 3 + 1])); bandCount[bandIdx[i]]++; }
console.log('  各带顶点数: ' + BANDS.map((b, i) => `${b}${bandCount[i]}`).join('  '));

// ---- 逐表情统计 ----
const groups = poj.extensions?.VRM?.blendShapeMaster?.blendShapeGroups || [];
function delta(group) {
  const out = new Float32Array(count * 3);
  for (const b of group.binds || []) {
    if (b.mesh !== faceMeshIdx) continue;
    const accIdx = (facePrim.targets || [])[b.index]?.POSITION;
    if (accIdx === undefined) continue;
    const arr = readAccessor(accIdx);
    const w = (b.weight ?? 100) / 100;
    for (let i = 0; i < out.length; i++) out[i] += arr[i] * w;
  }
  return out;
}

console.log('\n  表情         |最大|  分布在哪些带（点数 / 该带占比）      主要方向');
console.log('  ' + '-'.repeat(88));
const table = [];
for (const g of groups) {
  const name = g.presetName || g.name || '(无名)';
  const d = delta(g);
  const perBand = BANDS.map(() => 0);
  let max = 0, sy = 0, sz = 0, n = 0, mxY = 0;
  for (let i = 0; i < count; i++) {
    const x = d[i * 3], y = d[i * 3 + 1], z = d[i * 3 + 2];
    const m = Math.hypot(x, y, z);
    if (m > max) { max = m; mxY = y; }
    if (m > 3e-4) { perBand[bandIdx[i]]++; sy += y; sz += z; n++; }
  }
  const mainDy = n ? sy / n : 0;
  const mainDz = n ? sz / n : 0;
  // "分散度"：动点数 / 最大位移。数值大 = 大面积小幅度（可信的软形变）；
  // 数值小 = 少数点大幅度（可能是局部夸张，也可能是坏数据）
  table.push({ name, max, n, perBand, mainDy, mainDz, spread: max > 0 ? n / (max * 1000) : 0 });

  const bandStr = BANDS.map((b, i) => perBand[i] ? `${b}${perBand[i]}` : null).filter(Boolean).join(' ');
  console.log(
    '  ' + name.padEnd(12) +
    (max * 1000).toFixed(1).padStart(7) + 'mm' +
    '  ' + bandStr.padEnd(38) +
    ' dy' + (mainDy * 1000).toFixed(1).padStart(7) +
    ' dz' + (mainDz * 1000).toFixed(1).padStart(7) +
    '  ' + (table[table.length - 1].spread).toFixed(1).padStart(6)
  );
}

// ---- 危险判定 ----
// 用来当「眼周/眉部」通道的表情，绝不能碰到「下巴」和「嘴」带。
// 判定：若某表情在 下巴+嘴 带上的动点数 > 总动点数的 4%，就标红。
console.log('\n  -- 安全判定（当"眼周/眉部"通道用时的风险） --');
let unsafe = 0;
for (const t of table) {
  if (!t.n) continue;
  const lowBands = t.perBand[0] + t.perBand[1];        // 下巴 + 嘴
  const share = lowBands / t.n;
  const isUpperOnly = share < 0.04;
  const tag = isUpperOnly ? '✅ 纯上半脸' : (share > 0.30 ? '❌ 主要动嘴部' : `⚠️ 沾到下半脸 ${(share * 100).toFixed(0)}%`);
  if (!isUpperOnly) unsafe++;
  console.log(`     ${t.name.padEnd(12)} ${tag}   (下带 ${lowBands}/${t.n})`);
}
console.log(`\\n  结论: ${table.filter((t) => t.n).length} 个有效表情，其中 ${unsafe} 个有下半脸成分。`);
console.log('  ⚠️ 若把"有下半脸成分"的表情接到 eyeWide/eyeSquint 上，张嘴和笑容叠加时会拽动下巴。');

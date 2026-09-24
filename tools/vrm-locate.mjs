// 逐 primitive 校验 VRM 表情位移是否「落在该材质该在的部位」。
//
// 为什么需要这个工具（前面两个工具为什么都不够）：
//   1. vrm-deltas.mjs 用「平均顶点序号 / 总点数」当重心底位。
//      对独立小块几何（Rose 的口腔 mesh）成立；
//      对 VRoid 的 Face.baked 完全失效 —— 那是 2148 点整脸几何。
//   2. vrm-region.mjs 按「整脸包围盒比例」分带。
//      但 VRoid 脸皮的 y 只覆盖 1.383–1.617（下巴到额），
//      按它切出来的"带"会把嘴归到"下巴带"，仍然误判。
//
// 真正可靠的判据：**看位移落在哪个绝对高度上**。
//   这个模型的五官高度是实测出来的、固定的：
//     嘴   1.403–1.442
//     眼   1.442–1.520
//     眉   1.480–1.539
//   一个想当"眼周通道"用的表情，绝不能在这三层里都动。
//
// 这个工具的输出直接决定 vr2glb 的通道映射表该怎么写。
//
// 用法: node tools/vrm-locate.mjs <输入.vrm> [--list]
import fs from 'node:fs';

const args = process.argv.slice(2);
const IN = args.find((a) => !a.startsWith('--'));
const LIST = args.includes('--list');
if (!IN) { console.error('用法: node tools/vrm-locate.mjs <输入.vrm> [--list]'); process.exit(1); }

const buf = fs.readFileSync(IN);
let o = 12, poj = null, binOff = 0;
while (o + 8 <= buf.length) {
  const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
  if (type === 0x4e4f534a) poj = JSON.parse(buf.slice(o + 8, o + 8 + len).toString('utf8'));
  if (type === 0x004e4942) binOff = o + 8;
  o += 8 + len;
}
function acc(i) {
  const a = poj.accessors[i], bv = poj.bufferViews[a.bufferView];
  const b = binOff + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const w = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] || 1;
  const out = new Float32Array(a.count * w);
  for (let k = 0; k < out.length; k++) out[k] = buf.readFloatLE(b + k * 4);
  return out;
}

// 找 targets 最多的 mesh
let fm = 0, fp = null;
poj.meshes.forEach((m, mi) => {
  const t = (m.primitives[0].targets || []).length;
  if (t > (fp?.targets?.length ?? 0)) { fm = mi; fp = m.primitives[0]; }
});
const N = poj.accessors[fp.attributes.POSITION].count;
const pos = acc(fp.attributes.POSITION);

// 各材质对应的 key 顶点 —— 用视觉上最可靠的判据：
// 「眼线/睫毛/虹膜这个 primitive 里那些点的位置」就是眼睛在哪
function bboxOfPrim(pi) {
  const a = poj.accessors[poj.meshes[fm].primitives[pi].attributes.POSITION];
  const bv = poj.bufferViews[a.bufferView];
  const b = binOff + (bv.byteOffset || 0) + (a.byteOffset || 0);
  let y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < a.count; i++) {
    const y = buf.readFloatLE(b + i * 12 + 4), z = buf.readFloatLE(b + i * 12 + 8);
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { y0, y1, z0, z1 };
}

console.log(`文件: ${IN.split(/[\\/]/).pop()}`);
console.log(`脸网格: #${fm} ${poj.meshes[fm].name}  ${N} 点  ${poj.meshes[fm].primitives.length} 个材质分量`);

if (LIST) {
  console.log('\n  各材质分量的顶点范围（都是同一份 ' + N + ' 点，只是材质不同）:');
  poj.meshes[fm].primitives.forEach((p, i) => {
    const b = bboxOfPrim(i);
    console.log(`   p${String(i).padStart(2)}  y[${b.y0.toFixed(3)},${b.y1.toFixed(3)}]  z[${b.z0.toFixed(3)},${b.z1.toFixed(3)}]  ${(poj.materials[p.material]?.name || '').slice(0, 34)}`);
  });
}

// ---- 用「眼线材质分量的顶点」当眼睛的掩码 ----
// 眼线是贴着眼睛轮廓画的一圈，它的顶点位置就精确代表眼睛在哪。
// 这比按高度比例猜准得多。
const EYELINE_RE = /Eyeline/i, IRIS_RE = /Iris/i, BROW_RE = /Brow/i, MOUTH_RE = /Mouth/i;
function maskFromPrim(re) {
  const pi = poj.meshes[fm].primitives.findIndex((p) => re.test(poj.materials[p.material]?.name || ''));
  if (pi < 0) return null;
  const a = poj.accessors[poj.meshes[fm].primitives[pi].attributes.POSITION];
  const bv = poj.bufferViews[a.bufferView];
  const b = binOff + (bv.byteOffset || 0) + (a.byteOffset || 0);
  // 取该材质顶点 y 的分位区间（去掉离群点），再用它标出这一层的点
  const ys = [];
  for (let i = 0; i < a.count; i++) ys.push(buf.readFloatLE(b + i * 12 + 4));
  ys.sort((x, y) => x - y);
  const lo = ys[Math.floor(ys.length * 0.02)], hi = ys[Math.floor(ys.length * 0.98)];
  const m = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (pos[i * 3 + 1] >= lo && pos[i * 3 + 1] <= hi) m[i] = 1;
  return { mask: m, lo, hi, src: poj.materials[poj.meshes[fm].primitives[pi].material]?.name };
}
const ZONES = [['嘴', MOUTH_RE], ['眼', EYELINE_RE], ['虹膜', IRIS_RE], ['眉', BROW_RE]];
const zoneMasks = [];
for (const [label, re] of ZONES) {
  const r = maskFromPrim(re);
  if (r) zoneMasks.push({ label, ...r });
}
console.log('\n  部位定位（由对应材质顶点的 y 分位推出）:');
for (const z of zoneMasks) console.log(`   ${z.label.padEnd(4)} y[${z.lo.toFixed(3)},${z.hi.toFixed(3)}]  ← ${z.src}`);
if (!zoneMasks.length) { console.error('没能定位任何部位（材质命名不匹配）'); process.exit(1); }

// ---- 逐表情：位移落点分布 ----
const groups = poj.extensions?.VRM?.blendShapeMaster?.blendShapeGroups || [];
console.log('\n  表情        总动点 |  按部位拆分的动点数（只有一格 = 纯部位）');
console.log('  ' + '-'.repeat(84));
const rows = [];
for (const g of groups) {
  const name = g.presetName || g.name || '(无名)';
  const d = new Float32Array(N * 3);
  for (const b of g.binds || []) {
    if (b.mesh !== fm) continue;
    const t = fp.targets?.[b.index];
    if (!t) continue;
    const a = acc(t.POSITION);
    const w = (b.weight ?? 100) / 100;
    for (let i = 0; i < a.length; i++) d[i] += a[i] * w;
  }
  const moving = new Uint8Array(N);
  let n = 0, max = 0;
  for (let i = 0; i < N; i++) {
    const m = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
    if (m > 3e-4) { moving[i] = 1; n++; }
    if (m > max) max = m;
  }
  // 每个部位带上「有位移」的点数
  const per = zoneMasks.map((z) => {
    let c = 0;
    for (let i = 0; i < N; i++) if (moving[i] && z.mask[i]) c++;
    return c;
  });
  // 纯部位判定：动点集中度 = 最大部位点 / 总动点
  const topShare = n ? Math.max(...per) / n : 0;
  rows.push({ name, n, max, per, topShare, zoneLabels: zoneMasks.map((z) => z.label) });
  console.log(
    '  ' + name.padEnd(12) + String(n).padStart(6) + ' | ' +
    per.map((c, i) => `${zoneMasks[i].label}${c}`).join(' ').padEnd(46) +
    ` 集中度${(topShare * 100).toFixed(0)}%`
  );
}

console.log('\n  -- 判读 --');
console.log('  集中度 100% = 该表情只动一个部位（最安全，可直接接到对应 ARKit 通道）');
console.log('  集中度低    = 整脸表情，接给任何单通道都会顺带拽动别的部位\\n');
for (const r of rows) {
  if (!r.n) continue;
  const only = r.per.map((c, i) => (c / r.n > 0.85 ? r.zoneLabels[i] : null)).filter(Boolean);
  const tag = only.length ? `✅ 纯「${only.join('/')}」` :
    (r.topShare > 0.6 ? `△ 偏「${r.zoneLabels[r.per.indexOf(Math.max(...r.per))]}」` : '❌ 整脸混合');
  console.log(`     ${r.name.padEnd(12)} 最大位移 ${(r.max * 1000).toFixed(1).padStart(5)}mm  ${tag}`);
}

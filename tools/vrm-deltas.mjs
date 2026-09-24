// 量出 VRM 每个表情「真正在动哪一块、往哪动」—— 定通道映射靠这个，不靠名字猜。
//
// 为什么要这个工具：
//   第一版 CHANNELS 把 mouthSmile 映射成 joy + i(0.25)。
//   结果拍出来是一张「下巴被拽到胸口、脸下半塌成 V 形」的图 —— 根本不是笑。
//   原因是 VRM 的元音 a/i/u/e/o 是**整个口型**（含开合），不是纯唇形；
//   把 i 当"微笑唇形"叠加，等于同时把下巴拉开了。
//
//   所以先量：对每个 group 统计
//     - 最大位移 / 移动点数（有没有东西在动）
//     - 平均 dy（下巴方向，正=往下=张嘴）
//     - 平均 dz（前后，正=往脸外=唇部外翻/嘟起）
//     - 平均 |dx|（左右，大=嘴角横向拉伸=笑）
//     - 动点集合的重心 y（判断动的是嘴还是眼）
//   有了这张表，才能判断某个 group 适合当"唇形"还是只能当"下颌"。
//
// 用法: node tools/vrm-deltas.mjs <输入.vrm> [--mesh=auto|<index>] [--verts]
import fs from 'node:fs';

const args = process.argv.slice(2);
const IN = args.find((a) => !a.startsWith('--'));
const VERT_DETAIL = args.includes('--verts');
if (!IN) { console.error('用法: node tools/vrm-deltas.mjs <输入.vrm> [--verts]'); process.exit(1); }

// ---- 解 GLB/VRM 容器 ----
const buf = fs.readFileSync(IN);
let o = 12, poj = null, binOff = 0;
while (o + 8 <= buf.length) {
  const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
  if (type === 0x4e4f534a) poj = JSON.parse(buf.slice(o + 8, o + 8 + len).toString('utf8'));
  if (type === 0x004e4942) binOff = o + 8;
  o += 8 + len;
}
if (!poj) { console.error('不是合法的 GLB/VRM'); process.exit(1); }

const bin = buf;
function readAccessor(i) {
  const a = poj.accessors[i];
  const bv = poj.bufferViews[a.bufferView];
  const base = binOff + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const n = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] || 1);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = bin.readFloatLE(base + k * 4);
  return out;
}

// ---- 找脸网格（target 最多的那个）----
let faceMeshIdx = 0, facePrim = null;
poj.meshes.forEach((m, mi) => {
  const t = (m.primitives[0].targets || []).length;
  if (t > (facePrim?.targets?.length ?? 0)) { faceMeshIdx = mi; facePrim = m.primitives[0]; }
});
console.log(`文件: ${IN.split(/[\\/]/).pop()}`);
console.log(`脸网格: #${faceMeshIdx} ${poj.meshes[faceMeshIdx].name}  targets ${(facePrim.targets || []).length}`);

const groups = poj.extensions?.VRM?.blendShapeMaster?.blendShapeGroups || [];
if (!groups.length) { console.error('没有 VRM blendShapeMaster（VRM 1.0？）'); process.exit(1); }

// 注意：VRM 的 binds 可能指向**多个** mesh。
// 统计时把每个 bind 的位移都算上，否则只看到一半。
function delta(group) {
  const count = poj.accessors[facePrim.attributes.POSITION].count;
  const out = new Float32Array(count * 3);
  const touched = [];
  for (const b of group.binds || []) {
    if (b.mesh !== faceMeshIdx) { touched.push(`mesh${b.mesh}(跳过)`); continue; }
    const accIdx = (facePrim.targets || [])[b.index]?.POSITION;
    if (accIdx === undefined) continue;
    const arr = readAccessor(accIdx);
    const w = (b.weight ?? 100) / 100;
    for (let i = 0; i < out.length; i++) out[i] += arr[i] * w;
    touched.push(`t${b.index}×${w}`);
  }
  return { data: out, touched };
}

const rows = [];
for (const g of groups) {
  const name = g.presetName || g.name || '(无名)';
  const { data, touched } = delta(g);
  let max = 0, n = 0, dy = 0, dz = 0, adx = 0, cy = 0;
  for (let i = 0; i < data.length; i += 3) {
    const x = data[i], y = data[i + 1], z = data[i + 2];
    const mag = Math.hypot(x, y, z);
    if (mag > max) max = mag;
    if (mag > 3e-4) { n++; dy += y; dz += z; adx += Math.abs(x); cy += i / 3; }
  }
  const cnt = poj.accessors[facePrim.attributes.POSITION].count;
  rows.push({
    name, binds: touched.length, max, n,
    dy: n ? dy / n : 0, dz: n ? dz / n : 0, adx: n ? adx / n : 0,
    // 动点重心换算成「网格第几成位置」——用来判断动的是上半脸还是下半脸
    centroid: n ? (cy / n) / cnt : 0,
  });
}

console.log('\n  表情          移动点   最大位移   平均dy(下+)  平均dz(外+)  平均|dx|   重心底位');
console.log('  ' + '-'.repeat(78));
for (const r of rows) {
  console.log(
    '  ' + r.name.padEnd(13) +
    String(r.n).padStart(6) +
    (r.max * 1000).toFixed(1).padStart(9) + 'mm' +
    (r.dy * 1000).toFixed(2).padStart(11) +
    (r.dz * 1000).toFixed(2).padStart(12) +
    (r.adx * 1000).toFixed(2).padStart(10) +
    (r.centroid * 100).toFixed(1).padStart(10) + '%'
  );
}

// ---- 按「动的是上半脸还是下半脸」分类 ----
console.log('\n  判读：重心底位 <45% ≈ 上半脸(眼/眉)；>50% ≈ 下半脸(口/下颌)');
const upper = rows.filter((r) => r.n && r.centroid < 0.45);
const lower = rows.filter((r) => r.n && r.centroid >= 0.45);
console.log('  上半脸:', upper.map((r) => r.name).join(', ') || '（无）');
console.log('  下半脸:', lower.map((r) => r.name).join(', ') || '（无）');

// ---- 嘴部候选按 dy 分成「下颌」和「唇形」 ----
// dy 大正值 = 顶点整体往下 = 下颌张开；dy 接近 0 且 |dx| 大 = 纯唇形
const jaw = lower.filter((r) => r.dy > 0.0015).sort((a, b) => b.dy - a.dy);
const shape = lower.filter((r) => r.dy <= 0.0015);
console.log('\n  下半脸里偏「下颌张开」(dy>1.5mm):', jaw.map((r) => `${r.name}(${(r.dy * 1000).toFixed(1)})`).join(', ') || '（无）');
console.log('  下半脸里偏「唇形」(dy≤1.5mm):', shape.map((r) => `${r.name}(|dx|${(r.adx * 1000).toFixed(1)})`).join(', ') || '（无）');

if (VERT_DETAIL) {
  console.log('\n  -- 逐 bind 明细 --');
  for (const g of groups) {
    const name = g.presetName || g.name || '(无名)';
    const { touched } = delta(g);
    console.log(`  ${name.padEnd(13)} binds=${touched.length}  ${touched.join(' ')}`);
  }
}

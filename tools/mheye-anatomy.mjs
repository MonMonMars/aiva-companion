// mheye-anatomy.mjs —— 从「已导出的 GLB 里真实存在的身体网格」量出眼睛该怎么放
//
// 为什么写这个：
//   之前所有眼球定位都基于 MakeHuman 源坐标（base.obj）的推算，
//   而 GLB 里身体经过了缩放/平移，两套坐标的换算我在 center[1] / zNew 上
//   混用了（一处当米、一处当源单位），结果眼球被甩到身体外面（审计：
//   身体 Z 范围 -0.10..0.33，而眼球被放到 1.39 米外）。
//
//   正确思路：**别再从源坐标换算**。直接在最终 GLB 的坐标里量：
//     · 头部网格的世界包围盒
//     · 眼睛高度处的脸部前轮廓 Z
//     · 已有骨骼 eyeL / eyeR 的实际位置（GLB 里它们就是最终坐标）
//   然后眼球就放在骨骼位置上，再做深度抵消。
//
// 用法：node tools/mheye-anatomy.mjs
import fs from 'node:fs';

const GLB = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-parts-mh.glb';

const buf = fs.readFileSync(GLB);
if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('不是 GLB');
let off = 12; let json = null; const binChunks = [];
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'));
  else if (type === 0x004E4942) binChunks.push(data);
  off += 8 + len + ((4 - (len % 4)) % 4);
}
const bin = Buffer.concat(binChunks);
console.log(`节点 ${json.nodes.length}  网格 ${json.meshes?.length || 0}  材质 ${json.materials?.length || 0}`);

// 读某个 accessor 的前几个 VEC3
const readAcc = (ai) => {
  const a = json.accessors[ai], bv = json.bufferViews[a.bufferView];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const comp = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const out = [];
  for (let i = 0; i < a.count; i++) {
    const v = [];
    for (let k = 0; k < n; k++) {
      const o = base + (i * n + k) * comp;
      v.push(a.componentType === 5126 ? bin.readFloatLE(o)
        : a.componentType === 5125 ? bin.readUInt32LE(o)
          : a.componentType === 5123 ? bin.readUInt16LE(o) : bin.readUInt8(o));
    }
    out.push(v);
  }
  return out;
};

// —— 1) 列出所有网格 + 世界包围盒（节点无额外变换时即局部坐标）
console.log('\n══ 网格清单 ══');
const meshInfo = [];
for (let i = 0; i < json.nodes.length; i++) {
  const nd = json.nodes[i];
  if (nd.mesh === undefined) continue;
  const m = json.meshes[nd.mesh];
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of m.primitives) {
    const a = json.accessors[p.attributes.POSITION];
    if (a.min && a.max) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a.min[k]); mx[k] = Math.max(mx[k], a.max[k]); }
  }
  const label = `${m.name || '?'} / node ${nd.name || '?'}`;
  meshInfo.push({ i, name: nd.name || m.name, mesh: m.name, mn, mx, skin: nd.skin !== undefined });
  console.log(`  [${i}] ${label}${nd.skin !== undefined ? '  (蒙皮)' : ''}`);
  console.log(`        min ${mn.map(x => x.toFixed(4))}  max ${mx.map(x => x.toFixed(4))}`);
}

// —— 2) 骨骼位置（GLB 里就是最终坐标）
console.log('\n══ 骨骼位置（eye* 相关）══');
const boneNames = json.nodes.map((n, i) => ({ i, n: n.name || '' }))
  .filter(o => /eye|head|neck|jaw/i.test(o.n));
for (const b of boneNames) {
  const nd = json.nodes[b.i];
  const t = nd.translation || [0, 0, 0];
  console.log(`  [${b.i}] ${b.n}  translation ${t.map(x => +x.toFixed(4))}  children ${(nd.children || []).length}`);
}

// —— 3) 深度优先累乘变换，算骨骼世界位置
const parent = new Array(json.nodes.length).fill(-1);
json.nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
const worldT = (i) => {
  // 只累加平移（骨骼链没有缩放/旋转的假设下够用；这里只用于定位参考）
  let acc = [0, 0, 0], k = i;
  while (k >= 0) {
    const t = json.nodes[k].translation || [0, 0, 0];
    acc = [acc[0] + t[0], acc[1] + t[1], acc[2] + t[2]];
    k = parent[k];
  }
  return acc;
};
console.log('\n══ 骨骼世界位置（累加平移）══');
for (const b of boneNames) {
  console.log(`  ${b.n}  ${worldT(b.i).map(x => +x.toFixed(4))}`);
}

// —— 4) 头部机身：在眼睛高度处的「前轮廓 Z」
console.log('\n══ 脸部前轮廓（X 分箱最大 Z，按身体网格顶点）══');
const bodyMesh = meshInfo.find(m => /Body/i.test(m.name) || /Body/i.test(m.mesh));
if (bodyMesh) {
  const nd = json.nodes[bodyMesh.i];
  const m = json.meshes[nd.mesh];
  const pos = readAcc(m.primitives[0].attributes.POSITION);
  console.log(`  身体顶点数 ${pos.length}`);
  // 眼睛大致高度：取身体顶部 0.87~0.95 区间的 Y
  const ys = pos.map(p => p[1]);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  console.log(`  Y 范围 ${yMin.toFixed(4)} .. ${yMax.toFixed(4)}（身高 ${(yMax - yMin).toFixed(4)}）`);
  // 扫描眼睛高度。人头：眼睛在身高约 0.935 处（从脚算），即 yMin + 0.935*H
  const eyeY = yMin + 0.935 * (yMax - yMin);
  console.log(`  假定眼睛高度 Y ≈ ${eyeY.toFixed(4)}（身高 93.5%）`);
  const bins = {};
  for (const p of pos) {
    if (Math.abs(p[1] - eyeY) > 0.03) continue;
    const b = (Math.round(p[0] / 0.01) * 0.01).toFixed(2);
    if (bins[b] === undefined || p[2] > bins[b]) bins[b] = p[2];
  }
  const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
  for (const k of keys) console.log(`    X ${k >= 0 ? ' ' : ''}${k.toFixed(2)}  → 前轮廓 Z ${bins[k].toFixed(4)}`);
}

// mh-glbinfo.mjs —— 检查 GLB 的网格节点变换 / 蒙皮 IBM，判断绑定是否需要 bindMatrix
// 用法: node tools/mh-glbinfo.mjs <glb...>
import fs from 'node:fs';

function readGLB(p) {
  const buf = fs.readFileSync(p);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const d = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(d.toString('utf8'));
    else if (type === 0x004e4942) bin = d;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc(g, i) {
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView];
  const [Arr, bytes] = CT[a.componentType]; const n = NC[a.type];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const out = new Arr(a.count * n);
  if (!stride || stride === n * bytes) out.set(new Arr(g.bin.buffer, g.bin.byteOffset + base, a.count * n));
  else for (let k = 0; k < a.count; k++) out.set(new Arr(g.bin.buffer, g.bin.byteOffset + base + k * stride, n), k * n);
  return out;
}
const isIdent = (m, eps = 1e-5) => {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - I[i]) > eps) return false;
  return true;
};

for (const p of process.argv.slice(2)) {
  const g = readGLB(p);
  const f = p.split(/[\\/]/).pop();
  console.log('=== ' + f + ' ===');
  const mn = (g.json.nodes || []).filter((n) => n.mesh !== undefined);
  for (const n of mn) {
    const trs = (n.translation || n.rotation || n.scale) ? { t: n.translation, r: n.rotation, s: n.scale } : null;
    console.log('  meshNode ' + JSON.stringify(n.name) + '  matrix=' + (n.matrix ? 'YES' : 'no') + '  trs=' + JSON.stringify(trs) + '  skin=' + n.skin);
  }
  const sk = (g.json.skins || [])[0];
  if (!sk) { console.log('  (no skin)'); continue; }
  console.log('  joints=' + sk.joints.length + '  skeletonRoot=' + sk.skeleton);
  if (sk.inverseBindMatrices !== undefined) {
    const m = acc(g, sk.inverseBindMatrices);
    const a = g.json.accessors[sk.inverseBindMatrices];
    console.log('  IBM count=' + a.count + '  componentType=' + a.componentType);
    let ident = 0;
    for (let i = 0; i < a.count; i++) if (isIdent(Array.from(m.subarray(i * 16, i * 16 + 16)))) ident++;
    console.log('  IBM 中单位阵数量 = ' + ident + ' / ' + a.count);
    // 打印前 3 个和几个非单位的
    const show = [];
    for (let i = 0; i < Math.min(3, a.count); i++) show.push([i, Array.from(m.subarray(i * 16, i * 16 + 16)).map((v) => +v.toFixed(4))]);
    console.log('  前3个 IBM: ' + JSON.stringify(show));
  } else console.log('  (no inverseBindMatrices)');
  // 关节节点的局部变换
  const joints = sk.joints.map((ji) => g.json.nodes[ji]);
  const withT = joints.filter((n) => n.translation).length;
  console.log('  关节带 translation 的: ' + withT + '/' + joints.length);
  const j0 = joints.slice(0, 4).map((n) => ({ name: n.name, t: n.translation, r: n.rotation ? 'rot' : null, s: n.scale }));
  console.log('  前4个关节: ' + JSON.stringify(j0));
}

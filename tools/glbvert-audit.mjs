#!/usr/bin/env node
// 拆件之后的「体积注水」体检：
//   每个部件 GLB 里，POSITION 访问器带着多少个顶点？实际被 indices 引用到的又有几个？
//   差得越多 = 白搬的顶点越多，压掉就能把文件瘦下来。
//
// 用法: node tools/glbvert-audit.mjs assets/models5/aiva-shino-outfit.glb [...]
import fs from 'node:fs';

function readGLB(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB: ' + file);
  let off = 12, json = null, bin = null;
  while (off < b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
    const body = b.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4) * 0;
    off += (4 - (len % 4)) % 4;
  }
  return { json, bin };
}

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SZ = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

for (const file of process.argv.slice(2)) {
  const { json, bin } = readGLB(file);
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  const totalBin = bin.length;

  // 收集所有 mesh 用到的 accessor
  const usedByMesh = new Set();   // accessor index
  const idxAcc = new Set();
  for (const m of json.meshes || []) {
    for (const p of m.primitives || []) {
      for (const k of ['indices', 'POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0', 'COLOR_0']) {
        if (p[k] != null) usedByMesh.add(p[k]);
      }
      if (p.indices != null) idxAcc.add(p.indices);
      for (const t of p.targets || []) for (const k of Object.keys(t)) usedByMesh.add(t[k]);
    }
  }

  // 实际被 indices 引用到的顶点集合（按 primitive 分别记，最后取并集）
  const live = new Set();
  let primCount = 0, idxTotal = 0;
  const posAccs = new Map();    // accessor index -> count
  for (const m of json.meshes || []) {
    for (const p of m.primitives || []) {
      primCount++;
      const pa = (p.attributes || {}).POSITION;
      if (pa != null) posAccs.set(pa, json.accessors[pa].count);
      if (p.indices == null) continue;
      const a = json.accessors[p.indices];
      const bv = json.bufferViews[a.bufferView];
      const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
      for (let i = 0; i < a.count; i++) {
        const v = a.componentType === 5125 ? bin.readUInt32LE(base + i * 4) : bin.readUInt16LE(base + i * 2);
        live.add(v); idxTotal++;
      }
    }
  }

  // 各访问器占多少字节
  const accBytes = (ai) => {
    const a = json.accessors[ai];
    if (a.bufferView == null) return 0;
    const bv = json.bufferViews[a.bufferView];
    return (bv.byteLength || 0);
  };
  const bySem = {};
  // 只认 indices / attributes / targets 三类里装着的 accessor index，
  // extensions / extras / material / mode 都不是，碰了就会 json.accessors[undefined]
  // ⚠️ 必须按 accessor **去重**：Shino 的 9 个 primitive 共用同一个 POSITION
  //    访问器，不去重会把一个 bufferView 算 9 遍，算出比文件本身还大的数。
  const counted = new Set();
  for (const m of json.meshes || []) for (const p of m.primitives || []) {
    const add = (k, ai) => { if (counted.has(k + ':' + ai)) return; counted.add(k + ':' + ai); bySem[k] = (bySem[k] || 0) + accBytes(ai); };
    if (p.indices != null) add('indices', p.indices);
    for (const [k, v] of Object.entries(p.attributes || {})) add(k, v);
    (p.targets || []).forEach((t, ti) => {
      for (const [k, v] of Object.entries(t)) add('morph#' + ti + ':' + k, v);
    });
  }

  console.log('\n===== ' + file.split(/[\\/]/).pop() + ' =====');
  console.log('  文件总大小        :', kb(fs.statSync(file).size));
  console.log('  BIN 段            :', kb(totalBin));
  console.log('  mesh / primitive  :', (json.meshes || []).length, '/', primCount);
  console.log('  POSITION 访问器   :', posAccs.size, '个');
  let posTotal = 0;
  for (const [ai, n] of posAccs) { console.log('     acc#' + ai, n, 'verts'); posTotal += n; }
  console.log('  indices 引用到的顶点:', live.size, '（共', idxTotal, '个索引）');
  console.log('  → 未被引用的顶点   :', posTotal - live.size, '/', posTotal,
    posTotal ? '(' + ((posTotal - live.size) / posTotal * 100).toFixed(1) + '% 是白搬的)' : '');
  console.log('  按语义占字节:');
  for (const [k, v] of Object.entries(bySem).sort((a, b) => b[1] - a[1])) console.log('     ' + k.padEnd(16), kb(v));
  // 纹理
  const imgs = (json.images || []).length;
  let imgBytes = 0;
  for (const im of json.images || []) if (im.bufferView != null) imgBytes += json.bufferViews[im.bufferView].byteLength || 0;
  console.log('  纹理              :', imgs, '张', kb(imgBytes));
}

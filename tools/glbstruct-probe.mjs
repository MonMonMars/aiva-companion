#!/usr/bin/env node
// 压缩前的结构勘察：有没有踩不得的雷（sparse / byteStride / 共用 bufferView / 非网格 accessor）
// 用法: node tools/glbstruct-probe.mjs <a.glb> [...]
import fs from 'node:fs';

for (const file of process.argv.slice(2)) {
  const b = fs.readFileSync(file);
  let off = 12, json = null, bin = null;
  while (off + 8 <= b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4), s = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(b.slice(s, s + len).toString('utf8'));
    else if (type === 0x004e4942) bin = b.slice(s, s + len);
    off = s + len;
  }
  console.log('\n===== ' + file.split(/[\\/]/).pop() + ' =====');

  const sparse = [], strided = [];
  (json.accessors || []).forEach((a, i) => {
    if (a.sparse) sparse.push(i);
    const bv = json.bufferViews[a.bufferView || 0];
    if (bv && bv.byteStride) strided.push(i + '(stride=' + bv.byteStride + ')');
  });
  console.log('  sparse 访问器 :', sparse.length ? sparse.join(',') : '无  ✅');
  console.log('  byteStride   :', strided.length ? strided.join(',') : '无  ✅（非交错）');

  // bufferView 被几个 accessor 共用
  const use = new Map();
  (json.accessors || []).forEach((a, i) => { if (a.bufferView != null) use.set(a.bufferView, (use.get(a.bufferView) || []).concat(i)); });
  const shared = [...use.entries()].filter(([, v]) => v.length > 1);
  console.log('  共用 bufferView:', shared.length ? shared.map(([k, v]) => 'bv' + k + '←acc' + v.join('/')).join(' ') : '无  ✅');

  // 哪些 accessor 不被任何 mesh 用到（骨架 IBM / 动画 / 其他）
  const byMesh = new Set();
  for (const m of json.meshes || []) for (const p of m.primitives || []) {
    if (p.indices != null) byMesh.add(p.indices);
    for (const v of Object.values(p.attributes || {})) byMesh.add(v);
    for (const t of p.targets || []) for (const v of Object.values(t)) byMesh.add(v);
  }
  const others = (json.accessors || []).map((a, i) => i).filter((i) => !byMesh.has(i));
  console.log('  非网格 accessor:', others.length, '个 →', others.map((i) => '#' + i + '(' + json.accessors[i].type + 'x' + json.accessors[i].count + ')').join(' '));

  // primitive 按 POSITION accessor 分组
  const groups = new Map();
  for (const m of json.meshes || []) for (const p of m.primitives || []) {
    const pa = (p.attributes || {}).POSITION;
    if (pa == null) continue;
    if (!groups.has(pa)) groups.set(pa, []);
    groups.get(pa).push(p);
  }
  console.log('  顶点组（按 POSITION accessor）:');
  for (const [pa, prims] of groups) {
    const n = json.accessors[pa].count;
    const live = new Set(); let noIdx = 0, idxN = 0;
    for (const p of prims) {
      if (p.indices == null) { noIdx++; continue; }
      const ia = json.accessors[p.indices];
      const bvv = json.bufferViews[ia.bufferView];
      const base = (bvv.byteOffset || 0) + (ia.byteOffset || 0);
      for (let i = 0; i < ia.count; i++) {
        live.add(ia.componentType === 5125 ? bin.readUInt32LE(base + i * 4) : bin.readUInt16LE(base + i * 2));
        idxN++;
      }
    }
    const meshNames = new Set();
    for (const m of json.meshes || []) for (const p of m.primitives || []) {
      if ((p.attributes || {}).POSITION === pa) meshNames.add(m.name);
    }
    console.log(`     acc#${pa} ${String(n).padStart(6)} verts | ${prims.length} prim | ${[...meshNames].join(',')}`
      + ` | 索引 ${idxN} 个 → 实际用 ${live.size}${noIdx ? ` ⚠️${noIdx} 个 prim 没有 indices` : ''}`);
  }
}

// 纯 JSON 的 GLB 结构探测器 —— 不依赖 three.js（避免 node 里 self is not defined）
// 用法: node tools/_glbdump.mjs <file.glb> [--deep]
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/_glbdump.mjs <file.glb> [--deep]'); process.exit(1); }
const deep = process.argv.includes('--deep');

const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error('not a GLB'); process.exit(1); }
let off = 12, json = null, bin = null, binLen = 0;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const start = off + 8;
  if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
  else if (type === 0x004e4942) { bin = buf.slice(start, start + len); binLen = len; }
  off = start + len;
}
if (!json) { console.error('no JSON chunk'); process.exit(1); }

const bytes = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log('FILE     :', path.basename(file), bytes(buf.length));
console.log('BIN chunk:', bytes(binLen));
console.log('asset    :', JSON.stringify(json.asset));
console.log('extensionsUsed:', json.extensionsUsed);
console.log('extensionsRequired:', json.extensionsRequired || []);

// ---- VRM 元数据 ----
const ext = json.extensions || {};
if (ext.VRM || ext.VRMC_vrm) {
  const v = ext.VRMC_vrm || ext.VRM;
  console.log('\n=== VRM ===');
  console.log('specVersion:', v.specVersion);
  console.log('meta:', JSON.stringify({
    name: v.meta?.name, version: v.meta?.version, authors: v.meta?.authors,
    licenseUrl: v.meta?.licenseUrl, avatarPermission: v.meta?.avatarPermission,
    allowExceedingAvatarRights: v.meta?.allowExceedingAvatarRights,
    commercialUsage: v.meta?.commercialUsage, allowRedistribution: v.meta?.allowRedistribution,
    modification: v.meta?.modification,
  }));
  if (v.firstPerson?.meshAnnotations) console.log('firstPerson meshes:', v.firstPerson.meshAnnotations.map(a => `${a.node}:${a.type || a.firstPersonFlag}`).join(', '));
  if (v.humanoid?.humanBones) console.log('humanBones:', v.humanoid.humanBones.length);
  if (v.blendShapeMaster?.blendShapeGroups) console.log('vrm blendShapeGroups:', v.blendShapeMaster.blendShapeGroups.length);
}

// ---- scenes / nodes ----
console.log('\n=== NODES ===');
const nodes = json.nodes || [];
const nodeName = (i) => nodes[i]?.name || `#${i}`;
function walk(i, d, out) {
  const n = nodes[i]; if (!n) return;
  out.push(`${'  '.repeat(d)}${i} "${n.name || ''}"${n.mesh != null ? ` [mesh ${n.mesh}]` : ''}${n.skin != null ? ` [skin ${n.skin}]` : ''}${n.camera != null ? ' [camera]' : ''}`);
  (n.children || []).forEach(c => walk(c, d + 1, out));
}
const roots = (json.scenes?.[json.scene ?? 0]?.nodes) || [];
const out = [];
roots.forEach(r => walk(r, 0, out));
console.log(out.join('\n'));

// ---- meshes ----
console.log('\n=== MESHES ===');
const meshes = json.meshes || [];
meshes.forEach((m, mi) => {
  let verts = 0, tris = 0;
  const prims = m.primitives.map((p, pi) => {
    const pos = json.accessors[p.attributes.POSITION];
    const idx = p.indices != null ? json.accessors[p.indices] : null;
    verts += pos.count; tris += (idx ? idx.count : pos.count) / 3;
    const attrs = Object.keys(p.attributes).join(',');
    return `    p${pi} v=${pos.count} idx=${idx ? idx.count : '-'} attrs=[${attrs}] mat=${p.material} mode=${p.mode ?? 4} targets=${p.targets ? p.targets.length : 0}`;
  });
  console.log(`  [${mi}] "${m.name}" verts=${verts} tris=${Math.round(tris)} prims=${m.primitives.length} targets=${m.primitives[0]?.targets?.length || 0}`);
  if (deep) prims.forEach(l => console.log(l));
});

// ---- morph target names ----
const allTargetNames = new Set();
meshes.forEach(m => m.primitives.forEach(p => (p.targetNames || (m.extras?.targetNames) || []).forEach(t => allTargetNames.add(t))));
if (allTargetNames.size) {
  console.log('\n=== MORPH TARGETS (' + allTargetNames.size + ') ===');
  console.log([...allTargetNames].join(' | '));
}

// ---- materials ----
console.log('\n=== MATERIALS ===');
(json.materials || []).forEach((m, i) => {
  const p = m.pbrMetallicRoughness || {};
  const tex = (t) => t != null ? `T${t}` : '-';
  console.log(`  [${i}] "${m.name}" base=${JSON.stringify(p.baseColorFactor)} tex=${tex(p.baseColorTexture?.index)} emissive=${JSON.stringify(m.emissiveFactor)} alpha=${m.alphaMode} double=${m.doubleSided} unlit=${!!m.extensions?.KHR_materials_unlit}`);
});
console.log('  textures:', (json.textures || []).length, ' images:', (json.images || []).length);

// ---- skins ----
console.log('\n=== SKINS ===');
(json.skins || []).forEach((s, i) => {
  console.log(`  [${i}] "${s.name}" joints=${s.joints.length} skeleton=${s.skeleton != null ? nodeName(s.skeleton) : '-'} ibm=${s.inverseBindMatrices}`);
  if (deep) console.log('      ' + s.joints.map(nodeName).join(', '));
});
if (!(json.skins || []).length) console.log('  (no skin —— 静态网格)');

// ---- animations ----
console.log('\n=== ANIMATIONS ===');
(json.animations || []).forEach((a, i) => console.log(`  [${i}] "${a.name}" channels=${a.channels.length} samplers=${a.samplers.length}`));
if (!(json.animations || []).length) console.log('  (none)');

// ---- accessors 明细 ----
if (deep) {
  console.log('\n=== ACCESSORS ===');
  const byUse = {};
  (json.accessors || []).forEach(a => { byUse[a.type] = (byUse[a.type] || 0) + 1; });
  console.log(' ', JSON.stringify(byUse));
}
console.log('\nDONE');

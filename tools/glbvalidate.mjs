// 检查 GLB 里所有索引引用是否越界 —— "Cannot read properties of undefined"
// 这类错误基本都是某个下标指到了被裁掉的数组元素上
import fs from 'node:fs';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = dv.getUint32(off, true), t = dv.getUint32(off + 4, true), s = off + 8;
  if (t === 0x4e4f534a) json = JSON.parse(buf.slice(s, s + len).toString('utf8'));
  else if (t === 0x004e4942) bin = buf.slice(s, s + len);
  off = s + len + ((4 - (len % 4)) % 4);
}
const j = json;
const n = (k) => (j[k] || []).length;
console.log('文件:', file.split(/[\\/]/).pop());
console.log('数组长度: nodes=' + n('nodes') + ' meshes=' + n('meshes') + ' materials=' + n('materials') +
  ' textures=' + n('textures') + ' images=' + n('images') + ' samplers=' + n('samplers') +
  ' accessors=' + n('accessors') + ' bufferViews=' + n('bufferViews') + ' skins=' + n('skins') +
  ' animations=' + n('animations'));

const bad = [];
const chk = (where, idx, arr) => { if (idx == null) return; if (idx < 0 || idx >= n(arr)) bad.push(`${where} = ${idx} 越界（${arr}.length=${n(arr)}）`); };

(j.meshes || []).forEach((m, mi) => (m.primitives || []).forEach((p, pi) => {
  chk(`meshes[${mi}].primitives[${pi}].material`, p.material, 'materials');
  chk(`meshes[${mi}].primitives[${pi}].indices`, p.indices, 'accessors');
  Object.entries(p.attributes || {}).forEach(([k, v]) => chk(`meshes[${mi}].primitives[${pi}].attributes.${k}`, v, 'accessors'));
  (p.targets || []).forEach((t, ti) => Object.entries(t).forEach(([k, v]) => chk(`meshes[${mi}].primitives[${pi}].targets[${ti}].${k}`, v, 'accessors')));
}));
(j.nodes || []).forEach((nd, i) => {
  chk(`nodes[${i}].mesh`, nd.mesh, 'meshes');
  chk(`nodes[${i}].skin`, nd.skin, 'skins');
  (nd.children || []).forEach((c, ci) => chk(`nodes[${i}].children[${ci}]`, c, 'nodes'));
});
(j.skins || []).forEach((s, i) => {
  (s.joints || []).forEach((jn, ji) => chk(`skins[${i}].joints[${ji}]`, jn, 'nodes'));
  chk(`skins[${i}].inverseBindMatrices`, s.inverseBindMatrices, 'accessors');
});
(j.scenes || []).forEach((s, i) => (s.nodes || []).forEach((nn, ni) => chk(`scenes[${i}].nodes[${ni}]`, nn, 'nodes')));
(j.materials || []).forEach((m, i) => {
  const t = m.pbrMetallicRoughness?.baseColorTexture;
  if (t != null) chk(`materials[${i}].baseColorTexture.index`, t.index, 'textures');
  const em = m.emissiveTexture; if (em != null) chk(`materials[${i}].emissiveTexture.index`, em.index, 'textures');
  const nm = m.normalTexture; if (nm != null) chk(`materials[${i}].normalTexture.index`, nm.index, 'textures');
});
(j.textures || []).forEach((t, i) => {
  chk(`textures[${i}].source`, t.source, 'images');
  if (t.sampler != null) chk(`textures[${i}].sampler`, t.sampler, 'samplers');
});
(j.images || []).forEach((im, i) => chk(`images[${i}].bufferView`, im.bufferView, 'bufferViews'));
(j.accessors || []).forEach((a, i) => { if (a.bufferView != null) chk(`accessors[${i}].bufferView`, a.bufferView, 'bufferViews'); });
(j.animations || []).forEach((a, i) => (a.samplers || []).forEach((s, si) => {
  chk(`animations[${i}].samplers[${si}].input`, s.input, 'accessors');
  chk(`animations[${i}].samplers[${si}].output`, s.output, 'accessors');
  (a.channels || []).forEach((c, ci) => chk(`animations[${i}].channels[${ci}].target.node`, c.target?.node, 'nodes'));
}));

// bufferView 越界（数据本身）
(j.bufferViews || []).forEach((bv, i) => {
  if ((bv.byteOffset || 0) + bv.byteLength > bin.length) bad.push(`bufferViews[${i}] 超出 BIN: ${(bv.byteOffset || 0) + bv.byteLength} > ${bin.length}`);
});

console.log(bad.length ? '\n❌ 越界 ' + bad.length + ' 处:\n  ' + bad.slice(0, 25).join('\n  ') : '\n✅ 所有索引引用都在范围内');

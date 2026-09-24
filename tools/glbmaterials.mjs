// 临时：查 kizuna 原始 glb 里 body_geo 两个 primitive 各用什么材质，
// 判断 bodysuit(#0) 是"内衣/打底"还是"可脱的外衣"
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not GLB');
let off = 12, json = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
  off += 12 + len;
}

const lines = [];
const log = (s) => lines.push(s);

log('文件: ' + path.basename(file));
log('meshes: ' + (json.meshes || []).length + '  materials: ' + (json.materials || []).length +
    '  textures: ' + (json.textures || []).length + '  images: ' + (json.images || []).length);

log('\n=== 按 mesh 列材质 ===');
(json.meshes || []).forEach((m, mi) => {
  const prims = (m.primitives || []).map((p, pi) => {
    const mat = p.material != null ? json.materials[p.material] : null;
    const cnt = json.accessors?.[p.attributes?.POSITION]?.count;
    return `#${pi} mat=${p.material}("${mat?.name || ''}") verts=${cnt} targets=${(p.targets || []).length}`;
  });
  log(`${mi} "${m.name}"  prims=${(m.primitives || []).length}  ${prims.join(' | ')}`);
});

log('\n=== materials ===');
(json.materials || []).forEach((m, i) => {
  const pbr = m.pbrMetallicRoughness || {};
  const bc = pbr.baseColorTexture;
  const texIdx = bc?.index;
  const imgIdx = texIdx != null ? json.textures[texIdx]?.source : null;
  const img = imgIdx != null ? json.images[imgIdx] : null;
  log(`${i} "${m.name}"  baseColorTex=${texIdx} srcImg=${imgIdx} "${img?.name || ''}" uri=${img?.uri || img?.mimeType}  doubleSided=${m.doubleSided} alphaMode=${m.alphaMode || 'OPAQUE'}`);
});
log('\n(材质名里出现 cloth / body / skin / tops / skirt 等词，能看出 #0 属于哪一类)');

fs.writeFileSync(process.argv[3] || 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/_mat.txt', lines.join('\n'), 'utf8');
console.log('written');

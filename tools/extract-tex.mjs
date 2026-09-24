// 把 GLB 内嵌贴图抽成独立文件，供肉眼查看
// 用法: node tools/_extract-tex.mjs <file.glb> [outdir]
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const outdir = process.argv[3] || '_tex';
if (!file) { console.error('usage: node tools/_extract-tex.mjs <file.glb> [outdir]'); process.exit(1); }

const buf = fs.readFileSync(file);
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), start = off + 8;
  if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
  else if (type === 0x004e4942) bin = buf.slice(start, start + len);
  off = start + len;
}
fs.mkdirSync(outdir, { recursive: true });

const mimeExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
console.log('images:', (json.images || []).length, ' textures:', (json.textures || []).length);
(json.images || []).forEach((img, i) => {
  const bv = json.bufferViews[img.bufferView];
  const bytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const ext = mimeExt[img.mimeType] || (img.uri ? path.extname(img.uri) : '.bin');
  const out = path.join(outdir, `T${i}${img.name ? '_' + img.name.replace(/[^\w.-]/g, '') : ''}${ext}`);
  fs.writeFileSync(out, bytes);
  console.log(`  [${i}] ${img.name || '-'} ${img.mimeType} ${(bytes.length / 1024).toFixed(0)} KB -> ${out}`);
});
// 每张贴图被哪些材质用
const texUse = {};
(json.materials || []).forEach((m) => {
  const t = m.pbrMetallicRoughness?.baseColorTexture?.index;
  if (t != null) (texUse[t] = texUse[t] || []).push(m.name);
});
console.log('\n贴图 -> 材质:');
Object.entries(texUse).forEach(([t, ms]) => console.log(`  T${t}: ${ms.join(', ')}`));

// 列出 GLB 里所有 morph target，并按"是不是表情"分类。
// 目的：判断 MakeHuman 本体到底有没有可用来做眨眼/微表情的 blendshape。
import fs from 'node:fs';
import path from 'node:path';

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB: ' + file);
  let off = 12, json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    off = start + len;
  }
  return json;
}

const file = process.argv[2] || 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-base-mh.glb';
const json = readGlb(file);
console.log('== ' + path.basename(file) + ' ==');
for (const m of json.meshes) {
  const names = m.extras?.targetNames || [];
  console.log(`\n网格 ${m.name}: 顶点 ${json.accessors[m.primitives[0].attributes.POSITION].count}, morph ${names.length} 个`);
  // 按前缀分组，看得出是不是一整類 repertoire
  const kw = {
    '体型/身高': /height|length|circ|waist|hip|thigh|weight|muscle|vshape|torso/i,
    '头/脸比例': /head|face|forehead|chin|jaw|cheek|neck|nose|mouth|eye|ear|lip|philtrum/i,
    '明显表情': /blink|smile|frown|widen|open|close|pout|grin|squint|express|brow/i,
  };
  const rest = [...names];
  for (const [label, re] of Object.entries(kw)) {
    const hit = rest.filter((n) => re.test(n));
    if (hit.length) { console.log(`  ${label}(${hit.length}): ${hit.join(' ')}`); hit.forEach(h => rest.splice(rest.indexOf(h), 1)); }
  }
  if (rest.length) console.log(`  其他(${rest.length}): ${rest.join(' ')}`);
  console.log('  —— 全名单 ——');
  console.log('  ' + names.join(' '));
}

// 比对一批 GLB 的拓扑指纹：顶点数 / primitive 数 / blendshape 名称集合。
// 指纹一致 = 同一套基础人体派生出来的，体态滑块才有可能做在它们之上。
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const pattern = process.argv[3] || 'realistic-';
const outFile = process.argv[4];

function readGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) return null;
  let off = 12, json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    off += 12 + len;
  }
  return json;
}

function fingerprint(json) {
  let verts = 0, prims = 0;
  const targets = new Set();
  for (const m of json.meshes || []) {
    for (const p of m.primitives || []) {
      prims++;
      const pos = json.accessors?.[p.attributes?.POSITION];
      verts += pos?.count || 0;
      const names = p.extras?.targetNames || [];
      for (const n of names) targets.add(n);
    }
  }
  return { verts, prims, targets };
}

const lines = [];
const log = (s) => { lines.push(s); };

const files = fs.readdirSync(dir).filter((f) => f.startsWith(pattern) && f.endsWith('.glb')).sort();
log(`扫描 ${dir}\\${pattern}*.glb —— 共 ${files.length} 个\n`);
log('文件'.padEnd(26) + '顶点'.padStart(8) + 'prim'.padStart(6) + 'blendshape'.padStart(12) + '  指纹');
log('-'.repeat(90));

const seen = new Map();
for (const f of files) {
  const json = readGLB(path.join(dir, f));
  if (!json) { log(f.padEnd(26) + '  (非 GLB)'); continue; }
  const fp = fingerprint(json);
  const names = [...fp.targets].sort();
  const key = `${fp.verts}|${fp.prims}|${names.join(',')}`;
  const short = (names.length ? names.slice(0, 2).join('+') + '…' : '(无)');
  log(f.padEnd(26) + String(fp.verts).padStart(8) + String(fp.prims).padStart(6) + String(fp.targets.size).padStart(12) + '  ' + short);
  if (!seen.has(key)) seen.set(key, []);
  seen.get(key).push(f);
}

log('');
log(`不同拓扑指纹：${seen.size} 种`);
let i = 0;
for (const [key, group] of seen) {
  const [verts, prims, names] = [key.split('|')[0], key.split('|')[1], key.split('|')[2]];
  log(`\n  指纹 #${++i}: 顶点=${verts} prim=${prims} blendshape 数=${names ? names.split(',').length : 0}`);
  log(`  成员 ${group.length} 个: ${group.join(', ')}`);
  if (group.length > 1) log(`  → 拓扑一致，可以互相变形（生态滑块能做）`);
}

fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log('written ' + outFile);

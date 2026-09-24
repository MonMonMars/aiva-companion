// mhproxy-diag.mjs —— 拟合结果体检：找出跑飞的顶点，并打印它引用的底模顶点在哪
// 用法: node tools/mhproxy-diag.mjs --mhclo <file> [--low N] [--high N]
import fs from 'node:fs';
import path from 'node:path';

const argv = (k, def) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : def; };
const SRC = argv('src', 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data');
const MH = argv('mhclo', '');
if (!MH) { console.log('需要 --mhclo'); process.exit(1); }
const LOW = Number(argv('low', 8)), HIGH = Number(argv('high', 3));

// 底模
const txt = fs.readFileSync(path.join(SRC, '3dobjs/base.obj'), 'utf8');
const pos = []; let group = null;
const trisP = [];
for (const raw of txt.split('\n')) {
  const line = raw.trim();
  if (!line || line[0] === '#') continue;
  if ((line[0] === 'o' || line[0] === 'g') && line[1] === ' ') { group = line.slice(2).trim(); continue; }
  if (line[0] === 'v' && line[1] === ' ') { const a = line.slice(2).trim().split(/\s+/); pos.push(+a[0], +a[1], +a[2]); }
  else if (line[0] === 'f' && line[1] === ' ') { if (group !== 'body') continue; const t = line.slice(2).trim().split(/\s+/).map((x) => x.split('/')); for (let i = 1; i < t.length - 1; i++) for (const k of [0, i, i + 1]) trisP.push(+t[k][0]); }
}
const nSrc = pos.length / 3;
let lo = Infinity, hi = -Infinity;
for (const v of trisP) { const y = pos[(v - 1) * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
const S = 1.70 / (hi - lo), yOff = lo * S;
const toM = (v, i) => [v[0] * S, v[1] * S - yOff, v[2] * S][i];
console.log(`底模 ${nSrc} 顶点  S=${S.toFixed(6)}`);

// mhclo
const lines = fs.readFileSync(MH, 'utf8').split(/\r?\n/);
const scale = [null, null, null];
const verts = [];
let inV = false, objFile = null;
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line[0] === '#') continue;
  const w = line.split(/\s+/);
  if (w[0] === 'obj_file') { objFile = w[1]; continue; }
  if (w[0] === 'x_scale') { scale[0] = [+w[1], +w[2], +w[3]]; continue; }
  if (w[0] === 'y_scale') { scale[1] = [+w[1], +w[2], +w[3]]; continue; }
  if (w[0] === 'z_scale') { scale[2] = [+w[1], +w[2], +w[3]]; continue; }
  if (w[0] === 'verts') { inV = true; continue; }
  if (/^[a-z_]+$/.test(w[0])) { inV = false; continue; }
  if (inV && w.length >= 9) verts.push([+w[0], +w[1], +w[2], +w[3], +w[4], +w[5], +w[6], +w[7], +w[8]]);
}
console.log(`mhclo verts ${verts.length}  obj ${objFile}  scale ${JSON.stringify(scale)}`);

const sd = [1, 1, 1];
for (let n = 0; n < 3; n++) {
  const s = scale[n]; if (!s) continue;
  sd[n] = Math.abs(pos[s[0] * 3 + n] - pos[s[1] * 3 + n]) / s[2];
}
console.log(`拟合缩放 ${sd.map((x) => x.toFixed(4))}`);

const rows = [];
for (let i = 0; i < verts.length; i++) {
  const [b0, b1, b2, w0, w1, w2, dx, dy, dz] = verts[i];
  const bad = [b0, b1, b2].some((b) => !(b >= 0 && b < nSrc));
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) c[k] = w0 * pos[b0 * 3 + k] + w1 * pos[b1 * 3 + k] + w2 * pos[b2 * 3 + k];
  c[0] += sd[0] * dx; c[1] += sd[1] * dy; c[2] += sd[2] * dz;
  rows.push({ i, y: c[1] * S - yOff, x: c[0] * S, z: c[2] * S, b: [b0, b1, b2], w: [w0, w1, w2], bad });
}
const ys = rows.map((r) => r.y);
console.log(`拟合后 Y 范围 ${Math.min(...ys).toFixed(4)} .. ${Math.max(...ys).toFixed(4)}  (米)`);
console.log(`越界底模索引的顶点数: ${rows.filter((r) => r.bad).length}`);

const sorted = [...rows].sort((a, b) => a.y - b.y);
console.log(`\n--- 最低的 ${LOW} 个顶点 ---`);
for (const r of sorted.slice(0, LOW)) {
  const bp = r.b.map((b) => (b >= 0 && b < nSrc)
    ? `[${pos[b * 3].toFixed(2)},${pos[b * 3 + 1].toFixed(2)},${pos[b * 3 + 2].toFixed(2)}]@${(pos[b * 3 + 1] * S - yOff).toFixed(3)}m`
    : `OOR(${b})`);
  console.log(`#${r.i}  y=${r.y.toFixed(4)} x=${r.x.toFixed(4)} z=${r.z.toFixed(4)}`);
  console.log(`     w=${r.w.map((v) => v.toFixed(3))}  baseY(m)=${bp.join(' ')}`);
}
console.log(`\n--- 最高的 ${HIGH} 个顶点 ---`);
for (const r of sorted.slice(-HIGH)) console.log(`#${r.i}  y=${r.y.toFixed(4)} x=${r.x.toFixed(4)} z=${r.z.toFixed(4)}`);

// 只看被引用到的底模顶点的 Y 分布
const used = new Set();
for (const r of rows) for (const b of r.b) if (b >= 0 && b < nSrc) used.add(b);
const uy = [...used].map((b) => pos[b * 3 + 1] * S - yOff);
console.log(`\n引用的底模顶点 ${used.size} 个，它们的 Y ${Math.min(...uy).toFixed(4)} .. ${Math.max(...uy).toFixed(4)}`);
const far = [...used].filter((b) => Math.abs(pos[b * 3 + 1] * S - yOff - 1.5768) > 0.05);
console.log(`距离眼高 >5cm 的底模顶点 ${far.length} 个：` + far.slice(0, 20).map((b) => `${b}@${(pos[b * 3 + 1] * S - yOff).toFixed(3)}`).join(' '));

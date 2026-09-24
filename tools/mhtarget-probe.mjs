// mhtarget-probe.mjs —— target 原始平滑度 + 覆盖率探针
// 目的：判断「滑块撕模特」是 MakeHuman 原始数据的问题，还是我们转换丢顶点。
// 完全绕开 GLB，直接在 base.obj 的源顶点空间里算邻接。
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const nArgs = process.argv.slice(2);
const ONLY = nArgs.length ? nArgs[0] : null;

// ---- base.obj（只要 body 组的面，用于建邻接）----
const txt = fs.readFileSync(path.join(SRC, '3dobjs/base.obj'), 'utf8');
const pos = [];
let group = null;
const faces = [];
for (const raw of txt.split('\n')) {
  const line = raw.trim();
  if (!line || line[0] === '#') continue;
  const c0 = line[0], c1 = line[1];
  if (c0 === 'o' || c0 === 'g') { if (c1 === ' ') group = line.slice(2).trim(); continue; }
  if (c0 === 'v' && c1 === ' ') { const a = line.slice(2).trim().split(/\s+/); pos.push(+a[0], +a[1], +a[2]); }
  else if (c0 === 'f' && c1 === ' ') {
    const toks = line.slice(2).trim().split(/\s+/).map((t) => +t.split('/')[0]);
    for (let i = 1; i < toks.length - 1; i++) faces.push([group, toks[0], toks[i], toks[i + 1]]);
  }
}
const nSrc = pos.length / 3;
const bodyFaces = faces.filter((f) => f[0] === 'body');
console.log(`base.obj: ${nSrc} 顶点；全部面 ${faces.length}；body 组面 ${bodyFaces.length}`);
console.log('出现的组: ' + [...new Set(faces.map((f) => f[0]))].join(', '));

// body 组用到了哪些源顶点
const used = new Set();
for (const f of bodyFaces) { used.add(f[1]); used.add(f[2]); used.add(f[3]); }
console.log(`body 组用到的顶点 ${used.size} / ${nSrc}（没用到的 ${nSrc - used.size}）`);

// 邻接（源顶点空间）
const nbr = Array.from({ length: nSrc }, () => new Set());
for (const f of bodyFaces) {
  nbr[f[1] - 1].add(f[2] - 1); nbr[f[2] - 1].add(f[1] - 1);
  nbr[f[2] - 1].add(f[3] - 1); nbr[f[3] - 1].add(f[2] - 1);
  nbr[f[1] - 1].add(f[3] - 1); nbr[f[3] - 1].add(f[1] - 1);
}

function parseTarget(rel) {
  const fp = path.join(SRC, 'targets', rel + '.target');
  if (!fs.existsSync(fp)) return null;
  const m = new Map();
  for (const raw of fs.readFileSync(fp, 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    const a = l.split(/\s+/);
    m.set(+a[0], [+a[1], +a[2], +a[3]]);
  }
  return m;
}

function analyse(name, rel) {
  const t = parseTarget(rel);
  if (!t) { console.log(`  ${name.padEnd(16)} 缺文件`); return; }
  const D = new Float32Array(nSrc * 3);
  let outRange = 0, unused = 0;
  for (const [vi, d] of t) {
    if (vi >= nSrc) { outRange++; continue; }
    if (!used.has(vi + 1)) unused++;
    D[vi * 3] = d[0]; D[vi * 3 + 1] = d[1]; D[vi * 3 + 2] = d[2];
  }
  let maxMag = 0;
  for (let i = 0; i < nSrc; i++) {
    const m = Math.hypot(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]);
    if (m > maxMag) maxMag = m;
  }
  // 洞 = 自己不动、但邻居平均在动（动得还不小）
  let holes = 0, worstStep = 0;
  const thr = maxMag * 0.15;
  for (let i = 0; i < nSrc; i++) {
    if (!nbr[i].size) continue;
    const own = Math.hypot(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]);
    let ax = 0, ay = 0, az = 0, n = 0;
    for (const j of nbr[i]) { ax += D[j * 3]; ay += D[j * 3 + 1]; az += D[j * 3 + 2]; n++; }
    const avg = Math.hypot(ax / n, ay / n, az / n);
    if (own < thr * 0.2 && avg > thr) holes++;
    const step = Math.abs(avg - own);
    if (step > worstStep) worstStep = step;
  }
  console.log(`  ${name.padEnd(16)} 覆盖 ${String(t.size).padStart(6)} 顶点  最大位移 ${maxMag.toFixed(4)}  孤立洞 ${String(holes).padStart(5)}  邻居落差 ${worstStep.toFixed(4)}  越界 ${outRange}  未用顶点 ${unused}`);
}

console.log('\n=== target 原始平滑度 ===');
const set = ONLY ? [[ONLY, ONLY]] : [
  ['head-oval', 'head/head-oval'],
  ['head-square', 'head/head-square'],
  ['universal-female-young...', 'macrodetails/universal-female-young-maxmuscle-averageweight'],
  ['breast-size', 'breast/female-young-averagemuscle-averageweight-breast-increase-size'],
  ['height', 'macrodetails/height/female-young-averagemuscle-averageweight-increase-height'],
  ['muscle', 'armslegs/armslegs-muscle-incr'],
];
for (const [n, r] of set) analyse(n, r);

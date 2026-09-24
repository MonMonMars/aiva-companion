// mheye-sign.mjs —— 定出「源 UV 增长方向」与「眼球局部几何方向」的对应关系
// ===========================================================================
// 背景：源网格两颗球共用同一套 UV，而且左球的 UV 落在贴图的**左下**素材球上、
//       右球落在**右上**。我之前靠"看起来对不对"改符号，来回翻了 3 次。
//       这次不猜，直接做数值验证：
//
//   把每个顶点的「球面局部方向 (nx,ny,nz)」和它的「UV 相对虹膜中心的偏移
//   (du,dv)」配对，求相关系数。若 |corr| 接近 1，说明 uv 与球面方向是
//   线性同向（正号）或反向（负号），据此决定是否要翻符号。
//
//   另外输出「按论文式重映射后，UV 落在 [0,1] 内的比例」，作为最终判据。
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
function parseOBJ(file) {
  const V = [], VT = []; const groups = {}; let g = '__default';
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim(); if (!l || l[0] === '#') continue;
    if ((l[0] === 'o' || l[0] === 'g') && l[1] === ' ') { g = l.slice(2).trim(); continue; }
    if (l.startsWith('v ')) V.push(l.slice(2).trim().split(/\s+/).map(Number));
    else if (l.startsWith('vt ')) VT.push(l.slice(3).trim().split(/\s+/).map(Number));
    else if (l.startsWith('f ')) {
      const tk = l.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      const gg = groups[g] || (groups[g] = { tris: [], uvs: [] });
      for (let i = 1; i < tk.length - 1; i++)
        for (const k of [0, i, i + 1]) { gg.tris.push(+tk[k][0] - 1); gg.uvs.push(tk[k][1] ? +tk[k][1] - 1 : -1); }
    }
  }
  return { V, VT, groups };
}
const e = parseOBJ(path.join(SRC, 'eyes/high-poly/high-poly.obj'));
const g = e.groups.__default;
const all = [...new Set(g.tris)];
const cl = (s) => {
  const vs = all.filter((i) => (s < 0 ? e.V[i][0] < 0 : e.V[i][0] >= 0));
  let c = [0, 0, 0]; for (const i of vs) for (let k = 0; k < 3; k++) c[k] += e.V[i][k];
  c = c.map((x) => x / vs.length); return { c, vs };
};
const L = cl(-1), R = cl(+1);

// 每颗球的正极点（nz 最大）的 UV，用来定虹膜中心
function pole(clu) {
  let best = null;
  for (const i of clu.vs) {
    const v = e.V[i];
    const d = [v[0] - clu.c[0], v[1] - clu.c[1], v[2] - clu.c[2]];
    const r = Math.hypot(...d) || 1;
    const nz = d[2] / r;
    if (!best || nz > best.nz) best = { i, nz, n: [d[0] / r, d[1] / r, d[2] / r] };
  }
  let ui = -1;
  for (let t = 0; t < g.tris.length; t++) if (g.tris[t] === best.i) { ui = g.uvs[t]; break; }
  return { ...best, uv: ui >= 0 ? e.VT[ui] : null, ui };
}
const pl = pole(L), pr = pole(R);
console.log(`左球正极点 v${pl.i} n=(${pl.n.map(x => x.toFixed(4))}) srcUV=(${pl.uv[0].toFixed(4)}, ${pl.uv[1].toFixed(4)})`);
console.log(`右球正极点 v${pr.i} n=(${pr.n.map(x => x.toFixed(4))}) srcUV=(${pr.uv[0].toFixed(4)}, ${pr.uv[1].toFixed(4)})`);

const corr = (a, b) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
  return sab / Math.sqrt(sa * sb || 1e-12);
};

for (const [nm, clu, poleUv] of [['左(-X)', L, pl.uv], ['右(+X)', R, pr.uv]]) {
  // 只取前半球顶点（nz>0.25），且取出它们各自的 UV
  const nx = [], ny = [], du = [], dv = [];
  for (const i of clu.vs) {
    const v = e.V[i];
    const d = [v[0] - clu.c[0], v[1] - clu.c[1], v[2] - clu.c[2]];
    const r = Math.hypot(...d) || 1;
    const n = [d[0] / r, d[1] / r, d[2] / r];
    if (n[2] < 0.25) continue;
    let ui = -1;
    for (let t = 0; t < g.tris.length; t++) if (g.tris[t] === i) { ui = g.uvs[t]; break; }
    if (ui < 0) continue;
    const uv = e.VT[ui];
    // UV 接缝：u 与虹膜中心相差超过 0.5 的，说明绕到另一侧了，跳过
    if (Math.abs(uv[0] - poleUv[0]) > 0.45) continue;
    nx.push(n[0]); ny.push(n[1]);
    du.push(uv[0] - poleUv[0]); dv.push(uv[1] - poleUv[1]);
  }
  console.log(`\n${nm} 样本 ${nx.length} 个（nz>0.25 且非接缝）`);
  console.log(`  corr(nx, du) = ${corr(nx, du).toFixed(4)}    ← |值|≈1 表示同向/反向，符号决定要不要翻`);
  console.log(`  corr(ny, dv) = ${corr(ny, dv).toFixed(4)}`);
  console.log(`  corr(ny, du) = ${corr(ny, du).toFixed(4)}    ← 应当 ≈0（说明没有旋转）`);
  console.log(`  corr(nx, dv) = ${corr(nx, dv).toFixed(4)}    ← 应当 ≈0`);
  // 半径比例：UV 距离 / 球面方向投影距离
  let sRU = 0, sRN = 0;
  for (let i = 0; i < nx.length; i++) {
    sRU += Math.hypot(du[i], dv[i]);
    sRN += Math.hypot(nx[i], ny[i]);
  }
  const k = (sRU / nx.length) / (sRN / nx.length);
  console.log(`  UV/几何 半径比 ≈ ${k.toFixed(4)}  → 角膜缘对应 UV 半径 ${(k * 0.55).toFixed(4)}（取 nz 视在半径 R=0.55）`);
}

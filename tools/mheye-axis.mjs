// mheye-axis.mjs —— 量出每只眼「虹膜方向」与「眼球局部 +Z」的关系
// ===========================================================================
// 现象：眼睛绑上以后虹膜偏到外侧，正面看到眼白。
// 怀疑：源 OBJ 里那颗球的"注视方向"并不是 +Z（我前面一直假设是 +Z）。
// 这次不假设，直接把「源 UV 里落在虹膜盘内的那些顶点」挑出来，
// 求它们的**球面平均方向**——那就是虹膜朝向，用它定义"正前方"。
//
// 另外顺便量一下眼睑（helper-l/r-eyelid）的朝向，判断"上下"对不对。
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './pngutil.mjs';

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

const eyeObj = parseOBJ(path.join(SRC, 'eyes/high-poly/high-poly.obj'));
const g = eyeObj.groups.__default;
const all = [...new Set(g.tris)];
const cl = (s) => {
  const vs = all.filter((i) => (s < 0 ? eyeObj.V[i][0] < 0 : eyeObj.V[i][0] >= 0));
  let c = [0, 0, 0]; for (const i of vs) for (let k = 0; k < 3; k++) c[k] += eyeObj.V[i][k];
  return { c: c.map((x) => x / vs.length), vs };
};
const L = cl(-1), R = cl(+1);

// 贴图两颗素材球的虹膜中心（整图 UV，实测于 mheye-measure.mjs）
const IRIS = [[0.70465, 0.29678], [0.28867, 0.70885]];
const IRIS_R = 0.108;

// 顶点 → uv（每顶点取它第一个出现的 uv；接缝顶点会被 u 跳变影响，稍后过滤）
function vmap(clu) {
  const m = new Map();
  for (let t = 0; t < g.tris.length; t++) {
    const vi = g.tris[t]; if (!clu.vs.includes(vi)) continue;
    if (!m.has(vi)) m.set(vi, eyeObj.VT[g.uvs[t]]);
  }
  return m;
}

console.log('每颗球的球心与半径：');
for (const [nm, clu] of [['左(-X)', L], ['右(+X)', R]]) {
  const r = Math.max(...clu.vs.map((i) => Math.hypot(eyeObj.V[i][0] - clu.c[0], eyeObj.V[i][1] - clu.c[1], eyeObj.V[i][2] - clu.c[2])));
  console.log(`  ${nm} c=(${clu.c.map((x) => x.toFixed(4))}) r=${r.toFixed(4)}`);
}

console.log('\n虹膜朝向（把 UV 落在虹膜盘内的顶点，求球面方向均值）：');
for (const [nm, clu] of [['左(-X)', L], ['右(+X)', R]]) {
  const m = vmap(clu);
  for (const [ic, irisUv] of IRIS.entries()) {
    const dirs = [];
    for (const [vi, uv] of m) {
      const d = Math.hypot(uv[0] - irisUv[0], uv[1] - irisUv[1]);
      if (d > IRIS_R) continue;
      if (Math.abs(uv[0] - irisUv[0]) > 0.5) continue;  // 排除接缝跳变
      const v = eyeObj.V[vi];
      const dd = [v[0] - clu.c[0], v[1] - clu.c[1], v[2] - clu.c[2]];
      const r = Math.hypot(...dd) || 1;
      dirs.push([dd[0] / r, dd[1] / r, dd[2] / r]);
    }
    if (!dirs.length) { console.log(`  ${nm} ↔ 素材球${ic}: 无样本（该球 UV 不落在这颗素材上）`); continue; }
    const s = [0, 0, 0];
    for (const d of dirs) for (let k = 0; k < 3; k++) s[k] += d[k];
    const L2 = Math.hypot(...s) || 1;
    const avg = s.map((x) => x / L2);
    console.log(`  ${nm} ↔ 素材球${ic}: ${dirs.length} 样本  虹膜方向 (${avg.map((x) => x.toFixed(4)).join(', ')})  |合成量| ${(L2 / dirs.length).toFixed(3)}`);
  }
}

// 顺便量眼睑方向：helper-l-eye / r-eye 与 l/r-eyelid 相对球心的方向
const { V: bV, groups: bG } = parseOBJ(path.join(SRC, '3dobjs/base.obj'));
function partCentroid(name) {
  const gg = bG[name]; if (!gg) return null;
  const idx = [...new Set(gg.tris)];
  const c = [0, 0, 0]; for (const i of idx) for (let k = 0; k < 3; k++) c[k] += bV[i][k];
  return c.map((x) => x / idx.length);
}
console.log('\n头部辅助件质心（判断眼睛在脸上的朝向）：');
for (const n of ['helper-l-eye', 'helper-r-eye', 'helper-l-eyelid', 'helper-r-eyelid', 'helper-nose', 'helper-tongue']) {
  const c = partCentroid(n);
  if (c) console.log(`  ${n.padEnd(18)} (${c.map((x) => x.toFixed(3)).join(', ')})`);
}

// mheye-map.mjs —— 判定「源网格每颗球的 UV 落在贴图哪颗素材球上」+ 求虹膜朝向
// ===========================================================================
// 前面几轮全错在一个隐含假设上：我以为 UV 一定落在两个虹膜圆盘之内。
// 实测「无样本」→ 说明根本不是。所以改用**最近距离归属**：
//   · 对每个顶点，量它到两颗素材球虹膜中心的 UV 距离 d0 / d1
//   · 谁近就归谁（这就是"这颗顶点的 UV 画在哪颗素材球上"）
//   · 再看 d 的分布：如果 |d| 集中在 < 0.31（素材球半径），说明归属可靠
// 然后对每颗球、每个归属组，求「球面方向均值」= 虹膜朝向。
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
  return { c: c.map((x) => x / vs.length), vs };
};
const L = cl(-1), R = cl(+1);

// 每颗球的**全部** (顶点, uv) 对（保留接缝 → 同一顶点多个 uv）
const pairs = (clu) => {
  const out = [];
  for (let t = 0; t < g.tris.length; t++) {
    const vi = g.tris[t];
    if (!clu.vs.includes(vi)) continue;
    out.push({ vi, uv: e.VT[g.uvs[t]] });
  }
  return out;
};

const IRIS = { A: [0.70465, 0.29678], B: [0.28867, 0.70885] };  // A=右上素材球, B=左下素材球

console.log('=== 源网格 UV 的整体范围（判定有没有"绕圈"）===');
for (const [nm, clu] of [['左(-X)', L], ['右(+X)', R]]) {
  const ps = pairs(clu);
  let u0 = 9, u1 = -9, v0 = 9, v1 = -9;
  for (const p of ps) { u0 = Math.min(u0, p.uv[0]); u1 = Math.max(u1, p.uv[0]); v0 = Math.min(v0, p.uv[1]); v1 = Math.max(v1, p.uv[1]); }
  console.log(`  ${nm}: u ${u0.toFixed(4)}..${u1.toFixed(4)}  v ${v0.toFixed(4)}..${v1.toFixed(4)}  （${ps.length} 个 uv 实例）`);
}

console.log('\n=== 最近距离归属 ===');
for (const [nm, clu] of [['左(-X)', L], ['右(+X)', R]]) {
  const ps = pairs(clu);
  const groups = { A: [], B: [] };
  for (const p of ps) {
    const dA = Math.hypot(p.uv[0] - IRIS.A[0], p.uv[1] - IRIS.A[1]);
    const dB = Math.hypot(p.uv[0] - IRIS.B[0], p.uv[1] - IRIS.B[1]);
    groups[dA < dB ? 'A' : 'B'].push({ ...p, d: Math.min(dA, dB) });
  }
  for (const k of ['A', 'B']) {
    const gs = groups[k];
    if (!gs.length) { console.log(`  ${nm} → 素材球${k}: 0 个`); continue; }
    const ds = gs.map((x) => x.d).sort((a, b) => a - b);
    // 球面方向均值
    const s = [0, 0, 0];
    for (const x of gs) {
      const v = e.V[x.vi];
      const dd = [v[0] - clu.c[0], v[1] - clu.c[1], v[2] - clu.c[2]];
      const r = Math.hypot(...dd) || 1;
      s[0] += dd[0] / r; s[1] += dd[1] / r; s[2] += dd[2] / r;
    }
    const Ln = Math.hypot(...s) || 1;
    console.log(`  ${nm} → 素材球${k}: ${gs.length} 个   UV 距离 中位 ${ds[ds.length >> 1].toFixed(4)}  P90 ${ds[Math.floor(ds.length * 0.9)].toFixed(4)}  最大 ${ds[ds.length - 1].toFixed(4)}`);
    console.log(`      球面方向均值 (${(s[0] / Ln).toFixed(4)}, ${(s[1] / Ln).toFixed(4)}, ${(s[2] / Ln).toFixed(4)})  凝聚度 ${(Ln / gs.length).toFixed(3)}`);
  }
}

// 关键：直接检验「+Z 方向顶点的 UV」离两颗素材球虹膜中心有多远
console.log('\n=== 正前方(+Z)顶点的 UV 归属 ===');
for (const [nm, clu] of [['左(-X)', L], ['右(+X)', R]]) {
  const ps = pairs(clu);
  // 按 nz 排序取前 40 个 uv 实例
  const scored = ps.map((p) => {
    const v = e.V[p.vi];
    const dd = [v[0] - clu.c[0], v[1] - clu.c[1], v[2] - clu.c[2]];
    const r = Math.hypot(...dd) || 1;
    return { ...p, n: [dd[0] / r, dd[1] / r, dd[2] / r] };
  }).sort((a, b) => b.n[2] - a.n[2]);
  const top = scored.slice(0, 40);
  let dA = 0, dB = 0;
  for (const p of top) {
    dA += Math.hypot(p.uv[0] - IRIS.A[0], p.uv[1] - IRIS.A[1]);
    dB += Math.hypot(p.uv[0] - IRIS.B[0], p.uv[1] - IRIS.B[1]);
  }
  console.log(`  ${nm}: 前 40 个 +Z 顶点  到素材A 平均距离 ${(dA / 40).toFixed(4)}  到素材B ${(dB / 40).toFixed(4)}  → 属于 ${dA < dB ? 'A' : 'B'}`);
  console.log(`      uv 范围 u ${Math.min(...top.map(p => p.uv[0])).toFixed(4)}..${Math.max(...top.map(p => p.uv[0])).toFixed(4)}  v ${Math.min(...top.map(p => p.uv[1])).toFixed(4)}..${Math.max(...top.map(p => p.uv[1])).toFixed(4)}`);
}

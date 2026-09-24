// mheye-sign2.mjs —— 用逐三角形角度散度定符号（比相关系数稳）
// ===========================================================================
// 上一个脚本用相关系数，左球只有 0.26（不可信）。原因：左球的 UV 接缝落在
// 正前方附近，过滤掉接缝顶点后剩下的样本在 u 方向被压缩得很厉害。
// 这次换更鲁棒的判据：
//   对每个小三角形，取它「球面切平面上的方向向量」和「UV 空间的方向向量」，
//   两者的夹角在「正确映射」下应当接近 0°；符号错了会接近 180°。
//   再对面积加权统计 0°/180° 的票数。
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

function poleUV(clu) {
  let bi = -1, bz = -2;
  for (const i of clu.vs) {
    const v = e.V[i]; const d = [v[0] - clu.c[0], v[1] - clu.c[1], v[2] - clu.c[2]];
    const nz = d[2] / (Math.hypot(...d) || 1);
    if (nz > bz) { bz = nz; bi = i; }
  }
  for (let t = 0; t < g.tris.length; t++) if (g.tris[t] === bi) return { i: bi, uv: e.VT[g.uvs[t]] };
  return { i: bi, uv: null };
}
const pl = poleUV(L), pr = poleUV(R);

// 顶点 -> UV、顶点 -> 球面局部方向
function lookup(clu) {
  const map = new Map();
  for (const i of clu.vs) {
    let ui = -1;
    for (let t = 0; t < g.tris.length; t++) if (g.tris[t] === i) { ui = g.uvs[t]; break; }
    if (ui < 0) continue;
    const v = e.V[i]; const d = [v[0] - clu.c[0], v[1] - clu.c[1], v[2] - clu.c[2]];
    const r = Math.hypot(...d) || 1;
    map.set(i, { uv: e.VT[ui], n: [d[0] / r, d[1] / r, d[2] / r] });
  }
  return map;
}

for (const [nm, clu, pole, wantLeft] of [['左(-X)', L, pl, true], ['右(+X)', R, pr, false]]) {
  const m = lookup(clu);
  // 球面切平面基（以 +Z 为注视方向）：x 向右、y 向上
  //   t_x = normalize(d(n)/d(nx) 方向)  —— 对 +Z 注视，tangent_x = (1,0,0), tangent_y = (0,1,0)
  let voteSame = 0, voteFlip = 0, n = 0, accRatioSame = 0, accRatioFlip = 0;
  for (let t = 0; t < g.tris.length; t += 3) {
    const ia = g.tris[t], ib = g.tris[t + 1], ic = g.tris[t + 2];
    if (!m.has(ia) || !m.has(ib) || !m.has(ic)) continue;
    const A = m.get(ia), B = m.get(ib), C = m.get(ic);
    // 几何方向：取 x 分量（水平方向），用 (B.x - C.x) 作为"水平边"，
    //   但在球面上 x 分量在极点附近退化，所以改用**切平面投影**：
    //   把 (B.n - A.n) 投影到切平面上，得到水平/垂直分量
    const gd = [B.n[0] - A.n[0], B.n[1] - A.n[1], B.n[2] - A.n[2]];
    // 垂直分量（用 n 与 y 的关系），水平分量直接用 x 差
    const gx = gd[0];                       // 水平方向（世界 X，与眼球局部 X 一致）
    const uvd = [B.uv[0] - A.uv[0], B.uv[1] - A.uv[1]];
    if (Math.abs(gx) < 1e-4 || Math.hypot(...uvd) < 1e-6) continue;
    const ratio = uvd[0] / gx;
    if (!isFinite(ratio)) continue;
    n++;
    if (ratio > 0) { voteSame++; accRatioSame += ratio; } else { voteFlip++; accRatioFlip += -ratio; }
  }
  console.log(`\n${nm}  正极点 srcUV=(${pole.uv[0].toFixed(4)}, ${pole.uv[1].toFixed(4)})`);
  console.log(`  du/dgx 为正（同向）的三角形 ${voteSame}，为负（反向）的 ${voteFlip}`);
  console.log(`  → 符号判定：${voteSame > voteFlip ? '不翻（+）' : '要翻（−）'}`);
  console.log(`  平均 |du/dgx| = ${((accRatioSame + accRatioFlip) / n).toFixed(4)}  （= UV 半径 / 几何半径）`);

  // v 方向同理
  let vs2 = 0, vf = 0, acc2 = 0, n2 = 0;
  for (let t = 0; t < g.tris.length; t += 3) {
    const ia = g.tris[t], ib = g.tris[t + 1], ic = g.tris[t + 2];
    if (!m.has(ia) || !m.has(ib) || !m.has(ic)) continue;
    const A = m.get(ia), B = m.get(ib);
    const gy = B.n[1] - A.n[1];
    const dv = B.uv[1] - A.uv[1];
    if (Math.abs(gy) < 1e-4 || Math.abs(dv) < 1e-6) continue;
    // glTF: v 向下为正（图片第一行 = v 0），世界 Y 向上，所以"正确"时 dv/gy 应为 **负**
    const r = dv / gy;
    n2++; if (r < 0) { vs2++; acc2 += -r; } else vf++;
  }
  console.log(`  v: dv/dgy 为负（= 贴图上下翻转，符合 glTF 约定）的 ${vs2}，正的 ${vf}`);
  console.log(`  → v 符号：${vs2 > vf ? 'v_src - v_iris（本就翻好）' : 'v_iris - v_src'}`);
}

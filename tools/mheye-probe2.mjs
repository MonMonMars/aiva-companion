// mheye-probe2.mjs —— 用「UV 质心」定半球归属 + 定虹膜朝向
// ===========================================================================
// 上一版探针（mheye-probe.mjs）踩的坑，记录在此：
//   ① 贴图 brown_eye.png 右下角有一个**纯黑圆盘标记**，被暗像素聚类吃了进去，
//      导致瞳孔中心算出来是 (0.47,0.52)/(0.53,0.47) 这种一看就不对的值。
//   ② 贴图上是**两个完整眼球**（瞳孔+虹膜+眼白+血丝），不是"一块虹膜贴图"。
//      所以「把瞳孔 UV 反查回 3D 求虹膜轴」这个方法本身就是多余的 ——
//      每个半球的 UV 范围里已经含自己的虹膜，模型不需要任何旋转。
//
// 本版改用更稳的判据：**UV 质心**。
//   把每个 UV 当平面点求均值，如果 vt 索引分配正确，质心应该落在贴图上
//   本半球那颗眼球的中心附近（上半 / 下半）；如果左右分配反了，
//   质心会跑到对面那颗眼球上，一眼就能看出来。
//
// 用法: node tools/mheye-probe2.mjs
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const { V, VT, F } = (() => {
  const V = [], VT = [], F = [];
  for (const raw of fs.readFileSync(path.join(SRC, 'eyes/high-poly/high-poly.obj'), 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    if (l[0] === 'v' && l[1] === ' ') V.push(l.slice(2).trim().split(/\s+/).map(Number));
    else if (l[0] === 'v' && l[1] === 't') VT.push(l.slice(3).trim().split(/\s+/).map(Number));
    else if (l[0] === 'f' && l[1] === ' ') {
      const tk = l.slice(2).trim().split(/\s+/).map((t) => t.split('/'));
      for (let i = 1; i < tk.length - 1; i++)
        for (const k of [0, i, i + 1]) F.push([+tk[k][0] - 1, +tk[k][1] - 1]);
    }
  }
  return { V, VT, F };
})();

console.log(`high-poly.obj: ${V.length} v / ${VT.length} vt / ${F.length / 3} tris`);

const halves = { xneg: [], xpos: [] };
for (const [vi, ti] of F) (V[vi][0] < 0 ? halves.xneg : halves.xpos).push([vi, ti]);

// vt 索引 -> 用它的面（可能多个面共用一个 vt，取全部，质心仍稳）
function centroid(list) {
  const us = [...new Set(list.map((l) => l[1]))].map((t) => VT[t]).filter(Boolean);
  return [
    us.reduce((s, p) => s + p[0], 0) / us.length,
    us.reduce((s, p) => s + p[1], 0) / us.length,
    us.length,
  ];
}

console.log('\n=== UV 质心判归属（判据：质心应落在贴图上本半球那颗眼球里）===');
// 贴图事实（1024x1024，PNG 左上为原点）：
//   上半部眼球 中心约 UV(0.70, 0.70)，半径约 0.27   ← 对应 v 范围小的那半
//   下半部眼球 中心约 UV(0.29, 0.29)，半径约 0.27   ← v 范围大的那半
//   （OBJ 的 UV 原点在左下，与 PNG 的 v 方向相反：png_v = 1 - obj_v）
const texUpper = [0.7034, 1 - 0.3037];   // 上半部那颗（PNG 坐标换算回 OBJ UV）
const texLower = [0.2859, 1 - 0.7162];

for (const k of ['xneg', 'xpos']) {
  const c = centroid(halves[k]);
  const dUpper = Math.hypot(c[0] - texUpper[0], c[1] - texUpper[1]);
  const dLower = Math.hypot(c[0] - texLower[0], c[1] - texLower[1]);
  const guess = dUpper < dLower ? '上半部（v 小）' : '下半部（v 大）';
  console.log(`  X${k === 'xneg' ? '<0' : '>0'}  UV 质心 (${c[0].toFixed(4)}, ${c[1].toFixed(4)})  [${c[2]} 个 uv]`);
  console.log(`       到上半球心 ${dUpper.toFixed(4)} / 到下半球心 ${dLower.toFixed(4)}  → 归属 ${guess}`);
}

// 顺带把「UV 到 3D」的对应关系也验一次：取每个 vt 用到它的顶点均值
console.log('\n=== vt -> 3D 位置抽样（看 UV 大 v 对应 Z 正还是负）===');
const vtToV = new Map();
for (const [vi, ti] of F) {
  let a = vtToV.get(ti);
  if (!a) vtToV.set(ti, a = []);
  a.push(vi);
}
for (const k of ['xneg', 'xpos']) {
  const sc = k === 'xneg' ? -0.2911 : 0.2911;
  const sample = [...new Set(halves[k].map((l) => l[1]))].slice(0, 3);
  console.log(`  X${k === 'xneg' ? '<0' : '>0'} 球心 X=${sc}:`);
  for (const ti of sample) {
    const vs = vtToV.get(ti) || [];
    if (!vs.length) continue;
    const p = [0, 1, 2].map((j) => vs.reduce((s, i) => s + V[i][j], 0) / vs.length);
    const dir = [p[0] - sc, p[1] - 15.7465, p[2] - 1.3731];
    console.log(`       vt${ti} uv(${VT[ti][0].toFixed(3)},${VT[ti][1].toFixed(3)}) 3D(${p.map((x) => x.toFixed(3)).join(', ')}) 局部(${dir.map((x) => x.toFixed(3)).join(', ')})`);
  }
}

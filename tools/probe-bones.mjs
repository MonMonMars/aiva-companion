#!/usr/bin/env node
/**
 * 打印 GLB 里骨骼的世界坐标，用来判断模型的静止姿态（T-pose / A-pose）。
 *
 * 为什么需要：VRM 1.0 规范强制静止姿势是 T-pose（双臂平举）。
 * 而 src/three/rigDriver.js 是「在初始姿态上叠加偏移」，不会把 T-pose 掰回来 ——
 * 直接挂上去角色就会像十字架一样站着。要修就得先知道手臂骨现在朝哪。
 *
 * 用法：node tools/probe-bones.mjs [glb路径]
 */
import fs from 'node:fs';
import path from 'node:path';

const GLB = process.argv[2] || path.join(process.cwd(), 'assets', 'models2', 'kizuna-kamatte.glb');
const buf = fs.readFileSync(GLB);

let off = 12, json = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
  off += 8 + len;
}

// 父 → 子
const parentOf = new Map();
(json.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));

// ⚠️ 必须走完整的 TRS 矩阵复合，只累加 translation 是错的：
//    父节点的旋转会被丢掉，算出来的骨架会整体歪掉（我第一版就是这样，
//    得出"头在 +X 方向"的荒谬结论 —— 其实这个模型有根节点旋转）。
const M = {
  ident: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul: (a, b) => {           // 列主序（glTF 约定）：返回 a·b
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  fromNode: (n) => {
    const t = n.translation || [0, 0, 0];
    const q = n.rotation || [0, 0, 0, 1];
    const s = n.scale || [1, 1, 1];
    if (n.matrix) return n.matrix.slice();
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ];
  },
  pos: (m) => [m[12], m[13], m[14]],
};

const world = new Array(json.nodes.length).fill(null);
function matOf(i) {
  if (world[i]) return world[i];
  const local = M.fromNode(json.nodes[i]);
  world[i] = parentOf.has(i) ? M.mul(matOf(parentOf.get(i)), local) : local;
  return world[i];
}
const worldOf = (i) => M.pos(matOf(i));

const bones = new Set((json.skins?.[0]?.joints) || []);
const fmt = (v) => `(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)})`;

console.log(`\n=== ${path.basename(GLB)} 骨骼世界坐标（共 ${bones.size} 根）===\n`);

// 先看有没有 VRMC_vrm 的人类骨映射（我们转 GLB 时剥掉了，所以大概率没有）
const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
console.log(`humanoid 映射：${hb ? Object.keys(hb).length + ' 根' : '已被剥离（按名字猜）'}\n`);

const ARM = /arm|腕|肩|shoulder|hand|手/i;
const rows = [];
(json.nodes || []).forEach((n, i) => {
  if (!bones.has(i)) return;
  const w = worldOf(i);
  rows.push({ i, name: n.name || `(node${i})`, w });
});

// 手臂相关的骨：看它到子骨的方向是不是接近水平
console.log('--- 上臂 / 前臂（判断 T-pose 的关键）---');
const dirOf = (i) => {
  const kids = (json.nodes[i].children || []).filter((c) => bones.has(c));
  if (!kids.length) return null;
  const a = worldOf(i), b = worldOf(kids[0]);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  return { d: d.map((x) => x / len), len, to: json.nodes[kids[0]].name };
};

for (const r of rows) {
  if (!ARM.test(r.name)) continue;
  const dir = dirOf(r.i);
  if (!dir) continue;
  const [dx, dy, dz] = dir.d;
  const horiz = Math.abs(dy) < 0.35;
  console.log(
    `  ${r.name.padEnd(22)} 起点 ${fmt(r.w)}  朝向 ${fmt(dir.d.map((x) => +x.toFixed(2)))}` +
    `  长 ${dir.len.toFixed(3)}  → ${dir.to}` +
    (horiz ? '   ⚠️ 接近水平（T-pose 特征）' : '')
  );
}

console.log('\n--- 全部骨骼 ---');
for (const r of rows) console.log(`  ${String(r.i).padStart(3)} ${r.name.padEnd(24)} ${fmt(r.w)}`);

// 结论：统计有多少根"臂"骨是水平的
const armBones = rows.filter((r) => ARM.test(r.name)).map((r) => ({ ...r, dir: dirOf(r.i) }));
const horizontal = armBones.filter((r) => r.dir && Math.abs(r.dir.d[1]) < 0.35);
console.log(
  `\n结论：${horizontal.length}/${armBones.length} 根臂骨接近水平 → ` +
  `${horizontal.length >= 2 ? '⚠️ T-pose，需要转成 A-pose 才能看' : '不是 T-pose'}`
);

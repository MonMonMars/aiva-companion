#!/usr/bin/env node
/**
 * 把模型的**朝向**转 180°，让「正面朝 +Z」。
 *
 * ⚠️ 为什么需要这一步（app 里看到后脑勺的根因）：
 *   src/three/companion.js 的相机默认在 **+Z** 侧看向原点
 *     CAM_DEFAULT = { yaw: 0, ... } → applyCamera(): z = dist·cos(yaw) = +dist
 *   而 VRM 规范里角色是面朝 **−Z** 的（three.js / glTF 的惯例也是 +Z 为"前"，
 *   但 VRM 0.x 的导出器把角色建模成脸朝 −Z）。
 *   实测依据：J_Bip_C_Head 在 z=−0.03，双眼在更负的一侧 —— 眼睛在 −Z，所以脸朝 −Z。
 *   结果：把 VRM 原样挂进 app，用户迎面看到的是后脑勺。
 *
 * 为什么不改 app 的相机/角色容器：
 *   已有 18 个自研角色都是「面朝 +Z」的，改 app 会让它们全部反过来。
 *   在**模型文件**里转，只影响这一个模型，其他一律不动。
 *
 * 为什么改根节点就够、不用动顶点/骨骼/IBM：
 *   转整个根节点 = 转整棵树。蒙皮靠 boneWorld × IBM，根节点是所有骨骼的共同祖先，
 *   各骨的 **相对** 关系完全不变，所以蒙皮结果一致，只是整体绕 Y 轴转了 180°。
 *   同理 A-pose 烘焙也是这个原理（见 tpose-to-apose.mjs 的注释）。
 *
 * ⚠️ 副作用：绕 Y 转 180° 会让包围盒的 x/z 符号翻转，但尺寸不变。
 *    attachModel 是按包围盒高度缩放 + 居中，所以不受影响。
 *
 * 用法：node tools/face-front.mjs <输入.glb> [输出.glb] [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const IN = args.find((a) => !a.startsWith('--'));
const pos = args.filter((a) => !a.startsWith('--'));
const OUT = pos[1] || IN.replace(/\.glb$/, '.front.glb');
const DRY = args.includes('--dry');

if (!IN) { console.error('用法：node tools/face-front.mjs <输入.glb> [输出.glb] [--dry]'); process.exit(1); }

const buf = fs.readFileSync(IN);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error('不是 GLB'); process.exit(1); }

/** 四元数乘法 a*b（先 a 后 b，标准 Hamilton 积） */
function mulQuat(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function fmt(q) { return '(' + q.map((v) => v.toFixed(3)).join(', ') + ')'; }

const chunks = [];
let off = 12;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  chunks.push({ type, data: buf.slice(off + 8, off + 8 + len) });
  off += 8 + len;
}
const jsonChunk = chunks.find((c) => c.type === 0x4e4f534a);
const json = JSON.parse(jsonChunk.data.toString('utf8'));

// ---------------------------------------------------------------------------
// 找**场景根节点**：在 scenes[0].nodes 里、且是其他所有骨骼共同祖先的那些。
//
// ⚠️ 不能无脑只转 scenes[0].nodes[0]：VRoid 的场景根通常只有一个 Armature，
//    但有些导出器会挂多个根（比如分开的 mesh 根 + 骨架根）。
//    逐个判断：如果一个根的子树上**没有别的根**，它就是真正的外层根。
// ---------------------------------------------------------------------------
const sceneRoots = (json.scenes?.[json.scene || 0]?.nodes) || [];
if (!sceneRoots.length) { console.error('场景没有根节点'); process.exit(1); }

// 建 parent 索引，用来判断祖先关系
const parent = new Array((json.nodes || []).length).fill(-1);
(json.nodes || []).forEach((n, i) => {
  for (const c of n.children || []) parent[c] = i;
});
const isAncestor = (a, b) => {
  let p = parent[b];
  while (p !== -1) { if (p === a) return true; p = parent[p]; }
  return false;
};
// 只保留「不被其他根包含」的那些 —— 它们才是真正的顶层根
const topRoots = sceneRoots.filter((r) => !sceneRoots.some((o) => o !== r && isAncestor(o, r)));

console.log(`文件: ${path.basename(IN)}`);
console.log(`  场景根节点: ${sceneRoots.map((i) => json.nodes[i].name || ('#' + i)).join(', ')}`);
console.log(`  顶层根    : ${topRoots.map((i) => json.nodes[i].name || ('#' + i)).join(', ')}`);

// ---------------------------------------------------------------------------
// 绕 Y 轴转 180°。用四元数表达：(x,y,z,w) = (0, 1, 0, 0)
// 即 180° 绕 Y —— 比矩阵更好合进已有 TRS，也不会有万向节问题。
// ---------------------------------------------------------------------------
const Q = [0, 1, 0, 0];
for (const ri of topRoots) {
  const n = json.nodes[ri];
  // ⚠️ 节点可能用 matrix 而不是 TRS。用 matrix 时不能只写 rotation —— 
  //    规范说 matrix 和 TRS 互斥，同时存在时以 matrix 为准，rotation 会被忽略。
  //    所以遇到 matrix 必须把它转成 TRS 再改（下面的兜底）。
  if (n.matrix) {
    const m = n.matrix;
    // 从列主序 4x4 里取平移
    n.translation = [m[12], m[13], m[14]];
    // 转 180° 绕 Y 后，原来的旋转矩阵左乘 Ry(180)：
    //   Ry(180) = diag(-1, 1, -1)
    // 作用在旋转部分上等于把 (r00,r01,r02) 和 (r20,r21,r22) 两行取反。
    // 直接改矩阵比拆四元数更省事，也避免手写四元数转换出错。
    const rot = [
      -m[0], -m[4], -m[8],
       m[1],  m[5],  m[9],
      -m[2], -m[6], -m[10],
    ];
    // 3x3 旋转矩阵 → 四元数（标准算法，注意列主序：rot[c*3+r]）
    const m00 = rot[0], m01 = rot[3], m02 = rot[6];
    const m10 = rot[1], m11 = rot[4], m12 = rot[7];
    const m20 = rot[2], m21 = rot[5], m22 = rot[8];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
    }
    n.rotation = q;
    // 尺度从原矩阵的三列长度取
    n.scale = [
      Math.hypot(m[0], m[1], m[2]),
      Math.hypot(m[4], m[5], m[6]),
      Math.hypot(m[8], m[9], m[10]),
    ];
    delete n.matrix;
    console.log(`  ✅ ${(n.name || '#' + ri).padEnd(16)} matrix → TRS，已转 180°`);
    continue;
  }
  // ⚠️ 旋转要**左乘**新的 180°（在世界/父空间里再转一次），
  //    而不是直接覆盖 —— 根节点自己可能已经带了一点旋转（VRM 常见 ±90°）。
  const cur = n.rotation || [0, 0, 0, 1];
  const q2 = mulQuat(Q, cur);
  n.rotation = q2;
  console.log(`  ✅ ${(n.name || '#' + ri).padEnd(16)} rotation ${fmt(cur)} → ${fmt(q2)}`);
}

if (DRY) { console.log('\n--dry：未写盘。'); process.exit(0); }

const pad4 = (n) => (4 - (n % 4)) % 4;
function chunkWrap(type, data, padByte) {
  const p = pad4(data.length);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length + p, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, data, Buffer.alloc(p, padByte)]);
}
const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const parts = [Buffer.alloc(12)];
let total = 12;
for (const c of chunks) {
  const isJson = c.type === 0x4e4f534a;
  const part = chunkWrap(c.type, isJson ? jsonBuf : c.data, isJson ? 0x20 : 0x00);
  parts.push(part);
  total += part.length;
}
const out = Buffer.concat(parts, total);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
fs.writeFileSync(OUT, out);
console.log(`\n输出：${path.basename(OUT)}（${(out.length / 1048576).toFixed(2)} MB，转了 ${topRoots.length} 个根节点）\n`);

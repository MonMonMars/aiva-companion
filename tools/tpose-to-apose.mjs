#!/usr/bin/env node
/**
 * 把 T-pose 的骨骼静止姿势烘焙成 A-pose（手臂自然下垂）。
 *
 * 为什么必须在转换阶段烘焙，而不是运行时掰：
 *   src/three/rigDriver.js 的设计是「在初始姿态上叠加偏移」（见它第 49~50 行注释），
 *   目的就是**不抹平模型自带的姿态**。对 VRM 来说这是致命的 —— VRM 1.0 规范
 *   强制静止姿势是 T-pose，直接挂上去角色就像十字架一样站着。
 *   在运行时改就得给 rigDriver 加分支、每帧多算四元数；
 *   烘焙进 GLB 则运行时零成本，而且 rigDriver 会把 A-pose 当成新的初始姿态，
 *   armRaise（被摸抬手）依旧是在它上面叠加，语义不变。
 *
 * 为什么改骨骼节点是安全的：
 *   蒙皮靠 inverseBindMatrices（IBM）。IBM 是从**原始**绑定姿态算出来的常量，
 *   运行时 boneMatrix = boneWorld × IBM。改骨骼节点的本地旋转 = 摆姿势，
 *   蒙皮会自动跟着变形 —— 这正是骨骼动画的工作原理，不需要动 IBM。
 *
 * 用法：node tools/tpose-to-apose.mjs <输入.glb> [输出.glb] [--deg=70]
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const IN = process.argv[2];
const OUT = process.argv[3] && !process.argv[3].startsWith('--')
  ? process.argv[3]
  : IN.replace(/\.glb$/, '.apose.glb');
const degArg = process.argv.find((a) => a.startsWith('--deg='));
// 手臂从水平往下压多少度。VRM 的 A-pose 惯例是 45~60°，
// 取 70° 更接近自然垂手，配这个角色的窄肩剪影更好看。
const DROP_DEG = degArg ? Number(degArg.split('=')[1]) : 70;

if (!IN) { console.error('用法：node tools/tpose-to-apose.mjs <输入.glb> [输出.glb] [--deg=70]'); process.exit(1); }

// ---------------------------------------------------------------------------
// 拆 GLB
// ---------------------------------------------------------------------------
const buf = fs.readFileSync(IN);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error('不是 GLB'); process.exit(1); }

const chunks = [];
let off = 12;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  chunks.push({ type, data: buf.slice(off + 8, off + 8 + len) });
  off += 8 + len;
}
const jsonChunk = chunks.find((c) => c.type === 0x4e4f534a);
if (!jsonChunk) { console.error('没有 JSON chunk'); process.exit(1); }
const json = JSON.parse(jsonChunk.data.toString('utf8'));

// ---------------------------------------------------------------------------
// 用 three 搭出和 GLTFLoader 一致的节点树（只为算世界矩阵，不碰几何/贴图）
// ---------------------------------------------------------------------------
const joints = new Set((json.skins?.[0]?.joints) || []);
const objs = (json.nodes || []).map((n) => {
  const o = new THREE.Object3D();
  o.name = n.name || '';
  if (n.matrix) {
    o.matrix.fromArray(n.matrix);
    o.matrix.decompose(o.position, o.quaternion, o.scale);
  } else {
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
  }
  return o;
});
(json.nodes || []).forEach((n, i) => {
  for (const c of n.children || []) objs[i].add(objs[c]);
});
// 场景根
const scene = new THREE.Object3D();
const roots = (json.scenes?.[json.scene || 0]?.nodes) || [];
for (const r of roots) scene.add(objs[r]);
scene.updateMatrixWorld(true);

// ---------------------------------------------------------------------------
// 找上臂骨：名字含 uparm / upperarm / upper_arm / 上腕
// ---------------------------------------------------------------------------
const UPARM = /up(?:per)?[_-]?arm|上腕/i;
const targets = [];
(json.nodes || []).forEach((n, i) => {
  if (!joints.has(i)) return;
  if (UPARM.test(n.name || '')) targets.push({ i, name: n.name, obj: objs[i] });
});

if (!targets.length) {
  console.error('❌ 没找到上臂骨（名字里没有 uparm / upper_arm / 上腕）。');
  console.error('   当前骨骼：', [...joints].slice(0, 12).map((i) => json.nodes[i].name).join(', '));
  process.exit(1);
}

console.log(`\n=== T-pose → A-pose（下压 ${DROP_DEG}°）===`);
console.log(`输入：${path.basename(IN)}\n`);

let changed = 0;
for (const t of targets) {
  // 骨段方向：从这块骨指向它的第一个子骨
  const kids = t.obj.children.filter((c) => c.children.length || true);
  const child = kids[0];
  if (!child) { console.log(`  ⚠️  ${t.name} 没有子骨，跳过`); continue; }

  const from = child.getWorldPosition(new THREE.Vector3())
    .sub(t.obj.getWorldPosition(new THREE.Vector3())).normalize();

  // 判断是不是真的 T-pose（水平）。已经是 A-pose 就别动。
  if (Math.abs(from.y) > 0.5) {
    console.log(`  ·  ${t.name} 已经不是水平的（y=${from.y.toFixed(2)}），跳过`);
    continue;
  }

  const side = from.x >= 0 ? 1 : -1;                 // 左臂朝 +X，右臂朝 -X
  const rad = THREE.MathUtils.degToRad(DROP_DEG);
  // 目标：斜下外展。y 恒为负（往下），x 保留原来那一侧。
  const to = new THREE.Vector3(side * Math.cos(rad), -Math.sin(rad), 0).normalize();

  // 世界空间的增量旋转
  const qWorld = new THREE.Quaternion().setFromUnitVectors(from, to);
  // 换回父空间：localNew = P⁻¹ · Qworld · P · localOld
  const P = t.obj.parent.getWorldQuaternion(new THREE.Quaternion());
  const Pinv = P.clone().invert();
  const localNew = Pinv.multiply(qWorld).multiply(P).multiply(t.obj.quaternion.clone());
  t.obj.quaternion.copy(localNew);
  t.obj.updateMatrixWorld(true);

  // 回写 JSON：统一写成 TRS（原来是 matrix 的也转过来，GLTFLoader 两种都吃）
  const n = json.nodes[t.i];
  delete n.matrix;
  n.translation = t.obj.position.toArray();
  n.rotation = t.obj.quaternion.toArray();
  n.scale = t.obj.scale.toArray();
  changed++;

  const after = child.getWorldPosition(new THREE.Vector3())
    .sub(t.obj.getWorldPosition(new THREE.Vector3())).normalize();
  console.log(
    `  ✅ ${t.name.padEnd(12)} ${fmtVec(from)} → ${fmtVec(after)}`
  );
}

function fmtVec(v) {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

if (!changed) {
  console.log('\n没有需要改的骨（可能已经是 A-pose）。不写文件。\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 重组 GLB。只改了 JSON，BIN 原样搬 —— 所以不存在偏移漂移的风险。
// ---------------------------------------------------------------------------
const pad4 = (n) => (4 - (n % 4)) % 4;
function chunk(type, data, padByte) {
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
  // JSON chunk 用我们新生成的，其余（BIN / 扩展）原样保留
  const isJson = c.type === 0x4e4f534a;
  const body = isJson ? jsonBuf : c.data;
  const part = chunk(c.type, body, isJson ? 0x20 : 0x00);
  parts.push(part);
  total += part.length;
}
const out = Buffer.concat(parts, total);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);

fs.writeFileSync(OUT, out);
console.log(`\n输出：${path.basename(OUT)}（${(out.length / 1048576).toFixed(2)} MB，改了 ${changed} 根骨）\n`);

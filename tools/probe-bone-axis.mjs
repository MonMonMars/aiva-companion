#!/usr/bin/env node
/**
 * 实测某根骨绕本地 x/y/z 各转 +0.5rad 之后，骨段在世界空间朝哪。
 *
 * 为什么必须实测：VRM 骨骼的本地轴没有统一约定（不像 Mixamo 那样bone沿 +Y），
 * 凭"上臂抬起是绕 z 转"这类经验写姿势，左右和上下很容易全反。
 * 而姿势库一旦写反，是**静默错误** —— 不报错，只是动作看着别扭。
 *
 * 用法：node tools/probe-bone-axis.mjs [glb] [骨名...]
 *   例：node tools/probe-bone-axis.mjs assets/models2/kizuna-kamatte.glb J_L_uparm J_C_head
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const GLB = process.argv[2] || path.join(process.cwd(), 'assets', 'models2', 'kizuna-kamatte.glb');
const WANT = process.argv.slice(3);

const buf = fs.readFileSync(GLB);
let off = 12, json = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
  off += 8 + len;
}

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
(json.nodes || []).forEach((n, i) => { for (const c of n.children || []) objs[i].add(objs[c]); });
const root = new THREE.Object3D();
for (const r of (json.scenes?.[json.scene || 0]?.nodes) || []) root.add(objs[r]);
root.updateMatrixWorld(true);

const byName = new Map();
root.traverse((o) => { if (o.name) byName.set(o.name, o); });

/** 骨段的世界方向：从 bone 指向它的第一个子骨 */
function dirOf(bone) {
  const kid = bone.children[0];
  if (!kid) return null;
  return kid.getWorldPosition(new THREE.Vector3())
    .sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
}

const TESTS = [
  ['x', +0.5], ['x', -0.5],
  ['y', +0.5], ['y', -0.5],
  ['z', +0.5], ['z', -0.5],
];

/**
 * 光看"子骨方向"会漏掉一种情况：**绕骨骼自身长轴旋转**。
 * 那种旋转不改变骨段朝向（所以子骨不动），但会把蒙皮网格拧过去 ——
 * 对头来说就是"左右摇头"，视觉上非常明显。
 * 所以再取两个探针点：骨骼局部 +Y 和 +Z 各 0.2，看它们往哪跑。
 */
function probePoints(bone) {
  const o = bone.getWorldPosition(new THREE.Vector3());
  return {
    y: bone.localToWorld(new THREE.Vector3(0, 0.2, 0)).sub(o),
    z: bone.localToWorld(new THREE.Vector3(0, 0, 0.2)).sub(o),
  };
}

const fmt = (v) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;

const names = WANT.length ? WANT
  : ['J_L_uparm', 'J_R_uparm', 'J_C_head', 'J_C_neck', 'J_C_hip'];

console.log(`\n=== ${path.basename(GLB)} 骨骼本地轴实测（±0.5 rad）===\n`);

for (const name of names) {
  const bone = byName.get(name);
  if (!bone) { console.log(`  ⚠️ 找不到 ${name}`); continue; }

  const base = dirOf(bone);
  console.log(`  ${name}`);
  console.log(`     静止朝向 ${base ? fmt(base) : '(无子骨)'}`);

  const q0 = bone.quaternion.clone();
  const p0 = probePoints(bone);
  for (const [axis, ang] of TESTS) {
    bone.quaternion.copy(q0);
    bone.rotateOnAxis(new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), ang);
    bone.updateMatrixWorld(true);

    const d = dirOf(bone);
    const p1 = probePoints(bone);
    const move = base ? Math.hypot(d.x - base.x, d.y - base.y, d.z - base.z) : 0;
    // 探针点的位移才是"网格会怎么动"的直接体现
    const my = p1.y.clone().sub(p0.y);
    const mz = p1.z.clone().sub(p0.z);
    const twist = Math.max(my.length(), mz.length());

    // 用人话描述骨段：往外/往内、往上/往下、往前/往后
    const side = Math.abs(d.x - base.x) > 0.04 ? ((d.x - base.x) > 0 ? '往 +X' : '往 -X') : '';
    const vert = Math.abs(d.y - base.y) > 0.04 ? ((d.y - base.y) > 0 ? '抬高' : '放下') : '';
    const fwd = Math.abs(d.z - base.z) > 0.04 ? ((d.z - base.z) > 0 ? '往前' : '往后') : '';
    const desc = [side, vert, fwd].filter(Boolean).join(' · ') || '骨段不动';
    console.log(
      `     ${axis} ${ang > 0 ? '+' : '-'}0.5 → ${fmt(d)}  ${desc.padEnd(16)}` +
      `网格位移 ${twist.toFixed(2)}`
    );
  }
  bone.quaternion.copy(q0);
  bone.updateMatrixWorld(true);
  console.log('');
}

// 语义轴换算的单测
// ---------------------------------------------------------------------------
// 为什么值得单测：骨骼轴向写错**不会报错**。头会转、手会抬，只是方向反了 ——
// 屏幕上看到的是"她把胳膊往身体里拧"，你还以为是姿势数调歪了。
//
// 这里搭两棵**合成骨架**：
//   骨架 A：骨段沿本地 +X（这批 VRM / PMX 的约定）
//   骨架 B：骨段沿本地 +Y（Mixamo / Rigify 的约定）
// 两棵再各自绕骨段拧 0.7rad，让另外两根本地轴指向乱七八糟的方向 ——
// 只要实现里有一处写死了本地轴，这里立刻会红。（第一版就是这么被抓的）
//
// 判据是世界空间里的**实际旋转轴**：给一个语义动作，量出骨骼世界四元数的增量，
// 转成轴角，看它是不是该绕的那根世界轴、转了多少度、方向对不对。
// 另外再补三条物理判据（手到底往哪走），防止"轴对了但符号反了"蒙混过关。
//
// 跑：node --import ./tools/src-resolve.mjs tools/test-rig-semantics.mjs

import * as THREE from 'three';
// ⚠️ 这两行原来写的是裸路径（'../src/three/rigDriver'），在 Node 的 ESM 下必须带扩展名 ——
//    它不会像 bundler 那样做扩展名推断，直接就 ERR_MODULE_NOT_FOUND。
//    症状很有迷惑性：报的是"Cannot find module ... rigDriver"，但文件明明在，
//    于是看着像模块被删了。以后加任何 dev 脚本都要留意这条。
import { createRigDriver } from '../src/three/rigDriver.js';
import { createPoseScheduler } from '../src/anim/poseScheduler.js';
import { IDLE_POSES } from '../src/anim/idlePoses.js';
import { buildSemAxes } from '../src/anim/semAxes.js';

// 角色站直、面朝 +Z：她的左手边是 +X（VRM 规范）
const DEFS = [
  { name: 'Hips', parent: null, pos: [0, 1.00, 0], along: [0, 1, 0] },
  { name: 'Spine', parent: 'Hips', pos: [0, 1.12, 0], along: [0, 1, 0] },
  { name: 'Spine1', parent: 'Spine', pos: [0, 1.30, 0], along: [0, 1, 0] },
  { name: 'Neck', parent: 'Spine1', pos: [0, 1.48, 0], along: [0, 1, 0] },
  { name: 'Head', parent: 'Neck', pos: [0, 1.60, 0], along: [0, 1, 0] },

  { name: 'LeftShoulder', parent: 'Spine1', pos: [0.09, 1.46, 0], along: [0.10, -0.04, 0] },
  { name: 'LeftArm', parent: 'LeftShoulder', pos: [0.19, 1.42, 0], along: [0.11, -0.32, 0] },
  { name: 'LeftForeArm', parent: 'LeftArm', pos: [0.30, 1.10, 0], along: [0.06, -0.30, 0] },
  { name: 'LeftHand', parent: 'LeftForeArm', pos: [0.36, 0.80, 0], along: [0.06, -0.30, 0] },

  { name: 'RightShoulder', parent: 'Spine1', pos: [-0.09, 1.46, 0], along: [-0.10, -0.04, 0] },
  { name: 'RightArm', parent: 'RightShoulder', pos: [-0.19, 1.42, 0], along: [-0.11, -0.32, 0] },
  { name: 'RightForeArm', parent: 'RightArm', pos: [-0.30, 1.10, 0], along: [-0.06, -0.30, 0] },
  { name: 'RightHand', parent: 'RightForeArm', pos: [-0.36, 0.80, 0], along: [-0.06, -0.30, 0] },

  { name: 'LeftUpLeg', parent: 'Hips', pos: [0.09, 0.95, 0], along: [0.01, -0.45, 0] },
  { name: 'LeftLeg', parent: 'LeftUpLeg', pos: [0.10, 0.50, 0], along: [0.01, -0.45, 0] },
  { name: 'RightUpLeg', parent: 'Hips', pos: [-0.09, 0.95, 0], along: [-0.01, -0.45, 0] },
  { name: 'RightLeg', parent: 'RightUpLeg', pos: [-0.10, 0.50, 0], along: [-0.01, -0.45, 0] },
];

/** 搭一棵骨架。alongAxis 决定"骨段沿本地哪根轴"，这就是两套骨架唯一的区别。 */
function buildRig(alongAxis, twistRad = 0.7) {
  const unit = new THREE.Vector3(alongAxis === 'x' ? 1 : 0, alongAxis === 'y' ? 1 : 0, 0);
  const root = new THREE.Object3D();
  const byName = {};
  const worldQ = {};

  for (const d of DEFS) {
    const bone = new THREE.Bone();
    bone.name = d.name;
    const along = new THREE.Vector3(...d.along).normalize();
    // 先转到"骨段指向目标方向"，再绕骨段自己拧一下 —— 让另外两根轴指哪都不一定
    const q0 = new THREE.Quaternion().setFromUnitVectors(unit, along);
    const qTwist = new THREE.Quaternion().setFromAxisAngle(unit, twistRad);
    const Qw = q0.clone().multiply(qTwist);
    worldQ[d.name] = Qw;

    const parentQ = d.parent ? worldQ[d.parent].clone() : new THREE.Quaternion();
    const invP = parentQ.clone().invert();
    bone.quaternion.copy(invP.clone().multiply(Qw));

    const worldPos = new THREE.Vector3(...d.pos);
    const parentPos = d.parent
      ? new THREE.Vector3(...DEFS.find((x) => x.name === d.parent).pos)
      : new THREE.Vector3(0, 0, 0);
    bone.position.copy(worldPos.clone().sub(parentPos).applyQuaternion(invP));

    (d.parent ? byName[d.parent] : root).add(bone);
    byName[d.name] = bone;
  }
  return root;
}

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ${extra}`); }
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const fmt = (v) => `(${v.toArray().map((n) => n.toFixed(3)).join(', ')})`;

/** 骨骼当前世界四元数相对 rest 的增量，转成轴角 */
function deltaAxisAngle(root, boneName, restQ) {
  const bone = root.getObjectByName(boneName);
  bone.updateWorldMatrix(true, false);
  const now = bone.getWorldQuaternion(new THREE.Quaternion());
  const d = now.multiply(restQ.clone().invert());
  const w = Math.min(1, Math.max(-1, d.w));
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(Math.max(1e-12, 1 - w * w));
  const axis = new THREE.Vector3(d.x, d.y, d.z).divideScalar(s);
  // (axis, θ) 和 (-axis, -θ) 是同一个旋转，统一成正角
  if (angle > Math.PI) return { axis: axis.negate(), angle: 2 * Math.PI - angle };
  return { axis, angle };
}

/** 只取"绕某根世界轴转了多少"，用于淡入曲线的逐帧采样 */
function angleAbout(root, boneName, restQ, axis) {
  const { axis: ax, angle } = deltaAxisAngle(root, boneName, restQ);
  return angle * (ax.dot(axis) < 0 ? -1 : 1);
}

for (const alongAxis of ['x', 'y']) {
  console.log(`\n=== 骨架 ${alongAxis.toUpperCase()}-along（骨段沿本地 +${alongAxis.toUpperCase()}，另两轴随机拧 0.7rad）===`);
  const root = buildRig(alongAxis);
  const driver = createRigDriver(root);
  if (!driver) { fail++; console.log('  ✗ 驱动没建起来'); continue; }
  console.log(`  覆盖率 ${Math.round(driver.coverage.ratio * 100)}%（${Object.keys(driver.mapping).length} 根骨）`);

  // rest 世界四元数快照：所有测量都以它为基准
  root.updateWorldMatrix(true, true);
  const restQ = new Map();
  root.traverse((o) => restQ.set(o.name, o.getWorldQuaternion(new THREE.Quaternion())));

  /** 清空姿势 + 推一帧（t=0 时程序化动画的正弦项全为 0，方便做精确断言） */
  const reset0 = () => {
    driver.clearPose({ fade: 0.001 });
    driver.update({ t: 0, dt: 1, lookX: 0, lookY: 0, headTilt: 0, armRaise: 0, bounce: 0 });
    root.updateWorldMatrix(true, true);
  };

  /** 施加一个语义动作，返回它绕世界哪根轴转了多少 */
  function measure(boneName, key, amount) {
    // 先归零，否则测到的是"上一个姿势 → 这个姿势"的差，不是纯增量
    driver.clearPose({ fade: 0.001 });
    driver.update({ t: 0, dt: 1, lookX: 0, lookY: 0, headTilt: 0, armRaise: 0, bounce: 0 });
    driver.setPose({ id: 't', bones: { [boneName]: { [key]: amount } } }, { fade: 0.001 });
    // t=0 时程序化层（呼吸/摆臂/看人）的正弦项全为 0，增量就是纯粹的姿势
    driver.update({ t: 0, dt: 1, lookX: 0, lookY: 0, headTilt: 0, armRaise: 0, bounce: 0 });
    return deltaAxisAngle(root, boneName, restQ.get(boneName));
  }

  // --- 竖直骨：yaw / pitch / roll ------------------------------------
  const VERT = [
    ['Head', 'yaw', new THREE.Vector3(0, 1, 0)],
    ['Head', 'pitch', new THREE.Vector3(1, 0, 0)],
    ['Head', 'roll', new THREE.Vector3(0, 0, 1)],
    ['Neck', 'yaw', new THREE.Vector3(0, 1, 0)],
    ['Neck', 'pitch', new THREE.Vector3(1, 0, 0)],
    ['Spine1', 'roll', new THREE.Vector3(0, 0, 1)],
    ['Hips', 'yaw', new THREE.Vector3(0, 1, 0)],
    ['LeftUpLeg', 'roll', new THREE.Vector3(0, 0, 1)],
  ];
  for (const [bone, key, want] of VERT) {
    const { axis, angle } = measure(bone, key, 0.30);
    const dot = axis.dot(want);
    check(dot > 0.9999 && near(angle, 0.30, 0.005),
      `${bone}.${key} = +0.30 → 绕世界 ${fmt(want)} 转 ${angle.toFixed(3)}`,
      `实际轴 ${fmt(axis)} dot=${dot.toFixed(4)}`);
  }

  // --- 手臂：out / fwd / twist ---------------------------------------
  const ARMS = ['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm'];
  for (const bone of ARMS) {
    const boneObj = root.getObjectByName(bone);
    const child = boneObj.children.find((c) => c.isBone) || boneObj;
    const along = child.getWorldPosition(new THREE.Vector3())
      .sub(boneObj.getWorldPosition(new THREE.Vector3())).normalize();
    // 向外 = 骨相对 Hips 的水平方向。直接取带符号的 X 分量，别再乘一次符号。
    const hipsPos = root.getObjectByName('Hips').getWorldPosition(new THREE.Vector3());
    const rel = boneObj.getWorldPosition(new THREE.Vector3()).sub(hipsPos);
    const away = new THREE.Vector3(rel.x, 0, rel.z).normalize();

    // twist：绕骨段自身
    const t = measure(bone, 'twist', 0.30);
    check(Math.abs(Math.abs(t.axis.dot(along)) - 1) < 0.01 && near(t.angle, 0.30, 0.005),
      `${bone}.twist = +0.30 → 绕骨段自身 ${fmt(along)} 转 ${t.angle.toFixed(3)}`,
      `实际轴 ${fmt(t.axis)} 角 ${t.angle.toFixed(3)}`);

    // fwd：绕 cross(骨段, +Z)
    const fwdAxis = along.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
    const f = measure(bone, 'fwd', 0.30);
    check(f.axis.dot(fwdAxis) > 0.9999 && near(f.angle, 0.30, 0.005),
      `${bone}.fwd = +0.30 → 绕 cross(骨段,+Z) ${fmt(fwdAxis)} 转 ${f.angle.toFixed(3)}`,
      `实际轴 ${fmt(f.axis)} dot=${f.axis.dot(fwdAxis).toFixed(4)}`);

    // out：绕 cross(骨段, 向外)
    const outAxis = along.clone().cross(away).normalize();
    const o = measure(bone, 'out', 0.30);
    check(o.axis.dot(outAxis) > 0.9999 && near(o.angle, 0.30, 0.005),
      `${bone}.out = +0.30 → 绕 cross(骨段,向外) ${fmt(outAxis)} 转 ${o.angle.toFixed(3)}`,
      `实际轴 ${fmt(o.axis)} dot=${o.axis.dot(outAxis).toFixed(4)}`);
  }

  // --- 父骨转动，子骨必须跟着走 ---------------------------------------
  // 这一条是专门防"脖子转了头留在原地"的：
  // 只给 Neck 一个 yaw，Head 自己没有任何 Δ，但它的世界朝向必须跟着变。
  {
    reset0();
    const headRest = restQ.get('Head').clone();
    const headBefore = root.getObjectByName('Head').getWorldQuaternion(new THREE.Quaternion()).clone();
    driver.setPose({ id: 'p', bones: { Neck: { yaw: 0.4 } } }, { fade: 0.001 });
    driver.update({ t: 0, dt: 1 });
    root.updateWorldMatrix(true, true);
    const headAfter = root.getObjectByName('Head').getWorldQuaternion(new THREE.Quaternion());
    const turned = headAfter.angleTo(headBefore);
    check(turned > 0.35,
      `只转 Neck，Head 跟着转了 ${turned.toFixed(3)}rad（应≈0.4）`,
      `实际 ${turned.toFixed(3)}`);
    void headRest;
  }

  // --- 不摆姿势时，骨骼必须精确回到 rest ---------------------------------
  // 防止"什么都不做却每帧歪一点"这种累积漂移
  {
    reset0();
    // t 恒为 0 → 呼吸/摆臂/看人的正弦项全是 0，此时骨骼必须**精确**停在 rest
    for (let i = 0; i < 40; i++) driver.update({ t: 0, dt: 0.016, lookX: 0, lookY: 0 });
    root.updateWorldMatrix(true, true);
    let worst = 0;
    let worstBone = '';
    for (const [name, q] of restQ) {
      if (!driver.mapping[name]) continue;
      const now = root.getObjectByName(name).getWorldQuaternion(new THREE.Quaternion());
      const d = now.angleTo(q);
      if (d > worst) { worst = d; worstBone = name; }
    }
    check(worst < 1e-5, `空跑 40 帧零漂移（最大 ${worst.toExponential(1)}rad${worstBone ? ' @' + worstBone : ''}）`, worstBone);
  }

  // --- 三条物理判据：手到底往哪走 -------------------------------------
  // 防止"轴挑对了、符号取反了"这种蒙混过关
  const handPos = (n) => {
    const h = root.getObjectByName(n);
    h.updateWorldMatrix(true, false);
    return h.getWorldPosition(new THREE.Vector3());
  };
  const reset = () => {
    driver.clearPose({ fade: 0.001 });
    driver.update({ t: 0, dt: 1 });
    root.updateWorldMatrix(true, true);
  };

  reset();
  const baseL = handPos('LeftHand').clone();
  const baseR = handPos('RightHand').clone();

  driver.setPose({ id: 'p', bones: { LeftArm: { out: 0.40 }, RightArm: { out: 0.40 } } }, { fade: 0.001 });
  driver.update({ t: 0, dt: 1 });
  root.updateWorldMatrix(true, true);
  const outL = handPos('LeftHand');
  const outR = handPos('RightHand');
  check(outL.x > baseL.x + 0.02 && outR.x < baseR.x - 0.02,
    `out+ → 双手向外张开（左 ${baseL.x.toFixed(3)}→${outL.x.toFixed(3)}，右 ${baseR.x.toFixed(3)}→${outR.x.toFixed(3)}）`,
    `${outL.x.toFixed(3)} / ${outR.x.toFixed(3)}`);
  check(outL.y > baseL.y && outR.y > baseR.y,
    `out+ → 双手同时被抬高（${baseL.y.toFixed(3)}→${outL.y.toFixed(3)}）`,
    `${outL.y.toFixed(3)} / ${outR.y.toFixed(3)}`);

  reset();
  driver.setPose({ id: 'p', bones: { LeftArm: { fwd: 0.40 }, RightArm: { fwd: 0.40 } } }, { fade: 0.001 });
  driver.update({ t: 0, dt: 1 });
  root.updateWorldMatrix(true, true);
  const fwdL = handPos('LeftHand');
  check(fwdL.z > baseL.z + 0.02,
    `fwd+ → 手往身前 +Z 摆（${baseL.z.toFixed(3)}→${fwdL.z.toFixed(3)}）`,
    `z=${fwdL.z.toFixed(3)}`);

  // twist 不改变骨段朝向，所以手尖几乎不动
  reset();
  const b2 = handPos('LeftHand').clone();
  driver.setPose({ id: 'p', bones: { LeftArm: { twist: 0.30 } } }, { fade: 0.001 });
  driver.update({ t: 0, dt: 1 });
  root.updateWorldMatrix(true, true);
  const moved = handPos('LeftHand').distanceTo(b2);
  check(moved < 0.03, `twist 只拧骨段，手尖几乎不动（位移 ${moved.toFixed(4)}m）`, `位移 ${moved.toFixed(4)}`);

  // --- 淡入：必须渐变，不能跳变 ---------------------------------------
  reset();
  const boneObj = root.getObjectByName('LeftArm');
  const child = boneObj.children.find((c) => c.isBone);
  const along = child.getWorldPosition(new THREE.Vector3())
    .sub(boneObj.getWorldPosition(new THREE.Vector3())).normalize();
  const away = new THREE.Vector3(1, 0, 0);
  const outAxis = along.clone().cross(away).normalize();

  driver.setPose({ id: 'p', bones: { LeftArm: { out: 0.6 } } }, { fade: 0.6 });
  const samples = [];
  for (let i = 0; i < 4; i++) {
    driver.update({ t: 0, dt: 0.15 });
    samples.push(angleAbout(root, 'LeftArm', restQ.get('LeftArm'), outAxis));
  }
  const rising = samples.every((v, i) => i === 0 || v > samples[i - 1] + 1e-6);
  check(rising && samples[0] < 0.3 && samples[3] > 0.55 && samples[3] <= 0.61,
    `0.6s 淡入是渐进的：${samples.map((v) => v.toFixed(3)).join(' → ')}`,
    samples.join(','));
}

// ---------------------------------------------------------------------------
// ★ 语义轴本身：out 必须正交于 fwd
// ---------------------------------------------------------------------------
// ⚠️ 上面两组合成骨架**够不到**这个状态 —— 这是 2026-09-26 变异实测出来的：
//    把 src/anim/semAxes.js 里那行 `out.addScaledVector(fwd, -out.dot(fwd));`
//    整行删掉，上面 69 项**照旧全绿**。
//
//    原因可以算出来：out 和 fwd 都垂直于骨段 d，于是
//        out_raw · fwd = away_z − (away·d)(F·d)
//    而 DEFS 里每根骨的 z 都是 0 —— away_z = 0、d_z = 0，右边恒等于 0。
//    也就是说那两棵树上手臂从来不往身前伸，正交化是**空操作**，
//    这条轴怎么算都正交。
//
//    可 src/anim/semAxes.js 顶部记的那次事故（Quaternius T-pose 骨架上
//    前臂残差 102°）正是这一条失效造成的：out 与 fwd 共线时三个角只剩两个
//    自由度，合成不回原来的旋转。所以这里另搭一棵**手臂往身前伸**的骨架
//    （带 z 分量），让 away 和 F 在「垂直于骨段的平面」里不再正交。
console.log('\n=== 语义轴：out 必须 ⟂ fwd（三个角才有三个自由度）===');
{
  const root = new THREE.Object3D();
  const mk = (name, parent, pos) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(pos[0], pos[1], pos[2]);
    parent.add(b);
    return b;
  };
  const hips = mk('Hips', root, [0, 1.00, 0]);
  const la = mk('LeftArm', hips, [0.18, -0.10, 0.06]);
  mk('LeftHand', la, [0.20, -0.26, 0.30]);   // 前臂往身前伸 → 骨段带 z
  const ra = mk('RightArm', hips, [-0.18, -0.10, 0.06]);
  mk('RightHand', ra, [-0.20, -0.26, 0.30]);
  root.updateWorldMatrix(true, true);

  const ax = buildSemAxes({ Hips: hips, LeftArm: la, RightArm: ra });
  for (const n of ['LeftArm', 'RightArm']) {
    const d = ax[n].out.dot(ax[n].fwd);
    check(Math.abs(d) < 1e-6,
      `${n} 的 out ⟂ fwd（点积 ${d.toExponential(1)}）`,
      `点积 ${d.toFixed(6)} —— 不正交时 out/fwd/twist 三个角只剩两个自由度，`
      + '合成不回原来的旋转（semAxes.js 顶部那次 102° 残差就是这么来的）');
  }
}

// ---------------------------------------------------------------------------
// 姿势调度器：状态池、抢占、播完回归
// ---------------------------------------------------------------------------
console.log('\n=== 姿势调度器 ===');
{
  const root = buildRig('x');
  const driver = createRigDriver(root);
  const seen = [];
  const sched = createPoseScheduler(driver, { onPose: (p) => seen.push(p.id) });

  const poses = IDLE_POSES;
  const idleIds = new Set(poses.filter((p) => p.tag === 'idle').map((p) => p.id));
  const thinkIds = new Set(poses.filter((p) => p.tag === 'think').map((p) => p.id));
  const loadIds = new Set(poses.filter((p) => p.tag === 'load').map((p) => p.id));

  // 库里必须有足够多的 idle 姿势（用户要的是"预置 10 个左右"）
  check(poses.length >= 10, `姿势库有 ${poses.length} 个（要求 ≥10）`, `${poses.length}`);
  check(idleIds.size >= 6, `其中待机 ${idleIds.size} 个`, `${idleIds.size}`);
  check(thinkIds.size >= 2, `思考 ${thinkIds.size} 个`, `${thinkIds.size}`);
  check(loadIds.size >= 1, `加载 ${loadIds.size} 个`, `${loadIds.size}`);

  // 每个姿势引用的骨必须都被骨架认出来，否则写了也白写（静默失效）
  const known = new Set(Object.keys(driver.mapping));
  const bad = [];
  for (const p of poses) {
    for (const b of Object.keys(p.bones)) if (!known.has(b)) bad.push(`${p.id}:${b}`);
  }
  check(bad.length === 0, `所有姿势引用的骨都被识别（${known.size} 根可用）`, `未识别 ${bad.join(', ')}`);

  // 跑 30 秒，idle 池里应该换过好几个姿势，而且不连着重复
  //
  // ⚠️ 这里把 Math.random 钉成一个常数 —— 2026-09-26 变异实测出来的：
  //    把 poseScheduler 里 `all.filter((p) => p.id !== lastId)` 改成 `all`
  //    （去掉去重），这一段**照样全绿**。18 个姿势随机抽、只换七八次，
  //    连着抽中同一个的概率本来就不高 —— 那条 `dup === 0` 的断言其实是在
  //    **碰运气**：它绿了不代表去重还在，它真红了也会被当成随机波动。
  //
  //    钉成常数之后「抽中谁」变成可预测的：有去重时在两个中间位之间来回摆，
  //    去重一拿掉就永远停在同一根 —— 概率问题由此变成确定性问题。
  //    （不这么做的话，只能靠"多跑几次"来碰，那不算防线。）
  const realRandom = Math.random;
  Math.random = () => 0.5;
  try {
    sched.update(0, 0.016);
    for (let i = 0; i < 1900; i++) sched.update(i * 0.016, 0.016);
  } finally {
    Math.random = realRandom;
  }
  let dup = 0;
  for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) dup++;
  check(seen.length >= 4, `30 秒内换了 ${seen.length} 次姿势`, `${seen.length}`);
  check(dup === 0, `没有连着播同一个姿势`, `重复 ${dup} 次`);
  check(seen.every((id) => idleIds.has(id)), `默认状态只从 idle 池挑`, seen.join(','));

  // 切到 think：下一个姿势必须来自 think 池
  // ⚠️ setState 是**同步**换姿势的，before 必须在它之前取，否则会把这次也切掉
  const before = seen.length;
  sched.setState('think');
  for (let i = 0; i < 120; i++) sched.update(30 + i * 0.016, 0.016);
  const afterThink = seen.slice(before);
  check(afterThink.length > 0 && thinkIds.has(afterThink[0]),
    `切到 think 后换成 ${afterThink[0]}（属于 think 池）`, afterThink.join(','));

  // 抢占：反应姿势插进来，播完要回 think 池
  const okReact = sched.react('startle');
  check(okReact && sched.isReacting(), `react('startle') 抢占成功`);
  check(seen[seen.length - 1] === 'startle', `当前姿势变成 startle`, seen[seen.length - 1]);
  for (let i = 0; i < 120; i++) sched.update(40 + i * 0.016, 0.016);
  check(!sched.isReacting(), `反应 0.5s 后自动结束`);
  check(thinkIds.has(seen[seen.length - 1]), `播完回到 think 池（${seen[seen.length - 1]}）`, seen[seen.length - 1]);

  // 不存在的 id 要老实返回 false，不能偷偷播个别的
  check(sched.react('不存在的姿势') === false, `react 未知 id 返回 false`);

  // 没 rig 的时候整个调度器必须安静空转，不能抛
  const blank = createPoseScheduler(null);
  let threw = null;
  try { blank.update(0, 0.016); blank.setState('think'); blank.react('startle'); }
  catch (e) { threw = e; }
  check(!threw, `没有 rig 时调度器空转不抛错`, threw?.message);
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

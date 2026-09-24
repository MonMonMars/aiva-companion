#!/usr/bin/env node
// 把 Quaternius CC0 动画库的骨骼动画**烘焙成我们角色能直接用的姿势序列**。
//
// 为什么要在构建期烘焙，而不是运行时直接播：
//   1. 运行时不需要再加载 6.5MB 的那个 GLB（它自带网格、贴图、手指骨，我们只要旋转）
//   2. 那套骨架和我们的角色不同名不同朝向，运行时重定向每帧都要算，代价高且容易错
//
// 产物每帧每根骨存一个 **Δ 四元数**（这根骨在父骨基础上额外转多少），
// 直接喂给 rigDriver 的 `__dq` 通道（见 src/three/rigDriver.js）。
//
// ---------------------------------------------------------------------------
// ⚠️⚠️ 为什么是四元数，不是 yaw/pitch/roll 那套语义角（走过弯路，记下来）
//
//   最早烘的是语义角。思路是：把 Δ 拆到 semAxes 的三根轴上，
//   竖直骨拆成 yaw/pitch/roll，手臂拆成 out/fwd/twist。跑通了，残差也只有
//   0.00094 rad（拆角确实是合成的逆运算），但**播放出来前臂会原地乱转**。
//
//   原因：欧拉角三元组在中轴 ±90° 处有万向锁，而"手肘弯 90°"正好在这个点上。
//   实测 Idle_Talking_Loop 的右前臂 fwd 全程 86°~96° —— 整段都贴在奇点上：
//   源动画几乎没动，拆出来的 out 却在 -167°~+17° 之间乱摆。
//   单看每一帧姿态都对（残差极小），可线性插值会从 -167° 扫到 -138°，
//   前臂就自己在那儿转。
//
//   试过所有补救：副解换分支、循环动作跑两遍、按跳变阈值判定……都只能把
//   最坏值从 380° 压到 115°，治不了根 —— 换成四元数之后，这些问题一次全没了：
//   slerp 天然走最短路，也没有奇点、没有分支、不用去绕行。
//
// ---------------------------------------------------------------------------
// ⚠️ 第四个坑：**只烘旋转不够，根的上下位移必须一起烘**（后补的，务必看完）
//
//   一开始只烘 Δ 四元数。播 Dance_Loop 时她脚离地 6cm，看着像"飘"。
//   量了源动画才发现：源动画里她**脚全程踩在地上**（最低脚 −1~0mm），
//   舞步是靠**髋下沉 7.1cm + 屈膝**做出来的。我们把髋的位移丢了，髋不动、
//   腿照弯，多出来的量全顶到脚上 —— 这就是那 6cm。
//   坐下(髋 −0.375)、蹲(−0.45)、马步(−0.19) 这些更是缺了位移根本不成立。
//
//   所以现在同时烘 `rootY`（每帧髋骨的世界高度，相对 rest，**单位是米**），
//   运行时加在根节点上。⚠️ 试过按"髋踝跨度"归一化成比例，放弃了：
//   运行时那边的 mapping 里 'Hips' 其实指向**骨架根节点**（世界高度 ≈ 0，
//   而真正的髋在 LeftUpLeg ≈ 1.12），量出来的跨度只有 0.135m，位移被缩了六倍。
//
//   配套：腿被驱动的片段要在产物里标 `legs: true`，运行时据此让落地支撑
//   **只做有上限的补偿**（12cm），否则它会把跳跃和翻滚按进地板里。
//
// ---------------------------------------------------------------------------
// ⚠️⚠️ 三个必须记住的坑（每一个都会静默产出"能跑但动作全错"的结果）
//
// 坑 1：**骨名被 three 洗过了**。
//   GLTFLoader 走 PropertyBinding.sanitizeNodeName，会把 `.` `[` `]` `:` `/`
//   直接吞掉。glTF 里叫 `DEF-spine.001`，到 scene 里已经变成 `DEF-spine001`；
//   `DEF-shoulder.L` → `DEF-shoulderL`。照着 glTF 原名去查，22 根骨只能命中 3 根
//   （DEF-hips / DEF-neck / DEF-head 这三个没点的），而且不报错 —— 只是烘出来的
//   动作只有头在动。查表前两边都要 sanitize。
//
// 坑 2：**Δ 必须是"相对父骨"的，不能是"相对 rest"的累积量**。
//   rigDriver 的合成式是 W_i = Δ_i · M_parent · R_i，M_parent 里已经含了
//   祖先骨的全部 Δ。所以 Δ 表达的是"这一根在父骨基础上额外转多少"：
//       Δ_i = D_i · D_parent⁻¹   （D = 世界朝向 · rest 世界朝向⁻¹）
//   直接烘 D_i（相对 rest 的累积量）会让父骨的运动被重复叠加 ——
//   脊柱转 10°，胸椎跟着继承这 10°，再自己加一次 10°，整个人拧成麻花。
//
// 坑 3：**源骨架是 T-pose 绑定的，我们是 A-pose**。
//   Quaternius 的模型双臂平举（T），我们的角色双臂下垂。实测上臂仰角 -70°，
//   也就是差 70°。所以要把源**上臂**在世界空间里往下转 70°，
//   再以那个姿态为 rest 基准 —— 不然一播放手臂就"唰"地抬成 T 字。
//   注意：是给 rest 用的补正，不是给每个采样帧加常量偏移。
//
// 用法：node tools/motion-bake.mjs assets/motion/raw/ual-standard.glb
// 产物：src/anim/motionClips.json

import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { UAL_BONE_MAP, UAL_META, UAL_LEG_BONES, UAL_SKIP_BONES } from '../src/anim/motionLibrary.js';

const SRC = process.argv[2] || 'assets/motion/raw/ual-standard.glb';
const OUT = process.argv[3] || 'src/anim/motionClips.json';
/** 采样密度（帧/秒）。动作快的片段自动多采几帧，慢的少采几帧，控制文件体积 */
const FPS = Number(process.env.FPS || 12);
const MIN_SAMPLES = Number(process.env.MIN_SAMPLES || 8);
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES || 24);
/** 小于这个转角的骨整帧丢掉：省体积，而且 0.7° 以下肉眼根本看不出来 */
const DROP_ANGLE = 0.012;

// --- 读模型 ---------------------------------------------------------------
const buf = fs.readFileSync(SRC);
const gltf = await new Promise((resolve, reject) => {
  new GLTFLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    '',
    resolve,
    reject,
  );
});
const scene = gltf.scene;

// 坑 1：three 把骨名里的 `. [ ] : /` 都吃掉了，查表前两边都得洗一遍
const sanitize = (s) => String(s || '').replace(/\s/g, '_').replace(/[[\].:/]/g, '');

const byName = new Map();
scene.traverse((o) => {
  if (o.isBone) byName.set(sanitize(o.name), o);
});

/** 规范名 → 源骨骼；以及规范名 → 父规范名 */
const map = new Map();
const parentCanon = new Map();
const missing = [];
for (const [src, canon] of Object.entries(UAL_BONE_MAP)) {
  const bone = byName.get(sanitize(src));
  if (!bone) { missing.push(src); continue; }
  map.set(canon, bone);
}
// 父关系按**规范名**重建：从这根骨往上找第一个也在映射表里的祖先
const srcToCanon = new Map();
for (const [canon, bone] of map) srcToCanon.set(bone, canon);
for (const [canon, bone] of map) {
  let p = bone.parent;
  while (p && !srcToCanon.has(p)) p = p.parent;
  if (p) parentCanon.set(canon, srcToCanon.get(p));
}

console.log(`骨映射 ${map.size}/${Object.keys(UAL_BONE_MAP).length}`
  + (missing.length ? `\n⚠ 认不出的骨: ${missing.join(', ')}` : ''));

// --- 实测角色朝向，以及 A-pose 补正 ---------------------------------------
const UP = new THREE.Vector3(0, 1, 0);

/** 水平分量；太短的当没有（脚趾/脚这种几乎垂直的骨会退化） */
function horizontal(v) {
  const h = new THREE.Vector3(v.x, 0, v.z);
  return h.lengthSq() < 1e-8 ? null : h.normalize();
}

// 用"脚趾 − 脚"的水平方向当朝向：Blender 系的模型通常朝 -Y，不能写死 +Z
let F = null;
for (const side of ['Left', 'Right']) {
  const foot = map.get(`${side}Foot`);
  const toe = map.get(`${side}Toe`);
  if (!foot || !toe) continue;
  scene.updateWorldMatrix(true, true);
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  const d = horizontal(wp(toe).sub(wp(foot)));
  if (d) { F = d; break; }
}
if (!F) F = new THREE.Vector3(0, 0, 1);
console.log(`角色朝向 F = (${F.x.toFixed(2)}, ${F.y.toFixed(2)}, ${F.z.toFixed(2)})`);

// 坑 3：源骨架绑的是 T-pose，我们是 A-pose，上臂差 70°
const APOSE = (Number(process.env.APOSE_DEG ?? 70) * Math.PI) / 180;
const aposeQ = new Map();
for (const side of ['Left', 'Right']) {
  const bone = map.get(`${side}Arm`);
  if (!bone) continue;
  const child = map.get(`${side}ForeArm`);
  // 骨段方向：有子骨就用"→子骨"，没有就用"父→自己"
  const d = child
    ? child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3()))
    : bone.getWorldPosition(new THREE.Vector3()).sub(bone.parent.getWorldPosition(new THREE.Vector3()));
  if (d.lengthSq() < 1e-8) continue;
  d.normalize();
  const axis = d.clone().cross(UP);
  if (axis.lengthSq() < 1e-8) continue;
  axis.normalize();
  aposeQ.set(bone, new THREE.Quaternion().setFromAxisAngle(axis, -APOSE));
}
function applyAPose() {
  const Wp = new THREE.Quaternion();
  const conj = new THREE.Quaternion();
  for (const [bone, q] of aposeQ) {
    bone.getWorldQuaternion(Wp);
    conj.copy(Wp).invert().multiply(q).multiply(Wp);
    bone.quaternion.premultiply(conj);
  }
}
applyAPose();
console.log(`A-pose 补正 ${((APOSE * 180) / Math.PI).toFixed(1)}°（上臂 ×${aposeQ.size}）`);

// rest 世界朝向必须**在补正之后**取，不然基准就错了
scene.updateWorldMatrix(true, true);
const restQ = new Map();
for (const [canon, bone] of map) restQ.set(canon, bone.getWorldQuaternion(new THREE.Quaternion()));

// --- 根（髋）的上下位移 -----------------------------------------------------
//
// ⚠️ 这一段是踩过坑才加的：最早只烘骨骼**旋转**，根位移整个丢了。
//    结果 Dance_Loop 一播，脚离地 6cm —— 因为她本来是"髋下沉 7cm + 屈膝"
//    来跳舞的（实测源动画：髋 -0.071~-0.006，而最低的脚始终 -0.001~0.000，
//    也就是**脚全程踩在地上**）。髋不动、腿却按源动画弯，多出来的量全顶到脚上，
//    脚就被抬起来了。坐下(-0.375)、蹲(-0.45)、持剑马步(-0.19)同理，
//    没有根位移这些动作根本成立不了。
//
// ⚠️ 试过按「髋踝跨度」归一化，放弃了：运行时那边的量法不可靠 ——
//    我们的 mapping 里 'Hips' 其实指向**骨架根节点**（实测世界高度 -0.02，
//    而真正的髋关节 LeftUpLeg 在 1.12），量出来的"跨度"是 0.135m，
//    根位移因此被缩小六倍。改成直接存米：库里的角色和我们都是成年人比例，
//    差的那几个百分点交给落地支撑的小额补偿去抹平。
const wpos = (o) => o.getWorldPosition(new THREE.Vector3());
const restHipsY = map.get('Hips') ? wpos(map.get('Hips')).y : null;

// --- 采样每个 clip --------------------------------------------------------
const mixer = new THREE.AnimationMixer(scene);
const clips = {};
let worstJump = 0;
let worstJumpWhere = '';
let maxAbsAngle = 0;

for (const clip of gltf.animations) {
  const meta = UAL_META[clip.name];
  if (!meta) continue;   // 没登记的动作不烘（库里有一堆开枪/游泳，我们不要）

  const samples = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(clip.duration * FPS)));
  const action = mixer.clipAction(clip);
  action.play();

  const frames = [];
  // 这个片段的腿是不是被驱动的？只有腿被驱动的片段才烘根位移 ——
  // 腿被锁死（待机类）时把根往下移，只会让僵直的腿把脚插进地里。
  const legsDriven = meta.keepLegs !== false;
  const rootY = legsDriven ? [] : null;
  const prevQ = new Map();     // 自检用：上一帧这根骨的 Δ
  for (let i = 0; i < samples; i++) {
    mixer.setTime((clip.duration * i) / samples);
    scene.updateWorldMatrix(true, true);

    if (rootY && restHipsY != null) {
      rootY.push(Number((wpos(map.get('Hips')).y - restHipsY).toFixed(5)));
    }

    // 先算每根骨"相对 rest 的累积量 D"
    const D = new Map();
    for (const [canon, bone] of map) {
      D.set(canon, bone.getWorldQuaternion(new THREE.Quaternion()).multiply(restQ.get(canon).clone().invert()));
    }
    // 再剥掉父骨那一份，得到 rigDriver 语义下的 Δ（坑 2）
    const frame = {};
    for (const [canon] of map) {
      if (UAL_SKIP_BONES.has(canon)) continue;
      if (meta.keepLegs === false && UAL_LEG_BONES.has(canon)) continue;
      let dq = D.get(canon).clone();
      const pc = parentCanon.get(canon);
      if (pc) dq = dq.multiply(D.get(pc).clone().invert());
      dq.normalize();

      const ang = 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
      if (ang > maxAbsAngle) maxAbsAngle = ang;
      // 自检：相邻帧的真实转角。四元数没有分支问题，这个数就是"动作有多快"，
      // 留着当体检指标 —— 突然冒出几百度的说明采样或映射出问题了。
      const prev = prevQ.get(canon);
      if (prev) {
        const jump = 2 * Math.acos(Math.min(1, Math.abs(prev.dot(dq))));
        if (jump > worstJump) { worstJump = jump; worstJumpWhere = `${clip.name}#${i} ${canon}`; }
      }
      prevQ.set(canon, dq.clone());

      if (ang > DROP_ANGLE) frame[canon] = dq.toArray().map((v) => Number(v.toFixed(4)));
    }
    frames.push(frame);
  }
  action.stop();

  clips[clip.name] = {
    name: meta.name,
    tag: meta.tag,
    loop: !!meta.loop,
    face: meta.face ?? null,
    hold: meta.hold,
    duration: Number(clip.duration.toFixed(3)),
    // legs = 腿骨是否被驱动。腿被驱动的片段由动画自己负责下半身，
    // 落地支撑（groundLock）必须让开 —— 不然它为了钉住脚，会把跳跃/翻滚
    // 按进地板里。运行时据此开关，见 companion.js。
    legs: legsDriven,
    // 每一帧根的上下位移（米，负数 = 下沉）。和 frames 一一对应。
    rootY,
    frames,
  };
  const ry = rootY ? `  根位移 ${Math.min(...rootY).toFixed(3)}~${Math.max(...rootY).toFixed(3)}m` : '';
  console.log(`  ✓ ${clip.name.padEnd(24)} ${clip.duration.toFixed(2)}s × ${samples} 帧${ry}`);
}

const payload = {
  // 出处与授权写进产物里 —— 这份 JSON 会被打进 bundle，出处必须跟着走
  source: 'Quaternius · Universal Animation Library (Standard, free)',
  license: 'CC0 1.0 Universal (Public Domain Dedication)',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  author: 'Quaternius (https://quaternius.com)',
  bakedBy: 'tools/motion-bake.mjs',
  format: 'dq',        // 每帧每根骨一个 Δ 四元数 [x,y,z,w]，喂 rigDriver 的 __dq
  rootYUnit: 'meter',     // 根的上下位移直接是米，见上面那段说明
  forward: [Number(F.x.toFixed(4)), Number(F.y.toFixed(4)), Number(F.z.toFixed(4))],
  clips,
};

console.log(`\n四元数自检：相邻帧最大真实转角 ${((worstJump * 180) / Math.PI).toFixed(1)}°（${worstJumpWhere || '无'}）`
  + `  ${worstJump < Math.PI ? '✓ 没有跳分支（四元数本来也不会）' : '✗ 采样或骨映射有问题'}`);
console.log(`单次最大 Δ ${((maxAbsAngle * 180) / Math.PI).toFixed(1)}°`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));
console.log(`\n✓ ${OUT}  ${Math.round(fs.statSync(OUT).size / 1024)}KB  ${Object.keys(clips).length} 个动作`);

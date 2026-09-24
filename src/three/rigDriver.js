// 驱动绑定好骨架的真模型
// ---------------------------------------------------------------------------
// 背景：程序化角色（手搓几何体）的动画是直接转 `character.head` / `character.arms`。
// 但真模型是 SkinnedMesh —— 它的动作必须转**骨骼**，转容器没用。
//
// 这个模块负责：
//   1. 从挂上来的模型里把标准名的骨骼找出来（用 anim/rigStandard.js 的别名表）
//   2. 把"语义动作"（yaw/pitch/roll、out/fwd/twist）变成骨骼的实际转角
//   3. 在 rest 姿态上叠加两层：程序化动画 + 待机姿势（含交叉淡入）
//
// ⚠️ 踩过的最大的坑：**不要用"本地某一根轴加一个欧拉角"来表达语义动作**。
//    骨骼的本地轴朝向是没有保证的 —— Mixamo 骨段沿本地 +Y，这批 VRM 沿本地 +X，
//    有些骨还会绕自己长轴再拧一下。这时候"低头"根本不是"绕本地 x 转"，
//    本地轴和世界轴差 40°，硬凑出来的动作方向就是歪的，而且**不报错**。
//    （第一版就是这么写的，被 tools/test-rig-semantics.mjs 用合成骨架当场抓出来）
//
//    现在的做法：先在**世界空间**里算出增量旋转 Δ（绕世界 Y/X/Z，或绕骨段相关的轴），
//    再自上而下合成 `W_i = Δ_i · M_parent · R_i`（R 是 rest 世界朝向），
//    最后换算回本地四元数 `L_i = W_parent⁻¹ · W_i`。
//
//    M_parent 是父节点的**运动因子** `W · R⁻¹`。乘它有两个作用：
//      · 舞台的呼吸摆动（root.rotation.y）能被一级级传下去
//      · **子骨继承父骨的 Δ** —— 脖子转了头会跟着走。
//        少了这一层，"抬头"会变成头留在原地、脖子从下面转出去。
//
// 关键：这个模块**不做任何渲染**，只摆骨骼的 rotation。

import * as THREE from 'three';
import { mapSkeleton, rigCoverage } from '../anim/rigStandard';
// 语义轴挪到 anim/semAxes.js 了 —— tools/motion-bake.mjs 也得用**同一套**，
// 两边各写一份迟早算得不一样，烘出来的角度到运行时就走形。
import { buildSemAxes, ARM_BONES, VERT_KEYS, ARM_KEYS } from '../anim/semAxes';

export { buildSemAxes };

/** 找出一棵子树里所有 Bone（DFS 先序，父一定在子之前 —— 合成顺序靠它） */
function collectBones(root) {
  const list = [];
  root.traverse((o) => {
    if (o.isBone) list.push({ name: o.name, obj: o });
  });
  return list;
}

const lerp = (a, b, w) => a + (b - a) * w;
/** 平滑进出，避免淡入的头尾有速度突变 */
const ease = (w) => w * w * (3 - 2 * w);

/**
 * @param {THREE.Object3D} object3D 已经挂到舞台上的模型根节点
 * @returns {null | object} 驱动句柄；认不出骨架就返回 null（调用方降级）
 */
export function createRigDriver(object3D) {
  if (!object3D) return null;

  const boneList = collectBones(object3D);
  if (!boneList.length) return null;

  const { mapping, unknown, missing } = mapSkeleton(boneList);
  const cov = rigCoverage(mapping);

  // 核心骨缺一半以上就当它没法驱动 —— 硬转只会在屏幕上把模型扭成麻花
  if (cov.ratio < 0.5) {
    console.warn(
      `[rig] 骨架覆盖率只有 ${Math.round(cov.ratio * 100)}%，放弃驱动（缺 ${cov.missing.join(', ')}）`
    );
    return null;
  }

  // 量轴之前必须先把整棵树的世界矩阵刷一遍，否则拿到的是上一次的脏矩阵
  object3D.updateWorldMatrix(true, true);

  // rest 姿态的世界四元数（整棵子树都记，因为父节点可能是普通 Object3D）
  const restWorldQ = new Map();
  object3D.traverse((o) => restWorldQ.set(o, o.getWorldQuaternion(new THREE.Quaternion())));

  // 角色在舞台上永远面朝 +Z，所以竖直骨的语义轴就是世界轴（默认值，不用传 forward）
  const semAxes = buildSemAxes(mapping);

  // 规范名 → 该骨的语义键列表；以及 Object3D → 规范名（反查）
  const canonOf = new Map();
  for (const [name, obj] of Object.entries(mapping)) if (obj) canonOf.set(obj, name);

  // 合成顺序：整棵子树 DFS 先序（父一定在子之前）。
  // 不能只列 Bone —— 中间可能夹着 Armature 这类普通节点，漏了它子骨会拿不到运动因子。
  const order = [];
  object3D.traverse((o) => order.push(o));

  const has = (n) => !!mapping[n];

  // --- 本帧的语义角 --------------------------------------------------------
  let angles = {};
  /** 叠加一个语义动作。认不出的骨 / 数值为 0 直接忽略，不抛错 */
  const sem = (n, key, v) => {
    if (!v || !mapping[n]) return;
    const a = angles[n] || (angles[n] = {});
    a[key] = (a[key] || 0) + v;
  };

  // --- 姿势淡入：A 是切换瞬间冻住的混合值，B 是目标 -------------------------
  let poseA = {};
  let poseB = {};
  let poseT = 1;
  let poseDur = 0.6;
  let poseId = null;
  let poseWeight = 0;

  const blendW = () => ease(Math.min(1, Math.max(0, poseT)));

  /** 把当前正在生效的姿势值冻成快照（淡入起点） */
  function snapshot() {
    const w = blendW();
    const out = {};
    for (const b of new Set([...Object.keys(poseA), ...Object.keys(poseB)])) {
      out[b] = blendBone(poseA[b] || {}, poseB[b] || {}, w);
    }
    return out;
  }

  /**
   * 换个姿势。默认 0.6s 内交叉淡入，不跳变。
   * @param {object|null} pose 来自 anim/idlePoses.js；传 null = 淡回站立
   * @param {object} [opts] { fade: 秒 }
   */
  function setPose(pose, opts) {
    poseA = snapshot();                  // 先冻住"现在长什么样"，否则会闪一下
    poseB = {};
    for (const [b, keys] of Object.entries(pose?.bones || {})) {
      if (mapping[b]) poseB[b] = { ...keys };   // 认不出的骨直接丢掉，不报错
    }
    poseT = 0;
    poseDur = Math.max(0.016, opts?.fade ?? 0.6);
    poseId = pose?.id ?? null;
    return poseId;
  }

  function clearPose(opts) {
    return setPose(null, opts);
  }

  // --- 动作片段通道 --------------------------------------------------------
  //
  // 和 setPose 的区别：setPose 每次调用都会**重新开始**一次淡入（poseA 冻快照、
  // poseT 归零）。动作片段要每帧换一帧姿势，走 setPose 的话淡入会被无限重置，
  // 永远停在起点的 0%。
  //
  // 所以这里分两步：开播时冻一次快照、起一次淡入；之后每帧只换 poseB 的内容，
  // 不动 poseT。淡入结束后 poseT 恒为 1，poseB 就逐帧直接生效。
  let motionOn = false;

  /** @param {object} bones { 规范名: { __dq: [x,y,z,w] } } */
  function setMotion(bones, opts) {
    if (!motionOn) {
      poseA = snapshot();                 // 从"现在这个样子"淡进去，不闪
      poseT = 0;
      poseDur = Math.max(0.016, opts?.fade ?? 0.35);
      motionOn = true;
      poseId = null;
    }
    poseB = {};
    for (const [b, v] of Object.entries(bones || {})) {
      if (mapping[b]) poseB[b] = v;       // 认不出的骨直接丢掉，不报错
    }
  }

  /** 收动作：淡回没有片段的状态（姿势调度器会接着接管） */
  function clearMotion(opts) {
    if (!motionOn) return;
    poseA = snapshot();
    poseB = {};
    poseT = 0;
    poseDur = Math.max(0.016, opts?.fade ?? 0.45);
    motionOn = false;
  }

  // --- 复用的临时量，避免每帧 new 一堆四元数 -------------------------------
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _q3 = new THREE.Quaternion();
  const _invRest = new THREE.Quaternion();
  const _dqA = new THREE.Quaternion();
  const _dqB = new THREE.Quaternion();
  const poolW = [];
  const poolM = [];
  const W = new Map();
  const M = new Map();

  /**
   * 语义角 → 世界空间增量旋转 Δ。
   *
   * 除了 yaw/pitch/roll、out/fwd/twist，还认一个 `__dq`：**直接给一个 Δ 四元数**。
   * 动作片段（anim/motionClips.json）走这条路 ——
   *
   *   为什么动作片段不烘成语义角：欧拉角在中轴 ±90° 处有万向锁，而"手肘弯 90°"
   *   正好就在这个点上。实测 Idle_Talking_Loop 的右前臂 fwd 全程 86°~96°，
   *   也就是**整段都贴在奇点上**：源动画几乎没动，拆出来的 out 却在 -167°~+17° 乱摆，
   *   线性插值是前臂原地乱转。四元数没有奇点，插值走最短路，天然没这个问题。
   *
   * `__dq` 可以只写它（动作片段独占这根骨），也可以和语义角同时存在 ——
   * 这时候 `__dq` 在外层、语义角在内层，动作片段盖住程序化的那点呼吸摆动。
   */
  function deltaQuat(name, a) {
    const ax = semAxes[name];
    if (!ax) return null;
    const isArm = !!ax.out;
    const keys = isArm ? ARM_KEYS : VERT_KEYS;
    let any = false;
    for (const k of keys) if (Math.abs(a[k] || 0) > 1e-6) { any = true; break; }
    if (!any && !a.__dq) return null;

    if (!any) {
      // 只有动作片段：直接用它
      return a.__dq.isQuaternion ? _q.copy(a.__dq) : _q.fromArray(a.__dq);
    }

    // 语义角那一份（由内到外：竖直骨 roll→pitch→yaw，手臂 out→fwd→twist）
    _q3.setFromAxisAngle(ax[keys[0]], a[keys[0]] || 0);
    _q2.setFromAxisAngle(ax[keys[1]], a[keys[1]] || 0);
    _q3.premultiply(_q2);
    _q2.setFromAxisAngle(ax[keys[2]], a[keys[2]] || 0);
    _q3.premultiply(_q2);

    if (!a.__dq) return _q3;
    // 动作片段在最外层
    return a.__dq.isQuaternion
      ? _q.copy(a.__dq).multiply(_q3)
      : _q.fromArray(a.__dq).multiply(_q3);
  }

  /** 两个"可能带 __dq 的骨值"按 w 混合：语义角线性插值，__dq 走 slerp */
  function blendBone(a, c, w) {
    const o = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(c)])) {
      if (k === '__dq') continue;
      o[k] = lerp(a[k] || 0, c[k] || 0, w);
    }
    if (a.__dq || c.__dq) {
      // 缺的那一边当"没转"处理，这样淡入淡出是从当前姿态平滑过渡，不会闪
      const qa = a.__dq
        ? (a.__dq.isQuaternion ? _dqA.copy(a.__dq) : _dqA.fromArray(a.__dq))
        : _dqA.set(0, 0, 0, 1);
      const qb = c.__dq
        ? (c.__dq.isQuaternion ? _dqB.copy(c.__dq) : _dqB.fromArray(c.__dq))
        : _dqB.set(0, 0, 0, 1);
      o.__dq = qa.slerp(qb, w).clone();   // 必须 clone：池里的对象下一根骨还要用
    }
    return o;
  }

  /**
   * 每帧调用。参数语义和程序化角色完全一致。
   * @param {object} s 状态
   * @param {number} s.t 累计时间（秒）
   * @param {number} s.dt 帧间隔（秒）—— 姿势淡入要用，没传就按 60fps
   * @param {number} s.headTilt 撒娇歪头量
   * @param {number} s.armRaise 抬手量（0~1.2）
   * @param {number} s.lookX 视线横向（-1~1，+ 为画面右）
   * @param {number} s.lookY 视线纵向（-1~1，+ 为上看）
   * @param {number} s.bounce 弹跳量
   */
  function update(s) {
    const { t, dt = 1 / 60, headTilt = 0, armRaise = 0, lookX = 0, lookY = 0, bounce = 0 } = s || {};

    // 姿势进度推进；到位后把 A 并到 B，省掉每帧重复的插值
    if (poseT < 1) {
      poseT = Math.min(1, poseT + dt / poseDur);
      if (poseT >= 1) poseA = poseB;
    }
    const w = blendW();
    poseWeight = Object.keys(poseB).length ? w : 0;

    // 本帧的语义角清零
    angles = {};

    // --- 呼吸：胸腔轻微起伏 ----------------------------------------------
    sem('Spine1', 'pitch', Math.sin(t * 1.7) * 0.02);

    // --- 头：跟指尖转 + 呼吸微动 -----------------------------------------
    // 脖子承担 60%，头承担 40% —— 只转头会像机械头，只转脖子会像鬼。
    const neckYaw = lookX * 0.34;
    const neckPitch = -lookY * 0.20 + Math.sin(t * 0.9) * 0.015;
    const neckRoll = Math.sin(t * 0.6) * 0.02 + headTilt * 0.45;

    sem('Neck', 'yaw', neckYaw * 0.6);
    sem('Neck', 'pitch', neckPitch * 0.6);
    sem('Neck', 'roll', neckRoll * 0.6);
    sem('Head', 'yaw', neckYaw * 0.4);
    sem('Head', 'pitch', neckPitch * 0.4);
    sem('Head', 'roll', neckRoll * 0.4);

    // --- 手臂：待机轻摆 + 被摸时抬起来 -----------------------------------
    // 姿势里已经写了手臂造型的话，把程序化摆臂压掉大半，不然两层会打架。
    const swing = Math.sin(t * 1.3) * 0.06 * (1 - poseWeight * 0.8);
    for (const side of ['Left', 'Right']) {
      sem(`${side}Arm`, 'out', armRaise * 0.75 + swing * 0.5);
      // 略前伸，避免抬手时手从身体里穿出去
      sem(`${side}Arm`, 'fwd', armRaise * 0.20);
      // 前臂跟着弯一点，像猫被挠下巴
      sem(`${side}ForeArm`, 'fwd', armRaise * 0.45);
      // 锁骨也抬一点，不然肩膀是死的
      sem(`${side}Shoulder`, 'out', armRaise * 0.22);
    }

    // --- 弹跳：整体上下（交给 stage 做，这里只补一点腿部下蹲）-------------
    if (bounce > 0) {
      const crouch = Math.max(0, 1 - bounce * 2.2) * 0;
      sem('LeftUpLeg', 'pitch', crouch);
      sem('RightUpLeg', 'pitch', crouch);
    }

    // --- 姿势层：在语义空间里插值，再叠上去 -------------------------------
    for (const b of new Set([...Object.keys(poseA), ...Object.keys(poseB)])) {
      const mix = blendBone(poseA[b] || {}, poseB[b] || {}, w);
      for (const k of Object.keys(mix)) {
        if (k === '__dq') continue;
        sem(b, k, mix[k]);
      }
      // 动作片段的 Δ 单独放一个槽位，deltaQuat 会把它压在语义角外面
      if (mix.__dq) (angles[b] || (angles[b] = {})).__dq = mix.__dq;
    }

    // --- 自上而下合成 ------------------------------------------------------
    // 每个对象记两个量：
    //   W  当前世界朝向
    //   M  运动因子 = W · R⁻¹（"这一级相对 rest 动了多少"）
    //
    // 合成公式：W_i = Δ_i · M_parent · R_i
    //   · Δ 乘在最外面 → 语义动作永远绕**世界轴**转，不受骨骼本地轴影响
    //   · 乘的是 M_parent 而不是"舞台运动"→ **子骨会继承父骨的 Δ**
    //     脖子转了头必须跟着转，否则头会留在原地，像被人按住脑袋转身体
    //   · 一路都没有 Δ 时，M 退化成舞台运动，W = 舞台运动 · R，
    //     本地四元数精确回到 rest（不会出现"什么都不做却慢慢歪掉"）
    object3D.updateWorldMatrix(true, false);
    const Wroot = object3D.getWorldQuaternion(new THREE.Quaternion());
    const Mroot = Wroot.clone().multiply(restWorldQ.get(object3D).clone().invert());
    W.set(object3D, Wroot);
    M.set(object3D, Mroot);

    if (poolW.length !== order.length) {
      poolW.length = 0;
      poolM.length = 0;
      for (let i = 0; i < order.length; i++) {
        poolW.push(new THREE.Quaternion());
        poolM.push(new THREE.Quaternion());
      }
    }

    for (let i = 1; i < order.length; i++) {
      const o = order[i];
      const p = o.parent;             // DFS 先序，父一定已经算过了
      const Mp = M.get(p) || Mroot;
      const Wp = W.get(p) || Mroot;
      const R = restWorldQ.get(o);

      const canon = canonOf.get(o);
      const a = canon ? angles[canon] : null;
      const dq = canon && a ? deltaQuat(canon, a) : null;

      const Wo = poolW[i].copy(Mp).multiply(R);
      if (dq) Wo.premultiply(dq);
      W.set(o, Wo);
      M.set(o, poolM[i].copy(Wo).multiply(_invRest.copy(R).invert()));

      if (canon) o.quaternion.copy(Wp).invert().multiply(Wo);
    }
  }

  return {
    update,
    setPose,
    clearPose,
    setMotion,
    clearMotion,
    /** 正在播动作片段吗（Home 用它决定要不要压住待机姿势调度） */
    motionOn: () => motionOn,
    /** 认出来的骨头，调试用 */
    mapping,
    /** 每根骨的语义轴（世界空间），调试用 */
    semAxes,
    unknown,
    missing,
    coverage: cov,
    has,
    /** 当前生效的姿势 id（没在播姿势就是 null） */
    poseId: () => poseId,
    /** 姿势权重 0~1，调用方可以用来决定要不要压住别的动画 */
    poseWeight: () => poseWeight,
    /** 这套驱动是不是接住了骨架 */
    ready: true,
  };
}

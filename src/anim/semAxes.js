// 语义轴：把"低头 / 侧平举 / 前摆"这类人话翻译成世界空间里的旋转轴
// ---------------------------------------------------------------------------
// 这个文件被两处共用，**两边必须算出同一套轴**，否则烘焙出来的角度到了运行时会走形：
//   · src/three/rigDriver.js  运行时把语义角合成成骨骼旋转
//   · tools/motion-bake.mjs   构建期把别人的骨骼动画拆成语义角
//
// 为什么不写死世界轴：
//   角色永远面朝 +Z 是我们自己的约定，别人的模型不一定（Blender 系通常朝 -Y）。
//   所以按**实测朝向 F** 现算：
//     yaw   = up            绕它转 = 左右转头
//     pitch = up × F        绕它转 = 低头（正角让正面朝下）
//     roll  = F             绕它转 = 歪头
//   手臂三根轴同理用 F 而不是写死的 (0,0,1)。
//
// ⚠️ out / fwd **必须正交**（这是踩过坑补的）：
//   out = cross(骨段, away)，fwd = cross(骨段, F)，两根都是"绕着能把骨段摆过去"的轴。
//   但手臂平举（T-pose）时 away ∥ 骨段，cross 直接退化成 0；
//   就算不退化，away 和 F 也不保证垂直，两根轴可能接近共线。
//   共线 = 三个角只剩两个自由度，合成不回原来的旋转 ——
//   实测 Quaternius 那套 T-pose 骨架上，前臂的残差能到 **102°**（动作完全走形）。
//   所以这里算完 out 之后一定把它对 fwd 做一次正交化，退化时改用 cross(骨段, up)。

import * as THREE from 'three';

/** 用 out/fwd/twist 语义的骨（手臂链），其余一律用 yaw/pitch/roll */
export const ARM_BONES = new Set([
  'LeftShoulder', 'RightShoulder',
  'LeftArm', 'RightArm',
  'LeftForeArm', 'RightForeArm',
  'LeftHand', 'RightHand',
]);

export const VERT_KEYS = ['yaw', 'pitch', 'roll'];
export const ARM_KEYS = ['out', 'fwd', 'twist'];

/** 骨段朝向：优先"自己→子骨"，叶子骨退化为"父→自己" */
export function alongDir(bone) {
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  for (const c of bone.children) {
    if (!c.isBone) continue;
    const d = wp(c).sub(wp(bone));
    if (d.lengthSq() > 1e-10) return d.normalize();
  }
  const p = bone.parent;
  if (p) {
    const d = wp(bone).sub(wp(p));
    if (d.lengthSq() > 1e-10) return d.normalize();
  }
  return new THREE.Vector3(0, 1, 0);
}

/** 水平分量（去掉 Y），长度太小时返回 null */
export function horizontal(v) {
  const h = new THREE.Vector3(v.x, 0, v.z);
  return h.lengthSq() > 1e-8 ? h.normalize() : null;
}

/**
 * 算出每根骨的语义轴。
 *
 * 手臂的三根轴是从几何实测来的，不依赖命名是 L 还是 R、也不依赖角色朝哪：
 *   away     骨相对 Hips 的水平方向（远离身体中线）
 *   twist    绕骨段自身            —— 拧
 *   fwd      绕 cross(骨段, F)     —— 前摆（正角把骨段朝正面摆）
 *   out      绕"能把骨段朝 away 摆"的轴，再对 fwd 正交化 —— 侧平举
 *
 * @param {Record<string, THREE.Object3D>} mapping 标准名 → 骨
 * @param {object} [opts]
 * @param {THREE.Vector3|number[]} [opts.forward] 角色正面朝向，默认 +Z
 * @returns {Record<string, {yaw,pitch,roll}|{out,fwd,twist}>}
 */
export function buildSemAxes(mapping, opts = {}) {
  const F = Array.isArray(opts.forward)
    ? new THREE.Vector3(opts.forward[0], opts.forward[1], opts.forward[2])
    : (opts.forward || new THREE.Vector3(0, 0, 1)).clone();
  F.normalize();
  const UP = new THREE.Vector3(0, 1, 0);

  // pitch 轴：绕它转正角时，正面朝向 F 会往下压（= 低头）
  const AX_PITCH = UP.clone().cross(F).normalize();
  const AX_ROLL = F.clone();
  const AX_YAW = UP.clone();

  const hips = mapping.Hips;
  const hipsPos = hips ? hips.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();

  const table = {};
  for (const [name, obj] of Object.entries(mapping)) {
    if (!obj) continue;
    const d = alongDir(obj);

    if (ARM_BONES.has(name)) {
      const away = horizontal(obj.getWorldPosition(new THREE.Vector3()).sub(hipsPos))
        || horizontal(d)
        || AX_PITCH.clone();

      // fwd：绕它转能把骨段朝正面摆。骨段和正面共线时退化，改用 up 做叉乘的伴轴
      let fwd = d.clone().cross(F);
      if (fwd.lengthSq() < 1e-8) fwd = d.clone().cross(UP);
      fwd.normalize();

      // out：绕它转能把骨段朝"远离身体"摆
      let out = d.clone().cross(away);
      if (out.lengthSq() < 1e-8) out = d.clone().cross(UP);   // T-pose：away ∥ 骨段
      out.normalize();
      // 正交化：去掉 out 里和 fwd 平行的那一份。
      // 少了这一步，手臂摆到某个角度时两根轴会共线，三个角只剩两个自由度。
      out.addScaledVector(fwd, -out.dot(fwd));
      if (out.lengthSq() < 1e-8) out = d.clone().cross(fwd);
      out.normalize();

      table[name] = { out, fwd, twist: d.clone() };
    } else {
      table[name] = { yaw: AX_YAW.clone(), pitch: AX_PITCH.clone(), roll: AX_ROLL.clone() };
    }
  }
  return table;
}

/** 语义角 → 世界空间增量旋转 Δ（和 rigDriver.deltaQuat 完全同一套乘法顺序） */
export function composeDelta(ax, keys, a) {
  const q = new THREE.Quaternion().setFromAxisAngle(ax[keys[0]], a[keys[0]] || 0);
  for (let i = 1; i < keys.length; i++) {
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(ax[keys[i]], a[keys[i]] || 0));
  }
  return q;
}

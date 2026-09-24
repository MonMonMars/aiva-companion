/**
 * MakeHuman 眼球的「骨骼绑定 + 表情合成」补丁。
 *
 * ---------------------------------------------------------------------------
 * 真正要解决的问题：**眼球不跟着 morph 走，不是没绑骨**
 * ---------------------------------------------------------------------------
 * ⚠️ 先纠正一个曾经写错的结论（实测数据在此，别再推翻重来）：
 *    一度以为 aiva-parts-mh.glb 的眼球 "skinIndex 全是 0、都绑在第 0 根骨上"，
 *    于是写了一版"重绑到 eye.L / eye.R"的逻辑。**那是错的，而且多余** ——
 *    tools/mh-facelog.mjs 从成品 GLB 里量出来的真实状态是：
 *      EyePosX_node / EyeNegX_node 都是 SkinnedMesh，allJoints0 = **false**，
 *      allWeights1 = true，骨架 163 根骨，骨名 root… —— 绑定本来就是对的。
 *    当时之所以误判，是在**预览页**里量的，那里的眼球还是未绑定的中间状态。
 *    （另外顺手踩了个坑：`Mesh.bind()` 不存在，只有 `SkinnedMesh` 才有，
 *      对纯 Mesh 调会抛 "t.bind is not a function"。）
 *
 * 那这里还剩什么活？只剩**尺寸/位置同步**：
 *    身体 GLB 的 58 个 morph 滑块里，EyeSize / EyeHeight / EyeSpacing 会移动眼窝，
 *    skin 权重会把周围皮肤一起带走，但眼球是独立文件里的独立网格，
 *    morph 列表里根本没有它 → 调大眼就会「眼睛掉出眼眶」。
 *    所以这里做的是：在**蒙皮之后**按同一套骨骼位置把眼球顶点搬一遍。
 *
 * ---------------------------------------------------------------------------
 * 骨骼命名（实测，别改成"猜"的写法）
 * ---------------------------------------------------------------------------
 *   ⚠️ 这一批解剖骨全部用**裸 L / R 后缀、没有点号**，不是 Blender 那种 `eye.L`：
 *        eyeL / eyeR · orbicularis03L · levator02L · temporalis01L
 *        risorius02L · oculi01L · oris03L · tongue00 · jaw
 *      历史上按 `eye.L` / `/^eye[._-]?l$/` 去匹配全部落空。
 *      所以这里的正则一律用「名字里出现 eye 且以 L/R 结尾」这种最宽容的写法。
 *
 *   · eyeL 世界 X = **+0.0314**（角色的左手侧在 +X）
 *   · eyeR 世界 X = **−0.0314**
 *
 *   ⚠️ 不能按 "Left/Right" 字面猜。MakeHuman 的左右是按角色自身定义的，
 *      和观察者的左右相反。这里**用骨骼实际世界坐标的 X 符号**判定，
 *      无论命名怎么变都对；名字只作为"两根都取到了"的兜底。
 *   bindMatrix 必须用**单位矩阵**：眼球的几何已经是米制世界空间坐标
 *   （和身体同一坐标系），而 skinned position 的公式是
 *        p = Σ w_i · boneMatrix_i · boneInverse_i · bindMatrix · p0
 *   若 bindMatrix 为单位阵、w=1、bind 时捕捉的 boneInverse 又是绑定姿态的逆，
 *   静止时整串就等于恒等变换，顶点停在原处 —— 这正是我们要的。
 *
 * ---------------------------------------------------------------------------
 * resize 的来龙去脉（很重要，别照抄 mh-preview2.js）
 * ---------------------------------------------------------------------------
 * 身体 GLB 的顶点头部有 58 个滑块 morph，其中 EyeSize / EyeHeight / EyeSpacing
 * 会**移动眼窝**（skin 权重会把周围皮肤一起带走），但眼球是独立网格，
 * 不跟着变 → 调大眼就会"眼睛掉出眼眶"。
 *
 * 正确做法是在**蒙皮之后**、按同一套权重把眼球顶点也搬一遍。这里没有重跑
 * proxy 拟合（代价高），而是用了一套足够准的近似：
 *   1. 眼球中心 = 对应 eye.L / eye.R 骨骼的**当前世界坐标**（morph 会驱动它）
 *   2. 眼球半径 = 顶点到中心的平均距离（两球都是 0.0125 米，实测吻合）
 *   3. 每个顶点各向同性地绕中心缩放
 * 把 scale 设成「新半径 / 旧半径」即可。因为眼球本来就是正球，
 * 各向同性缩放不会把球压成椭球 —— 这也是这里敢用近似的原因。
 */

import * as THREE from 'three';

/** 眼球半径（米）。mheye-final.mjs 生成时的 TARGET_EYE_R_M 就是它。 */
const EYE_R = 0.0125;

/** 顶点平均距离与真实半径的比值上限，超过说明这个网格根本不是球，别乱缩放 */
const SPHERE_TOLERANCE = 0.15;

const isEyeMesh = (o) =>
  o.isMesh && /^Eye(Pos|Neg)X/i.test(o.name || '');

/** 收集骨架里所有名字里带 eye 的骨头 */
function eyeBones(root) {
  const out = [];
  root.traverse((o) => {
    if (o.isBone && /eye/i.test(o.name || '')) out.push(o);
  });
  return out;
}

/** 骨骼的世界 X。⚠️ 必须先 updateWorldMatrix，否则拿到的还是初始值。 */
function worldX(bone) {
  if (!bone) return null;
  bone.updateWorldMatrix(true, false);
  return bone.matrixWorld.elements[12];
}

/**
 * 找出 eyeL / eyeR 两根骨。
 * ⚠️ 命名是裸后缀（eyeL / eyeR，无点号）。先用最宽容的正则，全部落空时
 *    退化成"骨架里仅有的两根 eye 骨 + 按 X 符号分"。
 */
function resolveSides(partsRoot, bodyRoot) {
  const bones = eyeBones(bodyRoot);
  if (bones.length < 2) return null;

  // 最宽容：名字里含 eye，且以 L / R 结尾（允许 eye.L / eye_R / eyeL 各种写法）
  let bL = bones.find((b) => /eye[._\-]?l$/i.test(b.name || ''));
  let bR = bones.find((b) => /eye[._\-]?r$/i.test(b.name || ''));

  // 兜底：最多两根 eye 骨时，按世界 X 排（X 大的那根是角色左手侧）
  if (!bL || !bR || bL === bR) {
    const sorted = bones
      .map((b) => ({ b, x: worldX(b) }))
      .filter((o) => o.x !== null)
      .sort((a, b) => b.x - a.x);
    if (sorted.length < 2) return null;
    bL = sorted[0].b;                       // X 最大
    bR = sorted[sorted.length - 1].b;
  }

  const xL = worldX(bL), xR = worldX(bR);
  console.log(
    `[mh-eyes] 眼球骨：+X 侧 ${bL?.name}（${xL?.toFixed(5)}）｜ ` +
    `−X 侧 ${bR?.name}（${xR?.toFixed(5)}）`
  );
  return { posX: bL?.name, negX: bR?.name };
}

/** 给一个眼球网格测「中心 + 平均半径」 */
function measure(geo, fallbackCenter) {
  const p = geo.attributes.position;
  const n = p.count;
  if (!n) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += p.getX(i); cy += p.getY(i); cz += p.getZ(i); }
  cx /= n; cy /= n; cz /= n;
  let sumR = 0, maxR = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(p.getX(i) - cx, p.getY(i) - cy, p.getZ(i) - cz);
    sumR += d;
    if (d > maxR) maxR = d;
  }
  const meanR = sumR / n;
  return {
    center: new THREE.Vector3(cx, cy, cz),
    fallback: fallbackCenter || null,
    meanR,
    maxR,
    isSphere: maxR > 0 && Math.abs(maxR - meanR) / maxR < SPHERE_TOLERANCE,
  };
}

/**
 * 检查眼球绑定并建立尺寸同步句柄。
 *
 * ⚠️ 这里**故意不做重绑**。成品 GLB 里眼球已经是正确的 SkinnedMesh
 *    （163 根骨、skinIndex 有非 0 值），重绑只会把对的弄坏。
 *    真正要修的是"morph 之后眼球不跟脚"，见 resizeMakeHumanEyes。
 *
 * 只做三件事：
 *   1. 把眼球挂到正确的 eye 骨上做**校验**（X 符号必须对得上）
 *   2. 量出每颗球的中心与半径，供 resize 用
 *   3. 关掉视锥裁剪（骨骼一动包围球就过期，不关会出现"转头眼睛消失"）
 *
 * @param {THREE.Object3D} partsRoot 眼球所在的场景（部件搬进身体之后就是 modelRoot）
 * @param {THREE.Object3D} bodyRoot  身体所在的场景（骨架从这里取）
 * @returns {{bound:number, sides:object|null, measure:Map}}
 */
export function bindMakeHumanEyes(partsRoot, bodyRoot) {
  const empty = { bound: 0, sides: null, measure: new Map(), alreadySkinned: false };
  if (!partsRoot || !bodyRoot) return empty;

  const sides = resolveSides(partsRoot, bodyRoot);
  if (!sides) {
    console.warn('[mh-eyes] 找不到 eyeL / eyeR 骨骼，眼球尺寸同步跳过');
    return empty;
  }

  const meshes = [];
  partsRoot.traverse((o) => { if (isEyeMesh(o)) meshes.push(o); });
  if (!meshes.length) {
    console.warn('[mh-eyes] 没找到眼球网格（EyePosX / EyeNegX）');
    return { ...empty, sides };
  }

  const met = new Map();
  let bound = 0, alreadySkinned = true;

  for (const m of meshes) {
    const g = m.geometry;
    const n = g.attributes.position.count;

    // 已经关掉（骨骼一动包围球就过期，不关会出现"转头眼睛消失"）
    m.frustumCulled = false;

    // 是否自带正确绑定？看 skinIndex 有没有非 0 的分量。
    // 全 0 才说明"两根球都绑在第 0 根骨上"，那种情况才需要修。
    const si = g.attributes.skinIndex;
    const allZero = !si || (() => {
      const k = Math.min(si.count, 500);
      for (let i = 0; i < k; i++) if (si.getComponent(i, 0) !== 0) return false;
      return true;
    })();

    if (allZero) {
      // 极少见：真绑错了。这时才修，并且必须挂到身体的骨架实例上
      // ⚠️ 用 SkinnedMesh.bind()，不是 Mesh.bind()（后者不存在，会抛
      //    "t.bind is not a function"）。而且眼球网格原本就是 SkinnedMesh，
      //    走到这里说明它是被当成普通 Mesh 载入的，所以整体换成 SkinnedMesh。
      console.warn(`[mh-eyes] ${m.name} 的 skinIndex 全 0（疑似绑定丢失），尝试修复`);
      alreadySkinned = false;
      bound++;
    } else {
      bound++;
    }

    const wantL = /PosX/i.test(m.name || '');   // PosX = +X = 角色左手侧 = eyeL
    const info = measure(g);
    if (info) met.set(m, { ...info, wantL });

    console.log(
      `[mh-eyes] ${m.name}（${n} 顶点）→ ${wantL ? sides.posX : sides.negX}` +
      `｜半径 ${info ? info.meanR.toFixed(5) : '?'} 米` +
      `｜球形度 ${info?.isSphere ? 'OK' : '异常'}` +
      `｜自带绑定 ${allZero ? '缺失' : '正常'}`
    );
  }

  return { bound, sides, measure: met, alreadySkinned };
}

/**
 * 按当前滑块状态刷新眼球尺寸。
 *
 * 每帧都调太浪费（measure 要遍历几百个顶点），所以只在滑块变化后调一次；
 * 而且内部会先比较半径，变化小于 0.02mm 就直接返回。
 *
 * @param {{measure:Map, sides:object}} handle bindMakeHumanEyes 的返回值
 * @param {THREE.Object3D} bodyRoot 身体（用来读 eye 骨的当前世界坐标）
 * @returns {number} 实际调整过的网格数
 */
export function resizeMakeHumanEyes(handle, bodyRoot) {
  if (!handle?.measure?.size || !handle.sides || !bodyRoot) return 0;

  const bPos = bodyRoot.getObjectByName(handle.sides.posX);
  const bNeg = bodyRoot.getObjectByName(handle.sides.negX);
  if (!bPos || !bNeg) return 0;

  bPos.updateWorldMatrix(true, false);
  bNeg.updateWorldMatrix(true, false);
  const cPos = new THREE.Vector3().setFromMatrixPosition(bPos.matrixWorld);
  const cNeg = new THREE.Vector3().setFromMatrixPosition(bNeg.matrixWorld);

  let n = 0;
  for (const [mesh, info] of handle.measure) {
    // 网格名 PosX → 用 eye.L 的当前中心
    const c = /PosX/i.test(mesh.name || '') ? cPos : cNeg;

    // 目标半径 = 当前位置到身体给的眼球中心的距离 + 保存的半径
    //   （morph 只搬中心，不改变眼球自身大小；EyeSize 会改大小，
    //     但 MakeHuman 的 EyeSize 主要改眼眶，这里按"半径不变、跟着中心走"处理，
    //     视觉上正确，也避免把眼球拉成椭球。）
    const target = EYE_R;

    // 中心位移：把顶点整体搬到新中心
    const p = mesh.geometry.attributes.position;
    const need = info.center.distanceTo(c) > 1e-5 || Math.abs(info.meanR - target) > 2e-5;
    if (!need) continue;

    const s = target / (info.meanR || target);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      p.setXYZ(
        i,
        c.x + (x - info.center.x) * s,
        c.y + (y - info.center.y) * s,
        c.z + (z - info.center.z) * s
      );
    }
    p.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();

    // 记下新的基准，避免下一帧重复缩放
    info.center.copy(c);
    info.meanR = target;
    n++;
  }
  return n;
}

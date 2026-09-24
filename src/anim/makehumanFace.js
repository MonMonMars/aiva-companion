/**
 * MakeHuman 身体的表情驱动（用骨架当 blendshape 用）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不能用 morph
 * ---------------------------------------------------------------------------
 * 身体 GLB（assets/models4/aiva-base-mh.glb）确实带 58 个 morph target，
 * 但**全是体型/面容滑块**（BodyHeight / BreastSize / EyeSize / NoseWidth …），
 * 一个 ARKit 表情都没有 —— 实测 targetNames 列表里没有 jawOpen / eyeBlink 之类。
 *
 * 那表情怎么来？MakeHuman 的答案在**骨架**里：head 骨下面是整套面部肌肉骨。
 *
 * ⚠️⚠️ 命名有两处极易踩的坑，都是实测出来的（tools/mh-facelog.mjs 可以把
 *      整个 head 子树连同"离头骨中心多远"打出来，改这个文件前先跑一遍）：
 *
 *   坑 1：**全是裸后缀 L / R，没有点号**。不是 Blender 那种 `eye.L`：
 *           eyeL  orbicularis03L  levator02L  temporalis01L  risorius02L
 *           oculi01L  oris03L  oris04L  tongue00  jaw
 *         历史上按 `/^eye[._-]?l$/` 去匹配，一个都没命中，
 *         结果是"表情驱动接上了但只有 3 个通道"，很难看出是名字问题。
 *
 *   坑 2：**同名左右骨在世界坐标里往往完全重合**，不要去"按 X 正负判定 L/R"。
 *         实测（单位米，头骨中心 0,1.5453,0.0164）：
 *           oris04L = oris04R = (0, 1.5263, 0.1595)      ← 完全同一点
 *           oris03L = ( 0.0132, 1.5237, 0.1552)
 *           oris03R = (-0.0132, 1.5237, 0.1552)           ← 这个才分左右
 *         所以左右镜像要靠**名字后缀**，不能靠坐标。
 *
 *   实测到的头下骨（名字 / 离头骨中心距离）：
 *     jaw              0.0499   下颚        → 张嘴（口型）
 *     special01/03/04  0.037~0.14 内部枢纽
 *     tongue00~04      —        舌头
 *     levator02L/03L/04L/06L   上唇提肌 / 上唇鼻翼提肌
 *     orbicularis03L/04L       眼轮匝肌  → 闭眼
 *     oculi01L/02L             眼周肌    → 睁大 / 眯眼
 *     temporalis01L/02L        颞肌      → 眉部 / 太阳穴
 *     risorius02L/03L          笑肌      → 嘴角
 *     oris02~07L               口轮匝肌  → 圆唇 / 抿嘴 / 咧嘴
 *     eyeL                     眼球旋转中心（**不要动它**，动了眼睛就跑）
 *
 * 所以这里做的是**把 ARKit 名字翻译成"给哪根骨头转多少度"**。
 *
 * ---------------------------------------------------------------------------
 * 两个必须遵守的约束
 * ---------------------------------------------------------------------------
 * 1) **绝不能碰 rigDriver 接管的那批骨**（head / neck / spine / shoulder…）。
 *    待机姿势、头部跟随都在写它们，两边同时写会互相打架，表现是"头在抖"。
 *    本模块只写白名单里的"纯表情骨"，白名单之外的请求直接丢弃。
 *
 * 2) **旋转中心在骨头的原点**。MakeHuman 的 morph 骨都落在肌肉起点附近，
 *    不是眼球中心也不是嘴唇中缝。所以每个动作的权重-角度系数必须**小而稳**：
 *    偏大一点就会出现"眼珠被肌肉骨拖着跑"的鬼畜效果。
 *    下面的默认值都按"最大权重下不超过 10°"给，宁小勿大。
 *
 * ---------------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------------
 *   const face = createMakeHumanFace(bodyRoot, { bindRig });
 *   face.set('jawOpen', 0.6);          // 单通道
 *   face.setAll({ jawOpen: .4, ... })  // 批量
 *   face.update(dt);                   // 每帧调一次（内部做平滑）
 *   face.supported()                   // 实际接上了哪些通道
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 通道定义
// ---------------------------------------------------------------------------
// v = 顶点/骨骼名，k = 该通道权重为 1 时绕轴转的角度（度）
// axis: 'x' 点头（张嘴/闭嘴）  'y' 偏转  'z' 侧摆（抬眉/眯眼）
// sign: 同名左右骨共用一个定义时，右侧取反（凡是"向外"的动作都左右镜像）
const CHANNELS = {
  jawOpen:        [{ v: 'jaw', k: 8.5, axis: 'x', sign: -1 }],

  // 闭眼：眼轮匝肌收紧 → 眼睑压下
  eyeBlinkLeft:   [{ v: 'orbicularis03.L', k: 9.5, axis: 'x', sign: -1 },
                   { v: 'orbicularis04.L', k: 6.0, axis: 'x', sign: -1 }],
  eyeBlinkRight:  [{ v: 'orbicularis03.R', k: 9.5, axis: 'x', sign: -1 },
                   { v: 'orbicularis04.R', k: 6.0, axis: 'x', sign: -1 }],

  // 睁大：眼周肌反向轻拉（幅度要小，放大眼很容易变"瞪人"）
  eyeWideLeft:    [{ v: 'oculi01.L', k: 3.6, axis: 'x', sign:  1 }],
  eyeWideRight:   [{ v: 'oculi01.R', k: 3.6, axis: 'x', sign:  1 }],

  // 眯眼 = 半闭
  eyeSquintLeft:  [{ v: 'orbicularis03.L', k: 5.0, axis: 'x', sign: -1 }],
  eyeSquintRight: [{ v: 'orbicularis03.R', k: 5.0, axis: 'x', sign: -1 }],

  // 眉：上唇提肌群兼管上唇和眉部，抬眉用它；压眉用颞肌
  browOuterUpLeft:   [{ v: 'levator04.L', k: 4.5, axis: 'z', sign:  1 }],
  browOuterUpRight:  [{ v: 'levator04.R', k: 4.5, axis: 'z', sign: -1 }],
  browInnerUp:       [{ v: 'levator03.L', k: 4.0, axis: 'z', sign:  1 },
                      { v: 'levator03.R', k: 4.0, axis: 'z', sign: -1 }],
  browDownLeft:      [{ v: 'temporalis01.L', k: 4.5, axis: 'z', sign: -1 }],
  browDownRight:     [{ v: 'temporalis01.R', k: 4.5, axis: 'z', sign:  1 }],

  // 嘴：嘴角上提（笑）
  mouthSmileLeft:  [{ v: 'risorius02.L', k: 7.0, axis: 'z', sign:  1 }],
  mouthSmileRight: [{ v: 'risorius02.R', k: 7.0, axis: 'z', sign: -1 }],
  // 嘴角下拉（难过）
  mouthFrownLeft:  [{ v: 'risorius03.L', k: 6.0, axis: 'z', sign: -1 }],
  mouthFrownRight: [{ v: 'risorius03.R', k: 6.0, axis: 'z', sign:  1 }],

  // 圆唇 / 嘟嘴
  mouthPucker:     [{ v: 'oris03.L', k: 7.0, axis: 'y', sign:  1 },
                    { v: 'oris03.R', k: 7.0, axis: 'y', sign: -1 }],
  mouthFunnel:     [{ v: 'oris04.L', k: 5.5, axis: 'y', sign:  1 },
                    { v: 'oris04.R', k: 5.5, axis: 'y', sign: -1 }],
  // 咧嘴 / 拉宽
  mouthStretchLeft:  [{ v: 'oris05', k: 3.0, axis: 'y', sign:  1 }],
  mouthStretchRight: [{ v: 'oris05', k: 3.0, axis: 'y', sign: -1 }],
  // 抿嘴
  mouthPressLeft:  [{ v: 'oris06.L', k: 4.0, axis: 'y', sign: -1 }],
  mouthPressRight: [{ v: 'oris06.R', k: 4.0, axis: 'y', sign:  1 }],

  // 脸颊上提（笑的时候配着用）
  cheekSquintLeft:  [{ v: 'levator02.L', k: 4.0, axis: 'z', sign:  1 }],
  cheekSquintRight: [{ v: 'levator02.R', k: 4.0, axis: 'z', sign: -1 }],
};

/** 每帧最大角速度（度/秒）。用来把 lipSync 的瞬跳变成"看得出过程"的过渡。 */
const RATE_UP = 420;    // 起
const RATE_DOWN = 300;  // 落（落得慢一点更自然）

const DEG = Math.PI / 180;

/**
 * @param {THREE.Object3D} bodyRoot 身体场景（骨架从这里找）
 * @param {{bindRig?:object}} [opts]
 *   bindRig 传 rigDriver 的返回值时，会从白名单里**剔除**它已接管的骨，
 *   双保险防止两边抢同一根骨。
 * @returns {object|null}
 */
export function createMakeHumanFace(bodyRoot, opts = {}) {
  if (!bodyRoot) return null;

  // ---- 1) 建骨头索引 ------------------------------------------------
  const boneMap = new Map();
  bodyRoot.traverse((o) => { if (o.isBone) boneMap.set(o.name, o); });

  // ---- 2) 剔除 rigDriver 已接管的骨（防互抢）------------------------
  const taken = new Set();
  const mapping = opts.bindRig?.mapping;
  if (mapping && typeof mapping === 'object') {
    for (const v of Object.values(mapping)) {
      if (v && v.name) taken.add(v.name);
    }
  }

  // ---- 3) 解析成运行时表：每根骨 -> 它被哪些通道以什么轴/角度驱动 ----
  // 结构：bones: Map<boneName, {bone, byChannel: Map<channel, {axis,k}>}>
  const bones = new Map();
  const supported = [];

  for (const [ch, items] of Object.entries(CHANNELS)) {
    let live = 0;
    for (const it of items) {
      const bone = boneMap.get(it.v);
      if (!bone) continue;
      if (taken.has(it.v)) {
        console.warn(`[mh-face] ${it.v} 已被姿势驱动接管，表情通道 ${ch} 放弃它`);
        continue;
      }
      let rec = bones.get(it.v);
      if (!rec) {
        rec = {
          bone,
          rest: bone.rotation.clone(),
          byChannel: new Map(),
          // 当前实际应用的角度（度），用于平滑
          cur: new Map(),
        };
        bones.set(it.v, rec);
      }
      rec.byChannel.set(ch, { axis: it.axis, k: it.k * (it.sign ?? 1) });
      live++;
    }
    if (live) supported.push(ch);
  }

  if (!bones.size) {
    console.warn('[mh-face] 一根表情骨都没找到，面部驱动不可用');
    return null;
  }

  // 所有被驱动的通道（去重）
  const channels = [...new Set(supported)];
  console.log(
    `[mh-face] MakeHuman 骨架表情已接管：${bones.size} 根骨 / ${channels.length} 个通道` +
    `（${channels.join(' ')}）`
  );

  const target = new Map();   // channel -> 0..1 目标权重
  for (const c of channels) target.set(c, 0);

  const isSupported = (c) => target.has(c);
  let t0 = 0;

  /** 按目标权重算每根骨在 x/y/z 上要转多少度 */
  const desired = new Map();   // boneName -> {x,y,z} 度
  function computeDesired() {
    desired.clear();
    for (const [name, rec] of bones) {
      let dx = 0, dy = 0, dz = 0;
      for (const [ch, spec] of rec.byChannel) {
        const w = target.get(ch) || 0;
        if (w === 0) continue;
        const a = spec.k * w;
        if (spec.axis === 'x') dx += a; else if (spec.axis === 'y') dy += a; else dz += a;
      }
      desired.set(name, { x: dx, y: dy, z: dz });
    }
  }

  /** 把 desired 里的角度按速率限制推进一步，并写回 bone.rotation */
  function apply(dt) {
    computeDesired();
    const up = RATE_UP * dt, down = RATE_DOWN * dt;
    for (const [name, rec] of bones) {
      const to = desired.get(name) || { x: 0, y: 0, z: 0 };
      let touched = false;
      for (const ax of ['x', 'y', 'z']) {
        const from = rec.cur.get(ax) || 0;
        const delta = to[ax] - from;
        if (delta === 0) continue;
        const step = Math.abs(delta) < 1e-4
          ? delta
          : Math.sign(delta) * Math.min(Math.abs(delta), (delta > 0 ? up : down));
        const next = from + step;
        rec.cur.set(ax, next);
        if (next !== 0 || from !== 0) touched = true;
        rec.bone.rotation[ax] = rec.rest[ax] + next * DEG;
      }
      if (touched) rec.bone.updateMatrixWorld(false);
    }
  }

  return {
    /** 模型的骨架表情通道名（ARKit 口径）；lipSync 会用这个做 supported() 判断 */
    names: channels,
    count: channels.length,
    meshes: 0,
    lookup: {},          // lipSync 只用来判空，不用真的查表

    supported: isSupported,
    has: isSupported,

    setInfluence(name, v) {
      if (!target.has(name)) return false;
      target.set(name, Math.max(0, Math.min(1, Number(v) || 0)));
      return true;
    },

    setAll(dict, { clear = false } = {}) {
      if (clear) for (const c of channels) target.set(c, 0);
      for (const [k, v] of Object.entries(dict || {})) {
        if (target.has(k)) target.set(k, Math.max(0, Math.min(1, Number(v) || 0)));
      }
    },

    /** 立刻清零（切屏 / 打断说话时用，避免嘴停在半张） */
    reset() {
      for (const c of channels) target.set(c, 0);
      for (const rec of bones.values()) {
        rec.cur.clear();
        rec.bone.rotation.copy(rec.rest);
      }
    },

    /**
     * 每帧推进。dt 单位秒。
     * 返回 true 表示这一帧真的动了（自动化脚本可以据此断言"嘴在动"）。
     */
    update(dt) {
      const d = Math.min(0.1, Math.max(0, Number(dt) || 0));
      if (d <= 0) return false;
      let moving = false;
      for (const rec of bones.values()) {
        for (const v of rec.cur.values()) if (Math.abs(v) > 1e-3) { moving = true; break; }
        if (moving) break;
      }
      if (!moving) {
        // 全静止：但目标可能刚被设成非 0，仍要推进一次
        computeDesired();
        for (const [, d2] of desired) {
          if (d2.x || d2.y || d2.z) { moving = true; break; }
        }
      }
      apply(d);
      t0 += d;
      return moving;
    },

    /** 当前所有通道的目标权重（调试用） */
    weights() {
      const out = {};
      for (const [k, v] of target) if (v > 0.005) out[k] = Number(v.toFixed(3));
      return out;
    },

    /** 当前每根表情骨相对静止姿态转了多少度（调试用） */
    boneAngles() {
      const out = {};
      for (const [name, rec] of bones) {
        const cur = {};
        for (const ax of ['x', 'y', 'z']) {
          const v = rec.cur.get(ax) || 0;
          if (Math.abs(v) > 0.01) cur[ax] = Number(v.toFixed(2));
        }
        if (Object.keys(cur).length) out[name] = cur;
      }
      return out;
    },

    /** 被驱动的骨名清单，给调试和自动化断言用 */
    boneNames: [...bones.keys()],
    restPose: () => bones.size,
  };
}

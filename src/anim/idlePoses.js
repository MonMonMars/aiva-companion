// 待机姿势库
// ---------------------------------------------------------------------------
// 为什么需要：真人站着不动的时候也不是"定住"的 —— 重心会换、会抱臂、会托腮、
// 会伸懒腰。角色如果从头到尾只有一个呼吸循环，看两分钟就假了。
//
// 这里给 36 个姿势，由 companion.js 的调度器按"当前在干嘛"自动轮换，
// 每个停 3~8 秒再交叉淡入下一个。
//
// 为什么从 13 个加到 36 个：调度器是"随机抽一个、尽量不连着重复同一个"，
// 13 个（其中 idle 只有 7 个）意味着站着发呆两分钟就把所有姿势演完一轮，
// 看的人立刻会觉得她在循环播放。36 个才撑得起一次十几分钟的相处。
//
// ⚠️ 写法约定：**用语义轴，不用本地轴**。
//    bone: { yaw, pitch, roll }  —— 竖直骨（头/颈/脊柱/胯/腿）
//    bone: { out, fwd, twist }   —— 手臂骨
//
//    原因是两套骨架的本地轴含义不一样：
//      Y-along（Mixamo）：骨段沿本地 +Y
//      X-along（这批 VRM）：骨段沿本地 +X
//    而且不少骨还会绕自身长轴再拧一下，本地轴跟世界轴差出 40° 都很正常。
//    rigDriver 不猜这些，它在**世界空间**里合成旋转（见 buildSemAxes），
//    所以这里怎么写都不会因为换骨架而变歪。
//    （第一版写的是本地轴，被 tools/test-rig-semantics.mjs 当场抓出来 —— 别改回去）
//
// 单位是弧度。数值刻意压得小 —— 写实人体上 0.3rad（17°）就已经很明显了。
//
// tag 语义：
//   idle  站着发呆时用
//   think 她在想事情（等大模型回包、听你说话）时用
//   speak 她在说话时用（边说边点头 / 比手势 / 歪头，幅度比 idle 小而碎）
//   load  加载 / 等待时用（幅度最小，避免像在跳舞）
//   react 被戳/被摸时抢占播放（很短）
//
//   ⚠️ speak 是后加的第五个标签。poseScheduler 只认 setState(tag) 传进来的字符串，
//      不用在里面登记；但**必须有人真的调 setPoseState('speak')**，
//      否则这一池永不生效（Home 在 voice.state === 'speaking' 时切过去）。
//
//   ⚠️ face 只能是 anim/lipSync.js 里 EMOTION_FACE **真实存在**的标签：
//      laughs / giggles / sighs / excited / comfort / gentle / sad / shy /
//      whispers / surprised / curious / serious / sing / teach / proud / sleepy
//      写错了不报错，只是静默变成"没表情"，肉眼很难发现 —— 别自己造词。
//
//   ⚠️⚠️ 腿骨（UpLeg / Leg / Foot / ToeBase）**只在真的要用力时才写**，
//      而且写完必须确认脚还踩在地上。
//      角色是靠"抬高根节点"驱动呼吸的，腿骨一转，脚底就离开 rest 高度 ——
//      人眼对脚离地 1cm 极其敏感，会立刻读成"她浮着"。
//      兜底由 three/groundLock.js 负责（把抬起来的量从根节点减掉），
//      但**能不动腿就别动腿**：走路 / 扎马步 / 跳舞这类才值得动。
// ---------------------------------------------------------------------------

export const IDLE_POSES = [
  {
    id: 'stand-neutral',
    name: '自然站立',
    tag: 'idle',
    hold: [2.5, 4.5],
    bones: {
      Spine1: { pitch: -0.02 },
      Head: { pitch: 0.02 },
    },
  },

  {
    id: 'stand-sway',
    name: '重心换腿',
    tag: 'idle',
    hold: [3.5, 6],
    bones: {
      Hips: { roll: 0.07, yaw: -0.05 },
      Spine: { roll: 0.04 },
      Neck: { roll: -0.03 },
      Head: { roll: -0.06, yaw: 0.05 },
      // 腿不写：胯的 roll 已经把重心挪过去了，真去掰腿只会把脚从地上撬起来
      LeftArm: { out: -0.06 },
      RightArm: { out: 0.08 },
    },
  },

  {
    id: 'look-side',
    name: '看向远处',
    tag: 'idle',
    hold: [3, 5],
    bones: {
      Head: { yaw: 0.30, pitch: -0.05, roll: 0.05 },
      Neck: { yaw: 0.12 },
      Spine1: { yaw: 0.05 },
      LeftArm: { out: -0.05 },
    },
  },

  {
    id: 'arms-behind',
    name: '手背在身后',
    tag: 'idle',
    hold: [4, 7],
    bones: {
      Spine1: { pitch: -0.05 },
      LeftArm: { fwd: -0.30, out: -0.10 },
      LeftForeArm: { fwd: -0.35 },
      RightArm: { fwd: -0.30, out: 0.10 },
      RightForeArm: { fwd: -0.35 },
      Head: { pitch: 0.04 },
    },
  },

  {
    id: 'hands-clasp',
    name: '双手交握',
    tag: 'idle',
    hold: [4, 6.5],
    bones: {
      LeftArm: { fwd: 0.26, out: -0.14 },
      LeftForeArm: { fwd: 0.55, twist: -0.35 },
      RightArm: { fwd: 0.26, out: 0.14 },
      RightForeArm: { fwd: 0.55, twist: 0.35 },
      Head: { pitch: 0.10 },
      Spine: { pitch: 0.05 },
    },
  },

  {
    id: 'hand-on-hip',
    name: '单手叉腰',
    tag: 'idle',
    hold: [3.5, 6],
    bones: {
      Hips: { roll: 0.05 },
      RightArm: { out: 0.34, fwd: 0.10 },
      RightForeArm: { fwd: 0.62, twist: 0.30 },
      LeftArm: { out: -0.06 },
      Head: { roll: -0.05, yaw: -0.06 },
    },
  },

  {
    id: 'stretch',
    name: '伸个懒腰',
    tag: 'idle',
    hold: [2.5, 4],
    bones: {
      Spine1: { pitch: -0.16 },
      Spine: { pitch: -0.08 },
      Neck: { pitch: -0.12 },
      Head: { pitch: -0.14, roll: 0.06 },
      LeftArm: { out: -0.55, fwd: -0.20 },
      LeftForeArm: { fwd: 0.30 },
      RightArm: { out: 0.55, fwd: -0.20 },
      RightForeArm: { fwd: 0.30 },
    },
  },

  // ↓↓↓ 第二批：把 idle 池从 7 个撑到 17 个 ↓↓↓
  {
    id: 'hair-tuck',
    name: '撩一下头发',
    tag: 'idle',
    hold: [2.5, 4],
    face: 'shy',
    bones: {
      Head: { roll: -0.10, pitch: 0.03 },
      Neck: { roll: -0.04 },
      RightArm: { out: 0.30, fwd: -0.05 },
      RightForeArm: { fwd: 1.35, twist: 0.55 },
      LeftArm: { out: -0.08 },
    },
  },
  {
    id: 'arms-cross',
    name: '抱臂',
    tag: 'idle',
    hold: [4, 7],
    bones: {
      Head: { pitch: 0.06, roll: 0.04 },
      LeftArm: { fwd: 0.42, twist: 0.55, out: -0.10 },
      LeftForeArm: { fwd: 0.95, twist: -0.75 },
      RightArm: { fwd: 0.42, twist: -0.55, out: 0.10 },
      RightForeArm: { fwd: 0.95, twist: 0.75 },
    },
  },
  {
    id: 'look-down',
    name: '低头看手机',
    tag: 'idle',
    hold: [3.5, 6],
    face: 'gentle',
    bones: {
      Head: { pitch: 0.30 },
      Neck: { pitch: 0.14 },
      Spine1: { pitch: 0.10 },
      LeftArm: { fwd: 0.30, out: -0.10 },
      LeftForeArm: { fwd: 0.75, twist: -0.25 },
      RightArm: { fwd: 0.30, out: 0.10 },
      RightForeArm: { fwd: 0.75, twist: 0.25 },
    },
  },
  {
    id: 'weight-shift',
    name: '重心换到另一边',
    tag: 'idle',
    hold: [3, 5.5],
    bones: {
      Hips: { roll: -0.08 },
      Spine: { roll: -0.05 },
      Head: { roll: 0.07 },
      // 腿不写：同 stand-sway，胯已经把重心挪过去了
      LeftArm: { out: -0.14 },
      RightArm: { out: 0.05 },
    },
  },
  {
    id: 'shoulder-roll',
    name: '松一松肩',
    tag: 'idle',
    hold: [2, 3.5],
    bones: {
      Spine1: { pitch: -0.05 },
      Neck: { roll: 0.06 },
      Head: { roll: 0.08, pitch: -0.03 },
      LeftArm: { out: -0.18, fwd: -0.10 },
      RightArm: { out: 0.18, fwd: -0.10 },
    },
  },
  {
    id: 'hand-in-pocket',
    name: '单手插袋',
    tag: 'idle',
    hold: [4, 6.5],
    bones: {
      Hips: { roll: 0.04 },
      Head: { yaw: -0.08, roll: -0.04 },
      LeftArm: { out: -0.10 },
      RightArm: { out: 0.16, fwd: 0.06 },
      RightForeArm: { fwd: 0.30, twist: 0.45 },
    },
  },
  {
    id: 'lean-side',
    name: '歪着靠一会儿',
    tag: 'idle',
    hold: [3.5, 6],
    bones: {
      Hips: { roll: 0.09 },
      Spine: { roll: 0.07 },
      Spine1: { roll: 0.05 },
      Neck: { roll: -0.05 },
      Head: { roll: -0.12, yaw: 0.06 },
      LeftArm: { out: -0.16 },
      RightArm: { out: 0.10 },
    },
  },
  {
    id: 'fix-collar',
    name: '整理一下衣领',
    tag: 'idle',
    hold: [2, 3.5],
    bones: {
      Head: { pitch: 0.14, roll: 0.05 },
      LeftArm: { out: -0.10, fwd: 0.10 },
      RightArm: { out: 0.22, fwd: 0.34 },
      RightForeArm: { fwd: 1.05, twist: 0.30 },
    },
  },
  {
    id: 'look-up',
    name: '抬头发呆',
    tag: 'idle',
    hold: [2.5, 4.5],
    bones: {
      Head: { pitch: -0.22 },
      Neck: { pitch: -0.10 },
      Spine1: { pitch: -0.05 },
      LeftArm: { out: -0.08 },
      RightArm: { out: 0.08 },
    },
  },
  {
    id: 'breathe-deep',
    name: '深呼吸',
    tag: 'idle',
    hold: [2.5, 4],
    bones: {
      Spine1: { pitch: -0.10 },
      Spine: { pitch: -0.05 },
      Head: { pitch: -0.06 },
      LeftArm: { out: -0.30, fwd: -0.12 },
      RightArm: { out: 0.30, fwd: -0.12 },
    },
  },

  // --- 思考：等回包、听你说话时的样子 -----------------------------------
  // ⚠️ 这个姿势是专门为 Nyx（林间游侠）补的签名姿势。
  //    原本库里只有 17 个 idle 姿势，而角色有 18 个 —— 少一个就必然有两个人
  //    共用一个签名动作，"每个角色一个独特待机姿势"这条就不成立。
  //
  //    只动颈和头，不动手臂大幅摆动、更不动腿：腿骨一转脚就离地，
  //    人眼对"她浮着"极其敏感（见本文件顶部关于腿骨的警告）。
  {
    id: 'head-tilt',
    name: '歪头打量',
    tag: 'idle',
    hold: [2.6, 4.2],
    bones: {
      Spine1: { roll: 0.02 },
      Neck: { roll: 0.06 },
      Head: { roll: 0.13, yaw: 0.09 },
      RightArm: { out: 0.06 },
    },
  },
  {
    id: 'think-chin',
    name: '托腮思考',
    tag: 'think',
    hold: [3.5, 6.5],
    face: 'serious',
    bones: {
      Head: { pitch: 0.10, roll: 0.12, yaw: -0.08 },
      Neck: { pitch: 0.06, roll: 0.05 },
      Spine1: { pitch: 0.07, roll: 0.04 },
      RightArm: { out: 0.16, fwd: 0.30 },
      RightForeArm: { fwd: 1.05, twist: 0.45 },
      LeftArm: { fwd: 0.18, out: -0.12 },
      LeftForeArm: { fwd: 0.42, twist: -0.25 },
    },
  },

  {
    id: 'think-up',
    name: '抬头想',
    tag: 'think',
    hold: [3, 5.5],
    face: 'serious',
    bones: {
      Head: { pitch: -0.18, yaw: 0.14 },
      Neck: { pitch: -0.08 },
      Spine1: { pitch: -0.06 },
      LeftArm: { fwd: 0.14, out: -0.10 },
      LeftForeArm: { fwd: 0.50, twist: -0.30 },
      RightArm: { fwd: 0.14, out: 0.10 },
      RightForeArm: { fwd: 0.50, twist: 0.30 },
      Hips: { roll: -0.03 },
    },
  },
  {
    id: 'think-arms-cross',
    name: '抱臂苦思',
    tag: 'think',
    hold: [3.5, 6],
    face: 'serious',
    bones: {
      Head: { pitch: 0.08, yaw: -0.10 },
      Neck: { pitch: 0.04 },
      LeftArm: { fwd: 0.40, twist: 0.55, out: -0.10 },
      LeftForeArm: { fwd: 0.92, twist: -0.75 },
      RightArm: { fwd: 0.40, twist: -0.55, out: 0.10 },
      RightForeArm: { fwd: 0.92, twist: 0.75 },
    },
  },
  {
    id: 'think-look-away',
    name: '想着看向别处',
    tag: 'think',
    hold: [3, 5.5],
    face: 'serious',
    bones: {
      Head: { yaw: -0.34, pitch: -0.06 },
      Neck: { yaw: -0.14 },
      Spine1: { yaw: -0.05 },
      LeftArm: { out: -0.10, fwd: 0.12 },
      LeftForeArm: { fwd: 0.40, twist: -0.30 },
      RightArm: { out: 0.12 },
    },
  },
  {
    id: 'think-tap',
    name: '手指点下巴',
    tag: 'think',
    hold: [3, 5],
    face: 'curious',
    bones: {
      Head: { pitch: 0.08, roll: 0.10 },
      Neck: { pitch: 0.04, roll: 0.04 },
      LeftArm: { fwd: 0.14, out: -0.10 },
      LeftForeArm: { fwd: 0.42, twist: -0.28 },
      RightArm: { out: 0.14, fwd: 0.26 },
      RightForeArm: { fwd: 1.18, twist: 0.40 },
    },
  },

  // --- 说话中：她在念台词时的小动作 -------------------------------------
  // 幅度刻意压得比 idle 小、比 load 大：说话时身体不该有大动作，
  // 但完全不动会像录音在播。这一池靠 Home 在 voice.state === 'speaking' 时切进来。
  {
    id: 'talk-nod',
    name: '边说边点头',
    tag: 'speak',
    hold: [1.2, 2],
    bones: {
      Head: { pitch: 0.06 },
      Neck: { pitch: 0.03 },
      RightArm: { out: 0.10, fwd: 0.10 },
    },
  },
  {
    id: 'talk-gesture',
    name: '说着手势',
    tag: 'speak',
    hold: [1.2, 2],
    face: 'gentle',
    bones: {
      Head: { yaw: 0.05 },
      RightArm: { out: 0.22, fwd: 0.34 },
      RightForeArm: { fwd: 0.55, twist: 0.20 },
      LeftArm: { out: -0.06 },
    },
  },
  {
    id: 'talk-tilt',
    name: '歪着头说',
    tag: 'speak',
    hold: [1.4, 2.4],
    bones: {
      Head: { roll: 0.12, yaw: 0.08 },
      Neck: { roll: 0.05 },
      LeftArm: { out: -0.10, fwd: 0.16 },
      RightArm: { out: 0.08 },
    },
  },
  {
    id: 'talk-open-palm',
    name: '摊开手说',
    tag: 'speak',
    hold: [1.2, 2],
    face: 'excited',
    bones: {
      Head: { pitch: 0.02 },
      LeftArm: { out: -0.28, fwd: 0.26 },
      LeftForeArm: { fwd: 0.55, twist: -0.45 },
      RightArm: { out: 0.28, fwd: 0.26 },
      RightForeArm: { fwd: 0.55, twist: 0.45 },
    },
  },
  {
    id: 'talk-lean-in',
    name: '凑近一点说',
    tag: 'speak',
    hold: [1.4, 2.4],
    face: 'gentle',
    bones: {
      Spine1: { pitch: 0.10 },
      Spine: { pitch: 0.05 },
      Neck: { pitch: 0.06 },
      Head: { pitch: 0.08 },
      LeftArm: { fwd: 0.20, out: -0.10 },
      RightArm: { fwd: 0.20, out: 0.10 },
    },
  },

  // --- 加载 / 等待：幅度要小，不然像在跳舞 -------------------------------
  {
    id: 'wait-ready',
    name: '安静等你',
    tag: 'load',
    hold: [2.5, 4.5],
    bones: {
      Head: { pitch: 0.04, roll: 0.03 },
      LeftArm: { fwd: 0.10, out: -0.06 },
      LeftForeArm: { fwd: 0.22 },
      RightArm: { fwd: 0.10, out: 0.06 },
      RightForeArm: { fwd: 0.22 },
    },
  },
  {
    id: 'wait-hands-fold',
    name: '双手交叠等',
    tag: 'load',
    hold: [2.5, 4.5],
    bones: {
      Head: { pitch: 0.06 },
      LeftArm: { fwd: 0.14, out: -0.08 },
      LeftForeArm: { fwd: 0.45, twist: -0.20 },
      RightArm: { fwd: 0.14, out: 0.08 },
      RightForeArm: { fwd: 0.45, twist: 0.20 },
    },
  },
  {
    id: 'wait-sway',
    name: '轻轻晃着等',
    tag: 'load',
    hold: [3, 5],
    bones: {
      Hips: { roll: 0.03 },
      Spine: { roll: 0.02 },
      Head: { roll: -0.03 },
      LeftArm: { out: -0.05 },
      RightArm: { out: 0.05 },
    },
  },
  {
    id: 'wait-behind',
    name: '手背身后等',
    tag: 'load',
    hold: [3.5, 5.5],
    bones: {
      Head: { pitch: 0.03 },
      LeftArm: { fwd: -0.16, out: -0.06 },
      LeftForeArm: { fwd: -0.22 },
      RightArm: { fwd: -0.16, out: 0.06 },
      RightForeArm: { fwd: -0.22 },
    },
  },

  // --- 被戳 / 被摸时抢占播放（很短，播完自动回到 idle 池）-----------------
  {
    id: 'startle',
    name: '被戳一激灵',
    tag: 'react',
    hold: [0.5, 0.5],
    face: 'surprised',
    bones: {
      Spine1: { pitch: -0.10 },
      Neck: { pitch: -0.10 },
      Head: { pitch: -0.12, roll: 0.10 },
      LeftArm: { out: -0.22 },
      RightArm: { out: 0.22 },
      LeftForeArm: { fwd: 0.30 },
      RightForeArm: { fwd: 0.30 },
    },
  },

  {
    id: 'pet-lean',
    name: '被摸了往你这边靠',
    tag: 'react',
    hold: [0.9, 0.9],
    face: 'gentle',
    bones: {
      Hips: { roll: 0.06 },
      Spine: { roll: 0.06 },
      Neck: { roll: -0.10 },
      Head: { roll: -0.18, pitch: 0.06 },
      LeftArm: { out: -0.14, fwd: 0.12 },
      RightArm: { out: 0.10 },
    },
  },
  {
    id: 'shy-look-away',
    name: '害羞别过脸',
    tag: 'react',
    hold: [1.1, 1.1],
    face: 'shy',
    bones: {
      Head: { yaw: -0.32, roll: 0.10 },
      Neck: { yaw: -0.12 },
      Spine1: { yaw: -0.06 },
      LeftArm: { out: -0.10, fwd: 0.18 },
      RightArm: { out: 0.10, fwd: 0.18 },
    },
  },
  {
    id: 'laugh-shake',
    name: '笑到抖',
    tag: 'react',
    hold: [1.2, 1.2],
    face: 'laughs',
    bones: {
      Spine1: { pitch: 0.08 },
      Spine: { pitch: 0.05 },
      Head: { pitch: 0.10, roll: 0.08 },
      LeftArm: { out: -0.16, fwd: 0.14 },
      RightArm: { out: 0.16, fwd: 0.14 },
    },
  },
  {
    id: 'flinch-back',
    name: '被戳缩一下',
    tag: 'react',
    hold: [0.5, 0.5],
    face: 'surprised',
    bones: {
      Spine1: { pitch: 0.08 },
      Neck: { pitch: 0.10 },
      Head: { pitch: 0.12, roll: -0.08 },
      LeftArm: { out: -0.16, fwd: 0.20 },
      RightArm: { out: 0.16, fwd: 0.20 },
    },
  },
  {
    id: 'pout',
    name: '噘嘴不高兴',
    tag: 'react',
    hold: [0.9, 0.9],
    face: 'sad',
    bones: {
      Head: { pitch: 0.06, roll: -0.06 },
      Neck: { roll: -0.03 },
      RightArm: { out: 0.12, fwd: 0.22 },
      LeftArm: { out: -0.08, fwd: 0.10 },
    },
  },
];

/** 按 tag 取姿势（调度器用它挑下一个） */
export const posesByTag = (tag) => IDLE_POSES.filter((p) => p.tag === tag);

export const getPose = (id) => IDLE_POSES.find((p) => p.id === id) || null;

/** 调试用：确认库里到底有多少个、都归在哪类 */
export const POSE_SUMMARY = IDLE_POSES.reduce((m, p) => {
  m[p.tag] = (m[p.tag] || 0) + 1;
  return m;
}, {});

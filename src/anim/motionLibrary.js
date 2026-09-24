// 在线免费动作库重定向
// ---------------------------------------------------------------------------
// 素材来源：Quaternius《Universal Animation Library》标准免费版
//   · 授权 **CC0 1.0 Universal（公共领域奉献）**，可商用、可修改、可再分发、无需署名
//     （许可证原文见 assets/motion/LICENSE-Quaternius-UAL.txt，是官方压缩包自带的那份）
//   · 46 个全身动作，来源 assets/motion/raw/ual-standard.glb
//   · 骨名是 Blender/Rigify 风格：DEF-hips / DEF-upper_arm.L / DEF-thigh.R …
//
// 为什么必须做重定向，不能直接播：
//   那套动画是**绑在它自己的骨架**上的（53 根骨，还有 root 和 10 根手指骨），
//   和我们角色（VRM / MakeHuman 系）的骨架既不同名也不同朝向。
//   拿 AnimationMixer 硬套过去，轻则手脚错位，重则整个人扭成麻花。
//
// 做法：把每个 clip 烘焙成**每帧每根骨的 Δ 四元数**，交给 rigDriver 的 `__dq`
//   通道在世界空间里合成（见 three/rigDriver.js）。这样：
//     · 不受骨架朝向差异影响（rigDriver 本来就绕世界空间做增量）
//     · 能和语义角那套（待机姿势库、呼吸、看人）叠加，因为两条路最后都汇进同一个 Δ
//     · 离线可用：烘焙结果存成一个 JSON，运行时不需要再加载那个 6.5MB 的 GLB
//
// ⚠️ 为什么烘四元数而不是 yaw/pitch/roll 那套语义角，见 tools/motion-bake.mjs 顶部。
//    一句话：欧拉角在"手肘弯 90°"这个最常用的姿态上正好撞万向锁。
//
// ⚠️ 烘焙出来的姿势**只含旋转**，没有位移。所以走路 / 跑步这类带位移的动作
//    在角色身上会变成"原地踏步"。这是刻意的：
//    角色是站在原地陪你的，让她自己走开反而奇怪。要真位移得另外做根节点平移。
//
// 生成：node tools/motion-bake.mjs assets/motion/raw/ual-standard.glb
// 产物：src/anim/motionClips.json

/** Quaternius 骨架名 → 我们的标准名（见 anim/rigStandard.js） */
export const UAL_BONE_MAP = {
  'DEF-hips': 'Hips',
  'DEF-spine.001': 'Spine',
  'DEF-spine.002': 'Spine1',
  'DEF-spine.003': 'Spine2',
  'DEF-neck': 'Neck',
  'DEF-head': 'Head',

  'DEF-shoulder.L': 'LeftShoulder',
  'DEF-upper_arm.L': 'LeftArm',
  'DEF-forearm.L': 'LeftForeArm',
  'DEF-hand.L': 'LeftHand',

  'DEF-shoulder.R': 'RightShoulder',
  'DEF-upper_arm.R': 'RightArm',
  'DEF-forearm.R': 'RightForeArm',
  'DEF-hand.R': 'RightHand',

  'DEF-thigh.L': 'LeftUpLeg',
  'DEF-shin.L': 'LeftLeg',
  'DEF-foot.L': 'LeftFoot',
  'DEF-toe.L': 'LeftToeBase',

  'DEF-thigh.R': 'RightUpLeg',
  'DEF-shin.R': 'RightLeg',
  'DEF-foot.R': 'RightFoot',
  'DEF-toe.R': 'RightToeBase',
};

/** 手臂链 —— 这几个用 out/fwd/twist 语义，其余用 yaw/pitch/roll */
export const UAL_ARM_BONES = new Set([
  'LeftShoulder', 'RightShoulder',
  'LeftArm', 'RightArm',
  'LeftForeArm', 'RightForeArm',
  'LeftHand', 'RightHand',
]);

/**
 * 腿链 —— 烘焙时可以选择整条丢掉。
 *
 * 为什么要有这个开关：腿骨一转脚就离开 rest 高度，落地支撑（three/groundLock.js）
 * 会把根节点往下拽来补。站姿待机那几套动作里腿的位移本来就只有几毫米，
 * 为了这几毫米让根节点每帧抖一下不划算 —— 待机类只留上半身，
 * 跳舞 / 功夫 / 蹲 / 坐这些"本来就该动腿"的才保留。
 */
export const UAL_LEG_BONES = new Set([
  'LeftUpLeg', 'RightUpLeg',
  'LeftLeg', 'RightLeg',
  'LeftFoot', 'RightFoot',
  'LeftToeBase', 'RightToeBase',
]);

/**
 * 不参与烘焙的骨。
 *
 * 以前这里躺着 LeftHand / RightHand：那时候烘的是欧拉语义角，手腕骨段短，
 * 语义轴容易落进欧拉角的奇异区，实测 Sitting_Exit 的 LeftHand 相邻两帧跳 176°。
 * 改成**烘 Δ 四元数**之后奇点问题整个消失了，手骨就放回来了 ——
 * 手腕那点朝向变化对手部网格是看得出来的，没必要丢。
 *
 * 现在这个集合是空的，留着是为了让烘焙脚本的过滤逻辑有个明确的位置。
 */
export const UAL_SKIP_BONES = new Set([]);

/**
 * 只打磨过的、真的适合"陪着聊天"的动作往外暴露。
 *
 * 库里 46 个动作有大半在我们的场景里毫无意义（开枪、游泳、开车、死亡），
 * 全塞进去只会让"随机待机"变成抽奖 —— 抽到 Death01 就尴尬了。
 * 这里按用途分组，宁可少而准。
 */
export const UAL_USEFUL = {
  // 待机 / 情绪
  idle: ['Idle_Loop', 'Idle_Talking_Loop', 'Idle_Torch_Loop'],
  // 说话时配合的姿势
  speak: ['Idle_Talking_Loop', 'Interact'],
  // 手上有东西（拿杯、拿礼物）
  hold: ['Idle_Torch_Loop', 'Driving_Loop'],
  // 玩：跳舞 + 功夫
  dance: ['Dance_Loop'],
  kungfu: ['Punch_Jab', 'Punch_Cross', 'Punch_Enter', 'Sword_Attack', 'Sword_Idle', 'Hit_Chest', 'Hit_Head'],
  // 动作：跳、翻滚、下蹲
  action: ['Jump_Start', 'Jump_Loop', 'Jump_Land', 'Roll', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop'],
  // 坐（以后做"陪她坐下"用）
  sit: ['Sitting_Enter', 'Sitting_Idle_Loop', 'Sitting_Talking_Loop', 'Sitting_Exit'],
};

/**
 * 每个动作的元信息：播多久、能不能循环、配什么表情、算哪一类。
 *
 * hold   「停留时长区间」，和 idlePoses 的语义一致。
 * loop   名字带 _Loop 的能停久一点；单次动作（Punch 这种）播完就回去。
 * keepLegs  false = 烘焙时把整条腿丢掉（见 UAL_LEG_BONES 的说明）。
 *           待机 / 说话类一律 false：那点腿部位移不值得让根节点每帧被拽。
 */
export const UAL_META = {
  Idle_Loop: { name: '站着发呆', tag: 'idle', hold: [3, 6], loop: true, face: null, keepLegs: false },
  Idle_Talking_Loop: { name: '边聊边比划', tag: 'speak', hold: [2.5, 5], loop: true, face: 'gentle', keepLegs: false },
  Idle_Torch_Loop: { name: '手里握着东西', tag: 'idle', hold: [3, 5], loop: true, face: null, keepLegs: false },
  Interact: { name: '伸手拿一下', tag: 'speak', hold: [1.6, 1.6], loop: false, face: 'curious', keepLegs: false },
  Driving_Loop: { name: '握着方向盘', tag: 'idle', hold: [3, 5], loop: true, face: null, keepLegs: false },

  Dance_Loop: { name: '跳舞', tag: 'dance', hold: [6, 9], loop: true, face: 'excited' },

  Punch_Jab: { name: '打一拳（刺拳）', tag: 'kungfu', hold: [1.4, 1.4], loop: false, face: 'serious' },
  Punch_Cross: { name: '打一拳（直拳）', tag: 'kungfu', hold: [1.6, 1.6], loop: false, face: 'serious' },
  Punch_Enter: { name: '摆架势', tag: 'kungfu', hold: [1.4, 1.4], loop: false, face: 'serious' },
  Sword_Attack: { name: '挥剑', tag: 'kungfu', hold: [1.8, 1.8], loop: false, face: 'serious' },
  Sword_Idle: { name: '持剑待机', tag: 'kungfu', hold: [3, 5], loop: true, face: 'proud' },
  Hit_Chest: { name: '胸口挨了一下', tag: 'kungfu', hold: [1.2, 1.2], loop: false, face: 'surprised' },
  Hit_Head: { name: '头被敲了一下', tag: 'kungfu', hold: [1.2, 1.2], loop: false, face: 'surprised' },

  Jump_Start: { name: '起跳', tag: 'action', hold: [0.8, 0.8], loop: false, face: 'excited' },
  Jump_Loop: { name: '空中', tag: 'action', hold: [0.8, 0.8], loop: false, face: 'excited' },
  Jump_Land: { name: '落地', tag: 'action', hold: [1, 1], loop: false, face: 'excited' },
  Roll: { name: '翻滚', tag: 'action', hold: [1.4, 1.4], loop: false, face: 'excited' },
  Crouch_Idle_Loop: { name: '蹲着', tag: 'action', hold: [3, 5], loop: true, face: null },
  Crouch_Fwd_Loop: { name: '蹲着挪', tag: 'action', hold: [3, 5], loop: true, face: null },

  Sitting_Enter: { name: '坐下', tag: 'sit', hold: [1.6, 1.6], loop: false, face: null },
  Sitting_Idle_Loop: { name: '坐着', tag: 'sit', hold: [5, 9], loop: true, face: null },
  Sitting_Talking_Loop: { name: '坐着聊', tag: 'sit', hold: [4, 7], loop: true, face: 'gentle' },
  Sitting_Exit: { name: '站起来', tag: 'sit', hold: [1.6, 1.6], loop: false, face: null },
};

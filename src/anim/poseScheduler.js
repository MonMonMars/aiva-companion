// 待机姿势调度器
// ---------------------------------------------------------------------------
// 姿势库（idlePoses.js）只负责"长什么样"，这个模块负责"什么时候换成什么样"。
//
// 三条规则：
//   1. 按当前状态从对应的池子里挑：站着发呆 / 思考 / 加载等待
//   2. 同一个姿势停 hold 秒（区间内随机，免得节奏太机械），再交叉淡入下一个
//   3. 被戳/被摸的反应姿势**抢占**播放，播完自动回到当前状态的池子
//
// 没有 rig（程序化角色 / 模型没认出骨架）时整个模块空转，不影响别的功能。

import { getPose, posesByTag } from './idlePoses';

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * @param {object|null} rig createRigDriver 的返回值
 * @param {object} [opts]
 * @param {number} [opts.fade] 换姿势的淡入时长（秒）
 * @param {(pose:object) => void} [opts.onPose] 每次换姿势的回调（用来同步表情）
 */
export function createPoseScheduler(rig, opts = {}) {
  const fade = opts.fade ?? 0.6;
  const onPose = opts.onPose || (() => {});

  let state = 'idle';       // idle | think | load
  let cur = null;           // 当前姿势对象
  let hold = 0;             // 还要停多久
  let lastId = null;        // 上一个姿势，用来避免连着播同一个
  let reactId = null;       // 正在抢占播放的反应姿势

  const active = () => !!rig;

  /** 从当前状态的池子里挑一个，尽量不重复上一个 */
  function pick() {
    const all = posesByTag(state);
    if (!all.length) return null;
    const fresh = all.filter((p) => p.id !== lastId);
    const pool = fresh.length ? fresh : all;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function apply(pose, f) {
    if (!pose) return;
    cur = pose;
    lastId = pose.id;
    hold = rand(pose.hold[0], pose.hold[1]);
    rig?.setPose(pose, { fade: f });
    onPose(pose);
  }

  /** 换下一个姿势（反应播完、hold 走完、状态切换时都走这里） */
  function next(fadeOverride) {
    // 反应期间不抢，让反应自己播完
    if (reactId) return;
    apply(pick(), fadeOverride ?? fade);
  }

  /**
   * 每帧调用
   * @param {number} t 累计时间（秒）
   * @param {number} dt 帧间隔（秒）
   */
  function update(t, dt) {
    if (!active()) return;
    if (!cur) { next(); return; }

    hold -= dt;
    if (hold > 0) return;

    if (reactId) {
      // 反应播完 → 回到当前状态的池子
      reactId = null;
      next();
    } else {
      next();
    }
  }

  /**
   * 切换状态。当前姿势不属于新状态时立刻换，属于就继续停着（别打断）
   * @param {'idle'|'think'|'load'} tag
   */
  function setState(tag) {
    if (!tag || tag === state) return;
    state = tag;
    if (active() && !reactId && cur?.tag !== state) next(fade * 0.8);
  }

  /**
   * 抢占播一个反应姿势（被戳 / 被摸）
   * @param {string} id idlePoses 里的 id
   * @returns {boolean} 库里有没有这个姿势
   */
  function react(id) {
    const pose = getPose(id);
    if (!pose || !active()) return false;
    reactId = id;
    // 反应要"立刻"，淡入必须短 —— 0.6s 淡入的话，惊吓动作播完都还没到位
    apply(pose, 0.16);
    return true;
  }

  /** 反应还在播吗（Home 用它决定要不要继续加戏） */
  function isReacting() {
    return !!reactId;
  }

  return {
    update,
    setState,
    react,
    isReacting,
    /** 当前姿势 id（调试 / 打日志用） */
    current: () => cur?.id ?? null,
    state: () => state,
    /** 换 rig 之后重新绑定（切换角色时） */
    rebind(nextRig) {
      rig = nextRig;
      cur = null;
      lastId = null;
      reactId = null;
    },
  };
}

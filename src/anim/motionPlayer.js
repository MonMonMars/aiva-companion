// 动作片段播放器
// ---------------------------------------------------------------------------
// 播的是 anim/motionClips.json —— Quaternius CC0 动画库烘出来的姿势序列
// （每帧每根骨一个 Δ 四元数，见 tools/motion-bake.mjs）。
//
// 和待机姿势库（idlePoses.js / poseScheduler.js）的分工：
//   · 待机姿势是**一个静态造型**，停几秒再换下一个，靠 rig 的交叉淡入过渡
//   · 动作片段是**一串关键帧**，要自己按时间往前推、帧间做插值
//
// 两条路最后都汇到 rigDriver 的同一个 Δ 上，所以待机姿势和动作片段可以叠着用
// （呼吸 / 看人那几层语义角会继续生效）。
//
// 帧间插值用 **slerp**：四元数最短路径，不会像欧拉角那样绕远路或撞万向锁。

import { UAL_USEFUL, UAL_META } from './motionLibrary';

const _a = { x: 0, y: 0, z: 0, w: 1 };
const _b = { x: 0, y: 0, z: 0, w: 1 };

/** 四元数 slerp，写成纯函数是因为这里拿到的都是裸数组 [x,y,z,w] */
function slerp(qa, qb, t, out) {
  _a.x = qa[0]; _a.y = qa[1]; _a.z = qa[2]; _a.w = qa[3];
  _b.x = qb[0]; _b.y = qb[1]; _b.z = qb[2]; _b.w = qb[3];

  let cos = _a.x * _b.x + _a.y * _b.y + _a.z * _b.z + _a.w * _b.w;
  // 走短的那半边：点积为负说明两个四元数夹角大于 180°，
  // 不翻的话 slerp 会绕远路转一圈回来
  if (cos < 0) {
    cos = -cos;
    _b.x = -_b.x; _b.y = -_b.y; _b.z = -_b.z; _b.w = -_b.w;
  }
  let s0;
  let s1;
  if (cos > 0.9995) {
    // 太接近了，slerp 的分母会炸，退化成线性插值再归一化就够了
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  const w = _a.w * s0 + _b.w * s1;
  const x = _a.x * s0 + _b.x * s1;
  const y = _a.y * s0 + _b.y * s1;
  const z = _a.z * s0 + _b.z * s1;
  const len = Math.hypot(x, y, z, w) || 1;
  out[0] = x / len; out[1] = y / len; out[2] = z / len; out[3] = w / len;
  return out;
}

/**
 * @param {object|null} rig createRigDriver 的返回值；没有 rig 就整个空转
 */
export function createMotionPlayer(rig) {
  /** 已加载的动作库；null = 还没加载 */
  let lib = null;
  let clip = null;        // 当前片段
  let clipId = null;
  let time = 0;           // 片段内时间（秒）
  let total = 0;          // 这次要播多久（循环片段 = hold，单次 = duration）
  let cur = null;         // 上一帧算出来的骨骼值，复用对象免得每帧 new
  let onEnd = null;
  /**
   * 当前帧根的上下位移（比例单位，× 髋踝跨度才是米）。
   *
   * 为什么动作片段要管根的高度：源动画是靠"髋下沉 + 屈膝"来让脚留在地上的
   * （实测 Dance_Loop：髋 -7.1cm，脚全程 0±1mm）。只烘旋转的话，
   * 髋不动而腿照弯，多出来的量全顶到脚上 —— 跳舞时脚就离地 6cm。
   */
  let curRootY = 0;

  const active = () => !!rig && !!clip;

  /** 注入动作库（配合"聊天时后台加载"，见 Home 的预加载逻辑） */
  function load(data) {
    lib = data?.clips ? data.clips : null;
    return !!lib;
  }

  /**
   * 播一个动作。
   * @param {string} id motionClips.json 里的键（'Dance_Loop' / 'Punch_Jab' …）
   * @param {object} [opts] { fade: 淡入秒数, hold: 覆盖停留时长 }
   * @returns {boolean} 库里有没有这个动作
   */
  function play(id, opts = {}) {
    if (!lib || !rig) return false;
    const c = lib[id];
    if (!c || !c.frames?.length) return false;

    clip = c;
    clipId = id;
    time = 0;
    curRootY = 0;
    // 循环片段停 hold 秒（区间内随机，免得每次一样长）；单次动作播完就结束
    const meta = UAL_META[id];
    const h = opts.hold ?? (meta?.hold ? meta.hold[0] : 2);
    total = c.loop ? h : c.duration;
    cur = null;
    onEnd = opts.onEnd || null;
    rig.setMotion({}, { fade: opts.fade ?? 0.3 });   // 先起一次淡入，帧内容下一帧填
    return true;
  }

  function stop(opts) {
    if (!rig) return;
    clip = null;
    clipId = null;
    cur = null;
    // 不在这里直接把 curRootY 归零 —— companion 那边是**缓动**过去的
    // （见 motionRootY 的 lerp），直接归零会在动作结束那一帧"掉"一下。
    rig.clearMotion({ fade: opts?.fade ?? 0.45 });
  }

  /**
   * 每帧调用
   * @param {number} dt 帧间隔（秒）
   */
  function update(dt) {
    if (!active()) return;
    time += dt;

    if (time >= total) {
      const done = clipId;
      stop();
      onEnd?.(done);
      return;
    }

    const frames = clip.frames;
    const n = frames.length;
    // 片段内进度 → 关键帧下标。循环片段首尾要接上，所以末尾再补一帧回到第 0 帧
    const span = clip.loop ? n : n - 1;
    const p = clip.loop
      ? ((time / clip.duration) % 1) * span
      : Math.min(1, time / clip.duration) * span;
    let i = Math.floor(p);
    let frac = p - i;
    if (i >= span) { i = span - 1; frac = 1; }
    const j = (i + 1) % n;
    const fa = frames[i];
    const fb = frames[j];

    // 根位移：和骨骼同一套下标，线性插值就够了（它是标量，没有最短路径问题）
    const ry = clip.rootY;
    if (ry && ry.length === n) {
      const ra = ry[i] ?? 0;
      const rb = ry[j] ?? 0;
      curRootY = ra + (rb - ra) * frac;
    } else {
      curRootY = 0;
    }

    // 逐骨 slerp。只有一边有的骨按"另一边等于没转"处理（单位四元数）
    const out = cur || (cur = {});
    for (const k of Object.keys(out)) if (!(k in fa) && !(k in fb)) delete out[k];
    const ident = [0, 0, 0, 1];
    for (const bone of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      const qa = fa[bone] || ident;
      const qb = fb[bone] || ident;
      const slot = out[bone] || (out[bone] = { __dq: [0, 0, 0, 1] });
      slerp(qa, qb, frac, slot.__dq);
    }
    rig.setMotion(out);
  }

  /**
   * 按用途随机挑一个（"跳个舞" → tag='dance'）
   * @param {'idle'|'speak'|'hold'|'dance'|'kungfu'|'action'|'sit'} tag
   */
  function playTag(tag, opts) {
    const pool = (UAL_USEFUL[tag] || []).filter((id) => lib?.[id]);
    if (!pool.length) return false;
    return play(pool[Math.floor(Math.random() * pool.length)], opts);
  }

  return {
    load,
    play,
    playTag,
    stop,
    update,
    active,
    current: () => clipId,
    /** 当前帧根的上下位移（比例单位，× 髋踝跨度 = 米） */
    rootY: () => curRootY,
    /**
     * 这个片段是不是自己在驱动腿？
     * true 的话下半身由动画负责，落地支撑必须让开（见 companion.js）——
     * 不然它为了钉住脚，会把跳跃和翻滚硬按进地板里。
     */
    legsDriven: () => !!clip?.legs,
    /** 动作库加载好了吗 */
    ready: () => !!lib,
    /** 库里所有动作的 id（调试 / 后台管理用） */
    list: () => (lib ? Object.keys(lib) : []),
    rebind(nextRig) {
      rig = nextRig;
      clip = null;
      clipId = null;
      cur = null;
      curRootY = 0;
    },
  };
}

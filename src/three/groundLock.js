// 落地支撑：世界坐标下的「脚钉在地上」
// ---------------------------------------------------------------------------
// 为什么需要它：
//   角色是被**根节点整体抬起来做呼吸/弹跳**的（companion.js 里
//   `root.position.y = breathe + bounce`）。这一层对"站着"没问题，但一被戳，
//   bounce 冲上去，**整个人连脚一起离地** —— 看起来就是"戳一下人飘起来了"。
//
//   而且光"把 root.position.y 钳到 0"是不够的：站姿本身的用力（换腿、踮脚、
//   蹲下）会把**脚底**抬起来，root 却还停在地上 —— 反过来就是"脚陷进去"。
//   所以正确的做法是反过来算：**先让姿势摆好，再看脚底到哪了，把根节点移回去**。
//
// 做法（核心是一个不变量，不是一次相对修正）：
//   1. 记下静止站姿时脚骨的**世界高度基准** rest，和当时的根节点高度 baseY
//   2. 每帧姿势合成完成后，量「脚骨最低的那一根」比 rest 高多少 = lift
//   3. 把根节点钉在 `baseY - lift` 上
//
// 为什么必须是「钉绝对位置」而不是「减掉这一帧的差」：
//   减差值是**相对修正**，它依赖"我上一帧算对了"。一旦有什么东西在几帧里
//   连续把脚抬高（实测：手指按住不放，抚摸路径每 260ms 调一次 react('pet')，
//   每次都往 bounce 上加一点），相对修正会跟着漂 —— 最后人悬在离地 30cm
//   怎么都回不来。钉绝对值没有这个问题：**每一帧都从 rest 重新算**，
//   无论中间漂到哪，下一帧一定是 `baseY - lift`。
//
//   ⚠️ `baseY` 必须量「静止时的 root.position.y」，不能直接写 0 ——
//      companion 里 root.position.y 是 breathe+bounce，静止时也有 ±6mm 的呼吸，
//      把基准当成 0 会把这 6mm 当成 lift 反着写进去，人就一直在微微上下漂。
//
// 只在 rig 存在时工作（程序化角色没有脚骨，跳过即可）。
//
// 验收：tools/cdp-ground.mjs —— 断言「静止 footLift ≤ 5mm」且
//      「戳完 2 秒内 footLift 回到 ≤ 5mm」且「连戳 5 次后仍在地上」。

const EPS = 1e-5;

/** 默认的着地检测骨，按优先级排。都用标准名，认不出就自动跳过 */
const CONTACT_BONES = [
  'LeftFoot', 'RightFoot',
  'LeftToeBase', 'RightToeBase',
];

export function createGroundLock(rig, opts = {}) {
  // 脚允许被抬起的最大高度（米）。默认 0 —— 完全钉死。
  // 想让"踮脚"这种姿势有点真实感可以调到 0.01 左右，但默认必须是 0：
  // 这个功能存在的唯一理由就是"别飘"。
  const slack = opts.slack ?? 0;

  let mapping = rig?.mapping || {};
  let tracked = [];
  /** 规范名 -> rest 世界高度（米） */
  let restY = new Map();
  /** 静止时根节点的 y（呼吸的基准线）—— 见文件头那段说明 */
  let baseY = null;
  let lastLift = 0;
  let lastDelta = 0;
  let lastResidual = 0;

  /** 被跟踪骨的共同祖先（就是模型根节点）—— 用来刷世界矩阵 */
  function rigSceneRoot() {
    for (const name of CONTACT_BONES) {
      const b = mapping?.[name];
      if (b) { let r = b; while (r.parent) r = r.parent; return r; }
    }
    return null;
  }

  /**
   * 重建基准。换模型（换骨架）时必须重来一次。
   *
   * ⚠️ 调用时机很讲究：**必须在"静止站姿"下量**。
   *    如果在某个姿势正播到一半时量，那个姿势的抬脚量会被当成基准 0，
   *    之后所有姿势都会相对它偏移 —— 表现为"她一直陷在地里"。
   *    attachModel 里是在挂了模型、rig 刚建好、还没播任何姿势时调的，正确。
   *
   * @param {object} nextRig
   * @param {number} [rootY] 当时的根节点 y；不传就退回 0
   */
  function rebuild(nextRig, rootY) {
    mapping = nextRig?.mapping || {};
    tracked = CONTACT_BONES.filter((n) => !!mapping[n]);
    baseY = Number.isFinite(rootY) ? rootY : null;
    lastLift = 0;
    lastDelta = 0;
    lastResidual = 0;

    restY = new Map();
    const root = rigSceneRoot();
    if (!root) return;
    root.updateWorldMatrix(true, true);
    for (const name of CONTACT_BONES) {
      const b = mapping[name];
      if (!b) continue;
      b.updateWorldMatrix(true, false);
      const y = b.matrixWorld.elements[13];
      if (Number.isFinite(y)) restY.set(name, y - (baseY ?? 0));
    }
  }

  /**
   * 每帧调用。**必须在 rig.update() / poseSched.update() 之后** ——
   * 要等姿势把骨头摆完再量，否则量到的是上一帧的脚位。
   *
 * @param {number} [rootYNow] 本帧 rig 更新完之后的根节点 y（还没加本函数的补偿）
 * @returns {number} 根节点应该被设成什么 y（绝对值）
 *
 * 探针断言要看 `residualLift()` 不是 `footLift()`：动作片段里 footLift
 * 天然不为 0（原始抬脚量），residual 才是"补完之后她到底离地多少"。
 */
  /** 量「最低的脚比 rest 高多少」。update 和 measure 共用 */
  function readLift() {
    // 1) 量脚骨当前世界高度，取最低的那一根
    let lowY = Infinity;
    let lowName = null;
    for (const name of tracked) {
      const b = mapping[name];
      b.updateWorldMatrix(true, false);
      const y = b.matrixWorld.elements[13];
      if (y < lowY) { lowY = y; lowName = name; }
    }
    if (!Number.isFinite(lowY) || !lowName) return null;

    // 2) rest 基准缺失（第一次跑还没量到）—— 就地补一次，别把好数据丢给 0
    const rest = restY.get(lowName);
    if (!Number.isFinite(rest)) return null;

    // 3) 抬起来多少。负的（踩得比基准低）一律当 0：
    //    强行往上顶会把人顶穿地面，而且下蹲本来就该让脚"更低"是错觉 ——
    //    脚不该比基准低，低说明是姿势写错了，不该由这里兜。
    let lift = lowY - rest - (baseY ?? 0);
    if (lift < EPS) lift = 0;
    if (lift > slack + 1) lift = slack + 1;   // 防呆，别让一个坏姿势把人送到天上
    lastLift = lift;
    return lift;
  }

  /**
   * 只量不钉。给"腿被驱动的动作片段"用：那种场合我们不改根节点
   * （跳跃/翻滚/马步本来就该离地），但仍然要知道脚离地多少 ——
   * 一是调试面板要看，二是探针要靠它断言"跳舞时她没飘"。
   */
  function measure() {
    if (!tracked.length) return 0;
    const lift = readLift();
    return lift == null ? 0 : lift;
  }

  /**
   * @param {number} rootYNow 本帧根节点 y（还没加本函数的补偿）
   * @param {number|null} [cap] 最多补多少米。给动作片段用：
   *        只抹平"没贴稳"的那几厘米，真正的离地（跳跃/翻滚）留给它自己。
   */
  function update(rootYNow, cap = null) {
    if (!tracked.length) return 0;
    const lift = readLift();
    if (lift == null) return 0;

    // 4) 钉绝对高度：静止时正好落在 baseY，抬脚时从 baseY 往下补
    //    ⚠️ lastLift 记的是**原始**抬脚量（给探针看"到底飘了多少"），
    //       实际补偿另算，两者分开才不会把"跳起来"误报成"贴地"。
    const cut = cap != null ? Math.min(lift, cap) : lift;
    const target = (baseY ?? 0) - cut;
    lastDelta = target - (Number.isFinite(rootYNow) ? rootYNow : 0);
    // 补完之后还剩多少没抹平。这是**验收真正该看的数**：
    // lastLift 是补偿前的原始抬脚量，动作片段里它天然不为 0；
    // residual 才是"这一帧渲染出来她到底离地多少"。
    lastResidual = Math.max(0, lift - cut);
    return target;
  }

  return {
    update,
    measure,
    rebuild,
    /** 补偿**前**的原始抬脚量（米）。看"这个姿势把脚抬了多少"用它 */
    footLift: () => Number(lastLift.toFixed(4)),
    /** 补偿**后**还剩多少（米）。验收"她到底离地没有"用这个，别用 footLift */
    residualLift: () => Number(lastResidual.toFixed(4)),
    /** 这一帧根节点被移动了多少（负数 = 往下）。调试用 */
    lastDelta: () => Number(lastDelta.toFixed(4)),
    /** 被跟踪的着地骨名字 */
    bones: () => tracked.slice(),
    /** rest 基准高度（已扣掉 baseY，所以静止时约等于脚踝真实高度） */
    rest: () => Object.fromEntries([...restY].map(([k, v]) => [k, Number(v.toFixed(4))])),
    /** 静止时根节点的基准 y */
    baseY: () => baseY,
    /** 真有基准可用吗 */
    ready: () => tracked.length > 0 && restY.size > 0 && Number.isFinite(baseY),
    tracked: () => restY.size,
  };
}

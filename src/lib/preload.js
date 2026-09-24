// 渐进式加载调度器
// ---------------------------------------------------------------------------
// 要解决的问题：**首屏被 7.6MB 的 GLB 解析堵住**。
//   之前的顺序是：进主页 → 建 3D 场景 → 立刻 parse 主模型（kizuna 7.4MB）
//   → 再挂贴图 / 灌 morph → 这整段跑完，输入框才真正能点。
//   在手机上这就是"点进去愣两三秒，界面像卡住"。
//
// 改成：
//   1. 先把"能打字、能看到她说的话"这条最小链路点亮（Home 挂载即 markInteractive）
//   2. 重活全部丢进这条队列，由它一个一个地、在**浏览器空闲时**慢慢跑
//   3. 主模型优先级最高（100），预热别人的模型排在主模型之后（after: 'model'）
//
// ⚠️ 三个容易踩的点，改这个文件前先看：
//   a) 队列**串行**。同时 parse 两个 GLB 会让主线程连续掉帧，
//      比一个一个来慢得多（GC 也跟着抖）。
//   b) 每个任务之间 `await nextIdle()` 让出主线程 —— 没有这一步，
//      "后台预热"就等于"换个地方卡界面"。
//   c) `after` 依赖的任务如果那个 id 永远不出现，会在队列清空后被强制放行
//      （见 pump 末尾），不会永久挂起。
//
// 另外：**Metro 是静态打包**，require() 的资源在构建期就写进清单了，
// 所以这里的"预载"不是"延迟下载"，而是"延迟解析 + 预热字节缓存"。
// 想真正延迟下载得改用动态 import()，那是另一套方案。

const listeners = new Set();

const state = {
  /** boot（还在等首屏） → running（在跑队列） → done */
  phase: 'boot',
  total: 0,
  done: 0,
  /** 当前在跑的任务名（给 UI / 调试看） */
  label: '',
  /** 队列里还剩几个 */
  pending: 0,
  /** 首屏就绪（markInteractive）的时刻；0 = 还没到 */
  interactiveAt: 0,
  /** 第一个重活真正开跑的时刻；0 = 还没跑 */
  firstTaskAt: 0,
};

const queue = [];     // 可以跑了的任务
const waiting = [];   // 在等某个 id 完成的任务
const ids = new Set();      // 已登记过的任务 id（去重）
const doneIds = new Set();  // 已完成的任务 id
let running = false;
let interactive = false;
let gateResolve = null;

// 顺序证据：本机跑得快的时候，队列在首屏 700ms 内就跑完了，
// "done < total" 这种断言在快机器上必然失败、在慢机器上必然通过 —— 测不出东西。
// 真正要守住的是**顺序**：首屏就绪的时刻必须早于第一个重活开跑的时刻。
// 这两个时间戳就是给自动化脚本做这个断言用的。
let interactiveAt = 0;
let firstTaskAt = 0;
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const gate = new Promise((r) => { gateResolve = r; });

function emit() {
  state.pending = queue.length + waiting.length;
  state.interactiveAt = interactiveAt;
  state.firstTaskAt = firstTaskAt;
  const snap = { ...state };
  listeners.forEach((fn) => { try { fn(snap); } catch (_) {} });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 让出主线程，等到浏览器空闲。
 * requestIdleCallback 在 iOS Safari 上要到 16.4 才有 —— 没有就退化成 setTimeout(0)，
 * 效果差一点（不会真的等空闲）但不会错。
 */
function nextIdle(timeout = 800) {
  return new Promise((res) => {
    const ric = typeof globalThis.requestIdleCallback === 'function'
      ? globalThis.requestIdleCallback
      : null;
    if (ric) ric(() => res(), { timeout });
    else setTimeout(res, 0);
  });
}

/**
 * 首屏就绪：输入框能点了。
 * Home 挂载后调用一次。从此刻起重活才允许跑。
 * 万一没人调（比如卡在角色选择页），3 秒兜底也会放行 —— 宁可晚点亮，
 * 也不要让用户对着一个永远不动的进度条。
 */
export function markInteractive() {
  if (interactive) return;
  interactive = true;
  if (!interactiveAt) interactiveAt = now();
  state.phase = 'boot';
  gateResolve?.();
  emit();
}

/**
 * @param {object} task
 * @param {string} task.id       唯一 id，重复登记会被忽略
 * @param {string} task.label    给人看的名字
 * @param {number} [task.priority] 越大越先跑
 * @param {string} [task.after]  等这个 id 的任务跑完才开始
 * @param {() => (Promise<any>|any)} task.run
 */
export function schedule(task) {
  if (!task || !task.id) return;
  if (ids.has(task.id)) {
    // force：同 id 重新登记（换角色时的模型任务要能重跑）。
    // 不这么做的话第二次 schedule('model') 会被静默忽略 ——
    // 表现是"换了角色但人没换"，很难查。
    if (!task.force) return;
    drop(task.id);
  }
  ids.add(task.id);

  const t = { priority: 0, ...task };
  if (t.after && !doneIds.has(t.after)) waiting.push(t);
  else queue.push(t);

  state.total++;
  emit();
  pump();
}

/** 把某个 id 从"已登记 / 已排队 / 已完成"里彻底抹掉（force 重登记用） */
function drop(id) {
  ids.delete(id);
  doneIds.delete(id);
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
  for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].id === id) waiting.splice(i, 1);
}

/** 解除某个 id 的依赖：等它的任务全部放行 */
function release(id) {
  doneIds.add(id);
  for (let i = waiting.length - 1; i >= 0; i--) {
    if (waiting[i].after === id) {
      queue.push(waiting[i]);
      waiting.splice(i, 1);
    }
  }
}

async function pump() {
  if (running) return;
  running = true;

  // 首屏没就绪就先等；3 秒兜底，避免某个页面忘了调 markInteractive 就永久卡住
  if (!interactive) {
    state.phase = 'boot';
    emit();
    await Promise.race([gate, sleep(3000)]);
  }

  state.phase = 'running';
  emit();

  while (queue.length || waiting.length) {
    // 队列空了但还有在等依赖的任务 → 依赖的那个 id 大概不会来了，强制放行
    if (!queue.length && waiting.length) {
      queue.push(...waiting.splice(0, waiting.length));
    }

    queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const t = queue.shift();
    state.label = t.label || t.id;
    if (!firstTaskAt) firstTaskAt = now();
    emit();

    await nextIdle(t.busy ? 1500 : 600);
    try {
      await t.run();
    } catch (e) {
      // 预热失败不值得打断用户：只是"切换角色慢一点"或"少一个模型"
      console.warn('[preload] ' + t.id + ' 失败：', e?.message || e);
    }
    state.done++;
    release(t.id);
    emit();
  }

  running = false;
  state.phase = 'done';
  state.label = '';
  emit();
}

/** 当前进度快照 */
export function preloadState() {
  return { ...state, pending: queue.length + waiting.length };
}

/** 订阅进度变化（Menu 页用它显示"后台预热 7/15"） */
export function subscribePreload(fn) {
  listeners.add(fn);
  fn(preloadState());
  return () => listeners.delete(fn);
}

/** 调试 / 自动化脚本用的钩子 */
if (typeof globalThis !== 'undefined') {
  globalThis.__aivaPreload = {
    state: preloadState,
    schedule,
    markInteractive,
    /** 等队列跑完（测试里用它断言"预热真的做完了"） */
    drain: (timeout = 30000) => new Promise((res) => {
      const t0 = Date.now();
      const tick = () => {
        const s = preloadState();
        if (s.phase === 'done' || Date.now() - t0 > timeout) return res(s);
        setTimeout(tick, 150);
      };
      tick();
    }),
  };
}

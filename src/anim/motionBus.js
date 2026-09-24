// 动作总线：让「不在同一个 React 树里」的调用方也能触发 3D 动作
// ---------------------------------------------------------------------------
// 场景句柄（companion）住在 Home/Avatar3D 那一层，而对话逻辑有两处：
//   · screens/Home.js  —— 打字发送，手里有 companionRef，直接调就行
//   · useVoice.js      —— 语音会话，是个 hook，拿不到任何 ref
//
// 为了不再为"怎么把 ref 传进 hook"折腾一层 prop drilling，这里放一个模块级的
// 单向登记处：场景挂载时把 playMotion 登记进来，谁想触发都行。
// 没登记（场景还没起来）时调用就是空转，不会报错。

let handler = null;

/** 场景侧调用：把真正的 playMotion 登记进来 */
export function registerMotionBus(fn) {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

/**
 * 对话侧调用：让角色做个动作
 * @param {string} kind 'dance' | 'kungfu' | 'action' | 'sit' | 'idle' | 'stop'
 * @returns {Promise<boolean>} 真的播起来了吗
 */
export function requestMotion(kind) {
  if (!handler) return Promise.resolve(false);
  return Promise.resolve(handler(kind)).then((r) => !!r);
}

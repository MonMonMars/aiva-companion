// 给「一个可能永远不 settle 的异步调用」加上限
// ---------------------------------------------------------------------------
// 单独成文件不是为了复用，而是为了**能被单元测试直接 import** ——
// 这个函数踩过一次足以搞挂整个 App 的坑（见下面第 ② 条），那种 bug 必须
// 有一条自动化用例盯着，光靠注释盯不住。
//
// 两条硬约束，都写死在代码里，改的时候别破坏：
//
// ① **guard 自己必须先挂上 handler。**
//    「超时用的那个 promise」如果在别处没人接，它到点就会变成一个
//    unhandled rejection。本项目 src/ErrorBoundary.js 恰好监听了
//    window 的 unhandledrejection（第 31 行），于是**整页会被错误页接管** ——
//    一个只想「少等几秒」的改动，把 App 打成了白屏错误页。
//
// ② **别假设传进来的东西是个真 Promise。**
//    cloud.database.from(...).select(...) 返回的是 PostgrestBuilder，
//    它只实现了 then，**没有 catch / finally**（见 node_modules/@tencent-ai/
//    workbuddy-cloud-sdk/lib/index.js:1375）。直接对它调 .catch 会同步抛
//    TypeError —— 异常发生在建立 race 之前，于是 timer 已经排上却没人 race，
//    2 秒后就是 ① 的那出戏。所以这里一律先 Promise.resolve() 包一层。
//
// ③ 原调用迟到返回的失败也要吞掉。它已经被 timeout 取代了，没人关心它，
//    不吞就是又一个 unhandled rejection。

/**
 * @param {unknown} source 要限时等待的东西（真 Promise 或只有 then 的 thenable 都行）
 * @param {number} ms 等待上限
 * @param {string} message 超时时 reject 的 Error 文案
 * @returns {Promise<unknown>} 超时则以 message 拒绝
 */
export function withTimeout(source, ms, message = 'timeout') {
  let timer;

  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // ① 先给 guard 挂个空 handler：无论后面任何一步同步抛错，它都不会无人接
  guard.catch(() => {});

  // ② 包一层，拿到标准 Promise 接口
  const p = Promise.resolve(source);
  // ③ 迟到的失败没人接，先吞掉，免得冒 unhandled rejection
  p.catch(() => {});

  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

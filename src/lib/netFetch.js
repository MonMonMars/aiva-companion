// 给网络请求加等待上限 —— 所有对外 API 调用走这里
// ---------------------------------------------------------------------------
// ⚠️ 为什么必须有：网络「挂起」时（电梯里、欠费 4G、DNS 黑洞 —— 连不上但也
//    没被拒）fetch **永不落定**。而 UI 的状态出口都写在 await 之后 /
//    finally 里 —— 那些代码要等 await 返回才执行。于是：
//      · 语音识别挂起 → webSession 停在 state='thinking'
//        → useVoice 的 isBusy 永远 true → 麦克风按不动
//      · 语音合成挂起 → state='speaking' → 同样卡死
//    这不是「慢一点」，是无限期卡住。2026-09-25 补 STT/TTS 兜底时发现的，
//    和 auth / database 那两次是同一个错：以为某个模块自带超时，实际没有。
//
// ⚠️⚠️ 超时**不能只靠 AbortController**（这一点改过一次，别退化回去）：
//    signal 只是"通知对方取消"，得对方（fetch 实现）真的搭理它才会 reject。
//    src/lib/region.js 里那句"RN 的 fetch 不认 AbortSignal 时也能靠
//    Promise.race 兜住"说的就是这件事 —— 万一某个平台的 fetch 装聋，
//    只发 signal 就等于没有超时，await 照样永不落定，前面那些分析全部白做。
//    所以这里是**两层**：
//      · AbortController —— 到点把没人等的请求掐掉，别让它在后台占着连接；
//      · withTimeout 的 Promise.race —— 真正保证「一定会有一个结果」。
//    只有第一层时测试照样绿（浏览器/node 的 fetch 都认 signal），
//    但换到不认的平台就全盘失效 —— 这种"测不出来"的差别才最危险。
//
// ⚠️ 只用于**网络请求**。读本地录音那种 `fetch(blobUri)` 别套上来 ——
//    本机读文件在移动端可能真的慢，给它加上限只会把正常流程掐断。

import { withTimeout } from './withTimeout';

export const NET_TIMEOUT_MS = 30000;

/** 超时错误的 machine-readable 标记（err.code），也是线上验收的探针串 */
export const NET_TIMEOUT_CODE = 'net-timeout';

function timeoutError(ms) {
  // 按秒取整要注意：调用方传小于 1 秒的上限时（测试里常见）会变成「等了 0 秒」，
  // 那是句明显的假话，所以不足一秒就照毫秒说。
  const wait = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms)} 毫秒`;
  const err = new Error(`服务器没响应（等了 ${wait}）`);
  // 挂起不是用户网络设置的锅，别写「检查一下网络」去误导他
  err.code = NET_TIMEOUT_CODE;
  return err;
}

/**
 * 带等待上限的 fetch。超时抛 Error（带 code，人话文案），调用方按普通失败处理即可。
 *
 * @param {string} url
 * @param {object} [init] fetch 的第二个参数
 * @param {number} [ms] 等待上限，默认 30 秒
 * @returns {Promise<Response>}
 */
export async function netFetch(url, init = {}, ms = NET_TIMEOUT_MS) {
  // 调用方自己带了 signal，说明它自己管超时（比如一次性的下载要更长）—— 别覆盖
  if (init?.signal) return fetch(url, init);

  const ac = new AbortController();
  try {
    return await withTimeout(
      fetch(url, { ...init, signal: ac.signal }),
      ms,
      NET_TIMEOUT_CODE,
      () => ac.abort() // 我们已经不等了，别让它继续占着连接（弱网正是要防的场景）
    );
  } catch (e) {
    // 两个来源都算超时：race 自己判的（大多数情况），以及 fetch 收到 abort 后
    // 抢在 race 之前抛的 AbortError —— 两者都得给人话，不能把
    // "The user aborted a request" 这种浏览器原文甩给用户。
    if (e?.message === NET_TIMEOUT_CODE || e?.name === 'AbortError') throw timeoutError(ms);
    throw e; // 网络本身的错误原样往上抛，别伪装成超时
  }
  // 注：真到超时那一刻，被 race 丢下的那个 fetch promise 会一直悬着到对方服务器
  // 关连接为止（withTimeout 已经替我们吞掉它的 rejection）。这是刻意的取舍：
  // 用户侧必须先拿到结果，与其无限等下去，不如留一个没人听的 promise。
}

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
// ⚠️ 只用于**网络请求**。读本地录音那种 `fetch(blobUri)` 别套上来 ——
//    本机读文件在移动端可能真的慢，给它加上限只会把正常流程掐断。
//
// 判据参考 services/web.js 里那份 req()（搜索/天气用的），这里抽成通用的：
// AbortController + setTimeout + AbortError 转人话 + finally 清定时器。
// 四步缺一不可 —— 少 clearTimeout 会让定时器泄漏；不转人话就会给用户看
// 一句 "The user aborted a request"。

export const NET_TIMEOUT_MS = 30000;

/** 超时错误的 machine-readable 标记（err.code），也是线上验收的探针串 */
export const NET_TIMEOUT_CODE = 'net-timeout';

/**
 * 带等待上限的 fetch。超时抛 Error（人话），调用方按普通失败处理即可。
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
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    // 挂起不是用户网络设置的锅，别写「检查一下网络」去误导他
    if (e?.name === 'AbortError') {
      // 按秒取整要注意：调用方传小于 1 秒的上限时（测试里常见）会变成「等了 0 秒」，
      // 那是句明显的假话，所以不足一秒就照毫秒说。
      const wait = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms)} 毫秒`;
      const err = new Error(`服务器没响应（等了 ${wait}）`);
      // machine-readable 的标记，不进文案。两个用处：调用方能区分「超时」和
      // 「真的出错」；verify-live.mjs 能在线上产物里搜到它，确认这次兜底真的上线了
      // —— push 成功不等于线上跑的是新代码。
      err.code = NET_TIMEOUT_CODE;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

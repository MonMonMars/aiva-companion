/**
 * netFetch 的行为契约 —— 对外网络请求必须「一定会回来」。
 *
 * 为什么要有这个测试（别当样板代码删掉）：
 *   挂起的网络（连不上也没被拒）会让 fetch **永不落定**，而 UI 的状态出口
 *   全都挂在 await 之后：以语音为例，webSession 先 setState('thinking')
 *   才 await transcribe()，那些 `onState({ state: 'idle' })` 全在它返回之后 ——
 *   没有上限，用户松手后就永远停在「等她说」，麦克风也按不动（isBusy 锁死）。
 *   这跟 auth / database 那两次是同一个错，只是这次在核心交互上。
 *
 * 这里模拟的是**真实浏览器行为**：请求挂起时不 settle，直到 signal 被 abort
 * 才以 AbortError 拒绝 —— 不是「到点自己 resolve」，那样测出来的东西没意义。
 *
 * 用法：node tools/test-net-timeout.mjs
 */
import { netFetch, NET_TIMEOUT_MS, NET_TIMEOUT_CODE } from '../src/lib/netFetch.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};

// App 有 ErrorBoundary 监听 unhandledrejection，漏一个就把整页打成错误页
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));

const realFetch = globalThis.fetch;

/** 让 fetch 变成「永远挂着，只有 abort 才拒绝」—— 复刻挂起的网络 */
const stubHang = () => {
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init?.signal) {
        init.signal.addEventListener('abort', () => {
          const e = new Error('The user aborted a request.');
          e.name = 'AbortError';
          reject(e);
        });
      }
      // 不 settle：这就是挂起
    });
};

console.log('— 常量 —');
ok(NET_TIMEOUT_MS >= 10000 && NET_TIMEOUT_MS <= 60000, `NET_TIMEOUT_MS 在合理区间（${NET_TIMEOUT_MS}ms）`);

console.log('\n— 正常路径必须原样透传 —');
{
  const sentinel = { ok: true, status: 200 };
  globalThis.fetch = async () => sentinel;
  const res = await netFetch('https://example.com/x', { method: 'POST' });
  ok(res === sentinel, '成功时原样返回 response，不改写');
}

console.log('\n— 挂起必须有出口（核心）—');
{
  stubHang();
  const t0 = Date.now();
  let caught = null;
  try {
    await netFetch('https://example.com/stt', { method: 'POST' }, 80);
  } catch (e) { caught = e; }
  const dt = Date.now() - t0;

  ok(!!caught, '挂起最终会抛错返回，而不是永远悬着');
  ok(dt >= 75 && dt < 2000, `确实等到了上限才放弃（${dt}ms）`);
  ok(caught && /服务器没响应/.test(caught.message), '错误是人话', caught && caught.message);
  ok(caught && !/abort|AbortError|The user aborted/i.test(caught.message),
    '不能把浏览器的 AbortError 原文甩给用户', caught && caught.message);
  // verify-live.mjs 就靠这个串确认线上 bundle 里真的有这层兜底
  ok(caught && caught.code === NET_TIMEOUT_CODE, '带上可机读的标记（且不混进用户看到的文案）',
    caught && caught.code);
}

console.log('\n— 超时文案本身不能撒谎 —');
{
  // 修过一次：原先一律按秒取整，于是小于 1 秒的上限会说出「等了 0 秒」这种假话。
  stubHang();
  let msg = null;
  try { await netFetch('https://example.com/short', {}, 80); } catch (e) { msg = e.message; }
  ok(msg && /80 毫秒/.test(msg), '不足一秒按毫秒说（否则会变成「等了 0 秒」）', msg);

  // 这条要表达的是「别把内部单位甩给用户」：秒级等待就该说秒，
  // 而不是把 1050 这种原始毫秒数印出来给用户看。
  let msg2 = null;
  try { await netFetch('https://example.com/long', {}, 1050); } catch (e) { msg2 = e.message; }
  ok(msg2 && /1 秒/.test(msg2) && !/1050/.test(msg2), '秒级等待只说秒，不泄漏原始毫秒数', msg2);
}

console.log('\n— 调用方自己管超时时不要覆盖 —');
{
  const ac = new AbortController();
  let seenSignal = null;
  globalThis.fetch = async (_u, init) => { seenSignal = init?.signal; return { ok: true }; };
  await netFetch('https://example.com/d', { signal: ac.signal }, 80);
  ok(seenSignal === ac.signal, '传了 signal 就原样用，不再套一层');
}

console.log('\n— 网络本身的错误要原样抛，不被误当成超时 —');
{
  globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
  let caught = null;
  try { await netFetch('https://example.com/e', {}, 80); } catch (e) { caught = e; }
  ok(caught && caught.message === 'Failed to fetch', '非超时错误原样透传', caught && caught.message);
}

console.log('\n— 自检：不套 netFetch 的话，挂起真的没有出口 —');
{
  // 证明上面那些断言有区分力：把兜底拿掉，下面这条就会失败。
  stubHang();
  let settled = false;
  netFetch('https://example.com/z', {}, 60).then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await new Promise((r) => setTimeout(r, 200));
  ok(settled === true, '套了 netFetch 的挂起请求 200ms 内会落定');

  let settled2 = false;
  Promise.resolve(globalThis.fetch('https://example.com/z', {})).then(
    () => { settled2 = true; },
    () => { settled2 = true; }
  );
  await new Promise((r) => setTimeout(r, 200));
  ok(settled2 === false, '裸的挂起 fetch 200ms 后仍未落定（= 兜底确实在起作用）');
}

globalThis.fetch = realFetch;
await new Promise((r) => setTimeout(r, 100));
console.log('\n— 未处理拒绝 —');
ok(unhandled.length === 0, '全程没有漏网的 unhandled rejection（否则整页变错误页）', unhandled.join(' | '));

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);

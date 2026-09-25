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

// 调一次 netFetch，并给它套一层「最终必须会有个结论」的硬上限。
// ⚠️ 为什么要这层：netFetch 要真失效了，它就是**永不返回**，而直接
//    await 一个永不 settle 的 promise 只会让测试进程挂住 —— CI 上要等 job
//    超时才知道失败，而且看不出是哪一步。加个盖子，把「挂住」变成
//    一条 3 秒内必然打出结果的失败断言。
async function callCapped(ms, capMs = 3000) {
  const t0 = Date.now();
  const out = await Promise.race([
    netFetch('https://example.com/x', {}, ms).then(
      (v) => ({ v }),
      (e) => ({ e }) // 挂上 handler，避免「迟到完工」变成 unhandled rejection
    ),
    new Promise((r) => setTimeout(() => r({ cap: true }), capMs)),
  ]);
  return { ...out, dt: Date.now() - t0, cap: !!out.cap };
}

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
  const { e: caught, dt, cap } = await callCapped(80);

  ok(!cap && !!caught, '挂起最终会抛错返回，而不是永远悬着',
    cap ? '等到硬上限都没回来' : '');
  ok(!cap && dt >= 75 && dt < 2000, `确实等到了上限才放弃（${dt}ms）`);
  ok(caught && /服务器没响应/.test(caught.message), '错误是人话', caught && caught.message);
  ok(caught && !/abort|AbortError|The user aborted/i.test(caught.message),
    '不能把浏览器的 AbortError 原文甩给用户', caught && caught.message);
  // verify-live.mjs 就靠这个串确认线上 bundle 里真的有这层兜底
  ok(caught && caught.code === NET_TIMEOUT_CODE, '带上可机读的标记（且不混进用户看到的文案）',
    caught && caught.code);
}

console.log('\n— 平台不理睬 AbortSignal 时也必须有出口（这组是命门）—');
{
  // 极端 stub：既不 settle，也**完全不理 signal** —— 模拟某个平台的 fetch 装聋。
  // ⚠️ 这组断言的存在意义：只发 AbortSignal、不做 Promise.race 的实现，
  //    在上面那些组里全都能通过（因为 node / 浏览器的 fetch 都认 signal），
  //    唯独在这一组会挂 —— await 永不返回。差别恰恰在"本地测不出来"的地方，
  //    所以必须写一条其余组都测不到的用例盯着它。
  globalThis.fetch = () => new Promise(() => {});
  const { e: caught, dt, cap } = await callCapped(120);

  ok(!cap && !!caught, '连「不认 AbortSignal 的平台」也有出口',
    cap ? '等到上限也没回来 —— 说明超时只靠 signal 一层，等于没有' : '');
  ok(!cap && dt >= 110 && dt < 2000, `到点就走，不管对方理不理（${dt}ms）`);
  ok(caught && caught.code === NET_TIMEOUT_CODE, '还是同一个可机读标记');
}

console.log('\n— 超时文案本身不能撒谎 —');
{
  // 修过一次：原先一律按秒取整，于是小于 1 秒的上限会说出「等了 0 秒」这种假话。
  stubHang();
  // 这里也走 callCapped：万一兜底退化掉，这条会立刻红，而不是把进程挂死
  const short = await callCapped(80);
  const long = await callCapped(1050);
  const msg = short.e && short.e.message;
  const msg2 = long.e && long.e.message;
  ok(msg && /80 毫秒/.test(msg), '不足一秒按毫秒说（否则会变成「等了 0 秒」）', msg);

  // 这条要表达的是「别把内部单位甩给用户」：秒级等待就该说秒，
  // 而不是把 1050 这种原始毫秒数印出来给用户看。
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

  // 裸 fetch 连 signal 都不认更不用说 —— 证明上面的「装聋平台」场景是真存在的
  globalThis.fetch = () => new Promise(() => {});
  let settled3 = false;
  Promise.resolve(globalThis.fetch('https://example.com/deaf2', {})).then(
    () => { settled3 = true; },
    () => { settled3 = true; }
  );
  await new Promise((r) => setTimeout(r, 200));
  ok(settled3 === false, '对不认 signal 的 fetch，裸调用 200ms 后仍未落定');
}

globalThis.fetch = realFetch;
await new Promise((r) => setTimeout(r, 100));
console.log('\n— 未处理拒绝 —');
ok(unhandled.length === 0, '全程没有漏网的 unhandled rejection（否则整页变错误页）', unhandled.join(' | '));

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);

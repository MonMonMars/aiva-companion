/**
 * authCall / dbCall / authErrorMessage 的行为契约 —— 云端调用的「挂起」兜底。
 *
 * 为什么要有这个测试（别当样板代码删掉）：
 *   网络挂在 Clinet 与服务器「连不上也未被拒」的状态时（电梯里、欠费 4G、
 *   DNS 黑洞），await **永不落定**。而 UI 的出口全都写在 `finally` 里 ——
 *   `finally` 要靠 await 落定才会跑，所以挂起 = 永久转圈且没有取消入口：
 *     · useAccount 的 loading 一直是 true → 账号页停在「正在读取账号…」
 *     · AccountView 的 setBusy(true) → 按钮被 ActivityIndicator 永久替换
 *   authCall / dbCall 就是那两层兜底。这里锁住的是「挂起也必须有出口」。
 *
 * ⚠️ 别信「database 模块里有 timeout 所以安全」——那是错的一半：
 *    SDK 建 PostgrestClient 时**没传** timeout（lib/index.js:5038 只传了 fetch），
 *    而构造函数里 timeout 没传就走 `else { this.fetch = originalFetch }`
 *    （同文件 4756~4787 行）—— 裸 fetch，一点超时都没有。文件里那些
 *    `timeout` 字样是 supabase 留的可选能力，没人用。
 *    所以 auth 和 database **两边都要兜**，只兜 auth 等于只堵了进门那一段。
 *
 * 用法：node --import ./tools/ext-resolve.mjs tools/test-auth-timeout.mjs
 */
import { authCall, dbCall, authErrorMessage, AUTH_TIMEOUT_MS, DB_TIMEOUT_MS } from '../src/lib/cloudClient.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};

// 未处理拒绝收集器：App 有 ErrorBoundary 监听 unhandledrejection，
// 任何一个漏网的拒绝都会把整页打成错误页（阶段六为这个付出过代价）。
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));

const never = () => new Promise(() => {});            // 永不落定 = 挂起的网络
const onlyThen = (v) => ({ then: (r) => r(v) });       // 只有 then 的 thenable

console.log('— 常量 —');
ok(AUTH_TIMEOUT_MS >= 5000 && AUTH_TIMEOUT_MS <= 30000, `AUTH_TIMEOUT_MS 在合理区间（${AUTH_TIMEOUT_MS}ms）`);
ok(DB_TIMEOUT_MS >= 5000 && DB_TIMEOUT_MS <= 30000, `DB_TIMEOUT_MS 在合理区间（${DB_TIMEOUT_MS}ms）`);

console.log('\n— 正常路径必须原样透传 —');
{
  const r = await authCall(() => Promise.resolve({ data: { token: 't' }, error: null }));
  ok(r && r.data && r.data.token === 't' && r.error === null, '成功结果原样返回，不被改写');
}

console.log('\n— 挂起必须有出口（核心）—');
{
  const t0 = Date.now();
  const r = await authCall(never, 80);
  const dt = Date.now() - t0;
  ok(r && r.data === null, '挂起后返回 data:null');
  ok(r && r.error && r.error.kind === 'timeout', 'error.kind 归一成 timeout', JSON.stringify(r));
  ok(dt >= 75 && dt < 2000, `确实等到了上限才放弃（${dt}ms）`);
}

console.log('\n— 各种异常都不能冒出去 —');
{
  const r1 = await authCall(() => { throw new Error('boom'); }, 80);
  ok(r1 && r1.error && r1.error.kind === 'timeout', 'fn 同步抛错 → 收成 error，不抛出');

  const r2 = await authCall(() => Promise.reject(new Error('failed to fetch')), 80);
  ok(r2 && r2.error && r2.error.kind === 'timeout', '请求 reject → 收成 error，不抛出');

  const r3 = await authCall(() => onlyThen({ data: 'x', error: null }), 80);
  ok(r3 && r3.data === 'x', '只有 then 的 thenable 也能被包住（SDK 的 builder 就是这德性）');

  const r4 = await authCall(() => onlyThen({ data: null, error: { kind: 'network' } }), 80);
  ok(r4 && r4.error && r4.error.kind === 'network', 'thenable 返回的 error 原样透传，不被误判成超时');
}

console.log('\n— 人话文案 —');
ok(authErrorMessage({ kind: 'timeout' }) === '服务器没响应，等一会儿再试', 'timeout → 别让用户去改网络设置');
ok(authErrorMessage({ kind: 'network' }) === '连不上服务器，检查一下网络', 'network → 老样子');
ok(authErrorMessage({ kind: 'unauthenticated' }) === '账号或密码不对', '密码错 → 说账号密码不对');
ok(authErrorMessage(null) === '出了点问题，再试一次', 'null 也要有一句话，不能崩');
ok(!/timeout|auth-timeout|undefined|Failed to fetch/i.test(authErrorMessage({ kind: 'timeout' })),
  '给用户的文案里不能出现内部串');

console.log('\n— dbCall：database 那一层同样要有出口 —');
{
  const r = await dbCall(() => Promise.resolve({ data: [{ id: 1 }], error: null }), 80);
  ok(Array.isArray(r && r.data) && r.data[0].id === 1, '正常结果原样返回，不被改写');

  const t0 = Date.now();
  const h = await dbCall(never, 80);
  const dt = Date.now() - t0;
  ok(h && h.data === null && h.error && h.error.kind === 'timeout',
    '挂起后归一成 data:null + kind:timeout', JSON.stringify(h));
  ok(dt >= 75 && dt < 2000, `确实等到了上限才放弃（${dt}ms）`);

  // 端到端：cloudSync 拿到 error 就 throw → UI 收进 authErrorMessage，必须还是人话
  ok(authErrorMessage(h.error) === '服务器没响应，等一会儿再试',
    'dbCall 的超时落到同一句人话上（cloudSync 的 if(error) throw error 不用改）');

  const r2 = await dbCall(() => onlyThen({ data: 'y', error: null }), 80);
  ok(r2 && r2.data === 'y', 'builder 那种「只有 then」的返回值也能包住');

  const r3 = await dbCall(() => onlyThen({ data: null, error: { kind: 'network' } }), 80);
  ok(r3 && r3.error && r3.error.kind === 'network', 'builder 自带的 error 不被误判成超时');
}

console.log('\n— 超时要把没人等的请求掐掉 —');
{
  let seen = null;
  await dbCall((sig) => { seen = sig; return { then: () => {} }; }, 60);
  ok(seen instanceof AbortSignal, 'dbCall 会把 AbortSignal 交给调用方（给 .abortSignal() 挂）');
  ok(seen && seen.aborted === true, '超时后 signal 被 abort，后台不再占着连接');

  let seen2 = null;
  await dbCall((sig) => { seen2 = sig; return Promise.resolve({ data: 1, error: null }); }, 60);
  ok(seen2 && seen2.aborted === false, '正常返回时不该 abort');
}

console.log('\n— 自检：不套 authCall 的话，挂起真的没有出口 —');
{
  // 证明上面那些断言是有区分力的：如果不信，把这层兜底拿掉，下面这条就会失败。
  let settled = false;
  never().then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 200));
  ok(settled === false, '裸的挂起 promise 200ms 后仍未落定（= 兜底确实在起作用）');

  let settled2 = false;
  authCall(never, 60).then(() => { settled2 = true; });
  await new Promise((r) => setTimeout(r, 200));
  ok(settled2 === true, '套了 authCall 的同一个挂起 promise 会落定');
}

await new Promise((r) => setTimeout(r, 100));
console.log('\n— 未处理拒绝 —');
ok(unhandled.length === 0, '全程没有漏网的 unhandled rejection（否则整页变错误页）', unhandled.join(' | '));

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);

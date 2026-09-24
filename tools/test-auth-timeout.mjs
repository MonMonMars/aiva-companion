/**
 * authCall / authErrorMessage 的行为契约。
 *
 * 为什么要有这个测试（别当样板代码删掉）：
 *   SDK 的 AuthModule 里 auth 请求是**裸 fetch** —— 没有 abortSignal，也没有
 *   任何超时（lib/index.js 里的 AbortSignal / timeout 全在 database 和 storage）。
 *   所以网络「挂起」而不是「快速失败」时 await 永不落定：
 *     · useAccount 的 loading 一直是 true → 账号页停在「正在读取账号…」
 *     · AccountView 的 setBusy(true) → 登录按钮被转圈永久替换，且没有取消入口
 *   authCall 就是那个兜底。这里锁住的是「挂起也必须有出口」。
 *
 * 用法：node --import ./tools/ext-resolve.mjs tools/test-auth-timeout.mjs
 */
import { authCall, authErrorMessage, AUTH_TIMEOUT_MS } from '../src/lib/cloudClient.js';

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

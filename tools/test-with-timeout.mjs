/**
 * src/lib/withTimeout.js 的回归测试。
 *
 * 为什么值得单独测 —— 它踩过一次「改一个等待时间，把整个 App 打成错误页」
 * 的事故，而事故的两个成因都**不会在改动它的地方报错**：
 *
 *   1. 传进来的不是真 Promise。cloud.database...select() 返回
 *      PostgrestBuilder，只有 then，没有 catch/finally。对它调 .catch
 *      是同步抛 TypeError —— 于是 race 没建立，但 timer 已经排上了。
 *   2. 那个「超时用的 guard promise」从此没人接，到点变成 unhandled
 *      rejection；而 src/ErrorBoundary.js:31 监听了 window 的
 *      unhandledrejection —— 整页被错误页接管。
 *
 * 所以这里不只测「会不会超时」，还测两件更要命的事：
 *   - 传一个**只有 then 的 thenable** 进去，不许同步抛错；
 *   - 全程不许产生任何 unhandled rejection。
 *
 * 最后有一节「自检」：把当初那个错误写法原样跑一遍，确认它**确实会被本测试
 * 抓出来**。没有自检的话，一条永远绿的测试等于没有测试。
 *
 * 用法： node tools/test-with-timeout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 .js 源码临时复制成 .mjs 再 import —— 项目没有 type:module，直接 import 会失败 */
async function loadSrc(relPath) {
  const src = path.join(root, ...relPath.split('/'));
  const tmp = path.join(root, 'tools', `.tmp-${path.basename(relPath, '.js')}-${process.pid}.mjs`);
  fs.copyFileSync(src, tmp);
  try {
    return await import('file://' + tmp.replace(/\\/g, '/'));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

// ── 未处理拒绝的收集器 ────────────────────────────────────────────────────
// Node 默认会把 unhandled rejection 直接变成进程崩溃；这里挂个 handler 接管，
// 目的是把它**记录下来**当作断言对象，而不是让它悄悄把测试进程干掉。
let unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const { withTimeout } = await loadSrc('src/lib/withTimeout.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, detail ? '→ ' + detail : ''); }
}

/** 只实现 then 的 thenable —— 精确复刻 PostgrestBuilder 的接口缺失 */
function makeThenableOnly(behavior) {
  return {
    then(onFulfilled, onRejected) {
      if (behavior === 'resolve') onFulfilled({ data: [{ key: 'a', value: 1 }], error: null });
      else if (behavior === 'reject') onRejected(new Error('late-network-error'));
      // 'hang'：什么都不调，永远不 settle
      return this;
    },
    // ⚠️ 故意不提供 catch / finally —— 和 SDK 里的 PostgrestBuilder 一样
  };
}

console.log('withTimeout 回归测试');
console.log('─'.repeat(60));

// 1) 正常路径：快速 resolve，原样透传
{
  const v = await withTimeout(Promise.resolve({ data: 'ok' }), 200);
  ok('快速 resolve 时原样返回值', v && v.data === 'ok', JSON.stringify(v));
}

// 2) 超时路径：hang 住的真 Promise，到点必须拒绝
{
  unhandled = [];
  const t = Date.now();
  let msg = null;
  try {
    await withTimeout(new Promise(() => {}), 150, 'settings-timeout');
  } catch (e) { msg = e.message; }
  const dt = Date.now() - t;
  ok('hang 住的调用会超时拒绝', msg === 'settings-timeout', String(msg));
  ok('超时发生在上限附近（不是立刻、也没拖过头）', dt >= 140 && dt < 900, dt + 'ms');
  await sleep(400);
  ok('超时后没有 unhandled rejection', unhandled.length === 0, JSON.stringify(unhandled));
}

// 3) ★ 核心回归：只有 then 的 thenable（PostgrestBuilder 的形状）
{
  unhandled = [];
  let threw = null;
  let msg = null;
  try {
    await withTimeout(makeThenableOnly('hang'), 150, 'settings-timeout');
  } catch (e) {
    msg = e.message;
    if (!(e.message === 'settings-timeout')) threw = e;
  }
  ok('thenable 不会导致同步抛错（.catch 缺失）', threw === null, threw && threw.message);
  ok('thenable 也能正常超时', msg === 'settings-timeout', String(msg));
  await sleep(400);
  ok('thenable 路径没有 unhandled rejection', unhandled.length === 0, JSON.stringify(unhandled));
}

// 4) 原调用在超时之后才失败 → 迟到的拒绝必须被吞掉
{
  unhandled = [];
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 400));
  let msg = null;
  try { await withTimeout(late, 100, 'settings-timeout'); } catch (e) { msg = e.message; }
  ok('迟到失败不影响结果', msg === 'settings-timeout', String(msg));
  await sleep(700); // 等那个 400ms 的迟到拒绝真的发生
  ok('迟到的失败被吞掉（无 unhandled）', unhandled.length === 0, JSON.stringify(unhandled));
}

// 5) 定时器必须被清掉：快路径之后进程不应该被一个悬着的 timer 拖住
{
  const t = Date.now();
  await withTimeout(Promise.resolve(1), 50);
  await sleep(120);
  ok('快路径不会拖出额外等待', Date.now() - t < 400, Date.now() - t + 'ms');
}

// ── 自检：当初那个错误写法，必须被上面第 3 条抓出来 ──────────────────────
// 如果这一节变成「没抓到」，说明测试用例本身失效了，得回头改测试而不是改产品代码。
console.log('─'.repeat(60));
console.log('自检：错误写法应当被抓出来');
{
  function buggyWithTimeout(promise, ms, message) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    promise.catch(() => {}); // ← 事故成因：thenable 没有这个方法
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  let syncThrew = false;
  try {
    buggyWithTimeout(makeThenableOnly('hang'), 120, 'settings-timeout');
  } catch (e) {
    syncThrew = true; // TypeError: promise.catch is not a function
  }
  ok('错误写法在 thenable 上会同步抛错（所以第 3 条不是空转）', syncThrew);
}

console.log('─'.repeat(60));
console.log(fail === 0 ? `全部通过（${pass} 项）` : `${fail} 项失败 / 共 ${pass + fail} 项`);
process.exit(fail === 0 ? 0 : 1);

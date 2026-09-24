// 全局数值开关 —— 管理后台改的就是这些，客户端只读
// ---------------------------------------------------------------------------
// ⚠️ 为什么这个是「公开可读」：维护模式、注册开关这些必须在**没登录**的时候就能读到，
//    否则一个没登录的用户根本看不到维护公告。所以数据库那边给的是
//    SELECT TO authenticated, anon，写才限定 admin。
//
// ⚠️ DEFAULTS 不是「偷懒的本地兜底」，而是有意为之：它等于改造前代码里写死的那几个常量。
//    断网 / 云不可用的时候行为要和以前一模一样，不能因为加了云就变得玩不了。
//    但**数据持久化**不在这里兜底 —— 该同步的还是走 user_state，同步不了会明确报错。
import { cloud } from './cloudClient';
import { withTimeout } from './withTimeout';

const DEFAULTS = {
  decay_affection_per_hour: 0.6,
  decay_mood_per_hour: 1.4,
  decay_energy_per_hour: 7,
  checkin_coins: 25,
  checkin_mood: 8,
  checkin_affection: 6,
  initial_coins: 30,
  registration_open: true,
  maintenance_mode: false,
};

let map = { ...DEFAULTS };
let task = null;
// 上一次拉取是不是超时/失败了。给自检和排查用 —— 后台改了值客户端没吃到时，
// 先看这个就能分清是「网络拿不到」还是「缓存没刷新」。
let degraded = false;

/**
 * 拉开关的等待上限。
 *
 * ⚠️ 这个上限是实测逼出来的，别删。线上（GitHub Pages 域名）访问云服务会被
 *    CORS 拦掉，SDK 内部会重试，实测整次调用拖到 **约 8 秒**；而 App.js 是
 *    `await loadSettings()` 之后才 `setReady(true)` 的 —— 于是每次冷启动都要
 *    在标题页干等 10 秒（App 本身 0.6 秒就起来了）。
 *
 *    DEFAULTS 本来就是为「拿不到」准备的（见文件头），拿不到就别等。
 *    2 秒对正常网络绰绰有余（实测一次成功请求 ~0.1–0.6 秒），
 *    对断网也只是多等 2 秒而已。
 */
const SETTINGS_TIMEOUT_MS = 2000;

/** ⚠️ 超时的具体实现在 ./withTimeout.js，别在本文件里另写一份。
 *  第一版就是在这儿手写的，结果把整个 App 打成了错误页 —— 完整经过和
 *  两条硬约束都记在那个文件头，改动前务必先读一遍。 */

/** 这次的默认值是不是因为拿不到云才用的 */
export function settingsDegraded() {
  return degraded;
}

/**
 * 拉一次开关。幂等：同时被十个地方调用也只会发一个请求。
 * App 启动时会 await 它一次；之后任何时候再调都是拿缓存。
 */
export function loadSettings() {
  if (task) return task;
  task = (async () => {
    // ★ 这里特意关掉 SDK 自带的重试，并在超时时 abort：
    //
    //   SDK 默认 `retryEnabled = true`，网络/CORS 失败时会退避重试 3~4 次
    //   （实测整次调用被拖到约 8 秒，而单次失败其实 0.3 秒就返回了）。
    //   这是一个**启动路径上的只读调用**，拿不到就用 DEFAULTS（见文件头），
    //   重试既救不回结果、又让用户白等 —— 关掉它。
    //
    //   abort 是给「请求卡住既不成功也不失败」那种情况兜底：我们已经不等了，
    //   就别让它在后台继续占着连接。
    const ac = new AbortController();
    try {
      const { data, error } = await withTimeout(
        cloud.database.from('app_settings').select('key, value')
          .retry(false)
          .abortSignal(ac.signal),
        SETTINGS_TIMEOUT_MS,
        'settings-timeout',
        () => ac.abort()
      );
      // ⚠️ 注意：SDK 在默认（非 throwOnError）模式下，网络失败是 **resolve 成
      //    { data: null, error }** 而不是 reject —— 所以「拿到 error」也必须
      //    记成 degraded，只在 catch 里置位是漏的。
      if (error) {
        degraded = true;
      } else if (Array.isArray(data)) {
        for (const row of data) map[String(row.key)] = row.value;
        degraded = false;
      }
    } catch (e) {
      // 拉不到就用默认值继续，不打断点评；CloudSettings 的影响面只是几个数值
      degraded = true;
    }
    return map;
  })();
  return task;
}

export function num(key) {
  const v = Number(map[key]);
  if (Number.isFinite(v)) return v;
  const d = Number(DEFAULTS[key]);
  return Number.isFinite(d) ? d : 0;
}

export function bool(key) {
  const v = map[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true';
  return Boolean(DEFAULTS[key]);
}

/**
 * 重新拉一次开关。维护模式下「重试」按钮用它。
 * 为什么不能只调 loadSettings()：它带幂等缓存，第二次调用会直接返回第一次的结果，
 * 后台刚改完的值永远读不到 —— 所以这里先把 task 清掉。
 */
export async function refreshSettings() {
  task = null;
  return loadSettings();
}

/** 给调试/自检用：后台改完之后，客户端有没有真的吃到新值，看这个最直观 */
export function settingsSnapshot() {
  return { ...map };
}

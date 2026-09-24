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

/**
 * 拉一次开关。幂等：同时被十个地方调用也只会发一个请求。
 * App 启动时会 await 它一次；之后任何时候再调都是拿缓存。
 */
export function loadSettings() {
  if (task) return task;
  task = (async () => {
    try {
      const { data, error } = await cloud.database.from('app_settings').select('key, value');
      if (!error && Array.isArray(data)) {
        for (const row of data) map[String(row.key)] = row.value;
      }
    } catch (e) {
      // 拉不到就用默认值继续，不打断点评；CloudSettings 的影响面只是几个数值
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

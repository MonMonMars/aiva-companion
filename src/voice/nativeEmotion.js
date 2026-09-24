// 系统嗓音的「情绪 → 音高/语速/音量」换算（纯函数，无任何依赖）
// ---------------------------------------------------------------------------
// 单独拆一个文件是为了能直接被 tools/nativeSpeech.test.mjs 真实调用。
// nativeSpeech.js 因为 import 了 expo-speech（原生模块），在纯 node 下没法加载，
// 而这段换算恰恰是最容易写坏、又听不出来的部分 —— 必须能测。
//
// ★ 两端的量纲已经查过 Expo 源码（详见 nativeSpeech.js 顶部注释）：
//     iOS     utterance.rate = rate * AVSpeechUtteranceDefaultSpeechRate
//     Android textToSpeech.setSpeechRate(rate)
//   iOS 的 AVSpeechUtterance 原始区间是 0~1、默认 0.5，乘上去之后刚好是 1.0 = 正常；
//   Android 本身就是 1.0 = 正常。**所以两端统一用 1.0 做基准，不需要分平台。**
//   pitch 同理（iOS pitchMultiplier / Android setPitch），1.0 为正常，
//   但 iOS 有效区间只有 0.5~2.0，越界会被系统钳到端点，这里必须自己先夹。

export const PITCH_RANGE = [0.5, 2.0]; // iOS AVSpeechUtterance 合法区间
export const RATE_RANGE = [0.1, 2.0];  // 保守区间：2.0 已接近 iOS 上限
export const VOLUME_RANGE = [0.0, 1.0];

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// 情绪档。取值刻意偏保守：系统引擎没有真正的表达力，
// 幅度稍大就会像卡通声 / 语速飙成机关枪。
export const NATIVE_EMOTION = {
  laughs: { pitch: 1.15, rate: 1.05 },
  giggles: { pitch: 1.25, rate: 1.08 },
  sighs: { pitch: 0.85, rate: 0.85 },
  excited: { pitch: 1.2, rate: 1.15 },
  comfort: { pitch: 0.92, rate: 0.9 },
  gentle: { pitch: 0.95, rate: 0.92 },
  sad: { pitch: 0.85, rate: 0.85 },
  shy: { pitch: 1.05, rate: 0.88 },
  whispers: { pitch: 0.9, rate: 0.85, volume: 0.55 },
  surprised: { pitch: 1.25, rate: 1.1 },
  curious: { pitch: 1.1, rate: 1.0 },
  serious: { pitch: 0.95, rate: 0.97 },
  sing: { pitch: 1.15, rate: 0.95 },
  teach: { pitch: 1.0, rate: 0.9 },
  proud: { pitch: 1.08, rate: 1.0 },
  sleepy: { pitch: 0.9, rate: 0.75 },
};

/**
 * 算出这次朗读的 pitch / rate / volume。
 *
 * 用户设定的全局语速（speed）与情绪档（rate）**相乘**而不是覆盖 ——
 * 这两个是独立维度：用户要"整体快一点"，同时喜怒哀乐之间也还要有快慢差别。
 *
 * @param {object} o
 * @param {string|null} [o.emotion] 情绪标签，认不出来就当中性
 * @param {number} [o.speed] 用户语速，1.0 为正常
 */
export function nativeSpeechParams({ emotion, speed } = {}) {
  const e = NATIVE_EMOTION[emotion] || {};
  const s = typeof speed === 'number' && Number.isFinite(speed) ? speed : 1;
  return {
    pitch: clamp(e.pitch ?? 1.0, PITCH_RANGE[0], PITCH_RANGE[1]),
    rate: clamp(s * (e.rate ?? 1.0), RATE_RANGE[0], RATE_RANGE[1]),
    volume: clamp(e.volume ?? 1.0, VOLUME_RANGE[0], VOLUME_RANGE[1]),
  };
}

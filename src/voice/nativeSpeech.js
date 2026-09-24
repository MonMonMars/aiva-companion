// 系统嗓音 TTS —— iOS / Android 原生端**免 Key**出声
// ---------------------------------------------------------------------------
// 为什么需要它
//   云端 TTS（OpenAI / Azure / ElevenLabs）全都要 API Key。以往原生 App 缺 Key 时
//   只能出字幕、完全没声音 —— 用户会觉得"这个 App 是哑的"。
//   但每台手机自己就带着能离线朗读的语音引擎：
//     · iOS     → AVSpeechSynthesizer（粤语 zh-HK 是系统自带嗓音）
//     · Android → TextToSpeech（Google TTS 含粤语）
//   expo-speech 把两者统一成一个 API，不用写原生代码、不用 Key、不用联网。
//
// ★★ 量纲已核对源码（决定音质，写错就是机关枪语速）★★
//   iOS     SpeechModule.swift: utterance.rate = rate * AVSpeechUtteranceDefaultSpeechRate
//   Android SpeechModule.kt:    textToSpeech.setSpeechRate(rate)
//   → 两端统一：**rate 1.0 = 正常语速**，可以直接用一个值，不必分平台。
//   pitch 同理（iOS pitchMultiplier / Android setPitch），**1.0 = 正常**，
//   但 iOS 的有效区间是 0.5~2.0，越界会被系统 clamp 到端点，所以这里先自己夹一次。
//
// ★★ 嗓音挑选的坑（iOS 会真的报错，不是降级）★★
//   显式传 `voice`（identifier）时，iOS 源码里是
//     utterance.voice = AVSpeechSynthesisVoice(identifier: voice)
//     guard utterance.voice != nil else { throw InvalidVoiceException }
//   → **传了设备上不存在的 identifier 会直接抛异常**。
//   所以必须先用 getAvailableVoicesAsync() 枚举设备真实嗓音，挑中了才传；
//   挑不中就干脆不传 voice，只传 language（这条路径 iOS/Android 都只是
//   退回默认嗓音，不会失败）。
//   也因此**不能**在这里写死一串"常见粤语嗓音 ID"当下拉选项 —— 那是设备相关的。

import * as Speech from 'expo-speech';

// ---------------------------------------------------------------------------
// 情绪 → 音高/语速/音量
// ---------------------------------------------------------------------------
// 系统引擎没有 Azure 那种表达风格、也没有 ElevenLabs 的稳定性参数，
// 唯一能调的就是 pitch / rate / volume。把情绪映射过去，让"笑着说完这句"这种
// 层次不至于完全消失 —— 做不到那么细腻，但至少不是全程一个调。
// 取值刻意保守：pitch 0.85~1.25（iOS 合法 0.5~2.0），rate 0.75~1.15。
// 情绪 → pitch / rate / volume 的换算搬去了 ./nativeEmotion.js：
// 那边是纯函数、零依赖，回归测试可以直接 import 进来真跑一遍。
// 这里 re-export 是为了让调用方继续能从本文件取到这两个东西，不用改引用。
// 注意这里同时写了 import 和 export-from 两条：
// 只用 export-from 的话只是"转发"，名字不会进本模块作用域，
// 下面 speakNative() 里调用 nativeSpeechParams 就会 ReferenceError。
import { nativeSpeechParams } from './nativeEmotion';
export { NATIVE_EMOTION, nativeSpeechParams } from './nativeEmotion';

// ---------------------------------------------------------------------------
// 设备嗓音枚举与挑选
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/_/g, '-');

// locale → 设备上报的语言码候选。粤语有两种叫法：BCP47 的 zh-HK 和 ISO639-3 的 yue，
// 各家 ROM / iOS 版本报哪个不一定，两边都得认。
const LANG_ALIASES = {
  'zh-hk': ['zh-hk', 'yue'],
  yue: ['zh-hk', 'yue'],
  'zh-cn': ['zh-cn', 'cmn', 'zh'],
  zh: ['zh-cn', 'zh'],
  'en-us': ['en-us', 'en'],
  en: ['en-us', 'en'],
};

let voicesCache = null;

/** 列出设备已安装的嗓音。结果缓存（一个 App 会话内嗓音不会变）。 */
export function listNativeVoices(force) {
  if (voicesCache && !force) return voicesCache;
  voicesCache = Speech.getAvailableVoicesAsync().catch(() => []);
  return voicesCache;
}

/**
 * 按 locale 挑一个设备上真实存在的嗓音 identifier。
 * @returns {Promise<string|null>} 挑不到返回 null —— 调用方应当因此**不传** voice
 */
export async function pickNativeVoice(locale) {
  const voices = await listNativeVoices().catch(() => []);
  if (!voices?.length) return null;

  const want = norm(locale);
  const aliases = LANG_ALIASES[want] || [want];

  // 1) 精确匹配：zh-HK → 先用 zh-HK，没有再试 yue
  for (const a of aliases) {
    const hit = voices.find((v) => norm(v.language) === a);
    if (hit?.identifier) return hit.identifier;
  }
  // 2) 退一步：同一语言的其它地区变体（zh-HK 没有就用任意 zh-*）
  //    注意这里退回的是"普通话"而非粤语，听感会有差异，但总比完全没声音好。
  const base = norm(aliases[aliases.length - 1]).split('-')[0];
  const loose = voices.find((v) => norm(v.language).startsWith(`${base}-`));
  return loose?.identifier || null;
}

// ---------------------------------------------------------------------------
// 朗读
// ---------------------------------------------------------------------------
/**
 * 用系统嗓音念一段话。
 *
 * 刻意**只在内部 resolve、从不 reject**：这是TTS，说不出来就已经够糟了，
 * 再往外抛异常只会让上层队列断掉、状态机卡住。失败 = 这句跳过（已经显示了字幕）。
 *
 * @param {string} text
 * @param {object} [o]
 * @param {string} [o.locale]  BCP47，如 'zh-HK'
 * @param {string|null} [o.emotion] 情绪标签
 * @param {number} [o.speed] 用户语速，1.0 为正常
 * @param {string} [o.voice] 指定嗓音 identifier；空则按 locale 自动挑
 * @param {() => void} [o.onStart] 声音真的出来的那一刻（驱动 3D 口型用）
 * @returns {Promise<void>}
 */
export async function speakNative(text, o = {}) {
  const { locale, emotion, speed, onStart } = o;
  const { pitch, rate, volume } = nativeSpeechParams({ emotion, speed });

  // 没指定嗓音就去设备里挑（结果有缓存，每句调一次不贵）
  let voice = o.voice;
  if (!voice) voice = await pickNativeVoice(locale).catch(() => null);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    // ★ 超时兜底不是可有可无的保险：
    // onDone/onStopped/onError 三个回调万一一个都不来（某些 ROM 的合成器会这样），
    // 这个 Promise 就永远不结算，整个会话会钉死在 speaking 状态 —— 用户再也叫不动。
    // 这里是按字数粗估（中文约 5 字/秒）再给冗余，宁可早放行也不要卡死。
    const chars = String(text || '').length;
    const estMs = Math.max(6000, (chars / 5 / Math.max(rate, 0.1)) * 1000 + 4000);
    timer = setTimeout(finish, estMs);

    try {
      Speech.speak(text, {
        language: locale || 'zh-CN',
        ...(voice ? { voice } : {}), // 没有就别传，传错 iOS 会抛
        pitch,
        rate,
        volume,
        onStart: () => { try { onStart?.(); } catch (_) {} },
        onDone: finish,
        onStopped: finish,
        onError: () => finish(),
      });
    } catch (_) {
      // 同步抛出（比如传给 ExpoSpeech 非法参数）：直接放行，不要卡住队列
      finish();
    }
  });
}

/** 立刻闭嘴（用户插话、点停止、页面销毁都要走这里） */
export function stopNative() {
  try {
    return Promise.resolve(Speech.stop()).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

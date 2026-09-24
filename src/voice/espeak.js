// eSpeak NG（粤语 zhy）浏览器端 WASM 封装 —— 真正离线、免 Key 的兜底 TTS
// ---------------------------------------------------------------------------
// 为什么需要它
//   云端 TTS（OpenAI / Azure / ElevenLabs）全要 API Key；浏览器自带 SpeechSynthesis
//   在部分设备/浏览器上根本没有粤语声音（尤其 iOS 内嵌 WebView 会拿普通话声音糊弄）。
//   eSpeak NG 是共振峰合成，体积 ~3MB 的 WASM，把粤语（zhy 嗓音）直接跑在浏览器里，
//   不依赖任何网络、不依赖任何 Key，是「没网也能开口」的最后一道保险。
//
// ⚠️ 关键限制：Web Worker 不能跨域加载（浏览器同源策略）。所以下面三个文件
//   espeakng-simple.js（或 espeakng.min.js）/ espeakng.worker.js / espeakng.worker.data
//   必须和 App **同源**。拿到它们后放进 Expo Web 的 `public/espeakng/` 目录即可
//   （构建后静态托管在 `/espeakng/`）。下载来源：
//     · steveseguin/espeakng.js 仓库（提供 SimpleTTS 包装器，暴露 window.SimpleTTS）
//     · 或 jsDelivr espeakng.js/latest（提供原始 eSpeakNG，暴露 window.eSpeakNG）
//   两个全局都兼容，下面的加载器会自动挑一个能用的。
//
// 还缺资源 / 加载失败怎么办
//   任何一步出错都抛异常，调用方（WebVoiceSession._speakEspeak）会回落到浏览器
//   SpeechSynthesis，保证用户永远不至于「完全没声音」。

const ESPEAK_BASE = '/espeakng/';

// locale → eSpeak 语音码。
// 关键坑：eSpeak-ng 里粤语的「嗓音名」是 'zhy'（不是 BCP47 的 yue），普通话是 'zh'。
// 用错码（比如写成 yue）引擎拿不到粤语嗓音，会静默回落到默认英文嗓音，听感全错。
export const VOICE_FOR = {
  'zh-hk': 'zhy',
  yue: 'zhy',
  'zh-cn': 'zh',
  zh: 'zh',
  'en-us': 'en',
  en: 'en',
};

let readyPromise = null;

function loadScriptOnce(src) {
  if (typeof window === 'undefined' || !window.document) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (window.document.querySelector(`script[src="${src}"]`)) {
      resolve(true);
      return;
    }
    const s = window.document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    window.document.head.appendChild(s);
  });
}

function waitCb(cb) {
  return new Promise((resolve) => cb(resolve));
}

/**
 * 懒加载并初始化 eSpeak。返回 { type, t }，type 为 'simple'（SimpleTTS）或 'raw'（eSpeakNG）。
 * 结果会被缓存，重复调用只初始化一次。
 */
async function ensureEspeak() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (typeof window === 'undefined' || !window.document) {
      throw new Error('eSpeak 仅支持浏览器环境');
    }
    const base = ESPEAK_BASE;
    const workerPath = base + 'espeakng.worker.js';

    // 先试 SimpleTTS 包装器，再试原始 eSpeakNG
    if (!window.SimpleTTS) await loadScriptOnce(base + 'espeakng-simple.js');
    if (!window.SimpleTTS && !window.eSpeakNG) await loadScriptOnce(base + 'espeakng.min.js');

    if (window.SimpleTTS) {
      const t = new window.SimpleTTS({ workerPath, defaultVoice: 'zhy' });
      await waitCb((done) => t.onReady(() => done()));
      return { type: 'simple', t };
    }
    if (window.eSpeakNG) {
      let api = null;
      const t = new window.eSpeakNG(workerPath, () => { api = t; });
      // 原始 eSpeakNG 的 ready 回调在构造第二个参数里给
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('eSpeak 初始化超时')), 15000);
        const started = Date.now();
        const iv = setInterval(() => {
          if (api) { clearTimeout(to); clearInterval(iv); resolve(); }
          else if (Date.now() - started > 15000) { clearTimeout(to); clearInterval(iv); reject(new Error('eSpeak 初始化超时')); }
        }, 100);
      });
      return { type: 'raw', t };
    }
    throw new Error(
      'espeakng 未加载：请确认 public/espeakng/ 下 espeakng-simple.js（或 espeakng.min.js）'
      + ' 与 espeakng.worker.js / espeakng.worker.data 齐全'
    );
  })();
  return readyPromise;
}

/** Float32 单声道 PCM → WAV（给原始 eSpeakNG 路径播放用） */
function floatToWav(samples, sampleRate) {
  const numFrames = samples.length;
  const buffer = new ArrayBuffer(44 + numFrames * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numFrames * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numFrames * 2, true);
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 合成并播放一句。解析时机：音频播放结束（或超时兜底）。
 * @param {string} text
 * @param {{lang?:string, speed?:number}} opts
 * @returns {Promise<void>}
 */
export async function speakEspeak(text, { lang = 'zh-HK', speed = 1 } = {}) {
  const be = await ensureEspeak();
  const voice = VOICE_FOR[String(lang).toLowerCase().replace(/_/g, '-')] || 'zhy';
  const rate = clamp(Math.round(175 * (speed || 1)), 80, 450);

  return new Promise((resolve, reject) => {
    let done = false;
    const fin = (err) => { if (done) return; done = true; err ? reject(err) : resolve(); };

    try {
      if (be.type === 'simple') {
        be.t.speak(text, { voice, rate, pitch: 50, volume: 1.0 }, (audioData, sampleRate) => {
          try {
            if (!audioData) { fin(new Error('eSpeak 没有返回音频')); return; }
            const pb = window.SimpleTTS.playAudioData(audioData, sampleRate);
            if (!pb) { fin(new Error('eSpeak 播放初始化失败')); return; }
            const secs = audioData.length / (sampleRate || 11025) + 0.3;
            let ended = false;
            const done = () => { if (!ended) { ended = true; fin(); } };
            if (pb.source) pb.source.onended = done;   // 优先用真实播放结束事件
            setTimeout(done, secs * 1000);              // 兜底，防止 onended 不触发
          } catch (e) {
            fin(e);
          }
        });
        setTimeout(() => fin(new Error('eSpeak 播放超时')), 20000);
        return;
      }

      // 原始 eSpeakNG：拿到 PCM 后自己包成 WAV 播放
      be.t.set_voice(voice);
      be.t.set_rate(rate);
      be.t.synthesize(text, (samples) => {
        try {
          const wav = floatToWav(samples, 11025);
          const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
          const a = new Audio(url);
          a.onended = () => { URL.revokeObjectURL(url); fin(); };
          a.onerror = () => { URL.revokeObjectURL(url); fin(new Error('eSpeak 播放失败')); };
          a.play().catch(fin);
        } catch (e) {
          fin(e);
        }
      });
      setTimeout(() => fin(new Error('eSpeak 合成超时')), 20000);
    } catch (e) {
      fin(e);
    }
  });
}

// 一键装 Key：把 URL 片段里的 Key 写进本机存档，然后立刻把片段擦掉
// ---------------------------------------------------------------------------
// 为什么要有这个
//   Key 长这样：sk-xxxxxxxxxxxxxxxxxxxxxxxx。让用户在 iPhone Safari 里手打一长串
//   大小写混排的字符是纯折磨，打错一个字还只是静默失败（界面只报「缺硅基流动 Key」）。
//   改成「点一条链接就装好」。
//
// 为什么用 URL 片段（#）而不是查询串（?）—— 这条是安全底线，别改
//   · 片段**根本不会发到服务器**。它在浏览器里就被截断了。
//   · 查询串会进 Nginx / CDN 的访问日志、Referer、浏览器历史同步，
//     等于把 Key 明文留在别人的机器和云上。这个项目是公开部署的。
//   · 片段只在本机读出来、写进 localStorage，效果和手动在设置页敲字完全等价。
//
// 用法（可以一次带多个，用 & 连）
//   https://<域名>/#ek=ElevenLabs的Key
//   https://<域名>/#ek=xxx&lk=xxx&tv=xxx
//   装完自动 replaceState 把 # 抹掉，地址栏不残留。
//
// 参数名速查： ek=ElevenLabs(听+说)  ok=OpenAI  gk=Groq  ak/ar=Azure
//              sk=硅基流动(中国实名)  lk=大模型  tv=Tavily搜索
//
// ⚠️ 调用时机：必须在 loadStore() **之后**。存档加载会用硬盘上的旧值整体覆盖内存，
//    先装后加载等于白装。
import { Platform } from 'react-native';
import * as S from '../store';
import { currentCountry, sttUsable } from './region';

// ⚠️ 提醒：加新 Key 时**只改这里是不够的** —— stt.js / providers.js / keyLink.js /
//    useVoice.js / App.js(KEY_LABEL) / webSession.js(_sttReady) 六处都要有。
//    漏掉 WebSession._sttReady 那处最要命：Key 装好了，iPhone 上点麦还是报「没配 Key」。

// 片段参数 → 存档字段。前缀 voice. 表示落在 config.voice 里，config. 落在 config 根上
const MAP = {
  // --- 听觉（STT）---
  gm: 'voice.geminiKey',  // ★ Gemini 3.5 Transcribe（免费额度最大、AI Studio 一键拿）
  ek: 'voice.elevenKey',  // ElevenLabs Scribe（粤语 STT，同时也能当嗓子）
  sk: 'voice.siliconKey', // 硅基流动 SenseVoice（中国居民专用，需实名）
  gk: 'voice.groqKey',    // Groq Whisper（免费额度大、快）
  ak: 'voice.azureKey',   // Azure Speech Key（听说共用）
  ar: 'voice.azureRegion',// Azure 区域，例如 eastasia
  // --- 嗓子（TTS）---
  ok: 'voice.openaiKey',  // OpenAI（TTS + Whisper STT）
  // --- 大脑 / 联网 ---
  lk: 'config.apiKey',    // 大模型（DeepSeek / OpenAI 兼容接口）
  tv: 'voice.tavilyKey',  // Tavily 联网搜索
};

// 装了某家的 Key 就把「听」拨到那家，免得装完还停在别家、界面照旧报「缺 XX Key」。
// 数组顺序 = 同时装好几把时谁优先：Gemini 免费额度最大排第一，ElevenLabs 其次。
// sk 留着是因为老用户可能还在用硅基流动。
const STT_SWITCH = [
  { params: ['gm'], to: 'gemini' },
  { params: ['ek'], to: 'elevenlabs' },
  { params: ['ak', 'ar'], to: 'azure' }, // 要 Key 和区域同时给才算装好
  { params: ['sk'], to: 'siliconflow' },
  { params: ['gk'], to: 'groq' },
];

/**
 * 读片段里的 Key 并写入存档。
 * @returns {string[]} 实际装上的是哪些参数（['sk']）；没装任何东西返回 []
 */
export function installKeysFromLink() {
  // 原生端没有 location，直接短路。别在这里碰 window，否则真机一启动就炸
  if (Platform.OS !== 'web') return [];

  try {
    const raw = (window.location.hash || '').replace(/^#/, '');
    if (!raw) return [];

    const q = new URLSearchParams(raw);
    const snap = S.getSnapshot();
    const cfg = snap?.config || {};
    const voice = { ...(cfg.voice || {}) };
    const root = {};
    const applied = [];

    for (const [param, path] of Object.entries(MAP)) {
      const val = (q.get(param) || '').trim();
      if (!val) continue;
      if (path.startsWith('voice.')) voice[path.slice(6)] = val;
      else root[path.replace('config.', '')] = val;
      applied.push(param);
    }
    if (!applied.length) return [];

    // 按优先级把 STT 供应商拨过去。
    // 同时装了好几把时，优先挑「在这个国家真的能用」的那家 ——
    // 比如香港用户同时给了 gm 和 ek：Gemini 在香港被 Google 直接拒绝，
    // 选它等于一开口就是死路，这时应该落到 ElevenLabs。
    // 但**只给了一把、而那把在这里用不了**时不做覆盖：那是用户明确的动作，
    // 宁可让他在设置页看到一句"这里用不了"的警告，也不能偷偷改掉他的 Key。
    const cc = currentCountry();
    const usable = STT_SWITCH.filter((r) => r.params.every((p) => applied.includes(p)));
    const hit = usable.find((r) => sttUsable(cc, r.to)) || usable[0];
    if (hit) voice.sttProvider = hit.to;

    S.updateConfig({ ...root, voice });

    // 抹掉片段：replaceState 不新增历史记录，刷新/后退都不会再带出 Key
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search
    );

    console.info('[keyLink] 已从链接装入：' + applied.join(', '));
    return applied;
  } catch (e) {
    // 装 Key 失败绝不能挡住启动
    console.warn('[keyLink] 处理失败', e);
    return [];
  }
}

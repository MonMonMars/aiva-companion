// 语音识别（STT）
// ---------------------------------------------------------------------------
// 关键决定：**不用手机自带的原生识别**（expo-speech-recognition）。
// 原生识别依赖 iOS/Android 的听写引擎，粤语常常不可用，而且各家行为不一致、
// 没法配宁静。所以统一「录音 → 送云端识别」，三种语言行为一致，
// 服务端也能切换。代价是需要联网，好处是识别质量和App 行为可控。

import { Platform } from 'react-native';
import { currentCountry, ccName } from '../lib/region';
import { netFetch } from '../lib/netFetch';

// ⚠️ 凡是对**外部 API** 的请求都要走 netFetch（不是裸 fetch）：挂起时会永不落定，
//    而这里的调用方 webSession.js 在 setState('thinking') 之后才 await transcribe，
//    那些 `onState({ state: 'idle' })` 的出口全在这一步返回之后 —— 没有超时上限，
//    用户松手后就永远停在「等她说」的状态，麦克风也按不动了。
//    注意：下面读本地录音的 `fetch(uri).blob()` **保持原样**，别一起套上来 ——
//    本机读文件在移动端本来就可能慢，给它加上限只会把正常流程掐断。

// Whisper 会把粤语整段洗成书面普通话（"唔知"→"不知道"、"食咗饭未"→"吃饭了吗"），
// 对一个主打粤语的陪伴 App 来说是致命的 —— 听进去的和说出口的不是一个味道。
// Whisper API 支持 prompt 参数做"行文风格提示"，给一段粤语口语样本当范例，
// 它会明显倾向于输出粤字。不是一个 100% 可靠的开关，但实测能救回大部分。
// 用繁体是因为粤语口语书面形式惯例就是繁体，跟 zh-HK 也对得上。
const YUE_PROMPT =
  '以下是一段廣東話對話，請用粵語口語轉寫：我唔知呀，你食咗飯未？今日好熱，我哋去邊度玩？佢話佢唔嚟喇。';

/** Whisper 系列：multipart 表单上传，字段名 file / model */
async function whisperRequest(url, apiKey, uri, model, language, prompt) {
  const form = new FormData();

  // 原生端可以给 FormData 塞「{uri,name,type}」让 RN 自己去读文件；
  // 但浏览器不认这种假 File，必须先 fetch 成真正的 Blob 再 append，否则上传是空文件。
  if (Platform.OS === 'web') {
    const blob = await fetch(uri).then((r) => r.blob());
    form.append('file', blob, 'speech.m4a');
  } else {
    form.append('file', { uri, name: 'speech.m4a', type: 'audio/m4a' });
  }

  form.append('model', model);
  // 传了 language 就别让模型猜，识别率更高；auto 时不传，交给模型判断
  if (language && language !== 'auto') {
    // Whisper 只认 ISO 639-1（zh / en）。粤语它没有独立码，只能用 zh，
    // 这也是"粤语会被写成书面普通话"的根因 —— 见 azure 分支。
    form.append('language', language === 'yue' ? 'zh' : language.replace(/-.*$/, ''));
  }
  // 听粤语时附一段口语范例，把输出从书面普通话往粤字方向拉
  if (prompt) form.append('prompt', prompt);
  form.append('response_format', 'json');

  const res = await netFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    let d = text.slice(0, 160);
    try { d = JSON.parse(text)?.error?.message || d; } catch (_) {}
    throw new Error(`STT ${res.status}：${d}`);
  }
  try {
    return JSON.parse(text)?.text?.trim() || '';
  } catch (_) {
    return '';
  }
}

/** Azure Speech-to-Text：直接 POST 原始音频字节，语言放 query string */
async function azureRequest(region, apiKey, uri, locale) {
  const blob = await (await fetch(uri)).blob();
  const res = await netFetch(
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
      },
      body: blob,
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Azure STT ${res.status}：${text.slice(0, 160)}`);
  try {
    const j = JSON.parse(text);
    // RecognitionStatus 不是 Success 时（比如 NoMatch），要给上层一个明确信号
    if (j.RecognitionStatus && j.RecognitionStatus !== 'Success') {
      return { text: '', status: j.RecognitionStatus };
    }
    return { text: (j.DisplayText || j.NBest?.[0]?.Display || '').trim(), status: 'Success' };
  } catch (_) {
    return { text: '', status: 'ParseError' };
  }
}

/**
 * 硅基流动 SenseVoice：OpenAI 兼容的 /v1/audio/transcriptions。
 * 纯技术口味它确实是粤语最强（FLEURS 上 7.09% CER，好过 Whisper large-v3）。
 * ⚠️ 但 2026 年起这家**强制实名认证**才能调用免费模型，且线上验证只认中国身份证件，
 *    外国护照走不通 —— 非中国居民这条路是死的，不要推荐给用户。
 * 它不支持传 language 参数（自己判定语种），所以这里也不假装传。
 */
async function siliconRequest(apiKey, uri) {
  const blob = await (await fetch(uri)).blob();
  // 官方文档写 .com，国内不少接入示例用 .cn —— 两个都试一遍，别让用户自己猜
  const hosts = ['https://api.siliconflow.cn', 'https://api.siliconflow.com'];
  let last = '';
  for (const h of hosts) {
    const form = new FormData();
    form.append('file', blob, 'speech.m4a');
    form.append('model', 'FunAudioLLM/SenseVoiceSmall');
    try {
      const res = await netFetch(`${h}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const text = await res.text();
      if (!res.ok) {
        last = `STT ${res.status}：${text.slice(0, 160)}`;
        continue; // 可能是域名不通，换下一个
      }
      const t = (JSON.parse(text)?.text || '').trim();
      return { text: t };
    } catch (e) {
      last = e?.message || '网络错误';
    }
  }
  throw new Error(last || 'SenseVoice 请求失败');
}

/**
 * ElevenLabs Scribe v2：POST https://api.elevenlabs.io/v1/speech-to-text
 * 选它不是因为它技术最强，是因为**它是粤语很强且不用中国实名认证的那一档里最方便的**：
 *   · 邮箱注册即可，不用身份证件 → 非中国居民能真正申请到
 *   · 官方粤语 benchmark（FLEURS）：Scribe 5.9% WER，Whisper large-v3 13.2%，
 *     Gemini Flash 2 17.6%，Deepgram Nova 2 19.3% —— 在能用的一档里最好
 *   · 和 TTS 共用同一个 elevenKey，用户只要注册一家
 *   · 免费档每月含约 4.5 小时
 * 粤语用 ISO 639-3 的 yue，普通话 zho，英语 eng；传了就别让它自动猜。
 */
async function elevenRequest(apiKey, uri, language) {
  const blob = await (await fetch(uri)).blob();
  const form = new FormData();
  form.append('file', blob, 'speech.m4a');
  form.append('model_id', 'scribe_v2');
  const code =
    language === 'yue' ? 'yue'
      : language === 'zh' || language === 'zh-CN' ? 'zho'
        : language === 'en' ? 'eng'
          : '';
  if (code) form.append('language_code', code);

  const res = await netFetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    let d = text.slice(0, 200);
    try { d = JSON.parse(text)?.detail?.message || JSON.parse(text)?.detail || d; } catch (_) {}
    throw new Error(`ElevenLabs STT ${res.status}：${d}`);
  }
  try {
    return (JSON.parse(text)?.text || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Google Gemini 3.5 Transcribe
 * ---------------------------------------------------------------------------
 * 为什么加这家：**它是唯一一家「既最准、又不用信用卡、也不用身份证件」的**。
 *   只要有一个 Google 账号，进 AI Studio 点一下就能拿到免费 Key；
 *   官方支持清单里明明白白写着「Cantonese (Traditional) → yue-Hant-HK」；
 *   公开 benchmark（Artificial Analysis 非实时榜）2.6% WER，是全行业第一梯队。
 * 代价（必须在 UI 里讲清楚）：免费层条款写明**音频可能用于改进 Google 产品**。
 *   贴心话多的陪伴 App 属私密场景，介意的话请用 ElevenLabs / Azure。
 *
 * 接口怎么走 —— 这段解释了为什么写了两条路
 *   官方主路径是「Files API 上传 → POST /v1beta/interactions」（REST 样例见 Google 文档）。
 *   Files API 要做 resumable 三步握手，对一段几秒的语音来说太重。
 *   所以带兜底地试：① 一次请求搞定 —— :generateContent + inlineData base64；
 *   ② ① 不通（比如模型改了 id、或不再支持 generateContent）再走官方 interactions。
 *   记住上次成功的那条，下句先试它 —— 别每句话都白跑一趟失败的 HTTP。
 *
 * ⚠️ 语言码必须用它自己那张 BCP-47 表：粤语 yue-Hant-HK，
 *    普通话是 **cmn-Hans-CN**（不是常见的 zh-CN，写错会被当成无效参数）。
 */
const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const GEM_MODEL = 'gemini-3.5-transcribe';
const GEM_LANG = {
  yue: 'yue-Hant-HK',
  zh: 'cmn-Hans-CN',
  'zh-CN': 'cmn-Hans-CN',
  en: 'en-US',
  'en-US': 'en-US',
  'en-GB': 'en-GB',
};
let geminiWay = null; // 上次走通的那条路：'inline' | 'interactions'

/** 有些 RN 环境没有全局 btoa（Hermes 旧版），自己兜一个 */
function toBase64(bin) {
  if (typeof btoa === 'function') return btoa(bin);
  const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i), b = bin.charCodeAt(i + 1), c = bin.charCodeAt(i + 2);
    out += T[a >> 2];
    out += T[((a & 3) << 4) | ((b || 0) >> 4)];
    out += i + 1 < bin.length ? T[((b & 15) << 2) | ((c || 0) >> 6)] : '=';
    out += i + 2 < bin.length ? T[c & 63] : '=';
  }
  return out;
}

/** 录音文件 → {mime, data(base64)}。Web 端 fetch(uri) 拿 blob，原生端也是这个写法 */
async function readAudio(uri) {
  const blob = await (await fetch(uri)).blob();
  // Gemini 支持 m4a / webm / mp3 / wav…，直接用录音器给的 MIME；拿不到就按 m4a 报
  const mime = /^audio\//.test(blob.type || '') ? blob.type : 'audio/m4a';
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return { mime, data: toBase64(bin) };
}

/**
 * Google 的错误有一半是"准入"而不是"代码错"，直接把英文原话甩给用户等于没说。
 * 尤其这条：Gemini 免费 API **按调用方 IP 所在地区放行**（不是按账号注册地，
 * 也不是按服务器 —— 我们是从手机直连 Google，所以看的是你手机的网络出口）。
 * 官方名单里**没有中国内地、香港、澳门**，这些地方会拿到
 * "User location is not supported for the API use."。
 * 遇到这类错误要给"下一步怎么办"，别让人对着 400 发呆。
 */
function geminiExplain(status, msg) {
  const m = String(msg || '');
  // 报地区错误时把"你看起来在哪"一起说出来 —— 用户自己未必知道手机出口在哪个国家，
  // 说了他才能判断是不是代理/VPN 的问题。探不到就只说规则。
  const where = currentCountry();
  const at = where ? `（看起来你在${ccName(where)}）` : '';
  if (/location|region|country|territory|not supported for the api/i.test(m)) {
    return `Gemini 在你所在地区用不了${at}：Google 的可用地区名单里没有中国内地/香港/澳门，`
      + '欧洲经济区/瑞士/英国又规定只能用付费服务。'
      + '请改选 ElevenLabs 或 Azure —— 那两家没这道门槛。';
  }
  if (/RESOURCE_EXHAUSTED|quota|rate limit/i.test(m) || status === 429) {
    return 'Gemini 今天的免费额度用完了（或请求太密）。明天自动恢复，或先切到 ElevenLabs。';
  }
  if (/API key not valid|API_KEY_INVALID|permission|permission_denied/i.test(m)) {
    return 'Gemini Key 不对、被删了，或者这个 Google 账号没开通 Gemini API。去 AI Studio 重新生成一把。';
  }
  return `Gemini ${status}：${m.slice(0, 200)}`;
}

async function geminiPost(path, apiKey, body) {
  const res = await netFetch(`${GEMINI_HOST}/${path}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let d = text.slice(0, 200);
    try { const j = JSON.parse(text); d = j?.error?.message || d; } catch (_) {}
    throw new Error(geminiExplain(res.status, d));
  }
  try { return JSON.parse(text); } catch (_) { return {}; }
}

function geminiText(j, inline) {
  if (inline) {
    const parts = j?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p?.audioTranscription?.text || p?.text || '').join('').trim();
  }
  if (typeof j?.output_text === 'string' && j.output_text.trim()) return j.output_text.trim();
  const out = [];
  for (const s of j?.steps || []) {
    for (const c of s?.content || []) if (c?.text) out.push(c.text);
  }
  return out.join('\n').trim();
}

/** 路线①：一段 base64 塞进 generateContent，一次请求出结果 */
async function geminiInline(apiKey, uri, language) {
  const { mime, data } = await readAudio(uri);
  const code = GEM_LANG[language];
  const contents = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data } }] }],
  };
  let j;
  try {
    j = await geminiPost(
      `v1beta/models/${GEM_MODEL}:generateContent`,
      apiKey,
      code
        ? { ...contents, generationConfig: { audioTranscriptionConfig: { languageCodes: [code] } } }
        : contents
    );
  } catch (e) {
    // 多半是这家改了字段名/参数（400 INVALID_ARGUMENT）。语言提示不是必需的，
    // 模型本来就能自动识别 85+ 语言和中英混说，丢掉它再试一次。
    if (!code) throw e;
    j = await geminiPost(`v1beta/models/${GEM_MODEL}:generateContent`, apiKey, contents);
  }
  return geminiText(j, true);
}

/** 路线②：官方文档那条 —— Files API 上传后交给 interactions 接口 */
async function geminiInteractions(apiKey, uri, language) {
  const blob = await (await fetch(uri)).blob();
  const mime = /^audio\//.test(blob.type || '') ? blob.type : 'audio/m4a';
  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify({ file: { displayName: 'speech' } })], { type: 'application/json' })
  );
  form.append('file', blob, 'speech.m4a');

  const up = await netFetch(`${GEMINI_HOST}/upload/v1beta/files`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey },
    body: form,
  });
  const upText = await up.text();
  if (!up.ok) {
    let d = upText.slice(0, 160);
    try { d = JSON.parse(upText)?.error?.message || d; } catch (_) {}
    throw new Error(`Gemini 上传 ${up.status}：${d}`);
  }
  const fileUri = JSON.parse(upText)?.file?.uri || JSON.parse(upText)?.file?.name;
  if (!fileUri) throw new Error('Gemini 上传没返回文件地址');

  const code = GEM_LANG[language];
  const j = await geminiPost('v1beta/interactions', apiKey, {
    model: GEM_MODEL,
    input: [{ type: 'audio', uri: fileUri, mime_type: mime }],
    generation_config: { transcription_config: { language_codes: code ? [code] : [] } },
  });
  return geminiText(j, false);
}

async function geminiRequest(apiKey, uri, language) {
  const order = geminiWay
    ? [geminiWay, geminiWay === 'inline' ? 'interactions' : 'inline']
    : ['inline', 'interactions'];
  let last = null;
  for (const way of order) {
    try {
      const t = way === 'inline'
        ? await geminiInline(apiKey, uri, language)
        : await geminiInteractions(apiKey, uri, language);
      if (t) {
        geminiWay = way; // 记住成功路径，下一句直接走它
        return t;
      }
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('Gemini 没返回文字');
}

/**
 * @param {{provider:string, keys:object, language?:string}} cfg
 * @param {string} localUri 录音文件本地路径
 * @returns {Promise<{ok:boolean, text?:string, error?:string, noMatch?:boolean}>}
 */
export async function transcribe(cfg, localUri) {
  const provider = cfg?.provider || 'openai';
  const keys = cfg?.keys || {};
  const lang = cfg?.language || 'auto';

  try {
    if (provider === 'openai') {
      if (!keys.openaiKey) return { ok: false, error: '缺 OpenAI Key' };
      const text = await whisperRequest(
        'https://api.openai.com/v1/audio/transcriptions',
        keys.openaiKey,
        localUri,
        'whisper-1',
        lang,
        lang === 'yue' ? YUE_PROMPT : ''
      );
      return text ? { ok: true, text } : { ok: true, text: '', noMatch: true };
    }

    if (provider === 'groq') {
      if (!keys.groqKey) return { ok: false, error: '缺 Groq Key' };
      const text = await whisperRequest(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        keys.groqKey,
        localUri,
        'whisper-large-v3',
        lang,
        lang === 'yue' ? YUE_PROMPT : ''
      );
      return text ? { ok: true, text } : { ok: true, text: '', noMatch: true };
    }

    if (provider === 'gemini') {
      if (!keys.geminiKey) return { ok: false, error: '缺 Gemini API Key' };
      const t = await geminiRequest(keys.geminiKey, localUri, lang);
      return t ? { ok: true, text: t } : { ok: true, text: '', noMatch: true };
    }

    if (provider === 'elevenlabs') {
      if (!keys.elevenKey) return { ok: false, error: '缺 ElevenLabs Key' };
      const t = await elevenRequest(keys.elevenKey, localUri, lang);
      return t ? { ok: true, text: t } : { ok: true, text: '', noMatch: true };
    }

    if (provider === 'siliconflow') {
      if (!keys.siliconKey) return { ok: false, error: '缺硅基流动 Key' };
      const r = await siliconRequest(keys.siliconKey, localUri);
      return r.text ? { ok: true, text: r.text } : { ok: true, text: '', noMatch: true };
    }

    if (provider === 'azure') {
      if (!keys.azureKey || !keys.azureRegion) return { ok: false, error: '缺 Azure Key 或区域' };
      // yue → zh-HK 才是 Azure 认的粤语 locale
      const locale = lang === 'yue' ? 'zh-HK' : lang === 'auto' ? 'zh-CN' : lang;
      const r = await azureRequest(keys.azureRegion, keys.azureKey, localUri, locale);
      if (!r.text) return { ok: true, text: '', noMatch: true, note: r.status };
      return { ok: true, text: r.text };
    }

    return { ok: false, error: `未知识别服务 ${provider}` };
  } catch (e) {
    return { ok: false, error: e?.message || '识别失败' };
  }
}

/**
 * 一键自检「这家听写服务现在通不通」—— 不录音、不花钱（或只花一个极便宜的 GET）。
 * ---------------------------------------------------------------------------
 * 为什么要有它：Gemini 免费 API **按调用方 IP 的地区放行**。我们是从手机直连
 * Google 的（不经过任何服务器），所以决定命运的是**你手机的网络出口地区**。
 * 官方地区名单里没有中国内地、香港、澳门 —— 人在这些地方点了麦只会拿到
 * 一句 "User location is not supported"。与其让人猜，不如给个按钮自查：
 * 通 = 地区 + Key 都没问题；不通 = 直接告诉他换哪家。
 *
 * @returns {Promise<{ok:boolean|null, msg:string}>} ok=null 表示"没法空跑自检"
 */
export async function checkSttProvider(cfg) {
  const provider = cfg?.provider || '';
  const k = cfg?.keys || {};

  const ping = async (url, headers, okMsg) => {
    const res = await netFetch(url, { method: 'GET', headers });
    const text = await res.text();
    if (!res.ok) {
      let d = text.slice(0, 200);
      try { d = JSON.parse(text)?.error?.message || d; } catch (_) {}
      throw new Error(d);
    }
    return okMsg;
  };

  try {
    if (provider === 'gemini') {
      if (!k.geminiKey) return { ok: false, msg: '还没填 Gemini Key' };
      const res = await netFetch(`${GEMINI_HOST}/v1beta/models`, {
        headers: { 'x-goog-api-key': k.geminiKey },
      });
      const text = await res.text();
      if (!res.ok) {
        let d = text.slice(0, 200);
        try { d = JSON.parse(text)?.error?.message || d; } catch (_) {}
        return { ok: false, msg: geminiExplain(res.status, d) };
      }
      const has = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .includes(GEM_MODEL);
      return has
        ? { ok: true, msg: 'Gemini 通了：地区放行、Key 有效，而且名单里有 gemini-3.5-transcribe。' }
        : { ok: true, msg: 'Key 有效、地区放行，但模型列表里没看到 gemini-3.5-transcribe（可能改名了）。识别时会自动走兜底路线，先说一句试试。' };
    }

    if (provider === 'elevenlabs') {
      if (!k.elevenKey) return { ok: false, msg: '还没填 ElevenLabs Key' };
      await ping('https://api.elevenlabs.io/v1/models', { 'xi-api-key': k.elevenKey });
      return { ok: true, msg: 'ElevenLabs 通了：Key 有效，Scribe 可以听粤语。' };
    }

    if (provider === 'groq') {
      if (!k.groqKey) return { ok: false, msg: '还没填 Groq Key' };
      await ping('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${k.groqKey}` });
      return { ok: true, msg: 'Groq 通了：Key 有效。粤语会被写成书面普通话，介意的话换 Gemini。' };
    }

    if (provider === 'openai') {
      if (!k.openaiKey) return { ok: false, msg: '还没填 OpenAI Key' };
      await ping('https://api.openai.com/v1/models', { Authorization: `Bearer ${k.openaiKey}` });
      return { ok: true, msg: 'OpenAI 通了：Key 有效。' };
    }

    if (provider === 'siliconflow') {
      if (!k.siliconKey) return { ok: false, msg: '还没填硅基流动 Key' };
      await ping('https://api.siliconflow.com/v1/models', { Authorization: `Bearer ${k.siliconKey}` });
      return { ok: true, msg: '硅基流动通了：Key 有效。' };
    }

    if (provider === 'azure') {
      if (!k.azureKey || !k.azureRegion) return { ok: false, msg: 'Azure 要 Key 和区域两个都填' };
      // Azure 没有"零成本自检"的公开端点，硬凑一个空的识别请求反而更贵也更慢。
      return { ok: null, msg: 'Azure 不支持空跑自检：直接对着麦说一句，看能不能听懂。' };
    }

    return { ok: false, msg: `未知识别服务 ${provider}` };
  } catch (e) {
    return { ok: false, msg: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * 粗略判断一句话主要是哪种语言 —— 用来决定"要不要切换角色的口音"。
 * 只用于"要不要切换角色的说话口音"这种粗粒度判断，不追求精确 ——
 * 粤语普通话混着说本来就是常态，硬分只会来回抖。
 */
export function detectLang(text) {
  const t = String(text || '');
  if (!t.trim()) return 'unknown';
  // 粤语特有的字/词：冇、嘅、喺、咗、啦我爱你、「唔」
  const cantoneseChars = (t.match(/[冇嘅喺咗啲乜咁佢俾喐揸揾攞嘢卌]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;

  if (cjk === 0 && latin > 0) return 'en';
  if (cantoneseChars >= 2) return 'yue';
  if (cjk > 0) return 'zh';
  return 'unknown';
}

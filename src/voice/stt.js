// 语音识别（STT）
// ---------------------------------------------------------------------------
// 关键决定：**不用手机自带的原生识别**（expo-speech-recognition）。
// 原生识别依赖 iOS/Android 的听写引擎，粤语常常不可用，而且各家行为不一致、
// 没法配宁静。所以统一「录音 → 送云端识别」，三种语言行为一致，
// 服务端也能切换。代价是需要联网，好处是识别质量和App 行为可控。

import { Platform } from 'react-native';

/** Whisper 系列：multipart 表单上传，字段名 file / model */
async function whisperRequest(url, apiKey, uri, model, language) {
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
  form.append('response_format', 'json');

  const res = await fetch(url, {
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
  const res = await fetch(
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
        lang
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
        lang
      );
      return text ? { ok: true, text } : { ok: true, text: '', noMatch: true };
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

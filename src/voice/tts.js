// 带情绪的语音合成
// ---------------------------------------------------------------------------
// 「像 ChatGPT 那样有情绪」这件事，光靠换音色是不够的。真正管用的三件事：
//  1. **分段**：一整段文字一次合成成不了戏。要按情绪切成小段，逐段合成再串起来播放，
//     才会有"笑着说完这句、然后正经起来"的层次。
//  2. **情绪指令**：OpenAI 的 gpt-4o-mini-tts 支持自然语言描述情绪；
//     Azure 支持 SSML 官方风格；ElevenLabs 靠参数微调。三家路子不同，下面分别适配。
//  3. **非语言声**：[laughs] 这种标记，要真的转换出笑声，而不是念出"中括号 laugh"这几个字。

// ---------------------------------------------------------------------------
// 情绪表：这个 Tag 在三家里分别怎么表达
// ---------------------------------------------------------------------------
export const EMOTIONS = [
  { tag: 'laughs', label: '笑', openai: 'laugh warmly and genuinely, with real amusement in the voice', azure: { style: 'cheerful', rate: '+8%' }, eleven: { style: 0.55, stability: 0.35 } },
  { tag: 'giggles', label: '偷笑', openai: 'giggle playfully, light and bubbly', azure: { style: 'cheerful', rate: '+10%' }, eleven: { style: 0.6, stability: 0.3 } },
  { tag: 'sighs', label: '叹气', openai: 'sigh softly, a little tired but affectionate', azure: { style: 'sad', rate: '-8%' }, eleven: { style: 0.25, stability: 0.6 } },
  { tag: 'excited', label: '兴奋', openai: 'speak with bright excitement and high energy', azure: { style: 'excited', rate: '+12%' }, eleven: { style: 0.7, stability: 0.3 } },
  { tag: 'comfort', label: '安慰', openai: 'speak very gently and soothingly, like comforting a friend who is upset', azure: { style: 'empathetic', rate: '-10%' }, eleven: { style: 0.2, stability: 0.65 } },
  { tag: 'gentle', label: '温柔', openai: 'speak softly and tenderly', azure: { style: 'gentle', rate: '-5%' }, eleven: { style: 0.2, stability: 0.6 } },
  { tag: 'sad', label: '难过', openai: 'speak quietly with sadness, voice slightly trembling', azure: { style: 'sad', rate: '-12%' }, eleven: { style: 0.3, stability: 0.55 } },
  { tag: 'shy', label: '害羞', openai: 'speak bashfully, hesitating a little', azure: { style: 'shy', rate: '-5%' }, eleven: { style: 0.35, stability: 0.5 } },
  { tag: 'whispers', label: '耳语', openai: 'whisper very quietly and intimately', azure: { style: 'gentle', rate: '-15%' }, eleven: { style: 0.2, stability: 0.7 } },
  { tag: 'surprised', label: '惊讶', openai: 'speak with genuine surprise, slightly raised pitch', azure: { style: 'excited', rate: '+8%' }, eleven: { style: 0.6, stability: 0.35 } },
  { tag: 'curious', label: '好奇', openai: 'speak with lively curiosity, leaning forward', azure: { style: 'hopeful', rate: '+3%' }, eleven: { style: 0.5, stability: 0.4 } },
  { tag: 'serious', label: '认真', openai: 'speak seriously and steadily', azure: { style: 'friendly', rate: '0%' }, eleven: { style: 0.15, stability: 0.75 } },
  { tag: 'sing', label: '唱歌', openai: 'sing this in a gentle, melodic, child-friendly tune', azure: { style: 'cheerful', rate: '0%' }, eleven: { style: 0.6, stability: 0.35 } },
  { tag: 'teach', label: '讲解', openai: 'speak like a patient teacher explaining to a curious child, warm and clear, slightly slower', azure: { style: 'friendly', rate: '-5%' }, eleven: { style: 0.3, stability: 0.6 } },
  { tag: 'proud', label: '骄傲', openai: 'speak with warm pride and approval', azure: { style: 'cheerful', rate: '+3%' }, eleven: { style: 0.45, stability: 0.5 } },
  { tag: 'sleepy', label: '困倦', openai: 'speak slowly and drowsily, voice heavy with sleep', azure: { style: 'gentle', rate: '-18%' }, eleven: { style: 0.15, stability: 0.8 } },
];

const EMOTION_BY_TAG = Object.fromEntries(EMOTIONS.map((e) => [e.tag, e]));

// ---------------------------------------------------------------------------
// 文本切段：把「哈哈哈 [laughs] 你好呀～」切成带情绪的小段
// ---------------------------------------------------------------------------
// 必须是 [\w] 而不是 [a-zA-Z]：那只会导致「[xyz123]」这类含数字的标签匹配不上，
// 结果被 TTS 当成正文念出来，角色会说「中括号 x y z 一二三」。
// 宁可匹配宽一点，认不出的标签在下面按未知处理掉。
const TAG_RE = /\[([A-Za-z0-9_]+)\]/g;

/**
 * 把「哈哈哈 [laughs] 你这个问题问得好！[excited] 答案是…」切成带情绪的小段。
 *
 * 采用的规则 —— **标签管它后面的文字**（和大家写舞台提示的习惯一致，也是
 * 模型最自然的输出方式）。所以上面这句会切成：
 *   「哈哈哈」无标签 → 「你这个问题问得好！」laughs → 「答案是…」excited
 *
 * 认不出来的标签（比如 [xyz123]）直接丢掉，绝不留在文本里被念出来；
 * 但它也不会清空当前情绪 —— 模型可能只是打错了一个标签，
 * 不该因为一个错别字就让后面的话全变成念稿。
 *
 * @returns {Array<{text:string, emotion:string|null}>}
 */
export function splitByEmotion(raw) {
  const text = String(raw || '')
    .replace(/［([A-Za-z0-9_]+)］/g, '[$1]')   // 全角中括号归一
    .trim();
  if (!text) return [];

  const segments = [];
  let cursor = 0;
  let current = null;

  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(text)) !== null) {
    const before = text.slice(cursor, match.index).trim();
    if (before) segments.push({ text: before, emotion: current });
    const tag = match[1];
    if (EMOTION_BY_TAG[tag]) current = tag;
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor).trim();
  if (tail) segments.push({ text: tail, emotion: current });

  return segments.filter((s) => s.text);
}

// ---------------------------------------------------------------------------
// OpenAI TTS
// ---------------------------------------------------------------------------
async function openaiTTS({ text, emotion, cfg }) {
  const key = cfg.keys?.openaiKey;
  if (!key) throw new Error('缺 OpenAI Key');

  const supportsInstructions = (cfg.ttsModel || 'gpt-4o-mini-tts') !== 'tts-1';
  const baseEmotion = EMOTION_BY_TAG[emotion];
  const personInstruction = cfg.personInstruction || '';
  const emotionInstruction = baseEmotion?.openai || '';

  const body = {
    model: cfg.ttsModel || 'gpt-4o-mini-tts',
    input: text,
    voice: cfg.voice || 'nova',
    response_format: 'mp3',
    speed: cfg.speed ?? 1.0,
  };
  // tts-1 不认 instructions，硬塞会 400
  if (supportsInstructions) {
    body.instructions = [personInstruction, emotionInstruction].filter(Boolean).join(' ').trim()
      || undefined;
  }

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI TTS ${res.status}：${detail.slice(0, 140)}`);
  }
  return { data: await res.arrayBuffer(), mime: 'audio/mpeg' };
}

// ---------------------------------------------------------------------------
// Azure TTS（SSML）
// ---------------------------------------------------------------------------
function buildAzureSSML({ text, emotion, cfg }) {
  const emo = EMOTION_BY_TAG[emotion];
  const style = emo?.azure?.style;
  const rate = emo?.azure?.rate || (cfg.speed ? `${Math.round((cfg.speed - 1) * 100)}%` : '0%');

  const inner = `<prosody rate="${rate}" pitch="${cfg.pitch || '0%'}">${escapeXml(text)}</prosody>`;
  // 标了 style: true 的发音人才接受 express-as；粤语发音人基本不支持，所以由 cfg.allowStyle 控制
  const body = cfg.allowStyle && style
    ? `<mstts:express-as style="${style}">${inner}</mstts:express-as>`
    : inner;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${cfg.locale || 'zh-CN'}"><voice name="${cfg.voice}">${body}</voice></speak>`;
}

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function azureTTS({ text, emotion, cfg }) {
  const key = cfg.keys?.azureKey;
  const region = cfg.keys?.azureRegion;
  if (!key || !region) throw new Error('缺 Azure Key 或区域');

  const ssml = buildAzureSSML({ text, emotion, cfg });
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
    },
    body: ssml,
  });
  if (!res.ok) {
    // Azure 最常见的失败：该发音人不支持这个 style。降级重来一次，别让用户听到报错。
    if (res.status === 400 && cfg.allowStyle) {
      const retry = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
        },
        body: buildAzureSSML({ text, emotion, cfg: { ...cfg, allowStyle: false } }),
      });
      if (retry.ok) return { data: await retry.arrayBuffer(), mime: 'audio/mpeg' };
    }
    throw new Error(`Azure TTS ${res.status}：${(await res.text()).slice(0, 140)}`);
  }
  return { data: await res.arrayBuffer(), mime: 'audio/mpeg' };
}

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------
async function elevenTTS({ text, emotion, cfg }) {
  const key = cfg.keys?.elevenKey;
  if (!key) throw new Error('缺 ElevenLabs Key');

  const emo = EMOTION_BY_TAG[emotion]?.eleven || { style: 0.3, stability: 0.5 };
  // ElevenLabs 没有明确情绪指令，靠 stability/similarity/style 的组合靠近目标情绪。
  // 另外它是逐字的，所以唱歌要在文本层面给他一点韵律提示。
  const input = emotion === 'sing' ? `♪ ${text} ♪` : text;

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.voice}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: input,
      model_id: cfg.ttsModel || 'eleven_multilingual_v2',
      voice_settings: {
        stability: emo.stability,
        similarity_boost: 0.75,
        style: emo.style,
        use_speaker_boost: true,
        speed: cfg.speed ?? 1.0,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}：${(await res.text()).slice(0, 140)}`);
  }
  return { data: await res.arrayBuffer(), mime: 'audio/mpeg' };
}

const ENGINES = { openai: openaiTTS, azure: azureTTS, elevenlabs: elevenTTS };

/**
 * 合成一个片段。失败会抛，调用方决定降级策略。
 * @returns {Promise<{data:ArrayBuffer, mime:string}>}
 */
export async function synthesizeSegment({ text, emotion, cfg }) {
  const engine = ENGINES[cfg.provider] || ENGINES.openai;
  return engine({ text, emotion, cfg });
}

/**
 * 整段回复 → 多个音频片段。
 * 串行请求（不并发）是有意的：并发会让播放顺序和语调对不上，
 * 而且三家 API 都有速率限制，一口气发五六个容易被限流。
 *
 * @param {string} rawReply 模型原文，可能含 [laughs] 之类标记
 * @param {object} cfg
 * @param {(done:number,total:number)=>void} onProgress
 * @returns {Promise<{ok:boolean, clips:Array<{data:ArrayBuffer,text:string,emotion:string|null}>, error?:string}>}
 */
export async function synthesizeReply(rawReply, cfg, onProgress) {
  const segments = splitByEmotion(rawReply);
  if (!segments.length) return { ok: false, error: '没有可朗读的内容' };

  const clips = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    try {
      const { data } = await synthesizeSegment({ ...seg, cfg });
      clips.push({ data, text: seg.text, emotion: seg.emotion });
      onProgress?.(i + 1, segments.length);
    } catch (e) {
      // 单段失败不要整句都废掉，把文字留给用户看
      clips.push({ data: null, text: seg.text, emotion: seg.emotion, error: e?.message });
    }
  }
  const anyOk = clips.some((c) => c.data);
  return { ok: anyOk, clips };
}

/** 去掉所有情绪标记，得到干净的、可以显示给用户看的文本 */
export function stripEmotionTags(raw) {
  return String(raw || '')
    .replace(/\[[a-zA-Z]+\]/g, '')
    .replace(/［[a-zA-Z]+］/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

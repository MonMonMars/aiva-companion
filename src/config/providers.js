// 外部服务商目录：语音合成 / 语音识别 / 联网搜索
// ---------------------------------------------------------------------------
// 这里只放"有哪些服务、每个服务有哪些声音"这种静态信息。
// 真正的请求逻辑在 src/voice/* 和 src/services/* 里。
// 想加第四家服务：在这里加一条，再去对应文件里加一个 case。

// ---------------------------------------------------------------------------
// 语音合成（TTS）
// ---------------------------------------------------------------------------
export const TTS_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    note: '情绪自然度高，支持用自然语言描述情绪。中英普粤都能说，粤语略带普通话口音。',
    keyFields: [{ key: 'openaiKey', label: 'OpenAI API Key', placeholder: 'sk-...' }],
    defaultVoice: 'nova',
    supportsEmotion: true,
    // gpt-4o-mini-tts 支持 instructions；老的 tts-1 不支持，会自动降级
    defaultModel: 'gpt-4o-mini-tts',
    voices: [
      { id: 'nova', label: 'Nova · 女声·活泼', gender: 'f' },
      { id: 'shimmer', label: 'Shimmer · 女声·温柔', gender: 'f' },
      { id: 'coral', label: 'Coral · 女声·亲切', gender: 'f' },
      { id: 'sage', label: 'Sage · 女声·沉稳', gender: 'f' },
      { id: 'alloy', label: 'Alloy · 中性·百搭', gender: 'n' },
      { id: 'ash', label: 'Ash · 男声·冷静', gender: 'm' },
      { id: 'echo', label: 'Echo · 男声·低沉', gender: 'm' },
      { id: 'onyx', label: 'Onyx · 男声·浑厚', gender: 'm' },
      { id: 'fable', label: 'Fable · 男声·讲故事', gender: 'm' },
      { id: 'verse', label: 'Verse · 中性·多变', gender: 'n' },
    ],
  },
  {
    id: 'azure',
    name: 'Azure 微软语音',
    note: '粤语最地道（专有 zh-HK 发音人），情绪风格官方支持。推荐要粤语就选它。⚠️ 要用国际版 azure.microsoft.com；不是 azure.cn（世纪互联）—— 那家要中国实名认证。',
    keyFields: [
      { key: 'azureKey', label: 'Speech Key', placeholder: '订阅密钥' },
      { key: 'azureRegion', label: '区域', placeholder: 'eastasia / southeastasia / eastus' },
    ],
    defaultVoice: 'zh-CN-XiaoxiaoMultilingualNeural',
    supportsEmotion: true,
    voices: [
      // 多语言神经语音：一个声音能说中英，适合混说场景
      { id: 'zh-CN-XiaoxiaoMultilingualNeural', label: '晓晓 · 女声·温柔（多语言）', gender: 'f', style: true },
      { id: 'zh-CN-XiaoyiMultilingualNeural', label: '晓伊 · 女声·活泼（多语言）', gender: 'f', style: true },
      { id: 'zh-CN-YunxiMultilingualNeural', label: '云希 · 男声·清朗（多语言）', gender: 'm', style: true },
      { id: 'zh-CN-YunxiaMultilingualNeural', label: '云夏 · 男声·少年（多语言）', gender: 'm', style: true },
      // 粤语（香港）—— 关键：这几个才是真·粤语
      { id: 'zh-HK-WanLungNeural', label: '雲龍 · 男声·粤语（香港）', gender: 'm', lang: 'yue' },
      { id: 'zh-HK-GaaiNeural', label: '佳 · 女声·粤语（香港）', gender: 'f', lang: 'yue' },
      { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 女声·粤语·温柔', gender: 'f', lang: 'yue' },
      { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 女声·粤语·亲切', gender: 'f', lang: 'yue' },
      // 英语
      { id: 'en-US-AvaMultilingualNeural', label: 'Ava · 女声·英语（多语言）', gender: 'f', style: true },
      { id: 'en-US-JennyMultilingualNeural', label: 'Jenny · 女声·英语', gender: 'f', style: true },
      { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew · 男声·英语', gender: 'm', style: true },
    ],
    // Azure 官方情绪风格。注意并非每个发音人都支持全部风格（比如粤语发音人通常不支持），
    // 所以运行时会先试 express-as，报不支持再降级成纯 prosody 调速调调。
    styles: [
      { id: 'cheerful', label: '开心' },
      { id: 'sad', label: '难过' },
      { id: 'excited', label: '兴奋' },
      { id: 'angry', label: '生气' },
      { id: 'fearful', label: '害怕' },
      { id: 'gentle', label: '温柔' },
      { id: 'friendly', label: '亲切' },
      { id: 'hopeful', label: '期待' },
      { id: 'shy', label: '害羞' },
      { id: 'empathetic', label: '共情安慰' },
    ],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    note: '情感表现力最强，笑声最自然。中文略逊于前两家。价格较高。',
    keyFields: [{ key: 'elevenKey', label: 'ElevenLabs API Key', placeholder: '...' }],
    defaultVoice: '21m00Tcm4TlvDq8ikWAM',
    supportsEmotion: true,
    defaultModel: 'eleven_multilingual_v2',
    voices: [
      { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel · 女声·温柔' },
      { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi · 女声·坚定' },
      { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella · 女声·甜美' },
      { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli · 女声·年轻' },
      { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni · 男声·磁性' },
      { id: 'VR6AewLTigWG4xSOukaG', label: 'Josh · 男声·少年' },
      { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam · 男声·沉稳' },
    ],
  },
  {
    id: 'edge',
    name: 'Edge 神经语音（浏览器）',
    note: '免 Key、零基础设施。走浏览器自带的 SpeechSynthesis，在 Edge / Windows 上就是微软真正的神经粤语嗓音（zh-HK-HiuGaaiNeural 等）；其它浏览器会退而求其次用设备已有的粤语声音。想在任何浏览器都拿到神经音质，可加一个 serverless 代理转发 Edge TTS（代码已预留）。',
    keyFields: [],
    free: true,
    defaultVoice: '',
    supportsEmotion: false,
    voices: [
      { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 女声·粤语·温柔（神经）', gender: 'f', lang: 'yue' },
      { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 女声·粤语·亲切（神经）', gender: 'f', lang: 'yue' },
      { id: 'zh-HK-WanLungNeural', label: '雲龍 · 男声·粤语（神经）', gender: 'm', lang: 'yue' },
      { id: 'zh-HK-GaaiNeural', label: '佳 · 女声·粤语（神经）', gender: 'f', lang: 'yue' },
    ],
  },
  {
    id: 'espeak',
    name: 'eSpeak（离线·机械音）',
    note: '免 Key、真正离线。浏览器内跑 eSpeak NG WASM，把粤语「zhy」共振峰合成出来，不依赖任何网络。机械音但一定能出声，是没网/没装粤语声音时的兜底。需把 eSpeak 的 worker 文件放进 public/espeakng/（Web Worker 不能跨域）。',
    keyFields: [],
    free: true,
    // defaultVoice / voices 里的 id 必须与 src/voice/espeak.js 的 VOICE_FOR 一致：
    // eSpeak-ng 的粤语**嗓音名**是 zhy，不是 BCP47 的 yue。
    // 两边打架的话，将来很容易有人照着这里把 espeak.js 改回 yue，
    // 重新引入「粤语静默回落成默认嗓音」这个已经修过的 bug。
    defaultVoice: 'zhy',
    supportsEmotion: false,
    voices: [
      { id: 'zhy', label: '粤语 zhy' },
      { id: 'zh', label: '普通话 zh' },
      { id: 'en', label: 'English en' },
    ],
  },
  {
    id: 'native',
    name: '系统嗓音（手机内置·离线）',
    note: '免 Key、免联网，用手机自带的语音引擎朗读（iOS 为 AVSpeechSynthesizer，Android 为 TextToSpeech）。想要地道的粤语，iPhone 需先在「设置 → 辅助功能 → 朗读内容 → 声音」里下载「中文（粤语）」嗓音；没下载也会出声，只是可能用默认嗓音念。情绪只能靠音高/语速微调，不如云端自然，但完全免费且一定能发声。',
    keyFields: [],
    free: true,
    defaultVoice: '',
    supportsEmotion: true,
    // 这里刻意**不列**设备嗓音清单：嗓音 identifier 是设备相关的，写死一个名称，
    // 若该设备没装这个嗓音，iOS 端会直接抛异常（详见 voice/nativeSpeech.js 顶部注释）。
    // 正确做法是运行时用 getAvailableVoicesAsync() 现场枚举，挑不到就退回按语言选。
    voices: [
      { id: '', label: '自动（按语言挑设备嗓音）' },
    ],
  },
];

// ---------------------------------------------------------------------------
// 语音识别（STT）
// ---------------------------------------------------------------------------
// ⚠️ 排序有讲究：第一项是**非中国居民真能申请到、且免费额度最大**的一家。
//    siliconflow 永远别放回第一 —— 它技术很强，但强制中国实名，外国人根本过不去。
//
// ⚠️ 但"排第一"不等于"全世界都该用它"。Gemini 有地区门槛（中国内地/香港/澳门
//    不在 Google 名单里，EEA/瑞士/英国又禁止免费层），所以**实际用哪家要看用户
//    在哪个国家**：见 src/lib/region.js。这里的顺序只是"理想情况下的推荐顺序"，
//    界面上会按地区重新排序，硬默认仍然是 elevenlabs（见 store.js）。
export const STT_PROVIDERS = [
  {
    id: 'gemini',
    name: 'Gemini 3.5 Transcribe ★免费额度最大',
    short: 'Gemini',
    // 2026-08 Google 发的专用语音识别模型。卖点：Google 账号 → AI Studio 里点一下
    // 就有 Key，**不要信用卡、不要身份证件**；
    // 支持清单里明确有「粤语（繁体）yue-Hant-HK」；公开 benchmark 2.6% WER，第一梯队。
    // 反面（必须在界面里讲清楚）：
    //   ① 按**你手机的网络出口地区**放行 —— Google 名单里没有中国内地/香港/澳门，
    //      也没有俄罗斯、白俄罗斯、伊朗、朝鲜、古巴、叙利亚；
    //   ② 附加条款规定：向**欧洲经济区 / 瑞士 / 英国**的用户提供服务只能用付费服务，
    //      这些地方**免费层不合规**（Google 官方论坛里 Google 员工确认过，
    //      并说"IP 是判断用户所在地的主要信号"）；
    //   ③ 免费层条款写明音频可能被用来改进 Google 产品。
    // → 所以这家是"能用就最好"，但**绝不是全世界通用**。见 src/lib/region.js。
    note: '门槛最低也最准：Google 账号登录 AI Studio 免费领 Key，不用信用卡、不用身份证件。官方支持列表里明确写了「粤语（繁体）yue-Hant-HK」。⚠️ 三条限制：① 按**你手机的网络出口地区**放行，Google 名单里没有中国内地/香港/澳门；② 欧洲经济区/瑞士/英国按 Google 条款只能用**付费**服务，免费层不合规 —— 这三处请用 ElevenLabs；③ 免费层条款写明音频可能用于改进 Google 产品。不确定就点下面的「检查这家通不通」。',
    keyFields: [{ key: 'geminiKey', label: 'Gemini API Key', placeholder: 'AIza...' }],
    langs: [
      { id: 'yue', label: '粤语（推荐）' },
      { id: 'auto', label: '自动检测（中英混说也行）' },
      { id: 'zh', label: '普通话' },
      { id: 'en', label: 'English' },
    ],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs Scribe',
    short: 'ElevenLabs',
    // 这家是**全世界默认**：ElevenLabs 只封锁白俄罗斯/古巴/伊朗/朝鲜/俄罗斯/叙利亚，
    // 香港、澳门、中国内地、欧洲、英国、瑞士全都可用。Gemini 虽好但有长长的地区门槛，
    // 所以在不知道用户在哪、或用户在受限地区时，兜底必须是这家。见 src/lib/region.js。
    note: '★全世界最稳的一家：只封锁少数制裁国家，中国内地/香港/澳门/欧洲/英国/瑞士都能用。邮箱注册就有 Key，和 TTS 共用同一把 —— 一家搞定「说」和「听」，免费档每月约 4.5 小时。官方粤语测试错误率 5.9%，远好于 Whisper 的 13.2%。粤语请选 yue。',
    keyFields: [{ key: 'elevenKey', label: 'ElevenLabs API Key', placeholder: '...' }],
    langs: [
      { id: 'yue', label: '粤语（推荐）' },
      { id: 'auto', label: '自动检测' },
      { id: 'zh', label: '普通话' },
      { id: 'en', label: 'English' },
    ],
  },
  {
    id: 'azure',
    name: 'Azure Speech',
    short: 'Azure',
    note: '粤语也很准（官方测试错误率约 9.2%），和 TTS 共用同一个 Key，一个 Key 包办"说"和"听"。⚠️ 一定要用国际版 azure.microsoft.com；azure.cn（世纪互联）要中国实名，走不通。',
    keyFields: [
      { key: 'azureKey', label: 'Speech Key', placeholder: '订阅密钥' },
      { key: 'azureRegion', label: '区域', placeholder: 'eastasia / southeastasia' },
    ],
    langs: [
      { id: 'zh-HK', label: '粤语（香港）★' },
      { id: 'zh-CN', label: '普通话' },
      { id: 'en-US', label: 'English (US)' },
      { id: 'en-GB', label: 'English (UK)' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq Whisper',
    short: 'Groq',
    note: '免费额度大方、速度快到几乎实时。缺点：Whisper 会把粤语洗成书面普通话，我们已加了粤语行文提示去纠正，但不保证每句都对。',
    keyFields: [{ key: 'groqKey', label: 'Groq API Key', placeholder: 'gsk_...' }],
    langs: [
      { id: 'auto', label: '自动检测' },
      { id: 'yue', label: '粤语' },
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI Whisper',
    short: 'OpenAI',
    note: '和 ChatGPT 一个 Key，顺带能当嗓子用。缺点同 Groq：粤语常被转成书面普通话。',
    keyFields: [{ key: 'openaiKey', label: 'OpenAI API Key', placeholder: 'sk-...' }],
    langs: [
      { id: 'auto', label: '自动检测' },
      { id: 'yue', label: '粤语（输出仍可能是书面语）' },
      { id: 'zh', label: '中文（普通话）' },
      { id: 'en', label: 'English' },
    ],
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SenseVoice',
    short: '硅基流动',
    // ⚠️ 技术最强但门槛最死：2026 年起免费模型强制实名认证，
    //    线上验证只认中国身份证件，外国护照走不通。非中国居民别在这家浪费时间。
    note: '⚠️ 中国居民专用：粤语技术最强（错误率 7.1%），但免费模型强制中国实名认证，外国护照无法在线验证 — 非中国居民请勿选此项。',
    keyFields: [{ key: 'siliconKey', label: '硅基流动 API Key', placeholder: 'sk-...' }],
    langs: [
      { id: 'auto', label: '自动检测' },
      { id: 'yue', label: '粤语' },
      { id: 'zh', label: '普通话' },
      { id: 'en', label: 'English' },
    ],
  },
];

// ---------------------------------------------------------------------------
// 联网搜索
// ---------------------------------------------------------------------------
export const SEARCH_PROVIDERS = [
  {
    id: 'tavily',
    name: 'Tavily',
    note: '专为 AI 设计的搜索，返回内容干净，最适合喂给大模型。有免费额度。',
    keyFields: [{ key: 'tavilyKey', label: 'Tavily API Key', placeholder: 'tvly-...' }],
  },
  {
    id: 'brave',
    name: 'Brave Search',
    note: '独立搜索引擎，注重隐私，收录偏网页原始内容。',
    keyFields: [{ key: 'braveKey', label: 'Brave API Key', placeholder: '...' }],
  },
  {
    id: 'serper',
    name: 'Serper（Google）',
    note: '走 Google 索引，结果最贴近日常搜索习惯。有免费额度。',
    keyFields: [{ key: 'serperKey', label: 'Serper API Key', placeholder: '...' }],
  },
  {
    id: 'none',
    name: '不联网',
    note: '只用模型自身知识。天气仍然可用（不需要搜索额度）。',
    keyFields: [],
  },
];

// ---------------------------------------------------------------------------
// 界面语言 —— 决定角色用哪种语言跟你说话
// ---------------------------------------------------------------------------
export const SPOKEN_LANGS = [
  { id: 'auto', label: '跟随我说的语言', note: '自动判断' },
  { id: 'zh-CN', label: '普通话', note: 'Mandarin' },
  { id: 'zh-HK', label: '粤语', note: 'Cantonese' },
  { id: 'en-US', label: 'English', note: '英语' },
  { id: 'mix', label: '中英混说', note: '像真实双语者那样自由切换' },
];

export const findTTS = (id) => TTS_PROVIDERS.find((p) => p.id === id) || TTS_PROVIDERS[0];
export const findSTT = (id) => STT_PROVIDERS.find((p) => p.id === id) || STT_PROVIDERS[0];
export const findSearch = (id) => SEARCH_PROVIDERS.find((p) => p.id === id) || SEARCH_PROVIDERS[0];

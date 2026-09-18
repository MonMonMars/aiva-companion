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
    note: '粤语最地道（专有 zh-HK 发音人），情绪风格官方支持。推荐要粤语就选它。',
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
];

// ---------------------------------------------------------------------------
// 语音识别（STT）
// ---------------------------------------------------------------------------
export const STT_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI Whisper',
    note: '中英普粤都能识别。注意：听粤语时常常自动转成书面普通话。',
    keyFields: [{ key: 'openaiKey', label: 'OpenAI API Key', placeholder: 'sk-...' }],
    langs: [
      { id: 'auto', label: '自动检测' },
      { id: 'zh', label: '中文（普通话）' },
      { id: 'yue', label: '粤语（ Whisper 输出仍可能是书面语）' },
      { id: 'en', label: 'English' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq Whisper',
    note: '同一套 Whisper，但速度快很多，几乎实时。适合对话。',
    keyFields: [{ key: 'groqKey', label: 'Groq API Key', placeholder: 'gsk_...' }],
    langs: [
      { id: 'auto', label: '自动检测' },
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
    ],
  },
  {
    id: 'azure',
    name: 'Azure Speech',
    note: '粤语识别最准（zh-HK），普通话也很强。和 TTS 共用同一个 Key。',
    keyFields: [
      { key: 'azureKey', label: 'Speech Key', placeholder: '订阅密钥' },
      { key: 'azureRegion', label: '区域', placeholder: 'eastasia' },
    ],
    langs: [
      { id: 'zh-CN', label: '普通话' },
      { id: 'zh-HK', label: '粤语（香港）' },
      { id: 'en-US', label: 'English (US)' },
      { id: 'en-GB', label: 'English (UK)' },
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

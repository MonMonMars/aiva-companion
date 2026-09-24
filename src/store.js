// 全局状态：好感度养成系统 + 本地持久化
// ---------------------------------------------------------------------------
// 结构
//   relations[personaId]  → 每个人一份独立的关系进度（亲密值/心情/精力/认识天数）
//   coins / memory / giftCount / config → 共享的用户侧数据
// 这样切换人格时，各自的感情线互不干扰。
//
// 另外：数值会随时间结算衰减，久不理她 → 心情低落、亲密值掉；精力则会随时间回复。
// 这是养成类最重要的"回访钩子"。

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getPersona, pick, GIFTS } from './theme';
import { personaLine } from './voice/cantonese';
import { num as setting } from './lib/cloudSettings';

const KEY = 'aiva.companion.v1';

// 每小时的衰减 / 回复速率 + 签到奖励 —— 这些现在是**管理后台下发**的，见 app_settings 表。
//
// ⚠️ 两条都不能违反：
//   1. 不要用模块级常量把值算死。loadSettings() 是异步的，在模块加载时读会永远拿到兜底值，
//      后台改了用户在客户端也看不到 —— 等于白做。所以每次调用时再读。
//   2. 兜底值必须和改造前代码里写死的一模一样（0.6 / 1.4 / 7 / 25 / 8 / 6），
//      这样断网时行为不回退也不跳变。
const decayRates = () => ({
  affectionPerHour: setting('decay_affection_per_hour'),
  moodPerHour: setting('decay_mood_per_hour'),
  energyPerHour: setting('decay_energy_per_hour'),
});

/** 签到一次给多少 —— store 和菜单页都从这里取，避免两处写死不一致 */
export function checkInReward() {
  return {
    coins: setting('checkin_coins'),
    mood: setting('checkin_mood'),
    affection: setting('checkin_affection'),
  };
}

const DEFAULT_RELATION = {
  affection: 0,
  mood: 70,
  energy: 80,
  createdAt: null,
  totalPets: 0,
  totalChats: 0,
};

const DEFAULT_STATE = {
  personaId: null,
  relations: {},
  coins: 30,
  giftCount: {},
  chatHistory: {}, // { [personaId]: [{role, content}] }
  memory: [],      // [{ text, ts }]
  lastCheckInDay: null,
  lastSeenAt: null,
  config: {
    // ---- 大模型 ----
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',

    // ---- 说话 / 听觉 / 联网 ----
    spokenLang: 'zh-HK',  // auto | zh-CN | zh-HK | en-US | mix（默认讲粤语）
    kidMode: false,       // 儿童模式：内容过滤更严、句子更短
    langMigratedToYue: false, // 一次性迁移标记：老存档的 auto 升级成粤语
    sttMigratedOffSilicon: false, // 一次性迁移标记：未填 Key 的 siliconflow 切去 elevenlabs
    bgId: 'auto',        // 舞台背景：见 src/backgrounds.js（auto=跟随角色配色）
    bgImage: '',         // 自定义背景图（data URL / uri），非空时优先于 bgId
    voice: {
      // Web 端默认用 edge（浏览器自带微软神经 zh-HK，免 Key、零基础设施）；
      // 原生端默认用 native（手机自带的 AVSpeechSynthesizer / TextToSpeech，
      // 同样免 Key、离线）。以前原生端默认 openai —— 没填 Key 就是彻底没声音。
      ttsProvider: Platform.OS === 'web' ? 'edge' : 'native',     // edge | espeak | native | openai | azure | elevenlabs
      ttsVoice: '',              // 空 = 用该角色在 theme.SPEECH 里的默认音色
      ttsSpeed: null,            // null = 用默认语速
      ttsModel: 'gpt-4o-mini-tts',
      // 默认给 elevenlabs（Scribe v2）：粤语准、邮箱就能注册、**不用中国实名认证**。
      // 曾经默认 siliconflow（SenseVoice 技术最强但强制中国实名，非中国居民走不通）；
      // elevenlabs | siliconflow | openai | groq | azure
      sttProvider: 'elevenlabs',
      sttLanguage: 'yue',        // auto | zh | yue | en（默认听粤语）
      searchProvider: 'none',    // none | tavily | brave | serper
      defaultCity: '',           // 问"天气怎么样"时的默认城市
      // Key 全部只存在本机，任何情况下都不进代码、不进 git、不上传
      openaiKey: '',
      groqKey: '',
      siliconKey: '',
      azureKey: '',
      azureRegion: '',
      elevenKey: '',
      geminiKey: '',
      tavilyKey: '',
      braveKey: '',
      serperKey: '',
    },
  },
};

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------
let state = { ...DEFAULT_STATE };
const listeners = new Set();
let snapCache = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const notify = () => listeners.forEach((l) => l());

async function persist() {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[store] persist failed', e);
  }
}

function relOr(id) {
  return { ...DEFAULT_RELATION, ...(state.relations[id] || {}) };
}

function writeRelation(id, patch) {
  state = { ...state, relations: { ...state.relations, [id]: { ...relOr(id), ...patch } } };
}

// 本机最后一次「真正写盘」的时间。云同步靠它判断这次是谁更新：
// 只有云端那行比本机晚时才让云端覆盖本机，否则是本机赢。
// （用来避免这种场景：离线玩了一天，一登录被云端旧数据洗掉。）net
let dirtyAt = 0;
export const localDirtyAt = () => dirtyAt;

function invalidate({ save = true } = {}) {
  snapCache = null;
  state = { ...state, lastSeenAt: Date.now() };
  if (save) {
    dirtyAt = Date.now();
    persist();
  }
  notify();
}

/** 给 UI 用的扁平快照 —— 缓存住，避免 useSyncExternalStore 无限重渲染 */
function buildSnapshot() {
  const id = state.personaId;
  const rel = relOr(id);
  const createdAt = rel.createdAt || Date.now();
  const days = Math.max(1, Math.floor((Date.now() - createdAt) / 86_400_000) + 1);
  return {
    personaId: id,
    affection: rel.affection,
    mood: clamp(rel.mood, 0, 100),
    energy: clamp(rel.energy, 0, 100),
    days,
    totalPets: rel.totalPets,
    totalChats: rel.totalChats,
    coins: state.coins,
    giftCount: state.giftCount,
    memory: state.memory,
    config: state.config,
    lastCheckInDay: state.lastCheckInDay,
    hasHistory: (state.chatHistory[id] || []).length > 0,
    // 语音链路要拿最近几轮做上下文。这里给的是原始数组引用，
    // 只在 appendMessage 时才会换新引用，所以不会破坏快照的引用稳定性。
    history: state.chatHistory[id] || [],
  };
}

export function getSnapshot() {
  if (!snapCache) snapCache = buildSnapshot();
  return snapCache;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadStore() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      state = {
        ...DEFAULT_STATE,
        ...saved,
        relations: { ...DEFAULT_STATE.relations, ...(saved.relations || {}) },
        // config 必须深层合并 voice：浅合并会用旧存档里的 voice 整体覆盖掉默认值，
        // 以后往 voice 里加新字段时，老用户的存档会直接把它抹成 undefined。
        config: {
          ...DEFAULT_STATE.config,
          ...(saved.config || {}),
          voice: {
            ...DEFAULT_STATE.config.voice,
            ...(saved.config?.voice || {}),
          },
        },
      };

      // 一次性迁移：老存档里 spokenLang 存的是 'auto'，而存档会**覆盖**默认值，
      // 光改 DEFAULT_STATE 根本到不了老用户手上 —— 他会一直听到普通话。
      // 只跑一次并打标记，之后用户自己改回 auto 也不会被反复掰回来。
      if (!state.config.langMigratedToYue) {
        if (!state.config.spokenLang || state.config.spokenLang === 'auto') {
          state.config.spokenLang = 'zh-HK';
        }
        if (!state.config.voice.sttLanguage || state.config.voice.sttLanguage === 'auto') {
          state.config.voice.sttLanguage = 'yue';
        }
        state.config.langMigratedToYue = true;
        persist();
      }

      // 一次性迁移：硅基流动 2026 年起免费模型强制中国实名认证，外国护照无法在线验证。
      // 老存档默认停在这家，而**没有填 Key 就说明他完全无法通过这条路**，
      // 留着只会一开口就报「缺硅基流动 Key」。这里切到 elevenlabs（Scribe，邮箱就能注册）。
      // 已经填了 siliconKey 的说明人家打通了，不动他。
      if (!state.config.sttMigratedOffSilicon) {
        const vv = state.config.voice || {};
        if (vv.sttProvider === 'siliconflow' && !vv.siliconKey) {
          state.config.voice = { ...vv, sttProvider: 'elevenlabs' };
        }
        state.config.sttMigratedOffSilicon = true;
        persist();
      }

      // 一次性迁移 A（Web 端）：还停在云端 TTS（openai/azure/elevenlabs）又没填对应 Key，
      // 一开口就报「缺 XX Key」。切到 edge（浏览器自带，免 Key）让用户立刻能听到声音。
      if (!state.config.ttsMigratedToFree && Platform.OS === 'web') {
        const vv = state.config.voice || {};
        const hasKey = (p) =>
          p === 'openai' ? !!vv.openaiKey
          : p === 'azure' ? !!(vv.azureKey && vv.azureRegion)
          : p === 'elevenlabs' ? !!vv.elevenKey
          : true; // 其它 provider（edge/espeak）本来就免 Key
        if (['openai', 'azure', 'elevenlabs'].includes(vv.ttsProvider) && !hasKey(vv.ttsProvider)) {
          state.config.voice = { ...vv, ttsProvider: 'edge' };
        }
        state.config.ttsMigratedToFree = true;
        persist();
      }

      // 一次性迁移 B（原生端）：同 A，但目标是 native（手机自带引擎、免 Key、离线）。
      // 以前原生端只有云端 TTS 一条路，老存档没填 Key 就是彻底没声音。
      // 必须用**新**的迁移标记：ttsMigratedToFree 在 A 里已经被老用户置成 true 了，
      // 复用它会让原生端这次迁移一次都跑不到。
      // 原则和其它迁移一致：**只救火不升级** —— 已填 Key 的一律不动（那是用户主动选的）。
      if (!state.config.ttsMigratedToNative && Platform.OS !== 'web') {
        const vv = state.config.voice || {};
        const hasKey = (p) =>
          p === 'openai' ? !!vv.openaiKey
          : p === 'azure' ? !!(vv.azureKey && vv.azureRegion)
          : p === 'elevenlabs' ? !!vv.elevenKey
          : true; // edge / espeak / native 本来就免 Key
        if (['openai', 'azure', 'elevenlabs'].includes(vv.ttsProvider) && !hasKey(vv.ttsProvider)) {
          // ★ ttsVoice 必须一起清空：留着旧值时它会作为嗓音 identifier 传给 expo-speech，
          //   而 'nova' 这种是 OpenAI 的音色名，设备上不存在 —— iOS 端会直接抛
          //   InvalidVoiceException（Exp 源码里是 guard + throw，不是静默降级）。
          state.config.voice = { ...vv, ttsProvider: 'native', ttsVoice: '' };
        }
        state.config.ttsMigratedToNative = true;
        persist();
      }

      const comeback = applyTimeDecay();
      snapCache = null;
      notify();
      return { snapshot: getSnapshot(), comeback };
    }
  } catch (e) {
    console.warn('[store] load failed', e);
  }
  snapCache = null;
  // 全新存档：开局金币同样由后台下发，所以在这里才取，不能放在 DEFAULT_STATE 里写死
  state = { ...state, coins: setting('initial_coins') };
  notify();
  return { snapshot: getSnapshot(), comeback: null };
}

/** 结算离线期间的时间衰减；返回本次结算摘要，供首屏演出 */
export function applyTimeDecay() {
  if (!state.lastSeenAt) return null;
  const now = Date.now();
  const hours = (now - state.lastSeenAt) / 3_600_000;
  if (hours < 0.05) return null; // 3 分钟内不结算

  const RATE = decayRates();
  const next = {};
  let moodDrop = 0;
  for (const id of Object.keys(state.relations)) {
    const r = relOr(id);
    const after = {
      ...r,
      affection: clamp(r.affection - hours * RATE.affectionPerHour, 0, 99999),
      mood: clamp(r.mood - hours * RATE.moodPerHour, 0, 100),
      energy: clamp(r.energy + hours * RATE.energyPerHour, 0, 100),
    };
    moodDrop = Math.max(moodDrop, r.mood - after.mood);
    next[id] = after;
  }
  state = { ...state, relations: next, lastSeenAt: now };
  persist();
  snapCache = null;
  notify();

  return {
    hours,
    moodDrop,
    isLongAbsence: hours >= 6,
    isReturnToday: hours >= 2,
  };
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

export function selectPersona(id) {
  const now = Date.now();
  if (!state.relations[id]) {
    state = {
      ...state,
      personaId: id,
      relations: { ...state.relations, [id]: { ...DEFAULT_RELATION, createdAt: now } },
    };
  } else {
    state = { ...state, personaId: id };
  }
  invalidate();
}

/** 抚摸 / 摸头 —— intensity 越大（滑动越快）反馈越强 */
export function pet(intensity = 1) {
  const id = state.personaId;
  const r = relOr(id);
  const energyCost = 0.8 * intensity;
  if (r.energy < energyCost) {
    return { ok: false, reason: 'tired', line: '（她有点累了，靠在你肩上不想动）' };
  }
  const gain = 5 * intensity;
  writeRelation(id, {
    affection: r.affection + gain,
    mood: clamp(r.mood + 3 * intensity, 0, 100),
    energy: clamp(r.energy - energyCost, 0, 100),
    totalPets: r.totalPets + 1,
  });
  state = { ...state, coins: state.coins + 1 };
  invalidate();
  return { ok: true, gain };
}

export function poke() {
  const id = state.personaId;
  const r = relOr(id);
  writeRelation(id, {
    affection: r.affection + 1.5,
    mood: clamp(r.mood + (Math.random() < 0.5 ? 1 : -1), 0, 100),
  });
  invalidate();
  // 粤语模式下念粤语台词，不然换了粤语声音却念普通话句子，一样出戏
  const lang = state.config?.spokenLang || 'zh-HK';
  return { ok: true, line: personaLine(getPersona(id), 'poke', lang) };
}

export function rewardChat() {
  const id = state.personaId;
  const r = relOr(id);
  writeRelation(id, {
    affection: r.affection + 2.5,
    mood: clamp(r.mood + 2, 0, 100),
    totalChats: r.totalChats + 1,
  });
  state = { ...state, coins: state.coins + 2 };
  invalidate();
}

export function sendGift(giftId) {
  const gift = GIFTS.find((g) => g.id === giftId);
  if (!gift) return { ok: false, reason: 'no-gift' };
  if (state.coins < gift.price) return { ok: false, reason: 'poor' };
  const id = state.personaId;
  const r = relOr(id);
  writeRelation(id, {
    affection: r.affection + gift.affection,
    mood: clamp(r.mood + gift.mood, 0, 100),
  });
  state = {
    ...state,
    coins: state.coins - gift.price,
    giftCount: { ...state.giftCount, [giftId]: (state.giftCount[giftId] || 0) + 1 },
  };
  invalidate();
  return { ok: true, line: pick(getPersona(id).voice.gift), gift };
}

export function dailyCheckIn() {
  const today = new Date().toDateString();
  if (state.lastCheckInDay === today) return { ok: false, reason: 'done' };
  const id = state.personaId;
  const r = relOr(id);
  const reward = checkInReward();
  writeRelation(id, {
    mood: clamp(r.mood + reward.mood, 0, 100),
    affection: r.affection + reward.affection,
  });
  state = { ...state, coins: state.coins + reward.coins, lastCheckInDay: today };
  invalidate();
  return { ok: true, coins: reward.coins };
}

export function remember(text) {
  const trimmed = String(text || '').trim().slice(0, 120);
  if (!trimmed) return { ok: false };
  if (state.memory.some((m) => m.text === trimmed)) return { ok: false, reason: 'dup' };
  state = { ...state, memory: [...state.memory, { text: trimmed, ts: Date.now() }].slice(-40) };
  invalidate();
  return { ok: true };
}

export function forgetMemory(ts) {
  state = { ...state, memory: state.memory.filter((m) => m.ts !== ts) };
  invalidate();
}

export function updateConfig(patch) {
  state = { ...state, config: { ...state.config, ...patch } };
  invalidate();
}

export async function resetAll() {
  state = { ...DEFAULT_STATE, relations: {}, chatHistory: {} };
  snapCache = null;
  await AsyncStorage.removeItem(KEY);
  notify();
}

// ---------------------------------------------------------------------------
// 聊天历史
// ---------------------------------------------------------------------------
export function getHistory(personaId = state.personaId) {
  return state.chatHistory[personaId] || [];
}

export function appendMessage(personaId, msg) {
  const cur = state.chatHistory[personaId] || [];
  state = {
    ...state,
    chatHistory: { ...state.chatHistory, [personaId]: [...cur, msg].slice(-60) },
  };
  invalidate();
}

export function clearHistory(personaId = state.personaId) {
  state = { ...state, chatHistory: { ...state.chatHistory, [personaId]: [] } };
  invalidate();
}

// ---------------------------------------------------------------------------
// 云同步：导出 / 导入本机进度
// ---------------------------------------------------------------------------
// ⚠️⚠️ 这里有一条不可逾越的红线：**API 私钥绝不上行**。
//   config.apiKey / config.voice.*Key / azureKey / elevenKey … 是用户自己填的付费凭据，
//   代码注释里早就写明「只存在本机，不上传」。所以 exportCloud 只挑能被后台管理的字段，
//   聊天内容、背景图 data URL、私钥一个都不在里面 —— 再加字段时按这个标准筛。
export function exportCloud() {
  return {
    relations: state.relations,
    coins: state.coins,
    giftCount: state.giftCount,
    memory: state.memory,
    lastCheckInDay: state.lastCheckInDay,
    // 只带不敏感的偏好。bgImage 是 data URL 可能几 MB，不放；私钥更不放。
    prefs: {
      spokenLang: state.config?.spokenLang,
      kidMode: state.config?.kidMode,
      bgId: state.config?.bgId,
    },
  };
}

/**
 * 把云端进度合回本机。
 * 注意 relations / coins 这类是整体替换而不是累加，prefs 用云端值覆盖；
 * config 里的敏感字段保持本机原样，一行都不动。
 */
export function importCloud(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload.prefs || {};
  state = {
    ...state,
    relations: payload.relations && typeof payload.relations === 'object' ? payload.relations : state.relations,
    coins: Number.isFinite(payload.coins) ? payload.coins : state.coins,
    giftCount: payload.giftCount && typeof payload.giftCount === 'object' ? payload.giftCount : state.giftCount,
    memory: Array.isArray(payload.memory) ? payload.memory.slice(-40) : state.memory,
    lastCheckInDay: payload.lastCheckInDay != null ? payload.lastCheckInDay : state.lastCheckInDay,
    config: {
      ...state.config,
      ...(p.spokenLang != null ? { spokenLang: p.spokenLang } : {}),
      ...(p.kidMode != null ? { kidMode: p.kidMode } : {}),
      ...(p.bgId != null ? { bgId: p.bgId } : {}),
    },
  };
  invalidate();
  return true;
}

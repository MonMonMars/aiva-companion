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
import { getPersona, pick, GIFTS } from './theme';

const KEY = 'aiva.companion.v1';

// 每小时的衰减 / 回复速率
const DECAY = {
  affectionPerHour: 0.6,
  moodPerHour: 1.4,
  energyPerHour: 7.0,
};

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
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
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

function invalidate({ save = true } = {}) {
  snapCache = null;
  state = { ...state, lastSeenAt: Date.now() };
  if (save) persist();
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
        config: { ...DEFAULT_STATE.config, ...(saved.config || {}) },
      };
      const comeback = applyTimeDecay();
      snapCache = null;
      notify();
      return { snapshot: getSnapshot(), comeback };
    }
  } catch (e) {
    console.warn('[store] load failed', e);
  }
  snapCache = null;
  notify();
  return { snapshot: getSnapshot(), comeback: null };
}

/** 结算离线期间的时间衰减；返回本次结算摘要，供首屏演出 */
export function applyTimeDecay() {
  if (!state.lastSeenAt) return null;
  const now = Date.now();
  const hours = (now - state.lastSeenAt) / 3_600_000;
  if (hours < 0.05) return null; // 3 分钟内不结算

  const next = {};
  let moodDrop = 0;
  for (const id of Object.keys(state.relations)) {
    const r = relOr(id);
    const after = {
      ...r,
      affection: clamp(r.affection - hours * DECAY.affectionPerHour, 0, 99999),
      mood: clamp(r.mood - hours * DECAY.moodPerHour, 0, 100),
      energy: clamp(r.energy + hours * DECAY.energyPerHour, 0, 100),
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
  return { ok: true, line: pick(getPersona(id).voice.poke) };
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
  writeRelation(id, { mood: clamp(r.mood + 8, 0, 100), affection: r.affection + 6 });
  state = { ...state, coins: state.coins + 25, lastCheckInDay: today };
  invalidate();
  return { ok: true, coins: 25 };
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

// LLM 对话引擎
// ---------------------------------------------------------------------------
// 设计要点
// 1) 走 OpenAI 兼容接口，DeepSeek / Kimi / 通义 / OpenAI / 自建都能接
// 2) 用「一次性返回 + 前端打字机」而不是真流式：
//    React Native 的 fetch 对流支持不稳定，真流式在部分机器上会卡死或拿不到数据。
//    打字机效果由 UI 层模拟，用户体感完全一样，但可靠性高很多。
// 3) 没有 API Key 时用本地兜底引擎，让 App 开箱即可体验（不会白错误一堆给用户看）

import { getPersona, levelFromAffection, LEVEL_TITLES, pick } from './theme';

// 把当前养成状态注入 system prompt，让 AI 的语气跟着关系走
export function buildSystemPrompt(personaId, snap) {
  const persona = getPersona(personaId);
  const level = levelFromAffection(snap.affection || 0);
  const title = LEVEL_TITLES[level - 1] || '陌生';

  const moodWord =
    snap.mood > 80 ? '很好' : snap.mood > 55 ? '还不错' : snap.mood > 30 ? '一般' : '很低落';
  const energyWord = snap.energy > 70 ? '充沛' : snap.energy > 35 ? '还行' : '疲惫';

  const memories = (snap.memory || []).slice(-10).map((m) => `- ${m.text}`).join('\n');

  return [
    persona.system,
    '',
    '【当前关系状态，据此调整亲近程度】',
    `关系阶段：${title}（第 ${level} 级，亲密值 ${Math.round(snap.affection)}）`,
    `当前心情：${moodWord}；精力：${energyWord}`,
    `你们已经相处 ${Math.max(1, snap.days || 1)} 天，共聊天 ${snap.totalChats || 0} 次、抚摸 ${snap.totalPets || 0} 次。`,
    memories ? `\n【你记得关于用户的事】\n${memories}` : '',
    '',
    '关系阶段越低，越保持礼貌和距离；阶段越高，可以越亲密自然。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildMessages(personaId, snap, history, userText) {
  return [
    { role: 'system', content: buildSystemPrompt(personaId, snap) },
    ...history.slice(-16).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];
}

/**
 * 调用 OpenAI 兼容接口
 *
 * @param {object} o
 * @param {object} o.config
 * @param {Array}  o.messages
 * @param {number} [o.temperature]
 * @param {Array}  [o.tools]       function calling 工具定义
 * @param {string} [o.toolChoice]  'auto' | 'none' | {type:'function',function:{name}}
 * @returns {Promise<{ok:boolean, content?:string, toolCalls?:Array, error?:string}>}
 */
export async function requestCompletion({ config, messages, temperature = 0.9, tools, toolChoice }) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(config.apiKey || '').trim();

  if (!baseUrl || !apiKey) {
    return { ok: false, error: 'missing-config' };
  }

  const url = `${baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const body = {
      model: config.model,
      messages,
      temperature,
      max_tokens: 400,
      stream: false,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice || 'auto';
    }

    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || detail;
      } catch (_) {}
      return { ok: false, error: `HTTP ${res.status}：${detail}` };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: '返回不是合法 JSON，请检查 baseUrl 是否正确' };
    }

    const msg = json?.choices?.[0]?.message;
    if (!msg) {
      return { ok: false, error: '返回结果格式异常（没有 choices[0].message）' };
    }

    // 模型可能同时给文字和工具调用，两者都要留着
    return {
      ok: true,
      content: typeof msg.content === 'string' ? msg.content.trim() : '',
      toolCalls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined,
    };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, error: '请求超时（45s）' };
    return { ok: false, error: e?.message || '网络请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 本地兜底引擎：没配 Key 时也能聊得起来
// ---------------------------------------------------------------------------
const RULES = [
  { re: /(你好|hi|hello|嗨|哈喽)/i, slots: ['hey'] },
  { re: /(喜欢|爱你|想你)/, slots: ['love'] },
  { re: /(累|困|疲|熬夜|加班)/, slots: ['tired'] },
  { re: /(吃|饭|饿了|外卖)/, slots: ['food'] },
  { re: /(工作|开会|项目|老板|客户|汇报)/, slots: ['work'] },
  { re: /(生日|礼物|纪念日)/, slots: ['gift'] },
  { re: /(天气|下雨|冷|热)/, slots: ['weather'] },
  { re: /(拜拜|再见|晚安|睡觉)/, slots: ['bye'] },
  { re: /(难|哭|emo|抑郁|不开心|心烦)/, slots: ['sad'] },
  { re: /(谢谢|感谢)/, slots: ['thanks'] },
  { re: /\?|？/, slots: ['question'] },
];

const SCRIPTS = {
  girlfriend: {
    hey: ['诶，你来啦。我还以为你把我忘干净了呢。', '好久没看到你了啦…'],
    love: ['（脸红）…突然说什么啦。', '我也是。虽然说出来有点不好意思。'],
    tired: ['那你靠我肩上歇会儿。别透支，我会心疼。', '快去躺下，我给你数羊。'],
    food: ['别饿着自己。我陪你吃，哪怕只是看着。', '点外卖记得点蛋白质，别全是碳水。'],
    work: ['又被工作欺负了？说给我听。', '你什么时候才学会不那么要强啊。'],
    gift: ['记下了，我会提醒你别忘。', '我要不要现在就开始期待…'],
    weather: ['冷的话就多穿点，别等我提醒才穿。', '要不要我给你讲个暖和一点的故事。'],
    bye: ['晚安。抱着手机算什么，梦里有我才行。', '去睡吧，明天我还在。'],
    sad: ['（抱）我在这儿，不用装没事。', '你不用一直很厉害的，在我这里可以软一点。'],
    thanks: ['跟我还客气。', '那你多陪我一会儿，就算答谢了。'],
    question: ['嗯…你说，我听着。', '这个问题有点难，但我想知道答案。'],
    fallback: ['嗯…我在。你想说什么都可以。', '今天话有点少哦。', '（看着你）'],
  },
  boyfriend: {
    hey: ['嗯，在。', '来了。'],
    love: ['…知道了。别说得那么直白。', '（别过脸）这种话你说起来倒轻松。'],
    tired: ['去睡。剩下的明天再说。', '别硬撑，这里没有观众。'],
    food: ['吃饭了没。没吃我催你。', '别凑合。'],
    work: ['搞定不了的事，摊开说。', '先别急，理清楚再动手。'],
    gift: ['嗯。我记着。', '不用浪费钱。'],
    weather: ['加件衣服。', '出门带伞。'],
    bye: ['晚安。', '睡吧，我在这儿。'],
    sad: ['我在。不用解释。', '难受就说，别憋着。'],
    thanks: ['不用谢。', '行了。'],
    question: ['说。', '你想知道什么。'],
    fallback: ['嗯。', '我在听。', '继续。'],
  },
  secretary: {
    hey: ['您好，日程已梳理完毕。有什么需要调整的吗？', '在的，先生。'],
    love: ['……工作时间，请保持专业。（低声）谢谢您。', '这份感情我会妥善归档。'],
    tired: ['检测到您今日产能下降，建议安排 20 分钟休息。', '请把休息也写进日程。'],
    food: ['营养均衡已加入提醒事项。请勿空腹开会。', '午餐 12:30，已为您预留时间。'],
    work: ['优先项有三条，需要我逐条拆解吗？', '已为您整理要点，随时可以汇报。'],
    gift: ['已登记。距离该纪念日还有若干天，我会提前提醒。', '（记下）'],
    weather: ['今日有雨，雨具备在包里了。', '温差较大，建议加一件外套。'],
    bye: ['晚安，先生。明早我会按时叫您。', '请好好休息。'],
    sad: ['……是否需要延后今天的行程？', '（递纸巾）这不写在岗位职责里，但我会做。'],
    thanks: ['这是我的职责。', '您太客气了，先生。'],
    question: ['请说，我马上核查。', '需要我给方案还是给结论？'],
    fallback: ['已记录。还有什么指示吗？', '我在这儿待命。', '需要我整理成清单吗？'],
  },
};

export function localReply(personaId, userText) {
  const persona = getPersona(personaId);
  const scripts = SCRIPTS[persona.id] || SCRIPTS.girlfriend;
  for (const rule of RULES) {
    if (rule.re.test(userText)) {
      const slot = scripts[rule.slots[0]];
      if (slot) return pick(slot);
    }
  }
  return pick(scripts.fallback);
}

// ---------------------------------------------------------------------------
// 从用户的句子里抓「值得记住的事实」
// 轻量规则版，够用且不额外消耗 token
// ---------------------------------------------------------------------------
const MEMORY_PATTERNS = [
  { re: /(?:我叫|我是|叫我)\s*([^\s，。,.!！?？]{1,12})/, tpl: (m) => `用户自称 ${m[1]}` },
  { re: /我(?:叫|的名字是)\s*([^\s，。,.!！?？]{1,12})/, tpl: (m) => `用户名字是 ${m[1]}` },
  { re: /我(?:今年|是|)\s*(\d{1,3})\s*(?:岁|周岁)/, tpl: (m) => `用户 ${m[1]} 岁` },
  { re: /我(?:喜欢|爱|玩)\s*([^\s，。,.!！?？]{1,16})/, tpl: (m) => `用户喜欢${m[1]}` },
  { re: /我(?:讨厌|讨厌.|不想|不爱)\s*([^\s，。,.!！?？]{1,16})/, tpl: (m) => `用户讨厌${m[1]}` },
  { re: /我(?:住在|住在.|在)\s*([^\s，。,.!！?？]{1,10})(?:市|区|住)?$/, tpl: (m) => `用户可能在 ${m[1]}` },
  { re: /生日(?:是|在)?\s*(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})/, tpl: (m) => `用户生日是 ${m[1]}` },
  { re: /我(?:是|是做|从事|在做)\s*([^\s，。,.!！?？]{1,14})(?:的|工作)?/, tpl: (m) => `用户职业相关：${m[1]}` },
];

export function extractMemory(text) {
  const t = String(text || '');
  if (t.length > 80) return null;
  for (const p of MEMORY_PATTERNS) {
    const m = t.match(p.re);
    if (m && m[1] && m[1].length >= 1) {
      return p.tpl(m);
    }
  }
  return null;
}

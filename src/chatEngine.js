// 带工具调用（function calling）的对话层
// ---------------------------------------------------------------------------
// 相比原来 llm.js 的「一问一答」，这里多了个循环：
//   模型说"我要查天气" → 我们真的去查 → 把结果塞回去 → 模型再组织成自然语言
// 这样角色才会说「我刚查了一下，香港现在 26 度」而不是瞎编一个温度。
//
// 循环最多 MAX_ROUNDS 轮，防止模型死循环反复调用工具把额度烧光。

import { buildSystemPrompt, requestCompletion, localReply } from './llm';
import { TOOL_SCHEMAS, runTool, guessTool } from './services/tools';
import { getPersona } from './theme';

const MAX_ROUNDS = 3;

// 告诉模型：你的回答是要被**念出来**的，所以不要 Markdown、不要列表，
// 并且可以在合适的位置插入情绪标记（[]）。这是"听起来像人"的一半功劳在这里。
const SPEECH_RULES = `
【极其重要的输出规则】
你的回复会被直接朗读给用户听，因此：
1. 只用纯文本。不要用 Markdown、不用列表符号、不用标题、不用代码块、不要用括号写注释。
2. 在合适的位置插入情绪标记，格式如 [laughs]、[giggles]、[gentle]，让朗读更有感情。可用的标记：
   [laughs] 笑 / [giggles] 偷笑 / [sighs] 叹气 / [excited] 兴奋 / [comfort] 安慰
   [gentle] 温柔 / [sad] 难过 / [shy] 害羞 / [whispers] 耳语 / [surprised] 惊讶
   [curious] 好奇 / [serious] 认真 / [sing] 唱歌 / [teach] 讲解小孩子时
   [proud] 骄傲 / [sleepy] 困倦
   标记放在你要用这种语气说的那句话前面。不要滥用，一次回复 1-3 个就够。
3. 长度控制在 60 字以内 —— 这是对话，不是写文章。
4. 数字、单位要说人话：「26 度」而不是「26°C」。
`;

const KID_RULES = `
【现在是儿童模式】
你在和一个孩子说话。请：
1. 用具体的、看得见的比喻，不要抽象概念。解释科学时用日常生活中有的东西打比方。
2. 句子要短，一次只说一件事。随时可以停下来等他回应。
3. 多鼓励，多好奇。他说错的时候不要否定，先肯定他在思考，再轻轻补正。
4. 绝不提任何恐怖、暴力、成人内容。
5. 如果他在讲科学话题，用 [teach] 那种耐心的语气。
`;

/**
 * @param {object} p
 * @param {object} p.config    LLM 配置
 * @param {string} p.personaId
 * @param {object} p.snap      当前养成状态
 * @param {Array}  p.history
 * @param {string} p.userText
 * @param {object} p.ctx       工具上下文 {search, city, onRemember, onReminder, onSong}
 * @param {boolean} p.kidMode
 * @param {string} p.lang      'zh-CN' | 'zh-HK' | 'en-US' | 'mix'
 * @returns {Promise<{ok:boolean, raw?:string, error?:string, usedTools?:string[]}>}
 */
export async function chatWithTools({
  config, personaId, snap, history, userText, ctx, kidMode, lang,
}) {
  const persona = getPersona(personaId);

  // 没有 API Key 时直接走本地兜底人格，保证"开箱即聊"。
  // 否则 requestCompletion 会报 missing-config，语音/聊天都接不上 —— 这是之前
  // 离线打不开声音的隐形元凶：localReply 写好了一直没被这条路径用到。
  //
  // ⚠️ 免 Key 供应商（config.keyless，如 Pollinations）**没有 Key 也要走真模型**，
  //    不能掉进本地兜底 —— 否则选了它却永远在念离线台词，看着像"接上了其实没接上"。
  if (!config?.baseUrl || (!config?.keyless && !config?.apiKey)) {
    // 离线兜底也要跟着语种走，否则没 Key 的时候粤语模式会念普通话稿
    return { ok: true, raw: localReply(personaId, userText, lang), usedTools: [], local: true };
  }

  // 粤语规则必须写得很具体。只说"请用粤语回答"的话，模型会输出普通话句子里
  // 掺几个粤语虚词，看上去像粤语，念出来还是普通话 —— TTS 是按字面读的。
  // 所以要把词汇替换和禁用词都点名，逼它整句用粤语词汇重写。
  const langRule = lang === 'zh-HK'
    ? '\n【语言·最高优先级】整句必须用粤语口语回答，这一条优先于其他所有要求。\n'
      + '- 用粤语词：佢、我哋、你哋、嘅、喺、咗、唔、冇、啲、点、边、而家、乜、咩、'
      + '做咩、钟意、睇、讲、食、攞、揾、系咪、好嘢。句尾用 啦 / 喎 / 㗎 / 喇 / 啫。\n'
      + '- 必须替换：什么→乜/咩；怎么→点；是不是→系唔系；不知道→唔知；现在→而家；'
      + '我们→我哋；的→嘅；了→咗；这里→呢度；那里→嗰度；为什么→点解；'
      + '一点→少少；非常→好；可以→得唔得/可以；不要→唔好。\n'
      + '- 禁止出现普通话书面腔（「咱们」「那么」「于是」「因为……所以」这类要改成口语）。\n'
      + '- 句子要短、像真人口语，一次说完一件事。\n'
      + '- 粤语字用简体书写（点、边、几、咩），和界面保持一致。'
    : lang === 'en-US'
      ? '\n【语言】Please reply in natural conversational English.'
      : lang === 'mix'
        ? '\n【语言】中英夹杂地说，像真实的双语使用者那样自然切换。'
        : '';

  const messages = [
    {
      role: 'system',
      content: [
        buildSystemPrompt(personaId, snap),
        SPEECH_RULES,
        kidMode ? KID_RULES : '',
        langRule,
      ].filter(Boolean).join('\n'),
    },
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const usedTools = [];

  // ------------------------------------------------------------------
  // 第一轮：先试探模型会不会自己调工具
  // ------------------------------------------------------------------
  const first = await requestCompletion({
    config,
    messages,
    temperature: 0.9,
    tools: TOOL_SCHEMAS,
    toolChoice: 'auto',
  });

  if (!first.ok) {
    // 有些模型完全不认 tools 字段，会直接报错。这时退化到关键词猜测，
    // 至少天气/搜索这种高频需求还能用。
    if (/tool|parameter|unsupported|400/i.test(first.error || '')) {
      return fallbackWithGuess({ config, messages, userText, ctx, usedTools });
    }
    return { ok: false, error: first.error };
  }

  // 模型没想用工具 —— 正常情况下直接返回文字就行
  if (!first.toolCalls?.length) {
    return { ok: true, raw: first.content, usedTools };
  }

  // ------------------------------------------------------------------
  // 执行工具，把结果喂回去，让模型组织成自然语言
  // ------------------------------------------------------------------
  let current = first;
  let rounds = 0;

  while (current.toolCalls?.length && rounds < MAX_ROUNDS) {
    rounds++;
    const assistantMsg = {
      role: 'assistant',
      content: current.content || '',
      tool_calls: current.toolCalls,
    };
    messages.push(assistantMsg);

    for (const call of current.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch (_) {}
      usedTools.push(call.function?.name);
      const result = await runTool(call.function?.name, args, ctx);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function?.name,
        content: result.text || '（没有返回结果）',
      });
    }

    const next = await requestCompletion({
      config,
      messages,
      temperature: 0.85,
      tools: TOOL_SCHEMAS,
      toolChoice: 'auto',
    });
    if (!next.ok) {
      // 第二轮崩了也别让用户白等 —— 把工具结果用大白话说出来
      return { ok: true, raw: summarizeResults(messages), usedTools };
    }
    current = next;
  }

  return { ok: true, raw: current.content || summarizeResults(messages), usedTools };
}

/** 把上一轮工具执行的结果拼成一段能念的话（模型挂了时的兜底） */
function summarizeResults(messages) {
  const toolMsgs = messages.filter((m) => m.role === 'tool' && m.content).slice(-3);
  if (!toolMsgs.length) return '嗯…刚才没接上，你再说一次？';
  return toolMsgs.map((m) => m.content).join('\n').slice(0, 300);
}

/** 模型不支持 function calling：用关键词猜该调哪个工具 */
async function fallbackWithGuess({ config, messages, userText, ctx, usedTools }) {
  const guess = guessTool(userText, ctx.city);
  if (!guess) {
    const plain = await requestCompletion({ config, messages, temperature: 0.9 });
    return plain.ok ? { ok: true, raw: plain.content, usedTools } : plain;
  }

  usedTools.push(guess.tool);
  const result = await runTool(guess.tool, guess.args, ctx);
  messages.push({
    role: 'user',
    content: `（以下是联网/工具查到的真实信息，请据此用你自己的话自然地说出来，不要说"根据资料"）\n${result.text}`,
  });
  const final = await requestCompletion({ config, messages, temperature: 0.85 });
  return final.ok ? { ok: true, raw: final.content, usedTools } : final;
}

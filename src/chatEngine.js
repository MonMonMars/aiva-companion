// 带工具调用（function calling）的对话层
// ---------------------------------------------------------------------------
// 相比原来 llm.js 的「一问一答」，这里多了个循环：
//   模型说"我要查天气" → 我们真的去查 → 把结果塞回去 → 模型再组织成自然语言
// 这样角色才会说「我刚查了一下，香港现在 26 度」而不是瞎编一个温度。
//
// 循环最多 MAX_ROUNDS 轮，防止模型死循环反复调用工具把额度烧光。

import { buildSystemPrompt, requestCompletion } from './llm';
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

  const langRule = lang === 'zh-HK'
    ? '\n【语言】请用粤语口语回答（例如「佢」「嘅」「喺」「咗」），不要用书面普通话。'
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

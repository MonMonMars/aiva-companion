// 给大模型的「工具箱」
// ---------------------------------------------------------------------------
// 为什么用 function calling 而不是直接把搜索结果塞进 System Prompt：
//  1. 只有需要时才联网 —— 聊家常不用浪费搜索额度
//  2. 模型自己决定查什么、什么时候查 —— 才能形成"我先查一下天气再回答你"这种自然对话
//  3. 换搜索引擎不影响角色逻辑 —— 三家都收编成同一个 web_search
//
// 注意：部分模型（比如 DeepSeek 早期版本）工具调用不稳定。
// runTools 里做了兜底：模型不支持工具时会退化成关键词触发（见 FALLBACK_RULES）。

import { webSearch, getWeather, weatherToSpeech } from './web';

/** OpenAI function calling 格式的工具定义 */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索。当用户问新闻、时事、某个事实、某个知识点、最新信息，或者你需要核实内容时使用。' +
        '不要用它查天气（用 get_weather）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，要具体。尽量用用户关心的那个实体的名称。' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询某地当前天气和未来三天预报。用户提到天气、气温、下雨、要不要带伞时使用。',
      parameters: {
        type: 'object',
        properties: {
          place: { type: 'string', description: '城市或地点名称，例如「香港」「东京」「尖沙咀」。' },
        },
        required: ['place'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: '记住关于用户的一个重要事实，以后对话会用得上。比如名字、年龄、喜好、家人、重要日期。',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: '要记住的内容，用简短的一句话。' },
        },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '给用户设置一个提醒。当用户说"提醒我…""别忘了…""X 分钟后叫我…"时使用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '提醒的内容' },
          delayMinutes: { type: 'number', description: '多少分钟后提醒。如果用户没说时间，默认 10 分钟。' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_song',
      description: '用户想听歌、想唱歌、想一起唱歌时使用。会播放一段简单的旋律并让角色跟着唱。',
      parameters: {
        type: 'object',
        properties: {
          song: {
            type: 'string',
            description: '歌名或描述，例如「小星星」「生日快乐」「随便唱一首」。',
          },
        },
        required: ['song'],
      },
    },
  },
];

/**
 * 执行一个工具调用
 * @param {string} name
 * @param {object} args
 * @param {{search:{provider,keys}, city:string, onRemember:(f:string)=>void,
 *          onReminder:(t:string, m:number)=>Promise<string>,
 *          onSong:(s:string)=>Promise<string>}} ctx
 */
export async function runTool(name, args, ctx) {
  switch (name) {
    case 'web_search': {
      const r = await webSearch(ctx.search, args?.query || '', 5);
      if (!r.ok) return { ok: false, text: `搜索失败：${r.error}。请用你自己的知识回答，并说明你没法确认最新信息。` };
      const lines = [];
      if (r.answer) lines.push(`摘要：${r.answer}`);
      (r.hits || []).slice(0, 5).forEach((h, i) => {
        lines.push(`${i + 1}. ${h.title}\n   ${String(h.snippet || '').slice(0, 220)}`);
      });
      return { ok: true, text: lines.join('\n') || '没有搜到结果。' };
    }

    case 'get_weather': {
      const place = args?.place || ctx.city || '香港';
      const r = await getWeather(place);
      if (!r.ok) return { ok: false, text: `天气查询失败：${r.error}` };
      // 既给结构化数据也给口语版，方便角色直接念
      return { ok: true, text: weatherToSpeech(r) };
    }

    case 'remember_fact': {
      const fact = String(args?.fact || '').trim();
      if (!fact) return { ok: false, text: '没有内容可记。' };
      ctx.onRemember?.(fact);
      return { ok: true, text: `已记住：${fact}` };
    }

    case 'set_reminder': {
      const title = String(args?.title || '').trim();
      const minutes = Number(args?.delayMinutes) || 10;
      if (!title) return { ok: false, text: '不知道要提醒什么。' };
      const msg = (await ctx.onReminder?.(title, minutes)) || null;
      return { ok: true, text: msg || `已设置提醒：${minutes} 分钟后提醒你「${title}」` };
    }

    case 'start_song': {
      const song = String(args?.song || '').trim();
      const msg = (await ctx.onSong?.(song)) || null;
      return { ok: true, text: msg || `已开始播放歌曲：${song || '随机一首'}` };
    }

    default:
      return { ok: false, text: `未知工具 ${name}` };
  }
}

// ---------------------------------------------------------------------------
// 兜底：模型不支持 function calling 时，用关键词判断该用哪个工具。
// 宁可这样凑出一个还行的答案，也不要让角色一脸「我不知道」。
// ---------------------------------------------------------------------------
const FALLBACK_RULES = [
  { re: /(天气|气温|几度|下雨|下雪|要不要带伞|冷吗|热吗)/, tool: 'get_weather', arg: (t) => extractPlace(t) },
  { re: /(新闻|最新|刚刚|今天发生|最近有什么|搜索|查一下|什么是|为什么|告诉我关于)/, tool: 'web_search', arg: (t) => t },
  { re: /(提醒我|别忘了|记得叫我|分钟后|分钟后叫我)/, tool: 'set_reminder', arg: (t) => t },
  { re: /(唱首歌|唱歌|听歌|儿歌|音乐)/, tool: 'start_song', arg: () => '' },
];

function extractPlace(text) {
  // 「香港天气怎么样」→ 香港。宁可能抽出来也不要全句塞进去（那样搜索是无效的）
  const m = text.match(/([\u4e00-\u9fa5A-Za-z]{2,8})(?:的?天气|那边|那边天气)/);
  if (m) return m[1];
  // 反过来：「天气香港」
  const m2 = text.match(/(?:天气|气温)(?:怎么样|如何)?(?:在)?([\u4e00-\u9fa5A-Za-z]{2,8})/);
  if (m2) return m2[1];
  return null;
}

/** @returns {{tool:string, args:object}|null} */
export function guessTool(userText, ctxCity) {
  const t = String(userText || '');
  for (const rule of FALLBACK_RULES) {
    if (rule.re.test(t)) {
      const a = rule.arg(t);
      if (rule.tool === 'get_weather') {
        return { tool: 'get_weather', args: { place: a || ctxCity || '' } };
      }
      if (rule.tool === 'set_reminder') {
        const mins = t.match(/(\d+)\s*(?:分钟|分)/);
        return { tool: 'set_reminder', args: { title: t.replace(/提醒我|别忘了|记得叫我/g, '').trim(), delayMinutes: mins ? Number(mins[1]) : 10 } };
      }
      if (rule.tool === 'start_song') return { tool: 'start_song', args: { song: t } };
      return { tool: 'web_search', args: { query: String(a || t).slice(0, 120) } };
    }
  }
  return null;
}

// 你在哪个国家 → 该推荐哪家听写服务（STT）
// ---------------------------------------------------------------------------
// 为什么要有这个文件
//   这个 App 是公开部署、面向**全世界**的。而"能不能听懂粤语"这件事，
//   在不同国家的答案完全不同 —— 不是技术好坏的差别，是各家云服务的
//   **合规 / 制裁地区名单**。默认给一家"作者所在地能用"的服务，
//   等于让地球另一半的人一开口就失败，而且失败信息还是一句英文 400。
//
//   我们的请求是**从用户手机直接打到服务商**的（中间不经过我们任何服务器），
//   所以决定命运的是用户手机的**网络出口 IP**。这跟 Google Colab 那句提示
//   是同一套逻辑 —— "Region restrictions are applied based on the region that
//   the instance is in, not the region that the user is in"：看的是流量从哪儿
//   出去，不是账号注册在哪儿。所以这里照做：查出口 IP 属于哪个国家再决定。
//
// 截至 2026-09 的硬事实（都是官方口径，不是猜的）
//   ① Google Gemini：官方 available-regions 名单里**没有**
//       中国大陆 / 香港 / 澳门 / 俄罗斯 / 白俄罗斯 / 伊朗 / 朝鲜 / 古巴 / 叙利亚
//     报错原文："User location is not supported for the API use."
//   ② Google 附加服务条款：向**欧洲经济区（EEA）、瑞士、英国**的用户提供服务时
//       **只能使用付费服务**。Google 官方论坛里 Google 员工明确回复过这条，
//       并被追问"用 IP 判断地区可以吗"，回答是"IP 是主要信号"。
//       → 这几个地方**免费层不能算能用**，对我们这种免注册的 App 等于不可用。
//   ③ ElevenLabs：只封锁 白俄罗斯 / 古巴 / 伊朗 / 朝鲜 / 俄罗斯 / 叙利亚
//       （外加克里米亚、顿涅茨克、卢甘斯克）。**香港不在其中**，绝大多数国家可用。
//
//   → 结论：**全世界范围内最稳的是 ElevenLabs**；Gemini 只在
//     「在 Google 名单内 **且** 不在 EEA/瑞士/英国」的地方才值得当首选。
//     所以下面 bestSttFor() 的排序是 Gemini → ElevenLabs → Azure，
//     而代码里的**硬默认仍然是 elevenlabs**（见 store.js）——
//     宁可让人少拿点免费额度，也不能让人一开口就是死的。
//
// ⚠️ 隐私：查地区要发一次请求给第三方（Cloudflare / ipwho.is）。
//    只取国家代码，不取精确坐标，结果在本机缓存 7 天，失败就当"不知道"。
//    宁可推荐保守，也不要为了推荐而纠缠用户。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as S from '../store';

// ---------------------------------------------------------------------------
// 地区名单
// ---------------------------------------------------------------------------

/** Google 名单里根本没有的地区 —— 请求直接被拒 */
export const GEMINI_BLOCKED = ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'CU', 'SY'];

/** 欧洲经济区（含冰岛 / 列支敦士登 / 挪威） */
export const EEA = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
];

/** 条款禁止用免费层服务这些地方的用户：EEA + 英国 + 瑞士 */
export const GEMINI_NO_FREE = [...EEA, 'GB', 'CH'];

/** ElevenLabs 封锁的地区（制裁名单，全世界绝大多数地方不在内） */
export const ELEVEN_BLOCKED = ['BY', 'CU', 'IR', 'KP', 'RU', 'SY'];

/** 硅基流动：免费模型强制中国实名认证，非中国居民根本走不通 → 只在中国内地推荐 */
export const SILICON_ONLY = ['CN'];

/** 这几家都在制裁名单上，几乎没有任何云服务商可用 —— 要如实告诉用户 */
export const SANCTIONED = ['BY', 'CU', 'IR', 'KP', 'RU', 'SY'];

// 常见国家/地区的中文名。查不到的就只显示代码，不瞎编
export const CC_NAME = {
  CN: '中国内地', HK: '香港', MO: '澳门', TW: '台湾',
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国',
  VN: '越南', ID: '印尼', PH: '菲律宾', IN: '印度', AU: '澳大利亚',
  NZ: '新西兰', US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西',
  AR: '阿根廷', CL: '智利', GB: '英国', IE: '爱尔兰', FR: '法国',
  DE: '德国', NL: '荷兰', BE: '比利时', ES: '西班牙', PT: '葡萄牙',
  IT: '意大利', CH: '瑞士', AT: '奥地利', SE: '瑞典', NO: '挪威',
  DK: '丹麦', FI: '芬兰', PL: '波兰', CZ: '捷克', GR: '希腊',
  ZA: '南非', NG: '尼日利亚', KE: '肯尼亚', EG: '埃及',
  AE: '阿联酋', SA: '沙特', IL: '以色列', TR: '土耳其',
  RU: '俄罗斯', BY: '白俄罗斯', IR: '伊朗', KP: '朝鲜',
  CU: '古巴', SY: '叙利亚', UA: '乌克兰',
};

export const ccName = (cc) => CC_NAME[cc] || cc || '未知';

// ---------------------------------------------------------------------------
// 探测：我现在的网络出口在哪个国家
// ---------------------------------------------------------------------------

const GEO_KEY = 'aiva.geo.v1';
const GEO_TTL = 7 * 24 * 3600 * 1000; // 缓存 7 天，别每次开 App 都去问一次

let geoCache = null; // { cc, ts, src }
let pending = null;

/** 给 fetch 套一个超时。RN 的 fetch 不认 AbortSignal 时也能靠 Promise.race 兜住 */
function withTimeout(ms) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  return { signal: ctl?.signal, done: () => t && clearTimeout(t) };
}

async function getText(url, ms) {
  const { signal, done } = withTimeout(ms);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return '';
    return await res.text();
  } finally {
    done();
  }
}

/** 三个源都实测过带 `Access-Control-Allow-Origin: *`，浏览器里能直接读 */
const SOURCES = [
  {
    // Cloudflare 的边缘调试端点：最快、无配额、不带任何个人信息，只回一行 loc=XX
    src: 'cloudflare',
    ms: 1400,
    parse: (t) => (t.match(/^loc=([A-Z]{2})$/m) || [])[1] || '',
  },
  {
    src: 'ipwho.is',
    ms: 1600,
    parse: (t) => {
      try { return JSON.parse(t)?.country_code || ''; } catch (_) { return ''; }
    },
  },
  {
    src: 'ipinfo.io',
    ms: 1600,
    parse: (t) => {
      try { return JSON.parse(t)?.country || ''; } catch (_) { return ''; }
    },
  },
];

const URLS = [
  'https://cloudflare.com/cdn-cgi/trace',
  'https://ipwho.is/',
  'https://ipinfo.io/json',
];

/**
 * 网络探测失败时的兜底：只认几个没有歧义的时区 → 国家映射。
 * 不硬猜更多 —— 时区到国家本来就是一对多（比如 Asia/Shanghai 也覆盖蒙古一部分），
 * 瞎猜只会给人一个错的推荐，还不如老实说"没测出来"。
 */
const TZ_HINT = {
  'Asia/Shanghai': 'CN', 'Asia/Chongqing': 'CN', 'Asia/Harbin': 'CN', 'Asia/Urumqi': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Macau': 'MO',
  'Asia/Taipei': 'TW',
};

function tzGuess() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TZ_HINT[tz] || '';
  } catch (_) {
    return '';
  }
}

async function probe(maxMs) {
  const started = Date.now();
  for (let i = 0; i < SOURCES.length; i++) {
    const left = maxMs - (Date.now() - started);
    if (left < 150) break;
    const cc = SOURCES[i].parse(await getText(URLS[i], Math.min(SOURCES[i].ms, left)) || '');
    if (cc && /^[A-Z]{2}$/.test(cc)) return { cc, src: SOURCES[i].src };
  }
  const guess = tzGuess();
  return guess ? { cc: guess, src: 'timezone' } : { cc: '', src: '' };
}

/**
 * 探测当前网络出口所在国家。有 7 天缓存，第二次调用基本是同步返回。
 * 任何失败都返回 ''（"不知道"），**绝不抛错** —— 探测只是锦上添花，
 * 挡住启动或者弹个报错都是本末倒置。
 * @param {{maxMs?:number}} opt
 * @returns {Promise<string>} 两位国家代码，或 ''
 */
export async function detectCountry({ maxMs = 2400 } = {}) {
  if (geoCache && Date.now() - geoCache.ts < GEO_TTL) return geoCache.cc;
  if (pending) return pending;

  pending = (async () => {
    let cc = '';
    let src = '';
    try {
      // 先把上次缓存读出来：就算过期了，也比"完全不知道"强
      if (!geoCache) {
        try {
          const raw = await AsyncStorage.getItem(GEO_KEY);
          if (raw) {
            const j = JSON.parse(raw);
            if (j?.cc) { geoCache = { cc: j.cc, ts: j.ts || 0, src: j.src || '' }; }
          }
        } catch (_) {}
      }
      if (geoCache && Date.now() - geoCache.ts < GEO_TTL) return geoCache.cc;

      const r = await probe(maxMs);
      cc = r.cc || geoCache?.cc || '';
      src = r.src || geoCache?.src || '';
      geoCache = { cc, ts: cc ? Date.now() : 0, src };
      if (cc) {
        try { await AsyncStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); } catch (_) {}
      }
      return cc;
    } catch (_) {
      return geoCache?.cc || '';
    } finally {
      pending = null;
    }
  })();

  return pending;
}

/** 同步读缓存（可能还没探测完，返回 ''）。给不能 await 的地方用 */
export function currentCountry() {
  return geoCache?.cc || '';
}

// ---------------------------------------------------------------------------
// 判断：某家服务在某个国家能不能用
// ---------------------------------------------------------------------------

/**
 * @returns {{level:'ok'|'blocked'|'nofree'|'unknown', msg:string}}
 *   ok      完全能用
 *   blocked 这个国家直接被拒（或像硅基流动那样根本申请不到）
 *   nofree  地区允许，但条款禁止对这里的用户用免费层 → 对我们等于不可用
 *   unknown 不知道在哪 / 没维护这份名单，不吓唬人
 */
export function sttStatus(cc, id) {
  const c = String(cc || '').toUpperCase();
  if (!c) return { level: 'unknown', msg: '' };

  if (id === 'gemini') {
    if (GEMINI_BLOCKED.includes(c)) {
      return {
        level: 'blocked',
        msg: 'Google 的可用地区名单里没有' + ccName(c) + '，Gemini 在这里直接被拒绝。',
      };
    }
    if (GEMINI_NO_FREE.includes(c)) {
      return {
        level: 'nofree',
        msg: ccName(c) + '能用 Gemini，但 Google 条款规定：向这个地区的用户提供服务'
          + '只能用**付费**服务，免费层不合规。要用就得去 Google Cloud 开账单。',
      };
    }
    return { level: 'ok', msg: '' };
  }

  if (id === 'elevenlabs') {
    if (ELEVEN_BLOCKED.includes(c)) {
      return { level: 'blocked', msg: 'ElevenLabs 不服务' + ccName(c) + '（制裁名单）。' };
    }
    return { level: 'ok', msg: '' };
  }

  if (id === 'siliconflow') {
    // 不是地区封锁，是**申请门槛**：免费模型强制中国实名认证，只认中国身份证件
    if (!SILICON_ONLY.includes(c)) {
      return {
        level: 'blocked',
        msg: '硅基流动的免费模型强制中国实名认证，外国护照无法在线验证 —— 非中国居民别选这家。',
      };
    }
    return { level: 'ok', msg: '' };
  }

  // Azure / Groq / OpenAI：各自也都有不支持的国家清单，但边界变动频繁，
  // 这里不硬编 —— 报 unknown，让「检查这家通不通」按钮去实测，不吓唬用户。
  return { level: 'unknown', msg: '' };
}

/** 这家在这个国家**能不能当作推荐项**（unknown 也算能，只是没把握） */
export const sttUsable = (cc, id) => sttStatus(cc, id).level !== 'blocked'
  && sttStatus(cc, id).level !== 'nofree';

/** 这个国家最该用哪家。不知道在哪 → elevenlabs（全世界最稳） */
export function bestSttFor(cc) {
  const c = String(cc || '').toUpperCase();
  if (!c) return 'elevenlabs';
  if (sttUsable(c, 'gemini')) return 'gemini';
  if (sttUsable(c, 'elevenlabs')) return 'elevenlabs';
  if (sttUsable(c, 'azure')) return 'azure';
  // 制裁国家：几家都悬。Azure 覆盖最广，但也别装作一定有
  return 'azure';
}

/** 把服务商列表按"这个国家能不能用"排序：能用的排前面，用不了的沉底 */
export function orderForCountry(list, cc) {
  if (!cc) return list;
  const rank = (p) => {
    const l = sttStatus(cc, p.id).level;
    return l === 'ok' ? 0 : l === 'unknown' ? 1 : 2;
  };
  // Array.prototype.sort 在现代 JS 里是稳定的，同级保持原顺序
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/**
 * 给界面用的一句话地区说明
 * @returns {{cc:string, name:string, best:string, line:string, warn:string}}
 */
export function regionAdvice(cc) {
  const c = String(cc || '').toUpperCase();
  if (!c) {
    return {
      cc: '', name: '', best: 'elevenlabs', line: '',
      warn: '没测出你所在的国家（可能断网或被拦截器挡了）。默认用 ElevenLabs —— 它在全世界绝大多数地方都能用。',
    };
  }
  const best = bestSttFor(c);
  const name = ccName(c);
  let warn = '';
  if (SANCTIONED.includes(c)) {
    warn = '注意：' + name + '在几家云服务商的制裁名单上，可能全都用不了。'
      + '能不能用取决于当地网络和具体账号，点下面的「检查这家通不通」实测一次。';
  } else if (!sttUsable(c, 'gemini')) {
    const st = sttStatus(c, 'gemini');
    warn = st.msg + ' → 这里推荐 ElevenLabs。';
  }
  return {
    cc: c,
    name,
    best,
    line: '当前出口：' + name + '（' + c + '）',
    warn,
  };
}

// ---------------------------------------------------------------------------
// 自动修正：只做"救火"，不做"升级"
// ---------------------------------------------------------------------------

// 每家对应的 Key 字段；判"用户有没有真的在用这家"就看它填没填
const KEY_OF = {
  gemini: 'geminiKey',
  elevenlabs: 'elevenKey',
  azure: 'azureKey',
  groq: 'groqKey',
  openai: 'openaiKey',
  siliconflow: 'siliconKey',
};

/**
 * 只在这一家**在这个国家用不了、而且用户还没填它的 Key** 时才换掉。
 *
 * 为什么只做救火、不做升级：
 *   反过来（把能用 Gemini 的人自动掰去 Gemini）看着是"给他更好的"，
 *   但 Gemini 免费层有一条"音频可能被用于改进 Google 产品"，
 *   对一个说贴心话的陪伴 App 来说这是**用户的取舍，不是我的**。
 *   升级交给界面上的按钮，用户自己点。
 *
 * 已经填了 Key 的一律不动 —— 那说明人家自己选了这条路，可能挂着代理，
 * 也可能就是想用这家。宁可让他在设置页看到一句警告，也不能替他改。
 *
 * @returns {boolean} 有没有真的改
 */
export function applyRegionDefault() {
  const cc = currentCountry();
  if (!cc) return false;
  try {
    const v = S.getSnapshot()?.config?.voice || {};
    const cur = v.sttProvider || 'elevenlabs';
    if (sttUsable(cc, cur)) return false;

    const kf = KEY_OF[cur];
    if (kf && v[kf]) return false; // 填了 Key = 用户自选，不动

    const want = bestSttFor(cc);
    if (want === cur) return false;
    S.updateConfig({ voice: { ...v, sttProvider: want } });
    console.info('[region] ' + cc + ' 用不了 ' + cur + '，已改推荐 ' + want);
    return true;
  } catch (e) {
    console.warn('[region] applyRegionDefault 失败', e);
    return false;
  }
}

// 联网能力：搜索 / 天气 / 新闻
// ---------------------------------------------------------------------------
// 设计原则：三家搜索都收编成同一种结构返回，上层不需要知道用的是哪家。
// 天气走 Open-Meteo —— **完全免费且不需要 Key**，还自带中文天气描述,
// 比让大模型瞎猜靠谱得多（它不知道今天到底几度）。

/**
 * 统一的搜索结果
 * @typedef {{title:string, url:string, snippet:string, published?:string}} SearchHit
 */

const TIMEOUT_MS = 20000;

async function req(url, { method = 'GET', headers, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    if (!res.ok) {
      const detail = json?.detail || json?.message || json?.error?.message || text.slice(0, 160);
      throw new Error(`HTTP ${res.status}：${detail}`);
    }
    return json ?? text;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('搜索超时（20s）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

async function searchTavily(key, query, count) {
  const j = await req('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: count,
      search_depth: 'basic',
      include_answer: true,
    }),
  });
  const hits = (j?.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    published: r.published_date,
  }));
  return { answer: j?.answer, hits };
}

async function searchBrave(key, query, count) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const j = await req(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  const hits = (j?.web?.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
    published: r.age || r.page_age,
  }));
  return { answer: null, hits };
}

async function searchSerper(key, query, count) {
  const j = await req('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: count }),
  });
  const hits = (j?.organic || []).map((r) => ({
    title: r.title || '',
    url: r.link || '',
    snippet: r.snippet || '',
    published: r.date,
  }));
  return { answer: j?.answerBox?.answer || j?.answerBox?.snippet, hits };
}

/**
 * @param {{provider:string, keys:Record<string,string>}} cfg
 * @param {string} query
 * @param {number} count
 * @returns {Promise<{ok:boolean, hits?:SearchHit[], answer?:string, error?:string}>}
 */
export async function webSearch(cfg, query, count = 5) {
  const provider = cfg?.provider || 'none';
  const keys = cfg?.keys || {};
  if (provider === 'none') {
    return { ok: false, error: '未启用联网搜索' };
  }
  try {
    if (provider === 'tavily') {
      if (!keys.tavilyKey) return { ok: false, error: '缺 Tavily Key' };
      const { answer, hits } = await searchTavily(keys.tavilyKey, query, count);
      return { ok: true, answer, hits };
    }
    if (provider === 'brave') {
      if (!keys.braveKey) return { ok: false, error: '缺 Brave Key' };
      const { answer, hits } = await searchBrave(keys.braveKey, query, count);
      return { ok: true, answer, hits };
    }
    if (provider === 'serper') {
      if (!keys.serperKey) return { ok: false, error: '缺 Serper Key' };
      const { answer, hits } = await searchSerper(keys.serperKey, query, count);
      return { ok: true, answer, hits };
    }
    return { ok: false, error: `未知搜索服务 ${provider}` };
  } catch (e) {
    return { ok: false, error: e?.message || '搜索失败' };
  }
}

// ---------------------------------------------------------------------------
// 天气 —— Open-Meteo，免费无 Key
// ---------------------------------------------------------------------------

export const WEATHER_CODES = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '冻雾',
  51: '毛毛雨', 53: '细雨', 55: '小阵雨',
  56: '冻毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

// Open-Meteo 的地理编码服务，把"东京""尖沙咀"这种地名换成经纬度
async function geocode(place) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=${encodeURIComponent(place)}`;
  const j = await req(url);
  const first = j?.results?.[0];
  if (!first) return null;
  return {
    lat: first.latitude,
    lon: first.longitude,
    name: first.name,
    country: first.country,
    admin: first.admin1,
  };
}

/**
 * 查天气。place 为空时，调用方一般得上一步先用 geocode 拿到的默认城市。
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export async function getWeather(place, { lat, lon } = {}) {
  try {
    let loc = { name: place || '当前位置' };
    if (lat != null && lon != null) {
      loc = { ...loc, lat, lon };
    } else {
      const g = await geocode(place);
      if (!g) return { ok: false, error: `找不到地点「${place}」` };
      loc = { ...loc, ...g, name: `${g.name}${g.admin ? ' · ' + g.admin : ''}` };
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=3`;
    const j = await req(url);

    const c = j?.current;
    const d = j?.daily;
    if (!c) return { ok: false, error: '天气数据为空' };

    return {
      ok: true,
      data: {
        place: loc.name,
        unit: j?.current_units?.temperature_2m || '°C',
        now: {
          temp: c.temperature_2m,
          feelsLike: c.apparent_temperature,
          humidity: c.relative_humidity_2m,
          wind: c.wind_speed_10m,
          desc: WEATHER_CODES[c.weather_code] ?? '未知',
        },
        forecast: (d?.time || []).slice(0, 3).map((day, i) => ({
          date: day,
          desc: WEATHER_CODES[d.weather_code?.[i]] ?? '未知',
          max: d.temperature_2m_max?.[i],
          min: d.temperature_2m_min?.[i],
          rain: d.precipitation_probability_max?.[i],
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: e?.message || '天气查询失败' };
  }
}

/** 把天气结果压成一段好念的话 —— 角色是念出来的，不是给人看的表格 */
export function weatherToSpeech(w) {
  if (!w?.ok) return null;
  const d = w.data;
  const parts = [
    `${d.place}现在${d.now.desc}，${d.now.temp}${d.unit}`,
    `体感 ${d.now.feelsLike}${d.unit}`,
    `湿度 ${d.now.humidity}%`,
  ];
  const today = d.forecast?.[0];
  if (today) parts.push(`今天${today.desc}，最高 ${today.max}${d.unit}，最低 ${today.min}${d.unit}`);
  const tomorrow = d.forecast?.[1];
  if (tomorrow) parts.push(`明天${tomorrow.desc}，最高 ${tomorrow.max}${d.unit}`);
  return parts.join('，') + '。';
}

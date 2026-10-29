// ============================================================
//  External services: OpenAI, DeepSeek, Open-Meteo, region check
// ============================================================

// Invocation context: counts outbound subrequests (free plan: 50 per invocation)
function newInv(mode) {
  return { mode, subreq: 0, dbq: 0, started: Date.now(), colo: null, regionBlocked: null, usage: emptyUsage() };
}
const SUBREQ_SOFT_LIMIT = 42;

async function xfetch(inv, url, init = {}, timeoutMs = 60000) {
  if (inv) {
    if (inv.subreq >= 48) throw new Error('本次运行的外部请求数已达上限，稍后会自动继续');
    inv.subreq++;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：${hostOf(url)}`);
    throw new Error(`网络请求失败：${hostOf(url)}：${errMsg(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(res, label) {
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.code)) || clampStr(text, 300) || res.statusText;
    const code = data && data.error && data.error.code;
    const err = new Error(`${label} 返回 ${res.status}：${msg}`);
    err.status = res.status;
    err.code = code || '';
    if (res.status === 403 && /unsupported_country|region|territory/i.test(`${code} ${msg}`)) err.regionBlocked = true;
    throw err;
  }
  if (data == null) throw new Error(`${label} 返回了无法解析的内容：${clampStr(text, 200)}`);
  return data;
}

// Where is this Worker running? (OpenAI blocks some regions, e.g. Hong Kong / mainland China)
const OPENAI_BLOCKED_COLOS = new Set(['HKG', 'MFM']);
const OPENAI_BLOCKED_LOCS = new Set(['HK', 'MO', 'CN', 'RU', 'KP', 'IR', 'SY', 'CU', 'BY']);
async function checkRegion(inv) {
  if (inv.regionBlocked !== null) return inv.regionBlocked;
  try {
    const res = await xfetch(inv, 'https://www.cloudflare.com/cdn-cgi/trace', {}, 8000);
    const text = await res.text();
    const colo = (/^colo=(\w+)/m.exec(text) || [])[1] || '';
    const loc = (/^loc=(\w+)/m.exec(text) || [])[1] || '';
    inv.colo = colo;
    inv.regionBlocked = OPENAI_BLOCKED_COLOS.has(colo) || OPENAI_BLOCKED_LOCS.has(loc);
  } catch {
    inv.regionBlocked = false; // unknown → try anyway
  }
  return inv.regionBlocked;
}

// ---------------- OpenAI (Responses API) ----------------
const OPENAI_BASE = 'https://api.openai.com/v1';

function openaiHeaders(key) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}

// Start a (background) response. Falls back to simpler payloads on 400s.
async function openaiStart(inv, key, body, { background = true } = {}) {
  const attempts = [];
  const full = { ...body, store: true };
  if (background) full.background = true;
  attempts.push(full);
  // fallback 1: drop optional extras
  const lite = { ...full };
  delete lite.include;
  if (lite.tools) lite.tools = lite.tools.map((t) => (t.type === 'web_search' ? { type: 'web_search' } : t));
  attempts.push(lite);
  // fallback 2: no reasoning param
  const liter = { ...lite };
  delete liter.reasoning;
  attempts.push(liter);
  let lastErr;
  for (const payload of attempts) {
    try {
      const res = await xfetch(inv, `${OPENAI_BASE}/responses`, {
        method: 'POST', headers: openaiHeaders(key), body: JSON.stringify(payload),
      }, background ? 45000 : 290000);
      return await readJsonResponse(res, 'OpenAI');
    } catch (e) {
      lastErr = e;
      if (e.status !== 400) throw e;
    }
  }
  throw lastErr;
}
async function openaiGet(inv, key, id) {
  const url = `${OPENAI_BASE}/responses/${encodeURIComponent(id)}?include[]=web_search_call.action.sources`;
  const res = await xfetch(inv, url, { headers: openaiHeaders(key) }, 30000);
  return readJsonResponse(res, 'OpenAI');
}
async function openaiCancel(inv, key, id) {
  try {
    await xfetch(inv, `${OPENAI_BASE}/responses/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: openaiHeaders(key) }, 15000);
  } catch { /* ignore */ }
}
// Extract text + cited urls + consulted sources from a Response object
function openaiExtract(resp) {
  let text = '';
  const urls = new Set();
  const out = Array.isArray(resp && resp.output) ? resp.output : [];
  for (const item of out) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
          text += (text ? '\n' : '') + c.text;
          for (const a of c.annotations || []) {
            const u = a.url || (a.url_citation && a.url_citation.url);
            if (isHttpUrl(u)) urls.add(u);
          }
        }
      }
    } else if (item.type === 'web_search_call' && item.action) {
      for (const s of item.action.sources || []) if (s && isHttpUrl(s.url)) urls.add(s.url);
    }
  }
  if (!text && typeof resp.output_text === 'string') text = resp.output_text;
  return { text, urls: [...urls] };
}
function openaiStatus(resp) {
  return (resp && resp.status) || 'unknown';
}
async function openaiModelCheck(inv, key, model) {
  const res = await xfetch(inv, `${OPENAI_BASE}/models/${encodeURIComponent(model)}`, { headers: openaiHeaders(key) }, 20000);
  return readJsonResponse(res, 'OpenAI');
}
// Synchronous JSON call with strict schema (no tools) — used for repair / memory
async function openaiJson(inv, key, model, instructions, input, schemaName, schema, effort = 'low') {
  const body = {
    model, instructions, input,
    reasoning: { effort },
    text: { format: { type: 'json_schema', name: schemaName, schema, strict: false } },
    max_output_tokens: 16000,
  };
  let resp;
  try {
    resp = await openaiStart(inv, key, body, { background: false });
  } catch (e) {
    if (e.status !== 400) throw e;
    const b2 = { model, instructions: instructions + '\n只输出 JSON。', input, max_output_tokens: 16000 };
    resp = await openaiStart(inv, key, b2, { background: false });
  }
  recordOaUsage(inv, model, resp);
  if (openaiStatus(resp) !== 'completed') throw new Error(`OpenAI 未完成：${openaiStatus(resp)} ${resp.incomplete_details ? JSON.stringify(resp.incomplete_details) : ''}`);
  const { text } = openaiExtract(resp);
  const j = extractJson(text);
  if (!j) throw new Error('OpenAI 返回的不是有效 JSON');
  return j;
}

// ---------------- DeepSeek ----------------
const DEEPSEEK_BASE = 'https://api.deepseek.com';

async function deepseekChat(inv, key, { model, system, user, json = true, thinking = false, maxTokens = 8000, timeoutMs = 240000 }) {
  const mk = (withExtras) => {
    const b = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      stream: false,
    };
    if (withExtras) {
      if (json) b.response_format = { type: 'json_object' };
      b.thinking = { type: thinking ? 'enabled' : 'disabled' };
    }
    return b;
  };
  let data;
  try {
    const res = await xfetch(inv, `${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(mk(true)),
    }, timeoutMs);
    data = await readJsonResponse(res, 'DeepSeek');
  } catch (e) {
    if (e.status !== 400) throw e;
    const res = await xfetch(inv, `${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(mk(false)),
    }, timeoutMs);
    data = await readJsonResponse(res, 'DeepSeek');
  }
  recordDsUsage(inv, model, data && data.usage);
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const content = (msg && msg.content) || '';
  if (!json) return content;
  const j = extractJson(content);
  if (!j) throw new Error(`DeepSeek 返回的不是有效 JSON：${clampStr(content, 150)}`);
  return j;
}

async function deepseekSearch(inv, key, query, count = 10) {
  const res = await xfetch(inv, `${DEEPSEEK_BASE}/v1/tools/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: clampStr(query, 128), count, need_content: false }),
  }, 30000);
  const data = await readJsonResponse(res, 'DeepSeek 搜索');
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length) recordDsSearch(inv); // only non-empty searches are billed
  return results;
}
async function deepseekModels(inv, key) {
  const res = await xfetch(inv, `${DEEPSEEK_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } }, 20000);
  return readJsonResponse(res, 'DeepSeek');
}

// ---------------- JSON helpers ----------------
function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const s = String(text);
  const tries = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) tries.push(fence[1]);
  tries.push(s);
  for (const t of tries) {
    const trimmed = t.trim();
    try { return JSON.parse(trimmed); } catch { /* continue */ }
    const a = trimmed.indexOf('{'), b = trimmed.lastIndexOf('}');
    if (a >= 0 && b > a) {
      const sub = trimmed.slice(a, b + 1);
      try { return JSON.parse(sub); } catch { /* continue */ }
      try { return JSON.parse(sub.replace(/,\s*([}\]])/g, '$1')); } catch { /* continue */ }
    }
  }
  return null;
}
// Remove markdown citation links that web-search models inline into strings; collect the urls.
function stripCites(s, urlSink) {
  if (typeof s !== 'string') return s;
  let out = s.replace(/\(?\[([^\]]{0,80})\]\((https?:\/\/[^)\s]+)\)\)?/g, (m, label, url) => {
    if (urlSink) urlSink.push(url);
    return '';
  });
  out = out.replace(/【\d+†[^】]*】/g, '').replace(/\s{2,}/g, ' ').trim();
  return out;
}

// ---------------- Weather (Open-Meteo, free, no key) ----------------
const WMO = {
  0: ['晴', '☀️'], 1: ['晴间多云', '🌤️'], 2: ['多云', '⛅'], 3: ['阴', '☁️'], 45: ['雾', '🌫️'], 48: ['雾凇', '🌫️'],
  51: ['毛毛雨', '🌦️'], 53: ['毛毛雨', '🌦️'], 55: ['毛毛雨', '🌧️'], 56: ['冻毛毛雨', '🌧️'], 57: ['冻毛毛雨', '🌧️'],
  61: ['小雨', '🌦️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'], 66: ['冻雨', '🌧️'], 67: ['冻雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['雪粒', '🌨️'],
  80: ['阵雨', '🌦️'], 81: ['阵雨', '🌧️'], 82: ['强阵雨', '⛈️'], 85: ['阵雪', '🌨️'], 86: ['强阵雪', '❄️'],
  95: ['雷阵雨', '⛈️'], 96: ['雷阵雨伴冰雹', '⛈️'], 99: ['强雷阵雨伴冰雹', '⛈️'],
};

async function geocode(inv, db, city) {
  if (CITY_COORDS[city]) return CITY_COORDS[city];
  const cached = await kvGet(db, `geo:${city}`, null);
  if (cached) return cached;
  const res = await xfetch(inv, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`, {}, 15000);
  const data = await readJsonResponse(res, '地理编码');
  const r = data.results && data.results[0];
  if (!r) throw new Error(`找不到城市「${city}」的坐标`);
  const v = [r.latitude, r.longitude];
  await kvSet(db, `geo:${city}`, v);
  return v;
}

function glowIndex(low, mid, high, rainProb) {
  const hi = Math.max(mid || 0, high || 0);
  if (rainProb >= 60) return { level: '低', note: '可能下雨' };
  if (low >= 70) return { level: '低', note: '低云太厚' };
  if (hi >= 25 && hi <= 85 && low < 45) return { level: '高', note: '中高云适中，晚霞概率较大' };
  if (hi >= 15 && low < 60) return { level: '中', note: '有一定云量，可能出现晚霞' };
  if (hi < 15 && low < 25) return { level: '中', note: '天空通透，日落清晰但霞光偏淡' };
  return { level: '一般', note: '' };
}

async function fetchWeather(inv, db, city, sat, sun) {
  const [lat, lon] = await geocode(inv, db, city);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset'
    + '&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability'
    + '&timezone=Asia%2FShanghai&forecast_days=10';
  const res = await xfetch(inv, url, {}, 20000);
  const w = await readJsonResponse(res, '天气');
  const out = {};
  for (const [label, day] of [['sat', sat], ['sun', sun]]) {
    const i = (w.daily && w.daily.time || []).indexOf(day);
    if (i < 0) continue;
    const code = w.daily.weather_code[i];
    const sunset = (w.daily.sunset && w.daily.sunset[i]) || '';
    let glow = null;
    if (sunset && w.hourly && w.hourly.time) {
      const hourKey = sunset.slice(0, 13) + ':00';
      const hi = w.hourly.time.indexOf(hourKey);
      if (hi >= 0) {
        glow = glowIndex(w.hourly.cloud_cover_low[hi], w.hourly.cloud_cover_mid[hi], w.hourly.cloud_cover_high[hi], w.hourly.precipitation_probability ? w.hourly.precipitation_probability[hi] : 0);
      }
    }
    out[label] = {
      date: day,
      text: (WMO[code] || ['未知'])[0],
      icon: (WMO[code] || ['', '🌡️'])[1],
      tmax: Math.round(w.daily.temperature_2m_max[i]),
      tmin: Math.round(w.daily.temperature_2m_min[i]),
      rain: w.daily.precipitation_probability_max ? w.daily.precipitation_probability_max[i] : null,
      sunset: sunset ? sunset.slice(11, 16) : '',
      glow,
    };
  }
  return out;
}

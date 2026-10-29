// ============================================================
//  周末去哪儿 · Weekend Planner for 2
//  Cloudflare Worker (single file) — backend + embedded PWA
// ============================================================

const APP_NAME = '周末去哪儿';
const SCHEMA_VERSION = '3';
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DEFAULT_ACTIVITIES = (Array.isArray(USER_CONFIG.defaultActivities) && USER_CONFIG.defaultActivities.length)
  ? USER_CONFIG.defaultActivities.map(String) : ['看电影', '逛街', '短途旅游'];

const NEARBY_PRESETS = {
  '上海': [
    { name: '苏州', hours: 1.2 }, { name: '嘉兴', hours: 1.3 }, { name: '无锡', hours: 1.7 },
    { name: '南通', hours: 1.7 }, { name: '湖州', hours: 2.0 }, { name: '杭州', hours: 2.2 },
    { name: '绍兴', hours: 2.5 }, { name: '宁波', hours: 2.7 }, { name: '舟山', hours: 3.0 },
  ],
  '杭州': [
    { name: '绍兴', hours: 1.0 }, { name: '嘉兴', hours: 1.2 }, { name: '湖州', hours: 1.2 },
    { name: '宁波', hours: 2.0 }, { name: '苏州', hours: 2.0 }, { name: '上海', hours: 2.2 },
  ],
  '苏州': [
    { name: '无锡', hours: 0.8 }, { name: '嘉兴', hours: 1.0 }, { name: '上海', hours: 1.2 },
    { name: '湖州', hours: 1.5 }, { name: '南通', hours: 1.5 }, { name: '杭州', hours: 2.0 },
  ],
  '南京': [
    { name: '镇江', hours: 1.0 }, { name: '扬州', hours: 1.3 }, { name: '马鞍山', hours: 1.0 },
    { name: '常州', hours: 1.5 }, { name: '芜湖', hours: 1.5 }, { name: '无锡', hours: 2.0 },
  ],
  '北京': [
    { name: '天津', hours: 1.8 }, { name: '廊坊', hours: 1.2 }, { name: '保定', hours: 2.0 },
    { name: '承德', hours: 2.8 }, { name: '张家口', hours: 2.8 },
  ],
  '广州': [
    { name: '佛山', hours: 0.8 }, { name: '东莞', hours: 1.2 }, { name: '中山', hours: 1.5 },
    { name: '珠海', hours: 2.0 }, { name: '深圳', hours: 2.0 }, { name: '清远', hours: 1.5 },
  ],
  '深圳': [
    { name: '东莞', hours: 1.0 }, { name: '惠州', hours: 1.5 }, { name: '广州', hours: 2.0 },
    { name: '中山', hours: 1.8 }, { name: '珠海', hours: 2.0 },
  ],
};

// Known city coordinates (lat, lon) — avoids a geocoding round trip
const CITY_COORDS = {
  '上海': [31.2304, 121.4737], '苏州': [31.2989, 120.5853], '嘉兴': [30.7522, 120.7555],
  '宁波': [29.8683, 121.5440], '南通': [31.9802, 120.8943], '无锡': [31.4912, 120.3119],
  '湖州': [30.8943, 120.0868], '杭州': [30.2741, 120.1551], '绍兴': [29.9958, 120.5861],
  '舟山': [29.9853, 122.2072], '北京': [39.9042, 116.4074], '天津': [39.3434, 117.3616],
  '广州': [23.1291, 113.2644], '深圳': [22.5431, 114.0579], '南京': [32.0603, 118.7969],
  '成都': [30.5728, 104.0668], '重庆': [29.5630, 106.5516], '武汉': [30.5928, 114.3055],
  '西安': [34.3416, 108.9398], '厦门': [24.4798, 118.0894], '青岛': [36.0671, 120.3826],
  '长沙': [28.2282, 112.9388], '常州': [31.8107, 119.9741], '镇江': [32.1877, 119.4250],
  '扬州': [32.3942, 119.4129], '佛山': [23.0215, 113.1214], '东莞': [23.0207, 113.7518],
  '珠海': [22.2710, 113.5767], '香港': [22.3193, 114.1694], '昆明': [25.0389, 102.7183],
};

function defaultConfig() {
  const city = String(USER_CONFIG.defaultCity || '上海').trim() || '上海';
  const names = Array.isArray(USER_CONFIG.defaultNames) ? USER_CONFIG.defaultNames : [];
  const dp = USER_CONFIG.defaultPush || {};
  const dc = USER_CONFIG.defaultCounts || {};
  return {
    setupDone: false,
    city,
    nearby: (NEARBY_PRESETS[city] || []).map((x) => ({ ...x })),
    users: [{ id: 'u1', name: String(names[0] || '').trim() || '我' }, { id: 'u2', name: String(names[1] || '').trim() || 'TA' }],
    push: {
      weekday: Number.isInteger(dp.weekday) && dp.weekday >= 0 && dp.weekday <= 6 ? dp.weekday : 4,
      time: parseHHMM(dp.time) ? dp.time : '18:30',
      sundayReminder: true, commentNotify: true,
    },
    counts: {
      live: Number.isInteger(dc.live) && dc.live >= 0 && dc.live <= 8 ? dc.live : 5,
      personal: Number.isInteger(dc.personal) && dc.personal >= 0 && dc.personal <= 8 ? dc.personal : 5,
    },
    activities: DEFAULT_ACTIVITIES.slice(),
    models: {
      openaiSearch: 'gpt-5.5',
      openaiAgent: 'gpt-5.5',
      openaiEffort: 'medium',
      deepseekPlanner: 'deepseek-flash',
      deepseekExtractor: 'deepseek-v4-pro',
    },
    agentWebSearch: true,
    bark: {},
  };
}

// ---------- bytes / base64url ----------
function b64urlEncode(input) {
  const bytes = typeof input === 'string' ? ENC.encode(input) : new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function sha256Hex(str) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', ENC.encode(str)));
  return Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(n = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- misc ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clampStr(s, n) {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) : s;
}
function parseJsonSafe(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
function errMsg(e) {
  if (!e) return '未知错误';
  return clampStr(e.message || String(e), 500);
}
function isHttpUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return false;
  try {
    const x = new URL(u.trim());
    return (x.protocol === 'https:' || x.protocol === 'http:') && !!x.hostname && x.hostname.includes('.');
  } catch { return false; }
}
function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    x.hash = '';
    // drop common tracking params
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|share|wfr$|for$)/i.test(k)) x.searchParams.delete(k);
    }
    let s = x.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch { return String(u || '').trim().toLowerCase(); }
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[《》「」『』“”"'‘’【】\[\]()（）\s·・,，.。!！?？:：\-—_|]/g, '');
}
function titleSimilarity(a, b) {
  a = normTitle(a); b = normTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.5 + 0.5;
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = grams(a), gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size || 1);
}

// ---------- Beijing time helpers (UTC+8, no DST) ----------
function bjParts(ts = Date.now()) {
  const d = new Date(ts + 8 * HOUR);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
function pad2(n) { return String(n).padStart(2, '0'); }
function ymdOf(ts) { const p = bjParts(ts); return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`; }
function bjTs(ymd, hh = 0, mm = 0) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - 8 * HOUR;
}
function addDaysYmd(ymd, n) { return ymdOf(bjTs(ymd, 12) + n * DAY); }
function weekendFor(ts = Date.now()) {
  const p = bjParts(ts);
  const today = ymdOf(ts);
  let sat;
  if (p.dow === 6) sat = today;
  else if (p.dow === 0) sat = addDaysYmd(today, -1);
  else sat = addDaysYmd(today, 6 - p.dow);
  return { sat, sun: addDaysYmd(sat, 1) };
}
function cnDate(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}月${d}日`;
}
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}
// The push time for a given weekend (sat = 'YYYY-MM-DD')
function pushTsFor(cfg, sat) {
  const W = Number(cfg.push && cfg.push.weekday);
  const wd = Number.isInteger(W) && W >= 0 && W <= 6 ? W : 4;
  const off = wd === 0 ? -6 : wd - 6;
  const t = parseHHMM(cfg.push && cfg.push.time) || { h: 18, mi: 30 };
  return bjTs(addDaysYmd(sat, off), t.h, t.mi);
}

function jsonRes(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Run `work()` and stream whitespace heartbeats so that long AI calls don't hit client timeouts.
function streamingJson(ctx, work) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let closed = false;
  const hb = setInterval(() => {
    if (!closed) writer.write(ENC.encode(' ')).catch(() => {});
  }, 4000);
  const p = (async () => {
    let out;
    try { out = await work(); } catch (e) { out = { error: errMsg(e) }; }
    clearInterval(hb);
    closed = true;
    try {
      await writer.write(ENC.encode(JSON.stringify(out)));
      await writer.close();
    } catch { /* client went away */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return new Response(readable, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

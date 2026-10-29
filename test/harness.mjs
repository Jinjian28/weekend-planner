// Test harness: D1 shim over node:sqlite, a controllable clock, and a mock "internet".
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

// ---------- clock ----------
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
export function setNow(ts) { offset = ts - realNow(); }
export function bjTsOf(y, m, d, h = 0, mi = 0) { return Date.UTC(y, m - 1, d, h, mi) - 8 * 3600e3; }

// ---------- D1 shim ----------
export const counters = { dbq: 0, fetches: 0 };
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const norm = (row) => (row ? { ...row } : null);
  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...p) {
      for (const x of p) if (x === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${this.sql.slice(0, 80)}`);
      return new Stmt(this.sql, p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
    }
    async first(col) { counters.dbq++; const r = norm(db.prepare(this.sql).get(...this.params)); return r && col ? r[col] : r; }
    async all() { counters.dbq++; return { results: db.prepare(this.sql).all(...this.params).map(norm), success: true, meta: {} }; }
    async run() { counters.dbq++; const r = db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
    _exec() {
      const s = db.prepare(this.sql);
      if (/^\s*(SELECT|WITH)/i.test(this.sql)) return { results: s.all(...this.params).map(norm), success: true, meta: {} };
      const r = s.run(...this.params);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  }
  return {
    _db: db,
    prepare(sql) { return new Stmt(sql); },
    async batch(stmts) {
      counters.dbq += stmts.length;
      for (const s of stmts) if (!(s instanceof Stmt)) throw new Error('batch got a non-D1 statement (wrapper not unwrapped)');
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

// ---------- ctx ----------
export function makeCtx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(Promise.resolve(p).catch((e) => console.error('waitUntil error', e))); }, passThroughOnException() {} };
}

// ---------- mock internet ----------
export const net = {
  colo: 'SJC', loc: 'US',
  openaiMode: 'ok', // ok | fail500 | region | badjson | slow
  deepseekMode: 'ok', // ok | searchfail | chatfail | allfail
  openaiResponses: new Map(),
  pushes: [], // decrypted push payloads
  barks: [],
  calls: [],
  log: false,
};
let respSeq = 0;

function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }); }

function weekendDates(now) {
  // returns 10 forecast days from today (BJ)
  const days = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(now + 8 * 3600e3 + i * 86400e3);
    days.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return days;
}

function openMeteo() {
  const days = weekendDates(Date.now());
  const hourly = { time: [], cloud_cover_low: [], cloud_cover_mid: [], cloud_cover_high: [], precipitation_probability: [] };
  for (const d of days) for (let h = 0; h < 24; h++) {
    hourly.time.push(`${d}T${String(h).padStart(2, '0')}:00`);
    hourly.cloud_cover_low.push(10); hourly.cloud_cover_mid.push(40); hourly.cloud_cover_high.push(55); hourly.precipitation_probability.push(10);
  }
  return {
    daily: {
      time: days, weather_code: days.map((_, i) => (i % 3 === 0 ? 2 : 61)),
      temperature_2m_max: days.map(() => 21.4), temperature_2m_min: days.map(() => 13.6),
      precipitation_probability_max: days.map((_, i) => (i % 3 === 0 ? 10 : 70)), sunset: days.map((d) => `${d}T17:05`),
    },
    hourly,
  };
}

function dsSearchResults(query) {
  const base = encodeURIComponent(query).slice(0, 20);
  return [
    { title: `${query} 音乐剧《剧院魅影》中文版 上海文化广场`, url: `https://www.damai.cn/item-${base}-1.html`, snippet: '...', summary: '10月31日-11月2日 19:30 上汽·上海文化广场，票价 180-1280 元，大麦网购票。', site_name: '大麦', date: '2026-10-20T00:00:00+00:00', rerank_score: 2.2, authority: 3 },
    { title: `${query} 万圣节 夜游 上海欢乐谷`, url: `https://mp.weixin.qq.com/s/hw-${base}`, snippet: '...', summary: '10月31日-11月1日 欢乐谷万圣节夜场，18:00-22:00。', site_name: '公众号', date: '2026-10-18T00:00:00+00:00', rerank_score: 1.9, authority: 2 },
    { title: `${query} 苏州 秋季 市集`, url: `https://www.sohu.com/a/sz-${base}`, snippet: '...', summary: '苏州 11月1日 平江路秋日市集。', site_name: '搜狐', date: '2026-10-22T00:00:00+00:00', rerank_score: 1.5, authority: 2 },
  ];
}

function extractPool(text) {
  const m = /【候选池（\d+ 个）】\n(\[[\s\S]*?\])\n\n请输出 JSON/.exec(text);
  return m ? JSON.parse(m[1]) : [];
}

function agentAnswer(input) {
  const pool = extractPool(input);
  const live = pool.slice(0, 7).map((p, i) => ({
    ref: p.id, title: p.title, emoji: '🎭', category: p.category, city: p.city || '上海', when: p.date || '周六', where: p.venue || '', price: p.price || '',
    summary: `${p.title} 简介 ([damai.cn](https://www.damai.cn/item-cited.html))`, reason: '你们都喜欢看剧', booking: '大麦购票', urls: [],
  }));
  live.splice(1, 0, { ref: 'X99', title: '不存在的活动', city: '上海' });
  live.push({ ref: 'NEW', title: '舟山 海鲜节', city: '舟山', urls: ['https://evil.example.com/x'] });
  const personal = [
    // duplicates of live picks — must be filtered out by the server
    ...(pool[0] ? [{ title: `${pool[0].title}，去逛逛`, emoji: '🎭', category: '演出', city: '上海', ref: pool[0].id, summary: 'dup', reason: 'dup', where: pool[0].venue || '' }] : []),
    ...(pool[2] ? [{ title: '换个说法再推一次', emoji: '🎭', category: '演出', city: '上海', where: pool[2].venue || 'zzz', summary: 'dup', reason: 'dup' }] : []),
    { title: '有段时间没打羽毛球了，约一场吧', emoji: '🏸', category: '运动', activity: '羽毛球', city: '上海', when: '周六上午', where: '附近羽毛球馆', summary: '订两小时场地', reason: '已经三周没打了', how: '美团订场', map_query: '羽毛球馆', search_query: '上海 羽毛球馆' },
    { title: '开车去崇明看晚霞', emoji: '🌇', category: '户外', activity: '短途旅游', city: '崇明', when: '周六傍晚', where: '崇明东滩', summary: '晚霞指数高', reason: '天气不错', how: '提前出发', map_query: '崇明东滩', search_query: '崇明 看日落' },
    { title: '在家练吉他', emoji: '🎸', category: '其他', activity: '练吉他', city: '', summary: '弹唱', reason: '好久没练', how: '', map_query: '', search_query: '吉他 弹唱 入门' },
    { title: '看一部口碑好电影', emoji: '🎬', category: '电影', activity: '看电影', city: '上海', ref: pool.find((p) => p.category === '电影') ? pool.find((p) => p.category === '电影').id : '', summary: '...', reason: '...', how: '猫眼', map_query: '电影院', search_query: '' },
  ];
  return { headline: '万圣节+好剧+晚霞，这周末很精彩', live, personal };
}

function oaSearchAnswer(input) {
  if (input.includes('热映')) {
    return { candidates: [
      { title: '电影《好东西2》', category: '电影', city: '上海', date_text: '热映中', summary: '豆瓣 8.6 ([douban](https://movie.douban.com/subject/1/))', urls: ['https://movie.douban.com/subject/1/'], confidence: 'high' },
      { title: '杭州 西湖 秋色', category: '户外', city: '杭州', date_text: '全天', summary: '赏秋', urls: ['https://www.hangzhou.gov.cn/x'], confidence: 'medium' },
      { title: '舟山 东极岛 观日出', category: '户外', city: '舟山', date_text: '全天', summary: '远', urls: ['https://www.zhoushan.gov.cn/x'], confidence: 'high' },
      { title: '无锡 鼋头渚 夜樱', category: '户外', city: '无锡', date_text: '全天', summary: '...', urls: ['https://fake-not-in-sources.example.org/x'], confidence: 'high' },
    ] };
  }
  return { candidates: [
    { title: '音乐剧《剧院魅影》中文版', category: '演出', city: '上海', venue: '上汽·上海文化广场', date_text: '10月31日-11月2日', time_text: '19:30', price_text: '¥180起', summary: '经典', booking: '大麦', booking_url: 'https://www.damai.cn/item-123.html', urls: ['https://www.damai.cn/item-123.html'], confidence: 'high' },
    { title: '上海国际宠物展', category: '宠物', city: '上海', venue: '新国际博览中心', date_text: '11月1日', urls: ['https://www.petfair.cn/x'], confidence: 'high' },
    { title: '外滩 万圣节 市集', category: '节庆', city: '黄浦区', venue: '外滩源', date_text: '10月31日', urls: ['https://mp.weixin.qq.com/s/bund'], confidence: 'medium' },
    { title: '烘焙美食节', category: '美食', city: '上海', venue: '徐汇滨江', date_text: '11月1日-2日', urls: ['https://www.timeoutshanghai.com/x'], confidence: 'high' },
  ] };
}

function openaiResponseObj(id, kind, input, status) {
  let text;
  if (kind === 'agent') text = '```json\n' + JSON.stringify(agentAnswer(input)) + '\n```';
  else if (kind === 'search') text = '```json\n' + JSON.stringify(oaSearchAnswer(input)) + '\n```';
  else if (kind === 'memory') text = JSON.stringify({ summary: '两人喜欢看剧和户外，小红不爱太远', together: { likes: ['音乐剧'], dislikes: ['排长队'], patterns: [] }, people: { u1: { likes: ['羽毛球'], dislikes: [], notes: '' }, u2: { likes: ['宠物'], dislikes: ['远途'], notes: '' } }, activity_last_done: { '看音乐剧/话剧': '2099-01-01' }, rules: ['周日晚上别太累'] });
  else text = '{"ok":true}';
  if (net.openaiMode === 'badjson' && kind !== 'memory') text = '抱歉，这是一些非 JSON 的文字……'.repeat(5);
  const sources = ['https://www.damai.cn/item-123.html', 'https://www.petfair.cn/x', 'https://mp.weixin.qq.com/s/bund', 'https://www.timeoutshanghai.com/x', 'https://movie.douban.com/subject/1/', 'https://www.hangzhou.gov.cn/x', 'https://www.zhoushan.gov.cn/x'];
  return {
    id, status,
    usage: { input_tokens: 30000, input_tokens_details: { cached_tokens: 10000 }, output_tokens: 4000, output_tokens_details: { reasoning_tokens: 2000 }, total_tokens: 34000 },
    output: [
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'x', sources: sources.map((u) => ({ type: 'url', url: u })) } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: 'https://www.damai.cn/item-cited.html', title: 't' }] }] },
    ],
  };
}

async function decryptPush(body, sub) {
  // independent implementation with node:crypto
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const asPub = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(sub._priv);
  const shared = ecdh.computeSecret(asPub);
  const uaPub = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, sub._auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(data), d.final()]);
  if (plain[plain.length - 1] !== 2) throw new Error('bad padding delimiter');
  if (rs !== 4096) throw new Error('bad rs');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

export const subsByEndpoint = new Map();
export function makeSubscription(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, _priv: ecdh.getPrivateKey(), _auth: auth };
  subsByEndpoint.set(endpoint, sub);
  return sub;
}

function verifyVapid(authHeader, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader || '');
  if (!m) throw new Error(`bad vapid header: ${authHeader}`);
  const [h, p, s] = m[1].split('.');
  const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('VAPID signature invalid');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (claims.aud !== new URL(endpoint).origin) throw new Error('bad aud');
  if (!(claims.exp > Date.now() / 1000) || claims.exp > Date.now() / 1000 + 24 * 3600) throw new Error('bad exp');
  if (!/^(mailto:|https:)/.test(claims.sub)) throw new Error('bad sub');
  return claims;
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  counters.fetches++;
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body;
  const headers = new Headers(init.headers || {});
  net.calls.push(`${method} ${url}`);
  if (net.log) console.log('  fetch', method, url.slice(0, 100));
  const u = new URL(url);

  if (u.hostname === 'www.cloudflare.com' && u.pathname === '/cdn-cgi/trace') {
    return new Response(`fl=1\nh=www.cloudflare.com\nip=1.2.3.4\nts=1\nvisit_scheme=https\ncolo=${net.colo}\nloc=${net.loc}\n`);
  }
  if (u.hostname === 'api.open-meteo.com') return json(openMeteo());
  if (u.hostname === 'geocoding-api.open-meteo.com') return json({ results: [{ latitude: 1, longitude: 2 }] });

  if (u.hostname === 'api.deepseek.com') {
    if (!/^Bearer sk-ds/.test(headers.get('Authorization') || '')) return json({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, 401);
    if (u.pathname === '/models') return json({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
    if (u.pathname === '/user/balance') return json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '9.58', granted_balance: '0.00', topped_up_balance: '9.58' }] });
    if (u.pathname === '/v1/tools/search') {
      if (net.deepseekMode === 'searchfail' || net.deepseekMode === 'allfail') return json({ error: { message: 'internal', code: 'x' } }, 500);
      const q = JSON.parse(body);
      if (q.query.length > 128) return json({ error: { message: 'query too long' } }, 400);
      return json({ results: dsSearchResults(q.query.replace(/ after:.*$/, '')) });
    }
    if (u.pathname === '/chat/completions') {
      if (net.deepseekMode === 'chatfail' || net.deepseekMode === 'allfail') return json({ error: { message: 'Service busy' } }, 503);
      const b = JSON.parse(body);
      const sys = b.messages[0].content;
      const user = b.messages[1].content;
      let out;
      if (sys.includes('搜索规划师')) out = { queries: ['上海 11月1日 音乐剧', '上海 万圣节 活动 2026', '上海 宠物展 11月'] };
      else if (sys.includes('信息提取员')) {
        const ids = [...user.matchAll(/^\[(\d+)\] (.+?)(?: \|.*)?$/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
        const kinds = ['话剧专场', '新展开幕', '创意市集', '脱口秀', '城市骑行', '亲子乐园夜场', '咖啡节', '爵士之夜', '苏州评弹'];
        out = { candidates: ids.slice(0, 9).map((r, i) => ({ title: `${['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'][i]}${kinds[i]}`, category: i % 2 ? '节庆' : '演出', city: kinds[i].includes('苏州') ? '苏州' : '上海', venue: `场馆${i}`, date_text: '11月1日', summary: '摘要', booking: '公众号预约', booking_url: i === 0 ? 'https://not-in-results.example.com/' : '', source_ids: [r.n], confidence: 'high' })) };
      } else if (sys.includes('周末偏好记忆')) out = { summary: 'DeepSeek 版记忆', together: { likes: ['看剧'] }, people: { u1: { likes: ['羽毛球'] } }, activity_last_done: {}, rules: [] };
      else if (sys.includes('周末策划师')) out = agentAnswer(user);
      else if (sys.includes('整理成严格合法的 JSON')) {
        out = user.includes('"candidates"') || sys.includes('candidates') ? { candidates: [] } : agentAnswer('');
      } else out = { ok: true };
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out) } }], usage: { prompt_tokens: 20000, completion_tokens: 3000, prompt_cache_hit_tokens: 5000, prompt_cache_miss_tokens: 15000, total_tokens: 23000 } });
    }
  }

  if (u.hostname === 'api.openai.com') {
    if (!/^Bearer sk-oa/.test(headers.get('Authorization') || '')) return json({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, 401);
    if (net.colo === 'HKG' || net.openaiMode === 'region') return json({ error: { message: 'Country, region, or territory not supported', code: 'unsupported_country_region_territory' } }, 403);
    if (net.openaiMode === 'fail500') return json({ error: { message: 'server error' } }, 500);
    if (u.pathname.startsWith('/v1/models/')) return json({ id: u.pathname.split('/').pop(), object: 'model' });
    if (u.pathname === '/v1/responses' && method === 'POST') {
      const b = JSON.parse(body);
      if (b.tools && b.tools[0] && b.tools[0].type !== 'web_search') return json({ error: { message: 'bad tool' } }, 400);
      const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input);
      const kind = (b.instructions || '').includes('周末策划师') ? 'agent' : (b.instructions || '').includes('local-events researcher') ? 'search' : (b.instructions || '').includes('偏好记忆') ? 'memory' : 'other';
      const id = `resp_${++respSeq}`;
      net.openaiResponses.set(id, { kind, input, polls: 0 });
      if (b.background) return json({ id, status: 'queued', output: [] });
      return json(openaiResponseObj(id, kind, input, 'completed'));
    }
    const m = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(u.pathname);
    if (m) {
      const r = net.openaiResponses.get(m[1]);
      if (!r) return json({ error: { message: 'not found' } }, 404);
      if (m[2]) return json({ id: m[1], status: 'cancelled' });
      r.polls++;
      if (net.openaiMode === 'slow' && r.polls < 3) return json({ id: m[1], status: 'in_progress', output: [] });
      return json(openaiResponseObj(m[1], r.kind, r.input, 'completed'));
    }
  }

  if (u.hostname === 'web.push.apple.com' || u.hostname === 'fcm.googleapis.com') {
    const sub = subsByEndpoint.get(url);
    if (!sub) return new Response('', { status: 410 });
    verifyVapid(headers.get('Authorization'), url);
    if (headers.get('Content-Encoding') !== 'aes128gcm') throw new Error('bad encoding');
    if (!headers.get('TTL')) throw new Error('no TTL');
    const payload = await decryptPush(new Uint8Array(body), sub);
    net.pushes.push({ endpoint: url, payload });
    return new Response('', { status: 201 });
  }
  if (u.hostname === 'api.day.app') { net.barks.push(url); return json({ code: 200 }); }

  throw new Error(`unexpected fetch ${url}`);
};

// ============================================================
//  Weekly list generation pipeline (resumable state machine)
//  prepare → memory → search (DeepSeek ‖ GPT) → agent (GPT; DeepSeek fallback) → finalize
// ============================================================

const CATS = ['演出', '展览', '节庆', '市集', '美食', '电影', '户外', '运动', '宠物', '亲子', '乐园', '其他'];
const CAT_EMOJI = { 演出: '🎭', 展览: '🖼️', 节庆: '🎃', 市集: '🛍️', 美食: '🍰', 电影: '🎬', 户外: '🌄', 运动: '🏃', 宠物: '🐾', 亲子: '🧸', 乐园: '🎢', 其他: '✨' };
const VOTE_CN = { want: '想去', maybe: '再看看', no: '不想去' };
const FAR_HOURS = 2.3;
const ACT_KEYWORDS = {
  '羽毛球': ['羽毛球'],
  '看电影': ['电影', '影院', '观影', '上映'],
  '约朋友打牌': ['打牌', '牌局', '掼蛋', '桌游', '德扑', '麻将', '狼人杀'],
  '陆冲板': ['陆冲', '滑板', 'surfskate'],
  '看音乐剧/话剧': ['音乐剧', '话剧', '舞台剧', '剧场', '戏剧'],
  '短途旅游': ['短途', '一日游', '周边游', '古镇', '自驾'],
  '游泳': ['游泳', '泳池'],
  '逛街': ['逛街', '商场', '购物', '街区', 'citywalk', '城市漫步'],
  '游乐园': ['游乐园', '乐园', '迪士尼', '欢乐谷', '海昌'],
  '宠物展/宠物店': ['宠物', '猫咖', '狗狗', '萌宠'],
  '练吉他': ['吉他'],
  '看展览': ['展览', '展会', '美术馆', '博物馆', '艺术展'],
  '美食探店': ['探店', '美食', '餐厅', '咖啡', '小吃'],
  '运动健身': ['健身', '运动', '跑步', '骑行', '攀岩', '瑜伽'],
  '约朋友聚会': ['聚会', '聚餐', '约朋友', '派对'],
};
const FALLBACK_TPL = {
  '羽毛球': { emoji: '🏸', title: '约一场羽毛球', summary: '订个两小时的场地出出汗，打完找家店好好吃一顿。', how: '美团/大众点评搜「羽毛球馆」提前订场', map: '羽毛球馆', cat: '运动' },
  '看电影': { emoji: '🎬', title: '去影院看场新片', summary: '挑一部口碑好的新片，提前选好中间排的位置。', how: '猫眼/淘票票选场次', map: '电影院', cat: '电影' },
  '约朋友打牌': { emoji: '🃏', title: '约朋友来场牌局', summary: '叫上两三个朋友，在家或桌游店打打掼蛋，配点夜宵。', how: '提前在群里约时间', map: '桌游 棋牌室', cat: '其他' },
  '陆冲板': { emoji: '🛹', title: '去江边刷陆冲', summary: '找段平整的滨江步道刷一刷，顺便吹风看日落。', how: '注意护具和人流', map: '滨江步道 滑板', cat: '运动' },
  '看音乐剧/话剧': { emoji: '🎭', title: '看一场话剧/音乐剧', summary: '看看本周末有什么好剧，捡个漏也不错。', how: '大麦/猫眼搜索本周末演出', map: '剧院', cat: '演出' },
  '短途旅游': { emoji: '🚗', title: '周边短途一日游', summary: '开车一两个小时去附近的小城或古镇逛逛，吃点当地特色。', how: '提前看好天气和停车', map: '古镇', cat: '户外' },
  '游泳': { emoji: '🏊', title: '去室内泳池游几圈', summary: '游个一小时，放松一周的疲惫。', how: '美团搜「游泳馆」买次卡', map: '游泳馆', cat: '运动' },
  '逛街': { emoji: '🛍️', title: '城市漫步 + 逛街', summary: '选一个没去过的街区慢慢逛，喝杯咖啡。', how: '小红书搜 citywalk 路线', map: '商场', cat: '其他' },
  '游乐园': { emoji: '🎢', title: '去游乐园疯玩一天', summary: '早点出发，避开排队高峰，玩到晚上看灯光。', how: '官方小程序提前买票', map: '游乐园', cat: '乐园' },
  '宠物展/宠物店': { emoji: '🐶', title: '逛逛宠物店/猫咖', summary: '去撸撸猫狗，顺便看看有没有宠物市集或领养日。', how: '大众点评搜「猫咖」「宠物市集」', map: '猫咖', cat: '宠物' },
  '练吉他': { emoji: '🎸', title: '在家练一首新曲子', summary: '挑一首两人都喜欢的歌，一个弹一个唱，录下来留念。', how: '', map: '', cat: '其他' },
  '看展览': { emoji: '🖼️', title: '去看一个新展', summary: '挑一个口碑好的展，慢慢逛，出来找家咖啡馆聊聊感受。', how: '大麦/小红书搜「本周 展览」提前预约', map: '美术馆', cat: '展览' },
  '美食探店': { emoji: '🍜', title: '去吃一家想吃很久的店', summary: '把收藏夹里那家店安排上，错开饭点去少排队。', how: '大众点评看评价、能订位就订位', map: '美食', cat: '美食' },
  '运动健身': { emoji: '🏃', title: '一起动一动', summary: '跑步、骑行或去健身房，出出汗，周末更有精神。', how: '天气好就户外，下雨去室内场馆', map: '运动场馆', cat: '运动' },
  '约朋友聚会': { emoji: '🍻', title: '约几个朋友聚一聚', summary: '在家做饭或找家餐厅，好久不见的朋友叫出来聊聊。', how: '提前在群里约时间', map: '聚餐 餐厅', cat: '其他' },
};

function initialState(cfg, sat) {
  return {
    step: 'prepare',
    sat, sun: addDaysYmd(sat, 1), city: cfg.city,
    picked: [], recentFar: false, weather: null,
    memory: { tries: 0 },
    ds: { status: 'pending', tries: 0, candidates: [], error: '', queries: [], results: 0 },
    oa: { status: 'pending', tries: 0, deferrals: 0, jobs: [], candidates: [], error: '' },
    agent: { status: 'pending', tries: 0, id: '', result: null, error: '', engine: '', urls: [] },
    pool: [],
    log: [],
  };
}
function hhmm() { const p = bjParts(Date.now()); return `${pad2(p.h)}:${pad2(p.mi)}`; }
function stLog(st, msg) {
  st.log.push(`${hhmm()} ${clampStr(msg, 300)}`);
  if (st.log.length > 40) st.log = st.log.slice(-40);
}

// ---------- helpers ----------
function rankConf(c) { return c === 'high' ? 3 : c === 'medium' ? 2 : 1; }
function cleanField(v, n, sink) {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return clampStr(stripCites(s, sink), n);
}
function pickEmoji(e, cat) {
  if (typeof e === 'string' && e.trim() && [...e.trim()].length <= 4) return e.trim();
  return CAT_EMOJI[cat] || '✨';
}
function appleMaps(q) { return `https://maps.apple.com/?q=${encodeURIComponent(q)}`; }
function baidu(q) { return `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`; }
function normCandidate(raw, sink) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const cat = typeof raw.category === 'string' ? raw.category.trim() : '';
  return {
    title: cleanField(raw.title, 60, sink),
    category: CATS.includes(cat) ? cat : (CATS.find((c) => cat.includes(c)) || '其他'),
    city: cleanField(raw.city, 12),
    venue: cleanField(raw.venue, 60, sink),
    address: cleanField(raw.address, 80, sink),
    date_text: cleanField(raw.date_text, 60, sink),
    time_text: cleanField(raw.time_text, 40, sink),
    price_text: cleanField(raw.price_text, 40, sink),
    summary: cleanField(raw.summary, 160, sink),
    booking: cleanField(raw.booking, 100, sink),
    booking_url: isHttpUrl(raw.booking_url) ? String(raw.booking_url).trim() : '',
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
    urls: [],
  };
}
function makeUrlChecker(urls) {
  const set = new Set(urls.map(normUrl));
  const hosts = new Set(urls.map(hostOf).filter(Boolean));
  return (u) => {
    if (!isHttpUrl(u)) return false;
    if (!set.size) return true; // no source list available → can't verify, accept
    return set.has(normUrl(u)) || hosts.has(hostOf(u));
  };
}
function resolveRef(ref, pool, title) {
  if (ref && ref !== 'NEW') {
    const r = String(ref).trim().toUpperCase();
    const hit = pool.find((p) => p.id === r || (p.alias || []).includes(r));
    if (hit) return hit;
  }
  if (title) {
    let best = null, bs = 0;
    for (const p of pool) { const s = titleSimilarity(p.title, title); if (s > bs) { bs = s; best = p; } }
    if (bs >= 0.6) return best;
  }
  return null;
}
function matchActivity(cfg, data) {
  if (data.activity && cfg.activities.includes(data.activity)) return data.activity;
  const text = `${data.title || ''} ${data.category || ''} ${data.summary || ''}`.toLowerCase();
  for (const act of cfg.activities) {
    const kws = ACT_KEYWORDS[act] || [act.split(/[/／]/)[0]];
    if (kws.some((k) => k && text.includes(k.toLowerCase()))) return act;
  }
  return '';
}

// ---------- nearby cities: farther = rarer ----------
async function pickNearby(db, cfg, sat) {
  const list = (cfg.nearby || []).filter((c) => c && c.name && c.name !== cfg.city);
  const recent = await recentPublishedIssues(db, 2, sat);
  const recentOut = new Set();
  let recentFar = false;
  if (recent.length) {
    const ids = recent.map((i) => i.id);
    const rows = (await db.prepare(`SELECT data FROM items WHERE issue_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || [];
    for (const r of rows) {
      const d = parseJsonSafe(r.data, {});
      if (d.isOut && d.city) { recentOut.add(d.city); if ((d.hours || 0) >= FAR_HOURS) recentFar = true; }
    }
  }
  const pool = list.map((c) => {
    const h = Math.max(0.5, Number(c.hours) || 2);
    return { name: c.name, hours: h, w: (1 / (h * h)) * (recentOut.has(c.name) ? 0.3 : 1) * (recentFar && h >= FAR_HOURS ? 0.3 : 1) };
  });
  const picked = [];
  const n = Math.min(2, pool.length);
  for (let k = 0; k < n; k++) {
    const total = pool.reduce((s, c) => s + c.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) { r -= pool[idx].w; if (r <= 0) break; }
    picked.push({ name: pool[idx].name, hours: pool[idx].hours });
    pool.splice(idx, 1);
  }
  return { picked, recentFar };
}

// ---------- memory ----------
function emptyProfile(cfg) {
  const people = {};
  for (const u of cfg.users) people[u.id] = { likes: [], dislikes: [], notes: '' };
  return { summary: '', together: { likes: [], dislikes: [], patterns: [] }, people, activity_last_done: {}, rules: [], updated_at: 0 };
}
function sanitizeProfile(p, cfg) {
  p = p && typeof p === 'object' ? p : {};
  const arr = (a, n = 10) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).map((x) => clampStr(x.trim(), 40)).slice(0, n) : []);
  const t = p.together && typeof p.together === 'object' ? p.together : {};
  const out = {
    summary: clampStr(typeof p.summary === 'string' ? p.summary : '', 300),
    together: { likes: arr(t.likes), dislikes: arr(t.dislikes), patterns: arr(t.patterns) },
    people: {},
    activity_last_done: {},
    rules: arr(p.rules),
    updated_at: Date.now(),
  };
  const ppl = p.people && typeof p.people === 'object' ? p.people : {};
  for (const u of cfg.users) {
    const pp = ppl[u.id] || ppl[u.name] || {};
    out.people[u.id] = { likes: arr(pp.likes), dislikes: arr(pp.dislikes), notes: clampStr(typeof pp.notes === 'string' ? pp.notes : '', 200) };
  }
  const today = ymdOf(Date.now());
  const ald = p.activity_last_done && typeof p.activity_last_done === 'object' ? p.activity_last_done : {};
  for (const [k, v] of Object.entries(ald)) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v <= today) out.activity_last_done[clampStr(k, 20)] = v;
  }
  return out;
}
async function getMemory(db, cfg) {
  const m = await kvGet(db, 'memory', null);
  return m ? sanitizeProfileLoose(m, cfg) : emptyProfile(cfg);
}
function sanitizeProfileLoose(m, cfg) {
  const s = sanitizeProfile(m, cfg);
  s.updated_at = m.updated_at || 0;
  return s;
}

async function historyContext(db, cfg, { beforeSat = '9999-12-31', limit = 6, ids = null } = {}) {
  let issues;
  if (ids && ids.length) {
    issues = (await db.prepare(`SELECT * FROM issues WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY sat DESC, id DESC`).bind(...ids).all()).results || [];
  } else {
    issues = await recentPublishedIssues(db, limit, beforeSat);
  }
  if (!issues.length) return [];
  const idList = issues.map((i) => i.id);
  const ph = idList.map(() => '?').join(',');
  const items = (await db.prepare(`SELECT * FROM items WHERE issue_id IN (${ph}) ORDER BY issue_id, kind, pos`).bind(...idList).all()).results || [];
  const reacts = (await db.prepare(`SELECT r.item_id, r.user_id, r.value FROM reactions r JOIN items i ON i.id = r.item_id WHERE i.issue_id IN (${ph})`).bind(...idList).all()).results || [];
  const comments = (await db.prepare(`SELECT * FROM comments WHERE issue_id IN (${ph}) ORDER BY id`).bind(...idList).all()).results || [];
  return issues.map((iss) => ({
    weekend: iss.sat,
    city: iss.city,
    items: items.filter((it) => it.issue_id === iss.id).map((it) => {
      const d = parseJsonSafe(it.data, {});
      const votes = {};
      for (const r of reacts) if (r.item_id === it.id) votes[userName(cfg, r.user_id)] = VOTE_CN[r.value] || r.value;
      const cm = comments.filter((c) => c.item_id === it.id).map((c) => `${userName(cfg, c.user_id)}：${clampStr(c.text, 100)}`);
      const o = { kind: it.kind === 'live' ? '实时' : '个性化', title: d.title, category: d.category, city: d.city };
      if (d.activity) o.activity = d.activity;
      if (it.chosen_by) o.chosen = true;
      if (Object.keys(votes).length) o.votes = votes;
      if (cm.length) o.comments = cm;
      return o;
    }),
    general: comments.filter((c) => !c.item_id).map((c) => `${userName(cfg, c.user_id)}：${clampStr(c.text, 140)}`),
  }));
}

async function updateMemory(inv, db, cfg, keys, { force = false } = {}) {
  const issues = (await db.prepare(`SELECT id, sat, meta, activity_at FROM issues WHERE status IN ('published','ready','archived') ORDER BY sat DESC, id DESC LIMIT 6`).all()).results || [];
  const pending = issues.filter((i) => {
    const m = parseJsonSafe(i.meta, {});
    return (i.activity_at || 0) > (m.digested_at || 0);
  });
  const noteRows = (await db.prepare('SELECT * FROM notes WHERE digested = 0 ORDER BY id LIMIT 30').all()).results || [];
  if (!pending.length && !noteRows.length && !force) return { skipped: true };
  const profile = await getMemory(db, cfg);
  const history = pending.length ? await historyContext(db, cfg, { ids: pending.map((i) => i.id) }) : [];
  const notes = noteRows.map((n) => `${userName(cfg, n.user_id)}（${ymdOf(n.created_at)}）：${clampStr(n.text, 300)}`);

  // deterministic "last done" from chosen items
  const ald = { ...(profile.activity_last_done || {}) };
  if (pending.length) {
    const ph = pending.map(() => '?').join(',');
    const chosen = (await db.prepare(`SELECT i.data, s.sat FROM items i JOIN issues s ON s.id = i.issue_id WHERE i.chosen_by IS NOT NULL AND i.issue_id IN (${ph})`).bind(...pending.map((p) => p.id)).all()).results || [];
    for (const c of chosen) {
      const act = matchActivity(cfg, parseJsonSafe(c.data, {}));
      if (act && (!ald[act] || ald[act] < c.sat) && c.sat <= ymdOf(Date.now())) ald[act] = c.sat;
    }
  }

  const user = memoryUser(cfg, profile, history, notes);
  let raw = null, engine = '';
  let lastErr = null;
  if (keys.openaiKey && !(await checkRegion(inv))) {
    try {
      raw = await openaiJson(inv, keys.openaiKey, cfg.models.openaiAgent, MEMORY_SYS, user, 'memory', { type: 'object' }, 'low');
      engine = 'gpt';
    } catch (e) { lastErr = e; }
  }
  if (!raw && keys.deepseekKey) {
    try {
      raw = await deepseekChat(inv, keys.deepseekKey, { model: cfg.models.deepseekExtractor, system: MEMORY_SYS, user, json: true, thinking: false, maxTokens: 6000, timeoutMs: 150000 });
      engine = 'deepseek';
    } catch (e) { lastErr = e; }
  }
  if (!raw) throw lastErr || new Error('没有可用的 AI Key');
  const next = sanitizeProfile(raw, cfg);
  for (const [k, v] of Object.entries(ald)) {
    if (!next.activity_last_done[k] || next.activity_last_done[k] < v) next.activity_last_done[k] = v;
  }
  await kvSet(db, 'memory', next);
  await db.prepare('INSERT INTO memory_history (ts, source, profile) VALUES (?, ?, ?)').bind(Date.now(), engine, JSON.stringify(next)).run();
  const t = Date.now();
  for (const i of pending) {
    const m = parseJsonSafe(i.meta, {});
    m.digested_at = t;
    await db.prepare('UPDATE issues SET meta = ? WHERE id = ?').bind(JSON.stringify(m), i.id).run();
  }
  if (noteRows.length) {
    await db.prepare(`UPDATE notes SET digested = 1 WHERE id IN (${noteRows.map(() => '?').join(',')})`).bind(...noteRows.map((n) => n.id)).run();
  }
  return { updated: true, engine, issues: pending.length, notes: noteRows.length };
}

// ---------- DeepSeek search agent ----------
async function runDeepseekSearch(inv, cfg, st, key) {
  let planned = [];
  try {
    const plan = await deepseekChat(inv, key, {
      model: cfg.models.deepseekPlanner, system: DS_PLANNER_SYS, user: dsPlannerUser(st, cfg),
      json: true, thinking: false, maxTokens: 1500, timeoutMs: 60000,
    });
    planned = (Array.isArray(plan.queries) ? plan.queries : []).map((q) => (typeof q === 'string' ? q : q && (q.q || q.query))).filter((q) => typeof q === 'string' && q.trim());
  } catch (e) {
    stLog(st, `DeepSeek 规划检索词失败，改用默认检索词（${errMsg(e)}）`);
  }
  const seen = new Set();
  const queries = [];
  for (const q of [...planned.slice(0, 8), ...seedQueries(st)]) {
    const k = q.replace(/\s+/g, '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    queries.push(clampStr(q.trim(), 100));
    if (queries.length >= 10) break;
  }
  const after = addDaysYmd(ymdOf(Date.now()), -45);
  const results = [];
  const urlSeen = new Set();
  let failures = 0, lastErr = null;
  // concurrency 5
  for (let i = 0; i < queries.length; i += 5) {
    const batch = queries.slice(i, i + 5);
    const settled = await Promise.allSettled(batch.map((q) => deepseekSearch(inv, key, /after:/.test(q) ? q : `${q} after:${after}`, 8)));
    for (const s of settled) {
      if (s.status !== 'fulfilled') { failures++; lastErr = s.reason; continue; }
      for (const r of s.value) {
        if (!r || !isHttpUrl(r.url)) continue;
        const k = normUrl(r.url);
        if (urlSeen.has(k)) continue;
        urlSeen.add(k);
        results.push({ title: clampStr(r.title, 120), url: r.url, site: r.site_name || '', date: r.date || '', summary: r.summary || '', snippet: r.snippet || '', score: Number(r.rerank_score) || 0 });
      }
    }
  }
  if (!results.length) {
    if (lastErr) throw lastErr;
    throw new Error('DeepSeek 搜索没有返回结果');
  }
  if (failures) stLog(st, `DeepSeek 有 ${failures} 个检索词失败（${errMsg(lastErr)}）`);
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 64).map((r, i) => ({ ...r, n: i + 1 }));
  const byN = new Map(top.map((r) => [r.n, r]));
  const urlSet = new Set(top.map((r) => normUrl(r.url)));

  const ext = await deepseekChat(inv, key, {
    model: cfg.models.deepseekExtractor, system: DS_EXTRACT_SYS, user: dsExtractUser(st, top),
    json: true, thinking: true, maxTokens: 16000, timeoutMs: 280000,
  });
  const list = Array.isArray(ext.candidates) ? ext.candidates : [];
  const out = [];
  for (const raw of list.slice(0, 30)) {
    const c = normCandidate(raw);
    if (!c.title) continue;
    const ids = Array.isArray(raw.source_ids) ? raw.source_ids : [];
    for (const n of ids) { const r = byN.get(Number(n)); if (r && !c.urls.includes(r.url)) c.urls.push(r.url); }
    if (!c.urls.length) {
      let best = null, bs = 0;
      for (const r of top) { const s = titleSimilarity(r.title, c.title); if (s > bs) { bs = s; best = r; } }
      if (best && bs >= 0.45) c.urls.push(best.url); else c.confidence = 'low';
    }
    if (c.booking_url && !urlSet.has(normUrl(c.booking_url))) c.booking_url = '';
    c.urls = c.urls.slice(0, 4);
    c.origin = 'deepseek';
    out.push(c);
  }
  out.forEach((c, i) => { c.id = `D${i + 1}`; });
  return { candidates: out, queries, resultCount: top.length };
}

// ---------- GPT search jobs ----------
async function startOaJob(inv, cfg, st, key, job) {
  const body = {
    model: cfg.models.openaiSearch,
    instructions: OA_SEARCH_SYS,
    input: job.input,
    tools: [oaWebSearchTool(st)],
    include: ['web_search_call.action.sources'],
    reasoning: { effort: cfg.models.openaiEffort || 'medium' },
    max_output_tokens: 32000,
  };
  const r = await openaiStart(inv, key, body, { background: true });
  return r;
}
function normalizeOaCandidates(list, urls) {
  const ok = makeUrlChecker(urls);
  const out = [];
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 30)) {
    const sink = [];
    const c = normCandidate(raw, sink);
    if (!c.title) continue;
    const given = [...(Array.isArray(raw.urls) ? raw.urls : []), ...sink];
    for (const u of given) if (ok(u) && !c.urls.includes(u)) c.urls.push(String(u).trim());
    if (c.booking_url && !ok(c.booking_url)) c.booking_url = '';
    if (!c.urls.length && !c.booking_url) continue; // GPT must show a source
    c.urls = c.urls.slice(0, 4);
    c.origin = 'gpt';
    out.push(c);
  }
  return out;
}
async function repairJson(inv, keys, cfg, text, shape) {
  const sys = `把下面的内容整理成严格合法的 JSON，结构为：${shape}。只输出 JSON，不要添加原文没有的信息。`;
  if (keys.deepseekKey) {
    return deepseekChat(inv, keys.deepseekKey, { model: cfg.models.deepseekPlanner, system: sys, user: clampStr(text, 60000), json: true, thinking: false, maxTokens: 8000, timeoutMs: 120000 });
  }
  return openaiJson(inv, keys.openaiKey, cfg.models.openaiAgent, sys, clampStr(text, 60000), 'repair', { type: 'object' }, 'low');
}

function mergePools(dsC, oaC) {
  const pool = [];
  const add = (c) => {
    for (const p of pool) {
      const sameCity = !p.city || !c.city || p.city === c.city || p.city.includes(c.city) || c.city.includes(p.city);
      if (sameCity && titleSimilarity(p.title, c.title) >= 0.72) {
        if (p.origin !== c.origin) p.origin = 'both';
        p.alias.push(c.id);
        for (const k of ['venue', 'address', 'date_text', 'time_text', 'price_text', 'booking', 'booking_url', 'summary', 'city']) if (!p[k] && c[k]) p[k] = c[k];
        p.urls = [...new Set([...p.urls, ...c.urls])].slice(0, 5);
        if (rankConf(c.confidence) > rankConf(p.confidence)) p.confidence = c.confidence;
        return;
      }
    }
    pool.push({ ...c, alias: [] });
  };
  const n = Math.max(dsC.length, oaC.length);
  for (let i = 0; i < n; i++) { if (oaC[i]) add(oaC[i]); if (dsC[i]) add(dsC[i]); }
  return pool.slice(0, 70);
}

// ---------- final selection (deterministic guard-rails) ----------
const CITY_DISTRICTS = {
  '上海': ['黄浦', '徐汇', '长宁', '静安', '普陀', '虹口', '杨浦', '闵行', '宝山', '嘉定', '浦东', '金山', '松江', '青浦', '奉贤', '崇明', '临港', '外滩', '陆家嘴', '朱家角', '迪士尼', '长兴岛', '横沙'],
  '杭州': ['西湖', '上城', '拱墅', '滨江', '萧山', '余杭', '临平', '钱塘', '富阳', '临安', '桐庐', '淳安', '建德', '千岛湖'],
  '北京': ['东城', '西城', '朝阳', '海淀', '丰台', '石景山', '通州', '顺义', '昌平', '大兴', '怀柔', '平谷', '密云', '延庆', '门头沟', '房山'],
  '苏州': ['姑苏', '吴中', '相城', '吴江', '工业园区', '虎丘', '昆山', '常熟', '张家港', '太仓', '周庄', '同里'],
};
function cityResolver(cfg) {
  const main = cfg.city;
  const nearby = (cfg.nearby || []).map((c) => [c.name, Number(c.hours) || 2]);
  const districts = CITY_DISTRICTS[main] || [];
  return (c, lenient = false) => {
    c = String(c || '').trim().replace(/市$/, '');
    if (!c || c.includes(main) || main.includes(c)) return { city: main, out: false, hours: 0 };
    for (const [n, h] of nearby) if (c.includes(n) || n.includes(c)) return { city: n, out: true, hours: h };
    // a district of the main city (e.g. 崇明、浦东)
    if (districts.some((d) => c.includes(d))) return { city: main, out: false, hours: 0 };
    if (lenient || /区$|新区|县$/.test(c)) return { city: main, out: false, hours: 0 };
    return null;
  };
}

function buildLiveItem(cfg, x, cand, rc, urlOk) {
  const c = cand || { urls: [] };
  const pick = (a, b, n) => clampStr(stripCites(typeof a === 'string' ? a : '') || stripCites(typeof b === 'string' ? b : ''), n);
  const title = pick(x.title, c.title, 40);
  const where = pick(x.where, [c.venue, c.address].filter(Boolean).join(' · '), 80);
  const category = CATS.includes(x.category) ? x.category : (c.category || '其他');
  const d = {
    title, emoji: pickEmoji(x.emoji, category), category, city: rc.city, isOut: rc.out, hours: rc.hours || 0,
    when: pick(x.when, [c.date_text, c.time_text].filter(Boolean).join(' '), 60),
    where, price: pick(x.price, c.price_text, 40),
    summary: pick(x.summary, c.summary, 160), reason: pick(x.reason, '', 120),
    booking: pick(x.booking, c.booking, 120),
    origin: c.origin || 'gpt', ref: c.id || 'NEW', confidence: c.confidence || 'medium',
    activity: '', links: [],
  };
  d.activity = matchActivity(cfg, d);
  const agentBooking = isHttpUrl(x.booking_url) && urlOk(x.booking_url) ? x.booking_url : '';
  const bookingUrl = c.booking_url || agentBooking;
  if (bookingUrl) d.links.push({ kind: 'book', label: '🎫 购票/报名', url: bookingUrl });
  const extra = Array.isArray(x.urls) ? x.urls.filter((u) => urlOk(u)) : [];
  const srcs = [...new Set([...(c.urls || []), ...extra])].filter((u) => isHttpUrl(u) && (!bookingUrl || normUrl(u) !== normUrl(bookingUrl)));
  if (srcs[0]) d.links.push({ kind: 'source', label: '🔗 信息来源', url: srcs[0] });
  if (srcs[1]) d.links.push({ kind: 'source', label: '🔗 更多', url: srcs[1] });
  const place = c.venue || (where && where.split(' · ')[0]);
  if (place) d.links.push({ kind: 'map', label: '🗺️ 地图', url: appleMaps(place.includes(rc.city) ? place : `${rc.city} ${place}`) });
  d.links.push({ kind: 'search', label: '🔍 搜一搜', url: baidu(`${title} ${rc.city} ${category === '电影' ? '排片 购票' : '购票 报名'}`) });
  return d;
}

function buildPersonalItem(cfg, x, rc, pool) {
  const s = (v, n) => clampStr(stripCites(typeof v === 'string' ? v : ''), n);
  const title = s(x.title, 40);
  const category = s(x.category, 10) || '建议';
  const d = {
    title, emoji: pickEmoji(x.emoji, category), category, city: rc.city, isOut: rc.out, hours: rc.hours || 0,
    when: s(x.when, 60), where: s(x.where, 80), summary: s(x.summary, 160), reason: s(x.reason, 120),
    booking: s(x.how, 120), activity: '', origin: 'ai', ref: '', links: [],
  };
  d.activity = cfg.activities.includes(x.activity) ? x.activity : matchActivity(cfg, d);
  const cand = x.ref ? resolveRef(x.ref, pool, '') : null;
  if (cand) {
    d.ref = cand.id;
    if (cand.booking_url) d.links.push({ kind: 'book', label: '🎫 购票/报名', url: cand.booking_url });
    if (cand.urls && cand.urls[0]) d.links.push({ kind: 'source', label: '🔗 相关信息', url: cand.urls[0] });
  }
  const mq = s(x.map_query, 60);
  if (mq) d.links.push({ kind: 'map', label: '🗺️ 地图找找', url: appleMaps(mq.includes(rc.city) ? mq : `${rc.city} ${mq}`) });
  d.links.push({ kind: 'search', label: '🔍 搜一搜', url: baidu(s(x.search_query, 60) || `${rc.city} ${title}`) });
  return d;
}

function fallbackPersonal(cfg, st, memory, need, usedActs, usedTitles) {
  const out = [];
  const ald = (memory && memory.activity_last_done) || {};
  const w = st.weather || {};
  const rainy = ['sat', 'sun'].every((k) => w[k] && w[k].rain >= 60);
  const glowDay = ['sat', 'sun'].find((k) => w[k] && w[k].glow && w[k].glow.level === '高');
  const hasSunset = [...usedTitles].some((t) => /晚霞|日落|夕阳/.test(t));
  if (glowDay && need > 0 && !hasSunset) {
    const day = glowDay === 'sat' ? '周六' : '周日';
    out.push({
      title: '去看一场晚霞', emoji: '🌇', category: '户外', city: cfg.city, isOut: false, hours: 0,
      when: `${day}傍晚（日落约 ${w[glowDay].sunset}）`, where: '江边/海边/高处观景点',
      summary: `${day}傍晚的云量很适合出晚霞，开车去水边兜兜风，等太阳落山。`,
      reason: `天气预报显示${day}晚霞指数高`, booking: '提前 40 分钟到达观景点', activity: '', origin: 'rules', ref: '',
      links: [{ kind: 'map', label: '🗺️ 地图找找', url: appleMaps(`${cfg.city} 看日落 观景点`) }, { kind: 'search', label: '🔍 搜一搜', url: baidu(`${cfg.city} 看晚霞 好去处`) }],
    });
  }
  const outdoor = new Set(['陆冲板', '短途旅游', '游乐园']);
  const acts = cfg.activities.filter((a) => !usedActs.has(a) && !(rainy && outdoor.has(a)));
  acts.sort((a, b) => ((ald[a] || '0000') < (ald[b] || '0000') ? -1 : (ald[a] || '0000') > (ald[b] || '0000') ? 1 : 0));
  for (const act of acts) {
    if (out.length >= need) break;
    const t = FALLBACK_TPL[act] || { emoji: '✨', title: `安排一次${act}`, summary: `这周末找个时间${act}吧。`, how: '', map: act, cat: '其他' };
    if (usedTitles.has(normTitle(t.title))) continue;
    const last = ald[act];
    out.push({
      title: t.title, emoji: t.emoji, category: t.cat || '建议', city: cfg.city, isOut: false, hours: 0,
      when: '周末任选半天', where: '', summary: t.summary,
      reason: last ? `上次${act}还是 ${cnDate(last)}，有段时间了` : `你们平时就喜欢${act}`,
      booking: t.how || '', activity: act, origin: 'rules', ref: '',
      links: [
        t.map ? { kind: 'map', label: '🗺️ 地图找找', url: appleMaps(`${cfg.city} ${t.map}`) } : null,
        { kind: 'search', label: '🔍 搜一搜', url: baidu(`${cfg.city} ${act} 推荐`) },
      ].filter(Boolean),
    });
  }
  return out.slice(0, need);
}

function selectFinal(cfg, st, agentOut, memory) {
  const pool = st.pool || [];
  const out = agentOut && typeof agentOut === 'object' ? agentOut : {};
  const resolve = cityResolver(cfg);
  const urlOk = makeUrlChecker([...(st.agent.urls || []), ...pool.flatMap((p) => [...(p.urls || []), p.booking_url].filter(Boolean))]);
  const want = { live: Math.max(0, Math.min(10, Number(cfg.counts.live) || 0)), personal: Math.max(0, Math.min(10, Number(cfg.counts.personal) || 0)) };
  let outCount = 0, farCount = 0;
  const titles = new Set();
  const usedRefs = new Set();
  const allow = (rc) => {
    if (!rc) return false;
    if (!rc.out) return true;
    if (outCount >= 2) return false;
    if (rc.hours >= FAR_HOURS && (farCount >= 1 || st.recentFar)) return false;
    return true;
  };
  const take = (rc) => { if (rc.out) { outCount++; if (rc.hours >= FAR_HOURS) farCount++; } };

  const live = [];
  for (const x of Array.isArray(out.live) ? out.live : []) {
    if (live.length >= want.live) break;
    if (!x || typeof x !== 'object') continue;
    const cand = resolveRef(x.ref, pool, x.title);
    const isNew = !cand && String(x.ref || '').toUpperCase() === 'NEW' && Array.isArray(x.urls) && x.urls.some((u) => urlOk(u));
    if (!cand && !isNew) continue;
    if (cand && usedRefs.has(cand.id)) continue;
    const rc = resolve(x.city || (cand && cand.city));
    if (!allow(rc)) continue;
    const key = normTitle(x.title || (cand && cand.title));
    if (!key || titles.has(key)) continue;
    titles.add(key); take(rc);
    if (cand) usedRefs.add(cand.id);
    live.push(buildLiveItem(cfg, x, cand, rc, urlOk));
  }
  if (live.length < want.live) {
    const ranked = pool.slice().sort((a, b) => (b.origin === 'both') - (a.origin === 'both') || rankConf(b.confidence) - rankConf(a.confidence) || (!!b.booking_url) - (!!a.booking_url));
    for (const cand of ranked) {
      if (live.length >= want.live) break;
      if (usedRefs.has(cand.id) || cand.confidence === 'low') continue;
      const rc = resolve(cand.city);
      if (!allow(rc)) continue;
      const key = normTitle(cand.title);
      if (!key || titles.has(key)) continue;
      titles.add(key); take(rc); usedRefs.add(cand.id);
      live.push(buildLiveItem(cfg, {}, cand, rc, urlOk));
    }
  }

  const personal = [];
  const usedActs = new Set();
  // things already covered by the live list — personal suggestions must not repeat them
  const liveTitles = live.map((l) => l.title);
  const livePlaces = live.map((l) => normTitle((l.where || '').split(' · ')[0])).filter((p) => p.length >= 3);
  let refCount = 0;
  const duplicatesLive = (x) => {
    const cand = x.ref ? resolveRef(x.ref, pool, '') : null;
    if (cand && usedRefs.has(cand.id)) return true;
    if (liveTitles.some((t) => titleSimilarity(t, x.title) >= 0.4)) return true;
    const w = normTitle(typeof x.where === 'string' ? x.where : '');
    if (w.length >= 3 && livePlaces.some((p) => w.includes(p) || p.includes(w))) return true;
    return false;
  };
  for (const x of Array.isArray(out.personal) ? out.personal : []) {
    if (personal.length >= want.personal) break;
    if (!x || typeof x !== 'object' || typeof x.title !== 'string' || !x.title.trim()) continue;
    if (duplicatesLive(x)) continue;
    const hasRef = !!(x.ref && resolveRef(x.ref, pool, ''));
    if (hasRef && refCount >= 1) continue;
    const rc = resolve(x.city, true);
    if (!allow(rc)) continue;
    const key = normTitle(x.title);
    if (titles.has(key)) continue;
    const item = buildPersonalItem(cfg, x, rc, pool);
    if (item.activity && usedActs.has(item.activity)) continue; // one suggestion per hobby
    titles.add(key); take(rc);
    if (hasRef) refCount++;
    if (item.activity) usedActs.add(item.activity);
    personal.push(item);
  }
  if (personal.length < want.personal) {
    const covered = new Set([...usedActs, ...live.map((l) => l.activity).filter(Boolean)]);
    for (const f of fallbackPersonal(cfg, st, memory, want.personal - personal.length, covered, titles)) {
      titles.add(normTitle(f.title));
      personal.push(f);
    }
  }
  let headline = clampStr(stripCites(typeof out.headline === 'string' ? out.headline : ''), 60);
  if (!headline) {
    const names = live.slice(0, 2).map((x) => x.title).concat(personal.slice(0, 1).map((x) => x.title));
    headline = names.length ? `本周末：${names.join('、')}…` : '本周末的备选清单来啦';
  }
  return { live, personal, headline };
}

function sanitizeAgentOut(raw, sinkUrls) {
  if (!raw || typeof raw !== 'object') return { live: [], personal: [], headline: '' };
  const fix = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : []);
  const out = { headline: typeof raw.headline === 'string' ? raw.headline : '', live: fix(raw.live), personal: fix(raw.personal) };
  // collect inline citation urls that GPT may have put inside strings
  for (const it of [...out.live, ...out.personal]) {
    for (const k of Object.keys(it)) if (typeof it[k] === 'string') { const s = []; stripCites(it[k], s); sinkUrls.push(...s); }
  }
  return out;
}

// ---------- the state machine ----------
async function advanceOnce(inv, env, db, cfg, keys, issue, st, opts) {
  const isCron = inv.mode === 'cron';
  const canDefer = isCron && Date.now() < (opts.softDeadline || 0);

  if (st.step === 'prepare') {
    const { picked, recentFar } = await pickNearby(db, cfg, st.sat);
    st.picked = picked;
    st.recentFar = recentFar;
    try {
      st.weather = await fetchWeather(inv, db, st.city, st.sat, st.sun);
    } catch (e) {
      st.weather = null;
      stLog(st, `天气获取失败（不影响生成）：${errMsg(e)}`);
    }
    stLog(st, `开始准备 ${cnDate(st.sat)}–${cnDate(st.sun)} · ${st.city}${picked.length ? `，本周顺带看看：${picked.map((c) => c.name).join('、')}` : ''}`);
    st.step = 'memory';
    return {};
  }

  if (st.step === 'memory') {
    try {
      const r = await updateMemory(inv, db, cfg, keys);
      if (r.updated) stLog(st, `AI 已复盘 ${r.issues} 期反馈${r.notes ? `和 ${r.notes} 条留言` : ''}，记忆已更新`);
    } catch (e) {
      st.memory.tries++;
      if (st.memory.tries < 2) { stLog(st, `更新记忆失败，重试：${errMsg(e)}`); return { waitMs: 2000 }; }
      stLog(st, `更新记忆失败，先跳过：${errMsg(e)}`);
    }
    st.step = 'search';
    return {};
  }

  if (st.step === 'search') {
    // 1) start GPT jobs
    if (st.oa.status === 'pending') {
      if (!keys.openaiKey) {
        st.oa.status = 'skipped';
        stLog(st, '未配置 OpenAI Key，跳过 GPT 检索');
      } else if (await checkRegion(inv)) {
        if (canDefer && st.oa.deferrals < 8) {
          st.oa.deferrals++;
          stLog(st, `当前云端节点（${inv.colo || '未知'}）不支持 OpenAI，稍后换节点重试`);
          if (st.ds.status !== 'pending') return { stop: true };
        } else {
          st.oa.status = 'failed';
          st.oa.error = `云端节点 ${inv.colo || ''} 不支持 OpenAI`;
          stLog(st, `GPT 检索不可用（${st.oa.error}），本次由 DeepSeek 完成`);
        }
      } else {
        const started = [];
        try {
          const defs = oaSearchJobs(st, cfg);
          for (const def of defs) {
            const r = await startOaJob(inv, cfg, st, keys.openaiKey, def);
            started.push({ key: def.key, id: r.id, status: 'running', tries: 1, startedAt: Date.now(), pollErr: 0, resp: r });
          }
          st.oa.jobs = started.map((j) => ({ key: j.key, id: j.id, status: j.status, tries: j.tries, startedAt: j.startedAt, pollErr: 0 }));
          st.oa.status = 'running';
          stLog(st, 'GPT 开始联网检索…');
          for (const j of started) {
            if (openaiStatus(j.resp) === 'completed') await finishOaJob(inv, cfg, keys, st, st.oa.jobs.find((x) => x.id === j.id), j.resp);
          }
        } catch (e) {
          st.oa.tries++;
          st.oa.error = errMsg(e);
          for (const j of started) await openaiCancel(inv, keys.openaiKey, j.id);
          st.oa.jobs = [];
          st.oa.status = 'pending';
          if (e.regionBlocked && canDefer && st.oa.deferrals < 8) { st.oa.deferrals++; stLog(st, 'OpenAI 拒绝了当前云端节点，稍后重试'); return { stop: true }; }
          stLog(st, `GPT 检索启动失败：${st.oa.error}`);
          if (st.oa.tries >= 2 || e.regionBlocked || e.status === 401 || e.status === 429) st.oa.status = 'failed';
        }
      }
    }
    // 2) DeepSeek (synchronous)
    if (st.ds.status === 'pending') {
      if (!keys.deepseekKey) {
        st.ds.status = 'skipped';
        stLog(st, '未配置 DeepSeek Key，跳过 DeepSeek 检索');
      } else {
        try {
          const r = await runDeepseekSearch(inv, cfg, st, keys.deepseekKey);
          st.ds.candidates = r.candidates;
          st.ds.queries = r.queries;
          st.ds.results = r.resultCount;
          st.ds.status = 'done';
          stLog(st, `DeepSeek 检索完成：${r.queries.length} 组检索词、${r.resultCount} 条结果，提炼出 ${r.candidates.length} 个候选`);
        } catch (e) {
          st.ds.tries++;
          st.ds.error = errMsg(e);
          stLog(st, `DeepSeek 检索出错：${st.ds.error}`);
          if (st.ds.tries >= 2 || e.status === 401 || e.status === 402) st.ds.status = 'failed';
          return { waitMs: 2000 };
        }
        return {};
      }
    }
    // 3) poll GPT jobs
    if (st.oa.status === 'running') {
      for (const job of st.oa.jobs) {
        if (job.status !== 'running') continue;
        try {
          const resp = await openaiGet(inv, keys.openaiKey, job.id);
          const s = openaiStatus(resp);
          if (s === 'completed' || s === 'incomplete') {
            await finishOaJob(inv, cfg, keys, st, job, resp);
          } else if (s === 'failed' || s === 'cancelled') {
            recordOaUsage(inv, cfg.models.openaiSearch, resp);
            const why = (resp.error && resp.error.message) || s;
            if (job.tries < 2) {
              const def = oaSearchJobs(st, cfg).find((d) => d.key === job.key);
              const r = await startOaJob(inv, cfg, st, keys.openaiKey, def);
              Object.assign(job, { id: r.id, tries: job.tries + 1, startedAt: Date.now(), pollErr: 0 });
              stLog(st, `GPT 检索（${job.key}）失败，已重试：${why}`);
            } else { job.status = 'failed'; job.error = why; }
          } else if (Date.now() - job.startedAt > 14 * MIN) {
            await openaiCancel(inv, keys.openaiKey, job.id);
            job.status = 'failed'; job.error = '超时';
            stLog(st, `GPT 检索（${job.key}）超时`);
          }
        } catch (e) {
          job.pollErr = (job.pollErr || 0) + 1;
          if (e.regionBlocked && canDefer) return { stop: true };
          if (job.pollErr >= 6 || e.status === 401 || e.status === 404) { job.status = 'failed'; job.error = errMsg(e); stLog(st, `GPT 检索（${job.key}）失败：${job.error}`); }
        }
      }
      if (st.oa.jobs.every((j) => j.status !== 'running')) {
        const all = [];
        for (const j of st.oa.jobs) all.push(...(j.candidates || []));
        all.forEach((c, i) => { c.id = `O${i + 1}`; });
        st.oa.candidates = all;
        for (const j of st.oa.jobs) delete j.candidates;
        st.oa.status = all.length ? 'done' : 'failed';
        stLog(st, all.length ? `GPT 检索完成，找到 ${all.length} 个候选` : 'GPT 检索没有得到有效结果');
      } else {
        return { waitMs: isCron ? 20000 : 4000, polling: true };
      }
    }
    const term = (s) => s === 'done' || s === 'failed' || s === 'skipped';
    if (term(st.oa.status) && term(st.ds.status)) {
      st.pool = mergePools(st.ds.candidates || [], st.oa.candidates || []);
      const both = st.pool.filter((p) => p.origin === 'both').length;
      stLog(st, `合并去重后候选池共 ${st.pool.length} 个（两路都找到的 ${both} 个）`);
      st.ds.candidates = [];
      st.oa.candidates = [];
      if (!st.pool.length) {
        const why = [st.ds.error && `DeepSeek：${st.ds.error}`, st.oa.error && `GPT：${st.oa.error}`].filter(Boolean).join('；') || '两路检索都没有结果';
        if (!opts.allowEmpty) return { failed: `没有检索到本周末的活动（${why}）` };
        stLog(st, `实时活动检索失败（${why}），本期先只给个性化建议`);
      }
      st.step = 'agent';
      return {};
    }
    return { waitMs: 2000 };
  }

  if (st.step === 'agent') {
    if (st.agent.status === 'pending') {
      const ctx = await buildAgentContext(db, cfg, st);
      const useGpt = keys.openaiKey && !st.agent.forceDS && st.agent.tries < 2;
      if (useGpt && !(await checkRegion(inv))) {
        try {
          const body = {
            model: cfg.models.openaiAgent,
            instructions: agentSystem(cfg, !!cfg.agentWebSearch),
            input: agentUser(cfg, st, ctx),
            reasoning: { effort: cfg.models.openaiEffort || 'medium' },
            max_output_tokens: 32000,
          };
          if (cfg.agentWebSearch) {
            body.tools = [oaWebSearchTool(st)];
            body.include = ['web_search_call.action.sources'];
          }
          const r = await openaiStart(inv, keys.openaiKey, body, { background: true });
          st.agent.id = r.id;
          st.agent.status = 'running';
          st.agent.engine = 'gpt';
          st.agent.startedAt = Date.now();
          st.agent.tries++;
          stLog(st, 'GPT 终审中：筛选、核实并结合你们的偏好排序…');
          if (openaiStatus(r) === 'completed') await finishAgent(inv, cfg, keys, st, r);
          return { waitMs: isCron ? 15000 : 4000, polling: true };
        } catch (e) {
          st.agent.tries++;
          st.agent.error = errMsg(e);
          stLog(st, `GPT 终审启动失败：${st.agent.error}`);
          if (e.regionBlocked && canDefer) return { stop: true };
          if (st.agent.tries < 2 && !e.regionBlocked && e.status !== 401) return { waitMs: 3000 };
          st.agent.forceDS = true;
        }
      } else if (useGpt && canDefer) {
        stLog(st, `当前云端节点（${inv.colo || '未知'}）不支持 OpenAI，稍后重试终审`);
        return { stop: true };
      }
      if (st.agent.status === 'pending') {
        if (keys.deepseekKey && (st.agent.dsTries || 0) < 2) {
          stLog(st, keys.openaiKey ? 'GPT 暂不可用，改由 DeepSeek 完成终审…' : 'DeepSeek 终审中…');
          try {
            const raw = await deepseekChat(inv, keys.deepseekKey, {
              model: cfg.models.deepseekExtractor, system: agentSystem(cfg, false), user: agentUser(cfg, st, ctx),
              json: true, thinking: true, maxTokens: 16000, timeoutMs: 280000,
            });
            st.agent.result = sanitizeAgentOut(raw, st.agent.urls);
            st.agent.status = 'done';
            st.agent.engine = 'deepseek';
          } catch (e) {
            st.agent.dsTries = (st.agent.dsTries || 0) + 1;
            stLog(st, `DeepSeek 终审出错：${errMsg(e)}`);
            return { waitMs: 2000 };
          }
        } else {
          st.agent.result = { live: [], personal: [], headline: '' };
          st.agent.status = 'done';
          st.agent.engine = 'rules';
          stLog(st, '没有可用的 AI 做终审，按规则自动挑选');
        }
      }
    }
    if (st.agent.status === 'running') {
      try {
        const resp = await openaiGet(inv, keys.openaiKey, st.agent.id);
        const s = openaiStatus(resp);
        if (s === 'completed' || s === 'incomplete') {
          await finishAgent(inv, cfg, keys, st, resp);
        } else if (s === 'failed' || s === 'cancelled') {
          recordOaUsage(inv, cfg.models.openaiAgent, resp);
          st.agent.error = (resp.error && resp.error.message) || s;
          stLog(st, `GPT 终审失败：${st.agent.error}`);
          st.agent.status = 'pending';
          if (st.agent.tries >= 2) st.agent.forceDS = true;
          return { waitMs: 2000 };
        } else if (Date.now() - st.agent.startedAt > 14 * MIN) {
          await openaiCancel(inv, keys.openaiKey, st.agent.id);
          stLog(st, 'GPT 终审超时，改用 DeepSeek');
          st.agent.status = 'pending';
          st.agent.forceDS = true;
          return {};
        } else {
          return { waitMs: isCron ? 15000 : 4000, polling: true };
        }
      } catch (e) {
        st.agent.pollErr = (st.agent.pollErr || 0) + 1;
        if (e.regionBlocked && canDefer) return { stop: true };
        if (st.agent.pollErr >= 6 || e.status === 401 || e.status === 404 || e.regionBlocked) {
          stLog(st, `GPT 终审查询失败，改用 DeepSeek：${errMsg(e)}`);
          st.agent.status = 'pending';
          st.agent.forceDS = true;
          return {};
        }
        return { waitMs: isCron ? 15000 : 4000, polling: true };
      }
    }
    if (st.agent.status === 'done') {
      st.step = 'finalize';
      return {};
    }
    return { waitMs: 3000 };
  }

  if (st.step === 'finalize') {
    drainUsage(inv, st);
    let balance = null;
    if (keys.deepseekKey) {
      try { balance = { deepseek: await deepseekBalance(inv, keys.deepseekKey) }; } catch (e) { balance = { deepseekError: errMsg(e) }; }
    }
    const memory = await getMemory(db, cfg);
    const sel = selectFinal(cfg, st, st.agent.result, memory);
    const stmts = [db.prepare('DELETE FROM items WHERE issue_id = ?').bind(issue.id)];
    sel.live.forEach((d, i) => stmts.push(db.prepare('INSERT INTO items (issue_id, kind, pos, data) VALUES (?, ?, ?, ?)').bind(issue.id, 'live', i, JSON.stringify(d))));
    sel.personal.forEach((d, i) => stmts.push(db.prepare('INSERT INTO items (issue_id, kind, pos, data) VALUES (?, ?, ?, ?)').bind(issue.id, 'personal', i, JSON.stringify(d))));
    await db.batch(stmts);
    const engines = {
      deepseek: st.ds.status, gpt: st.oa.status, agent: st.agent.engine,
    };
    const usage = st.usage || emptyUsage();
    try { await addMonthlyUsage(db, usage); } catch { /* non-critical */ }
    st.meta = {
      headline: sel.headline, weather: st.weather, picked: st.picked, engines,
      poolSize: (st.pool || []).length, live: sel.live.length, personal: sel.personal.length, generatedAt: Date.now(),
      usage, costCny: Math.round(usageTotalCny(usage) * 1000) / 1000, usdCny: USD_CNY, balance,
    };
    stLog(st, `清单完成：实时 ${sel.live.length} 条 + 个性化 ${sel.personal.length} 条（终审：${st.agent.engine === 'gpt' ? 'GPT' : st.agent.engine === 'deepseek' ? 'DeepSeek' : '规则'}）`);
    st.step = 'done';
    return { finalized: true };
  }
  return { stop: true };
}

async function finishOaJob(inv, cfg, keys, st, job, resp) {
  recordOaUsage(inv, cfg.models.openaiSearch, resp);
  const { text, urls } = openaiExtract(resp);
  let j = extractJson(text);
  if ((!j || !Array.isArray(j.candidates)) && text && text.length > 50) {
    try { j = await repairJson(inv, keys, cfg, text, '{"candidates":[{"title":"","category":"","city":"","venue":"","address":"","date_text":"","time_text":"","price_text":"","summary":"","booking":"","booking_url":"","urls":[],"confidence":""}]}'); } catch { j = null; }
  }
  const list = j && Array.isArray(j.candidates) ? j.candidates : [];
  job.candidates = normalizeOaCandidates(list, urls);
  job.status = job.candidates.length ? 'done' : 'failed';
  if (!job.candidates.length) job.error = text ? '结果无法解析' : '没有返回内容';
}

async function finishAgent(inv, cfg, keys, st, resp) {
  recordOaUsage(inv, cfg.models.openaiAgent, resp);
  const { text, urls } = openaiExtract(resp);
  st.agent.urls = urls;
  let j = extractJson(text);
  if ((!j || (!Array.isArray(j.live) && !Array.isArray(j.personal))) && text && text.length > 50) {
    try { j = await repairJson(inv, keys, cfg, text, '{"headline":"","live":[{"ref":"","title":"","emoji":"","category":"","city":"","when":"","where":"","price":"","summary":"","reason":"","booking":"","booking_url":"","urls":[]}],"personal":[{"title":"","emoji":"","category":"","activity":"","city":"","when":"","where":"","summary":"","reason":"","how":"","map_query":"","search_query":"","ref":""}]}'); } catch { j = null; }
  }
  if (!j || (!Array.isArray(j.live) && !Array.isArray(j.personal))) {
    stLog(st, 'GPT 终审结果无法解析，改用 DeepSeek');
    st.agent.status = 'pending';
    st.agent.forceDS = true;
    return;
  }
  st.agent.result = sanitizeAgentOut(j, st.agent.urls);
  st.agent.status = 'done';
  st.agent.engine = 'gpt';
}

async function buildAgentContext(db, cfg, st) {
  const memory = await getMemory(db, cfg);
  const rows = (await db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 15').all()).results || [];
  const notes = rows.reverse().map((n) => `${userName(cfg, n.user_id)}（${ymdOf(n.created_at)}）：${clampStr(n.text, 200)}`);
  const history = await historyContext(db, cfg, { beforeSat: st.sat, limit: 6 });
  const mem = { ...memory };
  delete mem.updated_at;
  return { memory: mem, notes, history };
}

// Run the pipeline for up to budgetMs. Returns the (fresh) issue row.
async function runPipeline(inv, env, issueId, opts = {}) {
  const db = env.DB;
  const budgetMs = opts.budgetMs || 20000;
  const lockMs = opts.lockMs || 6 * MIN;
  if (!(await acquireLock(db, issueId, lockMs))) return { busy: true, issue: await getIssue(db, issueId) };
  const t0 = Date.now();
  try {
    const cfg = await getConfig(db);
    const keys = await getSecrets(env, db);
    let issue = await getIssue(db, issueId);
    if (!issue || issue.status !== 'running') return { issue };
    const st = parseJsonSafe(issue.state, null) || initialState(cfg, issue.sat);
    let lastSaved = JSON.stringify(st);
    let loops = 0;
    while (loops++ < 40) {
      // D1 free plan allows 50 queries per invocation — leave room for finalize/publish
      if (inv.dbq > (st.step === 'finalize' ? 18 : 32)) break;
      let res;
      try {
        res = await advanceOnce(inv, env, db, cfg, keys, issue, st, opts);
      } catch (e) {
        stLog(st, `出错：${errMsg(e)}`);
        await logEvent(db, 'error', `生成第 ${issue.sat} 期时出错（步骤 ${st.step}）：${errMsg(e)}`);
        st.errors = (st.errors || 0) + 1;
        if (st.errors >= 6) res = { failed: errMsg(e) };
        else res = { waitMs: 3000 };
      }
      if (!res.finalized) drainUsage(inv, st);
      if (res.failed) {
        stLog(st, res.failed);
        await saveIssueState(db, issueId, st, { status: 'failed', error: clampStr(res.failed, 500) });
        await logEvent(db, 'error', `第 ${issue.sat} 期生成失败：${res.failed}`);
        break;
      }
      if (res.finalized) {
        await saveIssueState(db, issueId, slimState(st), { status: 'ready', meta: { ...parseJsonSafe(issue.meta, {}), ...st.meta }, ready_at: Date.now(), error: null });
        await logEvent(db, 'info', `第 ${issue.sat} 期清单已生成`);
        break;
      }
      const now = JSON.stringify(st);
      if (now !== lastSaved) { await saveIssueState(db, issueId, st); lastSaved = now; }
      if (res.stop) break;
      const elapsed = Date.now() - t0;
      if (elapsed > budgetMs || inv.subreq >= SUBREQ_SOFT_LIMIT) break;
      if (res.waitMs) {
        if (elapsed + res.waitMs > budgetMs) break;
        await sleep(res.waitMs);
      }
    }
  } finally {
    await releaseLock(db, issueId);
  }
  return { issue: await getIssue(db, issueId) };
}
function slimState(st) {
  const s = { ...st };
  s.pool = (st.pool || []).map((p) => ({ id: p.id, title: p.title, city: p.city, origin: p.origin, urls: (p.urls || []).slice(0, 2), booking_url: p.booking_url }));
  if (s.agent) s.agent = { ...s.agent, result: null };
  return s;
}

// ---------- publish & notify ----------
async function publishIssue(inv, db, cfg, issue, { notifyWho = 'all', reason = 'scheduled', byUser = null } = {}) {
  const meta = parseJsonSafe(issue.meta, {});
  const t = Date.now();
  if (issue.status !== 'published') {
    await db.prepare(`UPDATE issues SET status = 'published', published_at = ? WHERE id = ?`).bind(t, issue.id).run();
  }
  let summary = null;
  if (notifyWho && (notifyWho === 'all' || (Array.isArray(notifyWho) && notifyWho.length))) {
    const title = byUser ? `${userName(cfg, byUser)} 刷新了周末清单` : `🎉 ${cnDate(issue.sat)}这个周末玩什么？`;
    const body = meta.headline || '本周末的备选清单来啦，快来看看～';
    summary = await notifyUsers(inv, db, cfg, notifyWho, { title, body, url: `/?issue=${issue.id}` });
    meta.pushes = [...(meta.pushes || []), { ts: t, reason, sent: summary.sent, failed: summary.failed }].slice(-10);
  }
  if (reason === 'scheduled') meta.scheduledPushSent = true;
  await db.prepare('UPDATE issues SET meta = ? WHERE id = ?').bind(JSON.stringify(meta), issue.id).run();
  return summary;
}

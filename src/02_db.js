// ============================================================
//  Database (Cloudflare D1)
// ============================================================

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_key TEXT NOT NULL UNIQUE,
    sat TEXT NOT NULL,
    city TEXT NOT NULL,
    status TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '{}',
    meta TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    trigger TEXT,
    lock_until INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    activity_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ready_at INTEGER,
    published_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_issues_sat ON issues(sat)`,
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    pos INTEGER NOT NULL,
    data TEXT NOT NULL,
    chosen_by TEXT,
    chosen_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_issue ON items(issue_id)`,
  `CREATE TABLE IF NOT EXISTS reactions (item_id INTEGER NOT NULL, user_id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (item_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, item_id INTEGER, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id)`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, digested INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, profile TEXT NOT NULL)`,
];

// Wrap the D1 binding so we can count queries per invocation (free plan: 50)
function wrapDb(db, inv) {
  if (!db || typeof db.prepare !== 'function') return db;
  const wrapStmt = (s) => ({
    __raw: s,
    bind: (...a) => wrapStmt(s.bind(...a)),
    first: (...a) => { inv.dbq++; return s.first(...a); },
    all: (...a) => { inv.dbq++; return s.all(...a); },
    run: (...a) => { inv.dbq++; return s.run(...a); },
    raw: (...a) => { inv.dbq++; return s.raw(...a); },
  });
  return {
    __wrapped: true,
    prepare: (sql) => wrapStmt(db.prepare(sql)),
    batch: (stmts) => { inv.dbq += stmts.length; return db.batch(stmts.map((x) => (x && x.__raw) || x)); },
  };
}

let schemaReady = false;
async function ensureSchema(env) {
  const db = env.DB;
  if (!db || typeof db.prepare !== 'function') {
    throw new HttpError(500, '没有找到数据库绑定：请在 Cloudflare 的 Worker 设置 → 绑定(Bindings) 里添加 D1 数据库，变量名必须是 DB');
  }
  if (schemaReady) return db;
  let ok = false;
  try {
    const row = await db.prepare(`SELECT v FROM kv WHERE k = 'schema_version'`).first();
    ok = !!row && row.v === JSON.stringify(SCHEMA_VERSION);
  } catch { ok = false; }
  if (!ok) {
    await db.batch(SCHEMA.map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO kv (k, v, updated_at) VALUES ('schema_version', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`)
      .bind(JSON.stringify(SCHEMA_VERSION), Date.now()).run();
  }
  schemaReady = true;
  return db;
}

async function kvGet(db, k, fallback = null) {
  const row = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  if (!row) return fallback;
  return parseJsonSafe(row.v, fallback);
}
async function kvSet(db, k, v) {
  await db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
    .bind(k, JSON.stringify(v), Date.now()).run();
}
async function kvSetIfAbsent(db, k, v) {
  const r = await db.prepare('INSERT OR IGNORE INTO kv (k, v, updated_at) VALUES (?, ?, ?)').bind(k, JSON.stringify(v), Date.now()).run();
  return !!(r && r.meta && r.meta.changes);
}

function mergeConfig(raw) {
  const d = defaultConfig();
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = { ...d, ...c };
  out.push = { ...d.push, ...(c.push || {}) };
  out.counts = { ...d.counts, ...(c.counts || {}) };
  out.models = { ...d.models, ...(c.models || {}) };
  out.bark = { ...d.bark, ...(c.bark || {}) };
  if (!Array.isArray(out.users) || out.users.length !== 2) out.users = d.users;
  if (!Array.isArray(out.nearby)) out.nearby = [];
  if (!Array.isArray(out.activities) || !out.activities.length) out.activities = d.activities;
  return out;
}
async function getConfig(db) {
  return mergeConfig(await kvGet(db, 'config', null));
}
async function saveConfig(db, cfg) {
  await kvSet(db, 'config', cfg);
}
async function getSecrets(env, db) {
  const s = (await kvGet(db, 'secrets', null)) || {};
  return {
    passHash: s.passHash || '',
    passSalt: s.passSalt || '',
    openaiKey: (env.OPENAI_API_KEY || s.openaiKey || '').trim(),
    deepseekKey: (env.DEEPSEEK_API_KEY || s.deepseekKey || '').trim(),
    openaiFromEnv: !!env.OPENAI_API_KEY,
    deepseekFromEnv: !!env.DEEPSEEK_API_KEY,
  };
}
async function saveSecrets(db, patch) {
  const s = (await kvGet(db, 'secrets', null)) || {};
  await kvSet(db, 'secrets', { ...s, ...patch });
}

async function logEvent(db, level, msg) {
  const text = clampStr(msg, 2000);
  try {
    console.log(`[${level}] ${text}`);
    await db.prepare('INSERT INTO logs (ts, level, msg) VALUES (?, ?, ?)').bind(Date.now(), level, text).run();
  } catch (e) { console.log('log failed', errMsg(e)); }
}

function userName(cfg, id) {
  const u = cfg.users.find((x) => x.id === id);
  return u ? u.name : id;
}

// ---------- issues ----------
async function getIssue(db, id) {
  return db.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first();
}
async function getIssueByWeek(db, sat) {
  return db.prepare('SELECT * FROM issues WHERE week_key = ?').bind(sat).first();
}
async function createIssue(db, cfg, sat, trigger) {
  const t = Date.now();
  const st = initialState(cfg, sat);
  await db.prepare(`INSERT OR IGNORE INTO issues (week_key, sat, city, status, state, meta, trigger, created_at, updated_at, attempts)
    VALUES (?, ?, ?, 'running', ?, '{}', ?, ?, ?, 1)`)
    .bind(sat, sat, cfg.city, JSON.stringify(st), trigger, t, t).run();
  return getIssueByWeek(db, sat);
}
// Move an existing issue out of the way (keeps its votes/comments as history)
async function archiveIssue(db, issue) {
  const newKey = `${issue.week_key}~${Date.now()}`;
  await db.prepare(`UPDATE issues SET week_key = ?, status = CASE WHEN status IN ('running','failed') THEN 'discarded' ELSE 'archived' END, lock_until = 0, updated_at = ? WHERE id = ?`)
    .bind(newKey, Date.now(), issue.id).run();
}
async function saveIssueState(db, id, st, extra = {}) {
  const sets = ['state = ?', 'updated_at = ?'];
  const vals = [JSON.stringify(st), Date.now()];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    vals.push(v && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  vals.push(id);
  await db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}
async function acquireLock(db, id, ms) {
  const t = Date.now();
  const r = await db.prepare('UPDATE issues SET lock_until = ? WHERE id = ? AND lock_until < ?').bind(t + ms, id, t).run();
  return !!(r && r.meta && r.meta.changes);
}
async function releaseLock(db, id) {
  await db.prepare('UPDATE issues SET lock_until = 0 WHERE id = ?').bind(id).run();
}
async function recentPublishedIssues(db, limit, beforeSat) {
  const r = await db.prepare(`SELECT * FROM issues WHERE status IN ('published','ready') AND sat < ? ORDER BY sat DESC LIMIT ?`)
    .bind(beforeSat || '9999-12-31', limit).all();
  return r.results || [];
}
async function itemsFor(db, issueId) {
  const r = await db.prepare('SELECT * FROM items WHERE issue_id = ? ORDER BY kind, pos').bind(issueId).all();
  return (r.results || []).map((row) => ({ ...row, data: parseJsonSafe(row.data, {}) }));
}

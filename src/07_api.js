// ============================================================
//  HTTP API
// ============================================================

let knownOrigin = null;

async function readBody(request) {
  const text = await request.text();
  if (text.length > 200000) throw new HttpError(413, '请求内容太大');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, '请求格式错误'); }
}

// Weekend that "generate now" / "current list" refers to.
function targetWeekend(ts = Date.now()) {
  const p = bjParts(ts);
  if (p.dow === 0 && p.h >= 12) {
    const sat = addDaysYmd(ymdOf(ts), 6);
    return { sat, sun: addDaysYmd(sat, 1) };
  }
  return weekendFor(ts);
}

async function hashPassword(salt, pass) { return sha256Hex(`${salt}:${pass}`); }

async function checkLoginThrottle(db) {
  const f = await kvGet(db, 'login_fail', null);
  if (f && f.until && f.until > Date.now()) {
    throw new HttpError(429, `密码错误次数太多，请 ${Math.ceil((f.until - Date.now()) / MIN)} 分钟后再试`);
  }
  return f;
}
async function recordLoginFail(db, f) {
  const t = Date.now();
  const recent = f && f.first && t - f.first < 15 * MIN ? f : { first: t, count: 0 };
  recent.count++;
  if (recent.count >= 8) { recent.until = t + 15 * MIN; recent.count = 0; recent.first = t; }
  await kvSet(db, 'login_fail', recent);
}

async function authenticate(request, env, db, { needUser = true } = {}) {
  const cfg = await getConfig(db);
  if (!cfg.setupDone) throw new HttpError(409, '还没有完成初始化');
  const keys = await getSecrets(env, db);
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) throw new HttpError(401, '请先登录');
  const hash = await hashPassword(keys.passSalt, token);
  if (!keys.passHash || !safeEqual(hash, keys.passHash)) throw new HttpError(401, '密码已更改或不正确，请重新登录');
  let userId = (request.headers.get('X-User') || '').trim();
  if (needUser && !cfg.users.some((u) => u.id === userId)) throw new HttpError(400, '请先选择你是谁');
  if (!needUser && !cfg.users.some((u) => u.id === userId)) userId = '';
  return { cfg, keys, userId };
}

function publicConfig(cfg) {
  return {
    city: cfg.city, nearby: cfg.nearby, users: cfg.users, push: cfg.push, counts: cfg.counts,
    activities: cfg.activities, models: cfg.models, agentWebSearch: cfg.agentWebSearch,
    barkSet: Object.fromEntries(cfg.users.map((u) => [u.id, !!(cfg.bark && cfg.bark[u.id])])),
  };
}
function publicIssue(issue) {
  if (!issue) return null;
  const meta = parseJsonSafe(issue.meta, {});
  return {
    id: issue.id, sat: issue.sat, sun: addDaysYmd(issue.sat, 1), city: issue.city, status: issue.status,
    headline: meta.headline || '', weather: meta.weather || null, engines: meta.engines || null, picked: meta.picked || [],
    poolSize: meta.poolSize || 0, created_at: issue.created_at, ready_at: issue.ready_at, published_at: issue.published_at,
    trigger: issue.trigger, error: issue.error || '',
    usage: meta.usage || null, costCny: meta.costCny != null ? meta.costCny : null, usdCny: meta.usdCny || USD_CNY, balance: meta.balance || null,
  };
}
function genStatus(issue) {
  if (!issue) return null;
  const st = parseJsonSafe(issue.state, {});
  return {
    id: issue.id, sat: issue.sat, status: issue.status, step: st.step || '', log: (st.log || []).slice(-14),
    error: issue.error || '', locked: (issue.lock_until || 0) > Date.now(), updated_at: issue.updated_at,
  };
}

async function loadIssueView(db, cfg, issue) {
  if (!issue) return { issue: null, items: [], general: [] };
  const items = await itemsFor(db, issue.id);
  const reacts = (await db.prepare('SELECT r.item_id, r.user_id, r.value, r.updated_at FROM reactions r JOIN items i ON i.id = r.item_id WHERE i.issue_id = ?').bind(issue.id).all()).results || [];
  const comments = (await db.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY id').bind(issue.id).all()).results || [];
  const view = items.map((it) => ({
    id: it.id, kind: it.kind, pos: it.pos, data: it.data, chosen_by: it.chosen_by || null, chosen_at: it.chosen_at || null,
    reactions: Object.fromEntries(reacts.filter((r) => r.item_id === it.id).map((r) => [r.user_id, r.value])),
    comments: comments.filter((c) => c.item_id === it.id).map((c) => ({ id: c.id, user_id: c.user_id, text: c.text, created_at: c.created_at })),
  }));
  const general = comments.filter((c) => !c.item_id).map((c) => ({ id: c.id, user_id: c.user_id, text: c.text, created_at: c.created_at }));
  return { issue: publicIssue(issue), items: view, general };
}

async function currentViewIssue(db, ts) {
  const wk = targetWeekend(ts);
  const cur = await getIssueByWeek(db, wk.sat);
  if (cur && (cur.status === 'published' || cur.status === 'ready')) return { view: cur, gen: null, wk };
  // while a list is being regenerated, keep showing the previous version of it
  const latest = await db.prepare(`SELECT * FROM issues WHERE status IN ('published','ready','archived') ORDER BY sat DESC, CASE WHEN status = 'archived' THEN 1 ELSE 0 END, id DESC LIMIT 1`).first();
  return { view: latest || null, gen: cur && (cur.status === 'running' || cur.status === 'failed') ? cur : null, wk };
}

function nextPushTs(cfg, ts = Date.now()) {
  let wk = weekendFor(ts);
  let p = pushTsFor(cfg, wk.sat);
  if (p < ts) p = pushTsFor(cfg, addDaysYmd(wk.sat, 7));
  return p;
}

async function touchIssue(db, issueId) {
  await db.prepare('UPDATE issues SET activity_at = ? WHERE id = ?').bind(Date.now(), issueId).run();
}

async function itemWithIssue(db, itemId) {
  const it = await db.prepare('SELECT i.*, s.sat AS sat, s.status AS issue_status FROM items i JOIN issues s ON s.id = i.issue_id WHERE i.id = ?').bind(Number(itemId) || 0).first();
  if (!it) throw new HttpError(404, '找不到这条建议（清单可能已重新生成）');
  return it;
}

function validateConfigPatch(cfg, patch) {
  const next = JSON.parse(JSON.stringify(cfg));
  if (patch.city !== undefined) {
    const c = clampStr(String(patch.city).trim().replace(/市$/, ''), 12);
    if (!c) throw new HttpError(400, '城市不能为空');
    if (c !== next.city) {
      next.city = c;
      if (patch.nearby === undefined) next.nearby = (NEARBY_PRESETS[c] || []).map((x) => ({ ...x }));
    }
  }
  if (patch.nearby !== undefined) {
    if (!Array.isArray(patch.nearby)) throw new HttpError(400, '周边城市格式错误');
    const seen = new Set();
    next.nearby = patch.nearby.map((x) => ({ name: clampStr(String((x && x.name) || '').trim().replace(/市$/, ''), 12), hours: Math.round(Math.min(6, Math.max(0.3, Number(x && x.hours) || 2)) * 10) / 10 }))
      .filter((x) => x.name && x.name !== next.city && !seen.has(x.name) && seen.add(x.name)).slice(0, 15);
  }
  if (patch.users !== undefined) {
    if (!Array.isArray(patch.users) || patch.users.length !== 2) throw new HttpError(400, '用户格式错误');
    next.users = next.users.map((u, i) => ({ id: u.id, name: clampStr(String((patch.users[i] && patch.users[i].name) || u.name).trim(), 12) || u.name }));
  }
  if (patch.push !== undefined) {
    const p = patch.push || {};
    if (p.weekday !== undefined) {
      const w = Number(p.weekday);
      if (!Number.isInteger(w) || w < 0 || w > 6) throw new HttpError(400, '推送星期错误');
      next.push.weekday = w;
    }
    if (p.time !== undefined) {
      if (!parseHHMM(p.time)) throw new HttpError(400, '推送时间格式应为 HH:MM');
      const t = parseHHMM(p.time);
      next.push.time = `${pad2(t.h)}:${pad2(t.mi)}`;
    }
    if (p.sundayReminder !== undefined) next.push.sundayReminder = !!p.sundayReminder;
    if (p.commentNotify !== undefined) next.push.commentNotify = !!p.commentNotify;
  }
  if (patch.counts !== undefined) {
    const live = Math.round(Number(patch.counts.live));
    const personal = Math.round(Number(patch.counts.personal));
    if (!(live >= 0 && live <= 8 && personal >= 0 && personal <= 8 && live + personal >= 1)) throw new HttpError(400, '条数范围：每类 0~8 条');
    next.counts = { live, personal };
  }
  if (patch.activities !== undefined) {
    if (!Array.isArray(patch.activities)) throw new HttpError(400, '活动列表格式错误');
    const acts = [...new Set(patch.activities.map((a) => clampStr(String(a || '').trim(), 16)).filter(Boolean))].slice(0, 30);
    if (!acts.length) throw new HttpError(400, '至少保留一项平时活动');
    next.activities = acts;
  }
  if (patch.models !== undefined) {
    for (const k of ['openaiSearch', 'openaiAgent', 'deepseekPlanner', 'deepseekExtractor']) {
      if (patch.models[k] !== undefined) {
        const v = String(patch.models[k]).trim();
        if (!/^[A-Za-z0-9._:\-/]{2,64}$/.test(v)) throw new HttpError(400, `模型名不合法：${v}`);
        next.models[k] = v;
      }
    }
    if (patch.models.openaiEffort !== undefined) {
      if (!['low', 'medium', 'high'].includes(patch.models.openaiEffort)) throw new HttpError(400, '推理强度只能是 low/medium/high');
      next.models.openaiEffort = patch.models.openaiEffort;
    }
  }
  if (patch.agentWebSearch !== undefined) next.agentWebSearch = !!patch.agentWebSearch;
  if (patch.bark !== undefined) {
    for (const u of next.users) {
      if (patch.bark[u.id] !== undefined) {
        const v = String(patch.bark[u.id] || '').trim();
        if (v && !isHttpUrl(v)) throw new HttpError(400, 'Bark 地址应以 https:// 开头');
        next.bark[u.id] = v;
      }
    }
  }
  return next;
}

async function handleApi(request, env, ctx, url) {
  const inv = newInv('http');
  env = { ...env, DB: wrapDb(env.DB, inv) };
  const db = await ensureSchema(env);
  const path = url.pathname;
  const method = request.method;

  if (knownOrigin !== url.origin && url.protocol === 'https:') {
    await kvSet(db, 'origin', url.origin);
    knownOrigin = url.origin;
  }

  // ---------- public ----------
  if (path === '/api/health') {
    // non-sensitive deployment check (no keys, no personal data)
    const cfg = await getConfig(db);
    const lastTick = await kvGet(db, 'last_tick', null);
    return jsonRes({
      ok: true, build: BUILD_ID, database: 'ok', setupDone: !!cfg.setupDone,
      cron: lastTick ? (Date.now() - lastTick.ts < 20 * MIN ? 'ok' : 'stale') : 'never',
      lastTickMinutesAgo: lastTick ? Math.round((Date.now() - lastTick.ts) / MIN) : null,
    });
  }
  if (path === '/api/bootstrap') {
    const cfg = await getConfig(db);
    const defaults = cfg.setupDone ? null : {
      city: cfg.city,
      names: (USER_CONFIG.defaultNames || []).map((n) => String(n || '')),
      activities: cfg.activities,
    };
    return jsonRes({ setupDone: !!cfg.setupDone, appName: APP_NAME, users: cfg.setupDone ? cfg.users : [], build: BUILD_ID, defaults });
  }
  if (path === '/api/setup' && method === 'POST') {
    const cfg = await getConfig(db);
    if (cfg.setupDone) throw new HttpError(409, '已经初始化过了，请直接登录');
    const b = await readBody(request);
    const pass = String(b.password || '');
    if (pass.length < 6) throw new HttpError(400, '访问密码至少 6 位');
    const openaiKey = String(b.openaiKey || '').trim();
    const deepseekKey = String(b.deepseekKey || '').trim();
    if (!openaiKey && !deepseekKey && !env.OPENAI_API_KEY && !env.DEEPSEEK_API_KEY) throw new HttpError(400, '至少填写一个 AI 的 API Key');
    const names = Array.isArray(b.users) ? b.users.map((u) => String((u && u.name) || '').trim()) : [];
    if (names.length !== 2 || !names[0] || !names[1]) throw new HttpError(400, '请填写两个人的名字');
    if (names[0] === names[1]) throw new HttpError(400, '两个人的名字不能一样');
    const patch = { city: b.city || cfg.city, users: names.map((name) => ({ name })) };
    if (Array.isArray(b.activities) && b.activities.length) patch.activities = b.activities;
    let next = validateConfigPatch(cfg, patch);
    next.setupDone = true;
    const salt = randomHex(16);
    await saveSecrets(db, { passSalt: salt, passHash: await hashPassword(salt, pass), openaiKey, deepseekKey });
    await saveConfig(db, next);
    await getVapid(db);
    await logEvent(db, 'info', '初始化完成');
    return jsonRes({ ok: true, users: next.users });
  }
  if (path === '/api/login' && method === 'POST') {
    const cfg = await getConfig(db);
    if (!cfg.setupDone) throw new HttpError(409, '还没有完成初始化');
    const f = await checkLoginThrottle(db);
    const b = await readBody(request);
    const keys = await getSecrets(env, db);
    const hash = await hashPassword(keys.passSalt, String(b.password || ''));
    if (!safeEqual(hash, keys.passHash)) {
      await recordLoginFail(db, f);
      throw new HttpError(401, '密码不对哦');
    }
    if (f) await kvSet(db, 'login_fail', { first: 0, count: 0 });
    return jsonRes({ ok: true, users: cfg.users });
  }

  // ---------- authenticated ----------
  const needUser = !(path === '/api/diag' || path === '/api/diag/test');
  const { cfg, keys, userId } = await authenticate(request, env, db, { needUser });

  if (path === '/api/state' && method === 'GET') {
    const now = Date.now();
    const qid = Number(url.searchParams.get('issue') || 0);
    let viewIssue = null, gen = null, wk = targetWeekend(now);
    if (qid) {
      viewIssue = await getIssue(db, qid);
      if (!viewIssue) throw new HttpError(404, '找不到这一期');
      const cur = await getIssueByWeek(db, wk.sat);
      if (cur && (cur.status === 'running' || cur.status === 'failed')) gen = cur;
    } else {
      const r = await currentViewIssue(db, now);
      viewIssue = r.view; gen = r.gen; wk = r.wk;
    }
    const view = await loadIssueView(db, cfg, viewIssue);
    const subs = (await db.prepare('SELECT user_id, COUNT(*) AS n FROM push_subs GROUP BY user_id').all()).results || [];
    const vapid = await getVapid(db);
    const month = await kvGet(db, `usage:${ymdOf(now).slice(0, 7)}`, null);
    return jsonRes({
      monthCostCny: Math.round(usageTotalCny(month) * 100) / 100,
      me: userId, users: cfg.users, config: publicConfig(cfg), now,
      target: wk, isCurrent: !!(view.issue && view.issue.sat === wk.sat),
      nextPushTs: nextPushTs(cfg, now),
      ...view,
      gen: genStatus(gen),
      push: { vapidPublicKey: vapid.publicKey, subs: Object.fromEntries(subs.map((s) => [s.user_id, s.n])) },
      keys: { openai: !!keys.openaiKey, deepseek: !!keys.deepseekKey },
    });
  }

  if (path === '/api/react' && method === 'POST') {
    const b = await readBody(request);
    const it = await itemWithIssue(db, b.itemId);
    const v = b.value;
    if (v === '' || v === null || v === undefined) {
      await db.prepare('DELETE FROM reactions WHERE item_id = ? AND user_id = ?').bind(it.id, userId).run();
    } else {
      if (!['want', 'maybe', 'no'].includes(v)) throw new HttpError(400, '无效的选项');
      await db.prepare(`INSERT INTO reactions (item_id, user_id, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(item_id, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(it.id, userId, v, Date.now()).run();
    }
    await touchIssue(db, it.issue_id);
    return jsonRes({ ok: true });
  }

  if (path === '/api/choose' && method === 'POST') {
    const b = await readBody(request);
    const it = await itemWithIssue(db, b.itemId);
    const chosen = !!b.chosen;
    await db.prepare('UPDATE items SET chosen_by = ?, chosen_at = ? WHERE id = ?').bind(chosen ? userId : null, chosen ? Date.now() : null, it.id).run();
    await touchIssue(db, it.issue_id);
    if (chosen && cfg.push.commentNotify) {
      const other = cfg.users.map((u) => u.id).filter((id) => id !== userId);
      const d = parseJsonSafe(it.data, {});
      ctx.waitUntil(notifyUsers(newInv('bg'), db, cfg, other, { title: `${userName(cfg, userId)} 定了一个周末计划 ✅`, body: `${d.emoji || ''} ${d.title || ''}`, url: `/?issue=${it.issue_id}` }).catch(() => {}));
    }
    return jsonRes({ ok: true });
  }

  if (path === '/api/comment' && method === 'POST') {
    const b = await readBody(request);
    const text = String(b.text || '').trim();
    if (!text) throw new HttpError(400, '说点什么吧');
    if (text.length > 500) throw new HttpError(400, '留言太长了（最多 500 字）');
    let issueId = Number(b.issueId) || 0;
    let itemId = null;
    let itemTitle = '';
    if (b.itemId) {
      const it = await itemWithIssue(db, b.itemId);
      issueId = it.issue_id;
      itemId = it.id;
      itemTitle = parseJsonSafe(it.data, {}).title || '';
    } else {
      const iss = await getIssue(db, issueId);
      if (!iss) throw new HttpError(404, '找不到这一期');
    }
    const r = await db.prepare('INSERT INTO comments (issue_id, item_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)').bind(issueId, itemId, userId, text, Date.now()).run();
    await touchIssue(db, issueId);
    if (cfg.push.commentNotify) {
      const other = cfg.users.map((u) => u.id).filter((id) => id !== userId);
      ctx.waitUntil(notifyUsers(newInv('bg'), db, cfg, other, {
        title: `💬 ${userName(cfg, userId)}${itemTitle ? ` 评论了「${clampStr(itemTitle, 16)}」` : ' 留言了'}`,
        body: clampStr(text, 120), url: `/?issue=${issueId}`,
      }).catch(() => {}));
    }
    return jsonRes({ ok: true, id: r.meta && r.meta.last_row_id });
  }
  if (path === '/api/comment/delete' && method === 'POST') {
    const b = await readBody(request);
    const c = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(Number(b.id) || 0).first();
    if (!c) return jsonRes({ ok: true });
    if (c.user_id !== userId) throw new HttpError(403, '只能删除自己的留言');
    await db.prepare('DELETE FROM comments WHERE id = ?').bind(c.id).run();
    return jsonRes({ ok: true });
  }

  if (path === '/api/issues' && method === 'GET') {
    const rows = (await db.prepare(`SELECT * FROM issues WHERE status IN ('published','ready','archived') ORDER BY sat DESC, id DESC LIMIT 40`).all()).results || [];
    let chosen = [];
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      chosen = (await db.prepare(`SELECT issue_id, data, chosen_by FROM items WHERE chosen_by IS NOT NULL AND issue_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || [];
    }
    return jsonRes({
      issues: rows.map((r) => ({
        ...publicIssue(r),
        chosen: chosen.filter((c) => c.issue_id === r.id).map((c) => { const d = parseJsonSafe(c.data, {}); return { title: d.title, emoji: d.emoji, by: c.chosen_by }; }),
      })),
    });
  }

  if (path === '/api/memory' && method === 'GET') {
    const profile = await getMemory(db, cfg);
    const notes = (await db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 40').all()).results || [];
    const hist = await db.prepare('SELECT COUNT(*) AS n, MAX(ts) AS last FROM memory_history').first();
    return jsonRes({ profile, notes, versions: (hist && hist.n) || 0, lastUpdated: (hist && hist.last) || 0, activities: cfg.activities, users: cfg.users });
  }
  if (path === '/api/memory' && method === 'POST') {
    const b = await readBody(request);
    if (!b.profile || typeof b.profile !== 'object') throw new HttpError(400, '记忆格式错误');
    const p = sanitizeProfile(b.profile, cfg);
    await kvSet(db, 'memory', p);
    await db.prepare('INSERT INTO memory_history (ts, source, profile) VALUES (?, ?, ?)').bind(Date.now(), `manual:${userId}`, JSON.stringify(p)).run();
    return jsonRes({ ok: true, profile: p });
  }
  if (path === '/api/memory/refresh' && method === 'POST') {
    return streamingJson(ctx, async () => {
      const r = await updateMemory(inv, db, cfg, keys, { force: true });
      try { await addMonthlyUsage(db, inv.usage); } catch { /* non-critical */ }
      return { ok: true, ...r, costCny: Math.round(usageTotalCny(inv.usage) * 1000) / 1000, profile: await getMemory(db, cfg) };
    });
  }
  if (path === '/api/note' && method === 'POST') {
    const b = await readBody(request);
    const text = String(b.text || '').trim();
    if (!text) throw new HttpError(400, '内容不能为空');
    if (text.length > 500) throw new HttpError(400, '最多 500 字');
    await db.prepare('INSERT INTO notes (user_id, text, created_at) VALUES (?, ?, ?)').bind(userId, text, Date.now()).run();
    return jsonRes({ ok: true });
  }
  if (path === '/api/note/delete' && method === 'POST') {
    const b = await readBody(request);
    const n = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(Number(b.id) || 0).first();
    if (n && n.user_id !== userId) throw new HttpError(403, '只能删除自己写的');
    if (n) await db.prepare('DELETE FROM notes WHERE id = ?').bind(n.id).run();
    return jsonRes({ ok: true });
  }

  if (path === '/api/settings' && method === 'GET') {
    const s = (await kvGet(db, 'secrets', null)) || {};
    const mask = (k) => (k ? `${k.slice(0, 3)}…${k.slice(-4)}` : '');
    return jsonRes({
      config: publicConfig(cfg),
      bark: cfg.bark,
      keys: {
        openai: mask(keys.openaiKey), deepseek: mask(keys.deepseekKey),
        openaiFromEnv: keys.openaiFromEnv, deepseekFromEnv: keys.deepseekFromEnv, storedOpenai: !!s.openaiKey, storedDeepseek: !!s.deepseekKey,
      },
      presets: Object.keys(NEARBY_PRESETS),
    });
  }
  if (path === '/api/settings' && method === 'POST') {
    const b = await readBody(request);
    if (b.config) {
      const next = validateConfigPatch(cfg, b.config);
      next.setupDone = true;
      await saveConfig(db, next);
    }
    if (b.keys) {
      const patch = {};
      if (typeof b.keys.openai === 'string' && b.keys.openai.trim()) patch.openaiKey = b.keys.openai.trim();
      if (typeof b.keys.deepseek === 'string' && b.keys.deepseek.trim()) patch.deepseekKey = b.keys.deepseek.trim();
      if (b.keys.clearOpenai) patch.openaiKey = '';
      if (b.keys.clearDeepseek) patch.deepseekKey = '';
      if (Object.keys(patch).length) await saveSecrets(db, patch);
    }
    if (b.password) {
      const np = String(b.password.next || '');
      if (np.length < 6) throw new HttpError(400, '新密码至少 6 位');
      const salt = randomHex(16);
      await saveSecrets(db, { passSalt: salt, passHash: await hashPassword(salt, np) });
    }
    return jsonRes({ ok: true });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const b = await readBody(request);
    const s = b.subscription || {};
    const k = s.keys || {};
    if (!isHttpUrl(s.endpoint) || !k.p256dh || !k.auth) throw new HttpError(400, '推送订阅信息不完整');
    if (b64urlDecode(k.p256dh).length !== 65 || b64urlDecode(k.auth).length !== 16) throw new HttpError(400, '推送订阅密钥无效');
    await db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at, fail_count) VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, fail_count = 0`)
      .bind(s.endpoint, userId, k.p256dh, k.auth, Date.now()).run();
    return jsonRes({ ok: true });
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const b = await readBody(request);
    if (b.endpoint) await db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint), userId).run();
    else await db.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(userId).run();
    return jsonRes({ ok: true });
  }
  if (path === '/api/push/check' && method === 'POST') {
    const b = await readBody(request);
    const mine = (await db.prepare('SELECT endpoint, created_at, fail_count FROM push_subs WHERE user_id = ? ORDER BY created_at').bind(userId).all()).results || [];
    const ep = String(b.endpoint || '');
    return jsonRes({
      known: !!ep && mine.some((s) => s.endpoint === ep),
      devices: mine.map((s) => ({ tail: s.endpoint.slice(-6), host: hostOf(s.endpoint), created_at: s.created_at, fail_count: s.fail_count, current: s.endpoint === ep })),
    });
  }
  if (path === '/api/push/test-device' && method === 'POST') {
    const b = await readBody(request);
    const sub = await db.prepare('SELECT * FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint || ''), userId).first();
    if (!sub) throw new HttpError(404, '服务器上没有这台设备的登记，请先点「重新登记本机」');
    const origin = (await kvGet(db, 'origin', '')) || url.origin;
    const r = await sendWebPush(inv, db, sub, { title: '🩺 推送体检', body: '看到这条，说明这台手机的 App 通知是通的', url: '/', check: String(b.check || '') }, origin);
    if (r.status === 404 || r.status === 410) await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
    await logEvent(db, r.ok ? 'info' : 'warn', `推送体检 → ${userName(cfg, userId)} 设备…${sub.endpoint.slice(-6)}：${r.status} ${r.text}`);
    return jsonRes({ ok: r.ok, status: r.status, text: r.text, removed: r.status === 404 || r.status === 410 });
  }
  if (path === '/api/push/prune' && method === 'POST') {
    const b = await readBody(request);
    const keep = String(b.keep || '');
    const r = await db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint <> ?').bind(userId, keep).run();
    await logEvent(db, 'info', `${userName(cfg, userId)} 清除了 ${(r.meta && r.meta.changes) || 0} 台旧设备`);
    return jsonRes({ ok: true, removed: (r.meta && r.meta.changes) || 0 });
  }
  if (path === '/api/push/test' && method === 'POST') {
    const r = await notifyUsers(inv, db, cfg, userId, { title: '🔔 推送测试', body: `${userName(cfg, userId)}，你能看到这条说明推送已经通了！`, url: '/' });
    return jsonRes({ ok: true, ...r });
  }

  if (path === '/api/gen/start' && method === 'POST') {
    const b = await readBody(request);
    if (!keys.openaiKey && !keys.deepseekKey) throw new HttpError(400, '还没有配置任何 AI 的 API Key（设置 → AI 与密钥）');
    const wk = targetWeekend();
    let issue = await getIssueByWeek(db, wk.sat);
    if (issue && issue.status === 'running') {
      if (b.force && (issue.lock_until || 0) < Date.now() && Date.now() - issue.updated_at > 10 * MIN) {
        await archiveIssue(db, issue);
        issue = null;
      } else {
        return jsonRes({ ok: true, issueId: issue.id, resumed: true });
      }
    }
    if (issue) {
      if (!b.force && (issue.status === 'published' || issue.status === 'ready')) {
        return jsonRes({ ok: false, exists: true, issueId: issue.id, message: '这个周末的清单已经有了，确定要重新生成吗？' });
      }
      await archiveIssue(db, issue);
    }
    issue = await createIssue(db, cfg, wk.sat, 'manual');
    const st = parseJsonSafe(issue.state, {});
    st.by = userId;
    await saveIssueState(db, issue.id, st);
    await logEvent(db, 'info', `${userName(cfg, userId)} 手动生成 ${wk.sat} 期`);
    return jsonRes({ ok: true, issueId: issue.id });
  }
  if (path === '/api/gen/advance' && method === 'POST') {
    const b = await readBody(request);
    const id = Number(b.issueId) || 0;
    return streamingJson(ctx, async () => {
      const issue0 = await getIssue(db, id);
      if (!issue0) throw new HttpError(404, '找不到这次生成任务');
      let issue = issue0;
      let busy = false;
      if (issue.status === 'running') {
        const r = await runPipeline(inv, env, id, { budgetMs: 25000, lockMs: 6 * MIN, allowEmpty: false });
        busy = !!r.busy;
        issue = r.issue || issue;
      }
      if (issue.status === 'ready') {
        const st = parseJsonSafe(issue.state, {});
        const by = st.by || userId;
        const pushTs = pushTsFor(cfg, issue.sat);
        const others = cfg.users.map((u) => u.id).filter((x) => x !== by);
        await publishIssue(inv, db, cfg, issue, { notifyWho: others, reason: Date.now() >= pushTs - 3 * HOUR && Date.now() < pushTs ? 'scheduled' : 'manual', byUser: by });
        issue = await getIssue(db, id);
      }
      return { ok: true, busy, gen: genStatus(issue), status: issue.status };
    });
  }

  if (path === '/api/diag' && method === 'GET') {
    const lastTick = await kvGet(db, 'last_tick', null);
    const logs = (await db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 60').all()).results || [];
    const subs = (await db.prepare('SELECT user_id, COUNT(*) AS n, MAX(fail_count) AS f FROM push_subs GROUP BY user_id').all()).results || [];
    const cur = await getIssueByWeek(db, targetWeekend().sat);
    let dsBalance = null;
    if (keys.deepseekKey) {
      try { dsBalance = await deepseekBalance(inv, keys.deepseekKey); } catch (e) { dsBalance = { error: errMsg(e) }; }
    }
    const month = await kvGet(db, `usage:${ymdOf(Date.now()).slice(0, 7)}`, null);
    return jsonRes({
      dsBalance,
      month: month ? { ...month, cny: Math.round(usageTotalCny(month) * 100) / 100 } : null,
      build: BUILD_ID,
      colo: (request.cf && request.cf.colo) || '',
      keys: { openai: !!keys.openaiKey, deepseek: !!keys.deepseekKey },
      lastTick: lastTick && lastTick.ts,
      cronOk: !!(lastTick && Date.now() - lastTick.ts < 20 * MIN),
      nextPushTs: nextPushTs(cfg),
      subs,
      current: cur ? { ...publicIssue(cur), gen: genStatus(cur) } : null,
      logs,
    });
  }
  if (path === '/api/diag/test' && method === 'POST') {
    const b = await readBody(request);
    const target = b.target;
    return streamingJson(ctx, async () => {
      const t0 = Date.now();
      if (target === 'openai') {
        if (!keys.openaiKey) return { ok: false, message: '未配置 OpenAI Key' };
        const blocked = await checkRegion(inv);
        if (blocked) return { ok: false, message: `当前云端节点 ${inv.colo} 属于 OpenAI 不支持的地区，定时任务会自动换节点重试；手动生成时会自动改用 DeepSeek。` };
        const out = [];
        for (const m of [...new Set([cfg.models.openaiSearch, cfg.models.openaiAgent])]) {
          try { await openaiModelCheck(inv, keys.openaiKey, m); out.push(`${m} ✅`); } catch (e) { out.push(`${m} ❌ ${errMsg(e)}`); }
        }
        const ok = out.every((x) => x.includes('✅'));
        return { ok, message: `${out.join('；')}（节点 ${inv.colo || '?'}，${Date.now() - t0}ms）` };
      }
      if (target === 'deepseek') {
        if (!keys.deepseekKey) return { ok: false, message: '未配置 DeepSeek Key' };
        const msgs = [];
        let ok = true;
        try {
          const m = await deepseekModels(inv, keys.deepseekKey);
          const ids = (m.data || []).map((x) => x.id);
          for (const want of [...new Set([cfg.models.deepseekPlanner, cfg.models.deepseekExtractor])]) {
            if (ids.length && !ids.includes(want)) { ok = false; msgs.push(`模型 ${want} 不在可用列表（可用：${ids.join(', ')}）`); }
          }
          msgs.push('Key 有效 ✅');
        } catch (e) { ok = false; msgs.push(`Key 校验失败：${errMsg(e)}`); }
        try {
          const r = await deepseekSearch(inv, keys.deepseekKey, `${cfg.city} 周末 活动`, 3);
          msgs.push(`搜索 API ✅（返回 ${r.length} 条）`);
        } catch (e) { ok = false; msgs.push(`搜索 API ❌ ${errMsg(e)}`); }
        return { ok, message: msgs.join('；') };
      }
      if (target === 'weather') {
        const wk = targetWeekend();
        const w = await fetchWeather(inv, db, cfg.city, wk.sat, wk.sun);
        const s = w.sat ? `周六 ${w.sat.text} ${w.sat.tmin}~${w.sat.tmax}°C` : '周六暂无预报';
        return { ok: true, message: `${cfg.city}：${s}` };
      }
      return { ok: false, message: '未知的测试项' };
    });
  }

  throw new HttpError(404, '接口不存在');
}

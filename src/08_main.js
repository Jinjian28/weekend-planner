// ============================================================
//  Cron + static assets + entry points
// ============================================================

async function cronTick(env, ctx, nowTs = Date.now()) {
  const inv = newInv('cron');
  env = { ...env, DB: wrapDb(env.DB, inv) };
  const db = await ensureSchema(env);
  await kvSet(db, 'last_tick', { ts: nowTs });
  const cfg = await getConfig(db);
  if (!cfg.setupDone) return { skipped: 'setup' };

  const wk = weekendFor(nowTs);
  const pushTs = pushTsFor(cfg, wk.sat);
  const genStart = pushTs - 60 * MIN;
  const genEnd = pushTs + 6 * HOUR;
  let issue = await getIssueByWeek(db, wk.sat);
  const report = { sat: wk.sat };

  if (!issue && nowTs >= genStart && nowTs <= genEnd) {
    const keys = await getSecrets(env, db);
    if (keys.openaiKey || keys.deepseekKey) {
      issue = await createIssue(db, cfg, wk.sat, 'cron');
      await logEvent(db, 'info', `开始自动生成 ${wk.sat} 期清单`);
      report.created = true;
    }
  }

  // automatic retry of a failed run (max 3 attempts)
  if (issue && issue.status === 'failed' && nowTs <= genEnd && issue.attempts < 3 && nowTs - issue.updated_at >= 10 * MIN) {
    await db.prepare(`UPDATE issues SET status = 'running', state = ?, attempts = attempts + 1, error = NULL, lock_until = 0, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(initialState(cfg, issue.sat)), nowTs, issue.id).run();
    await logEvent(db, 'info', `第 ${issue.sat} 期上次生成失败，自动重试（第 ${issue.attempts + 1} 次）`);
    issue = await getIssue(db, issue.id);
  }

  // advance a running pipeline (also finishes manual runs whose app was closed)
  if (issue && issue.status === 'running' && (issue.lock_until || 0) < nowTs && nowTs - issue.updated_at > 45 * 1000) {
    const allowEmpty = issue.attempts >= 3 || nowTs > pushTs + 30 * MIN;
    const r = await runPipeline(inv, env, issue.id, { budgetMs: 11 * MIN, lockMs: 13 * MIN, softDeadline: pushTs - 15 * MIN, allowEmpty });
    if (r.issue) issue = r.issue;
    report.advanced = issue.status;
  }

  // publish & scheduled push
  if (issue && (issue.status === 'ready' || issue.status === 'published')) {
    const meta = parseJsonSafe(issue.meta, {});
    if (issue.status === 'ready' && issue.trigger === 'manual') {
      if (nowTs - (issue.ready_at || 0) < 60 * 1000) return report; // the app is probably publishing it right now
      await publishIssue(inv, db, cfg, issue, { notifyWho: 'all', reason: nowTs >= pushTs - 3 * HOUR && nowTs < pushTs ? 'scheduled' : 'manual' });
      report.published = 'manual';
    } else if (nowTs >= pushTs && !meta.scheduledPushSent) {
      if (nowTs <= genEnd) {
        const justManual = issue.trigger === 'manual' && issue.published_at && pushTs - issue.published_at < 3 * HOUR && issue.published_at <= pushTs;
        await publishIssue(inv, db, cfg, issue, { notifyWho: justManual ? null : 'all', reason: 'scheduled' });
        report.published = justManual ? 'silent' : 'scheduled';
      } else if (issue.status === 'ready') {
        await publishIssue(inv, db, cfg, issue, { notifyWho: null, reason: 'scheduled' });
      }
    }
  }

  // Sunday evening reminder to record what they ended up doing
  const p = bjParts(nowTs);
  if (cfg.push.sundayReminder && p.dow === 0 && p.h === 20 && p.mi < 30) {
    const sat = addDaysYmd(ymdOf(nowTs), -1);
    const iss = await getIssueByWeek(db, sat);
    if (iss && iss.status === 'published' && await kvSetIfAbsent(db, `sunrem:${sat}`, nowTs)) {
      const chosen = await db.prepare('SELECT COUNT(*) AS n FROM items WHERE issue_id = ? AND chosen_by IS NOT NULL').bind(iss.id).first();
      const body = chosen && chosen.n ? '去给这个周末的安排打个分、留句话吧，AI 会越来越懂你们 ✨' : '花 10 秒标记一下这周末最后去了哪（✅），AI 会越来越懂你们 ✨';
      await notifyUsers(inv, db, cfg, 'all', { title: '周末过得怎么样？', body, url: `/?issue=${iss.id}` });
      report.sunday = true;
    }
  }

  // housekeeping once a day
  if (p.h === 4 && p.mi < 5) {
    await db.prepare('DELETE FROM logs WHERE ts < ?').bind(nowTs - 45 * DAY).run();
    await db.prepare('DELETE FROM memory_history WHERE id NOT IN (SELECT id FROM memory_history ORDER BY id DESC LIMIT 60)').run();
  }
  return report;
}

function serveAsset(pathname, request) {
  let key = pathname === '/index.html' ? '/' : pathname;
  let a = ASSETS[key];
  if (a && a.alias) { key = a.alias; a = ASSETS[key]; }
  if (!a) return null;
  const etag = `"${BUILD_ID}"`;
  const headers = {
    'Content-Type': a.type,
    ETag: etag,
    'Cache-Control': a.cache || 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (key === '/') {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    headers['Referrer-Policy'] = 'no-referrer';
  }
  if (key === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  const body = a.b64 ? b64urlDecode(a.body) : a.body;
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx, url);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const r = serveAsset(url.pathname, request);
        if (r) return r;
        // SPA fallback
        return serveAsset('/', request);
      }
      return new Response('Method not allowed', { status: 405 });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.log('API error', e && e.stack ? e.stack : e);
      return jsonRes({ error: errMsg(e) }, status);
    }
  },
  async scheduled(event, env, ctx) {
    const p = cronTick(env, ctx, event && event.scheduledTime ? Number(event.scheduledTime) : Date.now()).catch(async (e) => {
      console.log('cron error', e && e.stack ? e.stack : e);
      try { if (env.DB) await logEvent(env.DB, 'error', `定时任务出错：${errMsg(e)}`); } catch { /* ignore */ }
    });
    ctx.waitUntil(p);
    await p;
  },
};

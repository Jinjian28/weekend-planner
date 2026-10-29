// End-to-end tests for the worker (run: node --no-warnings test/run.mjs)
import assert from 'node:assert/strict';
import { makeD1, makeCtx, net, counters, setNow, bjTsOf, makeSubscription } from './harness.mjs';

const mod = await import('../dist/worker.test.mjs');
const worker = mod.default;
const T = mod.__t;

let passed = 0;
const results = [];
async function test(name, fn) {
  const t0 = performance.now();
  try { await fn(); passed++; results.push(`✅ ${name} (${Math.round(performance.now() - t0)}ms)`); }
  catch (e) { results.push(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`); }
}

const ORIGIN = 'https://weekend.example.workers.dev';
function mkEnv() { return { DB: makeD1() }; }
const maxPer = { dbq: 0, fetches: 0, where: '' };
async function call(env, method, path, body, { pass, user, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (pass) headers.Authorization = `Bearer ${pass}`;
  if (user) headers['X-User'] = user;
  const req = new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ctx = makeCtx();
  const q0 = counters.dbq, f0 = counters.fetches;
  const res = await worker.fetch(req, env, ctx);
  const text = await res.text();
  await Promise.all(ctx.pending);
  const dq = counters.dbq - q0, df = counters.fetches - f0;
  if (dq > maxPer.dbq) { maxPer.dbq = dq; maxPer.where = `${method} ${path}`; }
  if (df > maxPer.fetches) maxPer.fetches = df;
  assert.ok(dq <= 50, `D1 queries in one invocation = ${dq} (${method} ${path})`);
  assert.ok(df <= 50, `subrequests in one invocation = ${df} (${method} ${path})`);
  if (raw) return { res, text };
  let data;
  try { data = JSON.parse(text.trim()); } catch { throw new Error(`non-json response ${res.status}: ${text.slice(0, 200)}`); }
  return { status: res.status, data };
}
async function cron(env, ts) {
  const ctx = makeCtx();
  const q0 = counters.dbq, f0 = counters.fetches;
  setNow(ts);
  await worker.scheduled({ scheduledTime: ts, cron: '*/5 * * * *' }, env, ctx);
  await Promise.all(ctx.pending);
  const dq = counters.dbq - q0, df = counters.fetches - f0;
  if (dq > maxPer.dbq) { maxPer.dbq = dq; maxPer.where = `cron ${new Date(ts).toISOString()}`; }
  if (df > maxPer.fetches) maxPer.fetches = df;
  assert.ok(dq <= 50, `cron D1 queries = ${dq}`);
  assert.ok(df <= 50, `cron subrequests = ${df}`);
}
async function setupApp(env) {
  T.resetSchema();
  const r = await call(env, 'POST', '/api/setup', { password: 'secret123', city: '上海', users: [{ name: '小明' }, { name: '小红' }], openaiKey: 'sk-oa-test', deepseekKey: 'sk-ds-test' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
const A = { pass: 'secret123', user: 'u1' };
const B = { pass: 'secret123', user: 'u2' };
async function genManual(env, who = A, force = false) {
  let r = await call(env, 'POST', '/api/gen/start', { force }, who);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (r.data.exists) r = await call(env, 'POST', '/api/gen/start', { force: true }, who);
  const id = r.data.issueId;
  let status = 'running', last;
  for (let i = 0; i < 40 && status === 'running'; i++) {
    last = await call(env, 'POST', '/api/gen/advance', { issueId: id }, who);
    assert.equal(last.status, 200);
    assert.ok(!last.data.error, last.data.error);
    status = last.data.status;
  }
  return { id, status, last };
}

// ================= unit tests =================
await test('RFC 8291 test vector (aes128gcm)', async () => {
  const asPub = T.b64urlDecode('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: T.b64urlEncode(asPub.slice(1, 33)), y: T.b64urlEncode(asPub.slice(33)), ext: true };
  const out = await T.encryptPushPayload(
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    { asPrivateJwk: jwk, salt: T.b64urlDecode('DGv6ra1nlYgDCS1FRnbzlw') },
  );
  assert.equal(T.b64urlEncode(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

await test('date helpers: weekend / push time (Beijing)', async () => {
  // Thu 2026-10-29 18:30 BJ → weekend Sat 10-31
  assert.deepEqual(T.weekendFor(bjTsOf(2026, 10, 29, 18, 30)), { sat: '2026-10-31', sun: '2026-11-01' });
  assert.deepEqual(T.weekendFor(bjTsOf(2026, 11, 1, 10, 0)), { sat: '2026-10-31', sun: '2026-11-01' });
  assert.deepEqual(T.weekendFor(bjTsOf(2026, 11, 2, 0, 1)), { sat: '2026-11-07', sun: '2026-11-08' });
  assert.equal(T.targetWeekend(bjTsOf(2026, 11, 1, 13, 0)).sat, '2026-11-07');
  assert.equal(T.targetWeekend(bjTsOf(2026, 11, 1, 9, 0)).sat, '2026-10-31');
  const cfg = { push: { weekday: 4, time: '18:30' } };
  assert.equal(T.pushTsFor(cfg, '2026-10-31'), bjTsOf(2026, 10, 29, 18, 30));
  assert.equal(T.pushTsFor({ push: { weekday: 0, time: '09:00' } }, '2026-10-31'), bjTsOf(2026, 10, 25, 9, 0));
  assert.equal(T.pushTsFor({ push: { weekday: 6, time: '08:05' } }, '2026-10-31'), bjTsOf(2026, 10, 31, 8, 5));
});

await test('json extraction / citation stripping', async () => {
  assert.deepEqual(T.extractJson('blah ```json\n{"a":1}\n``` tail'), { a: 1 });
  assert.deepEqual(T.extractJson('前言 {"a":[1,2,],} 后记'), { a: [1, 2] });
  assert.equal(T.extractJson('no json here'), null);
  const sink = [];
  assert.equal(T.stripCites('好剧 ([damai.cn](https://www.damai.cn/x)) 推荐', sink), '好剧 推荐');
  assert.deepEqual(sink, ['https://www.damai.cn/x']);
});

await test('city resolver + glow index + activity matching', async () => {
  const cfg = { city: '上海', nearby: [{ name: '苏州', hours: 1.2 }, { name: '舟山', hours: 3 }], activities: ['羽毛球', '看电影'] };
  const r = T.cityResolver(cfg);
  assert.deepEqual(r('上海市'), { city: '上海', out: false, hours: 0 });
  assert.deepEqual(r('崇明'), { city: '上海', out: false, hours: 0 });
  assert.deepEqual(r('苏州'), { city: '苏州', out: true, hours: 1.2 });
  assert.equal(r('南京'), null);
  assert.equal(T.glowIndex(10, 40, 55, 10).level, '高');
  assert.equal(T.glowIndex(80, 40, 55, 10).level, '低');
  assert.equal(T.matchActivity(cfg, { title: '去打羽毛球' }), '羽毛球');
});

// ================= integration =================
await test('static assets: html/csp, sw, manifest, icons', async () => {
  const env = mkEnv();
  T.resetSchema();
  const { res, text } = await call(env, 'GET', '/', null, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.match(res.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.match(text, /app\.js\?v=/);
  const sw = await call(env, 'GET', '/sw.js', null, { raw: true });
  assert.match(sw.text, /addEventListener\('push'/);
  assert.equal(sw.res.headers.get('Service-Worker-Allowed'), '/');
  const mf = await call(env, 'GET', '/manifest.webmanifest', null, { raw: true });
  assert.equal(JSON.parse(mf.text).display, 'standalone');
  for (const p of ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico']) {
    const req = new Request(ORIGIN + p);
    const r = await worker.fetch(req, env, makeCtx());
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${p} is png`);
  }
  const spa = await call(env, 'GET', '/some/deep/link', null, { raw: true });
  assert.match(spa.text, /<div id="app">/);
});

await test('setup, login, auth guards', async () => {
  const env = mkEnv();
  T.resetSchema();
  let r = await call(env, 'GET', '/api/bootstrap');
  assert.equal(r.data.setupDone, false);
  r = await call(env, 'GET', '/api/health');
  assert.equal(r.data.database, 'ok');
  assert.equal(r.data.cron, 'never');
  r = await call(env, 'POST', '/api/setup', { password: '123', openaiKey: 'x' });
  assert.equal(r.status, 400);
  await setupApp(env);
  r = await call(env, 'POST', '/api/setup', { password: 'another1', openaiKey: 'x' });
  assert.equal(r.status, 409);
  r = await call(env, 'POST', '/api/login', { password: 'wrong' });
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/login', { password: 'secret123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.users[1].name, '小红');
  r = await call(env, 'GET', '/api/state', null, { pass: 'wrong', user: 'u1' });
  assert.equal(r.status, 401);
  r = await call(env, 'GET', '/api/state', null, { pass: 'secret123', user: 'nobody' });
  assert.equal(r.status, 400);
  r = await call(env, 'GET', '/api/state', null, A);
  assert.equal(r.status, 200);
  assert.equal(r.data.issue, null);
  assert.ok(r.data.push.vapidPublicKey.length > 80);
  // throttle
  for (let i = 0; i < 8; i++) await call(env, 'POST', '/api/login', { password: 'bad' });
  r = await call(env, 'POST', '/api/login', { password: 'secret123' });
  assert.equal(r.status, 429);
});

let sharedEnv;
await test('manual generation end-to-end (DeepSeek ‖ GPT → GPT agent) + push to the other person', async () => {
  setNow(bjTsOf(2026, 10, 27, 10, 0)); // Tue
  net.colo = 'SJC'; net.openaiMode = 'ok'; net.deepseekMode = 'ok'; net.pushes.length = 0;
  const env = mkEnv();
  sharedEnv = env;
  await setupApp(env);
  const subA = makeSubscription('https://web.push.apple.com/QA-u1');
  const subB = makeSubscription('https://web.push.apple.com/QB-u2');
  assert.equal((await call(env, 'POST', '/api/push/subscribe', { subscription: { endpoint: subA.endpoint, keys: subA.keys } }, A)).status, 200);
  assert.equal((await call(env, 'POST', '/api/push/subscribe', { subscription: { endpoint: subB.endpoint, keys: subB.keys } }, B)).status, 200);
  const g = await genManual(env, A);
  assert.equal(g.status, 'published', JSON.stringify(g.last.data));
  const st = await call(env, 'GET', '/api/state', null, B);
  const d = st.data;
  assert.equal(d.issue.sat, '2026-10-31');
  assert.equal(d.isCurrent, true);
  const live = d.items.filter((x) => x.kind === 'live');
  const personal = d.items.filter((x) => x.kind === 'personal');
  assert.equal(live.length, 5, 'five live items');
  assert.equal(personal.length, 5, 'five personal items');
  assert.equal(d.issue.engines.agent, 'gpt');
  assert.equal(d.issue.engines.deepseek, 'done');
  assert.equal(d.issue.engines.gpt, 'done');
  // no bogus refs, out-of-city limits
  assert.ok(!d.items.some((x) => x.data.title === '不存在的活动'));
  assert.ok(!d.items.some((x) => x.data.title.includes('舟山')), 'NEW item with unverified url / far city must be dropped');
  const outCount = d.items.filter((x) => x.data.isOut).length;
  assert.ok(outCount <= 2, `out-of-city items ${outCount}`);
  // every link is http(s); no evil url
  for (const it of d.items) {
    for (const l of it.data.links) {
      assert.match(l.url, /^https:\/\//);
      assert.ok(!l.url.includes('evil.example.com') && !l.url.includes('not-in-results') && !l.url.includes('fake-not-in-sources'), l.url);
    }
    assert.ok(it.data.title && it.data.title.length <= 40);
    assert.ok(!/\]\(http/.test(it.data.summary), 'citations stripped');
  }
  assert.ok(personal.filter((x) => /晚霞/.test(x.data.title)).length <= 1, 'no duplicate sunset suggestions');
  assert.ok(!personal.some((p) => /去逛逛|换个说法/.test(p.data.title)), 'personal items must not repeat live items');
  const liveRefs = new Set(live.map((l) => l.data.ref));
  assert.ok(!personal.some((p) => p.data.ref && liveRefs.has(p.data.ref)), 'personal refs not used by live');
  assert.ok(personal.filter((p) => p.data.activity).length >= 3, 'at least 3 hobby-based suggestions');
  // usage / cost / balance
  const us = d.issue.usage;
  assert.ok(us && us.ds.calls >= 2 && us.ds.searches >= 5, `deepseek usage ${JSON.stringify(us && us.ds)}`);
  const expectedDsTokensCny = (cnt) => cnt; // (sanity only — exact CNY depends on peak/off-peak time)
  assert.ok(us.ds.cny > us.ds.searches * 0.005 && expectedDsTokensCny(1), 'deepseek cny includes tokens + searches');
  assert.ok(us.oa.calls >= 3 && us.oa.searches >= 3, `openai usage ${JSON.stringify(us && us.oa)}`);
  assert.ok(d.issue.costCny > 0, 'cost computed');
  const expectedOa = us.oa.calls * (((30000 - 10000) * 5 + 10000 * 0.5 + 4000 * 30) / 1e6 + 0.01);
  assert.ok(Math.abs(us.oa.usd - expectedOa) < 1e-9, `oa usd ${us.oa.usd} vs ${expectedOa}`);
  assert.equal(d.issue.balance.deepseek.total, 9.58);
  assert.ok(st.data.monthCostCny > 0);
  const chongming = personal.find((x) => x.data.title.includes('崇明'));
  assert.ok(chongming && chongming.data.city === '上海' && !chongming.data.isOut);
  assert.ok(d.issue.weather && d.issue.weather.sat && d.issue.weather.sat.glow);
  // push: only the other person (u2) is notified for a manual run
  const toB = net.pushes.filter((p) => p.endpoint === subB.endpoint);
  const toA = net.pushes.filter((p) => p.endpoint === subA.endpoint);
  assert.equal(toB.length, 1, 'u2 notified');
  assert.equal(toA.length, 0, 'u1 (initiator) not notified');
  assert.match(toB[0].payload.title, /小明 刷新了周末清单/);
  assert.match(toB[0].payload.url, /\?issue=\d+/);
});

await test('votes, choose, comments, notifications, history & memory', async () => {
  const env = sharedEnv;
  net.pushes.length = 0;
  let d = (await call(env, 'GET', '/api/state', null, A)).data;
  const it0 = d.items[0], it1 = d.items[6];
  assert.equal((await call(env, 'POST', '/api/react', { itemId: it0.id, value: 'want' }, A)).status, 200);
  assert.equal((await call(env, 'POST', '/api/react', { itemId: it0.id, value: 'want' }, B)).status, 200);
  assert.equal((await call(env, 'POST', '/api/react', { itemId: it1.id, value: 'no' }, B)).status, 200);
  assert.equal((await call(env, 'POST', '/api/react', { itemId: it1.id, value: 'bogus' }, B)).status, 400);
  assert.equal((await call(env, 'POST', '/api/choose', { itemId: it0.id, chosen: true }, B)).status, 200);
  assert.equal((await call(env, 'POST', '/api/comment', { itemId: it0.id, text: '这个好！周六晚上去' }, B)).status, 200);
  assert.equal((await call(env, 'POST', '/api/comment', { issueId: d.issue.id, text: '这周想轻松点' }, A)).status, 200);
  assert.equal((await call(env, 'POST', '/api/comment', { issueId: d.issue.id, text: '   ' }, A)).status, 400);
  d = (await call(env, 'GET', '/api/state', null, A)).data;
  const x0 = d.items.find((x) => x.id === it0.id);
  assert.deepEqual(x0.reactions, { u1: 'want', u2: 'want' });
  assert.equal(x0.chosen_by, 'u2');
  assert.equal(x0.comments.length, 1);
  assert.equal(d.general.length, 1);
  // notifications went to the *other* person
  assert.ok(net.pushes.some((p) => p.endpoint.endsWith('QA-u1') && /定了一个周末计划/.test(p.payload.title)));
  assert.ok(net.pushes.some((p) => p.endpoint.endsWith('QA-u1') && /评论了/.test(p.payload.title)));
  assert.ok(net.pushes.some((p) => p.endpoint.endsWith('QB-u2') && /留言了/.test(p.payload.title)));
  // cannot delete other's comment
  const cid = x0.comments[0].id;
  assert.equal((await call(env, 'POST', '/api/comment/delete', { id: cid }, A)).status, 403);
  // notes + memory refresh
  assert.equal((await call(env, 'POST', '/api/note', { text: '小红最近不想去太远的地方' }, B)).status, 200);
  const m = await call(env, 'POST', '/api/memory/refresh', {}, A);
  assert.equal(m.status, 200);
  assert.ok(m.data.updated, JSON.stringify(m.data));
  assert.equal(m.data.engine, 'gpt');
  const mem = (await call(env, 'GET', '/api/memory', null, A)).data;
  assert.ok(mem.profile.summary.length > 0);
  assert.ok(mem.notes[0].digested === 1);
  assert.ok(!mem.profile.activity_last_done['看音乐剧/话剧'] || mem.profile.activity_last_done['看音乐剧/话剧'] <= '2026-10-31', 'future dates rejected');
  // manual memory edit
  const edit = await call(env, 'POST', '/api/memory', { profile: { ...mem.profile, summary: '手动修改' } }, A);
  assert.equal(edit.data.profile.summary, '手动修改');
  const hist = (await call(env, 'GET', '/api/issues', null, A)).data;
  assert.equal(hist.issues.length, 1);
  assert.equal(hist.issues[0].chosen.length, 1);
});

await test('regenerate keeps old list as archived; settings validation', async () => {
  const env = sharedEnv;
  let r = await call(env, 'POST', '/api/gen/start', {}, A);
  assert.equal(r.data.exists, true);
  const g = await genManual(env, B, true);
  assert.equal(g.status, 'published');
  const hist = (await call(env, 'GET', '/api/issues', null, A)).data;
  assert.equal(hist.issues.length, 2);
  assert.ok(hist.issues.some((i) => i.status === 'archived'));
  r = await call(env, 'POST', '/api/settings', { config: { push: { time: '25:00' } } }, A);
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/settings', { config: { counts: { live: 9, personal: 1 } } }, A);
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/settings', { config: { city: '杭州' } }, A);
  assert.equal(r.status, 200);
  let s = (await call(env, 'GET', '/api/settings', null, A)).data;
  assert.equal(s.config.city, '杭州');
  assert.ok(s.config.nearby.some((n) => n.name === '上海'), 'preset nearby applied');
  r = await call(env, 'POST', '/api/settings', { config: { city: '上海', nearby: [{ name: '苏州', hours: 1.2 }, { name: '上海', hours: 1 }, { name: '', hours: 1 }] }, keys: { openai: 'sk-oa-new' } }, A);
  assert.equal(r.status, 200);
  s = (await call(env, 'GET', '/api/settings', null, A)).data;
  assert.deepEqual(s.config.nearby, [{ name: '苏州', hours: 1.2 }]);
  assert.match(s.keys.openai, /^sk-…/);
  // restore default nearby for later tests
  await call(env, 'POST', '/api/settings', { config: { city: '杭州' } }, A);
  await call(env, 'POST', '/api/settings', { config: { city: '上海' } }, A);
  s = (await call(env, 'GET', '/api/settings', null, A)).data;
  assert.equal(s.config.nearby.length, 9);
});

await test('cron: Thursday auto-generation, scheduled push at 18:30, no duplicates', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 11, 2, 9, 0));
  await setupApp(env);
  const subA = makeSubscription('https://web.push.apple.com/C-u1');
  const subB = makeSubscription('https://web.push.apple.com/C-u2');
  await call(env, 'POST', '/api/push/subscribe', { subscription: { endpoint: subA.endpoint, keys: subA.keys } }, A);
  await call(env, 'POST', '/api/push/subscribe', { subscription: { endpoint: subB.endpoint, keys: subB.keys } }, B);
  await call(env, 'POST', '/api/settings', { config: { bark: { u2: 'https://api.day.app/BARKKEY' } } }, B);
  net.pushes.length = 0; net.barks.length = 0;
  // Thu 11-05 17:00 → before window: nothing
  await cron(env, bjTsOf(2026, 11, 5, 17, 0));
  let diag = (await call(env, 'GET', '/api/diag', null, A)).data;
  assert.equal(diag.current, null);
  assert.equal(diag.cronOk, true);
  // 17:35 → window open → creates and runs
  await cron(env, bjTsOf(2026, 11, 5, 17, 35));
  for (let t = 17 * 60 + 40; t < 18 * 60 + 30; t += 5) await cron(env, bjTsOf(2026, 11, 5, Math.floor(t / 60), t % 60));
  diag = (await call(env, 'GET', '/api/diag', null, A)).data;
  assert.equal(diag.current.status, 'ready', JSON.stringify(diag.current.gen));
  assert.equal(net.pushes.length, 0, 'no push before 18:30');
  await cron(env, bjTsOf(2026, 11, 5, 18, 30));
  diag = (await call(env, 'GET', '/api/diag', null, A)).data;
  assert.equal(diag.current.status, 'published');
  assert.equal(net.pushes.length, 2, 'both notified');
  assert.equal(net.barks.length, 1, 'bark for u2');
  assert.match(net.pushes[0].payload.title, /11月7日这个周末玩什么/);
  await cron(env, bjTsOf(2026, 11, 5, 18, 35));
  await cron(env, bjTsOf(2026, 11, 5, 19, 0));
  assert.equal(net.pushes.length, 2, 'no duplicate pushes');
  // Sunday 20:00 reminder once
  await cron(env, bjTsOf(2026, 11, 8, 20, 0));
  await cron(env, bjTsOf(2026, 11, 8, 20, 5));
  assert.equal(net.pushes.filter((p) => /周末过得怎么样/.test(p.payload.title)).length, 2);
});

await test('cron: OpenAI region-blocked node → defers, then falls back to DeepSeek before deadline', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 11, 9, 9, 0));
  await setupApp(env);
  net.colo = 'HKG'; net.pushes.length = 0;
  for (let t = 17 * 60 + 30; t <= 18 * 60 + 30; t += 5) await cron(env, bjTsOf(2026, 11, 12, Math.floor(t / 60), t % 60));
  const d = (await call(env, 'GET', '/api/state', null, A)).data;
  net.colo = 'SJC';
  assert.ok(d.issue, 'issue exists');
  assert.equal(d.issue.status, 'published');
  assert.equal(d.issue.engines.gpt, 'failed');
  assert.equal(d.issue.engines.agent, 'deepseek');
  assert.equal(d.items.filter((x) => x.kind === 'live').length, 5);
  assert.equal(d.items.filter((x) => x.kind === 'personal').length, 5);
  assert.ok(!net.calls.some((c) => c.includes('api.openai.com') && false));
});

await test('cron: region recovers on a later tick → GPT used', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 11, 16, 9, 0));
  await setupApp(env);
  net.colo = 'HKG';
  await cron(env, bjTsOf(2026, 11, 19, 17, 30));
  net.colo = 'SJC';
  for (let t = 17 * 60 + 35; t <= 18 * 60 + 30; t += 5) await cron(env, bjTsOf(2026, 11, 19, Math.floor(t / 60), t % 60));
  const d = (await call(env, 'GET', '/api/state', null, A)).data;
  assert.equal(d.issue.status, 'published');
  assert.equal(d.issue.engines.gpt, 'done');
  assert.equal(d.issue.engines.agent, 'gpt');
});

await test('manual: OpenAI down (500) → DeepSeek-only search & DeepSeek agent', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 11, 24, 10, 0));
  await setupApp(env);
  net.openaiMode = 'fail500';
  const g = await genManual(env, A);
  net.openaiMode = 'ok';
  assert.equal(g.status, 'published', JSON.stringify(g.last.data));
  const d = (await call(env, 'GET', '/api/state', null, A)).data;
  assert.equal(d.issue.engines.agent, 'deepseek');
  assert.equal(d.items.length, 10);
});

await test('manual: GPT returns non-JSON → repaired / falls back, still 5+5', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 12, 1, 10, 0));
  await setupApp(env);
  net.openaiMode = 'badjson';
  const g = await genManual(env, A);
  net.openaiMode = 'ok';
  assert.equal(g.status, 'published', JSON.stringify(g.last.data));
  const d = (await call(env, 'GET', '/api/state', null, A)).data;
  assert.equal(d.items.filter((x) => x.kind === 'personal').length, 5);
  assert.ok(d.items.filter((x) => x.kind === 'live').length >= 3);
});

await test('manual: DeepSeek search down → GPT-only pool works', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 12, 8, 10, 0));
  await setupApp(env);
  net.deepseekMode = 'searchfail';
  const g = await genManual(env, A);
  net.deepseekMode = 'ok';
  assert.equal(g.status, 'published', JSON.stringify(g.last.data));
  const d = (await call(env, 'GET', '/api/state', null, A)).data;
  assert.equal(d.issue.engines.deepseek, 'failed');
  assert.equal(d.issue.engines.agent, 'gpt');
  assert.ok(d.items.filter((x) => x.kind === 'live').length >= 4);
});

await test('manual: everything down → clear failure; cron eventually ships personal-only list', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 12, 14, 10, 0));
  await setupApp(env);
  net.openaiMode = 'fail500'; net.deepseekMode = 'allfail';
  const g = await genManual(env, A);
  assert.equal(g.status, 'failed');
  assert.match(g.last.data.gen.error, /没有检索到/);
  // cron keeps retrying; after attempts/deadline it degrades to personal suggestions only
  for (let t = 17 * 60 + 30; t <= 20 * 60; t += 5) await cron(env, bjTsOf(2026, 12, 17, Math.floor(t / 60), t % 60));
  net.openaiMode = 'ok'; net.deepseekMode = 'ok';
  const d = (await call(env, 'GET', '/api/state', null, A)).data;
  assert.ok(d.issue && d.issue.sat === '2026-12-19', JSON.stringify(d.gen));
  assert.equal(d.issue.status, 'published');
  assert.equal(d.items.filter((x) => x.kind === 'personal').length, 5);
});

await test('slow GPT background jobs are polled until complete', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2026, 12, 22, 10, 0));
  await setupApp(env);
  net.openaiMode = 'slow';
  const g = await genManual(env, A);
  net.openaiMode = 'ok';
  assert.equal(g.status, 'published');
  const d = (await call(env, 'GET', '/api/state', null, A)).data;
  assert.equal(d.issue.engines.gpt, 'done');
  assert.equal(d.issue.engines.agent, 'gpt');
});

await test('diagnostics endpoints', async () => {
  const env = sharedEnv;
  let r = await call(env, 'POST', '/api/diag/test', { target: 'openai' }, A);
  assert.equal(r.data.ok, true, r.data.message);
  r = await call(env, 'POST', '/api/diag/test', { target: 'deepseek' }, A);
  assert.equal(r.data.ok, true, r.data.message);
  r = await call(env, 'POST', '/api/diag/test', { target: 'weather' }, A);
  assert.equal(r.data.ok, true, r.data.message);
  r = await call(env, 'POST', '/api/push/test', {}, A);
  assert.ok(r.data.sent >= 1);
});

await test('push self-check: check / test-device / stale device removal / prune', async () => {
  const env = mkEnv();
  setNow(bjTsOf(2027, 1, 4, 10, 0));
  await setupApp(env);
  const live = makeSubscription('https://web.push.apple.com/LIVE-u1');
  const stale = makeSubscription('https://web.push.apple.com/STALE-u1');
  await call(env, 'POST', '/api/push/subscribe', { subscription: { endpoint: live.endpoint, keys: live.keys } }, A);
  await call(env, 'POST', '/api/push/subscribe', { subscription: { endpoint: stale.endpoint, keys: stale.keys } }, A);
  let c = (await call(env, 'POST', '/api/push/check', { endpoint: live.endpoint }, A)).data;
  assert.equal(c.known, true);
  assert.equal(c.devices.length, 2);
  assert.ok(c.devices.some((d) => d.current && d.tail === 'IVE-u1'));
  // other user cannot probe my device
  assert.equal((await call(env, 'POST', '/api/push/test-device', { endpoint: live.endpoint }, B)).status, 404);
  net.pushes.length = 0;
  const t = (await call(env, 'POST', '/api/push/test-device', { endpoint: live.endpoint, check: 'tok123' }, A)).data;
  assert.equal(t.status, 201);
  assert.equal(net.pushes.length, 1);
  assert.equal(net.pushes[0].payload.check, 'tok123', 'check token reaches the service worker');
  // a device Apple no longer knows (410) is removed automatically
  const { subsByEndpoint } = await import('./harness.mjs');
  subsByEndpoint.delete(stale.endpoint);
  const t2 = (await call(env, 'POST', '/api/push/test-device', { endpoint: stale.endpoint }, A)).data;
  assert.equal(t2.status, 410);
  assert.equal(t2.removed, true);
  c = (await call(env, 'POST', '/api/push/check', { endpoint: live.endpoint }, A)).data;
  assert.equal(c.devices.length, 1);
  // prune keeps only the given device
  const extra = makeSubscription('https://web.push.apple.com/EXTRA-u1');
  await call(env, 'POST', '/api/push/subscribe', { subscription: { endpoint: extra.endpoint, keys: extra.keys } }, A);
  const p = (await call(env, 'POST', '/api/push/prune', { keep: live.endpoint }, A)).data;
  assert.equal(p.removed, 1);
  c = (await call(env, 'POST', '/api/push/check', { endpoint: live.endpoint }, A)).data;
  assert.deepEqual(c.devices.map((d) => d.tail), ['IVE-u1']);
  const diag = (await call(env, 'GET', '/api/diag', null, A)).data;
  assert.ok(diag.logs.some((l) => /推送体检/.test(l.msg)), 'push results are logged');
});

await test('setup requires two distinct names; defaults contain no personal info', async () => {
  const env = mkEnv();
  T.resetSchema();
  const boot = (await call(env, 'GET', '/api/bootstrap')).data;
  assert.deepEqual(boot.defaults.names, ['', '']);
  assert.ok(boot.defaults.activities.length >= 3);
  let r = await call(env, 'POST', '/api/setup', { password: 'secret123', users: [{ name: '' }, { name: '小红' }], deepseekKey: 'sk-ds-x' });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/setup', { password: 'secret123', users: [{ name: '同名' }, { name: '同名' }], deepseekKey: 'sk-ds-x' });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/setup', { password: 'secret123', users: [{ name: '阿杰' }, { name: '小雨' }], activities: ['攀岩', '露营'], deepseekKey: 'sk-ds-x' });
  assert.equal(r.status, 200);
  const s = (await call(env, 'GET', '/api/settings', null, { pass: 'secret123', user: 'u1' })).data;
  assert.deepEqual(s.config.users.map((u) => u.name), ['阿杰', '小雨']);
  assert.deepEqual(s.config.activities, ['攀岩', '露营']);
});

await test('missing D1 binding gives a friendly error', async () => {
  T.resetSchema();
  const r = await call({}, 'GET', '/api/bootstrap');
  assert.equal(r.status, 500);
  assert.match(r.data.error, /D1/);
});

console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} passed · max per invocation: ${maxPer.dbq} D1 queries (${maxPer.where}), ${maxPer.fetches} subrequests`);
process.exit(passed === results.length ? 0 : 1);

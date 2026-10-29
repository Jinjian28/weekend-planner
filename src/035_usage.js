// ============================================================
//  Token usage & cost accounting (prices as of 2026-10)
// ============================================================

const USD_CNY = 7.1; // rough exchange rate used for estimates
// DeepSeek official prices, CNY per 1M tokens: [peak, off-peak]
const DS_PRICES = {
  'deepseek-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-pro': { hit: [0.30, 0.15], miss: [9, 4.5], out: [27, 13.5] },
};
const DS_SEARCH_CNY = 0.005; // ¥5 per 1,000 successful searches
// OpenAI list prices, USD per 1M tokens
const OA_PRICES = {
  'gpt-5.5': { in: 5, cached: 0.5, out: 30 },
  'gpt-6-astra': { in: 10, cached: 1, out: 50 },
  'gpt-6.1-sol': { in: 2, cached: 0.1, out: 10 },
  'gpt-6.1-terra': { in: 1, cached: 0.05, out: 5 },
  'gpt-6-luna': { in: 0.1, cached: 0.01, out: 0.5 },
};
const OA_SEARCH_USD = 0.01; // $10 per 1,000 web search calls

function emptyUsage() {
  return {
    ds: { in: 0, cached: 0, out: 0, calls: 0, searches: 0, cny: 0 },
    oa: { in: 0, cached: 0, out: 0, calls: 0, searches: 0, usd: 0 },
  };
}
// DeepSeek peak hours: Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time
function dsPeak(ts = Date.now()) {
  const p = bjParts(ts);
  if (p.dow === 0 || p.dow === 6) return false;
  return (p.h >= 9 && p.h < 12) || (p.h >= 14 && p.h < 18);
}
function recordDsUsage(inv, model, u) {
  if (!inv || !inv.usage || !u) return;
  const price = DS_PRICES[model] || DS_PRICES['deepseek-v4-pro'];
  const i = dsPeak() ? 0 : 1;
  const prompt = Number(u.prompt_tokens) || 0;
  const hit = Number(u.prompt_cache_hit_tokens) || 0;
  const miss = u.prompt_cache_miss_tokens != null ? Number(u.prompt_cache_miss_tokens) || 0 : Math.max(0, prompt - hit);
  const out = Number(u.completion_tokens) || 0;
  const d = inv.usage.ds;
  d.in += prompt; d.cached += hit; d.out += out; d.calls++;
  d.cny += (hit * price.hit[i] + miss * price.miss[i] + out * price.out[i]) / 1e6;
}
function recordDsSearch(inv) {
  if (!inv || !inv.usage) return;
  inv.usage.ds.searches++;
  inv.usage.ds.cny += DS_SEARCH_CNY;
}
function recordOaUsage(inv, model, resp) {
  if (!inv || !inv.usage || !resp) return;
  const u = resp.usage || {};
  const price = OA_PRICES[model] || OA_PRICES['gpt-5.5'];
  const input = Number(u.input_tokens) || 0;
  const cached = Number(u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  const out = Number(u.output_tokens) || 0;
  let searches = 0;
  for (const it of Array.isArray(resp.output) ? resp.output : []) {
    if (it && it.type === 'web_search_call' && (!it.action || !it.action.type || it.action.type === 'search')) searches++;
  }
  const o = inv.usage.oa;
  o.in += input; o.cached += cached; o.out += out; o.calls++; o.searches += searches;
  o.usd += ((input - cached) * price.in + cached * price.cached + out * price.out) / 1e6 + searches * OA_SEARCH_USD;
}
function addUsage(a, b) {
  const out = emptyUsage();
  for (const k of ['ds', 'oa']) {
    for (const f of Object.keys(out[k])) out[k][f] = ((a && a[k] && a[k][f]) || 0) + ((b && b[k] && b[k][f]) || 0);
  }
  return out;
}
// move what this invocation recorded into the pipeline state
function drainUsage(inv, st) {
  if (!inv.usage) return;
  st.usage = addUsage(st.usage, inv.usage);
  inv.usage = emptyUsage();
}
function usageTotalCny(u) {
  if (!u) return 0;
  return (u.ds ? u.ds.cny : 0) + (u.oa ? u.oa.usd * USD_CNY : 0);
}
async function addMonthlyUsage(db, u) {
  const key = `usage:${ymdOf(Date.now()).slice(0, 7)}`;
  const cur = await kvGet(db, key, null);
  await kvSet(db, key, addUsage(cur, u));
}
async function deepseekBalance(inv, key) {
  const res = await xfetch(inv, `${DEEPSEEK_BASE}/user/balance`, { headers: { Authorization: `Bearer ${key}` } }, 15000);
  const data = await readJsonResponse(res, 'DeepSeek 余额');
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const cny = infos.find((b) => b.currency === 'CNY') || infos[0];
  if (!cny) return null;
  return { currency: cny.currency, total: Number(cny.total_balance), granted: Number(cny.granted_balance) || 0, available: !!data.is_available, at: Date.now() };
}

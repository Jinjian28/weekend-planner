/* 周末去哪儿 — PWA front-end (vanilla JS, no build step) */
(function () {
  'use strict';

  // ---------------- storage (falls back to memory) ----------------
  const memStore = {};
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return k in memStore ? memStore[k] : null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { memStore[k] = v; } },
    del(k) { try { window.localStorage.removeItem(k); } catch (e) { delete memStore[k]; } },
  };

  const S = {
    pass: store.get('wk_pass') || '',
    me: store.get('wk_me') || '',
    tab: 'week',
    viewIssueId: null,
    data: null,
    issues: null,
    memory: null,
    settings: null,
    diag: null,
    boot: null,
    openComments: new Set(),
    drafts: {},
    gen: null,
    loading: false,
    editMemory: false,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = () => document.getElementById('app');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function safeUrl(u) {
    try { const x = new URL(String(u)); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.toString() : ''; } catch (e) { return ''; }
  }
  function toast(msg, ms) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }
  function cnDate(ymd) { if (!ymd) return ''; const p = ymd.split('-').map(Number); return `${p[1]}月${p[2]}日`; }
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function bj(ts) { const d = new Date(ts + 8 * 3600e3); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; }
  function p2(n) { return String(n).padStart(2, '0'); }
  function fmtTs(ts) {
    if (!ts) return '';
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    const a = bj(ts), b = bj(now);
    const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
    if (sameDay) return `今天 ${p2(a.h)}:${p2(a.mi)}`;
    const y = bj(now - 86400e3);
    if (a.y === y.y && a.m === y.m && a.d === y.d) return `昨天 ${p2(a.h)}:${p2(a.mi)}`;
    return `${a.m}月${a.d}日 ${p2(a.h)}:${p2(a.mi)}`;
  }
  function fmtPush(ts) { const a = bj(ts); return `${WD[a.dow]} ${a.m}月${a.d}日 ${p2(a.h)}:${p2(a.mi)}`; }
  function daysAgo(ymd) {
    if (!ymd) return '';
    const p = ymd.split('-').map(Number);
    const t = Date.UTC(p[0], p[1] - 1, p[2]) - 8 * 3600e3;
    const d = Math.floor((Date.now() - t) / 86400e3);
    if (d <= 0) return '今天';
    if (d < 7) return `${d} 天前`;
    if (d < 60) return `${Math.floor(d / 7)} 周前`;
    return `${Math.floor(d / 30)} 个月前`;
  }
  function userName(id) {
    const list = (S.data && S.data.users) || (S.boot && S.boot.users) || [];
    const u = list.find((x) => x.id === id);
    return u ? u.name : id;
  }
  function otherId() {
    const list = (S.data && S.data.users) || (S.boot && S.boot.users) || [];
    const u = list.find((x) => x.id !== S.me);
    return u ? u.id : '';
  }
  function b64urlToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function bytesToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---------------- API ----------------
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (S.pass) headers.Authorization = `Bearer ${S.pass}`;
    if (S.me) headers['X-User'] = S.me;
    let res;
    try {
      res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    } catch (e) {
      throw new Error('网络连接失败，请检查网络后重试');
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text.trim() || '{}'); } catch (e) {
      throw new Error(`服务器返回异常（${res.status}）`);
    }
    if (res.status === 401 && !opts.noLogout) {
      logout(data.error || '请重新登录');
      throw new Error(data.error || '请重新登录');
    }
    if (!res.ok || (data && data.error)) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  }

  function logout(msg) {
    S.pass = '';
    store.del('wk_pass');
    S.data = null;
    render();
    if (msg) toast(msg);
  }

  // ---------------- boot ----------------
  async function boot() {
    const params = new URLSearchParams(location.search);
    if (params.get('issue')) S.viewIssueId = Number(params.get('issue')) || null;
    if (params.get('tab')) S.tab = params.get('tab');
    if (params.toString()) history.replaceState(null, '', '/');
    try {
      S.boot = await api('/api/bootstrap', { noLogout: true });
    } catch (e) {
      app().innerHTML = `<div class="boot"><div class="logo">🌧️</div><p>${esc(e.message)}</p><button class="btn" data-act="reload">重试</button></div>`;
      return;
    }
    if (!S.boot.setupDone) { renderSetup(); return; }
    if (!S.pass) { renderLogin(); return; }
    if (!S.me || !S.boot.users.some((u) => u.id === S.me)) { renderPickUser(); return; }
    await loadTab();
    syncPushSilently();
    try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) { /* ignore */ }
  }

  function render() {
    if (!S.boot) return;
    if (!S.boot.setupDone) return renderSetup();
    if (!S.pass) return renderLogin();
    if (!S.me) return renderPickUser();
    renderMain();
  }

  // ---------------- setup / login ----------------
  function renderSetup() {
    const df = (S.boot && S.boot.defaults) || {};
    const names = df.names || [];
    app().innerHTML = `
      <div class="auth">
        <div class="logo">🌤️</div>
        <h1>周末去哪儿</h1>
        <p class="sub">第一次使用，花 2 分钟完成初始化</p>
        <form class="card" data-form="setup">
          <label class="field"><span>设置访问密码（你们俩共用，至少 6 位）</span><input class="input" name="password" type="password" autocomplete="new-password" required minlength="6"></label>
          <label class="field"><span>再输一次密码</span><input class="input" name="password2" type="password" autocomplete="new-password" required minlength="6"></label>
          <div class="row"><label class="field" style="flex:1"><span>你的名字</span><input class="input" name="u1" value="${esc(names[0] || '')}" placeholder="比如：小明" required maxlength="12"></label><label class="field" style="flex:1"><span>另一位的名字</span><input class="input" name="u2" value="${esc(names[1] || '')}" placeholder="比如：小红" required maxlength="12"></label></div>
          <label class="field"><span>所在城市</span><input class="input" name="city" value="${esc(df.city || '上海')}"></label>
          <label class="field"><span>你们平时爱做的事（逗号分隔，AI 会据此给个性化建议，之后也能改）</span><textarea class="textarea" name="activities">${esc((df.activities || []).join('，'))}</textarea></label>
          <label class="field"><span>OpenAI API Key（sk-…）</span><input class="input" name="openaiKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="platform.openai.com → API keys"></label>
          <label class="field"><span>DeepSeek API Key（sk-…）</span><input class="input" name="deepseekKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="platform.deepseek.com → API keys"></label>
          <p class="hint">Key 只保存在你自己的 Cloudflare 数据库里，之后可在「设置」中修改。两个都填效果最好，只填一个也能用。</p>
          <button class="btn block" type="submit">完成初始化</button>
        </form>
      </div>`;
  }
  function renderLogin() {
    app().innerHTML = `
      <div class="auth">
        <div class="logo">🌤️</div>
        <h1>周末去哪儿</h1>
        <p class="sub">${esc((S.boot.users || []).map((u) => u.name).join(' & '))} 的周末小助手</p>
        <form class="card" data-form="login">
          <label class="field"><span>访问密码</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
          <button class="btn block" type="submit">进入</button>
        </form>
      </div>`;
    setTimeout(() => { const i = $('input[name=password]'); if (i) i.focus(); }, 50);
  }
  function renderPickUser() {
    const users = S.boot.users || [];
    app().innerHTML = `
      <div class="auth">
        <div class="logo">👋</div>
        <h1>你是哪位？</h1>
        <p class="sub">选一次就记住了，之后可在设置里切换</p>
        <div class="who-pick">
          ${users.map((u, i) => `<button data-act="pick-user" data-id="${esc(u.id)}"><span class="e">${i === 0 ? '🙂' : '😊'}</span>${esc(u.name)}</button>`).join('')}
        </div>
      </div>`;
  }

  // ---------------- main shell ----------------
  const TABS = [
    { id: 'week', icon: '🗓️', label: '本周' },
    { id: 'history', icon: '📚', label: '往期' },
    { id: 'memory', icon: '🧠', label: 'AI 记忆' },
    { id: 'settings', icon: '⚙️', label: '设置' },
  ];
  function shell(inner) {
    return `
      <div class="topbar"><div class="brand">周末去哪儿</div><button class="who" data-act="tab" data-tab="settings">我是 ${esc(userName(S.me))}</button></div>
      ${inner}
      <nav class="tabbar">${TABS.map((t) => `<button class="${S.tab === t.id ? 'on' : ''}" data-act="tab" data-tab="${t.id}"><span class="i">${t.icon}</span>${t.label}</button>`).join('')}</nav>`;
  }
  function renderMain() {
    let inner = '';
    if (S.tab === 'week') inner = renderWeek();
    else if (S.tab === 'history') inner = renderHistory();
    else if (S.tab === 'memory') inner = renderMemory();
    else if (S.tab === 'settings') inner = renderSettings();
    else if (S.tab === 'diag') inner = renderDiag();
    const y = window.scrollY;
    app().innerHTML = shell(inner);
    // restore drafts
    document.querySelectorAll('[data-draft]').forEach((el) => {
      const k = el.getAttribute('data-draft');
      if (S.drafts[k]) el.value = S.drafts[k];
    });
    if (S._keepScroll) window.scrollTo(0, y);
    S._keepScroll = false;
    if (S.gen && !S.gen.hidden) renderGenSheet();
  }

  async function loadTab(silent) {
    try {
      if (S.tab === 'week') {
        S.data = await api(`/api/state${S.viewIssueId ? `?issue=${S.viewIssueId}` : ''}`);
        // keep the progress sheet fresh while a long step is running on the server
        const g = S.gen, dg = S.data.gen;
        if (g && dg && dg.id === g.id && g.status === 'running' && (dg.log || []).length > (g.log || []).length) {
          g.log = dg.log; g.step = dg.step;
        }
      } else if (S.tab === 'history') {
        if (!S.data) S.data = await api('/api/state');
        S.issues = await api('/api/issues');
      } else if (S.tab === 'memory') {
        if (!S.data) S.data = await api('/api/state');
        S.memory = await api('/api/memory');
      } else if (S.tab === 'settings') {
        if (!S.data) S.data = await api('/api/state');
        S.settings = await api('/api/settings');
      } else if (S.tab === 'diag') {
        if (!S.data) S.data = await api('/api/state');
        S.diag = await api('/api/diag');
      }
    } catch (e) {
      if (!S.pass) return;
      if (!silent) toast(e.message);
      if (!S.data) {
        app().innerHTML = `<div class="boot"><div class="logo">🌧️</div><p>${esc(e.message)}</p><button class="btn" data-act="reload">重试</button></div>`;
        return;
      }
    }
    if (silent) S._keepScroll = true;
    renderMain();
  }

  // ---------------- week view ----------------
  const VOTES = [
    { v: 'want', label: '😍 想去' },
    { v: 'maybe', label: '🤔 再看看' },
    { v: 'no', label: '🙅 不想去' },
  ];
  const VOTE_LABEL = { want: '😍 想去', maybe: '🤔 再看看', no: '🙅 不想去' };

  function weatherHtml(w) {
    if (!w || (!w.sat && !w.sun)) return '';
    const day = (k, label) => {
      const d = w[k];
      if (!d) return '';
      const glow = d.glow && d.glow.level === '高' ? ' · 🌇晚霞指数高' : '';
      return `<div class="day"><b>${label} ${esc(d.icon)} ${esc(d.tmin)}~${esc(d.tmax)}°</b><br>${esc(d.text)}${d.rain != null ? ` · 雨 ${esc(d.rain)}%` : ''}${glow}</div>`;
    };
    return `<div class="wx">${day('sat', '周六')}${day('sun', '周日')}</div>`;
  }

  function renderWeek() {
    const d = S.data;
    if (!d) return '<div class="boot"><span class="spin"></span></div>';
    let html = '';
    if (isIOS && !standalone() && !store.get('wk_hide_install')) {
      html += `<div class="banner"><div>📲 <b>添加到主屏幕才能收到推送</b><br>点 Safari 底部的「分享」按钮 → 选「添加到主屏幕」，之后从桌面图标打开。</div><button class="x" data-act="hide-install">×</button></div>`;
    } else if (standalone() && 'Notification' in window && Notification.permission === 'default') {
      html += `<div class="banner"><div>🔔 <b>开启通知</b>，每${WD[d.config.push.weekday]}准时收到清单、对方留言也能第一时间知道。</div><button class="btn small" data-act="push-reregister">开启</button></div>`;
    } else if (standalone() && 'Notification' in window && Notification.permission === 'denied') {
      html += '<div class="banner warn"><div>🔕 通知被关掉了：去 iPhone <b>设置 → 通知 → 周末去哪儿</b> 打开「允许通知」。</div></div>';
    } else if (standalone() && S.localSub === false) {
      html += `<div class="banner"><div>🔔 本机还没登记推送，点一下就好。</div><button class="btn small" data-act="push-reregister">登记</button></div>`;
    }
    if (d.gen && d.gen.status === 'running') {
      html += `<div class="banner"><div><span class="spin"></span> 本周清单正在生成中…<br><span class="small muted">${esc((d.gen.log || []).slice(-1)[0] || '')}</span></div><button class="btn small" data-act="gen-resume">查看</button></div>`;
    } else if (d.gen && d.gen.status === 'failed') {
      html += `<div class="banner warn"><div>⚠️ 本周清单生成失败：${esc(d.gen.error || '')}</div><button class="btn small" data-act="gen" data-force="1">重试</button></div>`;
    }
    if (!d.keys.openai && !d.keys.deepseek) {
      html += '<div class="banner warn"><div>还没有配置 AI 的 API Key，去「设置 → AI 与密钥」里填一下吧。</div></div>';
    }

    const iss = d.issue;
    if (!iss) {
      html += `<div class="card empty"><div class="big">🌤️</div><h3>第一期清单还没生成</h3>
        <p class="muted">每${WD[d.config.push.weekday]} ${esc(d.config.push.time)} 会自动推送本周末的备选清单。<br>等不及的话，现在就让 AI 帮你们找找吧！</p>
        <button class="btn" data-act="gen">✨ 现在生成本周清单</button></div>`;
      return html;
    }
    const viewingOld = S.viewIssueId && !d.isCurrent;
    if (viewingOld) {
      html += `<div class="row" style="margin-bottom:10px"><button class="btn small plain" data-act="view-current">← 回到本周</button></div>`;
    }
    const title = d.isCurrent ? '这个周末，去哪儿？' : (iss.sat < d.target.sat ? '上次的周末清单' : '周末清单');
    html += `<section class="hero">
      <div class="row"><span class="pill">📍 ${esc(iss.city)}</span><span>${cnDate(iss.sat)} – ${cnDate(iss.sun)}</span></div>
      <h1>${esc(title)}</h1>
      <p class="headline">${esc(iss.headline)}</p>
      ${weatherHtml(iss.weather)}
    </section>`;
    if (!d.isCurrent && !viewingOld) {
      html += `<div class="banner" style="margin-top:14px"><div>🗓️ 新一期清单将在 <b>${esc(fmtPush(d.nextPushTs))}</b> 送达。<br><span class="small muted">这是上一期的内容，别忘了标记你们最后去了哪 ✅</span></div><button class="btn small" data-act="gen">现在生成</button></div>`;
    }

    const items = d.items || [];
    const me = S.me, other = otherId();
    const both = items.filter((it) => it.reactions[me] === 'want' && it.reactions[other] === 'want');
    const chosen = items.filter((it) => it.chosen_by);
    if (chosen.length || both.length) {
      html += '<div class="card" style="margin-top:14px">';
      if (chosen.length) html += `<div><b>✅ 已经定了：</b>${chosen.map((it) => `${esc(it.data.emoji)} ${esc(it.data.title)}`).join('、')}</div>`;
      if (both.length) html += `<div${chosen.length ? ' style="margin-top:6px"' : ''}><b>💞 你们都想去：</b>${both.map((it) => `${esc(it.data.emoji)} ${esc(it.data.title)}`).join('、')}</div>`;
      html += '</div>';
    }

    const live = items.filter((it) => it.kind === 'live');
    const personal = items.filter((it) => it.kind === 'personal');
    html += `<div class="section-title"><h2>🎟️ 本周末在发生</h2><span>${live.length} 条 · 实时检索</span></div>`;
    html += live.length ? live.map(itemCard).join('') : '<div class="card muted small">这期没有检索到合适的实时活动。</div>';
    html += `<div class="section-title"><h2>💡 为你们定制</h2><span>${personal.length} 条 · 懂你们的建议</span></div>`;
    html += personal.length ? personal.map(itemCard).join('') : '<div class="card muted small">暂无个性化建议。</div>';

    // general discussion
    const gk = `g:${iss.id}`;
    html += `<div class="section-title"><h2>💬 这周末的整体想法</h2><span>两人都看得到</span></div>
      <div class="card">
        ${(d.general || []).map(bubble).join('') || '<div class="muted small">比如：“这周想宅一点” / “周日下午要加班”…</div>'}
        <form class="cmt-form" data-form="comment" data-issue="${iss.id}">
          <input class="input" name="text" maxlength="500" placeholder="说点什么…" data-draft="${gk}" autocomplete="off">
          <button class="btn small" type="submit">发送</button>
        </form>
      </div>`;

    html += usageHtml(iss, d.monthCostCny, d.keys);
    const eng = iss.engines || {};
    const st = (s) => (s === 'done' ? '✓' : s === 'skipped' ? '未启用' : '✗');
    html += `<p class="small muted center" style="margin-top:18px">信息来自网络公开资料，可能有变动，出发前请以官方渠道为准。<br>
      检索：DeepSeek ${st(eng.deepseek)} · GPT ${st(eng.gpt)} · 终审：${eng.agent === 'gpt' ? 'GPT' : eng.agent === 'deepseek' ? 'DeepSeek' : '规则'}${iss.published_at ? ` · ${fmtTs(iss.published_at)}发布` : ''}</p>`;
    if (d.isCurrent) html += `<div class="center" style="margin-top:6px"><button class="btn small plain" data-act="gen" data-force="1">🔄 重新生成本周清单</button></div>`;
    return html;
  }

  function fmtTok(n) {
    n = Number(n) || 0;
    return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n);
  }
  function money(n) { n = Number(n) || 0; return n > 0 && n < 0.01 ? '<0.01' : n.toFixed(2); }
  function usageHtml(iss, monthCny, keys) {
    const u = iss.usage;
    if (!u) return '';
    const rate = iss.usdCny || 7.1;
    const rows = [];
    if (u.ds && (u.ds.calls || u.ds.searches)) {
      rows.push(`<div>DeepSeek：输入 ${fmtTok(u.ds.in)} + 输出 ${fmtTok(u.ds.out)} tokens，搜索 ${u.ds.searches} 次 ≈ <b>¥${money(u.ds.cny)}</b></div>`);
    }
    if (u.oa && (u.oa.calls || u.oa.searches)) {
      rows.push(`<div>GPT：输入 ${fmtTok(u.oa.in)} + 输出 ${fmtTok(u.oa.out)} tokens，搜索 ${u.oa.searches} 次 ≈ <b>¥${money(u.oa.usd * rate)}</b>（$${(u.oa.usd || 0).toFixed(3)}）</div>`);
    }
    if (!rows.length) rows.push('<div>本期没有调用 AI</div>');
    const b = iss.balance || {};
    const bal = [];
    if (b.deepseek && Number.isFinite(b.deepseek.total)) {
      bal.push(`DeepSeek <b>${b.deepseek.currency === 'USD' ? '$' : '¥'}${b.deepseek.total.toFixed(2)}</b>${b.deepseek.available ? '' : '（余额不足，请充值）'}`);
    } else if (b.deepseekError) bal.push('DeepSeek 余额查询失败');
    if ((keys && keys.openai) || (u.oa && u.oa.calls)) bal.push('OpenAI <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">去官网查看</a>');
    return `<div class="card small usage" style="margin-top:18px">
      <div style="font-weight:700;margin-bottom:6px">🧾 本期 AI 用量</div>
      ${rows.join('')}
      <div style="margin-top:6px">本期合计约 <b>¥${money(iss.costCny)}</b>${monthCny != null ? ` · 本月累计约 ¥${money(monthCny)}` : ''}</div>
      ${bal.length ? `<div style="margin-top:6px">💰 余额（生成时）：${bal.join(' · ')}</div>` : ''}
      <div class="muted" style="margin-top:6px">按官方价格估算，实际以平台账单为准${u.oa && u.oa.calls ? `；美元按 1:${rate} 折算` : ''}。</div>
    </div>`;
  }

  function bubble(c) {
    const mine = c.user_id === S.me;
    return `<div class="bubble ${mine ? 'me' : ''}"><div class="meta">${esc(userName(c.user_id))} · ${esc(fmtTs(c.created_at))}${mine ? ` <button class="del" data-act="cmt-del" data-cid="${c.id}">删除</button>` : ''}</div>${esc(c.text)}</div>`;
  }

  function itemCard(it) {
    const d = it.data || {};
    const me = S.me, other = otherId();
    const mine = it.reactions[me] || '';
    const theirs = it.reactions[other] || '';
    const tags = [];
    tags.push(`<span class="chip ${it.kind === 'live' ? 'accent' : 'purple'}">${esc(d.category || (it.kind === 'live' ? '活动' : '建议'))}</span>`);
    if (d.isOut) tags.push(`<span class="chip">🚗 ${esc(d.city)}${d.hours ? ` · 约${esc(d.hours)}h` : ''}</span>`);
    if (it.kind === 'live' && d.origin === 'both') tags.push('<span class="chip good">双重核实</span>');
    if (d.activity && it.kind === 'personal') tags.push(`<span class="chip">${esc(d.activity)}</span>`);
    const facts = [];
    if (d.when) facts.push(`<li><span class="k">📅</span><span>${esc(d.when)}</span></li>`);
    if (d.where) facts.push(`<li><span class="k">📍</span><span>${esc(d.where)}</span></li>`);
    if (d.price) facts.push(`<li><span class="k">💰</span><span>${esc(d.price)}</span></li>`);
    const links = (d.links || []).map((l) => { const u = safeUrl(l.url); return u ? `<a class="${l.kind === 'book' ? 'book' : ''}" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>` : ''; }).join('');
    const open = S.openComments.has(it.id);
    const cmts = it.comments || [];
    const dk = `c:${it.id}`;
    return `<article class="card item ${it.chosen_by ? 'chosen' : ''}" data-id="${it.id}">
      <div class="head">
        <div class="emoji">${esc(d.emoji || '✨')}</div>
        <div style="flex:1;min-width:0"><h3>${esc(d.title)}</h3><div class="tags">${tags.join('')}</div></div>
      </div>
      ${facts.length ? `<ul class="facts">${facts.join('')}</ul>` : ''}
      ${d.summary ? `<p class="summary">${esc(d.summary)}</p>` : ''}
      ${d.reason ? `<p class="reason">💡 ${esc(d.reason)}</p>` : ''}
      ${d.booking ? `<p class="booking">📝 ${esc(d.booking)}</p>` : ''}
      ${links ? `<div class="links">${links}</div>` : ''}
      ${it.chosen_by ? `<div class="chosen-badge">✅ ${esc(userName(it.chosen_by))} 定了这个</div>` : ''}
      <div class="votes">
        <div class="vote-row"><span class="name">我</span>${VOTES.map((x) => `<button class="vote-btn ${x.v} ${mine === x.v ? 'on' : ''}" data-act="vote" data-id="${it.id}" data-v="${x.v}">${x.label}</button>`).join('')}</div>
        <div class="other-vote">${esc(userName(other))}：${theirs ? `<b>${VOTE_LABEL[theirs]}</b>` : '<span>还没表态</span>'}</div>
      </div>
      <div class="item-actions">
        <button class="btn small ${it.chosen_by ? 'plain' : 'ghost'}" data-act="choose" data-id="${it.id}" data-on="${it.chosen_by ? '0' : '1'}">${it.chosen_by ? '取消选定' : '✅ 就它了'}</button>
        <button class="btn small plain" data-act="cmt-toggle" data-id="${it.id}">💬 ${cmts.length ? `${cmts.length} 条留言` : '留言'}</button>
      </div>
      ${open ? `<div class="comments">${cmts.map(bubble).join('')}
        <form class="cmt-form" data-form="comment" data-item="${it.id}">
          <input class="input" name="text" maxlength="500" placeholder="写下你的想法…" data-draft="${dk}" autocomplete="off">
          <button class="btn small" type="submit">发送</button>
        </form></div>` : ''}
    </article>`;
  }

  // ---------------- history ----------------
  function renderHistory() {
    const list = S.issues && S.issues.issues;
    if (!list) return '<div class="boot"><span class="spin"></span></div>';
    if (!list.length) return '<div class="card empty"><div class="big">📚</div><p class="muted">还没有往期清单</p></div>';
    return `<div class="section-title"><h2>📚 往期清单</h2><span>共 ${list.length} 期</span></div>` + list.map((i) => `
      <a class="card issue-row" href="#" data-act="open-issue" data-id="${i.id}">
        <div class="row"><span class="t">${cnDate(i.sat)} – ${cnDate(i.sun)}</span><span class="spacer"></span><span class="chip">${esc(i.city)}</span>${i.status === 'archived' ? '<span class="chip">已重新生成</span>' : ''}</div>
        <div class="muted small" style="margin-top:4px">${esc(i.headline || '')}</div>
        ${i.chosen && i.chosen.length ? `<div class="chips" style="margin-top:8px">${i.chosen.map((c) => `<span class="chip good">✅ ${esc(c.emoji || '')} ${esc(c.title)}</span>`).join('')}</div>` : ''}
      </a>`).join('');
  }

  // ---------------- memory ----------------
  function renderMemory() {
    const m = S.memory;
    if (!m) return '<div class="boot"><span class="spin"></span></div>';
    const p = m.profile || {};
    const chips = (arr, cls) => (arr && arr.length ? `<div class="chips">${arr.map((x) => `<span class="chip ${cls || ''}">${esc(x)}</span>`).join('')}</div>` : '<span class="muted small">还在学习中…</span>');
    const people = (m.users || []).map((u) => {
      const pp = (p.people && p.people[u.id]) || {};
      return `<div style="margin-top:12px"><b>${esc(u.name)}</b>
        <div class="small muted" style="margin:4px 0 2px">喜欢</div>${chips(pp.likes, 'accent')}
        <div class="small muted" style="margin:6px 0 2px">不太感冒</div>${chips(pp.dislikes)}
        ${pp.notes ? `<div class="small" style="margin-top:6px">${esc(pp.notes)}</div>` : ''}</div>`;
    }).join('');
    const ald = p.activity_last_done || {};
    let html = `<div class="section-title"><h2>🧠 AI 眼中的你们</h2><span>${m.lastUpdated ? `更新于 ${fmtTs(m.lastUpdated)}` : '尚未学习'}</span></div>
      <div class="card">
        <p style="margin:0 0 10px">${esc(p.summary || '还没有足够的反馈。多给清单投票、留言、标记“就它了”，AI 会越来越懂你们。')}</p>
        <div class="small muted" style="margin:6px 0 2px">一起时喜欢</div>${chips(p.together && p.together.likes, 'purple')}
        <div class="small muted" style="margin:8px 0 2px">一起时不爱</div>${chips(p.together && p.together.dislikes)}
        ${p.together && p.together.patterns && p.together.patterns.length ? `<div class="small muted" style="margin:8px 0 2px">规律</div>${chips(p.together.patterns)}` : ''}
        ${p.rules && p.rules.length ? `<div class="small muted" style="margin:8px 0 2px">AI 会记住的小规则</div>${chips(p.rules, 'good')}` : ''}
        <hr class="hr">${people}
      </div>
      <div class="section-title"><h2>⏱️ 上次做这些</h2><span>来自你们的“就它了”</span></div>
      <div class="card"><div class="act-grid">${(m.activities || []).map((a) => `<div class="a">${esc(a)}<div class="w">${ald[a] ? `${esc(daysAgo(ald[a]))}（${cnDate(ald[a])}）` : '还没记录'}</div></div>`).join('')}</div></div>
      <div class="section-title"><h2>✍️ 告诉 AI</h2><span>下次生成时会参考</span></div>
      <div class="card">
        <form data-form="note">
          <textarea class="textarea" name="text" maxlength="500" placeholder="比如：最近想学冲浪 / 这周脚扭了，别推荐运动 / 我们不喜欢排长队的网红店" data-draft="note"></textarea>
          <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="btn small" type="submit">告诉 AI</button></div>
        </form>
        ${(m.notes || []).map((n) => `<div class="bubble ${n.user_id === S.me ? 'me' : ''}" style="max-width:100%"><div class="meta">${esc(userName(n.user_id))} · ${esc(fmtTs(n.created_at))}${n.digested ? ' · 已学习' : ' · 待学习'}${n.user_id === S.me ? ` <button class="del" data-act="note-del" data-nid="${n.id}">删除</button>` : ''}</div>${esc(n.text)}</div>`).join('')}
      </div>
      <div class="row" style="margin-top:6px">
        <button class="btn ghost" style="flex:1" data-act="mem-refresh">🔁 让 AI 现在复盘</button>
        <button class="btn plain" style="flex:1" data-act="mem-edit">✏️ ${S.editMemory ? '收起编辑' : '手动修改记忆'}</button>
      </div>`;
    if (S.editMemory) {
      html += `<div class="card" style="margin-top:14px"><p class="small muted" style="margin-top:0">高级：直接编辑 AI 记忆（JSON 格式）。改错了也没关系，AI 下次复盘会修正。</p>
        <form data-form="memory"><textarea class="textarea" name="profile" style="min-height:260px;font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(JSON.stringify(p, null, 2))}</textarea>
        <button class="btn block" style="margin-top:8px" type="submit">保存记忆</button></form></div>`;
    }
    return html;
  }

  // ---------------- settings ----------------
  function renderSettings() {
    const s = S.settings;
    if (!s) return '<div class="boot"><span class="spin"></span></div>';
    const c = s.config;
    const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const mySubs = (S.data && S.data.push.subs && S.data.push.subs[S.me]) || 0;
    let pushState;
    if (isIOS && !standalone()) pushState = '⚠️ 需要先“添加到主屏幕”，再从桌面图标打开';
    else if (!pushSupported) pushState = '当前浏览器不支持推送';
    else if (perm === 'denied') pushState = '❌ 通知被拒绝了：请到 iPhone 设置 → 通知 → 周末去哪儿 中打开';
    else if (perm === 'granted' && mySubs) pushState = `✅ 已开启（${mySubs} 台设备）`;
    else pushState = '还没开启';
    const users = c.users;
    return `
      <div class="section-title"><h2>👤 我是</h2></div>
      <div class="card"><div class="row">${users.map((u) => `<button class="btn ${u.id === S.me ? '' : 'plain'}" style="flex:1" data-act="switch-user" data-id="${esc(u.id)}">${esc(u.name)}</button>`).join('')}</div></div>

      <div class="section-title"><h2>🔔 通知</h2></div>
      <div class="card">
        <div class="small">${esc(pushState)}</div>
        <div class="row wrap" style="margin-top:10px"><button class="btn small" data-act="push-on">开启/刷新本机通知</button><button class="btn small plain" data-act="push-test">发一条测试</button></div>
        <div class="row wrap" style="margin-top:8px"><button class="btn small plain" data-act="push-check">🩺 推送体检</button><button class="btn small plain" data-act="push-reregister">🔄 重新登记本机</button></div>
        <div id="push-check-out" class="small" style="margin-top:8px"></div>
        <hr class="hr">
        <form data-form="notify">
          <label class="toggle"><span>每${WD[c.push.weekday]} ${esc(c.push.time)} 推送本周清单</span><input type="checkbox" checked disabled></label>
          <label class="toggle"><span>对方留言 / 定计划时提醒我</span><input type="checkbox" name="commentNotify" ${c.push.commentNotify ? 'checked' : ''}></label>
          <label class="toggle"><span>周日 20:00 提醒标记“最后去了哪”</span><input type="checkbox" name="sundayReminder" ${c.push.sundayReminder ? 'checked' : ''}></label>
          <div class="row"><label class="field" style="flex:1"><span>推送日</span><select class="select" name="weekday">${[1, 2, 3, 4, 5, 6, 0].map((w) => `<option value="${w}" ${c.push.weekday === w ? 'selected' : ''}>${WD[w]}</option>`).join('')}</select></label>
          <label class="field" style="flex:1"><span>推送时间</span><input class="input" type="time" name="time" value="${esc(c.push.time)}"></label></div>
          <label class="field"><span>备用：Bark 推送地址（可选，${esc(userName(S.me))} 的）</span><input class="input" name="bark" placeholder="https://api.day.app/你的Key" value="${esc((s.bark && s.bark[S.me]) || '')}" autocapitalize="off" spellcheck="false"></label>
          <button class="btn block" type="submit">保存通知设置</button>
        </form>
      </div>

      <div class="section-title"><h2>📍 城市与出行范围</h2></div>
      <div class="card">
        <form data-form="city">
          <label class="field"><span>目标城市</span><input class="input" name="city" value="${esc(c.city)}"></label>
          <div class="chips" style="margin:-4px 0 12px">${s.presets.map((p) => `<button type="button" class="chip" data-act="city-preset" data-city="${esc(p)}">${esc(p)}</button>`).join('')}</div>
          <div class="small muted" style="margin-bottom:6px">周边可去的城市（车程小时）。越远的城市被推荐得越少，每期最多 2 条外地活动。</div>
          <div id="nearby-list">${(c.nearby || []).map((n) => nearbyRow(n.name, n.hours)).join('')}</div>
          <button type="button" class="btn small plain" data-act="nearby-add">＋ 添加城市</button>
          <div class="hint">改了目标城市、但没改下面的列表时，会自动换成新城市的默认周边。</div>
          <button class="btn block" style="margin-top:12px" type="submit">保存城市设置</button>
        </form>
      </div>

      <div class="section-title"><h2>🎯 清单与爱好</h2></div>
      <div class="card">
        <form data-form="prefs">
          <div class="row"><label class="field" style="flex:1"><span>实时活动条数</span><input class="input" type="number" min="0" max="8" name="live" value="${esc(c.counts.live)}"></label>
          <label class="field" style="flex:1"><span>个性化建议条数</span><input class="input" type="number" min="0" max="8" name="personal" value="${esc(c.counts.personal)}"></label></div>
          <label class="field"><span>平时爱做的事（用逗号或换行分隔）</span><textarea class="textarea" name="activities">${esc(c.activities.join('，'))}</textarea></label>
          <div class="row"><label class="field" style="flex:1"><span>第一位的名字</span><input class="input" name="u0" value="${esc(users[0].name)}"></label><label class="field" style="flex:1"><span>第二位的名字</span><input class="input" name="u1" value="${esc(users[1].name)}"></label></div>
          <button class="btn block" type="submit">保存</button>
        </form>
      </div>

      <div class="section-title"><h2>🤖 AI 与密钥</h2></div>
      <div class="card">
        <form data-form="ai">
          <label class="field"><span>OpenAI API Key ${s.keys.openai ? `（当前：${esc(s.keys.openai)}）` : '（未设置）'}</span><input class="input" name="openai" placeholder="留空表示不修改" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>DeepSeek API Key ${s.keys.deepseek ? `（当前：${esc(s.keys.deepseek)}）` : '（未设置）'}</span><input class="input" name="deepseek" placeholder="留空表示不修改" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <details><summary>模型设置（一般不用改）</summary>
            <div style="margin-top:10px">
              <label class="field"><span>GPT 检索模型</span><input class="input" name="openaiSearch" value="${esc(c.models.openaiSearch)}" autocapitalize="off"></label>
              <label class="field"><span>GPT 终审模型</span><input class="input" name="openaiAgent" value="${esc(c.models.openaiAgent)}" autocapitalize="off"></label>
              <label class="field"><span>GPT 推理强度</span><select class="select" name="openaiEffort">${['low', 'medium', 'high'].map((e) => `<option ${c.models.openaiEffort === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
              <label class="field"><span>DeepSeek 规划模型</span><input class="input" name="deepseekPlanner" value="${esc(c.models.deepseekPlanner)}" autocapitalize="off"></label>
              <label class="field"><span>DeepSeek 提取/兜底模型</span><input class="input" name="deepseekExtractor" value="${esc(c.models.deepseekExtractor)}" autocapitalize="off"></label>
              <label class="toggle"><span>GPT 终审时允许再联网核实</span><input type="checkbox" name="agentWebSearch" ${c.agentWebSearch ? 'checked' : ''}></label>
            </div>
          </details>
          <button class="btn block" style="margin-top:12px" type="submit">保存 AI 设置</button>
        </form>
      </div>

      <div class="section-title"><h2>🛠️ 其他</h2></div>
      <div class="card stack">
        <button class="btn block" data-act="gen" data-force="1">✨ 立即生成本周清单</button>
        <button class="btn block plain" data-act="tab" data-tab="diag">🩺 运行状态与自检</button>
        <form data-form="password" class="row"><input class="input" type="password" name="next" placeholder="新访问密码（至少 6 位）" autocomplete="new-password"><button class="btn small plain" type="submit">改密码</button></form>
        <button class="btn block danger" data-act="logout">退出登录</button>
      </div>
      <p class="small muted center">build ${esc(S.boot && S.boot.build)}</p>`;
  }
  function nearbyRow(name, hours) {
    return `<div class="nearby-row"><input class="input" name="nb_name" value="${esc(name || '')}" placeholder="城市"><input class="input h" name="nb_hours" type="number" step="0.1" min="0.3" max="6" value="${esc(hours || '')}" placeholder="小时"><button type="button" class="btn small plain" data-act="nearby-del">✕</button></div>`;
  }

  // ---------------- diagnostics ----------------
  function renderDiag() {
    const g = S.diag;
    if (!g) return '<div class="boot"><span class="spin"></span></div>';
    const cur = g.current;
    return `<div class="row" style="margin-bottom:10px"><button class="btn small plain" data-act="tab" data-tab="settings">← 返回设置</button></div>
      <div class="section-title"><h2>🩺 运行状态</h2></div>
      <div class="card kv">
        <span class="k">定时任务</span><span>${g.cronOk ? `✅ 正常（${esc(fmtTs(g.lastTick))}）` : `❌ ${g.lastTick ? `上次运行 ${esc(fmtTs(g.lastTick))}` : '从未运行'}——请检查 Cloudflare 的 Cron 触发器`}</span>
        <span class="k">下次推送</span><span>${esc(fmtPush(g.nextPushTs))}</span>
        <span class="k">OpenAI</span><span>${g.keys.openai ? '已配置' : '未配置'}</span>
        <span class="k">DeepSeek</span><span>${g.keys.deepseek ? '已配置' : '未配置'}</span>
        <span class="k">DeepSeek 余额</span><span>${g.dsBalance && Number.isFinite(g.dsBalance.total) ? `${g.dsBalance.currency === 'USD' ? '$' : '¥'}${g.dsBalance.total.toFixed(2)}${g.dsBalance.available ? '' : '（不足，请充值）'}` : g.dsBalance && g.dsBalance.error ? `查询失败：${esc(g.dsBalance.error)}` : '-'}</span>
        <span class="k">本月 AI 花费</span><span>约 ¥${money(g.month ? g.month.cny : 0)}</span>
        <span class="k">推送设备</span><span>${(g.subs || []).map((s) => `${esc(userName(s.user_id))} ${s.n} 台`).join('，') || '无'}</span>
        <span class="k">本次节点</span><span>${esc(g.colo || '-')}</span>
        <span class="k">本周期</span><span>${cur ? `${esc(cur.status)}${cur.error ? ` · ${esc(cur.error)}` : ''}` : '尚未生成'}</span>
      </div>
      <div class="section-title"><h2>🧪 一键自检</h2></div>
      <div class="card stack">
        <button class="btn block plain" data-act="diag-test" data-t="openai">测试 OpenAI</button>
        <button class="btn block plain" data-act="diag-test" data-t="deepseek">测试 DeepSeek（含搜索）</button>
        <button class="btn block plain" data-act="diag-test" data-t="weather">测试天气</button>
        <div id="diag-out" class="small"></div>
      </div>
      ${cur && cur.gen && cur.gen.log && cur.gen.log.length ? `<div class="section-title"><h2>📝 本期生成过程</h2></div><div class="card progress-log">${cur.gen.log.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
      <div class="section-title"><h2>📜 日志</h2></div>
      <div class="card">${(g.logs || []).map((l) => `<div class="log-line"><span class="lv ${esc(l.level)}">${esc(l.level)}</span>${esc(fmtTs(l.ts))} · ${esc(l.msg)}</div>`).join('') || '<span class="muted small">暂无</span>'}</div>`;
  }

  // ---------------- generation flow ----------------
  const STEP_ORDER = ['prepare', 'memory', 'search', 'agent', 'finalize', 'done'];
  function renderGenSheet() {
    let el = document.getElementById('gen-sheet');
    if (!S.gen) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'gen-sheet';
      el.className = 'sheet-mask';
      document.body.appendChild(el);
    }
    const g = S.gen;
    const idx = Math.max(0, STEP_ORDER.indexOf(g.step || 'prepare'));
    const failed = g.status === 'failed';
    const done = g.status === 'published' || g.status === 'ready';
    const k = (S.data && S.data.keys) || {};
    const how = k.openai && k.deepseek ? 'DeepSeek 和 GPT 分别联网检索，再由 GPT 终审'
      : k.openai ? 'GPT 联网检索并终审' : 'DeepSeek 联网检索并终审';
    el.innerHTML = `<div class="sheet">
      <h3>${done ? '🎉 清单生成好了' : failed ? '😵 生成失败' : '✨ AI 正在为你们找周末好去处'}</h3>
      <div class="small muted">${done ? '' : failed ? esc(g.error || '') : `${how}，通常需要 3~8 分钟。可以先关掉 App，生成好会推送通知。`}</div>
      <div class="steps">${STEP_ORDER.slice(0, 5).map((s, i) => `<div class="s ${i < idx || done ? 'done' : i === idx && !failed ? 'cur' : ''}"></div>`).join('')}</div>
      <div class="progress-log">${(g.log || []).map((l) => `<div>${esc(l)}</div>`).join('') || '<div>准备中…</div>'}${g.netErr ? `<div style="color:var(--warn)">${esc(g.netErr)}</div>` : ''}</div>
      <div class="row">
        ${failed ? '<button class="btn" style="flex:1" data-act="gen" data-force="1">重试</button>' : ''}
        <button class="btn plain" style="flex:1" data-act="gen-close">${done || failed ? '关闭' : '先收起，后台继续'}</button>
      </div></div>`;
  }

  async function startGen(force) {
    if (S.gen && S.gen.status === 'running' && S.gen.looping) { renderGenSheet(); return; }
    let r;
    try {
      r = await api('/api/gen/start', { method: 'POST', body: { force: !!force } });
      if (!r.ok && r.exists) {
        if (!window.confirm(r.message || '确定重新生成吗？')) return;
        r = await api('/api/gen/start', { method: 'POST', body: { force: true } });
      } else if (force && r.ok && !r.resumed && S.data && S.data.issue && S.data.isCurrent) {
        // server already archived the old list (force=true); nothing else to do
      }
    } catch (e) { toast(e.message); return; }
    S.gen = { id: r.issueId, status: 'running', step: 'prepare', log: [] };
    genLoop();
  }
  async function genLoop() {
    const g = S.gen;
    if (!g || g.looping) return;
    g.looping = true;
    renderGenSheet();
    let netFails = 0;
    while (S.gen === g && g.status === 'running') {
      let res;
      try {
        res = await api('/api/gen/advance', { method: 'POST', body: { issueId: g.id } });
        netFails = 0;
        g.netErr = '';
      } catch (e) {
        netFails++;
        g.netErr = `${e.message}（自动重试中…）`;
        renderGenSheetIfOpen();
        if (netFails > 10) { g.netErr = '网络不稳定，生成会在云端继续，稍后回来看看'; break; }
        await sleep(5000);
        continue;
      }
      g.status = res.status;
      if (res.gen) { g.log = res.gen.log || []; g.step = res.gen.step; g.error = res.gen.error; }
      renderGenSheetIfOpen();
      await sleep(res.busy ? 5000 : 1200);
    }
    g.looping = false;
    if (S.gen !== g) return;
    if (g.status === 'published' || g.status === 'ready') {
      toast('清单生成好了 🎉');
      S.viewIssueId = null;
      S.tab = 'week';
      if (g.hidden) S.gen = null;
      await loadTab(true);
      renderGenSheetIfOpen();
    } else {
      renderGenSheetIfOpen();
    }
  }
  function renderGenSheetIfOpen() { if (S.gen && !S.gen.hidden) renderGenSheet(); }

  // ---------------- push ----------------
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch (e) { return null; }
  }
  async function enablePush() {
    if (isIOS && !standalone()) { toast('请先「添加到主屏幕」，再从桌面图标打开 App 开启通知', 4000); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { toast('当前浏览器不支持推送'); return; }
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('没有获得通知权限，可到 iPhone 设置 → 通知 中开启', 4000); return; }
    try {
      await registerSW();
      const reg = await navigator.serviceWorker.ready;
      const key = S.data && S.data.push && S.data.push.vapidPublicKey;
      if (!key) throw new Error('服务器还没准备好推送密钥');
      let sub = await reg.pushManager.getSubscription();
      if (sub && sub.options && sub.options.applicationServerKey && bytesToB64url(sub.options.applicationServerKey) !== key) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
      await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      toast('通知已开启 🎉');
      S.data = await api('/api/state');
      if (S.tab === 'settings') S.settings = await api('/api/settings');
      S._keepScroll = true;
      renderMain();
    } catch (e) {
      toast(`开启失败：${e.message || e}`, 4000);
    }
  }
  // In-app push self-check: verifies every link of the chain on THIS phone
  async function pushCheck(out) {
    const lines = [];
    const add = (ok, text) => {
      lines.push(`<div>${ok === true ? '✅' : ok === false ? '❌' : 'ℹ️'} ${esc(text)}</div>`);
      out.innerHTML = lines.join('');
    };
    add(standalone(), standalone() ? '是从桌面图标打开的' : '不是从桌面图标打开的（iPhone 必须从桌面图标打开 App 才能收通知）');
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { add(false, '当前环境不支持推送'); return; }
    const permText = { granted: '已允许', denied: '被拒绝了（去 iPhone 设置 → 通知 → 周末去哪儿 打开）', default: '还没授权（点「重新登记本机」）' };
    add(Notification.permission === 'granted', `通知权限：${permText[Notification.permission] || Notification.permission}`);
    const reg = await navigator.serviceWorker.getRegistration('/');
    add(!!(reg && reg.active), reg && reg.active ? '后台服务正在运行' : '后台服务没有运行（点「重新登记本机」）');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    add(!!sub, sub ? `本机有推送订阅（…${sub.endpoint.slice(-6)}）` : '本机没有推送订阅（点「重新登记本机」）');
    const c = await api('/api/push/check', { method: 'POST', body: { endpoint: sub ? sub.endpoint : '' } });
    add(c.known, c.known ? '服务器上已登记本机' : '服务器上没有登记本机（点「重新登记本机」）');
    if (c.devices.length) add(null, `你名下共 ${c.devices.length} 台设备：${c.devices.map((x) => `…${x.tail}（${fmtTs(x.created_at)}登记${x.current ? '，就是本机' : ''}）`).join('；')}`);
    if (!sub || !c.known) return;
    add(null, '正在只给本机发一条体检推送，最多等 20 秒…');
    const token = Math.random().toString(36).slice(2);
    const got = new Promise((resolve) => {
      const h = (ev) => {
        if (ev.data && ev.data.type === 'push-received' && ev.data.check === token) {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('message', h);
          resolve(ev.data);
        }
      };
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('message', h); resolve(null); }, 20000);
      navigator.serviceWorker.addEventListener('message', h);
    });
    const r = await api('/api/push/test-device', { method: 'POST', body: { endpoint: sub.endpoint, check: token } });
    add(r.ok, `苹果推送服务器响应：${r.status}${r.ok ? '（已接收）' : ` ${r.text || ''}`}`);
    if (!r.ok) { if (r.removed) add(false, '苹果说这个订阅已经失效了 → 点「重新登记本机」'); return; }
    const m = await got;
    if (!m) add(false, '20 秒内本机没收到推送 → 订阅多半已失效，点「重新登记本机」后再体检一次');
    else if (!m.shown) add(false, `本机收到了推送，但弹出通知失败：${m.err}`);
    else add(true, '本机已收到推送并弹出了通知！如果屏幕上没看到，请检查 iPhone 设置 → 通知 → 周末去哪儿（打开横幅、锁定屏幕、通知中心），并关闭专注模式');
  }
  async function reRegisterPush() {
    if (isIOS && !standalone()) { toast('请从桌面图标打开 App 后再操作', 4000); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { toast('当前环境不支持推送'); return; }
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('没有获得通知权限，请到 iPhone 设置 → 通知 → 周末去哪儿 打开', 4500); return; }
    await registerSW();
    const reg = await navigator.serviceWorker.ready;
    const old = await reg.pushManager.getSubscription();
    if (old) {
      try { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: old.endpoint } }); } catch (e) { /* ignore */ }
      try { await old.unsubscribe(); } catch (e) { /* ignore */ }
    }
    if (!S.data || !S.data.push) S.data = await api('/api/state');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(S.data.push.vapidPublicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    const c = await api('/api/push/check', { method: 'POST', body: { endpoint: sub.endpoint } });
    const others = c.devices.filter((x) => !x.current).length;
    if (others && window.confirm(`你名下还有 ${others} 台旧设备的登记（比如删掉的旧图标）。要清除它们、只保留本机吗？\n只有这一台 iPhone 的话，点「确定」。`)) {
      await api('/api/push/prune', { method: 'POST', body: { keep: sub.endpoint } });
    }
    toast('本机已登记 ✅ 可以在「设置」里点「推送体检」确认', 4000);
    S.localSub = true;
    S.data = await api('/api/state');
    S._keepScroll = true;
    renderMain();
  }

  async function syncPushSilently() {
    try {
      await registerSW();
      if (!('Notification' in window) || Notification.permission !== 'granted' || !('PushManager' in window)) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const key = S.data && S.data.push && S.data.push.vapidPublicKey;
      const had = S.localSub;
      S.localSub = !!sub;
      if (had !== S.localSub && S.tab === 'week' && S.data) { S._keepScroll = true; renderMain(); }
      if (!sub || !key) return;
      if (sub.options && sub.options.applicationServerKey && bytesToB64url(sub.options.applicationServerKey) !== key) return;
      await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    } catch (e) { /* ignore */ }
  }

  // ---------------- events ----------------
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el && el.getAttribute && el.getAttribute('data-draft')) S.drafts[el.getAttribute('data-draft')] = el.value;
  });

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');
    if (el.tagName === 'A' && act) e.preventDefault();
    try {
      await onAction(act, el);
    } catch (err) {
      toast(err.message || String(err));
    }
  });

  async function onAction(act, el) {
    const id = Number(el.getAttribute('data-id')) || el.getAttribute('data-id');
    switch (act) {
      case 'reload': location.reload(); return;
      case 'pick-user':
      case 'switch-user': {
        S.me = String(el.getAttribute('data-id'));
        store.set('wk_me', S.me);
        if (act === 'pick-user') { S.tab = 'week'; await loadTab(); syncPushSilently(); }
        else { await syncPushSilently(); toast(`已切换为 ${userName(S.me)}`); await loadTab(); }
        return;
      }
      case 'tab': {
        S.tab = el.getAttribute('data-tab');
        if (S.tab === 'week') S.viewIssueId = S.viewIssueId || null;
        window.scrollTo(0, 0);
        renderMain();
        await loadTab();
        return;
      }
      case 'view-current': S.viewIssueId = null; await loadTab(); window.scrollTo(0, 0); return;
      case 'open-issue': S.viewIssueId = id; S.tab = 'week'; window.scrollTo(0, 0); await loadTab(); return;
      case 'hide-install': store.set('wk_hide_install', '1'); renderMain(); return;
      case 'vote': {
        const v = el.getAttribute('data-v');
        const it = S.data.items.find((x) => x.id === id);
        if (!it) return;
        const next = it.reactions[S.me] === v ? '' : v;
        if (next) it.reactions[S.me] = next; else delete it.reactions[S.me];
        S._keepScroll = true; renderMain();
        try {
          await api('/api/react', { method: 'POST', body: { itemId: id, value: next } });
        } catch (err) { await loadTab(true); throw err; }
        return;
      }
      case 'choose': {
        const on = el.getAttribute('data-on') === '1';
        const it = S.data.items.find((x) => x.id === id);
        if (it) { it.chosen_by = on ? S.me : null; S._keepScroll = true; renderMain(); }
        try {
          await api('/api/choose', { method: 'POST', body: { itemId: id, chosen: on } });
        } catch (err) { await loadTab(true); throw err; }
        if (on) toast('已标记 ✅ AI 会记住你们的选择');
        return;
      }
      case 'cmt-toggle': {
        if (S.openComments.has(id)) S.openComments.delete(id); else S.openComments.add(id);
        S._keepScroll = true; renderMain();
        if (S.openComments.has(id)) { const inp = document.querySelector(`[data-draft="c:${id}"]`); if (inp) inp.focus({ preventScroll: true }); }
        return;
      }
      case 'cmt-del': {
        if (!window.confirm('删除这条留言？')) return;
        await api('/api/comment/delete', { method: 'POST', body: { id: Number(el.getAttribute('data-cid')) } });
        await loadTab(true);
        return;
      }
      case 'gen': await startGen(el.getAttribute('data-force') === '1'); return;
      case 'gen-resume': {
        if (S.data && S.data.gen) { S.gen = { id: S.data.gen.id, status: 'running', step: S.data.gen.step, log: S.data.gen.log }; genLoop(); }
        return;
      }
      case 'gen-close': {
        const g = S.gen;
        if (g && g.status === 'running') { g.hidden = true; const sh = document.getElementById('gen-sheet'); if (sh) sh.remove(); toast('已在后台继续生成，好了会通知你'); }
        else { S.gen = null; renderGenSheet(); }
        return;
      }
      case 'push-on': await enablePush(); return;
      case 'push-check': {
        const out = document.getElementById('push-check-out');
        if (!out) return;
        el.disabled = true;
        try { await pushCheck(out); } catch (err) { out.insertAdjacentHTML('beforeend', `<div>❌ ${esc(err.message || err)}</div>`); } finally { el.disabled = false; }
        return;
      }
      case 'push-reregister': {
        el.disabled = true;
        try { await reRegisterPush(); } finally { el.disabled = false; }
        return;
      }
      case 'push-test': {
        const r = await api('/api/push/test', { method: 'POST' });
        toast(r.sent ? `已发送到 ${r.sent} 个通道，稍等几秒看看` : `没有可用的推送通道${r.details && r.details.length ? `：${r.details[0]}` : '，请先开启通知或填写 Bark'}`, 4500);
        return;
      }
      case 'city-preset': { const i = $('input[name=city]'); if (i) i.value = el.getAttribute('data-city'); return; }
      case 'nearby-add': { const box = document.getElementById('nearby-list'); if (box) box.insertAdjacentHTML('beforeend', nearbyRow('', '')); return; }
      case 'nearby-del': { const row = el.closest('.nearby-row'); if (row) row.remove(); return; }
      case 'mem-edit': S.editMemory = !S.editMemory; S._keepScroll = true; renderMain(); return;
      case 'mem-refresh': {
        el.disabled = true;
        el.innerHTML = '<span class="spin"></span> 复盘中…';
        try {
          const r = await api('/api/memory/refresh', { method: 'POST' });
          toast(r.updated ? `已复盘${r.issues ? ` ${r.issues} 期反馈` : ''}，记忆已更新 ✨（花费约 ¥${money(r.costCny)}）` : '暂时没有新的反馈需要学习', 3500);
        } finally { await loadTab(true); }
        return;
      }
      case 'note-del': {
        await api('/api/note/delete', { method: 'POST', body: { id: Number(el.getAttribute('data-nid')) } });
        await loadTab(true);
        return;
      }
      case 'diag-test': {
        const out = document.getElementById('diag-out');
        const t = el.getAttribute('data-t');
        if (out) out.innerHTML = '<span class="spin"></span> 测试中…';
        try {
          const r = await api('/api/diag/test', { method: 'POST', body: { target: t } });
          if (out) out.innerHTML = `${r.ok ? '✅' : '❌'} ${esc(r.message || '')}`;
        } catch (err) { if (out) out.innerHTML = `❌ ${esc(err.message)}`; }
        return;
      }
      case 'logout': if (window.confirm('确定退出登录？')) logout('已退出'); return;
      default: return;
    }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.getAttribute('data-form');
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await onSubmit(kind, form);
    } catch (err) {
      toast(err.message || String(err), 4000);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  function val(form, name) { const el = form.querySelector(`[name="${name}"]`); return el ? el.value : ''; }
  function checked(form, name) { const el = form.querySelector(`[name="${name}"]`); return !!(el && el.checked); }

  async function onSubmit(kind, form) {
    if (kind === 'setup') {
      const pw = val(form, 'password');
      if (pw !== val(form, 'password2')) throw new Error('两次输入的密码不一样');
      const n1 = val(form, 'u1').trim(), n2 = val(form, 'u2').trim();
      if (!n1 || !n2) throw new Error('请填写两个人的名字');
      await api('/api/setup', { method: 'POST', body: {
        password: pw, city: val(form, 'city').trim() || '上海',
        users: [{ name: n1 }, { name: n2 }],
        activities: val(form, 'activities').split(/[,，、\n]+/).map((x) => x.trim()).filter(Boolean),
        openaiKey: val(form, 'openaiKey').trim(), deepseekKey: val(form, 'deepseekKey').trim(),
      }, noLogout: true });
      S.pass = pw; store.set('wk_pass', pw);
      S.boot = await api('/api/bootstrap', { noLogout: true });
      toast('初始化完成 🎉');
      renderPickUser();
      return;
    }
    if (kind === 'login') {
      const pw = val(form, 'password');
      await api('/api/login', { method: 'POST', body: { password: pw }, noLogout: true });
      S.pass = pw; store.set('wk_pass', pw);
      if (!S.me || !S.boot.users.some((u) => u.id === S.me)) { renderPickUser(); return; }
      await loadTab();
      syncPushSilently();
      return;
    }
    if (kind === 'comment') {
      const input = form.querySelector('input[name=text]');
      const text = input.value.trim();
      if (!text) return;
      const itemId = Number(form.getAttribute('data-item')) || null;
      const issueId = Number(form.getAttribute('data-issue')) || (S.data && S.data.issue && S.data.issue.id);
      await api('/api/comment', { method: 'POST', body: { itemId, issueId, text } });
      const dk = input.getAttribute('data-draft');
      if (dk) delete S.drafts[dk];
      input.value = '';
      await loadTab(true);
      return;
    }
    if (kind === 'note') {
      const text = val(form, 'text').trim();
      if (!text) return;
      await api('/api/note', { method: 'POST', body: { text } });
      delete S.drafts.note;
      toast('AI 记下了，下次生成清单时会参考 📝');
      await loadTab(true);
      return;
    }
    if (kind === 'memory') {
      let p;
      try { p = JSON.parse(val(form, 'profile')); } catch (e) { throw new Error('JSON 格式不正确'); }
      await api('/api/memory', { method: 'POST', body: { profile: p } });
      S.editMemory = false;
      toast('记忆已保存');
      await loadTab(true);
      return;
    }
    if (kind === 'notify') {
      const bark = {};
      bark[S.me] = val(form, 'bark').trim();
      await api('/api/settings', { method: 'POST', body: { config: {
        push: { weekday: Number(val(form, 'weekday')), time: val(form, 'time'), commentNotify: checked(form, 'commentNotify'), sundayReminder: checked(form, 'sundayReminder') },
        bark,
      } } });
      toast('已保存');
      await loadTab(true);
      return;
    }
    if (kind === 'city') {
      const names = [...form.querySelectorAll('input[name=nb_name]')].map((x) => x.value.trim());
      const hours = [...form.querySelectorAll('input[name=nb_hours]')].map((x) => Number(x.value));
      const nearby = names.map((n, i) => ({ name: n, hours: hours[i] || 2 })).filter((x) => x.name);
      const city = val(form, 'city').trim();
      const cur = S.settings && S.settings.config;
      const cfgPatch = { city };
      const sameList = cur && JSON.stringify(cur.nearby.map((x) => [x.name, x.hours])) === JSON.stringify(nearby.map((x) => [x.name, x.hours]));
      if (!(cur && city !== cur.city && sameList)) cfgPatch.nearby = nearby;
      await api('/api/settings', { method: 'POST', body: { config: cfgPatch } });
      toast('城市设置已保存，下次生成清单时生效');
      S.data = null;
      await loadTab(true);
      return;
    }
    if (kind === 'prefs') {
      const acts = val(form, 'activities').split(/[,，、\n]+/).map((x) => x.trim()).filter(Boolean);
      await api('/api/settings', { method: 'POST', body: { config: {
        counts: { live: Number(val(form, 'live')), personal: Number(val(form, 'personal')) },
        activities: acts,
        users: [{ name: val(form, 'u0').trim() }, { name: val(form, 'u1').trim() }],
      } } });
      S.boot = await api('/api/bootstrap', { noLogout: true });
      S.data = null;
      toast('已保存');
      await loadTab(true);
      return;
    }
    if (kind === 'ai') {
      await api('/api/settings', { method: 'POST', body: {
        keys: { openai: val(form, 'openai').trim(), deepseek: val(form, 'deepseek').trim() },
        config: { models: {
          openaiSearch: val(form, 'openaiSearch').trim(), openaiAgent: val(form, 'openaiAgent').trim(), openaiEffort: val(form, 'openaiEffort'),
          deepseekPlanner: val(form, 'deepseekPlanner').trim(), deepseekExtractor: val(form, 'deepseekExtractor').trim(),
        }, agentWebSearch: checked(form, 'agentWebSearch') },
      } });
      toast('AI 设置已保存');
      S.data = null;
      await loadTab(true);
      return;
    }
    if (kind === 'password') {
      const next = val(form, 'next');
      if (next.length < 6) throw new Error('新密码至少 6 位');
      if (!window.confirm('改密码后，另一位也需要用新密码重新登录。确定吗？')) return;
      await api('/api/settings', { method: 'POST', body: { password: { next } } });
      S.pass = next; store.set('wk_pass', next);
      toast('密码已修改，记得告诉另一位');
      form.reset();
    }
  }

  // ---------------- auto refresh ----------------
  let tick = 0;
  setInterval(() => {
    tick++;
    if (document.visibilityState !== 'visible' || !S.pass || !S.me || S.tab !== 'week' || !S.data) return;
    const generating = S.gen && S.gen.status === 'running' && !S.gen.hidden;
    if (!generating && tick % 4 !== 0) return; // every 20s normally, every 5s while generating
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    loadTab(true);
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.pass && S.me && S.data && S.tab === 'week') {
      loadTab(true);
      try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) { /* ignore */ }
    }
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'open' && ev.data.url) {
        const u = new URL(ev.data.url, location.origin);
        const iid = Number(u.searchParams.get('issue')) || null;
        S.viewIssueId = iid;
        S.tab = 'week';
        loadTab(true);
      }
    });
  }

  boot();
})();

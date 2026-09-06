'use strict';
/* FreeHub 前端逻辑（零依赖原生 JS） */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  q: '', type: '', tier: '', window: '14', sort: 'time', includeExpired: false,
};
let crawlBusy = false;

/* ---------------- 静态模式（GitHub Pages 等纯静态空间） ---------------- */
const STATIC = { enabled: false, items: [], payload: null };
async function detectMode() {
  try {
    const r = await fetch('/api/stats', { signal: AbortSignal.timeout(3000) });
    if (r.ok) return 'server';
  } catch { /* 无后端 → 尝试静态数据 */ }
  try {
    const r = await fetch('data/activities.json', { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      STATIC.payload = await r.json();
      STATIC.items = STATIC.payload.items || [];
      STATIC.enabled = true;
      return 'static';
    }
  } catch { /* 两者都不可用 */ }
  return 'none';
}
function ts(v) { const t = v ? new Date(v).getTime() : 0; return isNaN(t) ? 0 : t; }
function filterLocal() {
  let items = [...STATIC.items];
  const q = state.q.toLowerCase();
  if (q) items = items.filter(a => [a.title, a.summary, a.content_md, a.vendor].some(s => String(s || '').toLowerCase().includes(q)));
  if (state.type) items = items.filter(a => a.type === state.type);
  if (state.tier) items = items.filter(a => a.tier === state.tier);
  if (!state.includeExpired) items = items.filter(a => !a.expired);
  if (state.window !== 'all') {
    const cut = Date.now() - Number(state.window || 14) * 86400000;
    items = items.filter(a => Math.max(ts(a.published_at), ts(a.updated_at), ts(a.first_seen)) >= cut);
  }
  if (state.sort === 'score') items.sort((a, b) => (b.score || 0) - (a.score || 0) || ts(b.first_seen) - ts(a.first_seen));
  else items.sort((a, b) => ts(b.first_seen) - ts(a.first_seen) || (b.score || 0) - (a.score || 0));
  return items;
}

/* ---------------- 工具 ---------------- */
function esc(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u = '') {
  return /^https?:\/\//i.test(u) ? u : '#';
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }); }
  catch { return iso.slice(0, 10); }
}
function daysAgo(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

/* 极简 markdown 渲染（先转义 HTML 再应用语法，防注入） */
function mdToHtml(md = '') {
  const lines = esc(md).split(/\r?\n/);
  const out = [];
  let inList = false;
  const inline = s => s
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.trim();
    const li = line.match(/^(?:[-*]|\d+[.、])\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (!line) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h4>${inline(h[2])}</h4>`); continue; }
    if (/^>/.test(line)) { out.push(`<blockquote style="color:var(--muted);margin:2px 0;">${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    out.push(`<p style="margin:4px 0;">${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const TYPE_LABEL = { signup: '🎁 注册送', daily: '📅 每日打卡', login: '👉 登录即领', limited: '⏳ 限时体验', free: '🆓 长期免费' };
const TIER_LABEL = { gold: '🥇 金蛋', silver: '🥈 银蛋', copper: '🥉 铜蛋' };

/* ---------------- 数据加载 ---------------- */
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadFeed() {
  if (STATIC.enabled) {
    renderFeed(filterLocal(), STATIC.payload.newDays || 7);
    return;
  }
  const p = new URLSearchParams();
  for (const k of ['q', 'type', 'tier', 'sort']) if (state[k]) p.set(k, state[k]);
  p.set('window', state.window);
  if (state.includeExpired) p.set('includeExpired', '1');
  $('#feed').innerHTML = '<div class="loading">⏳ 正在加载活动数据…</div>';
  try {
    const data = await api(`/api/activities?${p}`);
    renderFeed(data.items || [], data.newDays || 7);
  } catch (e) {
    $('#feed').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function loadStats() {
  if (STATIC.enabled) {
    const s = STATIC.payload.stats || {};
    const gen = STATIC.payload.generatedAt ? new Date(STATIC.payload.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
    $('#stats').innerHTML = `
      <span class="stat"><b>${s.active || 0}</b> 进行中</span>
      <span class="stat"><b>${s.new7d || 0}</b> 近7天新增</span>
      <span class="stat"><b>${s.signup || 0}</b> 注册送</span>
      <span class="stat"><b>${s.daily || 0}</b> 每日打卡</span>
      <span class="stat"><b>${s.vendors || 0}</b> 家厂商</span>
      <span class="stat">数据更新 ${esc(gen)}</span>`;
    return;
  }
  try {
    const s = await api('/api/stats');
    const last = s.lastCrawl ? new Date(s.lastCrawl).toLocaleString('zh-CN', { hour12: false }) : '从未';
    $('#stats').innerHTML = `
      <span class="stat"><b>${s.active}</b> 进行中</span>
      <span class="stat"><b>${s.new7d}</b> 近7天新增</span>
      <span class="stat"><b>${s.signup}</b> 注册送</span>
      <span class="stat"><b>${s.daily}</b> 每日打卡</span>
      <span class="stat"><b>${s.vendors}</b> 家厂商</span>
      <span class="stat" title="点击右上角「立即刷新」可手动采集">上次采集 ${esc(last)}</span>`;
  } catch { $('#stats').textContent = '统计加载失败'; }
}

/* ---------------- 渲染 ---------------- */
function cardHtml(a, newDays) {
  const isNew = daysAgo(a.first_seen) <= newDays;
  const badges = [
    `<span class="badge t-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>`,
    `<span class="badge tier tier-${a.tier}" title="福利分 ${a.score}">${TIER_LABEL[a.tier] || ''} ${a.score}</span>`,
    isNew ? '<span class="badge new">NEW</span>' : '',
    a.expired ? '<span class="badge expired">已过期</span>' : '',
    a.duration === 'longterm' ? '<span class="badge src">长期</span>' : '',
    a.region === 'global' ? '<span class="badge src">🌐 国际</span>' : '',
  ].filter(Boolean).join('');
  const expires = a.expires_at ? ` · 截止 ${fmtDate(a.expires_at)}` : '';
  const del = `<button class="btn-del" data-del="${a.id}" title="从列表移除">✕</button>`;
  const details = (a.content_md || a.summary)
    ? `<details class="card-details"><summary>📖 领取方式 / 详情</summary><div class="md">${mdToHtml(a.content_md || a.summary)}</div></details>`
    : '';
  return `
  <article class="card tier-${a.tier} ${a.expired ? 'expired' : ''}">
    <div class="card-top">${badges}<span style="flex:1"></span>${del}</div>
    <h3>${esc(a.title)}</h3>
    ${a.summary && a.summary !== a.content_md ? `<p class="summary">${esc(a.summary)}</p>` : ''}
    <div class="card-meta">
      <span>📅 发现 ${fmtDate(a.first_seen)}</span>
      ${a.published_at ? `<span>发布 ${fmtDate(a.published_at)}</span>` : ''}${expires}
      <span class="badge src">${esc(a.source_name || a.source)}</span>
    </div>
    ${details}
    <div class="card-foot">
      ${a.link && a.link !== '#' ? `<a class="btn-go" href="${safeUrl(a.link)}" target="_blank" rel="noopener">前往领取 ↗</a>` : ''}
    </div>
  </article>`;
}

function renderFeed(items, newDays) {
  if (!items.length) {
    $('#feed').innerHTML = '<div class="empty">🪹 当前筛选条件下没有活动。试试放宽时间窗，或点「立即刷新」采集最新数据。</div>';
    return;
  }
  const groups = new Map();
  for (const a of items) {
    const v = a.vendor || '未知厂商';
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(a);
  }
  let html = '';
  for (const [vendor, acts] of groups) {
    const typeCounts = {};
    for (const a of acts) typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
    const mini = Object.entries(typeCounts).map(([t, n]) =>
      `<span class="badge t-${t}" title="${TYPE_LABEL[t]} ×${n}">${TYPE_LABEL[t].split(' ')[0]}${n > 1 ? ` ×${n}` : ''}</span>`).join(' ');
    html += `
    <section class="vgroup">
      <div class="vgroup-head"><h2>🏢 ${esc(vendor)}</h2><span class="cnt">${acts.length} 个活动</span>${mini}</div>
      <div class="vgrid">${acts.map(a => cardHtml(a, newDays)).join('')}</div>
    </section>`;
  }
  $('#feed').innerHTML = html;
}

/* ---------------- 管理弹窗 ---------------- */
async function renderSources() {
  const data = await api('/api/sources');
  $('#cfg-interval').textContent = `每 ${data.crawlIntervalHours} 小时自动拉取一次`;
  $('#src-list').innerHTML = (data.sources || []).map(s => `
    <div class="src-item">
      <div class="row1">
        <label class="switch" title="${s.enabled ? '点击停用' : '点击启用'}">
          <input type="checkbox" data-toggle="${s.id}" ${s.enabled ? 'checked' : ''}><span></span>
        </label>
        <span class="name">${esc(s.name)}</span>
        <span class="badge src">${esc(s.type)}</span>
        <span style="flex:1"></span>
        ${s.type !== 'freeegg' ? `<button class="btn-del" data-delsrc="${s.id}" title="删除该源">🗑 删除</button>` : ''}
      </div>
      <div class="url">${esc(s.url || '(未配置地址)')}</div>
      ${s.lastStatus ? `<div class="status ${String(s.lastStatus).startsWith('失败') ? 'err' : ''}">最近采集：${esc(s.lastStatus)}</div>` : ''}
    </div>`).join('');
}

function openManage() {
  renderSources().catch(e => toast('加载源失败：' + e.message));
  $('#dlg-manage').showModal();
}

/* ---------------- 事件绑定 ---------------- */
let searchTimer;
$('#f-q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadFeed(); }, 350);
});
function bindChips(id, key) {
  $(id).addEventListener('click', e => {
    const btn = e.target.closest('button.chip');
    if (!btn) return;
    $$(id + ' .chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state[key] = btn.dataset.v;
    loadFeed();
  });
}
bindChips('#f-type', 'type');
bindChips('#f-tier', 'tier');
$('#f-window').addEventListener('change', e => { state.window = e.target.value; loadFeed(); });
$('#f-sort').addEventListener('change', e => { state.sort = e.target.value; loadFeed(); });
$('#f-expired').addEventListener('change', e => { state.includeExpired = e.target.checked; loadFeed(); });

$('#btn-manage').addEventListener('click', openManage);
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.tab-pane').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $(`#tab-${t.dataset.tab}`).classList.add('active');
}));

$('#btn-crawl').addEventListener('click', async () => {
  if (crawlBusy) return;
  crawlBusy = true;
  const btn = $('#btn-crawl');
  btn.disabled = true;
  btn.textContent = '⏳ 采集中…';
  try {
    const r = await api('/api/crawl', { method: 'POST' });
    if (r.skipped) toast('已有采集任务在执行，请稍候');
    else toast(`采集完成：共 ${r.total} 条（${(r.results || []).map(x => `${x.id}:${x.ok ? '✓' : '✗'}`).join(' ')}）`);
    await Promise.all([loadFeed(), loadStats()]);
  } catch (e) {
    toast('采集失败：' + e.message);
  } finally {
    crawlBusy = false;
    btn.disabled = false;
    btn.textContent = '⟳ 立即刷新';
  }
});

/* 弹窗内事件（委托） */
$('#dlg-manage').addEventListener('click', async e => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    try {
      await api(`/api/sources/${encodeURIComponent(toggle.dataset.toggle)}/toggle`, { method: 'POST' });
      await renderSources();
    } catch (err) { toast('操作失败：' + err.message); }
    return;
  }
  const del = e.target.closest('[data-delsrc]');
  if (del) {
    if (!confirm('确定删除该数据源？')) return;
    try {
      await api(`/api/sources/${encodeURIComponent(del.dataset.delsrc)}/delete`, { method: 'POST' });
      await renderSources();
    } catch (err) { toast('删除失败：' + err.message); }
  }
});

$('#form-src').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/sources', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
    e.target.reset();
    toast('数据源已添加');
    await renderSources();
  } catch (err) { toast('添加失败：' + err.message); }
});

$('#form-manual').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);
  if (body.expiresAt) body.expiresAt = new Date(body.expiresAt + 'T23:59:59+08:00').toISOString();
  else delete body.expiresAt;
  try {
    await api('/api/activities/manual', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    $('#dlg-manage').close();
    toast('已收录该活动');
    await Promise.all([loadFeed(), loadStats()]);
  } catch (err) { toast('收录失败：' + err.message); }
});

/* 删除活动（列表内委托） */
$('#feed').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  if (!confirm('从列表中移除该活动？')) return;
  try {
    await api(`/api/activities/${del.dataset.del}`, { method: 'DELETE' });
    loadFeed();
    loadStats();
  } catch (err) { toast('删除失败：' + err.message); }
});

/* ---------------- 启动 ---------------- */
(async () => {
  const mode = await detectMode();
  if (mode === 'static') {
    // 纯静态空间：无后端，隐藏需要 API 的功能
    $('#btn-crawl').style.display = 'none';
    $('#btn-manage').style.display = 'none';
  } else if (mode === 'none') {
    $('#feed').innerHTML = '<div class="empty">暂无数据：请先在本机运行 <code>node server/export.js</code> 生成静态数据，或启动 <code>node server/index.js</code>。</div>';
    return;
  }
  loadFeed();
  loadStats();
})();

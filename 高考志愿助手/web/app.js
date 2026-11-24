/* 高考志愿助手 · 前端逻辑（原生 JS，零依赖） */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('zh-CN');
const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function api(path, params, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const withBody = method === 'POST' || method === 'PUT';
  const query = withBody ? (opts.query || null) : params;
  const url = '/api' + path + (query ? '?' + qs(query) : '');
  const init = { method, credentials: 'same-origin', headers: {} };
  if (withBody) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(params || {});
  }
  const r = await fetch(url, init);
  if (!r.ok) {
    let message = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.message) message = j.message; } catch { /* 保留默认错误 */ }
    throw new Error(message);
  }
  return r.json();
}
let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
const loading = (txt = '加载中…') => `<div class="loading"><div class="spinner"></div>${esc(txt)}</div>`;
const emptyBox = (icon, txt) => `<div class="empty"><span class="big">${icon}</span>${txt}</div>`;
/** 导出用数据快照：只保留版本事实，剥掉质量模块旧版兜底文案中的对外话术。 */
function snapshotForExport(dq) {
  if (dq?.snapshotText) return String(dq.snapshotText);
  if (typeof QualityUI !== 'undefined') {
    // 用 Unicode 转义书写待剥离话术，避免源码中出现对外文案字面量
    return String(QualityUI.csvSnapshot(dq))
      .replace(/[；;。]?\s*\u8bf7\u4ee5\u672c\u7701\u5f53\u5e74[^\u3002\uff1b;]*\u4e3a\u51c6/g, '');
  }
  return '数据版本未标注';
}

/* ---------------- 全局状态 ---------------- */
const S = { dict: null, meta: null, schools: [], wishlist: loadWishlist() };

function loadWishlist() {
  try { return JSON.parse(localStorage.getItem('gk_wishlist') || '[]'); } catch { return []; }
}
function saveWishlist() {
  localStorage.setItem('gk_wishlist', JSON.stringify(S.wishlist));
  const c = $('#w-count'); if (c) c.textContent = S.wishlist.length;
}
function isWished(key) { return S.wishlist.some((x) => x.key === key); }

/** 登录后以服务端列表为准刷新本地镜像，同时保留尚未迁移成功的本地条目。 */
async function loadServerWishlist() {
  if (!window.AuthUI?.isAuthenticated()) return;
  try {
    const r = await api('/wishlist');
    if (!r.ok) return;
    const serverItems = r.items || [];
    const serverKeys = new Set(serverItems.map((x) => x.key));
    S.wishlist = serverItems.concat(S.wishlist.filter((x) => !serverKeys.has(x.key)));
    saveWishlist();
  } catch (e) { console.error('收藏同步失败：', e.message); }
}

/** 登录态双写服务端：本地先更新保证即时反馈，服务端成功后以其返回为准。 */
async function syncWishToServer(item, adding) {
  if (!window.AuthUI?.isAuthenticated()) return;
  try {
    if (adding) {
      const r = await api('/wishlist', item, { method: 'POST' });
      if (r.ok && r.item) {
        const i = S.wishlist.findIndex((x) => x.key === item.key);
        if (i >= 0) S.wishlist[i] = { ...S.wishlist[i], ...r.item };
        saveWishlist();
      }
    } else {
      await api('/wishlist', { key: item.key }, { method: 'DELETE' });
    }
  } catch (e) { toast('收藏同步失败：' + e.message); }
}

function toggleWish(item) {
  const i = S.wishlist.findIndex((x) => x.key === item.key);
  const adding = i < 0;
  if (adding) S.wishlist.push(item); else S.wishlist.splice(i, 1);
  saveWishlist();
  toast(adding ? '已加入志愿表' : '已从志愿表移除');
  renderWishlist();
  $$('.star').forEach((b) => { if (b.dataset.key) b.classList.toggle('on', isWished(b.dataset.key)); });
  syncWishToServer(item, adding);
}

/* ---------------- Tab（通用 [data-tab]，兼容侧边栏入口） ---------------- */
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.auth === '1' && !window.AuthUI?.isAuthenticated()) {
    window.AuthUI?.promptLogin();       // 弹登录提示，不切页
    return;
  }
  $$('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
  if (b.dataset.tab === 'wishlist') renderWishlist();
  if (b.dataset.tab === 'data') renderData();
  if (b.dataset.tab === 'lines') window.LinesUI?.render();
  if (b.dataset.tab === 'rank') window.RankUI?.render();
  if (b.dataset.tab === 'score') window.CollegeUI?.render();
  if (b.dataset.tab === 'history') window.HistoryUI?.render();
  if (b.dataset.tab === 'drafts') window.DraftUI?.render();
}));

/* ---------------- 初始化 ---------------- */
async function init() {
  saveWishlist();
  if (window.AuthUI) {
    await window.AuthUI.init();
    await loadServerWishlist();
  }
  try {
    S.meta = await api('/meta');
  } catch (e) { toast('加载基础信息失败：' + e.message); }

  const provOpts = (S.meta?.provinces || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  for (const id of ['s-province', 'd-province', 'p-province']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">请选择</option>' + provOpts;
  }

  // 默认省份：河北（若存在）
  for (const sel of ['#s-province', '#p-province']) {
    const el = $(sel);
    if (el && [...el.options].some((o) => o.value === '13')) el.value = '13';
  }

  await refreshDict('s');
  await refreshDict('p');
  bindEvents();
  renderWishlist();
  // 通知扩展模块（志愿参考 / 资料库 / AI）可以初始化了
  document.dispatchEvent(new CustomEvent('app-ready'));
}

async function refreshDict(prefix) {
  // v3：旧分数线/推荐页的 s-*/r-* DOM 已删除；缺失时直接返回，
  // 避免真实浏览器中 null.value 抛错中断 init() 与后续事件绑定。
  const pidEl = $(`#${prefix}-province`);
  const typeSel = $(`#${prefix}-type`);
  if (!pidEl || !typeSel) return;
  const pid = pidEl.value;
  const d = await api('/dict', { provinceId: pid || '' });
  const cur = typeSel.value;
  const types = d.types?.length ? d.types : (S.meta?.types || []);
  typeSel.innerHTML = (prefix === 's' ? '<option value="">全部</option>' : '<option value="">请选择</option>')
    + types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if ([...typeSel.options].some((o) => o.value === cur)) typeSel.value = cur;
  else if (prefix !== 's' && types.length) typeSel.value = types[0];

  if (prefix === 's') {
    const ySel = $('#s-year');
    const cy = ySel.value;
    const nowY = new Date().getFullYear();
    const ys = [...new Set([...(d.indexedYears || []), nowY, nowY - 1, nowY - 2])].sort((a, b) => b - a);
    ySel.innerHTML = '<option value="">全部</option>' + ys.map((y) => `<option value="${y}">${y} 年</option>`).join('');
    // 默认选中最近一年，查询更快
    if ([...ySel.options].some((o) => o.value === cy) && cy) ySel.value = cy;
    else ySel.value = String(ys[0]);
  }
}

/* ---------------- 1. 分数线查询 ---------------- */
let schoolTimer;
async function searchSchoolList(q) {
  if (!q) return;
  const r = await api('/schools', { q, size: 20 });
  S.schools = r.items || [];
  $('#school-list').innerHTML = S.schools.map((s) => `<option value="${esc(s.name)}">${esc(s.province)} · ${esc(s.level)}</option>`).join('');
}
function resolveSchool(name) {
  if (!name) return null;
  const n = name.trim();
  return S.schools.find((s) => s.name === n)
    || S.schools.find((s) => s.name.includes(n) || n.includes(s.name))
    || null;
}

async function runScoreQuery() {
  const pid = $('#s-province').value;
  const type = $('#s-type').value;
  const year = $('#s-year').value;
  const schoolName = $('#s-school').value.trim();
  const major = $('#s-major').value.trim();
  const box = $('#s-result');

  if (!pid) return toast('请先选择生源省份');
  if (!schoolName) return toast('请输入院校名称');

  box.innerHTML = loading('正在查询…');
  let school = resolveSchool(schoolName);
  if (!school) {
    const r = await api('/schools', { q: schoolName, size: 5 });
    school = (r.items || [])[0];
    S.schools = r.items || [];
  }
  if (!school) { box.innerHTML = emptyBox('🔍', '未找到该院校，请检查名称'); return; }

  try {
    const [prov, spec] = await Promise.all([
      api('/score/province', { schoolId: school.id, provinceId: pid, year }),
      api('/score/special', { schoolId: school.id, provinceId: pid, year, major, type }),
    ]);
    renderScoreResult(school, { prov, spec }, { pid, type, year, major });
  } catch (e) {
    box.innerHTML = emptyBox('⚠️', '查询失败：' + esc(e.message));
  }
}

function tierTag(s) {
  if (s.f985) return '<span class="tag t985">985</span>';
  if (s.f211) return '<span class="tag t211">211</span>';
  if (s.dual) return `<span class="tag tdual">${esc(s.dual)}</span>`;
  return '';
}

function renderScoreResult(school, { prov, spec }, q) {
  const box = $('#s-result');
  const provItems = (prov.items || []).filter((x) => !q.type || !x.type || x.type.includes(q.type) || q.type.includes(x.type));
  const specItems = (spec.items || []);

  const provRows = provItems.map((x) => `<tr>
      <td>${esc(x.year)}</td><td>${esc(x.type || '—')}</td><td>${esc(x.batch || '—')}</td>
      <td>${esc(x.group || '—')}</td><td>${esc(x.subjectReq || '—')}</td>
      <td class="num">${fmt(x.min)}</td><td class="num">${fmt(x.minRank)}</td>
      <td class="num">${fmt(x.batchLine)}</td>
      <td class="num">${x.min && x.batchLine ? (x.min - x.batchLine) : '—'}</td>
      <td><button class="star ${isWished('p_' + school.id + '_' + x.year + '_' + (x.group || '')) ? 'on' : ''}"
          data-key="p_${school.id}_${x.year}_${esc(x.group || '')}" title="加入志愿表">☆</button></td>
    </tr>`).join('');

  const majorList = specItems.filter((x) => !q.type || !x.type || x.type.includes(q.type) || q.type.includes(x.type));
  const specRows = majorList.slice(0, 300).map((x) => `<tr>
      <td>${esc(x.year)}</td><td>${esc(x.major || '—')}</td>
      <td>${esc(x.category || '')}${x.className ? ' / ' + esc(x.className) : ''}</td>
      <td>${esc(x.subjectReq || '—')}</td>
      <td class="num">${fmt(x.min)}</td><td class="num">${fmt(x.minRank)}</td>
      <td class="num">${fmt(x.batchLine)}</td>
      <td title="${esc(x.remark || '')}">${esc((x.remark || '').slice(0, 22))}${(x.remark || '').length > 22 ? '…' : ''}</td>
      <td><button class="star ${isWished('s_' + school.id + '_' + x.year + '_' + x.major) ? 'on' : ''}"
          data-key="s_${school.id}_${x.year}_${esc(x.major)}" title="加入志愿表">☆</button></td>
    </tr>`).join('');

  box.innerHTML = `
  <div class="card score-shell">
    <div class="filters" style="align-items:center">
      <h2 class="h2">${esc(school.name)} ${tierTag(school)}</h2>
      <span class="tag tpub">${esc(school.nature || '')}</span>
      <span class="tag">${esc(school.province || '')} · ${esc(school.city || '')}</span>
      <span class="tag">${esc(school.level || '')} · ${esc(school.type || '')}</span>
      <div class="spacer"></div>
      <a class="btn sm" href="https://www.gaokao.cn/school/${school.id}" target="_blank" rel="noopener">掌上高考 ↗</a>
      <button class="btn sm" id="s-trend">查看历年趋势</button>
    </div>
    <div class="score-tabs" style="margin-top:12px">
      <button class="score-tab active" id="score-tab-prov" type="button">录取分数线</button>
      <button class="score-tab" id="score-tab-spec" type="button">专业分数线</button>
    </div>

    <div class="score-section" data-score-section="prov">
      <h2 class="h2" style="margin-top:12px">录取分数线 <span class="score-sub">院校专业组投档线</span> <span class="pill">${provItems.length}</span>
        ${prov.local ? '<span class="pill" style="background:#dcfce7;color:#166534">本地数据</span>' : '<span class="pill" style="background:#ffedd5;color:#c2410c">联网数据</span>'}</h2>
      ${prov.warning ? `<div class="hint" style="color:#b45309">⚠ ${esc(prov.warning)}</div>` : ''}
      ${provItems.length ? `<div class="tablewrap" style="margin-top:10px"><table>
        <thead><tr><th>年份</th><th>科类</th><th>批次</th><th>专业组</th><th>选科要求</th>
        <th>最低分</th><th>最低位次</th><th>省控线</th><th>线差</th><th>收藏</th></tr></thead>
        <tbody>${provRows}</tbody></table></div>`
        : emptyBox('📭', '暂无该校在本省的投档线数据（可切换年份或省份再试）')}
    </div>

    <div class="score-section" data-score-section="spec" hidden>
      <h2 class="h2" style="margin-top:12px">专业分数线 <span class="score-sub">专业录取分数线</span> <span class="pill">${majorList.length}</span>
        <span class="pill" style="background:#ffedd5;color:#c2410c">实时获取</span></h2>
      ${spec.warning ? `<div class="hint" style="color:#b45309">⚠ ${esc(spec.warning)}</div>` : ''}
      ${majorList.length ? `<div class="tablewrap" style="margin-top:10px"><table>
        <thead><tr><th>年份</th><th>专业</th><th>门类 / 专业类</th><th>选科要求</th>
        <th>最低分</th><th>最低位次</th><th>省控线</th><th>备注</th><th>收藏</th></tr></thead>
        <tbody>${specRows}</tbody></table></div>
        ${majorList.length >= 300 ? '<div class="hint">仅显示前 300 条</div>' : ''}`
        : emptyBox('📭', q.major ? `未找到包含「${esc(q.major)}」的专业记录` : '暂无专业分数线数据')}
    </div>
  </div>

  <div class="card" id="trend-card" style="display:none"></div>`;

  const switchScoreSection = (which) => {
    $$('#score-tab-prov, #score-tab-spec').forEach((t) => t.classList.toggle('active', t.id === 'score-tab-' + which));
    $$('#s-result .score-section').forEach((s) => { s.hidden = s.dataset.scoreSection !== which; });
    const trend = $('#trend-card');
    if (trend) trend.style.display = 'none';
  };
  $('#score-tab-prov')?.addEventListener('click', () => switchScoreSection('prov'));
  $('#score-tab-spec')?.addEventListener('click', () => switchScoreSection('spec'));

  $$('#s-result .star').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.key;
    let item;
    if (key.startsWith('p_')) {
      const [, sid, year, group] = key.split('_');
      item = { key, type: '投档线', school: school.name, schoolId: Number(sid), year: Number(year), extra: group || '' };
    } else {
      const parts = key.split('_');
      item = { key, type: '专业线', school: school.name, schoolId: Number(parts[1]), year: Number(parts[2]), extra: parts.slice(3).join('_') };
    }
    toggleWish(item);
    b.classList.toggle('on', isWished(key));
  }));

  $('#s-trend')?.addEventListener('click', () => loadTrend(school, q));
}

async function loadTrend(school, q) {
  const card = $('#trend-card');
  card.style.display = 'block';
  card.innerHTML = loading('正在获取历年趋势…');
  try {
    const r = await api('/score/trend', { schoolId: school.id, provinceId: q.pid, major: q.major });
    const series = (r.series || []).filter((x) => x.min);
    if (!series.length) { card.innerHTML = emptyBox('📈', '暂无趋势数据'); return; }
    card.innerHTML = `<h2 class="h2">历年录取趋势 · ${esc(school.name)}</h2>
      <div style="margin-top:10px">${lineChart(series)}</div>
      <div class="legend">实线＝该年录取最低分区间（最低~最高），虚线＝省控线。位次见表格。</div>`;
  } catch (e) { card.innerHTML = emptyBox('⚠️', '获取失败：' + esc(e.message)); }
}

/* 纯 SVG 折线/区间图 */
function lineChart(series) {
  const W = 900, H = 230, PL = 52, PR = 18, PT = 16, PB = 30;
  const xs = series.map((s) => s.year);
  const allV = series.flatMap((s) => [s.min, s.max, s.batchLine].filter((v) => v > 0));
  const lo = Math.min(...allV) - 8, hi = Math.max(...allV) + 8;
  const x = (y) => PL + (xs.length === 1 ? (W - PL - PR) / 2 : ((y - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - PL - PR));
  const y = (v) => PT + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - PT - PB);

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4;
    g += `<line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}" stroke="#eef2f7"/>`;
    g += `<text x="${PL - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" fill="#94a3b8" text-anchor="end">${Math.round(v)}</text>`;
  }
  const pts = series.map((s) => `${x(s.year).toFixed(1)},${y(s.min).toFixed(1)}`).join(' ');
  let bars = '';
  for (const s of series) {
    if (s.max && s.min) {
      bars += `<line x1="${x(s.year).toFixed(1)}" y1="${y(s.max).toFixed(1)}" x2="${x(s.year).toFixed(1)}" y2="${y(s.min).toFixed(1)}" stroke="#bfdbfe" stroke-width="10" stroke-linecap="round"/>`;
    }
  }
  const dots = series.map((s) => `<circle cx="${x(s.year).toFixed(1)}" cy="${y(s.min).toFixed(1)}" r="4" fill="#2563eb"/>`).join('');
  const bl = series.filter((s) => s.batchLine).map((s) => `${x(s.year).toFixed(1)},${y(s.batchLine).toFixed(1)}`).join(' ');
  const labels = series.map((s) => `<text x="${x(s.year).toFixed(1)}" y="${H - 8}" font-size="11.5" fill="#64748b" text-anchor="middle">${s.year}</text>`).join('');
  const vals = series.map((s) => `<text x="${x(s.year).toFixed(1)}" y="${(y(s.min) - 10).toFixed(1)}" font-size="11.5" fill="#1d4ed8" text-anchor="middle" font-weight="600">${s.min}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${g}${bars}
    ${bl ? `<polyline points="${bl}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 5"/>` : ''}
    <polyline points="${pts}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}${labels}${vals}
  </svg>`;
}

/* ---------------- 2. 大学环境 ---------------- */
async function runCampusSearch() {
  const q = $('#c-q').value.trim();
  const box = $('#c-result');
  box.innerHTML = loading('搜索中…');
  try {
    const r = await api('/colleges', { q, size: 60 });
    const list = r.items || [];
    if (!list.length) { box.innerHTML = emptyBox('🏫', '未找到相关院校的问卷数据'); return; }
    box.innerHTML = `<div class="card"><h2 class="h2">院校列表 <span class="pill">${list.length}</span></h2>
      <div class="cards" style="margin-top:12px">
      ${list.map((s) => `<div class="ccard" data-name="${esc(s.name)}">
        <div class="n">${esc(s.name)}</div>
        <div class="m">${esc(s.province || '')} · 有效问卷 ${s.resp} 份</div>
      </div>`).join('')}</div></div><div id="c-detail"></div>`;
    $$('#c-result .ccard').forEach((c) => c.addEventListener('click', () => showCampus(c.dataset.name)));
    if (q) showCampus(list[0].name);
  } catch (e) { box.innerHTML = emptyBox('⚠️', '搜索失败：' + esc(e.message)); }
}

async function showCampus(name) {
  const box = $('#c-detail') || $('#c-result');
  box.innerHTML = loading('加载中…');
  try {
    const r = await api('/colleges/detail', { school: name });
    if (!r.ok) { box.innerHTML = emptyBox('📭', esc(r.message || '暂无数据')); return; }
    const d = r.detail;
    const groups = (d.groups || []).filter((g) => g.items.length);
    const g2 = (d.groupsV2 || []).filter((g) => g.items.length);
    box.innerHTML = `
    <div class="card">
      <div class="filters" style="align-items:center">
        <h2 class="h2">${esc(d.name)} · 大学生活质量</h2>
        <span class="tag tpub">${esc(d.province || '')}</span>
        <span class="pill">${d.resp} 份问卷</span>
        <div class="spacer"></div>
        <a class="btn sm primary" href="${esc(d.url)}" target="_blank" rel="noopener">在 colleges.chat 查看原文 ↗</a>
      </div>
      <div class="hint">以下内容为在校生匿名问卷回答的聚合，同一问题按回答频次排序。</div>
    </div>
    ${groups.length ? `<div class="card"><h2 class="h2">住宿与生活（${groups.length} 个问题）</h2><div style="margin-top:10px">
      ${groups.map((x) => `<details class="qgroup" ${['宿舍', '教室'].some((k) => x.q.includes(k)) ? 'open' : ''}>
        <summary>${esc(x.q)}</summary>
        <div class="answers">${x.items.map(([a, c]) => `<div class="ans"><span class="cnt">${c}</span><span>${esc(a)}</span></div>`).join('')}</div>
      </details>`).join('')}</div></div>` : ''}
    ${g2.length ? `<div class="card"><h2 class="h2">2026 版问卷补充（${g2.length} 个问题）</h2><div style="margin-top:10px">
      ${g2.map((x) => `<details class="qgroup"><summary>${esc(x.q)}</summary>
        <div class="answers">${x.items.map(([a, c]) => `<div class="ans"><span class="cnt">${c}</span><span>${esc(a)}</span></div>`).join('')}</div>
      </details>`).join('')}</div></div>` : ''}
    ${(d.extra || []).length ? `<div class="card"><h2 class="h2">自由补充</h2><div style="margin-top:10px">
      ${d.extra.map((t) => `<div class="answers" style="padding:8px 0;border-bottom:1px solid var(--line)">${esc(t)}</div>`).join('')}</div></div>` : ''}`;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { box.innerHTML = emptyBox('⚠️', '加载失败：' + esc(e.message)); }
}

/* ---------------- 4. 我的志愿 ---------------- */
function renderWishlist() {
  const box = $('#w-result');
  if (!box) return;
  const list = S.wishlist;
  $('#w-count').textContent = list.length;
  if (!list.length) { box.innerHTML = emptyBox('📋', '志愿表还是空的，去查询页把心仪院校加进来吧'); return; }
  box.innerHTML = `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th>#</th><th>类型</th><th>院校</th><th>年份</th><th>专业 / 专业组</th><th>操作</th></tr></thead>
    <tbody>${list.map((x, i) => `<tr>
      <td>${i + 1}</td><td>${esc(x.type)}</td>
      <td><a href="https://www.gaokao.cn/school/${x.schoolId}" target="_blank" rel="noopener">${esc(x.school)}</a></td>
      <td>${esc(x.year || '')}</td><td>${esc(x.extra || x.major || '')}</td>
      <td><button class="btn sm danger" data-del="${esc(x.key)}">移除</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('#w-result [data-del]').forEach((b) => b.addEventListener('click', () => {
    const item = S.wishlist.find((x) => x.key === b.dataset.del);
    if (item) toggleWish(item);
  }));
}

function exportWishlist() {
  if (!S.wishlist.length) return toast('志愿表为空');
  // 导出的纸质/电子结果必须自带数据快照，脱离本工具后仍可判断时效性
  const snap = S.meta?.dataVersion
    ? `数据版本 ${S.meta.dataVersion}`
    : snapshotForExport(null);
  const rows = [['# 数据快照', snap], ['序号', '类型', '院校', '院校ID', '年份', '专业/专业组']];
  S.wishlist.forEach((x, i) => rows.push([i + 1, x.type, x.school, x.schoolId, x.year || '', x.extra || '']));
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `我的志愿表_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- 5. 数据管理 ---------------- */
let dataTimer;
async function renderData() {
  const box = $('#d-result');
  box.innerHTML = loading('读取状态…');
  try {
    const r = await api('/status');
    const ds = r.dataSource || { kind: 'legacy-json' };
    const idx = r.indexer || {};
    const up = r.upstream || {};
    const main = ds.kind === 'sqlite' ? dataSourceCard(ds) : legacyCard(r.coverage || {});
    box.innerHTML = main + syncCard(idx) + upstreamCard(up);
    $('#d-auto')?.addEventListener('click', renderData);
  } catch (e) { box.innerHTML = emptyBox('⚠️', '读取失败：' + esc(e.message)); }
}

/** 新数据源（SQLite）总览 */
function dataSourceCard(ds) {
  const mb = (n) => (n / 1024 / 1024).toFixed(0);
  const gz = Math.round(ds.bytes / 4.6 / 1024 / 1024);   // brotli 后大致体积，仅作提示
  const yMin = ds.years?.min, yMax = ds.years?.max;
  const tbl = (ds.tables || []).map((t) => `<tr>
      <td><b>${esc(t.label)}</b></td>
      <td class="num">${fmt(t.rows)}</td>
      <td class="hint" style="margin:0">${esc(t.desc || '')}</td></tr>`).join('');

  const years = ds.byYear || [];
  const yearRows = years.map((y) => `<tr>
      <td><b>${y.year}</b></td>
      <td class="num">${y.score_range ? `${y.score_rangeProvinces || 0} 省 / ${fmt(y.score_range)} 行` : '—'}</td>
      <td class="num">${y.school_adm ? `${y.school_admProvinces || 0} 省 / ${fmt(y.school_adm)} 行` : '—'}</td>
      <td class="num">${y.major_adm ? fmt(y.major_adm) : '—'}</td>
      <td class="num">${y.plan_code ? fmt(y.plan_code) : '—'}</td>
      <td class="num">${y.school_code ? fmt(y.school_code) : '—'}</td></tr>`).join('');

  // 省份覆盖：逐省展示当年四态，禁止用 has2026 布尔 OR 渲染绿色「有 2026」
  const provRows = (ds.provinces || []).map((p) => {
    const cell = (y) => (y ? `<b>${y}</b>` : '<span class="hint" style="margin:0">—</span>');
    const chip = (typeof QualityUI !== 'undefined')
      ? QualityUI.stateChip(p)
      : (p.has2026 ? '<span class="tag tpub">有 2026</span>' : '<span class="hint" style="margin:0">—</span>');
    return `<tr>
      <td>${esc(p.name)}</td>
      <td>${cell(p.latestRank)}</td>
      <td>${cell(p.latestAdm)}</td>
      <td>${cell(p.latestMajor)}</td>
      <td>${chip}</td></tr>`;
  }).join('');
  const full2026 = (ds.provinces || []).filter((p) => p.has2026).length;
  const partial2026 = (ds.provinces || []).filter((p) => p.has2026Partial).length;

  return `
  <div class="card">
    <div class="filters" style="align-items:center">
      <h2 class="h2">数据源</h2>
      <span class="tag tpub">SQLite 单文件（内置 node:sqlite，离线可用）</span>
      <div class="spacer"></div>
      <button class="btn sm" id="d-auto">刷新</button>
    </div>
    <div class="statgrid" style="margin-top:12px">
      <div class="stat"><div class="k">数据库大小</div><div class="v">${mb(ds.bytes)}<span style="font-size:12px"> MB</span></div></div>
      <div class="stat"><div class="k">随包压缩版</div><div class="v">≈${gz}<span style="font-size:12px"> MB</span></div></div>
      <div class="stat"><div class="k">年份范围</div><div class="v" style="font-size:20px">${yMin}–${yMax}</div></div>
      <div class="stat"><div class="k">院校</div><div class="v">${fmt(ds.schoolCount)}</div></div>
      <div class="stat"><div class="k">当年完整省</div><div class="v">${full2026}<span style="font-size:12px"> / 31</span></div></div>
      <div class="stat"><div class="k">当年部分/抽样省</div><div class="v">${partial2026}<span style="font-size:12px"> / 31</span></div></div>
    </div>
    <div class="hint">数据来自 <b>GaokaoCompass</b>（历史库）与<b>各省官方发布 / 后台补抓</b>（当年增量），
      已统一为同一套表结构。当年数据仅部分省份、部分表已发布，抽样行标 ◐ 且默认不参与推荐算法。</div>
  </div>

  <div class="card">
    <h2 class="h2">各表记录数</h2>
    <div class="tablewrap" style="margin-top:10px"><table>
      <thead><tr><th>表</th><th>行数</th><th>用途</th></tr></thead>
      <tbody>${tbl}</tbody></table></div>
  </div>

  <div class="card">
    <h2 class="h2">逐年覆盖</h2>
    <div class="tablewrap" style="margin-top:10px;max-height:420px;overflow-y:auto"><table>
      <thead><tr><th>年份</th><th>一分一段</th><th>院校投档线</th><th>专业录取分</th><th>招生计划</th><th>院校代码</th></tr></thead>
      <tbody>${yearRows}</tbody></table></div>
    <div class="hint">不同省份、年份、表的覆盖并不一致，缺口按 ● / ◐ / — / ⓘ 四态如实标注；「年份范围」不代表每省每年每表都有数据。</div>
  </div>

  <div class="card">
    <h2 class="h2">省份覆盖（各表最新年份） <span class="pill">${(ds.provinces || []).length} 省</span></h2>
    <div class="tablewrap" style="margin-top:10px;max-height:520px;overflow-y:auto"><table>
      <thead><tr><th>省份</th><th>一分一段</th><th>投档线</th><th>专业录取分</th><th>当年数据四态</th></tr></thead>
      <tbody>${provRows}</tbody></table></div>
    <div class="hint">想补某省某年缺失数据，可在下方「后台补抓」里按需同步（会并入本地索引，不影响已有数据）。</div>
  </div>`;
}

/** 旧数据源（JSON 索引）总览，仅在缺少 gaokao.db 时显示 */
function legacyCard(cov) {
  const years = Object.keys(cov).sort((a, b) => b - a);
  return `
  <div class="card">
    <div class="filters" style="align-items:center">
      <h2 class="h2">本地索引覆盖</h2>
      <span class="tag" style="background:#fef3c7;color:#92400e">未找到 gaokao.db，回退到旧版 JSON 索引</span>
      <div class="spacer"></div>
      <button class="btn sm" id="d-auto">刷新</button>
    </div>
    ${years.length ? `<div class="tablewrap" style="margin-top:10px"><table>
      <thead><tr><th>年份</th><th>已建省份</th><th>完整</th><th>记录数</th><th>覆盖度</th></tr></thead>
      <tbody>${years.map((y) => {
        const c = cov[y]; const pct = Math.round(c.provinces / 31 * 100);
        return `<tr><td><b>${y}</b></td><td>${c.provinces} / 31</td><td>${c.complete}</td>
          <td class="num">${fmt(c.rows)}</td>
          <td style="min-width:180px"><div class="bar"><i style="width:${pct}%"></i></div>
          <span class="hint" style="margin:0">${pct}%</span></td></tr>`;
      }).join('')}</tbody></table></div>`
      : '<div class="hint">尚无任何本地索引。把 gaokao.db.gz 放回 data 目录即可启用新数据源。</div>'}
  </div>`;
}

/** 后台补抓任务 */
function syncCard(idx) {
  return `
  <div class="card">
    <div class="filters" style="align-items:center">
      <h2 class="h2">后台补抓任务</h2>
      <span class="pill">${idx.running ? '运行中' : '空闲'}</span>
      <span class="tag">队列 ${idx.queueLen ?? 0}</span>
      <span class="tag">已完成 ${idx.doneCount ?? 0}</span>
    </div>
    ${idx.current ? `<div class="hint">正在抓取：<b>${esc(idx.current.province)} ${idx.current.year}</b>
      — ${fmt(idx.current.fetched)} / ${fmt(idx.current.total)} 条</div>
      <div class="bar"><i style="width:${idx.current.total ? Math.round(idx.current.fetched / idx.current.total * 100) : 0}%"></i></div>` : ''}
    ${idx.queueLen ? `<div class="hint">待处理：${(idx.queue || []).slice(0, 24).map((x) => esc(x.province) + x.year).join('、')}${idx.queueLen > 24 ? ' …' : ''}</div>` : ''}
    ${idx.recentDone?.length ? `<div class="hint">最近完成：${idx.recentDone.map((x) => `${esc(x.province)}${x.year}(${fmt(x.rows)}条${x.complete ? '' : '⚠'})`).join('、')}</div>` : ''}
    ${idx.errors?.length ? `<div class="hint" style="color:#b45309">失败记录：${idx.errors.map((x) => `${esc(x.province)}${x.year}`).join('、')}（稍后会自动重试）</div>` : ''}
    <div class="hint">内置数据已覆盖 31 省 2017–2025，通常无需手动同步；这里用于补齐个别缺失的省份/年份。</div>
  </div>`;
}

/** 上游接口状态 */
function upstreamCard(up) {
  return `
  <div class="card">
    <h2 class="h2">上游接口状态</h2>
    <div class="statgrid" style="margin-top:10px">
      <div class="stat"><div class="k">当前间隔</div><div class="v">${up.interval ?? '—'}<span style="font-size:12px">ms</span></div></div>
      <div class="stat"><div class="k">总请求</div><div class="v">${fmt(up.req)}</div></div>
      <div class="stat"><div class="k">成功</div><div class="v">${fmt(up.ok)}</div></div>
      <div class="stat"><div class="k">被限流</div><div class="v">${fmt(up.limited)}</div></div>
      <div class="stat"><div class="k">异常</div><div class="v">${fmt(up.bad)}</div></div>
    </div>
    <div class="hint">出现「被限流」时程序会自动降速并等待，属正常保护行为，不影响已抓取的数据。</div>
  </div>`;
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  // v3：旧「分数线查询」与「智能推荐」页入口已从 DOM 移除，
  // 其 s-* / r-* 绑定必须一并删除，否则 null.addEventListener 会中断后续全部绑定。
  $('#c-search').addEventListener('click', runCampusSearch);
  $('#c-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCampusSearch(); });

  $('#w-export').addEventListener('click', exportWishlist);
  $('#w-print').addEventListener('click', () => window.print());
  $('#w-clear').addEventListener('click', async () => {
    if (!S.wishlist.length) return;
    if (!confirm('确定清空志愿表？')) return;
    S.wishlist = []; saveWishlist(); renderWishlist(); toast('已清空');
    if (window.AuthUI?.isAuthenticated()) {
      try { await api('/wishlist/clear', {}, { method: 'POST' }); }
      catch (e) { toast('服务端清空失败：' + e.message); }
    }
  });

  $('#d-refresh').addEventListener('click', renderData);
  $('#d-sync-one').addEventListener('click', async () => {
    const pid = $('#d-province').value;
    if (!pid) return toast('请先选择省份');
    const year = $('#d-year').value || new Date().getFullYear();
    const r = await api('/sync', { provinces: pid, year, priority: 1 });
    toast(r.enqueued ? '已加入同步队列，后台限速抓取中' : '该省份该年份已在队列中或已完成');
    setTimeout(renderData, 600);
  });
  $('#d-sync-all').addEventListener('click', async () => {
    if (!confirm('将为最近三年、全部省份排队抓取数据（后台限速、耗时较长，可随时关闭程序）。确定继续？')) return;
    const r = await api('/sync', { all: 1 });
    toast(`已排入 ${r.enqueued} 个任务，后台限速抓取中`);
    setTimeout(renderData, 600);
  });
}

init();

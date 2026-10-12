/* 高考志愿助手 · 前端逻辑（原生 JS，零依赖） */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('zh-CN');
const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function api(path, params) {
  const url = '/api' + path + (params ? '?' + qs(params) : '');
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
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
function toggleWish(item) {
  const i = S.wishlist.findIndex((x) => x.key === item.key);
  if (i >= 0) S.wishlist.splice(i, 1); else S.wishlist.push(item);
  saveWishlist();
  toast(i >= 0 ? '已从志愿表移除' : '已加入志愿表');
  renderWishlist();
  $$('.star').forEach((b) => { if (b.dataset.key) b.classList.toggle('on', isWished(b.dataset.key)); });
}

/* ---------------- Tab ---------------- */
$$('#tabs .tab').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
  if (b.dataset.tab === 'wishlist') renderWishlist();
  if (b.dataset.tab === 'data') renderData();
}));

/* ---------------- 初始化 ---------------- */
async function init() {
  saveWishlist();
  try {
    S.meta = await api('/meta');
    $('#s-hint').innerHTML = `本地院校库 <b>${fmt(S.meta.schoolCount)}</b> 所，
      大学环境数据 <b>${fmt(S.meta.collegeCount)}</b> 所，
      已建分数线索引 <b>${S.meta.indexFiles}</b> 个省-年。
      数据来源：掌上高考 / colleges.chat。`;
  } catch (e) { toast('加载基础信息失败：' + e.message); }

  const provOpts = (S.meta?.provinces || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#s-province').innerHTML = '<option value="">请选择</option>' + provOpts;
  $('#r-province').innerHTML = '<option value="">请选择</option>' + provOpts;
  $('#d-province').innerHTML = '<option value="">请选择</option>' + provOpts;

  // 默认省份：广东（若存在）
  for (const sel of ['#s-province', '#r-province']) {
    const el = $(sel);
    if ([...el.options].some((o) => o.value === '44')) el.value = '44';
  }

  await refreshDict('s');
  await refreshDict('r');
  bindEvents();
  renderWishlist();
}

async function refreshDict(prefix) {
  const pid = $(`#${prefix}-province`).value;
  const d = await api('/dict', { provinceId: pid || '' });
  const typeSel = $(`#${prefix}-type`);
  const cur = typeSel.value;
  const types = d.types?.length ? d.types : (S.meta?.types || []);
  typeSel.innerHTML = (prefix === 'r' ? '<option value="">请选择</option>' : '<option value="">全部</option>')
    + types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if ([...typeSel.options].some((o) => o.value === cur)) typeSel.value = cur;

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
  <div class="card">
    <div class="filters" style="align-items:center">
      <h2 class="h2">${esc(school.name)} ${tierTag(school)}</h2>
      <span class="tag tpub">${esc(school.nature || '')}</span>
      <span class="tag">${esc(school.province || '')} · ${esc(school.city || '')}</span>
      <span class="tag">${esc(school.level || '')} · ${esc(school.type || '')}</span>
      <div class="spacer"></div>
      <a class="btn sm" href="https://www.gaokao.cn/school/${school.id}" target="_blank" rel="noopener">掌上高考 ↗</a>
      <button class="btn sm" id="s-trend">查看历年趋势</button>
    </div>
  </div>

  <div class="card">
    <h2 class="h2">院校专业组投档线 <span class="pill">${provItems.length}</span>
      ${prov.local ? '<span class="pill" style="background:#dcfce7;color:#166534">本地数据</span>' : '<span class="pill" style="background:#ffedd5;color:#c2410c">联网数据</span>'}</h2>
    ${prov.warning ? `<div class="hint" style="color:#b45309">⚠ ${esc(prov.warning)}</div>` : ''}
    ${provItems.length ? `<div class="tablewrap" style="margin-top:10px"><table>
      <thead><tr><th>年份</th><th>科类</th><th>批次</th><th>专业组</th><th>选科要求</th>
      <th>最低分</th><th>最低位次</th><th>省控线</th><th>线差</th><th>收藏</th></tr></thead>
      <tbody>${provRows}</tbody></table></div>`
      : emptyBox('📭', '暂无该校在本省的投档线数据（可切换年份或省份再试）')}
  </div>

  <div class="card">
    <h2 class="h2">专业录取分数线 <span class="pill">${majorList.length}</span>
      <span class="pill" style="background:#ffedd5;color:#c2410c">实时获取</span></h2>
    ${spec.warning ? `<div class="hint" style="color:#b45309">⚠ ${esc(spec.warning)}</div>` : ''}
    ${majorList.length ? `<div class="tablewrap" style="margin-top:10px"><table>
      <thead><tr><th>年份</th><th>专业</th><th>门类 / 专业类</th><th>选科要求</th>
      <th>最低分</th><th>最低位次</th><th>省控线</th><th>备注</th><th>收藏</th></tr></thead>
      <tbody>${specRows}</tbody></table></div>
      ${majorList.length >= 300 ? '<div class="hint">仅显示前 300 条</div>' : ''}`
      : emptyBox('📭', q.major ? `未找到包含「${esc(q.major)}」的专业记录` : '暂无专业分数线数据')}
  </div>

  <div class="card" id="trend-card" style="display:none"></div>`;

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
    ${g.length ? `<div class="card"><h2 class="h2">住宿与生活（${g.length} 个问题）</h2><div style="margin-top:10px">
      ${g.map((x) => `<details class="qgroup" ${['宿舍','教室'].some((k) => x.q.includes(k)) ? 'open' : ''}>
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

/* ---------------- 3. 智能推荐 ---------------- */
async function runRecommend() {
  const pid = $('#r-province').value;
  const type = $('#r-type').value;
  const mode = $('#r-mode').value;
  const score = $('#r-score').value;
  const rank = $('#r-rank').value;
  const major = $('#r-major').value.trim();
  const box = $('#r-result');

  if (!pid) return toast('请选择生源省份');
  if (!type) return toast('请选择科类');
  if (mode === 'score' && !score) return toast('请输入分数');
  if (mode === 'rank' && !rank) return toast('请输入位次');

  box.innerHTML = loading('正在计算冲稳保…（首次查询某省份可能需要数十秒联网获取）');
  try {
    const r = await api('/recommend', {
      provinceId: pid, type, major,
      score: mode === 'score' ? score : '', rank: mode === 'rank' ? rank : '', limit: 60,
    });
    if (!r.ok) { box.innerHTML = emptyBox('⚠️', esc(r.message)) + syncHint(pid); return; }
    renderRecommend(r, { pid, type, major });
  } catch (e) {
    box.innerHTML = emptyBox('⚠️', '推荐失败：' + esc(e.message));
  }
}
function syncHint(pid) {
  return `<div class="card"><div class="hint">该省份暂无本地索引。可点击右侧按钮加入后台同步队列，
    或切换到已有数据的省份体验。</div>
    <div style="margin-top:10px"><button class="btn primary" onclick="syncProvince(${pid})">立即同步该省数据</button></div></div>`;
}
window.syncProvince = async (pid) => {
  const y = new Date().getFullYear();
  const r = await api('/sync', { provinces: pid, year: y, priority: 1 });
  toast(r.enqueued ? '已加入同步队列，请稍后在「数据管理」查看进度' : '该省份数据已在队列中或已完成');
};

function renderRecommend(r, q) {
  const box = $('#r-result');
  const meta = r.meta;
  const bing = meta.mode === 'rank';
  const tierDef = [['chong', '冲'], ['wen', '稳'], ['bao', '保']];
  const total = (r.counts.chong + r.counts.wen + r.counts.bao);
  const mm = r.majorMatches || {};
  box.innerHTML = `
  <div class="card">
    <div class="filters" style="align-items:center">
      <h2 class="h2">推荐结果</h2>
      <span class="tag">${esc(meta.province)} · ${esc(meta.type)}</span>
      ${bing
        ? `<span class="tag">你的位次 <b>${fmt(meta.userRank)}</b></span>`
        : `<span class="tag">你的分数 <b>${fmt(meta.userScore)}</b></span>
           <span class="tag">本科省控线 <b>${fmt(meta.baseLine)}</b></span>
           <span class="tag">你的线差 <b>${meta.userDiff > 0 ? '+' : ''}${meta.userDiff}</b></span>`}
      <span class="tag">参考年份 ${meta.refYears.join(' / ')}</span>
      <span class="tag">候选 ${fmt(meta.candidates)}</span>
      <div class="spacer"></div>
      <button class="btn sm" id="r-print">打印</button>
    </div>
    <div class="hint">
      共匹配到 <b>${fmt(total)}</b> 个招生单元：冲 ${r.counts.chong} / 稳 ${r.counts.wen} / 保 ${r.counts.bao}；
      批次范围：<b>${esc(meta.batch)}</b>。
      定位方式：<b>${bing ? '位次法' : '线差法（分数 − 省控线）'}</b>。
      ${bing ? '' : '线差法不受试卷难度与省控线波动影响，是分数未知位次时的稳健做法。'}
    </div>
    ${meta.notice ? `<div class="hint" style="color:#b45309">ℹ ${esc(meta.notice)}</div>` : ''}
  </div>

  ${(mm.list && mm.list.length) ? `
  <div class="card">
    <h2 class="h2">专业「${esc(mm.keyword)}」近年录取情况 <span class="pill">${mm.list.length}</span></h2>
    ${mm.note ? `<div class="hint" style="color:#b45309">${esc(mm.note)}</div>` : ''}
    <div class="tablewrap" style="margin-top:10px"><table>
      <thead><tr><th>院校</th><th>年份</th><th>专业</th><th>最低分</th><th>线差</th><th>最低位次</th><th>录取概率</th><th>选科要求</th></tr></thead>
      <tbody>${mm.list.slice(0, 80).map((m) => `<tr>
        <td>${esc(m.school.name)}</td><td>${m.year}</td><td>${esc(m.major)}</td>
        <td class="num">${fmt(m.min)}</td><td class="num">${m.diff == null ? '—' : (m.diff > 0 ? '+' : '') + m.diff}</td>
        <td class="num">${fmt(m.minRank)}</td>
        <td class="num">${m.probability == null ? '—' : m.probability + '%'}</td>
        <td>${esc(m.subjectReq || '—')}</td></tr>`).join('')}</tbody></table></div>
  </div>` : (mm.error ? `<div class="card"><div class="hint" style="color:#b45309">专业匹配未完成：${esc(mm.error)}</div></div>` : '')}

  <div class="tiers">
    ${tierDef.map(([k, label]) => `
      <div class="tier ${k}">
        <div class="tier-head">
          <h3>${label}（${label === '冲' ? '可以冲一冲' : label === '稳' ? '把握较大' : '保底稳妥'}）</h3>
          <span class="cnt">${r.counts[k]} 个 · 显示 ${r.tiers[k].length}</span>
        </div>
        <div class="tier-body">
          ${r.tiers[k].length ? r.tiers[k].map((c) => recCard(c, k, bing)).join('') : '<div class="empty" style="padding:20px">暂无匹配结果</div>'}
        </div>
      </div>`).join('')}
  </div>`;

  $('#r-print')?.addEventListener('click', () => window.print());
  $$('#r-result .star').forEach((b) => b.addEventListener('click', () => {
    const c = JSON.parse(b.dataset.item);
    toggleWish(c);
    b.classList.toggle('on', isWished(c.key));
  }));
}

function recCard(c, tier, byRank) {
  const color = tier === 'chong' ? 'var(--red)' : tier === 'wen' ? 'var(--amber)' : 'var(--green)';
  const key = `r_${c.school.id}_${c.group}_${tier}`;
  const item = {
    key, type: '推荐', school: c.school.name, schoolId: c.school.id,
    extra: `${c.group || ''} ${c.batch || ''} 概率${c.probability}%`,
  };
  const h = c.hist || [];
  const spark = h.length > 1
    ? `<svg width="86" height="24" viewBox="0 0 86 24">${(() => {
        const rs = h.map((x) => x.rank).filter((x) => x > 0);
        if (rs.length < 2) return '';
        const lo = Math.min(...rs), hi = Math.max(...rs);
        const pts = h.map((x, i) => `${(i / (h.length - 1)) * 82 + 2},${22 - ((x.rank - lo) / Math.max(1, hi - lo)) * 20}`).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
      })()}</svg>`
    : '';
  return `<div class="rcard">
    <div class="rl1">
      <span class="sname">${esc(c.school.name)}</span>
      ${tierTag(c.school)}
      <span class="meta">${esc(c.school.province || '')}${c.school.city ? ' · ' + esc(c.school.city) : ''}</span>
      <span class="spacer" style="margin-left:auto"></span>
      <button class="star ${isWished(key) ? 'on' : ''}" data-item='${esc(JSON.stringify(item))}' title="加入志愿表">☆</button>
    </div>
    <div class="row">
      <span class="kv">录取概率 <b style="color:${color}">${c.probability}%</b></span>
      ${byRank
        ? `<span class="kv">基准位次 <b>${fmt(c.baseRank)}</b></span>`
        : `<span class="kv">基准线差 <b>${c.baseDiff == null ? '—' : (c.baseDiff > 0 ? '+' : '') + c.baseDiff}</b></span>`}
      <span class="kv">${c.latestYear} 年 <b>${fmt(c.latestMin)}分</b>${c.latestRank ? ' / ' + fmt(c.latestRank) + '位' : ''}</span>
    </div>
    <div class="row">
      <span class="meta">${esc(c.group || '')} ${esc(c.batch || '')} ${c.subjectReq ? '· ' + esc(c.subjectReq) : ''}</span>
      ${spark}
    </div>
    <div class="probbar"><i style="width:${c.probability}%;background:${color}"></i></div>
    <div class="reasons">${(c.reason || []).slice(0, 4).map((x) => `<span>${esc(x)}</span>`).join('')}</div>
  </div>`;
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
      <td>${esc(x.year || '')}</td><td>${esc(x.extra || '')}</td>
      <td><button class="btn sm danger" data-del="${esc(x.key)}">移除</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('#w-result [data-del]').forEach((b) => b.addEventListener('click', () => {
    S.wishlist = S.wishlist.filter((x) => x.key !== b.dataset.del);
    saveWishlist(); renderWishlist(); toast('已移除');
  }));
}

function exportWishlist() {
  if (!S.wishlist.length) return toast('志愿表为空');
  const rows = [['序号', '类型', '院校', '院校ID', '年份', '专业/专业组']];
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
    const cov = r.coverage || {};
    const years = Object.keys(cov).sort((a, b) => b - a);
    const idx = r.indexer;
    const up = r.upstream || {};
    box.innerHTML = `
    <div class="card">
      <h2 class="h2">本地索引覆盖</h2>
      ${years.length ? `<div class="tablewrap" style="margin-top:10px"><table>
        <thead><tr><th>年份</th><th>已建省份</th><th>完整</th><th>记录数</th><th>覆盖度</th></tr></thead>
        <tbody>${years.map((y) => {
          const c = cov[y]; const pct = Math.round(c.provinces / 31 * 100);
          return `<tr><td><b>${y}</b></td><td>${c.provinces} / 31</td><td>${c.complete}</td>
            <td class="num">${fmt(c.rows)}</td>
            <td style="min-width:180px"><div class="bar"><i style="width:${pct}%"></i></div>
            <span class="hint" style="margin:0">${pct}%</span></td></tr>`;
        }).join('')}</tbody></table></div>`
        : '<div class="hint">尚无任何本地索引。点击右上角「补齐全部年份数据」开始后台抓取。</div>'}
    </div>

    <div class="card">
      <div class="filters" style="align-items:center">
        <h2 class="h2">后台同步任务</h2>
        <span class="pill">${idx.running ? '运行中' : '空闲'}</span>
        <span class="tag">队列 ${idx.queueLen}</span>
        <span class="tag">已完成 ${idx.doneCount}</span>
        <div class="spacer"></div>
        <button class="btn sm" id="d-auto">刷新</button>
      </div>
      ${idx.current ? `<div class="hint">正在抓取：<b>${esc(idx.current.province)} ${idx.current.year}</b>
        — ${fmt(idx.current.fetched)} / ${fmt(idx.current.total)} 条</div>
        <div class="bar"><i style="width:${idx.current.total ? Math.round(idx.current.fetched / idx.current.total * 100) : 0}%"></i></div>` : ''}
      ${idx.queueLen ? `<div class="hint">待处理：${idx.queue.slice(0, 24).map((x) => esc(x.province) + x.year).join('、')}${idx.queueLen > 24 ? ' …' : ''}</div>` : ''}
      ${idx.recentDone?.length ? `<div class="hint">最近完成：${idx.recentDone.map((x) => `${esc(x.province)}${x.year}(${fmt(x.rows)}条${x.complete ? '' : '⚠'})`).join('、')}</div>` : ''}
      ${idx.errors?.length ? `<div class="hint" style="color:#b45309">失败记录：${idx.errors.map((x) => `${esc(x.province)}${x.year}`).join('、')}（稍后会自动重试）</div>` : ''}
    </div>

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
    $('#d-auto')?.addEventListener('click', renderData);
  } catch (e) { box.innerHTML = emptyBox('⚠️', '读取失败：' + esc(e.message)); }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('#s-school').addEventListener('input', (e) => {
    clearTimeout(schoolTimer);
    const v = e.target.value.trim();
    schoolTimer = setTimeout(() => searchSchoolList(v).catch(() => {}), 260);
  });
  $('#s-search').addEventListener('click', runScoreQuery);
  $('#s-province').addEventListener('change', async () => { await refreshDict('s'); });
  $('#s-type').addEventListener('change', () => {});
  $('#s-school').addEventListener('keydown', (e) => { if (e.key === 'Enter') runScoreQuery(); });
  $('#s-major').addEventListener('keydown', (e) => { if (e.key === 'Enter') runScoreQuery(); });

  $('#c-search').addEventListener('click', runCampusSearch);
  $('#c-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCampusSearch(); });

  $('#r-province').addEventListener('change', () => refreshDict('r'));
  $('#r-mode').addEventListener('change', () => {
    const mode = $('#r-mode').value;
    $('#r-score-wrap').style.display = mode === 'score' ? '' : 'none';
    $('#r-rank-wrap').style.display = mode === 'rank' ? '' : 'none';
  });
  $('#r-run').addEventListener('click', runRecommend);

  $('#w-export').addEventListener('click', exportWishlist);
  $('#w-print').addEventListener('click', () => window.print());
  $('#w-clear').addEventListener('click', () => {
    if (!S.wishlist.length) return;
    if (confirm('确定清空志愿表？')) { S.wishlist = []; saveWishlist(); renderWishlist(); toast('已清空'); }
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

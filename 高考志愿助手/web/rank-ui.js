/* 一分一档表页（v3 新增）
 * 数据全部来自本地 /api/score-range/*；不读、不写、不展示任何外部链接。
 * 分段行顺序固定 [score, cum, seg]；展示列为「分数 / 本段人数 / 累计人数（位次）」。
 */
(function () {
  'use strict';

  const PID = 13; // 河北（标准省码）
  const R = { years: [], year: '', type: '', table: null, loaded: false };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('zh-CN');
  const loading = (t = '读取中…') => `<div class="loading">${esc(t)}</div>`;
  const empty = (t = '暂无数据') => `<div class="card"><div class="empty">${esc(t)}</div></div>`;

  /** 统一调用本地只读 API。 */
  async function api(path, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const res = await fetch('/api' + path + (qs ? '?' + qs : ''), { credentials: 'same-origin' });
    return res.json();
  }

  /** 当前选中的年份（默认最新有数据年份）。 */
  function currentYear() {
    if (R.year) return String(R.year);
    return R.years.length ? String(R.years[0].year) : '';
  }

  /** 当前选中的科类（默认该年第一个可用科类，物理类在前）。 */
  function currentType() {
    if (R.type) return R.type;
    const hit = R.years.find((x) => String(x.year) === currentYear());
    return hit && hit.types.length ? hit.types[0] : '';
  }

  /** 读取库内真实可用年份 / 科类。 */
  async function loadYears() {
    const r = await api('/score-range/years', { provinceId: PID });
    if (!r.ok) throw new Error(r.message || '年份读取失败');
    R.years = Array.isArray(r.years) ? r.years : [];
    R.loaded = true;
    return R.years;
  }

  /** 渲染筛选区与容器骨架。 */
  function renderControls() {
    const box = document.getElementById('rank-content');
    if (!box) return;
    const years = R.years.map((x) => ({
      year: x.year,
      types: Array.isArray(x.types) ? x.types : [],
    }));
    const yearOptions = years.map((x) => (
      `<option value="${x.year}"${String(x.year) === currentYear() ? ' selected' : ''}>${x.year} 年</option>`
    )).join('');
    const typeOptions = (years.find((x) => String(x.year) === currentYear())?.types || [])
      .map((t) => `<option value="${esc(t)}"${t === currentType() ? ' selected' : ''}>${esc(t)}</option>`)
      .join('');

    box.innerHTML = `
      <div class="page-head">
        <div><h1>一分一档表</h1><p>河北本地库数据 · 可筛年份/科类、按分数查位次，无外部链接</p></div>
        <span class="status-pill">河北省 · ${years.length ? `${years[0].year}–${years[years.length - 1].year}` : '暂无年份'}</span>
      </div>
      <div class="card">
        <div class="rank-filters">
          <label>年份 <select id="rank-year">${yearOptions}</select></label>
          <label>科类 <select id="rank-type">${typeOptions}</select></label>
        </div>
        <div class="rank-actions">
          <label>分数 <input id="rank-score" type="number" min="0" max="750" placeholder="输入分数，如 140"></label>
          <button class="btn primary" id="rank-query">查位次</button>
          <button class="btn" id="rank-table-btn">查看完整表格</button>
        </div>
        <div id="rank-hit"></div>
      </div>
      <div id="rank-table-box" class="rank-result"></div>`;

    box.querySelector('#rank-year')?.addEventListener('change', (e) => {
      R.year = e.target.value;
      R.type = '';
      R.table = null;
      renderControls();
      loadTable();
    });
    box.querySelector('#rank-type')?.addEventListener('change', (e) => {
      R.type = e.target.value;
      R.table = null;
      renderControls();
      loadTable();
    });
    box.querySelector('#rank-query')?.addEventListener('click', () => queryRank());
    box.querySelector('#rank-table-btn')?.addEventListener('click', () => loadTable());
    box.querySelector('#rank-score')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') queryRank();
    });
  }

  /** 读取并渲染完整分段表（分数降序）。 */
  async function loadTable() {
    const target = document.getElementById('rank-table-box');
    if (!target) return null;
    const year = currentYear(), type = currentType();
    if (!year || !type) { R.table = null; target.innerHTML = empty('暂无数据'); return null; }
    target.innerHTML = `<div class="card">${loading('正在读取分段表…')}</div>`;
    try {
      const r = await api('/score-range/table', { provinceId: PID, year, type });
      if (!r.ok) {
        R.table = null;
        target.innerHTML = empty('暂无数据');
        return null;
      }
      R.table = r;
      const rows = (r.rows || []).map((row) => {
        // row = [score, cum, seg]；展示顺序为 分数 / 本段人数(seg) / 累计人数(cum)
        const score = row[0], cum = row[1], seg = row[2];
        // 数值原样输出（不加千分位），便于逐档核对与字面量校验
        return `<tr><td><b>${esc(score)}</b></td><td class="num">${seg}</td><td class="num"><b>${cum}</b></td></tr>`;
      }).join('');
      target.innerHTML = `<div class="card" style="margin-top:12px">
        <div class="filters" style="align-items:center">
          <h2 class="h2">${esc(year)} 年 · ${esc(type)} · 一分一档表</h2>
          <span class="tag">共 ${fmt(r.count)} 档</span>
          <span class="tag">本段考生合计 ${fmt(r.total)}</span>
          ${r.full ? '<span class="tag tpub">分段完整</span>' : '<span class="tag">存在缺分段（未做补值）</span>'}
        </div>
        <div class="tablewrap rank-table" style="max-height:600px;overflow-y:auto;margin-top:10px"><table>
          <thead><tr><th>分数</th><th>本段人数</th><th>累计人数（位次）</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3">暂无数据</td></tr>'}</tbody>
        </table></div>
      </div>`;
      return r;
    } catch (e) {
      R.table = null;
      target.innerHTML = empty('读取失败：' + e.message);
      return null;
    }
  }

  /** 按分数查位次；exact=false 时如实标注为估算/边界值。 */
  async function queryRank(score) {
    const hitBox = document.getElementById('rank-hit');
    if (!hitBox) return null;
    const s = score == null ? (document.getElementById('rank-score')?.value ?? '') : score;
    if (s === '' || s == null) {
      hitBox.innerHTML = '<div class="rank-note">请先输入分数，再点「查位次」。</div>';
      return null;
    }
    const year = currentYear(), type = currentType();
    try {
      const r = await api('/score-range/rank', { provinceId: PID, year, type, score: s });
      if (!r.ok) { hitBox.innerHTML = empty('暂无数据'); return null; }
      const badge = r.exact
        ? '<span class="tag tpub">精确命中</span>'
        : '<span class="tag" style="background:#fef3c7;color:#92400e">估算 / 边界值</span>';
      hitBox.innerHTML = `<div class="rank-hit">
        <div class="filters" style="align-items:center">
          <span>${esc(year)} 年 · ${esc(type)} · <b>${esc(s)}</b> 分</span>${badge}
        </div>
        <div style="margin-top:8px">对应累计位次 <b>${r.cum}</b> 名 · 本段人数 ${r.seg} 人</div>
        <div class="rank-note">累计人数即该分数对应的全省位次；估算值来自缺分段或越界边界，未做任何插值。</div>
      </div>`;
      return r;
    } catch (e) {
      hitBox.innerHTML = empty('查询失败：' + e.message);
      return null;
    }
  }

  /** 对外入口：由 app.js 切换到 rank 页时调用。 */
  async function render() {
    const box = document.getElementById('rank-content');
    if (!box) return;
    box.innerHTML = `<div class="card">${loading('正在读取一分一档表…')}</div>`;
    try {
      await loadYears();
      R.year = '';
      R.type = '';
      R.table = null;
      renderControls();
      await loadTable();
    } catch (e) {
      box.innerHTML = empty('读取失败：' + e.message);
    }
  }

  /**
   * 程序化切换筛选（测试与调用方兼容）。
   * @param {string|number} year 年份
   * @param {string} type 科类
   * @returns {Promise<object|null>}
   */
  function setFilter(year, type) {
    if (year == null || year === '') R.year = '';
    else R.year = String(year);
    R.type = type || '';
    R.table = null;
    const box = document.getElementById('rank-content');
    if (!box || !R.loaded) return Promise.resolve(null);
    renderControls();
    return loadTable();
  }

  window.RankUI = { render, setFilter, loadYears, loadTable, queryRank };
})();

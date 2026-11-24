/* 院校查询三级页（v3 新增）
 * 一级：有录取记录的学校列表（搜索 / 加载更多）
 * 二级：学校详情 + 地区（固定河北）/年份/专业/科类筛选
 * 三级：结果表，固定四列 专业 / 最低分 / 位次 / 计划数。
 * 强约束：major_adm 无录取人数字段，本模块不返回、不展示「录取人数」。
 * 校名 id 一律使用 gcdb 库内 school.id（sid）。
 */
(function () {
  'use strict';

  const PID = 13; // 河北（标准省码）
  const C = {
    view: 'list',
    q: '', page: 1, size: 30, total: 0, items: [],
    sid: null, school: null, filters: null,
    year: '', type: '', major: '', rowPage: 1,
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('zh-CN');
  const dash = (n) => (n == null || n === '' ? '—' : fmt(n));
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

  function box() { return document.getElementById('college-content'); }

  /** 面包屑：一级列表 / 二级详情。 */
  function crumb(name) {
    if (!name) return `<div class="crumb"><span class="now">院校查询</span></div>`;
    return `<div class="crumb">
      <button type="button" id="college-back">院校查询</button><span class="sep">›</span><span class="now">${esc(name)}</span>
    </div>`;
  }

  /** 一级：学校列表。q 为空则展示全部；page>1 为加载更多。 */
  async function showList(q, page = 1) {
    if (q != null) C.q = String(q);
    C.page = Math.max(1, Number(page) || 1);
    C.view = 'list';
    const target = box();
    if (!target) return null;
    target.innerHTML = `<div class="card">${loading('正在读取院校列表…')}</div>`;
    try {
      const r = await api('/colleges/admitted', {
        provinceId: PID, q: C.q, page: C.page, size: C.size,
      });
      if (!r.ok) throw new Error(r.message || '院校列表读取失败');
      C.total = Number(r.total) || 0;
      C.items = Array.isArray(r.items) ? r.items : [];
      renderList();
      return r;
    } catch (e) {
      target.innerHTML = empty('读取失败：' + e.message);
      return null;
    }
  }

  /** 渲染一级列表骨架、搜索框与加载更多。 */
  function renderList() {
    const target = box();
    if (!target) return;
    const items = C.items.map((s) => {
      const meta = [s.nature, Number(s.lv) === 3 ? '985' : Number(s.lv) === 2 ? '211' : '']
        .filter(Boolean).join(' · ');
      return `<button type="button" class="college-item" data-sid="${s.id}">
        <div class="name">${esc(s.name)}</div><div class="meta">${esc(meta || '公办/民办：—')}</div>
      </button>`;
    }).join('');
    target.innerHTML = `${crumb('')}
      <div class="card">
        <div class="college-filters">
          <label class="grow">搜索学校名称
            <input id="college-q" placeholder="输入关键词，如：河北师范" value="${esc(C.q)}">
          </label>
          <button class="btn primary" id="college-search">搜索</button>
        </div>
        <div class="college-total" style="margin-top:10px">共 ${fmt(C.total)} 所有河北录取记录的院校；当前显示 ${fmt(C.items.length)} 所</div>
        <div class="college-list">${items || empty('没有匹配的院校')}</div>
        ${C.items.length < C.total ? '<div class="college-more"><button class="btn" id="college-more">加载更多</button></div>' : ''}
      </div>`;

    target.querySelector('#college-search')?.addEventListener('click', () => {
      showList(target.querySelector('#college-q')?.value || '', 1);
    });
    target.querySelector('#college-q')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') showList(target.querySelector('#college-q')?.value || '', 1);
    });
    target.querySelector('#college-more')?.addEventListener('click', () => {
      showList(C.q, C.page + 1);
    });
    target.querySelectorAll('.college-item').forEach((b) => {
      b.addEventListener('click', () => showDetail(b.dataset.sid));
    });
  }

  /** 二级：学校详情 + 筛选项。 */
  async function showDetail(sid) {
    C.sid = Number(sid);
    C.view = 'detail';
    C.rowPage = 1;
    const target = box();
    if (!target) return null;
    target.innerHTML = `<div class="card">${loading('正在读取院校筛选项…')}</div>`;
    try {
      const r = await api('/colleges/filters', { provinceId: PID, schoolId: C.sid });
      if (!r.ok) throw new Error(r.message || '院校信息读取失败');
      C.filters = r;
      C.school = r.school || null;
      const years = Array.isArray(r.years) ? r.years : [];
      // 默认取数据最全年份 2025；无 2025 时取最新年份
      C.year = String(years.find((y) => Number(y) === 2025) ?? years[0] ?? '');
      C.type = '';
      C.major = '';
      renderDetail();
      await loadRows();
      return r;
    } catch (e) {
      target.innerHTML = `${crumb('')}${empty('读取失败：' + e.message)}`;
      return null;
    }
  }

  /** 渲染二级筛选骨架。地区按拍板固定仅河北一项。 */
  function renderDetail() {
    const target = box();
    if (!target) return;
    const f = C.filters || {};
    const years = Array.isArray(f.years) ? f.years : [];
    const types = Array.isArray(f.types) ? f.types : [];
    const majors = Array.isArray(f.majors) ? f.majors : [];
    const yearOpts = years.map((y) => (
      `<option value="${y}"${String(y) === String(C.year) ? ' selected' : ''}>${y} 年</option>`
    )).join('');
    const typeOpts = ['<option value="">全部科类</option>']
      .concat(types.map((t) => `<option value="${esc(t)}"${t === C.type ? ' selected' : ''}>${esc(t)}</option>`))
      .join('');
    const majorOpts = ['<option value="">全部专业</option>']
      .concat(majors.slice(0, 400).map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`))
      .join('');
    const regions = Array.isArray(f.regions) && f.regions.length ? f.regions : [{ id: PID, name: '河北' }];
    const regionOpts = regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    const name = C.school?.name || String(C.sid || '');
    const meta = [C.school?.nature, Number(C.school?.lv) === 3 ? '985' : Number(C.school?.lv) === 2 ? '211' : '']
      .filter(Boolean).join(' · ');

    target.innerHTML = `${crumb(name)}
      <div class="card">
        <div class="filters" style="align-items:center">
          <h2 class="h2">${esc(name)}</h2><span class="tag">${esc(meta || '—')}</span>
          <div class="spacer"></div>
          <button class="btn sm" id="college-back-top">返回学校列表</button>
        </div>
        <div class="college-filters" style="margin-top:12px">
          <label>地区 <select id="college-region">${regionOpts}</select></label>
          <label>年份 <select id="college-year">${yearOpts}</select></label>
          <label>科类 <select id="college-type">${typeOpts}</select></label>
          <label class="grow">专业
            <input id="college-major" list="college-major-list" placeholder="输入专业名关键词" value="${esc(C.major)}">
            <datalist id="college-major-list">${majorOpts}</datalist>
          </label>
          <button class="btn primary" id="college-query">查询结果</button>
        </div>
      </div>
      <div id="college-result" class="college-result"></div>`;

    const bindBack = (sel) => target.querySelector(sel)?.addEventListener('click', () => {
      C.q = '';
      C.page = 1;
      showList('', 1);
    });
    bindBack('#college-back');
    bindBack('#college-back-top');
    target.querySelector('#college-query')?.addEventListener('click', () => {
      C.year = target.querySelector('#college-year')?.value || C.year;
      C.type = target.querySelector('#college-type')?.value || '';
      C.major = target.querySelector('#college-major')?.value || '';
      C.rowPage = 1;
      loadRows();
    });
  }

  /** 三级：专业录取行（专业 / 最低分 / 位次 / 计划数）。 */
  async function loadRows(page = 1) {
    const target = document.getElementById('college-result');
    if (!target) return null;
    C.rowPage = Math.max(1, Number(page) || 1);
    if (!C.sid || !C.year) { target.innerHTML = empty('暂无数据'); return null; }
    target.innerHTML = `<div class="card">${loading('正在读取专业录取数据…')}</div>`;
    try {
      const r = await api('/colleges/majors', {
        provinceId: PID, schoolId: C.sid, year: C.year,
        type: C.type, major: C.major, page: C.rowPage, size: C.size,
      });
      if (!r.ok) throw new Error(r.message || '录取数据读取失败');
      const rows = (r.items || []).map((x) => `<tr>
        <td>${esc(x.major || '—')}</td>
        <td class="num">${dash(x.min)}</td>
        <td class="num">${dash(x.rank)}</td>
        <td class="num">${dash(x.planNum)}</td>
      </tr>`).join('');
      target.innerHTML = `<div class="card">
        <div class="filters" style="align-items:center">
          <h2 class="h2">${esc(C.year)} 年专业录取明细 <span class="pill">${fmt(r.total)}</span></h2>
          <span class="tag">计划数来自招生计划库（非实际录取数）</span>
        </div>
        <div class="tablewrap college-table" style="margin-top:10px"><table>
          <thead><tr><th>专业</th><th>最低分</th><th>位次</th><th>计划数</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">暂无数据</td></tr>'}</tbody>
        </table></div>
        ${C.rowPage * C.size < (r.total || 0) ? '<div class="college-more"><button class="btn" id="college-row-more">加载更多</button></div>' : ''}
      </div>`;
      target.querySelector('#college-row-more')?.addEventListener('click', () => loadRows(C.rowPage + 1));
      return r;
    } catch (e) {
      target.innerHTML = empty('读取失败：' + e.message);
      return null;
    }
  }

  /** 对外入口：由 app.js 切换到 score 页时调用。 */
  async function render() {
    const target = box();
    if (!target) return;
    C.view = 'list';
    C.q = '';
    C.page = 1;
    await showList('', 1);
  }

  window.CollegeUI = {
    render, showList, showDetail, loadRows,
    /** 测试/程序化入口：设置筛选并刷新结果。 */
    setFilter(year, type, major) {
      if (year != null && year !== '') C.year = String(year);
      if (type != null) C.type = type;
      if (major != null) C.major = major;
      C.rowPage = 1;
      if (C.view === 'detail' && C.sid) return loadRows(1);
      return Promise.resolve(null);
    },
  };
})();

/* 河北省控线页（方案 A：年份 / 科类 / 本科批 / 专科批 四列 10 行）
 * 数据唯一真源在 server/province-lines.mjs；本文件不写死第二份数据、不插值。
 * v3 起一分一档外链已移除，本模块只负责省控线。
 */
(function () {
  'use strict';

  const LINES = {
    loaded: false,
    years: [],
    data: {},
    selectedYear: 'all',
    selectedCategory: '历史类', // 仅保留状态兼容 setFilter；方案 A 两科类同时展开，不参与渲染
  };
  const BATCHES = ['本科批', '专科批'];
  const CATEGORIES = ['历史类', '物理类']; // 每年先历史类后物理类

  const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  /** 读取省控线（首次访问请求服务端，后续复用缓存）。 */
  async function loadLines() {
    if (LINES.loaded) return true;
    const res = await fetch('/api/lines?provinceId=13', { credentials: 'same-origin' });
    const r = await res.json();
    if (!r.ok) throw new Error(r.message || '省控线读取失败');
    LINES.years = Array.isArray(r.years) ? r.years.map(Number) : [];
    LINES.data = r.data || {};
    LINES.loaded = true;
    return true;
  }

  /**
   * 方案 A 渲染：5 年 × 2 科类 = 10 行，每行 4 格（年份 / 科类 / 本科批 / 专科批）。
   * 20 个数值格全部来自真源，逐列对齐；不再渲染「暂无数据」。
   * @param {HTMLElement} box 渲染容器
   */
  function draw(box) {
    const years = LINES.selectedYear === 'all'
      ? LINES.years
      : LINES.years.filter((y) => String(y) === String(LINES.selectedYear));
    const yearOptions = ['<option value="all">全部年份</option>']
      .concat(LINES.years.map((y) => (
        `<option value="${y}"${String(LINES.selectedYear) === String(y) ? ' selected' : ''}>${y} 年</option>`
      )))
      .join('');

    const rows = [];
    for (const year of years) {
      for (const category of CATEGORIES) {
        const cells = BATCHES.map((batch) => {
          const value = LINES.data[String(year)]?.[`${category}|${batch}`];
          return `<td class="num">${escapeHtml(value ?? '—')}</td>`;
        }).join('');
        rows.push(`<tr><td><b>${escapeHtml(year)}</b></td><td>${escapeHtml(category)}</td>${cells}</tr>`);
      }
    }

    box.innerHTML = `
      <div class="page-head">
        <div><h1>河北省控线</h1><p>历史类 / 物理类逐行对照本科批与专科批录取控制分数线</p></div>
        <span class="status-pill">河北省 · ${LINES.years.length ? `${LINES.years[0]}–${LINES.years[LINES.years.length - 1]}` : '暂无年份'}</span>
      </div>
      <div class="card">
        <div class="filters">
          <label>年份 <select id="lines-year">${yearOptions}</select></label>
        </div>
        <div class="tablewrap" style="margin-top:12px"><table>
          <thead><tr><th>年份</th><th>科类</th><th>本科批</th><th>专科批</th></tr></thead>
          <tbody>${rows.join('') || '<tr><td colspan="4">暂无数据</td></tr>'}</tbody>
        </table></div>
      </div>`;

    box.querySelector('#lines-year')?.addEventListener('change', (e) => {
      LINES.selectedYear = e.target.value;
      draw(box);
    });
  }

  /** 对外入口：由 app.js 切换到 lines 页时调用。 */
  async function render() {
    const box = document.getElementById('lines-content');
    if (!box) return;
    box.innerHTML = '<div class="card"><div class="loading">正在读取省控线…</div></div>';
    try {
      await loadLines();
      draw(box);
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="empty">读取失败：${escapeHtml(e.message)}</div></div>`;
    }
  }

  /**
   * 程序化切换筛选条件（与页面共用状态）。
   * 方案 A 同时展开两科类，category 参数仅兼容旧调用方，不参与渲染。
   * @param {string|number} year 年份或 'all'
   * @param {string} [category] 兼容参数，忽略
   */
  function setFilter(year, category) {
    LINES.selectedYear = year == null || year === '' ? 'all' : String(year);
    if (category) LINES.selectedCategory = String(category);
    const box = document.getElementById('lines-content');
    if (box && LINES.loaded) draw(box);
  }

  window.LinesUI = { render, setFilter };
})();

/* =================================================================
 * 数据质量 UI（原生 JS，零依赖）
 *
 * 用户拍板口径（2026-11-18）：
 *   U4 河北 2026 抽样行「保留 + 标注 + 默认排除」——前端只做标注，不参与算法年份选择；
 *   Q4 异常数据默认隐藏，但可在质量面板查——维护者详情放在 <details> 折叠区，展开才请求；
 *   Q7 默认给家长看精简版，维护者细节折叠——精简版只讲「数据到哪年 / 能不能用」。
 *
 * 全部标记采用「符号 + 文字」，颜色不作唯一区分，色盲用户同样可读。
 * 依赖 app.js 提供的全局 api / esc / fmt；脚本须在 app.js 之后加载。
 * ================================================================= */
'use strict';

(function () {
  const STATE = {
    full: { symbol: '●', label: '官方完整', cls: 'q-official' },
    partial: { symbol: '◐', label: '部分/抽样', cls: 'q-partial' },
    missing: { symbol: '—', label: '缺失', cls: 'q-missing' },
    imageOnly: { symbol: 'ⓘ', label: '仅图片', cls: 'q-info' },
  };
  const TABLE_LABEL = {
    score_range: '一分一段', school_adm: '院校投档线',
    major_adm: '专业录取分', plan_code: '招生计划',
  };
  const LEVEL_LABEL = {
    current: '数据已到当年', lagging: '滞后 1 年',
    stale: '滞后 2 年以上', provisional: '当年数据为临时/部分', 'no-data': '暂无完整数据',
  };

  const G = { last: null, manifest: null, freshness: null, panelLoaded: false };
  const escQ = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const get = (p, params) => api(p, params);

  function provinceId() {
    for (const id of ['p-province', 'r-province', 's-province', 'd-province']) {
      const el = document.getElementById(id);
      if (el && /^\d+$/.test(String(el.value || ''))) return Number(el.value);
    }
    return 13; // 默认河北
  }

  const dateOnly = (s) => (s ? String(s).slice(0, 10) : '未标注');

  // ------------------------------------------------------------------
  // 统一「数据快照条」：所有结果卡片 / 打印页脚 / CSV 共用同一份文案
  // ------------------------------------------------------------------
  function snapshotBar(dq) {
    if (!dq) return '';
    const flags = (dq.flags || [])
      .map((f) => `<span class="q-flag">${escQ(f.text || '')}</span>`).join('');
    return `<div class="snapshot-bar">
      <span class="q-snap-label">数据快照</span>
      <span class="q-snap-text">${escQ(dq.snapshotText || '')}</span>
      ${flags ? `<div class="q-flags">${flags}</div>` : ''}
    </div>`;
  }

  function csvSnapshot(dq) {
    const d = dq || G.last;
    if (d?.snapshotText) return d.snapshotText;
    const m = G.manifest;
    return m ? `数据版本 ${m.dataVersion || '未标注'} · 构建 ${dateOnly(m.builtAt)} · 完整基准年 ${m.baselineYear || '未标注'}；请以本省当年官方发布为准`
      : '数据版本未标注；请以本省当年省教育考试院发布为准';
  }

  /** 结果接口返回时调用：缓存信封并同步打印页脚 */
  function setSnapshot(dq) {
    if (!dq) return;
    G.last = dq;
    const el = document.getElementById('q-print-footer');
    if (el) {
      el.innerHTML = `数据快照：${escQ(csvSnapshot(dq))} · 本表为历史数据统计推算，最终以本省当年《招生专业目录》与省教育考试院发布为准。`;
    }
  }

  function legendHtml(legend) {
    const list = legend || [
      { symbol: '●', label: '官方完整', cssClass: 'q-official' },
      { symbol: '≈', label: '估算/拟合', cssClass: 'q-est' },
      { symbol: '◐', label: '部分/抽样', cssClass: 'q-partial' },
      { symbol: 'ⓘ', label: '回填/图片/缺口', cssClass: 'q-info' },
      { symbol: '⚠', label: '历史回退', cssClass: 'q-warn' },
    ];
    return `<div class="q-legend">${list.map((x) =>
      `<span class="q-legend-item ${escQ(x.cssClass || '')}"><b>${escQ(x.symbol)}</b> ${escQ(x.label)}</span>`).join('')}</div>`;
  }

  // ------------------------------------------------------------------
  // 四态 chip：替换误导性的绿色「有 2026」（C3/Q6）
  // ------------------------------------------------------------------
  function stateChip(p) {
    const cov = p?.coverage2026 || {};
    const detail = Object.entries(TABLE_LABEL).map(([t, label]) => {
      const c = cov[t] || {};
      const st = STATE[c.state] || STATE.missing;
      return `${label} ${st.symbol}${st.label}${Number(c.sampled) === 1 ? '(抽样)' : ''}`;
    }).join(' · ');
    const title = escQ(detail);
    if (p?.has2026) return `<span class="q-chip q-official" title="${title}">● 有完整数据</span>`;
    if (p?.has2026Partial) return `<span class="q-chip q-partial" title="${title}">◐ 部分/抽样</span>`;
    return `<span class="q-chip q-missing" title="${title}">— 无当年数据</span>`;
  }

  // ------------------------------------------------------------------
  // 首页横幅（家长精简版）
  // ------------------------------------------------------------------
  function bannerHtml(fr, mf) {
    const level = fr.level || 'no-data';
    return `<div class="q-banner-inner">
      <span class="q-banner-icon q-${escQ(level)}">ⓘ</span>
      <span class="q-banner-text">${escQ(fr.bannerText || `数据版本 ${mf.dataVersion || '未标注'}，请以官方发布为准`)}</span>
      <span class="q-chip q-${escQ(level)}">${escQ(LEVEL_LABEL[level] || level)}</span>
      <button class="btn sm" id="q-banner-detail" type="button">数据质量详情</button>
    </div>`;
  }

  async function init() {
    const banner = document.getElementById('q-banner');
    if (!banner) return;
    const pid = provinceId();
    try {
      const [fr, mf] = await Promise.all([
        get('/quality/freshness', { provinceId: pid }),
        get('/quality/manifest'),
      ]);
      G.freshness = fr; G.manifest = mf;
      banner.innerHTML = bannerHtml(fr, mf);
      banner.classList.remove('q-banner-error');
    } catch (e) {
      banner.classList.add('q-banner-error');
      banner.innerHTML = '<div class="q-banner-inner"><span class="q-banner-text">数据质量信息暂不可用；具体分数与位次请以本省当年省教育考试院发布为准。</span></div>';
    }
    const btn = document.getElementById('q-banner-detail');
    if (btn) btn.addEventListener('click', openPanel);
    // 省份切换后重取按省新鲜度（只绑定一次）
    if (!G.boundProvince) {
      G.boundProvince = true;
      for (const id of ['p-province', 'r-province', 's-province', 'd-province']) {
        document.getElementById(id)?.addEventListener('change', () => { G.freshness = null; init(); });
      }
    }
  }

  // ------------------------------------------------------------------
  // 质量面板：默认精简版 + <details> 维护者折叠（Q4/Q7）
  // ------------------------------------------------------------------
  function matrixHtml(fr, mf) {
    const rows = (fr.tables || []).map((t) => {
      const st = STATE[t.state] || STATE.missing;
      return `<div class="q-matrix-row">
        <span class="q-matrix-name">${escQ(t.tableName || t.table)}</span>
        <span class="q-chip ${st.cls}">${st.symbol} ${st.label}</span>
        <span class="q-matrix-year">最新 ${t.latestYear ?? '—'} 年${t.lagYears > 0 ? ` · 完整数据滞后 ${t.lagYears} 年` : ''}</span>
      </div>`;
    }).join('');
    return `<div class="q-matrix">${rows}</div>
      <div class="hint">数据版本 <b>${escQ(mf.dataVersion || '未标注')}</b> · 构建 <b>${escQ(dateOnly(mf.builtAt))}</b>
        · 完整基准年 <b>${escQ(mf.baselineYear || '未标注')}</b> · 当前高考年度 <b>${escQ(fr.gaokaoYear || mf.gaokaoYear || '未标注')}</b></div>`;
  }

  async function renderPanel() {
    const root = document.getElementById('q-panel-root');
    if (!root) return;
    root.innerHTML = '<div class="hint">正在读取数据质量…</div>';
    const pid = provinceId();
    let fr = G.freshness, mf = G.manifest;
    try {
      const [f, m] = await Promise.all([
        fr || get('/quality/freshness', { provinceId: pid }),
        mf || get('/quality/manifest'),
      ]);
      G.freshness = f; G.manifest = m; fr = f; mf = m;
    } catch (e) {
      root.innerHTML = `<div class="card"><div class="hint">数据质量读取失败：${escQ(e.message)}；请以官方发布为准。</div></div>`;
      return;
    }
    root.innerHTML = `<div class="card q-panel">
      <div class="filters" style="align-items:center">
        <h2 class="h2">数据质量</h2>
        <span class="q-chip q-${escQ(fr.level || 'no-data')}">${escQ(LEVEL_LABEL[fr.level] || fr.level || '—')}</span>
        <div class="spacer"></div>
        <button class="btn sm" id="q-refresh" type="button">刷新</button>
        <button class="btn sm" id="q-export" type="button">导出报告</button>
      </div>
      <div class="q-summary">${escQ(fr.bannerText || '')}</div>
      ${matrixHtml(fr, mf)}
      <div class="q-legend-title">图例（符号 + 文字，颜色不作唯一区分）</div>
      ${legendHtml(mf.legend)}
      <details class="q-details" id="q-details">
        <summary>维护者详情：异常清单 / 字段非空率 / 校验和 / 抽样比对（点击展开）</summary>
        <div class="q-detail-body" id="q-detail-body">展开后加载…</div>
      </details>
    </div>`;

    document.getElementById('q-refresh')?.addEventListener('click', () => { G.freshness = null; G.manifest = null; renderPanel(); });
    document.getElementById('q-export')?.addEventListener('click', exportReport);
    const det = document.getElementById('q-details');
    det?.addEventListener('toggle', () => { if (det.open && !G.panelLoaded) loadDetails(); });
    if (det?.open) loadDetails();
  }

  /** 维护者细节按需加载：默认隐藏，展开才请求（Q4） */
  async function loadDetails() {
    const box = document.getElementById('q-detail-body');
    if (!box) return;
    box.innerHTML = '<div class="hint">加载维护者明细…</div>';
    try {
      const [issues, fields, report] = await Promise.all([
        get('/quality/issues', { limit: 20 }),
        get('/quality/fields'),
        get('/quality/report'),
      ]);
      G.panelLoaded = true;
      const s = fields.summary || {};
      const rows = (issues.items || []).slice(0, 20).map((i) => `<tr>
        <td>${escQ(i.table || '')}</td><td>${escQ(i.year || '')}</td>
        <td>${escQ(i.rule || '')}</td><td>${escQ(i.reason || i.value || '')}</td></tr>`).join('');
      const decisions = Object.entries(report.decisions || {})
        .map(([k, v]) => `<li><b>${escQ(k)}</b>：${escQ(v)}</li>`).join('');
      box.innerHTML = `
        <div class="q-detail-grid">
          <div><h3 class="h2">字段非空率</h3>
            <div class="hint">最低分 ${escQ(s.minFillRate ?? '—')} · 最低位次 ${escQ(s.rnkFillRate ?? '—')} · 省控线 ${escQ(s.ctrlFillRate ?? '—')}</div>
            <div class="hint">缺失（NULL/0）如实披露、不填充；只有值存在且越界才隔离。</div>
          </div>
          <div><h3 class="h2">校验与溯源</h3>
            <div class="hint">数据版本 ${escQ(report.version?.dataVersion || '—')} · 内容指纹 ${escQ(String(report.version?.dbSha256 || '未烘焙').slice(0, 16))}…</div>
            <div class="hint">省码回环 ${report.roundTrip?.ok ? `${report.roundTrip.total}/${report.roundTrip.total} 通过` : '存在错配'}</div>
            <div class="hint">抽样比对：${escQ(report.audit?.status || '未运行')}</div>
          </div>
        </div>
        <h3 class="h2" style="margin-top:14px">异常清单（默认不进候选集，仅此处可查）</h3>
        <div class="tablewrap"><table>
          <thead><tr><th>表</th><th>年份</th><th>规则</th><th>说明</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">暂无异常记录</td></tr>'}</tbody></table></div>
        <div class="hint">共 ${escQ(issues.total ?? 0)} 条，此处仅列前 20 条；完整清单见「导出报告」。</div>
        <h3 class="h2" style="margin-top:14px">决策口径</h3>
        <ul class="hint">${decisions}</ul>`;
    } catch (e) {
      box.innerHTML = `<div class="hint">维护者明细加载失败：${escQ(e.message)}</div>`;
    }
  }

  async function exportReport() {
    try {
      const r = await get('/quality/report');
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `数据质量报告_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      if (typeof toast === 'function') toast('导出失败：' + e.message);
    }
  }

  function openPanel() {
    const tab = document.querySelector('#tabs .tab[data-tab="data"]');
    if (tab) tab.click();
    setTimeout(() => {
      renderPanel();
      document.getElementById('q-panel-root')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }

  // ------------------------------------------------------------------
  // 初始化：app.js 完成字典加载后派发 app-ready
  // ------------------------------------------------------------------
  const UI = {
    init, renderPanel, openPanel, snapshotBar, csvSnapshot, setSnapshot,
    stateChip, legendHtml,
    get last() { return G.last; },
    get manifest() { return G.manifest; },
  };
  window.QualityUI = UI;

  let started = false;
  const boot = () => { if (started) return; started = true; init(); renderPanel(); };
  document.addEventListener('app-ready', boot);
  if (document.readyState === 'complete') setTimeout(boot, 0);
})();

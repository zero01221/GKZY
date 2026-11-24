/* 填报历史记录：列表 / 完整快照详情 / 导入为草稿 / 删除 */
(function () {
  'use strict';

  const STATE = { list: [], selectedId: null, detail: null };

  const hEsc = (v) => (typeof esc === 'function' ? esc(v) : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const hFmt = (v) => (typeof fmt === 'function' ? fmt(v) : (v == null || v === '' ? '—' : String(v)));
  const hToast = (msg) => { if (typeof toast === 'function') toast(msg); };
  const hEmpty = (icon, text) => (typeof emptyBox === 'function'
    ? emptyBox(icon, text)
    : `<div class="empty"><span class="big">${icon}</span>${text}</div>`);

  /** 统一请求入口：复用 app.js 的 api()（含 credentials 与错误信息解析）。 */
  function request(path, params, opts) {
    if (typeof api === 'function') return api(path, params, opts);
    const method = String(opts?.method || 'GET').toUpperCase();
    const withBody = method === 'POST' || method === 'PUT';
    const url = '/api' + path + (!withBody && params ? '?' + new URLSearchParams(params).toString() : '');
    const init = { method, credentials: 'same-origin', headers: {} };
    if (withBody) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(params || {});
    }
    return fetch(url, init).then((r) => r.json());
  }

  const shortTime = (iso) => String(iso || '').replace('T', ' ').slice(0, 19);

  function loginPrompt() {
    return `<div class="page-head"><div><h1>填报历史记录</h1><p>登录后查看每次生成的完整方案快照</p></div></div>
      <div class="card"><div class="empty"><span class="big">🔒</span>请先登录后再查看历史记录</div></div>`;
  }

  /** 历史列表 HTML：只展示 id / 时间 / meta / slotCount，不内嵌完整 slots。 */
  function renderList(items) {
    STATE.list = Array.isArray(items) ? items : [];
    const rows = STATE.list.map((h) => {
      const m = h.meta || {};
      return `<tr>
        <td>${hEsc(shortTime(h.createdAt))}</td>
        <td>${hEsc(m.province || '—')} · ${hEsc(m.type || '—')}</td>
        <td>${m.score ? `${hEsc(m.score)} 分` : '—'} / ${hFmt(m.rank)}</td>
        <td class="num">${hEsc(h.slotCount ?? (h.slots || []).length ?? 0)}</td>
        <td><div class="row-actions">
          <button class="btn sm" data-hist-view="${hEsc(h.id)}">查看详情</button>
          <button class="btn sm primary" data-hist-import="${hEsc(h.id)}">导入为草稿</button>
          <button class="btn sm danger" data-hist-del="${hEsc(h.id)}">删除</button>
        </div></td>
      </tr>`;
    }).join('');

    return `<div class="page-head">
        <div><h1>填报历史记录</h1><p>每次一键生成志愿参考后自动留档，点开可看完整快照</p></div>
        <span class="status-pill">${STATE.list.length} 条记录</span>
      </div>
      <div class="card">
        ${STATE.list.length ? `<div class="tablewrap"><table>
          <thead><tr><th>生成时间</th><th>省份 / 科类</th><th>分数 / 位次</th><th>条数</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
          : hEmpty('🧾', '还没有历史记录，先到「志愿参考」生成一次方案吧')}
      </div>
      <div id="history-detail"></div>`;
  }

  /** 完整快照详情：概率/位次/最低分等原字段全部保留展示，不参与草稿映射。 */
  function renderDetail(item) {
    if (!item) return '';
    const m = item.meta || {};
    const c = item.context || {};
    const slots = Array.isArray(item.slots) ? item.slots : [];
    const rows = slots.map((s) => {
      const school = s.school || {};
      const latest = s.latest || {};
      return `<tr>
        <td>${hEsc(s.order)}</td>
        <td><span class="tag ${s.tier === 'chong' ? 'tag-chong' : s.tier === 'wen' ? 'tag-wen' : s.tier === 'bao' ? 'tag-bao' : 'tag-soft'}">${hEsc(s.tierLabel || '')}</span></td>
        <td><b>${hEsc(school.name || '')}</b><div class="meta">${hEsc(school.province || '')}${school.city ? ' · ' + hEsc(school.city) : ''}${s.nationalCode ? ' · ' + hEsc(s.nationalCode) : ''}</div></td>
        <td>${hEsc(s.group || '专业组招生（未细分）')}<div class="meta">${hEsc(s.batch || '')}</div></td>
        <td>${hEsc(s.major || '按专业组招生')}</td>
        <td class="num">${hEsc(s.probability ?? '—')}${s.probability == null ? '' : '%'}</td>
        <td class="num">${hFmt(latest.min)}</td>
        <td class="num">${hFmt(latest.rank)}</td>
        <td>${hEsc(s.subjectReq || '不限')}</td>
        <td class="note-cell">${hEsc((s.reason || []).join(' '))}</td>
      </tr>`;
    }).join('');

    return `<div class="card">
        <div class="filters" style="align-items:center">
          <h2 class="h2">方案快照 · ${hEsc(shortTime(item.createdAt))}</h2>
          <span class="tag">${hEsc(m.province || '—')} · ${hEsc(m.type || '—')}</span>
          ${m.score ? `<span class="tag">分数 <b>${hEsc(m.score)}</b></span>` : ''}
          <span class="tag">位次 <b>${hFmt(m.rank)}</b></span>
          <span class="tag">${hEsc(m.strategyLabel || '')}</span>
          <span class="tag">参考年份 ${hEsc((m.refYears || []).join(' / '))}</span>
          <span class="tag">${slots.length} 条</span>
          <div class="spacer"></div>
          <button class="btn sm primary" data-hist-import-detail="${hEsc(item.id)}">导入为草稿</button>
        </div>
        ${c.subjects ? `<div class="hint">选科 ${hEsc(String(c.subjects))}${c.major ? ' · 意向 ' + hEsc(c.major) : ''}</div>` : ''}
        <div class="tablewrap" style="margin-top:10px;max-height:620px;overflow-y:auto"><table>
          <thead><tr><th>序</th><th>档</th><th>院校</th><th>专业组 / 批次</th><th>专业</th>
            <th>录取概率</th><th>最低分</th><th>最低位次</th><th>选科要求</th><th>推荐理由</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="10">该记录没有方案行</td></tr>'}</tbody>
        </table></div>
      </div>`;
  }

  /** 读取并展示一条历史详情。 */
  async function loadDetail(id) {
    const box = document.getElementById('history-detail');
    if (!box) return null;
    box.innerHTML = '<div class="card"><div class="loading">读取快照中…</div></div>';
    try {
      const r = await request('/history/' + encodeURIComponent(id));
      if (!r.ok) throw new Error(r.message || '读取失败');
      STATE.selectedId = id;
      STATE.detail = r.item;
      box.innerHTML = renderDetail(r.item);
      // 详情是异步注入的 DOM，必须在这里补绑事件；否则详情内的「导入为草稿」按钮无监听器
      bindActions(box);
      return r.item;
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="empty">读取失败：${hEsc(e.message)}</div></div>`;
      return null;
    }
  }

  /** 按 §3.2 映射表把历史快照导入为新草稿，原记录保持只读。 */
  async function importAsDraft(id) {
    let item = STATE.detail && STATE.detail.id === id ? STATE.detail : null;
    if (!item) {
      const r = await request('/history/' + encodeURIComponent(id));
      if (!r.ok) { hToast(r.message || '读取历史记录失败'); return null; }
      item = r.item;
    }
    if (!window.DraftUI || typeof window.DraftUI.mapSlotsToDraftRows !== 'function') {
      hToast('草稿模块尚未加载');
      return null;
    }
    const rows = window.DraftUI.mapSlotsToDraftRows(item.slots || []);
    try {
      const out = await request('/drafts', {
        name: '普通类平行志愿',
        rows,
        sourceHistoryId: item.id,
      }, { method: 'POST' });
      if (!out.ok) throw new Error(out.message || '导入失败');
      hToast('已导入草稿箱，可继续编辑');
      const tab = document.querySelector('[data-tab="drafts"]');
      if (tab && typeof tab.click === 'function') tab.click();
      return out.item;
    } catch (e) {
      hToast('导入失败：' + e.message);
      return null;
    }
  }

  /** 删除一条历史记录（不影响已导入的草稿）。 */
  async function removeHistory(id) {
    if (typeof confirm === 'function' && !confirm('确定删除这条历史记录？')) return false;
    try {
      const r = await request('/history/' + encodeURIComponent(id), null, { method: 'DELETE' });
      if (!r.ok) throw new Error(r.message || '删除失败');
      if (STATE.selectedId === id) {
        STATE.selectedId = null;
        STATE.detail = null;
        const detail = document.getElementById('history-detail');
        if (detail) detail.innerHTML = '';
      }
      hToast('已删除历史记录');
      await render();
      return true;
    } catch (e) {
      hToast('删除失败：' + e.message);
      return false;
    }
  }

  function bindActions(box) {
    box.querySelectorAll('[data-hist-view]').forEach((b) => b.addEventListener('click', () => loadDetail(b.dataset.histView)));
    box.querySelectorAll('[data-hist-import]').forEach((b) => b.addEventListener('click', () => importAsDraft(b.dataset.histImport)));
    box.querySelectorAll('[data-hist-del]').forEach((b) => b.addEventListener('click', () => removeHistory(b.dataset.histDel)));
    box.querySelectorAll('[data-hist-import-detail]').forEach((b) => b.addEventListener('click', () => importAsDraft(b.dataset.histImportDetail)));
  }

  /** 页面入口：app.js 历史 tab 切换时调用。 */
  async function render() {
    const box = document.getElementById('history-result');
    if (!box) return;
    if (window.AuthUI && typeof window.AuthUI.isAuthenticated === 'function' && !window.AuthUI.isAuthenticated()) {
      box.innerHTML = loginPrompt();
      return;
    }
    box.innerHTML = '<div class="card"><div class="loading">读取历史记录中…</div></div>';
    try {
      const r = await request('/history');
      if (!r.ok) throw new Error(r.message || '读取失败');
      box.innerHTML = renderList(r.items);
      bindActions(box);
      if (STATE.selectedId && (r.items || []).some((x) => x.id === STATE.selectedId)) {
        await loadDetail(STATE.selectedId);
      }
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="empty">${e.message === '请先登录' ? '请先登录' : '读取失败：' + hEsc(e.message)}</div></div>`;
    }
  }

  window.HistoryUI = { render, renderList, renderDetail, loadDetail, importAsDraft, removeHistory };
})();

/* 草稿箱：列表 / 新建 / 行编辑 / 保存 / 删除 / 从历史快照导入 */
(function () {
  'use strict';

  const STATE = { items: [], editing: null, rows: [] };
  const TIER_LABELS = { chong: '冲', wen: '稳', bao: '保' };
  const TIER_ORDER = ['chong', 'wen', 'bao', ''];

  const dEsc = (v) => (typeof esc === 'function' ? esc(v) : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const dToast = (msg) => { if (typeof toast === 'function') toast(msg); };
  const dEmpty = (icon, text) => (typeof emptyBox === 'function'
    ? emptyBox(icon, text)
    : `<div class="empty"><span class="big">${icon}</span>${text}</div>`);

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

  /**
   * §3.2 映射表：生成快照 slots[i] → DraftRow。
   * 概率 / 位次 / 最低分 / 选科 / 年份等字段一律不进草稿行，原值仍留在历史快照里。
   */
  function mapSlotsToDraftRows(slots) {
    return (Array.isArray(slots) ? slots : []).map((s, i) => {
      const reason = (Array.isArray(s.reason) ? s.reason : []).join(' ');
      const batch = s.batch ? `批次：${s.batch}` : '';
      return {
        order: i + 1,
        school: s.school?.name || '',
        group: s.group || '',
        major: s.major || '',
        obey: '是',
        tier: s.tier || '',
        tierLabel: s.tierLabel || TIER_LABELS[s.tier] || '',
        note: [reason, batch].filter(Boolean).join(' '),
      };
    });
  }

  /** 把任意来源的行规整为合法 DraftRow（编辑保存前统一走这里）。 */
  function normalizeRow(row, i) {
    const tier = TIER_ORDER.includes(row?.tier) ? row.tier : '';
    return {
      order: Number(row?.order) || i + 1,
      school: String(row?.school || ''),
      group: String(row?.group || ''),
      major: String(row?.major || ''),
      obey: row?.obey === '否' ? '否' : '是',
      tier,
      tierLabel: row?.tierLabel || TIER_LABELS[tier] || '',
      note: String(row?.note || ''),
    };
  }

  function groupLabel(row) {
    return row.group ? `${row.school || ''} · ${row.group}`.trim() : (row.school || '院校未填写');
  }

  function renderList(items) {
    STATE.items = Array.isArray(items) ? items : [];
    const rows = STATE.items.map((d) => `<tr>
      <td><b>${dEsc(d.name || '未命名草稿')}</b></td>
      <td class="num">${(d.rows || []).length}</td>
      <td>${dEsc(shortTime(d.updatedAt))}</td>
      <td>${d.sourceHistoryId ? '生成方案导入' : '手工新建'}</td>
      <td><div class="row-actions">
        <button class="btn sm" data-draft-edit="${dEsc(d.id)}">编辑</button>
        <button class="btn sm danger" data-draft-del="${dEsc(d.id)}">删除</button>
      </div></td>
    </tr>`).join('');

    return `<div class="page-head">
        <div><h1>草稿箱</h1><p>手动模拟志愿填报；可从历史记录导入方案快照后继续编辑</p></div>
        <span class="status-pill">${STATE.items.length} 份草稿</span>
      </div>
      <div class="card">
        <div class="list-tools">
          <button class="btn primary" id="draft-new">＋ 新建草稿</button>
        </div>
      </div>
      <div class="card">
        ${STATE.items.length ? `<div class="tablewrap"><table>
          <thead><tr><th>草稿名称</th><th>条数</th><th>最近保存</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
          : dEmpty('📝', '还没有草稿，点「新建草稿」或从填报历史记录导入')}
      </div>`;
  }

  /** 编辑表格列严格为：序号 / 院校专业组 / 专业 / 服从调剂 / 梯度 / 备注 / 操作。 */
  function renderEditor(draft) {
    const box = document.getElementById('draft-editor');
    if (!box) return;
    if (!draft) {
      box.innerHTML = '<div class="card"><div class="hint">选择一份草稿点击「编辑」，或点击「新建草稿」开始填写。</div></div>';
      return;
    }
    STATE.editing = draft;
    STATE.rows = (draft.rows || []).map((r, i) => normalizeRow(r, i));
    const rowsHtml = STATE.rows.map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td><input class="inline-edit" data-row="${i}" data-field="school" value="${dEsc(r.school)}" placeholder="院校名称">
        <div style="height:4px"></div>
        <input class="inline-edit" data-row="${i}" data-field="group" value="${dEsc(r.group)}" placeholder="专业组招生（未细分）"></td>
      <td><input class="inline-edit" data-row="${i}" data-field="major" value="${dEsc(r.major)}" placeholder="专业（可留空）"></td>
      <td><select class="inline-edit" data-row="${i}" data-field="obey">
        <option value="是"${r.obey === '是' ? ' selected' : ''}>是</option>
        <option value="否"${r.obey === '否' ? ' selected' : ''}>否</option>
      </select></td>
      <td><select class="inline-edit" data-row="${i}" data-field="tier">
        ${TIER_ORDER.map((t) => `<option value="${t}"${r.tier === t ? ' selected' : ''}>${TIER_LABELS[t] || '未设置'}</option>`).join('')}
      </select></td>
      <td><input class="inline-edit" data-row="${i}" data-field="note" value="${dEsc(r.note)}" placeholder="备注"></td>
      <td><div class="row-actions">
        <button class="btn xs" data-draft-row-up="${i}" title="上移">↑</button>
        <button class="btn xs" data-draft-row-down="${i}" title="下移">↓</button>
        <button class="btn xs danger" data-draft-row-del="${i}" title="删除该行">✕</button>
      </div></td>
    </tr>`).join('');

    box.innerHTML = `<div class="card">
      <div class="filters" style="align-items:center">
        <label class="grow">草稿名称 <input id="draft-name" value="${dEsc(draft.name || '普通类平行志愿')}" placeholder="如：普通类平行志愿"></label>
        <button class="btn" id="draft-add-row">＋ 添加一行</button>
        <button class="btn primary" id="draft-save">保存</button>
        <button class="btn" id="draft-cancel">取消编辑</button>
      </div>
      <div class="hint">院校专业组列可填院校与专业组；专业组留空表示按专业组招生。梯度可留空由自己决定。</div>
      <div class="tablewrap" style="margin-top:10px"><table>
        <thead><tr><th>序号</th><th>院校专业组</th><th>专业</th><th>服从调剂</th><th>梯度</th><th>备注</th><th>操作</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="7">暂无行，点「添加一行」开始填写</td></tr>'}</tbody>
      </table></div>
    </div>`;

    box.querySelectorAll('[data-field]').forEach((input) => {
      const apply = () => {
        const i = Number(input.dataset.row);
        const field = input.dataset.field;
        if (!STATE.rows[i] || !field) return;
        STATE.rows[i][field] = input.value;
        if (field === 'tier') STATE.rows[i].tierLabel = TIER_LABELS[input.value] || '';
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    });
    box.querySelectorAll('[data-draft-row-up]').forEach((b) => b.addEventListener('click', () => moveRow(Number(b.dataset.draftRowUp), -1)));
    box.querySelectorAll('[data-draft-row-down]').forEach((b) => b.addEventListener('click', () => moveRow(Number(b.dataset.draftRowDown), 1)));
    box.querySelectorAll('[data-draft-row-del]').forEach((b) => b.addEventListener('click', () => removeRow(Number(b.dataset.draftRowDel))));
    box.querySelector('#draft-add-row')?.addEventListener('click', addRow);
    box.querySelector('#draft-save')?.addEventListener('click', saveFromEditor);
    box.querySelector('#draft-cancel')?.addEventListener('click', () => {
      STATE.editing = null; STATE.rows = []; renderEditor(null);
    });
  }

  function renumber() {
    STATE.rows = STATE.rows.map((r, i) => normalizeRow(r, i));
  }

  function addRow() {
    STATE.rows.push(normalizeRow({}, STATE.rows.length));
    renumber();
    renderEditor(STATE.editing);
  }

  function removeRow(i) {
    STATE.rows.splice(i, 1);
    renumber();
    renderEditor(STATE.editing);
  }

  function moveRow(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= STATE.rows.length) return;
    [STATE.rows[i], STATE.rows[j]] = [STATE.rows[j], STATE.rows[i]];
    renumber();
    renderEditor(STATE.editing);
  }

  /** 直接保存一条草稿（新建用 POST，编辑用 PUT），供按钮与测试共用。 */
  async function saveDraft(id, payload) {
    const rows = (payload?.rows || []).map((r, i) => normalizeRow(r, i));
    const body = { name: payload?.name || '普通类平行志愿', rows };
    try {
      const r = id
        ? await request('/drafts/' + encodeURIComponent(id), body, { method: 'PUT' })
        : await request('/drafts', { ...body, sourceHistoryId: payload?.sourceHistoryId || null }, { method: 'POST' });
      if (!r.ok) throw new Error(r.message || '保存失败');
      dToast(id ? '草稿已保存' : '草稿已新建');
      await render();
      return r.item;
    } catch (e) {
      dToast('保存失败：' + e.message);
      return null;
    }
  }

  function saveFromEditor() {
    if (!STATE.editing) return Promise.resolve(null);
    const nameInput = document.getElementById('draft-name');
    const name = nameInput?.value || STATE.editing.name;
    return saveDraft(STATE.editing.id || null, { name, rows: STATE.rows });
  }

  async function newDraft() {
    const draft = { id: null, name: '普通类平行志愿', rows: [normalizeRow({}, 0)] };
    renderEditor(draft);
  }

  async function editDraft(id) {
    try {
      const r = await request('/drafts/' + encodeURIComponent(id));
      if (!r.ok) throw new Error(r.message || '读取失败');
      renderEditor(r.item);
    } catch (e) { dToast('读取草稿失败：' + e.message); }
  }

  async function deleteDraft(id) {
    if (typeof confirm === 'function' && !confirm('确定删除这份草稿？')) return false;
    try {
      const r = await request('/drafts/' + encodeURIComponent(id), null, { method: 'DELETE' });
      if (!r.ok) throw new Error(r.message || '删除失败');
      if (STATE.editing?.id === id) { STATE.editing = null; STATE.rows = []; renderEditor(null); }
      dToast('已删除草稿');
      await render();
      return true;
    } catch (e) {
      dToast('删除失败：' + e.message);
      return false;
    }
  }

  function loginPrompt() {
    return `<div class="page-head"><div><h1>草稿箱</h1><p>登录后新建与保存草稿</p></div></div>
      <div class="card"><div class="empty"><span class="big">🔒</span>请先登录后再使用草稿箱</div></div>`;
  }

  /** 页面入口：app.js 草稿 tab 切换时调用。 */
  async function render() {
    const box = document.getElementById('drafts-result');
    if (!box) return;
    if (window.AuthUI && typeof window.AuthUI.isAuthenticated === 'function' && !window.AuthUI.isAuthenticated()) {
      box.innerHTML = loginPrompt();
      return;
    }
    box.innerHTML = '<div class="card"><div class="loading">读取草稿箱中…</div></div>';
    try {
      const r = await request('/drafts');
      if (!r.ok) throw new Error(r.message || '读取失败');
      const editorHtml = box.querySelector('#draft-editor')?.innerHTML || '';
      box.innerHTML = renderList(r.items) + '<div id="draft-editor"></div>';
      bindListActions(box);
      const editorBox = document.getElementById('draft-editor');
      if (editorBox) editorBox.innerHTML = editorHtml || '<div class="card"><div class="hint">选择一份草稿点击「编辑」，或点击「新建草稿」开始填写。</div></div>';
      if (STATE.editing) renderEditor(STATE.editing);
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="empty">${e.message === '请先登录' ? '请先登录' : '读取失败：' + dEsc(e.message)}</div></div>`;
    }
  }

  function bindListActions(box) {
    box.querySelector('#draft-new')?.addEventListener('click', newDraft);
    box.querySelectorAll('[data-draft-edit]').forEach((b) => b.addEventListener('click', () => editDraft(b.dataset.draftEdit)));
    box.querySelectorAll('[data-draft-del]').forEach((b) => b.addEventListener('click', () => deleteDraft(b.dataset.draftDel)));
  }

  window.DraftUI = {
    render, renderList, renderEditor, mapSlotsToDraftRows, normalizeRow, groupLabel,
    newDraft, editDraft, saveDraft, deleteDraft, addRow, removeRow, moveRow, STATE,
  };
})();

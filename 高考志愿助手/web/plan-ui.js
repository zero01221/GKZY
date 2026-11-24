/* =================================================================
 * 追加模块：志愿参考 / 资料库 / AI 助手
 * ================================================================= */

/* ---------------- 通用 ---------------- */
const SUBJECT_LIST = ['物理', '化学', '生物', '思想政治', '历史', '地理', '技术'];
const LEVEL_TAG = (s) => (s.f985 ? '<span class="tag t985">985</span>' : s.f211 ? '<span class="tag t211">211</span>' : s.dual ? `<span class="tag tdual">${esc(s.dual)}</span>` : '');
const tierColor = (t) => (t === 'chong' ? 'var(--red)' : t === 'wen' ? 'var(--amber)' : 'var(--green)');

/* =================================================================
 * 一、志愿参考
 * ================================================================= */
const PLAN = { slots: [], meta: null, dq: null };

function renderSubjectChips() {
  const box = document.getElementById('p-subjects');
  if (!box) return;
  box.innerHTML = SUBJECT_LIST.map((s) => `<button type="button" class="chip" data-sub="${s}">${s}</button>`).join('');
  box.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    b.classList.toggle('on');
  }));
}
const selectedSubjects = () => [...document.querySelectorAll('#p-subjects .chip.on')].map((b) => b.dataset.sub);

async function runPlan() {
  const pid = document.getElementById('p-province').value;
  const type = document.getElementById('p-type').value;
  const mode = document.getElementById('p-mode').value;
  const score = document.getElementById('p-score').value;
  const rank = document.getElementById('p-rank').value;
  const major = document.getElementById('p-major').value.trim();
  const strategy = document.getElementById('p-strategy').value;
  const total = document.getElementById('p-total').value || 80;
  const ratiosRaw = document.getElementById('p-ratios').value || '30:40:30';
  const box = document.getElementById('p-result');

  if (!pid) return toast('请选择生源省份');
  if (!type) return toast('请选择科类');
  if (mode === 'score' && !score) return toast('请输入分数');
  if (mode === 'rank' && !rank) return toast('请输入位次');

  const parts = ratiosRaw.split(/[:：/]/).map((x) => Number(x.trim()));
  const ratios = (parts.length === 3 && parts.every(Number.isFinite) && parts.reduce((a, b) => a + b, 0) > 0)
    ? { chong: parts[0] / 100, wen: parts[1] / 100, bao: parts[2] / 100 } : null;

  box.innerHTML = loading('正在生成志愿参考…（首次某省份可能需要联网取数）');
  try {
    const r = await api('/plan', {
      provinceId: pid, type, strategy, total,
      subjects: selectedSubjects().join(','),
      score: mode === 'score' ? score : '', rank: mode === 'rank' ? rank : '',
      major, ratios: ratios ? JSON.stringify(ratios) : '',
    });
    if (!r.ok) { box.innerHTML = emptyBox('⚠️', esc(r.message)); return; }
    PLAN.slots = r.slots;
    PLAN.meta = r.meta;
    PLAN.dq = r.dataQuality || null;
    renderPlan();
  } catch (e) {
    box.innerHTML = emptyBox('⚠️', '生成失败：' + esc(e.message));
  }
}

function renderPlan() {
  const box = document.getElementById('p-result');
  const m = PLAN.meta;
  if (!m) return;
  const g = { 冲: 0, 稳: 0, 保: 0 };
  PLAN.slots.forEach((s) => { g[s.tierLabel]++; });
  // 统一数据快照条 + 打印页脚同步（脱离工具后仍可判断数据时效）
  if (typeof QualityUI !== 'undefined') QualityUI.setSnapshot(PLAN.dq);
  const snapBar = (typeof QualityUI !== 'undefined') ? QualityUI.snapshotBar(PLAN.dq) : '';

  box.innerHTML = `
  ${snapBar}
  <div class="card">
    <div class="filters" style="align-items:center">
      <h2 class="h2">志愿参考 <span class="pill">${PLAN.slots.length} 条</span></h2>
      <span class="tag">${esc(m.province)} · ${esc(m.type)}</span>
      ${m.score ? `<span class="tag">分数 <b>${m.score}</b></span>` : ''}
      <span class="tag">位次 <b>${fmt(m.rank)}</b> <span class="meta">(${esc(m.rankSourceLabel || m.rankSource || '')})</span></span>
      ${m.batchLine ? `<span class="tag">省控线 <b>${m.batchLine}</b> · 线差 <b>${m.userDiff > 0 ? '+' : ''}${m.userDiff}</b></span>` : ''}
      <span class="tag">${esc(m.strategyLabel)}</span>
      ${m.subjects && m.subjects.length ? `<span class="tag">选科 ${esc(m.subjects.join('/'))}</span>` : ''}
      ${m.major ? `<span class="tag">意向 ${esc(m.major)}</span>` : ''}
      <div class="spacer"></div>
      <span class="tag" style="background:#fee2e2;color:#b91c1c">冲 ${g['冲']}</span>
      <span class="tag" style="background:#ffedd5;color:#c2410c">稳 ${g['稳']}</span>
      <span class="tag" style="background:#dcfce7;color:#166534">保 ${g['保']}</span>
      <button class="btn sm" id="p-export">导出 CSV</button>
      <button class="btn sm" id="p-print">打印</button>
    </div>
    <div class="hint">
      参考年份 ${m.refYears.join(' / ')}，候选 ${fmt(m.candidates)} 个招生单元。
      ${m.hasMajorData ? `已接入 <b>${m.majorDataYear} 年专业分数线</b>，条目精确到专业。` : '暂无该省专业分数线索引，条目为「院校专业组」粒度；可在「数据管理」同步专业数据后重新生成。'}
      可拖动或用 ↑↓ 调整顺序，点 ✕ 删除。
    </div>
  </div>
  <div class="card">
    <div class="tablewrap"><table class="plan-table">
      <thead><tr>
        <th style="width:44px">序</th><th style="width:52px">档</th><th>院校</th><th>专业组</th>
        <th>推荐专业</th><th>选科要求</th><th>概率</th><th>三年位次</th><th style="width:76px">调整</th>
      </tr></thead>
      <tbody>${PLAN.slots.map((s, i) => planRow(s, i)).join('')}</tbody>
    </table></div>
  </div>`;

  bindPlanActions();
  document.getElementById('p-export')?.addEventListener('click', exportPlan);
  document.getElementById('p-print')?.addEventListener('click', () => window.print());
  refreshAiProfile();
}

function planRow(s, i) {
  const spark = (s.hist || []).length > 1
    ? `<svg width="70" height="20" viewBox="0 0 70 20">${(() => {
        const rs = s.hist.map((x) => x.rank).filter((x) => x > 0);
        if (rs.length < 2) return '';
        const lo = Math.min(...rs), hi = Math.max(...rs);
        const pts = s.hist.map((x, k) => `${(k / (s.hist.length - 1)) * 66 + 2},${18 - ((x.rank - lo) / Math.max(1, hi - lo)) * 16}`).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="${tierColor(s.tier)}" stroke-width="1.5"/>`;
      })()}</svg>` : '';
  return `<tr data-i="${i}">
    <td>${s.order}</td>
    <td><span class="tag" style="background:${tierColor(s.tier)};color:#fff">${s.tierLabel}</span></td>
    <td><b>${esc(s.school.name)}</b> ${LEVEL_TAG(s.school)}<div class="meta">${esc(s.school.province || '')}${s.school.city ? ' · ' + esc(s.school.city) : ''}${s.nationalCode ? ' · 院校代码 ' + s.nationalCode : ''}</div></td>
    <td>${esc(s.group || '—')}<div class="meta">${esc(s.batch || '')}</div></td>
    <td>${s.major ? `<b>${esc(s.major)}</b>${s.majorCode ? `<div class="meta">专业代码 ${esc(s.majorCode)}</div>` : ''}` : '<span class="meta">专业组招生（未细分）</span>'}
        ${s.majorOptions && s.majorOptions.length > 1 ? `<div class="meta">组内 ${s.majorOptions.length} 个专业可选</div>` : ''}</td>
    <td>${esc(s.subjectReq || '不限')}</td>
    <td class="num"><b style="color:${tierColor(s.tier)}">${s.probability}%</b></td>
    <td>${spark}<div class="meta">${s.latest ? `${s.latest.year}: ${s.latest.min}分/${fmt(s.latest.rank)}位` : '—'}</div></td>
    <td>
      <button class="btn xs" data-up="${i}" title="上移">↑</button>
      <button class="btn xs" data-down="${i}" title="下移">↓</button>
      <button class="btn xs danger" data-del="${i}" title="删除">✕</button>
    </td>
  </tr>`;
}

function bindPlanActions() {
  const box = document.getElementById('p-result');
  box.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => moveSlot(Number(b.dataset.up), -1)));
  box.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => moveSlot(Number(b.dataset.down), 1)));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { PLAN.slots.splice(Number(b.dataset.del), 1); renumber(); renderPlan(); }));
}
function moveSlot(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= PLAN.slots.length) return;
  [PLAN.slots[i], PLAN.slots[j]] = [PLAN.slots[j], PLAN.slots[i]];
  renumber(); renderPlan();
}
function renumber() { PLAN.slots.forEach((s, i) => { s.order = i + 1; s.tierLabel = s.tierLabel || (s.tier === 'chong' ? '冲' : s.tier === 'wen' ? '稳' : '保'); }); }

function exportPlan() {
  if (!PLAN.slots.length) return toast('还没有生成方案');
  const m = PLAN.meta || {};
  const head = ['序号', '梯度', '院校', '院校代码', '专业组', '批次', '推荐专业', '专业代码', '选科要求', '录取概率(%)', '最新最低分', '最新最低位次', '所在省', '理由'];
  const rows = [head];
  for (const s of PLAN.slots) {
    rows.push([s.order, s.tierLabel, s.school.name, s.nationalCode || '', s.group || '', s.batch || '',
      s.major || '', s.majorCode || '', s.subjectReq || '', s.probability,
      s.latest ? s.latest.min : '', s.latest ? s.latest.rank : '', s.school.province || '', (s.reason || []).join(' ')]);
  }
  rows.push([]);
  rows.push(['生成信息', `${m.province} ${m.type} ${m.score ? m.score + '分' : ''} 位次${m.rank} 线差${m.userDiff} 策略${m.strategyLabel} 参考年份${(m.refYears || []).join('/')}`]);
  rows.push(['数据快照', snapshotForExport(PLAN.dq)]);
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`高考志愿参考_${m.province || ''}${m.score ? m.score + '分' : ''}_${new Date().toISOString().slice(0, 10)}.csv`, csv);
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* =================================================================
 * 三、AI 助手
 * ================================================================= */
const AI = {
  messages: [],
  profile: null,
  cfg: (() => {
    try { return JSON.parse(localStorage.getItem('gk_ai_cfg') || '{}'); } catch { return {}; }
  })(),
  busy: false,
};

function aiCfgSave() {
  AI.cfg = {
    base: document.getElementById('ai-base').value.trim() || 'https://api.deepseek.com/v1',
    key: document.getElementById('ai-key').value.trim(),
    model: document.getElementById('ai-model').value.trim() || 'deepseek-chat',
  };
  localStorage.setItem('gk_ai_cfg', JSON.stringify(AI.cfg));
  toast('已保存到本机浏览器');
}
function aiCfgLoad() {
  document.getElementById('ai-base').value = AI.cfg.base || 'https://api.deepseek.com/v1';
  document.getElementById('ai-key').value = AI.cfg.key || '';
  document.getElementById('ai-model').value = AI.cfg.model || 'deepseek-chat';
}

function refreshAiProfile() {
  const m = PLAN.meta;
  if (!m) return;
  AI.profile = {
    省份: m.province, 科类: m.type, 选科: m.subjects || [],
    分数: m.score, 位次: m.rank, 批次线: m.batchLine, 线差: m.userDiff,
    意向专业: m.major || '', 填报策略: m.strategyLabel,
    方案条数: PLAN.slots.length,
    参考年份: (m.refYears || []).join('/'),
    // 服务端 /api/ai/chat 还会注入 profile.dataQuality（逐表截止年份）；
    // 这里给模型一句可直接引用的中文约束，避免把灰数据数值说成当年官方数据。
    数据时效提醒: PLAN.dq
      ? `数据版本 ${PLAN.dq.dataVersion || '未标注'}，完整基准年 ${PLAN.dq.baselineYear || '未标注'}；${PLAN.dq.snapshotText || ''}；◐ 部分/抽样、≈ 估算拟合、ⓘ 回填或图片缺口、⚠ 历史回退 的数值不得说成当年官方数据`
      : '数据版本未标注，勿将历史分数与位次当作当年数据',
    已生成方案前10条: PLAN.slots.slice(0, 10).map((s) => `${s.tierLabel}｜${s.school.name}｜${s.major || s.group || ''}｜概率${s.probability}%`),
  };
}

function aiRenderMessages() {
  const box = document.getElementById('ai-messages');
  if (!AI.messages.length) {
    box.innerHTML = `<div class="empty" style="padding:26px"><span class="big">💬</span>
      先在上方「API 设置」里填入 Key，然后开始对话。<br>
      <span class="meta">例如：河北物理类 600 分，家里想让我学计算机，但我想学新闻，怎么选？</span></div>`;
    return;
  }
  box.innerHTML = AI.messages.map((m, i) => `
    <div class="msg ${m.role}">
      <div class="msg-role">${m.role === 'user' ? '我' : 'AI 顾问'}</div>
      <div class="msg-body" id="msg-${i}">${renderMarkdown(m.content)}</div>
    </div>`).join('');
  box.scrollTop = box.scrollHeight;
}

/** 极简 markdown 渲染（标题/加粗/列表/换行），并做 HTML 转义 */
function renderMarkdown(t) {
  let s = esc(t || '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/^###\s?(.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^##\s?(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  s = s.replace(/\n{2,}/g, '</p><p>');
  return `<p>${s}</p>`.replace(/<p>\s*<\/p>/g, '');
}

async function aiSend(text) {
  if (AI.busy) return toast('正在回答中，请稍候');
  const input = document.getElementById('ai-input');
  const content = (text || input.value || '').trim();
  if (!content) return;
  if (!AI.cfg.key) { document.getElementById('ai-settings').style.display = ''; return toast('请先填写 API Key'); }

  AI.messages.push({ role: 'user', content });
  input.value = '';
  AI.busy = true;
  AI.messages.push({ role: 'assistant', content: '' });
  aiRenderMessages();

  const idx = AI.messages.length - 1;
  const body = document.getElementById('msg-' + idx);
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBase: AI.cfg.base, apiKey: AI.cfg.key, model: AI.cfg.model,
        messages: AI.messages.slice(0, -1), profile: AI.profile, stream: true,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let acc = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop();
      for (const b of blocks) {
        for (const line of b.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.error) throw new Error(j.error);
            const d = j.choices?.[0]?.delta?.content;
            if (d) { acc += d; if (body) body.innerHTML = renderMarkdown(acc); document.getElementById('ai-messages').scrollTop = 1e9; }
          } catch { /* 忽略单块解析错误 */ }
        }
      }
    }
    AI.messages[idx].content = acc || '（未收到内容）';
  } catch (e) {
    AI.messages[idx].content = `⚠️ 请求失败：${e.message}`;
  } finally {
    AI.busy = false;
    aiRenderMessages();
  }
}

async function aiExtract() {
  if (!AI.messages.length) return toast('还没有对话内容');
  if (!AI.cfg.key) return toast('请先填写 API Key');
  const box = document.getElementById('ai-result');
  box.innerHTML = loading('正在整理建议…');
  try {
    const pr = await api('/ai/extract-prompt');
    const messages = [...AI.messages, { role: 'user', content: pr.prompt }];
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiBase: AI.cfg.base, apiKey: AI.cfg.key, model: AI.cfg.model, messages, profile: AI.profile, stream: false }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.message);
    const raw = String(j.content || '').replace(/```json|```/g, '').trim();
    let data;
    try { data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); }
    catch { box.innerHTML = emptyBox('📄', '模型未返回结构化结果，以下是原始回答：<pre style="text-align:left;white-space:pre-wrap">' + esc(j.content) + '</pre>'); return; }
    renderAiAdvice(data);
  } catch (e) { box.innerHTML = emptyBox('⚠️', '整理失败：' + esc(e.message)); }
}

function renderAiAdvice(d) {
  const box = document.getElementById('ai-result');
  const items = Array.isArray(d.items) ? d.items : [];
  const tier = { 冲: 'chong', 稳: 'wen', 保: 'bao' };
  const p = d.profile || {};
  box.innerHTML = `
  <div class="card">
    <div class="filters" style="align-items:center">
      <h2 class="h2">AI 志愿建议 <span class="pill">${items.length} 条</span></h2>
      ${p.province ? `<span class="tag">${esc(p.province)} · ${esc(p.type || '')}</span>` : ''}
      ${p.score ? `<span class="tag">分数 ${esc(p.score)}</span>` : ''}
      ${p.rank ? `<span class="tag">位次 ${esc(p.rank)}</span>` : ''}
      <div class="spacer"></div>
      <button class="btn sm" id="ai-export">导出 CSV</button>
    </div>
    ${d.summary ? `<div class="hint" style="font-size:13.5px">${esc(d.summary)}</div>` : ''}
  </div>
  <div class="cards">
    ${items.map((x) => `<div class="ccard" style="cursor:default">
      <div class="rl1"><span class="tag" style="background:${tierColor(tier[x.tier] || 'wen')};color:#fff">${esc(x.tier || '')}</span>
      <b>${esc(x.school || '')}</b></div>
      <div class="m" style="font-size:13px;color:var(--ink2);margin-top:6px">${esc(x.major || '')}</div>
      <div class="m">${esc(x.reason || '')}</div>
      ${x.note ? `<div class="m" style="color:#b45309">${esc(x.note)}</div>` : ''}
    </div>`).join('')}
  </div>`;
  document.getElementById('ai-export')?.addEventListener('click', () => {
    const rows = [['梯度', '院校', '专业', '理由', '提示']];
    items.forEach((x) => rows.push([x.tier || '', x.school || '', x.major || '', x.reason || '', x.note || '']));
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(`AI志愿建议_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  });
}

/* =================================================================
 * 绑定
 * ================================================================= */
function bindExtra() {
  renderSubjectChips();

  // 志愿参考
  document.getElementById('p-province').addEventListener('change', () => refreshDict('p'));
  document.getElementById('p-mode').addEventListener('change', () => {
    const m = document.getElementById('p-mode').value;
    document.getElementById('p-score-wrap').style.display = m === 'score' ? '' : 'none';
    document.getElementById('p-rank-wrap').style.display = m === 'rank' ? '' : 'none';
  });
  document.getElementById('p-run').addEventListener('click', runPlan);
  document.getElementById('p-clear').addEventListener('click', () => { PLAN.slots = []; PLAN.meta = null; document.getElementById('p-result').innerHTML = ''; });

  // v3：旧「一分一段/代码」资料库页已整页删除，其 #res-* / #rk-* / #cd-* 绑定
  // 必须一并移除，否则 null.addEventListener 会中断后续 AI 等全部绑定。

  // AI
  aiCfgLoad();
  document.getElementById('ai-settings-toggle').addEventListener('click', () => {
    const el = document.getElementById('ai-settings');
    el.style.display = el.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('ai-save').addEventListener('click', aiCfgSave);
  document.getElementById('ai-send').addEventListener('click', () => aiSend());
  document.getElementById('ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiSend(); }
  });
  document.getElementById('ai-clear').addEventListener('click', () => { AI.messages = []; aiRenderMessages(); document.getElementById('ai-result').innerHTML = ''; });
  document.getElementById('ai-extract').addEventListener('click', aiExtract);
  api('/ai/skill').then((r) => {
    const b = document.getElementById('ai-skill-badge');
    if (r.available) b.textContent = `技能已加载 · ${r.title || ''}`;
    else { b.textContent = '技能未加载'; b.style.background = '#fee2e2'; b.style.color = '#b91c1c'; }
  }).catch(() => {});
  aiRenderMessages();
}

/* ---------------- 启动 ---------------- */
let extraBooted = false;
function bootExtra() {
  if (extraBooted) return;
  extraBooted = true;
  try { bindExtra(); } catch (e) { console.error('扩展模块初始化失败', e); }
}
document.addEventListener('app-ready', bootExtra);
// 兜底：若 app.js 已经初始化完成（脚本顺序变化等），延迟后仍尝试一次
setTimeout(() => { if (!extraBooted) bootExtra(); }, 2500);

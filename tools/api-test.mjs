/**
 * 后端 API 验收测试
 *
 * 覆盖三大功能 + 边界场景，会自动拉起本地服务，跑完自动关闭。
 * 用法：node tools/api-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..', '高考志愿助手');
const PORT = 8798;
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const j = async (p) => { const r = await fetch(B + p); return r.json(); };
const head = (t) => console.log(`\n──── ${t} ────`);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`); ok ? pass++ : fail++; };

let AUTH_COOKIE = '';
const reqJson = async (p, opts = {}, cookie = '') => {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(B + p, { ...opts, headers });
  let body = {};
  try { body = await r.json(); } catch { /* 保留空对象 */ }
  return { status: r.status, body, headers: r.headers };
};
const postJson = (p, body, cookie = '') => reqJson(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}, cookie);
const authed = (p, opts = {}) => reqJson(p, opts, AUTH_COOKIE);
const postAuthed = (p, body) => postJson(p, body, AUTH_COOKIE);

async function startServer() {
  const child = spawn(process.execPath, [path.join(APP, 'server', 'server.mjs'), '--port', String(PORT), '--no-index'], {
    cwd: APP, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const r = await fetch(`${B}/api/meta`, { signal: AbortSignal.timeout(3000) }); if (r.ok) return child; } catch { /* 继续等 */ }
  }
  child.kill();
  throw new Error('本地服务启动超时');
}

(async () => {
  const server = await startServer();
  try {
    head('F0 · 基础信息');
    const meta = await j('/api/meta');
    check('院校库加载', meta.schoolCount > 2900, `${meta.schoolCount} 所`);
    check('大学环境数据加载', meta.collegeCount > 4000, `${meta.collegeCount} 所`);
    check('分数线索引存在', meta.indexFiles > 0, `${meta.indexFiles} 个省-年`);

    head('F1 · 分数线查询');
    const sc = await j('/api/schools?q=' + encodeURIComponent('中山大学') + '&size=3');
    check('院校检索', sc.items?.[0]?.name === '中山大学', `total=${sc.total}`);
    const pv = await j('/api/score/province?schoolId=104&provinceId=44');
    check('院校投档线', (pv.items || []).length > 0, `${pv.items.length} 条 local=${pv.local}`);
    const sp = await j('/api/score/special?schoolId=104&provinceId=44&year=2025');
    if (sp.items.length) {
      check('专业分数线（联网）', true, `${sp.items.length} 条`);
      const spf = await j('/api/score/special?schoolId=104&provinceId=44&year=2025&major=' + encodeURIComponent('计算机'));
      check('专业关键词过滤', spf.items.length > 0 && spf.items.length < sp.items.length, `${spf.items.length} 条`);
      const tr = await j('/api/score/trend?schoolId=104&provinceId=44');
      check('历年趋势', (tr.series || []).length > 0, `${tr.series.length} 个年份`);
    } else {
      // 上游限流属于「优雅降级」，只要给出明确提示即视为通过
      check('专业分数线（上游限流时优雅降级）', !!sp.warning, sp.warning || '无提示');
      check('专业关键词过滤', true, '跳过（上游限流）');
      check('历年趋势', true, '跳过（上游限流）');
    }

    head('F2 · 大学环境');
    const cc = await j('/api/colleges?q=' + encodeURIComponent('武汉'));
    check('环境检索', (cc.items || []).length > 0, `命中 ${cc.items.length} 所`);
    const cd = await j('/api/colleges/detail?school=' + encodeURIComponent('武汉大学'));
    check('环境详情', cd.ok && cd.detail.groups.length > 20, `${cd.detail.resp} 份问卷 / ${cd.detail.groups.length} 个问题`);
    check('原文深链', /cn\.colleges\.chat\/universities\//.test(cd.detail.url), cd.detail.url);

    // ================= 资料库 =================
    head('F4 · 资料库（一分一段表 · 真实数据）');
    const rs = await j('/api/resource/status');
    check('资料库已加载', rs.ok !== false && rs.tables > 0, `${rs.tables} 张表 / ${rs.provinces} 个省`);
    check('来源标注', /GaokaoCompass|eol\.cn|教育在线/.test(rs.source || ''), rs.source);

    const rlist = await j('/api/resource/rank/list');
    check('表清单', Array.isArray(rlist.tables) && rlist.tables.length > 0, `${rlist.tables.length} 组`);
    check('图片发布也如实列出', Array.isArray(rlist.imageOnly), `${rlist.imageOnly?.length || 0} 条`);

    // 广东 2026 物理类 600 分 —— 用真实一分一段表核对
    const rk = await j('/api/resource/rank?provinceId=44&type=' + encodeURIComponent('物理类') + '&score=600');
    check('分数→位次（真实表）', rk.ok && rk.rank > 0, `600 分 -> 位次 ${rk.rank}（${rk.year} ${rk.type}，考生 ${rk.total}）`);
    check('位次落在合理区间', rk.rank > 1000 && rk.rank < rk.total, `1 < ${rk.rank} < ${rk.total}`);
    check('带数据来源链接', /^https?:\/\//.test(rk.url || ''), (rk.url || '').slice(0, 60));

    const rk2 = await j('/api/resource/rank?provinceId=44&type=' + encodeURIComponent('物理类') + '&score=680');
    check('单调性（高分位次更靠前）', rk2.ok && rk2.rank < rk.rank, `680 分 -> ${rk2.rank} < 600 分 -> ${rk.rank}`);

    const rkInv = await j('/api/resource/rank?provinceId=44&type=' + encodeURIComponent('物理类') + '&rank=' + rk.rank);
    check('位次→分数（可逆）', rkInv.ok && Math.abs(rkInv.score - 600) <= 2, `${rk.rank} -> ${rkInv.score} 分`);

    const rtab = await j('/api/resource/rank?provinceId=44&year=2026&type=' + encodeURIComponent('物理类') + '&size=5');
    check('完整表格可分页读取', rtab.ok && rtab.rows.length === 5 && rtab.count > 400, `${rtab.count} 档，返回 ${rtab.rows.length} 行`);
    check('每行含本段与累计', rtab.rows.every((r) => r.length >= 3 && r[0] > 100 && r[1] >= r[2] && r[2] >= 0),
      `[分数, 累计, 本段] = ${JSON.stringify(rtab.rows[0])}`);

    // 交叉校验：本段人数之和 == 末档累计人数
    const rfull = await j('/api/resource/rank?provinceId=44&year=2026&type=' + encodeURIComponent('物理类') + '&size=2000');
    const sumCnt = rfull.rows.reduce((a, r) => a + r[2], 0);
    const endCum = rfull.rows[rfull.rows.length - 1][1];
    check('累计人数自洽（本段和 == 末档累计）', sumCnt === endCum, `${sumCnt} == ${endCum}`);

    head('F5 · 资料库（院校代码 / 专业代码）');
    const codes = await j('/api/resource/codes?schoolId=104&provinceId=44&year=2025');
    check('院校国标代码', codes.nationalCode === '10558', `中山大学 = ${codes.nationalCode}`);
    check('招生计划（含专业代码）', (codes.plan || []).length > 0, `${codes.plan?.length} 条，来源 ${codes.planSource || 'upstream'}`);
    const clinical = (codes.plan || []).find((x) => /临床医学/.test(x.major || ''));
    check('专业代码已补全', !!clinical && /^\d+[A-Z]?$/.test(clinical.majorCode || ''),
      clinical ? `${clinical.major} = ${clinical.majorCode}（${codes.codeType || '省编专业代码'}）` : '未找到临床医学');
    check('招生计划含计划数/学费/学制', (codes.plan || []).some((x) => x.planNum && x.tuition), codes.plan?.[0] ? `${codes.plan[0].planNum} 人 / ${codes.plan[0].tuition} / ${codes.plan[0].length}` : '');
    check('省编专业代码', (codes.special || []).some((x) => x.provinceCode), `${codes.special?.length} 条专业线`);
    const tsinghua = await j('/api/resource/codes?schoolId=140&provinceId=11&year=2025');
    check('清华院校代码', tsinghua.nationalCode === '10003', `清华大学 = ${tsinghua.nationalCode}`);

    head('F6 · 完整志愿方案（专业粒度）');
    const plan = await j('/api/plan?provinceId=44&type=' + encodeURIComponent('物理类') + '&score=600&total=80&strategy=major&subjects=' + encodeURIComponent('物理,化学') + '&major=' + encodeURIComponent('计算机'));
    check('方案生成成功', plan.ok, plan.ok ? '' : plan.message);
    if (plan.ok) {
      check('方案条数 ≈ 80', plan.slots.length >= 60 && plan.slots.length <= 90, `${plan.slots.length} 条`);
      const tiers = {};
      plan.slots.forEach((s) => { tiers[s.tierLabel] = (tiers[s.tierLabel] || 0) + 1; });
      check('含冲稳保三档', tiers['冲'] > 0 && tiers['稳'] > 0 && tiers['保'] > 0, JSON.stringify(tiers));
      // rankSource 已由自由文本升级为枚举 user|official|estimated|none，展示文案在 rankSourceLabel
      check('用真实一分一段定位', plan.meta.rankSource === 'official' && plan.meta.rankEstimated !== true,
        `${plan.meta.rank} (${plan.meta.rankSource} / ${plan.meta.rankSourceLabel || '官方一分一段'})`);
      check('每条含院校国标代码', plan.slots.every((s) => s.nationalCode), `${plan.slots.filter((s) => s.nationalCode).length}/${plan.slots.length}`);
      check('专业粒度生效', plan.slots.filter((s) => s.major).length > 0, `${plan.slots.filter((s) => s.major).length} 条含具体专业`);
      check('专业优先命中意向专业', plan.slots.filter((s) => /计算机/.test(s.major || '')).length > 0,
        plan.slots.filter((s) => s.major).slice(0, 3).map((s) => s.major).join('/'));
      check('选科过滤未放宽', plan.slots.every((s) => !s.subjectReq || !/历史/.test(s.subjectReq)), '无历史类要求混入');
    }
    const planSchool = await j('/api/plan?provinceId=44&type=' + encodeURIComponent('物理类') + '&score=600&total=40&strategy=school');
    check('院校优先：每校至多一个专业组', planSchool.ok && new Set(planSchool.slots.map((s) => s.school.id)).size === planSchool.slots.length,
      `${planSchool.slots?.length} 条 / ${new Set(planSchool.slots.map((s) => s.school.id)).size} 所院校`);

    head('F7 · AI 助手（张雪峰技能）');
    const skill = await j('/api/ai/skill');
    check('技能已内嵌', skill.available && skill.bytes > 5000, `${skill.title} ${skill.bytes} 字`);
    check('技能来源与协议', /github\.com\/alchaincyf/.test(skill.source) && skill.license === 'MIT', `${skill.source} (${skill.license})`);
    const ep = await j('/api/ai/extract-prompt');
    check('结论提炼提示词', ep.ok && ep.prompt.includes('JSON'), `${ep.prompt.length} 字`);
    const noKey = await (await fetch(B + '/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })).json();
    check('未填 Key 时给出提示', noKey.ok === false && /API Key/.test(noKey.message || ''), noKey.message);

    head('F8 · 数据管理数据源');
    const st = await j('/api/status');
    check('数据管理已切到新数据源', st.dataSource?.kind === 'sqlite',
      st.dataSource?.kind === 'sqlite' ? `SQLite ${Math.round(st.dataSource.bytes / 1024 / 1024)} MB，${st.dataSource.years.min}-${st.dataSource.years.max}` : st.dataSource?.kind);
    check('数据源各表行数可用', (st.dataSource?.tables || []).length >= 5,
      (st.dataSource?.tables || []).map((t) => `${t.label}=${t.rows}`).join(' '));
    check('逐年与逐省覆盖可用', (st.dataSource?.byYear || []).length > 0 && (st.dataSource?.provinces || []).length === 31,
      `${st.dataSource?.byYear?.length} 年 / ${st.dataSource?.provinces?.length} 省`);
    const hb = (st.dataSource?.provinces || []).find((p) => p.id === 13);
    // 四态口径：河北 2026 只有抽样投档线/专业分与部分一分一段，
    // 不得再靠 has2026 布尔 OR 渲染成绿色「有 2026」（Q6/C3 根因）。
    check('河北 2026 四态正确：抽样标 ◐、不冒充「有 2026」',
      hb && hb.has2026 === false && hb.has2026Partial === true
        && hb.coverage2026?.school_adm?.state === 'partial'
        && Number(hb.coverage2026?.school_adm?.sampled) === 1,
      hb ? JSON.stringify(hb.coverage2026) : '未找到河北');

    head('F9 · 数据质量（四态 / 新鲜度 / 抽样 / 异常 / 统一信封）');
    const qm = await j('/api/quality/manifest');
    check('数据版本与基准年可读', !!qm.dataVersion && qm.baselineYear === 2025 && qm.gaokaoYear === new Date().getFullYear(),
      `${qm.dataVersion} / 基准 ${qm.baselineYear} / 高考年 ${qm.gaokaoYear}`);
    check('统一图例含五类灰数据标记', (qm.legend || []).length === 5 && qm.legend.every((x) => x.symbol && x.label),
      (qm.legend || []).map((x) => x.symbol + x.label).join(' '));

    const cov = await j('/api/quality/coverage?provinceId=13&year=2026');
    const c26 = Object.fromEntries((cov.cells || []).map((c) => [c.table, c]));
    check('河北 2026 一分一段标 partial（当年非完整基准）', c26.score_range?.state === 'partial', c26.score_range?.state || '—');
    check('河北 2026 投档线 partial + sampled=1（Q6 保留+标注+默认排除）',
      c26.school_adm?.state === 'partial' && Number(c26.school_adm?.sampled) === 1,
      `${c26.school_adm?.state} / sampled=${c26.school_adm?.sampled}`);
    check('河北 2026 专业分同为抽样',
      c26.major_adm?.state === 'partial' && Number(c26.major_adm?.sampled) === 1,
      `${c26.major_adm?.state} / sampled=${c26.major_adm?.sampled}`);
    check('河北 2026 招生计划如实标缺失', c26.plan_code?.state === 'missing', c26.plan_code?.state || '—');
    check('四态标注率 100%（无 unknown）', cov.summary?.labeledRate === 1, String(cov.summary?.labeledRate));

    const fr = await j('/api/quality/freshness?provinceId=13');
    check('按省逐表新鲜度（4 张表各自截止年份，不用全库 MAX）',
      (fr.tables || []).length === 4 && fr.tables.every((t) => 'latestYear' in t),
      (fr.tables || []).map((t) => `${t.table}=${t.latestYear}`).join(' '));
    check('新鲜度横幅含数据版本', /数据版本/.test(fr.bannerText || ''), fr.bannerText?.slice(0, 64));

    const issues = await j('/api/quality/issues?limit=5');
    check('异常清单可查（默认隐藏但质量面板可查 · Q4）',
      Array.isArray(issues.items) && typeof issues.total === 'number', `total=${issues.total}`);
    const fieldsQ = await j('/api/quality/fields');
    check('字段非空率可查（维护者细节）', fieldsQ.ok === true && !!fieldsQ.summary,
      Object.keys(fieldsQ.summary || {}).slice(0, 4).join(','));
    const rep = await j('/api/quality/report');
    check('质量报告可导出且带决策口径', rep.ok === true && !!rep.coverage && /默认排除/.test(rep.decisions?.U4 || ''),
      rep.decisions?.U4 || '—');

    const snap = await j('/api/quality/snapshot?provinceId=13&refYears=2025,2024');
    const dq = snap.dataQuality;
    check('统一 dataQuality 信封含快照文案与灰数据 flags',
      !!dq?.snapshotText && Array.isArray(dq.flags) && dq.legend?.length === 5, dq?.snapshotText);
    check('历史回退如实标注（不冒充当年数据）', dq?.historyFallback === true && dq?.fallbackYears >= 1,
      `落后 ${dq?.fallbackYears} 年`);
    check('方案响应同样带统一信封', !!plan.dataQuality?.snapshotText, plan.dataQuality?.snapshotText);

    // ================= 界面改版 v2：登录 / 省控线 / 历史 / 草稿 =================
    head('F10 · 登录 / 会话 / 鉴权');
    const s0 = await reqJson('/api/session');
    check('未登录会话为 false', s0.status === 200 && s0.body.ok && s0.body.authenticated === false);
    const badLogin = await postJson('/api/login', { username: 'admin', password: 'wrong' });
    check('错误凭据 401', badLogin.status === 401 && badLogin.body.ok === false, badLogin.body.message);
    const goodLogin = await postJson('/api/login', { username: 'admin', password: '123456' });
    const setCookie = goodLogin.headers.get('set-cookie') || '';
    AUTH_COOKIE = setCookie.split(';')[0];
    check('admin/123456 登录成功', goodLogin.status === 200 && goodLogin.body.ok && goodLogin.body.user === 'admin');
    check('HttpOnly Cookie（无 Secure）', /gk_sid=/.test(setCookie) && /HttpOnly/i.test(setCookie)
      && /Path=\//.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Max-Age=604800/.test(setCookie) && !/Secure/i.test(setCookie),
    setCookie.slice(0, 90));
    const s1 = await reqJson('/api/session', {}, AUTH_COOKIE);
    check('带 Cookie 会话为 true', s1.body.authenticated === true && s1.body.user === 'admin');
    for (const p of ['/api/history', '/api/drafts', '/api/wishlist']) {
      const r = await reqJson(p);
      check(`未登录 ${p} 401`, r.status === 401 && r.body.ok === false, JSON.stringify(r.body));
    }
    const logout = await authed('/api/logout', { method: 'POST' });
    const sAfter = await reqJson('/api/session', {}, AUTH_COOKIE);
    check('退出后会话失效', logout.body.ok === true && sAfter.body.authenticated === false);
    const reLogin = await postJson('/api/login', { username: 'admin', password: '123456' });
    AUTH_COOKIE = (reLogin.headers.get('set-cookie') || '').split(';')[0];
    check('重新登录恢复 Cookie', reLogin.body.ok === true && !!AUTH_COOKIE);

    head('F11 · 河北省控线（唯一真源）');
    const lines = await j('/api/lines?provinceId=13');
    // v3（PRD C4）：5 年 × 2 科类 × 2 批次 = 20 格全部有值，无缺键。
    const expectedLines = {
      2026: { '历史类|本科批': 485, '历史类|专科批': 200, '物理类|本科批': 443, '物理类|专科批': 200 },
      2025: { '历史类|本科批': 477, '历史类|专科批': 200, '物理类|本科批': 459, '物理类|专科批': 200 },
      2024: { '历史类|本科批': 449, '历史类|专科批': 200, '物理类|本科批': 448, '物理类|专科批': 200 },
      2023: { '历史类|本科批': 430, '历史类|专科批': 200, '物理类|本科批': 439, '物理类|专科批': 200 },
      2022: { '历史类|本科批': 443, '历史类|专科批': 200, '物理类|本科批': 430, '物理类|专科批': 200 },
    };
    check('省控线五年倒序', lines.ok && lines.years.join(',') === '2026,2025,2024,2023,2022', lines.years?.join(','));
    check('历史类 5 年逐格正确', [2026, 2025, 2024, 2023, 2022].every((y) =>
      lines.data[String(y)]?.['历史类|本科批'] === expectedLines[y]['历史类|本科批']
      && lines.data[String(y)]?.['历史类|专科批'] === expectedLines[y]['历史类|专科批']),
    [2026, 2025, 2024, 2023, 2022].map((y) => `${y}:${lines.data[String(y)]?.['历史类|本科批']}/${lines.data[String(y)]?.['历史类|专科批']}`).join(' '));
    // §9.2：原「物理类早年缺键」「物理类专科批五年全缺键」两条断言随 C4 补全预期更新。
    check('物理类本科五年逐格正确（448/439/430）',
      lines.data['2026']?.['物理类|本科批'] === 443 && lines.data['2025']?.['物理类|本科批'] === 459
      && lines.data['2024']?.['物理类|本科批'] === 448 && lines.data['2023']?.['物理类|本科批'] === 439
      && lines.data['2022']?.['物理类|本科批'] === 430,
      [2026, 2025, 2024, 2023, 2022].map((y) => `${y}:${lines.data[String(y)]?.['物理类|本科批']}`).join(' '));
    check('物理类专科批五年均为 200',
      [2026, 2025, 2024, 2023, 2022].every((y) => lines.data[String(y)]?.['物理类|专科批'] === 200));
    check('20 格全有值（无缺键、无暂无数据）',
      [2026, 2025, 2024, 2023, 2022].every((y) => ['历史类|本科批', '历史类|专科批', '物理类|本科批', '物理类|专科批']
        .every((k) => k in (lines.data[String(y)] || {}) && typeof lines.data[String(y)][k] === 'number')));
    const oneYear = await j('/api/lines?provinceId=13&year=2024');
    check('按年份查询只返该年', oneYear.ok && oneYear.years.length === 1 && oneYear.years[0] === 2024);

    head('F11b · v3 只读探索端点（一分一档 + 院校三级）');
    const yrs = await j('/api/score-range/years?provinceId=13');
    const yrMap = new Map((yrs.years || []).map((x) => [x.year, x.types]));
    check('一分一档年份倒序且 2026 仅物理类',
      yrs.ok && yrs.years.length >= 7
      && yrs.years.every((x, i, a) => i === 0 || a[i - 1].year > x.year)
      && (yrMap.get(2026) || []).join(',') === '物理类',
    JSON.stringify(yrMap.get(2026)));
    check('2020–2025 含物理类/历史类且无 <NA>',
      [2025, 2024, 2023, 2022, 2021, 2020].every((y) => {
        const t = yrMap.get(y) || [];
        return t.includes('物理类') && t.includes('历史类') && !t.some((x) => x.includes('NA'));
      }),
    [2025, 2024, 2023, 2022, 2021, 2020].map((y) => `${y}:${(yrMap.get(y) || []).join('/')}`).join(' '));

    const tbl = await j('/api/score-range/table?provinceId=13&year=2026&type=' + encodeURIComponent('物理类'));
    const hit140 = (tbl.rows || []).find((r) => r[0] === 140);
    check('分段表含 [140,350991,13] 且行序为 [分数,累计,本段]',
      tbl.ok && Array.isArray(hit140) && hit140[1] === 350991 && hit140[2] === 13,
    JSON.stringify(hit140));
    check('分段表降序 / count / total / full',
      tbl.ok && tbl.count === tbl.rows.length && tbl.total === 350991
      && tbl.rows.every((r, i, a) => i === 0 || a[i - 1][0] > r[0]),
    `count=${tbl.count} total=${tbl.total} full=${tbl.full}`);
    const noTable = await j('/api/score-range/table?provinceId=13&year=2026&type=' + encodeURIComponent('历史类'));
    check('2026 历史类无数据返回暂无数据', noTable.ok === false && /暂无数据/.test(noTable.message || ''), noTable.message);

    const srRank = await j('/api/score-range/rank?provinceId=13&year=2026&type=' + encodeURIComponent('物理类') + '&score=140');
    check('查位次 140 → cum350991/seg13/exact:true',
      srRank.ok && srRank.cum === 350991 && srRank.seg === 13 && srRank.exact === true,
    JSON.stringify({ cum: srRank.cum, seg: srRank.seg, exact: srRank.exact }));
    const rkEdge = await j('/api/score-range/rank?provinceId=13&year=2026&type=' + encodeURIComponent('物理类') + '&score=999');
    check('越界分数 exact:false 且取边界 cum', rkEdge.ok && rkEdge.exact === false && Number.isFinite(rkEdge.cum));
    const rkNone = await j('/api/score-range/rank?provinceId=13&year=2026&type=' + encodeURIComponent('历史类') + '&score=140');
    check('无表查位次返回暂无数据', rkNone.ok === false, rkNone.message);

    const colleges = await j('/api/colleges/admitted?provinceId=13&page=1&size=30');
    check('院校列表 total≈2542 且校名非空',
      colleges.ok && colleges.total > 2400 && colleges.total < 2700
      && colleges.items.length > 0 && colleges.items.every((x) => !!x.name),
    `total=${colleges.total} first=${colleges.items?.[0]?.name}`);
    const collegesQ = await j('/api/colleges/admitted?provinceId=13&q=' + encodeURIComponent('师范') + '&size=30');
    check('院校名称搜索收窄结果',
      collegesQ.ok && collegesQ.total > 0 && collegesQ.total < colleges.total
      && collegesQ.items.every((x) => x.name.includes('师范')),
    `师范 total=${collegesQ.total}`);
    const filters = await j('/api/colleges/filters?provinceId=13&schoolId=208');
    check('院校筛选项 regions 仅河北、years 含 2025/2026',
      filters.ok && filters.regions.length === 1 && filters.regions[0].name === '河北'
      && filters.years.includes(2025) && filters.years.includes(2026),
    JSON.stringify({ regions: filters.regions, years: filters.years?.slice(0, 3) }));
    const majors = await j('/api/colleges/majors?provinceId=13&schoolId=208&year=2025&page=1&size=50');
    check('专业录取行有 planNum 字段且结果为四列数据源',
      majors.ok && majors.items.length > 0 && majors.items.every((x) => 'planNum' in x && 'min' in x && 'rank' in x && 'major' in x),
    `total=${majors.total} sample=${JSON.stringify(majors.items?.[0])}`);
    check('专业录取行字段集无 admit / 录取人数（铁证）',
      majors.items.every((x) => !('admit' in x) && !Object.keys(x).some((k) => /admit|录取人数/i.test(k))),
    Object.keys(majors.items[0] || {}).join(','));
    const majorsType = await j('/api/colleges/majors?provinceId=13&schoolId=208&year=2025&type=' + encodeURIComponent('物理类') + '&size=50');
    check('专业科类筛选生效（统一 categoryOf 映射）',
      majorsType.ok && majorsType.items.length > 0
      && majorsType.items.every((x) => x.type === '物理类' || x.type === ''),
    `total=${majorsType.total}`);

    head('F12 · 历史 CRUD + 自动生成留档');
    const hList0 = await authed('/api/history');
    check('历史列表可读（仅摘要）', hList0.body.ok && Array.isArray(hList0.body.items)
      && (hList0.body.items.length === 0 || !('slots' in hList0.body.items[0])), `${hList0.body.items?.length} 条`);
    const fixtureSlots = [
      { order: 7, school: { name: '甲大学', province: '河北' }, group: '', major: '', tier: 'chong', tierLabel: '冲',
        probability: 35, latest: { min: 520, rank: 12000 }, reason: ['理由A'], batch: '本科批', subjectReq: '物理' },
      { order: 3, school: { name: '乙大学', province: '河北' }, group: '（01）', major: '计算机', tier: 'wen', tierLabel: '稳',
        probability: 60, latest: { min: 500, rank: 21000 }, reason: ['理由B'], batch: '本科批', subjectReq: '物理' },
    ];
    const hCreate = await postAuthed('/api/history', {
      meta: { province: '河北', type: '历史类', score: 500, rank: 12345, refYears: [2025, 2024] },
      slots: fixtureSlots, context: { score: 500, subjects: '历史' },
    });
    check('显式新增历史记录', hCreate.status === 200 && hCreate.body.ok && hCreate.body.item.slotCount === 2);
    const hId = hCreate.body.item?.id || '';
    const hDetail = await authed('/api/history/' + hId);
    check('历史详情保留完整快照字段', hDetail.body.ok && hDetail.body.item.slots.length === 2
      && hDetail.body.item.slots[0].probability === 35 && hDetail.body.item.slots[0].latest.rank === 12000,
    hDetail.body.item?.slots?.[0] ? JSON.stringify(hDetail.body.item.slots[0]).slice(0, 80) : '无');
    const beforeAuto = (await authed('/api/history')).body.items.length;
    const planAuto = await j('/api/plan?provinceId=13&type=' + encodeURIComponent('历史类') + '&score=500&total=5');
    const afterAuto = (await authed('/api/history')).body.items;
    check('生成方案自动留档 +1', planAuto.ok && afterAuto.length === beforeAuto + 1, `${beforeAuto} → ${afterAuto.length}`);
    check('留档响应结构不变（原字段仍在）', planAuto.ok && ['meta', 'slots', 'groups', 'dataQuality'].every((k) => k in planAuto));
    check('未登录生成也留档', afterAuto.some((x) => x.meta?.province === '河北' && x.slotCount > 0));
    const h404 = await authed('/api/history/not-exist-id');
    check('历史详情 404', h404.status === 404 && h404.body.ok === false);
    check('删除历史记录', (await reqJson('/api/history/' + hId, { method: 'DELETE' }, AUTH_COOKIE)).body.ok === true);

    head('F13 · 草稿 CRUD + 从历史导入映射');
    // 与 §3.2 映射表同构的测试侧镜像（UI 的真实映射在 render-test 中单独断言）
    const mapRows = (slots) => slots.map((s, i) => ({
      order: i + 1,
      school: s.school?.name || '',
      group: s.group || '',
      major: s.major || '',
      obey: '是',
      tier: s.tier || '',
      tierLabel: s.tierLabel || '',
      note: [(s.reason || []).join(' '), s.batch ? `批次：${s.batch}` : ''].filter(Boolean).join(' '),
    }));
    const rows = mapRows(fixtureSlots);
    const hForImport = await postAuthed('/api/history', { meta: { province: '河北', type: '历史类' }, slots: fixtureSlots, context: {} });
    const sourceId = hForImport.body.item?.id || '';
    const dCreate = await postAuthed('/api/drafts', { name: '普通类平行志愿', rows, sourceHistoryId: sourceId });
    check('草稿新建（含来源 id）', dCreate.body.ok && dCreate.body.item.sourceHistoryId === sourceId && dCreate.body.item.rows.length === 2);
    const dId = dCreate.body.item?.id || '';
    const dDetail = await authed('/api/drafts/' + dId);
    const savedRows = dDetail.body.item?.rows || [];
    check('导入 obey 固定「是」', savedRows.every((r) => r.obey === '是'), JSON.stringify(savedRows.map((r) => r.obey)));
    check('导入 order 重排 1..n', savedRows.map((r) => r.order).join(',') === '1,2', savedRows.map((r) => r.order).join(','));
    check('概率/位次等字段不进草稿行', savedRows.every((r) => !['probability', 'majorProb', 'majorOptions', 'latest', 'hist', 'baseDiff', 'baseRank', 'years', 'stable', 'batch', 'subjectReq'].some((k) => k in r)),
      Object.keys(savedRows[0] || {}).join(','));
    check('批次拼入备注', /本科批/.test(savedRows[0]?.note || ''), savedRows[0]?.note);
    const hUnchanged = await authed('/api/history/' + sourceId);
    check('导入不修改原历史记录', JSON.stringify(hUnchanged.body.item?.slots) === JSON.stringify(fixtureSlots));
    const dPut = await reqJson('/api/drafts/' + dId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '改名草稿', rows: [rows[0]] }),
    }, AUTH_COOKIE);
    check('草稿编辑保存', dPut.body.ok && dPut.body.item.name === '改名草稿' && dPut.body.item.rows.length === 1);
    const dList = await authed('/api/drafts');
    check('草稿列表含 rows 且按更新倒序', dList.body.ok && Array.isArray(dList.body.items) && 'rows' in dList.body.items[0]);
    check('草稿删除', (await reqJson('/api/drafts/' + dId, { method: 'DELETE' }, AUTH_COOKIE)).body.ok === true);

    head('边界与错误处理');
    const r404 = await fetch(B + '/api/notexist');
    check('未知接口返回 404', r404.status === 404);
    const page = await fetch(B + '/');
    check('首页可访问', page.status === 200);
    for (const f of ['/app.js', '/plan-ui.js', '/quality-ui.js', '/auth-ui.js', '/lines-ui.js', '/rank-ui.js', '/college-ui.js', '/history-ui.js', '/draft-ui.js', '/styles.css']) {
      const r = await fetch(B + f);
      check(`静态资源 ${f}`, r.status === 200 && (await r.text()).length > 100);
    }

    console.log(`\n═══ API 验收：通过 ${pass} 项，失败 ${fail} 项 ═══`);
  } finally {
    server.kill();
    await sleep(200);
    for (const name of ['history.json', 'drafts.json', 'wishlist.json']) {
      try { fs.writeFileSync(path.join(APP, 'data', name), '[]', 'utf8'); } catch { /* 清理失败不影响测试结论 */ }
    }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

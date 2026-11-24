/**
 * 前端渲染回归测试
 *
 * 在「假 DOM」里真实执行 高考志愿助手/web/app.js 的全部渲染函数，
 * 捕获 ReferenceError / TypeError 这类只有运行期才会暴露的问题
 * （例如模板里引用了未声明的变量）。
 *
 * 用法：node tools/render-test.mjs
 * 会自动在 8799 端口拉起本地服务，跑完自动关闭。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '高考志愿助手');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TEST_COOKIE = '';   // 登录后的 gk_sid，供沙箱内 fetch 访问鉴权端点

// ---------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------
function makeEl(tag = 'div') {
  const el = {
    tagName: tag, id: '', value: '', textContent: '', options: [], dataset: {},
    style: {}, files: [], children: [], _html: '', _queryCalls: [],
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      contains(x) { return this._s.has(x); },
      toggle(x, f) { if (f === undefined) { this._s.has(x) ? this._s.delete(x) : this._s.add(x); } else if (f) this._s.add(x); else this._s.delete(x); },
    },
    addEventListener() {}, removeEventListener() {}, scrollIntoView() {},
    focus() {}, click() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); },
    querySelector() { return makeEl(); },
    querySelectorAll(sel) { this._queryCalls.push(String(sel)); return []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); },
  });
  return el;
}

function installDom() {
  const registry = new Map();
  const listeners = new Map();          // 极简事件总线，让 'app-ready' 能真正触发
  const document = {
    querySelector(sel) { if (!registry.has(sel)) registry.set(sel, makeEl(sel)); return registry.get(sel); },
    querySelectorAll() { return []; },
    createElement(tag) { return makeEl(tag); },
    // 真实浏览器里 getElementById 与 querySelector('#id') 返回同一元素，
    // 这里复用同一个键，保证两种取法看到的状态一致
    getElementById(id) { return this.querySelector('#' + id); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (arr) listeners.set(type, arr.filter((x) => x !== fn));
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev && ev.type) || []) {
        try { fn(ev); } catch (e) { console.error('事件处理抛错', ev.type, e); }
      }
      return true;
    },
  };
  document.body = makeEl('body');
  document.documentElement = makeEl('html');
  return { document, registry };
}

// ---------------------------------------------------------------
// 启动本地服务
// ---------------------------------------------------------------
async function startServer() {
  const child = spawn(process.execPath, [path.join(APP, 'server', 'server.mjs'), '--port', String(PORT), '--no-index'], {
    cwd: APP, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/meta`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return child;
    } catch { /* 继续等 */ }
  }
  child.kill();
  throw new Error('本地服务启动超时');
}

// ---------------------------------------------------------------
// 在沙箱里执行 app.js
// ---------------------------------------------------------------
function loadApp() {
  const { document, registry } = installDom();
  const store = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: class { constructor() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    confirm: () => true,
    alert: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document,
    fetch: (u, o = {}) => {
      const headers = { ...(o.headers || {}) };
      if (TEST_COOKIE) headers.Cookie = TEST_COOKIE;
      return fetch(u.startsWith('http') ? u : BASE + u, { ...o, headers });
    },
    navigator: { userAgent: 'node' },
  };
  // app.js 只通过 window.AuthUI 做门禁；渲染测试里视为已登录
  sandbox.AuthUI = {
    init: async () => {},
    isAuthenticated: () => true,
    promptLogin: () => {},
    migrateWishlist: async () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(APP, 'web', 'app.js'), 'utf8');
  const src2 = fs.readFileSync(path.join(APP, 'web', 'plan-ui.js'), 'utf8');
  const src3 = fs.readFileSync(path.join(APP, 'web', 'quality-ui.js'), 'utf8');
  // lines-ui.js 是 ESM（export 常量），测试里去掉 export 后与其它脚本同一沙箱执行；
  // 其逻辑已包在 IIFE 内，不会与 app.js 的顶层 init 等函数冲突。
  const srcLines = fs.readFileSync(path.join(APP, 'web', 'lines-ui.js'), 'utf8').replace(/^export\s+/m, '');
  const srcHistory = fs.readFileSync(path.join(APP, 'web', 'history-ui.js'), 'utf8');
  const srcDraft = fs.readFileSync(path.join(APP, 'web', 'draft-ui.js'), 'utf8');
  // v3 新增：一分一档表 / 院校查询三级（均为 IIFE，挂 window.RankUI / window.CollegeUI）
  const srcRank = fs.readFileSync(path.join(APP, 'web', 'rank-ui.js'), 'utf8');
  const srcCollege = fs.readFileSync(path.join(APP, 'web', 'college-ui.js'), 'utf8');
  // 脚本顶层 function 声明会成为沙箱全局属性，借此暴露内部函数用于断言
  const driver = `
    globalThis.__t = { S, esc, fmt, lineChart, tierTag, renderScoreResult,
      renderWishlist, exportWishlist, renderData, showCampus, runCampusSearch, runScoreQuery, loadTrend,
      runPlan, renderPlan, planRow, renderSubjectChips, selectedSubjects, exportPlan, moveSlot,
      aiRenderMessages, renderMarkdown, renderAiAdvice, refreshAiProfile, aiCfgLoad, aiCfgSave, AI, PLAN,
      QualityUI, HistoryUI: window.HistoryUI, DraftUI: window.DraftUI, LinesUI: window.LinesUI,
      RankUI: window.RankUI, CollegeUI: window.CollegeUI };
  `;
  vm.runInContext(src + '\n' + src2 + '\n' + src3 + '\n' + srcLines + '\n' + srcHistory + '\n' + srcDraft
    + '\n' + srcRank + '\n' + srcCollege + driver, ctx, { filename: 'app.js' });
  return { ctx, t: sandbox.__t, registry, doc: document };
}

// ---------------------------------------------------------------
// 测试框架
// ---------------------------------------------------------------
let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try {
    const out = await fn();
    results.push(['✅', name, out === undefined ? '' : String(out)]);
    pass++;
  } catch (e) {
    results.push(['❌', name, `${e.name}: ${e.message}`]);
    fail++;
  }
}

// ---------------------------------------------------------------
(async () => {
  const server = await startServer();
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  TEST_COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  if (!TEST_COOKIE) { console.error('测试登录失败，无法访问历史/草稿端点'); server.kill(); process.exit(1); }
  const { ctx, t, registry, doc } = loadApp();
  if (!t) { console.error('无法取得 app.js 内部函数'); server.kill(); process.exit(1); }
  const el = (id) => doc.querySelector('#' + id);      // 按需创建/取用元素
  await sleep(1200);                                    // 等 init() 的异步请求完成

  const meta = await (await fetch(`${BASE}/api/meta`)).json();
  const r1 = await (await fetch(`${BASE}/api/schools?q=${encodeURIComponent('中山大学')}&size=1`)).json();
  const school = r1.items[0];
  const prov = await (await fetch(`${BASE}/api/score/province?schoolId=104&provinceId=44`)).json();
  const spec = await (await fetch(`${BASE}/api/score/special?schoolId=104&provinceId=44&year=2025`)).json();
  const rec = await (await fetch(`${BASE}/api/recommend?provinceId=11&type=${encodeURIComponent('综合')}&score=600&limit=12`)).json();
  const plan = await (await fetch(`${BASE}/api/plan?provinceId=11&type=${encodeURIComponent('综合')}&score=600&total=80&strategy=major`)).json();
  const trend = await (await fetch(`${BASE}/api/score/trend?schoolId=104&provinceId=44`)).json();
  const cd = await (await fetch(`${BASE}/api/colleges/detail?school=${encodeURIComponent('清华大学')}`)).json();

  console.log('== 渲染路径测试（真实执行 app.js）==\n');

  await check('esc / fmt 基础函数', () => `${t.esc('<a>&"')} | ${t.fmt(1234567)}`);

  await check('lineChart 折线图 SVG', () => {
    const svg = t.lineChart(trend.series.filter((s) => s.min));
    if (!svg.includes('<svg')) throw new Error('未生成 SVG');
    if (svg.includes('undefined') || svg.includes('NaN')) throw new Error('SVG 含 undefined/NaN');
    return `${svg.length} 字符`;
  });

  await check('tierTag 院校层次标签', () => {
    const a = t.tierTag({ f985: true }), b = t.tierTag({ f211: true }), c = t.tierTag({ dual: '双一流' }), d = t.tierTag({});
    if (!a.includes('985') || !b.includes('211') || !c.includes('双一流')) throw new Error('标签内容异常');
    return `${a} ${b} ${c} ${d}`;
  });

  await check('renderScoreResult 分数线结果页', () => {
    t.renderScoreResult(school, { prov, spec }, { pid: 44, type: '', year: 2025, major: '' });
    const html = registry.get('#s-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('HTML 含 undefined/NaN');
    if (!html.includes(school.name)) throw new Error('未包含院校名');
    if (!html.includes('录取分数线') || !html.includes('专业分数线')) throw new Error('缺少录取分数线/专业分数线分区');
    if (!html.includes('score-tab-prov') || !html.includes('score-tab-spec')) throw new Error('缺少两个分区切换按钮');
    return `${html.length} 字符`;
  });




  await check('推荐结果含专业代码与命中标记', () => {
    const all = [...rec.tiers.chong, ...rec.tiers.wen, ...rec.tiers.bao];
    const coded = all.filter((x) => (x.majors || []).some((m) => m.code));
    if (!coded.length) throw new Error('没有任何专业代码');
    const hit = all.filter((x) => x.majorHit);
    return `${coded.length}/${all.length} 条带专业代码，${hit.length} 条命中意向专业`;
  });

  // ★ 全量年份回归：北京补回 2017–2022 后，专业选年必须兼顾专业组名兼容性
  await check('北京推荐：全量年份下专业粒度仍生效', () => {
    const all = [...rec.tiers.chong, ...rec.tiers.wen, ...rec.tiers.bao];
    const withMajor = all.filter((x) => (x.majors || []).length);
    if (!withMajor.length) throw new Error('北京推荐没有带专业候选（专业选年组名不兼容？）');
    if (!(rec.meta?.majorDataYear > 2000)) throw new Error(`专业数据年份不可追溯，实际 ${rec.meta?.majorDataYear}`);
    return `${withMajor.length}/${all.length} 条带专业，majorDataYear=${rec.meta.majorDataYear}`;
  });

  await check('北京方案：全量年份下专业粒度仍生效', () => {
    if (!plan.ok) throw new Error(plan.message || '方案生成失败');
    const withMajor = plan.slots.filter((s) => s.major);
    if (!withMajor.length) throw new Error('北京方案没有带专业条目（专业选年组名不兼容？）');
    if (!(plan.meta?.majorDataYear > 2000)) throw new Error(`专业数据年份不可追溯，实际 ${plan.meta?.majorDataYear}`);
    return `${withMajor.length}/${plan.slots.length} 条带专业，majorDataYear=${plan.meta.majorDataYear}`;
  });

  // ★ 用户反馈的缺陷路径
  await check('showCampus 大学环境详情', async () => {
    t.showCampus('清华大学');
    await sleep(1500);
    const html = registry.get('#c-detail')?.innerHTML || registry.get('#c-result')?.innerHTML || '';
    if (html.includes('undefined')) throw new Error('HTML 含 undefined');
    if (html.includes('加载失败')) throw new Error('渲染抛错：' + html.replace(/<[^>]+>/g, ' ').trim().slice(0, 60));
    if (!html.includes(cd.detail.name)) throw new Error('未包含院校名');
    if (cd.detail.groups.length && !html.includes('住宿与生活')) throw new Error('缺少「住宿与生活」区块');
    if (!html.includes('colleges.chat')) throw new Error('缺少原文链接');
    return `${html.length} 字符，含 ${cd.detail.groups.length} 个问题`;
  });

  await check('showCampus 多所院校（回归遍历）', async () => {
    const names = ['北京大学', '武汉大学', '吉林大学'];
    for (const n of names) {
      t.showCampus(n);
      await sleep(1200);
      const html = registry.get('#c-detail')?.innerHTML || '';
      if (html.includes('加载失败')) throw new Error(`${n} 渲染抛错`);
      if (!html.includes(n)) throw new Error(`${n} 未渲染`);
    }
    return names.join(' / ');
  });

  await check('runCampusSearch 搜索→自动选中首家', async () => {
    el('c-q').value = '复旦';
    t.runCampusSearch();
    await sleep(2000);
    const html = registry.get('#c-result')?.innerHTML || '';
    if (html.includes('undefined')) throw new Error('含 undefined');
    if (!html.includes('院校列表')) throw new Error('未渲染列表');
    return `${html.length} 字符`;
  });

  await check('loadTrend 历年趋势', async () => {
    t.loadTrend(school, { pid: 44, major: '' });
    await sleep(2500);
    const html = registry.get('#trend-card')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    if (!html.includes('<svg')) throw new Error('未生成图表');
    return `${html.length} 字符`;
  });

  await check('renderWishlist 空状态 + 有数据', () => {
    t.renderWishlist();
    t.S.wishlist.push({ key: 'k1', type: '推荐', school: '清华大学', schoolId: 140, year: 2026, extra: '（01） 概率50%' });
    t.renderWishlist();
    const html = registry.get('#w-result')?.innerHTML || '';
    if (!html.includes('清华大学')) throw new Error('未渲染收藏项');
    t.S.wishlist.length = 0;
    t.renderWishlist();
    return '两种状态均正常';
  });

  await check('renderData 数据管理页', async () => {
    t.renderData();
    // 首次 /api/status 要统计 200 万+ 行，给足时间（服务端已缓存，第二次很快就返回）
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const h = registry.get('#d-result')?.innerHTML || '';
      if (h && !h.includes('读取状态') && !h.includes('读取中')) break;
    }
    const html = registry.get('#d-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    // 新数据源应展示：数据源卡片 + 各表记录数 + 逐年覆盖 + 省份覆盖
    if (!html.includes('数据源')) throw new Error('缺少数据源区块 >> ' + html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
    if (!html.includes('SQLite')) throw new Error('未标注新数据源为 SQLite');
    if (!html.includes('各表记录数')) throw new Error('缺少各表记录数');
    if (!html.includes('逐年覆盖')) throw new Error('缺少逐年覆盖');
    if (!html.includes('省份覆盖')) throw new Error('缺少省份覆盖');
    if (!html.includes('一分一段表')) throw new Error('缺少一分一段表行');
    return `${html.length} 字符，已展示新数据源`;
  });

  await check('边界：不存在的院校', async () => {
    t.showCampus('这所学校不存在xyz');
    await sleep(1200);
    const html = registry.get('#c-detail')?.innerHTML || '';
    if (html.includes('undefined')) throw new Error('含 undefined');
    return '未崩溃';
  });

  await check('runScoreQuery 完整表单流程（分数线页）', async () => {
    el('s-province').value = '44';
    el('s-type').value = '';
    el('s-year').value = '2025';
    el('s-school').value = '中山大学';
    el('s-major').value = '';
    t.runScoreQuery();
    await sleep(3000);
    const html = registry.get('#s-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    if (html.includes('查询失败')) throw new Error('渲染抛错：' + html.replace(/<[^>]+>/g, ' ').trim().slice(0, 60));
    if (!html.includes('中山大学')) throw new Error('未渲染院校');
    return `${html.length} 字符`;
  });


  await check('API 元信息完整性', () => {
    if (!meta.schoolCount || !meta.collegeCount) throw new Error('meta 缺字段');
    return `院校 ${meta.schoolCount} / 大学环境 ${meta.collegeCount}`;
  });

  // ================= 新增：志愿方案 / 资料库 / AI =================
  console.log('\n  ── 志愿方案 ──');

  await check('renderSubjectChips 选科按钮', () => {
    t.renderSubjectChips();
    const html = registry.get('#p-subjects')?.innerHTML || '';
    if (!html.includes('物理') || !html.includes('化学')) throw new Error('未渲染选科按钮');
    return `${html.length} 字符`;
  });

  await check('runPlan 生成完整志愿方案（80 条）', async () => {
    el('p-province').value = '44';
    el('p-type').value = '物理类';
    el('p-mode').value = 'score';
    el('p-score').value = '600';
    el('p-rank').value = '';
    el('p-major').value = '计算机';
    el('p-strategy').value = 'major';
    el('p-total').value = '80';
    el('p-ratios').value = '30:40:30';
    t.runPlan();
    await sleep(4000);
    const html = registry.get('#p-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('HTML 含 undefined/NaN');
    if (!html.includes('志愿参考')) throw new Error('未渲染方案：' + html.replace(/<[^>]+>/g, ' ').trim().slice(0, 80));
    const n = t.PLAN.slots.length;
    if (n < 20) throw new Error(`方案条数过少：${n}`);
    return `${n} 条，${html.length} 字符`;
  });

  await check('方案含冲稳保三档', () => {
    const tiers = new Set(t.PLAN.slots.map((s) => s.tierLabel));
    for (const x of ['冲', '稳', '保']) if (!tiers.has(x)) throw new Error(`缺少「${x}」档`);
    const g = {};
    t.PLAN.slots.forEach((s) => { g[s.tierLabel] = (g[s.tierLabel] || 0) + 1; });
    return JSON.stringify(g);
  });

  await check('方案条目含院校代码与专业信息', () => {
    const withCode = t.PLAN.slots.filter((s) => s.nationalCode).length;
    const withMajor = t.PLAN.slots.filter((s) => s.major).length;
    if (!withCode) throw new Error('没有任何院校代码');
    return `${withCode}/${t.PLAN.slots.length} 有院校代码，${withMajor} 有具体专业`;
  });

  await check('moveSlot 调整顺序', () => {
    const a = t.PLAN.slots[0].school.name, b = t.PLAN.slots[1].school.name;
    t.moveSlot(0, 1);
    if (t.PLAN.slots[0].school.name !== b) throw new Error('顺序未交换');
    t.moveSlot(1, -1);                        // 换回来
    if (t.PLAN.slots[0].school.name !== a) throw new Error('顺序未还原');
    return `${a} ⇄ ${b}`;
  });

  await check('planRow 单条渲染', () => {
    const html = t.planRow(t.PLAN.slots[0], 0);
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    if (!html.includes(t.PLAN.slots[0].school.name)) throw new Error('未含院校名');
    return `${html.length} 字符`;
  });

  await check('exportPlan 生成 CSV', () => {
    t.exportPlan();   // download() 在沙箱里是假实现，只验证不抛错
    return `${t.PLAN.slots.length} 行`;
  });





  console.log('\n  ── AI 助手 ──');

  await check('renderMarkdown 渲染', () => {
    const h = t.renderMarkdown('## 标题\n- **加粗** 列表\n\n第二段');
    if (!h.includes('<h3>') || !h.includes('<b>') || !h.includes('<li>')) throw new Error('markdown 渲染异常：' + h);
    return `${h.length} 字符`;
  });

  await check('aiRenderMessages 空状态 + 消息', () => {
    t.aiRenderMessages();
    const empty = registry.get('#ai-messages')?.innerHTML || '';
    if (!empty.includes('API 设置')) throw new Error('空状态未提示');
    t.AI.messages.push({ role: 'user', content: '你好' }, { role: 'assistant', content: '**答**：你好' });
    t.aiRenderMessages();
    const html = registry.get('#ai-messages')?.innerHTML || '';
    if (!html.includes('AI 顾问')) throw new Error('未渲染 AI 消息');
    t.AI.messages.length = 0;
    t.aiRenderMessages();
    return '两种状态正常';
  });

  await check('renderAiAdvice 结构化建议卡片', () => {
    t.renderAiAdvice({
      summary: '建议以计算机为主',
      profile: { province: '广东', type: '物理类', score: 600, rank: 30891 },
      items: [
        { tier: '冲', school: '华南理工大学', major: '计算机科学与技术', reason: '985 平台好', note: '' },
        { tier: '稳', school: '暨南大学', major: '软件工程', reason: '位次匹配', note: '' },
        { tier: '保', school: '广东工业大学', major: '计算机类', reason: '保底', note: '' },
      ],
    });
    const html = registry.get('#ai-result')?.innerHTML || '';
    if (html.includes('undefined')) throw new Error('含 undefined');
    if (!html.includes('华南理工大学') || !html.includes('软件工程')) throw new Error('未渲染建议卡片');
    return `${html.length} 字符`;
  });

  await check('refreshAiProfile 带入考生档案', () => {
    t.refreshAiProfile();
    if (!t.AI.profile || !t.AI.profile.省份) throw new Error('档案为空');
    return Object.keys(t.AI.profile).join('/');
  });

  await check('AI 设置读写 localStorage', () => {
    el('ai-base').value = 'https://api.deepseek.com/v1';
    el('ai-key').value = 'sk-test';
    el('ai-model').value = 'deepseek-chat';
    t.aiCfgSave();
    if (t.AI.cfg.model !== 'deepseek-chat') throw new Error('保存失败');
    return t.AI.cfg.base;
  });

  console.log('\n  ── 数据质量 UI（Q4 / Q7 · 家长精简版 + 维护者折叠）──');

  const DQ = {
    dataVersion: '2026.10.18-r1', builtAt: '2026-10-18', baselineYear: 2025, gaokaoYear: 2026,
    snapshotText: '本次基于 2025 年历史数据 · ⚠ 历史回退落后 1 年 · 数据版本 2026.10.18-r1',
    flags: [{ text: '⚠ 本次基于历史数据（非当年）' }], legend: [],
  };

  await check('四态 chip：河北 2026 抽样标 ◐ 而非绿色「有 2026」', () => {
    const chip = t.QualityUI.stateChip({
      has2026: false, has2026Partial: true,
      coverage2026: {
        score_range: { state: 'partial', sampled: 0 },
        school_adm: { state: 'partial', sampled: 1 },
        major_adm: { state: 'partial', sampled: 1 },
        plan_code: { state: 'missing', sampled: 0 },
      },
    });
    if (!chip.includes('◐') || !chip.includes('部分/抽样')) throw new Error('未标 ◐ 部分/抽样');
    if (chip.includes('有 2026')) throw new Error('仍在渲染误导性的绿色「有 2026」');
    if (!chip.includes('抽样')) throw new Error('未披露抽样明细');
    return chip.slice(0, 80);
  });

  await check('统一快照条与 CSV 快照文案', () => {
    const bar = t.QualityUI.snapshotBar(DQ);
    if (!bar.includes('数据快照') || !bar.includes('历史回退')) throw new Error('快照条未带版本/回退说明');
    if (!bar.includes('q-flag')) throw new Error('灰数据标记未渲染');
    const csv = t.QualityUI.csvSnapshot(DQ);
    if (!csv.includes('2026.10.18-r1')) throw new Error('CSV 快照未带数据版本');
    return `${bar.length} 字符 / ${csv.slice(0, 40)}…`;
  });

  await check('灰数据图例：五类符号 + 文字（不依赖颜色）', () => {
    const h = t.QualityUI.legendHtml();
    for (const s of ['●', '≈', '◐', 'ⓘ', '⚠']) if (!h.includes(s)) throw new Error('缺少符号 ' + s);
    if (!h.includes('官方完整') || !h.includes('历史回退')) throw new Error('缺少文字说明');
    return '5/5 符号 + 文字齐全';
  });

  await check('方案结果带快照条，导出 CSV 仅保留快照事实', () => {
    t.PLAN.dq = DQ;
    t.renderPlan();
    const html = registry.get('#p-result')?.innerHTML || '';
    if (!html.includes('snapshot-bar')) throw new Error('方案结果未渲染快照条');
    let csv = '';
    const orig = ctx.download;
    ctx.download = (_n, text) => { csv = text; };
    try { t.exportPlan(); } finally { ctx.download = orig; }
    if (!csv.includes('数据快照') || !csv.includes('2026.10.18-r1')) throw new Error('CSV 未带数据快照');
    if (/免责|请以本省当年/.test(csv)) throw new Error('CSV 仍带对外话术');
    return `${html.length} 字符 / CSV ${csv.length} 字符`;
  });

  await check('我的志愿 CSV 首行即数据快照', () => {
    let csv = '';
    const OrigBlob = ctx.Blob;
    ctx.Blob = class { constructor(parts) { csv = parts.join(''); } };
    t.S.wishlist = [{ key: 'x', type: '冲', school: '测试大学', schoolId: '1', year: 2025, extra: '计算机' }];
    try { t.exportWishlist(); } finally { ctx.Blob = OrigBlob; }
    if (!csv.startsWith('\uFEFF"# 数据快照"')) throw new Error('首行不是数据快照：' + csv.slice(0, 50));
    return csv.split('\r\n')[0].slice(0, 70);
  });

  await check('质量面板默认精简版，维护者细节折叠且懒加载', async () => {
    await t.QualityUI.renderPanel();
    const html = registry.get('#q-panel-root')?.innerHTML || '';
    if (!html.includes('<details')) throw new Error('维护者细节未折叠在 <details>');
    if (!html.includes('数据版本')) throw new Error('精简版未展示数据版本');
    if (!html.includes('q-legend')) throw new Error('精简版未展示灰数据图例');
    if (html.includes('<table')) throw new Error('默认就渲染了维护者明细表格');
    return `${html.length} 字符 · 详情默认收起`;
  });

  // ================= 界面改版 v2：省控线 / 历史 / 草稿 =================
  console.log('\n  ── 省控线 / 历史记录 / 草稿箱 ──');

  const apiJson = async (p, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (TEST_COOKIE) headers.Cookie = TEST_COOKIE;
    const r = await fetch(BASE + p, { ...opts, headers });
    return r.json();
  };

  // §9.2：原「省控线 + 外链原样打开」用例随 C2（删外链）与 C4/R7（补全 20 格、方案 A）重写。
  await check('省控线方案 A：四列表头 / 10 行 / 20 格全有值', async () => {
    await t.LinesUI.render();
    const html = registry.get('#lines-content')?.innerHTML || '';
    const ths = (html.match(/<th>/g) || []).length;
    if (ths !== 4) throw new Error(`表头应为 4 列，实际 ${ths}`);
    for (const h of ['年份', '科类', '本科批', '专科批']) {
      if (!html.includes(`<th>${h}</th>`)) throw new Error(`表头缺少 ${h}`);
    }
    const trs = (html.match(/<tr>/g) || []).length - 1;
    if (trs !== 10) throw new Error(`方案 A 应为 10 行，实际 ${trs}`);
    const nums = (html.match(/<td class="num">/g) || []).length;
    if (nums !== 20) throw new Error(`数值格应为 20 个，实际 ${nums}`);
    if (html.includes('暂无数据')) throw new Error('方案 A 不应出现暂无数据');
    for (const [y, v] of [[2024, 448], [2023, 439], [2022, 430], [2026, 443], [2025, 459], [2024, 200]]) {
      if (!html.includes(String(v))) throw new Error(`缺少数值 ${y}:${v}`);
    }
    // setFilter 保留旧签名，category 参数被兼容忽略，调用不得报错
    t.LinesUI.setFilter('all', '物理类');
    t.LinesUI.setFilter(2024, '历史类');
    return `${ths} 列 / ${trs} 行 / ${nums} 数值格`;
  });

  await check('v3 DOM 删除：index.html 无被删 token / 主控无空引用绑定', () => {
    const html = fs.readFileSync(path.join(APP, 'web', 'index.html'), 'utf8');
    const banned = ['panel-recommend', 'data-tab="recommend"', 'panel-resource', 'data-tab="resource"',
      'id="q-banner"', 'nav-onepoint', 'rk-province', 'cd-province', '智能推荐'];
    for (const token of banned) if (html.includes(token)) throw new Error(`index.html 仍含 ${token}`);
    if (/quark\.cn/i.test(html)) throw new Error('index.html 仍含夸克外链');
    for (const token of ['data-tab="rank"', 'panel-rank', 'college-content', 'rank-ui.js', 'college-ui.js']) {
      if (!html.includes(token)) throw new Error(`index.html 缺少 ${token}`);
    }
    const appSrc = fs.readFileSync(path.join(APP, 'web', 'app.js'), 'utf8');
    const planSrc = fs.readFileSync(path.join(APP, 'web', 'plan-ui.js'), 'utf8');
    if (/\$\(['"]#(?:s|r)-[^'"]+['"]\s*\)\.addEventListener/.test(appSrc)) {
      throw new Error('app.js 仍绑定已删除的 s-*/r-* DOM');
    }
    if (/getElementById\(\s*['"](?:rk|cd|res)-[^'"]*['"]\s*\)\s*\.addEventListener/.test(planSrc)) {
      throw new Error('plan-ui.js 仍绑定已删除的资料库 DOM');
    }
    if (/initResource\(\)\s*\.catch/.test(planSrc)) throw new Error('plan-ui.js 仍调用 initResource()');
    if (/refreshDict\('r'\)/.test(appSrc)) throw new Error('app.js 仍调用 refreshDict(r)');
    return `已删 ${banned.length} 类 token，无链式空引用绑定`;
  });

  await check('v3 一分一档页：本地表格 140/13/350991 + 查位次', async () => {
    if (!t.RankUI) throw new Error('RankUI 未挂载');
    await t.RankUI.render();
    let html = el('rank-table-box').innerHTML || '';
    for (const h of ['分数', '本段人数', '累计人数']) {
      if (!html.includes(h)) throw new Error(`表头缺少 ${h}`);
    }
    const row = html.split('<tr>').find((s) => s.includes('<b>140</b>'));
    if (!row || !row.includes('>13<') || !row.includes('350991')) {
      throw new Error('样例行应为 140 / 13 / 350991（分数/本段/累计）');
    }
    el('rank-score').value = '140';
    const hit = await t.RankUI.queryRank();
    if (!hit || hit.cum !== 350991 || hit.seg !== 13 || hit.exact !== true) {
      throw new Error('查位次 140 应返回 350991/13/exact:true');
    }
    if (!el('rank-hit').innerHTML.includes('350991')) throw new Error('查位次结果未渲染');
    await t.RankUI.setFilter(2026, '历史类');
    html = el('rank-table-box').innerHTML || '';
    if (!html.includes('暂无数据')) throw new Error('2026 历史类应显示暂无数据');
    const srcRank = fs.readFileSync(path.join(APP, 'web', 'rank-ui.js'), 'utf8');
    if (/https?:\/\/|quark|YI_FEN_YI_DANG/.test(srcRank)) throw new Error('rank-ui.js 含外链');
    return '表格 + 查位次 + 无数据分支 + 零外链';
  });

  await check('v3 院校三级：列表 / 详情 / 四列结果表（无录取人数）', async () => {
    if (!t.CollegeUI) throw new Error('CollegeUI 未挂载');
    await t.CollegeUI.render();
    let html = registry.get('#college-content')?.innerHTML || '';
    if (!html.includes('college-item') || !html.includes('河北')) throw new Error('一级学校列表未渲染');
    await t.CollegeUI.showList('师范');
    html = registry.get('#college-content')?.innerHTML || '';
    if (!html.includes('师范')) throw new Error('学校搜索未生效');
    await t.CollegeUI.showDetail(208);
    html = registry.get('#college-content')?.innerHTML || '';
    if (!html.includes('河北师范大学') || !html.includes('college-back')) throw new Error('二级详情/返回列表未渲染');
    for (const label of ['地区', '年份', '专业', '科类']) {
      if (!html.includes(label)) throw new Error(`二级缺少筛选项 ${label}`);
    }
    const result = registry.get('#college-result')?.innerHTML || '';
    const ths = (result.match(/<th>/g) || []).length;
    if (ths !== 4) throw new Error(`结果表应恰为 4 列，实际 ${ths}`);
    for (const h of ['专业', '最低分', '位次', '计划数']) {
      if (!result.includes(`<th>${h}</th>`)) throw new Error(`结果表缺少列 ${h}`);
    }
    if (result.includes('录取人数') || result.includes('admit')) throw new Error('结果表出现录取人数列/值');
    if (!result.includes('计划数来自招生计划库')) throw new Error('计划数未标明来源');
    return `${ths} 列 · 四列固定 · 无录取人数`;
  });

  await check('未登录时历史/草稿不渲染数据', async () => {
    const saved = ctx.AuthUI.isAuthenticated;
    ctx.AuthUI.isAuthenticated = () => false;
    await t.HistoryUI.render();
    await t.DraftUI.render();
    ctx.AuthUI.isAuthenticated = saved;
    const h = registry.get('#history-result')?.innerHTML || '';
    const d = registry.get('#drafts-result')?.innerHTML || '';
    if (!h.includes('请先登录') || !d.includes('请先登录')) throw new Error('未登录门禁未生效');
    if (h.includes('条记录') || d.includes('份草稿')) throw new Error('未登录仍渲染了数据摘要');
    return '两个页面均提示登录';
  });

  const histSlots = [
    { order: 7, school: { name: '甲大学', province: '河北' }, group: '', major: '', tier: 'chong', tierLabel: '冲',
      probability: 35, latest: { min: 520, rank: 12000 }, reason: ['理由A'], batch: '本科批', subjectReq: '物理' },
    { order: 3, school: { name: '乙大学', province: '河北' }, group: '（01）', major: '计算机', tier: 'wen', tierLabel: '稳',
      probability: 60, latest: { min: 500, rank: 21000 }, reason: ['理由B'], batch: '本科批', subjectReq: '物理' },
  ];
  const createdHistory = await apiJson('/api/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meta: { province: '河北', type: '历史类', score: 500, rank: 12345, refYears: [2025, 2024] },
      slots: histSlots, context: { score: 500, subjects: '历史' },
    }),
  });

  await check('历史列表渲染（时间 / meta / 条数）', async () => {
    await t.HistoryUI.render();
    const html = registry.get('#history-result')?.innerHTML || '';
    if (!html.includes('填报历史记录') || !html.includes('河北') || !html.includes('2')) throw new Error('列表缺少摘要字段');
    if (!html.includes('导入为草稿') || !html.includes('查看详情')) throw new Error('缺少操作按钮');
    const listCalls = registry.get('#history-result')?._queryCalls || [];
    if (!listCalls.some((sel) => sel.includes('data-hist-import'))) throw new Error('列表导入按钮未绑定事件');
    return `${html.length} 字符 · 列表导入按钮已绑定`;
  });

  await check('历史详情保留概率 / 位次等原字段', async () => {
    const item = await t.HistoryUI.loadDetail(createdHistory.item.id);
    if (!item) throw new Error('详情读取失败');
    const detailEl = registry.get('#history-detail');
    const html = detailEl?.innerHTML || '';
    for (const v of ['35%', '60%', '12,000', '甲大学', '计算机']) {
      if (!html.includes(v)) throw new Error(`详情缺少 ${v}`);
    }
    // 回归：详情 DOM 是异步注入的，loadDetail 必须对其重新 bindActions，
    // 否则真实浏览器里详情内的「导入为草稿」按钮没有事件监听器。
    const calls = detailEl?._queryCalls || [];
    if (!calls.some((sel) => sel.includes('data-hist-import-detail'))) {
      throw new Error('详情导入按钮未绑定事件');
    }

    // 事件派发级验证：拦截详情容器的绑定回调并真实触发 click，
    // 证明点击详情内「导入为草稿」会生成草稿并切到草稿箱（QA 报的失败路径）。
    const savedGet = doc.getElementById;
    const dispatchDetail = makeEl('div');
    let detailClick = null;
    dispatchDetail.querySelectorAll = (sel) => {
      if (String(sel).includes('data-hist-import-detail')) {
        return [{
          dataset: { histImportDetail: createdHistory.item.id },
          addEventListener(type, fn) { if (type === 'click') detailClick = fn; },
        }];
      }
      return [];
    };
    doc.getElementById = (id) => (id === 'history-detail' ? dispatchDetail : savedGet(id));
    const tabEl = doc.querySelector('[data-tab="drafts"]');
    const origTabClick = tabEl.click;
    let switched = 0;
    tabEl.click = () => { switched++; };
    try {
      await t.HistoryUI.loadDetail(createdHistory.item.id);
      if (!detailClick) throw new Error('详情导入按钮未注册 click 监听器');
      await detailClick();
    } finally {
      doc.getElementById = savedGet;
      tabEl.click = origTabClick;
    }
    if (switched !== 1) throw new Error('详情导入后未切换到草稿箱');
    const drafts = await apiJson('/api/drafts');
    const imported = (drafts.items || []).find((d) => d.sourceHistoryId === createdHistory.item.id);
    if (!imported) throw new Error('详情导入未生成草稿');
    await apiJson('/api/drafts/' + imported.id, { method: 'DELETE' });
    return `${html.length} 字符 · 详情按钮 click 已派发：生成草稿并切页`;
  });

  await check('§3.2 草稿导入映射（不污染原快照）', () => {
    const before = JSON.stringify(histSlots);
    const rows = t.DraftUI.mapSlotsToDraftRows(histSlots);
    if (rows.length !== 2) throw new Error('行数不符');
    if (rows.map((r) => r.order).join(',') !== '1,2') throw new Error('序号未重排 1..n');
    if (!rows.every((r) => r.obey === '是')) throw new Error('服从调剂非「是」');
    if (rows[0].school !== '甲大学' || rows[1].major !== '计算机') throw new Error('院校/专业映射错误');
    if (rows[0].tier !== 'chong' || rows[0].tierLabel !== '冲') throw new Error('梯度映射错误');
    if (!/本科批/.test(rows[0].note) || !/理由A/.test(rows[0].note)) throw new Error('备注未含理由与批次');
    const banned = ['probability', 'majorProb', 'majorOptions', 'latest', 'hist', 'baseDiff', 'baseRank', 'years', 'stable', 'batch', 'subjectReq'];
    if (rows.some((r) => banned.some((k) => k in r))) throw new Error('概率/位次等字段混进草稿行');
    if (JSON.stringify(histSlots) !== before) throw new Error('映射修改了原快照');
    return Object.keys(rows[0]).join('/');
  });

  await check('草稿箱渲染 + 保存 + 删除', async () => {
    const rows = t.DraftUI.mapSlotsToDraftRows(histSlots);
    const created = await t.DraftUI.saveDraft(null, { name: '历史导入草稿', rows, sourceHistoryId: createdHistory.item.id });
    if (!created || created.rows.length !== 2) throw new Error('新建草稿失败');
    await t.DraftUI.render();
    let html = registry.get('#drafts-result')?.innerHTML || '';
    if (!html.includes('历史导入草稿') || !html.includes('生成方案导入')) throw new Error('草稿列表未渲染');
    const saved = await t.DraftUI.saveDraft(created.id, { name: '改名草稿', rows: [rows[0]] });
    if (!saved || saved.name !== '改名草稿' || saved.rows.length !== 1) throw new Error('编辑保存失败');
    const ok = await t.DraftUI.deleteDraft(created.id);
    if (!ok) throw new Error('删除草稿失败');
    await t.HistoryUI.removeHistory(createdHistory.item.id);
    return '新建 / 列表 / 保存 / 删除 / 历史清理全通';
  });

  console.log(results.map(([m, n, d]) => `  ${m} ${n}${d ? '  — ' + d : ''}`).join('\n'));
  console.log(`\n═══ 渲染测试：通过 ${pass} 项，失败 ${fail} 项 ═══`);

  server.kill();
  await sleep(200);
  for (const name of ['history.json', 'drafts.json', 'wishlist.json']) {
    try { fs.writeFileSync(path.join(APP, 'data', name), '[]', 'utf8'); } catch { /* 清理失败不影响测试结论 */ }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

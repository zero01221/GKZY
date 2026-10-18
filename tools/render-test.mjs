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

// ---------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------
function makeEl(tag = 'div') {
  const el = {
    tagName: tag, id: '', value: '', textContent: '', options: [], dataset: {},
    style: {}, files: [], children: [], _html: '',
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
    querySelectorAll() { return []; },
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
    fetch: (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o),
    navigator: { userAgent: 'node' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(APP, 'web', 'app.js'), 'utf8');
  const src2 = fs.readFileSync(path.join(APP, 'web', 'plan-ui.js'), 'utf8');
  // 脚本顶层 function 声明会成为沙箱全局属性，借此暴露内部函数用于断言
  const driver = `
    globalThis.__t = { S, esc, fmt, lineChart, tierTag, renderScoreResult, renderRecommend, recCard,
      renderWishlist, renderData, showCampus, runCampusSearch, runScoreQuery, runRecommend, loadTrend,
      runPlan, renderPlan, planRow, renderSubjectChips, selectedSubjects, exportPlan, moveSlot,
      initResource, refreshRankOptions, queryRankScore, showRankTable, queryCodes,
      aiRenderMessages, renderMarkdown, renderAiAdvice, refreshAiProfile, aiCfgLoad, aiCfgSave, AI, PLAN };
  `;
  vm.runInContext(src + '\n' + src2 + driver, ctx, { filename: 'app.js' });
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
  const { t, registry, doc } = loadApp();
  if (!t) { console.error('无法取得 app.js 内部函数'); server.kill(); process.exit(1); }
  const el = (id) => doc.querySelector('#' + id);      // 按需创建/取用元素
  await sleep(1200);                                    // 等 init() 的异步请求完成

  const meta = await (await fetch(`${BASE}/api/meta`)).json();
  const r1 = await (await fetch(`${BASE}/api/schools?q=${encodeURIComponent('中山大学')}&size=1`)).json();
  const school = r1.items[0];
  const prov = await (await fetch(`${BASE}/api/score/province?schoolId=104&provinceId=44`)).json();
  const spec = await (await fetch(`${BASE}/api/score/special?schoolId=104&provinceId=44&year=2025`)).json();
  const rec = await (await fetch(`${BASE}/api/recommend?provinceId=11&type=${encodeURIComponent('综合')}&score=600&limit=12`)).json();
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
    if (!html.includes('专业录取分数线')) throw new Error('缺少专业分数线区块');
    return `${html.length} 字符`;
  });

  await check('renderRecommend 冲稳保结果页', () => {
    t.renderRecommend(rec, { pid: 11, type: '综合', major: '' });
    const html = registry.get('#r-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('HTML 含 undefined/NaN');
    for (const k of ['冲', '稳', '保']) if (!html.includes(k)) throw new Error(`缺少「${k}」档`);
    return `${html.length} 字符`;
  });

  await check('recCard 推荐卡片', () => {
    const c = rec.tiers.chong[0];
    const html = t.recCard(c, 'chong', false);
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    if (!html.includes(c.school.name)) throw new Error('未包含院校名');
    return `${html.length} 字符`;
  });

  await check('recCard 显示推荐专业（不只学校）', () => {
    const all = [...rec.tiers.chong, ...rec.tiers.wen, ...rec.tiers.bao];
    const withMajor = all.find((x) => (x.majors || []).length);
    if (!withMajor) throw new Error('推荐结果里没有任何专业数据');
    const html = t.recCard(withMajor, 'chong', false);
    if (!html.includes('推荐专业')) throw new Error('卡片未渲染「推荐专业」标签');
    if (!html.includes(withMajor.majors[0].major)) throw new Error('卡片未渲染具体专业名');
    if (!/mchip/.test(html)) throw new Error('未渲染专业 chip');
    return `${withMajor.school.name} → ${withMajor.majors.slice(0, 3).map((m) => m.major).join('/')}`;
  });

  await check('推荐结果含专业代码与命中标记', () => {
    const all = [...rec.tiers.chong, ...rec.tiers.wen, ...rec.tiers.bao];
    const coded = all.filter((x) => (x.majors || []).some((m) => m.code));
    if (!coded.length) throw new Error('没有任何专业代码');
    const hit = all.filter((x) => x.majorHit);
    return `${coded.length}/${all.length} 条带专业代码，${hit.length} 条命中意向专业`;
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

  await check('runRecommend 完整表单流程（推荐页）', async () => {
    el('r-province').value = '11';
    el('r-type').value = '综合';
    el('r-mode').value = 'score';
    el('r-score').value = '600';
    el('r-rank').value = '';
    el('r-major').value = '';
    t.runRecommend();
    await sleep(3500);
    const html = registry.get('#r-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    if (!html.includes('推荐结果')) throw new Error('未渲染结果：' + html.replace(/<[^>]+>/g, ' ').trim().slice(0, 60));
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
    if (!html.includes('志愿方案')) throw new Error('未渲染方案：' + html.replace(/<[^>]+>/g, ' ').trim().slice(0, 80));
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

  console.log('\n  ── 资料库 ──');

  await check('initResource 加载一分一段索引', async () => {
    await t.initResource();
    await sleep(800);
    const html = registry.get('#res-hint')?.innerHTML || '';
    if (!html.includes('一分一段')) throw new Error('未渲染提示');
    return html.replace(/<[^>]+>/g, ' ').trim().slice(0, 70);
  });

  await check('queryRankScore 分数查位次', async () => {
    el('rk-province').value = '广东';
    el('rk-year').value = '2026';
    el('rk-type').value = '物理类';
    el('rk-score').value = '600';
    t.queryRankScore();
    await sleep(2500);
    const html = registry.get('#rk-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    if (!html.includes('全省位次')) throw new Error('未渲染位次：' + html.replace(/<[^>]+>/g, ' ').trim().slice(0, 80));
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  });

  await check('showRankTable 完整表格', async () => {
    t.showRankTable();
    await sleep(2500);
    const html = registry.get('#rk-result')?.innerHTML || '';
    if (!html.includes('一分一段表')) throw new Error('未渲染表格');
    if (!html.includes('累计人数')) throw new Error('缺表头');
    return `${html.length} 字符`;
  });

  await check('queryCodes 院校/专业代码', async () => {
    el('cd-school').value = '中山大学';
    el('cd-province').value = '44';
    el('cd-year').value = '2025';
    t.queryCodes();
    await sleep(6000);
    const html = registry.get('#cd-result')?.innerHTML || '';
    if (html.includes('undefined')) throw new Error('含 undefined');
    if (!html.includes('院校代码')) throw new Error('未渲染代码：' + html.replace(/<[^>]+>/g, ' ').trim().slice(0, 80));
    if (!html.includes('10558')) throw new Error('未渲染院校代码数值');
    if (!html.includes('专业代码')) throw new Error('未渲染专业代码表头');
    if (!/\d+[A-Z]?<\/b>/.test(html)) throw new Error('未渲染任何专业代码');
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
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

  console.log(results.map(([m, n, d]) => `  ${m} ${n}${d ? '  — ' + d : ''}`).join('\n'));
  console.log(`\n═══ 渲染测试：通过 ${pass} 项，失败 ${fail} 项 ═══`);

  server.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

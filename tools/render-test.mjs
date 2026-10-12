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
  const document = {
    querySelector(sel) { if (!registry.has(sel)) registry.set(sel, makeEl(sel)); return registry.get(sel); },
    querySelectorAll() { return []; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
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
  // 脚本顶层 function 声明会成为沙箱全局属性，借此暴露内部函数用于断言
  const driver = `
    globalThis.__t = { S, esc, fmt, lineChart, tierTag, renderScoreResult, renderRecommend, recCard,
      renderWishlist, renderData, showCampus, runCampusSearch, runScoreQuery, runRecommend, loadTrend };
  `;
  vm.runInContext(src + driver, ctx, { filename: 'app.js' });
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
    await sleep(1500);
    const html = registry.get('#d-result')?.innerHTML || '';
    if (html.includes('undefined') || html.includes('NaN')) throw new Error('含 undefined/NaN');
    if (!html.includes('本地索引覆盖')) throw new Error('缺少覆盖情况区块');
    return `${html.length} 字符`;
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

  console.log(results.map(([m, n, d]) => `  ${m} ${n}${d ? '  — ' + d : ''}`).join('\n'));
  console.log(`\n═══ 渲染测试：通过 ${pass} 项，失败 ${fail} 项 ═══`);

  server.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

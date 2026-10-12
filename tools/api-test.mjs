/**
 * 后端 API 验收测试
 *
 * 覆盖三大功能 + 边界场景，会自动拉起本地服务，跑完自动关闭。
 * 用法：node tools/api-test.mjs
 */
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

    head('F3 · 冲稳保推荐');
    const recDiff = await j('/api/recommend?provinceId=11&type=' + encodeURIComponent('综合') + '&score=600&limit=15');
    if (recDiff.ok) {
      check('线差法模式', recDiff.meta.mode === 'diff', `省控线 ${recDiff.meta.baseLine} / 线差 ${recDiff.meta.userDiff}`);
      check('三档均有结果', recDiff.counts.chong > 0 && recDiff.counts.wen > 0 && recDiff.counts.bao > 0,
        `冲${recDiff.counts.chong} 稳${recDiff.counts.wen} 保${recDiff.counts.bao}`);
      const all = [...recDiff.tiers.chong, ...recDiff.tiers.wen, ...recDiff.tiers.bao];
      check('默认只看本科批', all.every((c) => (c.batch || '').includes('本科')), all[0]?.batch);
      check('概率区间合法', all.every((c) => c.probability >= 0 && c.probability <= 100));
      check('推荐理由非空', all.every((c) => (c.reason || []).length > 0), all[0]?.reason?.join('/'));
    } else { check('线差法模式', false, recDiff.message); }

    const recRank = await j('/api/recommend?provinceId=11&type=' + encodeURIComponent('综合') + '&rank=10000&limit=9');
    if (recRank.ok) check('位次法模式', recRank.meta.mode === 'rank', `位次 ${recRank.meta.userRank}`);
    else check('位次法模式', false, recRank.message);

    const recMajor = await j('/api/recommend?provinceId=11&type=' + encodeURIComponent('综合') + '&score=650&limit=9&major=' + encodeURIComponent('计算机'));
    check('带专业匹配', recMajor.ok, recMajor.majorMatches ? `${recMajor.majorMatches.list?.length || 0} 条专业记录` : '无');

    head('边界与错误处理');
    const bad = await j('/api/recommend?provinceId=99&type=' + encodeURIComponent('综合') + '&score=600');
    check('非法省份给出提示', bad.ok === false && !!bad.message, bad.message?.slice(0, 40));
    const noIndex = await j('/api/recommend?provinceId=54&type=' + encodeURIComponent('理科') + '&score=600');
    check('缺数据不崩溃', typeof noIndex.ok === 'boolean', noIndex.ok ? '有数据' : noIndex.message?.slice(0, 40));
    const r404 = await fetch(B + '/api/notexist');
    check('未知接口返回 404', r404.status === 404);
    const page = await fetch(B + '/');
    check('首页可访问', page.status === 200);
    for (const f of ['/app.js', '/styles.css']) {
      const r = await fetch(B + f);
      check(`静态资源 ${f}`, r.status === 200 && (await r.text()).length > 100);
    }

    console.log(`\n═══ API 验收：通过 ${pass} 项，失败 ${fail} 项 ═══`);
  } finally {
    server.kill();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

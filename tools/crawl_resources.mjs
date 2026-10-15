/**
 * 资料库抓取：一分一段表（真实数据）
 *
 * 数据来源：中国教育在线 / 掌上高考（gaokao.eol.cn、www.eol.cn）
 *   2026 索引：https://gaokao.eol.cn/e_html/gk/gkfsd/index.shtml
 *   历史归档：https://www.eol.cn/e_html/gk/gkfsd/<年份>.shtml
 *
 * 说明：
 *   - 部分省份以「图片」形式发布一分一段表，脚本会如实标注 table=false 并保留原文链接，
 *     绝不编造数据。
 *   - 各省表格列结构不统一（3~15 列），normalize 命令会把它统一成
 *     [[分数, 累计人数, 本段人数], ...]（分数降序）。
 *
 * 用法：
 *   node tools/crawl_resources.mjs rank --years 2026,2025
 *   node tools/crawl_resources.mjs normalize
 *   node tools/crawl_resources.mjs verify
 *   node tools/crawl_resources.mjs status
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'resources');
fs.mkdirSync(OUT, { recursive: true });
const RANK_FILE = path.join(OUT, 'rank_table.json');

const HDR = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PINYIN_PROVINCE = {
  bei_jing: '北京', tian_jin: '天津', he_bei: '河北', shan_xi: '山西', nei_meng_gu: '内蒙古',
  liao_ning: '辽宁', ji_lin: '吉林', hei_long_jiang: '黑龙江', shang_hai: '上海', jiang_su: '江苏',
  zhe_jiang: '浙江', an_hui: '安徽', fu_jian: '福建', jiang_xi: '江西', shan_dong: '山东',
  he_nan: '河南', hu_bei: '湖北', hu_nan: '湖南', guang_dong: '广东', guang_xi: '广西',
  hai_nan: '海南', chong_qing: '重庆', si_chuan: '四川', gui_zhou: '贵州', yun_nan: '云南',
  xi_zang: '西藏', shaan_xi: '陕西', gan_su: '甘肃', qing_hai: '青海', ning_xia: '宁夏', xin_jiang: '新疆',
};
const RANK_INDEXES = {
  2026: 'https://gaokao.eol.cn/e_html/gk/gkfsd/index.shtml',
  2025: 'https://www.eol.cn/e_html/gk/gkfsd/2025.shtml',
  2024: 'https://www.eol.cn/e_html/gk/gkfsd/2024.shtml',
  2023: 'https://www.eol.cn/e_html/gk/gkfsd/2023.shtml',
};

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: HDR, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      const buf = Buffer.from(await r.arrayBuffer());
      const u = buf.toString('utf8');
      const text = (u.match(/\uFFFD/g) || []).length > 20 ? new TextDecoder('gbk').decode(buf) : u;
      return { status: r.status, text, url: r.url };
    } catch (e) {
      if (i === 3) throw e;
      await sleep(1200 + i * 800);
    }
  }
}
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const num = (s) => Number(String(s).replace(/[,，\s]/g, ''));

function extractTables(html) {
  const out = [];
  for (const tm of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [];
    for (const rm of tm[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...rm[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => strip(c[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length >= 3) out.push(rows);
  }
  return out;
}
const provinceFromUrl = (u) => { const m = /\/([a-z_]+)\/dongtai\//.exec(u); return (m && PINYIN_PROVINCE[m[1]]) || ''; };
function provinceFromText(t) {
  for (const name of Object.values(PINYIN_PROVINCE)) if (t.startsWith(name) || t.includes(name)) return name;
  return '';
}
const typeFromText = (t) => {
  if (/物理类|物理科目|理科/.test(t)) return '物理类';
  if (/历史类|历史科目|文科/.test(t)) return '历史类';
  if (/综合|本科阶段|总成绩|成绩分布|成绩统计|第一阶段|一分一段表$/.test(t)) return '综合';
  return '';
};

// ===============================================================
// 归一化：把各省五花八门的表格统一成 [[分数, 累计人数, 本段人数], ...]
//
// 实测需要处理的坑：
//   1. 表头行夹杂在数据里（如山西重复出现「分数/本分人数/累计人数」）
//   2. 左右分栏：一张表里并排放两组「分数|本段|累计」（山西、部分年份）
//   3. 多组累计列：如广东「分数|本段|累计|本段|累计」（含加分/不含加分）
//   4. 首行是「695 分以上」这种文字
//   5. 部分省份官方只发布部分分段（存在缺口），需如实标记
// ===============================================================
const cellNum = (s) => {
  const t = String(s).replace(/[,，\s]/g, '');
  const m = /^(\d+(?:\.\d+)?)分以上$/.exec(t);
  if (m) return Number(m[1]);
  return Number(t);
};

export function normalizeRows(rows) {
  if (!rows || rows.length < 10) return null;
  const numRows = rows
    .map((r) => r.map(cellNum))
    .filter((r) => r.filter(Number.isFinite).length >= Math.ceil(r.length * 0.5));
  if (numRows.length < 10) return null;
  const ncol = Math.max(...numRows.map((r) => r.length));

  // 1) 找所有「分数列」：取值 50~800、整体单调不增、跨度 > 50
  const scoreCols = [];
  for (let c = 0; c < ncol; c++) {
    const v = numRows.map((r) => r[c]).filter(Number.isFinite);
    if (v.length < numRows.length * 0.6) continue;
    const max = Math.max(...v), min = Math.min(...v);
    if (min < 20 || max > 800 || max - min < 50) continue;
    let mono = true;
    for (let i = 1; i < v.length; i++) if (v[i] > v[i - 1] + 1e-9) { mono = false; break; }
    if (mono) scoreCols.push({ c, max, min, span: max - min });
  }
  if (!scoreCols.length) return null;

  // 2) 找所有「累计人数列」：单调不减、末值 > 1000
  const cumCols = [];
  for (let c = 0; c < ncol; c++) {
    const v = numRows.map((r) => r[c]).filter(Number.isFinite);
    if (v.length < numRows.length * 0.6) continue;
    let mono = true;
    for (let i = 1; i < v.length; i++) if (v[i] < v[i - 1] - 1e-9) { mono = false; break; }
    if (!mono) continue;
    const end = v[v.length - 1];
    if (end > 1000) cumCols.push({ c, end });
  }
  if (!cumCols.length) return null;

  // 3) 每个累计列配到「它左边最近的分数列」；同一分数列有多个累计列时取末值最大的
  const byScore = new Map();          // scoreCol -> { cumCol, end }
  for (const cum of cumCols) {
    let best = null;
    for (const sc of scoreCols) if (sc.c < cum.c && (!best || sc.c > best.c)) best = sc;
    if (!best) continue;
    const prev = byScore.get(best.c);
    if (!prev || cum.end > prev.end) byScore.set(best.c, { cumCol: cum.c, end: cum.end });
  }
  if (!byScore.size) return null;

  // 4) 逐块取出 (分数, 累计)，最后按分数降序合并
  const points = [];
  for (const [sc, { cumCol }] of byScore) {
    for (const r of numRows) {
      const s = r[sc], cum = r[cumCol];
      if (!Number.isFinite(s) || !Number.isFinite(cum)) continue;
      points.push([Math.round(s), Math.round(cum)]);
    }
  }
  points.sort((a, b) => b[0] - a[0]);
  // 同分数去重（保留较小的累计，即更保守）
  const dedup = [];
  for (const p of points) {
    if (dedup.length && dedup[dedup.length - 1][0] === p[0]) {
      dedup[dedup.length - 1][1] = Math.min(dedup[dedup.length - 1][1], p[1]);
      continue;
    }
    dedup.push(p);
  }
  if (dedup.length < 10) return null;

  // 5) 由累计差生成「本段人数」
  const series = [];
  let prevCum = 0;
  for (const [s, cum] of dedup) {
    if (cum < prevCum) continue;                 // 保守：跳过不合理的累计回退
    series.push([s, cum, Math.max(0, cum - prevCum)]);
    prevCum = cum;
  }
  if (series.length < 10) return null;

  // 6) 检测缺口（相邻分数不连续）
  const gaps = [];
  for (let i = 1; i < series.length; i++) {
    const hi = series[i - 1][0], lo = series[i][0];
    if (hi - lo > 1) gaps.push([hi - 1, lo + 1]);
  }
  const covered = series[series.length - 1][0] === undefined ? 0
    : series[series.length - 1][0];
  return { blocks: byScore.size, series, gaps, full: gaps.length === 0 };
}

// ===============================================================
// 1. 抓取一分一段表
// ===============================================================
async function crawlRank(years, indexUrlOverride) {
  console.log('== 抓取一分一段表 ==');
  let store = { source: '中国教育在线（gaokao.eol.cn / www.eol.cn）', items: [] };
  if (fs.existsSync(RANK_FILE)) { try { store = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); } catch { /* ignore */ } }
  const byUrl = new Map((store.items || []).map((x) => [x.url, x]));
  console.log(`  已有 ${byUrl.size} 篇，本次合并写入`);

  const targets = [];
  const seen = new Set();
  for (const year of years) {
    const indexUrl = indexUrlOverride || RANK_INDEXES[year];
    if (!indexUrl) { console.log(`  ⚠ 年份 ${year} 无已知索引页，跳过`); continue; }
    let idx;
    try { idx = await get(indexUrl); } catch (e) { console.log(`  ✗ 索引页失败 ${indexUrl} :: ${e.message}`); continue; }
    console.log(`  索引页 ${year} [${idx.status}] len=${idx.text.length}  ${indexUrl}`);
    let hit = 0;
    for (const m of idx.text.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,80}?)<\/a>/g)) {
      const label = strip(m[2]);
      if (!/(一分一段|分段表|成绩统计|成绩分布|分数分布|分数段|位次|考生成绩)/.test(label)) continue;
      let href; try { href = new URL(m[1], indexUrl).href; } catch { continue; }
      const ym = /(20\d\d)\s*年/.exec(label) || /\/t(20\d\d)/.exec(href);
      if (!ym || Number(ym[1]) !== year) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      targets.push({ label, href, year, province: provinceFromText(label) || provinceFromUrl(href), type: typeFromText(label) });
      hit++;
    }
    console.log(`    命中 ${hit} 篇`);
  }

  const todo = targets.filter((t) => !byUrl.get(t.href)?.table);
  console.log(`  待抓取 ${todo.length} 篇（已有表格的跳过）`);
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    try {
      const p = await get(t.href);
      const tables = extractTables(p.text);
      let best = null;
      for (const rows of tables) {
        const flat = rows.flat().filter(Boolean);
        const numRatio = flat.filter((c) => Number.isFinite(num(c))).length / Math.max(1, flat.length);
        const score = rows.length + numRatio * 100;
        if (numRatio > 0.5 && rows.length > 20 && (!best || score > best.score)) best = { rows, score };
      }
      const item = {
        province: t.province, year: t.year, type: t.type, title: strip(t.label),
        url: t.href, table: !!best, rows: best?.rows || null, header: best?.rows?.[0] || null,
        images: [...p.text.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
          .filter((s) => /upload|image\/20/i.test(s) && !/logo|icon|qrcode|header/i.test(s)).slice(0, 10),
        fetchedAt: new Date().toISOString(),
      };
      byUrl.set(t.href, item);
      console.log(`  [${i + 1}/${todo.length}] ${(t.province || '?').padEnd(5)} ${t.year} ${(t.type || '?').padEnd(4)} ${best ? `表格 ${String(best.rows.length).padStart(4)} 行 ✓` : '图片发布 ⚠'}`);
    } catch (e) {
      console.log(`  [${i + 1}/${todo.length}] ✗ ${t.href} :: ${e.message}`);
    }
    await sleep(500);
  }

  const items = [...byUrl.values()].sort((a, b) => b.year - a.year || String(a.province).localeCompare(String(b.province), 'zh'));
  fs.writeFileSync(RANK_FILE, JSON.stringify({ source: store.source, updatedAt: new Date().toISOString(), items }, null, 1));
  console.log(`\n✓ ${RANK_FILE}  共 ${items.length} 篇`);
}

// ===============================================================
// 2. 归一化已有数据
// ===============================================================
function normalizeAll() {
  console.log('== 归一化一分一段表 ==');
  const store = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'));
  let ok = 0, fail = 0, multi = 0, gapped = 0;
  for (const it of store.items) {
    if (!it.table || !it.rows) { it.series = null; continue; }
    const r = normalizeRows(it.rows);
    if (r) {
      it.series = r.series;
      it.blocks = r.blocks;
      it.gaps = r.gaps;
      it.full = r.full;
      it.range = [r.series[r.series.length - 1][0], r.series[0][0]];
      it.total = r.series[r.series.length - 1][1];
      ok++;
      if (r.blocks > 1) multi++;
      if (!r.full) gapped++;
    } else { it.series = null; it.gaps = null; it.full = false; fail++; }
  }
  fs.writeFileSync(RANK_FILE, JSON.stringify({ ...store, normalizedAt: new Date().toISOString() }, null, 1));
  console.log(`  归一化成功 ${ok} 篇（其中左右分栏 ${multi} 篇），失败 ${fail} 篇，存在分数缺口 ${gapped} 篇`);
  console.log(`✓ ${RANK_FILE}`);
}

// ===============================================================
// 3. 校验（单调性 / 累计一致性 / 量级合理性）
// ===============================================================
function verify() {
  console.log('== 校验一分一段表 ==\n');
  const store = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'));
  const withSeries = store.items.filter((x) => Array.isArray(x.series) && x.series.length);
  console.log(`  有结构化数据的：${withSeries.length} 篇 / 共 ${store.items.length} 篇\n`);
  const PROBLEM = [];
  console.log('  省份    年份  科类    分数区间        累计人数   本段和校验        单调 分段');
  for (const it of withSeries.sort((a, b) => b.year - a.year || String(a.province).localeCompare(String(b.province), 'zh'))) {
    const s = it.series;
    let mono = true;
    for (let i = 1; i < s.length; i++) {
      if (s[i][0] > s[i - 1][0]) mono = false;
      if (s[i][1] < s[i - 1][1]) mono = false;
    }
    const sumCnt = s.reduce((a, r) => a + r[2], 0);
    const endCum = s[s.length - 1][1];
    const diff = Math.abs(sumCnt - endCum);
    const pass = mono && diff <= Math.max(5, endCum * 0.002) && endCum > 500;
    if (!pass) PROBLEM.push({ ...it, mono, sumCnt, endCum, diff });
    console.log(`  ${String(it.province).padEnd(6)} ${it.year}  ${String(it.type || '综合').padEnd(6)} ${String(it.range[0] + '~' + it.range[1]).padEnd(14)} ${String(endCum).padStart(8)}   ${String(sumCnt).padStart(8)}/${String(endCum).padStart(8)} ${diff === 0 ? '✓' : 'Δ' + diff}   ${mono ? '✓' : '✗'}   ${it.full ? '完整' : '缺口' + JSON.stringify(it.gaps)}`);
  }
  console.log(`\n  异常条目：${PROBLEM.length}`);
  for (const p of PROBLEM) console.log(`    ✗ ${p.province} ${p.year} ${p.type} 单调=${p.mono} 累计${p.endCum} 本段和${p.sumCnt} 差${p.diff}`);
  console.log('\n  仅图片发布（无结构化数据）：');
  const imgOnly = store.items.filter((x) => !Array.isArray(x.series));
  for (const it of imgOnly.sort((a, b) => b.year - a.year)) console.log(`    ${String(it.province).padEnd(6)} ${it.year}  ${it.type || '-'}   ${it.url}`);
}

// ===============================================================
function status() {
  const store = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'));
  const withSeries = store.items.filter((x) => Array.isArray(x.series) && x.series.length);
  console.log(`  rank_table.json: ${store.items.length} 篇，其中有结构化数据 ${withSeries.length} 篇`);
  const byYear = {};
  for (const x of withSeries) { byYear[x.year] = byYear[x.year] || new Set(); byYear[x.year].add(x.province); }
  for (const y of Object.keys(byYear).sort((a, b) => b - a)) console.log(`    ${y}: ${byYear[y].size} 个省 -> ${[...byYear[y]].sort().join(' ')}`);
}

(async () => {
  const cmd = process.argv[2] || 'status';
  const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  if (cmd === 'rank') { await crawlRank(argOf('years', '2026,2025').split(',').map(Number), argOf('index', '')); normalizeAll(); verify(); }
  else if (cmd === 'normalize') { normalizeAll(); verify(); }
  else if (cmd === 'verify') verify();
  else status();
})();

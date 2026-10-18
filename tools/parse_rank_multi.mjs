/**
 * 从「重复标题 + 多列」版式的一分一段页提取所有科类。
 *
 * 背景：河北 2026 的官方表格是「分数档次 | 物理(含优惠分) | 历史(含优惠分)」三列，
 * 且整张表被切成 19 个上下分块、每块重复标题与表头。
 * 原先的归一化只取了第 1 列 + 首块，导致历史类缺失。
 *
 * 用法：node tools/parse_rank_multi.mjs --url <页面> --province 河北 --year 2026
 *       node tools/parse_rank_multi.mjs --url <页面> --province 河北 --year 2026 --import
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const has = (n) => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

const URL = argOf('url', '');
const PROV = argOf('province', '');
const YEAR = Number(argOf('year', 0));
const IMPORT = has('import');
if (!URL || !PROV || !YEAR) { console.error('需要 --url --province --year'); process.exit(1); }

const cellsOf = (tr) => [...tr.matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)]
  .map((m) => m[0].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());

const num = (s) => {
  const t = String(s || '').replace(/[^\d.]/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** 科类列名 -> 标准科类名 */
function normType(label) {
  if (/物理/.test(label)) return '物理类';
  if (/历史/.test(label)) return '历史类';
  if (/综合|不分|普通类/.test(label)) return '综合';
  if (/理科/.test(label)) return '理科';
  if (/文科/.test(label)) return '文科';
  return null;
}

const r = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122' }, signal: AbortSignal.timeout(90000) });
if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1); }
let html = Buffer.from(await r.arrayBuffer()).toString('utf8');
if (/charset=["']?gb/i.test(html.slice(0, 3000))) {
  try { html = new TextDecoder('gbk').decode(Buffer.from(html, 'latin1')); } catch { /* ignore */ }
}

const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
console.log(`页面表格数 ${tables.length}, 大小 ${html.length}`);

/**
 * 从一张表里切块提取。
 * 支持两种版式：
 *   A) 3 列：分数档次 | 物理(含优惠分) | 历史(含优惠分)        —— 值为「累计人数」
 *   B) 5 列：分数档次 | 人数 | 累计人数 | 人数 | 累计人数      —— 两级表头，值为「本段/累计」
 * 通过第二级表头（人数/累计人数）自动识别。
 */
function extract(table) {
  const trs = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => cellsOf(m[0]));
  const out = new Map();            // type -> Map(score -> {cum, seg})
  let types = null;                 // ['物理类','历史类']
  let perType = 1;                  // 1=只有累计；2=本段+累计

  const put = (type, score, cum, seg) => {
    if (!out.has(type)) out.set(type, new Map());
    const m = out.get(type);
    const prev = m.get(score);
    // 同一分数可能跨块重复出现，取累计更大的那条
    if (!prev || cum > prev.cum) m.set(score, { cum, seg });
  };

  for (const c of trs) {
    const first = c[0] || '';
    // 一级表头：分数档次 + 若干科类
    if (c.length >= 3 && /分数|档次/.test(first) && c.slice(1).some((x) => /物理|历史|综合|理科|文科/.test(x))) {
      types = c.slice(1).map(normType);
      perType = 1;
      continue;
    }
    // 二级表头：人数 / 累计人数 ...（说明数据行是 本段+累计 两列一组）
    if (c.length >= 2 && c.every((x) => x === '' || /^(人数|累计人数|分数|档次)$/.test(x))) {
      if (types && /累计人数/.test(c.join(','))) perType = 2;
      continue;
    }
    if (!types) continue;
    const score = num(first);
    if (score === null || score < 100 || score > 750) continue;

    for (let g = 0; g < types.length; g++) {
      const type = types[g];
      if (!type) continue;
      if (perType === 2) {
        const segCol = 1 + 2 * g, cumCol = 2 + 2 * g;
        if (c.length <= cumCol) continue;
        const cum = num(c[cumCol]);
        if (cum === null) continue;
        put(type, score, cum, num(c[segCol]));
      } else {
        const cumCol = 1 + g;
        if (c.length <= cumCol) continue;
        const cum = num(c[cumCol]);
        if (cum === null) continue;
        put(type, score, cum, null);
      }
    }
  }
  return out;
}

const merged = new Map();
for (const t of tables) {
  for (const [type, m] of extract(t)) {
    if (!merged.has(type)) merged.set(type, new Map());
    const dst = merged.get(type);
    for (const [s, v] of m) {
      const prev = dst.get(s);
      if (!prev || v.cum > prev.cum) dst.set(s, v);
    }
  }
}

if (!merged.size) { console.error('未提取到任何数据'); process.exit(1); }

const results = [];
for (const [type, m] of merged) {
  const scores = [...m.keys()].sort((a, b) => b - a);
  // 优先用源表自带的「本段人数」；没有就用相邻档累计差分
  const series = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const { cum, seg } = m.get(s);
    let segFinal = seg;
    if (segFinal === null || segFinal === undefined) {
      const nextCum = i + 1 < scores.length ? m.get(scores[i + 1]).cum : cum;
      segFinal = Math.max(0, cum - nextCum);
    }
    series.push([s, cum, segFinal]);
  }
  const total = series[series.length - 1][1];
  const gaps = [];
  for (let i = 1; i < series.length; i++) if (series[i - 1][0] - series[i][0] > 1) gaps.push([series[i - 1][0] - 1, series[i][0] + 1]);
  results.push({ type, series, total, range: [series[series.length - 1][0], series[0][0]], gaps });
  console.log(`  ${type.padEnd(6)} ${String(series.length).padStart(4)} 档  区间 ${series[series.length - 1][0]}~${series[0][0]}  考生 ${total.toLocaleString()}  缺口 ${gaps.length}`);
}

// 自洽校验：本段人数之和 == 末档累计
let allOk = true;
for (const t of results) {
  const sum = t.series.reduce((a, x) => a + x[2], 0);
  const ok = sum === t.total;
  if (!ok) allOk = false;
  console.log(`  自洽校验 ${t.type}: 本段和 ${sum.toLocaleString()} vs 末档累计 ${t.total.toLocaleString()} -> ${ok ? '✅' : '❌ 差 ' + (sum - t.total)}`);
}
if (!allOk) console.log('  ⚠ 存在不自洽的表，建议人工复核');

if (!IMPORT) { console.log('\n--import 才会写库'); process.exit(0); }

// ---------- 写入 SQLite ----------
const DB = path.resolve(ROOT, argOf('db', '高考志愿助手/data/gaokao.db'));
const db = new DatabaseSync(DB);
const dictBox = new Map();
function box(t) {
  if (!dictBox.has(t)) {
    const byName = new Map(); let max = 0;
    for (const x of db.prepare('SELECT id, v FROM dict WHERE t=?').all(t)) { byName.set(x.v, x.id); if (x.id > max) max = x.id; }
    dictBox.set(t, { byName, max });
  }
  return dictBox.get(t);
}
const insDict = db.prepare('INSERT INTO dict (id, t, v) VALUES (?,?,?)');
function did(t, v) {
  const s = String(v == null ? '' : v).trim(); if (!s) return 0;
  const b = box(t);
  if (b.byName.has(s)) return b.byName.get(s);
  const id = ++b.max; b.byName.set(s, id); insDict.run(id, t, s); return id;
}
const pid = did('province', PROV);
const del = db.prepare('DELETE FROM score_range WHERE p=? AND y=? AND c=?');
const ins = db.prepare('INSERT INTO score_range (p,y,c,b,ctrl,score,seg,cum) VALUES (?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for (const t of results) {
  const cid = did('category', t.type);
  del.run(pid, YEAR, cid);
  for (const [score, cum, seg] of t.series) ins.run(pid, YEAR, cid, 0, 0, score, seg, cum);
}
db.exec('COMMIT');
try { db.exec('ANALYZE'); } catch { /* */ }
console.log(`\n已写入 ${PROV} ${YEAR}：${results.map((t) => t.type).join(' / ')}`);
db.close();

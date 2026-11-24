/**
 * @file 一分一段「真不自洽」存量修复工具（零第三方依赖、零联网、只读原有数据源）
 *
 * 背景：
 *   gaokao.db 的 score_range 按 (p,y,c) 分组审计时，约 50 组出现「Σseg 与末 cum 不符」
 *   或「累计人数回退」。逐组排查表明这些并非官方原始表数值错误，而是导入期产生的
 *   结构性缺陷：
 *     R1 同一 CSV 被重复导入，整组行完全重复（Σseg 恰为末 cum 的 2 倍）；
 *     R2 官方表被补齐成连续整数分数网格，同一 cum 及其 seg 被复制到多行
 *        （合并单元格展开 / 同分段重复计数），按 cum 折叠后 Σseg 恰恢复为末 cum；
 *     R3 同一 (p,y,c) 叠加了 2~5 张独立来源表（各有独立 cum 序列 / score<=0 汇总行），
 *        跨表排序造成 cum 回退；
 *     R4 同一 score 落入不同来源序列；
 *     R5 seg 列与 cum 差分不符且无法从库内原有行还原（如 2026 增量截断/首行偏移）。
 *
 * 铁律：
 *   - 不填充、不插值、不拟合、不按公式生成任何新数值；
 *   - 所有写入只做「删除多余原有行」或「把不可信 seg 列如实置为 NULL（未发布）」；
 *   - 保留下来的每一行、每一个数值都来自库内原有行，可追溯到 rowid；
 *   - 判定数学完全复用 server/quality-core.mjs 的 auditRankSeries，不放宽任何门禁。
 *
 * 用法：
 *   node tools/fix_rank_series.mjs --db data/gc/rankfix/gaokao.work.db
 *   node tools/fix_rank_series.mjs --db data/gc/rankfix/gaokao.work.db --apply \
 *        --report data/gc/rankfix/fix_report.json
 *
 *   --dry 为默认，只诊断并输出修复清单，不写库；显式 --apply 才在事务中写库。
 *   --apply 若 --db 命中受保护的原始库/交付库，直接拒绝，避免误改基线。
 *   重复 --apply 幂等：坏组为 0 时不产生任何写操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  auditRankSeries, LARGE_GAP_SCORE, RANK_SUM_REL_TOL, RANK_SUM_ABS_TOL,
} from '../高考志愿助手/server/quality-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = 'data/gc/rankfix/gaokao.work.db';
const DEFAULT_REPORT = 'data/gc/rankfix/fix_report.json';

/** 硬约束：这些文件的 size/mtime 不得改变，--apply 一律拒绝写入。 */
const PROTECTED_FILES = [
  '高考志愿助手/data/gaokao.db',
  '高考志愿助手/data/gaokao.db.gz',
  'data/gc/gaokao.final.db',
];
const PROTECTED_PATHS = new Set(PROTECTED_FILES.map((f) => path.resolve(ROOT, f)));

/**
 * 标准省码字典（只读常量）。刻意不 import server/data.mjs：该文件顶层会 mkdirSync，
 * 本工具应保持「除目标库与报告文件外零写入」的隔离性。
 */
const STANDARD_PROVINCES = [
  [11, '北京'], [12, '天津'], [13, '河北'], [14, '山西'], [15, '内蒙古'],
  [21, '辽宁'], [22, '吉林'], [23, '黑龙江'], [31, '上海'], [32, '江苏'],
  [33, '浙江'], [34, '安徽'], [35, '福建'], [36, '江西'], [37, '山东'],
  [41, '河南'], [42, '湖北'], [43, '湖南'], [44, '广东'], [45, '广西'],
  [46, '海南'], [50, '重庆'], [51, '四川'], [52, '贵州'], [53, '云南'],
  [54, '西藏'], [61, '陕西'], [62, '甘肃'], [63, '青海'], [64, '宁夏'], [65, '新疆'],
];
const NAME2STD = new Map(STANDARD_PROVINCES.map(([id, name]) => [name, Number(id)]));
const STD2NAME = new Map(STANDARD_PROVINCES.map(([id, name]) => [Number(id), name]));
const PROVINCE_ALIAS = new Map([['内蒙', '内蒙古']]);

/** @typedef {{rid:number,p:number,y:number,c:number,b:number,ctrl:number|null,
 *   score:number,seg:number|null,cum:number|null}} ScoreRow */
/** @typedef {{p:number,y:number,c:number}} GroupKey */

/**
 * 解析命令行参数。值与 verify_gcdb.mjs 同口径：下一个 token 以 -- 开头时视为布尔开关。
 * @param {string[]} argv
 * @returns {{db:string,report:string,apply:boolean}}
 */
function parseArgs(argv) {
  const argOf = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const apply = argv.includes('--apply') && !argv.includes('--dry');
  return {
    db: String(argOf('db', DEFAULT_DB)),
    report: String(argOf('report', DEFAULT_REPORT)),
    apply,
  };
}

/** @returns {Map<number,string>} 字典 id -> 名称 */
function loadDict(db, type) {
  return new Map(db.prepare("SELECT id, v FROM dict WHERE t=?").all(type).map((r) => [Number(r.id), String(r.v)]));
}

/** 与 auditRankSeries 完全同口径的回退次数（只数 score>0 的有效分段行）。 */
function countBacktracks(rows) {
  const s = rows.filter((r) => Number(r.score) > 0)
    .sort((a, b) => Number(b.score) - Number(a.score) || Number(a.cum ?? 0) - Number(b.cum ?? 0));
  let n = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i - 1].cum != null && s[i].cum != null && Number(s[i].cum) < Number(s[i - 1].cum)) n++;
  }
  return n;
}

/** @param {ScoreRow[]} rows */
function auditOf(rows) {
  return auditRankSeries(rows.map((r) => ({ score: r.score, cum: r.cum, seg: r.seg })));
}

/** 组的形态指标（根因判定的客观证据）。 */
function metricsOf(rows) {
  const pos = rows.filter((r) => Number(r.score) > 0);
  const duplicateCount = (keyFn) => {
    const counts = new Map();
    for (const r of pos) {
      const k = keyFn(r);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.values()].filter((n) => n > 1).reduce((sum, n) => sum + n - 1, 0);
  };
  const rowKey = (r) => [r.p, r.y, r.c, r.b, r.ctrl, r.score, r.seg, r.cum].join('|');
  const v = auditOf(rows);
  // seg 与「按分数降序的 cum 差分」不符的行数：列口径错配的直接证据
  const ordered = pos.slice().sort((a, b) =>
    Number(b.score) - Number(a.score) || Number(a.cum ?? 0) - Number(b.cum ?? 0));
  let prevCum = 0;
  let segMismatch = 0;
  for (const r of ordered) {
    const diff = Number(r.cum ?? 0) - prevCum;
    if (Number(r.seg || 0) !== diff) segMismatch++;
    prevCum = Number(r.cum ?? 0);
  }
  return {
    rows: rows.length,
    posRows: pos.length,
    exactDupRows: duplicateCount(rowKey),
    cumDupRows: duplicateCount((r) => String(r.cum)),
    scoreDupRows: duplicateCount((r) => String(r.score)),
    segMismatchRows: segMismatch,
    segNullRows: pos.filter((r) => r.seg == null).length,
    sumSeg: v.sumSeg,
    endCum: v.endCum,
    ratio: v.endCum ? Math.round((v.sumSeg / v.endCum) * 10000) / 10000 : 0,
    backtracks: countBacktracks(rows),
    mono: v.mono,
  };
}

/**
 * 按 rowid（= CSV 逐文件导入顺序）切分来源链，并记录断点类型。
 *   cum_reset：cum 相对上一行骤降 >50% 且绝对差 >100 —— 另一张表从 0 重新累计（真断点）；
 *   score_jump：score 回升 > LARGE_GAP_SCORE —— 可能是表内跳分展开（伪断点），也可能是新表；
 *   summary：score<=0 汇总行之后 —— 表结束。
 * @returns {{chains: ScoreRow[][], breaks: string[]}}
 */
function splitChains(rows) {
  const ordered = [...rows].sort((a, b) => a.rid - b.rid);
  const chains = [];
  const breaks = [];
  let cur = [];
  let prev = null;
  let afterSummary = false;
  for (const r of ordered) {
    const score = Number(r.score);
    const cum = Number(r.cum ?? 0);
    const summary = !(score > 0);
    let cut = null;
    if (prev) {
      if (prev.cum != null && cum < Number(prev.cum) * 0.5 && Number(prev.cum) - cum > 100) cut = 'cum_reset';
      else if (score > Number(prev.score) + LARGE_GAP_SCORE) cut = 'score_jump';
      if (afterSummary && !summary && !cut) cut = 'summary';
    }
    if (cut && cur.length) {
      chains.push(cur);
      breaks.push(cut);
      cur = [];
    }
    cur.push(r);
    prev = r;
    afterSummary = summary;
  }
  if (cur.length) chains.push(cur);
  return { chains, breaks };
}

/**
 * R3：剔除叠加的多余来源表，只保留「末累计人数最大（覆盖考生最全）」的一条主链。
 * 启用门槛（客观证据，避免把表内跳分展开误判成多表叠加）：
 *   (a) >=2 条链自身 auditRankSeries 通过且长度 >=20；
 *   (b) 存在 cum_reset 真断点且最短链 >=20 行；
 *   (c) 存在一条通过的主链 + 孤立残片链。
 * 长度不足最长链 10% 的链被视为孤立残片，不参与主表候选。
 */
function keepPrimaryChain(rows) {
  const { chains, breaks } = splitChains(rows);
  if (chains.length < 2 || chains.length > 8) return rows;
  const scored = chains.map((ch) => ({ ch, v: auditOf(ch) }));
  const maxLen = Math.max(...scored.map((s) => s.ch.length));
  const minLen = Math.min(...scored.map((s) => s.ch.length));
  const passChains = scored.filter((s) => s.v.pass && s.ch.length >= 20);
  const hasCumReset = breaks.includes('cum_reset');
  const hasTinyOrphan = scored.some((s) => s.ch.length < Math.max(2, maxLen * 0.1));
  const enabled = passChains.length >= 2
    || (hasCumReset && minLen >= 20)
    || (passChains.length >= 1 && hasTinyOrphan && maxLen >= 20);
  if (!enabled) return rows;
  const eligible = scored.filter((s) => s.ch.length >= Math.max(2, maxLen * 0.1));
  if (!eligible.length) return rows;
  const best = eligible.slice().sort((a, b) =>
    b.v.endCum - a.v.endCum
    || Number(b.v.pass) - Number(a.v.pass)
    || b.ch.length - a.ch.length)[0];
  const keep = new Set(best.ch.map((r) => r.rid));
  return rows.filter((r) => keep.has(r.rid));
}

/** R1：删除 8 列完全相同的重复导入行，保留 rowid 最小的一条原有行。 */
function dedupExact(rows) {
  const seen = new Set();
  const out = [];
  for (const r of [...rows].sort((a, b) => a.rid - b.rid)) {
    const k = [r.p, r.y, r.c, r.b, r.ctrl, r.score, r.seg, r.cum].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * 折叠：同一键值只保留一条原有行；汇总行（score<=0）一律保留。
 * @param {(r: ScoreRow)=>string} keyFn
 * @param {(a: ScoreRow,b: ScoreRow)=>number} cmp
 */
function foldBy(rows, keyFn, cmp) {
  const pos = rows.filter((r) => Number(r.score) > 0).sort(cmp);
  const seen = new Set();
  const keep = new Set();
  for (const r of pos) {
    const k = keyFn(r);
    if (seen.has(k)) continue;
    seen.add(k);
    keep.add(r.rid);
  }
  return rows.filter((r) => Number(r.score) <= 0 || keep.has(r.rid));
}

/** R2：同一 cum 只保留一条（score 最高、rowid 最小的原有行）。 */
const foldCum = (rows) => foldBy(rows, (r) => String(r.cum),
  (a, b) => Number(b.score) - Number(a.score) || a.rid - b.rid);

/** R4：同一 score 只保留 cum 最大的一条原有行。 */
const foldScore = (rows) => foldBy(rows, (r) => String(r.score),
  (a, b) => Number(b.score) - Number(a.score)
    || Number(b.cum ?? 0) - Number(a.cum ?? 0) || a.rid - b.rid);

/** R5：把不可信的 seg 列如实置为未发布（NULL）；不改动 cum/score，不生成任何数值。 */
const clearSeg = (rows) => rows.map((r) => (Number(r.score) > 0 ? { ...r, seg: null } : r));

const ACTION_TEXT = {
  dedup_exact: 'R1 重复导入去重：删除 8 列完全相同的重复导入行，保留 rowid 最小的原有行',
  fold_cum: 'R2 累计口径折叠：同一 cum 只保留一条原有行（合并单元格展开 / 同分段重复计数）',
  keep_primary_chain: 'R3 多来源表剔除：保留末累计人数最大的主表，剔除叠加的其它来源表',
  fold_score: 'R4 同分数折叠：同一 score 只保留 cum 最大的原有行',
  clear_seg: 'R5 列口径纠正：seg 与 cum 差分不符且无法从原有行还原，如实置为未发布（NULL）',
};

/** 决策序列：按证据门槛逐步施加原子动作，自洽即停；最多两轮。 */
const OPS = [
  { name: 'dedup_exact', fn: dedupExact, gate: (m) => m.exactDupRows > 0 },
  { name: 'fold_cum', fn: foldCum, gate: (m) => m.cumDupRows > 0 },
  { name: 'keep_primary_chain', fn: keepPrimaryChain, gate: (_m, rows) => {
    const n = splitChains(rows).chains.length;
    return n >= 2 && n <= 8;
  } },
  { name: 'fold_score', fn: foldScore, gate: (m) => m.scoreDupRows > 0 },
  { name: 'clear_seg', fn: clearSeg, gate: (m) => m.segNullRows < m.posRows },
];

/** 判定两次模拟结果是否实质相同（只可能发生删除行或 seg 置空两种变化）。 */
function sameState(a, b) {
  return a.length === b.length && a.every((r, i) => r.rid === b[i].rid && r.seg === b[i].seg);
}

/**
 * 在内存中模拟一个组的修复，返回最终保留的行与动作清单。
 * 数据完整性保护：任何动作都不得把有效分段行删到不足 20 行或原始 10%。
 */
function simulateGroup(original) {
  let rows = original;
  const actions = [];
  const skipped = [];
  const minRows = Math.max(20, original.filter((r) => Number(r.score) > 0).length * 0.1);
  let v = auditOf(rows);
  for (let round = 0; round < 2 && !v.pass; round++) {
    for (const op of OPS) {
      if (v.pass) break;
      const m = metricsOf(rows);
      if (!op.gate(m, rows)) continue;
      const next = op.fn(rows);
      if (sameState(rows, next)) {
        skipped.push({ name: op.name, reason: '动作无实质变化' });
        continue;
      }
      if (next.filter((r) => Number(r.score) > 0).length < minRows) {
        skipped.push({ name: op.name, reason: `保护：剩余有效行将不足 ${Math.round(minRows)} 行` });
        continue;
      }
      const delta = {
        name: op.name,
        text: ACTION_TEXT[op.name],
        deletedRows: rows.length - next.length,
        clearedSegRows: next.filter((r) => Number(r.score) > 0 && r.seg == null).length
          - rows.filter((r) => Number(r.score) > 0 && r.seg == null).length,
      };
      rows = next;
      actions.push(delta);
      v = auditOf(rows);
    }
  }
  return { rows, actions, skipped, audit: v };
}

/** 静态根因标签：只依赖修复前的形态证据，与最终采用哪个动作无关。 */
function rootCausesOf(m, chainInfo) {
  const tags = [];
  if (m.exactDupRows / Math.max(1, m.rows) >= 0.3) tags.push('R1 重复导入（整组两份完全相同的行）');
  if (m.cumDupRows > 0 || m.sumSeg > m.endCum * 1.5) {
    tags.push('R2 累计口径重复（合并单元格展开 / 同分段重复计数）');
  }
  if (chainInfo.chains.length >= 2 && chainInfo.chains.length <= 8) {
    tags.push('R3 多来源表叠加（同组内存在多条独立 cum 序列）');
  }
  if (m.scoreDupRows > 0) tags.push('R4 同分数落入多套序列');
  if (m.segMismatchRows > 0) tags.push('R5 seg 列与 cum 差分不符（列口径错配 / 部分未发布）');
  return tags;
}

/** 生成一组的完整修复计划（纯内存，不写库）。 */
function planGroup(db, g, dict) {
  const original = db.prepare(
    'SELECT rowid AS rid, p, y, c, b, ctrl, score, seg, cum FROM score_range WHERE p=? AND y=? AND c=? ORDER BY rowid',
  ).all(g.p, g.y, g.c);
  const before = auditOf(original);
  if (before.pass) return null;
  const m = metricsOf(original);
  const chainInfo = splitChains(original);
  const sim = simulateGroup(original);
  const after = sim.audit;
  const keep = new Set(sim.rows.map((r) => r.rid));
  const origById = new Map(original.map((r) => [r.rid, r]));
  const clearIds = new Set(sim.rows.filter((r) => Number(r.score) > 0 && r.seg == null
    && origById.get(r.rid)?.seg != null).map((r) => r.rid));
  const deleteIds = original.filter((r) => !keep.has(r.rid)).map((r) => r.rid);

  const dictProv = dict.prov.get(g.p) || String(g.p);
  const stdName = PROVINCE_ALIAS.get(dictProv) || dictProv;
  const province = STD2NAME.get(NAME2STD.get(stdName)) || stdName;
  return {
    province,
    dictProvince: dictProv,
    provinceId: NAME2STD.get(stdName) ?? null,
    dictProvinceId: g.p,
    year: g.y,
    category: dict.cat.get(g.c) || String(g.c),
    categoryId: g.c,
    rowKey: `${g.p}|${g.y}|${g.c}`,
    rootCauses: rootCausesOf(m, chainInfo),
    evidence: {
      rows: m.rows,
      exactDuplicateRows: m.exactDupRows,
      duplicateCumRows: m.cumDupRows,
      duplicateScoreRows: m.scoreDupRows,
      segMismatchRows: m.segMismatchRows,
      sourceChains: chainInfo.chains.length,
      chainBreaks: chainInfo.breaks,
      sumSegOverEndCum: m.ratio,
    },
    actions: sim.actions,
    skippedActions: sim.skipped,
    before: {
      rows: original.length, sumSeg: before.sumSeg, endCum: before.endCum,
      backtracks: m.backtracks, mono: m.mono, errors: before.errors,
    },
    after: {
      rows: sim.rows.length, sumSeg: after.sumSeg, endCum: after.endCum,
      backtracks: countBacktracks(sim.rows), mono: after.mono, errors: after.errors,
    },
    impact: {
      rowsDeleted: deleteIds.length,
      segClearedRows: clearIds.size,
      rowsAfter: sim.rows.length,
    },
    fixed: after.pass,
    note: after.pass
      ? '修复后复用 auditRankSeries 判定为自洽；保留行与数值全部来自原有行。'
      : '在不填充/不伪造前提下无法自洽，如实保留并在报告中披露。',
    /** 以下两个字段只供 --apply 使用，不写入 JSON 报告 */
    _deleteIds: deleteIds,
    _clearIds: [...clearIds],
  };
}

/** 扫描全库，返回仍不自洽的组键集合。 */
function scanBadKeys(db) {
  const groups = db.prepare('SELECT DISTINCT p, y, c FROM score_range').all();
  const bad = new Set();
  for (const g of groups) {
    const rows = db.prepare('SELECT score, cum, seg FROM score_range WHERE p=? AND y=? AND c=?')
      .all(g.p, g.y, g.c);
    if (!auditRankSeries(rows).pass) bad.add(`${g.p}|${g.y}|${g.c}`);
  }
  return { groups, bad };
}

/** 事务化写入 + 写后复验；任何「计划修复却仍不自洽」都回滚。 */
function applyPlans(db, plans, reportPath) {
  const delStmt = db.prepare('DELETE FROM score_range WHERE rowid=?');
  const nullStmt = db.prepare('UPDATE score_range SET seg=NULL WHERE rowid=?');
  const expectedBad = new Set(plans.filter((p) => !p.fixed).map((p) => p.rowKey));
  db.exec('BEGIN');
  try {
    for (const p of plans) {
      for (const rid of p._deleteIds) delStmt.run(rid);
      for (const rid of p._clearIds) nullStmt.run(rid);
    }
    const { bad } = scanBadKeys(db);
    const unexpected = [...bad].filter((k) => !expectedBad.has(k));
    if (unexpected.length) {
      throw new Error(`写后复验失败：${unexpected.length} 组仍未自洽，示例 ${unexpected.slice(0, 5).join(', ')}`);
    }
    db.exec('COMMIT');
    return { committed: true, remainingBad: bad.size, expectedUnfixable: expectedBad.size };
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`\n事务已回滚：${e.message}`);
    console.error(`  修复清单仍写入 ${reportPath}（记录诊断与计划，未落库）`);
    return { committed: false, remainingBad: null, error: String(e.message) };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(ROOT, args.db);
  const reportPath = path.resolve(ROOT, args.report);
  if (!fs.existsSync(dbPath)) {
    console.error(`找不到目标数据库：${dbPath}`);
    console.error('请先把开发库复制成工作副本，例如 data/gc/rankfix/gaokao.work.db');
    process.exit(1);
  }
  if (args.apply && PROTECTED_PATHS.has(dbPath)) {
    console.error(`拒绝写入受保护的原始库/交付库：${dbPath}`);
    console.error('本工具只允许在副本上 --apply；原库 size/mtime 必须保持不变。');
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath, args.apply ? {} : { readOnly: true });
  let result;
  try {
    const dict = { prov: loadDict(db, 'province'), cat: loadDict(db, 'category') };
    const scan = scanBadKeys(db);
    const groups = scan.groups;
    const plans = [];
    for (const g of groups) {
      const p = planGroup(db, g, dict);
      if (p) plans.push(p);
    }
    const fixed = plans.filter((p) => p.fixed).length;
    const unfixable = plans.filter((p) => !p.fixed).map((p) => p.rowKey);
    const rowsDeleted = plans.reduce((s, p) => s + p.impact.rowsDeleted, 0);
    const segCleared = plans.reduce((s, p) => s + p.impact.segClearedRows, 0);

    result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      db: dbPath,
      mode: args.apply ? 'apply' : 'dry',
      policy: {
        defaultMode: 'dry',
        writeActions: ['删除多余原有行', '把不可信 seg 列置 NULL（未发布）'],
        forbidden: ['插值', '拟合', '按公式生成新数值', '引入外部数据源', '改判定数学或门禁'],
        judge: 'server/quality-core.mjs :: auditRankSeries（未改动）',
        tolerances: { RANK_SUM_REL_TOL, RANK_SUM_ABS_TOL, LARGE_GAP_SCORE },
        protectedPaths: [...PROTECTED_PATHS],
        idempotent: true,
      },
      summary: {
        groupsTotal: scan.groups.length,
        badBefore: scan.bad.size,
        plannedGroups: plans.length,
        fixedGroups: fixed,
        unfixableGroups: unfixable.length,
        rowsDeleted,
        segClearedRows: segCleared,
        skippedActions: plans.reduce((s, p) => s + p.skippedActions.length, 0),
      },
      groups: plans.map(({ _deleteIds, _clearIds, ...publicPlan }) => publicPlan),
      unfixable,
      verification: null,
    };

    if (args.apply) {
      const applied = applyPlans(db, plans, reportPath);
      result.verification = {
        ...applied,
        rankSeriesTrueFailAfter: applied.committed ? applied.remainingBad : null,
      };
      if (!applied.committed) result.summary.applied = false;
      else result.summary.applied = true;
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 1) + '\n');

    // ---- 控制台摘要（简体中文）----
    console.log(`\n== 一分一段存量修复（${result.mode}）==`);
    console.log(`  数据库 ${dbPath}`);
    console.log(`  分组 ${result.summary.groupsTotal} 组，修复前真不自洽 ${result.summary.badBefore} 组`);
    console.log(`  计划修复 ${fixed} 组 · 无法自洽如实保留 ${unfixable.length} 组`);
    console.log(`  计划删除重复/叠加行 ${rowsDeleted} 条 · seg 列置未发布 ${segCleared} 条`);
    const byAction = {};
    for (const p of plans) for (const a of p.actions) byAction[a.name] = (byAction[a.name] || 0) + 1;
    console.log(`  动作分布 ${JSON.stringify(byAction)}`);
    if (unfixable.length) console.log(`  无法修复组：${unfixable.join(', ')}`);
    if (args.apply) {
      console.log(`  事务 ${result.verification.committed ? '✅ 已提交' : '❌ 已回滚'}`);
      if (result.verification.committed) {
        console.log(`  写后复验 rank_series_true_fail = ${result.verification.rankSeriesTrueFailAfter}`);
      }
    } else {
      console.log('  当前为 --dry（默认）：未写任何库；显式 --apply 才在事务中落库。');
    }
    console.log(`  修复清单 ${reportPath}`);
    if (args.apply && !result.verification.committed) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();

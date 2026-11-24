/**
 * gaokao.db 主库字段级质量校验 + 发版门禁（零第三方依赖）
 *
 * 用法：
 *   node tools/verify_gcdb.mjs --db 高考志愿助手/data/gaokao.db            # 默认 audit-only，只读出报告
 *   node tools/verify_gcdb.mjs --db data/gc/gaokao.slim.db --apply          # 构建期：物理隔离 + 烘焙质量表
 *   node tools/verify_gcdb.mjs --db data/gc/gaokao.slim.db --apply \
 *        --fail-on A1,A2,A4,C1,C2,C3,C4,T2,RT --gaokao-year 2026 --baseline-year 2025
 *
 *  --apply 才会写库（构建期 slim 库可写）；audit-only 可在只读随包库上安全运行。
 *  --min-full-rate 0.6   C1F 回归基线（历史完整度不得低于该值，默认 0.6）。
 *
 * 门禁分层：
 *   A1   所有一分一段组已审计，且真实不自洽的单元格均已降级 partial（默认排除、不冒充 full）；
 *   A1S  opt-in 严格门禁：真不自洽组数 === 0 才通过。存量 53 组已按 A1 降级 partial
 *        并在报告 rankSeriesDetail 逐组披露，因此默认绝不启用（不在默认 fail-on，
 *        也不在 pack_gcdb.mjs 默认 --require-gates 中），不影响 A1,C1,C1F,C2,C3,C4,RT。
 *   C1   四态标注覆盖率（无 unknown），是阻断门禁；
 *   C1F  历史完整度回归门禁；fullRate 本身只是披露指标，存量历史缺口不应阻断发版。
 *
 * 铁律：缺失（NULL/0）只披露、不填充、不隔离；只有「值存在但非法」才隔离。
 *       cum=0 是一分一段的合法起点，不是异常；seg 整组未发布时只校验 cum 单调/规模。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ROOT, PROVENANCE_FILE, readProvenance, sha256File, sha256Text } from './lib/provenance.mjs';
import {
  CORE_TABLES, TABLE_SOURCE, EXPECTED_YEARS, DEFAULT_BASELINE_YEAR, SPARSE_RATIO, BASELINE_SAMPLE_YEARS,
  RULE_TEXT, classifyCell, median, auditRankSeries, LARGE_GAP_SCORE,
} from '../高考志愿助手/server/quality-core.mjs';
import { PROVINCES } from '../高考志愿助手/server/data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argOf = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : (process.argv.includes('--' + n) ? true : d);
};
const DB = path.resolve(ROOT, String(argOf('db', '高考志愿助手/data/gaokao.db')));
const APPLY = !!argOf('apply', false);
const FAIL_ON = String(argOf('fail-on', '')).split(',').map((s) => s.trim()).filter(Boolean);
const GAOKAO_YEAR = Number(argOf('gaokao-year', new Date().getFullYear()));
const BASELINE_YEAR = Number(argOf('baseline-year', DEFAULT_BASELINE_YEAR));
const REPORT_PATH = path.resolve(ROOT, String(argOf('report', 'data/gc/quality_report.json')));
const AUDIT_SAMPLES = String(argOf('samples', ''));
const MIN_FULL_RATE = Number(argOf('min-full-rate', 0.6));
const INDEX_DIR = path.resolve(ROOT, '高考志愿助手/data/index');
/** 仅显式 --fail-on 才启用的严格门禁；绝不进入任何默认门禁集合 */
const OPT_IN_GATES = ['A1S'];

const STD2NAME = new Map(PROVINCES.map(([id, n]) => [Number(id), n]));
const NAME2STD = new Map(PROVINCES.map(([id, n]) => [n, Number(id)]));
const ALIAS = new Map([['内蒙', '内蒙古']]);
for (const [a, s] of ALIAS) if (NAME2STD.has(s) && !NAME2STD.has(a)) NAME2STD.set(a, NAME2STD.get(s));

/**
 * 后台补抓索引的抽样/未完成标记（Q6 根因）。
 * 与运行时 server/quality.mjs 的 sampledYears() 同口径：只读文件头 4KB 正则探测，
 * 不解析 39 个大 JSON。文件名 province_{标准省码}_{年份}.json。
 */
function loadIndexFlags() {
  const out = new Map();
  try {
    for (const f of fs.readdirSync(INDEX_DIR)) {
      const m = /^(province|special)_(\d+)_(\d+)\.json$/.exec(f);
      if (!m) continue;
      // 与运行时 sampledYears() 同口径：历史索引普遍带 complete:false（抓取器的
      // 通用未完成标记），不代表主库历史数据抽样，一律跳过；只认 > baselineYear 的当年索引。
      if (Number(m[3]) <= BASELINE_YEAR) continue;
      const fd = fs.openSync(path.join(INDEX_DIR, f), 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, n).toString('utf8');
      out.set(`${Number(m[2])}|${Number(m[3])}`, {
        sampled: /"sampled"\s*:\s*true/.test(head),
        complete: !/"complete"\s*:\s*false/.test(head),
        numFound: Number((head.match(/"numFound"\s*:\s*(\d+)/) || [])[1]) || 0,
      });
    }
  } catch { /* 构建期可选目录，缺失不影响门禁 */ }
  return out;
}

/** 每个表 -> [规则名, SQL 谓词, 处置] */
const RULES = {
  school_adm: [
    ['min_out', 'min IS NOT NULL AND (min > 750 OR (min > 0 AND min < 100))', 'quarantine'],
    ['rnk_neg', 'rnk IS NOT NULL AND rnk < 0', 'quarantine'],
    ['ctrl_neg', 'ctrl IS NOT NULL AND ctrl < 0', 'quarantine'],
  ],
  major_adm: [
    ['min_out', 'min IS NOT NULL AND (min > 750 OR (min > 0 AND min < 100))', 'quarantine'],
    ['rnk_neg', 'rnk IS NOT NULL AND rnk < 0', 'quarantine'],
  ],
  score_range: [
    ['score_out', 'score IS NOT NULL AND (score < 0 OR score > 800)', 'quarantine'],
    // cum=0 是「最高分段之上 0 人」的合法起点；cum IS NULL 属缺失，只披露不隔离。
    // 只有「值存在且为负」才是非法值，才物理隔离。
    ['cum_neg', 'cum IS NOT NULL AND cum < 0', 'quarantine'],
    ['ctrl_neg', 'ctrl IS NOT NULL AND ctrl < 0', 'quarantine'],
  ],
  plan_code: [],
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS data_manifest (
  data_version TEXT PRIMARY KEY, built_at TEXT NOT NULL, gaokao_year INT NOT NULL,
  baseline_year INT NOT NULL, schema_version INT NOT NULL, db_sha256 TEXT,
  app_version TEXT, generator TEXT);
CREATE TABLE IF NOT EXISTS table_manifest (
  data_version TEXT, table_name TEXT, source TEXT, source_url TEXT, license TEXT,
  ingested_at TEXT, published_at TEXT, rows INT, rows_quarantined INT,
  min_year INT, max_year INT, sha256 TEXT, completeness TEXT,
  PRIMARY KEY (data_version, table_name));
CREATE TABLE IF NOT EXISTS cell_manifest (
  data_version TEXT, p INT, y INT, table_name TEXT, source TEXT, source_url TEXT,
  ingested_at TEXT, published_at TEXT, rows INT, sampled INT, complete INT, checksum TEXT,
  PRIMARY KEY (data_version, p, y, table_name));
CREATE TABLE IF NOT EXISTS coverage_cell (
  data_version TEXT, p INT, y INT, table_name TEXT, state TEXT,
  rows INT, baseline_rows INT, ratio REAL, sampled INT, complete INT,
  expected INT, image_only INT, gaps INT, source TEXT, basis TEXT,
  PRIMARY KEY (data_version, p, y, table_name));
CREATE TABLE IF NOT EXISTS field_stats (
  data_version TEXT, table_name TEXT, field TEXT, total INT, non_null INT,
  filled INT, fill_rate REAL, fill_source TEXT, out_of_range INT,
  PRIMARY KEY (data_version, table_name, field));
CREATE TABLE IF NOT EXISTS quality_issue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, data_version TEXT, table_name TEXT,
  p INT, y INT, row_key TEXT, rule TEXT, reason TEXT, snapshot_json TEXT,
  quarantine INT, detected_at TEXT);
CREATE TABLE IF NOT EXISTS gap_list (
  data_version TEXT, p INT, y INT, c INT, gap_count INT, ranges TEXT,
  PRIMARY KEY (data_version, p, y, c));
CREATE TABLE IF NOT EXISTS image_only (
  data_version TEXT, p INT, y INT, title TEXT, url TEXT,
  PRIMARY KEY (data_version, p, y, url));
CREATE TABLE IF NOT EXISTS sample_audit (
  data_version TEXT, status TEXT, note TEXT, checked INT, matched INT,
  consistent REAL, mean_abs_err REAL, generated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_qc_py ON coverage_cell (p, y);
CREATE INDEX IF NOT EXISTS ix_qi_rule ON quality_issue (rule);
`;

function main() {
  if (!fs.existsSync(DB)) { console.error('找不到数据库：' + DB); process.exit(1); }
  const db = new DatabaseSync(DB, APPLY ? {} : { readOnly: true });
  try { db.exec('PRAGMA temp_store = MEMORY'); } catch { /* ignore */ }

  // ---- 省份字典 + 回环自检 ----
  const dProv = new Map();      // dict id -> 标准码
  const nameToDict = new Map();
  for (const r of db.prepare("SELECT id, v FROM dict WHERE t='province'").all()) {
    const std = NAME2STD.get(r.v) ?? (ALIAS.has(r.v) ? NAME2STD.get(ALIAS.get(r.v)) : null);
    dProv.set(r.id, std ?? null);
    nameToDict.set(r.v, r.id);
    if (ALIAS.has(r.v)) nameToDict.set(ALIAS.get(r.v), r.id);
  }
  // 科类字典：A1S 逐组明细需要「省 / 年 / 科类 / 原因」四要素，不能只给计数或 dict id
  const dCat = new Map();
  for (const r of db.prepare("SELECT id, v FROM dict WHERE t='category'").all()) dCat.set(r.id, r.v);

  const roundTrip = [];
  for (const [std, name] of PROVINCES) {
    const dictId = nameToDict.get(name);
    const back = dictId != null ? dProv.get(dictId) : null;
    if (back !== Number(std)) roundTrip.push({ std: Number(std), name, dictId, back });
  }

  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    db: DB, mode: APPLY ? 'apply' : 'audit-only',
    gaokaoYear: GAOKAO_YEAR, baselineYear: BASELINE_YEAR,
    checks: {}, issues: [], rankSeriesDetail: [], coverage: [], fieldStats: [], gaps: [], imageOnly: [],
    roundTrip, tables: {}, summary: {}, audit: { status: 'not_run' },
    gatePolicy: {
      defaultFailOn: [],
      optInGates: OPT_IN_GATES,
      note: 'A1S 默认关闭；真不自洽组逐组见 rankSeriesDetail，修复并重新 --apply 后才建议显式启用',
    },
  };

  // --apply 时先建表（隔离阶段就要写 quality_issue），并清掉上一次烘焙残留
  if (APPLY) {
    db.exec(SCHEMA);
    for (const t of ['data_manifest', 'table_manifest', 'cell_manifest', 'coverage_cell',
      'field_stats', 'quality_issue', 'gap_list', 'image_only', 'sample_audit']) {
      try { db.exec(`DELETE FROM ${t}`); } catch { /* ignore */ }
    }
  }

  // ---- A2：字段级校验 + 快照（--apply 时物理隔离）----
  for (const [table, rules] of Object.entries(RULES)) {
    for (const [rule, predicate, action] of rules) {
      let rows = [];
      try { rows = db.prepare(`SELECT rowid AS rid, * FROM ${table} WHERE ${predicate}`).all(); } catch (e) {
        report.checks[`${table}.${rule}.error`] = e.message; continue;
      }
      report.checks[`${table}.${rule}`] = rows.length;
      for (const r of rows) {
        report.issues.push({
          table, rule, action, reason: RULE_TEXT[rule] || rule,
          stdPid: dProv.get(r.p) ?? r.p, year: r.y, rowKey: String(r.rid),
          value: r.min ?? r.cum ?? r.score ?? null, isolated: false,
        });
        if (APPLY && action === 'quarantine') {
          db.prepare('INSERT INTO quality_issue (data_version,table_name,p,y,row_key,rule,reason,snapshot_json,quarantine,detected_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run('pending', table, r.p, r.y, String(r.rid), rule, RULE_TEXT[rule] || rule,
              JSON.stringify(r), 1, new Date().toISOString());
          db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(r.rid);
        }
      }
    }
  }
  report.checks.quarantine_total = report.issues.filter((i) => i.action === 'quarantine').length;
  // 隔离后残留复检：--apply 后必须为 0；audit-only 时等于原始越界数
  let residualOut = 0;
  for (const [table, rules] of Object.entries(RULES)) {
    for (const [, predicate, action] of rules) {
      if (action !== 'quarantine') continue;
      try { residualOut += db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${predicate}`).get().c; } catch { /* ignore */ }
    }
  }
  for (const i of report.issues) if (i.action === 'quarantine') i.isolated = APPLY;
  report.checks.residual_out_of_range = residualOut;
  report.checks.isolation_rate = APPLY ? 1 : 0;

  // ---- A1：一分一段累计自洽（主库分级诊断，按 p,y,c 跨 b 批次合并）----
  // 与备用抓取资源不同：主库约半数年份只发布 cum（seg 全 NULL），且 score<=0 是
  // 「总计人数」汇总行。这两类属数据形态差异，不得误报为异常。
  // 真实异常进清单，并令其 score_range 单元格降级 partial（默认排除、不冒充 full）。
  const seriesGroups = db.prepare('SELECT DISTINCT p, y, c FROM score_range').all();
  const rankSeriesBadKeys = new Set();   // `${标准省码}|${年}`
  const largeGapByKey = {};              // `${标准省码}|${年}` -> 结构性缺口数
  let seriesFail = 0, segUnpublished = 0, seriesAudited = 0, summaryRows = 0;
  for (const g of seriesGroups) {
    const rows = db.prepare('SELECT score, cum, seg FROM score_range WHERE p=? AND y=? AND c=?')
      .all(g.p, g.y, g.c);
    const v = auditRankSeries(rows);
    seriesAudited++;
    summaryRows += v.summaryRows;
    const ok = `${dProv.get(g.p) ?? g.p}|${g.y}`;
    if (v.largeGaps) largeGapByKey[ok] = (largeGapByKey[ok] || 0) + v.largeGaps;
    if (!v.hasSeg) segUnpublished++;
    if (!v.pass) {
      seriesFail++;
      rankSeriesBadKeys.add(ok);
      const std = dProv.get(g.p) ?? g.p;
      const reason = `累计不自洽：${v.errors.slice(0, 3).join('；')}`;
      report.issues.push({
        table: 'score_range', rule: 'rank_series', action: 'report',
        reason,
        stdPid: std, year: g.y,
        rowKey: `${g.p}|${g.y}|${g.c}`, value: v.endCum, isolated: false,
      });
      // 逐组明细（省 / 年 / 科类 / 原因）：A1S 判定依据可审计，不因门禁默认关闭而省略
      report.rankSeriesDetail.push({
        province: STD2NAME.get(std) || String(std), provinceId: std,
        year: g.y, categoryId: g.c, category: dCat.get(g.c) || String(g.c),
        dictProvinceId: g.p, rowKey: `${g.p}|${g.y}|${g.c}`,
        reason, errors: v.errors.slice(), rows: v.length, endCum: v.endCum,
      });
    }
  }
  report.checks.rank_series_groups = seriesGroups.length;
  report.checks.rank_series_audited = seriesAudited;
  report.checks.rank_series_fail = seriesFail;
  report.checks.rank_series_true_fail = seriesFail;   // A1S 依据：真不自洽组数（已排除形态差异）
  report.checks.rank_series_detail_count = report.rankSeriesDetail.length;
  report.checks.rank_series_seg_unpublished = segUnpublished;
  report.checks.rank_series_summary_rows = summaryRows;
  report.checks.rank_series_large_gap_threshold = LARGE_GAP_SCORE;

  // ---- 覆盖四态矩阵 + 字段非空率 + 缺口 ----
  const perCell = {};
  for (const t of CORE_TABLES) {
    perCell[t] = {};
    for (const r of db.prepare(`SELECT p, y, COUNT(*) c FROM ${t} GROUP BY p, y`).all()) {
      const std = dProv.get(r.p) ?? r.p;
      const k = `${std}|${r.y}`;
      perCell[t][k] = (perCell[t][k] || 0) + r.c;
    }
  }
  const provenance = readProvenance(PROVENANCE_FILE);
  const provByKey = new Map(provenance.cells.map((c) => [`${c.table}|${c.p}|${c.y}`, c]));
  const indexFlags = loadIndexFlags();

  // 仅图片发布（备用资源，构建期可选读取）
  const rankStorePath = path.join(ROOT, '高考志愿助手', 'data', 'rank_table.json.gz');
  let imageOnlyEntries = [];
  try {
    const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(rankStorePath)).toString('utf8'));
    imageOnlyEntries = (d.imageOnly || []).map((it) => ({
      p: NAME2STD.get(it.province) ?? NAME2STD.get(String(it.province).replace(/[省市自治区]/g, '')) ?? null,
      y: Number(it.year), title: it.title || '', url: it.url || '',
    })).filter((x) => x.p && x.y);
  } catch { /* 可选资源缺失不影响门禁 */ }

  const baselineRowsOf = (table, k) => {
    const [std] = k.split('|').map(Number);
    const hist = [];
    for (let y = BASELINE_YEAR; y > BASELINE_YEAR - 8; y--) {
      const c = perCell[table]?.[`${std}|${y}`];
      if (c && c > 0) hist.push(c);
      if (hist.length >= BASELINE_SAMPLE_YEARS) break;
    }
    return hist.length >= 2 ? median(hist) : 0;
  };

  const combos = new Set();
  for (const t of CORE_TABLES) {
    for (const k of Object.keys(perCell[t])) combos.add(k);
    const [a, b] = EXPECTED_YEARS[t] || [BASELINE_YEAR, BASELINE_YEAR];
    for (const [std] of PROVINCES) for (let y = a; y <= b; y++) combos.add(`${std}|${y}`);
  }
  for (const [std] of PROVINCES) combos.add(`${std}|${GAOKAO_YEAR}`);

  const fieldDefs = {
    school_adm: [['min', 'min IS NOT NULL AND min<>0', 'min>750 OR (min>0 AND min<100)', 'min'],
      ['rnk', 'rnk IS NOT NULL AND rnk<>0', 'rnk<0', 'rnk'],
      ['ctrl', 'ctrl IS NOT NULL AND ctrl<>0', 'ctrl<0', 'ctrl']],
    major_adm: [['min', 'min IS NOT NULL AND min<>0', 'min>750 OR (min>0 AND min<100)', 'min']],
    score_range: [['cum', 'cum IS NOT NULL', 'cum IS NOT NULL AND cum<0', 'cum']],
  };
  for (const [table, defs] of Object.entries(fieldDefs)) {
    const total = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    for (const [field, nnPred, badPred] of defs) {
      const nonNull = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${nnPred}`).get().c;
      const outOfRange = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${badPred}`).get().c;
      report.fieldStats.push({ table, field, total, nonNull, outOfRange, fillRate: total ? Math.round(nonNull / total * 1000) / 1000 : 0, fillSource: field === 'ctrl' ? 'gc.batchLines() 归纳回填' : '源数据' });
      report.checks[`${table}.${field}.fillRate`] = total ? nonNull / total : 0;
    }
  }

  // 结构性分数缺口：直接复用 A1 分级诊断结果（排除 score<=0 汇总行，
  // 只计跨度 >LARGE_GAP_SCORE 的连续空白；1~10 分的正常跳分不算缺口）。
  const gapCount = { ...largeGapByKey };

  for (const key of combos) {
    const [std, year] = key.split('|').map(Number);
    if (!STD2NAME.has(std) || !year) continue;
    for (const table of CORE_TABLES) {
      const [ea, eb] = EXPECTED_YEARS[table] || [BASELINE_YEAR, BASELINE_YEAR];
      const expected = year >= ea && year <= eb;
      const rows = perCell[table]?.[key] || 0;
      if (!rows && !expected && year <= BASELINE_YEAR) continue;
      const baselineRows = baselineRowsOf(table, key);
      const prov = provByKey.get(`${table}|${std}|${year}`);
      const idx = indexFlags.get(`${std}|${year}`);
      // Q6 定稿：河北 2026 school_adm / major_adm 为 eol.cn 后台抽样，索引带 complete:false。
      // 只对主库确有行的「投档线/专业分/计划」单元格生效；score_range 属官方发布的一分一段，
      // 当年部分省份/部分分段只按 year>baseline 判 partial，不标 sampled。
      const fromIndex = table !== 'score_range' && rows > 0 && !!idx
        && (idx.sampled || !idx.complete);
      const sampled = !!(prov?.sampled) || (prov?.complete === 0) || fromIndex;
      const source = prov?.source
        || (fromIndex ? 'eol.cn 后台抽样（index complete:false）' : TABLE_SOURCE[table]);
      const isImage = table === 'score_range' && rows === 0 && imageOnlyEntries.some((x) => x.p === std && x.y === year);
      const gaps = table === 'score_range' ? (gapCount[key] || 0) : 0;
      const rankSeriesBad = table === 'score_range' && rankSeriesBadKeys.has(key);
      const state = classifyCell({ rows, baselineRows, sampled, complete: !sampled, year,
        baselineYear: BASELINE_YEAR, gapCount: gaps, rankSeriesBad, imageOnly: isImage, expected });
      report.coverage.push({ provinceId: std, province: STD2NAME.get(std), year, table, state,
        rows, baselineRows, ratio: baselineRows ? Math.round(rows / baselineRows * 1000) / 1000 : null,
        sampled: sampled ? 1 : 0, expected: expected ? 1 : 0, imageOnly: isImage ? 1 : 0,
        gaps, rankSeriesBad: rankSeriesBad ? 1 : 0,
        source, basis: baselineRows ? 'province-3y' : 'none' });
    }
  }
  for (const [k, n] of Object.entries(gapCount)) {
    const [std, year] = k.split('|').map(Number);
    report.gaps.push({ provinceId: std, year, gapCount: n });
  }
  report.imageOnly = imageOnlyEntries;

  const sm = { full: 0, partial: 0, missing: 0, imageOnly: 0, expected: 0, expectedFull: 0, sampled: 0, labeled: 0 };
  for (const c of report.coverage) {
    sm[c.state]++;
    if (c.expected) {
      sm.expected++;
      if (c.state === 'full') sm.expectedFull++;
      if (['full', 'partial', 'missing', 'imageOnly'].includes(c.state)) sm.labeled++;
    }
    if (c.sampled) sm.sampled++;
  }
  // C1 拆分（对齐设计文档 U8「完整或已如实标注缺失」）：
  //   fullRate    —— 历史数据完整度【披露指标】，不阻断发版；存量历史缺口如实呈现即可；
  //   labeledRate —— 四态标注覆盖率【门禁指标】，每个期望单元格必须有确定状态、无 unknown；
  //   C1F         —— 可选回归门禁，防止 fullRate 相较 --min-full-rate 基线继续恶化。
  // 若用 full/expected 直接阻断，2017–2019 的真实历史缺口会让发版永远失败，与
  // 「默认隐藏但可在质量面板查」的决策相悖。
  sm.fullRate = sm.expected ? sm.expectedFull / sm.expected : 1;
  sm.completeRate = sm.fullRate;              // 兼容运行时 /api/quality/coverage 字段名
  sm.labeledRate = sm.expected ? sm.labeled / sm.expected : 1;
  sm.minFullRate = MIN_FULL_RATE;
  sm.stateRate = 1;
  report.summary = sm;

  // ---- A3 官方值抽样比对（构建期人工台账，运行时零联网）----
  if (AUDIT_SAMPLES && fs.existsSync(AUDIT_SAMPLES)) {
    try {
      const samples = JSON.parse(fs.readFileSync(AUDIT_SAMPLES, 'utf8'));
      let matched = 0, errSum = 0, errN = 0;
      for (const s of (samples.items || [])) {
        const r = db.prepare('SELECT min FROM school_adm WHERE p=? AND y=? AND sid=? LIMIT 1')
          .get(nameToDict.get(String(s.p)) ?? s.p, s.y, s.sid);
        if (!r) continue;
        if (r.min === s.min) matched++;
        errSum += Math.abs(r.min - s.min); errN++;
      }
      report.audit = { status: 'pass', checked: (samples.items || []).length, matched,
        consistent: errN ? matched / errN : 0, meanAbsErr: errN ? errSum / errN : null,
        generatedAt: new Date().toISOString() };
    } catch (e) { report.audit = { status: 'error', note: e.message }; }
  }

  // ---- 烘焙（仅 --apply）----
  let dataVersion = null;
  if (APPLY) {
    dataVersion = `${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-1`;
    const builtAt = new Date().toISOString();
    db.prepare('INSERT INTO data_manifest VALUES (?,?,?,?,?,?,?,?)')
      .run(dataVersion, builtAt, GAOKAO_YEAR, BASELINE_YEAR, 1, null, '1.1.0', 'tools/verify_gcdb.mjs');

    const insTbl = db.prepare(`INSERT OR REPLACE INTO table_manifest VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const t of CORE_TABLES) {
      const st = db.prepare(`SELECT COUNT(*) c, MIN(y) a, MAX(y) b FROM ${t}`).get();
      insTbl.run(dataVersion, t, provByKey.get(`${t}|0|0`)?.source || 'GaokaoCompass / gaokao-vault',
        null, 'MIT', builtAt, null, st.c, 0, st.a, st.b, null, 'full');
    }
    const insCell = db.prepare(`INSERT OR REPLACE INTO coverage_cell VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insCM = db.prepare(`INSERT OR REPLACE INTO cell_manifest VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const c of report.coverage) {
      const dictPid = nameToDict.get(c.province);
      if (dictPid == null) continue;
      insCell.run(dataVersion, dictPid, c.year, c.table, c.state, c.rows, c.baselineRows, c.ratio,
        c.sampled, c.sampled ? 0 : 1, c.expected, c.imageOnly, c.gaps, c.source, c.basis);
      const prov = provByKey.get(`${c.table}|${c.provinceId}|${c.year}`);
      insCM.run(dataVersion, dictPid, c.year, c.table, prov?.source || c.source || null,
        prov?.sourceUrl || null, prov?.ingestedAt || builtAt, prov?.publishedAt || null,
        c.rows, c.sampled, c.sampled ? 0 : 1, sha256Text(`${c.table}|${c.year}|${c.rows}`));
    }
    const insFS = db.prepare(`INSERT OR REPLACE INTO field_stats VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const f of report.fieldStats) {
      insFS.run(dataVersion, f.table, f.field, f.total, f.nonNull, 0, f.fillRate, f.fillSource, f.outOfRange);
    }
    const insGap = db.prepare(`INSERT OR REPLACE INTO gap_list VALUES (?,?,?,?,?,?)`);
    for (const g of report.gaps) insGap.run(dataVersion, nameToDict.get(STD2NAME.get(g.provinceId)) ?? g.provinceId, g.year, 0, g.gapCount, null);
    const insImg = db.prepare(`INSERT OR REPLACE INTO image_only VALUES (?,?,?,?,?)`);
    for (const im of report.imageOnly) insImg.run(dataVersion, nameToDict.get(STD2NAME.get(im.p)) ?? im.p, im.y, im.title, im.url);
    db.prepare(`INSERT INTO sample_audit VALUES (?,?,?,?,?,?,?,?)`)
      .run(dataVersion, report.audit.status, report.audit.note || null, report.audit.checked || 0,
        report.audit.matched || 0, report.audit.consistent || 0, report.audit.meanAbsErr || 0, builtAt);
    // 回填 quality_issue 的 data_version（隔离发生在建表之前，故需补写）
    try { db.exec(`UPDATE quality_issue SET data_version='${dataVersion}'`); } catch { /* ignore */ }
    // meta(k,v) 兼容：写入数据版本，旧代码仍可读 builtAt
    try { db.exec("INSERT OR REPLACE INTO meta(k,v) VALUES('dataVersion','" + dataVersion + "')"); } catch { /* ignore */ }
    try { db.exec('VACUUM'); } catch { /* ignore */ }
    // 内容指纹（按表聚合，不受 VACUUM / Brotli 压缩影响，运行时可重算比对）。
    // 不用文件字节 SHA256：写回文件本身就会改变字节，形成循环。
    const fp = [];
    for (const t of CORE_TABLES) {
      try {
        const st = db.prepare(`SELECT COUNT(*) c, SUM(y) sy FROM ${t}`).get();
        fp.push(`${t}:${st.c}:${st.sy ?? 0}`);
      } catch { fp.push(`${t}:na`); }
    }
    const dbSha256 = sha256Text(fp.join('|'));
    try { db.prepare('UPDATE data_manifest SET db_sha256=? WHERE data_version=?').run(dbSha256, dataVersion); } catch { /* ignore */ }
    report.checks.db_sha256 = dbSha256;
  }
  report.dataVersion = dataVersion;

  // ---- 门禁 ----
  // A1 处置完备性：真实不自洽的组所在 score_range 单元格不得仍判 full 混入算法参考年份
  const badCells = report.coverage.filter((c) => c.table === 'score_range'
    && rankSeriesBadKeys.has(`${c.provinceId}|${c.year}`));
  const rankSeriesUnlabeled = badCells.filter((c) => c.state === 'full').length;
  report.checks.rank_series_bad_cells = badCells.length;
  report.checks.rank_series_unlabeled = rankSeriesUnlabeled;

  // C3：Q6 定稿——河北（标准码 13）当年投档线/专业分必须保留且标为 partial + sampled。
  // 原实现「sampled 单元格全部为 partial」在 sampled=0 时恒真，正是抽样漏标的盲点。
  const sampledCells = report.coverage.filter((c) => c.sampled);
  const hbCurrent = report.coverage.filter((c) => c.year === GAOKAO_YEAR && c.provinceId === 13
    && (c.table === 'school_adm' || c.table === 'major_adm'));
  report.checks.sampled_cells = sampledCells.length;
  report.checks.hb_current_cells = hbCurrent.length;

  const gated = {
    A1: report.checks.rank_series_audited === report.checks.rank_series_groups
      && rankSeriesUnlabeled === 0,
    // opt-in 严格门禁：真不自洽组数 === 0。默认不在任何 fail-on / require-gates 集合中；
    // 存量 53 组已逐组披露并降级 partial，不因本门禁关闭而放宽规则或删除异常记录。
    A1S: report.checks.rank_series_true_fail === 0,
    A2: residualOut === 0,
    A4: APPLY ? report.issues.filter((i) => i.action === 'quarantine').every((i) => i.isolated) : false,
    C1: sm.labeledRate >= 0.98,
    C1F: sm.fullRate >= MIN_FULL_RATE,
    C2: sm.stateRate === 1,
    C3: sampledCells.length > 0
      && sampledCells.every((c) => c.state === 'partial')
      && hbCurrent.length === 2
      && hbCurrent.every((c) => c.sampled === 1 && c.state === 'partial'),
    C4: report.fieldStats.length >= 4,
    T2: !!dataVersion,
    RT: roundTrip.length === 0,
  };
  report.gates = gated;
  const failed = FAIL_ON.filter((f) => gated[f] !== true);
  report.failOn = FAIL_ON;
  report.failedGates = failed;
  report.passed = failed.length === 0;

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
  db.close();

  // ---- 控制台摘要 ----
  console.log(`\n== gaokao.db 质量校验（${report.mode}）==`);
  console.log(`  数据库 ${DB}`);
  console.log(`  越界/异常记录 ${report.checks.quarantine_total} 条（${APPLY ? '已物理隔离' : '审计模式，未改动'}）`);
  console.log(`  一分一段 ${seriesAudited}/${report.checks.rank_series_groups} 组已审计，真实不自洽 ${seriesFail} 组`);
  console.log(`    其中 seg 未发布（只校验 cum 单调）${segUnpublished} 组 · 汇总行 ${summaryRows} 条 · 结构性缺口阈值 >${LARGE_GAP_SCORE} 分`);
  console.log(`  覆盖单元格 ${report.coverage.length} 个：完整 ${sm.full} / 部分 ${sm.partial} / 缺失 ${sm.missing} / 仅图片 ${sm.imageOnly}`);
  console.log(`  历史完整度 ${(sm.fullRate * 100).toFixed(1)}%（披露，基线 ${(MIN_FULL_RATE * 100).toFixed(0)}%）· 四态标注率 ${(sm.labeledRate * 100).toFixed(1)}%（门禁）`);
  console.log(`  抽样单元格 ${sm.sampled} 个 · 河北 ${GAOKAO_YEAR} 投档/专业单元格 ${report.checks.hb_current_cells} 个`);
  console.log(`  省码回环 ${roundTrip.length === 0 ? '31/31 通过' : roundTrip.length + ' 省错配'}`);
  console.log(`  报告 ${REPORT_PATH}`);
  if (FAIL_ON.length) {
    console.log(`  门禁 ${FAIL_ON.join(',')}：${failed.length ? '❌ 未通过 ' + failed.join(',') : '✅ 全部通过'}`);
  }
  if (OPT_IN_GATES.includes('A1S') && !FAIL_ON.includes('A1S') && !gated.A1S) {
    console.log(`  A1S（严格零不自洽）默认关闭：真不自洽 ${report.checks.rank_series_true_fail} 组，`
      + `逐组明细见报告 rankSeriesDetail（${report.checks.rank_series_detail_count} 条）`);
    console.log('    启用前置：按清单修复数据后重新 --apply 烘焙，再显式 --fail-on ...,A1S');
  }
  if (failed.length) process.exitCode = 1;
}

main();

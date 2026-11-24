/**
 * 数据质量 · 运行时唯一真源（server/quality.mjs）
 *
 * 设计要点：
 *  - 双模式：随包库若由 tools/verify_gcdb.mjs 烘焙过质量表，优先读烘焙表；
 *    否则（当前随包库的实际情况）从 gaokao.db 主表只读实时聚合，进程内缓存一次。
 *    这样本次改动无需重建 52MB 数据库即可立刻生效。
 *  - 所有 API 的 dataQuality 字段只由本模块产出，禁止各层自造 estimated/sampled/rankSource 语义。
 *  - 决策口径（2026-11-18 用户拍板）：
 *      U4 河北 2026 抽样行「保留 + 标注 + 默认排除」；
 *      U5 不考虑复读/模考，gaokaoYear 恒为当前日历年；
 *      Q4 异常数据默认隐藏，但 /api/quality/issues 与质量面板可查；
 *      Q7 质量面板默认精简版，维护者细节折叠。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as gc from './gcdb.mjs';
import { DATA_DIR, INDEX_DIR, PROVINCE_NAME, PROVINCE_ID, readJsonCached } from './data.mjs';
import {
  CORE_TABLES, TABLE_LABEL, TABLE_SOURCE, EXPECTED_YEARS, DEFAULT_BASELINE_YEAR,
  STATE_LABEL, STATE_SYMBOL, LEGEND, RULE_TEXT, BASELINE_SAMPLE_YEARS,
  classifyCell, computeFreshness, flagsOf, snapshotText, median,
} from './quality-core.mjs';

export { LEGEND };
const BAKED = () => gc.hasQualityTables();

/** 高考年度：不考虑复读/模考，恒取当前日历年（Q1/U5 决策） */
export function gaokaoYear() { return new Date().getFullYear(); }
/** 完整基准年：固化，避免 2026 抽样数据被当作基准（U6 默认取值） */
export function baselineYear() {
  const m = gc.manifest();
  return Number(m.baseline_year) || DEFAULT_BASELINE_YEAR;
}

// ------------------------------------------------------------------
// 省份 / 表现层辅助
// ------------------------------------------------------------------
const pname = (stdPid) => PROVINCE_NAME.get(Number(stdPid)) || String(stdPid);

/** 备用资源里的「仅图片发布」省份-年份集合 */
let imageOnlySet = null;
function imageOnly() {
  if (imageOnlySet) return imageOnlySet;
  imageOnlySet = new Map();
  try {
    const d = readJsonCached(path.join(DATA_DIR, 'rank_table.json.gz'), { items: [], imageOnly: [] });
    for (const it of (d.imageOnly || [])) {
      const pid = PROVINCE_ID.get(it.province) || PROVINCE_ID.get(String(it.province).replace(/[省市自治区]/g, ''));
      if (!pid) continue;
      const k = `${pid}|${it.year}`;
      const cur = imageOnlySet.get(k) || [];
      cur.push({ title: it.title || '', url: it.url || '', type: it.type || '' });
      imageOnlySet.set(k, cur);
    }
  } catch { /* 备用资源缺失时忽略 */ }
  return imageOnlySet;
}

/** 后台补抓 JSON 索引里的抽样/未完成标记（Q6 溯源，仅用于标注 sampled）
 *  只读文件头 4KB 正则探测，避免解析 39 个大 JSON 拖慢首次请求。 */
let sampledSet = null;
function sampledYears() {
  if (sampledSet) return sampledSet;
  sampledSet = new Set();
  try {
    for (const f of fs.readdirSync(INDEX_DIR)) {
      const m = /^(province|special)_(\d+)_(\d+)\.json$/.exec(f);
      if (!m || Number(m[3]) <= baselineYear()) continue;
      try {
        const fd = fs.openSync(path.join(INDEX_DIR, f), 'r');
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const head = buf.subarray(0, n).toString('utf8');
        if (/"sampled"\s*:\s*true/.test(head) || /"complete"\s*:\s*false/.test(head)) {
          sampledSet.add(`${Number(m[2])}|${Number(m[3])}`);
        }
      } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 */ }
  return sampledSet;
}

// ------------------------------------------------------------------
// 覆盖单元格（四态矩阵）
// ------------------------------------------------------------------
function bakedCells(filter) {
  return gc.coverageCells(filter);
}

let cellCache = null;
function allCells() {
  if (cellCache) return cellCache;
  const base = baselineYear();
  const gy = gaokaoYear();
  const live = gc.liveQualityStats();
  const smp = sampledYears();
  const img = imageOnly();
  const out = [];

  // 同省同表最近 N 个「完整基准年及之前」年度行数中位数（C3 基准）
  const baselineRowsOf = (table, stdPid) => {
    const hist = [];
    for (let y = base; y > base - 8 && hist.length < BASELINE_SAMPLE_YEARS + 3; y--) {
      const c = live.perCell[table]?.[`${stdPid}|${y}`];
      if (c && c > 0) hist.push(c);
    }
    return hist.length >= 2 ? median(hist.slice(0, BASELINE_SAMPLE_YEARS)) : 0;
  };

  // 收集所有出现过的 (省,年) 组合 + 期望单元格（保证 missing 也进矩阵）
  const combos = new Set();
  for (const t of CORE_TABLES) {
    for (const k of Object.keys(live.perCell[t] || {})) combos.add(k);
    const [a, b] = EXPECTED_YEARS[t] || [base, base];
    for (const [pid] of PROVINCE_NAME) for (let y = a; y <= b; y++) combos.add(`${pid}|${y}`);
  }
  // 当年单元格也要出现（即便不在期望区间）
  for (const [pid] of PROVINCE_NAME) combos.add(`${pid}|${gy}`);

  for (const key of combos) {
    const [stdPid, year] = key.split('|').map(Number);
    if (!PROVINCE_NAME.has(stdPid) || !year) continue;
    for (const table of CORE_TABLES) {
      const [ea, eb] = EXPECTED_YEARS[table] || [base, base];
      const expected = year >= ea && year <= eb;
      const rows = live.perCell[table]?.[key] || 0;
      if (!rows && !expected && !img.has(key) && year <= base) continue; // 非期望的历史空单元格不展示
      const baselineRows = baselineRowsOf(table, stdPid);
      const sampled = smp.has(key) && (table === 'school_adm' || table === 'major_adm');
      const isImage = table === 'score_range' && rows === 0 && img.has(key);
      const gapCount = table === 'score_range' ? (live.gaps[key] || 0) : 0;
      const rankSeriesBad = table === 'score_range' && (live.rankBad[key] || 0) > 0;
      const cumBadCount = 0; // 已由 liveStats 汇总为异常清单，不重复
      const state = classifyCell({
        rows, baselineRows, sampled, complete: !sampled,
        year, baselineYear: base, gapCount, cumBadCount, rankSeriesBad,
        imageOnly: isImage, expected,
      });
      out.push({
        stdPid, province: pname(stdPid), year, table, tableName: TABLE_LABEL[table],
        state, stateLabel: STATE_LABEL[state], symbol: STATE_SYMBOL[state],
        rows, baselineRows, ratio: baselineRows ? Math.round(rows / baselineRows * 1000) / 1000 : null,
        sampled: sampled ? 1 : 0, expected,
        imageOnly: isImage ? 1 : 0, gaps: gapCount,
        rankSeriesBad: rankSeriesBad ? 1 : 0,
        source: TABLE_SOURCE[table] || null, sourceBasis: 'table-level',
        basis: baselineRows ? 'province-3y' : 'none',
      });
    }
  }
  out.sort((a, b) => a.stdPid - b.stdPid || b.year - a.year || CORE_TABLES.indexOf(a.table) - CORE_TABLES.indexOf(b.table));
  cellCache = out;
  return out;
}

/** 外部使缓存失效（后台补抓完成后调用） */
export function invalidate() { cellCache = null; gc.qualityTablesPresent(); }

export function coverage({ pid, year, table, gaokaoYear: gyOpt } = {}) {
  const gy = Number(gyOpt) || gaokaoYear();
  const base = baselineYear();
  let cells;
  if (BAKED()) {
    cells = bakedCells({ pid, year, table }).map((r) => ({
      stdPid: r.stdPid, province: pname(r.stdPid), year: r.y, table: r.table_name,
      tableName: TABLE_LABEL[r.table_name] || r.table_name,
      state: r.state, stateLabel: STATE_LABEL[r.state] || r.state, symbol: STATE_SYMBOL[r.state] || '',
      rows: r.rows, baselineRows: r.baseline_rows, ratio: r.ratio,
      sampled: r.sampled, expected: r.expected, imageOnly: r.image_only, gaps: r.gaps,
      source: r.source || null, sourceBasis: r.source ? 'manifest' : 'table-level',
      basis: r.basis || null,
    }));
  } else {
    cells = allCells().filter((c) =>
      (pid == null || c.stdPid === Number(pid)) &&
      (year == null || c.year === Number(year)) &&
      (!table || c.table === table));
  }
  const summary = { full: 0, partial: 0, missing: 0, imageOnly: 0,
    expected: 0, sampled: 0, labeled: 0 };
  for (const c of cells) {
    if (summary[c.state] != null) summary[c.state]++;
    if (c.expected) {
      summary.expected++;
      if (['full', 'partial', 'missing', 'imageOnly'].includes(c.state)) summary.labeled++;
    }
    if (c.sampled) summary.sampled++;
  }
  const expectedFull = cells.filter((c) => c.expected && c.state === 'full').length;
  // 与构建期 verify_gcdb.mjs 同口径：completeRate/fullRate 是历史完整度【披露指标】，
  // labeledRate 是四态标注覆盖率【门禁指标】。历史缺口如实呈现，不冒充达标。
  summary.fullRate = summary.expected ? Math.round(expectedFull / summary.expected * 1000) / 1000 : 1;
  summary.completeRate = summary.fullRate;
  summary.labeledRate = summary.expected ? Math.round(summary.labeled / summary.expected * 1000) / 1000 : 1;
  summary.stateRate = 1; // classifyCell 无 unknown
  summary.baselineYear = base;
  summary.gaokaoYear = gy;
  summary.baked = BAKED();
  return { ok: true, cells, summary, dataVersion: version().dataVersion };
}

/**
 * 逐单元格视图（T2/Q6）：供资料库等按 (省, 年, 表) 取状态与来源。
 * 取不到时返回 null，调用方必须自行标注「来源未逐单元格溯源」。
 */
export function cellOf(pid, year, table = 'score_range') {
  return coverage({ pid, year, table }).cells[0] || null;
}

/** 来源描述：优先 cell_manifest 的逐单元格来源，否则给表级来源并明确 basis。
 *  - basis='manifest'    逐单元格确证（由 verify_gcdb.mjs --apply 烘焙）
 *  - basis='table-level' 仅表级来源，不得当作该单元格的官方出处
 */
export function sourceOf(pid, year, table = 'score_range') {
  const c = cellOf(pid, year, table);
  if (c?.source) {
    return { source: c.source, basis: c.sourceBasis || 'manifest',
      state: c.state, sampled: c.sampled || 0 };
  }
  return { source: TABLE_SOURCE[table] || '来源未标注',
    basis: 'table-level', state: null, sampled: 0 };
}

// ------------------------------------------------------------------
// 按省逐表新鲜度（T1/T4）：禁止用全库 MIN/MAX
// ------------------------------------------------------------------
export function freshness(pid, gyOpt) {
  const gy = Number(gyOpt) || gaokaoYear();
  const stdPid = Number(pid);
  const cells = coverage({ pid: stdPid }).cells;
  const tables = CORE_TABLES.map((table) => {
    // 只把「确实有行」的单元格作为年份候选；rows=0 的期望单元格只表达「缺失」，不能冒充最新年份
    const cs = cells.filter((c) => c.table === table && c.stdPid === stdPid && c.rows > 0)
      .map((c) => ({ year: c.year, state: c.state, rows: c.rows, source: c.source || null }));
    const f = computeFreshness(cs, gy);
    return {
      table, tableName: TABLE_LABEL[table],
      ...f,
      label: `${f.latestYear ?? '—'} 年（${STATE_LABEL[f.state] || ''}）`,
    };
  });
  const levels = tables.map((t) => t.level);
  const level = levels.includes('no-data') && tables.every((t) => t.level === 'no-data') ? 'no-data'
    : levels.includes('stale') ? 'stale' : levels.includes('lagging') ? 'lagging' : 'current';
  const v = version();
  const built = v.builtAt ? String(v.builtAt).slice(0, 10) : '未知';
  const worst = tables.filter((t) => t.lagYears != null).sort((a, b) => b.lagYears - a.lagYears)[0];
  const partials = tables.filter((t) => t.state === 'partial' || t.state === 'imageOnly');
  const bannerText = [
    `${pname(stdPid)} · 数据版本 ${v.dataVersion || '未标注'} · 构建 ${built}`,
    worst && worst.lagYears > 0 ? `完整数据截至 ${worst.latestCompleteYear}（滞后 ${worst.lagYears} 年）` : '',
    partials.length ? `${partials.map((t) => t.tableName).join('、')}为 ◐ 部分/抽样或非结构化` : '',
  ].filter(Boolean).join(' · ');
  return {
    ok: true, province: pname(stdPid), provinceId: stdPid, gaokaoYear: gy,
    tables, level, bannerText, dataVersion: v.dataVersion, builtAt: v.builtAt,
  };
}

// ------------------------------------------------------------------
// 字段非空率 / 异常清单 / 缺口 / 抽样比对
// ------------------------------------------------------------------
export function fields({ pid, year } = {}) {
  if (BAKED()) {
    const rows = gc.fieldStatsRows().filter((r) => (!pid || Number(r.stdPid ?? r.p) === Number(pid)) && (!year || Number(r.y) === Number(year)));
    return { ok: true, baked: true, byTable: rows, summary: {}, note: '数据来自构建期烘焙表' };
  }
  const f = gc.liveQualityStats().fields;
  const pct = (a, b) => (b ? Math.round(a / b * 1000) / 1000 : 0);
  const sa = f.school_adm || {}, ma = f.major_adm || {}, sr = f.score_range || {};
  const byTable = {
    school_adm: {
      total: sa.total || 0,
      min: { nonNull: sa.minNonNull || 0, fillRate: pct(sa.minNonNull, sa.total), outOfRange: sa.minOutOfRange || 0 },
      rnk: { nonNull: sa.rnkNonNull || 0, fillRate: pct(sa.rnkNonNull, sa.total) },
      ctrl: { nonNull: sa.ctrlNonNull || 0, fillRate: pct(sa.ctrlNonNull, sa.total), note: '≈ 其余由批次线归纳回填' },
    },
    major_adm: {
      total: ma.total || 0,
      min: { nonNull: ma.minNonNull || 0, fillRate: pct(ma.minNonNull, ma.total), outOfRange: ma.minOutOfRange || 0 },
    },
    score_range: {
      total: sr.total || 0,
      cum: { bad: sr.cumBad || 0 }, score: { bad: sr.scoreBad || 0 },
    },
  };
  return {
    ok: true, baked: false, byTable,
    summary: {
      minFillRate: byTable.school_adm.min.fillRate,
      rnkFillRate: byTable.school_adm.rnk.fillRate,
      ctrlFillRate: byTable.school_adm.ctrl.fillRate,
    },
    note: '缺失（NULL/0）只披露、不填充、不隔离；越界值进入异常清单并在查询层隔离',
  };
}

export function issues({ table, pid, limit = 100 } = {}) {
  let items;
  if (BAKED()) {
    items = gc.qualityIssues(Math.min(limit, 500)).map((r) => ({
      table: r.table_name, stdPid: Number(r.stdPid ?? r.p), year: Number(r.y),
      rowKey: r.row_key, rule: r.rule, reason: r.reason || RULE_TEXT[r.rule] || r.rule,
      value: r.snapshot_json || r.value, quarantine: r.quarantine ?? true,
    }));
  } else {
    items = gc.liveQualityStats().issues.map((r) => ({
      table: r.table, stdPid: r.stdPid, year: r.year, rowKey: r.rowKey,
      rule: r.rule, reason: RULE_TEXT[r.rule] || r.rule, value: r.value, quarantine: 'query-layer',
    }));
  }
  items = items.filter((r) => (!table || r.table === table) && (!pid || r.stdPid === Number(pid)));
  return { ok: true, total: items.length, items: items.slice(0, limit), defaultHidden: true, note: '异常记录默认不进候选集、不显示、不计入覆盖统计；仅在本清单可见（Q4 决策）' };
}

export function gaps({ pid, year } = {}) {
  const img = imageOnly();
  const rankGaps = [], imageOnlyList = [];
  const live = gc.liveQualityStats();
  for (const [k, n] of Object.entries(live.gaps)) {
    const [p, y] = k.split('|').map(Number);
    if ((pid == null || p === Number(pid)) && (year == null || y === Number(year))) rankGaps.push({ province: pname(p), provinceId: p, year: y, gapCount: n });
  }
  for (const [k, arr] of img) {
    const [p, y] = k.split('|').map(Number);
    if ((pid == null || p === Number(pid)) && (year == null || y === Number(year))) imageOnlyList.push({ province: pname(p), provinceId: p, year: y, ...arr[0] });
  }
  return { ok: true, rankGaps, imageOnly: imageOnlyList };
}

export function audit() {
  const baked = BAKED();
  return {
    ok: true,
    status: 'not_run',
    note: '官方值抽样比对为构建期人工台账（tools/verify_gcdb.mjs --audit），运行时不联网；未执行时如实标注，不谎报一致率',
    baked,
  };
}

// ------------------------------------------------------------------
// 版本信息
// ------------------------------------------------------------------
export function version() {
  const m = gc.manifest();
  const builtAt = m.built_at || m.builtAt || m.kv?.builtAt || null;
  let dataVersion = m.data_version || null;
  if (!dataVersion && builtAt) {
    const d = String(builtAt).slice(0, 10).replace(/-/g, '.');
    dataVersion = `${d}-r1`;
  }
  return {
    dataVersion, builtAt, gaokaoYear: gaokaoYear(), baselineYear: baselineYear(),
    dbSha256: m.db_sha256 || null, schemaVersion: m.schema_version || 0, baked: BAKED(),
    appVersion: '1.1.0',
  };
}

/** 可用参考年份：排除 partial / sampled / 仅图片 / 缺失年份（U4 默认排除） */
export function usableYears(pid, maxYears = 3) {
  const gy = gaokaoYear();
  const base = baselineYear();
  const cov = coverage({ pid }).cells;
  const okYears = new Set();
  for (const c of cov) {
    if (c.table !== 'school_adm') continue;
    if (c.year <= base && c.state === 'full') okYears.add(c.year);
  }
  // 回退：烘焙表尚未生成且实时统计无任何 full（例如极端稀疏库），仍返回历史年份避免 NO_INDEX 崩溃，
  // 但由 snapshot 标注 historyFallback。
  if (!okYears.size) {
    const all = cov.filter((c) => c.table === 'school_adm' && c.rows > 0).map((c) => c.year);
    for (const y of all.filter((y) => y <= base)) okYears.add(y);
  }
  return [...okYears].filter((y) => y <= gy + 1).sort((a, b) => b - a).slice(0, maxYears);
}

/** 统一 dataQuality 信封（所有 API 附加这一份，禁止各层自造字段） */
export function snapshot(pid, ctx = {}) {
  const stdPid = Number(pid) || 0;
  const v = version();
  const gy = Number(ctx.gaokaoYear) || gaokaoYear();
  const refYears = Array.isArray(ctx.refYears) ? ctx.refYears : [];
  const refYearStates = {};
  if (stdPid) {
    const cells = coverage({ pid: stdPid }).cells;
    for (const y of refYears) {
      const c = cells.find((x) => x.table === 'school_adm' && x.year === Number(y));
      refYearStates[y] = c ? c.state : 'missing';
    }
  }
  const primary = refYears[0] || null;
  const historyFallback = primary != null && primary < gy;
  const f = stdPid ? freshness(stdPid, gy) : null;
  const fl = fields().summary || {};
  const ctrlFilled = ctx.ctrlFilled != null
    ? (typeof ctx.ctrlFilled === 'object' ? ctx.ctrlFilled : { count: Number(ctx.ctrlFilled), total: null })
    : { count: null, total: null };
  const dq = {
    dataVersion: v.dataVersion, builtAt: v.builtAt,
    gaokaoYear: gy, baselineYear: v.baselineYear,
    province: stdPid ? pname(stdPid) : null, provinceId: stdPid || null,
    baked: v.baked,
    tables: f ? f.tables : [],
    freshnessLevel: f ? f.level : null,
    bannerText: f ? f.bannerText : null,
    refYears, refYearStates,
    historyFallback, fallbackYears: historyFallback ? gy - primary : 0,
    rankSource: ctx.rankSource || 'none', rankEstimated: ctx.rankSource === 'estimated',
    rankYear: ctx.rankYear || null, rankTableState: ctx.rankTableState || null,
    sampled: !!ctx.sampled,
    ctrlFilled,
    fieldFill: { min: fl.minFillRate ?? null, rnk: fl.rnkFillRate ?? null, ctrl: fl.ctrlFillRate ?? null },
    legend: LEGEND,
  };
  dq.flags = flagsOf({
    rankEstimated: dq.rankEstimated, sampled: dq.sampled, historyFallback,
    ctrlFilled: ctrlFilled.count || 0, refYearStates,
  });
  dq.snapshotText = snapshotText(dq);
  return dq;
}

/** AI 上下文用的精简版，避免把整个信封塞进提示词 */
export function brief(pid) {
  const stdPid = Number(pid) || 0;
  if (!stdPid) return null;
  const v = version();
  const f = freshness(stdPid);
  return {
    dataVersion: v.dataVersion, builtAt: v.builtAt,
    gaokaoYear: v.gaokaoYear, baselineYear: v.baselineYear,
    province: pname(stdPid),
    tables: f.tables.map((t) => ({ table: t.tableName, latestYear: t.latestYear, state: t.state, lagYears: t.lagYears })),
    level: f.level,
  };
}

/** 31 省标准码回环自检（暴露给 /api/status 与 QA） */
export function roundTrip() { return gc.provinceRoundTrip(); }

/** 合并报告（数据管理页「导出报告」按钮） */
export function report() {
  const cov = coverage({});
  return {
    ok: true, generatedAt: new Date().toISOString(),
    version: version(),
    coverage: cov.summary,
    roundTrip: gc.provinceRoundTrip(),
    fields: fields(),
    issues: issues({ limit: 500 }),
    gaps: gaps({}),
    audit: audit(),
    decisions: {
      U4: '保留 + 标注 + 默认排除（河北 2026 抽样行）',
      U5: '不考虑复读/模考，gaokaoYear 恒为当前日历年',
      Q4: '异常数据默认隐藏，可在质量面板查询',
      Q7: '质量面板默认精简版，维护者细节折叠',
    },
  };
}

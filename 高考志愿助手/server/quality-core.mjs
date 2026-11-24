/**
 * 数据质量 · 共享纯逻辑（零依赖、无 IO）
 *
 * 同时被运行时 server/quality.mjs 与构建期 tools/verify_gcdb.mjs 引用，
 * 避免「构建期判定」与「运行时判定」出现规则漂移。
 * 本文件不得引入 node:sqlite / fs / data.mjs 等任何有副作用或路径依赖的模块。
 */

export const CORE_TABLES = ['score_range', 'school_adm', 'major_adm', 'plan_code'];
export const TABLE_LABEL = {
  score_range: '一分一段表',
  school_adm: '院校投档线',
  major_adm: '专业录取分',
  plan_code: '招生计划',
};

/**
 * 表级来源（T2）。逐单元格溯源以 cell_manifest.source 为准；
 * 未烘焙逐单元格来源时，只给表级来源并明确标注 sourceBasis，
 * 禁止按 `year >= 2026` 硬猜成「某项目」再当作确证（Q6 直接修复点）。
 */
export const TABLE_SOURCE = {
  score_range: 'GaokaoCompass 历史库 / 各省考试院官方发布（当年增量）',
  school_adm: 'GaokaoCompass 历史库 / 后台补抓（当年增量）',
  major_adm: 'GaokaoCompass 历史库 / 后台补抓（当年增量）',
  plan_code: 'GaokaoCompass 招生计划 / 掌上高考',
};

/** 「当年应有单元格」基准：完整基准年及之前才计入完整率分母 */
export const EXPECTED_YEARS = {
  score_range: [2017, 2025],
  school_adm: [2017, 2025],
  major_adm: [2023, 2025],
  plan_code: [2023, 2025],
};
export const DEFAULT_BASELINE_YEAR = 2025;
export const SPARSE_RATIO = 0.30;       // 低于同省近 3 年中位数的 30% 判为 partial
export const BASELINE_SAMPLE_YEARS = 3;

/**
 * 一分一段「结构性缺口」阈值。
 * 官方一分一段表天然跳分（只发布有人的分数段），相邻差 1~10 分属正常发布形态；
 * 只有跨度 >10 分的连续空白才算缺口。构建期与运行时共用，避免判定漂移。
 */
export const LARGE_GAP_SCORE = 10;
export const RANK_SUM_REL_TOL = 0.002; // Σseg 与末 cum 允许的相对偏差
export const RANK_SUM_ABS_TOL = 5;     // 绝对偏差下限

/** 四态：无 unknown */
export const STATE_LABEL = {
  full: '完整', partial: '部分/抽样', missing: '缺失', imageOnly: '仅图片',
};
export const STATE_SYMBOL = {
  full: '●', partial: '◐', missing: '—', imageOnly: 'ⓘ',
};

/** 灰数据统一图例：符号 + 文字，颜色不作唯一区分 */
export const LEGEND = [
  { key: 'official', symbol: '●', label: '官方完整', cssClass: 'q-official', state: 'full' },
  { key: 'estimated', symbol: '≈', label: '估算/拟合', cssClass: 'q-est' },
  { key: 'partial', symbol: '◐', label: '部分/抽样', cssClass: 'q-partial', state: 'partial' },
  { key: 'info', symbol: 'ⓘ', label: '回填/图片/缺口', cssClass: 'q-info', state: 'imageOnly' },
  { key: 'fallback', symbol: '⚠', label: '历史回退', cssClass: 'q-warn' },
];

export const RULE_TEXT = {
  min_out: '最低分越界（不在 100–750）',
  rnk_neg: '最低位次为负',
  ctrl_neg: '省控线为负',
  score_out: '分数越界（不在 0–800）',
  cum_neg: '累计人数为负',
  rank_series: '一分一段累计人数不自洽',
};

// ------------------------------------------------------------------
// 字段合法性谓词：严格区分「越界（值存在但非法）」与「缺失（NULL/0）」
// 缺失只披露、不填充、不隔离；只有值存在且非法才隔离。
// ------------------------------------------------------------------
export const isValidMin = (v) => v == null || v === 0 || (Number(v) >= 100 && Number(v) <= 750);
export const isValidMinRank = (v) => v == null || v === 0 || Number(v) >= 0;
export const isValidCtrl = (v) => v == null || v === 0 || Number(v) >= 0;
export const isValidCum = (v) => v == null || Number(v) >= 0; // cum=0 是合法起点；NULL 只披露
export const isValidScore = (v) => Number(v) >= 0 && Number(v) <= 800;

/** 中位数 */
export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 结构性分数缺口：只统计跨度 > LARGE_GAP_SCORE 的连续空白段。
 * - 官方表按「有人的分数段」发布，1~10 分的跳分是正常的，不算缺口；
 * - score <= 0 是「总计人数」汇总行，不属于分数序列，必须排除。
 */
export function countLargeGaps(scores) {
  const v = (Array.isArray(scores) ? scores : [])
    .map(Number).filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => b - a);
  let n = 0;
  for (let i = 1; i < v.length; i++) if (v[i - 1] - v[i] > LARGE_GAP_SCORE) n++;
  return n;
}

/**
 * 主库一分一段组（p,y,c 跨批次合并）的分级自洽诊断。
 *
 * 与外部抓取资源（tools/crawl_resources.mjs verifyRankSeries）的三点关键差异：
 *  1) 主库约半数年份只发布累计人数，seg 整组为 NULL/0 —— 此时不能要求 Σseg≈末 cum；
 *  2) score<=0 是「总计人数」汇总行，cum 属另一套口径，混入序列会造成假的 cum 回退；
 *  3) 同一 (p,y,c) 下 b 为分片批次，cum 是全局累计，必须合并而非按 b 拆分。
 *
 * 返回 pass=false 表示真实异常（进入异常清单 / 该单元格降级为 partial），
 * 不再把「数据形态差异」误报为异常。
 */
export function auditRankSeries(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const summaryRows = all.filter((r) => !(Number(r.score) > 0)).length;
  const s = all.filter((r) => Number(r.score) > 0)
    .sort((a, b) => Number(b.score) - Number(a.score)
      || Number(a.cum ?? 0) - Number(b.cum ?? 0));
  const base = {
    total: all.length, summaryRows, length: s.length,
    mono: true, negCum: 0, nullCum: 0,
    sumSeg: 0, endCum: 0, hasSeg: false, sumOk: true, scaleOk: false,
    largeGaps: 0, pass: false, errors: [],
  };
  if (!s.length) { base.errors.push('无有效分段行'); return base; }

  let mono = true, negCum = 0, nullCum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i].cum;
    if (c == null) { nullCum++; continue; }
    if (Number(c) < 0) negCum++;
    if (i > 0 && s[i - 1].cum != null && Number(c) < Number(s[i - 1].cum)) mono = false;
  }
  const sumSeg = s.reduce((a, r) => a + (Number(r.seg) || 0), 0);
  const endCum = Number(s[s.length - 1].cum) || 0;
  const hasSeg = sumSeg > 0;
  const sumOk = !hasSeg
    || Math.abs(sumSeg - endCum) <= Math.max(RANK_SUM_ABS_TOL, endCum * RANK_SUM_REL_TOL);
  const scaleOk = endCum > 500;
  const largeGaps = countLargeGaps(s.map((r) => r.score));

  const errors = [];
  if (!mono) errors.push('累计人数回退');
  if (nullCum) errors.push(`累计人数缺失 ${nullCum} 行`);
  if (negCum) errors.push(`累计人数为负 ${negCum} 行`);
  if (!sumOk) errors.push(`Σseg ${sumSeg} 与末 cum ${endCum} 不符`);
  if (!scaleOk) errors.push(`末累计人数 ${endCum} 规模异常`);

  return { ...base, mono, negCum, nullCum, sumSeg, endCum, hasSeg,
    sumOk, scaleOk, largeGaps, errors, pass: errors.length === 0 };
}

/**
 * 四态判定（C2 保证无 unknown；C3 稀疏识别）
 * @returns {'full'|'partial'|'missing'|'imageOnly'}
 */
export function classifyCell({
  rows = 0, baselineRows = 0, sampled = false, complete = true,
  year = 0, baselineYear = DEFAULT_BASELINE_YEAR,
  gapCount = 0, cumBadCount = 0, rankSeriesBad = false,
  imageOnly = false, expected = true,
} = {}) {
  if (rows === 0) return imageOnly ? 'imageOnly' : 'missing';
  const ratio = rows / Math.max(1, baselineRows);
  const sparse = baselineRows > 0 && ratio < SPARSE_RATIO;
  const partial = sampled || complete === false || sparse
    || (year > baselineYear) || (gapCount > 0) || (cumBadCount > 0)
    || rankSeriesBad || expected === false;
  return partial ? 'partial' : 'full';
}

/** 滞后分级（Q10）：按省逐表，禁止用全库 MAX */
export function freshnessLevel(lagYears, state = 'full', year = 0, gaokaoYear = 0) {
  if (year > gaokaoYear) return 'provisional';
  if (lagYears == null) return 'no-data';
  if (lagYears <= 0) return 'current';
  if (lagYears === 1) return 'lagging';
  return 'stale';
}

/**
 * 由单元格集合计算按省逐表新鲜度。
 * @param cells Array<{year,state,rows,source?,ingestedAt?}>
 */
export function computeFreshness(cells, gaokaoYear) {
  const sorted = [...cells].sort((a, b) => b.year - a.year);
  const latest = sorted[0] || null;
  const complete = sorted.filter((c) => c.state === 'full');
  const latestComplete = complete.length ? complete[0] : null;
  const latestYear = latest ? latest.year : null;
  const latestCompleteYear = latestComplete ? latestComplete.year : null;
  const lagYears = latestCompleteYear == null ? null : gaokaoYear - latestCompleteYear;
  const state = latest ? latest.state : 'missing';
  const level = freshnessLevel(lagYears, state, latestYear || 0, gaokaoYear);
  return {
    latestYear, latestCompleteYear, gaokaoYear, lagYears, level, state,
    source: latest?.source || null,
    ingestedAt: latest?.ingestedAt || null,
  };
}

/** 统一 dataQuality 信封里的 flags（灰数据标记） */
export function flagsOf({ rankEstimated = false, sampled = false, historyFallback = false,
  ctrlFilled = 0, imageOnly = false, gaps = 0, refYearStates = {} } = {}) {
  const out = [];
  if (rankEstimated) out.push({ ...LEGEND[1], text: '≈ 位次为拟合估算（无官方一分一段表）' });
  if (sampled) out.push({ ...LEGEND[2], text: '◐ 本次结果基于快速抽样数据，刷新后可能变化' });
  if (ctrlFilled > 0) out.push({ ...LEGEND[3], text: `ⓘ 省控线由批次线归纳回填（${ctrlFilled} 条）` });
  if (imageOnly || gaps > 0) out.push({ ...LEGEND[3], text: 'ⓘ 官方仅图片发布 / 存在分数缺口' });
  if (Object.values(refYearStates).some((s) => s === 'partial' || s === 'imageOnly')) {
    out.push({ ...LEGEND[2], text: '◐ 参考年份含部分/抽样数据' });
  }
  if (historyFallback) out.push({ ...LEGEND[4], text: `⚠ 本次基于历史数据（非当年）` });
  return out;
}

/** 生成统一「数据快照条」文案 */
export function snapshotText(dq) {
  const bits = [];
  if (dq.refYears?.length) bits.push(`本次基于 ${dq.refYears[0]} 年历史数据`);
  if (dq.historyFallback) bits.push(`⚠ 历史回退落后 ${dq.fallbackYears} 年`);
  if (dq.rankEstimated) bits.push('位次 ≈ 拟合估算');
  else if (dq.rankSource === 'official' || dq.rankSource === 'user') bits.push('位次 ● 官方/直填');
  if (dq.sampled) bits.push('◐ 快速抽样');
  if (dq.dataVersion) bits.push(`数据版本 ${dq.dataVersion}`);
  if (dq.builtAt) bits.push(`构建 ${String(dq.builtAt).slice(0, 10)}`);
  return bits.join(' · ');
}

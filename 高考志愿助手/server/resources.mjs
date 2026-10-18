/**
 * 资料库：一分一段表（真实数据）+ 院校代码 / 专业代码
 *
 * 一分一段数据来自中国教育在线（gaokao.eol.cn / www.eol.cn）抓取的各省官方发布表格，
 * 已归一化为 [[分数, 累计人数, 本段人数], ...]（分数降序）。
 * 代码数据来自掌上高考招生计划接口与专业分数线接口（见 upstream.mjs）。
 */
import {
  DATA_DIR, PROVINCES, PROVINCE_NAME, PROVINCE_ID, getSchool, readJsonCached, cacheGet, cacheSet,
} from './data.mjs';
import * as gc from './gcdb.mjs';
import { gcIdOf } from './gcsource.mjs';
import { fetchAll } from './upstream.mjs';
import path from 'node:path';

const PROVINCES_ARR = PROVINCES;

// ------------------------------------------------------------------
// 一分一段表
// ------------------------------------------------------------------
let rankStore = null;
const rankIndex = new Map();      // `${pid}_${year}_${type}` -> item

// ==================================================================
// 一分一段表
//   首选新数据源（GaokaoCompass 统一 SQLite，31 省 × 2017-2025）
//   其次回退到原先抓取的中国教育在线表格（rank_table.json.gz）
// ==================================================================
const GC_ON = () => { try { return gc.available(); } catch { return false; } };

/** 新数据源的一分一段（内部统一返回与旧结构相同的字段） */
function gcRankTable(pid, year, type) {
  const t = gc.rankTable(Number(pid), Number(year), type);
  if (!t || !t.series.length) return null;
  return { province: t.province, year: t.year, type: type || t.type, series: t.series, range: t.range, total: t.total, gaps: t.gaps, full: t.full, url: 'https://huggingface.co/datasets/choucsan/Gaokao-Compass-11M', title: `GaokaoCompass · ${t.province} ${t.year} 年一分一段表`, control: t.control, source: 'GaokaoCompass' };
}

export function loadRankTables() {
  if (rankStore) return rankStore;
  const d = readJsonCached(path.join(DATA_DIR, 'rank_table.json.gz'), { source: '', items: [], imageOnly: [] });
  rankStore = d;
  for (const it of d.items || []) {
    const pid = PROVINCE_ID.get(it.province);
    if (!pid) continue;
    rankIndex.set(`${pid}_${it.year}_${it.type}`, it);
  }
  return rankStore;
}

/** 列出可用的 (省, 年, 科类) 组合 */
export function listRankTables() {
  if (GC_ON()) {
    const groups = new Map();
    for (const [pid, name] of PROVINCES_ARR) {
      for (const r of gc.rankYears(pid)) {
        const k = `${pid}_${r.year}`;
        if (!groups.has(k)) groups.set(k, { provinceId: pid, province: name, year: r.year, types: [] });
        groups.get(k).types.push(r.type);
      }
    }
    return [...groups.values()].sort((a, b) => b.year - a.year || String(a.province).localeCompare(String(b.province), 'zh'));
  }
  const d = loadRankTables();
  const groups = new Map();
  for (const it of d.items || []) {
    const pid = PROVINCE_ID.get(it.province);
    if (!pid) continue;
    const k = `${pid}_${it.year}`;
    if (!groups.has(k)) groups.set(k, { provinceId: pid, province: it.province, year: it.year, types: [], total: it.total, range: it.range, full: it.full, url: it.url, title: it.title });
    groups.get(k).types.push(it.type);
  }
  return [...groups.values()].sort((a, b) => b.year - a.year || String(a.province).localeCompare(String(b.province), 'zh'));
}

/** 只有图片、没有结构化表格的省份（如实告知用户） */
export function listImageOnly() {
  return (loadRankTables().imageOnly || []).slice();
}

export function getRankTable(pid, year, type) {
  if (GC_ON()) {
    const t = gcRankTable(pid, year, type);
    if (t) return t;
  }
  loadRankTables();
  let it = rankIndex.get(`${pid}_${year}_${type}`);
  if (!it) {
    for (const t of ['综合', '物理类', '历史类']) {
      const c = rankIndex.get(`${pid}_${year}_${t}`);
      if (c) { it = c; break; }
    }
  }
  return it || null;
}

/** 该省有哪些年/科类可用（合并新数据源 2017-2025 与已抓取的 2026，取并集） */
export function availableRank(pid) {
  const out = [];
  const seen = new Set();
  if (GC_ON()) {
    for (const r of gc.rankYears(Number(pid))) {
      const k = `${r.year}_${r.type}`;
      if (!seen.has(k)) { seen.add(k); out.push({ year: r.year, type: r.type, source: 'GaokaoCompass' }); }
    }
  }
  loadRankTables();
  for (const k of rankIndex.keys()) {
    const [p, y, t] = k.split('_');
    if (Number(p) !== Number(pid)) continue;
    const kk = `${y}_${t}`;
    if (!seen.has(kk)) { seen.add(kk); out.push({ year: Number(y), type: t, source: 'eol' }); }
  }
  return out.sort((a, b) => b.year - a.year);
}

/**
 * 分数 → 位次（用真实一分一段表）
 * 返回 { rank, year, type, exact, table }；无表则返回 null
 */
export function realScoreToRank(pid, type, score, preferYear) {
  const avail = availableRank(pid).filter((x) => !type || x.type === type || x.type === '综合' || type === '综合');
  if (!avail.length) return null;
  const pick = (preferYear && avail.find((x) => x.year === preferYear)) || avail[0];
  const t = getRankTable(pid, pick.year, type) || getRankTable(pid, pick.year, pick.type);
  if (!t || !Array.isArray(t.series)) return null;
  const s = Number(score);
  const ser = t.series;                       // 分数降序
  const top = ser[0], bot = ser[ser.length - 1];
  let rank;
  let exact = true;
  if (s >= top[0]) { rank = top[1]; exact = false; }
  else if (s <= bot[0]) { rank = bot[1]; exact = false; }
  else {
    for (let i = 1; i < ser.length; i++) {
      if (s >= ser[i][0]) {
        const hi = ser[i - 1], lo = ser[i];
        if (hi[0] - lo[0] > 1) { rank = lo[1]; }          // 缺口：取下一档（更保守）
        else rank = lo[1];
        break;
      }
    }
  }
  if (!rank) return null;
  return { rank, year: t.year, type: t.type, exact, total: t.total, range: t.range, url: t.url, title: t.title, gaps: t.gaps, full: t.full };
}

/** 位次 → 分数（用真实一分一段表） */
export function realRankToScore(pid, type, rank, preferYear) {
  const avail = availableRank(pid).filter((x) => !type || x.type === type || x.type === '综合' || type === '综合');
  if (!avail.length) return null;
  const pick = (preferYear && avail.find((x) => x.year === preferYear)) || avail[0];
  const t = getRankTable(pid, pick.year, type) || getRankTable(pid, pick.year, pick.type);
  if (!t || !Array.isArray(t.series)) return null;
  const r = Number(rank);
  const ser = t.series;
  if (r <= ser[0][1]) return { score: ser[0][0], year: t.year, type: t.type };
  const last = ser[ser.length - 1];
  if (r >= last[1]) return { score: last[0], year: t.year, type: t.type };
  for (let i = 1; i < ser.length; i++) {
    if (r <= ser[i][1]) {
      const hi = ser[i - 1], lo = ser[i];
      const t2 = (r - lo[1]) / Math.max(1, hi[1] - lo[1]);
      return { score: Math.round(lo[0] + (hi[0] - lo[0]) * t2), year: t.year, type: t.type };
    }
  }
  return null;
}

// ------------------------------------------------------------------
// 选科要求解析与过滤
// ------------------------------------------------------------------
const SUBJECTS = ['物理', '化学', '生物', '思想政治', '历史', '地理', '技术'];

/** 从 sg_info 文本解析出「必须选的科目」与「任选其一」 */
export function parseSubjectReq(text) {
  const t = String(text || '');
  if (!t || /不限/.test(t)) return { mode: 'any', require: [], anyOf: [] };
  const found = SUBJECTS.filter((s) => t.includes(s));
  // 「X、Y(N科必选)」/「首选X，再选Y」= 都需要
  if (/必选|首选|再选|均须|都要/.test(t) || /、/.test(t)) {
    return { mode: 'all', require: found, anyOf: [] };
  }
  // 「X或Y」「X/Y」
  if (/或|\//.test(t)) return { mode: 'oneOf', require: [], anyOf: found };
  return { mode: 'all', require: found, anyOf: [] };
}

/** 用户选科是否满足要求 */
export function matchSubjects(reqText, userSubjects) {
  const req = parseSubjectReq(reqText);
  const u = new Set((userSubjects || []).map((s) => String(s).trim()));
  if (!u.size) return true;                       // 未填写选科 → 不过滤
  if (req.mode === 'any') return true;
  if (req.mode === 'all') return req.require.every((s) => u.has(s));
  if (req.mode === 'oneOf') return req.anyOf.some((s) => u.has(s));
  return true;
}

// ------------------------------------------------------------------
// 院校代码 / 专业代码
// ------------------------------------------------------------------
/**
 * 招生计划 → 含专业国标代码(spcode)、专业组、计划数、学费、学制
 * 数据来源：掌上高考 gkv3/plan/school
 */
export async function getPlanCodes(schoolId, provinceId, year) {
  // 优先用统一数据集（离线、含专业代码、含计划数/学费/学制）
  if (GC_ON()) {
    try {
      const gid = gcIdOf(schoolId);
      if (gid != null) {
        const items = gc.planCodes(gid, Number(provinceId), Number(year));
        if (items.length) {
          return {
            items: items.map((x) => ({
              ...x, majorFull: '', level2: '', level3: '', remark: '',
              type: '', province: PROVINCE_NAME.get(Number(provinceId)) || '',
            })),
            numFound: items.length, failed: false, partial: false, cached: true, source: 'GaokaoCompass',
          };
        }
      }
    } catch { /* 回退到在线接口 */ }
  }
  const key = `plan_${schoolId}_${provinceId}_${year}`;
  const hit = cacheGet(key);
  if (hit && Date.now() - (hit.at || 0) < 1000 * 60 * 60 * 24 * 7) return { ...hit.value, cached: true };
  const r = await fetchAll('apidata/api/gkv3/plan/school', { school_id: schoolId, local_province_id: provinceId, year }, { maxPages: 40, user: true });
  const items = (r.items || []).map((it) => ({
    major: it.sp_name || '', majorFull: it.spname || '',
    majorCode: it.spcode || '',                 // 教育部专业(类)代码
    group: it.sg_name || '',                    // 专业组
    subjectReq: it.sg_info || '', firstReq: it.sg_fxk || '', reReq: it.sg_sxk || '',
    batch: it.local_batch_name || '', type: it.local_type_name || '', province: it.local_province_name || '',
    planNum: it.num || '', tuition: it.tuition ? `${it.tuition}${it.tuition_unit || ''}` : '',
    length: it.length || '', level2: it.level2_name || '', level3: it.level3_name || '',
    remark: it.info || it.remark || '', year: Number(it.year) || Number(year),
  }));
  const value = { items, numFound: r.numFound, failed: r.failed, partial: r.partial };
  if (!r.failed) cacheSet(key, { at: Date.now(), value });
  return { ...value, cached: false };
}

/**
 * 专业分数线 → 含省编专业代码(sp_scode)
 * 数据来源：掌上高考 gk/score/special
 */
export async function getSpecialCodes(schoolId, provinceId, year) {
  // 优先用统一数据集：专业录取分（离线）+ 招生计划里的教育部专业代码
  if (GC_ON()) {
    try {
      const gid = gcIdOf(schoolId);
      if (gid != null) {
        const rows = gc.schoolMajorAdmission(gid, Number(provinceId), Number(year));
        if (rows.length) {
          const plans = gc.planCodes(gid, Number(provinceId), Number(year));
          const codeOf = new Map();
          for (const p of plans) if (p.major && p.majorCode && !codeOf.has(p.major)) codeOf.set(p.major, p.majorCode);
          return {
            items: rows.map((r) => ({
              major: r.major, provinceCode: codeOf.get(r.major) || '', group: r.group || '',
              type: r.type || '', batch: r.batch || '',
              min: r.min, minRank: r.minRank, batchLine: 0, subjectReq: '', level2: '', level3: '', remark: '',
            })),
            numFound: rows.length, failed: false, partial: false, cached: true,
            source: 'GaokaoCompass', codeType: '教育部专业代码',
          };
        }
      }
    } catch { /* 回退到在线接口 */ }
  }
  const key = `spcode_${schoolId}_${provinceId}_${year}`;
  const hit = cacheGet(key);
  if (hit && Date.now() - (hit.at || 0) < 1000 * 60 * 60 * 24 * 7) return { ...hit.value, cached: true };
  const r = await fetchAll('apidata/api/gk/score/special', { school_id: schoolId, local_province_id: provinceId, year }, { maxPages: 70, user: true });
  const items = (r.items || []).map((it) => ({
    major: it.sp_name || '', provinceCode: it.sp_scode || '', group: it.sg_name || '',
    type: it.local_type_name || '', batch: it.local_batch_name || '',
    min: Number(it.min) || null, minRank: Number(it.min_section) || null,
    batchLine: Number(it.proscore) || null, subjectReq: it.sg_info || '',
    level2: it.level2_name || '', level3: it.level3_name || '', remark: it.info || it.remark || '',
  }));
  const value = { items, numFound: r.numFound, failed: r.failed, partial: r.partial, source: '掌上高考', codeType: '省编专业代码' };
  if (!r.failed) cacheSet(key, { at: Date.now(), value });
  return { ...value, cached: false };
}

/** 院校国标代码（优先用统一数据集里的省编/国标代码，其次用掌上高考的 code_enroll） */
export function schoolNationalCode(schoolId) {
  if (GC_ON()) {
    try {
      const gid = gcIdOf(schoolId);
      if (gid != null) {
        const codes = gc.schoolCodes(gid, 0);          // 全部省份
        const five = codes.find((c) => /^\d{5}$/.test(c.code));
        if (five) return five.code;
      }
    } catch { /* 回退 */ }
  }
  const s = getSchool(schoolId);
  if (!s || !s.codeEnroll) return '';
  return String(s.codeEnroll).slice(0, 5);
}

/** 某校在各省的代码（新数据集直接给出省编代码） */
export function schoolAllCodes(schoolId) {
  if (!GC_ON()) return [];
  try {
    const gid = gcIdOf(schoolId);
    if (gid == null) return [];
    return gc.schoolCodes(gid, 0).map((r) => ({ year: r.y, code: r.code }));
  } catch { return []; }
}

export function resourceStatus() {
  if (GC_ON()) {
    const cov = gc.coverage();
    const byYear = {};
    for (const [y, v] of Object.entries(cov)) {
      if (!v.scoreRange) continue;
      byYear[y] = [];
      for (const [pid, name] of PROVINCES_ARR) if (gc.rankYears(pid).some((r) => r.year === Number(y))) byYear[y].push(name);
    }
    const st = gc.stats();
    // tables = 「省份-年份-科类」表格张数（不是行数）
    let tableCount = 0;
    for (const [pid] of PROVINCES_ARR) tableCount += gc.rankYears(pid).length;
    return {
      source: 'GaokaoCompass（2017-2025）+ gaokao-vault（2026 增量）',
      tables: tableCount,
      rows: st.scoreRange,
      provinces: new Set(Object.values(byYear).flat()).size,
      byYear,
      imageOnly: (loadRankTables().imageOnly || []).length,
      sqlite: true, dbBytes: st.bytes, years: `${st.years.a}-${st.years.b}`,
      schoolCount: st.schools,
      schoolAdm: st.schoolAdm, majorAdm: st.majorAdm, planCode: st.planCode, schoolCode: st.schoolCode,
    };
  }
  const d = loadRankTables();
  const items = d.items || [];
  const byYear = {};
  for (const x of items) { byYear[x.year] = byYear[x.year] || new Set(); byYear[x.year].add(x.province); }
  return {
    source: d.source, updatedAt: d.updatedAt, normalizedAt: d.normalizedAt,
    tables: items.length,
    provinces: new Set(items.map((x) => x.province)).size,
    byYear: Object.fromEntries(Object.entries(byYear).map(([y, s]) => [y, [...s].sort()])),
    imageOnly: (d.imageOnly || []).length,
    sqlite: false,
  };
}

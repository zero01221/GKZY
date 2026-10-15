/**
 * 资料库：一分一段表（真实数据）+ 院校代码 / 专业代码
 *
 * 一分一段数据来自中国教育在线（gaokao.eol.cn / www.eol.cn）抓取的各省官方发布表格，
 * 已归一化为 [[分数, 累计人数, 本段人数], ...]（分数降序）。
 * 代码数据来自掌上高考招生计划接口与专业分数线接口（见 upstream.mjs）。
 */
import {
  DATA_DIR, PROVINCE_NAME, PROVINCE_ID, getSchool, readJsonCached, cacheGet, cacheSet,
} from './data.mjs';
import { fetchAll } from './upstream.mjs';
import path from 'node:path';

// ------------------------------------------------------------------
// 一分一段表
// ------------------------------------------------------------------
let rankStore = null;
const rankIndex = new Map();      // `${pid}_${year}_${type}` -> item

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
  const d = loadRankTables();
  const groups = new Map();      // `${pid}_${year}` -> types[]
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
  loadRankTables();
  let it = rankIndex.get(`${pid}_${year}_${type}`);
  if (!it) {
    // 科类名兼容：综合 / 物理类 / 历史类
    for (const t of ['综合', '物理类', '历史类']) {
      const c = rankIndex.get(`${pid}_${year}_${t}`);
      if (c) { it = c; break; }
    }
  }
  return it || null;
}

/** 该省该年有哪些年/科类可用 */
export function availableRank(pid) {
  loadRankTables();
  const out = [];
  for (const k of rankIndex.keys()) {
    const [p, y, t] = k.split('_');
    if (Number(p) === Number(pid)) out.push({ year: Number(y), type: t });
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
  const value = { items, numFound: r.numFound, failed: r.failed, partial: r.partial };
  if (!r.failed) cacheSet(key, { at: Date.now(), value });
  return { ...value, cached: false };
}

/** 院校国标代码（5 位，来自院校库 code_enroll 前 5 位） */
export function schoolNationalCode(schoolId) {
  const s = getSchool(schoolId);
  if (!s || !s.codeEnroll) return '';
  return String(s.codeEnroll).slice(0, 5);
}

export function resourceStatus() {
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
  };
}

/**
 * 数据层：院校库 / 分数线索引 / 一分一段估算 / 大学环境
 * 仅使用 Node 内置模块，无第三方依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// 注意：必须用 fileURLToPath，否则含中文的目录名会被百分号编码
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(APP_DIR, 'data');
export const INDEX_DIR = path.join(DATA_DIR, 'index');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const CHARTS_DIR = path.join(DATA_DIR, 'charts');

for (const d of [DATA_DIR, INDEX_DIR, CACHE_DIR]) fs.mkdirSync(d, { recursive: true });

export const PROVINCES = [
  [11, '北京'], [12, '天津'], [13, '河北'], [14, '山西'], [15, '内蒙古'],
  [21, '辽宁'], [22, '吉林'], [23, '黑龙江'], [31, '上海'], [32, '江苏'],
  [33, '浙江'], [34, '安徽'], [35, '福建'], [36, '江西'], [37, '山东'],
  [41, '河南'], [42, '湖北'], [43, '湖南'], [44, '广东'], [45, '广西'],
  [46, '海南'], [50, '重庆'], [51, '四川'], [52, '贵州'], [53, '云南'],
  [54, '西藏'], [61, '陕西'], [62, '甘肃'], [63, '青海'], [64, '宁夏'], [65, '新疆'],
];
export const PROVINCE_NAME = new Map(PROVINCES);
export const PROVINCE_ID = new Map(PROVINCES.map(([id, n]) => [n, id]));

function readJson(file, fallback = null) {
  const tryRead = (f) => {
    const buf = fs.readFileSync(f);
    const txt = f.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    return JSON.parse(txt.replace(/^\uFEFF/, ''));
  };
  try { return tryRead(file); } catch { /* 再试 gz 变体 */ }
  try { return tryRead(file + '.gz'); } catch { return fallback; }
}
function writeJson(file, obj, gzip = false) {
  const txt = JSON.stringify(obj);
  if (gzip) fs.writeFileSync(file + '.gz', zlib.gzipSync(Buffer.from(txt)));
  else fs.writeFileSync(file, txt);
}

/** 带内存缓存的只读 JSON（大文件避免重复解压） */
const jsonCache = new Map();
export function readJsonCached(file, fallback = null) {
  if (jsonCache.has(file)) return jsonCache.get(file);
  const v = readJson(file, fallback);
  jsonCache.set(file, v);
  return v;
}

// ------------------------------------------------------------------
// 院校库
// ------------------------------------------------------------------
let schoolList = [];         // 归一化后的数组
let schoolById = new Map();

export function loadSchools() {
  const raw = readJson(path.join(DATA_DIR, 'schools.json'), []);
  schoolList = raw.map((s) => ({
    id: Number(s.school_id),
    name: s.name || '',
    province: s.province_name || '',
    city: s.city_name || '',
    level: s.level_name || '',
    type: s.type_name || '',
    nature: s.nature_name || '',
    belong: s.belong || '',
    f985: String(s.f985) === '1',
    f211: String(s.f211) === '1',
    dual: s.dual_class_name || '',
    rank: s.rank || '',
    codeEnroll: s.code_enroll || '',
    logo: s.school_id ? `https://static-data.gaokao.cn/upload/logo/${s.school_id}.jpg` : '',
  })).filter((s) => s.id && s.name);
  indexSchools();
  return schoolList.length;
}

const normalize = (t) => String(t || '').toLowerCase().replace(/\s+/g, '').replace(/[（）()·・\-—]/g, '');
let schoolSearchIndex = [];
let schoolByKey = new Map();      // 归一化名称 -> 院校记录

function indexSchools() {
  schoolById = new Map(schoolList.map((s) => [s.id, s]));
  schoolSearchIndex = schoolList.map((s) => ({ s, key: normalize(s.name) }));
  schoolByKey = new Map(schoolSearchIndex.map((x) => [x.key, x.s]));
}

export const getSchool = (id) => schoolById.get(Number(id)) || null;
export const allSchools = () => schoolList;
export const schoolByName = (name) => schoolByKey.get(normalize(name)) || null;

/** 合并 GaokaoCompass 的院校主表：同名合并元数据，未收录的补进来（id 用 900000+gcid 避免冲突） */
export function mergeGcSchools(gcSchools) {
  const map = new Map();          // gcId -> appId
  let added = 0;
  for (const g of gcSchools) {
    const hit = schoolByKey.get(normalize(g.name));
    if (hit) { map.set(g.id, hit.id); continue; }
    const id = 900000 + Number(g.id);
    const rec = {
      id, name: g.name, province: g.province || '', city: '', level: '',
      type: '', nature: g.nature || '',
      f985: (g.lv & 3) === 3, f211: (g.lv & 2) === 2, dual: '',
      bgc: true, codeEnroll: '',
    };
    schoolList.push(rec);
    map.set(g.id, id);
    added++;
  }
  indexSchools();
  return { map, added };
}

export function searchSchools({ q = '', province = '', level = '', type = '', dual = '', page = 1, size = 30, ids = null }) {
  let pool;
  if (ids && ids.length) {
    pool = ids.map((i) => schoolById.get(Number(i))).filter(Boolean);
  } else if (q) {
    const key = normalize(q);
    const starts = [], contains = [];
    for (const { s, key: k } of schoolSearchIndex) {
      if (k.startsWith(key)) starts.push(s);
      else if (k.includes(key)) contains.push(s);
    }
    pool = [...starts, ...contains];
  } else {
    pool = schoolList;
  }
  if (province) pool = pool.filter((s) => s.province === province);
  if (level) pool = pool.filter((s) => s.level === level);
  if (type) pool = pool.filter((s) => s.type === type);
  if (dual === '985') pool = pool.filter((s) => s.f985);
  else if (dual === '211') pool = pool.filter((s) => s.f211);
  else if (dual === '双一流') pool = pool.filter((s) => s.dual);

  const total = pool.length;
  const start = (Math.max(1, Number(page)) - 1) * Number(size);
  return { total, page: Number(page), size: Number(size), items: pool.slice(start, start + Number(size)) };
}

// ------------------------------------------------------------------
// 分数线索引（按省-年）
//   data/index/province_<pid>_<year>.json
//   { pid, year, types:[], batches:[], groups:[], subj:[], rows:[[schoolId,typeIdx,batchIdx,groupIdx,min,minRank,batchLine,subjIdx,zslx?]] }
// ------------------------------------------------------------------
const indexCache = new Map();
const INDEX_TTL = 60_000;

export function indexFile(pid, year) { return path.join(INDEX_DIR, `province_${pid}_${year}.json`); }

export function loadProvinceIndex(pid, year, { fresh = false } = {}) {
  const key = `${pid}_${year}`;
  if (!fresh) {
    const c = indexCache.get(key);
    if (c && Date.now() - c.at < INDEX_TTL) return c.data;
  }
  const data = readJson(indexFile(pid, year), null);
  if (data) indexCache.set(key, { at: Date.now(), data });
  return data;
}

export function saveProvinceIndex(pid, year, data) {
  // 注意：索引必须写成未压缩的 .json，否则读取端（indexFile 无 .gz 后缀）会读不到
  writeJson(indexFile(pid, year), data, false);
  indexCache.set(`${pid}_${year}`, { at: Date.now(), data });
}

// ------------------------------------------------------------------
// 专业粒度索引（按省-年）
//   data/index/special_<pid>_<year>.json
//   { dict:{major,category,className,type,batch,group,subj,code},
//     rows:[[schoolId, majorIdx, typeIdx, batchIdx, groupIdx, subjIdx, min, minRank, batchLine, codeIdx, catIdx, classIdx]] }
// ------------------------------------------------------------------
const specialCache = new Map();

export function specialIndexFile(pid, year) { return path.join(INDEX_DIR, `special_${pid}_${year}.json`); }

export function loadSpecialIndex(pid, year) {
  const key = `${pid}_${year}`;
  const c = specialCache.get(key);
  if (c && Date.now() - c.at < INDEX_TTL) return c.data;
  const data = readJson(specialIndexFile(pid, year), null);
  if (data) specialCache.set(key, { at: Date.now(), data });
  return data;
}

export function saveSpecialIndex(pid, year, data) {
  writeJson(specialIndexFile(pid, year), data, false);
  specialCache.set(`${pid}_${year}`, { at: Date.now(), data });
}

export function hasSpecialIndex(pid, year) {
  return fs.existsSync(specialIndexFile(pid, year));
}

export function compactSpecialRecords(items) {
  const dict = { major: [], category: [], className: [], type: [], batch: [], group: [], subj: [], code: [] };
  const di = (k, v) => {
    const s = String(v ?? '').trim();
    if (!s) return -1;
    let i = dict[k].indexOf(s);
    if (i < 0) { dict[k].push(s); i = dict[k].length - 1; }
    return i;
  };
  const rows = [];
  for (const it of items) {
    const min = Number(it.min);
    if (!Number.isFinite(min) || min <= 0) continue;
    rows.push([
      Number(it.school_id),
      di('major', it.sp_name),
      di('type', it.local_type_name),
      di('batch', it.local_batch_name),
      di('group', it.sg_name),
      di('subj', it.sg_info),
      min,
      Number(it.min_section) || 0,
      Number(it.proscore) || 0,
      di('code', it.sp_scode),
      di('category', it.level2_name),
      di('className', it.level3_name),
    ]);
  }
  return { dict, rows };
}

/** 某省某年是否有专业粒度索引 */
export function specialYears(pid) {
  const out = [];
  for (const f of fs.readdirSync(INDEX_DIR)) {
    const m = /^special_(\d+)_(\d+)\.json$/.exec(f);
    if (m && Number(m[1]) === Number(pid)) out.push(Number(m[2]));
  }
  return out.sort((a, b) => b - a);
}

/** 把上游原始记录压缩为索引行 */
export function compactProvinceRecords(items) {
  const dict = { type: [], batch: [], group: [], subj: [], zslx: [] };
  const di = (k, v) => {
    const s = String(v ?? '').trim();
    if (!s) return -1;
    let i = dict[k].indexOf(s);
    if (i < 0) { dict[k].push(s); i = dict[k].length - 1; }
    return i;
  };
  const rows = [];
  for (const it of items) {
    const min = Number(it.min);
    if (!Number.isFinite(min) || min <= 0) continue;
    rows.push([
      Number(it.school_id),
      di('type', it.local_type_name),
      di('batch', it.local_batch_name),
      di('group', it.sg_name),
      min,
      Number(it.min_section) || 0,
      Number(it.proscore) || 0,
      di('subj', it.sg_info),
      di('zslx', it.zslx_name),
    ]);
  }
  return { dict, rows };
}

export function indexStats() {
  const out = [];
  for (const f of fs.readdirSync(INDEX_DIR)) {
    const m = /^province_(\d+)_(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const d = readJson(path.join(INDEX_DIR, f));
      out.push({ pid: Number(m[1]), province: PROVINCE_NAME.get(Number(m[1])) || m[1], year: Number(m[2]), rows: d?.rows?.length || 0, gz: fs.statSync(path.join(INDEX_DIR, f)).size });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => b.year - a.year || a.pid - b.pid);
}

// ------------------------------------------------------------------
// 一分一段估算（由索引中的 (最低分, 最低位次) 样本拟合）
// ------------------------------------------------------------------
const rankCurveCache = new Map();

export function getRankCurve(pid, year, typeName) {
  const key = `${pid}_${year}_${typeName}`;
  if (rankCurveCache.has(key)) return rankCurveCache.get(key);
  const idx = loadProvinceIndex(pid, year);
  let curve = null;
  if (idx) {
    const ti = idx.dict.type.indexOf(typeName);
    if (ti >= 0) {
      // 优先只用本科批样本（专科批/提前批的位次分布差异过大）
      const batches = idx.dict.batch || [];
      const hasBenke = batches.some((b) => b && b.includes('本科批') && !b.includes('提前'));
      const pts = [];
      for (const r of idx.rows) {
        if (r[1] !== ti) continue;
        if (hasBenke && !(batches[r[2]] || '').includes('本科批')) continue;
        const min = r[4], rank = r[5];
        if (min > 0 && rank > 0) pts.push([min, rank]);
      }
      if (pts.length >= 20) curve = buildCurve(pts);
    }
  }
  rankCurveCache.set(key, curve);
  return curve;
}

function buildCurve(pts) {
  // 按分数聚合：同一分数下多数院校的「最低位次」构成该分数段的位次区间，
  // 取其高分位（近似该分数段的累计人数，即一分一段的累计值）
  const byScore = new Map();
  for (const [s, r] of pts) {
    if (!byScore.has(s)) byScore.set(s, []);
    byScore.get(s).push(r);
  }
  const arr = [...byScore.entries()]
    .map(([s, rs]) => {
      rs.sort((a, b) => a - b);
      const q = rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.9))];
      return [s, q];
    })
    .sort((a, b) => a[0] - b[0]);
  // 单调化：分数越高，位次越小
  for (let i = 1; i < arr.length; i++) if (arr[i][1] > arr[i - 1][1]) arr[i][1] = arr[i - 1][1];
  // 去掉重复的垂直段（同一位次对应多个分数时只保留最高分）
  const out = [];
  for (const p of arr) {
    if (out.length && out[out.length - 1][1] === p[1]) out[out.length - 1] = p;
    else out.push(p);
  }
  return out.length >= 2 ? out : arr;
}

/** 分数 -> 位次（估算） */
export function scoreToRank(pid, year, typeName, score) {
  const curve = getRankCurve(pid, year, typeName);
  if (!curve || !curve.length) return null;
  const s = Number(score);
  const first = curve[0], last = curve[curve.length - 1];   // curve 按分数升序，位次降序
  if (s <= first[0]) {
    // 低于最低采样分：外推（每低 1 分位次约增加首段斜率）
    const slope = curve.length > 1 ? Math.max(1, (first[1] - curve[1][1]) / Math.max(1, curve[1][0] - first[0])) : 30;
    return Math.round(first[1] + (first[0] - s) * slope);
  }
  if (s >= last[0]) {
    const slope = curve.length > 1 ? Math.max(0.5, (curve[curve.length - 2][1] - last[1]) / Math.max(1, last[0] - curve[curve.length - 2][0])) : 8;
    return Math.max(1, Math.round(last[1] - (s - last[0]) * slope));
  }
  // 曲线按分数升序、位次降序；找第一个 >= s 的点
  for (let i = 1; i < curve.length; i++) {
    if (s <= curve[i][0]) {
      const [s0, r0] = curve[i - 1], [s1, r1] = curve[i];
      const t = (s - s0) / Math.max(1, s1 - s0);
      return Math.max(1, Math.round(r0 + (r1 - r0) * t));
    }
  }
  return null;
}

/** 位次 -> 分数（估算） */
export function rankToScore(pid, year, typeName, rank) {
  const curve = getRankCurve(pid, year, typeName);
  if (!curve || !curve.length) return null;
  const r = Number(rank);
  const first = curve[0], last = curve[curve.length - 1];
  if (r >= first[1]) return first[0];
  if (r <= last[1]) return last[0];
  // curve 位次降序；找第一个 <= r 的点
  for (let i = 1; i < curve.length; i++) {
    if (r >= curve[i][1]) {
      const [s0, r0] = curve[i - 1], [s1, r1] = curve[i];
      const t = (r0 - r) / Math.max(1, r0 - r1);
      return Math.round(s0 + (s1 - s0) * t);
    }
  }
  return null;
}

/** 该省该年的批次线（省控线）估计：取索引中出现频次最高的 proscore */
export function getBatchLines(pid, year) {
  const idx = loadProvinceIndex(pid, year);
  const out = {};
  if (!idx) return out;
  const counter = new Map();
  for (const r of idx.rows) {
    const t = idx.dict.type[r[1]] || '-';
    const b = idx.dict.batch[r[2]] || '-';
    const k = `${t}|${b}`;
    if (!counter.has(k)) counter.set(k, new Map());
    const m = counter.get(k);
    m.set(r[6], (m.get(r[6]) || 0) + 1);
  }
  for (const [k, m] of counter) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[0] > 0) out[k] = best[0];
  }
  return out;
}

/** 列出某省已建索引的年份 */
export function indexedYears(pid) {
  const out = [];
  for (const f of fs.readdirSync(INDEX_DIR)) {
    const m = /^province_(\d+)_(\d+)\.json$/.exec(f);
    if (m && Number(m[1]) === Number(pid)) out.push(Number(m[2]));
  }
  return out.sort((a, b) => b - a);
}

// ------------------------------------------------------------------
// 大学环境（colleges.chat）
// ------------------------------------------------------------------
let collegesData = null;
let collegeIndex = [];

export function loadColleges() {
  if (collegesData) return collegesData;
  collegesData = readJson(path.join(DATA_DIR, 'colleges.json'), { questions: [], v2questions: [], schools: [] });
  collegeIndex = (collegesData.schools || []).map((s) => ({ s, key: normalize(s.name) }));
  return collegesData;
}

export function searchColleges(q, limit = 30) {
  loadColleges();
  if (!q) return collegeIndex.slice(0, limit).map((x) => x.s);
  const key = normalize(q);
  const starts = [], contains = [];
  for (const { s, key: k } of collegeIndex) {
    if (k.startsWith(key)) starts.push(s); else if (k.includes(key)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, limit);
}

export function getCollege(name) {
  loadColleges();
  const key = normalize(name);
  let hit = collegeIndex.find((x) => x.key === key);
  if (hit) return hit.s;
  // 模糊：包含关系
  hit = collegeIndex.find((x) => x.key.includes(key) || key.includes(x.key));
  return hit ? hit.s : null;
}

// ------------------------------------------------------------------
// 通用磁盘缓存
// ------------------------------------------------------------------
export function cacheGet(key) {
  const f = path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
  try {
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > 1000 * 60 * 60 * 24 * 30) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}
export function cacheSet(key, value) {
  try { fs.writeFileSync(path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json'), JSON.stringify(value)); } catch { /* ignore */ }
}

/**
 * GaokaoCompass + gaokao-vault 统一数据源（SQLite）
 *
 * 数据来自两个开源项目，已统一为同一套表结构：
 *   - choucisan/GaokaoCompass（MIT）  2017-2025，31 省，1133 万行
 *   - lifefloating/gaokao-vault（MIT）2026 增量：一分一段 / 批次线 / 招生计划 / 专业库
 *
 * 表结构（全部字符串字典编码，表内只存 INTEGER）：
 *   dict(id, t, v)                  所有字符串字典
 *   school(id, name, name_id, province, nature, lv)   院校主表（lv: 985=3 / 211=2）
 *   score_range(p, y, c, b, ctrl, score, seg, cum)    一分一段表
 *   school_adm(p, y, c, b, sid, grp, subj, min, rnk, ctrl, admit)  院校投档线
 *   major_adm(p, y, c, b, sid, mid, grp, min, rnk, admit)          专业录取分
 *   plan_code(p, y, b, sid, mid, grp, mcode, cnt, fee, dur, subj)   招生计划（含专业代码）
 *   school_code(p, y, sid, code)                     省编院校代码
 *
 * 用 Node 内置 node:sqlite 读取，零第三方依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, PROVINCES } from './data.mjs';

// 允许用环境变量指向别处的数据库（构建/测试时用）
export const GC_DB = process.env.GAOKAO_DB ? path.resolve(process.env.GAOKAO_DB) : path.join(DATA_DIR, 'gaokao.db');
export const GC_DB_GZ = process.env.GAOKAO_DB_GZ ? path.resolve(process.env.GAOKAO_DB_GZ) : path.join(DATA_DIR, 'gaokao.db.gz');

let db = null;
const D = {
  province: { byId: new Map(), byName: new Map() },
  category: { byId: new Map(), byName: new Map() },
  batch: { byId: new Map(), byName: new Map() },
  subject: { byId: new Map(), byName: new Map() },
  groupname: { byId: new Map(), byName: new Map() },
  major: { byId: new Map(), byName: new Map() },
  majorcode: { byId: new Map(), byName: new Map() },
  duration: { byId: new Map(), byName: new Map() },
};
const schoolById = new Map();       // id -> {id,name,province,nature,lv}
const schoolByName = new Map();     // name -> id
const yearCache = new Map();        // `${p}|${y}` -> {categories:Set, batches:Set}

// ------------------------------------------------------------------
// 省份 id 映射
//   ETL 里省份用的是字典自增 id（1..31），而应用对外统一用标准省份码（11..65）。
//   两者会冲突（例如 31 既是标准码「上海」，也可能是某个字典 id），
//   所以一律走「标准码 -> 省名 -> 字典 id」的单向换算，不去猜传入的是哪种 id。
// ------------------------------------------------------------------
const STD2NAME = new Map(PROVINCES.map(([id, name]) => [Number(id), name]));
const NAME2STD = new Map(PROVINCES.map(([id, name]) => [name, Number(id)]));

/** 标准省份码（11..65）或省名 -> 库内省份 id */
export function toDictPid(pid) {
  if (pid == null) return pid;
  const name = STD2NAME.get(Number(pid)) || (D.province.byName.has(String(pid)) ? String(pid) : null);
  if (!name) return Number(pid);
  return D.province.byName.get(name) ?? Number(pid);
}
/** 库内省份 id -> 标准省份码 */
export function toStdPid(dictPid) {
  const name = D.province.byId.get(Number(dictPid));
  return name ? (NAME2STD.get(name) ?? Number(dictPid)) : Number(dictPid);
}

/** 首次使用时解压 .db.gz -> .db（只在磁盘上留一份，压缩包也保留以便分发） */
export function ensureDb() {
  if (fs.existsSync(GC_DB)) return true;
  if (!fs.existsSync(GC_DB_GZ)) return false;
  try {
    const buf = zlib.brotliDecompressSync(fs.readFileSync(GC_DB_GZ));
    fs.writeFileSync(GC_DB, buf);
    return true;
  } catch (e) {
    // 兼容 gzip 压缩的旧包
    try {
      fs.writeFileSync(GC_DB, zlib.gunzipSync(fs.readFileSync(GC_DB_GZ)));
      return true;
    } catch (e2) {
      console.error('解压 gaokao.db.gz 失败：', e.message);
      return false;
    }
  }
}

export function available() {
  ensureDb();
  return fs.existsSync(GC_DB);
}

export function open() {
  if (db) return db;
  if (!available()) throw new Error('未找到 gaokao.db（新数据源）。请先运行 tools/build_gc_db.mjs 生成，或放置 gaokao.db.gz');
  db = new DatabaseSync(GC_DB, { readOnly: true });
  // 只读连接下 GROUP BY / DISTINCT 默认会去写临时文件，某些环境（无写权限的 Temp、
  // 便携运行时目录）会直接报 “unable to open database file”。强制全部走内存。
  try {
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA cache_size = -65536');
    db.exec('PRAGMA query_only = ON');
  } catch { /* 老版本不支持则忽略 */ }
  loadDicts();
  return db;
}

function loadDicts() {
  for (const r of db.prepare('SELECT id, t, v FROM dict').all()) {
    const box = D[r.t];
    if (!box) continue;
    box.byId.set(r.id, r.v);
    if (!box.byName.has(r.v)) box.byName.set(r.v, r.id);
  }
  try {
    for (const r of db.prepare('SELECT id, name, province, nature, lv FROM school').all()) {
      schoolById.set(r.id, { id: r.id, name: r.name, province: r.province, nature: r.nature, lv: r.lv });
      if (!schoolByName.has(r.name)) schoolByName.set(r.name, r.id);
    }
  } catch { /* school 表可能为空 */ }
}

// ------------------------------------------------------------------
// 基础查表
// ------------------------------------------------------------------
export const pidOf = (name) => D.province.byName.get(String(name)) ?? null;
export const pnameOf = (id) => D.province.byId.get(Number(id)) ?? null;
export const cidOf = (name) => D.category.byName.get(String(name)) ?? null;
export const cnameOf = (id) => D.category.byId.get(Number(id)) ?? null;
export const bidOf = (name) => D.batch.byName.get(String(name)) ?? null;
export const bnameOf = (id) => D.batch.byId.get(Number(id)) ?? null;
export const gnameOf = (id) => D.groupname.byId.get(Number(id)) ?? '';
export const snameOf = (id) => D.subject.byId.get(Number(id)) ?? '';
export const mnameOf = (id) => D.major.byId.get(Number(id)) ?? '';
export const mcodeOf = (id) => D.majorcode.byId.get(Number(id)) ?? '';
export const getSchoolRow = (id) => schoolById.get(Number(id)) || null;
export const allSchools = () => [...schoolById.values()];

export const codeTo = {
  province: (name) => pidOf(name), category: (name) => cidOf(name),
  batch: (name) => bidOf(name), group: (name) => D.groupname.byName.get(String(name)) ?? 0,
  subject: (name) => D.subject.byName.get(String(name)) ?? 0,
  major: (name) => D.major.byName.get(String(name)) ?? 0,
};

/** 该省该年有哪些科类 / 批次 */
export function yearInfo(pid, year) {
  pid = toDictPid(pid);
  const k = `${pid}|${year}`;
  if (yearCache.has(k)) return yearCache.get(k);
  const cats = new Set(), batches = new Set();
  for (const r of db.prepare('SELECT DISTINCT c FROM school_adm WHERE p=? AND y=?').all(pid, year)) {
    const v = cnameOf(r.c); if (v) cats.add(v);
  }
  for (const r of db.prepare('SELECT DISTINCT b FROM school_adm WHERE p=? AND y=?').all(pid, year)) {
    const v = bnameOf(r.b); if (v) batches.add(v);
  }
  const out = { categories: [...cats], batches: [...batches] };
  yearCache.set(k, out);
  return out;
}

/** 数据覆盖概览 */
export function coverage() {
  open();
  const out = {};
  for (const r of db.prepare('SELECT y, COUNT(*) c, COUNT(DISTINCT p) np FROM score_range GROUP BY y').all()) {
    out[r.y] = out[r.y] || {};
    out[r.y].scoreRange = r.c; out[r.y].provinces = r.np;
  }
  for (const r of db.prepare('SELECT y, COUNT(*) c, COUNT(DISTINCT p) np FROM school_adm GROUP BY y').all()) {
    out[r.y] = out[r.y] || {};
    out[r.y].schoolAdm = r.c; out[r.y].provinces = Math.max(out[r.y].provinces || 0, r.np);
  }
  for (const r of db.prepare('SELECT y, COUNT(*) c FROM major_adm GROUP BY y').all()) {
    out[r.y] = out[r.y] || {};
    out[r.y].majorAdm = r.c;
  }
  for (const r of db.prepare('SELECT y, COUNT(*) c FROM plan_code GROUP BY y').all()) {
    out[r.y] = out[r.y] || {};
    out[r.y].planCode = r.c;
  }
  return out;
}

export function stats() {
  open();
  const one = (s) => db.prepare(s).get().c;
  return {
    bytes: fs.existsSync(GC_DB) ? fs.statSync(GC_DB).size : 0,
    schools: schoolById.size,
    scoreRange: one('SELECT COUNT(*) c FROM score_range'),
    schoolAdm: one('SELECT COUNT(*) c FROM school_adm'),
    majorAdm: one('SELECT COUNT(*) c FROM major_adm'),
    planCode: one('SELECT COUNT(*) c FROM plan_code'),
    schoolCode: one('SELECT COUNT(*) c FROM school_code'),
    years: db.prepare('SELECT MIN(y) a, MAX(y) b FROM school_adm').get(),
  };
}

// ------------------------------------------------------------------
// 一分一段
// ------------------------------------------------------------------
/** 该省可用的 (年, 科类) */
export function rankYears(pid) {
  pid = toDictPid(pid);
  open();
  const rows = db.prepare(`SELECT DISTINCT y, c FROM score_range WHERE p=? ORDER BY y DESC`).all(pid);
  const out = [];
  for (const r of rows) {
    const t = cnameOf(r.c);
    if (t) out.push({ year: r.y, type: t });
  }
  return out;
}

/** 取一分一段表（分数降序） */
export function rankTable(pid, year, type) {
  pid = toDictPid(pid);
  open();
  const c = cidOf(type);
  const rows = c
    ? db.prepare('SELECT score, seg, cum, ctrl FROM score_range WHERE p=? AND y=? AND c=? ORDER BY score DESC').all(pid, year, c)
    : db.prepare('SELECT score, seg, cum, ctrl FROM score_range WHERE p=? AND y=? ORDER BY score DESC').all(pid, year);
  if (!rows.length) return null;
  const flat = rows.map((r) => [r.score, r.cum, r.seg]);
  const gaps = [];
  for (let i = 1; i < flat.length; i++) {
    const hi = flat[i - 1][0], lo = flat[i][0];
    if (hi - lo > 1) gaps.push([hi - 1, lo + 1]);
  }
  return {
    province: pnameOf(pid), year, type,
    control: rows[0].ctrl || 0,
    series: flat,
    range: [flat[flat.length - 1][0], flat[0][0]],
    total: flat[flat.length - 1][1],
    gaps, full: gaps.length === 0,
  };
}

/** 分数 -> 位次（真实一分一段表） */
export function scoreToRank(pid, type, score, preferYear) {
  pid = toDictPid(pid);
  open();
  const ys = rankYears(pid).filter((x) => !type || x.type === type || x.type === '综合' || type === '综合');
  if (!ys.length) return null;
  const pick = (preferYear && ys.find((x) => x.year === preferYear)) || ys[0];
  const t = rankTable(pid, pick.year, pick.type);
  if (!t) return null;
  const s = Number(score), ser = t.series;
  const top = ser[0], bot = ser[ser.length - 1];
  let rank = null, exact = true;
  if (s >= top[0]) { rank = top[1]; exact = false; }
  else if (s <= bot[0]) { rank = bot[1]; exact = false; }
  else {
    for (let i = 1; i < ser.length; i++) {
      if (s >= ser[i][0]) { rank = ser[i][1]; break; }
    }
  }
  if (!rank) return null;
  return { rank, year: t.year, type: t.type, exact, total: t.total, range: t.range, gaps: t.gaps, full: t.full, control: t.control };
}

/** 位次 -> 分数 */
export function rankToScore(pid, type, rank, preferYear) {
  pid = toDictPid(pid);
  open();
  const ys = rankYears(pid).filter((x) => !type || x.type === type || x.type === '综合' || type === '综合');
  if (!ys.length) return null;
  const pick = (preferYear && ys.find((x) => x.year === preferYear)) || ys[0];
  const t = rankTable(pid, pick.year, pick.type);
  if (!t) return null;
  const r = Number(rank), ser = t.series;
  if (r <= ser[0][1]) return { score: ser[0][0], year: t.year, type: t.type };
  const last = ser[ser.length - 1];
  if (r >= last[1]) return { score: last[0], year: t.year, type: t.type };
  for (let i = 1; i < ser.length; i++) {
    if (r <= ser[i][1]) {
      const hi = ser[i - 1], lo = ser[i];
      const k = (r - lo[1]) / Math.max(1, hi[1] - lo[1]);
      return { score: Math.round(lo[0] + (hi[0] - lo[0]) * k), year: t.year, type: t.type };
    }
  }
  return null;
}

/** 批次线（省控线） */
export function batchLines(pid, year) {
  pid = toDictPid(pid);
  open();
  const out = {};
  for (const r of db.prepare('SELECT DISTINCT c, b, ctrl FROM score_range WHERE p=? AND y=? AND ctrl>0').all(pid, year)) {
    const c = cnameOf(r.c), b = bnameOf(r.b);
    if (c && b) out[`${c}|${b}`] = r.ctrl;
  }
  for (const r of db.prepare('SELECT DISTINCT c, b, ctrl FROM school_adm WHERE p=? AND y=? AND ctrl>0').all(pid, year)) {
    const c = cnameOf(r.c), b = bnameOf(r.b);
    if (c && b && !out[`${c}|${b}`]) out[`${c}|${b}`] = r.ctrl;
  }
  return out;
}

// ------------------------------------------------------------------
// 投档线 / 专业录取分（供推荐与方案使用）
// ------------------------------------------------------------------
/** 某校在某省某年的投档线（全部批次/组） */
export function schoolAdmission(sid, pid, years) {
  pid = toDictPid(pid);
  open();
  const out = [];
  const ys = Array.isArray(years) ? years : [years];
  for (const y of ys) {
    for (const r of db.prepare('SELECT * FROM school_adm WHERE sid=? AND p=? AND y=?').all(sid, pid, y)) {
      out.push({
        year: r.y, type: cnameOf(r.c), batch: bnameOf(r.b), group: gnameOf(r.grp),
        subjectReq: snameOf(r.subj), min: r.min, minRank: r.rnk, batchLine: r.ctrl, admit: r.admit,
      });
    }
  }
  return out;
}

/** 某校在某省某年的专业录取分 */
export function schoolMajorAdmission(sid, pid, years) {
  pid = toDictPid(pid);
  open();
  const out = [];
  const ys = Array.isArray(years) ? years : [years];
  for (const y of ys) {
    for (const r of db.prepare('SELECT * FROM major_adm WHERE sid=? AND p=? AND y=?').all(sid, pid, y)) {
      out.push({
        year: r.y, type: cnameOf(r.c), batch: bnameOf(r.b), group: gnameOf(r.grp),
        major: mnameOf(r.mid), min: r.min, minRank: r.rnk, admit: r.admit,
      });
    }
  }
  return out;
}

/** 某省某年全部投档线（推荐引擎用，按需分页/流式读取） */
export function provinceAdmission(pid, year, { onlyBatch = '', limit = 0 } = {}) {
  pid = toDictPid(pid);
  open();
  const rows = onlyBatch
    ? db.prepare('SELECT * FROM school_adm WHERE p=? AND y=? AND b=?').all(pid, year, bidOf(onlyBatch) || -1)
    : db.prepare('SELECT * FROM school_adm WHERE p=? AND y=?').all(pid, year);
  const out = limit ? rows.slice(0, limit) : rows;
  return out.map((r) => ({
    schoolId: r.sid, year: r.y, type: cnameOf(r.c), batchId: r.b, batch: bnameOf(r.b),
    groupId: r.grp, group: gnameOf(r.grp), subjectReq: snameOf(r.subj),
    min: r.min, minRank: r.rnk, batchLine: r.ctrl, admit: r.admit,
  }));
}

/** 某省某年全部专业录取分 */
export function provinceMajor(pid, year) {
  pid = toDictPid(pid);
  open();
  return db.prepare('SELECT * FROM major_adm WHERE p=? AND y=?').all(pid, year).map((r) => ({
    schoolId: r.sid, year: r.y, type: cnameOf(r.c), batchId: r.b, batch: bnameOf(r.b),
    groupId: r.grp, group: gnameOf(r.grp), majorId: r.mid, major: mnameOf(r.mid),
    min: r.min, minRank: r.rnk, admit: r.admit,
  }));
}

// ------------------------------------------------------------------
// 代码
// ------------------------------------------------------------------
/** 院校国标代码（从院校库或省编代码推断） */
export function nationalCode(sid) {
  open();
  const s = getSchoolRow(sid);
  if (!s) return '';
  // school.name_id 与学校同名；国标代码在 GaokaoCompass 的 university_code 里
  const r = db.prepare("SELECT code FROM school_code WHERE sid=? AND length(code)=5 ORDER BY y DESC LIMIT 1").get(sid);
  return r ? r.code : '';
}

/**
 * 招生计划 + 代码
 *   plan_code.mcode = 教育部专业（类）代码
 * 兼容两种库结构：
 *   完整库 plan_code(p,y,b,sid,mid,grp,mcode,cnt,fee,dur,subj)
 *   瘦身库 plan_code(p,y,sid,mid,grp,mcode) + plan_info(sid,mid,cnt,fee,dur,subj)
 */
let pcCols = null;
function planCols() {
  if (pcCols) return pcCols;
  pcCols = new Set(db.prepare('PRAGMA table_info(plan_code)').all().map((r) => r.name));
  return pcCols;
}

export function planCodes(sid, pid, year) {
  pid = toDictPid(pid);
  open();
  const wide = planCols().has('cnt');
  const sql = wide
    ? 'SELECT * FROM plan_code WHERE sid=? AND p=? AND y=?'
    : `SELECT pc.*, pi.cnt AS i_cnt, pi.fee AS i_fee, pi.dur AS i_dur, pi.subj AS i_subj
       FROM plan_code pc LEFT JOIN plan_info pi ON pi.sid = pc.sid AND pi.mid = pc.mid
       WHERE pc.sid=? AND pc.p=? AND pc.y=?`;
  const rows = db.prepare(sql).all(sid, pid, year);
  // 瘦身库没有批次列，用同校同年同专业组的投档线记录回填批次
  let batchOf = null;
  if (!wide) {
    batchOf = new Map();
    for (const r of db.prepare('SELECT grp, b FROM school_adm WHERE sid=? AND p=? AND y=?').all(sid, pid, year)) {
      if (!batchOf.has(r.grp)) batchOf.set(r.grp, r.b);
    }
  }
  return rows.map((r) => ({
    group: gnameOf(r.grp),
    major: mnameOf(r.mid),
    majorCode: mcodeOf(r.mcode),
    subjectReq: snameOf(wide ? r.subj : r.i_subj),
    batch: bnameOf(wide ? r.b : (batchOf.get(r.grp) ?? 0)),
    planNum: wide ? r.cnt : r.i_cnt,
    tuition: wide ? r.fee : r.i_fee,
    length: D.duration.byId.get(wide ? r.dur : r.i_dur) || '',
  }));
}

/** 省编院校代码；pid 传 0 / 空表示不限省份 */
export function schoolCodes(sid, pid) {
  open();
  const p = Number(pid) || 0;
  if (!p) return db.prepare('SELECT y, code, p FROM school_code WHERE sid=? ORDER BY y DESC').all(sid);
  return db.prepare('SELECT y, code, p FROM school_code WHERE sid=? AND p=? ORDER BY y DESC').all(sid, toDictPid(p));
}

/** 专业库（含教育部专业代码） */
export function searchMajor(keyword, limit = 200) {
  open();
  const out = [];
  for (const [id, name] of D.major.byId) {
    if (!keyword || name.includes(keyword)) out.push({ id, name });
    if (out.length >= limit) break;
  }
  return out;
}

/** 院校检索（走内存索引） */
export function searchSchool(q, limit = 30) {
  open();
  const key = String(q || '').trim();
  if (!key) return allSchools().slice(0, limit);
  const starts = [], contains = [];
  for (const s of schoolById.values()) {
    if (s.name.startsWith(key)) starts.push(s);
    else if (s.name.includes(key)) contains.push(s);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

export function raw() { return db; }

/**
 * 数据源适配层：把 SQLite（GaokaoCompass + gaokao-vault 统一数据）适配成
 * 现有推荐引擎需要的「索引」结构，从而无需改动 plan.mjs / recommend.mjs 的核心逻辑。
 *
 * 返回结构与原 JSON 索引完全一致：
 *   { pid, province, year, dict:{type[],batch[],group[],subj[],zslx[]},
 *     rows:[[schoolId,typeIdx,batchIdx,groupIdx,min,minRank,batchLine,subjIdx,zslxIdx]] }
 *
 * 若 SQLite 不存在，则回退到旧的 JSON 索引文件（data/index/*.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  INDEX_DIR, PROVINCE_NAME, PROVINCE_ID, readJsonCached as readJson, mergeGcSchools,
} from './data.mjs';
import * as gc from './gcdb.mjs';

const HAVE_GC = () => gc.available();

/** GaokaoCompass 院校 id -> 应用内院校 id（同名合并；未收录的补入院校库） */
let gcToApp = null;
function schoolMap() {
  if (gcToApp) return gcToApp;
  gc.open();
  const list = gc.allSchools();
  const { map, added } = mergeGcSchools(list);
  gcToApp = map;
  if (added) console.log(`  院校库合并：新增 ${added} 所（来自 GaokaoCompass），共 ${map.size} 所`);
  return gcToApp;
}
export const appSchoolId = (gcId) => {
  const m = schoolMap();
  return m.get(Number(gcId)) ?? Number(gcId);
};

const appToGc = new Map();
/** 应用内院校 id -> GaokaoCompass 院校 id */
export function gcIdOf(appId) {
  schoolMap();
  if (!appToGc.size) for (const [g, a] of gcToApp) appToGc.set(a, g);
  const id = Number(appId);
  if (appToGc.has(id)) return appToGc.get(id);
  if (id >= 900000) return id - 900000;      // mergeGcSchools 合成的 id
  return null;
}

// ------------------------------------------------------------------
// 内存缓存（按需构建，LRU 上限，避免重复查库）
// ------------------------------------------------------------------
const CACHE_MAX = 24;
const cache = new Map();
function cached(key, make) {
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
  const v = make();
  cache.set(key, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return v;
}

let denseDict = null;
/** 把字典表的 id -> 值 展开成稠密数组，直接当原有 dict.xxx[索引] 用 */
function dicts() {
  if (denseDict) return denseDict;
  gc.open();
  const db = gc.raw();
  const out = {};
  for (const t of ['province', 'category', 'batch', 'subject', 'groupname', 'major', 'majorcode', 'duration']) {
    const max = db.prepare('SELECT MAX(id) m FROM dict WHERE t=?').get(t).m || 0;
    const arr = new Array(max + 1).fill('');
    for (const r of db.prepare('SELECT id, v FROM dict WHERE t=?').all(t)) arr[r.id] = r.v;
    out[t] = arr;
  }
  // 与旧索引的字段名对齐（category/className 本数据集不含，用空数组占位，下标越界返回 undefined）
  denseDict = {
    type: out.category, batch: out.batch, group: out.groupname, subj: out.subject,
    zslx: [], code: out.majorcode, majorcode: out.majorcode,
    category: [], className: [],
    province: out.province, major: out.major, duration: out.duration,
  };
  return denseDict;
}

// ------------------------------------------------------------------
// 院校投档线索引
// ------------------------------------------------------------------
/** 该省有哪些年份有投档线数据 */
export function indexedYears(pid) {
  if (!HAVE_GC()) return legacyIndexedYears(pid);
  return cached(`y_${pid}`, () => {
    gc.open();
    return gc.raw().prepare('SELECT DISTINCT y FROM school_adm WHERE p=? ORDER BY y DESC').all(gc.toDictPid(pid)).map((r) => r.y);
  });
}

export function provinceIndex(pid, year, { fresh = false } = {}) {
  if (!HAVE_GC()) return readJson(path.join(INDEX_DIR, `province_${pid}_${year}.json`), null);
  if (fresh) cache.delete(`pi_${pid}_${year}`);
  return cached(`pi_${pid}_${year}`, () => {
    gc.open();
    const rows = gc.raw()
      .prepare('SELECT sid,c,b,grp,min,rnk,ctrl,subj FROM school_adm WHERE p=? AND y=?')
      .all(gc.toDictPid(pid), Number(year));
    if (!rows.length) return null;
    const d = dicts();
    // 源数据里 school_adm 的省控线（control_score）大量为空，
    // 用一分一段/投档线汇总出的批次线按「科类|批次」回填，否则线差法无法使用
    const bl = gc.batchLines(Number(pid), Number(year));
    const lineOf = (c, b) => bl[`${d.type[c]}|${d.batch[b]}`] || 0;
    let filled = 0;
    const out = rows.map((r) => {
      let ctrl = r.ctrl;
      if (!ctrl) { ctrl = lineOf(r.c, r.b) || null; if (ctrl) filled++; }
      return [appSchoolId(r.sid), r.c, r.b, r.grp, r.min, r.rnk, ctrl, r.subj, -1];
    });
    return {
      pid: Number(pid), province: gc.pnameOf(gc.toDictPid(pid)), year: Number(year), source: 'sqlite',
      dict: d,
      rows: out,
      ctrlFilled: filled,
    };
  });
}

/** 该省该年有哪些科类（供前端下拉） */
export function provinceTypes(pid, year) {
  if (!HAVE_GC()) {
    const ix = readJson(path.join(INDEX_DIR, `province_${pid}_${year}.json`), null);
    return (ix?.dict?.type || []).filter(Boolean);
  }
  gc.open();
  const d = dicts();
  const set = new Set();
  for (const r of gc.raw().prepare('SELECT DISTINCT c FROM school_adm WHERE p=? AND y=?').all(gc.toDictPid(pid), Number(year))) {
    const v = d.type[r.c]; if (v) set.add(v);
  }
  return [...set];
}

// ------------------------------------------------------------------
// 专业粒度索引
// ------------------------------------------------------------------
export function specialYears(pid) {
  if (!HAVE_GC()) return legacySpecialYears(pid);
  return cached(`sy_${pid}`, () => {
    gc.open();
    return gc.raw().prepare('SELECT DISTINCT y FROM major_adm WHERE p=? ORDER BY y DESC').all(gc.toDictPid(pid)).map((r) => r.y);
  });
}

export function specialIndex(pid, year) {
  if (!HAVE_GC()) return readJson(path.join(INDEX_DIR, `special_${pid}_${year}.json`), null);
  return cached(`si_${pid}_${year}`, () => {
    gc.open();
    const rows = gc.raw()
      .prepare('SELECT sid, mid, c, b, grp, min, rnk FROM major_adm WHERE p=? AND y=?')
      .all(gc.toDictPid(pid), Number(year));
    if (!rows.length) return null;
    const d = dicts();
    // 专业表本身没有省控线，用批次线表按「科类|批次」回填，便于线差法使用
    const bl = gc.batchLines(Number(pid), Number(year));
    const lineOf = (c, b) => bl[`${d.type[c]}|${d.batch[b]}`] || 0;
    return {
      pid: Number(pid), province: gc.pnameOf(gc.toDictPid(pid)), year: Number(year), source: 'sqlite',
      dict: d,
      // 与原 special 索引行布局对齐：[schoolId, majorIdx, typeIdx, batchIdx, groupIdx, subjIdx, min, minRank, batchLine, codeIdx, catIdx, classIdx]
      rows: rows.map((r) => [appSchoolId(r.sid), r.mid, r.c, r.b, r.grp, 0, r.min, r.rnk, lineOf(r.c, r.b), -1, -1, -1]),
    };
  });
}

// ------------------------------------------------------------------
// 批次线
// ------------------------------------------------------------------
export function batchLines(pid, year) {
  if (!HAVE_GC()) {
    const ix = readJson(path.join(INDEX_DIR, `province_${pid}_${year}.json`), null);
    const out = {};
    if (ix) {
      const counter = new Map();
      for (const r of ix.rows) {
        const t = ix.dict.type[r[1]] || '-', b = ix.dict.batch[r[2]] || '-';
        const k = `${t}|${b}`;
        if (!counter.has(k)) counter.set(k, new Map());
        const m = counter.get(k); m.set(r[6], (m.get(r[6]) || 0) + 1);
      }
      for (const [k, m] of counter) { const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; if (best && best[0] > 0) out[k] = best[0]; }
    }
    return out;
  }
  return cached(`bl_${pid}_${year}`, () => gc.batchLines(Number(pid), Number(year)));
}

// ------------------------------------------------------------------
// 一分一段（优先真实表；无则回退到旧资源文件）
// ------------------------------------------------------------------
export function hasRankTable(pid) {
  if (!HAVE_GC()) return false;
  return gc.rankYears(Number(pid)).length > 0;
}

// ------------------------------------------------------------------
// 旧的 JSON 索引回退
// ------------------------------------------------------------------
function legacyIndexedYears(pid) {
  const out = [];
  try {
    for (const f of fs.readdirSync(INDEX_DIR)) {
      const m = /^province_(\d+)_(\d+)\.json$/.exec(f);
      if (m && Number(m[1]) === Number(pid)) out.push(Number(m[2]));
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b - a);
}
function legacySpecialYears(pid) {
  const out = [];
  try {
    for (const f of fs.readdirSync(INDEX_DIR)) {
      const m = /^special_(\d+)_(\d+)\.json$/.exec(f);
      if (m && Number(m[1]) === Number(pid)) out.push(Number(m[2]));
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b - a);
}

export function source() { return HAVE_GC() ? 'sqlite' : 'legacy-json'; }
export function info() {
  if (!HAVE_GC()) return { source: 'legacy-json' };
  return { source: 'sqlite', ...gc.stats() };
}
/** 启动时调用：预热字典与院校映射 */
export function init() {
  if (!HAVE_GC()) return { source: 'legacy-json' };
  const m = schoolMap();
  return { source: 'sqlite', schools: m.size };
}

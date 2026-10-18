/**
 * 把旧版 JSON 索引（掌上高考抓取）并入统一 SQLite。
 *
 * 用途：GaokaoCompass 只到 2025，某些省份的 2026 数据来自掌上高考实时抓取，
 * 落在 data/index/{province,special}_<省>_<年>.json，需要并入新数据源。
 *
 * 用法：
 *   node tools/import_legacy_index.mjs --province 13 --year 2026
 *   node tools/import_legacy_index.mjs --province 13 --year 2026 --rank   # 同时并入一分一段
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const has = (n) => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

const PID = Number(argOf('province', 0));
const YEAR = Number(argOf('year', 0));
const DB = path.resolve(ROOT, argOf('db', '高考志愿助手/data/gaokao.db'));
const APP = path.join(ROOT, '高考志愿助手');
const WITH_RANK = has('rank');

if (!PID || !YEAR) { console.error('需要 --province 与 --year'); process.exit(1); }
if (!fs.existsSync(DB)) { console.error('目标库不存在：' + DB); process.exit(1); }

const PROVINCES = { 11: '北京', 12: '天津', 13: '河北', 14: '山西', 15: '内蒙古', 21: '辽宁', 22: '吉林', 23: '黑龙江', 31: '上海', 32: '江苏', 33: '浙江', 34: '安徽', 35: '福建', 36: '江西', 37: '山东', 41: '河南', 42: '湖北', 43: '湖南', 44: '广东', 45: '广西', 46: '海南', 50: '重庆', 51: '四川', 52: '贵州', 53: '云南', 54: '西藏', 61: '陕西', 62: '甘肃', 63: '青海', 64: '宁夏', 65: '新疆' };
const provName = PROVINCES[PID];
if (!provName) { console.error('未知省份 ID ' + PID); process.exit(1); }

console.log(`并入 ${provName}(${PID}) ${YEAR} 年数据 -> ${DB}\n`);

const db = new DatabaseSync(DB);

// ---------- 字典 ----------
const dictBox = new Map();
function box(t) {
  if (!dictBox.has(t)) {
    const byName = new Map();
    let max = 0;
    for (const r of db.prepare('SELECT id, v FROM dict WHERE t=?').all(t)) { byName.set(r.v, r.id); if (r.id > max) max = r.id; }
    dictBox.set(t, { byName, max });
  }
  return dictBox.get(t);
}
const insDict = db.prepare('INSERT INTO dict (id, t, v) VALUES (?,?,?)');
function did(t, v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const b = box(t);
  if (b.byName.has(s)) return b.byName.get(s);
  const id = ++b.max;
  b.byName.set(s, id);
  insDict.run(id, t, s);
  return id;
}
const pidDict = did('province', provName);

// ---------- 院校：掌上高考 id -> 名称 -> 新库 id ----------
const schools = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(APP, 'data/schools.json.gz'))).toString('utf8'));
const nameByOldId = new Map();
for (const s of schools) if (s.school_id) nameByOldId.set(Number(s.school_id), s.name);
const gcSchoolByName = new Map();
for (const r of db.prepare('SELECT id, name FROM school').all()) if (!gcSchoolByName.has(r.name)) gcSchoolByName.set(r.name, r.id);
const insSchool = db.prepare('INSERT OR IGNORE INTO school (id, name, province, nature, lv) VALUES (?,?,?,?,?)');
let maxSid = db.prepare('SELECT MAX(id) m FROM school').get().m || 0;
const gcSidCache = new Map();
function gcSid(oldId) {
  if (gcSidCache.has(oldId)) return gcSidCache.get(oldId);
  const name = nameByOldId.get(Number(oldId));
  let id = name ? gcSchoolByName.get(name) : null;
  if (!id && name) {
    id = ++maxSid;
    insSchool.run(id, name, '', '', 0);
    gcSchoolByName.set(name, id);
  }
  gcSidCache.set(oldId, id || 0);
  return id || 0;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

let totalAdm = 0, totalMajor = 0, totalRank = 0;
db.exec('BEGIN');

// ---------- 1. 院校投档线 ----------
const admFile = path.join(APP, `data/index/province_${PID}_${YEAR}.json`);
const adm = readJson(admFile);
if (adm) {
  const del = db.prepare('DELETE FROM school_adm WHERE p=? AND y=?');
  del.run(pidDict, YEAR);
  const ins = db.prepare('INSERT INTO school_adm (p,y,c,b,sid,grp,subj,min,rnk,ctrl,admit) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of adm.rows) {
    const sid = gcSid(r[0]);
    if (!sid) continue;
    const min = Number(r[4]);
    if (!Number.isFinite(min) || min < 100) continue;
    ins.run(pidDict, YEAR,
      did('category', (adm.dict.type || [])[r[1]] || '综合'),
      did('batch', (adm.dict.batch || [])[r[2]] || ''),
      sid,
      did('groupname', (adm.dict.group || [])[r[3]] || ''),
      did('subject', (adm.dict.subj || [])[r[7]] || ''),
      Math.round(min), Number(r[5]) || null, Number(r[6]) || null, 0);
    totalAdm++;
  }
  console.log(`  投档线     ${totalAdm} 行  (来源 ${path.basename(admFile)})`);
} else console.log('  投档线     跳过（无文件）');

// ---------- 2. 专业录取分 ----------
const spFile = path.join(APP, `data/index/special_${PID}_${YEAR}.json`);
const sp = readJson(spFile);
if (sp) {
  db.prepare('DELETE FROM major_adm WHERE p=? AND y=?').run(pidDict, YEAR);
  const ins = db.prepare('INSERT INTO major_adm (p,y,c,b,sid,mid,grp,min,rnk) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const r of sp.rows) {
    const sid = gcSid(r[0]);
    if (!sid) continue;
    const mname = (sp.dict.major || [])[r[1]];
    if (!mname) continue;
    const min = Number(r[6]);
    if (!Number.isFinite(min) || min < 100) continue;
    ins.run(pidDict, YEAR,
      did('category', (sp.dict.type || [])[r[2]] || '综合'),
      did('batch', (sp.dict.batch || [])[r[3]] || ''),
      sid, did('major', mname),
      did('groupname', (sp.dict.group || [])[r[4]] || ''),
      Math.round(min), Number(r[7]) || null);
    totalMajor++;
  }
  console.log(`  专业录取   ${totalMajor} 行  (来源 ${path.basename(spFile)})`);
} else console.log('  专业录取   跳过（无文件）');

// ---------- 3. 一分一段 ----------
if (WITH_RANK) {
  const rtPath = path.join(APP, 'data/rank_table.json.gz');
  const rt = JSON.parse(zlib.gunzipSync(fs.readFileSync(rtPath)).toString('utf8'));
  const items = (rt.items || []).filter((x) => x.province === provName && x.year === YEAR);
  if (items.length) {
    db.prepare('DELETE FROM score_range WHERE p=? AND y=?').run(pidDict, YEAR);
    const ins = db.prepare('INSERT INTO score_range (p,y,c,b,ctrl,score,seg,cum) VALUES (?,?,?,?,?,?,?,?)');
    for (const it of items) {
      const cid = did('category', it.type || '综合');
      for (const [score, cum, seg] of it.series) {
        ins.run(pidDict, YEAR, cid, 0, it.control || 0, score, seg, cum);
        totalRank++;
      }
    }
    console.log(`  一分一段   ${totalRank} 行 / ${items.length} 张  (${items.map((x) => x.type).join(',')})`);
  } else console.log('  一分一段   跳过（rank_table 里没有该省该年）');
}

db.exec('COMMIT');
try { db.exec('ANALYZE'); } catch { /* ignore */ }

console.log('\n== 校验 ==');
for (const t of ['score_range', 'school_adm', 'major_adm']) {
  const rows = db.prepare(`SELECT y, COUNT(*) c FROM ${t} WHERE p=? GROUP BY y ORDER BY y`).all(pidDict);
  console.log(`  ${t.padEnd(13)} ${rows.map((r) => r.y + '=' + r.c).join(' ')}`);
}
db.close();
console.log('\n完成。重新打包：node tools/pack_gcdb.mjs --src 高考志愿助手/data/gaokao.db --out 高考志愿助手/data/gaokao.db.gz --level 9');

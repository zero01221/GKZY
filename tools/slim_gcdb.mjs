/**
 * 把 build_gc_db.mjs 产出的「全字段」数据库瘦身为随包发布的轻量库。
 *
 * 瘦身手段（实测可省 ~75% 体积）：
 *   1. 专业名规范化：源数据 major_name 常带整段括号说明（最多 639 字符，
 *      部分行甚至粘连了整行文本），按「首个括号前」归一后 65 万条唯一值降到几千条
 *   2. 招生计划只保留「代码映射」列，学费/学制/选科去重成 plan_info 一张小表
 *   3. 去掉几乎全空的列（major_adm.admit 78% 为空）
 *   4. 只建真正被查询用到的索引（原库索引占了 302 MB / 45%）
 *   5. 加大 page_size + VACUUM，最后交给 pack_gcdb.mjs 做 Brotli
 *
 * 用法：node tools/slim_gcdb.mjs [--src data/gc/gaokao.db] [--out data/gc/gaokao.slim.db]
 *                              [--min-year 2017] [--drop-vocational]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const has = (n) => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

const SRC = path.resolve(ROOT, argOf('src', 'data/gc/gaokao.db'));
const OUT = path.resolve(ROOT, argOf('out', 'data/gc/gaokao.slim.db'));
const MIN_YEAR = Number(argOf('min-year', 0)) || 0;
const DROP_VOC = has('drop-vocational');

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
if (!fs.existsSync(SRC)) { console.error('找不到源库 ' + SRC); process.exit(1); }
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

/** 专业名规范化：截到第一个括号之前，并压缩空白 */
export function normMajor(s) {
  let t = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();
  const i = t.search(/[（(]/);
  if (i > 0) t = t.slice(0, i);
  t = t.replace(/[\s　]+/g, '').replace(/[、,，;；]+$/, '');
  return t.slice(0, 40);
}
export function normGroup(s) {
  const t = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();
  return t.slice(0, 24);
}

console.log(`源库 ${SRC}  ${mb(fs.statSync(SRC).size)}`);
console.log(`目标 ${OUT}`);
console.log(`条件：minYear=${MIN_YEAR || '不限'}  剔除专科=${DROP_VOC}\n`);

const src = new DatabaseSync(SRC, { readOnly: true });
const dst = new DatabaseSync(OUT);
dst.exec(`
PRAGMA page_size = 8192;
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -400000;
CREATE TABLE dict (id INTEGER, t TEXT, v TEXT);
CREATE TABLE school (id INTEGER PRIMARY KEY, name TEXT, province TEXT, nature TEXT, lv INT);
CREATE TABLE score_range (p INT, y INT, c INT, b INT, ctrl INT, score INT, seg INT, cum INT);
CREATE TABLE school_adm (p INT, y INT, c INT, b INT, sid INT, grp INT, subj INT, min INT, rnk INT, ctrl INT, admit INT);
CREATE TABLE major_adm (p INT, y INT, c INT, b INT, sid INT, mid INT, grp INT, min INT, rnk INT);
CREATE TABLE plan_code (p INT, y INT, sid INT, mid INT, grp INT, mcode INT);
CREATE TABLE plan_info (sid INT, mid INT, cnt INT, fee INT, dur INT, subj INT, PRIMARY KEY (sid, mid));
CREATE TABLE school_code (p INT, y INT, sid INT, code TEXT);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
`);

// ---------- 字典重建 ----------
const dictMap = new Map();     // `${t}\t${v}` -> id
const dictNext = new Map();
const dictRows = [];
function did(t, v) {
  const s = v == null ? '' : String(v);
  if (!s) return 0;
  const k = t + '\t' + s;
  let id = dictMap.get(k);
  if (id) return id;
  id = (dictNext.get(t) || 0) + 1;
  dictNext.set(t, id);
  dictMap.set(k, id);
  dictRows.push([id, t, s]);
  return id;
}

console.log('== 1. 重建字典（专业名规范化）==');
for (const r of src.prepare('SELECT id, t, v FROM dict').all()) {
  if (r.t === 'major') did('major', normMajor(r.v));
  else if (r.t === 'groupname') did('groupname', normGroup(r.v));
  else did(r.t, r.v);
}
console.log(`  原字典 ${src.prepare('SELECT COUNT(*) c FROM dict').get().c.toLocaleString()} 条 -> 规范化后 ${dictRows.length.toLocaleString()} 条`);
const majorBefore = src.prepare("SELECT COUNT(*) c FROM dict WHERE t='major'").get().c;
const majorAfter = dictNext.get('major') || 0;
console.log(`  其中 major：${majorBefore.toLocaleString()} -> ${majorAfter.toLocaleString()}`);

// 旧 id -> 新 id 的映射（按类型分别建）
const remap = {};
for (const t of ['province', 'category', 'batch', 'subject', 'groupname', 'major', 'majorcode', 'duration', 'school']) {
  remap[t] = new Map();
}
function normBy(t, v) { return t === 'major' ? normMajor(v) : t === 'groupname' ? normGroup(v) : String(v == null ? '' : v); }
// 先把原 dict 的 id->值 读出来，再算新 id
const oldDict = new Map();
for (const r of src.prepare('SELECT t, id, v FROM dict').all()) oldDict.set(`${r.t}\t${r.id}`, r.v);
function remapId(t, oldId) {
  if (!oldId || oldId === 0) return 0;
  const m = remap[t];
  if (m.has(oldId)) return m.get(oldId);
  const v = oldDict.get(`${t}\t${oldId}`);
  const nid = v == null ? 0 : did(t, normBy(t, v));
  m.set(oldId, nid);
  return nid;
}

console.log('\n== 2. 索引裁剪 ==');
const DROP_IX = ['ix_sa2', 'ix_ma', 'ix_ma2', 'ix_ma3', 'ix_pc', 'ix_d', 'ix_sr2', 'ix_sa', 'ix_sc'];
for (const ix of DROP_IX) { try { src.exec(`DROP INDEX IF EXISTS ${ix}`); } catch { /* */ } }
console.log('  已删除源库全部索引（不再需要）');

// ---------- 过滤条件 ----------
// 核心表（一分一段 / 投档线 / 院校代码）体积小、价值高，默认保留全部年份；
// 大表（专业录取分 / 招生计划代码）只保留近年，用于「近三年」比较与代码查询。
const minYearBig = Number(argOf('min-year', 0)) || 0;
const minYearAll = Number(argOf('min-year-all', 0)) || 0;
const BIG_TABLES = new Set(['major_adm', 'plan_code']);
const keepYear = (y, table) => {
  if (minYearAll && y < minYearAll) return false;
  if (MIN_YEAR && BIG_TABLES.has(table) && y < MIN_YEAR) return false;
  if (minYearBig && BIG_TABLES.has(table) && y < minYearBig) return false;
  return true;
};
const vocIds = DROP_VOC
  ? new Set(src.prepare("SELECT id FROM dict WHERE t='batch' AND (v LIKE '%专科%' OR v LIKE '%高职%')").all().map((r) => r.id))
  : new Set();
const keepBatch = (b) => !vocIds.has(b);

// ---------- 逐表搬运 ----------
const insDict = dst.prepare('INSERT INTO dict VALUES (?,?,?)');
const insSchool = dst.prepare('INSERT INTO school VALUES (?,?,?,?,?)');
const insSR = dst.prepare('INSERT INTO score_range VALUES (?,?,?,?,?,?,?,?)');
const insSA = dst.prepare('INSERT INTO school_adm VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const insMA = dst.prepare('INSERT INTO major_adm VALUES (?,?,?,?,?,?,?,?,?)');
const insPC = dst.prepare('INSERT INTO plan_code VALUES (?,?,?,?,?,?)');
const insPI = dst.prepare('INSERT OR IGNORE INTO plan_info VALUES (?,?,?,?,?,?)');
const insSC = dst.prepare('INSERT INTO school_code VALUES (?,?,?,?)');
const insMeta = dst.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');

const copy = (label, sql, fn, table) => {
  const t0 = Date.now();
  let n = 0, skipped = 0;
  dst.exec('BEGIN');
  for (const r of src.prepare(sql).iterate()) {
    if (!keepYear(r.y, table)) { skipped++; continue; }
    if (r.b !== undefined && !keepBatch(r.b)) { skipped++; continue; }
    const out = fn(r);
    if (out) { n++; }
    if (n % 100000 === 0 && n) { dst.exec('COMMIT'); dst.exec('BEGIN'); }
  }
  dst.exec('COMMIT');
  console.log(`  ${label.padEnd(14)} ${String(n).padStart(9)} 行  跳过 ${skipped.toLocaleString()}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return n;
};

console.log('\n== 3. 搬运数据 ==');
dst.exec('BEGIN');
for (const r of src.prepare('SELECT id, name, province, nature, lv FROM school').all()) insSchool.run(r.id, r.name, r.province, r.nature, r.lv);
dst.exec('COMMIT');
console.log(`  school          ${src.prepare('SELECT COUNT(*) c FROM school').get().c.toLocaleString()} 行`);

copy('score_range', 'SELECT * FROM score_range', (r) => {
  insSR.run(r.p, r.y, remapId('category', r.c), remapId('batch', r.b), r.ctrl, r.score, r.seg, r.cum); return true;
}, 'score_range');
copy('school_adm', 'SELECT * FROM school_adm', (r) => {
  insSA.run(r.p, r.y, remapId('category', r.c), remapId('batch', r.b), r.sid,
    remapId('groupname', r.grp), remapId('subject', r.subj), r.min, r.rnk, r.ctrl, r.admit); return true;
}, 'school_adm');
copy('major_adm', 'SELECT p,y,c,b,sid,mid,grp,min,rnk FROM major_adm', (r) => {
  const mid = remapId('major', r.mid);
  if (!mid) return false;
  insMA.run(r.p, r.y, remapId('category', r.c), remapId('batch', r.b), r.sid, mid,
    remapId('groupname', r.grp), r.min, r.rnk); return true;
}, 'major_adm');
copy('plan_code', 'SELECT p,y,b,sid,mid,grp,mcode,cnt,fee,dur,subj FROM plan_code', (r) => {
  const mid = remapId('major', r.mid);
  if (!mid) return false;
  insPC.run(r.p, r.y, r.sid, mid, remapId('groupname', r.grp), remapId('majorcode', r.mcode));
  insPI.run(r.sid, mid, r.cnt, r.fee, remapId('duration', r.dur), remapId('subject', r.subj));
  return true;
}, 'plan_code');
copy('school_code', 'SELECT * FROM school_code', (r) => { insSC.run(r.p, r.y, r.sid, r.code); return true; }, 'school_code');

console.log('\n== 4. 写字典 ==');
dst.exec('BEGIN');
for (const row of dictRows) insDict.run(row[0], row[1], row[2]);
dst.exec('COMMIT');
console.log(`  dict ${dictRows.length.toLocaleString()} 条`);

console.log('\n== 5. 建最小索引集 ==');
dst.exec(`
  CREATE INDEX ix_sr  ON score_range (p, c, score);
  CREATE INDEX ix_sa_py ON school_adm (p, y);
  CREATE INDEX ix_sa_s  ON school_adm (sid, p);
  CREATE INDEX ix_ma_py ON major_adm (p, y);
  CREATE INDEX ix_ma_s  ON major_adm (sid, p);
  CREATE INDEX ix_pc_s  ON plan_code (sid, p);
  CREATE INDEX ix_sc_s  ON school_code (sid, p);
  CREATE INDEX ix_d_t   ON dict (t, id);
`);
console.log('\n== 6. VACUUM ==');
dst.exec('VACUUM');
dst.exec('ANALYZE');

insMeta.run('builtAt', new Date().toISOString());
insMeta.run('minYear', String(MIN_YEAR || ''));
insMeta.run('dropVocational', String(DROP_VOC));

const one = (s) => dst.prepare(s).get().c;
console.log('\n═══ 瘦身结果 ═══');
for (const t of ['school', 'dict', 'score_range', 'school_adm', 'major_adm', 'plan_code', 'plan_info', 'school_code']) {
  console.log(`  ${t.padEnd(14)} ${one(`SELECT COUNT(*) c FROM ${t}`).toLocaleString()}`);
}
dst.close(); src.close();
console.log(`\n  ${mb(fs.statSync(SRC).size)} -> ${mb(fs.statSync(OUT).size)}  (${(fs.statSync(OUT).size / fs.statSync(SRC).size * 100).toFixed(0)}%)`);

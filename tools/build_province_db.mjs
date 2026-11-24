/**
 * 从全国统一库生成「单省站点库」：只保留指定考生省份的数据行。
 *
 * 用法：
 *   node tools/build_province_db.mjs \
 *     --src 数据/gaokao.db \
 *     --out data/gc/hebei-site/gaokao.db \
 *     --province 河北 --std-code 13 \
 *     --report data/gc/hebei-site/build_report.json
 *
 * 设计口径：
 *   1. 只按考生省份 p 过滤 5 张数据表；dict / school / meta 保持整库，避免破坏
 *      「标准省码 -> 字典 id」换算和「河北考生查全国院校」的院校元数据。
 *   2. 质量小表同步裁剪到该省，并重新计算字段统计、表覆盖、内容指纹。
 *   3. 拒绝直接写交付库，避免误覆盖当前网站数据源；只写 staging 路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { PROVINCE_ID } from '../高考志愿助手/server/data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const die = (msg) => { console.error('错误：' + msg); process.exit(1); };

const SRC = path.resolve(ROOT, String(argOf('src', '高考志愿助手/data/gaokao.db')));
const OUT = path.resolve(ROOT, String(argOf('out', '')));
const PROV = String(argOf('province', '河北'));
const STD_CODE = Number(argOf('std-code', PROVINCE_ID.get(PROV) || 0));
const REPORT = path.resolve(ROOT, String(argOf('report', '')));

if (!fs.existsSync(SRC)) die(`源库不存在：${SRC}`);
if (!OUT) die('必须用 --out 指定 staging 输出路径');
const relOut = path.relative(ROOT, OUT).replace(/\\/g, '/');
const PROTECTED = new Set([
  '高考志愿助手/data/gaokao.db',
  '高考志愿助手/data/gaokao.db.gz',
  'data/gc/gaokao.db',
  'data/gc/fullrebuild/gaokao.slim.db',
]);
if (PROTECTED.has(relOut)) die(`拒绝写入受保护的交付库路径：${relOut}`);
if (OUT === SRC) die('输出路径不能等于源库');
if (!STD_CODE) die(`无法识别省份「${PROV}」，请用 --std-code 明确指定标准省码`);

const DATA_TABLES = ['score_range', 'school_adm', 'major_adm', 'plan_code', 'school_code'];
const CORE_TABLES = ['score_range', 'school_adm', 'major_adm', 'plan_code'];
const QUALITY_P_TABLES = ['coverage_cell', 'cell_manifest', 'gap_list', 'image_only', 'quality_issue'];
const sha256Text = (s) => crypto.createHash('sha256').update(s).digest('hex');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(SRC, OUT);

const db = new DatabaseSync(OUT);
db.exec('PRAGMA temp_store = MEMORY');
db.exec('PRAGMA cache_size = -65564');

const pidRow = db.prepare("SELECT id FROM dict WHERE t='province' AND v=?").get(PROV);
if (!pidRow) die(`源库字典中没有省份「${PROV}」`);
const pid = Number(pidRow.id);
console.log(`省份 ${PROV}：标准码 ${STD_CODE}，库内字典 id ${pid}`);

const count = (t, where = '', args = []) =>
  db.prepare(`SELECT COUNT(*) c FROM ${t}${where ? ' WHERE ' + where : ''}`).get(...args).c;

const before = Object.fromEntries(DATA_TABLES.map((t) => [t, count(t)]));
const kept = Object.fromEntries(DATA_TABLES.map((t) => [t, count(t, 'p=?', [pid])]));
console.log('裁剪前行数：', before);
console.log('保留行数：', kept);

const dm = db.prepare('SELECT * FROM data_manifest ORDER BY data_version DESC LIMIT 1').get();
const tmBefore = db.prepare('SELECT * FROM table_manifest').all();
const fsBefore = db.prepare('SELECT * FROM field_stats').all();
const builtAt = new Date().toISOString();
const dataVersion = dm?.data_version || 'province-subset';

db.exec('BEGIN');
try {
  for (const t of DATA_TABLES) {
    const n = db.prepare(`DELETE FROM ${t} WHERE p != ?`).run(pid);
    console.log(`  ${t}: 删除 ${n.changes} 行非 ${PROV} 数据`);
  }

  // plan_info 没有 p 列，按裁剪后仍被河北招生计划引用的 (sid,mid) 收缩。
  const planPruned = db.prepare(
    'DELETE FROM plan_info WHERE NOT EXISTS (SELECT 1 FROM plan_code pc WHERE pc.sid=plan_info.sid AND pc.mid=plan_info.mid)'
  ).run();
  console.log(`  plan_info: 删除 ${planPruned.changes} 行无河北计划引用记录`);

  // 质量小表同步裁剪；quality_issue 保留 p=0 的全局规则问题。
  for (const t of QUALITY_P_TABLES) {
    if (t === 'quality_issue') {
      db.prepare('DELETE FROM quality_issue WHERE p IS NOT NULL AND p NOT IN (0, ?)').run(pid);
    } else {
      db.prepare(`DELETE FROM ${t} WHERE p != ?`).run(pid);
    }
  }

  // field_stats 重算，避免继续报告全国行数。
  db.exec('DELETE FROM field_stats');
  const insFs = db.prepare(
    'INSERT INTO field_stats(data_version,table_name,field,total,non_null,filled,fill_rate,fill_source,out_of_range) VALUES(?,?,?,?,?,?,?,?,?)'
  );
  for (const r of fsBefore) {
    if (!/^[a-z_]+$/.test(r.table_name) || !/^[a-z_]+$/.test(r.field)) continue;
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(r.table_name);
    if (!exists) continue;
    const cols = db.prepare(`PRAGMA table_info(${r.table_name})`).all().map((c) => c.name);
    if (!cols.includes(r.field)) continue;
    const total = count(r.table_name);
    const nonNull = count(r.table_name, `${r.field} IS NOT NULL`);
    insFs.run(r.data_version ?? dataVersion, r.table_name, r.field, total, nonNull, 0,
      total ? nonNull / total : 0, r.fill_source ?? null, r.out_of_range ?? 0);
  }

  // table_manifest 重算 CORE_TABLES 的行数/年份范围；其余行原样保留。
  db.exec('DELETE FROM table_manifest');
  const insTm = db.prepare(`INSERT INTO table_manifest VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of tmBefore) {
    let rows = r.rows, minYear = r.min_year, maxYear = r.max_year;
    if (CORE_TABLES.includes(r.table_name)) {
      const s = db.prepare(`SELECT COUNT(*) c, MIN(y) a, MAX(y) b FROM ${r.table_name}`).get();
      rows = s.c; minYear = s.a; maxYear = s.b;
    }
    insTm.run(r.data_version ?? dataVersion, r.table_name, r.source, r.source_url, r.license,
      r.ingested_at, r.published_at, rows, r.rows_quarantined ?? 0, minYear, maxYear,
      null, r.completeness ?? 'full');
  }

  if (dm) {
    db.prepare('UPDATE data_manifest SET built_at=?, generator=? WHERE data_version=?')
      .run(builtAt, `tools/build_province_db.mjs -> ${PROV} subset`, dm.data_version);
  }
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('dataScope',?)").run(PROV);
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('scopeStdCode',?)").run(String(STD_CODE));
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('scopeDictPid',?)").run(String(pid));
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('sourceDatabase',?)")
    .run(path.relative(ROOT, SRC).replace(/\\/g, '/'));

  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  db.close();
  die('裁剪事务失败：' + e.message);
}

// VACUUM 必须在事务外执行；与 verify_gcdb 一致，TEMP/TMP 应指向可写目录。
try { db.exec('VACUUM'); } catch (e) { console.warn('VACUUM 跳过：' + e.message); }

// 内容指纹：与 verify_gcdb.mjs 的 db_sha256 口径一致（按表聚合，不受文件字节影响）。
const fp = CORE_TABLES.map((t) => {
  const s = db.prepare(`SELECT COUNT(*) c, SUM(y) sy FROM ${t}`).get();
  return `${t}:${s.c}:${s.sy ?? 0}`;
}).join('|');
const contentHash = sha256Text(fp);
if (dm) db.prepare('UPDATE data_manifest SET db_sha256=? WHERE data_version=?').run(contentHash, dm.data_version);

// 写后自验
const verify = {};
for (const t of DATA_TABLES) {
  verify[t] = { rows: count(t), foreign: count(t, 'p != ?', [pid]) };
  if (verify[t].foreign !== 0) die(`${t} 仍有 ${verify[t].foreign} 行非 ${PROV} 数据`);
}
const coverageP = db.prepare('SELECT COUNT(*) c FROM coverage_cell WHERE p != ?').get(pid).c;
if (coverageP !== 0) die(`coverage_cell 仍有 ${coverageP} 行非 ${PROV} 数据`);
const manifestHash = db.prepare('SELECT db_sha256 FROM data_manifest WHERE data_version=?').get(dataVersion)?.db_sha256;
if (manifestHash !== contentHash) die('data_manifest.db_sha256 回写不一致');
const report = {
  province: PROV,
  stdCode: STD_CODE,
  dictPid: pid,
  source: path.relative(ROOT, SRC).replace(/\\/g, '/'),
  output: relOut,
  builtAt,
  dataVersion,
  contentFingerprint: contentHash,
  rowsBefore: before,
  rowsAfter: kept,
  planInfoRows: count('plan_info'),
  coverageCells: count('coverage_cell'),
};
db.close();
if (REPORT) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
}
console.log(`\n完成：${relOut} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`内容指纹：${contentHash}`);
if (REPORT) console.log(`报告：${path.relative(ROOT, REPORT).replace(/\\/g, '/')}`);

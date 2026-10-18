/**
 * 打包 gaokao.db：精简 → 压缩 → 放入交付目录
 *
 * 目标：在「保留全部可用数据」的前提下，把随包体积压到最小。
 *   1. 只保留服务端真正会用到的索引（多余索引在 SQLite 里可能占一半体积）
 *   2. 清理临时表、VACUUM 回收空洞
 *   3. 用 Brotli（比 gzip 再小 ~20%）压缩成 gaokao.db.gz
 *   4. 服务端首次启动时解压成 gaokao.db（node:zlib 内置，零依赖）
 *
 * 用法：
 *   node tools/pack_gcdb.mjs [--src data/gc/gaokao.db] [--out 高考志愿助手/data/gaokao.db.gz]
 *                            [--keep-years 2017-2025] [--drop-vocational]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (process.argv.includes('--' + n) ? true : d); };

const SRC = path.resolve(ROOT, argOf('src', 'data/gc/gaokao.db'));
const OUT = path.resolve(ROOT, argOf('out', '高考志愿助手/data/gaokao.db.gz'));
const KEEP_YEARS = String(argOf('keep-years', ''));
const DROP_VOC = !!argOf('drop-vocational', false);
const LEVEL = Number(argOf('level', 11));      // brotli 质量 0-11

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

if (!fs.existsSync(SRC)) { console.error('找不到源数据库：' + SRC); process.exit(1); }
const before = fs.statSync(SRC).size;
console.log(`源数据库 ${SRC}\n  大小 ${mb(before)}`);

const db = new DatabaseSync(SRC);
const q = (s) => db.prepare(s).get().c;
const count = (t) => { try { return q(`SELECT COUNT(*) c FROM ${t}`); } catch { return -1; } };

console.log('\n== 1. 清理与索引精简 ==');
// 删除构建期的辅助表（服务端不需要）
for (const t of ['_progress', '_files']) {
  try { db.exec(`DROP TABLE IF EXISTS ${t}`); console.log(`  删除辅助表 ${t}`); } catch { /* ignore */ }
}
// 只保留查询必需的索引：其余索引会显著放大体积
const DROP = [
  'ix_sr2',       // score_range 已有 (p,y,c) 复合索引，够用
  'ix_ma3',       // major_adm 的 (p,mid,y) 很少用
];
for (const ix of DROP) {
  try { db.exec(`DROP INDEX IF EXISTS ${ix}`); console.log(`  删除索引 ${ix}`); } catch { /* ignore */ }
}
// 补一个对方案生成更关键的索引
try { db.exec('CREATE INDEX IF NOT EXISTS ix_ma4 ON major_adm (p, y, sid)'); } catch { /* ignore */ }

if (KEEP_YEARS) {
  const [a, b] = KEEP_YEARS.split('-').map(Number);
  console.log(`\n== 2. 年份裁剪：保留 ${a}-${b} ==`);
  for (const t of ['score_range', 'school_adm', 'major_adm', 'plan_code', 'school_code']) {
    if (count(t) < 0) continue;
    const n0 = count(t);
    db.exec(`DELETE FROM ${t} WHERE y < ${a} OR y > ${b}`);
    console.log(`  ${t.padEnd(12)} ${n0.toLocaleString()} -> ${count(t).toLocaleString()}`);
  }
} else {
  console.log('\n== 2. 年份裁剪：跳过（保留全部年份）==');
}

if (DROP_VOC) {
  console.log('\n== 3. 剔除专科批 ==');
  const vocIds = db.prepare("SELECT id FROM dict WHERE t='batch' AND (v LIKE '%专科%' OR v LIKE '%高职%')").all().map((r) => r.id);
  if (vocIds.length) {
    const list = vocIds.join(',');
    for (const t of ['school_adm', 'major_adm', 'plan_code']) {
      const n0 = count(t);
      db.exec(`DELETE FROM ${t} WHERE b IN (${list})`);
      console.log(`  ${t.padEnd(12)} ${n0.toLocaleString()} -> ${count(t).toLocaleString()}`);
    }
  } else console.log('  未识别到专科批次');
} else {
  console.log('\n== 3. 剔除专科批：跳过 ==');
}

console.log('\n== 4. VACUUM 回收空洞 ==');
db.exec('PRAGMA journal_mode = DELETE');
db.exec('VACUUM');
db.close();
const afterOptimize = fs.statSync(SRC).size;
console.log(`  ${mb(before)} -> ${mb(afterOptimize)}`);

console.log(`\n== 5. Brotli 压缩（质量 ${LEVEL}）==`);
const raw = fs.readFileSync(SRC);
const t0 = Date.now();
const gz = zlib.brotliCompressSync(raw, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: LEVEL,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
  },
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, gz);
console.log(`  ${mb(raw.length)} -> ${mb(gz.length)}  (压缩到 ${(gz.length / raw.length * 100).toFixed(1)}%，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log(`  → ${OUT}`);

console.log('\n== 6. 汇总 ==');
const check = new DatabaseSync(SRC, { readOnly: true });
for (const t of ['school', 'dict', 'score_range', 'school_adm', 'major_adm', 'plan_code', 'school_code']) {
  try { console.log(`  ${t.padEnd(12)} ${check.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c.toLocaleString()}`); } catch { /* ignore */ }
}
const yr = check.prepare('SELECT MIN(y) a, MAX(y) b FROM school_adm').get();
console.log(`  年份范围     ${yr.a}-${yr.b}`);
check.close();

// 交付目录总体积
const APP = path.join(ROOT, '高考志愿助手');
let total = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
walk(APP);
console.log(`\n  交付目录合计 ${mb(total)}（其中 runtime/node.exe ${mb(fs.existsSync(path.join(APP, 'runtime', 'node.exe')) ? fs.statSync(path.join(APP, 'runtime', 'node.exe')).size : 0)}）`);

/**
 * 打包：把爬取产物装配进交付目录
 *   data/raw/schools.json        -> 高考志愿助手/data/schools.json.gz
 *   data/bundle/colleges.json    -> 高考志愿助手/data/colleges.json.gz
 *   data/raw/province_<pid>_<y>.json -> 高考志愿助手/data/index/province_<pid>_<y>.json
 *
 * 说明：大数据文件统一 gzip 存放，服务端 readJson() 会自动回退读取 .gz，无需解压。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { compactProvinceRecords, APP_DIR } from '../高考志愿助手/server/data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
const BUNDLE = path.join(ROOT, 'data', 'bundle');
const APP_DATA = path.join(APP_DIR, 'data');
const INDEX = path.join(APP_DATA, 'index');
fs.mkdirSync(INDEX, { recursive: true });

/** 以 gzip 写入；若明文文件已存在则删除，避免仓库里出现两份 */
const copyGz = (from, baseName) => {
  if (!fs.existsSync(from)) { console.log(`  ✗ 缺少 ${path.relative(ROOT, from)}`); return false; }
  const raw = fs.readFileSync(from);
  const gz = zlib.gzipSync(raw, { level: 9 });
  const dest = path.join(APP_DATA, baseName + '.gz');
  fs.writeFileSync(dest, gz);
  const plain = path.join(APP_DATA, baseName);
  if (fs.existsSync(plain)) fs.unlinkSync(plain);
  console.log(`  ✓ ${baseName}.gz  ${(raw.length / 1024 / 1024).toFixed(2)} MB -> ${(gz.length / 1024 / 1024).toFixed(2)} MB  (压缩 ${(100 - gz.length / raw.length * 100).toFixed(0)}%)`);
  return true;
};

console.log('== 1. 基础数据 ==');
copyGz(path.join(RAW, 'schools.json'), 'schools.json');
copyGz(path.join(BUNDLE, 'colleges.json'), 'colleges.json');

console.log('\n== 2. 分数线索引 ==');
const files = fs.existsSync(RAW) ? fs.readdirSync(RAW).filter((f) => /^province_\d+_\d+\.json$/.test(f)) : [];
let ok = 0, rows = 0, skipped = 0;
for (const f of files) {
  const m = /^province_(\d+)_(\d+)\.json$/.exec(f);
  const pid = Number(m[1]), year = Number(m[2]);
  let src;
  try { src = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8')); } catch { skipped++; continue; }
  if (!src.items || !src.items.length) { skipped++; continue; }
  const compact = { pid, province: src.provinceName, year, numFound: src.numFound, complete: !!src.complete, ...compactProvinceRecords(src.items) };
  const dest = path.join(INDEX, `province_${pid}_${year}.json`);
  fs.writeFileSync(dest, JSON.stringify(compact));
  ok++; rows += compact.rows.length;
}
console.log(`  生成 ${ok} 个索引文件，累计 ${rows.toLocaleString()} 条记录（跳过空/无效 ${skipped} 个）`);

console.log('\n== 3. 汇总 ==');
let total = 0;
for (const f of fs.readdirSync(APP_DATA, { withFileTypes: true })) {
  const p = path.join(APP_DATA, f.name);
  const size = f.isDirectory()
    ? fs.readdirSync(p).reduce((a, x) => a + fs.statSync(path.join(p, x)).size, 0)
    : fs.statSync(p).size;
  total += size;
  console.log(`  ${f.name.padEnd(16)} ${(size / 1024 / 1024).toFixed(2)} MB`);
}
console.log(`  合计 ${(total / 1024 / 1024).toFixed(2)} MB  ->  ${APP_DATA}`);

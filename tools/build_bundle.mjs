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

console.log('\n== 3. 资料库：一分一段表 ==');
{
  const src = path.join(ROOT, 'data', 'resources', 'rank_table.json');
  if (fs.existsSync(src)) {
    const d = JSON.parse(fs.readFileSync(src, 'utf8'));
    // 只保留应用需要的字段（去掉原始表格与图片列表，体积可减小一半以上）
    const items = (d.items || []).filter((x) => Array.isArray(x.series) && x.series.length).map((x) => ({
      province: x.province, year: x.year, type: x.type || '综合', title: x.title,
      url: x.url, series: x.series, range: x.range, total: x.total,
      gaps: x.gaps || [], full: !!x.full, blocks: x.blocks || 1,
    }));
    const imgOnly = (d.items || []).filter((x) => !Array.isArray(x.series)).map((x) => ({
      province: x.province, year: x.year, type: x.type || '', title: x.title, url: x.url,
    }));
    const out = {
      source: d.source, updatedAt: d.updatedAt, normalizedAt: d.normalizedAt,
      items, imageOnly: imgOnly,
    };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
    fs.writeFileSync(path.join(APP_DATA, 'rank_table.json.gz'), gz);
    const plain = path.join(APP_DATA, 'rank_table.json');
    if (fs.existsSync(plain)) fs.unlinkSync(plain);
    console.log(`  ✓ rank_table.json.gz  ${items.length} 张表（${new Set(items.map((x) => x.province)).size} 个省）+ ${imgOnly.length} 条图片发布记录  ${(gz.length / 1024).toFixed(0)} KB`);
  } else {
    console.log('  ✗ 缺少 data/resources/rank_table.json，请先运行 tools/crawl_resources.mjs rank');
  }
}

console.log('\n== 4. 资料库：AI 技能提示词 ==');
{
  const src = path.join(ROOT, 'data', 'skill', 'SKILL.md');
  if (fs.existsSync(src)) {
    const txt = fs.readFileSync(src);
    fs.writeFileSync(path.join(APP_DATA, 'skill_zhangxuefeng.md'), txt);
    console.log(`  ✓ skill_zhangxuefeng.md  ${(txt.length / 1024).toFixed(1)} KB`);
  } else {
    console.log('  ✗ 缺少 data/skill/SKILL.md');
  }
}

console.log('\n== 5. 汇总 ==');
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

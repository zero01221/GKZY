/**
 * 为已有「投档线索引」的省份补建「专业粒度索引」
 * 用法：node tools/build_special_index.mjs [--years 2026,2025] [--pages 200]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quickIndex } from '../高考志愿助手/server/indexer.mjs';
import { PROVINCE_NAME, specialIndexFile, loadSpecialIndex } from '../高考志愿助手/server/data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX_DIR = path.join(ROOT, '高考志愿助手', 'data', 'index');

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const years = argOf('years', '2026,2025,2024').split(',').map(Number);
const pages = Number(argOf('pages', 200));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 找出已有 province 索引的 (省, 年)
  const jobs = [];
  for (const f of fs.readdirSync(INDEX_DIR)) {
    const m = /^province_(\d+)_(\d+)\.json$/.exec(f);
    if (!m) continue;
    const pid = Number(m[1]), year = Number(m[2]);
    if (!years.includes(year)) continue;
    if (fs.existsSync(specialIndexFile(pid, year))) continue;
    let rows = 0;
    try { rows = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), 'utf8')).rows?.length || 0; } catch { continue; }
    if (rows < 50) continue;
    jobs.push({ pid, year, rows });
  }
  jobs.sort((a, b) => b.year - a.year || b.rows - a.rows);
  console.log(`待建专业索引：${jobs.length} 个 省份-年份`);

  const t0 = Date.now();
  let ok = 0, fail = 0;
  for (let i = 0; i < jobs.length; i++) {
    const { pid, year } = jobs[i];
    const pname = PROVINCE_NAME.get(pid) || pid;
    const t = Date.now();
    const r = await quickIndex(pid, year, pages, 'special');
    const idx = r.ok ? loadSpecialIndex(pid, year) : null;
    const schools = idx ? new Set(idx.rows.map((x) => x[0])).size : 0;
    if (r.ok) ok++; else fail++;
    console.log(`  [${i + 1}/${jobs.length}] ${String(pname).padEnd(6)} ${year}  ${r.ok ? `${String(r.rows).padStart(5)} 条 / ${String(schools).padStart(4)} 所院校` : '✗ ' + r.reason}  (${((Date.now() - t) / 1000).toFixed(0)}s)`);
    await sleep(1200);
  }
  console.log(`\n✓ 完成 ${ok} 个，失败 ${fail} 个，总用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  process.exit(0);
})();

/**
 * 把 gaokao-vault（PostgreSQL）抓到的 2026 数据并入统一 SQLite。
 *
 * 分工：2017-2025 来自 GaokaoCompass，2026 由 gaokao-vault 抓取（阳光高考 / eol.cn / dxsbb）。
 * 通过 docker compose exec psql 的 COPY 导出 CSV，再用 node:sqlite 写入，无需 Node 的 PG 驱动。
 *
 * 用法：
 *   node tools/import_vault.mjs [--year 2026] [--db 高考志愿助手/data/gaokao.db]
 *                              [--vault _research/gv/gaokao-vault] [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const has = (n) => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

const YEAR = Number(argOf('year', 2026));
const DB = path.resolve(ROOT, argOf('db', '高考志愿助手/data/gaokao.db'));
const VAULT = path.resolve(ROOT, argOf('vault', '_research/gv/gaokao-vault'));
const DRY = has('dry');

const DSN_DB = 'gaokao_vault';

function psqlCopy(sql) {
  const out = execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'gaokao', '-d', DSN_DB, '-c', `COPY (${sql}) TO STDOUT WITH CSV HEADER`], {
    cwd: VAULT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  return out;
}

/** 极简 CSV 解析（psql COPY CSV 输出，字段带引号转义） */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

console.log(`年份 ${YEAR}   目标库 ${DB}`);
console.log(`vault ${VAULT}\n`);

// ---------- 1. 导出 ----------
console.log('== 1. 从 PostgreSQL 导出 ==');
const segSql = `SELECT p.name AS province, s.year, COALESCE(sc.name,'') AS category,
  s.score, s.segment_count, s.cumulative_count
  FROM score_segments s
  JOIN provinces p ON p.id = s.province_id
  LEFT JOIN subject_categories sc ON sc.id = s.subject_category_id
  WHERE s.year = ${YEAR}
  ORDER BY p.name, sc.name, s.score DESC`;
let segRows = [];
try {
  const csv = psqlCopy(segSql);
  segRows = parseCsv(csv);
  console.log(`  score_segments 导出 ${segRows.length - 1} 行`);
} catch (e) { console.error('  导出失败：' + e.message); process.exit(1); }

if (segRows.length < 2) { console.log('\n没有可导入的数据（抓取可能还在进行）。'); process.exit(0); }

// 统计省份
const provs = new Map();
for (let i = 1; i < segRows.length; i++) {
  const p = segRows[i][0];
  provs.set(p, (provs.get(p) || 0) + 1);
}
console.log('  涉及省份：' + [...provs.entries()].map(([k, v]) => `${k}(${v})`).join(' '));

if (DRY) { console.log('\n--dry 模式结束'); process.exit(0); }

// ---------- 2. 写入 SQLite ----------
console.log('\n== 2. 写入统一 SQLite ==');
if (!fs.existsSync(DB)) { console.error('  目标库不存在：' + DB); process.exit(1); }
const db = new DatabaseSync(DB);

// 字典查询/新增
const dictMax = new Map();
function dictOf(t) {
  if (!dictMax.has(t)) {
    const byName = new Map();
    let max = 0;
    for (const r of db.prepare('SELECT id, v FROM dict WHERE t=?').all(t)) { byName.set(r.v, r.id); if (r.id > max) max = r.id; }
    dictMax.set(t, { byName, max });
  }
  return dictMax.get(t);
}
const insDict = db.prepare('INSERT INTO dict (id, t, v) VALUES (?,?,?)');
function did(t, v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const box = dictOf(t);
  if (box.byName.has(s)) return box.byName.get(s);
  const id = ++box.max;
  box.byName.set(s, id);
  insDict.run(id, t, s);
  return id;
}

const del = db.prepare('DELETE FROM score_range WHERE p=? AND y=? AND c=?');
const ins = db.prepare('INSERT INTO score_range (p, y, c, b, ctrl, score, seg, cum) VALUES (?,?,?,?,?,?,?,?)');

// 按 (省, 科类) 分组，先删旧数据再整批插入
const groups = new Map();
for (let i = 1; i < segRows.length; i++) {
  const [prov, year, cat, score, seg, cum] = segRows[i];
  const k = `${prov}|${cat}`;
  if (!groups.has(k)) groups.set(k, { prov, cat, rows: [] });
  groups.get(k).rows.push({ score: Number(score), seg: Number(seg), cum: Number(cum) });
}

let inserted = 0, replaced = 0;
db.exec('BEGIN');
for (const { prov, cat, rows } of groups.values()) {
  const pid = did('province', prov);
  const cid = did('category', cat || '综合');
  del.run(pid, YEAR, cid);
  replaced++;
  for (const r of rows) {
    if (!Number.isFinite(r.score) || !Number.isFinite(r.seg) || !Number.isFinite(r.cum)) continue;
    ins.run(pid, YEAR, cid, 0, 0, r.score, r.seg, r.cum);
    inserted++;
  }
}
db.exec('COMMIT');

// 清理缓存表（服务端按需重建）
try { db.exec('ANALYZE'); } catch { /* ignore */ }

console.log(`  写入 ${inserted.toLocaleString()} 行，覆盖 ${replaced} 个「省-科类」组合`);
console.log('\n== 3. 校验 ==');
const chk = db.prepare(`SELECT p.y AS year, COUNT(*) rows, COUNT(DISTINCT p.p) provs FROM score_range p WHERE p.y=?`).get(YEAR);
console.log(`  score_range ${YEAR}: ${chk.rows.toLocaleString()} 行 / ${chk.provs} 省`);
for (const r of db.prepare(`SELECT p.p AS pid, d.v AS prov, c.v AS cat, COUNT(*) n
  FROM score_range p LEFT JOIN dict d ON d.t='province' AND d.id=p.p
  LEFT JOIN dict c ON c.t='category' AND c.id=p.c
  WHERE p.y=? GROUP BY p.p, p.c ORDER BY n DESC`).all(YEAR)) {
  console.log(`    ${String(r.prov).padEnd(6)} ${String(r.cat).padEnd(8)} ${r.n}`);
}
db.close();
console.log('\n完成。记得重新执行：node tools/pack_gcdb.mjs --src <该库> --out 高考志愿助手/data/gaokao.db.gz --level 9');

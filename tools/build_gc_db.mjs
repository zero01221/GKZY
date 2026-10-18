/**
 * GaokaoCompass（2017-2025，11M 行）-> 轻量 SQLite
 *
 * 设计要点（目标：尽量小的体积）
 *   1. 所有字符串做字典编码，表里只存 INTEGER
 *   2. 只保留应用真正用到的列
 *   3. 招生计划只保留「代码映射 + 计划信息」，并按 (省,年,校,专业,组) 去重
 *   4. 边下边解析边入库，不落原始 CSV（省磁盘、省时间）
 *   5. 支持断点续跑（_progress 表记录已完成文件）
 *
 * 用法：
 *   node tools/build_gc_db.mjs [--out data/gc/gaokao.db] [--concurrency 8] [--years 2017,2018,...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://hf-mirror.com/datasets/choucsan/Gaokao-Compass-11M/resolve/main/';
// 多个镜像轮换，规避单站限流（实测 429 为共享配额，换站 + 退避即可恢复）
const MIRRORS = [
  'https://hf-mirror.com/datasets/choucsan/Gaokao-Compass-11M/resolve/main/',
  'https://aifasthub.com/datasets/choucsan/Gaokao-Compass-11M/resolve/main/',
];
let mirrorCursor = 0;
let rateLimitUntil = 0;

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, argOf('out', 'data/gc/gaokao.db'));
const CONC = Number(argOf('concurrency', 8));
const YEARS = argOf('years', '').split(',').filter(Boolean).map(Number);
const LIMIT = Number(argOf('limit', 0)) || 0;
const FILELIST = path.join(ROOT, 'data', 'gc', 'filelist.json');

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// ===============================================================
// CSV 解析（支持引号、引号内逗号与换行）
// ===============================================================
export function parseCsv(text) {
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

// ===============================================================
// 字典编码
// ===============================================================
const dictTables = ['province', 'category', 'batch', 'subject', 'groupname', 'major', 'majorcode', 'school'];
const dmap = new Map();      // `${t}\t${v}` -> id
const dnext = new Map();     // t -> next id
let pendingDict = [];

function dictId(t, v) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) return 0;                                  // 0 = 空
  const k = t + '\t' + s;
  let id = dmap.get(k);
  if (id) return id;
  id = (dnext.get(t) || 0) + 1;
  dnext.set(t, id);
  dmap.set(k, id);
  pendingDict.push([id, t, s]);
  return id;
}

// ===============================================================
// 学校主表（从各表累积）
// ===============================================================
const schoolInfo = new Map();   // name -> {code, province, nature, lv}

// ===============================================================
// 建库
// ===============================================================
const db = new DatabaseSync(OUT);
db.exec(`
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -200000;

CREATE TABLE IF NOT EXISTS dict (id INTEGER, t TEXT, v TEXT);
CREATE TABLE IF NOT EXISTS school (id INTEGER PRIMARY KEY, name TEXT, name_id INTEGER,
                                   province TEXT, nature TEXT, lv INTEGER);
CREATE TABLE IF NOT EXISTS score_range (p INT, y INT, c INT, b INT, ctrl INT, score INT, seg INT, cum INT);
CREATE TABLE IF NOT EXISTS school_adm  (p INT, y INT, c INT, b INT, sid INT, grp INT, subj INT,
                                        min INT, rnk INT, ctrl INT, admit INT);
CREATE TABLE IF NOT EXISTS major_adm   (p INT, y INT, c INT, b INT, sid INT, mid INT, grp INT,
                                        min INT, rnk INT, admit INT);
CREATE TABLE IF NOT EXISTS plan_code   (p INT, y INT, b INT, sid INT, mid INT, grp INT,
                                        mcode INT, cnt INT, fee INT, dur INT, subj INT);
CREATE TABLE IF NOT EXISTS school_code (p INT, y INT, sid INT, code TEXT);
CREATE TABLE IF NOT EXISTS _progress (path TEXT PRIMARY KEY, rows INT, at INT);
CREATE TABLE IF NOT EXISTS _files (path TEXT PRIMARY KEY, kind TEXT, year INT, province TEXT);
`);

const isDone = db.prepare('SELECT 1 FROM _progress WHERE path = ?');
const markDone = db.prepare('INSERT OR REPLACE INTO _progress (path, rows, at) VALUES (?,?,?)');

// ===============================================================
// 插入语句
// ===============================================================
const ins = {
  dict: db.prepare('INSERT INTO dict (id,t,v) VALUES (?,?,?)'),
  score: db.prepare('INSERT INTO score_range VALUES (?,?,?,?,?,?,?,?)'),
  sadm: db.prepare('INSERT INTO school_adm VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
  madm: db.prepare('INSERT INTO major_adm VALUES (?,?,?,?,?,?,?,?,?,?)'),
  plan: db.prepare('INSERT INTO plan_code VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
  scode: db.prepare('INSERT INTO school_code VALUES (?,?,?,?)'),
};

const int = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(/[,，\s]/g, '')); return Number.isFinite(n) ? Math.round(n) : null; };
const idx = (h, name) => h.indexOf(name);

// 招生计划去重：key = p|y|b|sid|mid|grp  （同一专业多个计划行只留一条 + 累加计划数）
const planSeen = new Map();
const schoolCodeSeen = new Set();

// ===============================================================
// 各表处理
// ===============================================================
function handleScoreRange(rows, meta) {
  const h = rows[0];
  const I = {
    p: idx(h, 'province'), y: idx(h, 'year'), c: idx(h, 'category'), b: idx(h, 'batch'),
    ctrl: idx(h, 'control_score'), score: idx(h, 'score'), seg: idx(h, 'segment_count'), cum: idx(h, 'cumulative_count'),
  };
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 8) continue;
    const score = int(r[I.score]);
    if (score === null) continue;
    ins.score.run(
      dictId('province', r[I.p]), int(r[I.y]), dictId('category', r[I.c]), dictId('batch', r[I.b]),
      int(r[I.ctrl]), score, int(r[I.seg]), int(r[I.cum]),
    );
    n++;
  }
  return n;
}

function handleSchoolAdm(rows) {
  const h = rows[0];
  const I = {
    p: idx(h, 'province'), y: idx(h, 'year'), c: idx(h, 'category'), b: idx(h, 'batch'),
    code: idx(h, 'university_code'), name: idx(h, 'university_name'), grp: idx(h, 'major_group'),
    subj: idx(h, 'subject_req'), min: idx(h, 'min_score'), rnk: idx(h, 'min_rank'),
    ctrl: idx(h, 'control_score'), admit: idx(h, 'admit_count'),
    sprov: idx(h, 'school_province'), snat: idx(h, 'school_nature'),
    f985: idx(h, 'is_985'), f211: idx(h, 'is_211'),
  };
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 10) continue;
    const name = String(r[I.name] || '').trim();
    if (!name) continue;
    const y = int(r[I.y]);
    const p = r[I.p];
    // 学校主表 + 省编院校代码
    const sid = dictId('school', name);
    if (!schoolInfo.has(name)) {
      schoolInfo.set(name, {
        code: String(r[I.code] || '').trim(), province: String(r[I.sprov] || '').trim(),
        nature: String(r[I.snat] || '').trim(),
        lv: (int(r[I.f985]) === 1 ? 3 : 0) + (int(r[I.f211]) === 1 ? 2 : 0),
      });
    }
    const code = String(r[I.code] || '').trim();
    if (code) {
      const ck = `${p}|${y}|${sid}`;
      if (!schoolCodeSeen.has(ck)) { schoolCodeSeen.add(ck); ins.scode.run(dictId('province', p), y, sid, code); }
    }
    ins.sadm.run(
      dictId('province', p), y, dictId('category', r[I.c]), dictId('batch', r[I.b]), sid,
      dictId('groupname', r[I.grp]), dictId('subject', r[I.subj]),
      int(r[I.min]), int(r[I.rnk]), int(r[I.ctrl]), int(r[I.admit]),
    );
    n++;
  }
  return n;
}

function handleMajorAdm(rows) {
  const h = rows[0];
  const I = {
    p: idx(h, 'province'), y: idx(h, 'year'), c: idx(h, 'category'), b: idx(h, 'batch'),
    name: idx(h, 'university_name'), grp: idx(h, 'major_group'), mname: idx(h, 'major_name'),
    min: idx(h, 'min_score'), rnk: idx(h, 'min_rank'), admit: idx(h, 'admit_count'),
  };
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 10) continue;
    const name = String(r[I.name] || '').trim();
    const mname = String(r[I.mname] || '').trim();
    if (!name || !mname) continue;
    ins.madm.run(
      dictId('province', r[I.p]), int(r[I.y]), dictId('category', r[I.c]), dictId('batch', r[I.b]),
      dictId('school', name), dictId('major', mname), dictId('groupname', r[I.grp]),
      int(r[I.min]), int(r[I.rnk]), int(r[I.admit]),
    );
    n++;
  }
  return n;
}

function handleEnrollment(rows) {
  const h = rows[0];
  const I = {
    p: idx(h, 'province'), y: idx(h, 'year'), b: idx(h, 'batch'),
    name: idx(h, 'university_name'), grp: idx(h, 'major_group'), mname: idx(h, 'major_name'),
    mcode: idx(h, 'major_code'), cnt: idx(h, 'plan_count'), fee: idx(h, 'tuition'),
    dur: idx(h, 'duration'), subj: idx(h, 'subject_req'),
  };
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 12) continue;
    const name = String(r[I.name] || '').trim();
    const mname = String(r[I.mname] || '').trim();
    if (!name || !mname) continue;
    const p = dictId('province', r[I.p]), y = int(r[I.y]), b = dictId('batch', r[I.b]);
    const sid = dictId('school', name), mid = dictId('major', mname), grp = dictId('groupname', r[I.grp]);
    const cnt = int(r[I.cnt]) || 0;
    const k = `${p}|${y}|${b}|${sid}|${mid}|${grp}`;
    const prev = planSeen.get(k);
    if (prev) { prev[7] += cnt; continue; }        // 同一行重复出现 -> 累加计划数
    planSeen.set(k, [p, y, b, sid, mid, grp, dictId('majorcode', r[I.mcode]), cnt,
      int(r[I.fee]), dictId('duration', String(r[I.dur] || '').trim()), dictId('subject', r[I.subj])]);
    n++;
  }
  return n;
}

// ===============================================================
// 下载
// ===============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(p, retries = 10) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    // 若正处于限流冷却期，先等
    const wait = rateLimitUntil - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 15000));
    const base = MIRRORS[mirrorCursor++ % MIRRORS.length];
    try {
      const r = await fetch(base + p, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(300000) });
      if (r.status === 429) {
        rateLimitUntil = Date.now() + 30000 + i * 10000;    // 全局限流冷却
        lastErr = new Error('429 限流');
        await sleep(2000 + i * 1500);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      // 有些镜像在限流时返回 200 + 提示文本
      if (text.length < 600 && /rate limit|Too Many Requests|quota/i.test(text)) {
        rateLimitUntil = Date.now() + 30000 + i * 10000;
        lastErr = new Error('限流提示');
        await sleep(2000 + i * 1500);
        continue;
      }
      return text;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr || new Error('下载失败');
}

// ===============================================================
// 主流程：并发下载 + 串行入库
// ===============================================================
const KIND = (p) => (p.includes('score-range') ? 'score_range'
  : p.includes('school-admission') ? 'school_admission'
    : p.includes('major-admission') ? 'major_admission'
      : p.includes('enrollment-plan') ? 'enrollment_plan' : 'other');

(async () => {
  if (!fs.existsSync(FILELIST)) { console.error('缺少 filelist.json，请先运行 tools/gc_filelist.mjs'); process.exit(1); }
  let files = JSON.parse(fs.readFileSync(FILELIST, 'utf8'));
  if (YEARS.length) files = files.filter((f) => YEARS.includes(Number((/data\/(\d{4})\//.exec(f.p) || [])[1])));
  // 小表优先，先拿到高价值数据
  const order = { score_range: 0, school_admission: 1, major_admission: 2, enrollment_plan: 3, other: 4 };
  files.sort((a, b) => order[KIND(a.p)] - order[KIND(b.p)] || a.s - b.s);

  const todo = files.filter((f) => !isDone.get(f.p)).slice(0, LIMIT || undefined);
  const totalBytes = files.reduce((a, b) => a + b.s, 0);
  const todoBytes = todo.reduce((a, b) => a + b.s, 0);
  console.log(`输出: ${OUT}`);
  console.log(`CSV  ${files.length} 个 / ${(totalBytes / 1024 / 1024).toFixed(1)} MB；待处理 ${todo.length} 个 / ${(todoBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`并发下载 ${CONC} 路，串行入库\n`);

  let done = 0, doneBytes = 0, rowsTotal = 0, failed = 0;
  const t0 = Date.now();
  const queue = [];
  let qi = 0, active = 0;
  let wake = null;
  const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };

  function pump() {
    while (active < CONC && qi < todo.length) {
      const f = todo[qi++];
      active++;
      download(f.p).then((text) => {
        queue.push({ f, text });
      }).catch((e) => {
        failed++; console.error(`  ✗ 下载失败 ${f.p} :: ${e.message}`);
      }).finally(() => { active--; wakeUp(); pump(); });
    }
  }
  pump();

  // 串行处理
  db.exec('BEGIN');
  let inTx = 0;
  for (;;) {
    if (!queue.length) {
      if (active === 0 && qi >= todo.length) break;
      await new Promise((res) => { wake = res; setTimeout(res, 200); });
      continue;
    }
    const { f, text } = queue.shift();
    const kind = KIND(f.p);
    let rows = 0;
    try {
      const csv = parseCsv(text);
      if (csv.length > 1) {
        if (kind === 'score_range') rows = handleScoreRange(csv, f);
        else if (kind === 'school_admission') rows = handleSchoolAdm(csv);
        else if (kind === 'major_admission') rows = handleMajorAdm(csv);
        else if (kind === 'enrollment_plan') rows = handleEnrollment(csv);
      }
    } catch (e) {
      failed++; console.error(`  ✗ 解析失败 ${f.p} :: ${e.message}`);
    }
    markDone.run(f.p, rows, Date.now());
    done++; doneBytes += f.s; rowsTotal += rows;
    inTx++;
    if (inTx >= 12) { db.exec('COMMIT'); db.exec('BEGIN'); inTx = 0; }
    const el = (Date.now() - t0) / 1000;
    const eta = doneBytes > 0 ? (el / doneBytes) * (todoBytes - doneBytes) / 60 : 0;
    console.log(`  [${done}/${todo.length}] ${kind.padEnd(16)} ${(f.s / 1024).toFixed(0).padStart(6)}KB  ${String(rows).padStart(7)} 行 | 累计 ${(rowsTotal / 1e6).toFixed(2)}M 行 | ${el.toFixed(0)}s ETA ${eta.toFixed(0)}min`);
  }
  db.exec('COMMIT');

  // 落字典 & 学校表
  console.log('\n写入字典与学校表…');
  db.exec('BEGIN');
  for (const [id, t, v] of pendingDict) ins.dict.run(id, t, v);
  const schoolIdOf = new Map();
  for (const [k, id] of dmap) if (k.startsWith('school\t')) schoolIdOf.set(k.slice(7), id);
  const insSchool = db.prepare('INSERT OR REPLACE INTO school (id,name,name_id,province,nature,lv) VALUES (?,?,?,?,?,?)');
  for (const [name, info] of schoolInfo) {
    const sid = schoolIdOf.get(name);
    if (sid) insSchool.run(sid, name, sid, info.province, info.nature, info.lv);
  }
  // 招生计划去重结果落库
  console.log(`写入招生计划（去重后 ${planSeen.size} 条，原始逐行按计划数合并）…`);
  for (const v of planSeen.values()) ins.plan.run(...v);
  db.exec('COMMIT');

  console.log('\n建索引 …');
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_sr  ON score_range (p,y,c);
    CREATE INDEX IF NOT EXISTS ix_sr2 ON score_range (p,c,y,score);
    CREATE INDEX IF NOT EXISTS ix_sa  ON school_adm (p,y,c);
    CREATE INDEX IF NOT EXISTS ix_sa2 ON school_adm (sid,p,y);
    CREATE INDEX IF NOT EXISTS ix_ma  ON major_adm (p,y,c);
    CREATE INDEX IF NOT EXISTS ix_ma2 ON major_adm (sid,p,y);
    CREATE INDEX IF NOT EXISTS ix_ma3 ON major_adm (p,mid,y);
    CREATE INDEX IF NOT EXISTS ix_pc  ON plan_code (sid,p,y);
    CREATE INDEX IF NOT EXISTS ix_sc  ON school_code (sid,p,y);
    CREATE INDEX IF NOT EXISTS ix_d   ON dict (t,id);
  `);
  console.log('整理（VACUUM）…');
  db.exec('VACUUM');
  db.exec('ANALYZE');

  const st = db.prepare('SELECT (SELECT COUNT(*) FROM score_range) sr,(SELECT COUNT(*) FROM school_adm) sa,(SELECT COUNT(*) FROM major_adm) ma,(SELECT COUNT(*) FROM plan_code) pc,(SELECT COUNT(*) FROM dict) d,(SELECT COUNT(*) FROM school) s').get();
  console.log('\n═══ 结果 ═══');
  console.log(`  score_range  ${st.sr.toLocaleString()}`);
  console.log(`  school_adm   ${st.sa.toLocaleString()}`);
  console.log(`  major_adm    ${st.ma.toLocaleString()}`);
  console.log(`  plan_code    ${st.pc.toLocaleString()}`);
  console.log(`  dict         ${st.d.toLocaleString()}`);
  console.log(`  school       ${st.s.toLocaleString()}`);
  console.log(`  失败文件     ${failed}`);
  console.log(`  数据库大小   ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  总用时       ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  db.close();
})();

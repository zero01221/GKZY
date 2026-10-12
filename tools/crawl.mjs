/**
 * 数据抓取工具 —— 掌上高考（api.eol.cn）
 *
 * 用法：
 *   node tools/crawl.mjs schools
 *   node tools/crawl.mjs bulk --kind province --years 2026,2025,2024 --rate 4
 *   node tools/crawl.mjs bulk --kind special  --years 2026 --rate 4
 *   node tools/crawl.mjs school --id 104 --years 2026
 *   node tools/crawl.mjs status
 *
 * 特性：
 *   - 全局令牌桶限速，遇到 1069/异常 时全局冷却并自动降速
 *   - 断点续爬：已完整抓取的文件自动跳过，未完整的重抓
 *   - 产物 data/raw/*.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
fs.mkdirSync(RAW, { recursive: true });

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://www.gaokao.cn/',
  Origin: 'https://www.gaokao.cn',
};
const BASE = 'https://api.eol.cn/gkcx/api/';
const PAGE_SIZE = 20;      // 上游硬上限：size > 20 返回空结构
const HARD_CAP = 10000;    // 上游 numFound 硬上限

export const PROVINCES = [
  [11, '北京'], [12, '天津'], [13, '河北'], [14, '山西'], [15, '内蒙古'],
  [21, '辽宁'], [22, '吉林'], [23, '黑龙江'], [31, '上海'], [32, '江苏'],
  [33, '浙江'], [34, '安徽'], [35, '福建'], [36, '江西'], [37, '山东'],
  [41, '河南'], [42, '湖北'], [43, '湖南'], [44, '广东'], [45, '广西'],
  [46, '海南'], [50, '重庆'], [51, '四川'], [52, '贵州'], [53, '云南'],
  [54, '西藏'], [61, '陕西'], [62, '甘肃'], [63, '青海'], [64, '宁夏'], [65, '新疆'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 全局限速器 ----------------
// 实测：上游对「持续高频」会封禁，但对「短促突发」容忍度较高。
// 因此采用「突发 N 次 + 强制休息」的节流模式，长期平均速率约 1.5 req/s。
class Limiter {
  constructor(rate, burst = 200, restMs = 80000) {
    this.interval = 1000 / rate;
    this.next = 0;
    this.cooldownUntil = 0;
    this.burst = burst;
    this.restMs = restMs;
    this.count = 0;
  }
  async acquire() {
    if (this.count >= this.burst) {
      this.count = 0;
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + this.restMs);
      console.log(`  … 已连续请求 ${this.burst} 次，主动休息 ${Math.round(this.restMs / 1000)} 秒以规避封禁`);
    }
    for (;;) {
      const now = Date.now();
      const wait = Math.max(this.next - now, this.cooldownUntil - now, 0);
      if (wait <= 0) { this.next = now + this.interval; this.count++; return; }
      await sleep(Math.min(wait, 500));
    }
  }
  cooldown(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    this.interval = Math.min(this.interval * 1.25, 2000);
    this.count = Math.max(0, this.burst - 40);   // 接近休息阈值，尽快进入休息
  }
  speedUp() {
    this.interval = Math.max(this.interval * 0.998, 1000 / (Number(process.env.MAX_RATE) || 6));
  }
}

const stats = { req: 0, ok: 0, limited: 0, bad: 0, retry: 0 };
let limiter = new Limiter(4);

async function apiGet(params, { retries = 10, label = '' } = {}) {
  const url = BASE + '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  for (let i = 0; i < retries; i++) {
    await limiter.acquire();
    let j = null;
    try {
      const r = await fetch(url, { headers: HDR });
      const t = await r.text();
      stats.req++;
      try { j = JSON.parse(t); } catch { j = null; }
    } catch { j = null; }

    if (j && j.code === '0000') { stats.ok++; limiter.speedUp(); return j; }
    if (j && j.code === '1069') { stats.limited++; limiter.cooldown(4000 + i * 1500); continue; }
    if (!j) { stats.bad++; limiter.cooldown(2500 + i * 1000); continue; }
    stats.retry++;
    limiter.cooldown(1200 + i * 600);
  }
  console.error(`\n  [FAIL] ${label} ${JSON.stringify(params)}`);
  return { code: 'FAIL' };
}

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const parseList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

// ---------------- 1. 学校列表 ----------------
async function crawlSchools() {
  const out = [];
  let page = 1, numFound = Infinity;
  while (out.length < numFound && page <= 400) {
    const j = await apiGet({ uri: 'apidata/api/gkv3/school/lists', page, size: PAGE_SIZE, request_type: 1 }, { label: 'schools' });
    const items = j?.data?.item || [];
    if (page === 1) numFound = j?.data?.numFound ?? 0;
    if (!items.length) break;
    out.push(...items);
    process.stdout.write(`\r  学校列表 ${out.length}/${numFound}   `);
    page++;
  }
  fs.writeFileSync(path.join(RAW, 'schools.json'), JSON.stringify(out));
  console.log(`\n✓ schools.json  共 ${out.length} 所`);
}

// ---------------- 2. 按省批量抓取 ----------------
async function fetchProvinceYear(kind, pid, pname, year) {
  const uri = kind === 'province' ? 'apidata/api/gk/score/province' : 'apidata/api/gk/score/special';
  const file = path.join(RAW, `${kind}_${pid}_${year}.json`);

  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev.complete) return { skipped: true, n: prev.items.length, numFound: prev.numFound, complete: true };
    } catch { /* 需重抓 */ }
  }

  const byPage = new Map();
  let numFound = null;
  let cursor = 1;
  let hardFail = false;
  const cap = HARD_CAP;

  async function worker() {
    for (;;) {
      const pg = cursor++;
      if (pg > 700) return;
      if (numFound !== null && (pg - 1) * PAGE_SIZE >= Math.min(numFound, cap)) return;
      const j = await apiGet({ uri, local_province_id: pid, year, page: pg, size: PAGE_SIZE }, { label: `${kind}/${pname}/${year}` });
      if (j.code === 'FAIL') { hardFail = true; return; }
      const items = j?.data?.item || [];
      if (pg === 1) numFound = j?.data?.numFound ?? 0;
      if (items.length) byPage.set(pg, items);
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));

  const items = [...byPage.keys()].sort((a, b) => a - b).flatMap((k) => byPage.get(k));
  const target = numFound === null ? 0 : Math.min(numFound, cap);
  const complete = !hardFail && numFound !== null && target > 0 && items.length >= target;
  fs.writeFileSync(file, JSON.stringify({ kind, provinceId: pid, provinceName: pname, year, numFound: numFound ?? 0, items, complete }));
  return { skipped: false, n: items.length, numFound: numFound ?? 0, complete };
}

async function crawlBulk(kind, years, provinces, concurrency) {
  const jobs = [];
  for (const year of years) for (const [pid, pname] of provinces) jobs.push({ pid, pname, year });

  console.log(`  ${kind}: ${jobs.length} 个 省份-年份 任务，并发 ${concurrency}`);
  const t0 = Date.now();
  let done = 0;
  let idx = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const my = idx++; if (my >= jobs.length) return;
      const { pid, pname, year } = jobs[my];
      const r = await fetchProvinceYear(kind, pid, pname, year);
      done++;
      const el = (Date.now() - t0) / 1000;
      const eta = done ? (el / done) * (jobs.length - done) / 60 : 0;
      console.log(`  [${done}/${jobs.length}] ${pname.padEnd(5)} ${year} ${r.skipped ? '⏭ 跳过' : `${r.n}/${r.numFound}${r.complete ? ' ✓' : ' ⚠'}`} | 请求${stats.req} 限流${stats.limited} 异常${stats.bad} | ${el.toFixed(0)}s ETA ${eta.toFixed(0)}min`);
    }
  }));
  console.log(`\n✓ bulk ${kind} 完成，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟 | 请求 ${stats.req}，成功 ${stats.ok}，限流 ${stats.limited}，异常 ${stats.bad}`);
}

// ---------------- 3. 单校全量 ----------------
async function crawlSchool(id, years, provinces) {
  const out = { schoolId: Number(id), province: [], special: [] };
  for (const year of years) {
    for (const [pid, pname] of provinces) {
      for (const [kind, uri] of [['province', 'apidata/api/gk/score/province'], ['special', 'apidata/api/gk/score/special']]) {
        let page = 1, n = Infinity;
        const buf = [];
        while (buf.length < n && page <= 700) {
          const j = await apiGet({ uri, school_id: id, local_province_id: pid, year, page, size: PAGE_SIZE }, { label: `school/${id}` });
          const got = j?.data?.item || [];
          if (page === 1) n = j?.data?.numFound ?? 0;
          if (!got.length) break;
          buf.push(...got); page++;
        }
        if (buf.length) {
          out[kind].push(...buf.map((x) => ({ ...x, _provinceId: pid, _provinceName: pname, year: Number(year) })));
          console.log(`  ${pname} ${year} ${kind}: ${buf.length}`);
        }
      }
    }
  }
  const f = path.join(RAW, `school_${id}.json`);
  fs.writeFileSync(f, JSON.stringify(out));
  console.log(`✓ ${f}  province=${out.province.length} special=${out.special.length}`);
}

// ---------------- 4. 状态 ----------------
function status() {
  const files = fs.readdirSync(RAW);
  const rows = [];
  let total = 0, empty = 0;
  for (const f of files.filter((x) => /^(province|special)_\d+_\d+\.json$/.test(x)).sort()) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
      total += o.items.length;
      if (!o.items.length) empty++;
      rows.push({ f, n: o.items.length, numFound: o.numFound, complete: o.complete, year: o.year });
    } catch { rows.push({ f, n: -1, numFound: -1, complete: false, year: 0 }); }
  }
  console.log('== 抓取状态 ==');
  const byK = {};
  for (const r of rows) {
    const k = `${r.f.split('_')[0]}_${r.year}`;
    byK[k] = byK[k] || { files: 0, done: 0, items: 0 };
    byK[k].files++; if (r.complete) byK[k].done++; byK[k].items += Math.max(r.n, 0);
  }
  for (const k of Object.keys(byK).sort()) {
    const v = byK[k];
    console.log(`  ${k.padEnd(16)} 完整 ${String(v.done).padStart(2)}/${String(v.files).padStart(2)}  记录 ${v.items}`);
  }
  console.log(`  合计文件 ${rows.length}，总记录 ${total}，空文件 ${empty}`);
}

// ---------------- CLI ----------------
(async () => {
  const cmd = process.argv[2];
  const years = parseList(arg('years', '2026,2025,2024')).map(Number);
  const selProv = arg('provinces', '');
  const provinces = selProv ? PROVINCES.filter(([id]) => parseList(selProv).map(Number).includes(id)) : PROVINCES;
  const concurrency = Number(arg('concurrency', 3));
  limiter = new Limiter(Number(arg('rate', 4)));

  if (cmd === 'schools') await crawlSchools();
  else if (cmd === 'bulk') await crawlBulk(arg('kind', 'province'), years, provinces, concurrency);
  else if (cmd === 'school') await crawlSchool(arg('id', '104'), years, provinces);
  else if (cmd === 'status') status();
  else console.log('用法: node tools/crawl.mjs <schools|bulk|school|status> [--kind province|special] [--years 2026,2025] [--rate 4] [--concurrency 3] [--id 104] [--provinces 44,11]');
})();

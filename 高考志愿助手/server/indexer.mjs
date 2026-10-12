/**
 * 索引构建器：把某省某年的院校专业组投档线抓取并压缩为本地索引
 *  - 单工作线程顺序执行，天然限速
 *  - 支持优先级队列、进度查询、断点（已存在则跳过）
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PROVINCES, PROVINCE_NAME, INDEX_DIR, indexFile, compactProvinceRecords, saveProvinceIndex, loadProvinceIndex,
} from './data.mjs';
import { apiFetch, upstreamStatus, userBusy } from './upstream.mjs';

const state = {
  running: false,
  current: null,          // { pid, year, fetched, total }
  queue: [],
  done: [],
  errors: [],
  startedAt: null,
  pagesSinceRest: 0,
  resting: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 上游对持续高频会封禁，对短促突发容忍度高 —— 采用「突发 N 页 + 主动休息」
const BURST_PAGES = 160;
const REST_MS = 70000;

export function indexerStatus() {
  return {
    running: state.running,
    resting: state.resting,
    current: state.current,
    queue: state.queue.map((j) => ({ province: PROVINCE_NAME.get(j.pid) || j.pid, year: j.year, priority: j.priority })),
    queueLen: state.queue.length,
    doneCount: state.done.length,
    recentDone: state.done.slice(-12),
    errors: state.errors.slice(-8),
    upstream: upstreamStatus(),
  };
}

export function enqueue(pid, year, priority = 5) {
  pid = Number(pid); year = Number(year);
  if (!PROVINCE_NAME.has(pid) || !year) return false;
  const f = indexFile(pid, year);
  if (fs.existsSync(f)) return false;
  if (state.current && state.current.pid === pid && state.current.year === year) return false;
  if (state.queue.some((j) => j.pid === pid && j.year === year)) return false;
  state.queue.push({ pid, year, priority });
  state.queue.sort((a, b) => a.priority - b.priority || b.year - a.year);
  return true;
}

export function enqueueMany(list, priority = 5) {
  let n = 0;
  for (const [pid, year] of list) if (enqueue(pid, year, priority)) n++;
  return n;
}

async function runJob(job) {
  const pname = PROVINCE_NAME.get(job.pid);
  const partFile = path.join(INDEX_DIR, `.part_${job.pid}_${job.year}.json`);
  let resumeFrom = 1;
  let items = [];
  let numFound = null;
  if (fs.existsSync(partFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(partFile, 'utf8'));
      items = p.items || [];
      resumeFrom = p.nextPage || 1;
      numFound = p.numFound ?? null;
    } catch { /* 忽略损坏的断点文件 */ }
  }
  state.current = {
    pid: job.pid, year: job.year, province: pname,
    fetched: items.length, total: numFound ?? 0, startedAt: Date.now(), resumed: resumeFrom > 1,
  };
  try {
    const r = await fetchAllStreaming(
      'apidata/api/gk/score/province',
      { local_province_id: job.pid, year: job.year },
      { partFile, startPage: resumeFrom, items, numFound },
    );
    if (!r.items.length) {
      state.errors.push({ province: pname, year: job.year, message: '无数据或抓取失败' });
    } else {
      const compact = { pid: job.pid, province: pname, year: job.year, numFound: r.numFound, complete: r.complete, ...compactProvinceRecords(r.items) };
      saveProvinceIndex(job.pid, job.year, compact);
      state.done.push({ province: pname, year: job.year, rows: compact.rows.length, complete: r.complete, at: Date.now() });
      if (r.complete || r.items.length) { try { fs.unlinkSync(partFile); } catch { /* ignore */ } }
    }
  } catch (e) {
    state.errors.push({ province: pname, year: job.year, message: e.message });
  } finally {
    state.current = null;
  }
}

/** 分页抓取：支持断点续爬 + 页间主动休息以规避封禁 */
async function fetchAllStreaming(uri, params, { partFile, startPage = 1, items = [], numFound = null } = {}) {
  const all = items;
  let nf = numFound;
  let failed = false;
  const save = (nextPage) => {
    if (!partFile) return;
    try { fs.writeFileSync(partFile, JSON.stringify({ items: all, nextPage, numFound: nf })); } catch { /* ignore */ }
  };
  for (let page = startPage; page <= 700; page++) {
    // 礼让用户查询：有交互请求时暂停后台抓取
    while (userBusy()) {
      state.resting = true;
      await sleep(600);
    }
    state.resting = false;
    const j = await apiFetch(uri, { ...params, page });
    state.pagesSinceRest++;
    if (state.pagesSinceRest >= BURST_PAGES) {
      state.pagesSinceRest = 0;
      state.resting = true;
      save(page);
      await sleep(REST_MS);
      state.resting = false;
    }
    if (j.code !== '0000') { if (page === startPage) failed = true; break; }
    const got = j.data?.item || [];
    if (page === startPage && nf === null) nf = j.data?.numFound ?? 0;
    if (state.current) { state.current.total = nf ?? 0; state.current.fetched = all.length; }
    if (!got.length) break;
    all.push(...got);
    if (state.current) state.current.fetched = all.length;
    if (page % 40 === 0) save(page + 1);
    if (nf !== null && all.length >= Math.min(nf, 10000)) break;
  }
  save(700);
  return { items: all, numFound: nf ?? all.length, failed, complete: !failed && nf !== null && all.length >= Math.min(nf, 10000) };
}

export function startIndexer() {
  if (state.running) return;
  state.running = true;
  (async () => {
    while (true) {
      const job = state.queue.shift();
      if (!job) {
        state.running = false;
        return;
      }
      await runJob(job);
      await new Promise((r) => setTimeout(r, 800));
    }
  })();
}

/** 启动时自动补齐：默认只补最近一年（最相关），其余年份由用户手动触发 */
export function autoBootstrap(years = [], { all = false } = {}) {
  const nowY = new Date().getFullYear();
  const ys = years.length ? years : (all ? [nowY, nowY - 1, nowY - 2] : [nowY]);
  let n = 0;
  for (let i = 0; i < ys.length; i++) {
    for (const [pid] of PROVINCES) {
      if (!loadProvinceIndex(pid, ys[i], { fresh: true })) { if (enqueue(pid, ys[i], i + 1)) n++; }
    }
  }
  return n;
}

/** 磁盘上已有索引的概览 */
export function coverage() {
  const out = {};
  for (const f of fs.readdirSync(INDEX_DIR)) {
    const m = /^province_(\d+)_(\d+)\.json$/.exec(f);
    if (!m) continue;
    const pid = Number(m[1]), year = Number(m[2]);
    let rows = 0, complete = false;
    try { const d = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), 'utf8')); rows = d.rows?.length || 0; complete = !!d.complete; } catch { /* ignore */ }
    out[year] = out[year] || { provinces: 0, rows: 0, complete: 0, total: 31 };
    out[year].provinces++; out[year].rows += rows; if (complete) out[year].complete++;
  }
  return out;
}

/**
 * 快速抽样建索引：只抓前 N 页（约 N×20 条），让推荐功能在约 1 分钟内可用。
 * 标记 sampled=true，后台完整同步完成后会被覆盖。
 */
export async function quickIndex(pid, year, pages = 30) {
  const f = indexFile(pid, year);
  if (fs.existsSync(f)) return { ok: true, existed: true };
  const items = [];
  let numFound = null;
  for (let page = 1; page <= pages; page++) {
    const j = await apiFetch('apidata/api/gk/score/province',
      { local_province_id: pid, year, page, size: 20 }, { user: true, retries: 3 });
    if (j.code !== '0000') break;
    const got = j.data?.item || [];
    if (page === 1) numFound = j.data?.numFound ?? 0;
    if (!got.length) break;
    items.push(...got);
    if (numFound !== null && items.length >= Math.min(numFound, 10000)) break;
  }
  if (!items.length) return { ok: false, reason: '上游未返回数据（可能被限流）' };
  const compact = {
    pid, province: PROVINCE_NAME.get(pid), year, numFound,
    complete: false, sampled: true,
    ...compactProvinceRecords(items),
  };
  saveProvinceIndex(pid, year, compact);
  return { ok: true, rows: compact.rows.length, numFound, sampled: true };
}

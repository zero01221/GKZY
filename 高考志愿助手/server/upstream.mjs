/**
 * 上游数据源代理（掌上高考 api.eol.cn）
 *  - 全局令牌桶限速 + 熔断退避，避免被上游封禁
 *  - 结果落盘缓存，重复查询毫秒级返回
 */
import { cacheGet, cacheSet } from './data.mjs';

const BASE = 'https://api.eol.cn/gkcx/api/';
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://www.gaokao.cn/',
  Origin: 'https://www.gaokao.cn',
};
export const PAGE_SIZE = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const rateState = {
  interval: 400,          // 每次请求最小间隔 ms（约 2.5 req/s）
  cooldownUntil: 0,
  next: 0,
  req: 0, ok: 0, limited: 0, bad: 0,
  lastError: '',
};

/** 用户交互活动：后台抓取任务会主动礼让，保证页面查询优先 */
export const activity = { user: 0, lastUserAt: 0 };
export function userBusy() {
  return activity.user > 0 || (Date.now() - activity.lastUserAt) < 4000;
}
export function markUser() {
  activity.lastUserAt = Date.now();
}

async function acquire(user) {
  if (user) {
    // 用户请求：跳过冷却与排队，立即发送
    rateState.cooldownUntil = 0;
    rateState.next = 0;
  }
  for (;;) {
    const now = Date.now();
    const wait = user ? 0 : Math.max(rateState.next - now, rateState.cooldownUntil - now, 0);
    if (wait <= 0) { rateState.next = now + rateState.interval; return; }
    await sleep(Math.min(wait, 400));
  }
}
function cool(ms, min) {
  rateState.cooldownUntil = Math.max(rateState.cooldownUntil, Date.now() + ms);
  rateState.interval = Math.min(Math.max(rateState.interval * 1.3, min), 1500);
}
function relax() {
  // 恢复要快一些，避免被偶发限流长期拖慢
  rateState.interval = Math.max(rateState.interval * 0.88, 220);
}

export async function apiFetch(uri, params, { retries = 6, user = false } = {}) {
  const p = { uri, size: PAGE_SIZE, page: 1, ...params };
  const qs = Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = BASE + '?' + qs;
  if (user) { activity.user++; markUser(); }
  try {
    for (let i = 0; i < retries; i++) {
      await acquire(user);
      try {
        const ctl = AbortSignal.timeout(20000);
        const r = await fetch(url, { headers: HDR, signal: ctl });
        const t = await r.text();
        rateState.req++;
        if (user) markUser();
        let j = null; try { j = JSON.parse(t); } catch { j = null; }
        if (j && j.code === '0000') { rateState.ok++; relax(); return j; }
        if (j && j.code === '1069') { rateState.limited++; cool(3000 + i * 1500, 800); continue; }
        if (!j) { rateState.bad++; rateState.lastError = '上游返回非 JSON（可能被限流）'; cool(2000 + i * 1000, 600); continue; }
        rateState.lastError = `${j.code}: ${j.message}`;
        cool(800 + i * 400, 400);
      } catch (e) {
        rateState.bad++; rateState.lastError = e.message;
        cool(1500 + i * 800, 500);
      }
    }
  } finally {
    if (user) activity.user--;
  }
  return { code: 'FAIL', message: rateState.lastError || '上游请求失败' };
}

/** 拉取某条件下全部页（user=true 时视为用户交互，优先于后台任务） */
export async function fetchAll(uri, params, { maxPages = 700, onPage, user = true } = {}) {
  const all = [];
  let numFound = null;
  let failed = false;
  let partial = false;
  for (let page = 1; page <= maxPages; page++) {
    const j = await apiFetch(uri, { ...params, page }, { user });
    if (j.code !== '0000') { if (page === 1) failed = true; else partial = true; break; }
    const items = j.data?.item || [];
    if (page === 1) numFound = j.data?.numFound ?? 0;
    if (!items.length) break;
    all.push(...items);
    if (onPage) onPage(all.length, numFound);
    if (numFound !== null && all.length >= Math.min(numFound, 10000)) break;
    if (page === maxPages) partial = true;
  }
  return {
    items: all, numFound: numFound ?? all.length, failed, partial,
    complete: !failed && !partial && numFound !== null && all.length >= Math.min(numFound, 10000),
  };
}

// ------------------------------------------------------------------
// 高分封装（带缓存；失败结果不缓存）
// ------------------------------------------------------------------
const TTL = 1000 * 60 * 60 * 24 * 7;   // 7 天
const USER_MAX_PAGES = 70;             // 单次用户查询最多抓 70 页（1400 条），避免长时间等待

async function cached(key, producer) {
  const hit = cacheGet(key);
  if (hit && Date.now() - (hit.at || 0) < TTL) return { ...hit.value, cached: true };
  const value = await producer();
  if (!value.failed) cacheSet(key, { at: Date.now(), value });
  return { ...value, cached: false };
}

/** 某校在某省的院校专业组投档线 */
export async function schoolProvinceScores(schoolId, provinceId, year) {
  const key = `ps_${schoolId}_${provinceId}_${year}`;
  return cached(key, async () => {
    const r = await fetchAll('apidata/api/gk/score/province', { school_id: schoolId, local_province_id: provinceId, year }, { maxPages: USER_MAX_PAGES, user: true });
    return { items: r.items, numFound: r.numFound, failed: r.failed, partial: r.partial, complete: r.complete };
  });
}

/** 某校在某省的专业录取分数线 */
export async function schoolSpecialScores(schoolId, provinceId, year) {
  const key = `ss_${schoolId}_${provinceId}_${year}`;
  return cached(key, async () => {
    const r = await fetchAll('apidata/api/gk/score/special', { school_id: schoolId, local_province_id: provinceId, year }, { maxPages: USER_MAX_PAGES, user: true });
    return { items: r.items, numFound: r.numFound, failed: r.failed, partial: r.partial, complete: r.complete };
  });
}

/** 某校在某省的全部年份（一次调用返回最新年份，多年度分别取） */
export async function schoolMultiYear(kind, schoolId, provinceId, years) {
  const out = {};
  for (const y of years) {
    const r = kind === 'special'
      ? await schoolSpecialScores(schoolId, provinceId, y)
      : await schoolProvinceScores(schoolId, provinceId, y);
    out[y] = r.items || [];
  }
  return out;
}

export function upstreamStatus() {
  return {
    interval: Math.round(rateState.interval),
    cooling: Math.max(0, rateState.cooldownUntil - Date.now()),
    req: rateState.req, ok: rateState.ok, limited: rateState.limited, bad: rateState.bad,
    lastError: rateState.lastError,
  };
}

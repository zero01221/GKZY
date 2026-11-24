/**
 * 服务端本地 JSON 存储：生成记录 / 草稿 / 收藏。
 * Node 单进程下全部使用同步读-改-原子写（tmp + rename），无需额外锁。
 * 纯本地数据，不上传、不同步。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data.mjs';

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const WISHLIST_FILE = path.join(DATA_DIR, 'wishlist.json');

function nextId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function readArray(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(txt);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function wishMergeKey(item) {
  return `${item?.schoolId ?? ''}|${String(item?.extra || item?.major || '').trim()}`;
}

const byNewest = (a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || ''));

/* ---------------- 生成历史 ---------------- */

export function listHistory() {
  return readArray(HISTORY_FILE).slice().sort(byNewest);
}

export function addHistory(rec) {
  const now = new Date().toISOString();
  const slots = Array.isArray(rec?.slots) ? rec.slots : [];
  const item = {
    id: nextId('h'),
    createdAt: now,
    updatedAt: now,
    meta: rec?.meta || {},
    slots,
    context: rec?.context || {},
    slotCount: slots.length,
  };
  const all = readArray(HISTORY_FILE);
  all.push(item);
  atomicWrite(HISTORY_FILE, all);
  return item;
}

export function getHistory(id) {
  return readArray(HISTORY_FILE).find((x) => x.id === id) || null;
}

export function deleteHistory(id) {
  const all = readArray(HISTORY_FILE);
  const kept = all.filter((x) => x.id !== id);
  if (kept.length === all.length) return false;
  atomicWrite(HISTORY_FILE, kept);
  return true;
}

/* ---------------- 草稿箱 ---------------- */

export function listDrafts() {
  return readArray(DRAFTS_FILE).slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function addDraft(d) {
  const now = new Date().toISOString();
  const item = {
    id: nextId('d'),
    name: d?.name || '普通类平行志愿',
    createdAt: now,
    updatedAt: now,
    sourceHistoryId: d?.sourceHistoryId || null,
    rows: Array.isArray(d?.rows) ? d.rows : [],
  };
  const all = readArray(DRAFTS_FILE);
  all.push(item);
  atomicWrite(DRAFTS_FILE, all);
  return item;
}

export function getDraft(id) {
  return readArray(DRAFTS_FILE).find((x) => x.id === id) || null;
}

export function updateDraft(id, patch) {
  const all = readArray(DRAFTS_FILE);
  const idx = all.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const old = all[idx];
  all[idx] = {
    ...old,
    name: patch?.name != null ? String(patch.name) : old.name,
    rows: Array.isArray(patch?.rows) ? patch.rows : old.rows,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(DRAFTS_FILE, all);
  return all[idx];
}

export function deleteDraft(id) {
  const all = readArray(DRAFTS_FILE);
  const kept = all.filter((x) => x.id !== id);
  if (kept.length === all.length) return false;
  atomicWrite(DRAFTS_FILE, kept);
  return true;
}

/* ---------------- 收藏 ---------------- */

export function listWishlist() {
  return readArray(WISHLIST_FILE);
}

/** 同 mergeKey 已存在则返回原记录并标记 duplicated。 */
export function addWishlist(item) {
  const all = readArray(WISHLIST_FILE);
  const mergeKey = wishMergeKey(item);
  const existing = all.find((x) => wishMergeKey(x) === mergeKey);
  if (existing) return { item: existing, duplicated: true };
  const rec = {
    id: nextId('w'),
    key: String(item?.key || mergeKey),
    mergeKey,
    type: String(item?.type || ''),
    school: String(item?.school || ''),
    schoolId: Number(item?.schoolId) || 0,
    year: item?.year ? Number(item.year) : undefined,
    extra: item?.extra ? String(item.extra) : undefined,
    major: item?.major ? String(item.major) : undefined,
    createdAt: new Date().toISOString(),
  };
  all.push(rec);
  atomicWrite(WISHLIST_FILE, all);
  return { item: rec, duplicated: false };
}

/** 批量导入：服务端按 mergeKey 再次幂等去重。 */
export function importWishlist(items) {
  const all = readArray(WISHLIST_FILE);
  const seen = new Set(all.map(wishMergeKey));
  let added = 0;
  let skipped = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const mergeKey = wishMergeKey(raw);
    if (!raw || !mergeKey || seen.has(mergeKey)) { skipped++; continue; }
    seen.add(mergeKey);
    all.push({
      id: nextId('w'),
      key: String(raw.key || mergeKey),
      mergeKey,
      type: String(raw.type || ''),
      school: String(raw.school || ''),
      schoolId: Number(raw.schoolId) || 0,
      year: raw.year ? Number(raw.year) : undefined,
      extra: raw.extra ? String(raw.extra) : undefined,
      major: raw.major ? String(raw.major) : undefined,
      createdAt: new Date().toISOString(),
    });
    added++;
  }
  if (added) atomicWrite(WISHLIST_FILE, all);
  return { added, skipped, items: all };
}

export function deleteWishlist(key) {
  const all = readArray(WISHLIST_FILE);
  const kept = all.filter((x) => x.key !== key && x.mergeKey !== key);
  if (kept.length === all.length) return false;
  atomicWrite(WISHLIST_FILE, kept);
  return true;
}

export function clearWishlist() {
  atomicWrite(WISHLIST_FILE, []);
  return true;
}

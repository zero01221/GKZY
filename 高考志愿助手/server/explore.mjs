/**
 * 高考志愿助手 · 探索查询（只读）
 *
 * 为 v3「一分一档表」与「院校查询三级」提供 6 个只读查询函数。
 * 全部经 gcdb.mjs 的 open()/raw() 只读连接与字典，不修改 gcdb.mjs 及任何原始数据。
 *
 * 关键约束（见 ui-v3-architecture.md §4）：
 *   - 科类归一化只用本文件的 categoryOf/codesOf；禁止用 cnameOf 生成前端科类
 *     （cnameOf(0)=null、cnameOf(1)='<NA>'，会把 2020–2024 数据整组丢失）。
 *   - 一分一档行顺序固定 [score, cum, seg]（分数 / 累计人数 / 本段人数）。
 *   - 结果不含 admit/录取人数字段（major_adm 表根本没有该列）。
 *   - 院校 id 一律用 gcdb 库内 school.id（sid）。
 */
import { open, raw, toDictPid, mnameOf, bnameOf, gnameOf } from './gcdb.mjs';

/** 对外标准省码：河北固定 13。 */
export const PROVINCE_ID = 13;

/** 科类展示排序：物理类在前，历史类次之，理科/文科兜底。 */
const TYPE_ORDER = { 物理类: 0, 历史类: 1, 理科: 2, 文科: 3 };

/**
 * 库内科类编码 -> 前端科类字符串（确定性映射，铁证见设计文档 §4）。
 * @param {number} c score_range.c / major_adm.c
 * @returns {string|null} 科类名；未知编码返回 null（不展示）
 */
export function categoryOf(c) {
  const code = Number(c);
  if (code === 0 || code === 3) return '物理类';
  if (code === 1 || code === 4) return '历史类';
  if (code === 5) return '理科';
  if (code === 6) return '文科';
  return null;
}

/**
 * 前端科类字符串 -> 库内编码集合（同时覆盖早期 0/1 与近年 3/4）。
 * @param {string} type 科类名
 * @returns {number[]} 编码数组；未知科类返回空数组
 */
export function codesOf(type) {
  if (type === '物理类') return [0, 3];
  if (type === '历史类') return [1, 4];
  if (type === '理科') return [5];
  if (type === '文科') return [6];
  return [];
}

/** 打开只读库并返回连接句柄。 */
function db() {
  open();
  return raw();
}

/** 安全的正整数分页参数。 */
function pageOf(v, def = 1) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def;
}
function sizeOf(v, def = 30, max = 100) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : def;
}

/**
 * 端点 1：河北一分一档可用年份与科类（由 DISTINCT y,c 生成，倒序、科类固定排序）。
 * @param {number} pid 标准省份码（13）
 * @returns {Array<{year:number, types:string[]}>}
 */
export function scoreRangeYears(pid) {
  const conn = db();
  const p = toDictPid(pid);   // 必须先 open() 载入字典，否则 13 无法换算为库内 18
  const rows = conn.prepare('SELECT DISTINCT y, c FROM score_range WHERE p=? ORDER BY y DESC').all(p);
  const map = new Map();
  for (const r of rows) {
    const t = categoryOf(r.c);
    if (!t) continue;                       // 未知科类不展示，避免 <NA> 泄漏到前端
    if (!map.has(r.y)) map.set(r.y, new Set());
    map.get(r.y).add(t);
  }
  return [...map.entries()].map(([year, set]) => ({
    year: Number(year),
    types: [...set].sort((a, b) => (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99)),
  }));
}

/**
 * 端点 2：某年某科类完整一分一档分段表（分数降序）。
 * @param {number} pid 标准省份码
 * @param {number|string} year 年份
 * @param {string} type 科类
 * @returns {{rows:Array<[number,number,number]>, count:number, total:number, gaps:Array<number[]>, full:boolean}|null}
 */
export function scoreRangeTable(pid, year, type) {
  const conn = db();
  const p = toDictPid(pid);
  const codes = codesOf(type);
  if (!codes.length) return null;
  const rows = conn.prepare(
    'SELECT score, cum, seg FROM score_range WHERE p=? AND y=? AND c IN (?,?) ORDER BY score DESC'
  ).all(p, Number(year), codes[0], codes[1] ?? codes[0]);
  if (!rows.length) return null;
  const flat = rows.map((r) => [Number(r.score), Number(r.cum), Number(r.seg)]);
  const gaps = [];
  for (let i = 1; i < flat.length; i++) {
    if (flat[i - 1][0] - flat[i][0] > 1) gaps.push([flat[i - 1][0] - 1, flat[i][0] + 1]);
  }
  return {
    rows: flat,
    count: flat.length,
    total: flat[flat.length - 1][1],
    gaps,
    full: gaps.length === 0,
  };
}

/**
 * 端点 3：分数 -> 位次（累计人数）。
 *   - 命中表内任意分数行 exact:true（含最低分边界，如 2026 物理类 140）；
 *   - 落在缺分段：保守取分数更高一档（降序数组中下一个满足 s>=score 的行）的 cum，exact:false；
 *   - 超上/下界：取边界行 cum，exact:false；不插值、不编造。
 * @param {number} pid 标准省份码
 * @param {number|string} year 年份
 * @param {string} type 科类
 * @param {number|string} score 分数
 * @returns {{score:number, seg:number, cum:number, exact:boolean}|null}
 */
export function scoreRangeRank(pid, year, type, score) {
  const table = scoreRangeTable(pid, year, type);
  if (!table) return null;
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const ser = table.rows;
  const top = ser[0];
  const bot = ser[ser.length - 1];
  if (s > top[0]) return { score: s, seg: top[2], cum: top[1], exact: false };
  if (s < bot[0]) return { score: s, seg: bot[2], cum: bot[1], exact: false };
  // 先判精确命中（含最低分所在行），避免最低分被越界分支误标为估算
  for (const row of ser) {
    if (s === row[0]) return { score: s, seg: row[2], cum: row[1], exact: true };
  }
  // 缺分段：降序表中找第一个 score <= s 的行，取其 cum（更保守的位次）
  for (let i = 1; i < ser.length; i++) {
    if (s >= ser[i][0]) {
      const hit = ser[i];
      return { score: s, seg: hit[2], cum: hit[1], exact: false };
    }
  }
  return null;
}

/**
 * 端点 4：有河北 major_adm 录取记录的学校列表（可搜索、分页）。
 * @param {number} pid 标准省份码
 * @param {string} q 校名关键词
 * @param {number} page 页码（从 1 起）
 * @param {number} size 每页条数（上限 100）
 * @returns {{total:number, page:number, size:number, items:Array<object>}}
 */
export function admittedColleges(pid, q = '', page = 1, size = 30) {
  const conn = db();
  const p = toDictPid(pid);
  const key = String(q || '').trim();
  const base = 'FROM school s WHERE s.id IN (SELECT DISTINCT sid FROM major_adm WHERE p=?)';
  const args = [p];
  let nameCond = '';
  if (key) {
    nameCond = ' AND s.name LIKE ?';
    args.push('%' + key + '%');
  }
  const total = conn.prepare(`SELECT COUNT(*) c ${base}${nameCond}`).get(...args).c;
  const pg = pageOf(page);
  const sz = sizeOf(size);
  const items = conn.prepare(
    `SELECT s.id, s.name, s.nature, s.lv ${base}${nameCond} ORDER BY s.id LIMIT ? OFFSET ?`
  ).all(...args, sz, (pg - 1) * sz);
  return { total, page: pg, size: sz, items };
}

/**
 * 端点 5：某校可用筛选项。地区按主理人拍板固定仅河北一项。
 * @param {number} pid 标准省份码
 * @param {number} sid gcdb 库内 school.id
 * @returns {object|null} 院校不存在返回 null
 */
export function collegeFilters(pid, sid) {
  const conn = db();
  const p = toDictPid(pid);
  const id = Number(sid);
  const schoolRow = conn.prepare('SELECT id, name, nature, lv FROM school WHERE id=?').get(id);
  if (!schoolRow) return null;
  const rows = conn.prepare('SELECT DISTINCT y, c, mid FROM major_adm WHERE p=? AND sid=?').all(p, id);
  const years = [...new Set(rows.map((r) => Number(r.y)))].sort((a, b) => b - a);
  const typeSet = new Set();
  const majorMap = new Map();
  for (const r of rows) {
    const t = categoryOf(r.c);
    if (t) typeSet.add(t);
    if (!majorMap.has(r.mid)) majorMap.set(r.mid, mnameOf(r.mid) || String(r.mid));
  }
  const types = [...typeSet].sort((a, b) => (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99));
  const majors = [...majorMap.entries()]
    .map(([id_, name]) => ({ id: Number(id_), name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  return {
    school: { id: schoolRow.id, name: schoolRow.name, nature: schoolRow.nature, lv: schoolRow.lv },
    regions: [{ id: PROVINCE_ID, name: '河北' }],
    years,
    types,
    majors,
  };
}

/**
 * 端点 6：某校某年各专业录取行（含计划数，无录取人数字段）。
 *   planNum 来自 plan_info.cnt（瘦库无年份维度，按 sid+mid LEFT JOIN）。
 * @param {number} pid 标准省份码
 * @param {number} sid gcdb 库内 school.id
 * @param {number|string} year 年份
 * @param {string} type 科类（可选；归一化走 codesOf）
 * @param {string} major 专业名关键词（可选；对 dict 专业名 LIKE）
 * @param {number} page 页码
 * @param {number} size 每页条数
 * @returns {{total:number, page:number, size:number, items:Array<object>}}
 */
export function collegeMajorRows(pid, sid, year, type = '', major = '', page = 1, size = 30) {
  const conn = db();
  const p = toDictPid(pid);
  const args = [p, Number(sid), Number(year)];
  let extra = '';
  const codes = type ? codesOf(type) : [];
  if (codes.length) {
    extra += ` AND ma.c IN (${codes.map(() => '?').join(',')})`;
    args.push(...codes);
  }
  const key = String(major || '').trim();
  if (key) {
    extra += ' AND m.v LIKE ?';
    args.push('%' + key + '%');
  }
  const from = `FROM major_adm ma
    LEFT JOIN dict m ON m.t='major' AND m.id=ma.mid
    LEFT JOIN plan_info pi ON pi.sid=ma.sid AND pi.mid=ma.mid
    WHERE ma.p=? AND ma.sid=? AND ma.y=?${extra}`;
  const total = conn.prepare(`SELECT COUNT(*) c ${from}`).get(...args).c;
  const pg = pageOf(page);
  const sz = sizeOf(size);
  const rows = conn.prepare(
    `SELECT ma.mid, m.v AS mname, ma.min, ma.rnk, ma.c, ma.b, ma.grp, pi.cnt AS planNum
     ${from} ORDER BY ma.min ASC, ma.rnk ASC LIMIT ? OFFSET ?`
  ).all(...args, sz, (pg - 1) * sz);
  const items = rows.map((r) => ({
    major: r.mname || String(r.mid ?? '—'),
    min: r.min ?? null,
    rank: r.rnk ?? null,
    planNum: r.planNum ?? null,
    type: categoryOf(r.c) || '',
    batch: bnameOf(r.b) || '',
    group: gnameOf(r.grp) || '',
  }));
  return { total, page: pg, size: sz, items };
}

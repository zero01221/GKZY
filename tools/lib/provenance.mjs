/**
 * 构建期溯源工具（零第三方依赖）
 * 仅用于开发侧，产物 data/gc/provenance.json 不随包；
 * 真正随包的是 verify_gcdb.mjs 烘焙进 gaokao.db 的小表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROVINCES } from '../../高考志愿助手/server/data.mjs';
import { TABLE_SOURCE } from '../../高考志愿助手/server/quality-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const PROVENANCE_FILE = path.join(ROOT, 'data', 'gc', 'provenance.json');

/** 库内省名别名：与 server/gcdb.mjs 的 PROVINCE_ALIAS 同口径（内蒙 -> 内蒙古，标准码 15） */
export const PROVINCE_ALIAS = new Map([['内蒙', '内蒙古']]);
const NAME2STD = new Map(PROVINCES.map(([id, name]) => [name, Number(id)]));
const STD_IDS = new Set(PROVINCES.map(([id]) => Number(id)));
for (const [alias, std] of PROVINCE_ALIAS) {
  if (NAME2STD.has(std) && !NAME2STD.has(alias)) NAME2STD.set(alias, NAME2STD.get(std));
}

/**
 * 表级来源的出处与协议（取自 README「数据说明」，不臆造接口或许可证）。
 * 注意：provenance.source 字符串本身一律取 quality-core.mjs 的 TABLE_SOURCE，
 * 不得另造，避免开发侧台账与运行时/构建期的表级来源漂移。
 */
export const SOURCE_URLS = {
  compass: 'https://github.com/choucisan/GaokaoCompass',
  vault: 'https://github.com/lifefloating/gaokao-vault',
  eol: 'https://www.gaokao.cn',
};
export const SOURCE_LICENSE = { compass: 'MIT', vault: 'Apache-2.0', eol: null };

/**
 * 把库内字典值 / 上游 CSV 省名归一成 31 省标准码。
 * 支持：标准码直传、标准名、自治区/省/市后缀、内蒙别名。
 * @param {string|number} name 省名或标准省码
 * @returns {number} 标准省码；无法识别返回 0（不猜、不伪造）
 */
export function standardPid(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return 0;
  if (STD_IDS.has(Number(raw))) return Number(raw);
  if (NAME2STD.has(raw)) return NAME2STD.get(raw);
  const norm = raw.replace(/(维吾尔|壮族|回族|特别行政区|自治区|省|市)/g, '').trim();
  if (NAME2STD.has(norm)) return NAME2STD.get(norm);
  for (const [std, n] of PROVINCES) {
    if (norm.includes(n) || raw.includes(n)) return Number(std);
  }
  return 0;
}

export function sha256File(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}
export function sha256Rows(rows) {
  const h = createHash('sha256');
  h.update(JSON.stringify(rows));
  return h.digest('hex');
}
export function sha256Text(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/**
 * 记录一个「省-年-表」单元格的来源。
 * @param {{table:string,p:number,y:number,source:string,sourceUrl?:string,license?:string,
 *          publishedAt?:string,sampled?:boolean,complete?:boolean,rows?:number}} cell
 * @param {string} [file=PROVENANCE_FILE] 台账文件路径；传临时路径即可脱离真实台账独立验证
 * @param {{preserveSampling?:boolean}} [options] 写入选项：
 *   preserveSampling=true 且命中既有 sampled=1 记录时，保留既有 sampled/complete 标记位，
 *   仅更新 rows/ingestedAt 等其余字段；默认 false，保持原有的幂等覆盖语义。
 * @returns {object} 实际落盘的记录
 */
export function appendProvenance(cell, file = PROVENANCE_FILE, options = {}) {
  let store = { schemaVersion: 1, cells: [] };
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次创建 */ }
  if (!Array.isArray(store.cells)) store.cells = [];
  const rec = {
    table: cell.table, p: Number(cell.p) || 0, y: Number(cell.y) || 0,
    source: cell.source || 'unknown',
    sourceUrl: cell.sourceUrl || null, license: cell.license || null,
    publishedAt: cell.publishedAt || null,
    ingestedAt: new Date().toISOString(),
    sampled: cell.sampled ? 1 : 0,
    complete: cell.complete === false ? 0 : 1,
    rows: Number(cell.rows) || 0,
  };
  const key = (x) => `${x.table}|${x.p}|${x.y}|${x.source}`;
  const i = store.cells.findIndex((x) => key(x) === key(rec));
  if (i >= 0) {
    // BugFix #1：可选「保留既有抽样标记」。默认关闭，原有幂等覆盖语义完全不变；
    // 仅 build_gc_db.mjs 的批量合并写入（writeBuildProvenance）显式启用，
    // 避免把后续导入脚本写入的 sampled=1/complete=0 覆盖回「完整」。
    const prev = store.cells[i];
    if (options && options.preserveSampling && Number(prev.sampled) === 1) {
      rec.sampled = 1;
      rec.complete = Number(prev.complete) === 0 ? 0 : 1;
    }
    store.cells[i] = rec;
  } else store.cells.push(rec);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 1));
  return rec;
}

/**
 * build_gc_db.mjs 的台账「合并写入」口径（纯逻辑入口，可独立于 CLI 主流程验证）。
 *
 * 口径来源：build_gc_db.mjs 从已落库主表按 (表,省,年) 聚合后逐单元格写台账——
 *   source 一律取 quality-core.mjs 的 TABLE_SOURCE（与 import_vault / import_legacy_index /
 *   parse_rank_multi / slim_gcdb 四个调用方同口径，不得另造）；
 *   sourceUrl / license 取 GaokaoCompass 历史库；默认 flags 为 sampled:false / complete:true。
 *
 * BugFix #1（抽样标记口径漂移）：这批是 2017–2025 历史库的批量合并写入，但同一
 *   (表,省,年,来源) 单元格可能已由 import_legacy_index.mjs 等「后续导入」写入更精确的
 *   抽样标记（如河北 2026 的 school_adm / major_adm 为 eol.cn 后台抽样 sampled=1 /
 *   complete=0）。因 appendProvenance 的幂等 key 完全相同，无条件覆盖会把抽样标记改回
 *   「完整」，在非标准重跑顺序下误导 verify_gcdb.mjs 的 sampled 判定。
 *   故这里显式启用 preserveSampling：命中既有 sampled=1 记录时保留其抽样/未完成标记，
 *   仅更新 rows 等其余字段。y<=2025 的普通单元格（既有 sampled=0）不受影响，
 *   仍按默认 flags 正常幂等覆盖，行为与修复前一致。
 *   口径同源：import_legacy_index.mjs L162-197 / verify_gcdb.mjs L354-359（Q6 定稿）。
 *
 * @param {Array<{table:string,p:number,y:number,rows?:number,source?:string}>} cells
 *   聚合后的「表-省-年」单元格；source 省略时统一取 TABLE_SOURCE[table]。
 * @param {string} [file=PROVENANCE_FILE] 台账文件路径；QA 传系统临时目录下的 json 即可。
 * @returns {number} 实际写入的单元格数
 */
export function writeBuildProvenance(cells, file = PROVENANCE_FILE) {
  const list = Array.isArray(cells) ? cells : [];
  let written = 0;
  for (const c of list) {
    if (!c || !c.table) continue;
    const p = Number(c.p) || 0, y = Number(c.y) || 0;
    // 与 build_gc_db.mjs 聚合循环的 `if (!std || !Number(r.y)) continue` 同口径
    if (!p || !y) continue;
    appendProvenance({
      table: c.table, p, y,
      source: c.source || TABLE_SOURCE[c.table],
      sourceUrl: SOURCE_URLS.compass, license: SOURCE_LICENSE.compass,
      sampled: false, complete: true, rows: Number(c.rows) || 0,
    }, file, { preserveSampling: true });
    written++;
  }
  return written;
}

export function readProvenance(file = PROVENANCE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { schemaVersion: 1, cells: [] }; }
}

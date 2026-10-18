/**
 * 冲 / 稳 / 保 推荐引擎
 *
 * 两种定位方式：
 *   - 按位次（最准）：用户输入全省位次，与院校专业组近 N 年最低位次比较
 *   - 按分数（默认）：线差法 —— 用户线差 = 分数 − 该批次省控线；
 *                     院校线差 = 最低分 − 当年省控线（数据自带 proscore 字段）；
 *                     两者直接可比，无需一分一段表
 *
 * 概率模型：以历史波动为尺度构造正态分布，P = Φ(z)
 * 分档：冲 P < 45% ≤ 稳 P < 80% ≤ 保
 */
import {
  PROVINCE_NAME, getSchool,
} from './data.mjs';
import {
  provinceIndex as loadProvinceIndex, indexedYears, batchLines as getBatchLines,
} from './gcsource.mjs';
import { schoolSpecialScores } from './upstream.mjs';

const WEIGHTS = [1.0, 0.7, 0.5, 0.35, 0.2];

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => (a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0);

function referenceYears(pid, maxYears = 3) {
  const nowY = new Date().getFullYear();
  return indexedYears(pid).filter((y) => y <= nowY + 1).slice(0, maxYears);
}

export async function recommend({ provinceId, type, score, rank, major = '', batch = '', limit = 45, year = null }) {
  const pid = Number(provinceId);
  if (!pid) throw new Error('缺少省份');
  const pname = PROVINCE_NAME.get(pid) || String(pid);

  const years = referenceYears(pid, 3);
  if (!years.length) {
    const e = new Error(`本地暂无「${pname}」的分数线索引。请到「数据管理」页同步该省数据，或换一个已有数据的省份。`);
    e.code = 'NO_INDEX';
    throw e;
  }
  const primaryYear = year && years.includes(Number(year)) ? Number(year) : years[0];

  // ---- 科类 ----
  const allTypes = new Set();
  for (const y of years) {
    const ix = loadProvinceIndex(pid, y);
    (ix?.dict?.type || []).forEach((t) => t && allTypes.add(t));
  }
  const typeList = [...allTypes];
  let typeName = type;
  if (typeName && !typeList.includes(typeName)) {
    const map = { 理科: ['物理类', '理科', '综合'], 文科: ['历史类', '文科', '综合'], 综合: ['综合'], 物理类: ['物理类'], 历史类: ['历史类'] };
    const cands = map[typeName] || [typeName];
    typeName = cands.find((c) => typeList.includes(c)) || typeList.find((t) => cands.some((c) => t.includes(c))) || typeList[0];
  } else if (!typeName) typeName = typeList[0];

  // ---- 批次 ----
  let batchFilter = batch;
  if (!batchFilter) {
    const names = new Set();
    for (const y of years) (loadProvinceIndex(pid, y)?.dict?.batch || []).forEach((b) => b && names.add(b));
    if ([...names].some((b) => b.includes('本科批'))) batchFilter = '本科批';
    else if ([...names].some((b) => b.includes('本科'))) batchFilter = '本科';
  }

  // ---- 汇总招生单元 ----
  const units = new Map();
  for (const y of years) {
    const ix = loadProvinceIndex(pid, y);
    if (!ix) continue;
    const ti = ix.dict.type.indexOf(typeName);
    if (ti < 0) continue;
    for (const r of ix.rows) {
      if (r[1] !== ti) continue;
      const batchName = ix.dict.batch[r[2]] || '';
      if (batchFilter && batchName && !batchName.includes(batchFilter)) continue;
      if (r[4] < 100) continue;
      const key = `${r[0]}#${r[2]}#${r[3]}`;
      if (!units.has(key)) units.set(key, { schoolId: r[0], groupIdx: r[3], batchIdx: r[2], subjIdx: r[7], hist: [] });
      const hist = units.get(key).hist;
      if (!hist.some((h) => h.year === y)) hist.push({ year: y, min: r[4], rank: r[5], line: r[6] });
    }
  }
  if (!units.size) {
    const e = new Error(`「${pname} · ${typeName}」暂无可用于推荐的招生记录（批次：${batchFilter || '全部'}）`);
    e.code = 'NO_DATA';
    throw e;
  }

  const batchLines = getBatchLines(pid, primaryYear);
  const batchLineOf = (batchName) => batchLines[`${typeName}|${batchName}`] || batchLines[`${typeName}|${batchFilter}`] || 0;

  const useRank = Number(rank) > 0;
  const userRank = useRank ? Number(rank) : null;
  const userScore = Number(score) > 0 ? Number(score) : null;
  // 线差法基准：取最常见的本科批省控线
  const baseLine = batchLineOf(batchFilter) || Object.entries(batchLines).find(([k]) => k.startsWith(typeName))?.[1] || 0;
  if (!useRank && (!userScore || !baseLine)) {
    const e = new Error(!userScore
      ? '请输入分数或位次'
      : `缺少「${pname} · ${typeName}」的省控线数据，无法使用线差法，请改用「按位次」输入`);
    e.code = 'NO_RANK';
    throw e;
  }
  const userDiff = useRank ? null : userScore - baseLine;

  // ---- 逐单元计算概率 ----
  const cands = [];
  for (const u of units.values()) {
    const sorted = u.hist.slice().sort((a, b) => b.year - a.year);
    const wOf = (i) => WEIGHTS[i] ?? 0.2;

    let prob = null, baseRank = null, baseDiff = null, metric = 0, metricStd = 1;

    if (useRank) {
      const wr = sorted.filter((h) => h.rank > 0);
      if (!wr.length) continue;
      let ws = 0, rs = 0;
      wr.forEach((h, i) => { ws += wOf(i); rs += h.rank * wOf(i); });
      baseRank = rs / ws;
      const s = std(wr.map((h) => h.rank));
      const sigma = Math.max(s, baseRank * 0.10, 60);
      prob = clamp(normalCdf((baseRank - userRank) / sigma), 0.02, 0.98);
      metric = baseRank; metricStd = sigma;
    } else {
      const wd = sorted.filter((h) => h.line > 0);
      if (!wd.length) continue;
      let ws = 0, ds = 0;
      wd.forEach((h, i) => { ws += wOf(i); ds += (h.min - h.line) * wOf(i); });
      baseDiff = ds / ws;
      const s = std(wd.map((h) => h.min - h.line));
      const sigma = Math.max(s, 8);
      prob = clamp(normalCdf((userDiff - baseDiff) / sigma), 0.02, 0.98);
      metric = baseDiff; metricStd = sigma;
      const wr = sorted.filter((h) => h.rank > 0);
      if (wr.length) {
        let ws2 = 0, rs2 = 0;
        wr.forEach((h, i) => { ws2 += wOf(i); rs2 += h.rank * wOf(i); });
        baseRank = rs2 / ws2;
      }
    }

    const latest = sorted[0];
    cands.push({
      schoolId: u.schoolId, groupIdx: u.groupIdx, batchIdx: u.batchIdx, subjIdx: u.subjIdx,
      baseRank: baseRank == null ? null : Math.round(baseRank),
      baseDiff: baseDiff == null ? null : Math.round(baseDiff * 10) / 10,
      latestMin: latest.min, latestRank: latest.rank, latestYear: latest.year, latestLine: latest.line,
      hist: sorted.slice().sort((a, b) => a.year - b.year).map((h) => ({ year: h.year, min: h.min, rank: h.rank, line: h.line })),
      prob, metric, metricStd,
      years: sorted.length,
      spread: metricStd / Math.max(1, Math.abs(metric)),
    });
  }

  const tierOf = (p) => (p >= 0.80 ? 'bao' : p >= 0.45 ? 'wen' : 'chong');
  const tiers = { chong: [], wen: [], bao: [] };
  for (const c of cands) tiers[tierOf(c.prob)].push(c);
  tiers.chong.sort((a, b) => b.prob - a.prob);
  tiers.wen.sort((a, b) => a.prob - b.prob);
  tiers.bao.sort((a, b) => a.prob - b.prob);

  const per = Math.max(6, Math.ceil(limit / 3));
  const decorate = (c) => {
    const s = getSchool(c.schoolId);
    const ix = loadProvinceIndex(pid, primaryYear);
    return {
      school: s
        ? { id: s.id, name: s.name, province: s.province, city: s.city, level: s.level, type: s.type, nature: s.nature, f985: s.f985, f211: s.f211, dual: s.dual }
        : { id: c.schoolId, name: `#${c.schoolId}`, f985: false, f211: false, dual: '' },
      group: ix?.dict?.group?.[c.groupIdx] ?? '',
      batch: ix?.dict?.batch?.[c.batchIdx] ?? '',
      subjectReq: ix?.dict?.subj?.[c.subjIdx] ?? '',
      probability: Math.round(c.prob * 100),
      baseRank: c.baseRank,
      baseDiff: c.baseDiff,
      latestMin: c.latestMin, latestRank: c.latestRank, latestYear: c.latestYear, latestLine: c.latestLine,
      diffGap: c.baseDiff == null || userDiff == null ? null : Math.round((userDiff - c.baseDiff) * 10) / 10,
      rankGap: c.baseRank == null || !useRank ? null : Math.round(c.baseRank - userRank),
      years: c.years,
      stable: c.spread < 0.15,
      hist: c.hist,
      reason: buildReason(c, s, { useRank, userRank, userDiff, userScore }),
    };
  };

  const result = {
    ok: true,
    meta: {
      province: pname, provinceId: pid, type: typeName, typeOptions: typeList,
      mode: useRank ? 'rank' : 'diff',
      userScore: userScore ?? null,
      userRank: useRank ? userRank : null,
      baseLine, userDiff,
      primaryYear, refYears: years, batch: batchFilter || '全部',
      candidates: units.size,
    },
    tiers: {
      chong: tiers.chong.slice(0, per).map(decorate),
      wen: tiers.wen.slice(0, per).map(decorate),
      bao: tiers.bao.slice(0, per).map(decorate),
    },
    counts: { chong: tiers.chong.length, wen: tiers.wen.length, bao: tiers.bao.length },
  };

  if (major) {
    try {
      result.majorMatches = await matchMajor(result, { pid, typeName, major, years, userRank: useRank ? userRank : null, userDiff, baseLine });
    } catch (e) {
      result.majorMatches = { error: e.message, list: [] };
    }
  }
  return result;
}

function buildReason(c, school, ctx) {
  const r = [];
  if (school?.f985) r.push('985 工程');
  else if (school?.f211) r.push('211 工程');
  else if (school?.dual) r.push('双一流');
  if (c.years >= 3) r.push(`近 ${c.years} 年数据`);
  if (c.spread < 0.15) r.push('历年稳定');
  else r.push('历年波动较大');
  const h = c.hist;
  if (h.length >= 2) {
    const a = h[0], b = h[h.length - 1];
    if (b.rank && a.rank) {
      if (b.rank < a.rank * 0.9) r.push('门槛逐年上升');
      else if (b.rank > a.rank * 1.1) r.push('门槛逐年下降');
    }
  }
  if (ctx.useRank) {
    const gap = c.baseRank - ctx.userRank;
    r.push(gap >= 0 ? `你的位次领先约 ${Math.abs(gap).toLocaleString()} 名` : `你的位次落后约 ${Math.abs(gap).toLocaleString()} 名`);
  } else if (c.baseDiff != null && ctx.userDiff != null) {
    const gap = ctx.userDiff - c.baseDiff;
    r.push(gap >= 0 ? `线差高出 ${gap.toFixed(1)} 分` : `线差低了 ${Math.abs(gap).toFixed(1)} 分`);
  }
  return r;
}

async function matchMajor(result, { pid, typeName, major, years, userRank, userDiff, baseLine }) {
  const all = [...result.tiers.chong, ...result.tiers.wen, ...result.tiers.bao];
  const seen = new Set();
  const targets = [];
  for (const c of all) {
    if (seen.has(c.school.id)) continue;
    seen.add(c.school.id);
    targets.push(c);
    if (targets.length >= 12) break;
  }
  const key = major.replace(/\s/g, '');
  const list = [];
  let upstreamFailed = 0;
  for (const t of targets) {
    for (const y of years.slice(0, 2)) {
      let r;
      try { r = await schoolSpecialScores(t.school.id, pid, y); } catch { r = { items: [] }; }
      if (!r.items || !r.items.length) { upstreamFailed++; continue; }
      for (const it of r.items) {
        const hay = `${it.sp_name || ''}${it.level2_name || ''}${it.level3_name || ''}`.replace(/\s/g, '');
        if (!hay.includes(key)) continue;
        const mr = Number(it.min_section) || 0;
        const mm = Number(it.min) || 0;
        const line = Number(it.proscore) || 0;
        if (!mm) continue;
        let probability = null;
        if (userRank && mr) {
          const z = (mr - userRank) / Math.max(mr * 0.1, 60);
          probability = Math.round(clamp(normalCdf(z), 0.02, 0.98) * 100);
        } else if (userDiff != null && line > 0) {
          const z = (userDiff - (mm - line)) / 8;
          probability = Math.round(clamp(normalCdf(z), 0.02, 0.98) * 100);
        }
        list.push({
          school: t.school, year: y, major: it.sp_name, category: it.level2_name, className: it.level3_name,
          min: mm, minRank: mr, batchLine: line, diff: line ? mm - line : null,
          subjectReq: it.sg_info || '', group: it.sg_name || '', remark: it.info || it.remark || '',
          probability,
        });
      }
    }
  }
  list.sort((a, b) => (b.year - a.year) || ((b.probability ?? -1) - (a.probability ?? -1)));
  return {
    keyword: major, count: list.length, list: list.slice(0, 120),
    note: upstreamFailed ? `${upstreamFailed} 次专业数据获取失败（可能被上游限流），稍后重试即可` : '',
  };
}

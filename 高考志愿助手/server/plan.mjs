/**
 * 志愿方案生成：冲稳保梯度 + 专业粒度 + 策略可选
 *
 * 定位方式（按准确度优先）：
 *   1. 用户直接输入位次
 *   2. 用真实一分一段表换算位次（resources.realScoreToRank）
 *   3. 用索引样本拟合的位次曲线（兜底）
 *
 * 招生单元：
 *   - 有专业索引时 → (院校 × 专业组 × 专业)
 *   - 无专业索引时 → (院校 × 专业组)，并提示可同步专业数据
 *
 * 策略：
 *   - school（院校优先）：每所院校只保留一个最优单元，优先院校层次
 *   - major（专业优先）：优先命中意向专业的单元，同一院校可保留多个专业
 */
import { PROVINCE_NAME, getSchool, scoreToRank } from './data.mjs';
import {
  provinceIndex as loadProvinceIndex, indexedYears,
  specialIndex as loadSpecialIndex, specialYears,
  batchLines as getBatchLines,
} from './gcsource.mjs';
import { realScoreToRank, matchSubjects } from './resources.mjs';

const WEIGHTS = [1.0, 0.7, 0.5, 0.35, 0.2];

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

export function tierOf(p) { return p >= 0.80 ? 'bao' : p >= 0.45 ? 'wen' : 'chong'; }

/**
 * @param {object} opt
 * @param {number} opt.provinceId
 * @param {string} opt.type            科类：物理类/历史类/综合/理科/文科
 * @param {string[]} opt.subjects      选科（物理/化学/生物/思想政治/历史/地理/技术）
 * @param {number} opt.score
 * @param {number} opt.rank
 * @param {string} opt.major           意向专业关键词
 * @param {'school'|'major'} opt.strategy
 * @param {number} opt.total           方案条数（默认 80）
 */
export async function buildPlan(opt) {
  const pid = Number(opt.provinceId);
  if (!pid) throw new Error('缺少省份');
  const pname = PROVINCE_NAME.get(pid) || String(pid);
  const strategy = opt.strategy === 'major' ? 'major' : 'school';
  const total = clamp(Number(opt.total) || 80, 10, 120);

  const years = indexedYears(pid).filter((y) => y <= new Date().getFullYear() + 1).slice(0, 3);
  if (!years.length) {
    const e = new Error(`本地暂无「${pname}」的投档线索引。请到「数据管理」页同步该省数据。`);
    e.code = 'NO_INDEX';
    throw e;
  }
  const primaryYear = years[0];

  // ---------- 科类 ----------
  const allTypes = new Set();
  for (const y of years) (loadProvinceIndex(pid, y)?.dict?.type || []).forEach((t) => t && allTypes.add(t));
  const typeList = [...allTypes];
  let typeName = opt.type || '';
  if (typeName && !typeList.includes(typeName)) {
    const map = { 理科: ['物理类', '理科', '综合'], 文科: ['历史类', '文科', '综合'], 综合: ['综合'], 物理类: ['物理类'], 历史类: ['历史类'] };
    const cands = map[typeName] || [typeName];
    typeName = cands.find((c) => typeList.includes(c)) || typeList.find((t) => cands.some((c) => t.includes(c))) || typeList[0];
  } else if (!typeName) typeName = typeList[0];

  // ---------- 批次 ----------
  const batchNames = new Set();
  for (const y of years) (loadProvinceIndex(pid, y)?.dict?.batch || []).forEach((b) => b && batchNames.add(b));
  let batchFilter = opt.batch || '';
  if (!batchFilter) {
    if ([...batchNames].some((b) => b.includes('本科批'))) batchFilter = '本科批';
    else if ([...batchNames].some((b) => b.includes('本科'))) batchFilter = '本科';
  }

  // ---------- 考生定位 ----------
  const subjects = Array.isArray(opt.subjects) ? opt.subjects.filter(Boolean) : [];
  let userRank = Number(opt.rank) > 0 ? Number(opt.rank) : null;
  let rankSource = userRank ? 'user' : '';
  if (!userRank && Number(opt.score) > 0) {
    const real = realScoreToRank(pid, typeName, opt.score, primaryYear);
    if (real) { userRank = real.rank; rankSource = `一分一段表(${real.year})`; }
    else {
      const est = scoreToRank(pid, primaryYear, typeName, opt.score);
      if (est) { userRank = est; rankSource = '拟合估算'; }
    }
  }
  if (!userRank) throw new Error('无法确定位次：请填写位次，或确认该省已有一分一段表/分数样本');

  const batchLines = getBatchLines(pid, primaryYear);
  const batchLine = batchLines[`${typeName}|${batchFilter}`] || Object.entries(batchLines).find(([k]) => k.startsWith(typeName))?.[1] || 0;
  const userScore = Number(opt.score) > 0 ? Number(opt.score) : null;
  const userDiff = userScore && batchLine ? userScore - batchLine : null;

  // ---------- 采集招生单元（专业组） ----------
  const units = new Map();     // key: schoolId#batchIdx#groupIdx
  for (const y of years) {
    const ix = loadProvinceIndex(pid, y);
    if (!ix) continue;
    const ti = ix.dict.type.indexOf(typeName);
    if (ti < 0) continue;
    for (const r of ix.rows) {
      if (r[1] !== ti) continue;
      const bName = ix.dict.batch[r[2]] || '';
      if (batchFilter && bName && !bName.includes(batchFilter)) continue;
      if (r[4] < 100) continue;
      const subj = ix.dict.subj[r[7]] || '';
      if (!matchSubjects(subj, subjects)) continue;
      const key = `${r[0]}#${r[2]}#${r[3]}`;
      if (!units.has(key)) units.set(key, { schoolId: r[0], batchIdx: r[2], groupIdx: r[3], subjIdx: r[7], hist: [] });
      const h = units.get(key).hist;
      if (!h.some((x) => x.year === y)) h.push({ year: y, min: r[4], rank: r[5], line: r[6] });
    }
  }
  if (!units.size) {
    const e = new Error(`「${pname} · ${typeName}」在所选条件下没有可报的招生单元${subjects.length ? '（可能是选科过滤过严）' : ''}`);
    e.code = 'NO_DATA';
    throw e;
  }

  // ---------- 专业数据（可选） ----------
  // 只有覆盖足够的专业索引才会被采用，避免「有索引但没几个专业」造成误导
  const MIN_SPECIAL_ROWS = 200;
  const spYears = specialYears(pid).filter((y) => years.includes(y));
  let spIdx = spYears.length ? loadSpecialIndex(pid, spYears[0]) : null;
  if (spIdx && (!spIdx.rows || spIdx.rows.length < MIN_SPECIAL_ROWS)) spIdx = null;
  const majorsByUnit = new Map();     // `${schoolId}#${groupName}` -> [{major,code,min,minRank,prob}]
  if (spIdx) {
    const ti = spIdx.dict.type.indexOf(typeName);
    for (const r of spIdx.rows) {
      if (ti >= 0 && r[2] !== ti) continue;
      const batchName = spIdx.dict.batch[r[3]] || '';
      if (batchFilter && batchName && !batchName.includes(batchFilter)) continue;
      const gname = spIdx.dict.group[r[4]] || '';
      const k = `${r[0]}#${gname}`;
      if (!majorsByUnit.has(k)) majorsByUnit.set(k, []);
      majorsByUnit.get(k).push({
        major: spIdx.dict.major[r[1]] || '', code: spIdx.dict.code[r[9]] || '',
        category: spIdx.dict.category[r[10]] || '', className: spIdx.dict.className[r[11]] || '',
        subjectReq: spIdx.dict.subj[r[5]] || '',
        min: r[6], minRank: r[7], line: r[8],
      });
    }
  }

  const majorKey = String(opt.major || '').replace(/\s/g, '');
  const matchMajorName = (m) => !majorKey || `${m.major}${m.category}${m.className}`.replace(/\s/g, '').includes(majorKey);

  // ---------- 逐单元算概率 ----------
  const cands = [];
  for (const u of units.values()) {
    const sorted = u.hist.slice().sort((a, b) => b.year - a.year);
    const wd = sorted.filter((h) => h.line > 0);
    const wr = sorted.filter((h) => h.rank > 0);
    if (!wd.length && !wr.length) continue;

    let prob, baseDiff = null, baseRank = null, spread = 0;
    if (userDiff != null && wd.length) {
      let ws = 0, ds = 0;
      wd.forEach((h, i) => { const w = WEIGHTS[i] ?? 0.2; ws += w; ds += (h.min - h.line) * w; });
      baseDiff = ds / ws;
      const dsArr = wd.map((h) => h.min - h.line);
      const mean = dsArr.reduce((a, b) => a + b, 0) / dsArr.length;
      const sd = dsArr.length > 1 ? Math.sqrt(dsArr.reduce((a, b) => a + (b - mean) ** 2, 0) / (dsArr.length - 1)) : 0;
      const sigma = Math.max(sd, 8);
      prob = clamp(normalCdf((userDiff - baseDiff) / sigma), 0.02, 0.98);
      spread = sigma / Math.max(1, Math.abs(baseDiff) || 1);
    } else if (wr.length) {
      let ws = 0, rs = 0;
      wr.forEach((h, i) => { const w = WEIGHTS[i] ?? 0.2; ws += w; rs += h.rank * w; });
      baseRank = rs / ws;
      const rsArr = wr.map((h) => h.rank);
      const mean = rsArr.reduce((a, b) => a + b, 0) / rsArr.length;
      const sd = rsArr.length > 1 ? Math.sqrt(rsArr.reduce((a, b) => a + (b - mean) ** 2, 0) / (rsArr.length - 1)) : 0;
      const sigma = Math.max(sd, baseRank * 0.1, 60);
      prob = clamp(normalCdf((baseRank - userRank) / sigma), 0.02, 0.98);
      spread = sigma / Math.max(1, baseRank);
    } else continue;

    const ix = loadProvinceIndex(pid, primaryYear);
    const group = ix?.dict?.group?.[u.groupIdx] ?? '';
    const school = getSchool(u.schoolId);

    // 该专业组下的专业
    let majorOptions = (majorsByUnit.get(`${u.schoolId}#${group}`) || []).slice();
    for (const m of majorOptions) {
      const sigma = 8;
      if (userDiff != null && m.line > 0) m.prob = clamp(normalCdf((userDiff - (m.min - m.line)) / sigma), 0.02, 0.98);
      else if (m.minRank) m.prob = clamp(normalCdf((m.minRank - userRank) / Math.max(m.minRank * 0.1, 60)), 0.02, 0.98);
      else m.prob = prob;
      m.same = true;
    }
    majorOptions.sort((a, b) => (b.prob - a.prob));

    const matched = majorOptions.filter(matchMajorName);
    // 专业优先：该组内没有意向专业则降权
    const majorHit = matched.length > 0;
    const best = matched[0] || null;

    cands.push({
      schoolId: u.schoolId, school, group, groupIdx: u.groupIdx, batch: ix?.dict?.batch?.[u.batchIdx] ?? '',
      subjectReq: ix?.dict?.subj?.[u.subjIdx] ?? '',
      prob, baseDiff: baseDiff == null ? null : baseDiff, baseRank: baseRank == null ? null : Math.round(baseRank),
      latest: sorted[0] ? { year: sorted[0].year, min: sorted[0].min, rank: sorted[0].rank, line: sorted[0].line } : null,
      hist: sorted.slice().sort((a, b) => a.year - b.year),
      years: sorted.length, spread,
      majorOptions: majorOptions.slice(0, 24),
      majorHit, major: best ? best.major : '', majorCode: best ? best.code : '',
      majorProb: best ? Math.round(best.prob * 100) : null,
      majorData: !!spIdx,
    });
  }
  if (!cands.length) {
    const e = new Error('没有可用的候选招生单元');
    e.code = 'NO_DATA';
    throw e;
  }

  // ---------- 排序权重 ----------
  const levelScore = (s) => (s?.f985 ? 3 : 0) + (s?.f211 ? 2 : 0) + (s?.dual ? 1 : 0);
  for (const c of cands) {
    c.lv = levelScore(c.school);
    // 综合排序分：意向专业命中 > 有专业明细 > 院校层次 > 与考生水平接近
    const closeness = 1 - Math.min(1, Math.abs(c.prob - 0.6) / 0.6);
    c.rankScore = 0;
    if (majorKey) c.rankScore += c.majorHit ? 3.0 : -1.0;
    if (c.majorOptions.length) c.rankScore += 0.5;
    c.rankScore += c.lv * 0.4 + closeness * 0.9;
    if (strategy === 'major' && majorKey && !c.majorHit) c.rankScore -= 1.5;
  }

  // ---------- 分档 & 选条 ----------
  const ratios = { chong: 0.3, wen: 0.4, bao: 0.3 };
  if (opt.ratios) for (const k of Object.keys(ratios)) if (Number(opt.ratios[k]) >= 0) ratios[k] = Number(opt.ratios[k]);
  const quota = {
    chong: Math.max(1, Math.round(total * ratios.chong)),
    wen: Math.max(1, Math.round(total * ratios.wen)),
    bao: Math.max(1, Math.round(total * ratios.bao)),
  };
  const pools = { chong: [], wen: [], bao: [] };
  for (const c of cands) pools[tierOf(c.prob)].push(c);

  const MAX_PER_SCHOOL = strategy === 'major' ? 3 : 1;
  const chosen = [];
  const perSchool = new Map();
  const picked = new Set();
  for (const tier of ['chong', 'wen', 'bao']) {
    // 按策略分排序；同分时冲档偏向高概率（更接近稳），稳保偏向低概率（更稳）
    pools[tier].sort((a, b) => (b.rankScore - a.rankScore)
      || (tier === 'chong' ? b.prob - a.prob : a.prob - b.prob));
    let n = 0;
    for (const c of pools[tier]) {
      if (n >= quota[tier]) break;
      const k = `${c.schoolId}#${c.group}`;
      if (picked.has(k)) continue;
      const used = perSchool.get(c.schoolId) || 0;
      if (used >= MAX_PER_SCHOOL) continue;
      perSchool.set(c.schoolId, used + 1);
      picked.add(k);
      chosen.push({ ...c, tier });
      n++;
    }
    // 该档不足时，从其它档补
    if (n < quota[tier]) {
      const rest = [...pools.chong, ...pools.wen, ...pools.bao].sort((a, b) => b.rankScore - a.rankScore);
      for (const c of rest) {
        if (n >= quota[tier]) break;
        const k = `${c.schoolId}#${c.group}`;
        if (picked.has(k)) continue;
        const used = perSchool.get(c.schoolId) || 0;
        if (used >= MAX_PER_SCHOOL) continue;
        perSchool.set(c.schoolId, used + 1);
        picked.add(k);
        chosen.push({ ...c, tier });
        n++;
      }
    }
  }

  // ---------- 输出 ----------
  const order = { chong: 0, wen: 1, bao: 2 };
  chosen.sort((a, b) => order[a.tier] - order[b.tier] || (a.tier === 'chong' ? b.prob - a.prob : a.prob - b.prob));
  const slots = chosen.map((c, i) => ({
    order: i + 1,
    tier: c.tier,
    tierLabel: c.tier === 'chong' ? '冲' : c.tier === 'wen' ? '稳' : '保',
    school: c.school ? {
      id: c.school.id, name: c.school.name, province: c.school.province, city: c.school.city,
      level: c.school.level, type: c.school.type, nature: c.school.nature,
      f985: c.school.f985, f211: c.school.f211, dual: c.school.dual,
    } : { id: c.schoolId, name: `#${c.schoolId}` },
    nationalCode: c.school?.codeEnroll ? String(c.school.codeEnroll).slice(0, 5) : '',
    group: c.group, batch: c.batch, subjectReq: c.subjectReq,
    probability: Math.round(c.prob * 100),
    major: c.major, majorCode: c.majorCode, majorProb: c.majorProb,
    majorOptions: c.majorOptions.map((m) => ({ major: m.major, code: m.code, category: m.category, className: m.className, min: m.min, minRank: m.minRank, prob: Math.round(m.prob * 100) })),
    baseDiff: round1(c.baseDiff), baseRank: c.baseRank,
    latest: c.latest, hist: c.hist, years: c.years, stable: c.spread < 0.15,
    reason: buildReasons(c, majorKey),
  }));

  return {
    ok: true,
    meta: {
      province: pname, provinceId: pid, type: typeName, typeOptions: typeList,
      subjects, strategy, strategyLabel: strategy === 'major' ? '专业优先' : '院校优先',
      score: userScore, rank: userRank, rankSource,
      batchLine, userDiff, batch: batchFilter || '全部',
      primaryYear, refYears: years,
      major: opt.major || '', total, quota,
      counts: { chong: pools.chong.length, wen: pools.wen.length, bao: pools.bao.length },
      hasMajorData: !!spIdx, majorDataYear: spIdx ? spYears[0] : null,
      candidates: cands.length,
      generatedAt: new Date().toISOString(),
    },
    slots,
    groups: { 冲: slots.filter((s) => s.tier === 'chong').length, 稳: slots.filter((s) => s.tier === 'wen').length, 保: slots.filter((s) => s.tier === 'bao').length },
  };
}

function buildReasons(c, majorKey) {
  const r = [];
  if (c.school?.f985) r.push('985');
  else if (c.school?.f211) r.push('211');
  else if (c.school?.dual) r.push('双一流');
  if (majorKey && c.majorHit) r.push(`含意向专业「${c.major}」`);
  if (c.years >= 3) r.push(`近 ${c.years} 年数据`);
  if (c.spread < 0.15) r.push('历年稳定'); else r.push('历年波动较大');
  if (c.latest && c.hist.length >= 2) {
    const a = c.hist[0], b = c.hist[c.hist.length - 1];
    if (a.rank && b.rank) {
      if (b.rank < a.rank * 0.9) r.push('门槛上升');
      else if (b.rank > a.rank * 1.1) r.push('门槛下降');
    }
  }
  return r;
}

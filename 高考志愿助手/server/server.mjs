/**
 * 高考志愿助手 · 本地服务
 * 纯 Node 内置模块实现：静态资源 + 数据 API + 上游代理 + 后台索引
 *
 * 启动：node server/server.mjs [--port 8765] [--open] [--no-index]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  APP_DIR, PROVINCES, PROVINCE_NAME, PROVINCE_ID,
  loadSchools, allSchools, getSchool, searchSchools,
  loadProvinceIndex, indexedYears, indexFile, scoreToRank, rankToScore,
  getBatchLines, searchColleges, getCollege, loadColleges, indexStats,
} from './data.mjs';
import {
  schoolProvinceScores, schoolSpecialScores, upstreamStatus, apiFetch, PAGE_SIZE,
} from './upstream.mjs';
import { recommend } from './recommend.mjs';
import { enqueue, enqueueMany, startIndexer, indexerStatus, autoBootstrap, coverage, quickIndex } from './indexer.mjs';
import {
  listRankTables, listImageOnly, getRankTable, realScoreToRank, realRankToScore, availableRank,
  getPlanCodes, getSpecialCodes, schoolNationalCode, resourceStatus,
} from './resources.mjs';
import { buildPlan } from './plan.mjs';
import { skillInfo, chatProxy, EXTRACT_PROMPT } from './ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(APP_DIR, 'web');

const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (argv.includes('--' + name) ? true : def); };
const START_PORT = Number(argOf('port', 8765));
const AUTO_OPEN = argv.includes('--open');
const NO_INDEX = argv.includes('--no-index');
const BOOTSTRAP = argv.includes('--bootstrap');   // 默认不自动批量抓取，避免给使用者 IP 带来限流风险

// ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function sendText(res, text, status = 200, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}
const toNum = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ---------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------
async function handleApi(req, res, url, body) {
  const p = url.pathname.replace(/^\/api/, '');
  const q = { ...Object.fromEntries(url.searchParams.entries()), ...(body && typeof body === 'object' ? body : {}) };

  // ---- 元信息 ----
  if (p === '/meta') {
    const schools = allSchools();
    return sendJson(res, {
      ok: true,
      version: '1.0.0',
      schoolCount: schools.length,
      collegeCount: (loadColleges().schools || []).length,
      provinces: PROVINCES.map(([id, name]) => ({ id, name })),
      types: ['物理类', '历史类', '理科', '文科', '综合'],
      coverage: coverage(),
      indexFiles: indexStats().length,
      now: new Date().toISOString(),
      source: '掌上高考 / colleges.chat',
    });
  }

  // ---- 字典 ----
  if (p === '/dict') {
    const pid = toNum(q.provinceId);
    const years = pid ? indexedYears(pid) : [];
    const types = new Set();
    for (const y of years) {
      const ix = loadProvinceIndex(pid, y);
      (ix?.dict?.type || []).forEach((t) => t && types.add(t));
    }
    return sendJson(res, {
      ok: true,
      provinces: PROVINCES.map(([id, name]) => ({ id, name })),
      indexedYears: years,
      types: [...types],
      schoolProvinces: [...new Set(allSchools().map((s) => s.province))].filter(Boolean).sort(),
      schoolLevels: [...new Set(allSchools().map((s) => s.level))].filter(Boolean),
      schoolTypes: [...new Set(allSchools().map((s) => s.type))].filter(Boolean).sort(),
      batchLines: pid && years.length ? getBatchLines(pid, years[0]) : {},
    });
  }

  // ---- 院校检索 ----
  if (p === '/schools') {
    return sendJson(res, { ok: true, ...searchSchools({
      q: q.q || '', province: q.province || '', level: q.level || '',
      type: q.type || '', dual: q.dual || '',
      page: toNum(q.page, 1), size: Math.min(toNum(q.size, 30), 100),
    }) });
  }

  const mSchool = /^\/school\/(\d+)$/.exec(p);
  if (mSchool) {
    const s = getSchool(Number(mSchool[1]));
    if (!s) return sendJson(res, { ok: false, message: '院校不存在' }, 404);
    const cc = getCollege(s.name);
    return sendJson(res, { ok: true, school: s, college: cc ? { ...cc, answers: undefined, v2: undefined } : null });
  }

  // ---- 院校投档线 ----
  if (p === '/score/province') {
    const sid = toNum(q.schoolId), pid = toNum(q.provinceId);
    if (!sid) return sendJson(res, { ok: false, message: '缺少 schoolId' }, 400);
    if (!pid) {
      // 不带省份：直接取上游最新年份全量
      const r = await apiFetch('apidata/api/gk/score/province', { school_id: sid, size: PAGE_SIZE, page: toNum(q.page, 1) });
      return sendJson(res, { ok: r.code === '0000', items: r.data?.item || [], numFound: r.data?.numFound || 0, live: true });
    }
    const nowY = new Date().getFullYear();
    const fallbackYears = (pid && indexedYears(pid).length) ? indexedYears(pid) : [nowY, nowY - 1];
    const years = q.year ? [toNum(q.year)] : fallbackYears.slice(0, 4);
    const local = [];
    let localHit = false;
    for (const y of years) {
      const ix = loadProvinceIndex(pid, y);
      if (!ix) continue;
      localHit = true;
      for (const r of ix.rows) {
        if (r[0] !== sid) continue;
        local.push({
          year: y, group: ix.dict.group[r[3]] || '', batch: ix.dict.batch[r[2]] || '',
          type: ix.dict.type[r[1]] || '', subjectReq: ix.dict.subj[r[7]] || '',
          min: r[4], minRank: r[5], batchLine: r[6], zslx: ix.dict.zslx?.[r[8]] || '',
          source: 'local',
        });
      }
    }
    if (localHit && local.length) {
      local.sort((a, b) => b.year - a.year || (a.min || 0) - (b.min || 0));
      return sendJson(res, { ok: true, items: local, local: true, years });
    }
    // 回退到在线查询
    const out = [];
    let failed = 0;
    for (const y of (q.year ? [toNum(q.year)] : years)) {
      const r = await schoolProvinceScores(sid, pid, y);
      if (r.failed) failed++;
      for (const it of r.items) out.push(normalizeProvince(it, y));
    }
    return sendJson(res, {
      ok: true, items: out, live: true, years,
      warning: failed ? '上游数据源暂时限流，部分年份未能获取。请稍后重试（已获取的数据已缓存）。' : '',
    });
  }

  // ---- 专业分数线 ----
  if (p === '/score/special') {
    const sid = toNum(q.schoolId), pid = toNum(q.provinceId);
    if (!sid || !pid) return sendJson(res, { ok: false, message: '缺少 schoolId / provinceId' }, 400);
    const nowY2 = new Date().getFullYear();
    const idxY = indexedYears(pid);
    // 未指定年份时默认只取最近 2 年，避免首次查询触发大量上游请求
    const years = q.year ? [toNum(q.year)] : (idxY.length ? idxY.slice(0, 2) : [nowY2, nowY2 - 1]);
    const out = [];
    let cached = false, failed = 0, partial = 0;
    for (const y of years) {
      const r = await schoolSpecialScores(sid, pid, y);
      if (r.cached) cached = true;
      if (r.failed) failed++;
      if (r.partial) partial++;
      for (const it of r.items) {
        const rec = normalizeSpecial(it, y);
        if (q.major && !`${rec.major}${rec.category}${rec.className}`.includes(q.major)) continue;
        if (q.type && rec.type && !rec.type.includes(q.type) && !q.type.includes(rec.type)) continue;
        out.push(rec);
      }
    }
    out.sort((a, b) => b.year - a.year || (a.min || 0) - (b.min || 0));
    let warning = '';
    if (failed && !out.length) warning = '上游数据源暂时限流（code 1069），本次未能获取专业分数线。请 1–2 分钟后重试。';
    else if (failed) warning = '部分年份因上游限流未能获取，可稍后重试。';
    else if (partial) warning = '数据量较大，本次仅返回部分记录，可缩小年份范围（或指定专业关键词）以获取完整数据。';
    return sendJson(res, { ok: true, items: out, live: true, cached, years, numFound: out.length, warning });
  }

  // ---- 趋势 ----
  if (p === '/score/trend') {
    const sid = toNum(q.schoolId), pid = toNum(q.provinceId), major = q.major || '';
    const nowY = new Date().getFullYear();
    const years = q.years ? String(q.years).split(',').map(Number) : [];
    const idxY = indexedYears(pid);
    const ys = years.length ? years
      : (idxY.length ? [...new Set([...idxY, nowY, nowY - 1])] : [nowY, nowY - 1, nowY - 2]);
    const series = [];
    for (const y of ys.slice().sort((a, b) => a - b)) {
      const r = await schoolSpecialScores(sid, pid, y);
      let pool = r.items.map((it) => normalizeSpecial(it, y));
      if (major) {
        const mm = pool.filter((x) => `${x.major}${x.category}${x.className}`.includes(major));
        if (mm.length) pool = mm;
      }
      if (!pool.length) continue;
      const mins = pool.map((x) => x.min).filter((x) => x > 0);
      const ranks = pool.map((x) => x.minRank).filter((x) => x > 0);
      series.push({
        year: y,
        min: mins.length ? Math.min(...mins) : null,
        max: mins.length ? Math.max(...mins) : null,
        avg: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
        bestRank: ranks.length ? Math.min(...ranks) : null,
        batchLine: pool[0]?.batchLine || 0,
        count: pool.length,
      });
    }
    return sendJson(res, { ok: true, series, major });
  }

  // ---- 分数 / 位次换算 ----
  if (p === '/rank') {
    const pid = toNum(q.provinceId), year = toNum(q.year) || indexedYears(toNum(q.provinceId))[0];
    const type = q.type || '';
    if (!pid || !year) return sendJson(res, { ok: false, message: '缺少省份或年份' }, 400);
    if (q.score) {
      const rank = scoreToRank(pid, year, type, toNum(q.score));
      return sendJson(res, { ok: rank != null, score: toNum(q.score), rank, year, type, estimated: true });
    }
    if (q.rank) {
      const score = rankToScore(pid, year, type, toNum(q.rank));
      return sendJson(res, { ok: score != null, score, rank: toNum(q.rank), year, type, estimated: true });
    }
    return sendJson(res, { ok: false, message: '需要 score 或 rank' }, 400);
  }

  // ---- 冲稳保推荐 ----
  if (p === '/recommend') {
    const pid = toNum(q.provinceId);
    const reqArgs = {
      provinceId: pid, type: q.type || '', score: toNum(q.score),
      rank: toNum(q.rank) || null, major: q.major || '', batch: q.batch || '',
      limit: Math.min(toNum(q.limit, 45), 120), year: toNum(q.year) || null,
    };
    try {
      return sendJson(res, await recommend(reqArgs));
    } catch (e) {
      // 缺索引时：先做一次「快速抽样建索引」（约 30 页），成功就立刻出结果；同时排队完整同步
      if ((e.code === 'NO_INDEX' || e.code === 'NO_DATA') && pid) {
        const y = toNum(q.year) || new Date().getFullYear();
        if (q.quick !== '0') {
          try {
            const qi = await quickIndex(pid, y, 30);
            if (qi.ok) {
              const out = await recommend(reqArgs);
              out.meta.sampled = true;
              out.meta.notice = `本次结果基于「${new Date().getFullYear()} 年快速抽样数据」（${qi.rows || '已有'} 条），完整数据正在后台补齐，稍后刷新会更准确。`;
              enqueue(pid, y, 5); startIndexer();
              return sendJson(res, out);
            }
          } catch { /* 落到下面返回错误 */ }
        }
        enqueue(pid, y, 1);
        startIndexer();
      }
      return sendJson(res, { ok: false, code: e.code || 'ERR', message: e.message }, 200);
    }
  }

  // ---- 大学环境 ----
  if (p === '/colleges') {
    const list = searchColleges(q.q || '', Math.min(toNum(q.size, 30), 100));
    return sendJson(res, {
      ok: true,
      total: list.length,
      items: list.map((s) => ({ name: s.name, province: s.province, resp: s.resp, slug: s.slug, hasDetail: (s.answers?.length || 0) > 0 || (s.v2?.length || 0) > 0 })),
    });
  }
  if (p === '/colleges/detail') {
    const name = q.school || '';
    const cc = getCollege(name);
    if (!cc) return sendJson(res, { ok: false, message: '未收录该校的问卷数据' }, 404);
    const data = loadColleges();
    const detail = {
      name: cc.name, province: cc.province, resp: cc.resp, slug: cc.slug,
      url: cc.slug ? `https://cn.colleges.chat/universities/${cc.slug}/` : `https://cn.colleges.chat/?q=${encodeURIComponent(cc.name)}`,
      groups: (cc.answers || []).map(([qi, list]) => ({ q: data.questions[qi] || `Q${qi + 1}`, items: list })),
      groupsV2: (cc.v2 || []).map(([qi, list]) => ({ q: data.v2questions[qi] || `Q${qi + 1}`, items: list })),
      extra: cc.extra || [],
    };
    return sendJson(res, { ok: true, detail });
  }

  // ---- 资料库：一分一段表（真实数据） ----
  if (p === '/resource/status') return sendJson(res, { ok: true, ...resourceStatus() });

  if (p === '/resource/rank/list') {
    return sendJson(res, {
      ok: true, tables: listRankTables(), imageOnly: listImageOnly(),
      source: resourceStatus().source, updatedAt: resourceStatus().updatedAt,
    });
  }

  if (p === '/resource/rank') {
    const pid = toNum(q.provinceId);
    if (!pid) return sendJson(res, { ok: false, message: '缺少 provinceId' }, 400);
    const type = q.type || '';
    if (q.score) {
      const r = realScoreToRank(pid, type, toNum(q.score), toNum(q.year) || null);
      if (!r) {
        const av = availableRank(pid);
        return sendJson(res, { ok: false, message: av.length ? '未找到匹配的一分一段表' : `暂无「${PROVINCE_NAME.get(pid) || pid}」的一分一段表（官方可能仅以图片发布）`, available: av });
      }
      return sendJson(res, { ok: true, mode: 'score2rank', score: toNum(q.score), ...r });
    }
    if (q.rank) {
      const r = realRankToScore(pid, type, toNum(q.rank), toNum(q.year) || null);
      if (!r) return sendJson(res, { ok: false, message: '暂无该省一分一段表' });
      return sendJson(res, { ok: true, mode: 'rank2score', rank: toNum(q.rank), ...r });
    }
    if (q.year && type) {
      const t = getRankTable(pid, toNum(q.year), type);
      if (!t) return sendJson(res, { ok: false, message: '未找到该表' }, 404);
      const page = Math.max(1, toNum(q.page, 1));
      const size = Math.min(toNum(q.size, 300), 2000);
      return sendJson(res, {
        ok: true, province: t.province, year: t.year, type: t.type, title: t.title, url: t.url,
        total: t.total, range: t.range, full: t.full, gaps: t.gaps, blocks: t.blocks,
        count: t.series.length, page, size,
        rows: t.series.slice((page - 1) * size, page * size),
      });
    }
    return sendJson(res, { ok: true, available: availableRank(pid) });
  }

  // ---- 资料库：院校代码 / 专业代码 ----
  if (p === '/resource/codes') {
    const sid = toNum(q.schoolId), pid = toNum(q.provinceId);
    const year = toNum(q.year) || new Date().getFullYear();
    if (!sid) return sendJson(res, { ok: false, message: '缺少 schoolId' }, 400);
    const s = getSchool(sid);
    const want = q.with || 'both';
    let plan = { items: [] }, spec = { items: [] };
    if (pid && (want === 'both' || want === 'plan')) plan = await getPlanCodes(sid, pid, year);
    if (pid && (want === 'both' || want === 'special')) spec = await getSpecialCodes(sid, pid, year);
    return sendJson(res, {
      ok: true, year, provinceId: pid,
      school: s ? { id: s.id, name: s.name, province: s.province, city: s.city, level: s.level, type: s.type, nature: s.nature } : null,
      nationalCode: schoolNationalCode(sid),
      plan: plan.items || [], planFailed: !!plan.failed, planPartial: !!plan.partial, planCached: !!plan.cached,
      special: spec.items || [], specialFailed: !!spec.failed, specialPartial: !!spec.partial, specialCached: !!spec.cached,
    });
  }

  // ---- 志愿方案生成 ----
  if (p === '/plan') {
    try {
      const out = await buildPlan({
        provinceId: toNum(q.provinceId),
        type: q.type || '',
        subjects: Array.isArray(q.subjects) ? q.subjects : String(q.subjects || '').split(',').filter(Boolean),
        score: toNum(q.score), rank: toNum(q.rank) || null,
        major: q.major || '', batch: q.batch || '',
        strategy: q.strategy || 'school',
        total: toNum(q.total, 80),
        ratios: q.ratios || null,
      });
      return sendJson(res, out);
    } catch (e) {
      const pid = toNum(q.provinceId);
      if ((e.code === 'NO_INDEX' || e.code === 'NO_DATA') && pid) {
        const y = toNum(q.year) || new Date().getFullYear();
        enqueue(pid, y, 1, 'province');
        startIndexer();
      }
      return sendJson(res, { ok: false, code: e.code || 'ERR', message: e.message }, 200);
    }
  }

  // ---- AI 对话（张雪峰技能） ----
  if (p === '/ai/skill') return sendJson(res, { ok: true, ...skillInfo() });
  if (p === '/ai/extract-prompt') return sendJson(res, { ok: true, prompt: EXTRACT_PROMPT });
  if (p === '/ai/chat') return chatProxy(q, res);

  // ---- 数据状态 / 同步 ----
  if (p === '/status') return sendJson(res, { ok: true, indexer: indexerStatus(), coverage: coverage(), upstream: upstreamStatus() });

  if (p === '/sync') {
    let n = 0;
    if (q.all === '1') {
      const nowY = new Date().getFullYear();
      n = autoBootstrap([nowY, nowY - 1, nowY - 2]);
    } else {
      n = enqueueMany(String(q.provinces || '').split(',').filter(Boolean).map((x) => [Number(x), toNum(q.year) || new Date().getFullYear()]), toNum(q.priority, 1));
    }
    startIndexer();
    return sendJson(res, { ok: true, enqueued: n, indexer: indexerStatus() });
  }

  return sendJson(res, { ok: false, message: '未知接口 ' + p }, 404);
}

function normalizeProvince(it, year) {
  return {
    schoolId: Number(it.school_id), schoolName: it.name, year: Number(it.year || year),
    province: it.local_province_name, type: it.local_type_name,
    batch: it.local_batch_name, group: it.sg_name, subjectReq: it.sg_info,
    min: Number(it.min) || null, minRank: Number(it.min_section) || null,
    average: Number(it.average) || null, max: Number(it.max) || null,
    batchLine: Number(it.proscore) || null, zslx: it.zslx_name || '', source: 'live',
  };
}
function normalizeSpecial(it, year) {
  return {
    schoolId: Number(it.school_id), schoolName: it.name, year: Number(it.year || year),
    province: it.local_province_name, type: it.local_type_name, batch: it.local_batch_name,
    major: it.sp_name || '', category: it.level2_name || '', className: it.level3_name || '',
    group: it.sg_name || '', subjectReq: it.sg_info || '',
    min: Number(it.min) || null, minRank: Number(it.min_section) || null,
    average: Number(it.average) || null, max: Number(it.max) || null,
    batchLine: Number(it.proscore) || null,
    remark: it.info || it.remark || '', code: it.sp_scode || '', source: 'live',
  };
}

// ---------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) return sendText(res, '403', 403);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 回退
      const idx = path.join(WEB_DIR, 'index.html');
      if (fs.existsSync(idx)) {
        const b = fs.readFileSync(idx);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length });
        return res.end(b);
      }
      return sendText(res, '404 Not Found', 404);
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await readBody(req);
      }
      await handleApi(req, res, url, body);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, { ok: false, message: e.message }, 500);
    else res.end();
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------
function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║            高考志愿助手  已启动                  ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log('');
    console.log(`   访问地址： ${url}`);
    console.log(`   数据目录： ${APP_DIR}`);
    console.log('');
    console.log('   * 关闭此窗口即退出程序');
    console.log('   * 数据来源：掌上高考 / colleges.chat（仅供学习参考）');
    console.log('');
    if (AUTO_OPEN) {
      try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* ignore */ }
    }
    if (BOOTSTRAP) {
      const n = autoBootstrap();
      console.log(`   已排入 ${n} 个数据补齐任务（后台限速抓取，可在页面查看进度）`);
      startIndexer();
      console.log('');
    } else {
      console.log('   数据补齐：默认关闭自动抓取。缺少的省份可在「数据管理」页按需同步。');
      console.log('');
    }
  });
}

console.log('  正在加载院校库…');
const n = loadSchools();
console.log(`  院校库加载完成：${n} 所`);
try { loadColleges(); console.log('  大学环境数据加载完成'); } catch { console.log('  ⚠ 大学环境数据缺失，功能 2 将不可用'); }
listen(START_PORT);

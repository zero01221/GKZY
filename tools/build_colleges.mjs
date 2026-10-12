/**
 * 将 colleges.chat 原始问卷数据转换为应用可用的结构化 JSON
 *   输入: data/colleges_raw/{v1.csv, v1.additions.csv, v2.csv, colleges.csv, alias.txt, blacklist.txt}
 *   输出: <bundle>/data/colleges.json
 *
 * 规则：
 *   - v1 口径：列[5]=学校名，列[6..30]=Q5..Q29 对应 questionnaire[0..24]，列[31]=自由补充
 *   - v2 口径：列[3]=学校名，列[10..34] 为环境类问题，列[35]=自由补充
 *   - 同名同题答案聚合并计数，按频次排序
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'colleges_raw');
const OUT_DIR = process.argv[2] || path.join(ROOT, 'data', 'bundle');
fs.mkdirSync(OUT_DIR, { recursive: true });

const QUESTIONNAIRE = [
  '宿舍是上床下桌吗？',
  '教室和宿舍有没有空调？',
  '有独立卫浴吗？没有独立浴室的话，澡堂离宿舍多远？',
  '有早自习、晚自习吗？',
  '有晨跑吗？',
  '每学期跑步打卡的要求是多少公里，可以骑车吗？',
  '寒暑假放多久，每年小学期有多长？',
  '学校允许点外卖吗，取外卖的地方离宿舍楼多远？',
  '学校交通便利吗，有地铁吗，在市区吗，不在的话进城要多久？',
  '宿舍楼有洗衣机吗？',
  '校园网怎么样？',
  '每天断电断网吗，几点开始断？',
  '食堂价格贵吗，会吃出异物吗？',
  '洗澡热水供应时间？',
  '校园内可以骑电瓶车吗，电池在哪能充电？',
  '宿舍限电情况？',
  '通宵自习有去处吗？',
  '大一能带电脑吗？',
  '学校里面用什么卡，饭堂怎样消费？',
  '学校会给学生发银行卡吗？',
  '学校的超市怎么样？',
  '学校的收发快递政策怎么样？',
  '学校里面的共享单车数目与种类如何？',
  '现阶段学校的门禁情况如何？',
  '宿舍晚上查寝吗，封寝吗，晚归能回去吗？',
];

// v2 问题的短标题（列 10..34 共 25 项，与 v1 主题大体对应但更细）
const V2_QUESTIONS = [
  '转专业容易吗？',
  '导师管理风格与组内氛围',
  '实验室与工位硬件条件',
  '研究生补助与福利待遇',
  '异地研究院/分院/校外基地联培情况',
  '宿舍床位结构',
  '教室和宿舍有空调吗？',
  '宿舍有独立卫浴吗？',
  '每天会断电断网吗？',
  '宿舍限电功率 / 违禁电器 / 床帘',
  '大一刚入学允许带电脑吗？',
  '晚上宿舍会查寝或封寝吗？',
  '食堂的价格与卫生质量',
  '校园网收费与网络质量',
  '校园内用什么卡消费？',
  '快递收发政策',
  '校园内超市的物价和服务',
  '学校允许点外卖吗？',
  '校园内可以骑私家电瓶车吗？',
  '校内共享单车数量与种类',
  '学校周边交通便利度',
  '日常考勤管理严格吗？',
  '每学期跑步打卡要求',
  '寒暑假时长 / 小学期',
  '自习资源与图书馆体验',
];

function parseCsv(text) {
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

const readCsv = (f) => {
  const p = path.join(RAW, f);
  if (!fs.existsSync(p)) { console.log(`  ⚠ 缺少 ${f}`); return []; }
  const rows = parseCsv(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  return rows;
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isSkip = (s) => !s || /^[（(]?\s*(空|跳过|无|没有|不知道|不清楚)\s*[)）]?$/.test(s);

async function main() {
  // ---------- 1. 省份映射 ----------
  const provinceOf = new Map();
  for (const r of readCsv('colleges.csv')) {
    if (r.length < 2) continue;
    const prov = clean(r[0]); const name = clean(r[1]).replace(/[()（）【】#]/g, '').replace(/\s/g, '');
    if (prov && name) provinceOf.set(name, prov);
  }
  console.log(`  省份映射 ${provinceOf.size} 条`);

  // ---------- 2. 别名合并 ----------
  const aliasTo = new Map();
  for (const r of readCsv('alias.txt')) {
    const line = (r[0] ?? '').trim();
    if (!line) continue;
    const parts = line.split('🚮').map((x) => clean(x).replace(/[()（）【】#]/g, '').replace(/\s/g, '')).filter(Boolean);
    if (parts.length < 2) continue;
    const [main, ...aliases] = parts;
    for (const a of aliases) aliasTo.set(a, main);
  }
  console.log(`  别名合并 ${aliasTo.size} 条`);

  const blacklist = new Set();
  for (const r of readCsv('blacklist.txt')) {
    const line = clean(r[0]).replace(/[()（）【】#]/g, '').replace(/\s/g, '');
    if (line) blacklist.add(line);
  }

  // ---------- 3. 站点 slug（用于深链 colleges.chat） ----------
  const slugOf = new Map();
  const idxFile = [
    path.join(RAW, 'search_index.json'),
    path.join(ROOT, '_research', 'cc_search_index.json'),
  ].find((f) => fs.existsSync(f));
  if (idxFile) {
    try {
      const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8').replace(/^\uFEFF/, ''));
      for (const d of idx.docs || []) {
        const m = /^(?:archived\/)?universities\/([^/]+)\/?$/.exec(d.location || '');
        if (m && d.title) {
          const nm = clean(d.title).replace(/[()（）【】#]/g, '').replace(/\s/g, '').replace(/\(已归档\)$/, '');
          if (!slugOf.has(nm)) slugOf.set(nm, m[1]);
        }
      }
    } catch (e) { console.log('  ⚠ 搜索索引解析失败', e.message); }
  }
  console.log(`  站点 slug ${slugOf.size} 条`);

  // ---------- 4. 聚合 ----------
  /** school -> { answers: Map<qIdx, Map<answer,count>>, extra: [], count, v2: Map } */
  const schools = new Map();
  function ensure(name) {
    const raw = clean(name).replace(/[()（）【】#]/g, '').replace(/\s/g, '');
    if (!raw) return null;
    const canon = aliasTo.get(raw) || raw;
    if (blacklist.has(canon)) return null;
    if (!schools.has(canon)) {
      schools.set(canon, { name: canon, count: 0, answers: new Map(), extra: [], v2: new Map(), v2count: 0 });
    }
    return schools.get(canon);
  }
  function addAnswer(s, qi, text) {
    const t = clean(text);
    if (isSkip(t) || t.length > 300) return;
    if (!s.answers.has(qi)) s.answers.set(qi, new Map());
    const m = s.answers.get(qi);
    m.set(t, (m.get(t) || 0) + 1);
  }
  function addV2(s, qi, text) {
    const t = clean(text);
    if (isSkip(t) || t.length > 300) return;
    if (!s.v2.has(qi)) s.v2.set(qi, new Map());
    const m = s.v2.get(qi);
    m.set(t, (m.get(t) || 0) + 1);
  }

  for (const file of ['v1.csv', 'v1.additions.csv']) {
    const rows = readCsv(file);
    if (!rows.length) continue;
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 32) continue;
      const s = ensure(r[5]);
      if (!s) continue;
      s.count++;
      for (let q = 0; q < 25; q++) addAnswer(s, q, r[6 + q]);
      addAnswer(s, 25, r[31]);       // 自由补充 -> 特殊索引 25
      n++;
    }
    console.log(`  ${file}: 采纳 ${n} 份答卷`);
  }

  {
    const rows = readCsv('v2.csv');
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 36) continue;
      const s = ensure(r[3]);
      if (!s) continue;
      s.v2count++;
      for (let q = 0; q < V2_QUESTIONS.length; q++) addV2(s, q, r[10 + q]);
      const extra = clean(r[35]);
      if (extra && !isSkip(extra)) s.extra.push(extra);
      n++;
    }
    console.log(`  v2.csv: 采纳 ${n} 份答卷`);
  }

  // ---------- 5. 输出 ----------
  const out = [];
  for (const s of schools.values()) {
    if (s.count + s.v2count === 0) continue;
    const qa = [];
    for (const [qi, m] of [...s.answers.entries()].sort((a, b) => a[0] - b[0])) {
      const list = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      if (list.length) qa.push([qi, list]);
    }
    const v2 = [];
    for (const [qi, m] of [...s.v2.entries()].sort((a, b) => a[0] - b[0])) {
      const list = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      if (list.length) v2.push([qi, list]);
    }
    const slug = slugOf.get(s.name) || '';
    out.push({
      name: s.name,
      province: provinceOf.get(s.name) || '',
      slug,
      answers: qa,
      v2,
      extra: s.extra.slice(0, 20),
      resp: s.count + s.v2count,
    });
  }
  out.sort((a, b) => b.resp - a.resp || a.name.localeCompare(b.name, 'zh'));

  const payload = { questions: QUESTIONNAIRE, v2questions: V2_QUESTIONS, schools: out };
  const dest = path.join(OUT_DIR, 'colleges.json');
  fs.writeFileSync(dest, JSON.stringify(payload));
  console.log(`\n✓ ${dest}`);
  console.log(`  学校 ${out.length} 所，答卷合计 ${out.reduce((a, b) => a + b.resp, 0)} 份，文件 ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
  console.log('  覆盖 Top5:', out.slice(0, 5).map((x) => `${x.name}(${x.resp})`).join(' '));
  console.log('  有 slug 的学校:', out.filter((x) => x.slug).length);
}

main();

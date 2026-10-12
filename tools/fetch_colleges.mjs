/**
 * 下载 colleges.chat（大学生活质量指北）开源数据
 * 走 GitHub Git Blobs API（raw.githubusercontent 在本机不可达）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'colleges_raw');
fs.mkdirSync(OUT, { recursive: true });

const REPO = 'CollegesChat/university-information';
const REF = 'v2';
const HDR = { 'User-Agent': 'dsh-colleges-fetch', Accept: 'application/vnd.github+json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      console.error(`  重试 ${i + 1}: ${e.message}`);
      await sleep(1500);
    }
  }
  return null;
}

async function fetchBlob(sha, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  ⏭ 已存在 ${path.basename(dest)} (${fs.statSync(dest).size} bytes)`);
    return true;
  }
  const j = await getJson(`https://api.github.com/repos/${REPO}/git/blobs/${sha}`);
  if (!j || !j.content) { console.error(`  ✗ ${path.basename(dest)} 获取失败`); return false; }
  const buf = Buffer.from(j.content, j.encoding === 'base64' ? 'base64' : 'utf8');
  fs.writeFileSync(dest, buf);
  console.log(`  ✓ ${path.basename(dest)} ${buf.length} bytes`);
  return true;
}

(async () => {
  console.log('== 列出仓库 data/ ==');
  const listing = await getJson(`https://api.github.com/repos/${REPO}/contents/data?ref=${REF}`);
  if (!listing) { console.error('无法列出目录'); process.exit(1); }
  const files = {};
  for (const it of listing) { files[it.name] = it.sha; console.log(`  ${it.name}\t${it.size}\t${it.sha}`); }

  console.log('== 下载 ==');
  for (const [name, sha] of Object.entries(files)) {
    await fetchBlob(sha, path.join(OUT, name));
    await sleep(400);
  }

  // 额外：colleges.csv / alias.txt / 说明文档 / 站点搜索索引（用于生成 slug 深链）
  const jsdelivr = [
    ['questionnaires/colleges.csv', 'colleges.csv'],
    ['questionnaires/alias.txt', 'alias.txt'],
    ['questionnaires/blacklist.txt', 'blacklist.txt'],
    ['questionnaires/history.txt', 'history.txt'],
    ['docs/README.md', 'docs_README.md'],
  ];
  for (const [p, dest] of jsdelivr) {
    const u = `https://cdn.jsdelivr.net/gh/${REPO}@${REF}/${p}`;
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) {
        const b = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(path.join(OUT, dest), b);
        console.log(`  ✓ ${dest} ${b.length} bytes`);
      } else console.log(`  ✗ ${dest} HTTP ${r.status}`);
    } catch (e) { console.log(`  ✗ ${dest} ${e.message}`); }
    await sleep(300);
  }

  // 站点搜索索引：提供「校名 → colleges.chat 页面 slug」映射，用于生成原文深链
  const dest = path.join(OUT, 'search_index.json');
  if (!fs.existsSync(dest)) {
    for (const u of ['https://cn.colleges.chat/search/search_index.json', 'https://colleges.chat/search/search_index.json']) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) {
          const b = Buffer.from(await r.arrayBuffer());
          fs.writeFileSync(dest, b);
          console.log(`  ✓ search_index.json ${b.length} bytes  <- ${u}`);
          break;
        }
        console.log(`  ✗ search_index.json HTTP ${r.status} <- ${u}`);
      } catch (e) { console.log(`  ✗ search_index.json ${e.message} <- ${u}`); }
    }
  } else {
    console.log(`  ⏭ 已存在 search_index.json`);
  }

  console.log('\n== 产物 ==');
  for (const f of fs.readdirSync(OUT)) console.log(`  ${f}\t${fs.statSync(path.join(OUT, f)).size}`);
})();

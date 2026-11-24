# 高考志愿查询系统 · 设计文档

> 文档版本：v1.1（架构速览已增量同步至「数据质量治理」版本；原有章节结构保留，旧版 JSON 索引时代的描述标注为历史参考）
> 交付目录：`D:\AAAProject\AAAgithub\zhiyuan`
> 目标读者：项目维护者 / 使用者
>
> **当前实现以源码与 README 为准**：运行时是「便携 Node + 原生 `node:http` + `node:sqlite` 只读单文件库 +
> 原生 HTML/CSS/JS」，**零第三方依赖**；数据层真源是 `高考志愿助手/data/gaokao.db`
> （随包 Brotli 压缩为 `gaokao.db.gz`）。凡旧章节中「实时联网抓取」「31 省全覆盖」「按 JSON 索引」等表述
> 均为历史设计，当前口径见下文 **第 0 章速览** 与各章订正。

---

## 0. 当前架构速览（v1.1 增量同步）

> 本章是当前实现的速览。第 1–12 章保留原有章节结构；旧版 JSON 索引时代的描述作为历史参考保留，
> 并在关键处逐条订正。`docs/system_design.md` 是本轮数据质量治理的 1134 行技术方案与用户决策记录，
> 本文档不覆盖、不重写它。

### 0.1 技术栈与运行形态

| 项 | 当前实现 |
|----|----------|
| 运行时 | 便携 `runtime/node.exe`（Node 24，免安装）；原生 `node:http`、`node:sqlite`、`node:zlib` |
| 数据 | **单文件只读 SQLite**：`gaokao.db.gz`（Brotli，约 105 MB）首次启动解压为 `gaokao.db`（约 517 MB） |
| 前端 | 原生 HTML / CSS / JS（无框架、无打包、无 CDN） |
| 依赖 | **零第三方依赖**；数据质量类 API 全部本地只读、零联网 |
| 部署 | 双击 `启动.bat` → 本地 `127.0.0.1:8765`；端口自增、自动开浏览器；复制即安装、删除即卸载 |

### 0.2 server 模块（`高考志愿助手/server/`）

| 文件 | 职责 |
|------|------|
| `server.mjs` | HTTP 入口、全部 API 路由、静态托管、端口自增、自动开浏览器 |
| `data.mjs` | 基础数据层：31 省标准码 `PROVINCES`、院校库 / 大学环境、磁盘缓存 |
| `gcdb.mjs` | 统一数据源：`node:sqlite` 读 `gaokao.db`；字典编码、省码换算；`PROVINCE_ALIAS` 修正 **「内蒙」→「内蒙古」**（标准码 15），避免静默查到四川的数据 |
| `gcsource.mjs` | 把 SQLite 适配成推荐引擎所需的索引结构；`has2026` 由布尔改**四态**（`has2026Partial` 等），抽样年不再冒充「有 2026」 |
| `quality-core.mjs` | **共享纯逻辑（零依赖、无 IO）**：四态 `classifyCell`、`auditRankSeries`、`LARGE_GAP_SCORE=10`、`TABLE_SOURCE` 表级来源常量、`STATE_LABEL/STATE_SYMBOL/LEGEND/RULE_TEXT`；构建期与运行时共用，防规则漂移 |
| `quality.mjs` | **运行时质量唯一真源**：双模式（烘焙质量表优先 / 主表实时聚合）；`version / coverage / freshness / fields / issues / gaps / audit / report`、`snapshot`（统一 `dataQuality` 信封）、`usableYears`、`brief`、`roundTrip` |
| `resources.mjs` | 资料库：一分一段（新库优先、eol 回退）、选科过滤、院校 / 专业代码；表级来源 + `sourceBasis` |
| `recommend.mjs` / `plan.mjs` | 冲稳保引擎 / 志愿方案；**专业索引按可过滤有效行数选年份**（不再用全库 MAX 年份） |
| `upstream.mjs` / `indexer.mjs` | 可选联网代理（限速 / 熔断 / 缓存）、后台索引构建（历史链路，保留） |
| `ai.mjs` | AI 代理：注入数据版本、逐表截止年份与灰数据约束后转发 OpenAI 兼容接口 |

### 0.3 web 模块（`高考志愿助手/web/`）

`index.html`（骨架）、`app.js`（分数线 / 推荐 / 大学环境 / 志愿表 / 数据管理）、
`plan-ui.js`（志愿方案 / 资料库 / AI 助手）、`styles.css`（原生样式）、
**`quality-ui.js`（数据质量 UI）**：

- **家长精简版**：首页横幅 + 四态矩阵 + 图例（数据版本、逐表截止年份、新鲜度）；
- **维护者详情**：异常清单、字段非空率、校验和、抽样比对等放在 `<details>` 折叠里，**展开才懒加载**；
- 所有结果、CSV、打印页都带统一「数据快照条」。

### 0.4 tools 构建链路（顺序不可颠倒）

```
tools/build_gc_db.mjs          GaokaoCompass 2017–2025 历史库 -> data/gc/gaokao.db
        ↓（2026 增量按省并入）
tools/import_vault.mjs         gaokao-vault 2026 一分一段（7 省）
tools/import_legacy_index.mjs  旧版 JSON 索引并入（河北 2026 抽样）
tools/parse_rank_multi.mjs     多列版式一分一段页解析（--import 写库）
        ↓ 以上每一步在「确实写库 / 产出索引」处调用 appendProvenance
        ↓ 写开发侧台账 data/gc/provenance.json（按 表|省|年|来源 幂等 upsert，不随包）
tools/slim_gcdb.mjs            瘦身 -> data/gc/gaokao.slim.db（专业名规范化 / 精简列 / 最小索引 / meta）
        ↓
tools/verify_gcdb.mjs --apply 字段级校验 + 越界物理隔离 + 烘焙 9 张质量小表 + 内容指纹
                              （audit-only 可在只读随包库上安全出报告）
        ↓
tools/pack_gcdb.mjs --require-verified  Brotli 压缩 -> 高考志愿助手/data/gaokao.db.gz
```

`tools/lib/provenance.mjs` 提供 `appendProvenance`、`readProvenance`、`sha256*`、`standardPid`；
**台账只写开发侧、不随包**，真正随包的是 `verify_gcdb.mjs` 烘焙进 `gaokao.db` 的质量小表。
来源字符串一律取 `quality-core.mjs` 的 `TABLE_SOURCE`（表级），逐单元格出处由 `sourceUrl` 补充，
**不另造来源名**；河北 2026 抽样单元格标 `sampled=true, complete=false`。

### 0.5 数据表：四张主表 + 9 张质量小表 + meta + 内容指纹

**四张主表**（`quality-core.mjs` 的 `CORE_TABLES`）：`score_range`（一分一段）、
`school_adm`（院校投档线）、`major_adm`（专业录取分）、`plan_code`（招生计划）；
辅助表 `dict / school / school_code / plan_info`。

**9 张质量小表**（`--apply` 烘焙）：`data_manifest`、`table_manifest`、`cell_manifest`、
`coverage_cell`、`field_stats`、`quality_issue`、`gap_list`、`image_only`、`sample_audit`；
另有 `meta(k,v)`（`builtAt` / `minYear` / `dropVocational` / `dataVersion`）。

**内容指纹** `data_manifest.db_sha256` 由四张主表 `COUNT(*) + SUM(y)` 聚合计算
（不受 VACUUM / Brotli 影响，运行时可重算比对）；`pack_gcdb.mjs --require-verified`
会校验库与报告的数据版本、指纹一致，否则拒绝打包。

### 0.6 四态、图例与统一 dataQuality 信封

| 符号 | 含义 | 处置 |
|------|------|------|
| ● | 官方完整 `full` | 可进入算法参考年份 |
| ◐ | 部分 / 抽样 `partial` | **保留 + 标注 + 默认排除**（如河北 2026 投档线、专业录取分） |
| — | 缺失 `missing` | 不进候选集，可在质量面板查 |
| ⓘ | 仅图片 `imageOnly` / 回填 / 分数缺口 | 如实披露，不补值 |
| ≈ | 估算 / 拟合 | 页面与 AI 均须标注，不得说成当年官方数据 |
| ⚠ | 历史回退 | 基于历史年份时标注落后年数 |

- `classifyCell` 保证**无 unknown**；`fullRate`（历史完整度，2026-11-19 全量重建后
  披露 72.2%，基线 70.16%）与 `labeledRate`（四态标注率，门禁 100%）严格拆分，
  存量历史缺口如实披露、不阻断发版。
- **所有数据类 API 统一附带 `dataQuality` 信封**（由 `quality.snapshot()` 唯一产出）：
  数据版本、构建日期、逐表新鲜度、参考年份状态、灰数据 `flags`、图例、快照文案；AI 用 `brief()` 精简注入。
- **`usableYears()` 默认排除 partial / sampled / 仅图片 / 缺失年份**（U4），参考年份不会混入抽样年。
- **异常数据默认隐藏**（不进候选集、不显示、不计覆盖），但 `/api/quality/issues` 与
  质量面板「维护者详情」可查、可导出报告（Q4 / Q7）。
- 铁律：缺失（`NULL/0`）只披露、不填充、不隔离；只有「值存在但非法」才在构建期物理隔离并留快照。

### 0.7 关键数据口径（实测结论，不得推翻）

- **2026 一分一段 10 省 / 8,657 行、投档线 27 省 / 14,707 行、专业分 11 省 / 14,643 行**；
  `plan_code` 2026 **全缺**；河北 2026 `school_adm` / `major_adm` 是 `api.eol.cn` 后台抽样
  → 保留 + 标 `partial` + `sampled` + 默认排除；海南 2026 投档线 20 行最低分 788–879 越界，
  按 A2 全部隔离、该省该表不并入（如实记 `missing`）。
- `score_range` 有 `b` 批次分片、191/378 组 `seg` 全 NULL、`score<=0` 是总计人数汇总行；
  `cum=0` 是合法起点（只隔离 `cum<0`）；相邻分数差 **>10 分**才算大缺口（`LARGE_GAP_SCORE`）。
- **存量 53 组真不自洽**（其中 2 组属 2026 增量）原已降级 `partial` 并在基线
  `quality_report.json` 的 `rankSeriesDetail` 逐组披露；2026-11-19 全量重建后历史源为
  **51 组**，由 `tools/fix_rank_series.mjs` 按「去重 / 累计口径折叠 / 多来源表剔除 /
  列口径纠正」可追溯修复（不填充、不伪造），复验 0 组；验证记录见 `data/gc/rankfix/`
  与本轮 `data/gc/fullrebuild/fix_report*.json`。
  本轮按用户授权已把修复推广到交付库 `高考志愿助手/data/gaokao.db(.gz)`，旧包备份于
  `data/gc/fullrebuild/backup/`；基线报告与 `data/gc/rankfix/` 产物未覆盖。
- **不宣称「31 省全覆盖」**：历史库逐省逐年逐表并不齐全（如西藏无一分一段），一律
  **按省逐表标注截止年份**（`/api/quality/freshness`），禁止用全库 `MAX(y)` 冒充。
- **内蒙古别名**：`dict` 里的「内蒙」经 `PROVINCE_ALIAS` 归一到标准码 15（内蒙古），并有 `RT` 省码回环门禁。

### 0.8 9 个质量接口（全部本地只读、零联网）

`GET /api/quality/{manifest,coverage,freshness,snapshot,issues,fields,gaps,audit,report}` —— 分别返回
版本与图例、四态矩阵、按省逐表新鲜度、统一 `dataQuality` 信封、异常清单、字段非空率、
分数缺口与仅图片清单、抽样比对状态、合并报告。

### 0.9 测试与门禁命令

```bash
# 全量语法检查
for f in 高考志愿助手/server/*.mjs 高考志愿助手/web/*.js tools/*.mjs tools/lib/*.mjs; do \
  ./高考志愿助手/runtime/node.exe --check "$f"; done

# 后端 / 前端回归（脚本自拉起服务、跑完自动关闭）
node tools/api-test.mjs       # 80/80
node tools/render-test.mjs    # 42/42

# 构建期质量校验（audit-only 可在只读随包库上安全运行）
node tools/verify_gcdb.mjs --db 高考志愿助手/data/gaokao.db \
    --fail-on A1,C1,C1F,C2,C3,C4,RT --gaokao-year 2026 --baseline-year 2025

# 构建期 --apply 烘焙 + 发版门禁打包
node tools/verify_gcdb.mjs --db data/gc/gaokao.slim.db --apply \
    --fail-on A1,A1S,A2,A4,C1,C1F,C2,C3,C4,T2,RT --gaokao-year 2026 --baseline-year 2025
node tools/pack_gcdb.mjs --src data/gc/gaokao.slim.db --require-verified \
    --require-gates A1,A1S,A2,A4,C1,C1F,C2,C3,C4,T2,RT \
    --out 高考志愿助手/data/gaokao.db.gz --level 9
#    本轮交付实测：11/11 门禁全绿、包 105 MB、数据版本 2026.11.19-1
```

> **A1S（严格零不自洽）仍为 opt-in 默认关闭**：真不自洽组数 === 0 才通过。存量缺陷已在
> 可追溯修复后验证（`rank_series_true_fail === 0`、`rankSeriesDetail` 为空）。
> 2026-11-19 交付**显式**在 `--fail-on` / `--require-gates` 中加入 A1S，运行时默认值与
> `quality-core.mjs` 判定数学均未改，绝不默认启用、不放宽判定。详见 README「3.2 / 3.2.2」。

---

## 1. 项目概述

### 1.1 一句话定位

一个**免安装、免编程环境**的 Windows 桌面级网页应用：输入省份、科类与分数，即可查询各高校各专业历年录取分数线，查看大学真实生活环境，并获得「冲 / 稳 / 保」三档志愿推荐。

### 1.2 三项核心功能

| 编号 | 功能 | 说明 |
|------|------|------|
| F1 | 分数线查询 | 按「省份 + 学校 + 专业 + 年份」多维检索历年录取最低分、最低位次、省控线、线差、选科要求；支持趋势图与导出 |
| F2 | 大学环境查询 | 对接 colleges.chat（大学生活质量指北），按学校名检索住宿、食堂、交通、管理制度等真实在校生反馈；一键跳转原站 |
| F3 | 智能志愿推荐 | 输入「科类 + 分数（或位次）+ 意向专业」，输出冲 / 稳 / 保三档院校专业清单，附录取概率评估与推荐理由 |

### 1.3 非功能需求

| 需求 | 落地方案 |
|------|----------|
| **不需要编程环境** | 交付包内置便携式 Node.js 运行时，双击 `启动.bat` 即用，无需安装 Python / Node / 数据库 |
| **安装简单** | 整个应用是一个文件夹，复制即安装，删除即卸载，不写注册表 |
| **离线可用** | 内置离线数据包，无网络时仍可查询历史分数线与大学环境 |
| **数据准确** | 全部数据来自公开渠道（掌上高考 / 各省考试院口径），页面显著位置标注数据来源与免责声明 |
| **响应速度** | 本地服务 + 磁盘缓存，重复查询命中缓存为毫秒级 |
| **数据质量可追溯** | 四态标注 + 按省逐表截止年份 + 统一 `dataQuality` 信封；构建期烘焙质量小表与内容指纹（见第 0 章） |
| **运行时数据零联网** | 数据层真源是随包只读 SQLite；质量类 API 全部本地只读（可选联网代理仅用于按需补充与 AI 转发） |

---

## 2. 参考产品调研

### 2.1 夸克高考志愿（主要交互参考）

调研来源：[夸克推出2026高考志愿填报产品](https://www.news.cn/tech/20260605/7fe87a14a27f4dc2aaf2ce2e39b963b0/c.html)、[夸克上线2026高考频道](https://m.cnfin.com/wx/share?url=//m.cnfin.com/cmjj-lb//zixun/20260605/4422370_1.html)

| 借鉴点 | 本项目落地 |
|--------|-----------|
| 「冲 / 稳 / 保」三档分层展示，颜色区分（红 / 黄 / 绿） | 推荐结果按三档分栏卡片展示，顶部显示各档数量与录取概率 |
| 先填「分数 + 科类 + 选科」再出结果的分步表单 | 首屏即为「输入成绩 → 选专业意向 → 出结果」三步向导 |
| 每条推荐给出「录取概率」与「推荐理由」 | 每条结果展示录取概率百分比、近三年位次对比、推荐理由标签 |
| 「模拟选志愿」——未出分也可预填报 | 支持输入「模考分数」或直接输入「位次」，两种定位方式 |
| 院校卡片聚合展示（层次、地点、往年分数） | 结果卡片含 985/211/双一流 标签、所在城市、近三年最低分/位次迷你趋势 |
| 志愿表管理（收藏、导出） | 支持收藏、一键导出为 CSV / 打印志愿表 |

### 2.2 掌上高考（数据结构参考）

调研来源：[掌上高考官网](https://www.gaokao.cn)、[gaokao-admission-crawler](https://github.com/1837620622/gaokao-admission-crawler)、[China-query-of-college-admission-score](https://github.com/Chenwenwen1007/China-query-of-college-admission-score)

| 借鉴点 | 本项目落地 |
|--------|-----------|
| 数据颗粒度：院校专业组投档线 + 专业录取分 | 两套数据都抓：`school/province_score` 与 `school/special_score` |
| 字段：最低分 / 最低位次 / 平均分 / 省控线 / 分差 / 选科要求 | 完整保留并在详情页展示 |
| 新旧高考口径分离（专业组 vs 院校级） | 数据结构中标注 `batch`、`sg_name`（专业组），不混用 |
| 选科过滤（避免推荐不可报专业） | 推荐引擎内置选科要求解析与过滤 |

### 2.3 colleges.chat 大学生活质量指北（功能 2 数据源）

调研来源：[colleges.chat](https://colleges.chat/)、[GitHub: CollegesChat/university-information](https://github.com/CollegesChat/university-information)

- 定位：收集**招生简章不会写、但真实影响大学生活质量**的信息（宿舍几人间/有无独卫空调、断电断网时间、食堂、跑操、查寝、周边交通等）。
- 技术形态：MkDocs 静态站，数据源为仓库 `data/*.csv`，由 `questionnaires/main.py` 生成页面。
- 集成策略：
  1. **本地化**：抓取并转换为本地 JSON，实现关键词检索与结构化展示（无网络也能用）。
  2. **深链**：每条结果附「在 colleges.chat 查看原文」按钮，跳转 `https://cn.colleges.chat/universities/<slug>/`。
  3. 遵守其开源协议（仓库自带 LICENSE），保留来源署名。

### 2.4 其他开源参考

- [azheea/score_to_school](https://github.com/azheea/score_to_school)：掌上高考接口调用方式。
- [1837620622/gaokao-admission-crawler](https://github.com/1837620622/gaokao-admission-crawler)：全量 2707 所学校 × 32 省抓取工程化范式（断点续爬、并发控制）。
- [Chenwenwen1007/China-query-of-college-admission-score](https://github.com/Chenwenwen1007/China-query-of-college-admission-score)：官方投档数据 ETL + 冲稳保分层 + SQLite 轻量部署范式。

---

## 3. 数据源与接口契约

### 3.1 数据源清单

| 数据 | 来源 | 接口 | 覆盖 |
|------|------|------|------|
| 院校基础库 | 掌上高考 | `api.eol.cn/gkcx/api/?uri=apidata/api/gkv3/school/lists` | 2991 所（本科 1484 / 专科 1507） |
| 院校专业组投档线 | 掌上高考 | `...&uri=apidata/api/gk/score/province` | 旧版索引时代的上游接口；当前真源为 SQLite `school_adm`，**逐省逐年不齐，按省逐表标注截止年份** |
| 专业录取分数线 | 掌上高考 | `...&uri=apidata/api/gk/score/special` | 旧版索引时代的上游接口；当前真源为 SQLite `major_adm`，**逐省逐年不齐，按省逐表标注截止年份** |
| 专业库 | 掌上高考 | `...&uri=apidata/api/gkv3/special/lists` | 全国专业目录 |
| 大学环境 | colleges.chat | GitHub `data/v1.csv`、`data/v2.csv` | 数千条在校生问卷 |

> **订正（v1.1）**：上表为旧版 JSON 索引时代的上游抓取清单，仅作历史参考。当前随包数据以
> `GaokaoCompass`（2017–2025 历史库，MIT）+ `gaokao-vault`（2026 增量，Apache-2.0）为准，
> **不宣称「31 省 × 全年份 × 全表全覆盖」**：逐省逐年逐表并不齐全（如西藏无一分一段），
> 一律按省逐表标注截止年份（`/api/quality/freshness`）。2026 仅部分省份 / 部分表：
> 一分一段 10 省、投档线 27 省、专业分 11 省、河北投档线 / 专业分为后台抽样、招生计划当年全缺。

### 3.2 关键接口契约（实测确认）

> 以下为旧版在线抓取链路的接口契约，保留作历史参考；当前运行时数据层为只读 SQLite（见第 0 章），
> 数据质量接口全部本地零联网。本节不改动任何算法数学口径。

**通用请求头**

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/122.0.0.0 Safari/537.36
Referer:    https://www.gaokao.cn/
Origin:     https://www.gaokao.cn
```

**A. 学校列表**

```
GET https://api.eol.cn/gkcx/api/?uri=apidata/api/gkv3/school/lists&page=1&size=20&request_type=1

→ { code:"0000", data:{ numFound:2991, item:[{
      school_id, name, province_name, city_name, level_name, type_name,
      nature_name, f985, f211, dual_class_name, belong, rank, ...
  }] } }
```

**B. 院校专业组投档线**

```
GET https://api.eol.cn/gkcx/api/?uri=apidata/api/gk/score/province
      &school_id=104[&local_province_id=44][&year=2025][&page=1][&size=20]

→ data.item[] = {
    school_id, name, year,
    province_id, province_name,            // 学校所在地
    local_province_name, local_type_name,  // 生源地 / 科类
    local_batch_name,                      // 批次
    sg_name, sg_info, sg_sxk,              // 专业组 / 选科要求
    min, min_section,                      // 最低分 / 最低位次
    average, max, proscore,                // 平均分 / 最高分 / 省控线
    zslx_name, special_group
  }
```

**C. 专业录取分数线**

```
GET https://api.eol.cn/gkcx/api/?uri=apidata/api/gk/score/special
      &school_id=104[&local_province_id=44][&year=2025][&page=1][&size=20]

→ data.item[] = {
    school_id, name, year, local_province_name, local_type_name,
    sp_name, level2_name, level3_name,     // 专业名 / 门类 / 专业类
    sg_name, sg_info, special_group,
    min, min_section, average, max,
    proscore,                              // 该批次省控线
    info, remark                           // 备注（学制、体检限制等）
  }
```

**实测要点**

1. **免签名**：`signsafe` 非必需，纯 `GET` 即可返回数据（对比参考项目需 WAF Cookie 的方案更稳定）。
2. **两个接口的必填参数不同**：
   - `score/province` / `score/special` 只需 `school_id`，其余为过滤条件；
   - 误传 `size > 20` 会触发 `data: []` 空结构，故分页 `size` 固定 **20**。
3. **限流**：上游对**持续高频**请求会封禁（返回非 JSON 的挑战页），短促突发则容忍度较高。
   实测「连续约 200 次请求 + 主动休息 80 秒」可长期稳定运行；程序采用
   **令牌桶 + 突发休息 + 熔断退避**三重保护，并持久化缓存避免重复请求。
4. **在位年份**：实测 2023–2026 均有数据（**2026 年数据已发布**，为最相关年份）。
   不同省份发布进度不同，个别省份部分年份暂为空。
5. **无省控线 / 一分一段专用接口**，但 `proscore` 字段即该批次省控线，
   且 `(min, min_section)` 样本对可用于自建一分一段曲线（见 6.2）。
6. **专业分数线不预抓取**，按需查询 + 缓存 —— 既保证覆盖率，又显著降低上游压力。

### 3.3 数据合规

- 数据仅用于个人学习与志愿参考，不做二次分发与商业用途。
- 应用内固定展示免责声明：**录取结果以各省教育考试院与高校官方发布为准**。

---

## 4. 系统架构

### 4.1 总体架构

```
┌────────────────────────────────────────────────────────────┐
│  浏览器（Chrome / Edge）                                    │
│  http://127.0.0.1:8765                                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 前端 SPA（原生 HTML / CSS / JS，零外部依赖）          │  │
│  │  ├ 分数线查询   ├ 大学环境   ├ 智能推荐   ├ 志愿表    │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────────┬────────────────────────────────┘
                            │ fetch /api/*
┌───────────────────────────▼────────────────────────────────┐
│  本地服务  server.mjs（便携 Node.js，无第三方依赖）          │
│  ├ 静态资源服务（web/）                                     │
│  ├ 数据查询层（data/ 离线包 + cache/ 增量缓存）             │
│  ├ 上游代理层（api.eol.cn，带限速 + 退避 + 缓存）           │
│  └ 推荐引擎（冲稳保算法）                                   │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTPS
┌───────────────────────────▼────────────────────────────────┐
│  上游数据源：掌上高考 api.eol.cn（实时补充）                 │
└─────────────────────────────────────────────────────────────┘
```

> **订正（v1.1）**：上图为旧版「在线抓取」架构。当前数据层真源是随包只读 SQLite
> （`gaokao.db`），数据质量类 API 零联网；可选联网代理仅用于按需补充与 AI 转发。
> 当前模块与链路见第 0.2 / 0.4 节。

### 4.2 为什么需要本地服务

浏览器直接打开 `file://` 页面时：

1. 无法跨域请求 `api.eol.cn`（其 `Access-Control-Allow-Origin` 仅允许 `https://www.gaokao.cn`）；
2. 无法用 `fetch` 读取本地数据文件（`file://` 的 CORS 限制）。

因此采用「**便携运行时 + 本地 HTTP 服务**」方案：对使用者而言仍是「双击一个 bat」，但获得了完整的网络与文件能力。

### 4.3 目录结构

```
D:\AAAProject\AAAgithub\zhiyuan\
├── DESIGN.md                      ← 本文档（v1.1 架构速览见第 0 章）
├── README.md                      ← 使用说明 + 数据质量与发版门禁
├── docs\system_design.md          ← 数据质量治理技术方案与决策记录（不覆盖）
├── 高考志愿助手\                   ← ★ 可直接拷贝给任何人的交付目录
│   ├── 启动.bat / 停止.bat         双击启动（自动选端口、开浏览器）/ 强制结束残留进程
│   ├── runtime\node.exe           便携运行时（Node 24，免安装，约 89 MB）
│   ├── server\
│   │   ├── server.mjs             HTTP 服务入口 + API 路由 + 静态托管
│   │   ├── data.mjs               基础数据层（31 省标准码 / 院校库 / 大学环境 / 缓存）
│   │   ├── gcdb.mjs               统一数据源（node:sqlite；内蒙 → 内蒙古别名）
│   │   ├── gcsource.mjs           SQLite → 推荐索引适配（has2026 四态化）
│   │   ├── quality-core.mjs       共享纯逻辑（四态 / 自洽诊断 / 表级来源 / 图例）
│   │   ├── quality.mjs            运行时质量唯一真源（双模式 + dataQuality 信封）
│   │   ├── resources.mjs          资料库（一分一段 / 院校与专业代码 / 选科）
│   │   ├── recommend.mjs / plan.mjs / ai.mjs   推荐 / 志愿方案 / AI 代理
│   │   └── upstream.mjs / indexer.mjs          可选联网代理 / 后台索引（历史链路）
│   ├── web\
│   │   ├── index.html / app.js / styles.css     单页骨架 / 基础逻辑 / 原生样式
│   │   ├── plan-ui.js             志愿方案 / 资料库 / AI 助手
│   │   └── quality-ui.js          数据质量 UI（家长精简版 + 维护者折叠懒加载）
│   └── data\
│       ├── gaokao.db.gz           统一数据源（Brotli，约 105 MB，首次启动解压为 gaokao.db）
│       ├── schools.json.gz / colleges.json.gz / rank_table.json.gz
│       ├── skill_zhangxuefeng.md  AI 技能提示词
│       ├── index\                 旧版分数线索引（仅在缺 gaokao.db 时回退）
│       └── cache\                 查询缓存（可随时删除）
└── tools\                          ← 开发者用（使用者无需关心）
    ├── build_gc_db.mjs            GaokaoCompass 历史库下载入库
    ├── import_vault.mjs           2026 一分一段增量（gaokao-vault）
    ├── import_legacy_index.mjs    旧版 JSON 索引并入（河北 2026 抽样）
    ├── parse_rank_multi.mjs       多列版式一分一段页解析
    ├── slim_gcdb.mjs              瘦身（专业名规范化 / 精简列 / 最小索引）
    ├── lib\provenance.mjs         开发侧溯源台账（appendProvenance / sha256 / standardPid）
    ├── verify_gcdb.mjs            字段校验 + 越界隔离 + 烘焙 9 张质量小表 + 内容指纹
    ├── pack_gcdb.mjs              Brotli 打包（--require-verified 发版门禁）
    ├── api-test.mjs / render-test.mjs          回归测试（80/80、42/42）
    ├── crawl*.mjs / build_*.mjs / fetch_*.mjs  旧版抓取与装配链路（保留）
    └── data\gc\                   构建中间产物（filelist / *.db / quality_report.json / provenance.json）
```

> **踩坑记录**：`APP_DIR` 必须用 `fileURLToPath(import.meta.url)` 计算，
> 不能用 `new URL(...).pathname` —— 后者会把中文目录名百分号编码
> （`高考志愿助手` → `%E9%AB%98...`），导致数据被写到错误的目录。

---

## 5. 数据模型

### 5.1 院校（School）

```jsonc
{
  "id": 104,
  "name": "中山大学",
  "province": "广东",
  "city": "广州市",
  "level": "本科",           // 本科 / 专科（高职）
  "type": "综合类",
  "nature": "公办",
  "f985": 1,
  "f211": 1,
  "dualClass": "双一流",
  "belong": "教育部"
}
```

### 5.2 投档线记录（ProvinceScore）

```jsonc
{
  "schoolId": 104,
  "year": 2025,
  "province": "广东",        // 生源地
  "type": "物理类",           // 科类
  "batch": "本科批",
  "group": "（06）",          // 专业组
  "subjectReq": "物理、化学(2科必选)",
  "min": 774,
  "minRank": 254,
  "avg": null,
  "max": null,
  "batchLine": 483           // 省控线
}
```

### 5.3 专业分数线（SpecialScore）

```jsonc
{
  "schoolId": 104,
  "year": 2025,
  "province": "广东",
  "type": "物理类",
  "batch": "本科批",
  "groupId": "623984",
  "group": "（004）",
  "subjectReq": "首选物理，再选化学",
  "major": "临床医学",
  "category": "医学",          // level2
  "className": "临床医学类",   // level3
  "min": 663,
  "minRank": 1676,
  "avg": null, "max": null,
  "batchLine": 483,
  "remark": "（学制8年）（不招色盲色弱）"
}
```

### 5.4 大学环境（CollegeChat）

```jsonc
{
  "school": "北京大学",
  "province": "北京",
  "slug": "bei-jing-da-xue",
  "url": "https://cn.colleges.chat/universities/bei-jing-da-xue/",
  "items": [
    { "q": "宿舍是几人间？", "a": "4 人间，上床下桌" },
    { "q": "有没有空调？", "a": "有" }
  ],
  "raw": { /* 保留原始列，便于扩展 */ }
}
```

### 5.5 落盘与索引

为兼顾体积与查询速度：

- **离线包**：仅保留近 3 年（默认 2023–2025）全量数据，压缩为紧凑数组格式（列式存储 + 字典编码）。
- **增量缓存**：`data/cache/<schoolId>_<province>_<year>_<kind>.json`，首次在线查询后落盘，后续命中缓存。
- **内存索引**：服务启动时构建
  - `bySchoolId: Map<number, {province:[], special:[]}>`
  - `byProvinceType: Map<"广东|物理类", Entry[]>`（推荐引擎用）
  - 专业名称倒排：`Map<专业关键词, Set<schoolId>>`

> **订正（v1.1）**：5.1–5.5 是旧版 JSON 索引时代的逻辑模型，保留作历史参考；
> 当前落盘形态见 5.6 / 5.7 与第 0.5 节。

### 5.6 统一 SQLite 数据模型（当前实现）

**四张主表**：`score_range`（一分一段）、`school_adm`（院校投档线）、`major_adm`（专业录取分）、
`plan_code`（招生计划）；辅助表 `dict / school / school_code / plan_info`。
所有字符串字典编码、表内只存整数；`score_range` 的 `b` 为批次分片、`cum` 为全局累计，
`score<=0` 是总计人数汇总行，`seg` 允许整组 NULL（约半数历史年份只发布累计人数）。

**9 张质量小表**（`tools/verify_gcdb.mjs --apply` 烘焙，运行时 `quality.mjs` 优先读取）：
`data_manifest / table_manifest / cell_manifest / coverage_cell / field_stats /
quality_issue / gap_list / image_only / sample_audit`；另有 `meta(k,v)`
（`builtAt` / `minYear` / `dropVocational` / `dataVersion`）。
未烘焙时 `quality.mjs` 从主表只读实时聚合（双模式），无需重建交付库即可生效。

**内容指纹**：`data_manifest.db_sha256 = sha256(四张主表的 COUNT(*) 与 SUM(y) 聚合串)`，
不受 VACUUM / Brotli 影响；`pack_gcdb.mjs --require-verified` 会比对库与报告的数据版本、指纹。

### 5.7 四态矩阵与图例（当前实现）

四态 `full ● / partial ◐ / missing — / imageOnly ⓘ`（**无 unknown**），
外加灰数据图例 `≈ 估算拟合`、`⚠ 历史回退`（`quality-core.mjs` 的 `LEGEND`）。
`coverage_cell` 逐「表-省-年」保存状态、行数、基线行数、是否抽样、来源与判定依据；
`fullRate`（披露约 70.2%）与 `labeledRate`（门禁 100%）严格拆分，历史缺口如实呈现、不阻断发版。

---

## 6. 冲稳保推荐算法

> **实现状态**：已按本节实现并实测通过（见 6.4 的实证结果）。

### 6.1 定位方法：双模式

录取的本质是**位次竞争**，但位次并非人人拿得到，因此提供两种模式由用户选择。

#### 模式 A：按分数 —— 线差法（默认）

**无需一分一段表**，直接用数据自带的 `proscore`（该批次省控线）做归一化：

```
考生线差    = 考生分数 − 当年该批次省控线
院校线差_i  = 该年最低分 − 该年省控线            （i 为参考年份）
院校基准线差 = Σ(w_i × 院校线差_i) / Σ w_i        （w = [1.0, 0.7, 0.5]）
```

线差法的优势：自动抵消每年试卷难度与省控线的波动，跨年可比性强，
且完全不需要外部一分一段数据。

#### 模式 B：按位次 —— 位次法

```
院校基准位次 = Σ(w_i × 最低位次_i) / Σ w_i
```

对位次缺失的记录自动回退到线差法。

### 6.2 一分一段曲线（自建，供参考）

上游没有一分一段接口，但索引中每条记录都带 `(最低分, 最低位次)` 样本对，
可反推该省的位次分布：

1. 只取**本科批**样本（专科批 / 提前批的位次分布差异过大）；
2. 按分数分组，取组内位次的 **90 分位**（近似该分数段的累计人数）；
3. 单调化：分数越高 → 位次越小；压缩重复的垂直段；
4. 查询时线性插值，区间外按首末段斜率外推。

实测效果（北京 · 综合 · 2026）：

| 分数 | 700 | 680 | 650 | 600 | 550 | 500 | 450 | 430（本科线） |
|------|-----|-----|-----|-----|-----|-----|-----|------|
| 估算位次 | 1 | 439 | 3,031 | 12,682 | 26,772 | 41,980 | 55,252 | 59,286 |

与该市考生规模（约 6.7 万人）吻合。但页面明确标注**这是估算值**，
建议优先使用官方一分一段表并选择「按位次」输入。

### 6.3 录取概率模型与分档

以历史波动作为尺度，构造正态分布：

```
σ_线差 = max(近三年线差的样本标准差, 8 分)
z      = (考生线差 − 院校基准线差) / σ_线差
P      = Φ(z)                       # 标准正态累积分布
```

位次模式下同理：`σ_位次 = max(样本标准差, 基准位次 × 10%, 60)`。
概率裁剪到 `[2%, 98%]`，避免「100% 录取」这类绝对化表述。

分档直接依据概率，口径统一、可解释：

| 分档 | 概率区间 | 含义 | 建议占比 |
|------|---------|------|---------|
| 🔴 冲 | P < 45% | 往年门槛略高于你，可以冲一冲 | ~30% |
| 🟡 稳 | 45% ≤ P < 80% | 与你的水平相当，把握较大 | ~40% |
| 🟢 保 | P ≥ 80% | 明显低于你的水平，用来兜底 | ~30% |

### 6.4 实证结果

北京 · 综合 · 600 分 · 2026 本科线 429 → 考生线差 **171**：

| 档位 | 代表院校 | 概率 | 基准线差 |
|------|---------|------|---------|
| 冲 | 宁波诺丁汉大学、北京林业大学、合肥工业大学 | 43–44% | 172–175 |
| 稳 | 中国政法大学、西北农林科技大学、西南大学 | 45–46% | 172 |
| 保 | 西安电子科技大学、太原理工大学、河北医科大学 | 81% | 145–164 |

### 6.5 过滤与排序

1. **省份过滤**：只取考生生源地的招生记录。
2. **科类过滤**：严格匹配（物理类 / 历史类 / 理科 / 文科 / 综合），
   支持「理科 → 物理类」「文科 → 历史类」自动映射。
3. **批次过滤**：默认只看**本科批**，避免专科批、提前批混入。
4. **异常过滤**：分数 < 100 的记录剔除。
5. **选科要求**：随结果展示，供人工核对（不做强制剔除，避免误杀）。
6. **排序**：冲档按概率降序（越接近 45% 越优先），稳保档按概率升序（越稳越优先）。

### 6.6 招生单元的去重键

```
招生单元 = 院校 ID # 批次 # 专业组
```

同一院校的不同专业组、不同批次是**相互独立**的招生单元，必须分开统计，
否则会把热门组与冷门组的分数线混在一起（这是实测中修复的一个真实缺陷）。

### 6.7 推荐理由生成

- 「985 工程 / 211 工程 / 双一流」
- 「近 3 年数据」/「历年稳定」/「历年波动较大」
- 「门槛逐年上升 / 下降」
- 线差模式：「线差高出 X 分」/「线差低了 X 分」
- 位次模式：「你的位次领先 / 落后约 N 名」

### 6.8 专业维度匹配

用户填写意向专业时，取三档结果中排名靠前的院校（最多 12 所），
联网拉取其专业分数线，按 `专业名 / 门类 / 专业类` 关键词匹配，
并给出该专业的分数、线差、位次与录取概率。

专业数据**不预抓取**，全部按需获取并缓存 —— 既保证覆盖率，又不给上游造成压力。

### 6.9 边界处理

| 场景 | 处理 |
|------|------|
| 该省无本地索引 | 返回明确提示 + 一键把该省排入同步队列（只排用户查询的那一个省） |
| 参考年份不足 3 年 | 使用可用年份，理由中标注 |
| 省控线缺失 | 提示改用「按位次」输入 |
| 上下游被限流 | 自动退避重试；失败结果**不写入缓存**，避免把空数据固化 |
| 分数超出所有院校范围 | 只输出冲档，并提示关注提前批 / 强基计划 |

### 6.10 数据质量治理对算法的影响（v1.1，不改数学）

本节数学口径（`WEIGHTS`、`normalCdf`、`tierOf`、σ 下限、45% / 80% 分档阈值）
**保持冻结、未改动**。数据质量治理只影响**参考年份的选择**：
`quality.usableYears(pid)` 默认排除 `partial / sampled / imageOnly / missing` 年份（U4），
`recommend.mjs` / `plan.mjs` 的专业索引改为按「可过滤有效行数」选年份，
不再用全库 `MAX(y)` 冒充某省某表的最新年份；当只能回退到历史年份时，由 `dataQuality`
信封标注 `historyFallback` 与落后年数（⚠）。

---

## 7. 前端设计

### 7.1 界面结构

```
┌──────────────────────────────────────────────────────┐
│  🎓 高考志愿助手      [分数线查询][大学环境][智能推荐][我的志愿]  │
├──────────────────────────────────────────────────────┤
│  筛选区（省份 / 科类 / 年份 / 学校 / 专业）             │
├──────────────────────────────────────────────────────┤
│  主内容区                                             │
│   ├ 分数线查询：表格 + 趋势图 + 分组筛选               │
│   ├ 大学环境：学校卡片 + 问答列表 + 原文跳转           │
│   ├ 智能推荐：三档卡片（冲红 / 稳黄 / 保绿）           │
│   └ 我的志愿：收藏清单 + 导出 / 打印                   │
└──────────────────────────────────────────────────────┘
```

### 7.2 视觉规范

| 元素 | 规范 |
|------|------|
| 主色 | `#2563eb`（科技蓝） |
| 冲 | `#ef4444` 红 |
| 稳 | `#f59e0b` 琥珀 |
| 保 | `#10b981` 绿 |
| 字体 | `system-ui, "Microsoft YaHei", sans-serif` |
| 圆角 / 阴影 | `12px` / `0 2px 12px rgba(0,0,0,.06)` |
| 布局 | CSS Grid + Flex，最大宽度 1280px，移动端自适应 |

### 7.3 交互要点

1. **即时反馈**：筛选条件变化即触发查询，无需点「搜索」；长查询显示骨架屏。
2. **趋势图**：纯 SVG 手写折线图（不引入 ECharts，保证离线可用）。
3. **收藏**：`localStorage` 持久化，支持备注、排序、导出 CSV。
4. **空状态与错误态**：明确提示「本地无该数据，点击在线获取」并提供按钮。
5. **无障碍**：表格带 `scope`，颜色不作为唯一区分（同时显示文字标签）。
6. **数据质量 UI**（`web/quality-ui.js`）：首页 / 结果页横幅 + 四态矩阵 + 图例；
   **家长精简版**默认展示数据版本、逐表截止年份、新鲜度；异常清单、字段非空率、校验和、
   抽样比对等**维护者细节折叠在 `<details>` 里，展开才懒加载**（Q7）。
   异常数据默认隐藏，但质量面板与 `/api/quality/issues` 可查、可导出（Q4）。
7. **统一数据快照**：所有结果、CSV、打印页带 `dataQuality.snapshotText`
   （版本 / 构建 / 参考年份 / 灰数据 flags）。

---

## 8. 后端 API 设计（已实现）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/meta` | 数据版本、覆盖范围、统计信息 |
| GET | `/api/dict?provinceId=` | 省份 / 科类 / 年份 / 批次线字典 |
| GET | `/api/schools?q=&province=&level=&type=&dual=&page=&size=` | 院校检索（前缀优先 + 模糊 + 筛选 + 分页） |
| GET | `/api/school/:id` | 院校详情 + 环境数据摘要 |
| GET | `/api/score/province?schoolId=&provinceId=&year=` | 院校专业组投档线（本地索引优先，缺失回退联网） |
| GET | `/api/score/special?schoolId=&provinceId=&year=&major=&type=` | 专业分数线（联网 + 缓存） |
| GET | `/api/score/trend?schoolId=&provinceId=&major=&years=` | 历年趋势序列（最低/最高/平均分、最好位次、省控线） |
| GET | `/api/rank?provinceId=&year=&type=&score=` 或 `&rank=` | 分数 ↔ 位次换算（估算） |
| GET | `/api/colleges?q=&size=` | 大学环境检索 |
| GET | `/api/colleges/detail?school=` | 大学环境详情（问题分组 + 答案频次 + 原文深链） |
| GET | `/api/recommend?provinceId=&type=&score=&rank=&major=&batch=&limit=&year=` | 冲稳保推荐 |
| GET | `/api/status` | 数据覆盖、后台任务、上游限速状态 |
| GET | `/api/sync?provinces=&year=` 或 `?all=1` | 排队同步指定/全部省份 |

> 全部为 `GET`，方便在浏览器里直接调试；无第三方依赖，无鉴权（仅监听 `127.0.0.1`）。
> **订正（v1.1）**：上表为旧版 API 清单，保留作历史参考；当前数据层以只读 SQLite 为真源，
> 所有数据类响应统一附带 `dataQuality` 信封（由 `server/quality.mjs` 唯一产出）。

### 8.2 数据质量接口（9 个，全部本地只读、零联网）

| 路径 | 说明 |
|------|------|
| `/api/quality/manifest` | 数据版本、基准年、高考年、内容指纹、统一图例 |
| `/api/quality/coverage` | 四态矩阵（可按省 / 年 / 表过滤）+ `fullRate` / `labeledRate` |
| `/api/quality/freshness` | **按省逐表**新鲜度（各自截止年份与滞后，不用全库 MAX） |
| `/api/quality/snapshot` | 统一 `dataQuality` 信封（新鲜度、参考年份状态、灰数据 flags、快照文案） |
| `/api/quality/issues` | 异常清单（默认隐藏，仅此处与质量面板可查） |
| `/api/quality/fields` | 字段非空率与越界统计（维护者细节） |
| `/api/quality/gaps` | 结构性分数缺口（>10 分）与仅图片发布清单 |
| `/api/quality/audit` | 官方值抽样比对状态（未执行如实标注 `not_run`） |
| `/api/quality/report` | 合并报告（版本 / 覆盖 / 省码回环 / 异常 / 决策口径） |

---

## 9. 打包与分发方案

### 9.1 为什么选「便携 Node.js + bat」

| 方案 | 免编程环境 | 体积 | 可靠性 | 结论 |
|------|-----------|------|--------|------|
| 纯静态 HTML | ✅ | 小 | ❌ 无法跨域取数（`api.eol.cn` 的 CORS 只允许 gaokao.cn），数据只能全量内置 | 备选 |
| **便携 Node + 本地服务** | ✅ | ~120 MB | ✅ 完整网络与文件能力 | **采用** |
| Electron 打包 exe | ✅ | ~200 MB | ⚠️ 需构建工具链 | 过度设计 |
| 要求用户装 Python | ❌ | 小 | — | 违背需求 |

### 9.2 使用者操作

1. 复制 `高考志愿助手` 文件夹到任意位置（如桌面）。
2. 双击 `启动.bat`。
3. 浏览器自动打开 `http://127.0.0.1:8765`。
4. 关闭黑窗口即退出；`停止.bat` 用于强制结束。

### 9.3 启动脚本要点

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\node.exe" ( runtime\node.exe server\server.mjs --port 8765 --open )
else ( node server\server.mjs --port 8765 --open )
```

服务端负责：
- 端口占用自动递增（8765 → 8766 → …）；
- 启动后调用系统默认浏览器打开实际地址；
- 无运行时给出明确中文错误提示并 `pause`，避免窗口一闪而过。

### 9.4 数据抓取策略（重要决策）

上游 `api.eol.cn` 对**持续高频**请求会封禁 IP（返回非 JSON 挑战页 / 连接超时），
实测「连续约 200 次请求后必须主动休息」才能长期稳定。

因此设计如下，**把选择权交给用户**：

| 场景 | 行为 |
|------|------|
| 默认启动 | **不自动抓取**。只服务本地已有数据 + 按需实时查询 |
| 用户查分数线 | 每次 1–70 页（上限 1400 条），带缓存，查询优先于后台任务 |
| 用户查推荐（该省无索引） | 页面给出提示 + 一键把**该省**排入队列 |
| 用户主动点「补齐全部」 | 才排队批量抓取，后台限速、断点续爬 |

服务端进一步做了**优先级隔离**：`userBusy()` 为真时后台抓取任务主动挂起，
确保页面操作永远比后台任务先拿到配额。

### 9.5 构建链路与发版门禁（当前实现，v1.1）

```
build_gc_db.mjs → import_vault.mjs / import_legacy_index.mjs / parse_rank_multi.mjs
  → slim_gcdb.mjs → [可选一次性] fix_rank_series.mjs --apply（仅开发库工作副本）
  → verify_gcdb.mjs --apply → pack_gcdb.mjs --require-verified
```

> `fix_rank_series.mjs` 是**存量一次性修复**步骤，默认 `--dry`、显式 `--apply` 才写库，
> 事务化 + 幂等 + 写后复验；它只删除多余原有行或把错误 `seg` 列置 `NULL`，不生成新数值，
> 且拒绝写入任何受保护的原始库 / 交付库。

- 每个**确实写库 / 产出索引**的导入步骤调用 `appendProvenance` 写开发侧台账
  `data/gc/provenance.json`（按 `table|p|y|source` 幂等 upsert，不随包、不改交付库）；
  河北 2026 抽样单元格标 `sampled=true, complete=false`。
- `verify_gcdb.mjs`：`audit-only` 只读出报告；`--apply` 才物理隔离越界值、烘焙 9 张质量小表并写内容指纹。
  门禁 `A1,C1,C1F,C2,C3,C4,RT` 全绿；**A1S（严格零不自洽）仍为 opt-in 默认关闭**——
  存量 53 组已在工作副本上可追溯修复并验证 `rank_series_true_fail === 0`，**已具备启用条件**，
  但仍须显式 `--fail-on ...,A1S`，绝不默认启用、不放宽判定数学或删除异常记录。
- `pack_gcdb.mjs --require-verified` 校验报告 `mode=apply / passed / dataVersion / db_sha256`
  与库一致，否则拒绝打包；默认 `--require-gates A1,A2,A4,C1,C2,C3,C4,T2,RT`（**不含 A1S**），
  本轮交付显式追加 A1S。
- 回归：`tools/api-test.mjs`（80/80）、`tools/render-test.mjs`（42/42）；
  全量语法检查见第 0.9 节，A1S 启用条件与存量修复见 README「3.2 / 3.2.1」。

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 上游接口变更 / 加签 | 在线同步失效 | ① 内置离线数据兜底；② 上游逻辑集中封装在 `upstream.mjs`，便于快速替换 |
| 上游限流（code 1069 / 连接超时） | 抓取慢、查询失败 | ① **默认不自动抓取**，由用户按需触发；② 令牌桶 + 突发休息 + 熔断退避；③ 用户请求优先于后台任务；④ 失败结果不写缓存；⑤ 接口返回明确的中文提示而非空表 |
| 数据版权 | 合规风险 | 仅个人学习使用，不二次分发数据文件；页面署名来源与免责声明 |
| `min_section`（位次）缺失 | 推荐精度下降 | 自动回退线差法 |
| 一分一段表为推断值 | 位次定位存在误差 | ① 默认使用不需要一分一段的**线差法**；② 位次模式下明示「估算值」 |
| 本地索引覆盖不全 | 推荐功能受限 | ① 数据管理页一键按省同步；② 分数线查询与环境查询不受影响（实时联网） |
| 浏览器拦截 / 端口占用 | 打不开 | 端口自动递增并在控制台显示实际地址；提供 `停止.bat` |
| 把抽样 / 缺失当完整数据 | 推荐结果失真 | 四态标注 + `usableYears` 默认排除 + 统一 `dataQuality` 信封（河北 2026 口径） |
| 用全库最新年份冒充某省某表截止年份 | 时效误判 | 按省逐表 `freshness()`；专业索引按可过滤有效行数选年份 |
| 库内「内蒙」别名错配 | 内蒙古考生查到四川数据 | `gcdb.mjs` 的 `PROVINCE_ALIAS` 双向归一 + `RT` 省码回环门禁 |
| 交付库被二次改动 | 质量表与报告不一致 | 内容指纹 + `--require-verified` 拒绝打包 |

---

## 11. 交付状态（里程碑）

| 阶段 | 产出 | 状态 |
|------|------|------|
| M1 | 设计文档（本文档） | ✅ 完成 |
| M2 | 数据抓取工具 + 离线数据包 | ✅ 完成（院校库 2991 所 / 大学环境 4585 所 / 分数线索引持续增长） |
| M3 | 本地服务（代理 / 限速 / 缓存 / 查询 API） | ✅ 完成，13 个接口 |
| M4 | 前端五大功能页 | ✅ 完成（分数线 / 大学环境 / 智能推荐 / 我的志愿 / 数据管理） |
| M5 | 冲稳保推荐引擎 | ✅ 完成，实测通过 |
| M6 | 打包 + 使用说明 + 端到端验证 | ✅ 完成（21/22 项验收通过，历史记录） |
| M7 | 数据质量治理（四态 / 溯源 / 门禁 / 质量 UI） | ✅ 完成（api-test 80/80、render-test 42/42、verify_gcdb audit-only 门禁全绿） |

### 验收记录（节选）

```
F0 · 基础信息        ✅ 院校库 2991 所 / 大学环境 4585 所 / 索引 49 个省-年
F1 · 分数线查询      ✅ 院校检索 / 投档线（本地） / 专业线（联网 79 条） / 专业过滤（4 条） / 趋势
F2 · 大学环境        ✅ 检索 / 详情（武汉大学 221 份问卷、26 个问题）/ 原文深链
F3 · 冲稳保推荐      ✅ 线差法 / 位次法 / 三档均有结果 / 默认本科批 / 概率合法 / 理由非空
边界与错误处理      ✅ 非法省份提示 / 缺数据不崩溃 / 404 / 首页可访问
```

> **订正（v1.1）**：以上为旧版验收记录（「索引 49 个省-年」等表述属 JSON 索引时代）。
> 当前覆盖口径为**按省逐表标注截止年份**，不宣称 31 省全覆盖；最新回归结果见 M7 与第 0.9 节。

---

## 12. 免责声明

1. 本系统为个人学习与技术研究项目，不构成任何志愿填报建议或录取承诺。
2. 数据来源于公开网络渠道，可能存在滞后或误差，**最终以各省教育考试院与高校官方发布为准**。
3. 「冲稳保」结果与录取概率为基于历史数据的统计推算，不保证实际录取结果。
4. 使用时请遵守相关网站的服务条款与 robots 协议，控制请求频率。
5. 数据**按省逐表标注截止年份**，逐省逐年逐表并不齐全；抽样、缺失、仅图片与估算数据均已如实标注，
   请以应用内「数据质量」面板与各省教育考试院当年发布为准。

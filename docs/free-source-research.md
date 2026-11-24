# 高考志愿助手 · 免费外部数据源补齐调研报告

> 调研人：许清楚（产品经理） ｜ 日期：2026-11-22 ｜ 模式：市场调研 / 只读调研
> 本轮用户指令：「在网上找免费的数据源，补齐数据」——授权引入**免费**外部源（解除「一分一段沿用原源」约束），但排除付费源。
> 硬约束：全程只读公开网页 + 只读项目文件；未下载任何数据集、未写库、未改代码；唯一写入本报告。
> 前序报告 `docs/data-source-research.md` 的既有结论不推倒，本报告只做「外部免费源可执行性」增量核实。

---

## ① 一句话结论

**靠免费源无法把「近三年（23–26）全且准」补到齐；能补的是「2026 部分省的专业/院校投档线与一分一段」，而当前最大缺口 `plan_code 2026`（31 省全缺）在全市场找不到任何「免费 + 无需登录 + 可追溯 + 现成结构化」的源。** 具体：zmex（MIT）可立即补浙江/山东/河北/辽宁/湖北 5 省 2026 官方专业投档线；新发现的 secnotes/gaokao 可补 21 省 2026 院校投档线（但许可与 OCR/LLM 溯源有红线）；一分一段只能靠官方 PDF 人工/OCR（工具的 OCR 依赖付费 OpenAI API，不符合「免费」）；西藏结构性缺口无免费源可解；**云南 2024 那 24,585 行属库内同源字典可补，与外部源无关**。另需注意：按现有 `quality-core.mjs` 口径，2026 属 `expected=false`、记 `partial`，补 2026 数据**不会提升 72.2% 的 fullRate**，只提升数据本身可用性。

---

## ② 当前缺口速览（主理人查实基线，直接沿用）

交付库 542MB；四表行数：`score_range` 192,646 / `school_adm` 770,623 / `major_adm` 4,404,012 / `plan_code` 4,532,353；完整率 72.2%。

| 缺口 | 规模 | 外部免费源能否补 |
|---|---|---|
| **`plan_code` 2026** | **31 省全缺（最大缺口）** | ❌ 无现成免费可追溯源；只能自建抓取（见 §④-C） |
| `school_adm` 2026 | 27 省 partial（26 省抽样默认排除）；海南 20 行越界隔离；缺 4 省 | ✅ 部分：zmex 5 省 + secnotes 21 省可补真实投档线 |
| `major_adm` 2026 | 11 省 partial；缺 20 省 | ⚠️ 有限：zmex 5 省官方专业线（浙江/山东/河北/辽宁/湖北） |
| `score_range` 2026 | 10 省数值 + 17 省仅图片 + 缺 4 省（浙江/西藏/甘肃/新疆） | ⚠️ 需 OCR；zmex 有河北/辽宁/湖北 2026 一分一段；青海有官方 PDF |
| 2023–2025 真实缺口 | 44 格 missing/imageOnly（字段空 22 + 源无 21 + 空壳 1） | ❌ 已审计确认 GaokaoCompass 无数据，外部源覆盖率也极有限 |
| **云南 2024**（school_adm 1,711 + major_adm 22,874 行空校名/空专业名） | 24,585 行 | ✅ **库内同源 code→name 字典可补，不需外部源**（主理人已复核）；本报告单列，勿与外部源混为一谈 |
| 结构性缺口 | 西藏 2017–2026 一分一段全缺；青海多表缺 | ❌ 未找到免费结构化源 |

---

## ③ 各候选源核实结果

### ③-1 逐源核实表

| 源 | 许可 / 免费 | 覆盖（核实所得） | 是否含 2026 | 是否含 `plan_code` 招生计划 | 数据形态 / 可追溯性 | 最近更新 | 结论 |
|---|---|---|---|---|---|---|---|
| **zstar1003/zmex（择木而栖）** | 代码 **MIT**；数据来自教育部/考试院/掌上高考，须保留来源说明；免费无需登录 | 3,191 所院校；官方专业投档表浙江/山东/河北/辽宁/湖北 2026；全国索引 565,446 条（历史 472,165 + 2026 新增 93,281）；掌上高考聚合记录主要 2025 | ✅ 5 省 2026 官方专业线 + 河北/辽宁/湖北 2026 一分一段参考 | ❌ **README 与目录全文无任何招生计划数据** | JSON：`data/admissions/provinces/{省}.json`、`reference/{省}-{年}-score-ranks.json`；`sources.json` 有官方原表 URL + SHA-256 / 解密说明 | 2026-11-05~07 | **可立即补 5 省 2026 专业线**（排除新疆/西藏估算） |
| **secnotes/gaokao（新发现）** | GitHub **MIT**，但 README 免责声明写「**非商业用途**」→ **许可冲突，需拍板**；免费无需登录 | 21 省普通批**院校投档线**约 68 万条（安徽/湖北/浙江/江苏/山东/河南/福建/广东/湖南/广西/海南/重庆/贵州/新疆/内蒙古/山西/辽宁/黑龙江/河北/北京/上海） | ✅ 河北等省已有 2026 JSON（`by_province/hebei/2026_*.json`） | ❌ 只有投档线，无招生计划、无专业线、无一分一段 | 静态 JSON：`data/by_province/{省}/{年}_{科类}_{层次}.json`；每条带 `origin`(ocr/cleaned/llm/unrepaired) + `fixes` 溯源 | pushed 2026-09-08 | **可补 21 省 2026 投档线**；含 OCR/LLM 记录，需按红线过滤 |
| **lifefloating/gaokao-vault**（项目已引入） | **Apache-2.0**（以 LICENSE/GitHub API 为准；README badge 写 MIT，不一致）；免费但抓取需 Docker+PG+联网 | 13 类（含 score_segments / enrollment_plans / major_admission_results）；源为阳光高考/eol.cn/dxsbb/掌上高考；`YEAR_START` 2020（计划）/2018（分段） | ⚠️ full 模式覆盖到 2026；但项目 `.env` 是 incremental 模式，`_select_plan_years()` 只取 2025/2024/2023，**不含 2026** | ⚠️ 有 `enrollment_plan_spider` 能抓掌上高考计划，但**项目 `import_vault.mjs` 只导 score_segments，不导计划/专业线** | 抓取工程（Python/PostgreSQL），无现成可下载结构化产物；本地 `pgdata` 卷无落盘数据，`crawl_data/score_segments` 为空 | pushed 2026-05-13 | **链路存在但不通 2026**：需改模式+写新导入脚本；图片 OCR 依赖付费 OpenAI API |
| **huckops/gaokao（HF）** | MIT；免费无需登录 | `enrollment_plan_ds` 6,574,288 行 + 专业线 2,523,124 + 院校线 529,537 + 一分一段 117,314；**年份经 statistics API 核实为 2022–2025** | ❌ **2026 行程为 0**（年份 max=2025-01-01） | ✅ 有，但只到 2025 | Arrow（HF datasets）；无来源/考试院出处说明，可追溯性弱 | 2026-10-07 | ❌ 补不了 2026；2022–2025 计划与现库重复，无增量价值 |
| **666keke/Shanghai-Gaokao** | 许可不明（仅免责声明） | 仅上海 2020–2025 院校专业组投档线，含「580及以上」边界值 | ❌ | ❌ | 本地 JSON | 2026-06 | 只核验不并入（沿用前序结论） |
| **HoukChen/gaokao-admission-data（洛沃数据）** | 仓库展示样例，**完整数据由付费商城提供**；明确禁止「建立同类商业数据产品」 | 宣称 30 省 8 类；但仓库只有 100 行样例 Excel | ⚠️ 宣称到 2026，需付费 | 宣称有（付费） | Excel 样例 + SHA-256 清单 | 2026-08-16 | ❌ **付费源，用户明确不要** |
| **Zenodo「China New Gaokao Reform Provincial Database」** | 数据 CC BY 4.0 / 代码 MIT；免费 | 实为 GaokaoCompass 的学术衍生；四张大表（含 plan_rows）因体积/许可**不随附，需向作者索取** | ❌ 止于 2025 | 有但不随附、不可即时获取 | 论文加工面板 | 2026-09-18 | ❌ 无即时增量价值 |
| **各省考试院官方站** | 官方公开信息，引用注明出处 | 权威全表，PDF/图片/网页，格式各异 | ✅ 2026 官方原表齐全 | ✅ **招生计划唯一真正一手来源**（各省《招生计划汇编》PDF） | PDF/图片/HTML，需 OCR + 人工核对 | 持续 | ⚠️ 唯一能补 plan_code 2026 的路，但工作量最高 |

### ③-2 gaokao-vault 链路_detail（任务#2 专项）

- **能补什么**：从常量表看 `ENROLLMENT_PLANS`、`MAJOR_ADMISSION_RESULTS`、`SCORE_SEGMENTS`、`DXSBB_ADMISSION_RESULTS` 都在 PHASE3；源为 `static-data.gaokao.cn`（掌上高考）、`gaokao.chsi.com.cn`（阳光高考）、eol.cn、dxsbb.com。理论上覆盖 2026 一分一段/计划/专业线。
- **三个断点**：
  1. **本地无数据**：`_research/gv/gaokao-vault/` 只有源码 + `.venv` + 空 `crawl_data/score_segments/`；日志显示 2026-10-18 曾抓到 41,357 条 score_segments，但同期 OpenAI Vision 连接失败（图片源省无数据）。pgdata 卷无落盘数据，`import_vault.mjs` 直接跑会「没有可导入的数据」。
  2. **增量模式不抓 2026**：`_select_plan_years(incremental)` 在 11 月返回 `[2025,2024,2023]`；须改 `--mode full` 或改配置才会抓 2026。
  3. **导入脚本只认一分一段**：`import_vault.mjs:62-117` 只 `SELECT ... FROM score_segments` 并写 `score_range`；招生计划/专业线**没有对应导入逻辑**，需新写脚本。
- **需 Docker + PostgreSQL + 联网抓取**，构建期联网不违反「运行时零联网」，但**图片 OCR 走 OpenAI Vision API（`.env` 里 `OPENAI_VISION_MODEL=gpt-5.4`）是付费的**，与「免费源」冲突——17 省 imageOnly 一分一段靠它补，实际要付费。
- **无现成可下载结构化产物**：仓库只有抓取代码，不发布数据集。

### ③-3 zmex 数据可用范围_detail（任务#1 专项）

- **2026 官方专业投档表**：浙江（普通类第一/二段，xls，直接给位次）、山东（常规批第 1/2 次，xls，**无最低分列**，minScore 留空）、河北（本科批历史/物理，xlsx）、辽宁（本科批历史/物理，xlsx，Office 密码 VelvetSweatshop 加密）、湖北（院校专业组投档线，PDF；另有华北水利水电大学 14 条具体专业线）。
- **2026 一分一段参考**：`reference/hebei-2026-score-ranks.json`(50KB)、`liaoning-2026-score-ranks.json`(49KB)、`hubei-2026-score-ranks.json`(118KB)；无西藏/青海/浙江一分一段。
- **具体可下载路径**（raw.githubusercontent.com/zstar1003/zmex/main/...）：
  `data/admissions/provinces/山东省.json`(20.8MB)、`河北省.json`(32.7MB)、`浙江省.json`(21.3MB)、`湖北省.json`(12.9MB)、`辽宁省.json`(19.1MB)、`重庆市.json`(11.1MB)；`data/admissions/index.json`(9.5MB)、`major-index.json`(77.8MB)、`sources.json`(32KB)、`coverage.json`(9.5MB)。
- **位次口径**：河北/辽宁/湖北最低分位次用**各省 2026 年**官方一分一段累计人数换算，含义是「同分考生位次上限」，非精确个人排名；浙江/山东官方表直接给位次。均带当年官方 URL + SHA-256。
- **明确无 `plan_code`**：README「数据」「位次数据规则」全节、目录树、sources 登记均无招生计划条目。

### ③-4 结构性缺口_detail（任务#4 专项）

- **青海 2026 一分一段**：官方 PDF 确认存在且**文本可读**（`qhjyks.com/zyym/docs/20260625110554854328.pdf`，2026-06-25，物理/历史等 8 张表，累计人数完整）；阳光高考有转载页与 8 个 PDF 下载链接；多个二次整理网页有逐分明细。→ **可 OCR/转录补青海 2026**，但属人工/付费 OCR，非「免费现成结构化」。
- **西藏 2017–2026 一分一段**：搜索未找到任何免费、结构化、可追溯的源；官方亦未公开可下载表。→ **未能核实到可用免费源**，如实记为补不到。
- **山东/福建/海南一分一段空字段**：均属 GaokaoCompass 源 CSV 空壳，zmex/secnotes/vault 均不提供这些省的一分一段结构化数据。→ 免费现成源补不到；仅 vault 的 eol/dxsbb 抓取理论可补，但依赖付费 OCR。

---

## ④ 分层可执行方案

### A 层 · 能立即补（现成免费结构化数据，构建期一次性导入）

| # | 源 → 缺口 | 预计补多少 | 获取方式 | 合规判定 |
|---|---|---|---|---|
| A1 | **zmex → 2026 专业线**（浙江/山东/河北/辽宁/湖北 `major_adm` 2026） | 5 省，README 明示 2026 新增 93,281 条（全国，含非这 5 省的聚合记录）；仅取 5 省官方表部分 | 直接下 `provinces/{省}.json` + `reference/{省}-2026-score-ranks.json`，一次性脚本导入 | ✅ MIT；**只取带当年官方 URL+SHA-256 的记录**；山东无分数列须保持 minScore 空；河北/辽宁/湖北位次标注「同分上限」 |
| A2 | **zmex → 2026 一分一段**（河北/辽宁/湖北 `score_range` 2026） | 3 省 × 物理/历史 ≈ 3–6 千行（按参考表 50–118KB 估） | 下 `reference/*-2026-score-ranks.json` | ✅ 同上；注意这批省当前多为 imageOnly/partial，补后可转数值 |
| A3 | **secnotes → 2026 院校投档线**（`school_adm` 2026，21 省） | 21 省 2026 JSON（河北单省 4 文件约 16MB）；全库约 68 万条，2026 部分按省数万条 | 下 `data/by_province/{省}/2026_*.json`，按 `origin` 字段过滤 | ⚠️ **先拍板许可冲突**（MIT vs 非商业用途免责声明）；**排除 `origin=llm`/`unrepaired` 记录**，只留 `cleaned`/`ocr` 且经人工核对的；编译进 SQLite 是否算二次分发需确认 |
| A4 | **云南 2024 库内字典补名**（school_adm 1,711 + major_adm 22,874 行） | 24,585 行真实校名/专业名 | **不用外部源**，用同源同年 `code→name` 字典在库内 UPDATE | ✅ 不改数值、不伪造、纯库内同源修复；但需用户拍板「算不算填充」（前序遗留问题） |

> A 层不改变「运行时零联网、零第三方依赖、单 SQLite 文件」铁律：数据全部在构建期下载、离线导入。

### B 层 · 需抓取 / OCR（有可行性，但增加维护成本或触碰付费线）

| # | 动作 | 能补的缺口 | 工作量 / 可行性 | 红线 |
|---|---|---|---|---|
| B1 | **gaokao-vault 改造抓 2026**：`--mode full` 或改增量年份窗 → 写 `enrollment_plans` / `major_admission_results` 导入脚本 | **plan_code 2026（部分）**、major_adm 2026 | 高：需 Docker+PG 跑通抓取（本地当前无数据）+ 新写 2 个导入脚本；源为掌上高考（二次聚合，非省考试院一手） | 计划数据须标 `sampled/complete` 与来源；不伪造 |
| B2 | **官方 PDF 转录补青海 2026 一分一段** | 青海 `score_range` 2026（及多表缺） | 中：PDF 文本可读，转录/校验约 1–2 省天；8 张表择普通类物理/历史 | 转录值须人工复核，来源标注青海考试院 |
| B3 | **zmex 浙江一分一段缺**：zmex `reference` 无浙江 2026；官方浙江表是投档线非分段表 | 浙江 `score_range` 2026 | 高：需浙江考试院官方 PDF/OCR | 同 B2 |
| B4 | **secnotes 21 省投档线 2023–2025 回填**：若源 CSV 空壳的省年 secnotes 有数据可交叉核验 | 部分 2023–2025 真实缺口 | 中：逐格比对；但多数缺口是「源无」，secnotes 未覆盖的省补不到 | 不覆盖的如实记缺失 |

### C 层 · 补不到（如实说明）

| 缺口 | 为什么补不到 |
|---|---|
| **`plan_code` 2026（31 省全缺）** | **全市场无免费现成源**：zmex/gaokao-vault 现成链路/HF 公开数据集都不给；唯一一手是各省考试院《招生计划汇编》PDF（31 省 × 多年，需 OCR + 人工），或掌上高考逐校抓（B1，需自建 + 二次聚合）。**靠「下载一个免费源」在短期内做不到**。 |
| **西藏 2017–2026 一分一段** | 未找到任何免费结构化源；官方未公开可下载表。 |
| **山东/福建/海南一分一段空字段、2023–2025 的 44 格缺口** | 源 CSV 本身空/无，外部免费源对这些省年也无覆盖；审计已确认不可从 GaokaoCompass 补。 |
| **17 省 imageOnly 一分一段（免费路径）** | gaokao-vault 的图片 OCR 依赖付费 OpenAI Vision API，**不符合「免费」**；免费现成结构化源没有这些省 2026 分段表。 |
| **海南 2026 20 行（900 分制越界）** | 与数据源无关，是分数越界被隔离；需官方合法口径数据，非外部源问题。 |

### 对用户「近三年全且准」的诚实回答

- **2023–2025**：现库已是免费源的天花板（GaokaoCompass + 二次聚合源），44 格缺口是客观边界；**外部免费源几乎无法再补**。
- **2026**：投档线可补到 21–26 省、专业线可补 5 省、一分一段可补 3–6 省；**招生计划 31 省全缺补不到**。
- **完整率**：补 A 层后 `fullRate` 仍为 72.2%（2026 属 `expected=false`、记 partial，不进分子分母），但数据可用性实质提升。**不要用「完整率上升」做宣传口径。**

---

## ⑤ 合规红线与许可

| # | 红线 | 具体约束 |
|---|---|---|
| 1 | **跨年换算/模型估算严禁并入** | zmex 新疆 365 条（2025 最低分 + 2024 分段换算）、西藏 736 条（模型估算）**一律排除**；只取带当年官方 URL + SHA-256 的记录。 |
| 2 | **OCR/LLM 记录须过滤或标注** | secnotes `origin=llm` / `unrepaired` 记录非官方精确值，按铁律 1「不伪装非官方值」应排除；`ocr` 记录须人工核对后方可并入。 |
| 3 | **位次口径如实标注** | zmex 河北/辽宁/湖北 2026 位次是「同分考生位次上限」；山东无最低分列须留空（不得从他年补分）。 |
| 4 | **许可与二次分发** | zmex 代码 MIT（数据须保留来源说明）；vault Apache-2.0；**secnotes GitHub=MIT 但 README 写「非商业用途」→ 冲突，编译进 SQLite 交付是否合规须用户/法务拍板**；huckops MIT 但无出处说明。 |
| 5 | **抽样与不完整数据默认排除** | 河北 2026 抽样维持「保留 + 标注 + 默认排除」；任何新补数据若 `complete:false` 一律标 sampled/partial，不冒充完整官方数据。 |
| 6 | **运行时零联网 / 零第三方依赖 / 单文件** | 所有下载与 OCR 在构建期完成，交付仍是本地单 SQLite；不得引入运行时联网查询。 |
| 7 | **付费源不碰** | HoukChen/洛沃、CnOpenData、gugudata API、vault 的 OpenAI Vision OCR 均属付费，用户已明确排除。 |

---

## ⑥ 待用户拍板问题（5 条）

| # | 问题 | 建议 |
|---|---|---|
| 1 | 是否允许引入 **zmex（MIT）** 补 5 省 2026 官方专业线 + 河北/辽宁/湖北一分一段？ | ✅ 建议允许，只取带官方来源+SHA-256 的记录，排除新疆/西藏估算 |
| 2 | **secnotes/gaokao** 许可冲突（GitHub MIT vs README「非商业用途」）：是否允许将其 21 省 2026 投档线编译进交付 SQLite？ | ⚠️ 需明确拍板；若保守，则只用作交叉核验不并入 |
| 3 | `plan_code` 2026（最大缺口）是否接受「**自建抓取**」路线（vault 改造 或 31 省考试院 PDF OCR）？工作量高且部分源为二次聚合。 | 若「近三年全」是硬指标，建议至少先做用户高频省的招生计划抓取；否则如实接受 2026 计划全缺 |
| 4 | **云南 2024 那 24,585 行库内同源字典补名**是否算「填充」而不被禁止？（前序遗留问题） | 建议允许：纯库内同源、不改数值、不伪造 |
| 5 | 17 省 imageOnly 一分一段：vault 的 OCR 需付费 OpenAI API，与「免费」冲突。是否接受「付费 OCR 但只用于构建期转录、不引入运行时依赖」？ | 若坚持免费，则接受这 17 省继续记 imageOnly；若接受付费 OCR，需单独授权 |

---

## ⑦ 证据与链接

### 本轮实际访问的公开页面（均为只读）

- zmex README：https://raw.githubusercontent.com/zstar1003/zmex/main/README.md
- zmex 目录：`https://api.github.com/repos/zstar1003/zmex/contents/data/admissions`（含 `reference/`、`provinces/`、`sources.json`、`index.json`）
- zmex sources 登记：https://raw.githubusercontent.com/zstar1003/zmex/main/data/admissions/sources.json
- gaokao-vault 仓库元数据：https://api.github.com/repos/lifefloating/gaokao-vault（pushed_at=2026-05-13，license=Apache-2.0）
- secnotes/gaokao README：https://github.com/secnotes/gaokao ；元数据：https://api.github.com/repos/secnotes/gaokao（license=MIT，pushed_at=2026-09-08）；2026 数据样例：`data/by_province/hebei/2026_physics_benke.json`
- huckops/gaokao：https://huggingface.co/datasets/huckops/gaokao/blob/main/README.md ；年份统计：`https://datasets-server.huggingface.co/statistics?dataset=huckops/gaokao&config=enrollment_plan_ds&split=train`（2022–2025，无 2026）
- HoukChen/gaokao-admission-data：https://github.com/HoukChen/gaokao-admission-data
- Zenodo：https://zenodo.org/records/22826792
- 青海 2026 一分一段官方 PDF：https://www.qhjyks.com/zyym/docs/20260625110554854328.pdf ；阳光高考转载：https://gaokao.chsi.com.cn/gkxx/zc/ss/202606/20260625/2293847238.html
- 2026 招生计划官方查询入口：https://www.gk100.com/read_6037208.htm

### 项目内只读证据

- `_research/gv/gaokao-vault/README.md`（13 类数据源、Docker/PG 抓取、MIT badge）、`LICENSE`（实为 Apache-2.0）
- `tools/import_vault.mjs:62-117`（只导 score_segments → score_range）
- `_research/gv/gaokao-vault/src/gaokao_vault/spiders/enrollment_plan_spider.py:482-490`（增量模式年份窗不含 2026）
- `_research/gv/gaokao-vault/src/gaokao_vault/spiders/dxsbb_score_segments.py:158-188`（图片 OCR 走 VisionAnalyzer/OpenAI）
- `_research/gv/gaokao-vault/crawl_data/logs/crawl.log`（2026-10-18 抓到 41,357 条，同期 OpenAI Vision 连接失败）
- `_research/gv/gaokao-vault/.env`（`GAOKAO_SCHEDULE__MODE=incremental`、`OPENAI_VISION_MODEL=gpt-5.4`）
- `data/raw/province_11_2026.json` 等 5 个本地 2026 索引（items 为院校投档明细，`complete:true` 仅北京）

### 未能核实项（如实说明）

1. 未下载任何数据集文件，各源「补多少行」为基于 README/元数据/文件大小的**估算**，精确增量需实际下载后统计。
2. zmex 各省 JSON 的逐条 2026 记录数、secnotes 21 省 2026 精确行数未逐文件清点（只核实了河北 2026 文件存在与体量）。
3. gaokao-vault 抓取在真实环境能否成功拿到 2026 掌上高考计划/专业数据，未实际启动 Docker 验证（本地无落盘数据）；仅从源码逻辑判定链路断点。
4. 西藏一分一段、山东/福建/海南空字段的免费补充源：搜索未找到，记为「未能核实到可用源」，非断言绝对不存在。

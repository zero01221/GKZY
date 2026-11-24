# 高考志愿助手 · 使用说明

一个**免安装、免编程环境**的高考志愿查询工具。双击即可运行，不需要安装 Python、Node.js 或任何数据库。

> 仓库地址：<https://github.com/zero01221/GKZY>

---

## 〇、获取方式

### 方式 A：直接下载仓库压缩包（推荐普通用户）

在仓库页面点 **`Code` → `Download ZIP`**，解压后双击 `高考志愿助手\启动.bat` 即可。

**不需要装任何东西**：仓库里已经包含

- 便携运行时 `runtime\node.exe`（89 MB，免安装）
- 河北单省数据库 `data\gaokao.db.gz`（约 7.3 MB，首次启动自动解压成约 40.7 MB）
- 全国 31 省历史存档包另放在仓库根目录 `数据\`，不随网站默认包解压；详见「3.3 数据源替换」
- 院校库、大学环境数据、AI 技能提示词

> 首次启动会多花约 1 秒解压数据库，之后就很快了。
> 如果 Windows 提示"此文件来自其他计算机"，右键压缩包 → 属性 → 勾选「解除锁定」再解压。

### 方式 B：克隆源码（适合开发者）

```bash
git clone https://github.com/zero01221/GKZY.git
cd GKZY
```

克隆下来同样自带便携运行时，可以直接双击启动；也可以自己用系统 Node 跑：

```bash
node 高考志愿助手/server/server.mjs --port 8765 --open
```

> 约 89 MB 是 `runtime\node.exe`、约 7.3 MB 是当前随包的河北单省压缩数据库（运行时解压出的 `.db` 不计入仓库）。
> 全国存档包（压缩约 105 MB / 解压约 517 MB）单独放在 `数据\`，不计入随包体积。
> 只想要源码做二次开发的话，删掉 `高考志愿助手\runtime\` 和
> `高考志愿助手\data\gaokao.db.gz` 即可降到几 MB。

---

## 一、快速开始（3 步）

1. 把 **`高考志愿助手`** 整个文件夹复制到任意位置（桌面、D 盘都行，**路径尽量不要包含特殊符号**）。
2. 双击文件夹里的 **`启动.bat`**。
3. 稍等几秒，浏览器会自动打开 `http://127.0.0.1:8765`，即可开始使用。

> 关闭那个黑色命令行窗口 = 退出程序。
> 如果浏览器没有自动打开，请手动在浏览器地址栏输入窗口里显示的地址。

**常见问题**

| 现象 | 处理办法 |
|------|----------|
| 双击后窗口一闪而过 | 右键 `启动.bat` → 以管理员身份运行；或查看窗口里的报错信息 |
| 提示端口被占用 | 程序会自动切换到 8766、8767…，以窗口里显示的地址为准 |
| 杀毒软件报警 | 内置的 `runtime\node.exe` 是 Node.js 官方运行时，属正常文件，请放行 |
| 页面打不开 | 关闭窗口后重新双击 `启动.bat`；或用 `停止.bat` 清理残留进程 |
| 想彻底卸载 | 直接删除整个文件夹即可（不写注册表、不留残留） |

---

## 二、功能说明

### 1. 志愿方案（一键生成 80 条完整方案）⭐

输入 **省份 + 科类 + 选科 + 分数（或位次）+ 意向专业**，一键生成**含冲稳保梯度的完整志愿方案**（默认 80 条，可调到 112 条，符合多数省份的志愿数量上限）。

- **选科多选**：勾选自己的选科组合，系统按「选科要求」自动过滤掉不能报的专业组（如「首选物理，再选化学」）。
- **填报策略**
  - **院校优先**：同一院校只保留一个最优专业组，优先冲刺院校层次（985 / 211 / 双一流）
  - **专业优先**：锁定意向专业，同一院校可保留多个专业（最多 3 个）
- **梯度可调**：默认「冲 30 : 稳 40 : 保 30」，可自己改成 `20:50:30` 之类。
- **专业粒度**：已接入该省专业分数线数据时，每条会给出**具体专业**（含专业代码）；没有则退化为「院校专业组」粒度并明确提示。
- **可编辑**：生成后用 ↑ ↓ 调整顺序、✕ 删除，确认后一键**导出 CSV** 或**打印**。
- **定位准确**：优先用该省**真实一分一段表**把分数换算成位次，没有官方表时才退回拟合估算，并在页面上标明来源。

### 2. 智能推荐（冲 / 稳 / 保 卡片视图）

和「志愿方案」同一套算法，但以卡片形式按档展示，方便快速浏览与收藏。

| 档位 | 录取概率 | 含义 |
|------|---------|------|
| 🔴 冲 | < 45% | 往年门槛略高于你，可以冲一冲 |
| 🟡 稳 | 45% ~ 80% | 与你的水平相当，把握较大 |
| 🟢 保 | ≥ 80% | 明显低于你的水平，用来兜底 |

每条显示：录取概率、基准线差/位次、最近一年分数、近三年迷你趋势，以及可解释的理由标签。

**推荐会精确到专业**：卡片里会列出该专业组包含的具体专业（附专业代码），
填了意向专业时命中的专业会高亮并在院校名后标注「意向专业命中」，同一档内优先排序。

> 例：广东物理类 600 分、意向「计算机」→ 北京工业大学 205 组包含
> 自动化、计算机科学与技术、数学类、环境科学与工程类，其中「计算机科学与技术」高亮。

### 3. 分数线查询

按 **生源省份 + 科类 + 年份 + 院校 + 专业关键词** 检索。

- **院校专业组投档线**：最低分、最低位次、省控线、线差、选科要求。
- **专业录取分数线**：具体每个专业的最低分与位次（首次查询自动联网，之后走本地缓存秒开）。
- **历年趋势图**：纯 SVG 折线图展示最低分区间与省控线的逐年变化。

### 4. 资料库 ⭐

三类**真实数据**，全部可溯源到原文：

- **一分一段表**：来自中国教育在线转载的**各省官方发布表格**，已归一化为「分数 / 本段人数 / 累计人数」。
  - 支持「输入分数查全省位次」与「查看完整表格」
  - 官方仅以图片发布的省份会**如实标注并给出原文链接**，不做任何估算填充
  - 官方分段发布的表格若存在分数缺口，会明确列出缺口区间
- **院校代码**：教育部国标代码（5 位），如 中山大学 = 10558、清华大学 = 10003。
- **专业代码**：同时给出两类
  - **教育部专业（类）代码**：临床医学 = 100201K、法学 = 030101K（大类招生时给专业类代码，如 0809）
  - **省编专业代码**：各省招生专业目录里用于填报的代码，如中山大学临床医学在广东是 089
  - 附带：专业组、选科要求、招生计划数、学费、学制

> 代码会随各省招生计划逐年调整，填报前请以本省当年《招生专业目录》为准。

### 5. AI 助手（内嵌张雪峰技能）⭐

- 内嵌开源技能 **[张雪峰 · 思维操作系统](https://github.com/alchaincyf/zhangxuefeng-skill)**（MIT），围绕高考志愿 / 考研 / 职业规划做**多轮追问式**分析。
- 在「API 设置」里填入自己的 Key 即可用，**兼容所有 OpenAI 格式接口**：DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / 本地 Ollama…
- Key **只保存在你自己的浏览器里**，通过本机服务转发，不写磁盘、不上传别处。
- 会自动带上你在「志愿方案」页填的省份、分数、选科、意向专业作为上下文。
- 聊完后点 **「把对话结论转成志愿建议」**，AI 输出结构化的「冲/稳/保 + 学校 + 专业 + 理由」，直接渲染成卡片并可导出 CSV。

### 6. 大学环境

数据来自开源项目 **[colleges.chat（大学生活质量指北）](https://cn.colleges.chat/)**，是**在校生匿名问卷**的聚合结果，覆盖：

- 宿舍是不是上床下桌、几人间
- 教室和宿舍有没有空调、有没有独立卫浴
- 会不会断电断网、限电多少瓦
- 食堂价格、校园网质量、外卖政策
- 交通便利度、查寝与门禁、跑步打卡要求
- 以及「自由补充」里最真实的吐槽

搜索院校名即可查看；每条结果都附有「在 colleges.chat 查看原文」按钮。

> 本工具内置了 4500+ 所院校、3.3 万余份问卷的聚合数据，离线也能查。

### 7. 我的志愿

在任意结果里点 **☆** 即可加入志愿表，数据保存在本机浏览器中，支持 **导出 CSV** 与 **打印**。

### 8. 数据管理

查看新数据源（SQLite）的全貌：数据库大小、年份范围、院校数、**各表记录数**、
**逐年覆盖**（每年有多少省的一分一段/投档线）与**逐省覆盖**（每省各表的最新年份、
当年数据的四态标注），以及后台补抓任务、上游接口状态与**数据质量面板**。

> **当前随包数据源 = 河北单省库**（5 张录取数据表合计 638,411 行）。本节中全国 31 省的行数、
> 压缩体积与覆盖描述均为**全国存档包的历史规格**（见「3.3 数据源替换」），切换到全国存档包后才适用。

- 内置数据以 2017–2025 历史库为主（2026-11-19 全量重建后，专业级数据也已覆盖 2017 年起），但**并不是每省每年每张表都有数据**；
  「年份范围」不等于全覆盖，缺口在「数据质量」面板按 ● 完整 / ◐ 部分·抽样 / — 缺失 / ⓘ 仅图片 四态如实标注。
- 数据质量面板**默认给家长看精简版**（数据版本、逐表截止年份、新鲜度、图例）；
  异常清单、字段非空率、校验和、抽样比对等**维护者细节折叠**在「维护者详情」里，展开才加载。
- 首页横幅与所有结果、CSV、打印页都带**统一数据快照**（数据版本 / 构建日期 / 参考年份 / 灰数据标记）。
- 若想补齐某省某年缺失，可在这里**按需同步**：选择省份 → 同步 → 后台限速抓取，
  **不影响你继续使用页面**。
- 想一次性补齐，可点「补齐最近三年全部省份」（耗时较长，可随时关闭程序，下次会从断点继续）。

**数据是怎么存的（轻量设计）**

全部数据打包成 **一个 SQLite 文件**（`data/gaokao.db`），随包发布的是它的 Brotli 压缩版
`data/gaokao.db.gz`（当前河北库约 7.3 MB，解压约 40.7 MB；全国存档包的全量重建规格约 105 MB），
首次启动自动解压。

| 做法 | 效果 |
|------|------|
| 字符串全部字典编码，表里只存整数 | 专业名/校名/批次各存一份 |
| 专业名规范化（源数据里带整段括号说明，最长 639 字符） | 字典从 65 万条降到 3.9 万条 |
| 招生计划只留「代码映射」，学费/学制去重成单独小表 | 该表体积减半 |
| 只建查询真正用到的索引 | 索引从 302 MB 降到约 40 MB |
| Brotli 压缩后再随包 | 全国库 517 MB → 105 MB；当前河北库 40.7 MB → 7.3 MB |

> 全国存档包：从 **1.35 GB 原始 CSV** 到 **105 MB 文件**（约 1/13），零第三方依赖、单文件、可离线。
> 当前随包的河北库是它的单省裁剪版（约 7.3 MB）。
> 2026-11-19 已按用户授权执行全量重建（`slim_gcdb.mjs --min-year 0`），专业录取分与招生计划已补回 2017–2022；52 MB 的旧包只保留近三年专业数据。

**关于「智能推荐」的省份覆盖**

- 若某省已有本地索引 → 直接秒出结果。
- 若某省没有索引 → 程序会自动做一次**快速抽样建库**（抓取前 600 条左右），
  约 1 分钟内先给出结果，并在页面上标注「本次结果基于快速抽样数据」；
  同时完整数据会在后台继续补齐，稍后刷新会更准确。

> 「分数线查询」和「大学环境」**任何省份都能用**（实时联网获取），不需要预建索引。

**已内置数据（随版本更新）**

基础数据来自两个开源项目（GaokaoCompass 为 MIT、gaokao-vault 为 Apache-2.0），2026 另有本地后台补抓索引；已统一为一套格式：

| 数据源 | 内容 | 覆盖 |
|--------|------|------|
| [choucisan/GaokaoCompass](https://github.com/choucisan/GaokaoCompass) | 一分一段表、院校投档线、专业录取分、招生计划、院校/专业代码 | 历史库 2017–2025、多数省份、约 1133 万行；**逐省逐年逐表并不齐全** |
| [lifefloating/gaokao-vault](https://github.com/lifefloating/gaokao-vault) 及本地后台补抓索引 | 2026 增量：一分一段、投档线、专业分 | 全量重建后：一分一段 10 省 / 8,657 行、投档线 27 省 / 14,707 行、专业分 11 省 / 14,643 行（均标 `partial`，当年数据默认不进算法参考年份）；河北投档/专业仍为**后台抽样**；`plan_code` 2026 全缺。海南投档线 20 行最低分 788–879 越界，已隔离未并入 |

| 表 | 行数（全国存档包；当前随包河北库见「3.3」） |
|----|-----------------|
| 一分一段表 score_range | 192,646（2017–2026，逐省逐年不齐） |
| 院校投档线 school_adm | 770,623（2017–2026，逐省逐年不齐） |
| 专业录取分 major_adm | 4,404,012（2017–2026，全量补回） |
| 招生计划 plan_code | 4,532,353（2017–2025，2026 全缺） |
| 院校招生代码 school_code | 243,727 |
| 院校主表 school | 5,354 所 |

> 2026-11-19 全量重建后四表均保留**全部年份**（`meta.minYear` 为空表示不裁剪），
> 其中 `major_adm` / `plan_code` 的 2017–2022 共补回约 547 万行；越界值按 A2 物理隔离 2,827 条。
> 推荐算法本身仍只用近三年，更多历史年份用于「数据管理」查询与逐年比较。

> 即使某省某年缺本地数据，「分数线查询」和「大学环境」功能依然**完全可用**（会实时联网获取）。

---

## 三、数据说明

| 项目 | 说明 | 协议 |
|------|------|------|
| 一分一段 / 投档线 / 专业录取分 / 招生计划 / 代码 | [choucisan/GaokaoCompass](https://github.com/choucisan/GaokaoCompass)（31 省 × 2017–2025，1133 万行） | MIT |
| 2026 增量（一分一段 / 批次线 / 招生计划） | [lifefloating/gaokao-vault](https://github.com/lifefloating/gaokao-vault)（阳光高考 / 中国教育在线 / 大学生必备网） | Apache-2.0 |
| 院校元信息（985/211/双一流/类型） | 掌上高考（`api.eol.cn`）公开接口 | — |
| 大学环境 | [colleges.chat](https://cn.colleges.chat/) 开源问卷（在校生匿名回答） | — |
| AI 技能提示词 | [alchaincyf/zhangxuefeng-skill](https://github.com/alchaincyf/zhangxuefeng-skill) | MIT |
| 覆盖范围 | **以下为全国存档包口径**；当前随包仅河北单省，见「3.3 数据源替换」。历史库 2017–2025 覆盖多数省份，但**并非 31 省 × 全年份 × 全表齐全**（如西藏无一分一段）；2026 一分一段 10 省 / 投档线 27 省 / 专业分 11 省，河北投档线与专业分为抽样，海南投档线因整表越界未并入。逐省逐表以应用内「数据质量」面板为准 | — |
| 存储方式 | 单文件 SQLite（`data/gaokao.db`），随包 Brotli 压缩为 `gaokao.db.gz`（当前河北单省库约 7.3 MB / 解压约 40.7 MB；全国存档包约 105 MB / 517 MB，见「3.3 数据源替换」） | — |
| 存储位置 | 全部在 `高考志愿助手\data\` 下，不上传任何个人数据 | — |

> 分数、位次等数据来自公开渠道，可能存在滞后或误差。**最终请以各省教育考试院和高校官方发布为准。**

### 3.1 数据质量与时效

工具把「数据准不准、全不全、到哪年」当作一等公民：默认**不填充缺失、不把抽样当完整、不用全库最新年份冒充某省某表的截止年份**。

| 标记 | 含义 | 处置 |
|------|------|------|
| ● | 官方完整 | 可进入算法参考年份 |
| ◐ | 部分 / 抽样 | **保留 + 标注 + 默认排除**（如河北 2026 投档线、专业录取分） |
| ≈ | 估算 / 拟合 | 页面与 AI 均须明确标注，不得说成当年官方数据 |
| ⓘ | 回填 / 仅图片 / 分数缺口 | 如实披露，不做补值 |
| ⚠ | 历史回退 | 基于历史年份时标注落后年数 |
| — | 缺失 | 不进候选集，可在质量面板查 |

- **缺失（`NULL/0`）只披露、不填充、不隔离**；只有「值存在但非法」才在构建期物理隔离，并保留异常清单快照。
- 高考年度固定取当前日历年，不考虑复读 / 模考场景。
- 异常数据默认隐藏，但 `/api/quality/issues` 与质量面板「维护者详情」可查、可导出报告。
- 所有数据类 API 都带统一 `dataQuality` 信封；AI 助手会被注入数据版本、逐表截止年份与灰数据约束。
- 质量接口：`/api/quality/{manifest,coverage,freshness,snapshot,issues,fields,gaps,audit,report}`（全部本地只读、零联网）。

### 3.2 发版门禁与 A1S（严格自洽）

构建期门禁在 `tools/verify_gcdb.mjs`：默认 `audit-only`（只读出报告，不改动任何库）；
`--apply` 才物理隔离越界值并烘焙质量表。日常发版/回归使用的门禁集合为：

```bash
node tools/verify_gcdb.mjs --db 高考志愿助手/data/gaokao.db \
    --fail-on A1,C1,C1F,C2,C3,C4,RT --gaokao-year 2026 --baseline-year 2025
```

| 门禁 | 含义 | 默认 |
|------|------|------|
| A1 | 所有一分一段组已审计，且真实不自洽的单元格均已降级 `partial`（默认排除、不冒充 `full`） | ✅ 启用 |
| C1 | 四态标注覆盖率 100%（无 unknown，`labeledRate`） | ✅ 启用 |
| C1F | 历史完整度 `fullRate` 不低于 `--min-full-rate`（默认 0.6；`fullRate` 本身只是披露指标） | ✅ 启用 |
| C2 / C3 / C4 / RT | 状态率 / 抽样标注（河北 2026）/ 字段统计 / 省码回环 | ✅ 启用 |
| **A1S** | **严格「零不自洽」：真不自洽组数 === 0** | **❌ 默认关闭（opt-in）**：已具备启用条件，但仍需显式 `--fail-on ...,A1S` |

**A1S 仍为 opt-in 的原因**：这是发版策略选择，不是数据能力限制。历史存量曾有
**53 组一分一段真不自洽**（`Σseg` 与末 `cum` 不符、累计人数回退），原已在
`data/gc/quality_report.json` 的 `rankSeriesDetail` 逐组披露、按 A1 降级 `partial`，
**如实披露并排除，不填充、不伪造、不删记录**。现已在**工作副本**上完成可追溯修复并验证
（见下「3.2.1」），但运行时的默认门禁集合、`quality-core.mjs` 的判定数学、A1/A1S 判定
一律未改；A1S 保持 opt-in，绝不默认启用。

**启用前置条件（现已具备）**：`tools/fix_rank_series.mjs` 用仓库内原有数据修复存量缺陷 →
在**开发库工作副本**上 `--apply` → `tools/verify_gcdb.mjs --apply` 重新烘焙质量表 →
报告 `checks.rank_series_true_fail === 0`、`rankSeriesDetail` 为空、含 `A1S` 的全门禁通过 →
才在 `--fail-on` 中**显式追加** `A1S`。验证记录见 `data/gc/rankfix/` 下的
`fix_report_*.json` 与 `verify_report_*.json`。

> A1S **不在** `verify_gcdb.mjs` 的默认 fail-on，也**不在** `pack_gcdb.mjs --require-verified`
> 的默认 `--require-gates`（`A1,A2,A4,C1,C2,C3,C4,T2,RT`）里，**绝不默认启用**。
> 严禁为了让它变绿而放宽 A1 规则、下调阈值或删除异常记录。
> 2026-11-19 按用户授权已走完整构建链路把修复**推广到交付库**：`--min-year 0` 全量重建 →
> `fix_rank_series.mjs --apply`（本轮历史源 51 组）→ `verify_gcdb.mjs --apply` →
> `pack_gcdb.mjs --require-verified`（显式含 A1S）。旧交付库已备份在
> `data/gc/fullrebuild/backup/`，失败可回滚；基线 `data/gc/quality_report.json` 未覆盖。

#### 3.2.1 存量 53 组修复（不填充、不伪造）

`tools/fix_rank_series.mjs`（零第三方依赖、零联网、只用 `node:` 内置模块与 `node:sqlite`）：

```bash
# 默认 --dry：只诊断并输出逐组修复清单，不写任何库
node tools/fix_rank_series.mjs --db data/gc/rankfix/gaokao.work.db \
    --report data/gc/rankfix/fix_report.json

# 显式 --apply 才在事务中写库；受保护的原始库/交付库一律拒绝写入
node tools/fix_rank_series.mjs --db data/gc/rankfix/gaokao.work.db --apply \
    --report data/gc/rankfix/fix_report.json
```

逐组根因与动作（清单 JSON 里按「省 / 年 / 科类」记录修复前后 `Σseg` / 末 `cum` / 回退次数、
影响行数、动作与证据）：

| 根因 | 证据 | 动作 |
|------|------|------|
| R1 重复导入 | 整组两份 8 列完全相同的行，`Σseg` 恰为末 `cum` 的 2 倍（新疆 6 组、山东 2026） | 去重，保留 `rowid` 最小的原有行 |
| R2 累计口径重复 | 分数被补齐成连续整数网格，同一 `cum` 及其 `seg` 复制到多行；按 `cum` 折叠后 `Σseg` 恰恢复为末 `cum` | 同一 `cum` 只保留一条原有行 |
| R3 多来源表叠加 | 同 `(p,y,c)` 混入 2–5 张独立表（`cum` 口径重置 / 汇总行），跨表排序造成回退 | 剔除多余来源表，只保留末累计人数最大的主表 |
| R4 / R5 列口径错配 | 同分数多套序列；`seg` 与 `cum` 差分不符且无法从原有行还原 | 同分数折叠；把不可信 `seg` 列如实置 `NULL`（与库内既有 `seg` 未发布形态一致） |

**铁律**：所有写入只有「删除多余原有行」和「把错误 `seg` 列标注为未发布」，保留下来的
每个数值都能追溯到某条原有行的 `rowid`；无插值、无拟合、无按公式生成的新数值、无外部数据源。
脚本幂等（重复 `--apply` 零改动），事务化写入且写后复验，失败自动回滚。

命令示例（A1S 为 opt-in，**必须显式追加**）：

```bash
# 1) 修复后重新校验并烘焙（A1S 显式启用；若未修复会在此处阻断）
node tools/verify_gcdb.mjs --db data/gc/gaokao.slim.db --apply \
    --fail-on A1,A1S,A2,A4,C1,C1F,C2,C3,C4,T2,RT --gaokao-year 2026 --baseline-year 2025

# 2) 打包时同步要求 A1S 通过
node tools/pack_gcdb.mjs --src data/gc/gaokao.slim.db --require-verified \
    --require-gates A1,A1S,A2,A4,C1,C1F,C2,C3,C4,T2,RT \
    --out 高考志愿助手/data/gaokao.db.gz --level 9
```

### 3.2.2 全量重建交付记录（2026-11-19）

按用户「下载，只要数据库是全的就可以」的授权，已用同一 GaokaoCompass 源全量重建并替换交付库：

| 步骤 | 命令要点 | 结果 |
|------|----------|------|
| 备份 | 复制旧 `.db` / `.gz` 到 `data/gc/fullrebuild/backup/` | 旧包 54,186,201 B，SHA256 已留档，可回滚 |
| 全量 build | `build_gc_db.mjs --concurrency 8` | 861 CSV / 1.35 GB，0 失败；major 4,391,607、plan 4,532,353 行 |
| 不裁剪 slim | `slim_gcdb.mjs --min-year 0`（不传 `--drop-vocational`） | 447.6 MB；`meta.minYear` 为空；四表均 2017 起 |
| 存量修复 | `fix_rank_series.mjs --apply` | 历史源 51 组全部修复，删 17,131 行、seg 置未发布 440 行；复验 0 组 |
| 2026 增量 | 逐省 `import_legacy_index.mjs --year 2026`（10 省带 `--rank`） | 一分一段 10 省、投档线 27 省、专业分 11 省；河北抽样如实标注 |
| 烘焙门禁 | `verify_gcdb.mjs --apply --fail-on A1,A1S,...,RT` | 11/11 全绿，`rank_series_true_fail=0`、A1S=true |
| 打包 | `pack_gcdb.mjs --require-verified --level 9` | 105 MB，数据版本 `2026.11.19-1` |

历史完整度 `fullRate` 由 **70.16% → 72.2%**（披露指标）；四态标注率仍为 100%。
注意 `EXPECTED_YEARS` 未改：`score_range` / `school_adm` 的期望年份是 2017–2025，
其 2017–2022 属 `expected=true`、可判 `full`，2022 进入推荐参考年是合规的；
只有 `major_adm` / `plan_code` 的分母仍是 2023–2025，其 2017–2022 属 `expected=false`、
如实记为 `partial`。因此不能宣称「完整率升至 85%+」。
详细的逐省并入行数、海南越界隔离证据与门禁报告见 `data/gc/fullrebuild/`。

> 已修复：全量数据一度暴露出 `server/recommend.mjs` / `server/plan.mjs` 的选年缺陷——
> 原逻辑只按「本科批有效行数最多」选年，北京选中 2022（组名 `1.0/2.0`），与候选 `（03）` 不匹配，
> 专业粒度丢失。现增加「组名兼容优先、兼容度相同再比有效行数、全不兼容回退原逻辑」约束，
> 并补 2 条北京回归断言：`render-test` **42/42**、`api-test` **80/80**（均为当时的全国库口径），
> 北京 `majorDataYear` 回到 2025（推荐 8/18、方案 53/80 条带专业）。判定数学与前端未改。

### 3.3 数据源替换（河北单省库 ⇄ 全国存档包）

#### 当前随包数据源：河北单省库

`高考志愿助手/data/gaokao.db.gz`（7,631,933 B，约 7.3 MB）与其解压出的 `gaokao.db`
（42,647,552 B，约 40.7 MB）是**河北单省库**，两者内容逐字节一致：`.gz` 用 `node:zlib` 的
Brotli 解压后 SHA-256 与 `.db` 相同，均为
`0e97de2c098d78fda38f4d0a29e5b2ef3be4646dfaefbcbd3c3fa9b943c8f5b3`。

库内 `school`（5,354 所院校）与 `dict`（71,810 条字典）保留整库，河北考生仍可查全国院校；
5 张录取数据表只含河北考生（库内字典 `p=18`，标准省码 `13`）记录：

| 数据表 | 行数 | 含义 | 年份范围 |
| --- | ---: | --- | --- |
| `score_range` | 7,036 | 一分一段 | 2020–2026 |
| `school_adm` | 35,956 | 院校投档线 | 2017–2026 |
| `major_adm` | 287,958 | 专业录取分 | 2017–2026 |
| `plan_code` | 295,240 | 招生计划 | 2017–2025 |
| `school_code` | 12,221 | 院校 / 专业代码 | 2017–2025 |

`meta.dataScope=河北`、`meta.scopeStdCode=13`，库内
`data_manifest.db_sha256=675bc15d4350999cdeb171872f5d46cf8ec7316685e5575c4211964f7b6201aa`
（内容指纹，按四张核心表的行数与年份和计算，**不是**文件字节哈希）。

#### 全国存档包位置

全国统一库只保留一份，位于仓库根目录 **`数据/`**（绝对路径
`D:/AAAProject/AAAgithub/zhiyuan/数据/`）；旧临时目录 `data/gc/all-provinces-package/` 已删除。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `数据/gaokao.db` | 542,081,024 | `f2c8245548bf32975d73d3e1d07962ed81dae529e6df98be7a735d6240714b47` |
| `数据/gaokao.db.gz` | 110,467,751 | `622cf7eb4e1e2879404aeb93d8bbad168a6495af71f13bbfd59fd8d4443b798f` |

同目录还有 `manifest.json`（数据版本 `2026.11.19-1`、全国库内容指纹
`890775fc9a34b218d7e9731f70b4e2675166e9458b751109fc1bb66cd55624ea`、全国逐表行数）与
`README.md`。以上是**全国存档包的历史规格**，不是当前随包数据源。

#### 切换到全国库（31 省）

1. 停止网站（关闭启动窗口，或运行 `高考志愿助手/停止.bat`）。
2. 把 `数据/gaokao.db`、`数据/gaokao.db.gz` 复制到 `高考志愿助手/data/`，覆盖同名文件。
3. 删除 `高考志愿助手/data/cache/` 清掉旧缓存。
4. 重新启动网站；首次启动会从 `.gz` 解压出约 517 MB 的 `.db`，耗时略长。
5. 校验：`sha256sum 高考志愿助手/data/gaokao.db` 应为
   `f2c8245548bf32975d73d3e1d07962ed81dae529e6df98be7a735d6240714b47`。

#### 切回河北库

1. 停止网站。
2. 把 `data/gc/hebei-site/gaokao.db`、`data/gc/hebei-site/gaokao.db.gz` 复制到
   `高考志愿助手/data/`，覆盖同名文件。该目录保存的就是当前河北包，两个文件与站点文件哈希一致。
3. 删除 `高考志愿助手/data/cache/` 后重启。

若 staging 丢失，可从全国存档包重建（不加 `--require-verified`：省份裁剪后全国门禁报告不适用）：

```bash
# 1) 从全国存档包裁剪出河北单省库（只写 staging，不碰交付库）
node tools/build_province_db.mjs --src 数据/gaokao.db \
  --out data/gc/hebei-site/gaokao.db --province 河北 --std-code 13 \
  --report data/gc/hebei-site/build_report.json

# 2) 复制一份作为打包用 staging 库（pack_gcdb.mjs 会原地精简 + VACUUM）
cp data/gc/hebei-site/gaokao.db data/gc/hebei-site/gaokao.pack.db

# 3) 压缩到交付目录
node tools/pack_gcdb.mjs --src data/gc/hebei-site/gaokao.pack.db \
  --out 高考志愿助手/data/gaokao.db.gz --level 11

# 4) 把打包后的 staging 库同步为交付库，保证 .db 与 .gz 解压结果逐字节一致
cp data/gc/hebei-site/gaokao.pack.db 高考志愿助手/data/gaokao.db
cp 高考志愿助手/data/gaokao.db.gz data/gc/hebei-site/gaokao.db.gz
```

> Windows 下若 `VACUUM` 报 `SQLITE_CANTOPEN`，把 `TEMP` / `TMP` / `TMPDIR` 设为
> `D:/AAAProject/AAAgithub/zhiyuan/data/gc/hebei-site/tmp` 再重跑。

#### 已知口径（河北库）

- `plan_code` 的 **2026 年数据全缺**（止于 2025）；一分一段与投档线有 2026 数据，不要按
  「招生计划覆盖到 2026」宣传。
- 河北 2024 官方补充表只有**投档最低分**，不是录取分，不得当作专业录取分展示。
- 全国 2026 数据本身多为抽样（含河北投档线与专业分），默认排除并如实标注，见「3.1 数据质量与时效」。
- 回归测试：`api-test` 80/80、`render-test` 42/42 全绿。两条北京用例只断言「年份可追溯」
  （`majorDataYear > 2000`）与专业粒度仍生效，不绑定具体年份：河北库下北京走上游回退得到 2026、
  全国库为 2025，两者都是合理年份。

---

## 四、目录结构

```
高考志愿助手\
├─ 启动.bat            ← 双击这个
├─ 停止.bat            ← 卡住时用这个强制结束
├─ runtime\node.exe    便携运行时（免安装，已在仓库内）
├─ server\             本地服务（静态托管 + 数据 API + 推荐引擎）
├─ web\                前端页面
└─ data\
   ├─ gaokao.db.gz     河北单省数据源（Brotli 压缩 SQLite，约 7.3 MB，首次启动解压为 40.7 MB 的 gaokao.db）
   ├─ schools.json.gz  院校元信息（985/211/双一流/类型）
   ├─ colleges.json.gz 大学环境数据（4585 所，压缩存放）
   ├─ rank_table.json.gz  中国教育在线一分一段表（备用数据源，含 2026 图文表）
   ├─ index\           旧版分数线索引（仅在缺少 gaokao.db 时作为回退）
   ├─ skill_zhangxuefeng.md  AI 技能提示词
   └─ cache\           查询缓存（可随时删除）
```

**运行要求**：Windows 10 / 11（64 位），内存 2 GB 以上（切换全国库建议 4 GB）。当前随包的
河北压缩数据库约 **7.3 MB**，首次启动解压出约 **40.7 MB** 的 `gaokao.db`，整个
`高考志愿助手\` 目录约 **152 MB**（含 89 MB 运行时）。
全国存档包另放仓库根目录 `数据\`（压缩约 105 MB / 解压约 517 MB），不计入上述体积。

---

## 五、开发者指南（重建数据）

仓库不包含体积较大的抓取中间产物，可用 `tools/` 下的脚本重新生成。

### 5.1 重建统一数据源（推荐路径）

```bash
# 1. 取 GaokaoCompass 的文件清单（走 hf-mirror 镜像）
node tools/build_gc_db.mjs --limit 1     # 首次会先生成 data/gc/filelist.json

# 2. 全量下载并入库（861 个 CSV / 1.35 GB，边下边解析，不落原始 CSV）
#    支持断点续跑：中断后重跑会跳过已完成文件
node tools/build_gc_db.mjs --concurrency 8
#    -> data/gc/gaokao.db（全字段，约 670 MB）

# 3. 瘦身：专业名规范化 + 精简列 + 只留必要索引
#    核心表（一分一段/投档线/院校代码）保留全部年份；
#    --min-year 控制大表（专业录取分/招生计划）的起始年份；0 = 不裁剪（当前交付口径）
node tools/slim_gcdb.mjs --min-year 0
#    -> data/gc/gaokao.slim.db（约 448 MB）
#    只保留近三年（旧版交付口径）：node tools/slim_gcdb.mjs --min-year 2023

# 3.5 质量校验 + 异常隔离 + 烘焙 9 张质量小表（发版门禁，零第三方依赖）
#     去掉 --apply 即为 audit-only，可在只读的随包库上安全出报告
node tools/verify_gcdb.mjs --db data/gc/gaokao.slim.db --apply \
    --fail-on A1,A1S,A2,A4,C1,C1F,C2,C3,C4,T2,RT --gaokao-year 2026 --baseline-year 2025
#    本轮交付显式启用 A1S（默认仍为 opt-in）；A1S 为 true 要求真不自洽组数为 0
#    -> data/gc/quality_report.json；库内 data_manifest / coverage_cell / quality_issue 等

# 4. 压缩并安装到交付目录（--require-verified：无有效校验报告则拒绝打包）
node tools/pack_gcdb.mjs --src data/gc/gaokao.slim.db --require-verified \
                         --out 高考志愿助手/data/gaokao.db.gz --level 9
#    -> 全量重建后约 105 MB（Brotli）—— 这是全国存档包的历史规格，不是当前随包的河北库
#       当前网站实际数据源与双向替换步骤见「3.3 数据源替换」
```

### 5.2 2026 增量（gaokao-vault）

2026 年数据用 [lifefloating/gaokao-vault](https://github.com/lifefloating/gaokao-vault) 抓取：

```bash
git clone https://github.com/lifefloating/gaokao-vault.git && cd gaokao-vault
uv sync --no-dev
uv pip install tzdata                     # Windows 缺 IANA 时区库
cp .env.example .env
docker compose up -d db
uv run gaokao-vault init-db

# 只抓 2026 的一分一段表（走 eol.cn / dxsbb.com，纯 HTTP 不需要浏览器）
GAOKAO_CRAWL__YEAR_START=2026 uv run gaokao-vault crawl -t score_segments
```

抓到的数据在 PostgreSQL 里，用 `docker compose exec db psql` 导出后按
`tools/build_gc_db.mjs` 的表结构并入统一数据源即可。

### 5.3 其他数据

```bash
# 院校基础库（2991 所）  -> data/raw/schools.json
node tools/crawl.mjs schools

# 2. 按省抓取录取数据       -> data/raw/province_<省ID>_<年份>.json
#    --rate 控制速率，--years 指定年份，可中断后续爬（自动跳过已完成）
node tools/crawl.mjs bulk --kind province --years 2026,2025,2024 --rate 2

# 3. 下载 colleges.chat 开源问卷数据   -> data/colleges_raw/
node tools/fetch_colleges.mjs

# 4. 把问卷聚合成高校环境数据          -> data/bundle/colleges.json
node tools/build_colleges.mjs

# 5. 装配院校元信息与旧版索引          -> 高考志愿助手/data/
node tools/build_bundle.mjs

# 6. 2026 一分一段补充（备用数据源，含官方图片版清单） -> data/resources/rank_table.json
node tools/crawl_resources.mjs rank --years 2026,2025
node tools/crawl_resources.mjs verify      # 校验单调性 / 累计自洽 / 缺口

# 查看抓取进度
node tools/crawl.mjs status
```

> 统一数据源（`gaokao.db`）已取代 `data/index/special_*.json` 与
> `build_special_index.mjs`；后者保留仅为兼容旧流程，新版不再需要。

### 自动化测试

```bash
node tools/api-test.mjs      # 后端验收：80 项（7 大功能 + 边界场景）
node tools/render-test.mjs   # 前端渲染回归：42 项（在假 DOM 中真实执行 app.js + plan-ui.js）
```

两个脚本都会自己拉起本地服务、跑完自动关闭，无需手工准备环境。

> `render-test.mjs` 的价值：`node --check` 只能查语法，查不出
> 「模板里引用了未声明的变量」这类只有运行期才暴露的错误。
> 它会在假 DOM 中真实调用 `renderScoreResult` / `showCampus` / `renderPlan` /
> `queryRankScore` / `queryCodes` / `renderAiAdvice` 等全部渲染函数，
> 并断言产出里不含 `undefined` / `NaN`。

**架构要点**

| 文件 | 职责 |
|------|------|
| `高考志愿助手/server/server.mjs` | HTTP 服务入口、全部 API 路由、静态托管、端口自增、自动开浏览器 |
| `高考志愿助手/server/data.mjs` | 基础数据层：院校库、大学环境、磁盘缓存、院校 ID 合并 |
| `高考志愿助手/server/gcdb.mjs` | **统一数据源**：用内置 `node:sqlite` 读 `gaokao.db`（字典编码、省份 ID 换算、一分一段/投档线/专业分/代码查询） |
| `高考志愿助手/server/gcsource.mjs` | 适配层：把 SQLite 适配成推荐引擎所需的索引结构，并在缺库时回退旧 JSON |
| `高考志愿助手/server/upstream.mjs` | 上游代理：令牌桶限速、熔断退避、用户请求优先、失败不缓存 |
| `高考志愿助手/server/indexer.mjs` | 索引构建：优先级队列、断点续爬、突发-休息节流、快速抽样 |
| `高考志愿助手/server/resources.mjs` | 资料库：一分一段查询（新库优先、eol 回退）、选科过滤、院校/专业代码 |
| `高考志愿助手/server/plan.mjs` | 志愿方案生成：冲稳保配额、院校/专业优先策略、专业粒度聚合 |
| `高考志愿助手/server/recommend.mjs` | 冲稳保推荐引擎（线差法 + 位次法 + 正态概率模型） |
| `高考志愿助手/server/ai.mjs` | AI 代理：注入张雪峰技能提示词、转发 OpenAI 兼容接口（含流式） |
| `高考志愿助手/web/app.js` | 前端基础：分数线/推荐/大学环境/志愿表/数据管理 |
| `高考志愿助手/web/plan-ui.js` | 前端扩展：志愿方案、资料库、AI 助手 |

详见 [DESIGN.md](DESIGN.md)。

---

## 六、免责声明

1. 本工具为个人学习与技术研究项目，**不构成任何志愿填报建议或录取承诺**。
2. 数据来源于公开网络渠道，可能存在滞后、缺失或误差。
3. 「冲稳保」分档与录取概率均为**基于历史数据的统计推算**，不保证实际录取结果。
4. 大学环境内容为在校生主观问卷，未经校方核实，仅供参考。
5. 使用时请遵守相关网站的服务条款，控制请求频率。

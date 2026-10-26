# 报告数据溯源设计方案

> **状态：P0 已实现（2026-10-11）。** 落地与本文的出入：
> ① 溯源附录页在 `synthesis.ts` 机械生成（而不是渲染层注入）——它因此进入 DSL，
>   HTML / Markdown / 前端预览三条输出天然一致，且经过同一套校验；
> ② 新校验规则编号为 **R13**（R6 已被"无来源数字"占用）；
> ③ mock 路径消费平台 rows 提前实现（原列在 P1），否则离线演示永远没有条目级溯源。
> 测试：`tests/data-provenance.test.ts`（6 例，含突变检查）；golden `slides` 15→16（新增附录页）。

> 目标：让报告里的每个结论都能回答「这条数据来自哪个平台、哪条内容、什么时候采的」，
> 并且这个回答是**机械保证**的，不是靠提示词求 LLM 别撒谎。

## 1. 现状诊断：来源信息处处存在，但一路丢失

七平台采集链路（`platform_digest` → `mc_*` 适配器 → collector → JSONL）上游的溯源信息其实**很全**，
问题全部出在「往报告走」的半程：

| 环节 | 现状 | 粒度 | 断点 |
| --- | --- | --- | --- |
| collector 归一化 `CollectRow` | platform/id/url/author/publishedAt/metrics/raw 全有 | 逐条 | — |
| collector JSONL 缓存 | 逐条落盘，可回查 | 逐条 | 只在 `.data-collector/`，与 job 无关联 |
| `platform_digest` 返回 | rows（10 个元数据字段）+ provenance + comparison | 逐条 | **只进模型上下文**，不落库 |
| `IntelOutput.citations` | `{claim, sourceKey, confidence}` | 来源级 | **条目全被总结掉**：无 url/author/时间 |
| 工具调用记录 | `ToolCallRecord`（tool/agent/ms/ok） | 调用级 | **内存态**，不落库 |
| 治理台账 `ledger` | (jobId, phase) 级 inputs：sourceId/tier/rowCount | 阶段级 | 无 tool 名、无条目 |
| 报告 DSL `ReportCitation.ref` | `{sourceKey?, chunkId?, runId?, fieldPath?}` | 来源级 | **没有条目级字段** |
| 渲染层 | 引用块只吐 sourceKey + 置信度 | 来源级 | 无平台徽标/原文链接/发布时间 |

一句话：**溯源断在「LLM 总结」这一步**——模型读了 500 条帖子，写进产物的只有
「小红书声量占比约 40%（mc_xhs，置信 0.6）」，至于是哪条帖子支撑的，链路上没有任何地方保留。

另一个被证伪的前提也要记住：七平台内容层**无任何共有指标**（metrics 交集为空），
所以溯源展示不能假设「能横向比数字」，只能比「证据本身」。

## 2. 设计原则

1. **溯源是机械注入的，不是 LLM 自觉的。** URL、作者、发布时间一律由渲染层从登记表反查拼接；
   LLM 只允许输出「条目引用 ID + 摘录」，编造 URL 在校验层直接被降级修复。
   这与「asOf 机械注入」「免责声明机械注入」是同一哲学，只是此前没做。
2. **来源级引用保留，条目级是增强而非替换。** `sourceDeclaration`、`mc_*` 来源声明、
   KB `chunkId` 引用全部不动；新增的条目级引用是第三种 `kind`。
3. **引用必须可校验、可降级。** 模型给的 entryId 不在登记集里 → `autoRepair` 降级为
   来源级引用 + warn callout（沿用现有「降级而不是拒绝渲染」的语义）。
4. **证据与 job 绑定落库。** 平台条目从「模型上下文里的过客」变成「job 的产物」，
   mock/降级路径同样有证据可看。

## 3. 方案总览

```
collector(七平台) ──▶ platform_digest 返回 rows
                          │
                          ▼ ①登记（机械）
              evidence 产物 intel_evidence（job 级，JSON 落 artifacts 表）
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
  IntelOutput 新增    ReportCitation.ref   buildSourceCatalog
  evidences[]        新增 entryId          新增 entries（校验目录）
  (entryId+摘录)     + kind platform_entry
        │                 │
        ▼                 ▼
  合成/校验 job 级    autoRepair：entryId 未登记 → 降级 + warn
                          │
                          ▼ ②机械反查（渲染）
              HTML：引用块带平台徽标 + 原文链接 + 发布时间 + L3 标注
                    「数据来源与溯源」附录页（来源声明/采集概览/被引条目清单）
```

分三个优先级：

- **P0（最小闭环，建议先做）**：条目登记 → intel 引用条目 → DSL/校验/降级 → 渲染展示与附录。
- **P1（链路完整性）**：台账记到工具调用级、事件总线补 `tool.result` 摘要、mock 路径消费 rows。
- **P2（体验）**：前端报告预览的引用交互（点击跳原文、按平台筛选）。

## 4. P0 详细设计

### 4.1 条目登记：新增 `intel_evidence` 产物

- `ArtifactKind` 增加 `"intel_evidence"`（`packages/contracts/src/job.ts`）。
- 登记点在 `platformDigest` 返回前（以及单平台工具，同形逻辑）：
  把返回给 LLM 的 rows 映射为证据条目（**剥离 `raw` 与正文长文**），追加进 job 级证据集：

```ts
interface EvidenceEntry {
  entryId: string;        // `pf_<platform>_<原始id>`，如 pf_xhs_65f2abc
  platform: MediaCrawlerPlatform;
  platformName: string;
  op: CollectOp;          // search | content_detail | comments
  kind: "content" | "comment";
  title: string;
  excerpt: string;        // 正文前 120 字
  author: string;         // 昵称（authorId 本来就是脱敏哈希）
  url: string;
  publishedAt: string;    // 取不到为空串，渲染时显示「未知」
  metrics: Record<string, number>;
  collectedAt: string;    // 采集时点，即 asOf 的条目级形态
}
```

- 存储走 artifacts 表（kind=intel_evidence，JSON 追加合并），**零 schema 迁移**；
  单 job 上限 500 条（超出截断并计数），防止 search 大结果把产物撑爆。
- 登记通过 `ToolRegistry` 的 deps 注入（`ToolCallContext` 已带 jobId/phase，无需改调用方）。

### 4.2 Intel 产物引用条目

`IntelOutput` 新增可选字段：

```ts
evidences?: { entryId: string; quote: string /* ≤80 字摘录 */; useFor?: string }[];
```

- `schemas.ts` 静态校验：quote 必填非空、长度上限；有 `shareOfVoice` 等平台数字的 competitor
  至少带 1 条 evidences（对齐现有「有数字必须有 citations」的校验风格）。
- **job 级存在性校验**在 `agents.ts` 阶段后处理做（schema 层拿不到 job 上下文）：
  entryId 不在本 job 证据集 → 剔除该条 + 发 `data.degraded` 事件。

### 4.3 报告 DSL 与校验

`packages/contracts/src/report.ts`：

- `ReportCitation.kind` 增加 `"platform_entry"`；`ref` 增加可选 `entryId?: string`（旧 DSL 完全兼容）。
- `SourceCatalog` 增加 `entries?: EvidenceEntry[]`（由 synthesis 从 evidence 产物读出注入）。
- 新校验规则 **R6**：`kind=platform_entry` 的 `ref.entryId` 不在 catalog.entries → warn / 可修复。
- `autoRepair` 降级策略：entryId 未知 → 改写为 `kind=data_source` + 该平台 sourceKey（保留可溯源），
  并追加 warn callout（「有 N 条条目级引用未通过校验，已降级为来源级」）。
- `isTraceableCitation` 把 `platform_entry` 计入可溯源（RG 的 60% 占比约束自动受益）。

### 4.4 合成与渲染

- `synthReport`：把 intel 的 `evidences` 机械转成 `platform_entry` citation（与现有
  citations→Cite 的转换同路），**entryId 只透传、不生成**。
- `render/index.ts` 引用块升级：
  - `platform_entry`：平台名徽标 + 标题/摘录 + 原文外链（`rel="noopener"`）+ 发布时间 + `L3 公开采集` 标注；
  - URL 取不到（空串）→ 只显示平台 + 摘录，不显示假链接。
- 新增机械附录页（`pageRole: "appendix"`，「数据来源与溯源」）：
  1. 来源级声明（现有 `sourceDeclaration` 原样）；
  2. 采集概览：per platform × op 的条目数、采集时点区间（从证据集聚合，不经过 LLM）；
  3. 被引条目清单：报告中实际引用的 entryId 反查表（平台/标题/URL/发布时间/指标）；
  4. 固定口径说明：各平台可比指标为空、数据属 L3 未核验公开内容。

### 4.5 提示词

`prompts.ts` RG/CI 段补一条：结论引用平台数据时，优先给 `evidences`（entryId 必须来自工具返回
的 rows，**禁止自己拼 URL**）；文案继续维持「公开采集 / 不可跨平台对比」口径。

## 5. P1：链路完整性（P0 之后再做）

1. **台账升级到调用级**：`LedgerEntry.inputs` 增加 `tool` 字段（或 tools.ts 每次 invoke 成功后
   `ledgerRun.addInput({sourceId, tool, rowCount})`），使 job → tool call → source 可精确回查。
2. **事件总线补 `tool.result` 摘要事件**：`{tool, platforms, rowCount, ms}`（不带大 payload），
   控制台「数据来源」面板可以从事件实时显示本次任务采了什么。
3. **mock/降级路径消费 rows**：`synthIntel` 目前完全不读 `platform_digest` 的 rows
   （synthesis.ts 只读 kb/web_search）——改为用确定性规则从 rows 里挑 top-N 造 evidences，
   保证离线演示也走同一条溯源链路。
4. `data.degraded` 的 `source` 字段区分 sourceId 与工具名。

## 6. P2：体验（可选）

- 前端报告预览：引用块点击跳原文；附录页按平台筛选；
- KB chunk 引用与平台条目引用统一为一套 citation 视觉语言。

## 7. 改动文件清单（P0）

| 文件 | 改动 |
| --- | --- |
| `packages/contracts/src/job.ts` | `ArtifactKind` + `"intel_evidence"` |
| `packages/contracts/src/report.ts` | `kind` + `platform_entry`、`ref.entryId`、`SourceCatalog.entries`、R6、autoRepair |
| `packages/agent-pack/src/tool-impls.ts` | platform_digest/单平台工具登记证据（deps 注入） |
| `packages/agent-pack/src/schemas.ts` | `IntelOutput.evidences` + 静态校验 |
| `packages/agent-pack/src/agents.ts` | job 级 entryId 存在性校验 + 证据产物注入 catalog |
| `packages/agent-pack/src/synthesis.ts` | synthReport 机械转换 platform_entry 引用 |
| `packages/agent-pack/src/prompts.ts` | evidences 使用约束（注意模板串内禁反引号） |
| `packages/render/src/index.ts` | 引用块展示 + 溯源附录页 |
| `tests/` | 登记/校验/降级/渲染 4 组用例 + 突变检查（去掉 R6 必须变红） |

## 8. 风险与不做的事

- **不做**：全量 rows 进报告（数量失控且无意义，只引用被使用的条目）；
  LLM 直接输出 URL/作者（幻觉源）；粉丝画像溯源（七平台根本没有）。
- **风险**：证据产物会让单 job 体积上升（500 条 × ~300 字节 ≈ 150KB 上限，可接受）；
  authorId 已是脱敏哈希，昵称属公开内容，无新增合规面。
- **验收标准**：关掉提示词里所有溯源话术后跑 mock job，报告仍出现
  「平台 + URL + 采集时点」的条目级引用——即溯源不依赖模型听话。

## 9. 数据真实性：样例数据与真实人选（2026-10-11 增补）

> 触发：业主看到报告里的人选昵称（`皮肤科医生老王` 等）"在平台上搜不到"，
> 明确要求 **"本地存储那些假的数据不要参考，我需要真实的数据"**。
> 根因不是"写错了人名"，而是**演示样例与真实数据在库里长得一模一样**：
> 谁都分不出来，报告读起来自然像编的。

### 9.1 演示样例的标记与隔离

- 新增 `DataProvenance = "demo" | "live"`（`contracts/kb.ts`），
  `talents` / `pricing` / `kb_chunks` 各加一列 `provenance`（迁移 id=3）；
- `scripts/seed.ts` 写入的一切（5 位样例达人、10 条样例报价、13 条演示语料）全部标 `demo`；
  存量库按 id 白名单回填，**不猜、不连坐**（真实录入的行保持 `unknown`，按 live 处理）；
- **闸门在读取侧**：`PricingStore(db, { allowDemo })` 与 KB 检索（`visibleScopeSql`）默认过滤
  `provenance='demo'`。理由：写入口只有 seed 一处，但"报告引用了样例"的后果在读取侧 ——
  万一有人手工灌了样例，读取侧过滤才是真正保证它进不了报告的那道闸；
- 开关是 `BM_ALLOW_DEMO_DATA`（默认 **false**）；离线测试脚本显式设 true
  （否则 mock 全链路没有数据可跑）。
- 连带效应（有意为之）：KB-2 的"ROI 锚点"等演示语料不再可见 → 预算阶段退回保守缺省值
  并在报告里标注为估算；来源目录不再声明 `internal_review`/`methodology`/`public_intel`
  —— 声明了却没有数据支撑的来源，比不声明更误导读者。

### 9.2 人选的真实来源：本任务真实采集账号

本地没有真实达人库时，人选池改成**从本任务真实采集到的平台内容聚合**：

- `aggregatePlatformAccounts(entries)`：按 `平台 × 作者` 聚合（无作者的条目直接丢弃 ——
  宁可少一个账号，也不要造一个），带真实互动量、条目数、代表原帖链接；
- `platformCreatorCandidates(...)`：把聚合结果变成候选人。三条硬约束：
  ① 粉丝量**未采集就写 0**（不用互动量倒推、不填行业均值）；
  ② 报价无 L2 样本就不估计（`estimatedCost: 0` + "无样本"）；
  ③ 分层按**同平台互动量分位**而不是粉丝量，且口径写进 `contentFit` 自证。
- 装配层在 `creator` 预取阶段把候选池塞进提示词（`PLATFORM_CREATOR_KEY`），
  并明确告诉模型"人选的唯一合法来源就是这些"。

### 9.3 编造人选的机械拦截

`pruneUnverifiableCreators(value, { talentIds, accounts })`：模型产出的人选必须能对上
真实数据源（真实报价库候选，或真实采集账号），否则**剔除**并记进 `excluded`，
剔空某一层后用 `fillCreatorTiers` 补「暂无人选」占位。
这条与 R13（条目级引用校验）是同一哲学：**不靠提示词求模型别撒谎，靠机械校验**。
真实数据源为空时不做剔除（闸门缺输入时"全拦"会让离线全链路空掉），
由来源声明与 `excluded` 兜底。

### 9.4 报告侧的呈现

- 人选表加「来源」「可核验凭据」两列：平台采集的人选给出**可点开的原帖链接**，
  报价库人选标「库内无账号 ID（未核验）」；成本列写「无样本」而不是 0 元；
- 附录「人选名单来源与核验状态」按来源分述（平台采集 / 本地报价库 / 无数据占位）；
- 散点图两条路径各用自己能拿到的真实量纲：报价库 = 粉丝量 × 匹配度；
  采集 = 匹配度 × 采集条目数（粉丝量不存在时不画"压在轴上的假分布"）。

测试：`tests/data-realism.test.ts`（8 例）。

## 10. 账号昵称完整显示：关闭采集内核的昵称脱敏（2026-10-11 增补）

### 10.1 问题

上游 MediaCrawler「教学版」出于防骚扰定位，把平台昵称做**中间脱敏**后落盘
（`tools/user_hash.py:mask_nickname` → `长***菜`）。brandsale 报告如实标注了"昵称经内核脱敏"，
但业主看报告的核心诉求是"拿名字去平台能搜到" —— 一个 `长***菜` 既搜不到、也看不出是谁，
反而强化了"数据是编的"这一误读。业主明确要求：**人选/账号不要隐藏 `****`，完整显示**。

### 10.2 改动

- **采集内核**（`services/collector-core/tools/user_hash.py`）：`mask_nickname` 默认**完整返回账号昵称**。
  如需恢复脱敏，启动采集时设 `BM_MC_MASK_NICKNAME=true`（子进程继承 `process.env`）。
- **`anonymize_user_id`（`creator_hash`）保持不变**：它只是（内容/评论）按创作者的**分组键**，
  不参与账号展示，也从不落原始 uid —— 与昵称脱敏是两件事，不能一起放开。
- **报告与提示词口径**同步：附录表头 `账号昵称（内核脱敏）` → `账号昵称`；
  相关 callout 从"无法还原完整账号名"改为"账号昵称完整显示，可直接检索"；
  人选 `riskFlags` 从"昵称脱敏、不能商务联系"改为"粉丝量与报价未采集，投放前须按原帖人工核验"。

### 10.3 存量数据

脱敏发生在**落盘前**，原始昵称**没有被保存**，因此历史缓存里已是马赛克的记录**无法还原**，
只能重新采集（同 key 的新记录会覆盖旧的）。上线后需重跑一次采集，报告里的账号才会变成完整昵称。

### 10.4 合规口径

昵称属平台**公开展示**字段，完整保留不新增个人信息采集面；原始 uid、头像、主页链接、性别、
签名、IP 归属地等**依旧一律不采集**（本项改造只放开昵称，其余约束不动）。

测试：`tests/collector.test.ts`（归一化透传完整昵称）、`tests/data-provenance.test.ts`
（附录账号清单不含 `***`）。

## 11. 「条目级引用被摘除」的根因与修法（2026-10-11 增补）

业主看到的现象：报告面板提示 `[产出不完整] 竞品情报分析 降级（intel.evidences：5 条条目级引用
未通过校验（entryId 不在本任务证据表内），已摘除）`。

结论：**降级提示本身是拦截器在正确工作**（模型确实在凭印象编 entryId），但**上游为什么让模型
在没有任何平台条目的情况下出稿**，才是要修的东西。逐条查下来是四个缺陷叠加。

### 11.1 根因

| # | 缺陷 | 证据 |
|---|---|---|
| ① | **侧车查询把关键词当正文子串过滤**。采集是按 `护肤品-精华` 搜的，落库时搜索词写在行的 `raw.source_keyword` 上；查询却拿它去 `title/text/author/url` 里 includes —— 而这个串在笔记正文里一个字都不出现，于是"用 A 搜回 220 条、再用 A 去查是 0 条"。 | 实测同一份缓存：`keyword=护肤品-精华` → 0 条；`keyword=面膜` → 4 条。历史任务类目词都是「精华」（正文里到处都是），子串过滤"恰好"命中，所以一直没暴露 |
| ② | **预取只投递不等待 + 降级路径不重取**。平台采集是分钟级的：intel 预取（12:28）只拿到"已排队"，数据 12:30:18 才落库；而 intel 阶段走的是 Pi 循环失败后的**单次结构化输出**，那条路径不调任何工具 —— 数据到了，阶段拿不到。 | 台账 `ledger.inputs`：intel 阶段 7 个平台 rowCount 全为 0；xhs 采集任务 20:28:01 起、20:30:18 完成 220 条 |
| ③ | **模型照抄提示词示例**。被摘除的 5 条里，`pf_xhs_65f2abc` 正是 `prompts.ts` / `schemas.ts` 里写的示例 id，另外 4 条是同款 7 位假 hex。 | 提示词原文（改前）：`（系统生成，形如 pf_xhs_65f2abc）` |
| ④ | **机械补齐从来没生效**。`attachPlatformEvidences` 直接读 `prefetched[platform_digest].rows`，而 `ToolRegistry.invoke` 返回的是 `{ result, provenance, note }` —— 顶层没有 rows。这个"兜底"静默失效，所以即使证据表有数据也补不进 evidences。 | `mergePlatformEvidences` 的单元用例一直是绿的（它测的是纯函数），接线断了没人发现 |

连带影响：证据表为空 → creator 阶段拿不到真实账号池，产出 `待确认头部达人` 这类占位人选；
报告不会出现「平台真实账号」附录，也不会有任何 `platform_entry` 引用。

### 11.2 修法

1. **采集查询按采集用语匹配**（`apps/collector/src/store.ts`）：`op=search` 时先按行的
   `raw.source_keyword` 匹配整批采集结果；匹配不到再退回子串（兼容没有该字段的老数据）。
2. **侧车改为有界排队**（`apps/collector/src/tasks.ts`）：内核单会话仍串行，但忙时**入队**
   （FIFO、同参数去重、上限 12）而不是返 409。原先一次扇出七个平台只受理第一个，
   其余六个被静默丢弃 —— 实测 brief 里明写 `douyin` 的任务**抖音从头到尾没采过**。
   敢排队的前提是调用方"只投递不等待"（`/collect` 立刻返 202）。
3. **降级路径补取一次平台数据**（`packages/agent-pack/src/agents.ts` 的 `refreshPlatformData`）：
   Pi 循环结束（无论成功失败）之后、出终稿之前，用同一批参数重放一次 `platform_digest`，
   把期间落库的数据捞回来；creator 阶段还会据此**重建真实账号人选池**（`buildCreatorPool`）。
   creator 阶段开头也会先补一次再建池，判定条件是 `needsPlatformRefresh()`：
   **池子为空，或存在"有真实条目却没粉丝量"的账号**（后者治"半池"，见 §13.2 末尾）。
4. **提示词与结构说明**：`entryId` 示例改成占位符（`pf_xhs_ 前缀 + 原始内容 id`），
   并明确"rows 为空就留空 evidences，系统会机械补齐；编造的一律摘除并标为产出不完整"。
5. **台账缓存命中改结构化字段**（`Provenance.cacheHit`）：原来靠 `note.includes("缓存")` 判断，
   而采集侧说明里有一句"本次无本地缓存" —— 未命中被记成命中（实测 `mc_xhs cached=true, rowCount=0`）。
6. **系统补取豁免单任务调用上限**（`ToolCallContext.systemCall`）：`platform_digest` 的
   `maxCallsPerJob=8` 是防**模型**换关键词放射式采集的，但实测模型能在 2 分钟内把 8 次额度烧光
   （每次都是空结果、却各触发一批后台采集），于是收尾补取被上限挡下 —— 数据照样进不了报告，
   事故形态原样复现。系统侧的补取数量由构造保证有界（每阶段最多一次），因此不计入该上限；
   模型路径**不得**使用这个标记（否则等于取消上限）。

### 11.3 测试

- `tests/collector.test.ts`：`op=search` 按采集用语匹配 / 退回子串；任务队列忙时入队、闲时自动开跑、同参数去重。
- `tests/data-provenance.test.ts`：`unwrap` 契约（机械补齐的接线）；提示词里不得出现可照抄的 entryId 示例。
- `tests/platform-collect.test.ts`：`cacheHit` 命中/未命中的结构化标记（含"无本地缓存"不被误判）。

## 12. 「数据在手、报告里一条真账号都没有」：真实采集账号机械进场（2026-10-11 增补）

业主看着报告的人选页说：「报告里面这些数据都没有……我需要有实际的数据」。当时报告是
`job_0mv3ssqa1ja5gv3w1zl`，人选页三条全是占位（`待确认头部达人/腰部/尾部`，来源写「本地达人报价库（L2）」，
粉丝量未知、报价 0.0 万），来源声明还说「平台上搜不到同名账号属预期」。**问题不在措辞，
在于那三条占位本可以不是占位** —— 本任务真实采到了六个平台几百条内容。

### 12.1 根因：剔除只解决"编造"，解决不了"无视"

§11 修掉了"数据进不了证据表"（查询语义、队列丢弃、降级路径不重取、机械补齐接线）。
这一轮暴露的是**下一环**：数据进了证据表、也进了提示词，但**模型可以选择不用它**。

`job_0mv3ssqa1ja5gv3w1zl` 的 `creator_candidates` 产物原文：

> `【严重数据缺失】当前知识库(kb_retrieve)与报价库(pricing_query)均返回空结果，且无授权数据源。
> 此条目为占位符，用于满足系统对 head/mid/tail 三层结构的强制校验要求。`

模型的三条判据（kb 0 命中 / pricing 0 候选人 / platform_digest 未提供达人）在当时**都是真的** ——
但第三条约等于"我拿到了几十个真实账号却没把它们写进人选"。

而当时的机械闸门 `pruneUnverifiableCreators` 的职责是**剔除编造**：没有真实数据可比对时（`known=false`）
它整批放行；有可比对时它把对不上的剔掉。**剔完不会补**，于是最尴尬的形态出现了：
池子里躺着几十个真实账号，人选列表里一个都没有，只剩 `fillCreatorTiers` 补的占位。

### 12.2 修法：`ensurePlatformCreators`（机械进场）

在 creator 阶段唯一的收口处（`AgentPack.enforceRealCreators`）追加一步：

- 人选中**只要已经出现平台账号**（`pfcre_` 前缀）→ 原样放行，尊重模型的选择；
- 一条都没有而 `PLATFORM_CREATOR_KEY` 池子非空 → 把池中账号按平台轮转补进去（上限 9 位），
  与"该层无真实账号"的占位合并后重新补层（`fillCreatorTiers`）；
- 补入的账号没有粉丝量与报价，一律 `followers: 0 / estimatedCost: 0`，报告显示「未采集 / 无样本」；
- 补入这件事写进 `excluded`：「模型未给出平台账号，由系统按采集结果机械补入」，读者能分辨这几条不是模型选的。

一句话：**"数据在手"必须推出"数据进报告"**，不能听凭模型这一次愿不愿意用。

配套的两处：

1. creator 预取时的补取条件从"证据表为空"改成"**没有平台账号**"（`aggregatePlatformAccounts(...).length === 0`）
   —— 证据表里可能只有非平台条目，按总数判会漏补。
2. 补取日志区分"无新增"与"没数据"：同一批采集结果在**预取**时就会登记一次，收尾补取自然 `added=0`，
   早先一律打「仍为 0 条」，把"数据早就到了"说成"一直没数据"，排查时被这句话带偏过。

### 12.3 平台覆盖面（实测）

| 平台 | 状态 |
|---|---|
| 小红书 xhs / 抖音 dy / B站 bili / 微博 wb / 贴吧 tieba / 知乎 zhihu | 正常，本地缓存有数据 |
| 快手 ks | **失败**：`REST API V2 error: {'result': 405, 'error_msg': '对方不允许该操作'}`。登录流程（`login_by_qrcode`）走完仍被平台侧拒，属平台风控/账号权限问题，需要人工在 `browser_data/cdp_ks_user_data_dir` 下完成一次有效登录；代码侧无法绕过。报告会如实把它列进 `platformsSkipped`，不当作 0 条。 |

### 12.4 测试

- `tests/data-realism.test.ts`：`ensurePlatformCreators` —— 模型只给占位时必须补入真实采集账号、
  同层占位让位、补入项留空粉丝量/报价、补入写进 `excluded`、三层仍齐全；模型已用平台账号时不叠加；
  池子为空时什么都不做。

## 13. 「粉丝量拿不到」：各平台个人主页取数与自动补采（2026-10-11 增补）

业主贴了一条小红书个人主页链接追问：

> 为什么拿不到粉丝数据？这个个人主页账号的个人主页都有啊，你需要分析每个平台如何进个人中心，
> 去查看他个人中心，个人中心一般都有这些账号详情数据的，你小红书这个就有。
> （`#userPageContainer … .data-info`）

**结论：粉丝数不在内容数据里，只在"个人主页"这一张页面上。** 之前整条链路只走
`search`（关键词搜索）→ 落内容行，而**内容行从来不带作者粉丝数**，所以报告那一列
只能写"未采集"。另外还有一层历史原因：内核（MediaCrawler 教学版）把
`save_creator()` 与 `store_creator()` 两跳都写成了空操作（"防骚扰"），
**即使调了 creator 模式也不会落任何资料**。

### 13.1 各平台"怎么进个人中心"（对内核源码逐平台核对）

| 平台 | 主页资料入口（内核已有方法） | 粉丝数字段 | 本轮处理 |
|---|---|---|---|
| 小红书 xhs | `XiaoHongShuClient.get_creator_info(user_id, xsec_token, xsec_source)` → 解析 `/user/profile/<user_id>` HTML 里的 `window.__INITIAL_STATE__.user.userPageData` | `interactions[type=fans].count`（页面 `data-info` 那三个数字；形如 `2373` / `1.2万`） | ✅ **已实测**（`福豆小鲤` = 2373）。⚠️ 无 `xsec_token` 时**部分账号**页面不含 `INITIAL_STATE`（解析返回 None、静默无数据），且平台风控会让登录态失效 |
| 抖音 dy | `DouYinClient.get_user_info(sec_user_id)` → `/aweme/v1/web/user/profile/other/` | `user.follower_count`（另有 `following_count` / `total_favorited` / `aweme_count`） | ✅ **已实测 8/8**：2849333 / 493818 / 422938 / 230979 / 115962 / 108972 / 63306 / 60515 |
| B站 bili | `BiliClient.get_creator_info(mid)`（`/x/space/wbi/acc/info`，**只有昵称/签名**）+ **新增** `get_creator_stat(mid)`（`/x/relation/stat`） | `follower`（`get()` 已解包一层 `data`，别再取 `data`） | ✅ **已实测 8/8**：4675033 / 2270228 / 1642305 / 171561 / 43023 / 32176 / 17584 / 1005 |
| 微博 wb | `WeiboClient.get_creator_info_by_id(uid)` → `/api/container/getIndex?containerid=100505<uid>` 的 `userInfo` | `followers_count` | ✅ **已实测 8/8**：4095000 / 1992000 / 1348000 / 1029000 / 776000 / 513000 / 488000 / 397000 |
| 快手 ks | `KuaiShouClient.get_creator_info(user_id)` → 主页 HTML 的 `visionProfile.userProfile` | 版本差异大，按 `fanCount/fansCount/...` 候选取值 | ⚠️ 代码就绪，但**平台侧 405 拒绝**（见 §12.3），需人工完成一次有效登录 |
| 贴吧 tieba | `TiebaClient.get_creator_info_by_url` → `TiebaCreator` | `fans`（模型自带） | ✅ 已实现（但内容行里只有匿名哈希，**不能自动补采**，只能由 creator 算子驱动） |
| 知乎 zhihu | 有 `save_creator` 落盘口径，但 `media_platform/zhihu/core.py` **根本不调用**它 | `ZhihuCreator.fans` | ⚠️ store 已能写，缺 core 侧接线；内容模型里也只有 `creator_hash`，同样无法自动补采 |

实测（本机、已登录态、小红书）：

```
python run.py --platform xhs --type creator --creator-id 69e0d0fa00000000330040ef --profile-only true
→ {"creator_hash": "ad141d3f3315db29", "user_id": "69e0d0fa00000000330040ef", "nickname": "福豆小鲤",
   "fans": "2373", "follows": "31", "liked": "17571",
   "home_url": "https://www.xiaohongshu.com/user/profile/69e0d0fa00000000330040ef"}
```

两个值得记下的事实：
- **裸 user_id（24 位十六进制）就能拿到主页资料**，不必带 `xsec_token` —— 这点决定了
  "自动补采"可行：搜索结果的 `user.user_id` 就够用。
- 计数是**带中文单位的字符串**（`2373` / `1.2万`），换算交给归一化层（`numOf` 认 万/亿）。

### 13.2 修法：三段接线

1. **内核：资料真正落盘**（`store/*/save_creator` + `store/*/_store_impl.py:store_creator`）。
   七个平台的 `store_creator` 不再是空操作；`save_creator` 只落**主页公开展示的统计**
   （昵称 / 粉丝 / 关注 / 获赞 / 主页链接），不带头像、性别、IP 归属地这类画像字段。
   新增 `config.PROFILE_ONLY`（`--profile-only` / `BM_MC_PROFILE_ONLY`）：creator 模式
   取完资料**立即返回**，不再顺带抓该作者的全部作品 —— 一次资料采集从分钟级降到秒级。
2. **内容行补 `author_user_id`**（平台原始标识：xhs `user_id` / dy `sec_uid` / bili `mid` /
   wb `uid` / ks `id`）。它是"按主页补采"的入参；归一化后的 `authorId` 是脱敏哈希，
   喂回内核必然失败。**只入参、不展示**。
3. **采集侧自动补采**（`apps/collector/src/tasks.ts:enqueueAuthorProfiles`）：一次 `search`
   落库后，按 `raw.author_user_id` 取前 `BM_MC_PROFILE_ENRICH_MAX`（默认 30，2026-10-15 由 12 提高）位作者，
   派生**一个** `op=creator` + `profileOnly` 的任务（`--creator-id a,b,c` 逗号列表，
   内核原生支持多 ID）排到队尾。开关 `BM_MC_PROFILE_ENRICH`（默认开）。
   `POST /collect` 也开放了 `profileOnly: true`，便于手工"只补一个账号的资料"。
   队列满时整批进 `profileBacklog`（上限 64，去重），内核腾出位置时由 `drain()` 自动接上 ——
   绝不静默丢（真机踩过：4 个作者只排上 1 个，另 3 个的粉丝数永远采不到）。

下游两处配套：

- `POST /query` 在 `op=search` 时按 `authorId` 把**这批作者的资料行**接在 `rows` 尾部并打
  `rowType: "creator"`；适配器与工具按这个标记**分流**：内容行做声量与内容分析，
  资料行只进证据表（`op=creator`），**不参与跨平台指标对比**。
- 报告侧 `aggregatePlatformAccounts` 把资料行并入同作者的账号视图，但：
  条目数不加、互动量不计；只在有值时写 `followers`，没有就是 `null` →
  报告显示「未采集」，**绝不用 0 或估值兜底**。有粉丝量时人选分层改按 `tierOf(followers)`
  （与 L2 人选同一把尺子），没有才退回"同平台互动量分位"。

### 13.3 仍然做不到的（如实标注）

- **报价**：平台侧没有公开接口，只能来自 L2 私域成交/人工核验 → 一律「无样本」。
- **粉丝量的时效**：主页统计是**采集时点的快照**，会随账号变化；报告里写明这一点。
- **贴吧 / 知乎**：内容记录里只有匿名哈希（模型层就没留原始 id），无法自动补采；
  要覆盖需改内容模型（不在本轮范围）。
- **快手**：平台侧 405（`对方不允许该操作`），代码就绪但要人工登录后才会生效。

### 13.4 测试

- `tests/collector.test.ts`：`enqueueAuthorProfiles` 派生链（按作者去重、整批合成一个任务、
  必带 `profileOnly`、开关关掉不派生、**队列满时进积压并在内核空闲后自动补上**）；
  七个平台 `store_creator` 不得退回空操作（AST 级契约）。
- `tests/data-realism.test.ts`：资料行与内容行合并的边界（不虚增条目、不混入互动量）、
  有粉丝量时填真值并按粉丝量分层、无资料时如实写"未采集"。

### 13.5 真机实测（2026-10-11 22:00 前后，一次补采 = 一个任务）

```
POST /collect {platform: dy|bili|wb, op: creator,
               params: {creatorId: "<uid1>,<uid2>,…,<uid8>"}, profileOnly: true}
→ dy   8 位作者   75s   stored=8    粉丝量 8/8
→ bili 8 位作者    6s   stored=8    粉丝量 8/8
→ wb   8 位作者   40s   stored=8    粉丝量 8/8
→ xhs                —— 登录态失效（Login state result: False），平台侧要求重新扫码
```

**批量不是优化，是必需**：一人一个任务时，每个任务都要重起内核 + 重开浏览器 +
重校登录态；4 个作者连跑就让小红书侧 `pong()` 掉登录态、卡在扫码等待 120s。
合成一批后 bili 8 位作者 6 秒跑完。

路上踩到并修掉的三个真 bug（都属于"不报错、只是数据为空"那类，最难发现）：

1. **B站 `CREATOR_MODE` 绕过 profile-only**（`media_platform/bilibili/core.py:start`）。
   `creator` 模式在 `CREATOR_MODE=True` 时走 `get_creator_videos`（把该 UP 的**全部作品
   连评论**一起爬），而不是 `get_all_creator_details`（PROFILE_ONLY 感知）。
   症状：一个"只要粉丝数"的任务跑了 3 分钟还在抓评论。修法：`PROFILE_ONLY` 优先走
   `get_all_creator_details`。
2. **B站 `get_creator_stat` 多取了一层 `data`**（`media_platform/bilibili/client.py`）。
   `BilibiliClient.get()` 内部已经 `return data.get("data", {})`，早先又写 `res.get("data")`
   → 永远 `{}`。症状：任务成功、昵称与主页链接都对、**粉丝数字段就是空的**。
3. **补采任务被队列上限静默丢弃**（`apps/collector/src/tasks.ts`）。
   症状：日志 `派生 1/4`。修法：`profileBacklog`（见 13.2 第 3 条）。

同时确认：**报告要看到粉丝量，采集缓存必须先热**。任务的取数是
`search`（分钟级）→ 派生补采（秒级）→ 报告读取；预取那一刻缓存是冷的，
所以首个任务常常读到旧缓存（`followers=0` → 报告显示"未采集"，是如实反映而非丢失）。
连跑第二个任务、或先手工预热同关键词，即可看到真实数字。


---

## 14. 与品牌营销智能体的集成自测（双十一 · 精华）与暴露出的两个真阻断

### 14.1 自测口径

「集成」指的不是把采集器接上（那在 §13 就完成了），而是**报告真的消费到账号级字段**：

```
brief.category = "精华"        →  platform_digest 预取关键词 = brief.category（见 agents.ts:platformPrefetchArgs）
brief.platforms = [xhs, dy, bili, wb]
brief.notes     = 双十一大促…重点品牌 施华蔻 / 赫莲娜 / 兰蔻 / 雅诗兰黛
```

报告侧的两张表都来自**证据表的机械聚合**，模型只能引用、不能发明：

| 产出 | 取数函数 | 账号级字段来源 |
|---|---|---|
| 人选建议与分层 | `platformCreatorCandidates(entries, brief)` | `op=creator` 的资料条目：`followers` / `profileUrl` |
| 附录「平台真实账号」 | `platformAccountRows(entries)` | 同上；资料条目**只贡献**粉丝量与主页链接 |

`aggregatePlatformAccounts` 把资料条目与内容条目**按 (平台, 作者) 合并**，
但资料条目不计 `entryIds`、不计互动量 —— 所以"该账号名下 12 条内容"不会变成 13 条，
粉丝量也不会混进互动量排序。分层口径：**有真实粉丝量就按粉丝量**
（head ≥100 万 / mid ≥40 万 / tail 其余），没采到才退回"同平台互动量分位"，
两者不混用。

### 14.2 修掉的两个真阻断（都属于"不报错、只是产出降级"那类）

**① 同一数据库上跑着两个网关进程 → 同一个任务被两条编排链同时跑。**

现象：`E-AGENT-002 模型调用失败：aborted` 反复出现在 playbook/budget/report 阶段，
报告整体降级成"工具实测数据 + 保守模板合成"，封面挂降级横幅。
取证：`ps` 里同时存在两个 `apps/gateway/src/main.ts`；一个已被 `/cancel` 的任务
其 `jobs.status` 又被改回 `running` —— 只有"另一个进程还在跑它"能解释。
上游 `cancelJob` / `shutdown()` 都会 `controller.abort()`，两条链各有一份
`controllers`，互相 abort 对方的在途请求，就表现为 `aborted`。
另：`orchestrator.recover()` 会把未完成阶段续跑，两个进程共享同一份 `jobs` 表时
会重复认领。

修法（运维侧，代码不变）：**一个数据库只允许一个网关进程**。启动用
`nohup npm start > /tmp/brandsale-gateway.out 2>&1 & disown`，启动后确认
`lsof -nP -iTCP:8787 -sTCP:LISTEN` 只有一行；重启前先确认旧进程已退出。

**② Pi 循环「工具调用风暴」：同一个 `platform_digest` 被连续调用 131 次。**

现象：`data.degraded{reason:"rate_limited", source:"platform_digest"}` 事件 **131 条**。
每一次都是 `maxCallsPerJob` 拒绝，却没有任何机制**终止循环**。
整个阶段的预算（`PHASE_TIMEOUT_MS` 与 `BM_LLM_TIMEOUT_MS` 取大）被这些
必然失败的往返烧光：Pi 循环最后只产出一句半截话（`Unexpected token 'I', "I'll start"...`），
解析失败；轮到直连兜底时预算已耗尽 → 又记一次 E-AGENT-002 → 整份报告降级。
用户看到的就是"数据明明采到了，报告里还是占位与无数据"。

根因有两半：
- 提示词鼓励重试 —— "首次常返回 0 条…重试即可"，模型把"重试"当成了循环条件；
- 治理层只会「拒绝并解释」，没有终止手段，模型并不会因为被拒就停手。

修法（`packages/agent-pack/src/agents.ts`）：

- 新增**可测试的纯状态机** `createToolCallGuard(usableTools)`，在 Pi 的
  `beforeToolCall` 钩子上做三件事：
  · 同一工具 + 相同参数重复 **> 3 次**即拒（参数指纹用 `JSON.stringify`）；
  · 单阶段工具调用总量 **> 30** 次即拒并 `terminate`；
  · 连续被拒 **≥ 6 次**即 `terminate`，让循环提前收手，**把剩余预算留给直连兜底**
    —— 在当前端点下，后者才是真正能产出合法 JSON 的那条路径。
- 提示词同步改成有界重试（"至多再试 1–2 次、且每次换参数；仍为空就按
  「本次没有条目级平台数据」如实处理"），工具返回的 note 也加上同一句约束。

顺带修掉一个**语义不一致**（`apps/collector/src/tasks.ts`）：一个记录是不是
"个人主页资料"，由**记录类型**决定，而不是由哪个算子取回来的。B站搜索时会顺带写
`*_creators_*.jsonl`，早先按 `task.op`（=search）归一化 → 这些行被打成 `op=search`，
于是① 查询侧"按 `op=creator` 取资料行"捞不到，粉丝量/主页链接丢失；
② 它们又以"内容行"身份混进条目数。现在统一**按 kind 纠偏**：`creator` 记录一律 `op=creator`。

### 14.3 测试

- `tests/tool-call-guard.test.ts`（新增 5 例）：同一调用第 4 次起被拒；换参数不算重复；
  重复风暴能触发 `terminate`；单阶段总量有硬上限；白名单外用工具被拒并列出可用集合。
- `tests/collector.test.ts`（新增 1 例）：搜索顺带取回的资料行必须归一化为
  `op=creator`，不得以内容行身份混进 `op=search`。
- 全量 **180 tests 通过**、`npm run typecheck` 通过。

## 15. 「为什么还有未采集的？」：补读条件治"半池" + 补采上限（2026-10-15 增补）

业主在电脑品类的报告（`job_0mv85fh3yw2r0i3u465` / `job_0mv86by83ilvbnn0h1a`）截图追问：
人选页的粉丝量一列，77 条真实条目、79 位真实账号都进来了，**为什么还有 7 位写着「未采集」？**

### 15.1 根因：三条，都不是"采不到"

事实前提：这 7 位的主页资料**大部分已经采到了**，只是报告读缓存的那一刻还没落库；
剩下 2 位是真的没采。

1. **时序竞争（主因，5 位）**：内容行与资料行是两条链路。搜索任务先落库（内容行天生不带粉丝量），
   B站搜索**顺带**写出 13:59:04 的资料行，抖音/小红书则要等 13:59:11 / 13:59:22 那轮派生的
   主页补采。而 intel 阶段的预取只在 13:57:24 发生一次 —— 报告读缓存时后两批资料行还没到。
2. **补读条件太窄（半池盲区）**：creator 阶段只在**证据池完全为空**时才补读
   （`aggregatePlatformAccounts(...).length === 0`）。B站那 18 位作者已经把池子填满了，
   于是"池子非空"判定为假 → 补读被跳过 → 抖音/小红书那批作者永远拿不到粉丝量。
3. **补采上限（2 位）**：`BM_MC_PROFILE_ENRICH_MAX` 默认 12，而抖音那批有 25 位作者，
   排在 12 位之后的两人从未被派生补采过。

### 15.2 修法

1. **补读条件改为 `needsPlatformRefresh(entries)`**（`packages/agent-pack/src/agents.ts`）：
   池子为空 **或** 存在"有真实条目却没粉丝量"的账号即补读。代价有界 ——
   内容行还在缓存时适配器不重新投递采集，证据登记又按 `entryId` 去重，所以只补进新增的资料行。
   已知边界：平台侧本来就给不出粉丝量的账号（快手主页 405）会让它恒为真，可以接受
   （每次 creator 阶段最多补一次，不重采、不脏写）。
2. **补采上限 12 → 30**（`apps/collector/src/config.ts`）：整批作者本来就合成一个任务跑
   （`--creator-id a,b,c`），提高上限不会成比例加重平台侧登录校验。

### 15.3 测试

- `tests/platform-collect.test.ts`：`needsPlatformRefresh` 三分支 —— 空池要补、
  全都有粉丝量不补、**半池（有人缺粉丝量）要补**。

---

## 16. 粉丝量「未采集」的第二轮修复：补读窗口 + 读时解析（2026-10-20）

上一节（§15）修的是"creator 阶段该不该补读"，但真机 job_0mvgany95k7poz73mks 证明
**补读的时机窗口比条件更致命**：报告里 5 位人选的粉丝量全是「未采集」，而缓存里
06:45:09 / 06:45:28 就已经采到了 60.1 万 / 13.0 万 / 16.1 万 / 16.9 万 / 43.5 万。

### 16.1 时间线（硬证据）

| 时刻 | 事件 |
|---|---|
| 06:27:24 → 06:36:22 | creator 阶段（此刻资料行**还没落库**） |
| 06:45:09 / 06:45:28 | 作者主页补采落库（xhs / dy） |
| 06:45:37 → 06:57:28 | report 阶段（数据比报告早 9 秒到，却全程没再读一次） |

### 16.2 三个成因与修法

1. **补读白名单写死**：`refreshPlatformData` 的 `if (phase !== "intel" && phase !== "creator") return;`
   把 report 挡在外面。而它在**每个阶段终稿前**本来就会被调用一次 ——
   等于"最后一次自愈机会"被关掉了。**修**：白名单加 `report`，并加两道闸
   （台账里没有任何平台内容就不查；粉丝量已齐就不查），避免无谓查询。
2. **`/query` 拼资料行时被 limit 截断**：默认只拼"本批 rows 的作者"，而 rows 被截到前 20 条。
   **修**：`/query` 支持 `authorIds`（点名取），report 阶段从台账取 `authorId` 列表点名要。
   纯函数 `matchCreatorRows` 钉住两种模式的差别。
3. **读侧取写时快照**：`platformCreatorCandidates` 在 creator 阶段把 `followers` 固化成 0；
   `creatorAccountRows` 只读这个快照。**修**：新增 `creatorLiveViews` / `withLiveCreatorStats`，
   以证据表为准实时算粉丝量与分层（口径与 `tierOf` 一致），并同步改写文案里"未采集"的口径。

### 16.3 模型写的表也要回填

机械块（附录「人选名单来源与核验状态」）改了读侧就自动对；但正文那张「人选建议与分层」
是**模型生成**的，它把 creator 阶段的 0 直接写成「未采集」。只修机械块会让同一份报告里
两张表自相矛盾。`backfillCreatorStatsInTables` 负责回填，两条保守规则：

- 只补空值（未采集 / — / 空），**不覆盖**模型写过的数字；
- 只在表格块**已有 `sourceRef`** 时写数字 —— 否则会把一个"无数字、本来不触发 R6"的块
  变成"有数字但无来源"，凭空造出一条阻塞。

### 16.4 顺带修掉标识列

`pfcre_<平台>_<昵称哈希>` 是内部聚合 id：读者拿去任何平台都查不到，模型还会把它误当
`creatorId` 喂回采集（真机 `stored:0` 直接源于此）。证据条目新增 `uid`（平台原始 UID，
抖音 `user_id` / 小红书 `user_id` / B站 `mid`），报告标识列按 `uid → 主页链接 → 内部哈希`
依次回退。`authorId`（脱敏哈希）只留在内存做关联，**不落报告**。

### 16.5 测试

- `tests/creator-stats.test.ts`（9 例）+ `tests/platform-collect.test.ts`（白名单 1 例）：读时解析、缺资料时不降级、uid 展示、
  有/无 `sourceRef` 的回填对照、`authorIds` 两种模式、`shouldRefreshPlatform` 的阶段与两道闸。

# brandsale 需求补全技术方案

> 输入：`品牌营销AI智能体需求梳理_20261008.docx`（12 标题 / 38 段 / 1 表）
> 前置分析：`docs/requirements-coverage-analysis.md`、`docs/datasource-candidate-evaluation.md`、
> `docs/p0-3-data-supply-evaluation.md`
> 范围：把需求覆盖度从 **65%（20 条中 11 满足 / 4 部分 / 5 缺失）** 推到可交付，
> 并保证不破坏现有的可溯源硬约束与分层架构。

---

## 0. 一句话结论

**缺口分两类，必须分开治：**

- **代码类缺口（P0-1 / P0-2 / P1-4 / P1-5 / P1-6 / P2）** —— 6 个工作包，纯工程可闭环，
  本方案给出可落地的接口与落点。
- **数据类缺口（P0-3 粉丝画像）** —— 代码只能把**入口铺好**（官方 OAuth 通道 + 评论 IP 属地代理
  + 人工入库通道），**数据本身取决于甲方**。方案里明确区分「代码已就位」与「数据已就位」，
  不允许用前者冒充后者。

**关键判断：投入产出比最高的一步不是接数据源，而是补 RAG 入库通道（WP-A）。**
它同时解掉 P1-5 和 P0-3 的兜底路径，且零适配器开发、完全合规。

---

## 1. 目标与验收基线

沿用 `report-depth-optimization-plan.md` 的做法：**每项工作包都必须有可测的验收口径**，
不写"优化""增强"这类无法判定的目标。

| 编号 | 目标 | 现状实测 | 验收口径（可自动断言） |
|---|---|---|---|
| P0-1 | 品牌自身诊断 | 0 页 / 0 字段 | 报告含「品牌自诊」章节；`BrandSelfSchema` 校验通过；差距矩阵 ≥3 维度 |
| P0-2 | 自然语言输入 | 缺（8 字段表单） | `POST /brief/parse` 对一段自由文本返回 `Brief` 草稿 + 澄清问题；缺字段显式列出 |
| P0-3 | 粉丝画像 | 缺（非代码问题） | 代码侧：`douyin_open_fans` 适配器可用且**只对已授权达人返回数据**；未授权返回 `not_authorized` 降级而非空数据 |
| P1-4 | 投流与增量建议 | 0 处 | 报告含付费/自然流量拆分与增量归因口径；**标注为口径建议而非实测** |
| P1-5 | RAG 入库通道 | `ingest()` 零调用点、`BM_PARSER_URL` 死配置 | `POST /kb/documents` 可入库并立即被 `/kb/retrieve` 检索到；统计数 +N |
| P1-6 | 艺人维度 | 只有达人模型 | talent 支持 `creator \| celebrity` 双类目；CT 按类目检索；报告人选页区分 |
| P2-7~10 | 直播排期 / 对接人 / 舆情 / 行业种子 | 缺 | 按需排期，不进首版硬验收 |

**回归红线（不得退化）**：
`npm run typecheck` / `npm test`（现 17 条）/ `npm run check:boundaries` 全绿；
报告深度基线（13 页 / 9 块型 / 可溯源比 ≥0.6）不下降。

---

## 2. 架构总览：数据分层的三条供给路径

需求 P0-3 的"粉丝画像"落不进任何单一数据源，必须承认它是**分阶段的**。
按业务阶段拆开看，每一格都有确定的答案：

```
                     候选评估阶段                已合作阶段
                  （还没签约的达人）          （已签约/已授权的达人）
                 ┌──────────────────┐      ┌──────────────────┐
  官方授权       │  巨量星图         │      │ 抖音开放平台      │
  （L1）        │  （品牌过审后）    │      │ fans_data OAuth  │  ← 免费、官方
                 │  粉丝性别/年龄/地域│      │ 性别/年龄/地域/兴趣│     字段与需求完全一致
                 └──────────────────┘      └──────────────────┘
                 ┌──────────────────┐      ┌──────────────────┐
  公开采集       │ 第三方 API 采买    │      │ 评论 ip_label    │
  （L3）        │ （蒲公英/Just One）│      │ 省级聚合代理      │  ← 有偏，须标注
                 └──────────────────┘      └──────────────────┘
                 ┌──────────────────┐      ┌──────────────────┐
  人工入库       │ 巨量算数网页版     │      │ 艺人/机构导出     │
  （L3，人工核验）│ （免费，人工可查）  │      │ （甲方现做法）    │  ← WP-A 承接
                 └──────────────────┘      └──────────────────┘
```

**这张图决定了方案的形状**：
- 「人工入库」那一行（甲方现在唯一能拿到的数据）**今天没有任何入口** → WP-A 优先。
- 「已合作阶段」那两格是**免费且合规**的 → WP-F 商务先行。
- 「候选评估阶段」需要付费或过审 → WP-E（免费公开部分）+ 采买（兜底）。

---

## 3. 工作包分解

### WP-A　RAG 入库通道（P1-5）＋ 文档解析器　`M`

**现状事实（已核实）**

| 事实 | 证据 |
|---|---|
| `kb_docs` 表存在 | `packages/storage/src/db.ts:177` |
| 但没有对应的 repo | `Repositories` 只有 job/phase/artifact/idempotency/event/usage/audit/ledger/source/authz/cache —— **无 KbDocRepo** |
| `KbDocument` 类型是死类型 | 全库 0 处引用 |
| `ingest()` 只收预切分 chunk | `IKnowledgeService.ingest(chunks: KbChunk[], ctx)` |
| `ingest()` 只被 seed 调用 | 全库唯一调用点在 `scripts/seed.ts` |
| 无切分器 | `retrieval.ts` 无 chunk 函数 |
| HTTP 层只读 | 只有 `GET /kb/stats`、`POST /kb/retrieve` |
| `BM_PARSER_URL` 是死配置 | 只在 `config/index.ts:185` 出现，无消费者 |

**设计**

新增三层，自下而上：

1. **切分器（纯函数，L0）** → `packages/contracts/src/kb.ts`
   ```ts
   export interface ChunkOptions { targetChars?: number; maxChars?: number; overlapChars?: number; }
   export interface RawChunk { index: number; text: string; headingPath: string[]; }
   export function chunkText(text: string, opts?: ChunkOptions): RawChunk[];
   ```
   - 为什么放 `contracts`：零依赖、可单测、被 knowledge 与测试共用，且不引入循环。
   - 策略：按 Markdown 标题层级 / 空行分段 → 段内超长按中文标点（。！？；\n）切分 →
     目标 400 字、硬上限 800 字、相邻块重叠 80 字。`headingPath` 保留标题路径，
     作为 chunk 的上下文前缀写进 `meta`（提升检索命中）。

2. **文档级入库** → `packages/knowledge/src/retrieval.ts`
   ```ts
   export interface IngestDocumentInput {
     title: string;
     collection: KbCollection;
     sourceId: string;
     mime: string;              // text/markdown | text/plain
     content: string;
     publishedAt: string;
     sampleSize?: number;
     humanVerified?: boolean;
     meta?: Record<string, string | number | boolean>;
   }
   export interface IngestDocumentResult {
     docId: string; chunks: number; rejected: number;
     collection: KbCollection; sourceId: string;
   }
   async ingestDocument(input: IngestDocumentInput, ctx: {...}): Promise<IngestDocumentResult>
   ```
   - **前置校验（关键）**：`sourceId` 必须在 `sources` 台账中存在、`authz` 为 `active`、
     L4 还需 `legalApproved`。任一不满足 → 抛 `E-INGEST-001`，**不写库**。
     理由：入库是"入站写"，虽不过数据出站的闸门，但来源合法性必须同等严格——
     否则「甲方把来路不明的数据丢进 KB，报告引用后标成 L3 已核验」就成了新的合规漏洞。
   - `docId` 稳定生成：`doc_${sha1(tenantId|sourceId|title|publishedAt).slice(0,16)}`，
     同键重灌 = 覆盖（先删该 doc 的 chunk + terms + doc 行，再写），保证幂等。
   - `chunkId = ${docId}#${index}`，天然幂等。
   - 写 `kb_docs` + 复用现有 `ingest(chunks, ctx)`（它已有"无 sourceId/sourceType 拒绝入库"
     的不变量，直接复用，不重写）。

3. **文档解析器** → `packages/knowledge/src/parser.ts`
   ```ts
   export interface ParsedDocument { text: string; parser: "mineru" | "textonly"; pages?: number }
   export interface DocumentParser { parse(buf: Buffer, mime: string): Promise<ParsedDocument> }
   export function createParser(config: Config): DocumentParser;
   ```
   - `MineruParser`：`config.parser.url` 非空时启用，`POST ${url}/file_parse`，
     返回 markdown。**这一步把死配置激活**。
   - `TextonlyParser`：仅接受 `text/plain`、`text/markdown`。
   - **对 `.docx` / `.pdf` 且未配 MinerU → 明确报 `E-INGEST-002`（不支持的格式，请配置 BM_PARSER_URL）**，
     **禁止**降级成"把二进制当文本塞进去"。这跟当初删掉 5 个合成适配器是同一条原则：
     宁可明确失败，不要产生看起来像数据的垃圾。
   - 放 `knowledge` 而非新包：`knowledge` 已依赖 `config`，解析入库本就是"知识"的职责，
     新包会平白多一条依赖边。

5. **新增错误码（必须先做，否则编译不过）** → `packages/contracts/src/errors.ts`

   ⚠️ **已核实的坑**：`E-KB-001/002/003` **已被「检索域」占用**
   （重排超时 / 向量库不可用 / 库为空冷启动），复用它们会把"来源未登记"误报成"重排超时"。
   `E-PARSE-002` 虽叫"解析器不可用"，但它的语义是**已降级可重试**，
   与"格式根本不支持"（不可重试）不同，不能复用。

   因此新增一个「入库域」：

   ```ts
   "E-INGEST-001": { http: 400, domain: "入库", message: "来源未登记或未授权，拒绝入库", retryable: false },
   "E-INGEST-002": { http: 415, domain: "入库", message: "不支持的文档格式（需配置解析器）", retryable: false },
   "E-INGEST-003": { http: 409, domain: "入库", message: "同一文档正在入库（幂等冲突）", retryable: true },
   ```

   **为什么这里用 4xx，而错误码表开头写着"业务错误一律 HTTP 200"**：
   那条规则的原因写得很清楚——*"长任务里的'某个源失败'不是请求失败，前端要继续渲染其余结果"*。
   它约束的是**长任务内的降级**。`POST /kb/documents` 是**同步请求**，调用方必须当场知道
   入库成功还是失败，返回 200 反而会让人误以为写进去了。前提条件错了却回 200 是接口设计缺陷。

4. **HTTP 路由** → `apps/gateway/src/server.ts`
   ```
   POST ${API_PREFIX}/kb/documents   （需 admin）
     body: { title, collection, sourceId, content|buffer(base64), mime, publishedAt, sampleSize?, humanVerified? }
     → 201 { docId, chunks, collection, sourceId }
   GET  ${API_PREFIX}/kb/documents   → 列表（含 chunk_count）
   DELETE ${API_PREFIX}/kb/documents/:docId  → 软删（标 meta.deleted，检索过滤）
   ```
   - 幂等：`Idempotency-Key` 走现有 `IdempotencyRepo`。
   - 审计：写一条 `audit` 记录（kind = `ingest`）。
   - 权限：`admin` 角色；普通用户只能写自己租户可见的 `KB-2`/`KB-4`，
     `KB-3` 全局语料需 `admin`（因为它跨租户可见，写错了全租户受影响）。

6. **`KbDocRepo`** → `packages/storage/src/repos.ts`
   `list(tenantId, collection?)` / `get(docId)` / `upsert(doc)` / `removeChunks(docId)`。

**验收**
- 新增 E2E：`POST /kb/documents` 传一段文本 → `chunks > 0` → 立刻 `POST /kb/retrieve` 能召回该 chunk →
  `GET /kb/stats` 该 collection 计数 +N。
- 反向用例：`sourceId` 未登记 → 400 `E-INGEST-001`，且 `kb_chunks` 行数不变（校验先于写入）。
- 反向用例：`.docx` 未配 parser → 415 `E-INGEST-002`，不产生任何 chunk。

**为什么这是第一步**：它让「结合甲方多年资源让策略更精准」从宣传口径变成可操作链路，
同时给 P0-3 开了一条**完全合规的人工兜底入口**（甲方运营把巨量算数网页版的免费人群画像录进 KB-3）。

---

### WP-B　品牌自身诊断（P0-1）　`M`

**现状**：intake 只做参数合法性校验与授权核验；报告 13 页无品牌诊断章节；
`CompetitorIntelSchema` 里只有竞品，**没有"我方"**。这是需求输出清单第 1 条，却是最彻底的空白。

**设计（推荐 B 方案）**

> **决策点 D1**：品牌自诊放哪？
> - **A 方案**：新增第七阶段 `diagnosis`（intake 之后、intel 之前）
> - **B 方案（推荐）**：不新增阶段，在 `intel` 阶段内新增子产物 `brandSelf`，由 CI Agent 一并产出

**推荐 B 的理由**：
1. 需求要的是**报告里有这一章**，不是**进度条上多一格**。
2. A 方案要动 `PHASE_ORDER` / `PHASE_LABEL` / `PHASE_AGENT` / `AgentCode` / 进度百分比 /
   前端阶段条 / checkpoint 迁移 / 所有 E2E 的 phase 断言——**契约面改动大，收益是"看起来更细"**。
3. B 方案的逻辑自洽：品牌自诊本质是"和谁比、差在哪"，离开竞品参照系就没意义，
   它天然属于 `intel`。CI 的定位从"竞品情报"扩为"竞争格局（含我方基线）"，是**职责的自然延伸**而非扩权。
4. A 方案留作升级路径：若甲方明确要求"诊断作为独立可交付环节、独立进度、独立重跑"，
   再按 A 改造（改造是加法，B→A 不返工）。

**Schema** → `packages/agent-pack/src/schemas.ts`
```ts
export const BrandSelfSchema = {
  positioning: { statement: string; differentiators: string[] },      // 定位与差异点（定性）
  contentAssets: [{ platform, accountCount, postCount, avgEngagement|null, tier }],
  reputation: {
    sentiment: "positive" | "neutral" | "negative" | "unknown",
    themes: [{ theme: string; polarity: string; sampleSize: number }],
  },
  gaps: [{ dimension: string; self: string; benchmark: string; delta: string }],  // ≥3 条
  citations: Cite[],
} as const;
```
写进 `IntelOutputSchema.brandSelf`（`intel` 的 JSON skeleton 同步更新）。

**防线（这条比 schema 本身更重要）**：
品牌自诊是**最容易变成"编造自家数据"**的一章——因为"我方"看起来是"已知信息"，
模型会顺手填上"品牌认知度 32%"这类没有来源的数字。
- `contentAssets` 里所有数字必须挂 `citations`；
- 甲方未授权平台数据时（现状：KB-1 为空），**只能给 `null` 或走 `model_inference/low`**，
  `synthesis.ts` 的 `synthIntel` 里显式写 `null`，不填占位数字；
- 报告页 mandatory 挂一个 `tone="warn"` 的 callout：「品牌资产数据未获授权，本页为定性判断」。

**报告侧** → `packages/agent-pack/src/synthesis.ts`
- 新增 2 页：`品牌自诊概览`（kpi + bullets + callout）、`品牌 vs 竞品差距矩阵`（matrix + table）
- 13 页 → **15 页**（`minSlides` 是下限 12，不冲突）
- `sourceRef` 用 `phase:intel`（已有逻辑引用，不新增）

**验收**：报告含该 2 页；`gaps.length >= 3`；未授权场景下 `contentAssets[].avgEngagement === null`
且存在 warn callout；`measureReportDepth().slides >= 15`。

---

### WP-C　自然语言输入（P0-2）　`M`

**现状**：`Brief` 是 8 个结构化字段（`industry / category / brandIds / budget /
objectiveWeights / window / platforms / notes`），控制台是表单；`notes` 是唯一自由文本且**不参与解析**。

**设计：两段式解析，规则优先、LLM 兜底**

> 为什么不做成"全交给 LLM 解析"：预算、时间窗、平台、权重这四类是**强结构化**的，
> 正则能稳定抽出来；全交给 LLM 会引入不确定性，且每次解析都烧 token。
> 规则段抽出的字段**直接可用且可解释**（"从文本中识别到预算 ¥300,000"），
> 只在缺关键字段时才让模型补一次。

1. **规则段（纯函数，L0）** → `packages/contracts/src/brief-parse.ts`
   ```ts
   export interface BriefDraft {
     brief: Partial<Brief>;
     filled: string[];                                     // 规则抽到的字段
     missing: string[];                                    // 关键必填但缺失
     ambiguities: { field: string; question: string; options?: string[] }[];
   }
   export function parseBriefUtterance(utterance: string, defaults?: Partial<Brief>): BriefDraft;
   ```
   - 预算：`/(\d+(?:\.\d+)?)\s*(万|w|W|k|K|元|块)?/` + 中文数字（"三十万"）→ `Money`
   - 时间窗：`11.11` / `双11` / `618` / `Q4` / `本月` / `近90天` → `{from,to}`
   - 平台：`抖音/小红书/B站/微博` → `platforms[]`
   - 目标权重：「既要曝光…又要销量…还要品牌形象」→ 命中关键词计数归一化到 `objectiveWeights`
   - 行业/类目：命中 KB-4 方法论模板的行业词典（内置一份小词表）
2. **LLM 补全段** → `packages/agent-pack/src/brief-parse.ts`
   仅当 `missing.length > 0` 且规则信心低时调用**一次** `gateway.completeJson`，
   prompt 里带上已抽出的字段（让模型只补缺，不推翻规则结果），
   返回 `{ brief, clarifications }`；结果与规则结果做 merge（规则优先）。
3. **路由** → `apps/gateway/src/server.ts`
   ```
   POST ${API_PREFIX}/brief/parse
     body: { utterance: string, defaults?: Partial<Brief> }
     → 200 { brief: Brief-like, filled, missing, ambiguities, source: "rule"|"rule+llm" }
   ```
   **不落库、不建 job**——只做草稿解析，用户在前端确认后再走原有 `POST /jobs`。
4. **控制台** → `apps/gateway/src/console.ts`
   在现有表单上方加一个 textarea「用一句话描述你的营销诉求」+「解析」按钮，
   解析结果**回填到现有表单字段**，用户可逐个改。**不替换表单**——
   结构化字段仍然是提交契约，自然语言只是入口的糖。

**验收**：一段中文诉求 → `filled` 覆盖 `budget/window/platforms/objectiveWeights` 中 ≥3 项；
缺 `category` 时 `ambiguities` 里有对应问题；`source` 字段可区分是否用了 LLM。
新增单测覆盖 ≥6 条中英文混合样例。

---

### WP-D　数据源接入框架强化　`S`

三处契约收紧，**都是加法，不改变现有行为**。

1. **`ToolPolicy.mutating?: boolean`** → `packages/contracts/src/agent.ts`
   - 现状核实：`ToolPolicy` 字段为
     `name / allowedAgents / governance / boundSourceId / rateLimit / timeoutMs / retry /
      fallback / parallelism / replaySafe / maxCallsPerJob` —— **没有 mutating**。
   - 为什么现在必须加：DTK 只读，但 **xiaohongshu-cli 自带写能力**（点赞/评论/关注/发笔记/删笔记）。
     整包封装的话，**类型层拦不住模型去操作甲方的小红书账号**。
   - 语义：`mutating: true` 的工具**默认不暴露给任何 Agent**（装配期 `registerAllTools` 跳过），
     需 `config.tools.allowMutating === true` 才注册。
   - 现状无 mutating 工具 → **加字段零行为变化**，纯为后续铺路。
2. **`mutating` 的执行期二次确认** → `packages/agent-pack/src/tools.ts`
   `invoke()` 里对 `mutating` 工具追加一条：`governance` 必须包含 `"authz"`，
   否则装配期直接抛错（防止有人加了个写工具却忘了挂授权检查）。
3. **`assertSourceRegistration()` 不变量** → `packages/governance/src/index.ts`
   - L1/L2：必须同时有 `authMethod` + `contractRef` + `legalApproved: true`；
   - **L3：禁止填 `contractRef`**（`contractRef` 的语义是"授权合同"，L3 是公开数据没有合同，
     填了就是把"公开采集"洗成"已授权"）；
   - L4：必须有 `contractRef` 且 `legalApproved`，并受 `config.tiers.L4` 总开关约束。
   - 这一条的作用：**把"用未授权采集冒充甲方授权实测"从"靠人自觉"变成"写不进去"**。
     它正是当初删掉 5 个合成适配器要防的同一类问题的另一半。

**验收**：新增单测 —— 注册 L3 源带 `contractRef` → 抛错；L1 源缺 `contractRef` → 抛错；
`mutating` 工具在 `allowMutating=false` 时不进注册表。

---

> **⚠️ 状态更新（2026-10-09）：WP-E / WP-F 已实施后又整体回退，随后由"七平台采集"取代。**
> `douyin_web_public` 与 `xhs_web_public` 两条适配器、四个工具
> （`douyin_creator` / `douyin_comments` / `xhs_creator` / `xhs_note`）、联调脚本
> `scripts/datasource-lab.ts` 均已从代码中删除。
>
> 回退后产品方决定**改用 MediaCrawler 的采集内核**，覆盖七平台
> （小红书 / 抖音 / 快手 / B站 / 微博 / 贴吧 / 知乎）。内核已**源码内嵌**进本仓库
> （`services/collector-core/`，只保留采集必需部分），部署上只有 brandsale 一个系统；
> 链路为 `services/collector-core` ──spawn──▶ `apps/collector`（归一化 + 缓存）
> ← 七个 L3 适配器 + 七个平台工具。
> 新工具名：`xhs_web` / `douyin_web` / `kuaishou_web` / `bilibili_web` / `weibo_web` /
> `tieba_web` / `zhihu_web`（白名单 `["CI","CT"]`）。
>
> ⚠️ 该链路带**非商用许可**约束，必须显式打开 `BM_MC_LICENSE_ACK` 才装配。
> 现状与运行手册见 [`docs/datasource-integration.md`](./datasource-integration.md)，
> 选型与许可以及"为什么 WP-E/F 被取代"见
> [`docs/datasource-platform-collection-analysis.md`](./datasource-platform-collection-analysis.md)。
> 以下两节保留原始设计记录，**不代表当前代码状态**。

### WP-E　抖音公开数据只读适配器（DTK）　`M`（已回退）

**已核实的能力边界**（`docs/datasource-candidate-evaluation.md`）
- 仓库：`Evil0ctal/Douyin_TikTok_Download_API`，20.5k star，Apache-2.0，最近提交 2026-10-02（活跃）
- **实际只接线 10 个端点**；`GENERAL_SEARCH`（关键词搜索）、`DOUYIN_HOT_SEARCH`（热榜）
  在类里定义了却**没进注册表** → **没有搜索、没有热榜**
- 关注/粉丝列表明确不支持（需登录态，作者拒绝注册"永远返回空页"的端点）
- 自托管常驻服务 + 自带 MCP

**设计**
- 新增 `packages/datasource/src/douyin-web.ts`
  ```ts
  export const DOUYIN_WEB_SOURCE_ID = "douyin_web_public";
  export function createDouyinWebAdapter(config: Config): DataSourceAdapter;
  ```
  - `tier: "L3"`　**这是红线**：不存在与平台的授权合同，标 L1/L2 等于把未授权采集洗成甲方授权实测。
  - `capabilities: ["creator_profile","creator_posts","content_detail","comments"]`
  - 只实现**只读子集**：作者主页 / 作者作品 / 作品详情 / 评论 / 二级回复
  - `Provenance.note` 强制文案：`公开网页聚合，未经人工核验，非授权实测`
  - 不做：搜索、热榜（未接线）、关注粉丝列表（作者已拒绝）、任何写操作
- `config` 新增**顶层**段（与现有 `webSearch` 同级，不放进 `datasource` 子对象——
  现状 `webSearch` 就在顶层，保持一致）
  ```ts
  douyin: { enabled: boolean; baseUrl: string; timeoutMs: number; cacheTtlSeconds: number; maxCallsPerJob: number }
  ```
  `baseUrl` 为空则不注册适配器 → `registerAllTools` 因 `boundSourceId` 缺适配器而跳过该工具，
  Agent 的工具清单里根本不会出现它（与 `web_search` 同一模式）。
- 新工具 → `packages/agent-pack/src/tool-impls.ts`
  `douyin_creator`（allowedAgents `["CI","CT"]`）、`douyin_comments`（`["CI"]`），
  均 `boundSourceId: DOUYIN_WEB_SOURCE_ID`、`maxCallsPerJob` 设上限（令牌桶限速率不限总量）。
- 台账登记 → `scripts/seed.ts` 的 `BUILTIN_SOURCES` 加一条 L3 源 + `BUILTIN_GRANTS` 授权。

**能补的格子**：达人维度、竞品内容矩阵、舆情/评论口碑 → 对应需求 P1-6 的一半 + P1 舆情。
**不能补**：P0-3 粉丝画像（DTK 的 `parser.py` 明明拿得到 `gender`/`city`，
但归一化时**有意不取**——它回答"账号是谁"，不回答"账号的粉丝是谁"）。

**验收**：配了 `BM_DOUYIN_BASE_URL` 且服务可达 → `douyin_creator` 出现在 CI 工具清单；
未配置 → 工具不注册且不报错；返回结果的 `provenance.tier === "L3"` 且 `synthetic === false`。

---

### WP-F　抖音官方 fans_data 通道（P0-3 正道）　`M`（商务）+ `S`（代码）

**这是唯一能真正交付"粉丝画像/占比/年龄层"的路径**，且**免费、官方**。

**已核实的接口**（`docs/p0-3-data-supply-evaluation.md`）
```
GET https://open.douyin.com/api/douyin/v1/user/fans_data/?open_id=...
→ all_fans_num / gender_distributions / age_distributions / geographical_distributions
  / interest_distributions / device_distributions / active_days_distributions / flow_contributions
```
- 门槛：仅企业/党政/事业单位；需申请「关系能力/关系数据」；审核 2–3 工作日；
  首次授权后间隔 2 天才出全量数据；仅提供粉丝 >100 的用户
- **决定性约束**：入参是 `open_id`（OAuth 换取）→ **只能查授权给你的达人**

**这意味着产品叙事要改**（这是方案的商业价值点，不是技术细节）：
- ❌ 不能宣称"我们能看到任意明星的粉丝画像"
- ✅ 可以宣称"合作的艺人点一次授权，粉丝画像就自动进系统，不再靠人工索要截图"
- 对甲方的话术：**把"人工向艺人索要"这个需求痛点，换成一次 OAuth 授权的工程问题**

**代码侧（本轮做预留，不做实现）**
1. 台账登记 → `scripts/seed.ts`
   `{ sourceId: "douyin_open_fans", tier: "L1", authMethod: "抖音开放平台 OAuth（关系能力）", contractRef: "开发者应用 app_id（待申请）" }`
   —— 注意：它是 **L1**（甲方/达人授权），不是 L3，与 WP-E 的 DTK 严格区分。
2. 适配器骨架 → `packages/datasource/src/douyin-open.ts`
   `createDouyinOpenAdapter(config)`，注册条件：`config.douyinOpen.clientKey/clientSecret` 均非空
   （同样放**顶层**，与 `webSearch` 一致）。
   `capabilities: ["fans_gender","fans_age","fans_geo","fans_interest"]`
3. **授权映射表**（关键新增）→ `packages/storage/src/db.ts` 新 migration
   ```sql
   CREATE TABLE douyin_auth (
     tenant_id   TEXT NOT NULL,
     talent_id   TEXT NOT NULL,
     open_id     TEXT NOT NULL,
     authorized_at TEXT NOT NULL,
     expires_at  TEXT,
     scope_json  TEXT NOT NULL DEFAULT '[]',
     PRIMARY KEY (tenant_id, talent_id)
   );
   ```
   没有它就没法把"库里的人选"映射到"可查询的 open_id"。
4. **降级语义（红线）**：未授权的达人 → 返回
   `degraded: { reason: "not_authorized", note: "该达人未完成 OAuth 授权，无法查询粉丝画像" }`，
   **绝不返回空数组假装成功**——空数组会被下游当成"该达人没有粉丝数据"，
   报告会渲染成"粉丝画像：无"，这是最危险的静默错误。

**商务清单（非代码，立即启动）**
- 申请企业开发者 + 「关系数据」权限（2–3 工作日）
- 准备 OAuth 授权落地页（达人点击授权的入口）
- 与甲方确认首批纳入授权的达人名单

---

### WP-G　报告侧扩展（横切）　`S`

- 新增页由各自工作包负责（WP-B 加 2 页、WP-E/P 加节）
- 来源声明页**无需改动**：`buildSourceCatalog()` 已自动合并「台账源 ∪ KB 语料源 ∪ 内部仓」，
  新登记的数据源会自动出现在可声明集合里
- `packages/contracts/src/report.ts` 的 `LOGICAL_REFS` 新增 `source:douyin_open_fans`（保持 `REF_ALIASES` 向后兼容）
  - ~~`tool:douyin_creator` / `tool:douyin_comments`~~ —— 两个工具已随 WP-E 回退删除，不再新增
- 深度策略：`minSlides` 维持 12（实际 15 页），`requiredBlockTypes` 不变

---

## 4. 依赖关系与实施顺序

```
WP-D（契约收紧，无依赖）─────────────────┐
                                        ├──→ WP-E（DTK 适配器）
WP-A（RAG 入库，无依赖，含 KbDocRepo）──┘

WP-A ──→ WP-B（品牌自诊）  ← 自诊需要 KB 检索能力已就绪（当前已具备，WP-A 让数据进得来）
WP-A ──→ WP-C（自然语言）

WP-F 商务申请 ────────────────────────→ WP-F 代码（等权限/应用审批）

全部 ──→ 回归（typecheck / test / boundaries / 深度基线）
```

**建议节奏（4 个批次）**

| 批次 | 内容 | 理由 |
|---|---|---|
| **批 1** | WP-A + WP-D | 均无依赖、可并行；WP-A 是最高 ROI 单点；WP-D 是小时级改动但决定后续安全性 |
| **批 1.5（并行，非开发）** | WP-F 商务申请 | 审核 2–3 工作日，**必须最先启动**，别让商务串行等开发 |
| **批 2** | WP-B + WP-C | 两条 P0 代码线，互不依赖，可并行 |
| **批 3** | WP-E | 依赖 WP-A（真实数据要有地方落）+ WP-D（mutating 契约先就位） |
| **批 4** | WP-F 代码 + P1-4 投流口径 + P1-6 艺人维度 | 按甲方确认的首版范围决定是否进本轮 |

---

## 5. 验收与回归

**新增测试**

| 用例 | 断言 |
|---|---|
| E2E-KB-1 | 文本入库 → 立即可检索 → stats 计数 +N |
| E2E-KB-2 | 未登记 sourceId → 400 `E-INGEST-001` 且库内行数不变 |
| E2E-KB-3 | `.docx` 无 parser → 415 `E-INGEST-002`，不产生 chunk |
| E2E-BRIEF-1 | 中文诉求 → `filled` 覆盖 ≥3 字段；缺 `category` 有澄清问题 |
| E2E-SELF-1 | 报告含品牌自诊 2 页；`gaps >= 3`；未授权时 `avgEngagement === null` + warn callout |
| E2E-DEPTH（回归） | `slides >= 15`、块型全覆盖、`traceableRatio >= 0.6`、来源声明键全在 catalog |
| 单测-CONTRACT-1 | L3 带 contractRef → 抛错；L1 缺 contractRef → 抛错 |
| 单测-CONTRACT-2 | `mutating` 工具在 `allowMutating=false` 时不注册 |

**回归门禁（同前）**
```
npm run typecheck           # 必须绿
npm test                    # 17 条 → 预期 24+ 条，全绿
npm run check:boundaries    # 必须绿
BM_LLM_MODE=mock npm run demo:mock   # 报告深度基线不下降
```

**架构边界影响评估**

| 工作包 | 是否新增依赖边 | 说明 |
|---|---|---|
| WP-A | 否 | 解析器放 `knowledge`（已依赖 config）；`KbDocRepo` 在 `storage` 内部 |
| WP-B | 否 | 全在 `agent-pack` 内部 |
| WP-C | 否 | 规则段放 `contracts`（叶子，纯函数）；LLM 段在 `agent-pack` |
| WP-D | 否 | 契约加可选字段 |
| WP-E | 否 | 适配器在 `datasource` 内部，`config` 加段 |
| WP-F | 否 | 同上；新表在 `storage` migration |

**无一处需要放宽 `check-boundaries` 的依赖矩阵** —— 这是方案成立的前提之一。

---

## 6. 明确不做（防止范围蔓延）

1. **不为了"看起来有数据"而注册任何合成/占位数据源**。这是项目已有的血泪教训
   （5 个合成适配器被整体移除），方案里所有新增源都必须是真实可达的，未就绪就不注册。
2. **不绕过闸门直连数据源**。所有新增适配器都走「工具声明 `boundSourceId` → 闸门 → 限流 → 降级」，
   与 `web_search` 完全一致。
3. **不接"巨量星图出租 / 品牌过审代办"**。检索中大量出现的这类服务违反平台条款、
   有封号风险、数据来源合法性无法证明——走这条路报告里的 `sourceDeclaration` 就是假的，
   与项目的可溯源硬约束直接冲突。
4. **不把评论 `ip_label` 当作粉丝地域**。可以做省级聚合的**有偏代理**，但必须：
   只省级聚合、只输出占比区间不落个人标识、报告标注「评论者地域分布（有偏代理，
   评论者 ≠ 粉丝总体）」、新增前过一次 privacy 评审。
   外部安全审计对该做法给出过 **Medium / 97% 置信度**的隐私风险发现，
   批评的正是"把 ip_label 拉进一个不需要它的任务"。
5. **不新增第七编排阶段**（除非甲方明确要求独立进度，见决策点 D1）。
6. **不做 xiaohongshu-cli**。三个问题叠加：许可存疑（README 标 Apache-2.0 但仓库无 LICENSE 文件）、
   6.5 个月未更新、**自带写操作**。等 WP-D 的 `mutating` 契约稳定后再评估，本轮缓接。

---

## 7. 待甲方/产品拍板的决策点

| # | 决策 | 方案默认建议 | 影响 |
|---|---|---|---|
| D1 | 品牌自诊放「intel 子产物」还是「新增第七阶段」 | **intel 子产物（B 方案）** | 契约改动面大小 |
| D2 | L3 采集类数据在报告中的表述边界 | 只支撑关于**他人**的公开断言（"该达人公开粉丝量 380 万"），**不得**支撑关于甲方自身的断言（"我们店铺 ROI"） | 合规底线 |
| D3 | 评论 IP 属地代理是否启用 | **默认不启用**，需 privacy 评审通过 + 甲方书面同意 | 隐私风险 |
| D4 | 入驻抖音开放平台的主体 | 甲方企业主体 还是 我方代申请 | 权限归属与数据所有权 |
| D5 | 首版是否含 P1-4 投流口径 | 建议含（口径建议而非实测，成本低） | 需求输出清单第 5 条完整性 |
| D6 | KB-3 全局语料的写入权限 | 仅 `admin`（跨租户可见，写错影响全租户） | 运营便利 vs 隔离安全 |

---

## 8. 与既有方案的关系（不要回退的部分）

本方案是**加法**，以下四条既有设计必须保持：

1. **可溯源是硬约束**：报告 DSL 的 R1–R12 引用校验、非法来源降级为 `model_inference/low`
   并记 `degraded`（而非拒绝出报告）——WP-B 的品牌自诊尤其依赖这条。
2. **三级降级链**：Pi Agent 循环 → 直连结构化输出 → 确定性合成。WP-E/WP-F 的适配器
   必须在**第三级也能优雅降级**（未配置/未授权 → 显式 `degraded`，不静默）。
3. **闸门是唯一通路 + 来源由代码绑定**：`boundSourceId` 覆盖参数里的 `sourceId`，
   防止模型自报来源绕过检查。新增工具必须遵守。
4. **分层单向依赖**：本方案零新增依赖边，`render` 仍只依赖 `contracts + config`。

---

## 9. 附：变更文件清单（按工作包）

**新增文件（11 个）**

| 文件 | 工作包 | 说明 |
|---|---|---|
| `packages/knowledge/src/parser.ts` | WP-A | `DocumentParser`（MinerU / textonly 双实现），激活 `BM_PARSER_URL` |
| `packages/governance/src/source-guard.ts` | WP-D | `assertSourceRegistration()` + `createIngestSourceGuard()` |
| `packages/contracts/src/brief-parse.ts` | WP-C | 规则段解析（纯函数，L0） |
| `packages/agent-pack/src/brief-parse.ts` | WP-C | LLM 补全段 |
| `packages/datasource/src/douyin-web.ts` | WP-E | DTK 只读适配器（L3） |
| `packages/datasource/src/douyin-open.ts` | WP-F | 官方 fans_data 适配器骨架（L1） |
| `tests/kb-ingest.test.ts` | WP-A/WP-D | 15 条：切分器 / 解析器 / 来源守卫 / E2E-KB-1~3 / 全局开关 / 契约不变量 / mutating 准入（**已落地**） |
| `tests/brief-parse.test.ts` | WP-C | ≥6 条样例单测（批 2） |
| `tests/golden/report.depth.json`（更新） | WP-B | 页数 13 → 15，基线写回 |

**修改文件（13 个）**

| 文件 | 工作包 | 改动 |
|---|---|---|
| `packages/contracts/src/errors.ts` | WP-A | 新增 `E-INGEST-001/002/003`（**前提条件**，否则其他改动编译不过） |
| `packages/contracts/src/kb.ts` | WP-A | `chunkText()` + `IngestDocumentInput/Result` + `KB_COLLECTIONS` + `IngestSourceGuard` |
| `packages/contracts/src/agent.ts` | WP-D | `ToolPolicy.mutating?: boolean` |
| `packages/contracts/src/report.ts` | WP-G | `LOGICAL_REFS` 新增 3 项 + `REF_ALIASES`（批 3） |
| `packages/storage/src/db.ts` | WP-F | 新 migration：`douyin_auth` 表（批 4；`kb_docs` 已存在，无需建） |
| `packages/storage/src/repos.ts` | WP-A | **无改动**（文档级 SQL 归 knowledge，见 §10 偏差 1） |
| `packages/knowledge/src/retrieval.ts` | WP-A | `ingestDocument()` / `listDocuments()` / `deleteDocument()`；`ingest()` 抽出 `writeChunks()` |
| `packages/knowledge/src/index.ts` | WP-A | 导出 `parser` / `stableDocId` |
| `packages/governance/src/gate.ts` | WP-D | `registerSource` 接入 `assertSourceRegistration` |
| `packages/governance/src/index.ts` | WP-D | 导出 source-guard |
| `packages/config/src/index.ts` | WP-A/D | `parser.timeoutMs` / `tools.allowMutating` / `kb.allowGlobalWrite` |
| `packages/agent-pack/src/schemas.ts` | WP-B | `BrandSelfSchema` + `IntelOutput.brandSelf`（批 2） |
| `packages/agent-pack/src/synthesis.ts` | WP-B | `synthIntel` 产出 `brandSelf`；`synthReport` 加 2 页（批 2） |
| `packages/agent-pack/src/tools.ts` | WP-D | `policy()` 默认 `mutating: false` |
| `packages/agent-pack/src/tool-impls.ts` | WP-D | 抽出并导出 `admitTool()`；`registerAllTools` 改为调用它 |
| `apps/gateway/src/server.ts` | WP-A | 3 条 KB 路由（POST/GET/DELETE `/kb/documents`） |
| `apps/gateway/src/container.ts` | WP-A/D | 注入 `createIngestSourceGuard` + `createParser`；新增启动告警 |
| `apps/gateway/src/console.ts` | WP-A | 「知识库入库」面板（来源下拉 + 入库 + 列表 + 删除） |
| `scripts/seed.ts` | WP-E/WP-F | `BUILTIN_SOURCES` 加 2 条（L3 DTK / L1 fans_data）（批 3/4） |
| `.env.example` | WP-A/D | `BM_PARSER_TIMEOUT_MS`、`BM_TOOLS_ALLOW_MUTATING`、`BM_KB_ALLOW_GLOBAL_WRITE` |

**零改动（有意为之）**

- `packages/render/src/index.ts` —— 渲染层不进本方案，报告页数变化由 DSL 驱动
- `scripts/check-boundaries.ts` —— **依赖矩阵无需放宽**，这是方案可实施性的验证点
- `packages/contracts/src/report-depth.ts` —— `minSlides` 是下限（12），15 页自动通过

---

## 10. 实施记录：批 1（WP-A + WP-D）已落地

状态：**已完成并通过全量验证**。以下记录与方案的偏差，避免文档与代码脱节。

### 验证结果

```
npm run typecheck        通过
npm run check:boundaries 通过（零新增依赖边，依赖矩阵未放宽）
npm test                 32/32 通过（原 17 条 + 新增 15 条）
npm run demo:mock        六阶段流水线正常，报告深度基线未退化
启动告警                 "未配置 BM_PARSER_URL：KB 入库通道目前只接受纯文本…"
```

实测入库链路（真实起服务、curl 打真接口）：

| 场景 | 结果 |
|---|---|
| 合法来源入库 → 立即检索 | 201；切出 2 块；`/kb/retrieve` 命中 `doc_xxx#0`、`#1` |
| 切分质量 | 块文本带标题路径前缀 `2026 Q3 美妆行业公开情报 > 一、类目大盘` |
| 未登记来源 | **400** `E-INGEST-001`，库内行数不变 |
| 无授权来源（L4 未过法务） | **400** `E-INGEST-001` |
| 幂等重传 | 同 `docId`，`replaced: true`，块数仍为 2（不翻倍） |
| docx 未配解析器 | **415** `E-INGEST-002`，不产生任何 chunk |
| 全局写入（默认关） | **400** `E-INGEST-001` |
| 删除文档 | `removedChunks: 2`；`kb_docs` 归零、**孤儿倒排词项 0** |
| 审计流水 | 「新增 → 覆盖 → 删除」三条 `kb.ingest` 记录完整 |

### 与方案的 6 处偏差（及原因）

| # | 方案原定 | 实际实现 | 原因 |
|---|---|---|---|
| 1 | 新增 `KbDocRepo`（`storage/repos.ts`） | **未新增**，文档级 SQL 落在 `KnowledgeService` | 写完发现与 `ingestDocument` 逻辑重复——两处 SQL 就是两份真相。KB 的表本就由 knowledge 独占（`stats`/`sourceIds`/`chunkIds` 全是原生 SQL），把它统一放在 knowledge 更一致，也少一层间接。 |
| 2 | L4 必须有 `contractRef` | **撤掉该约束** | 破坏了既有设计：E2E-10 依赖"L4 可先登记、合同后补，使用期由双开关拦截"。而且 L4 的门（`config.tiers.L4` + `legalApproved` + 闸门）**比一个字符串字段强得多**——不变量应当编码"系统无法用其他方式保证的东西"。 |
| 3 | KB-3 全局语料"仅 admin 可写" | 改为 `config.kb.allowGlobalWrite` 部署开关（默认 false） | `TenantContext` 里**没有角色概念**（token 只有 `t.<tenantId>.<userId>` 三段）。宁可暂时用一个部署开关守住，也不要靠 `userId` 字符串匹配猜谁是管理员。角色系统落地后应改为按角色鉴权。 |
| 4 | 未提解析超时 | 新增 `BM_PARSER_TIMEOUT_MS`（默认 60s） | 原 `config.parser` 只有 `url`/`fallback`。网络调用没有超时是缺陷；而 pdf/扫描件解析本就慢，用 8s 这类默认值必然超时。 |
| 5 | 装配期过滤内联在 `registerAllTools` | 抽出 `admitTool()` 并导出 | mutating 的三条约束是**安全不变量**，靠"读代码确认"验证不够。抽成纯函数后可单测（新增用例已覆盖四种组合）。 |
| 6 | WP-A4 只做路由 | **额外补了控制台入库面板** | 没有它，入库通道等于只有 curl 能用，"让甲方运营把资料放进来"这条产品承诺落不了地。面板含：来源下拉（自动标注"（无授权）"）、入库、文档列表、删除。 |

### 实现中修正的两个自身错误

1. **`E-KB-001/002` 复用冲突**（写方案时已发现并改正）：它们是「检索域」的重排超时/向量库不可用，复用会把"来源未登记"误报成"重排超时"，排障方向反了。已改为新增「入库域」`E-INGEST-001/002/003`。
2. **`purgeChunks` 顺序写反**：初版先 `DELETE kb_chunks` 再 `SELECT chunk_id` 去删倒排词项，导致 SELECT 返回空集、词项残留。残留词项会让 BM25 命中一个已不存在的 chunk——表现为"检索结果里出现空白条目"且不报错。已修正为先查后删，并写了注释说明为什么顺序不能反。

### 仍未做（留给后续批次）

- `POST /brief/parse`（WP-C，批 2）
- 品牌自诊（WP-B，批 2）
- DTK 适配器（WP-E，批 3）
- `douyin_auth` 表 migration（WP-F，批 4）
- `POST /api/v1/sources` 目前仍会把 `E-GOV-005`（http=200）当成功状态返回——这是既有约定，WP-D 未改动它；若要改成 4xx 属于独立议题。

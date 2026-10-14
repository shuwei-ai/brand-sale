# 报告摘要 → 向量库回灌：集成分析

> 命题：把每次生成的报告做一份**摘要**，用 **EmbeddingGemma 2**（`google/embeddinggemma-2`）向量化，
> 存进 **Milvus**，让历史报告成为后续任务的检索语料。
>
> 本文是**集成分析**，不是实现。结论先给：目标合理，但**三类能力不该打包一起上**——
> 摘要生成和真实 embedding 是低风险高收益，Milvus 在当前规模下是负收益，
> 建议拆成三期，用已有的 `BM_VECTOR_DRIVER` 开关留出接口。
>
> **部署口径（已定）**：Milvus 走 **Docker**（Standalone + Docker Compose），
> 不用 Milvus Lite、不用 sidecar 进程。见 §4.8。这一决定解掉了原方案最大的障碍
> （Node 无法内嵌 Python 库），但也把"部署只有 brandsale 一个系统"改成了
> "**brandsale + 一组 Milvus 容器**"，需要在运维口径上同步。

---

## 0. 结论摘要（TL;DR）

| 议题 | 结论 |
| --- | --- |
| 方案整体 | 方向对（本地知识库要长"记忆"），但**当前提法把三类东西捆在一起**：摘要抽取（业务逻辑）、真实 embedding（模型接入）、向量库（存储选型）。三者风险与收益量级完全不同。 |
| EmbeddingGemma 2 | 可接入，**Apache 2.0 是相对 v1 的实质利好**（v1 是门控 Gemma 许可）。但我们是**纯文本**场景，吃到的是 270M 文本塔，其多语言分与 v1 基本持平——**多模态那部分能力目前用不上**。 |
| Milvus | **部署形态已定：Docker（Standalone + Compose）**。Docker 解掉了"Milvus Lite 是纯 Python 库、Node 网关无法内嵌"这个最大障碍，因此**P3 的门槛从"部署形态"降为"双写一致性"**（§5.3）。但代价要认清：3 个容器（milvus / etcd / MinIO）、8GB 内存起步、开发机需 Docker Desktop，且部署不再是单进程。**引入时机仍建议等触发条件**，理由从"部署太麻烦"变成"当前语料量用不上"。 |
| 真正的瓶颈 | 不在存储，在**向量没有落盘**：`retrieve()` 每次查询都在 JS 里对候选行**现算** `hashEmbed()`。换成真模型后这一步会变成主要开销。 |
| 最大风险 | **溯源回环**：摘要若由 LLM 生成、又被后续报告当证据引用，就出现「模型产物 → 当作事实引用」的闭环，直接击穿本项目最贵的资产（citation 制度）。必须结构性隔离。 |
| 建议路径 | ① 摘要机械抽取 + 落盘向量（SQLite BLOB）→ ② 接 EmbeddingGemma 2 HTTP 服务替换 `hashEmbed` → ③ 语料过阈值后切 Milvus（Docker），仅替换存储驱动。 |

---

## 1. 现状核对（代码级证据）

先把"现在的知识库到底是什么"钉住，方案才有落点。

| 事实 | 证据 |
| --- | --- |
| 四库 = KB-1 客户授权 / KB-2 历史执行 / KB-3 公开情报 / KB-4 方法论 | `packages/contracts/src/kb.ts` `KB_LABEL`；仅 KB-3/KB-4 可写全局作用域（`GLOBAL_WRITABLE_COLLECTIONS`） |
| 存储在 SQLite：`kb_docs` / `kb_chunks` / `kb_terms` | `packages/storage/src/db.ts:177-210` |
| 语义通道是**占位实现**：256 维字符 n-gram 哈希 | `packages/knowledge/src/retrieval.ts` `hashEmbed()`，`VEC_DIM = 256`，文件头注释明写"接入 Infinity / bge-m3 时只需替换 `embed()` 的实现" |
| **向量不落盘**：每次查询现算 | `retrieve()` 里 `cosine(qVec, this.embed(r.text))` 对**每个候选行**调用；只有 5000 条内存 LRU（`embedCache`），进程重启即失效 |
| 检索 = BM25 ⊕ 向量 → RRF 融合 → 外部重排 | 融合 `K_RRF = 60`；重排候选池 `max(topK, BM_RERANK_POOL_SIZE=50)`；降级链 `E-KB-001`（重排超时）`E-KB-002`（向量库不可用）`E-KB-003`（库为空） |
| 重排走**外部 HTTP**（Jina/Cohere 形状：`{model, query, documents, top_n}` → `results[].relevance_score`） | `callRerank()`，`packages/knowledge/src/retrieval.ts:575` |
| 配置里**已预埋**但**全仓无实现**的开关 | `retrieval.vectorDriver: "memory" \| "qdrant"`、`embedUrl`、`embedModel`（`packages/config/src/index.ts:279-288` / `:520-529`）——grep 全仓只有定义与解析两处，**没有任何消费点** |
| 入库有来源闸门，fail-closed | `ingestDocument()` 未注入 `IngestSourceGuard` 时一律拒绝；`WriteChunks` 对无 `sourceId/sourceType` 的行直接丢弃 |
| 入库幂等 | `stableDocId([scopeTenant, sourceId, title, publishedAt])`，同键覆盖（先 `purgeChunks` 再写） |
| 报告产物落点 | `packages/orchestrator/src/pipeline.ts` `renderReport()` → 写 `report_dsl` / `report_markdown` / `report_html` 三个 artifact |
| 月度台账 | `scripts/seed.ts` `BUILTIN_SOURCES` + `resolveLegalApproved()`（合规布尔量**只设默认拒绝**，不设默认值） |
| 迁移机制 | `packages/storage/src/db.ts` `MIGRATIONS[]`，每项 `{id, name, sql}`，按 id 顺序增量执行 |

**一句话**：架构上已经为"真实 embedding + 向量驱动"留好了插座（`vectorDriver` / `embedUrl`），
只是插头从没插上过。这对我们是好消息——接入不是改造，是**填坑**。

---

## 2. 两个组件的真实情况

### 2.1 EmbeddingGemma 2（`google/embeddinggemma-2`）

> 核查说明：HF 模型页直连失败，以下事实来自 Google 官方博客的多家转载与第三方模型目录，
> **实施前必须以 HF 模型卡为准逐条复核**；下述基准分**均为 Google 自报，未经第三方复现**。

| 项 | 值 |
| --- | --- |
| 发布 | 2026-10-06 |
| 总参数 | 740M = 文本/代码塔 270M + 视觉编码器 170M + 音频编码器 300M（**模块化，可只载文本塔**） |
| 架构 / 上下文 | Gemma 4 / 8,192 token（v1 是 2K，4 倍） |
| 输出维度 | 768，MRL 可截断至 512 / 256 / 128 |
| 模态 | 文本、代码、图像、视频帧、音频映射到**同一 768 维空间** |
| 许可 | **Apache 2.0**（v1 是门控 Gemma 许可）——商业可用、可自行托管，这是相对 v1 的实质改善 |
| 语言 | 100+ |
| 资源 | 文本版量化后约 191MB 活跃内存；全模态约 567MB |
| 生态 | sentence-transformers / llama.cpp / Ollama / LiteRT 均可跑 |

**对我们要害的三点判断：**

1. **好消息**：Apache 2.0 干净落地，没有 MediaCrawler 那种"非商用许可 + 三道闸门"的合规包袱。
2. **持平项**：多语言文本分 61.36（v1 61.15），基本没变。**我们的报告摘要是纯中文文本，
   吃到的是 270M 文本塔，能力上限≈ v1**。真正的提升集中在 MTEB Code（68.76 → 78.68），对营销文案检索无感。
3. **用不上的部分**：视觉/音频编码器目前是**死重量**。除非未来要跨模态检索（"找到了讲这个的打法的那张图/那段口播"），
   否则按文本塔装载即可——省 470M 参数与约 376MB 内存。

> 结论：**选它，但不为多模态付费**。若日后要按"文本+图表"跨模态检索（我们的报告确实有 chart 块），
> 那时再开视觉塔，向量空间是同一个，不用重建库——这是它唯一真正优于纯文本模型的地方。

### 2.2 Milvus

| 形态 | 说明 | 本项目选型 |
| --- | --- | --- |
| **Milvus Standalone（Docker Compose）** | 官方 `milvus-standalone-docker-compose.yml`，拉起 **3 个容器**：`milvus-standalone` + `milvus-etcd`（元数据）+ `milvus-minio`（对象存储）。消息队列默认用内嵌的 Woodpecker，**无需额外部署**。（早期版本可选 Pulsar，不装） | ✅ **已选定** |
| Milvus Lite | 纯 Python 库（v3.0 起重写），`pip install -U "pymilvus[milvus-lite]"`，本地 `.db` 或本地 gRPC server。**Node 网关无法内嵌**，只能起 sidecar 进程 | ❌ 否决——要额外 Python 运行时 + 自建进程守护 |
| Milvus Distributed / Zilliz Cloud | K8s / 托管 | ❌ 规模不匹配 |

**选 Docker 是对的决定**，因为它一次性消掉了 Lite 路线的两个硬伤：
不用引入第二个 Python 产物、不用自己写进程守护与重启策略，
而且**本地与生产是同一份 compose、同一套 API**，将来真要横向扩容也是换 compose 而非改代码。

**但要如实记下代价**：

| 项 | 要求 |
| --- | --- |
| 容器 | 3 个（milvus / etcd / minio），可选第 4 个 Attu（Web 管理界面，8000） |
| 内存 | Standalone **最低 8GB**，推荐 16GB。macOS 上 Docker Desktop 的 VM 必须调到 **≥2 vCPU + 8GB**，否则装不起来 |
| 磁盘 | SATA 3.0 SSD 起步，**etcd 强烈建议本地 NVMe**（etcd 对 fsync 敏感，慢盘会引发频繁选举导致整体退化） |
| CPU | 需支持 SSE4.2 / AVX / AVX2 之一（SIMD 指令集，向量检索与建索引依赖） |
| 端口 | `19530`（gRPC **与 RESTful 复用同一端口**）、`9091`（仅健康/指标）、`2379`（etcd）、`9000`/`9001`（MinIO API/控制台） |

> **实测修正（2026-10-12）**：Milvus 3.0 的 **RESTful API 在 19530**，**9091 只有健康端点**
> （`/healthz`、`/api/v1/health`）。打 `9091/v2/vectordb/*` 会得到 `404 page not found`——
> 网上大量旧文章写"REST 在 9091"，照抄会误判成"接口写错了"。
> 这一点很关键：**走 19530 的 REST 就能让集成类零依赖**，不必引 gRPC SDK。

**部署边界（必须写进 README）**：本项目原口径是"部署上只有 brandsale 一个系统"，
现在变成 **"brandsale + 一组 Milvus 容器"**。开发侧新增一条前置：**Docker Desktop 需分配 8GB VM**。
`infra/milvus/` 放 compose 与说明，与 `npm run collector:setup` 并列成第二条环境前置。

**Milvus 真正的价值**（十亿级、分布式、全局索引）在本项目**一条都用不上**——
所以它必须被当作**可失败的旁路**，而不是启动路径上的硬依赖（见 §5.5）。
它带来的真正麻烦不是部署，而是 **跨存储事务边界**（§5.3）。

---

## 3. 目标架构

```
┌─ 报告生成（已有）───────────────────────────────────────────┐
│ phases: brief → intel → playbook → budget → report          │
│            ↓                                                │
│  pipeline.renderReport()  → report_dsl / md / html  artifacts│
└────────────────┬────────────────────────────────────────────┘
                 │ ① 摘要抽取（新增，本仓纯函数，可单测）
                 ▼
        buildReportSummary(dsl, job)  →  结构化 Summary + 渲染文本
                 │ ② 来源校验（走已有 IngestSourceGuard，sourceId=report_summary）
                 ▼
        KnowledgeService.ingestDocument()  ── collection: KB-2（租户私有）
                 │ ③ 向量化（新 EmbeddingProvider，替换 hashEmbed）
                 ▼
        ┌────────┴─────────┐
        │  Phase1/2:       │  Phase3:
        │  SQLite BLOB     │  Milvus（Docker · 同一驱动接口）
        └──────────────────┘
                 │ ④ 检索（已有 kb_retrieve）
                 ▼
        未来报告：BM25 ⊕ 向量 → RRF → 重排 → topK（**派生语料须被隔离**，见 §5）
```

关键设计原则：**① 摘要抽取是纯函数，② ③ 走已有插座，④ 检索路径零改动**。
新增的外部依赖只有两个：一个本地 embedding HTTP 服务（P2），一组 Milvus 容器（P3），
两者都被 `vectorDriver` 开关隔离，且都必须是**可失败的旁路**。

> ③ 与 ④ 的存储边界要提前说清：**BM25 词项永远留在 SQLite**（`kb_terms`），
> Milvus 只接管**密向量**。RF 融合仍在应用层做（现有代码就是这个结构，不用改）。
> 这个切分决定了 §5.3 的一致性策略。

---

## 4. 逐层落地改法（文件级）

### 4.1 摘要抽取（新，纯函数，零风险）

**新增 `packages/knowledge/src/summarize.ts`**，导出一个无 I/O 的纯函数：

```ts
export interface ReportSummary {
  jobId: string; tenantId: string; title: string;
  brief: { brand?: string; industry?: string; category?: string; platforms?: string[] };
  sections: { title: string; gist: string }[];        // 机械抽取自 DSL slides 的标题 + 首个文本块
  keyNumbers: { label: string; value: string; ref: string }[]; // 只收**已挂 citation** 的行
  citedSources: string[];                              // 去重后的 sourceId 集合
  degradations: string[];                              // 取自 job.degraded，用于标注产出完整性
  modelInference: string[];                            // 若启用 LLM 总结，单独列在这里
}
export function buildReportSummary(dsl: ReportDsl, job: JobRecord): ReportSummary;
export function renderSummaryText(s: ReportSummary): string; // 供入库的纯文本
```

要点：

- **优先机械抽取，不用 LLM**。理由不是省钱，是**溯源**：机械抽取的每一句都能指回 DSL 里已带 citation 的块；
  LLM 总结会引入新的、无法溯源的表述。若确实要 LLM 总结（语义更连贯），
  其输出**必须**落在 `modelInference[]` 字段里、入库时按 `tier=low` / `model_inference` 处理。
- **`keyNumbers` 只收已挂 citation 的行**。这条与项目既有铁律一致（"报告中每一个数字都必须挂 citation"），
  且能防止摘要成为套壳洗白通道。
- `renderSummaryText()` 产出紧凑 Markdown，一屏内，天然落在 `chunkText()` 的单个块里。

### 4.2 落盘向量（新，最小改动，收益最大）

**新增迁移 `packages/storage/src/db.ts` `MIGRATIONS` 追加一项**（沿用既有 `{id, name, sql}` 模式）：

```sql
ALTER TABLE kb_chunks ADD COLUMN vec         BLOB;      -- Float32Array 的字节序列
ALTER TABLE kb_chunks ADD COLUMN embed_model TEXT;      -- 产出该向量的模型标识
ALTER TABLE kb_chunks ADD COLUMN embed_dim   INTEGER;   -- 冗余存维度，防跨模型对比
CREATE INDEX IF NOT EXISTS idx_chunks_embed_model ON kb_chunks(embed_model);
```

**为什么要落盘而不是继续现算**：现在是 256 维哈希，现算成本≈0；换成 270M 模型后，
一次 `retrieve()` 要对候选池里每一行做一次前向——哪怕有缓存，冷启动查询也会退化到秒级。
落盘 + 后台补算（backfill）把成本压到**写入一次**。

> 注意：向量以 `BLOB` 存 SQLite 完全够用（万级 chunk × 768 × 4B ≈ 30MB），
> 并且**保住了单事务语义**——`purgeChunks` / `writeChunks` 与向量写入天然原子，不需要双写协调。

### 4.3 Embedding Provider（新，接 EmbeddingGemma 2）

**新增 `packages/knowledge/src/embedding.ts`**：

```ts
export interface EmbeddingProvider {
  readonly model: string;           // 如 "embeddinggemma-2-text"
  readonly dim: number;              // 768（或 MRL 截断到 256 与历史对齐）
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}
```

三个实现：

| 实现 | 用途 |
| --- | --- |
| `HashEmbeddingProvider` | 包装现有 `hashEmbed()`，作为**默认与兜底**，保持现状行为可复现 |
| `HttpEmbeddingProvider` | 打 OpenAI 兼容 `/v1/embeddings`（`{model, input}` → `{data:[{embedding}]}`）。Ollama / llama.cpp server / TEI 都原生支持，**不自建 Python 服务** |
| `CachingEmbeddingProvider` | 装饰器，包住上面两者，落盘前的按块缓存 + 内存 LRU |

**接入方式二选一**：

- **推荐**：`llama.cpp` / Ollama 加载 EmbeddingGemma 2 量化权重，暴露 `/v1/embeddings`，
  `BM_EMBED_URL=http://127.0.0.1:11434/v1/embeddings`、`BM_EMBED_MODEL=embeddinggemma-2`。**零 Python 依赖**。
- 备选：`pip install sentence-transformers` + 自建服务，走 `services/collector-core/.venv` 同款 venv 模式。
  代价是 2–3GB 的 torch 体积，收益仅是"跟论文默认用法一致"，**不推荐**。

**⚠️ 形状别搞混**：现有重排调用是 **Jina/Cohere 形状**（`query` + `documents` → `results[].relevance_score`），
不是 OpenAI 形状。embedding 与 rerank **必须各自适配**，不要把 `callRerank()` 的结构照抄过来。

### 4.4 报告收尾挂钩（新，best-effort）

**改 `packages/orchestrator/src/pipeline.ts`**，在 `renderReport()` 成功之后、`finish()` 之前插入：

```ts
await this.summarizeAndIngest(jobId, ctx, upstream).catch((e) => {
  // 摘要回灌失败**绝不影响任务成败**：它是"锦上添花"，不是产出的一部分。
  this.deps.repos.jobs.addDegraded(jobId, { missing: [msg], reason: "unavailable", note: "报告摘要回灌失败（不影响报告本身）" });
});
```

四个必须守住的点：

1. **幂等**：`docId` 直接用 `stableDocId([tenantId, "report_summary", jobId, ""])`，
   rerun 同一 job 覆盖而非堆积（避免"同一份报告在检索里出现两次"，那是 `stableDocId` 注释里明确要防的）。
2. **不阻塞**：异步、best-effort、失败只记 degraded。
3. **来源闸门必过**：`sourceId="report_summary"` 必须在 `seed.ts` `BUILTIN_SOURCES` 登记并授权，
   否则 `ingestDocument()` 会 fail-closed 拒绝（这是**特性不是 bug**）。
4. **租户私有**：写 KB-2、`global` 不传（KB-2 写全局会被直接拒——防客户数据跨租户泄露）。

### 4.5 来源登记（小改）

`scripts/seed.ts` `BUILTIN_SOURCES` 加一条：

```ts
{ sourceId: "report_summary", name: "本系统生成的历史报告摘要", tier: "L2",
  authMethod: "系统内生成（非外部来源）", legalApproved: true },
```

`BUILTIN_GRANTS` 加对应授权。理由：它是 L2（历史执行类）而非 L3 公开情报；
`legalApproved: true` 是诚实的——数据由本系统生成，不涉及第三方授权，
但**必须显式写**（`resolveLegalApproved()` 对漏写字段默认拒绝）。

### 4.6 配置与环境变量（小改）

`packages/config/src/index.ts`：`vectorDriver` 扩展为 `"memory" | "qdrant" | "milvus"`；
新增 `embedDim`、`embedTimeoutMs`、`embedBatchSize`、`summaryIngest: boolean`；
以及 Milvus 一组（仅在 `vectorDriver === "milvus"` 时必填）：

```ts
milvus: {
  uri: string;            // BM_MILVUS_URI，默认 http://127.0.0.1:19530
  token: string;          // BM_MILVUS_TOKEN，dev 留空（Standalone 默认无鉴权）
  collection: string;     // BM_MILVUS_COLLECTION，默认 brandsale_kb
  timeoutMs: number;      // BM_MILVUS_TIMEOUT_MS，默认 3000（要短，见 §5.5）
}
```

`.env.example` 补：

```
BM_EMBED_DIM=768
BM_SUMMARY_INGEST=true
BM_MILVUS_URI=http://127.0.0.1:19530
BM_MILVUS_TOKEN=
BM_MILVUS_COLLECTION=brandsale_kb
BM_MILVUS_TIMEOUT_MS=3000
```

> `BM_MILVUS_TIMEOUT_MS` 默认给 **3s** 而不是 30s：Milvus 是旁路，
> 它挂了就该立刻退回纯 BM25，而不是把一次 `kb_retrieve` 拖到 20s 超时（工具 `timeoutMs` 就是 20s）。
> 这与重排的处理口径一致——**宁可降级，不要等待**。

### 4.7 测试（必做）

- **新增 `tests/report-summary.test.ts`**：纯函数可测——`keyNumbers` 只含带 citation 的项、
  空 DSL 不炸、幂等 `docId` 稳定、**跨租户不可见**（A 租户的报告摘要不得出现在 B 租户检索结果里）。
- 扩展 `tests/kb-ingest.test.ts`：`report_summary` 未登记时入库被拒（fail-closed 回归）。
- 扩展 `tests/schema-coverage.test.ts`：新迁移列必须在契约层有对应字段（该测试就是防"加列不加类型"的）。
- **新增 `tests/milvus-driver.test.ts`（P3）**：Milvus 不可达时 `retrieve()` 必须**降级为纯 BM25 且不抛错**；
  Milvus 命中但 SQLite 无对应 chunk 时该条被丢弃并记 degraded（§5.3 的孤儿向量用例）。
  这两个用例可以用**指向一个不存在的端口**来构造，**不需要跑真 Milvus**——CI 不必依赖 Docker。
- 现有 190 条基线须保持全绿。

### 4.8 Milvus Docker 部署与接线（P3）

**部署文件已就位**（P3 触发时直接用，不必再讨论基础设施）：

| 文件 | 内容 |
| --- | --- |
| `infra/milvus/docker-compose.yml` | 取自官方 `milvusdb/milvus:v3.0.2` 的 standalone 模板，**只改两处**：端口收敛到 `127.0.0.1`、去掉 MinIO 的宿主机映射 |
| `infra/milvus/README.md` | 前置条件、启停、排障、鉴权与暴露面、版本锁定、与网关的接线约束 |
| `.gitignore` | 已加 `infra/milvus/volumes/` |

`docker compose config` 已校验通过，端口渲染确认为 `host_ip: 127.0.0.1`。

**数据持久化**：官方模板用 bind mount（`./volumes/milvus|etcd|minio`），不是 named volume——
所以 `docker compose down -v` **删不掉数据**，必须手动 `rm -rf volumes/`。README 里写清了。

**启动**

```bash
cd infra/milvus && docker compose up -d
docker compose ps                      # 三个容器都应为 Up / healthy
curl http://127.0.0.1:9091/healthz     # 预期 OK（首次需 60~90 秒）
```

**网关侧的接线（Node，零 Python）**

用官方 Node SDK `@zilliz/milvus2-sdk-node`（本项目已有 npm workspace，加一个依赖即可）：

```ts
import { MilvusClient, DataType, MetricType } from "@zilliz/milvus2-sdk-node";

const client = new MilvusClient({ address: cfg.milvus.uri });  // 127.0.0.1:19530
await client.connectPromise;

// collection 与 kb_chunks 同构：向量 + 一份标量副本用于过滤
await client.createCollection({
  collection_name: cfg.milvus.collection,
  fields: [
    { name: "chunk_id",    data_type: DataType.VarChar, max_length: 128, is_primary_key: true },
    { name: "collection",  data_type: DataType.VarChar, max_length: 16 },   // KB-1..KB-4
    { name: "tenant_id",   data_type: DataType.VarChar, max_length: 64 },   // 空串 = 全局
    { name: "embed_model", data_type: DataType.VarChar, max_length: 64 },   // §5.4 模型混用守卫
    { name: "vector",      data_type: DataType.FloatVector, dim: cfg.milvus.dim },
  ],
  index_params: [{
    field_name: "vector", index_type: "HNSW",
    metric_type: MetricType.COSINE, params: { M: 16, efConstruction: 200 },
  }],
});
await client.loadCollectionSync({ collection_name: cfg.milvus.collection });
```

**四个必须注意的 SDL 细节：**

1. **检索前必须 `loadCollectionSync`**，否则 search 报 collection 未加载。
2. **搜刚写入的数据要 `consistency_level: 'Strong'`**（默认 Bounded 可能读不到）。
   但注意：生产检索**不要**长期用 Strong——它会强制等全部副本同步，牺牲延迟。
   建议：**写入后的校验读用 Strong，常规检索用 Bounded**。
3. **租户过滤必须下推到 Milvus 的 filter 表达式**，不能只靠 SQLite 回表兜底。
   否则「先按向量捞出全局 topK」这一步就已经把别的租户的向量算进相似度了——
   **即使最后回表被过滤掉，命中名额已经被挤占**，表现为"本租户的资料明明有，却检不出来"。
   filter 需与 `visibleScopeSql()` 的语义严格对齐（`tenant_id == 'x' or tenant_id == ''`）。
4. **不要把 `ping`/建表放在进程启动的必经路径**。Milvus 未启动时网关必须能正常起、正常出报告
   （降级为纯 BM25），这是 §5.5 的硬要求。建议懒连接 + 首次失败后进入冷却，与环境变量的
   `BM_VECTOR_DRIVER=memory` 一起构成两级开关。

---

## 5. 五个必须解决的工程问题

### 5.1 溯源回环（**最高优先级**）

摘要一旦可检索，后续报告就会引用它。若摘要是 LLM 生成的，就形成
「模型产物 → 存库 → 被当作事实引用 → 再生成模型产物」的闭环。
这条链一旦跑起来，本项目最贵的资产——**citation 制度**——会静默失效：
报告里每个数字仍"挂着引用"，但引用指向的是另一个模型的猜测。

**结构性隔离方案**（三选一，建议 1+2 同做）：

1. **默认不用 LLM 总结**（§4.1），摘要为 DSL 的机械投影，每句可回指原始 citation。
2. **引用呈现层区分**：`report_summary` 来源在报告引用里显式标注"派生自历史报告"，
   不允许它作为**数字类结论的唯一依据**。
3. 若坚持 LLM 总结，则其入口必须走 `tier=low` / `model_inference` 路径，
   且在 `render` 的 R3/R5 校验里被同等对待。

### 5.2 自引用回声（**最隐蔽**）

现有 `CrossSourceAgreement`（多源交叉一致度）会给"两个来源说同一件事"加分。
历史报告摘要与原始来源**说的是同一件事**——于是
「1 个真实来源 + 1 份它自己的摘要」会被算成 **2 个来源的交叉验证**，置信度虚高。

**处置**：`report_summary` 来源必须从 `crossSourceAgreement` 计算中排除。
这是个**没有任何报错**的错误，只能靠测试钉住——建议在 `tests/report-summary.test.ts` 里加一条断言。

### 5.3 双写一致性（Docker 化之后**升级为本项目的头号工程问题**）

> **注意**：选定 Docker 之后，这条从"次要顾虑"变成了 **P3 真正的门槛**。
> 部署形态的问题被 Docker 解掉了；**能不能安全地维护两个存储，才是 Milvus 值不值得上的决定性因素。**

BM25 词项在 `kb_terms`（SQLite），密向量在 Milvus——**两个进程、两个存储引擎，没有共享事务**。
`ingestDocument()` 的 `purgeChunks → writeChunks → 写 kb_docs` 是**单个 SQLite 事务**；
加入 Milvus 后，向量写入落在这个事务之外，无法回滚。至少四类不一致：

| 不一致 | 后果 | 可见性 |
| --- | --- | --- |
| 事务回滚，Milvus 留了孤儿向量 | 检索命中、回表为空 → **空白条目**（正是 `purgeChunks` 注释描述过的那类 bug） | 可见但难归因 |
| 事务成功，Milvus 写入失败 | 该 chunk **永久缺席语义通道**，只剩 BM25 | **静默**，无报错 |
| `deleteDocument()` 删了 SQLite，Milvus 没删 | 已删文档仍能被召回 | 严重（可能泄露已撤回内容） |
| 模型换代重嵌入中途失败 | 同一 `embed_model` 下新旧向量混杂 | 静默，分数无意义（见 §5.4） |

**处置策略（三层）：**

1. **单一真相源**：SQLite 是唯一真相源，**Milvus 永远只是可重建的索引**。
   任何时刻删掉 Milvus 数据卷、跑一次 `rebuildVectorIndex()`，系统必须完全恢复。
   这条是整套方案的安全底线——**它决定了 Milvus 挂了永远不致命**。
2. **写入顺序**：先提交 SQLite 事务，**后**写 Milvus；Milvus 失败只记 degraded（下一次 `rebuild` 会补上）。
   反过来（先 Milvus 后 SQLite）会产生无法自愈的孤儿，**不要**。
3. **读取防御**：检索侧对「Milvus 命中但 SQLite 无对应 `chunk_id`」的条目**直接丢弃 + 记 degraded**；
   对 `deleteDocument()` 额外做一次 Milvus 侧补偿删除（尽力而为，失败交给 rebuild 兜底）。

**降级开关**：`BM_VECTOR_DRIVER=memory` 必须始终可用，一键退回纯 SQLite 路径——
这是升级 Milvus 出问题时的**回滚手段**，也是 CI 跑测试的默认值。

### 5.4 模型混用（迁移期必然发生）

256 维哈希向量与 768 维模型向量**不在同一空间**，`cosine()` 会算出无意义的分数而不报错。
`embed_model` / `embed_dim` 列的用途就是此处：**只比较同 `embed_model` 的向量**，
跨模型一律视为"该行无语义向量"（退回纯 BM25），并对混合状态记 degraded。

### 5.5 降级链要接上（Docker 化后更容易被触发）

已有 `E-KB-002`「向量库不可用」（`packages/contracts/src/errors.ts`）。
新增的两个外部依赖都不可用了，必须落到同一条链上，**不要新造一套**：

| 失败点 | 表现 | 降级动作 |
| --- | --- | --- |
| embedding 服务不可用 | 查询文本无法向量化 | 该次检索降级为**纯 BM25** → 记 degraded → 30s 冷却（对齐重排的 `E-KB-001` 纪律） |
| Milvus 容器没起 / 挂了 | 连接失败或超时 | 同上；**且不得让 `kb_retrieve` 撞到 20s 的工具超时**（故 `BM_MILVUS_TIMEOUT_MS` 默认 3s） |

Docker 让这条链更**重要**而不是更不重要：容器是需要被 `docker compose up` 的东西，
开发机忘启、CI 没装 Docker、生产重启顺序不对，都会走到这里。
**判据**：Milvus 全组容器停掉，网关仍能正常启动、正常出报告（语义通道静默关闭 + 记 degraded）。
这条必须做成自动化用例——**用"指向不存在的端口"来构造，不需要真跑 Docker**。

---

## 6. 分期建议与验收

| 期 | 内容 | 新增外部依赖 | 验收 |
| --- | --- | --- | --- |
| **P1** | 摘要抽取 + 落盘向量列 + 检索读落盘 + `report_summary` 来源登记 + 测试 | **无** | 历史报告可被检索命中；跨租户不可见；自引用不计入交叉验证；190 基线全绿 |
| **P2** | `EmbeddingProvider` + 接 EmbeddingGemma 2（HTTP）+ 存量 backfill + 模型混用守卫 | 一个本地 HTTP embedding 服务 | 语义召回质量对比哈希基线有可量化提升；embedding 不可用时正确降级为纯 BM25 |
| **P3** | **Milvus Standalone（Docker Compose）** + `MilvusVectorStore` 实现 + `rebuildVectorIndex()` + 一致性用例 | **一组 Milvus 容器（3 个）+ Docker Desktop** | SQLite 为唯一真相源（删卷可重建）；Milvus 全停时系统正常；租户过滤下推到 filter；`BM_VECTOR_DRIVER=memory` 可一键回滚 |

**P3 的启动触发条件（建议写进 README，避免"技术选型先行"）**，满足任一才做：

- chunk 总量 > 10 万；或
- 单次 `retrieve()` 的 p95 延迟 > 500ms（纯 SQLite 路径）；或
- 出现必须跨租户/跨实例共享向量的需求；或
- 出现**多实例部署**需求（此时进程内嵌方案直接失效，Milvus 成为必需品）。

在此之前，**SQLite BLOB + 暴力余弦**在万级 chunk 下是毫秒级，Milvus 带来的是纯成本。

> **Docker 已定，但"现在不做"的结论不变。** 理由已经从"部署太麻烦"换成了
> "当前语料量下它换不来任何东西，却要承担 §5.3 的一致性成本"。
> 好消息是这个决定的成本被 Docker 大幅降低了：`infra/milvus/` 的 compose 与接线可以**先备好**，
> 等触发条件满足时只需实现驱动和 `rebuildVectorIndex()`，不必再讨论基础设施。

---

## 7. 实施前必须确认的开放问题

1. **HF 模型卡未直连成功**——参数量、维度、许可、prompt 前缀（EmbeddingGemma 系列对
   query/document 有不同任务前缀）需以模型卡为准复核。**任务前缀用错会显著掉点且不报错**。
2. **维度选 768 还是 256？** 768 是模型原生、质量最好；256 与现有 `VEC_DIM` 对齐、存储省 2/3。
   MRL 的意义就是这里可调——建议先用 768，压测后再决定是否截断。
   **注意**：这个决定同时决定 Milvus collection 的 `dim`，**dim 一旦建表就不能改**，
   换维度必须重建 collection（好在 §5.3 已规定 Milvus 可重建，代价可接受）。
3. **摘要是否允许 LLM 参与？** 这是产品决策，不是技术决策。考虑到本项目的溯源纪律，建议默认否。
4. **是否真要跨模态**（把报告里的 chart 图也向量化）？若是，EmbeddingGemma 2 的视觉塔才有价值；
   若否，文本塔足矣，且可以考虑更小的纯文本模型。
5. ~~Milvus 部署形态~~ → **已定：Docker（Standalone + Compose）**，见 §2.2 与 §4.8。
6. **Milvus 鉴权与网络暴露面（新增，Docker 化带来的）**：Standalone 默认**无鉴权**且监听 `0.0.0.0`。
   开发机无妨，但只要宿主机不是完全可信网络，就必须处理——两个动作：
   compose 里把端口映射收敛为 `127.0.0.1:19530:19530`（**不要** `0.0.0.0`），
   生产再加 `common.security.authorizationEnabled` + root 密码。
   **本项目装的是客户私域语料的向量**（KB-2 租户私有数据），
   裸奔的 Milvus 等于把客户数据的语义指纹挂在网上——这条不能省。
7. **Milvus 版本锁定**：Node SDK 与 Milvus 版本有兼容矩阵（如 Milvus v2.5.x ↔ SDK 2.5.x）。
   compose 里的镜像 tag **必须钉死到具体版本**，不要用 `latest`——
   否则某天 CI 拉到一个大版本，SDK 静默不兼容。

---

## 8. 明确不做的

- ❌ 不为了 Milvus 而重写 `KnowledgeService` 的检索链路——它已经是 BM25 ⊕ 向量 → RRF → 重排，**结构本身是对的**。
- ❌ 不把向量库当"必须项"塞进启动路径——它必须是**可失败的旁路**（Docker 让它更容易挂，这条只会更重要）。
- ❌ 不让 LLM 生成的摘要进入 citation 的合法来源集合（除非按 `model_inference` / `tier=low` 走）。
- ❌ 不引入 torch 全量依赖，除非确认 llama.cpp/Ollama 路线走不通。
- ❌ 不用 Milvus Lite / sidecar 方案——既然定了 Docker，就不要同时维护两套部署形态。
- ❌ 不在 `infra/milvus/` 里手写 compose——**从官方 `milvus-standalone-docker-compose.yml` 取**，
  只改端口绑定与版本 tag。
- ❌ 不提交 `infra/milvus/volumes/`（向量库数据目录）。
- ❌ 不在 P1 之前碰 Milvus——顺序反了会把"摘要回灌"这件简单事拖成基础设施项目。

---

## 9. 实测落地状态（2026-10-12）

**P3 的两块基础设施已实际跑通**，并把「嵌入 + 向量检索」封装成了一个可直接集成的类。
本节记录**实测与推演的差异**——这些差异比方案本身更值钱。

### 已就位

| 组件 | 位置 | 状态 |
| --- | --- | --- |
| Milvus Standalone（Docker） | `infra/milvus/` | 3 容器 healthy，`/healthz` OK，`19530` 可连 |
| EmbeddingGemma 2 服务 | `services/embedding-core/` | 两种形态：**Docker（推荐）** `npm run embedding:up`；原生（开发）`serve.py`。均输出 768 维 |
| 集成类（单文件、零依赖） | `packages/knowledge/src/semantic-memory.ts` | 走 Milvus REST，不引 gRPC SDK |
| 端到端验收 | `npm run semantic:smoke` | 9 项断言全绿（含租户隔离、幂等、降级） |

实测数据：写入 3 条（含嵌入）**86ms**，检索 **28ms**，建集合 **15ms**。

### 嵌入服务 Docker 化（2026-10-12 追加）

镜像 `brandsale/embedding-core:1.0.0`，`services/embedding-core/{Dockerfile,.dockerignore,docker-compose.yml}`。
发布 `127.0.0.1:8899`，`semanticMemoryFromEnv()` 的 `BM_EMBED_URL` 默认就指向它，**集成侧零改动**。

| 项 | 值 |
| --- | --- |
| 镜像体积 | 4.25GB（其中权重层 1.53GB、site-packages 1.3GB） |
| 容器内设备 | `cpu`（float32） |
| 健康就绪 | 约 5s（模型在 FastAPI lifespan 加载完后才 200） |
| 批量吞吐 | 32 条中文 553~659ms |
| 语义自检 | 与宿主 MPS **排序完全一致**（小红书美妆 0.8897 / 供应链 0.6099） |

**四条实测结论**（都区别于"想当然"）：

1. **容器内没有 MPS，但向量逐位一致**。Docker Desktop for Mac 不做 GPU 透传，必须在 CPU 上跑；
   实测容器 CPU 与宿主 MPS 的余弦相似度 **1.00000000**（最大绝对差 1.3e-7，纯 float32 舍入）。
   含义：**换设备不会让已建的向量索引失效**，CPU/MPS 可混用同一份 Milvus 索引。
2. **torch 必须走 CPU 专用索引**。Linux 上 PyPI 的 torch 默认是 CUDA 构建，
   会连带拖进 2GB+ 的 `nvidia-*` 运行时库，而容器没有 GPU。
   Dockerfile 用 `download.pytorch.org/whl/cpu` 只装 CPU 版，并钉死 `torch==2.14.1`（与宿主 venv 同版本）。
3. **`chown -R` 会在镜像里复制一整层**。先 `COPY` 再 `chown -R app:app /app` 时，
   Docker 层是快照——1.53GB 的权重层被整份复制，镜像从 4.25GB 涨到 6.62GB。
   改用 `COPY --chown=10001:10001` 后回落。（`docker images` 的 SIZE 还含多清单/attestation 的重复计数，
   看 `du` 更准：容器内 `/app` 1.5G + site-packages 1.3G。）
4. **端口冲突是切容器时的第一个坑**。宿主原生 `serve.py` 与容器都用 8899，
   切之前必须先 `pkill -f "embedding-core/serve.py"`，否则 `up` 因端口被占失败。


### 与方案推演不一致的三处（**重要**）

1. **RESTful API 在 19530，不是 9091**。这直接改变了集成方式：原来准备的
   `@zilliz/milvus2-sdk-node`（gRPC）**不再必要**，用全局 `fetch` 打 19530 的 REST
   就够，于是「一个类文件」得以真正零依赖。**这是本次最大的意外收益。**
2. **文本专用加载躲不掉多模态依赖**。`config_kwargs={"vision_config": None, "audio_config": None}`
   确实把参数降到 270M（省了内存），但**依赖装不全根本加载不起来**：
   需要 `pillow`（processor 构造依赖），还需要 `torchvision`
   （import 链 `EmbeddingGemma2Processor → gemma4/image_processing_gemma4 → torchvision`）。
   后者的报错会被 transformers 包装成 `Could not import module 'EmbeddingGemma2Processor'`，
   **根因被吞掉**，必须开 DEBUG 才看得到。方案里"只载文本塔所以不用装视觉栈"的隐含假设是错的。
3. **一致性级别不是理论问题**。实测 `delete` 返回成功后立刻 `query`，
   **被删的行仍然查得到**（默认 Bounded）。所以类里 `fresh: true` 的路径走 Strong。
   这不是"优化项"，是"不这么做就会写出错代码"。

### 仍未做的

- **P1（摘要机械抽取 + 落盘向量列 + `report_summary` 来源登记）尚未实施**。
  本次只把"外部依赖"这一层打通并封好，业务侧的挂钩（`pipeline.renderReport()` 之后回灌）还没接。
- §5.1 的**溯源回环**与 §5.2 的**自引用回声**两条隔离措施仍未落地——
  在把生成式摘要喂进这个库之前，这两条必须先做。

---

## 10. 接入实施记录（2026-10-12 晚）

本轮把上文的 P1 与 P2 **实际接进主线**，P3 的驱动接线也做了（但默认关闭）。§9「仍未做的」两条至此作废，保留在文中作为历史。

### 10.1 改动清单（文件级）

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 存储 | `packages/storage/src/db.ts` | 迁移 **M4 `kb-vectors`**：`kb_chunks` 加 `vec BLOB` / `embed_model` / `embed_dim` + 索引 |
| 契约 | `packages/contracts/src/kb.ts` | `IngestDocumentResult.embedded?`（本次写入向量的块数）；`ConfidenceInput.derived?`（派生语料标记） |
| 知识库 | `packages/knowledge/src/embedding.ts`（新） | `EmbeddingProvider` 接口 + `HashEmbeddingProvider`（默认/兜底，256 维）+ `HttpEmbeddingProvider`（768 维，OpenAI 兼容）+ `embeddingProviderFromConfig`；`tokenize/hashEmbed/cosine` 迁入此处；`vectorToBlob/blobToVector` |
| 知识库 | `packages/knowledge/src/summarize.ts`（新） | `buildReportSummary(dsl, job)`（纯函数）+ `renderSummaryText()` + `SUMMARY_SOURCE_ID` |
| 知识库 | `packages/knowledge/src/retrieval.ts` | 向量**写入时落盘**；检索改读落盘向量 + 混用守卫；`ingestGeneratedDocument()`（系统自产通道，白名单）；`semanticScore()`；外部索引融合 + 孤儿向量丢弃 |
| 知识库 | `packages/knowledge/src/vector-index.ts`（新） | `VectorIndex` 接口 + `MilvusVectorIndex`（包装已有 `SemanticMemory`）+ `createVectorIndex(config)` |
| 知识库 | `packages/knowledge/src/confidence.ts` | `derived=true` 时忽略 `crossSourceAgreement`（§5.2 落地执行点） |
| 治理 | `packages/governance/src/catalog.ts` | `report_summary` 进 `KB_DISPLAY` / `KB_GRADE` |
| 编排 | `packages/orchestrator/src/pipeline.ts` | `OrchestratorDeps.onReportReady?`（注入式钩子，避免越界依赖 knowledge）；`renderReport()` 返回是否成功；`runReportHook()` 吞异常只记 degraded |
| 装配 | `apps/gateway/src/container.ts` | 注入 `onReportReady` → 摘要写 KB-2；两条启动告警（Milvus 缺嵌入服务 / 未配嵌入服务） |
| 配置 | `packages/config/src/index.ts` | `retrieval` 加 `embedDim/embedBatchSize/embedTimeoutMs/milvus*`；`vectorDriver: "memory" \| "milvus"`（原 `"qdrant"` 是命名错误）；新增 `knowledge.summaryIngest` |
| 脚本 | `scripts/embedding-backfill.ts`（新） | `npm run embedding:backfill` 存量向量补算 / 换模型重算 |
| 脚本 | `scripts/vector-rebuild.ts`（新） | `npm run vector:rebuild [--reset]` 从 SQLite 重建 Milvus 索引 |
| 测试 | `tests/report-summary.test.ts`（新，14 例） | 摘要抽取 / 幂等 / 跨租户 / 向量落盘 / 混用守卫 / 降级 / 孤儿向量 / 派生置信度 / E2E 回灌 |

### 10.2 四个"设计上必须这样"的决定

1. **摘要走独立通道，不复用上传通道**。`report_summary` 不是外部来源，台账里没有它的
   `contractRef`（那是给外部采集/采购用的字段）；它与 `internal_review` / `methodology`
   一样"不在 sources 表里"。但它也**不是后门**：`ingestGeneratedDocument()` 只认
   `INTERNAL_INGEST_SOURCES` 白名单，传别的 sourceId 直接 `E-INGEST-003`。
2. **向量先算后写**。`node:sqlite` 的事务体必须同步，所以嵌入在事务**之前**完成。
   算不出来（服务没起）就存 NULL —— 这批块仍入库、仍可被 BM25 检索，
   `IngestDocumentResult.embedded` 会如实报 0，而不是假装成功。
3. **编排层不认识 knowledge**。回灌钩子由装配层注入（`onReportReady`），
   因为依赖矩阵是 `apps → orchestrator → agent-pack → knowledge`，
   `npm run check:boundaries` 会当场拦下越界 import。
4. **Milvus 默认关闭，且是可失败的旁路**。`createVectorIndex()` 在
   `vectorDriver !== "milvus"` 或没配 `BM_EMBED_URL` 时返回 `null`；
   检索时索引不可用只记 degraded（退回 SQLite 语义 + BM25），
   索引命中但 SQLite 无该 chunk 的**孤儿向量直接丢弃**并提示跑 `vector:rebuild`。

### 10.3 怎么验证

```bash
npm test                 # 206 例全绿（新增 14 例覆盖上述每条不变量）
npm run typecheck
npm run check:boundaries

# 端到端（mock 模式，不需要任何外部服务）：
#   E2E 报告产出后摘要回灌 KB-2：可检索、带向量、且不影响任务状态

# 真机联通（需 Milvus + 嵌入服务已起）：
npm run semantic:smoke   # 9 项断言：健康/建集合/写入/检索/租户隔离/幂等/删除/降级
npm run vector:demo      # 直观演示：打印真实向量 + 写入 + 回查 Milvus + 近义查询命中
```

`vector:demo` 与 `semantic:smoke` 的分工：前者是**证据演示**（看数字：768 维、
L2 范数、分数排序、相关 vs 无关的差值），后者是**断言清单**（看红绿）。
demo 用「字面几乎不重合的近义查询」验证是语义匹配而非字符串命中，
并且判据用 top-2 而非 top-1 —— 近义查询同时命中多条语义相近的文档是正确行为，
用单条期望反而会误判（第一版用例就是这么错判的）。

要真正启用真语义检索：

```bash
npm run embedding:up                    # EmbeddingGemma 2（127.0.0.1:8899）
export BM_EMBED_URL=http://127.0.0.1:8899/v1/embeddings
export BM_EMBED_MODEL=embeddinggemma-2
export BM_EMBED_DIM=768
npm run embedding:backfill              # 给存量语料补算 768 维向量

# 可选：语料量/多实例触发条件满足后再上 Milvus
npm run milvus:up && npm run vector:rebuild
export BM_VECTOR_DRIVER=milvus
```

### 10.4 仍未做的

- `crossSourceAgreement` **至今没有生产者**（全仓只有 `ConfidencePolicy` 一个消费点）。
  §5.2 的隔离已落在消费点（`derived=true` 时忽略加分）并有用例钉住，
  但"多源交叉一致度"本身何时计算、由谁计算，仍是未决策的产品问题。
- P3 的验收项里，「删掉 Milvus 数据卷 → `vector:rebuild` 完全恢复」这条只做了机制
  （脚本 + 幂等 upsert），**没有跑过真 Milvus 的完整演练**；
  §2.2 已确认容器与 REST 路径可用（`npm run semantic:smoke` 9 项全绿）。

---

## 11. 本机启用记录（2026-10-12 晚，业主"帮我配置切换、打开"）

P2 的真嵌入与 P3 的 Milvus 在**本机正式打开**，并做了走主流程（网关 HTTP）的端到端验证。

### 11.1 `.env` 切换

原值 → 新值（备份在 `.env.bak.20261012-165953`，可回滚）：

| 键 | 原 | 新 |
| --- | --- | --- |
| `BM_VECTOR_DRIVER` | `memory` | `milvus` |
| `BM_EMBED_URL` | （空） | `http://127.0.0.1:8899/v1/embeddings` |
| `BM_EMBED_MODEL` | （空） | `embeddinggemma-2` |
| `BM_EMBED_DIM` | 未设（默认 768） | `768`（显式） |
| `BM_MILVUS_URI` | 未设（默认同值） | `http://127.0.0.1:19530` |
| `BM_MILVUS_COLLECTION` | 未设（默认同值） | `brandsale_kb` |
| `BM_MILVUS_TIMEOUT_MS` | 未设（默认 3000） | `3000` |

切换后 `providerKind` 由 `hash` 变为 `http`，维度由 256 → 768。存量非 demo 语料为 0，
故 `embedding:backfill` 无需补算；`vector:rebuild --reset` 建好 `brandsale_kb`（768 维，HNSW/COSINE）。

### 11.2 端到端验证（全部经网关 HTTP，非脚本直连）

- 写入：`POST /api/v1/kb/documents` 4 条 → 201，`embedded=1`/条；
  SQLite 落盘 `embed_model=embeddinggemma-2`、`embed_dim=768`、`vec` 3072 字节（768×4）。
- **Milvus 同步**：best-effort fan-out 生效，`brandsale_kb` 记录数 = 4。
- 检索：
  - `POST /api/v1/kb/retrieve`（SQLite 语义 ⊕ BM25 ⊕ Milvus 融合）三个近义查询 top-1 全部正确；
  - 直连 Milvus 单查同三个查询，COSINE 分数 0.70 / 0.78 / 0.74，排序一致。
- 清理：`DELETE /api/v1/kb/documents/:id` 4 条 → 各 `removedChunks=1`；
  Milvus 与 SQLite 的非空 `vec` 行数均回到 0（残留 1 条是 seed 的 `provenance=demo` 语料，检索侧本就被过滤）。

### 11.3 顺带修掉的两个问题

1. **`vector:rebuild` 在空库下不建集合**：upsert 循环一次都不执行 → 集合永不创建，
   首次部署（或全 demo 语料）时检索侧会以为"Milvus 里没数据"。改为显式 `ensureCollection()`，
   并让 `--reset` 的 drop 容忍"集合不存在"。
2. **测试隐式继承开发机 `.env`**：`BM_EMBED_URL` 一旦配好，`npm test` 里的
   `hash-256` 落盘断言与"外部请求只发 1 次/0 次"的计数断言会随环境红。
   按 `overrides > process.env > .env` 的优先级，在 `npm test` 的隔离层钉住
   `BM_VECTOR_DRIVER=memory BM_EMBED_URL= BM_EMBED_MODEL=`，并让 `report-summary.test.ts`
   的 `svcOf()` 显式声明其测量场景（本地哈希）。**测试必须与环境无关**。

验证：`npm test` 206/206、`npm run typecheck`、`npm run check:boundaries` 全过。

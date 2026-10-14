# brandsale 技术架构

> **本文描述当前代码库的真实实现，不是设计意图的复述。** 每条结论都能在源码里找到对应位置；
> 遇到"实现与文档/注释不一致"的地方，本文按**实现**写，并把不一致单独记在 §14。
>
> 核对基线：2026-10-13 工作区（`npm test` 210 用例全绿、`npm run check:boundaries` 通过）。
> 2026-10-14 局部更新：采集浏览器会话改为 `reuse` 常驻复用（§8.5）、删除死配置
> `BM_PARSER_FALLBACK`、补上从未被调用的 `crawler.close()`；用例数 **218**（见 §14）。

## 0. 阅读指引

**本文覆盖**：分层与依赖约束、运行时拓扑、任务生命周期、六个 Agent 与工具治理、
数据源与治理闸门、采集链路、报告 DSL 与溯源、检索与向量、渲染、接入层与控制台、
配置体系、质量保障、关键设计取舍与已知边界。

**本文不覆盖**（各有专文，本文只在相关处引用）：

| 文档 | 主题 | 什么时候看 |
|---|---|---|
| `README.md` | 上手导读：快速开始、常用命令、API 速查 | 第一次跑起来 |
| [`data-provenance-design.md`](./data-provenance-design.md) | 报告条目级溯源的设计与取舍 | 改证据链 / 引用校验 |
| [`platform-capability-integration-plan.md`](./platform-capability-integration-plan.md) | 七平台能力矩阵（真机核对）与 Agent 集成 | 改平台工具 / 判断某指标能不能跨平台比 |
| [`datasource-integration.md`](./datasource-integration.md) | 外部数据源接入现状与运行手册 | 接入新数据源、扫码登录、开闸门 |
| [`datasource-platform-collection-analysis.md`](./datasource-platform-collection-analysis.md) | MediaCrawler 接入评估与裁剪清单 | 改采集内核 |
| [`frontend-console.md`](./frontend-console.md) | 前端工程化与取舍 | 改控制台 |
| [`report-depth-optimization-plan.md`](./report-depth-optimization-plan.md) | 报告深度下限的门槛与改法 | 改报告质量要求 |
| [`report-summary-vectordb-integration-plan.md`](./report-summary-vectordb-integration-plan.md) | 报告摘要回灌向量库 | 改检索/回灌 |
| [`requirements-coverage-analysis.md`](./requirements-coverage-analysis.md) | 需求逐条覆盖度 | 对甲方口径 |

**怎么用**：查"某个行为为什么是这样"→ 先看 §13 设计取舍；查"某段代码在哪"→ 看附录 A 模块-文件对照表。

---

## 1. 系统概览

### 1.1 业务链路

输入一句自然语言需求（或一张结构化表单），产出一份**每个数字都能追溯到来源**的营销策略报告：

```
用户 Brief（品牌 / 类目 / 预算 / 时间窗 / 平台 / 目标权重）
   │
   ├─① intake    任务录入：结构化 + 校验授权范围，指出需澄清项
   ├─② intel     竞品情报：竞品格局、类目趋势、人群洞察 + 品牌自诊基线
   ├─③ creator   人选：达人候选（平台公开采集 / 本地报价库）
   ├─④ playbook  打法：内容日历、渠道策略
   ├─⑤ budget    预算：渠道 × 阶段分配 + 三档情景模拟
   └─⑥ report    报告：Report DSL → 校验 → HTML / Markdown
```

六个阶段**串行**、前一阶段的产物是后一阶段的输入（§4.1）。任一阶段「失败」不会中断整条链路，
而是走三级降级（§4.3），缺失项显式进入报告的「排除项」——**绝不静默编造**。

### 1.2 一句话架构

> 一个**分层单向依赖**的 TypeScript monorepo（10 个 package + 3 个应用），
> 用**治理闸门**把住所有数据访问，用**契约层**统一类型与校验，
> 用**报告 DSL + 校验器**把住"不许有无来源的数字"，外部只暴露一个 HTTP+SSE 网关。

### 1.3 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 运行时 | Node.js ≥ 22.19 | 依赖 `node:sqlite`、原生 test runner、`fetch` |
| 语言 | TypeScript 5.9（`tsc --noEmit` 严格模式） | 无构建步骤，直接 `tsx` 跑 TS |
| 包管理 | npm workspaces | `packages/*` + `apps/*` |
| 持久化 | SQLite（`node:sqlite`） | **唯一真相源**；见 §6 |
| 模型接入 | 自建 vLLM 端点（OpenAI 兼容）+ Pi 框架 | `@earendil-works/pi-agent-core` / `pi-ai` / `pi-durable` |
| 前端 | React 18.3 + Ant Design 5 + Vite 5 | 产物由网关托管，无独立前端服务 |
| 向量检索 | SQLite 暴力余弦（默认）/ Milvus REST（可选） | Milvus 是**可重建的旁路索引** |
| 嵌入模型 | EmbeddingGemma 2（Docker 服务，CPU） | 留空则退化为字符哈希占位 |
| 平台采集 | 内嵌 MediaCrawler 内核（Python + Playwright） | 非商用许可，三道门（§8.4） |
| 容器 | Docker Compose | 仅用于 Milvus 与嵌入服务两个可选组件 |

### 1.4 代码规模（2026-10-13）

| 模块 | 文件 | 行数 | 职责 |
|---|---:|---:|---|
| `packages/agent-pack` | 9 | 7224 | 智能体集群 + 工具实现 + 降级合成 |
| `packages/knowledge` | 9 | 2686 | 检索、报价库、嵌入、语义记忆 |
| `packages/contracts` | 12 | 2681 | 全系统契约（零依赖叶子） |
| `packages/storage` | 4 | 1234 | SQLite 迁移与仓储 |
| `packages/model-gateway` | 6 | 893 | 并发/重试/成本/熔断 + Pi 接入 |
| `packages/config` | 1 | 681 | 环境变量装配与不变量断言 |
| `packages/render` | 1 | 671 | DSL → Markdown / HTML |
| `packages/orchestrator` | 3 | 660 | 编排、检查点、事件总线 |
| `packages/governance` | 5 | 590 | 闸门、台账、来源守卫 |
| `packages/datasource` | 3 | 560 | 数据源适配器 |
| `apps/web` | 24 | 3628 | React 控制台 |
| `apps/collector` | 7 | 1804 | 采集归一化 sidecar |
| `apps/gateway` | 5 | 902 | HTTP + SSE 接入层 |
| **合计（TS）** | **89** | **≈24 200** | 另有采集内核 Python（内嵌 MediaCrawler） |

测试：**17 个文件 / 218 个用例**，全部离线可跑（§12）。

---

## 2. 运行时视图

### 2.1 进程与端口

```
┌─────────────────────────────────────────────────────────────────────┐
│ 浏览器                                                              │
│   http://127.0.0.1:8787/        ← React 控制台（静态产物，网关托管） │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP / SSE
┌────────────────────────────▼────────────────────────────────────────┐
│ apps/gateway            127.0.0.1:8787      ★ 对外唯一入口          │
│   · 鉴权 / 幂等 / 协议转换 / SSE / 静态托管                          │
│   · 进程内直接持有 orchestrator（无独立编排服务）                    │
└──┬───────────────────────────────┬──────────────────────────────────┘
   │ 直接函数调用                   │ SQLite 文件（唯一真相源）
   │                               ▼
   │                    .data/brandsale.sqlite（+ WAL / SHM）
   │
   │ 子进程 spawn（仅采集时）
   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ services/collector-core         （Python + Playwright，无端口）      │
│   由 apps/collector 以子进程方式驱动：起浏览器 → 扫码 → 采集 → jsonl │
└────────────────────────────┬────────────────────────────────────────┘
                             ▲ spawn
┌────────────────────────────┴────────────────────────────────────────┐
│ apps/collector          127.0.0.1:8890      采集归一化 sidecar      │
│   · 驱动 Python 内核 / 归一化 jsonl / 本地缓存 / 只暴露 4 个只读算子 │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP（按查询同步调用）
┌────────────────────────────┴────────────────────────────────────────┐
│ packages/datasource → 七个平台工具 → platform_digest（模型侧入口）   │
└─────────────────────────────────────────────────────────────────────┘

可选的旁路组件（缺席只导致降级，不阻塞）：
  Docker: embedding-core  127.0.0.1:8899   EmbeddingGemma 2 嵌入服务
  Docker: Milvus          127.0.0.1:19530  向量索引（+ etcd + MinIO）
```

要点：

- **只有 brandsale 一个系统**：编排、智能体、渲染、控制台全在网关进程内，没有第二个业务进程/端口。
- **采集是唯一的外置进程**，且只在用到平台数据时才有意义；它慢（分钟级、含扫码登录），
  与"工具层要同步按查询返回"的矛盾靠 §8.3 的 sidecar + 预采集化解。
- **SQLite 是唯一真相源**。Milvus 里的向量是**可重建的索引**，不是数据源（§9.3）。

### 2.2 部署形态与初始化

```bash
npm install                 # 一次性
npm test                    # 全离线自检（218 用例）
npm run migrate             # 建表（dev 模式空库会自动灌种子）
npm run seed                # 登记内置数据源与演示租户
npm run web:build           # 构建前端控制台 → apps/web/dist
npm start                   # 启动网关（8787）
npm run collector:setup     # 仅当要用平台采集：建 Python venv + 装依赖 + 下载浏览器
npm run collector           # 仅当要用平台采集：启动 sidecar（8890）
npm run stack:up            # 仅当要用语义检索：起 Milvus + 嵌入服务
```

**渐进式可用**：不装 Python 就没有平台数据；不起 Docker 就没有语义检索（退化为 BM25 + 关键词）；
不配 `BM_LLM_BASE_URL` 就用 `BM_LLM_MODE=mock` 的确定性桩。每一级缺席都**显式降级**而不是报错。

### 2.3 数据落盘位置

| 路径 | 内容 | 是否入库（git） |
|---|---|---|
| `.data/brandsale.sqlite` | 任务、事件、产物、台账、审计、KB、向量 —— **唯一真相源** | 否 |
| `.data-collector/` | 采集归一化缓存 + `logs/<taskId>.log` | 否 |
| `services/collector-core/data/` | 内核原始 jsonl（按平台 + 按天） | 否 |
| `infra/milvus/volumes/` | Milvus 数据卷（含客户语料语义指纹） | 否 |
| `out/` | 导出的报告产物（HTML / MD / DSL） | 否 |
| `.workbuddy/` | 项目内助手工作记忆 | 否 |

`.gitignore` 的完整约定见仓库根文件；`.env` 从不入库（只提交 `.env.example`）。

---

## 3. 分层架构

### 3.1 分层与依赖矩阵

分层不是"命名约定"，而是由 `scripts/check-boundaries.ts` 里的 `MATRIX` **硬编码白名单** +
CI 卡住的（§3.2）。包只允许 `import` 白名单里的包，多一个就构建失败。

```
L0 契约层（零依赖叶子）
   @brandsale/contracts        纯类型 + 常量 + 纯函数校验（报告 DSL / 任务 / 事件 / 错误码 / KB）
   @brandsale/config           环境变量装配 + 不变量断言 + 平台元数据常量

L1 基础设施（只依赖 L0）
   @brandsale/storage          SQLite 迁移与仓储
   @brandsale/render           DSL → Markdown / HTML（含校验与自动修复）
   @brandsale/model-gateway    模型并发/重试/成本/熔断 + Pi 框架接入
   @brandsale/knowledge        检索（BM25 + 向量 + 重排）、报价库、嵌入、语义记忆
   @brandsale/datasource       数据源适配器（联网检索 / 七平台采集）

L2 领域能力（可依赖 L1，不得依赖编排层）
   @brandsale/governance       闸门（M3）+ 血缘台账（M5）+ 来源守卫
   @brandsale/agent-pack       六个智能体 + 工具注册与治理 + 降级合成

L3 编排层（唯一同时看见 agent-pack 与 render 的层）
   @brandsale/orchestrator     任务状态机、检查点、重跑、事件总线

应用层（允许依赖任意包）
   apps/gateway                HTTP + SSE 接入（唯一入口）+ 静态托管
   apps/web                    控制台前端（**只依赖 @brandsale/contracts**）
   apps/collector              采集归一化 sidecar（独立进程）
```

### 3.2 边界检查机制

`npm run check:boundaries` 扫描 `packages/*/src` 与 `apps/*/src` 里所有 `@brandsale/*` 导入，
检查四件事：

1. **白名单**：每个包只能依赖 `MATRIX` 里列出的包；
2. **叶子约束**：`contracts` / `config` 不得依赖任何业务包；
3. **反向依赖**：L1/L2 不得依赖 `orchestrator` / `agent-pack`；
4. **环检测**：实际依赖图不得有环（DFS 三色标记）。

为什么值得单独一个脚本（脚本文件头写得很直白）：分层架构最大的风险不是"写错"，
而是"慢慢写歪"——某天有人在 `render` 里直接 `import storage` 查一条数据，代码照样能跑，
但渲染层从此不再是纯函数。**这类退化不会报错，只会累积。**

> 前端那条约束（`apps/web` 只依赖 `contracts`）由**编译期**保证：一旦 import 了
> `agent-pack`，`pi-agent-core` 会被打进浏览器包；import 了 `config`，`node:fs` 会炸。
> 因此前端能用到的契约常量（`PHASE_LABEL`、`KB_COLLECTIONS`、`POPULAR_PLATFORMS`、各类记录类型）
> 都放在 `packages/contracts` —— 后端加阶段或加库位时，前端**要么编译报错、要么自动跟上**。

### 3.3 LLD 模块编号映射

代码注释里大量出现 `M1`–`M16`，来自《详细技术设计说明书》（LLD）。对照表：

| 编号 | 模块 | 落在哪个包 |
|---|---|---|
| M1 | Gateway 接入网关 | `apps/gateway` |
| M2 | Orchestrator（编排 + 检查点） | `packages/orchestrator` |
| M3 | GovernanceGate 治理闸门 | `packages/governance/gate.ts` |
| M4 | DataSourceAdapter 数据源适配 | `packages/datasource` |
| M5 | LineageLedger 血缘台账 | `packages/governance/ledger.ts` |
| M6 | 文档解析（Parser） | `packages/knowledge/parser.ts` |
| M7 | KnowledgeService（检索） | `packages/knowledge/retrieval.ts` |
| M8 | PricingStore（达人报价库） | `packages/knowledge/pricing.ts` |
| M9 | AgentPack（智能体集群） | `packages/agent-pack` |
| M10 | ToolRegistry（工具治理） | `packages/agent-pack/tools.ts` |
| M11 | RenderService（渲染） | `packages/render` |
| M12 | 任务运行时约束（时限/并发预算） | `packages/config`（`BM_MAX_JOB_MINUTES` 等） |
| M13 | 观测（trace / OTel / Langfuse） | `packages/config`（`BM_TRACE_*`） |
| M14 | ModelGateway（模型网关） | `packages/model-gateway` |
| M15 | Storage（持久化） | `packages/storage` |
| M16 | —— | **不存在**，见 §14 不一致清单 |

### 3.4 各层职责速查

| 包 | 对外提供什么 | 谁在用 | 详细章节 |
|---|---|---|---|
| `contracts` | 类型、常量、错误码、报告校验与自动修复、深度策略 | 所有层 + 前端 | §5 |
| `config` | `loadConfig()` 单一配置对象、平台能力元数据 | 所有层 | §11 |
| `storage` | 迁移、Repositories（所有 SQL 集中于此） | 除前端外所有层 | §6 |
| `orchestrator` | `startJob` / `rerunPhase` / `recover` / 事件订阅 | gateway | §4 |
| `agent-pack` | 六阶段执行器、工具注册表、证据表 | orchestrator | §7 |
| `governance` | `gate.authorize()`、台账记录、来源目录 | agent-pack | §8.2 |
| `datasource` | 适配器（返回标准 `Provenance`） | agent-pack | §8 |
| `knowledge` | 检索、报价查询、摘要抽取、嵌入、语义记忆 | agent-pack | §9 |
| `model-gateway` | `complete` / `completeJson` / `stream` | agent-pack | §10 |
| `render` | `RenderService.compile()` | orchestrator | §5.4 |
| `gateway` | HTTP API + SSE + 静态托管 | 浏览器 | §10（接入层） |

---

## 4. 核心链路：任务生命周期

实现集中在 `packages/orchestrator/src/pipeline.ts`（553 行，`Orchestrator` 类）。

### 4.1 六阶段流水线

```
POST /api/v1/jobs
  → 幂等检查 → 建 job（status=queued）→ 为六个阶段各写一行 job_phases(pending)
  → 后台 void runJob(...)（立即返回 jobId，不阻塞 HTTP）
        ↓ 串行 for (i = startIndex; i < 6; i++)
     ┌──────────────────────────────────────────────────────────────┐
     │ 读检查点：已完成（succeeded/partial）→ 复用 output，跳过重跑  │
     │ 否则：markStarted(attempt+1) → publish phase.start           │
     │       → agentPack.runPhase(phase, {job, ctx, upstream, emit, signal})
     │       ← { status, output, strategy, usage, cost, toolCalls, degradedKeys }
     │ markFinished(检查点) → 写 artifact → publish artifact.ready   │
     │ 上游产物累积进 upstream[]，注入下一阶段的提示词              │
     └──────────────────────────────────────────────────────────────┘
        ↓ 六阶段跑完
  renderReport(...)  ← 把 report_dsl 编译成 HTML / Markdown
        ↓ 渲染成功才调
  onReportReady(...) ← 报告摘要回灌 KB-2（best-effort）
        ↓
  终态：degraded 非空 或 有阶段 partial/failed → partial；否则 succeeded
```

| 阶段 | Agent | 产物 `ArtifactKind` | 阶段耗时估算 | 进度权重 |
|---|---|---|---:|---:|
| intake | AO | `brief` | 4s | 1/6 |
| intel | CI | `intel`（+ `intel_evidence`） | 45s | 2/6 |
| creator | CT | `creator_candidates` | 40s | 3/6 |
| playbook | PL | `playbook` | 35s | 4/6 |
| budget | BR | `budget` | 35s | 5/6 |
| report | RG | `report_dsl` → `report_markdown` → `report_html` | 60s | 6/6 |

`PHASE_ESTIMATE_MS` 只用于给前端一个"这阶段大概多久"的预期（`phase.start.estimatedMs`），
不做超时控制 —— 超时在 `agents.ts` 的 `PHASE_TIMEOUT_MS`（§7.1）。

**同一个 job 不会并发跑**：`runJob` 开头检查 `this.running.has(jobId)` 并直接返回（`running` 是 Set）。

### 4.2 状态机与终态判定

```
job:   queued → running → succeeded | partial | failed | cancelled
phase: pending → running → succeeded | partial | failed | skipped
```

- **`partial` 是"有产出但缺东西"**：`job.degraded` 非空，或任一季度是 `partial`/`failed`（§4.1 末段）；
- **`failed` 只在 `BM_ALLOW_PARTIAL=false` 时出现**：某阶段失败且不允许部分成功 → 立即终止整条链；
  默认 `true`，即"永远尽量出报告"；
- `cancelled` 由 `cancelJob` 置入，并往 `job.degraded` 记一条 `reason: "unavailable"`。

### 4.3 检查点与断点续跑

**每个阶段结束都写检查点**（`job_phases.output_json`），三件事因此成立：

1. **重跑不从头**：`runJob(jobId, ctx, startIndex)` 先把 `[0, startIndex)` 里已完成的阶段产物读回 `upstream`；
2. **阶段级复用**：循环内遇到已 `succeeded`/`partial` 的阶段直接复用，只发一条
   `phase.complete`（摘要写明"复用已完成的检查点，未重跑"）——所以**恢复是幂等的**；
3. **重跑任意阶段**（`rerunPhase`，API `POST /jobs/:id/rerun/:phase`）：

```
idx = PHASE_ORDER.indexOf(phase)
downstream = PHASE_ORDER.slice(idx)          ← 该阶段 + 其下游
jobs.clearDegraded(jobId)                    ← ⚠️ 必须清：否则"已修掉的降级"会跟着重跑复活
phases.resetForRerun(jobId, downstream)      ← 重置为 pending、attempts 归零
DELETE FROM artifacts WHERE kind IN (下游阶段产物, report_dsl, report_markdown, report_html)
   ↑ 清理下游产物，避免新旧混杂（尤其报告：旧 HTML 必须删掉，否则会展示过期内容）
→ runJob(..., idx)
```

### 4.4 幂等

`Idempotency-Key` 请求头 → `idempotency` 表（主键 `(tenant_id, key)`）。

```
同 key + 同指纹 → { jobId, reused: true }   （直接复用，不新建任务）
同 key + 异指纹 → 抛 E-JOB-002「该请求标识已被用于另一份不同的参数」
```

指纹 = 请求体**逐层按键名排序**后序列化，再取 FNV-1a 哈希。
⚠️ **不能用** `JSON.stringify(v, Object.keys(v).sort())` —— 那个 replacer **数组对所有层级都生效**，
只保留顶层出现过的键名，于是 `{brief:{a:1}}` 与 `{brief:{a:2}}` 会被同时压成 `{"brief":{}}`，
**指纹恒等、冲突永远发现不了**（`pipeline.ts:75-100` 有完整说明）。

### 4.5 崩溃恢复

`POST /api/v1/recover`（网关启动时也可自动调用）：

```
for (job of jobs.findUnfinished())        # status ∈ {queued, running}
    next = 第一个 status ∉ {succeeded, partial, skipped} 的阶段
    if (!next)  → 所有阶段都完成了，只是没写终态：直接补 succeeded，**不重跑**（计入 skipped）
    else        → runJob(..., indexOf(next.phase))         （计入 resumed）
```

因为检查点在，重启后的恢复**不会重复烧钱**：已完成的阶段直接复用。

### 4.6 事件与流式回放（SSE）

协议定义在 `packages/contracts/src/events.ts`，13 种事件：

| 事件 | 何时发 |
|---|---|
| `job.status` | 状态/进度变化（**每次都必须同时落库**，见下） |
| `phase.start` / `phase.progress` / `phase.complete` | 阶段生命周期 |
| `agent.delta` | 模型流式增量（正文/思考/工具调用） |
| `artifact.ready` | 产物落库 |
| `governance.block` | 闸门拦截（**不得静默**，前端必须红色提示） |
| `data.degraded` | 数据降级（缺失项 + 原因） |
| `cost.update` | 单阶段费用与 token |
| `job.error` / `job.done` | 任务级错误 / 完成 |
| `heartbeat` | 15s 心跳（`HEARTBEAT_INTERVAL_MS`） |
| `view.snapshot` | 缓冲过期时的视图快照兜底 |

三条容易踩的设计点：

1. **`seq` 单调递增，直接用 SSE 的 `id:`** → 断线重连带 `Last-Event-ID` 只补缺口；
   无 ID 则全量回放。
2. **缓冲按类型分桶**：状态类 2000 条（`EVENT_BUFFER_SIZE`），`agent.delta` 单独一档 600 条
   （`DELTA_BUFFER_SIZE`）。**不能混在一个窗口里按 seq 裁剪** —— 一次真实任务有 1.6 万条 `agent.delta`，
   delta 洪水会把状态事件整段挤出回放窗口，表现为"刷新页面后事件日志空白、进度掉回起点"，且**刷得越晚越严重**。
3. **全量回放不回放 `agent.delta`**：刷页面要靠它重建进度与日志，而不是回放几十万字符的正文碎片；
   缓冲 TTL 30 分钟，过期则推 `view.snapshot`。

> **进度必须同时落库**（`pipeline.ts:226-229` 的注释）：列表页 5 秒轮询、详情页刷新后
> **都只读 `jobs.percent`**。只 `publish` 不写库是曾经的 bug —— 运行期 percent 恒为 0，
> 前端刷得再勤也拿不到真实进度（`job_phases` 早已跑到 report，列表仍显示 0%）。

---

## 5. 契约层：报告 DSL、校验与渲染

### 5.1 契约层的定位

`packages/contracts` 是**零依赖叶子**（LLD §7.1 强制）：只有类型、常量与**纯函数**，
`node:fs` / `node:sqlite` 之类一律不许出现。它同时被后端与前端依赖，
所以"后端加了一个阶段/块型，前端要么编译报错、要么自动跟上"。

12 个文件的分工见附录 A；关键是 `report.ts`（774 行）——报告 DSL、校验器、自动修复都在这里。

### 5.2 ReportDsl 结构

```
ReportDsl {
  meta          报告元信息（title / brand / window / generatedAt / degraded?）
  sourceDeclaration { grade, sources[], exclusions[] }   ← 首屏合规声明
  slides[]      { index, pageRole, title, layoutId, blocks[], citations[] }
}
```

**`pageRole`** 决定豁免与校验强度：`cover` / `toc` / `section` / `closing`（**结构性页面，R7 豁免**）、
`content` / `data`（正文页，受深度策略的"每页 ≥3 块"约束）。

**10 种 block**（`BLOCK_TYPES`）：`text` `bullets` `kpi` `table` `chart` `image` `timeline` `quote` `callout` `matrix`。
其中 **`image` 需要外部图片素材**（`ref` 只放行 `https://` 与 `data:image/`），而本链路不下发任何图片 URL，
因此它**不计入深度下限**（详见 §5.5）。

**`citations[]` 的 `kind`** 决定可信度语义：

| kind | 含义 | 渲染层如何还原出处 |
|---|---|---|
| `data_source` | 指向数据源 key | 直接用 `ref.sourceKey` |
| `kb_chunk` | 指向知识库片段 | 用 `ref.chunkId` |
| `platform_entry` | **条目级**平台内容引用 | 用 `ref.entryId` 反查证据表，拼出 URL / 发布时间 |
| `model_inference` | 模型推断（必须 `tier: "low"`） | 无 |

### 5.3 校验规则 R1–R13（`validateReportDsl`）

> 设计说明（`report.ts:352-377`）："每个数字必须有引用"这条不变量如果逐字符比对 claim 文本，
> 在实践中不可行（生成文本与 citation 文案不可能字字相同）。因此把它具化为**可判定的规则**。

**不可修复 / 拒绝渲染（hard error）**：

| 规则 | 内容 |
|---|---|
| R6 | 含数字断言的页面：既要"至少一条**可用** citation"，要么该页**所有**含数字的 block 都声明了**有效** `sourceRef`；两者皆无 → **error，`repairable` 未置位，拒绝渲染** |
| R8 | 任何 citation 的 `grade === "L4"` → error（闸门最后一道保险） |
| R10 | `sourceDeclaration` 缺失或为空 → error |
| R13 | `kind=platform_entry` 的 `ref.entryId` 不在 `catalog.evidenceEntries` → error（不给该字段=不校验；给空数组=判非法） |

**可机械修复（`repairable: true`）**：

| 规则 | 内容 | 修复方式 |
|---|---|---|
| R1 | 声明的 key 不在 catalog | 移出声明并降级相关引用 |
| R2 | `displayName` 与 catalog 不一致 | 改正（warn） |
| R3 | `kind=data_source` 的 `sourceKey` 不在已声明 sources | 见 §5.4 |
| R4 | `kind=kb_chunk` 的 `chunkId` 不存在 | 降级 |
| R5 | `model_inference` 却 `tier≠low` | 降到 low（warn） |
| R9 | `tier="low"` 的 KPI 所在页缺 `warn` callout | 补一个 |
| R11 | `block.sourceRef` 不在 `logicalRefs ∪ 已声明 sources` | 别名归一（warn） |

**只提示不阻塞**：R7（结构性页面豁免）、R12（可溯源引用占比 < 60% → warn，深度问题交给深度策略）。

**降级阶梯**（R13 失效时）：条目级 → 来源级（保留 `sourceKey`）→ `model_inference/low`。

### 5.4 自动修复（`autoRepair`）与修复分级

`autoRepair` 返回 `{ dsl, actions, cosmeticActions }`：

- **`actions`（data 级）** → 写进 `job.degraded`，任务标 `partial`；
- **`cosmeticActions`（观感级）** → 不脏 `job.degraded`（只影响 cover/toc/section/closing，
  或 appendix 且 claim 不含数字）。
  `CompileResult.repairs[].severity: "data" | "cosmetic"`，编排层只记 data 级。

> **历史事故（务必看这段再改 autoRepair）**：R3 的前置特例是"逻辑命名空间被误当数据源"
> （`meta:*` / `phase:*` / `tool:*` / `degrade:*` 是**块级 sourceRef** 的写法，不是数据源；
> 模型被提示词同时教了两套写法，实测会混用）。最初的处理是**直接移除**这条 citation —— 但移除后
> 该页 `citations` 变 0，而 R6 只看 `citations.length`，于是**修复动作自己制造出一个
> `repairable: false` 的 error** → `render.compile` 抛 `E-RENDER-001` → **报告整份丢失**。
> 更糟的是 `finalizeReport` 的回喂只收 `!repairable` 的 error（且用的是**未 repair** 的 DSL），
> 模型从头到尾**没被告知**这件事。
>
> 现行做法：把这条逻辑引用**改挂到该页含数字断言的 block 上当 `sourceRef`**（最小改动，
> 溯源还保住了），认不出的写法才退回移除；并且 R6 与 autoRepair **共用唯一判定函数**
> `isMisplacedLogicalRef`。回归用例：`tests/report-repair.test.ts` ⑧⑨⑩⑪。

### 5.5 深度策略（`report-depth.ts`）

`DEFAULT_DEPTH_POLICY`：`slides ≥ 12`、正文页每页 ≥ 3 块、`chart+matrix ≥ 4`、
可溯源引用占比 ≥ 60%、来源声明 ≥ 3 条、**块型 ≥ 9 且必须含 `kpi/table/chart/matrix/timeline/callout/quote`**。

**关键设计：下限必须是「可达解」**。`BLOCK_TYPES` 有 10 种，但 `image` 需要外部图片素材，
本链路永远产不出 —— 若把它算进下限，模型只会拿一个渲染时被摘掉的空块来凑数。
因此：

```
BLOCK_TYPE_HINTS    每种块型的用途（单一事实源）
ASSET_BLOCK_TYPES   = ["image"]        ← 需外部素材，不计入任何下限
USABLE_BLOCK_TYPES  = BLOCK_TYPES − ASSET_BLOCK_TYPES = 9 种
requiredBlockTypes  7 种必需 + text/bullets 自然出现 = 9  → 与 minBlockTypes 自洽
```

**第一道（提示词）与第二道（回喂）同源**：`describeDepthPolicy()` 生成的人类可读描述里
既有数量下限，也有**完整的可用块型清单与逐种用途**，以及"不要用 image 凑数"的禁令；
`measureReportDepth().gaps` 会**点名"还没用上"的可用块型**。
（旧文案只说"只用到 8 种（下限 9）"，模型看到也不知道该补哪种 —— 真机回喂一次仍只产 8 种，
缺的正是当时提示词从未介绍过的 `quote`。）

**第三道**：仍不达标 → 如实落 `meta.degraded`，任务标 `partial`（不假装达标）。

### 5.6 提示词侧的两套写法（规则 A / 规则 B）

同一件事（来源标注）在 DSL 里有两种**互不通用**的写法，模型混用是高频错误，
所以提示词把它们拆成两条独立规则 + 正反例：

| | 规则 A | 规则 B |
|---|---|---|
| 字段 | `citation.ref.sourceKey` | `block.sourceRef` |
| 允许的值 | **只能取「可用数据源清单」里的 key**（`mc_xhs` / `volc_web_search` …） | **只用逻辑命名空间** `phase:*` / `meta:*` / `tool:*` / `degrade:*` |
| 正例 | `{ "kind": "data_source", "ref": { "sourceKey": "mc_xhs" } }` | `{ "type": "kpi", "sourceRef": "phase:budget" }` |
| 反例 | `{ "ref": { "sourceKey": "phase:intel" } }` ← 会被机械删除 | `{ "sourceRef": "mc_xhs" }` ← 校验会拦 |

效果（真机）：改前同一 job 有 11 条 citation 把 `phase:*` 当来源；改后 31 条 citation
**全部是真源**，`phase:*` 全部落在 `block.sourceRef` 上。

### 5.7 渲染层（`packages/render`，672 行）

`RenderService.compile(dsl, { catalog })` 的**顺序是有讲究的**：

```
sanitizeImages(dsl)     摘掉协议不被允许的 image 块（只放行 https:// 与 data:image/），记 dropped
      ↓
autoRepair(dsl)         机械修复，产出 repairs[]（每条带 severity: data | cosmetic）
      ↓
validateReportDsl()     仍不通过且 error 不可修复 → 抛 E-RENDER-001（**拒绝渲染**）
      ↓
渲染 HTML / Markdown     两条输出路径共用同一套块渲染逻辑
```

- **`E-RENDER-001` 的语义**：报告 DSL 未通过不变量校验，**拒绝渲染** ——
  宁可不出报告，也不出一份含无来源数字的报告；
- HTML 是**自包含**的（内联样式，不引 CDN），因为交付环境是离线私有化；
- Markdown 供下载与后续处理（`report_markdown`）；
- **机械附录页**（「数据来源与溯源」：来源声明 / 按平台×算子的采集概览 / 被引用条目清单 / 口径说明）
  由渲染层生成，模型不需要写也不应该写 —— 这样"报告里有几条真实条目引用"不可能被模型美化。

---

## 6. 持久化（M15）

### 6.1 驱动与迁移

- **`node:sqlite`**（Node 内置，无第三方依赖），文件 `.data/brandsale.sqlite`（`BM_DATA_DIR` 可改）；
- 迁移在 `packages/storage/src/db.ts`，`schema_migrations(id, name, applied_at)` 记录版本；
  `npm run migrate` 执行（dev 模式空库会自动灌种子）；
- **所有 SQL 集中在 `repos.ts`**（789 行），上层只操作类型化对象 ——
  这条约束让"换存储引擎"或"审查所有数据访问"成为可能；
- `BM_STORAGE_DRIVER` 目前只有 `sqlite` 实现（`postgres` 为预留）。

### 6.2 表清单（17 表 / 11 索引）

| 表 | 用途 | 关键字段 |
|---|---|---|
| `jobs` | 任务主表 | `status` `percent` `spec_json` `degraded_json` `idempotency_key` |
| `job_phases` | 阶段检查点 | 主键 `(job_id, phase)`；`output_json`（**断点续跑的载体**）`attempts` `cost_json` `degraded_json` |
| `job_events` | 事件持久化 | 主键 `(job_id, seq)`；`type` `payload` —— SSE 回放的真相源 |
| `artifacts` | 产物 | `kind`（9 种）`inline_json` `url` |
| `idempotency` | 幂等 | 主键 `(tenant_id, key)`；`fingerprint` `job_id` |
| `ledger` | 血缘台账（M5） | `inputs_json` `outputs_json` `run_id` |
| `audit` | 审计 | `kind` `code` `reason` `trace_id` |
| `sources` | 数据源登记 | 主键 `(tenant_id, source_id)`；`tier` `legal_approved` `contract_ref` |
| `authz` | 数据源授权 | `valid_from` / `valid_to` / `scopes_json` / `status` |
| `talents` | 达人主表 | `followers` `engagement_rate` `provenance` `account_ref` |
| `pricing` | 报价样本（M8） | `quoted_amount` `actual_amount` `human_verified` `provenance` |
| `kb_docs` | 知识库文档 | `collection` `source_id` `chunk_count` |
| `kb_chunks` | 知识库片段 | `text` `tier` `**vec BLOB**` `embed_model` `embed_dim` `provenance` |
| `kb_terms` | BM25 倒排 | `(chunk_id, term)` |
| `usage_records` | Token 与成本 | `model` `input_tokens` `output_tokens` `cost_amount` |
| `external_cache` | 外部接口缓存 | `cache_key` `payload` `expires_at` |
| `schema_migrations` | 迁移版本 | `id` `name` `applied_at` |

### 6.3 存储约定（改代码前先看）

- **JSON 列**：`spec_json` / `output_json` / `payload` / `degraded_json` / `scopes_json` 等
  在 TS 侧是**对象**，落库时序列化。改字段类型要同时改两侧；
- **时间统一 ISO 8601 字符串**（可排序、可比较）；
- **金额统一 `{ currency: "CNY", amount: number }`**，单位「元」；
- **`kb_chunks.vec` 是 BLOB（Float32）**，向量与 chunk **同事务读写** ——
  这是"默认用 SQLite 暴力余弦而不用 Milvus"的直接理由（不会出现"chunk 删了向量还在"）；
- 可见性谓词：租户数据 `tenant_id = ?`，全局语料 `tenant_id = ''`；
  SQLite 侧 `VISIBLE_SCOPE_SQL` 与 Milvus 侧 filter **必须语义对齐**（写歪不报错）。

---

## 7. 智能体集群（M9）与工具治理（M10）

### 7.1 六个 Agent

一个阶段一个 Agent，**结构化交接**（`HandoffEnvelope`：schema + data + `missing` + `degraded`），
不走自由对话。角色码与阶段一一对应（`packages/contracts/src/agent.ts:AGENT_CODE_LABEL`）：

| 码 | 阶段 | 中文名 | 产出 Schema | 模型档 | 输出上限 | 上下文上限 | 阶段超时 | 工具白名单 |
|---|---|---|---|---|---:|---:|---:|---|
| AO | intake | 任务录入 | `BriefSchema` | light | 4 096 | 8 000 | 120s | `validate_brief` `resolve_authorization` |
| CI | intel | 竞品情报 | `CompetitorIntelSchema` | strong | 8 192 | 16 000 | 180s | `kb_retrieve` `web_search` `platform_digest` |
| CT | creator | 人选匹配 | `CreatorCandidatesSchema` | medium | 8 192 | 16 000 | 150s | `kb_retrieve` `pricing_query` `risk_screen` `platform_digest` |
| PL | playbook | 打法排期 | `PlaybookSchema` | medium | 10 240 | 24 000 | 150s | `kb_retrieve` `calendar_plan` |
| BR | budget | 预算风控 | `BudgetSchema` | medium | 8 192 | 16 000 | 150s | `kb_retrieve` `pricing_query` `scenario_simulate` |
| RG | report | 研报生成 | `ReportDslSchema` | strong | **32 768** | **48 000** | 240s | `render_outline` `cite_fact` |

**为什么要分档**（`agents.ts` 注释）：输出预算给少了，模型每轮恰好截在 max_tokens
（`finish_reason=length`），解析全失败 → 走合成兜底 → 报告顶部出现误导性的「模型不可用」——
实际模型一直是好的。一份 13 页含真表格的 DSL 约 40–60KB JSON（≈2 万+ token），
所以 report 必须显著高于其它阶段。上下文同理：全局 24 000 装不下「竞品 + 人选 + 排期 + 预算」四份表格。

**阶段超时是"下限"**：实际取 `max(本表, BM_LLM_TIMEOUT_MS + 60_000)`。
自建端点有冷启动（连上但不吐 token 好几分钟），若阶段预算小于单次请求超时，
阶段会在请求本身还没超时前就 abort —— 表现是**任务卡在 0%、既不前进也不降级**。

### 7.2 工具清单（18 个）

`packages/agent-pack/src/tool-impls.ts:TOOL_IMPLEMENTATIONS`。工具是**确定性**的：
只负责取数、检索、计算，不负责措辞；每个数据类工具都返回 `provenance`；拿不到数据就返回降级结构。

| 工具 | 作用 | 白名单 | 治理检查 | 绑定源 / 限额 |
|---|---|---|---|---|
| `validate_brief` | 校验 Brief 合法性（预算/权重/时间窗） | AO | — | — |
| `resolve_authorization` | 查可用数据源与受阻源 | AO | scope | — |
| `kb_retrieve` | 四库混合检索（BM25 ⊕ 向量 + 重排） | CI, CT, PL, BR | scope, tenant | 20s |
| `web_search` | 联网检索公开网页 | **全部六个** | scope, source, authz, tenant | `volc_web_search` · **30 次/任务** · 12s |
| `pricing_query` | 达人报价区间 | CT, BR | scope, tenant | 6s |
| `risk_screen` | 达人风控筛查 | CT | scope, tenant | 5s |
| `calendar_plan` | 内容日历排期 + 冲突检测 | PL | — | 5s |
| `scenario_simulate` | 三档情景模拟 | BR | scope, tenant | 6s |
| `render_outline` | 报告页面骨架（完整章节） | RG | — | 5s |
| `cite_fact` | 引用校验（命中才允许写 `data_source`） | RG | tenant | 5s |
| **`platform_digest`** | **跨平台聚合采集（模型侧唯一平台入口）** | CI, CT | scope, source, authz, tenant | 七个 `mc_*` · **8 次/任务** · 45s |
| `xhs_web` / `douyin_web` / `kuaishou_web` / `bilibili_web` / `weibo_web` / `tieba_web` / `zhihu_web` | 单平台采集（**`hidden: true`**，模型看不到） | CI, CT | scope, source, authz, tenant | 各自 `mc_<平台>` · 20 次/任务 · 15s · `sequential` |

`web_search` 白名单是**全部六个阶段**：早期只给 CI，因为那时千川/星图等合成适配器还在承担取数职责；
那些适配器已整体移除，公开信息只剩联网检索一条路。
**代价（刻意的）**：CT 的达人信息可能来自公开网页而非报价库，「禁止编造达人」不再由白名单兜底，
只剩 prompt 约束 + 报告阶段的引用校验事后拦截 —— 将来接回真实达人库后应重新收紧。

### 7.3 装配期准入（`admitTool`）

工具不是"定义了就能用"，装配期还要过一遍 `admitTool`（**独立函数，可单测**）：
三条安全不变量靠"读代码确认"是不够的。

| 规则 | 行为 |
|---|---|
| 同时声明 `boundSourceId` 与 `boundSourceIds` | **抛错**（来源声明有歧义 = 配置自相矛盾，启动时炸出来） |
| `boundSourceId` 的源未装配 | **静默不注册**（宁可工具清单里没有，也不要让模型去调一个必然失败的工具） |
| `boundSourceIds`（聚合）**一个都没有**已装配 | 不注册（否则报告里会多一条"平台聚合可用但一个平台都没有"的**假能力**） |
| `mutating` 且 `BM_TOOLS_ALLOW_MUTATING=false` | 不注册（默认关，让"引入写能力"成为显式决策） |
| `mutating` 但 `governance` 不含 `authz` | **抛错**（写操作没有授权检查是不可接受的默认值） |
| `mutating` 且 `replaySafe=true` | **抛错**（写操作重放会重复产生副作用） |

> **为什么 `boundSourceId` 必须由代码声明**：闸门的 `source` / `authz` / `tenant` 三项都是按
> `args.sourceId` 定位数据源的。若来源由模型在参数里"自报"，模型传一个别的 sourceId
> 就能让闸门去检查另一个（已登记的）源，而工具实际访问的那个源根本没被检查 ——
> **闸门形同虚设**。声明在 policy 后，M10 会用它覆盖参数里的 sourceId。

### 7.4 `platform_digest`：跨平台聚合

一次调用覆盖多个平台，并在返回值里直接给出"哪些指标可以横向比"。为什么不让模型逐个调七个平台工具：

1. **可比性判断不该交给模型**（见 §8.7 的能力矩阵：七平台内容层没有任何共有指标）；
2. **闸门要逐源过**：绑多个源不等于放开来源 —— 每个平台仍按自己的 `sourceId` 单独跑
   `source`/`authz`/`tenant`/`scope`，**未通过的平台被跳过并记名**，而不是让整只工具失败
   （一个未授权的平台不该拖垮另外六个）；
3. **工具面收敛**：模型看到的平台入口只有这一个。

返回契约（**提示词依赖它，改前先看这段**）：

- `comparison.metrics` —— 本组平台指标的**交集**，再剔除"声明共有但本批全无非零值"的
  （**空集是合法结果**；跨平台对比只允许落在这上面）；
- `comparison.dropped` —— 声明共有但本批全 0（**缺失不是 0**）；
- `platformsSkipped` —— 逐平台记名（未装配 / 未过闸门 / 采集失败）；
- `platforms[].absentMetrics` —— 该平台缺哪些指标。

七个单平台工具是**受治理的实现原语**：仍注册、仍逐个过闸门、单测仍直接调用它们，
但不进模型上下文。⚠️ 它们**不走并行**（`parallelism: "sequential"`）——
底层是 MediaCrawler 的**单进程串行**执行器，并行只会让调用一起排队反而更慢；`retry: 0` 同理
（采集是分钟级，失败立刻重试也来不及）。

### 7.5 阶段执行：三级降级阶梯

**任何一级失败都不中断任务**（`agents.ts:runPhase`）：

```
                    ┌─ ① Pi Agent 循环（pi-agent-core，带工具）
                    │     工具往返 → 结构化输出 → Schema 校验
                    │     ✅ 成功（report 阶段还要过 finalizeReport）
                    │     ✘ 失败（无工具 / 抛错 / 校验不过）↓
准备提示词 ─────────┤
+ 预取平台数据       ├─ ② 单次结构化输出（completeJson，**不调工具**）
（refreshPlatformData）│     ✅ 成功（同样过 finalizeReport）
                    │     ✘ 失败（E-AGENT-001 校验不过 / E-AGENT-002 调用失败）↓
                    └─ ③ 合成兜底（synthesize，仅当 BM_ALLOW_PARTIAL=true）
                          工具实测数据 + 保守模板，标注降级原因
```

**降级文案必须如实**（这条是踩坑得来的）：
`E-AGENT-002` = 调用层失败（网络/超时/熔断），写"模型不可用"没问题；
`E-AGENT-001` = 模型有输出但没通过解析/校验（**常见于被 max_tokens 截断**），
此时模型是通的，再写"模型不可用"会把排障方向带偏 —— 曾因此把截断问题误判成端点故障。

**Pi 循环的"工具调用风暴"闸门**（三道，`agents.ts`）：

| 常量 | 值 | 作用 |
|---|---:|---|
| `PI_MAX_IDENTICAL_CALLS` | 3 | 同一调用（参数指纹相同）超过 3 次即拒 |
| `PI_MAX_TOOL_CALLS_PER_PHASE` | 30 | 单阶段工具调用总数上限 |
| `PI_MAX_BLOCKED_STREAK` | 6 | 连续被拒 6 次 → 置 `terminate`，让循环提前收手 |

**真机事故背景**：intel 阶段同一个 `platform_digest` 被**连续调用 131 次**，
每次都因 `maxCallsPerJob` 被拒、每次都记一条降级 —— 阶段预算被这些必然失败的往返烧光，
Pi 循环只吐出一句半截话，结构化解析失败；轮到直连兜底时预算已耗尽，又被打成 `E-AGENT-002`，
报告整体降级成模板合成。用户看到的是"数据明明采到了，报告却还是占位"。

根因是提示词鼓励「首次常返回 0 条，重试即可」，模型把"重试"当成了循环条件，
而**治理层只会拒绝并解释、没有终止循环的手段**，模型不会因为被拒就停手。所以闸门必须补在循环层。

### 7.6 报告阶段的特殊处理

**`finalizeReport`（RG 产出后）**：

1. `enrichReportProvenance` 机械补齐（模型路径**不依赖模型自觉**）：
   - 把 `platform_digest` 已取回、但模型没写进 `evidences` 的条目，补成 `platform_entry` 引用；
   - 给结构页补 `meta:*` 块级 `sourceRef`；
   - 原因：实测模型会整份报告**一条 `platform_entry` 都不写**（该字段可选、且模型倾向只写"模型推断"），
     结果"数据其实取回来了，报告读起来却像没接平台"。
2. 自校验 `validateReportDsl`，**只把 `!repairable` 的 error 收进回喂清单** ——
   可机械修复的交给渲染期 `autoRepair` 降级处理，不必浪费一次整份重生成；
3. 若仍有 blockage 或深度缺口 → **回喂一次**（附完整问题清单 + `describeDepthPolicy()`）；
4. 回喂结果要**重新走一遍 `enrichReportProvenance`**（回喂得到的是全新输出，不重跑会丢溯源）；
5. 仍不达标 → 落 `meta.degraded`，任务标 `partial`（**如实标注，不假装达标**）。

### 7.7 提示词组织（`prompts.ts`，217 行）

```
SYSTEM_PROMPTS[code] = PER_AGENT[code] + "\n\n" + COMMON_RULES
```

- `PER_AGENT` —— 六个角色各自的职责与硬性要求（CI 的竞品 ≥3 家、CT 的达人不得编造…）；
- `COMMON_RULES` —— 六条通用约定（严格 JSON / 无来源数字写 null / 降 confidence / 缺失必须显式 /
  `verifiedBy: auto`）+ 工作方式 + 【来源与引用】（规则 A/B，见 §5.6）；
- ⚠️ **`prompts.ts` 是反引号模板字符串**：文案里**不能用反引号**（会截断字符串引发一片 TS1005），
  用「」代替。踩过。

各阶段的"该调什么工具"不在系统提示词里，而在 `PHASE_TOOL_HINT[phase]`
（与 `AgentSpec.tools` 白名单一并注入）—— 这是**随阶段变化的运行时提示**，
与静态角色提示词分开，避免同一段规则在六个提示词里各抄一遍。

### 7.8 结构化输出校验（`schemas.ts`，1334 行）

**手写校验器，不引 zod**：每个字段都要给出**可定位的错误路径**（`$.brandSelf.contentAssets[0].accountCount`），
因为校验错误要拼进回喂提示词、还要写进事件流给用户看。
校验器同时承担若干**业务不变量**，例如：

- `contentAssets` 每个数字是 `number | null`，且**出现具体数字时 `brandSelf.citations` 必须非空**（硬校验）；
- `riskFlags` 必须落在对应候选人上；
- 报告阶段的 `evidences[].entryId` 必须**逐字**来自 `platform_digest` 的 rows。

---

## 8. 数据源与治理

### 8.1 三条供给路径与数据分级

系统里任何"数字"都必须落在三条路径之一（见 `docs/requirements-implementation-plan.md` §2）：

| 路径 | 内容 | 当前落地 |
|---|---|---|
| ① 客户/授权方语料 | 品牌自诊、历史执行复盘、达人报价 | KB 四库 + 达人报价库（SQLite 内） |
| ② 公开采集 | 竞品与类目公开内容 | 联网检索 + 七平台采集（共 8 个 L3 源） |
| ③ 官方授权接口 | 平台私有经营数据（经营大盘、粉丝画像） | **未接入**（需企业主体 + 审批 + OAuth） |

**数据分级决定可信度口径与闸门行为**：

| 级别 | 含义 | 现状 |
|---|---|---|
| L1 | 平台官方授权接口 | 无真实适配器（`BM_L1_ENABLED` 为预留开关） |
| L2 | 客户内部数据 / 人工录入 | KB-1..KB-4、达人报价库 |
| L3 | 公开信息（未经人工核验） | 联网检索 + 七平台采集，共 **8 个源** |
| L4 | 第三方采购数据 | 默认关闭（`BM_L4_ENABLED=false`，且需 `legal_approved`） |

### 8.2 八个 L3 源（真实清单）

| 源 id | 显示名 | 算子 | 外部 HTTP | 计费 | 备注 |
|---|---|---|---|---|---|
| `volc_web_search` | 火山引擎「联网搜索 Lite」 | `search` | ✅ | **按次计费** | 全系统**唯一**真正打外部 HTTP 的通道 |
| `mc_xhs` | 小红书公开内容 | `search` / `content_detail` / `comments` / `creator` | ✅（经 collector） | 否 | 复用 MediaCrawler 内核 |
| `mc_dy` | 抖音公开内容 | 同上 | 同上 | 否 | |
| `mc_ks` | 快手公开内容 | 同上 | 同上 | 否 | |
| `mc_bili` | B站公开内容 | 同上 | 同上 | 否 | 唯一有弹幕/投币 |
| `mc_wb` | 微博公开内容 | 同上 | 同上 | 否 | |
| `mc_tieba` | 贴吧公开内容 | 同上 | 同上 | 否 | 指标最贫（仅正文 + 回复数） |
| `mc_zhihu` | 知乎公开内容 | 同上 | 同上 | 否 | |

**`volc_web_search` 的三条自我约束**（`packages/datasource/src/web-search.ts`）：

1. **是适配器而不是后门**：走标准 `Provenance`，台账登记 L3，`synthetic: false`；
2. **单任务调用有界**：`maxCallsPerJob = 30` —— 令牌桶只管速率不管总量，计费接口必须另有**总额闸门**；
3. **能力缺席即不暴露**：未配 `BM_WEB_SEARCH_API_KEY` 时适配器不注册，工具**不会出现在模型清单里**
   （宁可工具清单里没有，也不让模型去调一个必然失败的工具）；`BM_LLM_MODE=mock` 时 intel 阶段跳过预取，
   因此 E2E 用例可以无条件离线跑。

**已移除且不要重加**：千川 / 星图 / 蒲公英 / 生意参谋 / 巨量算数 ——
它们从未接入真实平台，只输出确定性伪随机数（`provenance.synthetic = true`）。
把它们留在台账里会让报告出现「已授权实测数据」的错觉，这比明确的"无数据"更危险（README §「关于 L1 平台源」）。

### 8.3 治理闸门（M3）：所有数据访问的唯一通路

`packages/governance/src/gate.ts`。**工具能碰到哪条数据，由代码绑定，不由模型参数决定** ——
`ToolPolicy.boundSourceId` 写死在工具定义里，模型只能选择"调不调这个工具"，不能选择"查哪个源"。
（否则模型传另一个已登记的 sourceId，闸门就会去检查错对象而放过真实来源。）

一次工具调用的完整路径（`packages/agent-pack/src/tools.ts`）：

```
模型请求调用工具
  ① 工具是否在 allowedAgents 白名单内（角色 × 工具矩阵）
  ② 令牌桶：源级速率 + maxCallsPerJob 总额（用完即拒，防"换关键词反复问同一个源"）
  ③ authz：该租户对该源是否已授权
  ④ tenant：跨租户隔离
  ⑤ mutating：写操作工具需 BM_TOOLS_ALLOW_MUTATING + authz（默认全关）
  ⑥ 语义红线：如预算超限（fail-closed，由 BM_GATE_FAIL_CLOSED 控制）
  ↓ 全通过
适配器调用 → 返回标准 Provenance → 写台账（M5）
  ↓ 任一失败
错误码（E-GOV-001 / E-DATA-001/002 …）→ 计入报告「排除项」，不会静默变成空数据
```

`ToolRegistry` 的三个关键标记：

| 标记 | 语义 |
|---|---|
| `boundSourceId` / `boundSourceIds` | 单源 / 一组源（聚合工具用）。**两者互斥**，同时声明会在装配期抛错 |
| `hidden` | 只影响**暴露**（`list()` / `toAgentTools()` 不返回），**不影响注册与闸门** —— 七个单平台工具仍在后台受治理 |
| `allowedAgents` | 白名单：哪个 Agent 能调它 |

> 经验教训（`tests/tool-call-guard.test.ts`）：真机双十一自测时，intel 阶段同一个 `platform_digest`
> 被**连续调用 131 次**，每次都因 `maxCallsPerJob` 被拒、每次记一条降级 —— 整个阶段的预算被这些
> 必然失败的往返烧光。因此"用完"与"限速"必须在**发起调用之前**就拦截，且要有确定性用例盯着。

### 8.4 台账（M5）与来源目录

- **台账**（`packages/governance/src/ledger.ts`）：每次数据访问记一行（源、算子、行数、成败、耗时），
  是控制台「治理台账」与 `/audit` 的数据源，也是"报告用了多少真实数据"的唯一凭据。
- **来源目录**（`packages/governance/src/catalog.ts` → `buildSourceCatalog`）：
  模型可见的"合法来源清单"。两条硬规则：
  1. `availableSourceIds` **只放已装配适配器的源** —— 登记 ≠ 可用（未装配的源写进报告只会变成假溯源）；
  2. `resolve_authorization` 的 `capabilityMissing` **单列「已授权但能力未装配」**，
     让"没授权"和"授权了但没装"这两种缺口在报告里能分开说。

### 8.5 平台采集链路（三段式）

```
services/collector-core       内嵌采集内核（MediaCrawler 的采集部分）
   Python + Playwright：起浏览器 → 扫码登录 → 七平台签名与采集 → 落 jsonl
   ↓ 子进程 spawn（每次采集新起，内核单会话，所以采集串行）
apps/collector                只读归一化 sidecar（127.0.0.1:8890）
   把各平台 jsonl 归一化成统一行 → 本地缓存 → 对外只暴露 4 个只读算子
   ↓ HTTP（同步、按查询、带 provenance）
packages/datasource           七个适配器 → 七个平台工具 → platform_digest（模型侧唯一入口）
```

**为什么中间必须有一个 sidecar**：内核的工作模式是「起浏览器 → 扫码 → 分钟级落盘」，
而工具层要的是「同步、按查询、带 provenance」。两者节奏差三个数量级，
必须有个地方把"采"和"查"解耦（`docs/datasource-integration.md` §1）。

| 环节 | 关键实现 | 为什么这么做 |
|---|---|---|
| 子进程驱动 | `apps/collector/src/core-runner.ts` 用 `spawn(<coreDir>/.venv/bin/python, run.py …)` | 内核单会话，采集串行；日志落 `.data-collector/logs/<taskId>.log`（`GET /tasks/:id/log`） |
| 参数映射 | 参数→config 照抄上游 `arg.py`；detail/creator 靠**平台专属 ID 列表**驱动 | 内核没有"按 id 取详情"的统一入口 |
| 落盘目录契约 | `MEDIA_CRAWLER_PLATFORM_META[*].dataDirName` **必须等于**内核 `_store_impl.py` 的字面量 | `bili→bili`、`dy→douyin`、`ks→kuaishou`、`wb→weibo`；写错时子进程 exit 0、jsonl 也写了，collector 却报"未读到任何归一化记录"（契约测试直接读内核源码断言） |
| 读落盘 | `snapshotDataFiles()` 拍快照 → `readRecordsSince()` 只取新增行 | 内核 jsonl **按天共享**，同一平台当天第二个任务是**追加**；整文件读会把旧行重吞并打上当前算子标签（贴吧实测：真采 3 条报 `stored: 14`） |
| 缓存 | `withCache`，**空结果不进缓存** | 否则"首次排队采集 → 重试"会被自己的空缓存堵死 |
| ID 闭环 | 归一化输出的 `id`/`url` 必须能喂回 `content_detail` / `comments` | 喂错形态是**静默失败**（任务 `done` + `stored: 0`），只看任务状态发现不了 |

#### 预采集覆盖哪些平台：`BM_MC_PREFETCH_SCOPE`（默认 `brief`）

`platformPrefetchArgs()`（`agents.ts`）决定 intel 阶段**自动预取**投哪些平台，三个分支：

| 条件 | 覆盖范围 |
|---|---|
| `prefetchScope=all` | 全部已装配平台，brief 声明的排在最前（`BM_MC_PLATFORMS` 交集的联合集） |
| `brief` 且 brief 声明了平台 | **只采声明的那个集合**（业务码映射→按已装配过滤，顺序即声明顺序）；一个都没装配 → 不投递 |
| `brief` 且 brief 没声明平台 | 不设范围，退回全部已装配平台 |

**为什么默认收窄**（2026-10-14 改，此前默认是 `all`）：平台采集是分钟级的 Playwright 子进程，
一次报告对七个平台各投一轮，"客户没打算投"的那几个平台整条链路都不会被引用 ——
实测手机报告的来源声明里就写着「快手 / 微博 / 贴吧 / 知乎 不在本次调研范围」，
却照样各采了一轮，纯属白烧时间与机器。

范围**只约束自动预取**：工具装配与闸门仍按 `BM_MC_PLATFORMS` 全量生效，
模型在工具循环里仍可主动采任何已装配平台（`platform_digest` 的 `platforms` 参数接受全部七个采集码）。
收窄的是"默认行为"，不是"能力"。另注意 `BRIEF_PLATFORM_TO_MC` 只映射四个业务码
（快手/贴吧/知乎不在 `Brief.platforms` 候选集里），所以 `brief` 模式下这三个平台不会被预采。

#### 浏览器会话：`reuse` 常驻复用（默认）

**问题**：内核每个采集任务都是一个新 Python 子进程，而子进程原本每次都 `launch` 一个
Chrome。collector 串行执行，于是一次报告 = 几十次"窗口弹出 → 关闭"。实测一轮
20 个任务 = 20 次窗口闪烁，且**报告交付后仍在弹** —— 因为 `enqueueAuthorProfiles`
（`tasks.ts`）在每次 `search` 完成后才派生作者主页补采任务，那批补采天然落在报告之后。

**做法**：把"浏览器"从**任务级资源**升级为**平台级常驻资源**。

| 角色 | 职责 |
|---|---|
| 内核 `--cdp reuse` | 端口上有常驻浏览器就 `connect_over_cdp` 接上（**不新开窗口**）；没有才拉起，并且**退出时不杀掉它**（`_connect_or_launch_persistent`，`tools/cdp_browser.py`） |
| 端口 | 按平台固定取自 `MEDIA_CRAWLER_PLATFORM_META[].cdpPort`（9333–9339），由 collector 经 `--cdp-port` 下发。**端口就是浏览器的身份**，所以不能让内核 `find_available_port` 向上找空闲端口 |
| 收尾 | `apps/collector/src/browser-session.ts` 按端口 `lsof` 找到进程、**核过进程名确实是浏览器**才 `SIGTERM`；`TaskManager.reapIdleBrowser()` 在该平台无待跑任务（含补采积压）时调用；collector 关闭时全量收尾 |

三条必须守住的纪律：

1. **`cleanup()` 在常驻模式下不能调 `browser_context.close()`** —— CDP 接上的那个 context
   就是浏览器默认 context，关掉它等于关掉整个窗口。只断连 + 把多余标签页收掉、保留一个空白页
   （Chrome 关掉最后一个标签等于关窗口）。
2. **`hasWorkFor()` 必须把 `profileBacklog` 算进来**。漏掉它的话，一次搜索刚结束就会把浏览器
   收掉，紧接着补采任务又得重新拉一个 —— 正好是这次要消灭的现象。
3. **停之前要核身份**。端口是 collector 挑的固定值，但本机别的程序也可能占着；
   误杀用户正在跑的程序，代价远大于漏收一个窗口。

实测（2026-10-14，2 个搜索 + 1 个自动派生补采）：**只新开 1 次浏览器**，后两个任务日志均为
「复用常驻浏览器（port 9333），不新开窗口」，队列排空后 collector 记录「已无待跑采集，回收常驻浏览器」。

**已知的脆弱点**：各平台 `login.py` 的选择器是对 DOM 的硬编码，平台改版即失效。
贴吧踩过（入口 `li.u_login` → `div.login-btn`），上游「点不到就 `sys.exit()`」会导致
`SystemExit` 不被 `except Exception` 捕获、子进程静默死。已修，**其余六平台仍是上游原样**。
诊断方法：用内核自己的 profile + `libs/stealth.min.js` 起 headless 探针抓 DOM——
一次性新 profile 直连会触发平台安全验证，得到假结论。

### 8.6 许可红线：三道门

内嵌采集内核来自 MediaCrawler，许可是 `NON-COMMERCIAL LEARNING LICENSE 1.1`，
条件第 3 条禁止未经版权方书面同意的**任何商业用途**。而本系统是商业交付（报告直接指导甲方真实投放）。

因此整条链路有**三道门，缺一不可**：

```
BM_MC_ENABLED=true   +   BM_MC_LICENSE_ACK=true（必须显式确认）   +   BM_MC_COLLECTOR_URL=<sidecar 地址>
```

任一项不满足，**七个适配器与七个工具一律不装配** —— 把"引入一个非商用组件"固化成
**必须显式做的决定**，而不是顺手配个地址就悄悄生效。默认值全部是"关"。

### 8.7 能力边界（跨平台对比的硬约束）

**各平台内容层指标并不一致**（真机核对，跨平台对比只能用共有指标）：

| 指标 | 覆盖 |
|---|---|
| 正文 | 7/7 |
| 点赞 | 6/7（缺贴吧） |
| 评论数 | 6/7（缺快手） |
| 收藏 | 3/7（小红书/抖音/B站） |
| 转发 | 4/7 |
| 播放 | 2/7（快手/B站） |
| 评论点赞 | 5/7（缺快手/贴吧） |
| 弹幕 / 投币 | 仅 B站 |
| 粉丝数 / 粉丝画像 / 创作者画像 | **0/7** |

**真机硬结论：七平台全量放在一起时，内容层没有任何共有指标** ——
"七平台声量横向对比"在数据上不成立，报告必须写"不可跨平台对比"。

**为什么模型侧只有一个 `platform_digest`**：七个同形工具并列时，模型必然自己在上下文里做合并，
而"哪些指标可比"是**确定性计算**、恰是 LLM 最易错的地方。因此：

- 七个单平台工具**仍注册、仍逐源过闸门**，但 `ToolPolicy.hidden = true`（不暴露给模型）；
- `platform_digest` 直接返回 `comparison.metrics` = 本组平台指标的**交集**，
  再剔除"声明共有但本批全无非零值"的（**空集是合法结果**，跨平台对比只允许落在这上面）；
- `comparison.dropped` = 声明共有但全为 0（**缺失不是 0**）；`platformsSkipped` 逐平台记名；
  `platforms[].absentMetrics` 记该平台缺哪些。

**粉丝画像（年龄/性别/地域）在公开 Web 接口层一个平台都拿不到** —— 这不是解析问题，
是接口层根本没有这个数据。正道只有 L1 官方通道（抖音开放平台 `fans_data`）。
B站的粉丝/关注列表在 MediaCrawler 源码里是**注释掉的**（入口不可达），所以也没做成算子。

---

## 9. 知识库与检索

### 9.1 四库 + 报价库

| 库位 | 内容 | 全局可写 |
|---|---|---|
| KB-1 | 品牌与业务语料 | 否 |
| KB-2 | 历史执行与复盘（含自动回灌的报告摘要） | 否 |
| KB-3 | 行业方法论 | ✅ |
| KB-4 | 公开研究/报告 | ✅ |

- **入库通道三处**：`scripts/seed.ts`（种子）、`POST /api/v1/kb/documents`（HTTP 上传）、
  `onReportReady` 钩子（系统自产摘要回灌）。
- **来源守卫 fail-closed**：入库的 `sourceId` 必须在台账登记且授权有效，否则 `E-INGEST-001`；
  守卫未注入时**也是** `E-INGEST-001`（`packages/knowledge/retrieval.ts`）。
- **全局语料用 `tenant_id = ''`**，可见性谓词是 `(tenant_id = '本租户' OR tenant_id = '')`；
  SQLite 侧 `VISIBLE_SCOPE_SQL` 与 Milvus 侧的 filter **必须对齐**（写歪不报错）。
- 二进制文档（PDF/DOCX/XLSX/PPTX）需配 `BM_PARSER_URL`（MinerU）；
  未配置时上传二进制返回 **415 `E-INGEST-002`**，**不会**退化成"把二进制当文本塞进库"。

### 9.2 混合检索：BM25（自研）+ 向量 + RRF + 可选重排

`packages/knowledge/src/retrieval.ts`（843 行，单文件承载整个 M7）。

- **BM25 自研，无第三方库**：`K1 = 1.4`、`B = 0.72`；
  倒排落 SQLite `kb_terms(chunk_id, term)`；索引文本是 `` `${text} ${sourceId}` ``（sourceId 也进词表）。
- **分词自研**（`embedding.ts:tokenize`）：拉丁按 `[a-z0-9]+`、len ≥ 2 收词、len > 4 切 4-gram；
  中文按 **2-gram + 3-gram + 单字**。**没有 jieba 或任何现成分词器**。
- **向量**：落 `kb_chunks.vec`（BLOB Float32）+ `embed_model` / `embed_dim`，
  应用层暴力余弦 —— 万级 chunk 毫秒级，且**向量与 chunk 同事务读写**，不会出现"chunk 删了向量还在"。
- **融合用 RRF**（不是加权），`K_RRF = 60`。关键细节：BM25 一路必进，
  **语义一路只有算出非零 `cos` 时才计入** —— 全 0 视为噪声，不参与融合。
- **跨模型向量不可比**：只比较 `embed_model + embed_dim` 都一致的行；不一致的由本地 provider 现算，
  并累计 `staleVectors` 记 `E-KB-002`。
- **重排**可选（`BM_RERANK_URL`）：失败 → 原序 + 30s 冷却 + `E-KB-001` note（不阻塞检索）。

### 9.3 语义记忆库（可选旁路）

`packages/knowledge/src/semantic-memory.ts`（637 行）。**单文件零依赖**：
全局 `fetch` 直接打 Milvus REST，**不引 gRPC SDK**。

- **SQLite 永远是唯一真相源**；Milvus 是**可重建的索引**，不是数据源。
- **租户过滤必须下推到 Milvus filter**：`(tenant_id == "X" or tenant_id == "")`，
  字符串经 `lit()` 转义防过滤注入；与 SQLite 侧的可见性谓词语义严格对齐。
- 写入后立刻读要 `consistencyLevel: "Strong"`（默认 `Bounded`）。
- **Milvus 业务错误也返回 HTTP 200**，必须看 `body.code !== 0`。
- REST 基址是 **19530**，不是 9091（9091 只有健康/指标端点，打 `/v2/vectordb/*` 会 404）。

**三档降级（都是静默的，要留意）**：

| 情形 | 行为 |
|---|---|
| `BM_VECTOR_DRIVER=milvus` 但 `BM_EMBED_URL` 为空 | `index = null`，完全走 SQLite 语义，**连降级记录都没有**（装配层只有启动告警） |
| index 可用但 Milvus 挂了 | 检索返回空 + `E-KB-002` note，退回 SQLite + 关键词 |
| 嵌入服务挂了 | `qVec = null` → 语义分全 0 → 纯 BM25，记 `E-KB-002` |

`BM_VECTOR_DRIVER` 的解析很严格：**只有严格等于 `"milvus"` 才是 milvus，其余任何值都归 `"memory"`**。

### 9.4 嵌入服务（`services/embedding-core`）

FastAPI + sentence-transformers 常驻服务，模型 `google/embeddinggemma-2`（270M，仅文本塔）。

- 端口 `127.0.0.1:8899`（容器内 `EMBED_HOST=0.0.0.0`，暴露面由 compose `ports` 决定）。
- **容器内固定 `EMBED_DEVICE=cpu`**（没有 MPS）；实测容器 CPU 与宿主 MPS 的**向量逐位一致**（余弦 1.00000000）
  → **换设备不废索引**。
- **禁用 float16**（模型卡：NaN / 静默劣化），默认 float32；仅 CUDA 允许 bfloat16。
- 前缀由服务端按 `input_type` 注入（query → `SearchQuery`，document → `Document`）；
  **带 title 的文档要手动拼 `title:{t} | text:{c}` 且不能再传 `prompt_name`**，否则前缀叠加。
- ⚠️ EmbeddingGemma 相似度整体偏高（不相关中文句也有 ~0.6），**不能用固定阈值判"是否相关"**。
- `BM_EMBED_URL` 留空 → 退化为本地 256 维字符哈希占位（**本质是词袋，不是语义向量**）。

### 9.5 达人报价库（M8）与置信度

- **刊例价与成交价分开存**（`quoted_amount` / `actual_amount`）。
- **「报价无样本」= `PricingStore.estimate()` 返回 `null`** —— 不是抛错、也不是空对象。
  估算规则：无成交时 `base = median(quotes) × 0.78`（经验折扣），区间 `base ± spread × 1.5`。
- **置信度**（`confidence.ts`）：基分按来源分级（l1 0.7 / l2 0.62 / l3 0.5 / l4 0.45 / 人工核验 0.8）
  - 样本量加分 − 新鲜度扣分 + 人工核验加分 + 多源交叉一致性。
  **`derived: true` 的记录不适用「多源交叉」** —— 否则"真实来源 + 自己的摘要"会被算成 2 源交叉（自证自话）。

### 9.6 报告摘要回灌

报告产出后，把**机械抽取**的摘要（`summarize.ts`，纯函数零 I/O，**默认不用 LLM**）
写进 KB-2（`sourceId = report_summary`），让"这家客户过去做过什么"进入后续任务的检索范围。

- 由 `onReportReady` 钩子触发（`container.ts`），受 `BM_SUMMARY_INGEST` 控制；
- **best-effort**：失败不影响报告本身，只记降级；
- `keyNumbers` 只收「挂了可溯源引用（非 `model_inference`）」的页，模型推断的部分单列。

---

## 10. 模型网关（M14）

`packages/model-gateway`：全系统**唯一的模型出口**，也是唯一做模型并发/重试/熔断/记账的地方。

### 10.1 两条调用路径

```
① Pi Agent 循环路径（有工具的阶段）
   agents.ts → createVllmModel() + loadPiStreamFn() → pi-agent-core 的 Agent
     · 工具循环、beforeToolCall 白名单钩子由 Pi 提供
     · streamSimple 包一层：注入 apiKey / 超时 / 并发闸门，并**强制 maxRetries: 0**
       （重试统一由 M14 负责，避免两处叠加）

② 直连结构化输出路径（无工具 / Pi 失败）
   agents.ts → gateway.completeJson() → client.ts（OpenAI 兼容 Chat Completions）
```

`pi.ts` 把自建 vLLM 端点包装成 Pi 的 `Model<"openai-completions">`，
`compat` **显式声明为 vLLM 友好档**（`supportsStore: false`、`supportsDeveloperRole: false`、
`maxTokensField: "max_tokens"`、`supportsStrictMode: false` …）—— 默认档位会发出 vLLM 不认的字段。

> **qwen3 系必须关思维链**：不显式关，模型会把 `max_tokens` 全部烧在推理上，正文一个字都出不来
> （表现为 assistant 消息只有 thinking 块）。pi-ai 不认识 vLLM 的 `chat_template_kwargs`，
> 所以借 `onPayload` 钩子注入 `enable_thinking: false`（由 `BM_LLM_DISABLE_THINKING` 控制，默认 true），
> 与直连路径行为保持一致。

### 10.2 四项治理能力

| 能力 | 实现 | 参数 |
|---|---|---|
| **并发** | `semaphore.ts` 令牌信号量 —— **只控制模型并发**，数据源限流是 M10 的职责，任务并发预算在 M12 | `BM_LLM_CONCURRENCY`（默认 4） |
| **超时** | 流式语义 = **相邻两个 chunk 的最大间隔**（即**空闲超时**，不是总时长）：长生成合法、静默非法 | `BM_LLM_TIMEOUT_MS`（默认 300s） |
| **重试** | 指数/固定退避，`callId` 加 `#retry${i}` 后缀以便事后区分 | `BM_LLM_MAX_RETRIES`（默认 2） |
| **熔断** | 只统计**端点级失败**（超时/连接/5xx）；连续失败达阈值 → 快速失败，避免病态端点把任务拖成小时级 | `BM_LLM_BREAKER_THRESHOLD`（默认 3）、`BM_LLM_BREAKER_COOLDOWN_MS`（默认 120s） |

熔断状态可从 `GET /health` 的 `llm.breaker` 读到（`{ open, consecutiveFailures, reopenInMs, trips }`），
控制台的「模型端点健康指示」用它。

**超时设 300s 的理由**（`.env.example` 注释）：自建端点有冷启动 ——
模型未驻留时请求会先"连上但不吐 token"好几分钟，冷启动完成后同一次请求会正常返回。
设太短会在冷启动期间误判失败。因此**任何阶段的预算都不低于它 + 60s**（§7.1）。

### 10.3 成本记账

- `cost.ts`：按 `BM_PRICE_INPUT_PER_1K` / `BM_PRICE_OUTPUT_PER_1K`（元/千 token）估算；
- 每次调用写一行 `usage_records`（`model` / `input_tokens` / `output_tokens` / `cached_tokens` / `cost_amount`）；
- 阶段成本累计进 `job_phases.cost_json`，任务级汇总见 `GET /jobs/:id/usage` / `job.done.usage`；
- 金额统一 `{ currency: "CNY", amount }`，单位「元」；
- `mock` 模式下成本为 0 且不写 usage（`BM_LLM_MODE=mock` 时 `health()` 直接返回 `ok: true, error: "mock 模式"`）。

---

## 11. 接入层与控制台

### 11.1 网关（M1）

`apps/gateway/src/`，5 个文件：`main.ts`（启动）、`server.ts`（路由 + SSE）、
`container.ts`（装配根）、`static.ts`（静态托管）、`bootstrap.ts`（未构建引导页）。

**用 `node:http` 手写路由，不引 Fastify**（`server.ts` 文件头）：
交付面上少一个依赖，SSE 的行为反而更可控（不会被框架的压缩/缓冲中间件干扰）。

**鉴权**：`Authorization: Bearer t.<tenantId>.<userId>`（Phase 1 本地实现）。
接 OIDC 时只替换 `server.ts` 的 `authenticate` 一个函数。
租户上下文（`TenantContext`）贯穿全链路，是闸门 tenant 检查的依据。

### 11.2 HTTP API（`/api/v1`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health`（也挂 `/api/v1/health`） | 健康与配置：LLM 模式/端点/模型/**熔断状态**、`web.{built,dist,builtAt}` |
| POST | `/jobs` | 创建任务（`Idempotency-Key` 头） |
| GET | `/jobs` | 任务列表 |
| GET | `/jobs/:id` | 任务详情 |
| GET | `/jobs/:id/phases` | 阶段状态（尝试次数/成本/降级原因） |
| GET | `/jobs/:id/usage` | Token 与成本（按阶段拆分） |
| GET | `/jobs/:id/ledger` | 血缘台账 |
| GET | `/jobs/:id/artifacts` | 产物清单 |
| GET | `/jobs/:id/artifacts/:kind` | 单个产物内容（html / markdown / json） |
| GET | `/jobs/:id/report` | 渲染后的 HTML 报告 |
| GET | `/jobs/:id/stream` | **SSE 事件流**（支持 `Last-Event-ID` 续传） |
| POST | `/jobs/:id/cancel` | 取消 |
| POST | `/jobs/:id/rerun/:phase` | 单模块联动重算（该阶段及下游） |
| POST | `/recover` | 崩溃恢复（扫遗留未完成任务） |
| GET / POST | `/sources` | 数据源登记 / 列表 |
| GET / POST | `/authz` | 授权查询 / 授予 |
| POST | `/brief/parse` | 自然语言 Brief 解析（结果回填表单，不直接提交） |
| GET | `/kb/stats` | 库况统计 |
| POST | `/kb/retrieve` | 检索测试 |
| POST / GET / DELETE | `/kb/documents` | KB 入库 / 列表 / 删除 |
| GET | `/audit` | 审计明细与汇总 |

**除 `/health` 外所有路径都要求 Bearer**（`server.ts:82-107`）；非 `/api/v1` 前缀的 GET 一律走静态托管。

### 11.3 静态托管与安全边界

`static.ts` 有三处刻意的设计：

1. **用 `import.meta.url` 定位产物目录**，不用 `process.cwd()` ——
   网关可能被从任意工作目录启动（`npm start` / `node dist/main.js` / systemd unit），
   只有模块自身的位置是稳定的。`BM_WEB_DIST` 可覆盖（给"前端由 CDN 发布、网关只做回退"的部署留口子）。
2. **路径穿越守卫**，且**在鉴权之前**执行 —— `tests/web-console.test.ts` 用
   "越界目标真实存在"的写法把关（弱化这条守卫测试会红）。
3. **缓存策略**：哈希资源 `immutable` 长缓存，入口 HTML `no-cache`
   （否则部署后用户拿不到新前端）。

产物不存在时**不报错**，由调用方回退到 `bootstrapHtml()` 轻量引导页 ——
这样 `git clone && npm start` 依然可用，不需要先跑一次前端构建才能看到界面。

> ⚠️ 网关的优雅关闭有个已知问题：`main.ts` 的 shutdown 走 `server.close()`，
> 而浏览器持有的 SSE 长连接让回调**永远不返回** → 进程半死（不接新连接、端口不放），
> 只能 `kill -9`。见 §14。

### 11.4 控制台前端（`apps/web`）

React 18.3 + Ant Design 5 + Vite 5，**产物由网关托管，同一个端口**（8787）。

| 页面 | 职责 |
|---|---|
| 新建任务 | Brief 结构化表单 + 一句话自然语言录入（解析结果**回填表单**，结构化字段仍是唯一提交契约；目标权重实时求和，≠1 时禁用提交） |
| 任务列表 | 状态/进度/降级/预算一览，5 秒自动刷新（可关），入口提供崩溃恢复扫描 |
| 任务详情 | 六阶段看板、模型正文与工具调用流式回显、终端风事件流（正常/降级/拦截三色）、报告内嵌预览、8 类产物预览下载、治理台账、重跑任意阶段/取消 |
| 知识库 | KB 入库、检索测试、库况统计 |
| 数据源与审计 | 数据源登记、授权授予、审计明细与汇总 |

**五条关键取舍**（`docs/frontend-console.md` 有完整版）：

1. **页面本身无需鉴权**（只是静态表单），但页内所有 API 调用都带 `Authorization: Bearer ...`；
2. **SSE 与报告预览用 `fetch` + `ReadableStream` / blob URL，不用 `EventSource` / `<iframe src>`** ——
   后两者带不了请求头，用它们就得把 token 塞进 URL（会进访问日志与 Referer）；
3. **流式增量写入 ref 并用 `requestAnimationFrame` 合帧** —— 一次真实任务有 1.6 万条 `agent.delta`，
   逐条 `setState` 会卡死；
4. **路由用 `HashRouter`**：网关只处理 `/` 与 `/assets/*`，不对未知路径做 SPA 兜底
   （否则真 404 被吞掉）；
5. **`apps/web` 只依赖 `packages/contracts`**（§3.2）—— `PHASE_LABEL`、`KB_COLLECTIONS`、
   `POPULAR_PLATFORMS`、各类记录类型都以契约为单一事实源。

`npm run web:dev` 起 Vite 5173，`/api` 与 `/health` 代理到 8787（改前端即时生效）；
`npm run web:build` 产出 `apps/web/dist`，**改完前端要重启网关**（dist 目录在启动时解析一次）。

### 11.5 装配根（`container.ts`）

`container.ts` 是**唯一的组合根**：按依赖顺序构造 config → storage → datasources → governance →
knowledge → model-gateway → agent-pack → render → orchestrator → gateway，并把它们串起来。

它也是**跨层胶水的唯一合法位置**。典型例子：报告摘要回灌需要同时看见 `orchestrator` 与 `knowledge`，
但依赖矩阵不允许 orchestrator 依赖 knowledge —— 于是编排层只暴露 `onReportReady` 钩子，
真正实现放在 container（它可以同时看到两边）。

---

## 12. 质量保障

### 12.1 测试体系

`npm test` = **17 个文件 / 218 个用例，全部离线可跑**：

```
BM_LLM_MODE=mock BM_ALLOW_DEMO_DATA=true BM_MC_ENABLED=false BM_MC_LICENSE_ACK=false \
BM_MC_COLLECTOR_URL= BM_VECTOR_DRIVER=memory BM_EMBED_URL= BM_EMBED_MODEL= \
node --import tsx --test tests/*.test.ts
```

隔离变量的作用：强制 mock 模型、**关闭平台采集**（不发外部请求）、
**关掉向量与嵌入**（不依赖 Docker）。因此 CI 里可以无条件执行。

清单见附录 B。几条值得单独说的设计：

- **确定性优先**：全部用例在 mock 模式下运行，`e2e.test.ts` 对应 LLD §7.3 的强制 E2E 清单，
  命名与清单一致；
- **打桩而非跳过**：`platform-collect` / `web-search` 用例打桩 `globalThis.fetch`，
  既验证了真实解析逻辑，又不触碰外部服务；
- **防漂移用例**：`schema-coverage.test.ts` 遍历 `BLOCK_TYPES`，强制"新增块型时必须同步三处"
  （联合类型、骨架、页面角色）—— 加第 11 种块型时编译器**不会**提醒你；
- **钉住"口径错误"而非"功能坏了"**：`governance-fixes.test.ts` 的三条不变量原先没有任何用例失败
  （功能是对的、口径是错的），只能专门写测试钉住。

### 12.2 架构边界检查

`npm run check:boundaries`（§3.2）：白名单 / 叶子约束 / 反向依赖 / 环检测，任一违反即构建失败。

### 12.3 两套 tsconfig

根 `tsconfig.json` **exclude 了 `apps/web`**（它有自己的 jsx + DOM 配置）。
`npm run typecheck` 串行跑两条，两条都要绿。

### 12.4 golden 快照

`tests/golden/report.depth.json`（slides 16，含机械附录页）：mock 路径合成的报告结构快照，
用于发现"报告结构被意外改动"。改合成结构后需 `BM_UPDATE_GOLDEN=1` 重新生成。

---

## 13. 关键设计取舍

按"如果不知道这条，就会改错"排序：

| # | 取舍 | 为什么 |
|---|---|---|
| 1 | **闸门是唯一通路，来源由代码绑定** | 若来源由模型在参数里自报，模型传另一个已登记的 sourceId 就能让闸门检查错对象 —— 闸门形同虚设（§7.3） |
| 2 | **宁可不出报告，也不出无来源数字的报告** | `E-RENDER-001` 拒绝渲染是**刻意**的：一份看起来正常的编造报告比明确的"无数据"危险得多 |
| 3 | **缺失不是 0** | `comparison.dropped`（声明共有但全 0）与 `platformsSkipped` 必须如实写；0 会被读成"实测为零" |
| 4 | **平台能力用一个聚合工具暴露** | "哪些指标可比"是确定性计算，恰是 LLM 最易错的地方；七个同形工具并列时模型必然自己手工合并（§7.4） |
| 5 | **三级降级 + 如实文案** | 任何一级失败都不中断任务；但降级原因必须区分"模型不可用"（`E-AGENT-002`）与"输出没通过校验"（`E-AGENT-001`，多为截断） |
| 6 | **模型从不生成 URL** | 平台条目引用的 URL / 发布时间由渲染层拿 `entryId` 反查证据表拼接 —— 编链接这条路在结构上不通 |
| 7 | **机械附录页由系统生成** | "本次引用了几条真实条目"不可能被模型美化 |
| 8 | **深度下限必须是可达解** | 把链路产不出的块型写进下限，等于给出不可能达成的约束（`image` 就是这种，§5.5） |
| 9 | **进度必须同时落库** | 列表页轮询与刷新后都只读 `jobs.percent`；只 publish 不写库会让前端永远看到 0%（§4.6） |
| 10 | **delta 与状态事件分桶缓冲** | 一次任务 1.6 万条 delta，混在一起按 seq 裁剪会把状态事件挤出窗口（§4.6） |
| 11 | **写操作默认关闭且必须挂 authz** | 公开采集类工具包普遍读写同包，整包封装会让模型以甲方名义产生副作用（§7.3） |
| 12 | **SQLite 是唯一真相源，Milvus 是旁路** | 向量与 chunk 同事务读写；Milvus 挂了只降级，不阻塞检索 |
| 13 | **空结果不进缓存** | 否则"首次排队采集 → 重试"会被自己的空缓存堵死 |
| 14 | **前端只依赖 contracts** | 后端加阶段/库位时，前端要么编译报错、要么自动跟上 |
| 15 | **非商用许可做成三道门** | 把"引入一个非商用组件"固化成必须显式做的决定，而不是顺手配个地址就悄悄生效（§8.6） |

---

## 14. 已知不一致与待修

文档与实现不一致时**以实现为准**；下面是核对过程中发现的漂移。
带日期标记的条目是**已处理**的（保留记录，便于回看"为什么当初是那样"）：

| # | 位置 | 现状 | 实情 |
|---|---|---|---|
| 1 | `README.md`「快速开始」 | 曾写 "npm test # 135 个用例" | 实际 **213**（§12.1，2026-10-14 当日数值；同日多次增补后为 **218**）→ **2026-10-14 已同步**；同段的"不构建则回退内置零构建控制台"也一并改为"返回内置引导页" |
| 2 | `README.md` 架构图 | `render  M16 渲染` | 渲染是 **M11**；M16 在代码里不存在（`check-boundaries.ts` 的注释也误写为 M16） |
| 3 | `README.md` | "不构建则回退内置零构建控制台" | 旧控制台（`console.ts` + `/console-legacy`）**已删除**，现在返回引导页（§11.3） |
| 4 | `README.md` | "七个平台采集已接入…17 个工具" 类表述 | 工具总数 **18**：10 个通用 + `platform_digest` + 7 个 hidden 原语（§7.2） |
| 5 | `.env.example` 第 9 行 | "回退到内置零构建控制台（/console-legacy）" | 已改为"返回内置引导页"（本次顺带修正） |
| 6 | `.env.example` | 未列 `BM_LLM_BREAKER_THRESHOLD` / `BM_LLM_BREAKER_COOLDOWN_MS` | 二者仅存在于 `config` 代码默认值（3 / 120s，§10.2） |
| 7 | 项目记忆 / 部分注释 | "七平台 `kind=creator` 一个都产不出" | 内核 `save_creator` **已实现**真正落盘主页公开统计（`store/{bilibili,douyin,kuaishou,weibo,xhs,tieba}/__init__.py`），抖音/小红书/B站/微博/贴吧均已接 |
| 8 | — | M6（解析）、M12（运行时约束）、M13（观测） | **没有独立模块**，只有配置项（`BM_PARSER_*` / `BM_MAX_JOB_MINUTES` / `BM_TRACE_*`）与 `knowledge/parser.ts` |
| 9 | `Config.parser.fallback` | 定义了 `fallback: "mineru" \| "textonly" \| "none"` 并读 `BM_PARSER_FALLBACK` | **全仓零消费**（`createParser()` 只看 `url`）。而且"解析器挂了就退回纯文本"本就**刻意不做** —— 那会产出能检索、能被引用、但毫无意义的乱码 chunk → **2026-10-14 删除字段与 `.env.example` 条目**（选择删而不是接活） |
| 10 | 各平台 `media_platform/*/core.py` 的 `close()` | 七个平台都实现了 | `run.py:_run()` 只调 `await crawler.start()`，**从不调 `close()`** → `CDPBrowserManager.cleanup()` 那条优雅关闭路径成了死代码，浏览器只能靠 `atexit` / 信号兜底；而 collector 超时是先 SIGTERM 再 **SIGKILL**，SIGKILL 不跑 atexit → 漏孤儿窗口 → **2026-10-14 在 `_run()` 加 `try/finally` 调 `close()`** |
| 11 | collector 采集窗口行为 | `BM_MC_CDP=auto` 时**每个采集任务都新开一个浏览器** | 一次报告 20 个任务 = 20 次窗口闪烁，且**报告交付后仍在弹**（补采任务落在报告之后才派生，见 §8.5） → **2026-10-14 新增 `reuse` 模式并设为默认** |
| 12 | `agents.ts:platformPrefetchArgs()` | `keyword: brief.category` —— **逐字**当平台搜索词用 | `category` 一身兼两职：分类标签 + **平台内搜索关键词**。`INDUSTRY_LEXICON` 只覆盖美妆/食品/服饰，耳机这类品类规则段命中不了 → intake 退到 LLM 补全 → 模型在**没有任何形态约束**下给出英文标识符（`consumer_electronics` / `headphones`）→ 实测小红书返回 **0 条**、抖音 14 条里混进 3 条英语教学视频（"英文K歌屋：Headphones On"），报告落到「**本次任务未采集到任何平台公开内容**」 → **2026-10-14 词表补 `3C数码`、`FILL_PROMPT` 加第 7 条约束（必须中文短语）、`platformPrefetchArgs` 补注释、新增回归用例 WP-C-11** |

> 注：条目 12 只是把 `category` 说清楚，**没有解耦**——`category` 仍是搜索词。新增品类时**优先补词表**，
> 不要指望模型每次都给中文（模型只在词表未命中时才被叫到，而那时它没有约束可依）。

| # | 位置 | 现状 | 实情 |
|---|---|---|---|
| 13 | `agent-pack/src/synthesis.ts` **兜底合成** | `synthIntel` 把「成分党 / 平价替代 / 医研背书」（**护肤品**题材）三个竞品**硬编码**在确定性兜底路径里，并把公开检索命中的**站点名**当品牌名拼进去；`synthReport` 的快捷结论写死"已识别三类定位坐标（成分党 / 平价替代 / 医研背书）"；`quote` 块硬抄 `scripts/seed.ts` 的演示种子「达人种草占比 45% 时 ROI 最优（2.3）」并署名"KB-2 内部复盘" | 模型不可用时（该次任务 LLM 报 E-AGENT-002）耳机报告渲染出「**头部成分党（Global Information, Inc. (GII)）**」：① 类目错 —— 耳机报告在讲"成分浓度"；② 主体错 —— GII 是市场研究出版机构，不是品牌。整张"竞品格局对比"表不可用；`quote` 块在 KB 无该条目时等于**无源假引用** → **2026-10-14 竞品集改为取自 `brief.brandIds`（不足 3 家时补"其他竞品 X（未识别）"中性占位以过 Schema 的 ≥3 下限）、分析字段一律标"待核验"、快捷结论按 brief 如实叙述、`quote` 换成不承载数字的口径说明；新增 2 条回归用例（`data-provenance.test.ts`）** |
| 14 | `Brief.brandIds`（`contracts/src/job.ts`） | 曾只有 `brandIds: string[]`，**没有"我方品牌"字段** | 同一个字段被两处按**相反**语义消费：`buildBrandSelf()` 与 `report.meta.brand` 当「我方品牌」，而「竞品格局对比」表与「品牌 vs 竞品差距矩阵」当**竞品集**（矩阵列头即「我方 \| 索尼 \| Bose \| 华为 \| 小米」）→ 后果：**「品牌自诊概览」页在任何 brief 下都填不实**，未授权时只能整页写「无数据」。→ **2026-10-14 修**：新增**可选**字段 `Brief.ownBrandId` 承接"我是谁"；`brandIds` **只**表示"本轮在投/在看的品牌集合"。**未指定 `ownBrandId` 时报告整份不做品牌自诊**：删去「品牌自诊概览」「品牌 vs 竞品差距矩阵」两页，代之以纯市场的**「竞品定位矩阵」**页（保住 `matrix` 可视化块与"竞品怎么分布"这个市场结论），`quote`/`matrix` 等必需块型不受影响；`meta.brand` 优先取 `ownBrandId`。回归用例 `brand-self.test.ts` **WP-B-8**（未指定时不得出现「我方 / 本品」字样）；WP-B-6/WP-B-7 的 fixture 显式给了 `ownBrandId`（行走的是"已指定"分支）。报告提示词（RG）同步条件化，CI 的 `brandSelf` 仍为结构必填但**只有指定自有品牌时才会进报告** |
| 15 | `agents.ts:platformPrefetchArgs()` **预采集覆盖范围** | 曾为「**全部已装配平台**」（brief 声明的只是"优先级"），注释理由是"只按 brief 收窄会让已接入平台在报告里被写成「未使用的来源」，读起来像没接上" | 这个理由**与报告的实际行为不符**：手机报告（brief 只要 `douyin/xiaohongshu/bilibili`）的来源声明 exclusions 里本来就写着「快手 / 微博 / 贴吧 / 知乎 **不在本次调研范围**」—— 采了照样进排除项，说明这批数据从产出到引用整条链路没有一处会用到它，而每个平台是一轮分钟级 Playwright 子进程 → **2026-10-14 加 `BM_MC_PREFETCH_SCOPE`（默认 `brief`）**：默认只采 brief 声明的平台（映射后按已装配过滤）；brief 声明了但一个都没装配 → 不投递（不改成采别的平台）；brief 没声明平台 → 不设范围退回全部已装配（防"没声明就没数据"的悬崖）。`all` 保留为回退开关。范围只约束自动预取，`platform_digest` 仍接受全部七个采集码（§8.5） |

**其它值得知道的边界**：

- `apps/gateway` 的优雅关闭对 SSE 长连接无效（§11.3），部署脚本应使用 `kill -9` 或超时兜底；
- 各平台 `login.py` 的选择器是 DOM 硬编码，平台改版即失效；**除贴吧外六平台仍是上游原样**（§8.5）；
- 粉丝画像（年龄/性别/地域）在公开 Web 接口层**一个平台都拿不到**，只能走 L1 官方通道（§8.7）；
- `BM_VECTOR_DRIVER=milvus` 但 `BM_EMBED_URL` 为空时，语义通道**完全关闭且不记降级**
  （装配层只有启动告警），排查"检索怎么变笨了"时要先看这两个变量（§9.3）。

---

## 附录 A · 模块-文件对照表

> 机械生成（`packages/*/src` + `apps/*/src`）。行数为 2026-10-13 快照。


**`apps/collector`** — 8 个文件 / 1963 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/tasks.ts` | 468 | 采集任务管理。 |
| `src/core-runner.ts` | 466 | 内嵌采集内核（`services/collector-core`）的**子进程驱动**。 |
| `src/normalize.ts` | 321 | 平台原始记录 → 统一行 的归一化。 |
| `src/server.ts` | 243 | collector 的 HTTP 面。 |
| `src/store.ts` | 161 | 采集结果的本地只读缓存。 |
| `src/config.ts` | 150 | collector sidecar 自己的配置。 |
| `src/browser-session.ts` | 78 | 常驻采集浏览器的查找与回收。 |
| `src/main.ts` | 76 | collector sidecar 入口。 |

**`apps/gateway`** — 5 个文件 / 907 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/server.ts` | 503 | M1 Gateway 接入网关：对外唯一入口 |
| `src/container.ts` | 179 | 装配根（Composition Root） |
| `src/static.ts` | 105 | 前端构建产物托管（React + Ant Design 控制台）。 |
| `src/bootstrap.ts` | 72 | 前端未构建时的引导页（替代已删除的零构建旧控制台）。 |
| `src/main.ts` | 48 |  |

**`apps/web`** — 24 个文件 / 3652 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/pages/KnowledgePage.tsx` | 414 |  |
| `src/pages/NewJobPage.tsx` | 403 |  |
| `src/pages/JobDetailPage.tsx` | 393 |  |
| `src/pages/GovernancePage.tsx` | 363 |  |
| `src/hooks/useJobStream.ts` | 312 | 任务 SSE 实时流。 |
| `src/components/ArtifactPanel.tsx` | 176 | 产物面板。 |
| `src/api/types.ts` | 171 | 接口返回类型。 |
| `src/pages/JobListPage.tsx` | 161 |  |
| `src/api/endpoints.ts` | 155 | 接口清单。 |
| `src/components/ReportPreview.tsx` | 149 | 报告内嵌预览。 |
| `src/api/client.ts` | 148 | 统一请求层。 |
| `src/theme.ts` | 91 | Ant Design 主题令牌。 |
| `src/components/PhaseBoard.tsx` | 90 | 六阶段看板。 |
| `src/hooks/useAsync.ts` | 90 | 数据获取与轮询小工具。 |
| `src/components/EventTerminal.tsx` | 83 | 事件流终端。 |
| `src/components/LiveConsole.tsx` | 83 | 模型流式回显。 |
| `src/components/AppShell.tsx` | 76 |  |
| `src/components/TokenBox.tsx` | 61 | 令牌输入框。 |
| `src/api/session.ts` | 57 | 会话令牌存储。 |
| `src/App.tsx` | 51 | 路由用 HashRouter 而不是 BrowserRouter。 |
| `src/utils/download.ts` | 37 | 下载取回的内容。 |
| `src/components/HealthBadge.tsx` | 36 | 模型端点健康指示。 |
| `src/main.tsx` | 32 | 刻意不套 `<StrictMode>`。 |
| `src/components/StatusTag.tsx` | 20 | 任务/阶段状态标签。 |

**`packages/agent-pack`** — 9 个文件 / 7233 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/synthesis.ts` | 2067 | 确定性合成（degraded synthesis） |
| `src/agents.ts` | 1612 | M9 AgentPack 运行时：把六个 Agent 与 Pi 框架真正接起来 |
| `src/schemas.ts` | 1334 | 六个阶段的结构化输出 Schema（对应 LLD §2.10） |
| `src/tool-impls.ts` | 1165 | 工具的实现（对应 LLD §2.10 的「依赖工具」列） |
| `src/tools.ts` | 387 | M10 ToolRegistry：工具注册与治理（对应 LLD §2.11） |
| `src/brief-parse.ts` | 222 | 自然语言 Brief 解析 —— **LLM 补全段**。 |
| `src/prompts.ts` | 217 | 六个 Agent 的系统提示词（对应 LLD §2.10 的「通用约定」五条） |
| `src/evidence.ts` | 154 | 平台采集证据登记表（P0 报告溯源）。 |
| `src/index.ts` | 75 | @brandsale/agent-pack —— M9 AgentPack + M10 ToolRegistry |

**`packages/config`** — 1 个文件 / 681 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/index.ts` | 681 | 配置加载（对应 LLD §7.2） |

**`packages/contracts`** — 12 个文件 / 2693 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/report.ts` | 774 | 报告 DSL（对应 LLD §4.4） |
| `src/kb.ts` | 478 | M7 KnowledgeService / M8 PricingStore 的对外契约 |
| `src/brief-parse.ts` | 444 | 自然语言 Brief 解析 —— **规则段**（纯函数，零依赖）。 |
| `src/report-depth.ts` | 167 | 报告深度策略（P1-2） |
| `src/agent.ts` | 160 | M9 AgentPack / M10 ToolRegistry 契约（对应 LLD §2.10、§2.11） |
| `src/job.ts` | 155 | 任务与阶段契约（对应 LLD §3.2、§5） |
| `src/governance.ts` | 132 | M3 GovernanceGate + M5 LineageLedger 的对外契约（对应 LLD §3.4.1 |
| `src/errors.ts` | 127 | 错误码表（对应 LLD §3.7） |
| `src/common.ts` | 102 | 通用约定（对应 LLD §3.1） |
| `src/orchestrator.ts` | 80 | M2 OrchestratorPort 防腐层契约（对应 LLD §2.3） |
| `src/events.ts` | 53 | SSE 事件协议（对应 LLD §3.3） |
| `src/index.ts` | 21 | @brandsale/contracts —— 全系统唯一的接口与 Schema 定义处（LLD §7.1 强制 |

**`packages/datasource`** — 3 个文件 / 563 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/media-crawler.ts` | 219 | M4 平台内公开内容采集适配器（复用 MediaCrawler，经 collector sidecar）。 |
| `src/index.ts` | 216 | M4 DataSourceAdapter 数据源适配层（对应 LLD §2.5） |
| `src/web-search.ts` | 128 | M4 联网检索适配器 —— 火山引擎「联网搜索 Lite」 |

**`packages/governance`** — 5 个文件 / 595 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/gate.ts` | 242 | M3 GovernanceGate（对应 LLD §2.4 / §3.4.1） |
| `src/catalog.ts` | 140 | 来源目录组装（P0-2） |
| `src/source-guard.ts` | 112 | 来源登记不变量 + 入库来源守卫（WP-D2 / WP-A）。 |
| `src/ledger.ts` | 92 | M5 LineageLedger（对应 LLD §2.6） |
| `src/index.ts` | 9 | @brandsale/governance —— M3 GovernanceGate + M5 LineageL |

**`packages/knowledge`** — 9 个文件 / 2695 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/retrieval.ts` | 843 | M7 KnowledgeService：四库管理 + 混合检索 + 重排 + 降级 |
| `src/semantic-memory.ts` | 637 | SemanticMemory —— 语义记忆库（EmbeddingGemma 2 + Milvus） |
| `src/embedding.ts` | 296 | EmbeddingProvider —— 检索语义通道的可插拔向量来源（P2） |
| `src/summarize.ts` | 241 | 报告摘要抽取（P1）—— 纯函数、零 I/O、可单测 |
| `src/parser.ts` | 211 | 文档解析器（P1-5）：把上传的二进制文档转成可切分的纯文本。 |
| `src/pricing.ts` | 201 | M8 PricingStore：达人报价的结构化查询与偏差收敛 |
| `src/vector-index.ts` | 128 | VectorIndex —— 可选的外部向量索引（P3，默认关闭） |
| `src/confidence.ts` | 75 | 置信度策略（对应 LLD §3.4.2） |
| `src/index.ts` | 63 | @brandsale/knowledge —— M7 KnowledgeService + M8 Pricing |

**`packages/model-gateway`** — 6 个文件 / 899 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/gateway.ts` | 416 | M14 ModelGateway（对应 LLD §2.15） |
| `src/client.ts` | 281 | OpenAI 兼容 Chat Completions 客户端。 |
| `src/pi.ts` | 84 | Pi 框架接入点（pi-ai / pi-agent-core） |
| `src/semaphore.ts` | 62 | 令牌信号量：M14 只控制「模型并发」，数据源限流是 M10 的职责。 |
| `src/cost.ts` | 46 | 成本核算（M14）。金额单位统一为「元」。 |
| `src/index.ts` | 10 | @brandsale/model-gateway —— M14 模型网关 |

**`packages/orchestrator`** — 3 个文件 / 663 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/pipeline.ts` | 553 | M2 OrchestratorPort 实现（对应 LLD §2.3 + §2.13） |
| `src/event-bus.ts` | 103 | 事件总线：把阶段产出实时推给 SSE 客户端，同时落库做断线重放。 |
| `src/index.ts` | 7 | @brandsale/orchestrator —— M2 编排端口（防腐层）+ 事件总线 |

**`packages/render`** — 1 个文件 / 672 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/index.ts` | 672 | M11 RenderService：报告 DSL → Markdown / HTML |

**`packages/storage`** — 4 个文件 / 1238 行

| 文件 | 行数 | 职责（文件头首句） |
|---|---:|---|
| `src/repos.ts` | 789 | 仓储实现（M15）。所有 SQL 都集中在这里，上层只操作类型化对象。 |
| `src/db.ts` | 389 | M15 Storage 层：SQLite 实现（对应 LLD §4.2 DDL） |
| `src/cli.ts` | 40 | 存储 CLI：迁移 / 状态查询 |
| `src/index.ts` | 20 | @brandsale/storage —— M15 存储层 |

## 附录 B · 测试清单

| 测试文件 | 用例 | 行数 | 守住什么 |
|---|---:|---:|---|
| `brand-self.test.ts` | 8 | 166 | 品牌自诊在"无授权数据"时必须如实写「无数据」，而不是编数字；**未指定自有品牌（`ownBrandId`）时整份报告不做自诊、且不得出现「我方/本品」字样** |
| `brief-llm-fill.test.ts` | 6 | 151 | 规则抽取结果的权威性：模型只能补空字段，不能改预算/时间窗 |
| `brief-parse.test.ts` | 12 | 167 | 自然语言解析（规则段）纯函数、中英混合输入；**category 会被逐字当平台搜索词，必须是中文** |
| `collector.test.ts` | 44 | 1282 | sidecar 归一化、落盘目录契约、快照取新增行、ID 闭环、常驻浏览器端口与回收 |
| `data-provenance.test.ts` | 18 | 655 | 条目级溯源不依赖模型自觉（证据登记 → 引用 → 渲染反查）；含**兜底路径不得写死行业文案**的回归 |
| `data-realism.test.ts` | 13 | 436 | 不引用本地样例数据；样例达人不得出现在报告里 |
| `e2e.test.ts` | 13 | 577 | LLD §7.3 强制 E2E 清单（mock 模式，全离线） |
| `governance-fixes.test.ts` | 6 | 186 | 治理口径的三个不变量（口径错了不会有用例失败，只能专门钉） |
| `kb-ingest.test.ts` | 15 | 508 | KB 入库通道、来源登记不变量、mutating 工具准入 |
| `platform-collect.test.ts` | 27 | 780 | 七平台工具与适配器（打桩 fetch，不碰 MediaCrawler）；**预采集覆盖范围 = brief 声明的平台**（`BM_MC_PREFETCH_SCOPE`） |
| `report-repair.test.ts` | 11 | 304 | 自动修复的分级语义与四条不变量（含"修复不得制造新错误"） |
| `report-summary.test.ts` | 16 | 500 | 摘要回灌 + 向量落盘 + 模型混用守卫 |
| `schema-coverage.test.ts` | 4 | 138 | 骨架/块型/页面角色的防漂移（加第 11 种块型时编译器不会提醒） |
| `stream-replay.test.ts` | 5 | 219 | 进度实时性与刷新后流式回放 |
| `tool-call-guard.test.ts` | 5 | 67 | 工具调用风暴闸门（真机曾出现同一工具连续被调 131 次） |
| `web-console.test.ts` | 5 | 214 | 前端托管契约（含路径穿越守卫） |
| `web-search.test.ts` | 10 | 313 | 唯一外部计费源（打桩 fetch） |
| **合计** | **218** | **≈6663** | 17 个文件 |

## 附录 C · 环境变量

共 **83 个变量 / 19 个分组**，完整清单与逐条注释见仓库根 `.env.example`（单一事实源）。
按分组概览：

### C.1 分组与变量总览（默认值取自 `.env.example`）


**运行环境**（3 个）

`BM_ENV`=`dev` · `BM_HTTP_PORT`=`8787` · `BM_DATA_DIR`=`./.data`

**前端控制台（React 版）**（0 个）



**存储**（1 个）

`BM_STORAGE_DRIVER`=`sqlite`

**模型网关 M14**（11 个）

`BM_LLM_MODE`=`live` · `BM_LLM_BASE_URL`=`http://124.174.44.116:8000/v1` · `BM_LLM_API_KEY`=`sk-local-dev` · `BM_MODEL_STRONG`=`qwen3.8-flash-next` · `BM_MODEL_MEDIUM`=`qwen3.8-flash-next` · `BM_MODEL_LIGHT`=`qwen3.8-flash-next` · `BM_LLM_CONCURRENCY`=`4` · `BM_LLM_TIMEOUT_MS`=`300000` · `BM_LLM_MAX_RETRIES`=`2` · `BM_LLM_MAX_OUTPUT_TOKENS`=`4096` · `BM_LLM_DISABLE_THINKING`=`true`

**成本（元 / 千 token，仅用于估算与门禁）**（2 个）

`BM_PRICE_INPUT_PER_1K`=`0.001` · `BM_PRICE_OUTPUT_PER_1K`=`0.002`

**检索 M7**（15 个）

`BM_VECTOR_DRIVER`=`memory` · `BM_EMBED_URL`=`http://127.0.0.1:8899/v1/embeddings` · `BM_EMBED_MODEL`=`embeddinggemma-2` · `BM_EMBED_DIM`=`768` · `BM_EMBED_BATCH_SIZE`=`32` · `BM_EMBED_TIMEOUT_MS`=`60000` · `BM_MILVUS_URI`=`http://127.0.0.1:19530` · `BM_MILVUS_COLLECTION`=`brandsale_kb` · `BM_MILVUS_TOKEN`=`（空）` · `BM_MILVUS_TIMEOUT_MS`=`3000` · `BM_RERANK_URL`=`（空）` · `BM_RERANK_MODEL`=`（空）` · `BM_RERANK_POOL_SIZE`=`50` · `BM_RERANK_TIMEOUT_MS`=`30000` · `BM_RERANK_COOLDOWN_MS`=`30000`

**知识库回灌 M7**（1 个）

`BM_SUMMARY_INGEST`=`true`

**解析 M6（Phase 1 用内置 textonly 解析器）**（3 个）

`BM_PARSER_URL`=`（空）` · `BM_PARSER_TIMEOUT_MS`=`60000`

**渲染 M11**（1 个）

`BM_RENDER_ENGINE`=`markdown`

**报告深度预算（P2-2）**（3 个）

`BM_REPORT_MAX_TOKENS`=`32768` · `BM_REPORT_CONTEXT_CHARS`=`48000` · `BM_REPORT_MIN_SLIDES`=`12`

**联网检索（火山引擎「联网搜索 Lite」）**（8 个）

`BM_WEB_SEARCH_ENABLED`=`true` · `BM_WEB_SEARCH_URL`=`https://open.feedcoopapi.com/search_api/web_search` · `BM_WEB_SEARCH_API_KEY`=`（空）` · `BM_WEB_SEARCH_COUNT`=`20` · `BM_WEB_SEARCH_MAX_COUNT`=`50` · `BM_WEB_SEARCH_TIMEOUT_MS`=`8000` · `BM_WEB_SEARCH_CACHE_TTL`=`900` · `BM_WEB_SEARCH_PREFETCH`=`true`

**平台内公开内容采集（七个平台，L3）**（0 个）



**三道门，缺一不可**（7 个）

`BM_MC_ENABLED`=`false` · `BM_MC_LICENSE_ACK`=`false` · `BM_MC_COLLECTOR_URL`=`http://127.0.0.1:8890` · `BM_MC_PLATFORMS`=`xhs,dy,ks,bili,wb,tieba,zhihu` · `BM_MC_PREFETCH_SCOPE`=`brief` · `BM_MC_TIMEOUT_MS`=`15000` · `BM_MC_CACHE_TTL`=`1800`

**collector sidecar（独立进程，npm run collector）**（14 个）

`BM_MC_CORE_DIR`=`services/collector-core` · `BM_MC_PYTHON`=`（空）` · `BM_MC_DATA_DIR`=`（空）` · `BM_MC_LOG_DIR`=`./.data-collector/logs` · `BM_COLLECTOR_DATA`=`./.data-collector` · `BM_COLLECTOR_HOST`=`127.0.0.1` · `BM_COLLECTOR_PORT`=`8890` · `BM_MC_HEADLESS`=`false` · `BM_MC_CDP`=`reuse` · `BM_MC_MAX_ITEMS`=`50` · `BM_MC_MAX_ITEMS_CAP`=`200` · `BM_MC_MASK_NICKNAME`=`false` · `BM_MC_CRAWL_TIMEOUT_MS`=`600000` · `BM_MC_ENV_CHECK_TIMEOUT_MS`=`60000` · `BM_MC_PROFILE_ENRICH`=`true` · `BM_MC_PROFILE_ENRICH_MAX`=`12`

**数据源分级总开关**（4 个）

`BM_L1_ENABLED`=`true` · `BM_L2_ENABLED`=`true` · `BM_L3_ENABLED`=`true` · `BM_L4_ENABLED`=`false`

**工具写能力总开关（安全）**（1 个）

`BM_TOOLS_ALLOW_MUTATING`=`false`

**知识库入库通道 M7（P1-5）**（1 个）

`BM_KB_ALLOW_GLOBAL_WRITE`=`false`

**任务运行时 M12**（2 个）

`BM_MAX_JOB_MINUTES`=`60` · `BM_ALLOW_PARTIAL`=`true`

**数据真实性（业主明确要求）**（1 个）

`BM_ALLOW_DEMO_DATA`=`false`

**观测 M13**（4 个）

`BM_TRACE_CONTENT`=`false` · `BM_OTEL_ENDPOINT`=`（空）` · `BM_LANGFUSE_URL`=`（空）` · `BM_LOG_LEVEL`=`info`

**闸门 M3（必须为 true，仅测试可改）**（1 个）

`BM_GATE_FAIL_CLOSED`=`true`


> 逐条语义与注意事项见 `.env.example` 的注释（那是单一事实源）；
> 代码里的默认值与断言见 `packages/config/src/index.ts`。


# brandsale · 品牌营销 AI 策略咨询系统

基于 **Pi 框架**（pi-agent-core / pi-ai）实现的六阶段多智能体策略咨询流水线。
对应《详细技术设计说明书》（LLD）Phase 1 可运行纵切：Brief → 情报 → 人选 → 打法 → 预算 → 报告。

## 快速开始

```bash
npm install
npm test          # 213 个用例，全离线，不依赖任何外部服务
npm run demo:mock # 离线桩模式跑通全链路（确定性输出）
npm run web:build # 构建前端控制台（可选；不构建则返回内置引导页）
npm start         # 启动 HTTP 网关（dev 模式空库自动灌种子），打开 http://127.0.0.1:8787/
```

接真实模型（OpenAI 兼容端点，如自建 vLLM）：

```bash
cp .env.example .env   # 填 BM_LLM_BASE_URL / BM_LLM_API_KEY / 模型名
                       # 用到联网检索再加 BM_WEB_SEARCH_API_KEY（不填则整体关闭）
npm run demo           # 真实模型端到端
```

已验证的真实端到端（vLLM qwen3.8-flash-next）：6 阶段全部成功、86 次工具调用、
16055 条流式增量、治理验证 5/5 通过、产出合规报告（HTML/Markdown/DSL 三格式）。

## 架构（分层单向依赖）

```
apps/gateway          HTTP + SSE 接入层（鉴权/幂等/协议转换 + 静态托管，唯一入口）
apps/web              控制台前端（React 18 + Ant Design 5，Vite 构建，产物由网关托管）
apps/collector        采集 sidecar（只读归一化 + 缓存，经子进程驱动内嵌采集内核）
packages/
  contracts           纯类型 + 错误码 + 报告DSL（零依赖叶子）
  config              环境变量装配 + 不变量断言
  storage             SQLite 持久化（node:sqlite，迁移/仓储）
  governance          M3 治理闸门（双重开关/租户/语义红线）+ M5 血缘台账
  model-gateway       M14 模型网关（并发/重试/成本/熔断）+ Pi 框架接入
  knowledge           M7 检索（BM25+引用）+ 达人报价库
  datasource          M4 数据源注册表（仅含唯一的真实外部源：联网检索）
  agent-pack          M9 智能体集群（AO/CI/CT/PL/BR/RG）+ 工具治理 + 降级合成
  render              M16 渲染（DSL 不变量校验 + HTML/Markdown）
  orchestrator        编排（检查点/断点续跑/事件总线/SSE 回放）
```

依赖白名单由 `npm run check:boundaries` 强制（越界/反向/环一律构建失败）。
`apps/*` 属于应用层，允许依赖任意包；前端只依赖 `packages/contracts`（纯类型与常量，
零 node 依赖），因此后端加阶段/库位时前端不会悄悄漏渲染——要么编译报错，要么自动跟上。

## 关键设计

- **闸门是唯一通路**：所有数据访问必须过治理闸门；未登记源、法务未批源、
  跨租户、语义红线（如预算超限）全部拦截并写审计。
- **三级降级**：Pi Agent 循环 → 直连结构化输出（校验错误回喂重试）→
  工具实测数据 + 保守模板合成。任何一级失败都不中断任务，缺失项显式进入
  报告「排除项」，绝不静默编造。
- **幂等**：同 Idempotency-Key 同体复用任务，异体 409（指纹 = 深度键排序序列化）。
- **可观测**：血缘台账记录每个阶段的输入源/行数/输出产物；SSE 断线后从
  Last-Event-ID 续传，无 ID 则全量回放；缓冲过期退化为视图快照。
- **模型网关熔断**：连续端点级失败（超时/连接/5xx）达到阈值后快速失败，
  避免病态端点把任务拖成小时级；流式读体用**空闲超时**（长生成合法、静默非法）。
- **不编造数字**：报告 DSL 校验器拒绝无来源数字断言与 L4 引用；模型输出
  无法溯源的指标写 null，渲染层显示"无数据"并降置信度。

## 关于 L1 平台源（已移除）

千川 / 星图 / 蒲公英 / 生意参谋 / 巨量算数 这 5 个适配器**已从代码中删除**。
它们从未接入真实平台，只输出确定性伪随机数（`provenance.synthetic = true`）；
登记在台账里会让报告出现「已授权实测数据」的错觉，这比明确的"无数据"更危险。
连带移除的还有 `query_customer_owned` 与 `query_public_index` 两个工具。

需要平台私有数据时，正确做法是等客户授权后**新增**一个真实适配器并走完整的登记流程。
届时在 `scripts/seed.ts` 的 `BUILTIN_SOURCES` 加回条目，并收紧 `web_search` 的白名单。

## 平台内公开内容采集（七个平台，L3，内嵌 MediaCrawler 内核）

七个平台的内容层采集已接入：小红书 / 抖音 / 快手 / B站 / 微博 / 贴吧 / 知乎。
每个平台一个台账源（`mc_xhs` / `mc_dy` / `mc_ks` / `mc_bili` / `mc_wb` / `mc_tieba` / `mc_zhihu`），
全部 **L3**（公开、未经人工核验、与平台无授权合同），只读、只给 CI/CT 两个角色的白名单。

**模型侧只有一个入口：`platform_digest`（跨平台聚合）。** 它一次覆盖多个平台，
并直接返回 `comparison.metrics` —— 本组平台指标的**交集**，跨平台横向对比只允许落在这上面。
七个单平台工具（`xhs_web` / `douyin_web` / …）仍然注册、仍然逐源过闸门，但标记为对模型隐藏：
它们是受治理的实现原语。把"七平台怎么合并、哪些指标可比"交给模型做，是最容易出错的地方
（七平台全量放在一起时，内容层其实**没有任何共有指标** —— 贴吧无点赞、快手无评论数）。
完整能力矩阵与集成方案见 `docs/platform-capability-integration-plan.md`。

**采集内核已内嵌进本仓库**（`services/collector-core/`），部署上只有 brandsale 一个系统。
链路是三段：

```
services/collector-core（内嵌采集内核 = MediaCrawler 的采集部分）
   │  Python + Playwright：起浏览器、扫码登录、七平台签名与采集，结果落 jsonl
   ▼
apps/collector（只读归一化 sidecar，npm run collector）
   │  以子进程驱动内核、把各平台 jsonl 归一化成统一行、本地缓存，对外只暴露 4 个只读算子
   ▼
packages/datasource 的七个适配器 → 七个工具（同步、按查询、带 provenance）
```

> **唯一的额外前置**是一个 Python 运行时：`npm run collector:setup` 一次装好
> （建 venv + 装依赖 + 下载 chromium）。内核的来源、许可与相对上游的裁剪清单见
> [`services/collector-core/README.md`](./services/collector-core/README.md)。

> ⚠️ **许可证红线**：内嵌的采集内核来自 MediaCrawler，其许可证是
> `NON-COMMERCIAL LEARNING LICENSE 1.1`，
> 条件第 3 条禁止未经版权方书面同意的**任何商业用途**。因此整条链路有三道门，
> 缺一不可：`BM_MC_ENABLED` + **`BM_MC_LICENSE_ACK`（必须显式确认）** + `BM_MC_COLLECTOR_URL`。
> 未确认时七个适配器与七个工具**一律不装配**——把"引入一个非商用组件"固化成一个
> 必须显式做的决定，而不是顺手配个地址就悄悄生效。

**能力边界（重要）**：七平台在**内容层**（搜索/详情/评论/创作者）全部可用；
**粉丝画像**（年龄/性别/地域）在公开 Web 接口层**一个平台都拿不到**——这不是解析问题，
是接口层根本没有这个数据，正道只有 L1 官方通道（抖音开放平台 `fans_data`，需企业主体+审批+达人 OAuth）。
B站 的粉丝/关注列表在 MediaCrawler 源码里是**注释掉的**、入口不可达，因此没有做成算子。

上手步骤（`npm run collector:setup` → 起 collector → 扫码登录 → 开三道门 → 自检）见
[`docs/datasource-integration.md`](./docs/datasource-integration.md) §6；
选型与许可评估见
[`docs/datasource-platform-collection-analysis.md`](./docs/datasource-platform-collection-analysis.md)。

## 报告数据溯源（条目级）

报告里的平台数据可以追溯到**具体某条内容**，且这条链路是机械保证的、不依赖模型自觉：

- 采集工具在返回结果的同时把条目**登记进本任务的证据表**（`intel_evidence` 产物，
  含平台 / 标题 / 摘录 / 原文链接 / 发布时间 / 采集时点）；
- 模型只能引用系统生成的 `entryId`（`pf_<平台>_<id>`），**不产生 URL** ——
  报告里的原文链接、发布时间由渲染层拿 entryId 反查证据表拼接，编造的引用会被
  渲染校验（R13）自动降级为来源级引用；
- 报告末尾有机械生成的「**数据来源与溯源**」附录页：来源声明、按平台 × 算子的采集概览、
  被引用条目清单（每条都能点回原帖），以及「L3 公开采集 / 跨平台不可数值对比」的固定口径。

设计与取舍见 [`docs/data-provenance-design.md`](./docs/data-provenance-design.md)。

## 联网检索（`web_search`）

`volc_web_search` 是**按次计费**的联网检索数据源
（火山引擎「联网搜索 Lite」，抓公开网页）。它不是"给工具开个后门"，而是按既有规则走完整条链：

- **是适配器**：实现 `packages/datasource/src/web-search.ts`，返回标准 `Provenance`；
  台账登记为 `L3`（公开），`synthetic: false`，note 明写"未经人工核验"。
- **过闸门**：工具声明 `boundSourceId = volc_web_search`，闸门据此做 scope/source/authz/tenant
  四项检查。**来源由代码绑定，不由模型参数决定**——否则模型传另一个已登记的 sourceId，
  闸门就会去检查错对象而放过真实来源（见 `packages/agent-pack/src/tools.ts` 的覆盖逻辑）。
- **白名单为全部六个阶段**：早期只开放给 CI（情报）阶段，因为那时千川/星图/蒲公英/
  生意参谋/巨量算数的合成适配器还在注册表里承担取数职责。那些适配器已整体移除，
  公开信息只剩联网检索一条路，白名单随之放开。**代价**：CT 阶段的达人信息可能来自
  公开网页而非报价库，「禁止编造达人」不再由白名单兜底，只剩 prompt 约束与报告阶段的
  引用校验事后拦截——将来接回真实达人库适配器后，应重新收紧 `allowedAgents`。
- **单任务调用有界**：`maxCallsPerJob = 30`。令牌桶只管速率不管总量，模型换个关键词
  就能把同一个源问上百遍，所以计费接口必须另有总额闸门。
- **能力缺席即不暴露**：未配 `BM_WEB_SEARCH_API_KEY` 时适配器不注册，`registerAllTools`
  便不注册该工具——宁可 Agent 工具清单里没有它，也不让它去调一个必然失败的工具。
- **mock 模式绝不联网**：`BM_LLM_MODE=mock` 时 intel 阶段跳过预取，E2E 用例因此可以无条件离线跑。

失败语义与其它源一致：超时 → `E-DATA-001`，接口异常 → `E-DATA-002`，未登记/未授权 →
`E-GOV-001` / `E-DATA-002`，一律计入报告「排除项」，不会静默变成空数据。

配置见 `.env`：`BM_WEB_SEARCH_ENABLED / URL / API_KEY / COUNT / MAX_COUNT / TIMEOUT_MS /
CACHE_TTL / PREFETCH`。相同查询按 TTL 命中缓存（默认 15 分钟），避免重复计费。

## 可视化控制台

React + Ant Design 单页应用，由网关托管构建产物，**同一个端口**（网关 8787）：

- 源码在 `apps/web`（React 18 + Ant Design 5 + Vite），访问 `/`、`/console`；
- 启动网关后打开 **http://127.0.0.1:8787/** 即可；
- 若产物未构建，`/` 会返回构建指引页而不是旧界面（旧的内联 HTML 控制台已移除）。

构建与开发态热更：

```bash
npm run web:build        # 产物输出 apps/web/dist，由网关托管（改前端后需重跑）
npm run web:dev          # Vite 开发服务器 5173，/api 与 /health 代理到 8787（改前端即时生效）
```

四个入口：

- **新建任务** — Brief 结构化表单 + 一句话自然语言录入（解析结果**回填表单**而非直接提交，
  结构化字段仍是唯一提交契约；目标权重实时求和，≠1 时提交按钮禁用）；
- **任务列表** — 状态/进度/降级/预算一览，5 秒自动刷新（可关），入口处提供崩溃恢复扫描；
- **任务详情** — 六阶段看板（状态/尝试次数/成本/降级原因）、模型正文与工具调用的
  流式回显、终端风事件流（正常/降级/拦截三色）、报告内嵌预览、8 类产物预览下载、
  治理台账（每次数据访问的来源与行数）、重跑任意阶段/取消任务；
- **知识库 / 数据源与审计** — KB 入库（来源必须在台账登记且授权有效，否则 E-INGEST-001）、
  检索测试、库况统计；数据源登记、授权授予、审计明细与汇总。

实现要点（详见 `docs/frontend-console.md`）：

- **页面本身无需鉴权**（只是静态表单），但页内所有 API 调用都带 `Authorization: Bearer ...`；
  SSE 与报告预览用 **fetch + ReadableStream/blob** 而非 `EventSource`/`iframe src`
  ——后两者带不了请求头，用它们就得把 token 塞进 URL（会进访问日志与 Referer）；
- 断线重连带 `Last-Event-ID`，服务端只补缺口；缓冲过期时改拉全量详情；
- 流式增量写入 ref 并用 `requestAnimationFrame` 合帧——一次真实任务有 1.6 万条
  `agent.delta`，逐条 setState 会卡死；
- 静态托管带路径穿越守卫与「哈希资源长缓存 / 入口 HTML 不缓存」策略，
  并有专门用例把关（`tests/web-console.test.ts`）；
- `/health` 返回 `web.built / web.dist / web.builtAt`，用于自证"现在跑的是哪一版前端"
  （部署到一半只更新了后端、忘了构建前端时能一眼看出来）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm test` | 全量回归（mock 模式，含前端托管契约） |
| `npm run typecheck` | 后端 + 前端两套 tsconfig 一起查 |
| `npm run check:boundaries` | 架构边界检查 |
| `npm run demo` / `demo:mock` | 端到端演示（真实/离线） |
| `npm run migrate` / `seed` | 建表 / 灌种子 |
| `npm run dev` / `start` | 开发热载 / 启动网关 |
| `npm run web:build` | 构建前端控制台（`apps/web/dist`） |
| `npm run web:dev` | 前端开发服务器（5173，代理到 8787） |

## HTTP API（`/api/v1`）

```
GET  /health                         健康与配置（含熔断状态）
POST /jobs                           创建任务（Idempotency-Key 头）
GET  /jobs                           任务列表
GET  /jobs/:id                       任务详情 /phases /usage /ledger /artifacts
GET  /jobs/:id/artifacts/:kind       单个产物内容（html/markdown/json，控制台下载用）
GET  /jobs/:id/report                渲染后的 HTML 报告
GET  /jobs/:id/stream                SSE 事件流（支持 Last-Event-ID 续传）
POST /jobs/:id/cancel                取消
POST /jobs/:id/rerun/:phase          单模块联动重算（该阶段及下游）
POST /recover                        崩溃恢复（扫遗留 running 任务）
GET/POST /sources /authz             数据源登记与授权
POST /kb/retrieve  GET /kb/stats     检索与库况
GET  /audit                          审计明细与汇总
```

鉴权：`Authorization: Bearer t.<tenantId>.<userId>`（Phase 1 本地实现，
接 OIDC 时只替换 `server.ts` 的 `authenticate` 一个函数）。

## 与 Pi 框架的接触面

`packages/model-gateway/src/pi.ts`：把自建 vLLM 端点包装成 Pi 的
`Model<"openai-completions">` + `StreamFn`，`agent-pack` 用 pi-agent-core 的
`Agent`（工具循环、`beforeToolCall` 白名单钩子）跑六个阶段。
注意：qwen3 系经 pi-ai 调用必须用 `onPayload` 注入
`chat_template_kwargs.enable_thinking=false`，否则推理会烧光 max_tokens，
正文一个字都出不来（详见该文件注释）。

### 两个容易误判成"模型不可用"的坑（都已修复）

1. **输出被 max_tokens 截断 ≠ 端点故障**。ReportDsl 真实体量 ≈8–25KB JSON，
   默认 `BM_LLM_MAX_OUTPUT_TOKENS=4096` 必然截断 → 三次重试每次都恰好
   4096 tokens、解析全失败 → 合成兜底。report 阶段已在
   `MAX_TOKENS_BY_PHASE`（agent-pack）放宽到 16384（Pi 与直连两条路径都覆盖）。
2. **降级文案要如实**。`E-AGENT-002`（调用失败）才叫"模型不可用"；
   `E-AGENT-001`（输出未过校验，多为截断）会写成"模型输出未通过结构校验"。
   RG 提示词另含"数字断言"合规规则：日期/百分比/等级标签都算数字，
   所在页面必须有 citations 或 sourceRef，否则渲染校验会拒绝出报告。

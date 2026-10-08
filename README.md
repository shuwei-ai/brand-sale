# brandsale · 品牌营销 AI 策略咨询系统

基于 **Pi 框架**（pi-agent-core / pi-ai）实现的六阶段多智能体策略咨询流水线。
对应《详细技术设计说明书》（LLD）Phase 1 可运行纵切：Brief → 情报 → 人选 → 打法 → 预算 → 报告。

## 快速开始

```bash
npm install
npm test          # 12 个 E2E 用例，全离线，不依赖任何外部服务
npm run demo:mock # 离线桩模式跑通全链路（确定性输出）
npm start         # 启动 HTTP 网关（dev 模式空库自动灌种子）
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
apps/gateway          HTTP + SSE 接入层（鉴权/幂等/协议转换，唯一入口）
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

## 联网检索（`web_search`，唯一的真实外部源）

`volc_web_search` 是**唯一**会真正发起外部 HTTP 请求的数据源
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

启动网关后直接打开 **http://127.0.0.1:8787/**（或 `/console`）即可，无需构建、无需额外进程：

- **新建任务**：左侧表单填 Brief（权重之和必须为 1，前端会拦），提交后自动建立 SSE 连接；
- **实时进度**：六阶段卡片（状态/尝试次数/成本）、进度条、模型正文与工具调用的流式回显；
- **事件流**：`phase.*` / `cost.update` / `data.degraded` / `governance.block` 逐条可读，
  绿/黄/红三色区分正常、降级、拦截；
- **报告预览**：内嵌 iframe（先带 token 取回 HTML 再喂 blob URL），可新标签打开；
- **产物**：8 类产物按类型预览/下载，走 `GET /jobs/:id/artifacts/:kind`；
- **运维动作**：重跑 report 阶段、取消任务、崩溃恢复扫描。

实现要点（`apps/gateway/src/console.ts`）：页面本身无需鉴权（只是静态表单），
但页内所有 API 调用都带 `Authorization: Bearer ...`；SSE 用 **fetch + ReadableStream**
手写解析而非 `EventSource`（后者不能带请求头，用它会逼着把 token 塞进 URL）；
报告预览同理用 blob URL，避免给 `/report` 开匿名口子。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm test` | E2E 回归（mock 模式） |
| `npm run check:boundaries` | 架构边界检查 |
| `npm run demo` / `demo:mock` | 端到端演示（真实/离线） |
| `npm run migrate` / `seed` | 建表 / 灌种子 |
| `npm run dev` / `start` | 开发热载 / 启动网关 |

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

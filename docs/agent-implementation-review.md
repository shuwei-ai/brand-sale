# 品牌营销智能体 · 实现梳理

> 核对基线：2026-10-26 工作区（HEAD `f2f226f` + 11 个未提交改动）。
> 本文只讲**实现**，不重复 `architecture.md` 的逐节细节；两者冲突时以代码为准。

## 1. 一句话说清它是什么

一个**六阶段串行、单进程、无自主规划**的策略咨询流水线：

> 不是"让一个 Agent 自己决定做什么"，而是**编排器把六个固定阶段排好**，
> 每个阶段一个角色、一份 Schema、一份工具白名单、一份 token/超时预算；
> 取数由编排器**确定性预取**，模型只负责"判断与措辞"；
> 产出必须过机械校验（R1–R14），过不了就修，修不好就**如实标脏**而不是硬出报告。

这个定位决定了后面所有设计：**能确定性算的事不给模型，能机械校验的事不靠提示词，能降级的事不中断任务。**

## 2. 运行时：只有三个进程

```
浏览器 ──HTTP/SSE──▶ apps/gateway :8787（唯一入口；编排/智能体/渲染都在这个进程内）
                        │
                        ├─▶ SQLite .data/brandsale.sqlite（唯一真相源）
                        └─▶ apps/collector :8890（采集 sidecar，独立进程）
                                 └─spawn─▶ services/collector-core（Python+Playwright 内核）

可选旁路（缺席只降级）：embedding-core :8899 · Milvus :19530
```

- 没有独立编排服务、没有消息队列、没有第二个业务端口；
- 采集是唯一外置进程，慢（分钟级 + 扫码登录），这也是 §6 时序问题的根源；
- Milvus 里的向量是**可重建索引**，不是数据源。

## 3. 智能体编排：阶段、角色、预算

`packages/orchestrator/src/pipeline.ts` 的 `Orchestrator.runJob()` 串行跑 `PHASE_ORDER`，
每阶段结束写检查点（`job_phases.output_json`），产物累积成下一阶段的 `upstream`。

| 阶段 | 角色 | 中文职责 | 输出 Schema | 模型档 | max tokens | 上下文 | 超时 | 工具白名单 |
|---|---|---|---|---|---:|---:|---:|---|
| intake | AO | 任务录入 / 授权核验 | `BriefSchema` | light | 4 096 | 8k | 120s | `validate_brief` `resolve_authorization` |
| intel | CI | 竞品情报 + 品牌自诊 | `CompetitorIntelSchema` | strong | 8 192 | 16k | 180s | `kb_retrieve` `web_search` `platform_digest` |
| creator | CT | 达人筛选与分层 | `CreatorCandidatesSchema` | medium | 8 192 | 16k | 150s | `kb_retrieve` `pricing_query` `risk_screen` `platform_digest` |
| playbook | PL | 打法与内容日历 | `PlaybookSchema` | medium | 10 240 | 24k | 150s | `kb_retrieve` `calendar_plan` |
| budget | BR | 预算与情景模拟 | `BudgetSchema` | medium | 8 192 | 16k | 150s | `kb_retrieve` `pricing_query` `scenario_simulate` |
| report | RG | 报告 DSL | `ReportDslSchema` | strong | **32 768** | **48k** | 240s | `render_outline` `cite_fact` `web_search` |

三个数字是刻意分开的：**输出上限**（截断风险）、**上下文上限**（上游四份表格装不装得下）、
**超时**（自建端点冷启动）。report 阶段三项都比别人高一档，因为一份 13–15 页 DSL 约 40–60KB JSON。

阶段间不对话，只传 `HandoffEnvelope`（`schema + data + missing + degraded`）——**结构化交接**，
避免"多 Agent 自由对话"这种不可复现的形态。

## 4. 六个角色的提示词承诺（`prompts.ts`，244 行）

`SYSTEM_PROMPTS[code] = PER_AGENT[code] + COMMON_RULES`。COMMON_RULES 是五条不可协商的通用约定
（严格 JSON / 无来源数字写 null / 不确定降 confidence / 缺失必须显式 / 风险标 `verifiedBy:"auto"`）。

各角色的"硬性要求"实际上是**为了让 Schema 校验能通过**而写的，不是泛泛的角色扮演：

- **CI**：竞品 ≥3 家 + 每家 contentMatrix/differentiation + sovTrend ≥3 点；brandSelf 的 contentAssets
  出现任何非 null 数字时 `citations` 必须非空（**这条是 Schema 硬校验**）；
- **CT**：三档 tier 都要有人；`risk_screen` 必须对每个候选人跑一遍；**禁止编造达人**——
  走的是 `enforceRealCreators()` 机械剔除，不是提示词兜底；
- **PL**：必须给周粒度 `weeklyCalendar`，每阶段要有 `stopLoss` + `trigger`，份额之和 = 1；
- **BR**：必须给渠道×阶段的 `stageMatrix`，情景必须是区间；
- **RG**：页数下限 13（有 `ownBrandId` 时 15）、块型下限、可溯源引用 ≥60%、
  只能用 `comparison.metrics` 里列出的指标做跨平台对比。

> 提示词里**禁用反引号**（模板字符串会截断），一律用「」。这是踩过的坑。

## 5. 取数：确定性预取 + 18 个工具

### 5.1 预取是编排器的职责，不是模型的

`AgentPack.prefetch()` 在每个阶段开始前**固定跑一遍**工具，结果作为提示词素材：

| 阶段 | 确定性预取 |
|---|---|
| intake | `validate_brief`、`resolve_authorization` |
| intel | 三路 `kb_retrieve`（竞品格局 / 类目趋势 / 合规口径）+ 行业级 `web_search` + **每品牌一次** `web_search_brand_<brand>` + `platform_digest`（投递，不等待） |
| creator | `kb_retrieve` + `pricing_query` + 对**每个**候选人 `risk_screen` + 平台账号池（半池时补取） |
| playbook | `kb_retrieve` + `calendar_plan`（三阶段 20/60/20） |
| budget | 有真实候选人时才 `pricing_query` + KB 取 ROI 锚点 + `scenario_simulate` |
| report | `source_catalog`（合法来源清单）+ `render_outline` + `cite_fact` |

这一步的意义：**模型拿不到"要不要取数"的自由**。它只能在已取回的素材上做判断，
以及在有白名单的情况下补调工具。这消掉了 LLM 最常见的一类失败（不取数就凭记忆写）。

### 5.2 工具面（`tool-impls.ts`）

10 个通用工具 + 1 个聚合入口 + 7 个隐藏原语 = **18 个**：

```
validate_brief · resolve_authorization · kb_retrieve · web_search · pricing_query
risk_screen · calendar_plan · scenario_simulate · render_outline · cite_fact
platform_digest
xhs_web · douyin_web · kuaishou_web · bilibili_web · weibo_web · tieba_web · zhihu_web（hidden）
```

- 工具是**确定性**的：只取数/检索/计算，不负责措辞；数据类工具都返回 `provenance`；
- `platform_digest` 是模型侧唯一的平台入口，它直接返回 `comparison.metrics`（本组平台指标**交集**）——
  "哪些指标可比"是确定性计算，恰是 LLM 最容易错的地方；
- 七个单平台工具 `hidden: true`：仍注册、仍逐源过闸门、单测仍直接调，但**不进模型上下文**；
- `web_search` 白名单是全部六阶段，代价是 CT 的达人信息可能来自公开网页（只剩事后引用校验拦截）。

### 5.3 闸门：来源由代码绑定

```
模型请求 → ① allowedAgents 白名单 → ② 令牌桶（源级速率 + maxCallsPerJob）
        → ③ authz → ④ tenant → ⑤ mutating（默认关）→ ⑥ 语义红线
        → 适配器 → Provenance → 台账
```

`boundSourceId` 写死在工具定义里，**模型只能选"调不调"，不能选"查哪个源"**。
否则模型传另一个已登记的 sourceId，闸门就会去检查错对象而放过真实来源——闸门形同虚设。

## 6. 生成回路：三级降级 + 一次追问

```
预取 → ① Pi Agent 循环（pi-agent-core，工具往返 + Schema 校验）
          ├─ 成功 ────────────────────────────────▶ 交付
          ├─ ①′ 追问重试一次（"只输出完整 JSON"+失败原因，只解析追问后的增量）
          ▼
       ② 直连结构化输出（completeJson，不调工具，校验失败回喂重试）
          ▼
       ③ 合成兜底（工具实测数据 + 保守模板，仅 allowPartial 时）
```

三个必须知道的边界：

1. **降级文案要如实**：`E-AGENT-002` 是调用失败（可以说"模型不可用"）；
   `E-AGENT-001` 是输出没过校验（**多为 max_tokens 截断**），写成"模型不可用"会把排障带偏。
2. **工具风暴闸门**（`agents.ts`）：同一调用（参数指纹）>3 次即拒、单阶段 >30 次即拒、
   连续被拒 6 次置 `terminate`。真机曾出现同一 `platform_digest` 连续调用 131 次，
   把阶段预算烧光后连兜底都跑不动。
3. **mock 模式**用工具实测数据合成并跑 Schema 校验，保证桩与真实路径同构，E2E 全离线。

## 7. 报告回路：这是全系统最复杂的一段

`finalizeReport()`（`agents.ts:1289–1565`）把"模型写的 DSL"变成"能渲染的 DSL"：

```
enrichProvenance（机械补平台证据 + 人选来源标注）
  → autoRepair（P0 自愈：纯函数，先修再判）
  → 校验（只把 !repairable 的 error 当阻塞）
  → 有阻塞？
      ├─ 问题全在 ≤3 页内 → P1 按页补丁（只重写那几页，index 对位合并）
      └─ 含全局问题 → 整份回喂
  → 每轮"问题数必须严格下降"才采纳（防改好一页弄坏一页）
  → 两轮仍不达标 → 接受当前版本 + 写 meta.degraded + 任务标 partial
```

四条硬约束：

- **P0 用确定性函数修的事，一条都不送模型**。为一条 R6 白烧过 23 分钟 / 4 万 token；
- **P1 只替换同名页**，页序页数不变，补丁把页掏空（块数腰斩）时保留原页——"这不是修复而是删内容"；
- **失败绝不回退到未修复原稿**：原稿含不可修 error → 渲染期 `compile()` 拒绝 → 报告整份丢失；
- **系统绝不凭空给数字块捏来源**：R6 仍 `undefined` 时 P0 也救不回来，只能回喂或如实标脏。

## 8. 真实性：四道机械防线

| # | 机制 | 防的是什么 |
|---|---|---|
| 1 | **证据表 + entryId**（`EvidenceRegistry`，`pf_<平台>_<id>`） | 模型编 URL。模型只能引 entryId，URL/时间/采集时点由渲染层反查拼接 |
| 2 | **R1–R14 校验 + autoRepair** | 无来源数字（R6）、非法来源（R3/R13）、L4 引用（R8）、未指定自有品牌却说"我方"（R14） |
| 3 | **机械附录页** | "引用了几条真实条目"由系统统计，模型无法美化 |
| 4 | **缺失 ≠ 0** | `comparison.dropped` / `platformsSkipped` / `absentMetrics` 必须如实写；0 会被读成"实测为零" |

配套的两个"上游版本"：intel 产出后立刻 `enforceEvidence()` 摘掉幻觉 entryId；
creator 产出后 `enforceRealCreators()` 把对不上真实数据源的候选人**直接剔除**（不是警告）。

## 9. 当前实现的真实短板

按影响排序（前三条是**结构性**的，不是 bug）：

| # | 问题 | 现状与成因 | 可行的方向 |
|---|---|---|---|
| 1 | **报告总可能先于采集完成** | 采集是 fire-and-forget(202)，内核单进程串行 + 队列上限；6 阶段约 35 分钟，好关键词排在队尾就错过。实测 2026-10-21：xhs 首批 08:11:14 落盘，intel 08:11:53 就结束 → 证据表 22 条全 dy、0 条 xhs | report 阶段对"brief 声明但台账为 0"的平台用 brief 关键词补发 `op=search`；或把采集改成"阶段可等待的前置依赖" |
| 2 | **CT 提示词与采集能力自相矛盾** | `prompts.ts:106` 仍写"粉丝量七个平台都拿不到（上游内核已移除创作者资料落盘）"，但同一文件 RG 提示词（:224）写"粉丝量取自个人主页公开统计"，代码里 `enqueueAuthorProfiles` / `creatorLiveViews` 也确实是这么做的 → **CT 被提示词劝退，不敢用已采到的粉丝量** | 改 CT 那段：改为"能采到就照写，没采到写未采集；只有报价禁止估算" |
| 3 | **"报告整份丢失"类风险靠逐条堵** | 历史形态：校验器吞字段（matrix 漏 `...sref`）、扫描槽位比修复多一个、回喂失败返回原稿 —— 每一条都是"报告消失" | 已有 `schema-coverage.test.ts` 逐块型断言写入→读出一致；新增块型/槽位时必须同步 |
| 4 | 平台能力边界被反复误读 | 画像 0/7、快手无评论数、贴吧无点赞、只 B站有播放 → 跨平台内容层**没有共有指标** | 已在 `platform_digest.comparison` 里确定性回答；新增平台指标时必须走这份交集计算 |
| 5 | 非商用许可仍是未决事项 | `collector-core` 是 NON-COMMERCIAL 1.1，三道门（`BM_MC_ENABLED` + `BM_MC_LICENSE_ACK` + URL）；`legalApproved` 对 L3 不执法 | 商用前必须取得版权方书面同意；`BM_MC_LICENSE_REF` 做溯源 |
| 6 | 文档漂移 | README 仍写 datasource "仅含唯一的真实外部源：联网检索"（实际 8 源）；工具数 17/18 并存；M16 不存在 | 以 `architecture.md` 为准，README 架构图待同步 |
| 7 | 工作区有未提交改动 | 11 个 M + 2 个未跟踪测试（`report-patch` / `creator-stats`），对应 P1 按页补丁与粉丝量修复 | 提交前核对 `.env` 未被纳入 |

## 10. 结论：这套实现的"性格"

- **编排确定、模型受限**：阶段、工具、预算全在代码里；模型只在"判断与措辞"上有自由度。
- **校验优先于提示词**：14 条规则 + 一次机械修复 + 一次按页补丁，都是可离线复放的纯函数；
  提示词只是第一道，不是唯一一道。
- **降级优先于失败**：三级生成阶梯 + 检查点 + 断点续跑，任何一级失败都不中断任务；
  代价是"必须如实标脏"，`partial` / `meta.degraded` 是设计的一部分，不是缺陷。
- **单进程、可复现、可离线**：253 个用例全离线，`mock` 与真实路径同构；这是它敢做
  "机械修复"和"逐块断言"的前提。

真正需要警惕的不是模型能力，而是**时序**（采集 vs 生成）与**口径**（提示词 vs 代码）这两类
"系统自己说错了"的问题——上面第 1、2 条都是这一类。

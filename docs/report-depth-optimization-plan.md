# 报告深度优化方案（P0–P2 全量）

> 目标：把「输出报告不够细致」从**四层结构性约束**逐层拆掉，让一份研报从
> 现状 8 页 / 14 块 / 6 种块型 / 0 条可溯源引用，提升到 **≥12 页 / 每种块型都用上 / 可溯源引用 ≥60%**，
> 并用**代码级回归**锁住，防止再次退化。
>
> 本文只讲改法，不含实施。全部改动落在 `packages/*` 与 `tests/`，不引入新依赖。

---

## 0. 验收门槛（先定标准，再谈改法）

新增一份**可执行的深度策略**，作为 P0–P2 的共同验收口径：

| 维度 | 现状实测 | 目标 | 强制手段 |
| --- | --- | --- | --- |
| 页数 | 8 | **≥ 12** | 深度校验 + 回喂重试 |
| 正文页块数 | 平均 1.75 | **每页 ≥ 3** | 深度校验 |
| 使用的块型 | 6 | **≥ 9（且必含 chart / matrix）** | 骨架补全 + 渲染支持 |
| 图表 / 矩阵块 | 0 | **≥ 4** | 骨架 + 渲染 + 提示词 |
| 可溯源引用占比 | 0 / 18 = 0% | **≥ 60%** | 来源目录 + 引用校验 |
| 来源声明合法项 | 1 / 6 | **全部合法** | 来源目录校验 |
| 声明来源数 | 6（含 5 个已删除源） | **≥ 3 且全部真实** | 来源目录注入 |

这七项直接写成 `tests/e2e.test.ts` 的断言，任何人改坏都会红。

---

## 1. 现状证据（来自 `out/` 真实产物）

一份真实模型跑出的研报（`out/报告DSL-联网检索-job_0muwdt0cjuwp7fxsv0e.json`）：

```
slides: 8   blocks: 14   block types: {text:2, table:4, callout:4, kpi:2, bullets:1, timeline:1}
citations: 18 → 全部 kind=model_inference，全部 ref.sourceKey=undefined
sourceDeclaration.sources:
  juliang_suanshu  (L3)  ← 巨量算数，适配器已整体移除
  pugongying       (L1)  ← 蒲公英，已移除
  qianchuan        (L1)  ← 千川，已移除
  shengyicanmou    (L1)  ← 生意参谋，已移除
  xingtu           (L1)  ← 星图，已移除
  volc_web_search  (L3)  ← 唯一真实源
sourceRef 实际取值: brief_input / intel_insights / playbook_phases / budget_risks …
```

**读法**：模型没画过一张图、没写过一条可溯源引用，还把 5 个系统里**根本不存在的**数据源写进了合规声明页。
这不是"模型偷懒"，是它严格照着系统给它的错误模板在写。

---

## 2. P0-1｜对齐 Report Schema 骨架与 `ReportDsl` 类型

### 2.1 问题

`packages/agent-pack/src/schemas.ts:544` 的 `ReportDslSchema.skeleton` 是**模型唯一能看到的结构说明**
（`agents.ts:612` 把它直接贴进提示词），但它和 `packages/contracts/src/report.ts` 的真实类型**三处对不上**：

| 骨架写的 | 真实类型 | 后果 |
| --- | --- | --- |
| `meta: { title, tenantId, window, generatedAt }` | `meta: { dslVersion, title, brand, window, generatedAt, degraded? }` | `brand` 拿不到 → 封面无品牌；模型凭空多写 `tenantId` |
| `blocks` 只列 7 种 | `Block` 有 **10** 种 | **漏 `chart` / `image` / `matrix` → 模型从不用图表**（实测 0 个图表块） |
| `citations: { claim, sourceId, grade, confidence }` | `ReportCitation: { claim, kind, ref, grade?, confidence, tier, verifiedBy }` | 缺 `kind`/`ref`/`tier` → `validate` 兜底成 `model_inference` + `ref={}` → **18/18 引用全落模型推断** |
| `sourceDeclaration.sources[].sourceId` | `sources[].key` | 字段名对不上，模型写 `sourceId` |
| 骨架无 `exclusions` | `SourceDeclaration.exclusions` 必填 | 排除项靠猜 |

同时 `validate`（`schemas.ts:609-620`）在兜底时静默补 `kind: "model_inference"`、`tier: "medium"`、
`verifiedBy: "auto"`——**兜底把"缺字段"变成了"合法的推断引用"**，问题被掩盖到渲染期才暴露。

### 2.2 改法

**(a) 重写骨架，逐字段对齐 `ReportDsl`**

`packages/agent-pack/src/schemas.ts` · `ReportDslSchema.skeleton`：

```ts
skeleton: `{
  "meta": { "dslVersion": "1.0", "title": string,
            "brand": { "id": string, "name": string },
            "window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
            "generatedAt": "ISO8601" },
                       // 注意：tenantId 不在 meta 里，不要写
  "sourceDeclaration": {
    "grade": "L2|L3",                          // 本系统没有 L1；L4 一律禁止
    "sources":    [{ "key": string, "displayName": string, "grade": "L2|L3",
                     "asOf": "ISO8601", "coverage": string }],
    "exclusions": [{ "key": string, "reason": string }] },
  "slides": [{ "index": number,                  // 第一页必须是 0，逐页 +1
               "pageRole": "cover|toc|section|content|data|appendix|closing",
               "title": string,
               "layoutId": string,
               "blocks": [                        // 共 10 种，按需选用，不要只用 table
                 { "type": "text",     "style": "h2|h3|body|caption", "content": string, "sourceRef?": string },
                 { "type": "bullets",  "items": string[], "sourceRef?": string },
                 { "type": "kpi",      "items": [{ "label": string, "value": string, "unit?": string,
                                                   "confidence?": number, "tier?": "high|medium|low",
                                                   "sourceRef?": string }] },
                 { "type": "table",    "columns": string[], "rows": string[][], "caption?": string, "sourceRef?": string },
                 { "type": "chart",    "chartType": "bar|line|pie|scatter|funnel",
                                       "series": [{ "name": string, "points": [{ "x": string, "y": number }] }],
                                       "axis?": { "xLabel?": string, "yLabel?": string }, "sourceRef?": string },
                 { "type": "matrix",   "xLabel": string, "yLabel": string,
                                       "cells": [{ "x": number, "y": number, "label": string, "size?": number }] },
                 { "type": "timeline", "phases": [{ "label": string, "from": string, "to": string, "items": string[] }],
                                       "sourceRef?": string },
                 { "type": "callout",  "tone": "info|warn|risk", "text": string, "sourceRef?": string },
                 { "type": "quote",    "text": string, "attribution?": string, "sourceRef?": string },
                 { "type": "image",    "ref": string, "caption?": string, "sourceRef?": string }
               ],
               "citations": [{ "claim": string,
                               "kind": "data_source|kb_chunk|model_inference",
                               "ref": { "sourceKey?": string, "chunkId?": string },
                               "grade": "L2|L3", "confidence": number,
                               "tier": "high|medium|low", "verifiedBy": "auto|human" }],
               "notes?": string }]
}`,
```

**(b) `validate` 不再"静默补默认值"，改为**缺字段即报错**（错误信息回喂给模型）**

`schemas.ts:578-589` 现在是：

```ts
kind: (typeof co.kind === "string" ? co.kind : "model_inference") as ...,
tier: (typeof co.tier === "string" ? co.tier : "medium") as ...,
```

改成显式校验 + 语义约束：

```ts
const citations = checkArray(o.citations, issues, `$.slides[${i}].citations`).map((c, j) => {
  const co = checkObject(c, issues, `$.slides[${i}].citations[${j}]`);
  const claim = checkString(co.claim, issues, `$.slides[${i}].citations[${j}].claim`);
  const kind = co.kind;
  if (kind !== "data_source" && kind !== "kb_chunk" && kind !== "model_inference") {
    issues.push(`$.slides[${i}].citations[${j}].kind 必须是 data_source|kb_chunk|model_inference，实际 ${JSON.stringify(kind)}`);
  }
  const ref = isObj(co.ref) ? (co.ref as Record<string, unknown>) : {};
  // kind 与 ref 必须自洽：data_source 要 sourceKey，kb_chunk 要 chunkId，model_inference 必须为空
  if (kind === "data_source" && typeof ref.sourceKey !== "string") {
    issues.push(`$.slides[${i}].citations[${j}]：kind=data_source 时 ref.sourceKey 必填`);
  }
  if (kind === "kb_chunk" && typeof ref.chunkId !== "string") {
    issues.push(`$.slides[${i}].citations[${j}]：kind=kb_chunk 时 ref.chunkId 必填`);
  }
  const confidence = checkNumber(co.confidence, issues, `$.slides[${i}].citations[${j}].confidence`, 0, 1);
  // 模型推断必须标 low：这是"不许编造"在类型层的落点
  const tier = co.tier ?? (kind === "model_inference" ? "low" : "medium");
  if (kind === "model_inference" && tier !== "low") {
    issues.push(`$.slides[${i}].citations[${j}]：kind=model_inference 必须 tier=low（当前 ${tier}）`);
  }
  ...
});
```

`meta` 也同理：`brand.id` / `brand.name` 必填，禁写 `tenantId`（写了就报"不得出现 tenantId 字段"）。

**(c) 补上"解锁图表"带来的新漏洞：`numericClaims` 要认识新块型**

`packages/contracts/src/report.ts:101-125` 的 `numericClaims()` 只覆盖 7 种块，
一旦放出 `chart` / `matrix` / `image`，**"有数字但无来源"的检查会对新块型完全失效**——
模型画一张带 12 个数字的柱状图却不写 citation，校验器查不出来。这是 P0-1 引入的副作用，必须同批修掉：

```ts
case "chart":
  for (const s of block.series) for (const p of s.points) push(`${s.name} ${p.x}:${p.y}`);
  break;
case "matrix":
  for (const c of block.cells) push(`${c.label}(${c.x}, ${c.y})`);
  break;
case "image":
  push(block.caption);
  break;
case "table":
  for (const row of block.rows) row.forEach(push);
  push(block.caption);            // 表注也常含数字/口径
  break;
```

**(d) 加"防漂移"单测（关键，否则半年后又是一次漂移）**

`tests/schema-coverage.test.ts`（新文件）：

```ts
import { Block, PageRole, ReportCitation, ReportDslSchema } from "@brandsale/contracts";

test("ReportDsl 骨架必须覆盖全部 Block.type / PageRole / 关键字段", () => {
  const s = ReportDslSchema.skeleton;
  const blockTypes = ["text","bullets","kpi","table","chart","matrix","timeline","callout","quote","image"] as const;
  for (const t of blockTypes) assert.match(s, new RegExp(`"type": "${t}"`), `骨架漏了块型 ${t}`);
  const roles = ["cover","toc","section","content","data","appendix","closing"] as const;
  for (const r of roles) assert.match(s, new RegExp(r), `骨架漏了 pageRole ${r}`);
  for (const f of ["kind","ref","tier","verifiedBy","dslVersion","brand","exclusions"]) {
    assert.match(s, new RegExp(`"?${f}"?`), `骨架漏了字段 ${f}`);
  }
  assert.doesNotMatch(s, /tenantId/, "meta 不得出现 tenantId（真实类型没有）");
});
```

> 这条测试的价值：`Block` 是联合类型，将来有人加第 11 种块型（比如 `gantt`），
> 只要忘了同步骨架，CI 立刻红。**漂移这件事只能靠类型与骨架的强绑定来防。**

---

## 3. P0-2｜来源目录 + 引用合法性校验（可溯源）

### 3.1 问题

三处叠加，导致报告里的"来源"完全是自由文本：

1. **RG 拿不到可用源清单**。`agents.ts:311-318` 的 report 预取只跑了 `render_outline` + 一次 `cite_fact`，
   提示词里没有任何"本次真实可用的数据源有哪些"。模型只能凭训练记忆编——于是写上千川/星图/蒲公英。
2. **`validateReportDsl` 只查"非空 + 无 L4"**（`report.ts:143-160`），不检查 key 是否真实存在。
3. **`cite_fact` 是空实现**（`tool-impls.ts:375-392`）：永远返回 `found:false / citation:null`，
   对模型没有任何约束力，等于把"引用校验"这件事整个悬空。

### 3.2 改法：引入 `SourceCatalog`

**(a) 契约层新增类型**（`packages/contracts/src/report.ts`，叶子包，纯类型）

```ts
export type SourceOrigin = "external" | "kb" | "internal";

export interface SourceCatalogEntry {
  key: string;
  displayName: string;
  grade: ComplianceGrade;
  origin: SourceOrigin;
  /** 人类可读取数口径，直接抄进来源声明页的 coverage */
  coverage: string;
  asOf: string;
}

export interface SourceCatalog {
  /** 真实可用的数据源（外部适配器 + 本地 KB）——只有这些能进 sourceDeclaration */
  entries: SourceCatalogEntry[];
  /** 逻辑来源：报告内部产物与用户输入，只能出现在 block.sourceRef，不能进 sourceDeclaration */
  logicalRefs: string[];
  /** 已知 KB chunkId，用于 kb_chunk 引用的存在性校验 */
  chunkIds?: string[];
}

/**
 * 逻辑来源清单。命名空间化，避免 `brief_input` / `pricing_query` 这类自由写法继续扩散。
 * 前缀约定：
 *   phase:*   上游阶段产物（brief/intake/intel/creator/playbook/budget）
 *   meta:*    报告自身元信息（sourceDeclaration/disclaimer）
 *   tool:*    工具直接产出（pricing/scenario_simulate/calendar_plan/render_outline）
 *   degrade:* 降级合成
 */
export const LOGICAL_REFS = [
  "phase:brief","phase:intake","phase:intel","phase:creator","phase:playbook","phase:budget",
  "meta:sourceDeclaration","meta:disclaimer","degrade:synthesis",
  "tool:pricing","tool:scenario_simulate","tool:calendar_plan","tool:render_outline",
] as const;
```

**(b) `DslIssue` 增加 `repairable`，让"收紧"不等于"炸掉渲染"**

现在 `render.compile` 遇到任何 error 就 `throw`（`render/src/index.ts:65-69`），
任务彻底拿不到报告。收紧校验后如果还这么干，等于把"不细致"换成"不可用"。
所以把 error 分成两类：

```ts
export interface DslIssue {
  level: "error" | "warn";
  path: string;
  message: string;
  fix?: string;
  /** true = 可由 autoRepair 机械修复（顺手记 degraded）；false = 硬拒绝，必须上游改 */
  repairable?: boolean;
}
```

| 规则 | 级别 | 可修复 |
| --- | --- | --- |
| R1 `sourceDeclaration.sources[].key` 不在 catalog → 不存在的源 | error | ✅ 移出声明 + 相关引用降级为 `model_inference/low` |
| R2 `displayName` 与 catalog 不一致 | warn | ✅ 按 catalog 改写 |
| R3 `kind=data_source` 的 `ref.sourceKey` 不在已声明 sources 里 | error | ✅ 该条降级为 `model_inference/low` |
| R4 `kind=kb_chunk` 的 `ref.chunkId` 不在 `catalog.chunkIds` | error | ✅ 同上 |
| R5 `block.sourceRef` ∉ `logicalRefs ∪ 已声明 sources` | warn | ✅ 归一化别名（见下） |
| R6 含数字且有无效 sourceRef 且该页无 citation | **error** | ❌ 硬拒（不许把编造来源洗成"有依据"） |
| R7 L4 引用 / 来源声明为空 / 无来源数字 | error | ❌ 硬拒（既有规则不变） |
| R8 `low` 置信 KPI 页缺 `warn` callout | warn | ✅ 既有 |
| R9 可溯源引用占比 < `minTraceableRatio` | warn | ❌（只在深度校验里做展示，不拒绝渲染） |

R1/R3/R4 的自动修复必须是**降级**而非删除：把该条引用的 `kind` 改成 `model_inference`、
`tier` 改成 `low`、`ref` 清空，并在 `autoRepair` 的 `actions` 里记一条明文
（`render/src/index.ts:62` 已把 `actions` 转成 `repairs`，orchestrator 会写进 job.degraded → 任务标 partial）。
这样既不编造，也不让任务失败。

别名归一小表（只处理观测到的真实写法，不猜）：

```ts
const REF_ALIASES: Record<string, string> = {
  brief: "phase:brief", brief_input: "phase:brief",
  intake: "phase:intake", intel: "phase:intel", intel_insights: "phase:intel",
  creator: "phase:creator", creator_candidates: "phase:creator",
  playbook: "phase:playbook", playbook_phases: "phase:playbook", playbook_rationale: "phase:playbook",
  budget: "phase:budget", budget_scenarios: "phase:budget",
  budget_risks: "phase:budget", budget_disclaimer: "phase:budget",
  sourceDeclaration: "meta:sourceDeclaration", disclaimer: "meta:disclaimer",
  synthesis: "degrade:synthesis",
  pricing: "tool:pricing", pricing_query: "tool:pricing",
  scenario_simulate: "tool:scenario_simulate",
  calendar_plan: "tool:calendar_plan", render_outline: "tool:render_outline",
};
```

**(c) 组装目录：放在 `@brandsale/governance`（边界合规）**

依赖矩阵（`scripts/check-boundaries.ts:25-57`）里 `render` 只能依赖 `contracts + config`，
**渲染层必须保持"无数据访问"**，所以目录不能在 render 里查库。放在 governance（可依赖 storage）：

`packages/governance/src/catalog.ts`（新文件）：

```ts
export function buildSourceCatalog(deps: {
  repos: Repositories;
  knowledgeSourceIds: string[];   // 由调用方从知识库取，避免 governance 反向依赖 knowledge
  tenantId: string;
}): SourceCatalog {
  const entries: SourceCatalogEntry[] = [];
  for (const s of deps.repos.sources.list(deps.tenantId)) {
    const az = deps.repos.authz.active(deps.tenantId, s.sourceId);
    const legal = s.tier !== "L4" || s.legalApproved;
    if (!az || !legal) continue;            // 未授权 / L4 未法务批 → 不进目录
    entries.push({ key: s.sourceId, displayName: s.name, grade: s.tier as never, origin: "external",
                   coverage: `${s.authMethod ?? "已授权"}，取数口径见台账`, asOf: az.validFrom });
  }
  for (const id of deps.knowledgeSourceIds) {
    entries.push({ key: id, displayName: KB_DISPLAY[id] ?? id, grade: KB_GRADE[id] ?? "L2", origin: "kb",
                   coverage: "本地知识库检索命中", asOf: new Date().toISOString() });
  }
  return { entries, logicalRefs: [...LOGICAL_REFS], chunkIds: deps.chunkIds };
}
```

`knowledge` 需要补一个 `sourceIds(tenantId): { sourceId, collection }[]`（`packages/knowledge/src/index.ts`），
因为 KB 语料的 `sourceId`（`public_intel` / `internal_review` / `methodology`，见 `scripts/seed.ts:105-165`）
**并不在 `sources` 表里**——它们没走闸门授权，是内部语料来源。目录必须把这两类合起来，
否则真实合法的 KB 引用反而会被判非法。

`AgentPack` 暴露一个门面供编排层调用（避免 orchestrator 直接摸 knowledge）：

```ts
// packages/agent-pack/src/agents.ts
sourceCatalog(ctx: TenantContext): SourceCatalog {
  return buildSourceCatalog({
    repos: this.deps.repos, tenantId: ctx.tenantId,
    knowledgeSourceIds: this.deps.knowledge.sourceIds(ctx.tenantId).map((x) => x.sourceId),
    chunkIds: this.deps.knowledge.chunkIds(ctx.tenantId),
  });
}
```

**(d) 把可用源清单注入 RG 提示词**

`agents.ts` · `buildPrompt()` 增加一段（仅 report 阶段），并在 `prefetch("report")` 里把目录塞进 `prefetched`：

```ts
// prefetch: case "report"
const catalog = this.sourceCatalog(tc.ctx);
out["source_catalog"] = catalog;      // 随 tool 数据一起进提示词
await run("render_outline", "render_outline", { title: ..., sections: [...] });
```

```
【可用数据源清单（唯一合法的来源集合）】
- volc_web_search（联网检索·L3）：公开网页检索，引用时必须写来源站点名
- public_intel（L3）/ internal_review（L2）/ methodology（L2）：本地知识库
- 本系统**没有**千川 / 星图 / 蒲公英 / 生意参谋 / 巨量算数 的数据源，禁止声明它们

sourceDeclaration.sources 只能从上面这份清单里选，key 与 displayName 必须逐字一致。
未使用的源写进 exclusions 并说明原因。
block.sourceRef 只允许用以下逻辑来源：phase:brief / phase:intel / phase:creator /
phase:playbook / phase:budget / meta:sourceDeclaration / meta:disclaimer / tool:pricing …
```

**(e) 把渲染期校验前移：RG 产出后先自校验，允许一次回喂修复**

这是整个 P0-2 里**性价比最高**的一步。现状是 render 才拦，拦下来任务就废了。
改成在 `runStrategies("report")` 的 `direct.ok` 之后：

```ts
if (phase === "report") {
  const dsl = attempt.value as ReportDsl;
  const catalog = this.sourceCatalog(tc.ctx);
  const first = validateReportDsl(dsl, { catalog });
  if (!first.ok) {
    const blocking = first.issues.filter((i) => i.level === "error" && !i.repairable);
    if (blocking.length > 0) {
      // 带着 issue 清单回喂一次（复用 completeJson 的重试通道）
      const repairPrompt = `${prompt}\n\n【上一次输出被拒绝，必须修正以下问题】\n${blocking.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`;
      ... // 一次 repair 调用
    }
  }
}
```

**优先级**：这一条比调提示词有效得多——它把"模型不知道错在哪"变成"模型被明确告知错在哪"。

**(f) 让 `cite_fact` 变成真正的校验器**（可选加固）

`tool-impls.ts:375` 的 `cite_fact` 现在恒返回 `found:false`。改为按 catalog 真查：

```ts
execute(params, tc) {
  const claim = String(params.claim);
  const catalog = this.sourceCatalog(tc.ctx);   // 需在此处可访问
  const hit = catalog.entries.find((e) => claim.includes(e.displayName) || claim.includes(e.key));
  return { result: { claim, found: Boolean(hit), citation: hit ? { sourceKey: hit.key, grade: hit.grade, tier: "medium" } : null,
                     note: hit ? "命中台账来源" : "未找到可引用来源，请改写为不含数字的定性表述" } };
}
```

---

## 4. P1-1｜加厚上游：让下游"有料可写"

上游薄，报告必然薄。逐阶段补维度：

### 4.1 CI（竞品情报）

- 竞品数下限 **≥3**（`CompetitorIntelSchema.competitors` 从 `min 1` 提到 `min 3`，错误信息回喂）。
- 每家补三个维度字段（含 `skeleton` 与 `validate`）：

```ts
competitors: [{
  name, positioning, priceBand, keyClaims, shareOfVoice,
  contentMatrix: { form: string; share: number; platform: string }[],   // 内容形态分布
  sovTrend: { month: string; value: number | null }[],                  // 声量趋势（无数据写 null）
  differentiation: string,                                              // 与本品差异点
  confidence,
}]
```

- `categoryInsights` 补 `pricingBand`（价格带分布）与 `channelMix`（渠道结构），供 BR 的渠道×阶段矩阵使用。
- `prefetch("intel")` 从**一次** `kb_retrieve` 改成三路并行：
  `竞品格局` / `类目趋势与人群` / `法规与合规口径`，各带 `topK: 5`。
  现在只有一条 query（`agents.ts:269`），检索面太窄。

### 4.2 CT（人选匹配）

- **`risk_screen` 覆盖全部候选**，不是只筛第一个。`agents.ts:286-289` 现在只对 `candidates[0]` 跑风控，
  导致报告里的 `riskFlags` 只对一个人有效。
  ```ts
  const cands = (out["pricing_query"] as ...)?.candidates ?? [];
  const screened = await Promise.all(cands.map((c) => run(`risk_${c.talent.talentId}`, "risk_screen", {...})));
  ```
- 候选人分三层，新增必填字段 `tier: "head" | "mid" | "tail"`，并校验**每层至少 1 人**
  （种子数据 `t_1001`~`t_1005` 正好覆盖 21.5w / 128w / 89w / 46w / 16.8w 粉，天然可分三层）。
- 每个候选补 `contentFit`（内容形态契合度）与 `historicalPerformance`（历史表现，取自 KB-2）。

### 4.3 PL（打法排期）

- 新增 `weeklyCalendar: { week: number; from: string; to: string; platform: string; contentType: string; creatorIds: string[]; theme: string }[]`
  —— 报告里的"内容日历"就靠它，现在只有 3 个粗阶段。
- `kpiTargets` 补 `stopLoss`（止损线）与 `trigger`（触发条件），对应风险页的"触发信号/止损动作"。

### 4.4 BR（预算风控）

- 新增 `stageMatrix: { channel: string; stage: string; amount: number; expectedRoi: number }[]`
  —— 渠道 × 阶段交叉矩阵，`matrix` 块的数据来源。
- `risks` 补 `owner`（责任人）与 `signal`（触发信号），当前只有 `probability / impact / mitigation`。
- `prefetch("budget")` 的 `baseRoi` 现在是**硬编码 1.9**（`agents.ts:308`），
  改为从 KB-2 复盘片段里取（"种草占比 45% 时 ROI 最优 2.3"），把估算锚定到真实语料。

---

## 5. P1-2｜提示词加"细化下限"，并在代码层强制

### 5.1 提示词改造（`packages/agent-pack/src/prompts.ts`）

`PER_AGENT.RG` 补章节维度与硬性下限：

```
【章节维度 · 缺一不可】
1  封面
2  数据来源与口径声明（含 exclusions）
3  核心结论速览（KPI 块，≤5 条）
4  竞品格局对比（table：≥3 家 × 定位/价格带/主张/声量/内容矩阵）
5  类目趋势与人群洞察（chart + bullets）
6  人选建议（table，按 head/mid/tail 分层，含风控结论）
7  内容日历（timeline，按周）
8  预算分配（chart + table）
9  渠道 × 阶段矩阵（matrix）
10 三档情景模拟（kpi + callout）
11 风险登记（table：概率/影响/触发信号/止损动作/责任人）
12 免责声明

【颗粒度下限 · 违反即需要重做】
- slides 总数 ≥ 12，其中 pageRole=content|data 的页每页 ≥ 3 个 block；
- 至少使用 9 种不同 block type，且**必须包含 chart 与 matrix 各 ≥1 个**；
- 引用结构必须真实：
  · 来自工具/KB 的数字 → kind=data_source 或 kb_chunk，ref.sourceKey 必须来自【可用数据源清单】
  · 你自己推断的数字 → kind=model_inference 且 tier=low，并在同级 note 说明推断依据
  · **禁止**把推断写成 data_source —— 这会被来源校验拒绝
- sourceDeclaration.sources 只能从【可用数据源清单】里选，key 与 displayName 逐字一致；
- 每个来源声明的 key，必须至少有 1 条 citation 指向它；否则删掉这条声明。
```

其余五个 Agent 各补 2–3 条"必须输出的维度"（见 §4 各字段），
例如 CI 补"竞品 ≥3 家且每家必须给 contentMatrix 与 differentiation"。

### 5.2 代码强制：`ReportDepthPolicy` + 一次回喂重试

提示词只是第一道。新增深度校验（放 `packages/contracts/src/report-depth.ts`，纯函数）：

```ts
export interface ReportDepthPolicy {
  minSlides: number;                  // 12
  minBlocksPerBodySlide: number;      // 3
  minBlockTypes: number;              // 9
  requiredBlockTypes: Block["type"][];// ["kpi","table","chart","matrix","timeline","callout"]
  minTraceableRatio: number;          // 0.6
  minSources: number;                 // 3
}
export const DEFAULT_DEPTH_POLICY: ReportDepthPolicy = { ... };

export interface DepthReport {
  slides: number; bodySlides: number; blocks: number;
  blockTypes: Block["type"][]; missingRequiredTypes: Block["type"][];
  totalCitations: number; traceable: number; traceableRatio: number;
  /** 人类可读缺口清单，直接拼进回喂提示词 */
  gaps: string[];
}
export function measureReportDepth(dsl: ReportDsl, policy = DEFAULT_DEPTH_POLICY): DepthReport;
```

在 `AgentPack.runPhase` report 分支：`schema.validate` → `measureReportDepth` → `gaps.length > 0` 时
**回喂一次**（把 `gaps` 拼进 prompt 重新生成），仍不达标则接受，但写进 `degradedKeys` 并落到
`meta.degraded = { reason, missingSections: gaps }`——**如实标注，不假装达标**。

> 与既有哲学一致：`agents.ts:12` 的注释写着"提示词只是第一道，不是唯一一道"。

---

## 6. P2-1｜渲染表达力：把"能用"变成"好看且真能读"

### 6.1 `chart` 现在不是图表

`render/src/index.ts:261-274` 的 `blockToHtml("chart")` 画的是**一排带背景色的 div 条**，
没有坐标轴、没有刻度、没有图例、多系列会被拉平。改为**内联 SVG**：

- `bar` / `line` / `pie` / `scatter` / `funnel` 五种各一个渲染函数，共用一套坐标计算；
- 坐标轴 + 刻度 + 图例 + 数值标签；`series` 多系列用色板区分；
- 尺寸 `viewBox="0 0 900 N"`，`preserveAspectRatio` 保证打印/PDF 不变形；
- **零依赖**：手写 SVG，不引 chart 库（render 包只允许 contracts + config）。

### 6.2 `matrix` 现在是"单列表格"

`render/src/index.ts:285-288` 把矩阵渲染成 `<th>xLabel / yLabel</th>` 一行 + 每格一行，
完全丢失了"二维象限"语义。改为**象限散点图**：按 `x`/`y` 归一化定位圆点，
`size` 决定半径，`label` 标在点旁，四象限加淡底与轴标签。竞品"声量×价格带"定位图、达人"粉丝量×匹配度"分层图都用它。

### 6.3 新增版式能力

| 能力 | 实现 |
| --- | --- |
| 目录页 | `pageRole === "toc"` → 自动生成章节列表 + 页码（当前 `PageRole` 已含 `toc`，但渲染层完全不认） |
| 页码 | `.slide` 右下角 `index+1 / total`；补 `@media print` 的 `@page` 规则 |
| 双栏 | `layoutId` 以 `content/2col` 开头 → `column-count: 2`，适合 bullets/长文 |
| `section` / `appendix` 角色 | 章节分隔页样式（大字标题 + 序号） |
| `image` | 现在直接 `esc(block.ref)` 塞进 `src`——**存在注入面**，改为只允许 `https:` / `data:image` 白名单，其余丢弃并记 repair |
| KPI 分组 | `items.length > 4` 时按 `flex-wrap` 自适应 + 首条加粗（"核心结论速览"页需要） |

### 6.4 Markdown 侧对齐

`toMarkdown()` 的 `chart` 现在是 `**图表：bar**` + 一串 `x=y`；改为输出 Markdown 表格 + 口径注，
并可选用 ```mermaid``` 代码块（纯文本，不引依赖），让 Markdown 也能看。

---

## 7. P2-2｜上下文/输出预算分级 + golden 回归

### 7.1 预算分级

`agents.ts:100-102` 现在只有 `report: 16_384`；一份 12 页、含真表格与图表的 DSL 约 40–60KB JSON
（约 2 万+ token），仍会截断 → 触发 `E-AGENT-001` → 合成兜底 → 报告顶部挂"模型输出未通过校验"横幅。
（`agents.ts:92-99` 的注释已经踩过一次这个坑。）

```ts
const MAX_TOKENS_BY_PHASE: Partial<Record<PhaseName, number>> = {
  intake: 2_048,
  intel: 6_144,
  creator: 6_144,
  playbook: 8_192,
  budget: 6_144,
  report: 32_768,     // 由 config 覆盖：BM_REPORT_MAX_TOKENS
};

/** 上下文预算按阶段给，避免 report 因 24000 字符上限丢掉上游表格 */
const CONTEXT_MAX_CHARS: Record<PhaseName, number> = {
  intake: 8_000, intel: 16_000, creator: 16_000,
  playbook: 24_000, budget: 16_000, report: 48_000,
};
```

`contextBlock(payload, maxChars)` 的签名已经支持第二参数（`prompts.ts:68`），
`buildPrompt` 传 `CONTEXT_MAX_CHARS[phase]` 即可。
`config` 包补 `report.maxTokens` 与 `report.contextMaxChars` 两个 env（`.env.example` 同步）。

### 7.2 golden 回归（防"改一版退一版"）

- `tests/golden/report.depth.json`：mock 模式跑一遍，落盘 `DepthReport`（页数/块型/占比）。
- `tests/e2e.test.ts` 新增 `E2E-11 报告深度回归`：

```ts
const depth = measureReportDepth(dsl);
assert.ok(depth.slides >= 12, `页数不足：${depth.slides}`);
assert.ok(depth.missingRequiredTypes.length === 0, `缺块型：${depth.missingRequiredTypes}`);
assert.ok(depth.traceableRatio >= 0.6, `可溯源引用占比过低：${depth.traceableRatio}`);
assert.ok(dsl.sourceDeclaration.sources.every((s) => catalogKeys.has(s.key)), "声明了不存在的来源");
```

- `npm run check:boundaries` 必须仍然通过（新增的 `governance → contracts/storage` 依赖已在矩阵内，
  无需改白名单；若把目录建在 render 里则会当场红——这正是边界检查的价值）。

---

## 8. 改动清单（按文件）

| 文件 | 改动 | 优先级 |
| --- | --- | --- |
| `packages/agent-pack/src/schemas.ts` | 重写 `ReportDslSchema.skeleton`；引用校验加严；CI/CT/PL/BR 骨架补维度 | P0-1 / P1-1 |
| `packages/contracts/src/report.ts` | `SourceCatalog` 类型；`LOGICAL_REFS`；`DslIssue.repairable`；`numericClaims` 补 chart/matrix/image/table-caption；`validateReportDsl(dsl, opts?)` | P0-2 |
| `packages/contracts/src/report-depth.ts` | **新增**：`ReportDepthPolicy` / `measureReportDepth` | P1-2 |
| `packages/governance/src/catalog.ts` | **新增**：`buildSourceCatalog` | P0-2 |
| `packages/knowledge/src/index.ts` | **新增**：`sourceIds(tenantId)` / `chunkIds(tenantId)` | P0-2 |
| `packages/agent-pack/src/agents.ts` | report 预取注入 catalog；RG 产出后自校验 + 一次回喂；深度校验；`MAX_TOKENS_BY_PHASE` / `CONTEXT_MAX_CHARS`；CT 全量风控；intel 三路检索 | P0-2 / P1 / P2-2 |
| `packages/agent-pack/src/prompts.ts` | RG 章节维度 + 颗粒度下限 + 可用源清单占位；各 Agent 补维度 | P1-2 |
| `packages/agent-pack/src/tool-impls.ts` | `cite_fact` 改为真校验；`render_outline` 输出 12 页骨架 | P0-2 / P1-2 |
| `packages/render/src/index.ts` | SVG 图表 / 象限矩阵 / 目录 / 页码 / 双栏 / image 白名单；Markdown 对齐 | P2-1 |
| `packages/orchestrator/src/pipeline.ts` | `renderReport` 传入 catalog：`render.compile(dsl, { catalog: this.deps.agentPack.sourceCatalog(ctx) })` | P0-2 |
| `apps/gateway/src/container.ts` | 装配 catalog 依赖；启动不变量断言（源清单非空） | P0-2 |
| `packages/config/src/index.ts` + `.env.example` | `BM_REPORT_MAX_TOKENS` / `BM_REPORT_CONTEXT_CHARS` / `BM_REPORT_MIN_SLIDES` | P2-2 |
| `tests/schema-coverage.test.ts` | **新增**：骨架覆盖类型全量取值（防漂移） | P0-1 |
| `tests/e2e.test.ts` | 加 E2E-11 深度回归；既有 E2E-1/3/4/5/9/10 必须继续绿 | P2-2 |
| `tests/golden/report.depth.json` | **新增**：深度基线快照 | P2-2 |

**不动**：闸门五项检查、令牌桶、三级降级链、幂等指纹、边界矩阵。

---

## 9. 实施顺序与验收

```
第 1 步  P0-1  ── 骨架对齐 + numericClaims 补块型 + 防漂移单测
         验收：schema-coverage 绿；mock 报告能出 chart/matrix 块
              ↓（依赖它才不会"放出图表却查不出无来源数字"）
第 2 步  P0-2  ── SourceCatalog + 引用校验 + RG 自校验回喂
         验收：报告不再声明千川/星图/蒲公英；声明项 100% 合法；
              可溯源引用占比 > 0
              ↓（来源可信了，才有资格谈"写更多"）
第 3 步  P1-1  ── 上游加厚（CI 三维度 / CT 分层+全量风控 / PL 日历 / BR 矩阵）
         验收：各阶段产物字段齐全；risk_screen 调用次数 = 候选人数
              ↓
第 4 步  P1-2  ── 提示词细化下限 + measureReportDepth 回喂
         验收：mock + 真实各跑 3 次，页数 ≥12、块型 ≥9
              ↓
第 5 步  P2-1  ── 渲染（SVG 图表 / 象限矩阵 / 目录 / 页码）
         验收：HTML 报告肉眼可见真图表；打印不分页错乱
              ↓
第 6 步  P2-2  ── 预算分级 + golden 回归
         验收：npm test 全绿 + check:boundaries 绿 + golden 快照锁定
```

**每一步都保持"可交付"**：第 1、2 步做完，报告就已经从"薄且来源可疑"变成"薄但可信"，
不必等全做完才见效。

---

## 10. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 校验收紧后报告被拒渲染 | 任务拿不到报告 | R1/R3/R4 全部走**降级修复**而非拒绝；只有 R6/R7 硬拒；且 RG 阶段先自校验 + 回喂，渲染期几乎不会命中 |
| 深度校验与模型能力不匹配 | 永远达不到 12 页 | 回喂只做 **1 次**；仍不达标则接受 + 落 `meta.degraded`（如实标注），不阻塞 |
| 报告变长导致截断/超时 | `E-AGENT-001` | `report` timeout 已 240s（`agents.ts:111`），maxTokens 提到 32768；实测若仍截断，改为**分页批量生成**（每页一次调用），接口形状不变 |
| KB 来源未登记被误判非法 | 合法引用被降级 | 目录同时收 `sources` 表与 KB `sourceIds`（§3.2c），并加单测固定这条行为 |
| 边界检查红 | 构建失败 | `buildSourceCatalog` 放 governance（矩阵内）；**不要**放 render |
| golden 快照过严 | 每次改动都红 | 只快照**深度指标**（页数/块型/占比），不比全文；允许"更好"（断言用 `>=`） |

---

## 11. 决策点（需要你拍板）

1. **深度不达标的处理**：默认「回喂 1 次 → 仍不达标则接受并标 degraded」。
   备选「硬失败，不出报告」/「回喂 3 次」。→ 建议保持默认。
2. **`sourceRef` 是否强制命名空间化**（`phase:intel` 而非 `intel`）：
   命名空间更干净、能做前缀校验；但会改变既有产物形状，需要一次性迁移旧报告。
   → 建议**新产物用命名空间 + 别名表兼容旧值**，旧报告不迁移。
3. **报告超长后的路径**：单次调用顶到 32k token，还是直接做**分页批量生成**（每页一次 LLM 调用，更稳但成本与耗时上升）。
   → 建议先调预算，实测截断率后再决定是否分页。
4. **是否顺带把 `web_search` 结果落进 KB-3**（把 L3 检索结果沉淀成可复用语料），
   这会让 CI 之后的阶段不必重复联网、也天然带 `chunkId` 引用。→ 属增量改动，可放 P1 之后单独立项。

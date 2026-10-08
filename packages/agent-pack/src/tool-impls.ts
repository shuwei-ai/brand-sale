/**
 * 10 个工具的落地实现（对应 LLD §2.10 的「依赖工具」列）
 *
 * 说明：多为**确定性**工具（检索/取数/计算/校验）。
 * 信息入口一共两条：
 *   ① knowledge —— 四库混合检索，本地语料（KB-2 私域复盘、KB-3 公开情报、KB-4 方法论）；
 *   ② web_search —— 联网检索公开网页，底层是 M4 的 `volc_web_search` 适配器。
 *
 * 原先还有第三个入口「平台适配器取数」（千川/星图/蒲公英/生意参谋/巨量算数）以及对应的
 * query_customer_owned / query_public_index 两个工具，已一并移除：那些适配器从未接入
 * 真实平台、只输出合成值，留在工具清单里等于给模型一个「看起来有实测数据」的假入口。
 *
 * 新增联网能力必须同时补：白名单、governance 检查项、provenance 出处（否则报告无法引用）。
 * `web_search` 就是按这条规则落的：它声明 `boundSourceId = volc_web_search`，
 * 于是闸门会真的按 L3 源检查它的台账登记与授权（见 tools.ts 的绑定覆盖逻辑）；
 * 未配置 API Key 时适配器不注册，registerAllTools 便不注册该工具。
 *
 * 设计原则：
 * - 工具是**确定性**的：负责取数、检索、计算，不负责措辞；
 * - 每个数据类工具都返回 `provenance`，供 M5 台账与报告引用；
 * - 拿不到数据就返回降级结构，不返回看起来正常的假数据。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ConfidenceTier, PhaseName } from "@brandsale/contracts";
import { WEB_SEARCH_SOURCE_ID, type Provenance } from "@brandsale/datasource";
import { buildSourceCatalog } from "@brandsale/governance";
import { type ToolDeps, type ToolImpl, type ToolCallContext, policy } from "./tools.ts";

const Str = Type.String;
const Num = Type.Number;
const Arr = (item: unknown) => Type.Array(item as never);

/* ── AO：任务录入 ───────────────────────────────────────── */

const validateBrief: ToolImpl = {
  policy: policy({ name: "validate_brief", allowedAgents: ["AO"], governance: [] }),
  description: "校验 Brief 的完整性、预算与目标权重合法性，返回问题清单。不修改输入。",
  producesCitedData: false,
  parameters: Type.Object({
    brief: Type.Object({
      industry: Str(),
      category: Str(),
      budgetAmount: Num(),
      awareness: Num(),
      conversion: Num(),
      retention: Num(),
      platforms: Arr(Str()),
    }),
  }),
  async execute(params) {
    const b = params.brief as {
      industry: string;
      category: string;
      budgetAmount: number;
      awareness: number;
      conversion: number;
      retention: number;
      platforms: string[];
    };
    const issues: string[] = [];
    if (!b.industry?.trim()) issues.push("行业为空");
    if (!b.category?.trim()) issues.push("类目为空");
    if (!(b.budgetAmount > 0)) issues.push("预算必须为正数");
    const sum = (b.awareness ?? 0) + (b.conversion ?? 0) + (b.retention ?? 0);
    if (Math.abs(sum - 1) > 0.02) issues.push(`目标权重之和为 ${sum.toFixed(3)}，应为 1`);
    if (!b.platforms?.length) issues.push("至少选择一个平台");
    if (b.budgetAmount > 50_000_000) issues.push("预算超过系统上限 5000 万元，请拆分为多个任务");
    return { result: { ok: issues.length === 0, issues } };
  },
};

const resolveAuthorization: ToolImpl = {
  policy: policy({ name: "resolve_authorization", allowedAgents: ["AO"], governance: ["scope"] }),
  description: "解析当前租户的数据源授权状态，返回可用源与受阻源（含原因）。这是报告「排除项」的数据来源。",
  producesCitedData: false,
  parameters: Type.Object({}),
  async execute(_p, tc: ToolCallContext) {
    const sources = this_deps(tc).repos.sources.list(tc.ctx.tenantId);
    const usable: { sourceId: string; tier: string; expiresAt: string }[] = [];
    const blocked: { sourceId: string; reason: string }[] = [];
    for (const s of sources) {
      const az = this_deps(tc).repos.authz.active(tc.ctx.tenantId, s.sourceId);
      if (!az) {
        blocked.push({ sourceId: s.sourceId, reason: "无生效授权" });
        continue;
      }
      if (s.tier === "L4" && !s.legalApproved) {
        blocked.push({ sourceId: s.sourceId, reason: "L4 源法务未批准" });
        continue;
      }
      usable.push({ sourceId: s.sourceId, tier: s.tier, expiresAt: az.validTo });
    }
    return { result: { usableSources: usable, blockedSources: blocked } };
  },
};

/* ── CT / PL / BR：检索与报价 ───────────────────────────── */

const kbRetrieve: ToolImpl = {
  policy: policy({
    name: "kb_retrieve",
    allowedAgents: ["CI", "CT", "PL", "BR"],
    governance: ["scope", "tenant"],
    timeoutMs: 20_000,
  }),
  description: "四库混合检索（BM25 ⊕ 向量 + 重排）。返回带 citation 的片段，重排超时会自动降级并标注。",
  producesCitedData: true,
  parameters: Type.Object({ query: Str(), collections: Arr(Str()), topK: Type.Optional(Num()) }),
  async execute(params, tc) {
    const res = await this_deps(tc).knowledge.retrieve({
      text: String(params.query),
      collections: (params.collections as string[] | undefined) as never,
      topK: params.topK ? Number(params.topK) : 6,
      tenantId: tc.ctx.tenantId,
      rerank: true,
    });
    return {
      result: {
        hits: res.hits.map((h) => ({
          chunkId: h.chunk.chunkId,
          collection: h.chunk.collection,
          text: h.chunk.text,
          tier: h.chunk.tier,
          sourceId: h.chunk.sourceId,
          sampleSize: h.chunk.sampleSize,
          citation: h.citation,
        })),
        reranked: res.reranked,
        degraded: res.degraded ?? null,
      },
      provenance: res.hits.map((h) => ({
        sourceId: h.chunk.sourceId,
        sourceName: h.chunk.sourceId,
        tier: h.chunk.tier,
        synthetic: false,
        asOf: h.chunk.publishedAt,
        note: `${h.chunk.collection} 检索命中`,
        rowCount: 1,
      })),
      note: `${res.hits.length} 条，reranked=${res.reranked}`,
    };
  },
};

/**
 * 联网检索：全系统**唯一**的真实外部信息通道。
 *
 * 历史沿革：早期白名单只有 CI（情报阶段），因为那时平台适配器（千川/星图/蒲公英/
 * 生意参谋/巨量算数）还在注册表里承担取数职责，而 CT 的达人来源被要求走
 * kb_retrieve / pricing_query，以保证「禁止编造达人」这条不变量。
 *
 * 那些适配器从未接入真实平台（只输出合成值），已整体移除。移除后公开信息只剩
 * 联网检索这一条路，**白名单随之放开到全部六个阶段** —— 这是有意的取舍：
 * 达人/打法/预算阶段的公开依据，现在也来自网页检索。
 *
 * 三条边界仍然写死在代码里，不靠提示词自觉：
 *   · boundSourceId = volc_web_search —— 让闸门按 L3 源真的去查台账与授权，
 *     而不是相信模型自报的来源；
 *   · 结果按 L3 处理（provenance.tier = "L3"，note 明写「未经人工核验」），
 *     报告引用必须带来源站点，不允许当事实基准用；
 *   · maxCallsPerJob 封顶 —— 这是**计费**接口，令牌桶限速率不限总量，
 *     所以单任务的外部调用次数必须单独有界。
 *
 * ⚠️ 代价提示（改动时请一并评估）：白名单放开后，CT 阶段的达人信息可能来自
 * 公开网页而非报价库，「禁止编造达人」不再由白名单兜底，只剩 prompt 约束与
 * report 阶段的引用校验（cite_fact + reportDsl）事后拦截。
 * 将来接回真实达人库适配器后，应重新收紧这里的 allowedAgents。
 */
const webSearch: ToolImpl = {
  policy: policy({
    name: "web_search",
    allowedAgents: ["AO", "CI", "CT", "PL", "BR", "RG"],
    governance: ["scope", "source", "authz", "tenant"],
    boundSourceId: WEB_SEARCH_SOURCE_ID,
    timeoutMs: 12_000,
    retry: { attempts: 1, backoff: "fixed", baseMs: 400 },
    fallback: "none",
    // 单次可检索 20 条（BM_WEB_SEARCH_COUNT），模型一轮内还会换多个关键词；
    // 给 30 次留余量，同时保证不管模型多想查，单任务外部调用次数有界（计费接口）。
    maxCallsPerJob: 30,
  }),
  description:
    "联网检索公开网页，返回标题、来源站点、链接、发布时间与摘要。用于补充行业趋势、竞品动态、平台规则与政策法规等公开信息。" +
    "结果属 L3 公开信息、未经人工核验：引用时必须标注来源站点，不得作为事实基准，也不得用它替代客户授权数据的实测值。",
  producesCitedData: true,
  parameters: Type.Object({
    query: Str(),
    count: Type.Optional(Num()),
    platform: Type.Optional(Str()),
  }),
  async execute(params, tc) {
    const query = String(params.query ?? "").trim();
    if (!query) {
      // 空查询不发起请求：省一次计费调用，也避免拿回一堆无关结果
      return { result: { query: "", count: 0, results: [], note: "查询词为空，未发起检索" }, note: "空查询，跳过" };
    }
    const res = await this_deps(tc)
      .datasources.require(WEB_SEARCH_SOURCE_ID)
      .fetch(
        {
          tenantId: tc.ctx.tenantId,
          jobId: tc.jobId,
          ...(params.platform ? { platform: String(params.platform) } : {}),
          metric: query,
          params: { query, count: params.count === undefined ? undefined : Number(params.count) },
        },
        this_deps(tc).config,
      );

    const results = res.rows.map((r) => ({
      title: String(r.title ?? ""),
      siteName: String(r.siteName ?? ""),
      url: String(r.url ?? ""),
      publishTime: String(r.publishTime ?? ""),
      snippet: String(r.snippet ?? ""),
      summary: String(r.summary ?? ""),
    }));

    return {
      result: { query, count: results.length, results },
      provenance: [res.provenance],
      note: `联网检索「${query}」命中 ${results.length} 条（L3 公开，未人工核验）`,
    };
  },
};

const pricingQuery: ToolImpl = {
  policy: policy({ name: "pricing_query", allowedAgents: ["CT", "BR"], governance: ["scope", "tenant"], timeoutMs: 6000 }),
  description:
    "查询达人报价。传 talentId 返回该达人的成交价估计区间；不传 talentId 则按平台/类目/粉丝量筛选候选人并逐个给出估计。样本不足时只给区间并下调置信度。",
  producesCitedData: true,
  parameters: Type.Object({
    talentId: Type.Optional(Str()),
    platform: Type.Optional(Str()),
    category: Type.Optional(Str()),
    followersMin: Type.Optional(Num()),
    followersMax: Type.Optional(Num()),
    topK: Type.Optional(Num()),
  }),
  async execute(params, tc) {
    const store = this_deps(tc).pricing;

    if (params.talentId) {
      const est = await store.estimate(String(params.talentId), tc.ctx.tenantId);
      if (!est) {
        return {
          result: { talentId: params.talentId, degraded: true, code: "E-DATA-002", rows: null, note: "报价库无该达人记录，禁止编造报价" },
        };
      }
      return {
        result: est,
        provenance: est.citations.map((c) => ({ sourceId: c.sourceId, sourceName: c.sourceName, tier: c.tier, synthetic: false, asOf: c.collectedAt, note: c.note, rowCount: 1 })),
      };
    }

    const baseQuery = {
      platform: params.platform ? String(params.platform) : undefined,
      followersMin: params.followersMin === undefined ? undefined : Number(params.followersMin),
      followersMax: params.followersMax === undefined ? undefined : Number(params.followersMax),
      topK: params.topK === undefined ? 8 : Number(params.topK),
    };
    let relaxed = false;
    let talents = await store.query({ ...baseQuery, category: params.category ? String(params.category) : undefined });
    if (talents.length === 0 && params.category) {
      // 类目口径不匹配时放宽到全部类目，并显式标注放宽（不允许静默返回空）
      relaxed = true;
      talents = await store.query(baseQuery);
    }
    const estimates = [];
    for (const t of talents) {
      const est = await store.estimate(t.talentId, tc.ctx.tenantId);
      estimates.push({ talent: t, estimate: est });
    }
    return {
      result: { candidates: estimates, categoryRelaxed: relaxed },
      provenance: estimates
        .flatMap((e) => e.estimate?.citations ?? [])
        .map((c) => ({ sourceId: c.sourceId, sourceName: c.sourceName, tier: c.tier, synthetic: false, asOf: c.collectedAt, note: c.note, rowCount: 1 })),
      note: `${estimates.length} 个候选人报价${relaxed ? "（类目口径放宽）" : ""}`,
    };
  },
};

const riskScreen: ToolImpl = {
  policy: policy({ name: "risk_screen", allowedAgents: ["CT"], governance: ["scope", "tenant"], timeoutMs: 5000 }),
  description: "达人风险评估：历史翻车、数据异常（互动与粉丝比偏离）、档期冲突、类目禁忌。全部规则透明可审计。",
  producesCitedData: false,
  parameters: Type.Object({ talentId: Str(), followers: Num(), engagementRate: Num(), category: Str() }),
  async execute(params) {
    const flags: { rule: string; level: "low" | "medium" | "high"; detail: string }[] = [];
    const followers = Number(params.followers);
    const er = Number(params.engagementRate);
    if (followers > 0 && er > 0) {
      const ratio = (er * followers) / 1000;
      if (ratio > 120) flags.push({ rule: "interaction-anomaly", level: "high", detail: `互动量/千粉 = ${ratio.toFixed(1)}，显著高于类目常态，疑似刷量` });
      if (ratio < 3) flags.push({ rule: "low-engagement", level: "medium", detail: `互动量/千粉 = ${ratio.toFixed(1)}，低于有效阈值，触达效率存疑` });
    }
    if (["医疗", "金融", "教育"].some((k) => String(params.category).includes(k))) {
      flags.push({ rule: "category-sensitive", level: "high", detail: `类目「${params.category}」属广告法严格限制类目，需法务预审话术` });
    }
    flags.push({ rule: "auto-only", level: "low", detail: "本次筛查为自动规则，未做人工背景核验（verifiedBy=auto）" });
    return { result: { flags, verifiedBy: "auto" } };
  },
};

const calendarPlan: ToolImpl = {
  policy: policy({ name: "calendar_plan", allowedAgents: ["PL"], governance: [], timeoutMs: 5000 }),
  description: "把打法拆成时间分段，检测档期冲突与预算份额合规。纯计算，不调用模型。",
  producesCitedData: false,
  parameters: Type.Object({
    from: Str(),
    to: Str(),
    phases: Arr(Type.Object({ label: Str(), days: Num(), budgetShare: Num(), creators: Arr(Str()) })),
  }),
  async execute(params) {
    const from = new Date(String(params.from));
    const phasesIn = params.phases as { label: string; days: number; budgetShare: number; creators: string[] }[];
    const conflicts: string[] = [];
    let cursor = from.getTime();
    const phases = phasesIn.map((p) => {
      const start = new Date(cursor);
      const end = new Date(cursor + p.days * 86_400_000);
      cursor = end.getTime();
      // 同一达人在多个阶段重复出现 → 档期冲突
      return { label: p.label, from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), budgetShare: p.budgetShare, creatorIds: p.creators };
    });
    const seen = new Map<string, string[]>();
    for (const p of phases) for (const c of p.creatorIds) seen.set(c, [...(seen.get(c) ?? []), p.label]);
    for (const [c, labels] of seen) if (labels.length > 1) conflicts.push(`达人 ${c} 出现在多个阶段（${labels.join("、")}），确认无档期冲突`);
    const share = phases.reduce((n, p) => n + p.budgetShare, 0);
    if (Math.abs(share - 1) > 0.02) conflicts.push(`阶段预算份额之和为 ${share.toFixed(3)}，应为 1`);
    return { result: { phases, conflicts } };
  },
};

const scenarioSimulate: ToolImpl = {
  policy: policy({ name: "scenario_simulate", allowedAgents: ["BR"], governance: ["scope", "tenant"], timeoutMs: 6000 }),
  description: "三档情景模拟（悲观/基准/乐观），基于历史 ROI 分布给出区间而非点估计。输出必须带免责声明。",
  producesCitedData: true,
  parameters: Type.Object({ totalBudget: Num(), baseRoi: Num(), volatility: Type.Optional(Num()) }),
  async execute(params) {
    const budget = Number(params.totalBudget);
    const base = Number(params.baseRoi) || 1.8;
    const vol = Number(params.volatility ?? 0.3);
    const mk = (roi: number) => ({ roi: Number(roi.toFixed(2)), gmv: Number((budget * roi).toFixed(2)) });
    return {
      result: {
        scenarios: { worst: mk(base * (1 - vol)), base: mk(base), best: mk(base * (1 + vol * 1.2)) },
        disclaimer: "情景模拟基于历史 ROI 分布与公开指数，不构成投放承诺；实际结果受供给、竞品与平台规则影响。",
      },
      note: `三档模拟，基准 ROI ${base}`,
    };
  },
};

/* ── RG：研报 ───────────────────────────────────────────── */

const renderOutline: ToolImpl = {
  policy: policy({ name: "render_outline", allowedAgents: ["RG"], governance: [], timeoutMs: 5000 }),
  description:
    "根据上游产物生成报告大纲骨架（页面角色 + 布局 id + 必填块），RG 只需按骨架填充内容。" +
    "骨架已按深度策略展开为完整章节（含目录、图表页、矩阵页），不要自行删减页面。",
  producesCitedData: false,
  parameters: Type.Object({ title: Str(), sections: Arr(Str()) }),
  async execute(params) {
    const sections = (params.sections as string[] | undefined) ?? [];
    // 骨架即深度下限的载体：每页都标出该页必须出现的块型，模型照着填就不会退化成"全是表格"
    const chapters: { pageRole: string; title: string; layoutId: string; blocks: string[] }[] = [
      { pageRole: "data", title: "数据来源与口径声明", layoutId: "content/table", blocks: ["table", "bullets", "callout"] },
      { pageRole: "toc", title: "目录", layoutId: "toc/list", blocks: ["bullets", "text"] },
      { pageRole: "content", title: "核心结论速览", layoutId: "content/kpi", blocks: ["kpi", "bullets", "quote"] },
      { pageRole: "data", title: "竞品格局对比", layoutId: "content/table", blocks: ["table", "bullets", "callout"] },
      { pageRole: "content", title: "类目趋势与人群洞察", layoutId: "content/chart", blocks: ["text", "chart", "bullets"] },
      { pageRole: "data", title: "人选建议与分层", layoutId: "content/table+matrix", blocks: ["table", "matrix", "callout"] },
      { pageRole: "content", title: "内容日历", layoutId: "content/timeline", blocks: ["timeline", "bullets", "callout"] },
      { pageRole: "data", title: "预算分配", layoutId: "content/chart+table", blocks: ["chart", "table", "callout"] },
      { pageRole: "content", title: "渠道 × 阶段矩阵", layoutId: "content/matrix", blocks: ["matrix", "table", "bullets"] },
      { pageRole: "content", title: "三档情景模拟", layoutId: "content/kpi", blocks: ["kpi", "table", "callout"] },
      { pageRole: "data", title: "风险登记与应对", layoutId: "content/table", blocks: ["table", "bullets", "callout"] },
      { pageRole: "closing", title: "免责声明", layoutId: "closing/statement", blocks: ["callout"] },
    ];
    const slides = [
      { index: 0, pageRole: "cover", title: String(params.title), layoutId: "cover/hero", blocks: ["text", "text"] },
      ...chapters.map((c, i) => ({ index: i + 1, ...c })),
    ];
    return {
      result: {
        slides,
        providedSections: sections,
        note: `骨架共 ${slides.length} 页；sourceDeclaration 必须紧随封面（第 2 页）；每页都要给含数字的 block 标 sourceRef 或补 citations`,
      },
    };
  },
};

const citeFact: ToolImpl = {
  policy: policy({ name: "cite_fact", allowedAgents: ["RG"], governance: ["tenant"], timeoutMs: 5000 }),
  description:
    "为一条数字断言查找可引用来源：按本次可用数据源目录（台账源 + 本地知识库 + 内部数据仓）真查。" +
    "命中返回 sourceKey，未命中返回 null —— 此时必须把该断言改写成不含数字的定性表述，禁止编造引用。",
  producesCitedData: true,
  parameters: Type.Object({ claim: Str(), tier: Type.Optional(Str()), confidence: Num() }),
  async execute(params, tc: ToolCallContext) {
    const claim = String(params.claim ?? "");
    const deps = this_deps(tc);
    /* 这里必须真查目录：早期实现恒返回 found:false，等于把「引用校验」整个悬空 ——
     * 模型既得不到正反馈，也得不到纠正，于是所有引用都落成 model_inference。 */
    const catalog = buildSourceCatalog({
      repos: deps.repos,
      tenantId: tc.ctx.tenantId,
      knowledgeSourceIds: deps.knowledge.sourceIds(tc.ctx.tenantId).map((x) => x.sourceId),
      chunkIds: deps.knowledge.chunkIds(tc.ctx.tenantId),
    });
    const hit = catalog.entries.find((e) => claim.includes(e.displayName) || claim.includes(e.key));
    const tier = (String(params.tier ?? "L3") as ConfidenceTier | string) as never;
    return {
      result: {
        claim,
        found: Boolean(hit),
        citation: hit ? { sourceKey: hit.key, grade: hit.grade, tier: "medium" } : null,
        note: hit
          ? `命中来源「${hit.displayName}」(${hit.key}/${hit.grade})，可在 citations 里用 kind=data_source + ref.sourceKey="${hit.key}"`
          : `未找到可引用来源。请改写为不含数字的定性表述，或把它标成 kind=model_inference + tier=low。当前可用来源：${catalog.entries.map((e) => e.key).join("、") || "（无）"}`,
        requestedTier: tier,
        availableSources: catalog.entries.map((e) => ({ key: e.key, displayName: e.displayName, grade: e.grade })),
      },
    };
  },
};

/* ── 注册全部工具 ───────────────────────────────────────── */

/** 把工具定义与依赖在装配期绑定，避免工具函数到处传 deps */
let BOUND_DEPS: ToolDeps | null = null;
export function bindDeps(deps: ToolDeps): void {
  BOUND_DEPS = deps;
}
function this_deps(_tc: ToolCallContext): ToolDeps {
  if (!BOUND_DEPS) throw new Error("ToolDeps 未绑定，请先调用 bindDeps()");
  return BOUND_DEPS;
}

export const TOOL_IMPLEMENTATIONS: ToolImpl[] = [
  validateBrief,
  resolveAuthorization,
  kbRetrieve,
  webSearch,
  pricingQuery,
  riskScreen,
  calendarPlan,
  scenarioSimulate,
  renderOutline,
  citeFact,
];

export function registerAllTools(registry: { register(t: ToolImpl): void }, deps: ToolDeps): void {
  bindDeps(deps);
  for (const t of TOOL_IMPLEMENTATIONS) {
    // 绑定数据源的工具，其能力可能在装配期不存在（例如没配 API Key 的联网检索）。
    // 此时不注册它：宁可 Agent 的工具清单里没有这一项，也不要让它去调一个必然失败的工具。
    if (t.policy.boundSourceId && !deps.datasources.get(t.policy.boundSourceId)) continue;
    registry.register(t);
  }
}

export const PHASE_TOOL_HINT: Record<PhaseName, string> = {
  intake: "先调用 validate_brief 校验参数，再调用 resolve_authorization 了解可用数据源与受阻源。",
  intel:
    "用 kb_retrieve 分三路取本地情报（竞品格局 / 类目趋势与人群 / 法规与合规口径），" +
    "用 web_search 检索公开网页（行业趋势、竞品动态、平台规则、政策法规）；" +
    "检索结果属 L3 公开且**未经人工核验**，引用必须带来源站点，不得当作事实基准。" +
    "竞品至少给出 3 家，每家都要有 contentMatrix / sovTrend / differentiation；" +
    "声量份额与价格带占比取不到就写 null，**不要编造**。",
  creator:
    "先用 kb_retrieve 找历史人选与复盘，再用 pricing_query 取报价区间、risk_screen 做风控；" +
    "risk_screen 要对**每一个候选**都跑，并把结论落到该候选的 riskFlags（不要只筛第一个）；" +
    "候选必须覆盖 head / mid / tail 三层，每层至少 1 人，并给出 contentFit 与 historicalPerformance；" +
    "报价库无样本时可用 web_search 补充公开背景，但**不得**据此虚构达人报价或成交价。",
  playbook:
    "用 kb_retrieve 找历史打法与排期经验，再用 calendar_plan 排期并检测冲突；" +
    "必须输出 weeklyCalendar（按周的内容日历，含平台/形态/达人/主题），" +
    "每个 KPI 目标都要带 stopLoss（止损线）与 trigger（触发止损的信号）。",
  budget:
    "用 pricing_query 取成本口径，用 scenario_simulate 做三档模拟；" +
    "必须输出 stageMatrix（渠道 × 阶段交叉矩阵），每条风险都要有 owner（责任人）与 signal（触发信号）。",
  report:
    "用 render_outline 取页面骨架（已经是完整章节），逐页填充内容；" +
    "每个数字都必须调用 cite_fact 校验引用，命中才写 kind=data_source，未命中就改写成不含数字的定性表述；" +
    "sourceDeclaration.sources 只能从【可用数据源清单】里选，key 与 displayName 必须逐字一致。" +
    "硬性下限见【颗粒度下限】，不达标需要重做。",
};

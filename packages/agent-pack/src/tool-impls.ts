/**
 * 工具的实现（对应 LLD §2.10 的「依赖工具」列）
 *
 * 说明：多为**确定性**工具（检索/取数/计算/校验）。
 * 外部信息入口分三类，全部按 L3 处理、全部由 `boundSourceId(s)` 绑死来源：
 *   ① knowledge —— 四库混合检索，本地语料（KB-2 私域复盘、KB-3 公开情报、KB-4 方法论）；
 *   ② web_search —— 联网检索公开网页，底层是 M4 的 `volc_web_search` 适配器；
 *   ③ platform_digest —— **跨平台聚合**采集公开内容，底层是七个 `mc_<平台>` 适配器，
 *      经 apps/collector sidecar 复用 MediaCrawler。
 *
 * ②③ 的共同点：都是**公开但未经人工核验**的第三方内容，只能支撑"关于他人"的公开断言。
 * 涉及甲方自身经营指标（ROI、店铺 GMV、投放成本）的断言，只能来自 L1/L2 授权数据 ——
 * 这条边界由 report 阶段的引用分级兜底，而工具描述负责让模型事前就知道不该越界。
 *
 * ③ 的形态是**一个聚合工具**而不是七个并列工具：七个平台除了名字、称呼与算子集几乎完全相同，
 * 而"跨平台怎么合并、哪些指标可比"是确定性计算、不该交给模型（见 platformDigest 的注释）。
 * 七个 `makePlatformTool` 生成的单平台工具仍然注册、仍然逐源受治理，但标记 `hidden` ——
 * 它们是**实现原语**，不是模型的入口。
 *
 * ⚠️ ③ 的可用性还多一道**许可证闸**（MediaCrawler 为非商用许可）：
 * 只有 `BM_MC_LICENSE_ACK=true` 且 collector 地址已配时才会装配。见
 * packages/datasource/src/media-crawler.ts 的文件头。
 *
 * 原先还有两类入口，均已移除：
 *   · 「平台适配器取数」（千川/星图/蒲公英/生意参谋/巨量算数）与对应的
 *     query_customer_owned / query_public_index —— 那些适配器从未接入真实平台、只输出合成值，
 *     留在工具清单里等于给模型一个「看起来有实测数据」的假入口；
 *   · 早期的 douyin_creator / douyin_comments / xhs_creator / xhs_note
 *     —— 由本轮的七平台采集能力取代（覆盖面从 2 个平台扩到 7 个）。
 *
 * 新增外部能力必须同时补：白名单、governance 检查项、provenance 出处（否则报告无法引用）。
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
import type { ConfidenceTier, PhaseName, ToolPolicy } from "@brandsale/contracts";
import {
  BRIEF_PLATFORM_TO_MC,
  COMMENT_METRIC_KEYS,
  CONTENT_METRIC_KEYS,
  MEDIA_CRAWLER_PLATFORM_META,
  MEDIA_CRAWLER_PLATFORMS,
  comparableCommentMetrics,
  comparableContentMetrics,
  type CollectOp,
  type MediaCrawlerPlatform,
  type MediaCrawlerPlatformMeta,
} from "@brandsale/config";
import { CREATOR_ROW_TYPE, WEB_SEARCH_SOURCE_ID, type Provenance } from "@brandsale/datasource";
import { buildSourceCatalog } from "@brandsale/governance";
import { toEvidenceEntries, type EvidenceRowInput } from "./evidence.ts";
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
  description:
    "解析当前租户的数据源授权状态，返回可用源、受阻源（含原因）与「已授权但采集能力未装配」的源。这是报告「排除项」的数据来源。",
  producesCitedData: false,
  parameters: Type.Object({}),
  async execute(_p, tc: ToolCallContext) {
    const deps = this_deps(tc);
    const sources = deps.repos.sources.list(tc.ctx.tenantId);
    // 已装配的适配器：只有它有数据可取。台账登记 ≠ 能力就绪（见 buildSourceCatalog 的同名说明）
    const assembled = new Set(deps.datasources.list().map((a) => a.sourceId));
    const usable: { sourceId: string; tier: string; expiresAt: string }[] = [];
    const blocked: { sourceId: string; reason: string }[] = [];
    const capabilityMissing: { sourceId: string; tier: string; reason: string }[] = [];
    for (const s of sources) {
      const az = deps.repos.authz.active(tc.ctx.tenantId, s.sourceId);

      // 一次性收集**所有**未通过的门，而不是命中第一条就返回。
      //
      // 早先的写法是"先查授权 → 再查法务"，于是 L4 源在既无授权又未过法务时，
      // 报告只会显示「无生效授权」—— 读者会以为补个授权就能用，而 L4 实际上
      // 还差法务批准与 config.tiers.L4 两道门。排除项存在的意义就是告诉读者
      // "还差什么"，所以必须把门列全，而不是只报第一道。
      const l4Unapproved = s.tier === "L4" && !s.legalApproved;
      const reasons: string[] = [];
      if (!az) reasons.push("无生效授权");
      if (l4Unapproved) reasons.push("L4 源法务未批准");
      if (!az || l4Unapproved) {
        blocked.push({ sourceId: s.sourceId, reason: reasons.join("；") });
        continue;
      }
      // 授权与法务都过了，但适配器没装配（平台采集源在许可未确认 / collector 未配置时如此）。
      // 单列一类而不是塞进 blocked：它的"缺什么"完全不同——不是补授权，而是去开开关，
      // 混在一起读者会按"补授权"去处理，白费功夫。
      if (!assembled.has(s.sourceId)) {
        capabilityMissing.push({
          sourceId: s.sourceId,
          tier: s.tier,
          reason: "已授权，但采集能力未装配（平台采集源需开启 BM_MC_ENABLED + BM_MC_LICENSE_ACK 并配置 collector）",
        });
        continue;
      }
      usable.push({ sourceId: s.sourceId, tier: s.tier, expiresAt: az.validTo });
    }
    return { result: { usableSources: usable, blockedSources: blocked, capabilityMissing } };
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
    // ⚠️ 必须**大于** `BM_WEB_SEARCH_TIMEOUT_MS`（默认 20000），否则工具层先超时，
    //    env 里把检索超时调大完全不生效（适配器还没走到自己的 AbortController 就被掐断）。
    //    真机实测检索耗时 0.4–1.7s，这里是给长尾兜底，不是常态等待。
    timeoutMs: 22_000,
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
      // 与 AgentPack.sourceCatalog 保持一致：只有装配了适配器的源才算"可引用来源"
      availableSourceIds: deps.datasources.list().map((a) => a.sourceId),
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

/* ── 七个平台内容工具（MediaCrawler / collector sidecar）──── */

/**
 * 平台码 → 工具名。刻意在工具层定义（而不是塞进 config 的平台元数据）：
 * 工具名是"模型看到的东西"，属于工具层的命名自由；台账源 ID 才是需要全局一致的标识，
 * 那个在 config 的元数据里。两者分开，改名不会牵动台账。
 */
export const PLATFORM_TOOL_NAME: Record<MediaCrawlerPlatform, string> = {
  xhs: "xhs_web",
  dy: "douyin_web",
  ks: "kuaishou_web",
  bili: "bilibili_web",
  wb: "weibo_web",
  tieba: "tieba_web",
  zhihu: "zhihu_web",
};

/** 正文截断上限：单条内容的正文对判断"讲什么"绰绰有余，全量回灌只会挤爆上下文 */
const TEXT_MAX = 400;
const clip = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s);

/**
 * 生成一个平台内容工具。
 *
 * 白名单取 `["CI", "CT"]` 两种角色：
 *   · CI（竞品情报）用 search / content_detail / comments 取"关于他人"的公开内容与口碑；
 *   · CT（人选匹配）用 creator 取该达人**个人主页的公开统计**（粉丝量/关注数），
 *     也可用来取 TA 名下的公开作品。内核的 `save_creator` 已从"教学版空实现"改为
 *     真正落盘主页公开统计（实测小红书 `fans: 2373`、抖音 `follower_count` 均可取到）。
 *     注意两点：① creatorId 必须是平台**原始 UID**（归一化结果里的 authorId 是脱敏哈希，
 *     喂回去必然失败）；② 若只要主页统计、不要作品，走 collector 的自动补采
 *     （搜索完成即按作者补一次，`profileOnly`），不必在这里手动调。
 * 不给 PL/BR/RG：排期、预算、研报阶段的数字必须来自授权数据与报价库，不该从平台公开内容里凑。
 *
 * **对模型隐藏**（`hidden: true`）：这七个是**受治理的实现原语**，不是给模型用的入口。
 * 模型只面对聚合工具 `platform_digest`。理由见 ToolPolicy.hidden 的注释——七个同形工具
 * 并列时模型既容易选错，也几乎必然自己在上下文里手工合并跨平台结果，而跨平台可比性
 * 恰恰是 LLM 做不准的部分（拿 B站投币数去比小红书点赞就是这么来的）。
 * 隐藏不影响治理：它们仍然注册、仍然逐个过闸门，单测也仍然直接调用它们。
 *
 * 不走并行（parallelism: "sequential"）：collector 底层是 MediaCrawler 的**单进程串行**执行器，
 * 并行只会让多个调用一起排队，反而更慢。
 *
 * retry 设 0：采集是分钟级的，失败立刻重试也来不及；真正该做的是让它排队、下次再取。
 * 工具执行本身很快（读 collector 缓存），但首次会触发一次后台采集，所以超时给得比 web_search 宽。
 */
function makePlatformTool(meta: MediaCrawlerPlatformMeta): ToolImpl {
  const toolName = PLATFORM_TOOL_NAME[meta.platform];
  const opList = meta.ops.join(" / ");
  return {
    policy: policy({
      name: toolName,
      allowedAgents: ["CI", "CT"],
      governance: ["scope", "source", "authz", "tenant"],
      boundSourceId: meta.sourceId,
      hidden: true,
      timeoutMs: 15_000,
      retry: { attempts: 0, backoff: "fixed", baseMs: 0 },
      fallback: "none",
      parallelism: "sequential",
      // 每次调用都可能触发一次后台采集；平台侧有频控，单任务 20 次封顶
      maxCallsPerJob: 20,
    }),
    description:
      `采集 ${meta.displayName}平台内的**公开内容**（${meta.contentNoun}/${meta.creatorNoun}/评论）。` +
      `op 取值：${opList}。` +
      `search 传 keyword 搜${meta.contentNoun}；content_detail / comments 传 contentId（或 url）；` +
      `creator 传 creatorId 取该${meta.creatorNoun}的个人主页公开统计（粉丝量/关注数）与名下作品。` +
      `注意 creatorId 必须是平台**原始 UID**：本系统归一化结果里的 authorId 是脱敏哈希，喂回去必然失败。` +
      `通常不必手动调 —— 搜索采集完成后系统会自动按作者补采一次主页统计（见 collector 的 profileEnrich）。` +
      `结果属 L3 公开信息、**未经人工核验**，且与平台无授权合同：引用必须注明"公开采集"，` +
      `只能支撑关于他人的公开断言，**不得**当作甲方自身的实测经营数据。` +
      `数据来自本机采集缓存：首次调用可能返回 0 条并已在后台排队采集，稍后重试即可拿到；` +
      `某平台首次需要登录态时，采集子进程会自拉起浏览器窗口等待扫码（登录态存在本机、后续复用），` +
      `扫码后该次采集仍需数分钟。`,
    producesCitedData: true,
    parameters: Type.Object({
      op: Str(),
      keyword: Type.Optional(Str()),
      contentId: Type.Optional(Str()),
      creatorId: Type.Optional(Str()),
      url: Type.Optional(Str()),
      limit: Type.Optional(Num()),
    }),
    async execute(params, tc) {
      const op = String(params.op ?? "").trim();
      // 非法 op 不抛错，而是回一条**可操作**的说明：模型据此就能自己改正，
      // 抛错则会被降级链包成 E-DATA-002，模型误以为是基础设施故障、改去重试。
      if (!(meta.ops as readonly string[]).includes(op)) {
        return {
          result: {
            platform: meta.platform,
            rows: [],
            invalidOp: op || "(空)",
            validOps: meta.ops,
            note: `${meta.displayName}不支持算子「${op}」。可用：${opList}`,
          },
          note: `算子非法：${op || "(空)"}`,
        };
      }
      const collectOp = op as CollectOp;
      const need = collectOp === "search" ? "keyword" : collectOp === "creator" ? "creatorId" : "contentId（或 url）";
      const provided =
        collectOp === "search"
          ? String(params.keyword ?? "").trim()
          : collectOp === "creator"
            ? String(params.creatorId ?? "").trim()
            : String(params.contentId ?? params.url ?? "").trim();
      if (!provided) {
        return {
          result: {
            platform: meta.platform,
            op: collectOp,
            rows: [],
            note: `${meta.displayName} ${collectOp} 需要 ${need}`,
          },
          note: `缺参数 ${need}`,
        };
      }

      const res = await this_deps(tc)
        .datasources.require(meta.sourceId)
        .fetch(
          {
            tenantId: tc.ctx.tenantId,
            jobId: tc.jobId,
            metric: provided,
            limit: params.limit === undefined ? 20 : Math.max(1, Math.min(100, Number(params.limit))),
            params: {
              op: collectOp,
              keyword: params.keyword === undefined ? undefined : String(params.keyword),
              contentId: params.contentId === undefined ? undefined : String(params.contentId),
              creatorId: params.creatorId === undefined ? undefined : String(params.creatorId),
              url: params.url === undefined ? undefined : String(params.url),
            },
          },
          this_deps(tc).config,
        );

      const mapped = res.rows.map((r) => ({
        id: String(r.id ?? ""),
        title: String(r.title ?? ""),
        text: clip(String(r.text ?? "")),
        author: String(r.author ?? ""),
        authorId: String(r.authorId ?? ""),
        ...(typeof r.uid === "string" && r.uid.trim() ? { uid: r.uid.trim() } : {}),
        url: String(r.url ?? ""),
        publishedAt: String(r.publishedAt ?? ""),
        metrics: (r.metrics as Record<string, number> | undefined) ?? {},
        // 资料行（作者主页）与内容行分流：资料行只提供粉丝数/主页链接，
        // 不能混进"本批内容条数"或跨平台指标对比
        rowType: r.rowType === CREATOR_ROW_TYPE ? CREATOR_ROW_TYPE : "content",
      }));
      const rows = mapped.filter((r) => r.rowType !== CREATOR_ROW_TYPE);
      const creators = mapped.filter((r) => r.rowType === CREATOR_ROW_TYPE);

      /* 证据登记必须发生在**返回给模型之前**：这样 entryId 是系统生成的，
       * 模型只能引用、不能发明（见 evidence.ts 的文件头）。 */
      registerEvidence(tc, rows, {
        platform: meta.platform,
        platformName: meta.displayName,
        op: collectOp,
        collectedAt: res.provenance?.asOf,
      });
      // 资料行按 op=creator 单独登记：报告据此拿到"这个账号的粉丝数"（见 synthesis.ts）
      registerEvidence(tc, creators, {
        platform: meta.platform,
        platformName: meta.displayName,
        op: "creator",
        collectedAt: res.provenance?.asOf,
      });

      return {
        result: {
          platform: meta.platform,
          platformName: meta.displayName,
          op: collectOp,
          count: rows.length,
          rows,
          ...(creators.length > 0 ? { creators } : {}),
          note:
            rows.length === 0
              ? "本地无采集缓存。已在后台排队采集，请稍后用**不同参数**再试一次本工具（采集受平台频控，通常几十秒到几分钟）；若仍为空，按「本次该平台没有命中数据」如实处理，不要用同一参数反复调用。"
              : `L3 公开内容、未经人工核验；引用须注明平台与账号。` +
                (creators.length > 0
                  ? `另附 ${creators.length} 位作者的个人主页公开统计（粉丝量 followers / 关注 follows / 主页链接）。`
                  : ""),
        },
        provenance: [res.provenance],
        note: `${meta.displayName} ${collectOp} 命中 ${rows.length} 条（L3 公开，未人工核验）`,
      };
    },
  };
}

export const PLATFORM_TOOLS: ToolImpl[] = MEDIA_CRAWLER_PLATFORMS.map((p) =>
  makePlatformTool(MEDIA_CRAWLER_PLATFORM_META[p]),
);

/* ── 跨平台聚合工具（模型唯一可见的平台入口）─────────────── */

export const PLATFORM_DIGEST_TOOL_NAME = "platform_digest";

/** 采集码 / 业务码 → 采集码。让模型既能传 `xhs` 也能传 `xiaohongshu` */
function resolvePlatformCode(raw: string): MediaCrawlerPlatform | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if ((MEDIA_CRAWLER_PLATFORMS as readonly string[]).includes(s)) return s as MediaCrawlerPlatform;
  return BRIEF_PLATFORM_TO_MC[s];
}

/** 算子 → 该算子产出的记录属于内容层还是评论层（决定用哪张指标表算可比集） */
const SCOPE_BY_OP: Record<CollectOp, "content" | "comment"> = {
  search: "content",
  content_detail: "content",
  creator: "content",
  comments: "comment",
};

/**
 * 跨平台聚合取数：**一次调用覆盖多个平台**，并在结果里直接给出"哪些指标可以横向比"。
 *
 * 为什么要有这层（而不是让模型逐个调七个平台工具）：
 *   1. **可比性判断不该交给模型**。七个平台的指标丰度差得很远（B站有播放/投币、贴吧只有
 *      正文+评论数、快手没有评论总数），模型在上下文里手工合并时几乎必然把某个平台独有的
 *      指标拿来横向比。这个函数的返回值里带了 `comparison`，把"本组平台的共有指标"算好给它。
 *   2. **闸门要逐源过**。绑多个源不代表放开来源：每个平台仍然按它自己的 `sourceId` 单独跑一次
 *      source/authz/tenant/scope，未通过的平台被**跳过并记名**，而不是让整只工具失败——
 *      一个未授权的平台不该拖垮另外六个。
 *   3. **工具面收敛**。模型看到的平台入口只有这一个。
 *
 * 与单平台工具的关系：聚合工具**复用**同一个 `mc_<平台>` 适配器与同一套归一化结果，
 * 只是把"调七次 + 自己合并"固化成一个确定性步骤。
 */
const platformDigest: ToolImpl = {
  policy: policy({
    name: PLATFORM_DIGEST_TOOL_NAME,
    /* `RG` 是 2026-10-20 加的：报告阶段终稿前要补读一次平台数据（作者主页资料行比 creator
     * 阶段晚到，见 `agents.ts:refreshPlatformData` 的长注释）。不加它，那次补读会撞
     * 「工具不在 RG 白名单」→ 补读失效 + 报告多一条无意义的降级项（这正是隐藏在
     * "粉丝量永远未采集"后面的第四层原因）。系统侧补取走 `systemCall`，不计入
     * `maxCallsPerJob`；模型在 report 阶段即使主动调它也受同一个 8 次上限约束。 */
    allowedAgents: ["CI", "CT", "RG"],
    governance: ["scope", "source", "authz", "tenant"],
    // 七个源一起绑：任一源已装配即注册，全都没装配才不注册（否则报告会多一条假能力）
    boundSourceIds: MEDIA_CRAWLER_PLATFORMS.map((p) => MEDIA_CRAWLER_PLATFORM_META[p].sourceId),
    timeoutMs: 45_000,
    retry: { attempts: 0, backoff: "fixed", baseMs: 0 },
    fallback: "none",
    parallelism: "sequential",
    // 一次调用可能扇出到 7 个平台（各自触发一次后台采集），所以上限比单平台工具低得多
    maxCallsPerJob: 8,
  }),
  description:
    "跨平台聚合采集公开内容：一次调用覆盖多个平台，返回合并后的记录，**并给出本组平台的共有指标**。\n" +
    "op 取值：search（按 keyword 搜内容）/ content_detail（按 contentId 取正文）/ " +
    "comments（按 contentId 取评论）/ creator（按 creatorId 取该创作者名下作品）。\n" +
    "platforms 传平台列表（小红书=xhs 或 xiaohongshu、抖音=dy 或 douyin、快手=ks、B站=bili、" +
    "微博=wb、贴吧=tieba、知乎=zhihu）；省略则覆盖全部已装配平台。\n" +
    "**返回值 comparison.metrics 是本组平台都真实存在的指标，跨平台横向对比只能落在这些指标上**；" +
    "comparison.dropped 列出「声明共有但这批数据里全为 0」的指标（那是缺失，不是 0），" +
    "platformsSkipped 列出被跳过（未授权 / 未装配 / 采集失败）的平台 —— 这两处都必须如实写进报告，" +
    "不要当成 0 条、也不要凭空补齐。\n" +
    "结果属 L3 公开信息、**未经人工核验**，与平台无授权合同：只能支撑关于他人的公开断言，" +
    "**不得**当作甲方自身的实测经营数据。粉丝量 / 性别 / 地域等画像七个平台都拿不到，不要从这里取。\n" +
    "数据来自本机采集缓存：首次调用可能返回 0 条并已在后台排队采集，稍后重试即可拿到（至多 1–2 次、换参数；仍为空就按「本次无该平台数据」如实处理，勿反复调用）。",
  producesCitedData: true,
  parameters: Type.Object({
    op: Str(),
    platforms: Type.Optional(Arr(Str())),
    keyword: Type.Optional(Str()),
    contentId: Type.Optional(Str()),
    creatorId: Type.Optional(Str()),
    url: Type.Optional(Str()),
    limit: Type.Optional(Num()),
    /** 点名要哪些作者的资料行（创作哈希）。内部自愈补读用，模型一般不用传。 */
    authorIds: Type.Optional(Arr(Str())),
  }),
  async execute(params, tc) {
    const deps = this_deps(tc);

    const op = String(params.op ?? "").trim();
    if (!(op in SCOPE_BY_OP)) {
      return {
        result: {
          op,
          rows: [],
          invalidOp: op || "(空)",
          validOps: Object.keys(SCOPE_BY_OP),
          note: `不支持的算子「${op || "(空)"}」。可用：search / content_detail / comments / creator`,
        },
        note: `算子非法：${op || "(空)"}`,
      };
    }
    const collectOp = op as CollectOp;

    // 平台列表：显式传入的按传入顺序去重；未传则覆盖全部七个（未装配/未授权的会在下面被跳过并记名）
    const rawPlatforms = Array.isArray(params.platforms) ? (params.platforms as unknown[]).map((x) => String(x)) : [];
    const requested: MediaCrawlerPlatform[] = [];
    const unknownPlatforms: string[] = [];
    if (rawPlatforms.length === 0) {
      requested.push(...MEDIA_CRAWLER_PLATFORMS);
    } else {
      for (const raw of rawPlatforms) {
        const code = resolvePlatformCode(raw);
        if (!code) {
          unknownPlatforms.push(raw);
          continue;
        }
        if (!requested.includes(code)) requested.push(code);
      }
    }
    if (requested.length === 0) {
      return {
        result: {
          op: collectOp,
          rows: [],
          platformsRequested: [],
          unknownPlatforms,
          note: `platforms 里没有可识别的平台名${unknownPlatforms.length ? `（未识别：${unknownPlatforms.join("、")}）` : ""}`,
        },
        note: "平台参数无法识别",
      };
    }

    // 必要的检索词
    const provided =
      collectOp === "search"
        ? String(params.keyword ?? "").trim()
        : collectOp === "creator"
          ? String(params.creatorId ?? "").trim()
          : String(params.contentId ?? params.url ?? "").trim();
    const need = collectOp === "search" ? "keyword" : collectOp === "creator" ? "creatorId" : "contentId（或 url）";
    if (!provided) {
      return {
        result: { op: collectOp, rows: [], platformsRequested: requested, note: `${collectOp} 需要 ${need}` },
        note: `缺参数 ${need}`,
      };
    }

    const limit = params.limit === undefined ? 20 : Math.max(1, Math.min(100, Number(params.limit)));
    const rows: Array<Record<string, unknown>> = [];
    const creators: Array<Record<string, unknown>> = [];
    const provenance: Provenance[] = [];
    const used: MediaCrawlerPlatform[] = [];
    const skipped: Array<{ platform: MediaCrawlerPlatform; platformName: string; reason: string }> = [];

    for (const p of requested) {
      const meta = MEDIA_CRAWLER_PLATFORM_META[p];
      const adapter = deps.datasources.get(meta.sourceId);
      if (!adapter) {
        skipped.push({ platform: p, platformName: meta.displayName, reason: "能力未装配（该平台未开启采集）" });
        continue;
      }
      /* 逐源过闸门。**不能因为绑定了七个源就对闸门"批发放行"**：
       * 每个平台是独立的台账源，授权与租户隔离都按源判定；某个源未授权只影响它自己。
       * agent 从 tc 取（由 ToolRegistry.invoke 注入），保证审计日志里"谁读了哪个源"是准的。 */
      const verdict = await deps.gate.evaluate(
        {
          tenantId: tc.ctx.tenantId,
          jobId: tc.jobId,
          agent: tc.agent ?? "CI",
          tool: PLATFORM_DIGEST_TOOL_NAME,
          args: { ...params, op: collectOp, sourceId: meta.sourceId },
          checks: ["scope", "source", "authz", "tenant"],
        },
        tc.ctx,
      );
      if (!verdict.allow) {
        skipped.push({
          platform: p,
          platformName: meta.displayName,
          reason: verdict.fatal ? `被拦下（${verdict.code}）：${verdict.reason}` : `未通过闸门（${verdict.code}）：${verdict.reason}`,
        });
        continue;
      }

      try {
        const res = await adapter.fetch(
          {
            tenantId: tc.ctx.tenantId,
            jobId: tc.jobId,
            metric: provided,
            limit,
            params: {
              op: collectOp,
              keyword: params.keyword === undefined ? undefined : String(params.keyword),
              contentId: params.contentId === undefined ? undefined : String(params.contentId),
              creatorId: params.creatorId === undefined ? undefined : String(params.creatorId),
              url: params.url === undefined ? undefined : String(params.url),
              ...(Array.isArray(params.authorIds) && params.authorIds.length > 0
                ? { authorIds: (params.authorIds as unknown[]).map((x) => String(x ?? "")).filter(Boolean) }
                : {}),
            },
          },
          deps.config,
        );
        provenance.push(res.provenance);
        used.push(p);
        for (const r of res.rows) {
          // 作者主页资料行单独收集：它们只提供粉丝量/主页链接，
          // 既不算"本批内容条数"，也不参与跨平台指标对比（见 CREATOR_ROW_TYPE）
          if (r.rowType === CREATOR_ROW_TYPE) {
            creators.push({
              platform: p,
              platformName: meta.displayName,
              id: String(r.id ?? ""),
              author: String(r.author ?? ""),
              authorId: String(r.authorId ?? ""),
              // 平台原始 UID：报告里的人选标识列用它（内部哈希对读者无用，喂回采集还会失败）
              ...(typeof r.uid === "string" && r.uid.trim() ? { uid: r.uid.trim() } : {}),
              url: String(r.url ?? ""),
              text: clip(String(r.text ?? "")),
              metrics: (r.metrics as Record<string, number> | undefined) ?? {},
            });
            continue;
          }
          rows.push({
            platform: p,
            platformName: meta.displayName,
            id: String(r.id ?? ""),
            title: String(r.title ?? ""),
            text: clip(String(r.text ?? "")),
            author: String(r.author ?? ""),
            authorId: String(r.authorId ?? ""),
            url: String(r.url ?? ""),
            publishedAt: String(r.publishedAt ?? ""),
            metrics: (r.metrics as Record<string, number> | undefined) ?? {},
          });
        }
      } catch (e) {
        // 单个平台失败不拖垮整批：记名跳过，其余平台的结果照常返回。
        skipped.push({
          platform: p,
          platformName: meta.displayName,
          reason: `采集失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // ── 可比指标：本组平台的**声明交集**，再剔掉"这批数据里全为 0"的（声明存在 ≠ 本批有值）
    const scope = SCOPE_BY_OP[collectOp];
    const declaredCommon: readonly string[] =
      scope === "comment" ? comparableCommentMetrics(used) : comparableContentMetrics(used);
    const allMetricKeys: readonly string[] = scope === "comment" ? COMMENT_METRIC_KEYS : CONTENT_METRIC_KEYS;
    const dropped: string[] = [];
    const metrics: string[] = [];
    for (const k of allMetricKeys) {
      if (!(declaredCommon as readonly string[]).includes(k)) continue;
      const anyNonZero = rows.some((r) => Number((r.metrics as Record<string, number>)[k] ?? 0) > 0);
      if (anyNonZero) metrics.push(k);
      else dropped.push(k);
    }

    const perPlatform = requested.map((p) => {
      const meta = MEDIA_CRAWLER_PLATFORM_META[p];
      const declared = scope === "comment" ? meta.commentMetrics : meta.contentMetrics;
      const mine = rows.filter((r) => r.platform === p);
      const absent = declared.filter((k) => !mine.some((r) => Number((r.metrics as Record<string, number>)[k] ?? 0) > 0));
      return {
        platform: p,
        platformName: meta.displayName,
        count: mine.length,
        declaredMetrics: declared,
        // 该平台声明有、但本批数据里一条非零值都没有的指标 —— 别在报告里当 0 用
        absentMetrics: absent,
        used: used.includes(p),
      };
    });

    const noteParts = [
      `${collectOp} 覆盖 ${used.length}/${requested.length} 个平台，共 ${rows.length} 条（L3 公开，未人工核验）`,
    ];
    if (rows.length === 0 && used.length > 0) {
      noteParts.push(
        "本地无采集缓存：已在后台排队采集，请稍后用不同参数再试一次；仍为空就按「本次无平台条目」如实处理，不要用同一参数反复调用本工具",
      );
    }
    if (skipped.length) noteParts.push(`跳过 ${skipped.length} 个平台（见 platformsSkipped，不要当成 0 条）`);
    if (metrics.length === 0) {
      noteParts.push("本组平台没有共有的非零指标：**不可做跨平台横向对比**，只能逐平台定性描述");
    } else {
      noteParts.push(`可跨平台对比的指标：${metrics.join(" / ")}`);
    }
    if (dropped.length) noteParts.push(`声明共有但本批全为 0（不要当 0 用）：${dropped.join(" / ")}`);

    /* 聚合工具一次性把本批全部平台的条目登记进证据表：
     * rows 里已经带了 platform / platformName，平台名不靠调用方猜。 */
    const reg = registerEvidence(tc, rows, {
      op: collectOp,
      collectedAt: provenance[0]?.asOf,
    });
    if (reg.truncated > 0) {
      noteParts.push(`证据表已达上限，另有 ${reg.truncated} 条未登记（不影响本批分析，但不支持条目级引用）`);
    }
    // 作者主页资料（粉丝量等）按 op=creator 单独登记：报告的人选表据此拿到真实粉丝数。
    // 它们**不参与**上面的声量/指标计算 —— 粉丝数是账号级的，不是内容级的。
    if (creators.length > 0) {
      registerEvidence(tc, creators, { op: "creator", collectedAt: provenance[0]?.asOf });
      noteParts.push(`另附 ${creators.length} 位作者的主页公开统计（粉丝量 / 关注数 / 主页链接）`);
    }

    return {
      result: {
        op: collectOp,
        platformsRequested: requested,
        ...(unknownPlatforms.length ? { unknownPlatforms } : {}),
        platformsSkipped: skipped,
        platforms: perPlatform,
        comparison: {
          scope,
          /** 跨平台横向对比**只能**用这些指标 */
          metrics,
          /** 声明共有但本批数据全为 0：缺失，不是 0 */
          dropped,
          note:
            metrics.length === 0
              ? "本组平台无共有非零指标，不可横向对比"
              : `仅这 ${metrics.length} 个指标可跨平台比较（取本组平台交集）`,
        },
        totalCount: rows.length,
        rows,
        ...(creators.length > 0 ? { creators } : {}),
        note: noteParts.join("；"),
      },
      provenance,
      note: noteParts[0]!,
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

/**
 * 把这一批返回行登记进 job 证据表（P0 溯源）。
 *
 * 调用点是刻意的：**在工具 return 之前**。工具返回什么，证据表里就有什么 ——
 * 两者同源，所以"模型引用了某条内容"与"报告能给出该内容的 URL"必然一致。
 * 反过来，如果登记放在调用方（Agent 或编排层），任何一处漏调都会让报告出现
 * "引用了但查不到出处"的悬空引用。
 *
 * deps.evidence 缺省时不登记（不报错）：证据是增强能力，不该因为测试没装配就炸。
 */
function registerEvidence(
  tc: ToolCallContext,
  rows: readonly EvidenceRowInput[],
  opts: { platform?: string; platformName?: string; op: string; collectedAt?: string },
): { added: number; truncated: number; total: number } {
  const registry = this_deps(tc).evidence;
  if (!registry) return { added: 0, truncated: 0, total: 0 };
  return registry.record(tc.jobId, toEvidenceEntries(rows, opts));
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
  // 跨平台聚合：模型唯一可见的平台入口（七个单平台工具已 hidden，仅作受治理原语）
  platformDigest,
  // 七个平台内容工具（仅在许可已确认 + collector 已配置时装配，见 admitTool）
  ...PLATFORM_TOOLS,
];

/**
 * 装配期的工具准入判定。
 *
 * 抽成独立函数而不是内联在 registerAllTools 里，是为了让它**可单测**：
 * mutating 的三条约束（默认不注册 / 必须挂 authz / 必须 replaySafe=false）
 * 是安全不变量，靠"读代码确认"验证是不够的。
 *
 * 返回 `{ ok: false }` 表示"能力未就绪或未授权，静默不注册"；
 * 抛错表示"配置本身自相矛盾"，属于部署错误，必须在启动时炸出来。
 */
export function admitTool(
  policy: ToolPolicy,
  deps: Pick<ToolDeps, "config" | "datasources">,
): { ok: boolean; reason?: string } {
  // boundSourceId 与 boundSourceIds 是互斥的两种声明方式（一个源 vs 一组源）。
  // 同时写等于"来源声明有歧义"，属配置自相矛盾，启动时就炸出来。
  if (policy.boundSourceId && policy.boundSourceIds) {
    throw new Error(
      `工具 ${policy.name} 同时声明了 boundSourceId 与 boundSourceIds —— 二者互斥，只能选一种。`,
    );
  }

  // 绑定数据源的工具，其能力可能在装配期不存在（例如没配 API Key 的联网检索）。
  // 此时不注册它：宁可 Agent 的工具清单里没有这一项，也不要让它去调一个必然失败的工具。
  if (policy.boundSourceId && !deps.datasources.get(policy.boundSourceId)) {
    return { ok: false, reason: `数据源能力未就绪：${policy.boundSourceId}` };
  }

  // 聚合类工具绑**一组**源。判定比单源宽一档：**至少一个**源已装配即注册
  // （有一个平台的采集通道可用，聚合就是有意义的）。
  // 反过来"一个都没有"必须不注册 —— 否则工具清单里会出现"平台聚合可用"、
  // 而实际上每次调用都只能返回 platformsSkipped 全部平台，那是假能力。
  if (policy.boundSourceIds) {
    const ready = policy.boundSourceIds.filter((id) => deps.datasources.get(id));
    if (ready.length === 0) {
      return { ok: false, reason: `数据源能力全部未就绪：${policy.boundSourceIds.join("、")}` };
    }
  }

  // 写操作工具默认不注册。见 ToolPolicy.mutating 的注释：
  // 缺省关闭是为了让"引入写能力"成为一次显式决策——公开采集类工具包
  // 常常同时提供读与写，整包封装会让模型有机会以甲方名义产生副作用。
  if (policy.mutating) {
    if (!deps.config.tools.allowMutating) {
      return { ok: false, reason: "policy.mutating=true 但 BM_TOOLS_ALLOW_MUTATING=false" };
    }
    // 即使显式开启，写操作也必须挂授权检查：没有 authz 的写工具是不可接受的默认值。
    // 放在装配期抛错而不是运行期拒绝，是为了让配置错误在启动时就暴露，
    // 而不是等到某次任务里模型真的调用了它。
    if (!policy.governance.includes("authz")) {
      throw new Error(
        `工具 ${policy.name} 标记为 mutating 但未挂 "authz" 检查。` +
          `写操作必须有授权检查，请在 policy.governance 里加上 "authz"。`,
      );
    }
    if (policy.replaySafe) {
      throw new Error(
        `工具 ${policy.name} 标记为 mutating 但 replaySafe=true。` +
          `写操作重放会重复产生副作用，必须设为 replaySafe: false。`,
      );
    }
  }

  return { ok: true };
}

export function registerAllTools(registry: { register(t: ToolImpl): void }, deps: ToolDeps): void {
  bindDeps(deps);
  for (const t of TOOL_IMPLEMENTATIONS) {
    if (!admitTool(t.policy, deps).ok) continue;
    registry.register(t);
  }
}

export const PHASE_TOOL_HINT: Record<PhaseName, string> = {
  intake: "先调用 validate_brief 校验参数，再调用 resolve_authorization 了解可用数据源与受阻源。",
  intel:
    "用 kb_retrieve 分三路取本地情报（竞品格局 / 类目趋势与人群 / 法规与合规口径），" +
    "用 web_search 检索公开网页（行业趋势、竞品动态、平台规则、政策法规）；" +
    "工具清单里若有 platform_digest，用它一次覆盖多个平台取平台内公开内容与评论区口碑" +
    "（op=search / content_detail / comments）；" +
    "**跨平台横向对比只允许落在它返回的 comparison.metrics 上**，comparison.dropped 与 " +
    "platformsSkipped 里的东西是缺失而非 0，必须照实写进 dataGaps。" +
    "检索与采集结果都属 L3 公开且**未经人工核验**，引用必须带来源站点或平台账号，不得当作事实基准。" +
    "竞品至少给出 3 家，每家都要有 contentMatrix / sovTrend / differentiation；" +
    "声量份额与价格带占比取不到就写 null，**不要编造**。" +
    "评论者的 IP 属地是有偏样本，**不是粉丝地域**，只能标为有偏代理；" +
    "**粉丝量与人群画像（性别/年龄/地域）平台侧拿不到**，不要试图从平台内容里推。",
  creator:
    "先用 kb_retrieve 找历史人选与复盘，再用 pricing_query 取报价区间、risk_screen 做风控；" +
    "候选人的公开作品样本可用 platform_digest 的 creator 算子补（用于判断 contentFit，**不是**补粉丝量）；" +
    "⚠️ **粉丝量与画像（性别/地域/年龄）七个平台都拿不到**（上游教学版已移除创作者资料落盘），" +
    "followers 只能来自 pricing_query 或 KB-2，缺失时写 0 + 低 confidence 并在 rationale 说明「无授权来源」；" +
    "**报价与成交价必须来自报价库**，不得用公开粉丝量或作品互动量去推算；公开采集不到就留 null；" +
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

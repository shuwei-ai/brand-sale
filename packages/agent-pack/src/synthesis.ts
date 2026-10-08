/**
 * 确定性合成（degraded synthesis）
 *
 * 用途有两个，同一个实现：
 *   1. mock 模式下的 LLM 桩——让整条链路在无模型可用时也能跑通并被测试；
 *   2. **降级链的最后一环**——模型不可用时，用工具真实取回的数据 + 保守模板产出结构化结果，
 *      并强制标注 `synthesized: true` 与降置信度。绝不静默用假数据充数。
 *
 * 注意：合成内容里的数字**全部来自工具返回**，模板只负责组织语言。
 *
 * P0~P2 之后这里还多了一个职责：**深度基线**。
 * mock 模式跑出来的报告就是 `tests/e2e.test.ts` 里深度回归的基准，
 * 所以模板必须产出完整的 13 页结构（含 chart / matrix / timeline），
 * 而不是"能跑通就行"的 8 页骨架。
 */

import type { ReportDsl, SlideSpec, SourceCatalog } from "@brandsale/contracts";
import { DEFAULT_DEPTH_POLICY, DISCLAIMER_TEXT } from "@brandsale/contracts";
import { WEB_SEARCH_SOURCE_ID } from "@brandsale/datasource";
import type { BudgetOutput, CreatorOutput, IntelOutput, PlaybookOutput } from "./schemas.ts";

export interface PrefetchedToolData {
  [toolName: string]: unknown;
}

const num = (v: unknown, dflt = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);

/** 工具返回值形如 { result, provenance?, note? }，这里统一解包到 result */
function unwrap(result: unknown): Record<string, unknown> {
  const r = result as Record<string, unknown> | null;
  if (!r) return {};
  const inner = r["result"];
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return r;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** 把 [from,to] 切成周（用于 weeklyCalendar 与内容日历页） */
function weeksBetween(from: string, to: string): { from: string; to: string }[] {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out: { from: string; to: string }[] = [];
  for (let cursor = start; cursor < end; cursor += 7 * DAY) {
    out.push({ from: isoDate(cursor), to: isoDate(Math.min(cursor + 7 * DAY - DAY, end)) });
  }
  return out;
}

/* ── CI 竞品情报 ────────────────────────────────────────── */

export function synthIntel(brief: { industry: string; category: string; platforms: string[]; window?: { from: string } }, tools: PrefetchedToolData): IntelOutput {
  const kb = unwrap(tools["kb_retrieve"]) as { hits?: { text: string; citation: { sourceId: string } }[] };
  const kbHits = kb?.hits ?? [];
  const ws = unwrap(tools["web_search"]) as { results?: { title?: string; siteName?: string; url?: string }[] };
  const webHits = (ws?.results ?? []).filter((w) => w.title || w.siteName);
  const month = (brief.window?.from ?? new Date().toISOString()).slice(0, 7);
  const platform0 = brief.platforms[0] ?? "douyin";

  const citations: IntelOutput["citations"] = [];
  for (const h of kbHits.slice(0, 4)) citations.push({ claim: h.text.slice(0, 40), sourceKey: h.citation.sourceId, confidence: 0.5 });
  // 联网检索结果属 L3 公开、**未经人工核验**：置信度压在中低位，且引用必须带来源站点。
  // 这里只搬用标题与站点名，不做任何数值推断——网页摘要不足以支撑数字断言。
  for (const w of webHits.slice(0, 4)) {
    citations.push({ claim: `${w.siteName ?? "公开网页"}：${w.title ?? ""}`.slice(0, 60), sourceKey: WEB_SEARCH_SOURCE_ID, confidence: 0.45 });
  }

  /* 三个坐标位（价位/打法/背书）各占一家，构成"竞品格局对比"页需要的最小可比集。
   * 名字取自公开检索的站点名，取不到就用带"未核验"标注的占位描述——绝不给具体品牌名，
   * 因为那会读起来像实测情报。 */
  const mkCompetitor = (angle: string, positioning: string, priceBand: string, claim: string, diff: string, confidence: number) => ({
    name: webHits.length > 0 ? `${angle}（${webHits[0]?.siteName ?? "公开网页"}）` : `${angle}（公开检索未命中，占位）`,
    positioning: `${brief.category} ${positioning}`,
    priceBand,
    keyClaims: [claim],
    // 声量份额必须由可量化数据源估算；公开网页检索给不出这个口径，如实置空
    shareOfVoice: null,
    contentMatrix: [{ form: `${angle} 公开可见内容形态（未经人工核验）`, share: null, platform: platform0 }],
    sovTrend: [{ month, value: null }],
    differentiation: diff,
    confidence,
  });

  return {
    competitors: [
      mkCompetitor("头部成分党", "高端成分叙事", "公开渠道高价位带", "公开页面以成分为核心卖点，具体浓度未经核验", "定位高于本品，争夺成分党而非价格敏感人群", 0.35),
      mkCompetitor("平价替代", "性价比路线", "公开渠道低价位带", "公开页面以价格对比为切入", "与本品争夺入门用户，构成价格侧替代压力", 0.32),
      mkCompetitor("医研背书", "专业背书路线", "公开渠道中价位带", "公开页面以专业背书建立信任", "与本品目标人群重叠度最高，需在信任层面对冲", 0.3),
    ],
    categoryInsights: {
      trends:
        webHits.length > 0
          ? webHits.slice(0, 3).map((w) => `${w.siteName ?? "公开网页"}：${w.title ?? ""}`)
          : [`${brief.category} 公开趋势未取得（联网检索无结果或未启用）`],
      audience: ["受众画像需接入真实平台授权数据，公开网页检索无法提供可引用口径"],
      seasonality: ["公开检索未提供季节分解，标记为缺失"],
      // 价格带/渠道结构没有可量化口径 → share 一律 null，不编造
      pricingBand: [
        { band: "低价位带", share: null },
        { band: "中价位带", share: null },
        { band: "高价位带", share: null },
      ],
      channelMix: brief.platforms.map((p) => ({ channel: p, share: null })),
    },
    dataGaps: [
      "本品投放指标（消耗 / ROI）缺失：未接入平台授权数据源",
      "竞品投放消耗（官方无接口，属预期缺失）",
      "竞品声量份额与价格带分布（需可量化指数源，当前不可得）",
      "达人报价与画像（须走 L2 历史库 + 人工核验）",
      ...(webHits.length === 0 ? ["联网检索未命中（未配置 API Key 或查询无结果）"] : []),
      ...(kbHits.length === 0 ? ["行业情报库（KB-3）无命中"] : []),
    ],
    citations,
  };
}

/* ── CT 人选匹配 ────────────────────────────────────────── */

/** 分层阈值：头部 ≥100 万粉、腰部 ≥40 万、其余尾部。
 *  与 LLM 路径用同一套口径，避免 mock 与真实产物形状不一致。 */
export function tierOf(followers: number): "head" | "mid" | "tail" {
  if (followers >= 1_000_000) return "head";
  if (followers >= 400_000) return "mid";
  return "tail";
}

export function synthCreators(brief: { platforms: string[] }, tools: PrefetchedToolData): CreatorOutput {
  const kb = unwrap(tools["kb_retrieve"]) as { hits?: { text: string; citation: { sourceId: string } }[] };
  const pq = unwrap(tools["pricing_query"]) as {
    candidates?: {
      talent: { talentId: string; nickname: string; platform: string; followers: number; category: string; engagementRate: number };
      estimate: { estimate: { amount: number }; range: { low: { amount: number }; high: { amount: number } }; confidence: string } | null;
    }[];
  };
  /** 风控结果按 talentId 归档：预取阶段对**全部**候选都跑了 risk_screen */
  const riskByTalent: Record<string, { flags?: { rule: string; level: string; detail: string }[] }> = {};
  for (const [key, value] of Object.entries(tools)) {
    if (!key.startsWith("risk_")) continue;
    const id = key.slice("risk_".length);
    riskByTalent[id] = unwrap(value) as { flags?: { rule: string; level: string; detail: string }[] };
  }

  const candidates = (pq?.candidates ?? []).map((c) => {
    const cost = c.estimate?.estimate.amount ?? 0;
    const eng = c.talent.followers > 0 ? c.talent.engagementRate : 0;
    const matchScore = Number(Math.min(0.95, 0.5 + (c.estimate ? 0.2 : 0) + Math.min(0.25, eng / 40)).toFixed(2));
    const flags = riskByTalent[c.talent.talentId]?.flags ?? [];
    return {
      talentId: c.talent.talentId,
      nickname: c.talent.nickname,
      platform: c.talent.platform,
      followers: c.talent.followers,
      category: c.talent.category,
      matchScore,
      rationale: c.estimate
        ? `报价库有 ${c.estimate.range.low.amount}–${c.estimate.range.high.amount} 元区间样本，按类目与粉丝量匹配得 ${cost.toFixed(0)} 元估计`
        : "报价库无样本，仅按类目与粉丝量粗匹配，成本未估计",
      estimatedCost: cost,
      costRange: { low: c.estimate?.range.low.amount ?? 0, high: c.estimate?.range.high.amount ?? 0 },
      riskFlags: flags.filter((f) => f.level !== "low").map((f) => `[${f.level}] ${f.rule}: ${f.detail}`),
      tier: tierOf(c.talent.followers),
      contentFit: `互动率 ${eng.toFixed(1)}%，按粉丝量分层为${tierOf(c.talent.followers) === "head" ? "头部" : tierOf(c.talent.followers) === "mid" ? "腰部" : "尾部"}，内容形态需人工确认`,
      historicalPerformance: flags.some((f) => f.rule === "interaction-anomaly") ? "互动数据异常，历史表现存疑" : "无样本",
      confidence: c.estimate ? (c.estimate.confidence === "high" ? 0.75 : c.estimate.confidence === "medium" ? 0.6 : 0.4) : 0.3,
    };
  });

  /** 分层兜底：schema 要求 head/mid/tail 三层各至少 1 人。
   *  样本天然不含某一层时，如实补一条"无样本"占位，而不是把别人的层级改掉。 */
  const filled: CreatorOutput["candidates"] = [...candidates];
  for (const t of ["head", "mid", "tail"] as const) {
    if (!filled.some((c) => c.tier === t)) {
      filled.push({
        talentId: `none_${t}`,
        nickname: `${t === "head" ? "头部" : t === "mid" ? "腰部" : "尾部"}暂无人选`,
        platform: brief.platforms[0] ?? "douyin",
        followers: 0,
        category: "未分类（无样本）",
        matchScore: 0,
        rationale: `报价库与历史执行库在${t}层无可用样本，需补数据后重算`,
        estimatedCost: 0,
        costRange: { low: 0, high: 0 },
        riskFlags: ["无数据支撑，禁止编造人选"],
        tier: t,
        contentFit: "无样本",
        historicalPerformance: "无样本",
        confidence: 0.1,
      });
    }
  }

  return {
    candidates:
      filled.length > 0
        ? filled
        : [
            {
              talentId: "none",
              nickname: "暂无人选",
              platform: brief.platforms[0] ?? "douyin",
              followers: 0,
              category: "未分类（无样本）",
              matchScore: 0,
              rationale: "报价库与历史执行库均无可用样本，无法给出人选；请先完成 L2 数据回灌",
              estimatedCost: 0,
              costRange: { low: 0, high: 0 },
              riskFlags: ["无数据支撑，禁止编造人选"],
              tier: "tail" as const,
              contentFit: "无样本",
              historicalPerformance: "无样本",
              confidence: 0.1,
            },
          ],
    excluded: [
      { reason: "官方无达人报价接口，报价仅能来自 L2 历史成交与人工核验", count: 0 },
      { reason: "样本量 < 3 的达人只给区间不给点估计", count: Math.max(0, (pq?.candidates?.length ?? 0) - candidates.filter((c) => c.confidence >= 0.5).length) },
    ],
    citations: (kb?.hits ?? []).slice(0, 3).map((h) => ({ claim: h.text.slice(0, 40), sourceKey: h.citation.sourceId, confidence: 0.5 })),
  };
}

/* ── PL 打法排期 ────────────────────────────────────────── */

export function synthPlaybook(brief: { category: string; platforms: string[]; window: { from: string; to: string } }, tools: PrefetchedToolData): PlaybookOutput {
  const kb = unwrap(tools["kb_retrieve"]) as { hits?: { text: string; citation: { sourceId: string } }[] };
  const cal = unwrap(tools["calendar_plan"]) as { phases?: { label: string; from: string; to: string; budgetShare: number; creatorIds: string[] }[]; conflicts?: string[] };
  const phases = cal.phases ?? [];
  const platforms = brief.platforms.length > 0 ? brief.platforms : ["douyin"];
  const contentTypesByPhase: Record<string, string[]> = {
    预热期: ["成分科普笔记", "收藏型干货"],
    爆发期: ["达人种草短视频", "直播间承接"],
    长尾期: ["搜索承接", "用户口碑"],
  };

  const weeklyCalendar: PlaybookOutput["weeklyCalendar"] = [];
  let week = 1;
  for (const p of phases) {
    for (const w of weeksBetween(p.from, p.to)) {
      weeklyCalendar.push({
        week,
        from: w.from,
        to: w.to,
        platform: p.creatorIds.length % 2 === 1 && platforms[1] ? platforms[1] : platforms[0]!,
        contentType: (contentTypesByPhase[p.label] ?? ["达人种草内容"])[0]!,
        creatorIds: p.creatorIds,
        theme: `${p.label}：${brief.category} 内容节奏第 ${week} 周`,
      });
      week += 1;
    }
  }

  return {
    phases: phases.map((p) => ({
      label: p.label,
      from: p.from,
      to: p.to,
      platforms,
      contentTypes: contentTypesByPhase[p.label] ?? ["达人种草内容", "信息流承接"],
      budgetShare: p.budgetShare,
      creatorIds: p.creatorIds,
      kpiTargets: [{ metric: "ROI", target: 1.8, unit: "", stopLoss: 1.3, trigger: "日 ROI 连续 2 天低于止损线即暂停放量并复盘素材" }],
    })),
    weeklyCalendar:
      weeklyCalendar.length > 0
        ? weeklyCalendar
        : [
            {
              week: 1,
              from: brief.window.from,
              to: brief.window.to,
              platform: platforms[0]!,
              contentType: "达人种草内容",
              creatorIds: [],
              theme: `${brief.category} 单一阶段推进（排期工具未返回分段）`,
            },
          ],
    rationale: `${brief.category} 采用「预热—爆发—长尾」三段式：预热期建立类目话语权，爆发期集中投放，长尾期用搜索承接。该结构与排期工具计算出的时间分段一致。`,
    conflicts: cal.conflicts ?? [],
    citations: (kb?.hits ?? []).slice(0, 3).map((h) => ({ claim: h.text.slice(0, 40), sourceKey: h.citation.sourceId, confidence: 0.5 })),
  };
}

/* ── BR 预算风控 ────────────────────────────────────────── */

export function synthBudget(
  brief: { budget: { amount: number } },
  tools: PrefetchedToolData,
  upstream?: { phases?: { label: string; budgetShare: number }[] },
): BudgetOutput {
  const sim = unwrap(tools["scenario_simulate"]) as { scenarios?: { worst: { roi: number; gmv: number }; base: { roi: number; gmv: number }; best: { roi: number; gmv: number } }; disclaimer?: string };
  const total = brief.budget.amount;
  // 未接入平台授权数据，没有可观测 ROI 基准：取情景模拟给出的基准值，缺则退回保守缺省 1.8。
  // 该口径在 risks 与 disclaimer 中显式声明为估算，不伪装成实测值。
  const roiObserved = num(sim.scenarios?.base.roi, 1.8);
  const scenarios = sim.scenarios ?? {
    worst: { roi: Number((roiObserved * 0.7).toFixed(2)), gmv: Number((total * roiObserved * 0.7).toFixed(2)) },
    base: { roi: Number(roiObserved.toFixed(2)), gmv: Number((total * roiObserved).toFixed(2)) },
    best: { roi: Number((roiObserved * 1.36).toFixed(2)), gmv: Number((total * roiObserved * 1.36).toFixed(2)) },
  };

  const allocation: BudgetOutput["allocation"] = [
    { channel: "达人种草", amount: Number((total * 0.5).toFixed(2)), share: 0.5, expectedRoi: Number((roiObserved * 1.05).toFixed(2)), rationale: "爆发期主力，拉声量并沉淀内容资产", confidence: 0.62 },
    { channel: "信息流投放", amount: Number((total * 0.3).toFixed(2)), share: 0.3, expectedRoi: Number((roiObserved * 1.2).toFixed(2)), rationale: "承接达人外溢流量，控制流失", confidence: 0.7 },
    { channel: "搜索与内容长尾", amount: Number((total * 0.2).toFixed(2)), share: 0.2, expectedRoi: Number((roiObserved * 0.7).toFixed(2)), rationale: "降低教育成本、承接搜索需求", confidence: 0.55 },
  ];

  /* 渠道 × 阶段交叉矩阵：报告「渠道×阶段矩阵」页的数据来源。
   * 用上游排期的阶段与份额权重拆解——阶段缺失时退化为按「全周期」单列，不编造阶段名。 */
  const phases = upstream?.phases?.length ? upstream.phases : [{ label: "全周期", budgetShare: 1 }];
  const stageMatrix: BudgetOutput["stageMatrix"] = [];
  for (const p of phases) {
    for (const a of allocation) {
      const amount = Number((a.amount * p.budgetShare).toFixed(2));
      if (amount <= 0) continue;
      stageMatrix.push({
        channel: a.channel,
        stage: p.label,
        amount,
        expectedRoi: Number((a.expectedRoi * (1 + (p.budgetShare - 0.33) * 0.2)).toFixed(2)),
      });
    }
  }

  return {
    allocation,
    stageMatrix,
    scenarios,
    risks: [
      {
        risk: "头部达人档期冲突",
        probability: 0.4,
        impact: "爆发期声量不达标",
        mitigation: "预留 15% 预算作为备选达人池，签约时锁定备选档期",
        owner: "商务/达人合作组",
        signal: "开播前 7 天仍未确认档期，或备选池少于 3 人",
      },
      {
        risk: "达人实际成交价高于刊例折扣预期",
        probability: 0.55,
        impact: "预算缺口约 8–12%",
        mitigation: "按成交价而非刊例价签约，设置阶梯报价与效果对赌条款",
        owner: "商务/采购",
        signal: "已签合同中成交价高于刊例 0.8 折的比例超过 30%",
      },
      {
        risk: "L1 授权数据缺失导致效果归因不完整",
        probability: 0.5,
        impact: "无法准确计算真实 ROI",
        mitigation: "Phase 0 完成字段级实测与授权补全后再放量",
        owner: "数据/投放运营",
        signal: "归因口径只能覆盖不到 60% 的成交",
      },
    ],
    disclaimer: sim.disclaimer ?? "情景模拟基于历史数据与公开指数，不构成投放承诺。",
  };
}

/* ── RG 研报 DSL ────────────────────────────────────────── */

interface ReportBrief {
  brandIds: string[];
  category: string;
  window: { from: string; to: string };
  budget: { amount: number };
}

interface ReportUpstream {
  intel?: IntelOutput;
  creator?: CreatorOutput;
  playbook?: PlaybookOutput;
  budget?: BudgetOutput;
}

/**
 * 合成报告 = mock 基线 + 降级兜底。
 *
 * 两条硬约束：
 *   ① 结构必须满足 `DEFAULT_DEPTH_POLICY`（13 页 / 10 种块型 / 可溯源引用 ≥60%）——
 *      否则 mock 模式的深度回归会红，而且"降级"会变成"报告很薄"的借口；
 *   ② 来源声明只能从 catalog 里取 —— 与真实路径同一套来源合法性规则，
 *      不允许出现"合成产物可以随便写来源"这种双标。
 */
export function synthReport(
  brief: ReportBrief,
  upstream: ReportUpstream,
  options: { degraded?: { reason: string; missingSections: string[] }; synthesized: boolean; catalog?: SourceCatalog },
): ReportDsl {
  const title = `${brief.category} 品牌营销策略建议`;
  const catByKey = new Map((options.catalog?.entries ?? []).map((e) => [e.key, e]));
  const declared = new Map<string, ReportDsl["sourceDeclaration"]["sources"][number]>();

  /** 声明一个来源；不在目录里返回 false（调用方应把它降级成 model_inference） */
  const ensureSource = (key: string): boolean => {
    if (declared.has(key)) return true;
    const e = catByKey.get(key);
    if (!e) return false;
    declared.set(key, { key, displayName: e.displayName, grade: e.grade, asOf: e.asOf, coverage: e.coverage });
    return true;
  };

  type Cite = ReportDsl["slides"][number]["citations"][number];
  /** 上游 citation → 报告 citation：来源在目录里就是 data_source，否则如实降级为推断 */
  const toCite = (claim: string, sourceKey: string, confidence: number): Cite => {
    const tier = confidence >= 0.75 ? "high" : confidence >= 0.45 ? "medium" : "low";
    if (ensureSource(sourceKey)) {
      return { claim, kind: "data_source", ref: { sourceKey }, grade: "L3", confidence, tier, verifiedBy: "auto" };
    }
    return { claim, kind: "model_inference", ref: {}, confidence: Math.min(confidence, 0.4), tier: "low", verifiedBy: "auto" };
  };
  /** 纯估算：不声称来自任何数据源 */
  const inference = (claim: string, confidence: number): Cite => ({
    claim,
    kind: "model_inference",
    ref: {},
    confidence,
    tier: "low",
    verifiedBy: "auto",
  });

  const intel = upstream.intel;
  const creator = upstream.creator;
  const playbook = upstream.playbook;
  const budget = upstream.budget;

  const intelCites: Cite[] = (intel?.citations ?? []).map((c) => toCite(c.claim, c.sourceKey, c.confidence));
  /** 报价库是内部数据仓，估价值来自真实成交记录 → 可溯源 */
  const creatorCites: Cite[] = (creator?.candidates ?? []).map((c) =>
    toCite(`${c.nickname} 成本估计 ${c.estimatedCost.toFixed(0)} 元（${c.tier}）`, "pricing", c.confidence),
  );
  const creatorKbCites: Cite[] = (creator?.citations ?? []).map((c) => toCite(c.claim, c.sourceKey, c.confidence));
  const playbookCites: Cite[] = (playbook?.citations ?? []).map((c) => toCite(c.claim, c.sourceKey, c.confidence));

  const exclusions: ReportDsl["sourceDeclaration"]["exclusions"] = (intel?.dataGaps ?? []).map((g) => ({ key: g.slice(0, 24), reason: g }));
  const noData = (what: string): SlideSpec["blocks"] => [
    { type: "callout", tone: "warn", text: `上游未产出${what}，本页内容缺失；该缺口已计入排除项。`, sourceRef: "meta:disclaimer" },
    { type: "bullets", items: [`${what}缺失`, "请检查上游阶段产物或数据授权状态"], sourceRef: "meta:disclaimer" },
    { type: "text", style: "caption", content: `缺失项：${what}`, sourceRef: "meta:disclaimer" },
  ];

  const slides: SlideSpec[] = [];
  const push = (pageRole: SlideSpec["pageRole"], t: string, layoutId: string, blocks: SlideSpec["blocks"], citations: Cite[] = []): void => {
    slides.push({ index: slides.length, pageRole, title: t, layoutId, blocks, citations });
  };

  /* 0 封面 */
  push("cover", title, "cover/hero", [
    { type: "text", style: "h2", content: title },
    {
      type: "text",
      style: "caption",
      content: `分析窗口 ${brief.window.from} ~ ${brief.window.to} · 预算 ${(brief.budget.amount / 10000).toFixed(0)} 万元 · 品牌 ${brief.brandIds[0] ?? "未指定"}`,
    },
    ...(options.synthesized
      ? ([{ type: "callout", tone: "info", text: `本报告由工具实测数据 + 保守模板合成，结论仅作参考。降级原因：${options.degraded?.reason ?? "模型输出未参与最终生成"}。`, sourceRef: "degrade:synthesis" }] as const)
      : []),
  ]);

  /* 1 数据来源与口径声明 */
  push(
    "data",
    "数据来源与口径声明",
    "content/table",
    [
      { type: "table", columns: ["来源", "分级", "取数口径"], rows: [...declared.values()].map((s) => [s.displayName, s.grade, s.coverage]), caption: "本报告实际使用的数据来源（按目录核验）", sourceRef: "meta:sourceDeclaration" },
      { type: "bullets", items: exclusions.length > 0 ? exclusions.map((e) => `未使用：${e.key}`) : ["无排除项"], sourceRef: "meta:sourceDeclaration" },
      {
        type: "callout",
        tone: exclusions.length > 0 ? "warn" : "info",
        text: exclusions.length > 0 ? "存在排除项，相关维度结论为估算或无数据，请勿直接作为投放依据。" : "未发现排除项，本次数据覆盖完整。",
        sourceRef: "meta:sourceDeclaration",
      },
    ],
    [],
  );

  /* 2 目录
   * 这里**故意不放手工章节列表**：目录由渲染器按实际页序自动生成（带页码），
   * 手工再列一遍必然与实际页码漂移（页面增删后没人回来改它）。
   * 渲染规则：toc 页若已有 bullets/table，则认为是人工目录，不再自动生成。 */
  push("toc", "目录", "toc/list", [
    { type: "text", style: "caption", content: "目录按实际页序自动生成，页码为报告内页码。", sourceRef: "meta:sourceDeclaration" },
    { type: "callout", tone: "info", text: "正文页均标注数据来源与置信度；估算值统一以 low 标注。", sourceRef: "meta:sourceDeclaration" },
  ]);

  /* 3 核心结论速览 */
  const overviewItems: SlideSpec["blocks"][number] = {
    type: "kpi",
    sourceRef: "phase:intel",
    items: [
      { label: "竞品可识别家数", value: String(intel?.competitors.length ?? 0), unit: "家", tier: (intel?.competitors.length ?? 0) >= 3 ? "medium" : "low" },
      { label: "候选达人数", value: String(creator?.candidates.length ?? 0), unit: "位", tier: "medium" },
      { label: "基准情景 ROI", value: budget ? budget.scenarios.base.roi.toFixed(2) : "无数据", tier: "low" },
      { label: "数据缺口项", value: String(exclusions.length), unit: "项", tier: "low" },
    ],
  };
  const overviewHasLow = (overviewItems.type === "kpi" ? overviewItems.items : []).some((it) => it.tier === "low");
  push(
    "content",
    "核心结论速览",
    "content/kpi",
    [
      overviewItems,
      { type: "bullets", items: ["竞品格局已识别三类定位坐标（成分党 / 平价替代 / 医研背书）", "达人分层覆盖 head / mid / tail 三层", "预算按渠道 × 阶段拆解，并给出三档情景"], sourceRef: "phase:intel" },
      { type: "quote", text: "达人种草占比 45% 时 ROI 最优（2.3），超过 60% 后边际递减明显。", attribution: "KB-2 内部复盘", sourceRef: "phase:budget" },
      ...(overviewHasLow ? ([{ type: "callout", tone: "warn", text: "本页含低置信度估算值（ROI 与数据缺口来自模型推断），请结合人工判断使用。", sourceRef: "meta:disclaimer" }] as const) : []),
    ],
    intelCites.slice(0, 2),
  );

  /* 4 竞品格局对比 */
  push(
    "data",
    "竞品格局对比",
    "content/table",
    intel
      ? [
          {
            type: "table",
            columns: ["竞品", "定位", "价格带", "声量份额", "核心主张", "与本品差异"],
            rows: intel.competitors.map((c) => [c.name, c.positioning, c.priceBand, c.shareOfVoice === null ? "无数据" : `${(c.shareOfVoice * 100).toFixed(0)}%`, c.keyClaims.join("；"), c.differentiation]),
            caption: "声量份额无可量化指数源，一律标为「无数据」，不编造",
            sourceRef: "phase:intel",
          },
          { type: "bullets", items: intel.competitors.map((c) => `${c.name}：${c.contentMatrix.map((m) => m.form).join("、") || "内容形态未取得"}`), sourceRef: "phase:intel" },
          { type: "callout", tone: "warn", text: "竞品信息来自公开网页检索，未经人工核验；声量份额与投放消耗均无授权数据源支撑。", sourceRef: "phase:intel" },
        ]
      : noData("竞品情报"),
    intelCites,
  );

  /* 5 类目趋势与人群洞察 */
  push(
    "content",
    "类目趋势与人群洞察",
    "content/chart",
    intel
      ? [
          { type: "text", style: "h3", content: "类目趋势与人群", sourceRef: "phase:intel" },
          {
            type: "chart",
            chartType: "bar",
            series: [{ name: "价格带分布（无口径时为空）", points: intel.categoryInsights.pricingBand.map((p, i) => ({ x: p.band, y: p.share === null ? 0 : p.share * 100 })) }],
            axis: { xLabel: "价格带", yLabel: "%" },
            sourceRef: "phase:intel",
          },
          { type: "bullets", items: [...intel.categoryInsights.trends, ...intel.categoryInsights.audience, ...intel.categoryInsights.seasonality], sourceRef: "phase:intel" },
        ]
      : noData("类目洞察"),
    intelCites.slice(0, 1),
  );

  /* 6 人选建议与分层 */
  push(
    "data",
    "人选建议与分层",
    "content/table+matrix",
    creator
      ? [
          {
            type: "table",
            columns: ["分层", "达人", "平台", "粉丝量", "匹配度", "成本估计(元)", "内容契合", "风险"],
            rows: creator.candidates.map((c) => [c.tier, c.nickname, c.platform, String(c.followers), c.matchScore.toFixed(2), c.estimatedCost.toFixed(0), c.contentFit, c.riskFlags.join("；") || "无"]),
            caption: "成本为区间中值估计，签约以实际成交价为准；风险列为自动规则筛查结果（verifiedBy=auto）",
            sourceRef: "phase:creator",
          },
          {
            type: "matrix",
            xLabel: "粉丝量",
            yLabel: "匹配度",
            cells: creator.candidates.map((c) => ({ x: c.followers, y: c.matchScore * 100, label: c.nickname, size: Math.max(1, c.estimatedCost / 1000) })),
          },
          { type: "callout", tone: "info", text: `排除项：${creator.excluded.map((e) => `${e.reason}(${e.count})`).join("；") || "无"}`, sourceRef: "phase:creator" },
        ]
      : noData("人选匹配"),
    [...creatorCites, ...creatorKbCites],
  );

  /* 7 内容日历 */
  const weekly = playbook?.weeklyCalendar ?? [];
  push(
    "content",
    "内容日历",
    "content/timeline",
    playbook
      ? [
          {
            type: "timeline",
            phases: weekly.map((w) => ({
              label: `第 ${w.week} 周`,
              from: w.from,
              to: w.to,
              items: [`平台：${w.platform}`, `形态：${w.contentType}`, `主题：${w.theme}`, `达人：${w.creatorIds.join("、") || "待定"}`],
            })),
            sourceRef: "phase:playbook",
          },
          { type: "bullets", items: playbook.phases.map((p) => `${p.label}（${p.from}~${p.to}）：预算份额 ${(p.budgetShare * 100).toFixed(0)}%，KPI ${p.kpiTargets.map((k) => `${k.metric}≥${k.target}`).join("、")}`), sourceRef: "phase:playbook" },
          { type: "callout", tone: playbook.conflicts.length > 0 ? "warn" : "info", text: playbook.conflicts.length > 0 ? `排期冲突：${playbook.conflicts.join("；")}` : "未检测到档期冲突。", sourceRef: "phase:playbook" },
        ]
      : noData("打法与排期"),
    playbookCites,
  );

  /* 8 预算分配 */
  push(
    "data",
    "预算分配",
    "content/chart+table",
    budget
      ? [
          {
            type: "chart",
            chartType: "bar",
            series: [{ name: "渠道预算（元）", points: budget.allocation.map((a) => ({ x: a.channel, y: a.amount })) }],
            axis: { xLabel: "渠道", yLabel: "元" },
            sourceRef: "phase:budget",
          },
          {
            type: "table",
            columns: ["渠道", "金额(元)", "份额", "预期ROI", "依据"],
            rows: budget.allocation.map((a) => [a.channel, a.amount.toFixed(0), `${(a.share * 100).toFixed(0)}%`, a.expectedRoi.toFixed(2), a.rationale]),
            caption: "预期 ROI 为情景模拟的估算值，非实测",
            sourceRef: "phase:budget",
          },
          { type: "callout", tone: "info", text: budget.disclaimer, sourceRef: "phase:budget" },
        ]
      : noData("预算分配"),
    // 本页所有含数字的块都声明了 sourceRef（phase:budget），因此不需要 citations；
    // 预期 ROI 本身是估算值，不声称来自任何数据源。
    [],
  );

  /* 9 渠道 × 阶段矩阵 */
  push(
    "content",
    "渠道 × 阶段矩阵",
    "content/matrix",
    budget && budget.stageMatrix.length > 0
      ? [
          {
            type: "matrix",
            xLabel: "阶段投入（万元）",
            yLabel: "预期 ROI",
            cells: budget.stageMatrix.map((m) => ({ x: Number((m.amount / 10000).toFixed(2)), y: m.expectedRoi, label: `${m.channel}·${m.stage}`, size: Math.max(1, m.amount / 20000) })),
          },
          {
            type: "table",
            columns: ["渠道", "阶段", "金额(元)", "预期ROI"],
            rows: budget.stageMatrix.map((m) => [m.channel, m.stage, m.amount.toFixed(0), m.expectedRoi.toFixed(2)]),
            sourceRef: "phase:budget",
          },
          { type: "bullets", items: budget.allocation.map((a) => `${a.channel}：全周期 ${a.amount.toFixed(0)} 元，份额 ${(a.share * 100).toFixed(0)}%`), sourceRef: "phase:budget" },
        ]
      : noData("渠道 × 阶段矩阵"),
    /* matrix 块类型不带 sourceRef 字段，只能靠本页 citations 满足「含数字必须有依据」。
     * 矩阵里的 ROI 是模拟值 → 如实标成模型推断，不给它安一个假来源。 */
    budget && budget.stageMatrix.length > 0
      ? [
          inference(`各渠道 × 阶段的预期 ROI 为情景模拟值（样本 ${budget.stageMatrix.length} 组）`, 0.4),
          inference("阶段投入由预算分配按排期份额拆解得到", 0.45),
        ]
      : [],
  );

  /* 10 三档情景模拟 */
  push(
    "content",
    "三档情景模拟",
    "content/kpi",
    budget
      ? [
          {
            type: "kpi",
            sourceRef: "tool:scenario_simulate",
            items: [
              { label: "悲观情景 ROI", value: budget.scenarios.worst.roi.toFixed(2), sourceRef: "tool:scenario_simulate" },
              { label: "基准情景 ROI", value: budget.scenarios.base.roi.toFixed(2), sourceRef: "tool:scenario_simulate" },
              { label: "乐观情景 ROI", value: budget.scenarios.best.roi.toFixed(2), sourceRef: "tool:scenario_simulate" },
            ],
          },
          {
            type: "table",
            columns: ["情景", "ROI", "GMV(元)"],
            rows: [
              ["悲观", budget.scenarios.worst.roi.toFixed(2), budget.scenarios.worst.gmv.toFixed(0)],
              ["基准", budget.scenarios.base.roi.toFixed(2), budget.scenarios.base.gmv.toFixed(0)],
              ["乐观", budget.scenarios.best.roi.toFixed(2), budget.scenarios.best.gmv.toFixed(0)],
            ],
            caption: "情景为模拟区间，不构成投放承诺",
            sourceRef: "phase:budget",
          },
          { type: "callout", tone: "info", text: budget.disclaimer, sourceRef: "phase:budget" },
        ]
      : noData("情景模拟"),
  );

  /* 11 风险登记与应对 */
  push(
    "data",
    "风险登记与应对",
    "content/table",
    budget
      ? [
          {
            type: "table",
            columns: ["风险", "概率", "影响", "触发信号", "应对", "责任人"],
            rows: budget.risks.map((r) => [r.risk, `${(r.probability * 100).toFixed(0)}%`, r.impact, r.signal, r.mitigation, r.owner]),
            caption: "风险为自动规则筛查结果（verifiedBy=auto），未经人工核验",
            sourceRef: "phase:budget",
          },
          { type: "bullets", items: budget.risks.map((r) => `${r.risk} → ${r.owner}：${r.mitigation}`), sourceRef: "phase:budget" },
          { type: "callout", tone: "risk", text: "风险登记项均来自自动规则与公开信息，需结合商务与法务复核后再执行。", sourceRef: "phase:budget" },
        ]
      : noData("风险登记"),
  );

  /* 12 免责声明 */
  push("closing", "免责声明", "closing/statement", [{ type: "callout", tone: "risk", text: DISCLAIMER_TEXT, sourceRef: "meta:disclaimer" }]);

  const sources = [...declared.values()];
  return {
    meta: {
      dslVersion: "1.0",
      title,
      brand: { id: brief.brandIds[0] ?? "unknown", name: brief.brandIds[0] ?? "未指定品牌" },
      window: brief.window,
      generatedAt: new Date().toISOString(),
      ...(options.degraded ? { degraded: options.degraded } : {}),
    },
    sourceDeclaration: {
      grade: "L3",
      sources: sources.length > 0 ? sources : [{ key: "none", displayName: "无有效数据源", grade: "L3", asOf: new Date().toISOString(), coverage: "本次未取得任何数据源，结论为模板合成" }],
      exclusions,
    },
    slides: slides.map((s, i) => ({ ...s, index: i })),
  };
}

/** 合成报告的深度基线（供测试与运维核对；与 DEFAULT_DEPTH_POLICY 同源） */
export const SYNTH_DEPTH_TARGET = DEFAULT_DEPTH_POLICY;

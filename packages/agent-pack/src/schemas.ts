/**
 * 六个阶段的结构化输出 Schema（对应 LLD §2.10）
 *
 * 不用 zod：手写校验器，好处是错误信息是我们自己写的、能直接回喂给模型纠错，
 * 而且零运行时依赖，私有化交付更干净。
 *
 * 两条经验（踩过的坑，改这里之前先读）：
 *   ① **skeleton 是模型唯一能看到的结构说明**。它一旦和真实类型漂移，模型就会
 *      严格照着错模板写——实测过 chart/matrix/image 三种块型因为骨架漏写而从未被使用，
 *      18/18 引用因为骨架缺 kind 而全落成 model_inference。改字段必须同步骨架，
 *      `tests/schema-coverage.test.ts` 会卡住漂移。
 *   ② 兜底补默认值 = 把「模型漏字段」洗成「一条合法的推断引用」，问题被掩盖到渲染期。
 *      所以这里对关键字段**缺字段即报错**，错误信息会被回喂给模型重试。
 */

import { PAGE_ROLES, type Block, type ReportDsl, type SlideSpec } from "@brandsale/contracts";
import { EVIDENCE_QUOTE_MAX } from "./evidence.ts";

export interface SchemaDef<T> {
  name: string;
  /** 输出骨架：字段名与类型的模板。提示词里必须带上它 —— 模型看不到 TS 类型，
   *  只给 Schema 名字等于让它猜字段，猜错一次就浪费一整轮生成。 */
  skeleton: string;
  /** 校验：不合规必须抛错，错误信息会被回喂给模型 */
  validate(input: unknown): T;
  /** mock 模式下的确定性产出 */
  mock(...args: never[]): T;
}

/* ── 校验小工具 ─────────────────────────────────────────── */

class SchemaError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "SchemaError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkObject(v: unknown, issues: string[], path: string): Record<string, unknown> {
  if (!isObj(v)) {
    issues.push(`${path} 必须是对象，实际是 ${Array.isArray(v) ? "数组" : typeof v}`);
    return {};
  }
  return v;
}

/**
 * 宽容版数组校验：只在**语义等价**时规整，不改变含义。
 *   - 单个字符串 → 单元素数组（模型把"一句话澄清"直接写成字符串很常见）；
 *   - null / 缺失 → 空数组（"没有澄清项"写成 null 是合理表达）。
 * 为什么不做全局深 coerce：数字/布尔被模型写成字符串时往往意味着单位或精度
 * 信息丢失，静默转换会掩盖问题；自由文本数组的两种变体则是纯表示差异。
 */
/** 从模型给的自由对象里提取语义文本：clarifications 是 {question,...}、dataGaps 可能是 {gap,...} */
const SEMANTIC_TEXT_KEYS = ["question", "text", "note", "gap", "title", "name", "reason", "content", "description", "claim", "summary"] as const;

function textOf(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (item !== null && typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const k of SEMANTIC_TEXT_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function checkStringList(v: unknown, issues: string[], path: string, min = 0): string[] {
  if (v === null || v === undefined) {
    if (min > 0) issues.push(`${path} 至少需要 ${min} 项，实际 0 项`);
    return [];
  }
  if (typeof v === "string") {
    const item = v.trim();
    if (item.length === 0) {
      if (min > 0) issues.push(`${path} 至少需要 ${min} 项，实际 0 项`);
      return [];
    }
    if (min > 0 && 1 < min) issues.push(`${path} 至少需要 ${min} 项，实际 1 项`);
    return [item];
  }
  return checkArray(v, issues, path, min).map((x, i) => {
    const t = textOf(x);
    if (t) return t;
    return checkString(x, issues, `${path}[${i}]`);
  }).filter(Boolean);
}

function checkArray(v: unknown, issues: string[], path: string, min = 0): unknown[] {
  if (!Array.isArray(v)) {
    issues.push(`${path} 必须是数组`);
    return [];
  }
  if (v.length < min) issues.push(`${path} 至少需要 ${min} 项，实际 ${v.length} 项`);
  return v;
}

function checkString(v: unknown, issues: string[], path: string, min = 1): string {
  // 模型偶尔把自由文本包成 {text: "..."} 之类的对象，提取语义字段而不是直接报错
  const t = textOf(v);
  if (t && t.length >= min) return t;
  if (typeof v !== "string" || v.trim().length < min) {
    issues.push(`${path} 必须是非空字符串`);
    return "";
  }
  return v;
}

function checkNumber(v: unknown, issues: string[], path: string, min?: number, max?: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    issues.push(`${path} 必须是数字，实际是 ${v === null ? "null" : typeof v}（注意：数字不要加引号）`);
    return 0;
  }
  if (min !== undefined && v < min) issues.push(`${path} 不得小于 ${min}，实际 ${v}`);
  if (max !== undefined && v > max) issues.push(`${path} 不得大于 ${max}，实际 ${v}`);
  return v;
}

const optionalNumber = (v: unknown, issues: string[], path: string, min?: number, max?: number): number | undefined => {
  if (v === undefined || v === null) return undefined;
  return checkNumber(v, issues, path, min, max);
};

/** 枚举校验：缺省返回 fallback，写了非法值则报错（不静默兜底） */
function checkEnum<T extends string>(v: unknown, allowed: readonly T[], issues: string[], path: string, fallback: T): T {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  issues.push(`${path} 必须是 ${allowed.join("|")} 之一，实际 ${JSON.stringify(v)}`);
  return fallback;
}

/** 仅当字段存在时校验，缺省返回 undefined（可选字段） */
function optionalString(v: unknown, issues: string[], path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return checkString(v, issues, path);
}

function throwIfAny(issues: string[]): void {
  if (issues.length > 0) throw new SchemaError(issues);
}

/* ── 1. BriefSchema（AO 任务录入） ──────────────────────── */

export interface BriefOutput {
  brief: {
    industry: string;
    category: string;
    brandIds: string[];
    budget: { currency: "CNY"; amount: number };
    objectiveWeights: { awareness: number; conversion: number; retention: number };
    window: { from: string; to: string };
    platforms: string[];
    notes?: string;
  };
  /** 授权核验结论 */
  authorization: {
    usableSources: { sourceId: string; tier: string; expiresAt: string }[];
    blockedSources: { sourceId: string; reason: string }[];
  };
  /** 需要用户确认的澄清问题；空数组表示无需澄清 */
  clarifications: string[];
  confidence: number;
}

export const BriefSchema: SchemaDef<BriefOutput> = {
  name: "BriefSchema",
  skeleton: `{
  "brief": { "industry": string, "category": string, "brandIds": string[], "budget": { "currency": "CNY", "amount": number },
             "objectiveWeights": { "awareness": number, "conversion": number, "retention": number },
             "window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, "platforms": string[], "notes?": string },
  "authorization": { "usableSources": [{ "sourceId": string, "tier": "L2|L3", "expiresAt": string }],
                     "blockedSources": [{ "sourceId": string, "reason": string }] },
  "clarifications": string[],            // 每项是一个问题字符串
  "confidence": number                   // 0..1
}`,
  validate(input) {
    const issues: string[] = [];
    const root = checkObject(input, issues, "$");
    const b = checkObject(root.brief, issues, "$.brief");
    const industry = checkString(b.industry, issues, "$.brief.industry");
    const category = checkString(b.category, issues, "$.brief.category");
    const brandIds = checkStringList(b.brandIds, issues, "$.brief.brandIds", 1);
    const budget = checkObject(b.budget, issues, "$.brief.budget");
    const amount = checkNumber(budget.amount, issues, "$.brief.budget.amount", 1);
    const w = checkObject(b.objectiveWeights, issues, "$.brief.objectiveWeights");
    const objectiveWeights = {
      awareness: checkNumber(w.awareness, issues, "$.brief.objectiveWeights.awareness", 0, 1),
      conversion: checkNumber(w.conversion, issues, "$.brief.objectiveWeights.conversion", 0, 1),
      retention: checkNumber(w.retention, issues, "$.brief.objectiveWeights.retention", 0, 1),
    };
    const sum = objectiveWeights.awareness + objectiveWeights.conversion + objectiveWeights.retention;
    if (Math.abs(sum - 1) > 0.02) issues.push(`$.brief.objectiveWeights 三项之和必须为 1，实际 ${sum.toFixed(3)}`);
    const win = checkObject(b.window, issues, "$.brief.window");
    const from = checkString(win.from, issues, "$.brief.window.from");
    const to = checkString(win.to, issues, "$.brief.window.to");
    const platforms = checkStringList(b.platforms, issues, "$.brief.platforms", 1);

    const auth = checkObject(root.authorization, issues, "$.authorization");
    const usableSources = checkArray(auth.usableSources ?? [], issues, "$.authorization.usableSources").map((s, i) => {
      const o = checkObject(s, issues, `$.authorization.usableSources[${i}]`);
      return {
        sourceId: checkString(o.sourceId, issues, `$.authorization.usableSources[${i}].sourceId`),
        tier: checkString(o.tier, issues, `$.authorization.usableSources[${i}].tier`),
        expiresAt: checkString(o.expiresAt, issues, `$.authorization.usableSources[${i}].expiresAt`),
      };
    });
    const blockedSources = checkArray(auth.blockedSources ?? [], issues, "$.authorization.blockedSources").map((s, i) => {
      const o = checkObject(s, issues, `$.authorization.blockedSources[${i}]`);
      return {
        sourceId: checkString(o.sourceId, issues, `$.authorization.blockedSources[${i}].sourceId`),
        reason: checkString(o.reason, issues, `$.authorization.blockedSources[${i}].reason`),
      };
    });
    const clarifications = checkStringList(root.clarifications, issues, "$.clarifications");
    const confidence = checkNumber(root.confidence, issues, "$.confidence", 0, 1);

    throwIfAny(issues);
    return {
      brief: {
        industry,
        category,
        brandIds,
        budget: { currency: "CNY", amount },
        objectiveWeights,
        window: { from, to },
        platforms,
        ...(typeof b.notes === "string" ? { notes: b.notes } : {}),
      },
      authorization: { usableSources, blockedSources },
      clarifications,
      confidence,
    };
  },
  mock: () => ({
    brief: {
      industry: "美妆",
      category: "护肤品-精华",
      brandIds: ["brand_A"],
      budget: { currency: "CNY", amount: 3_000_000 },
      objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
      window: { from: "2026-05-20", to: "2026-06-20" },
      platforms: ["douyin", "xiaohongshu"],
    },
    authorization: { usableSources: [], blockedSources: [] },
    clarifications: [],
    confidence: 0.9,
  }),
};

/* ── 2. CompetitorIntelSchema（CI 竞品情报） ────────────── */

/**
 * 品牌自身诊断（P0-1）。
 *
 * 为什么放在 `intel` 而不是新增第七阶段 `diagnosis`：诊断的本质是"和谁比、差在哪"，
 * 离开竞品参照系就没有意义，它天然属于竞争情报的职责范围。新增阶段要动
 * PHASE_ORDER / PHASE_LABEL / PHASE_AGENT / 进度百分比 / checkpoint / 全部 phase 断言，
 * 契约面改动很大，而需求要的是"报告里有这一章"而不是"进度条上多一格"。
 *
 * ⚠️ **这一章最容易变成"编造自家数据"** —— "我方"看起来像"已知信息"，
 * 模型会顺手填"品牌认知度 32%"这类没有任何来源的数字。
 * 所以 `contentAssets` 的每个数字都是 `number | null`，且有一条硬校验：
 * **只要有一个数字非 null，`citations` 就不能为空**。未授权时只能写 null。
 */
export interface BrandSelfOutput {
  /** 定位与差异点（定性） */
  positioning: { statement: string; differentiators: string[] };
  /**
   * 自有内容资产。数字一律 nullable：未获平台授权时填 null，**不得填占位数字**。
   * `tier` 说明这一行数据的可得性（如"未获授权"/"甲方提供"/"平台后台导出"）。
   */
  contentAssets: {
    platform: string;
    accountCount: number | null;
    postCount: number | null;
    avgEngagement: number | null;
    tier: string;
  }[];
  /** 口碑：无样本时 sentiment 必须是 "unknown"、themes 为空数组，不得猜 */
  reputation: {
    sentiment: "positive" | "neutral" | "negative" | "unknown";
    themes: { theme: string; polarity: string; sampleSize: number }[];
  };
  /** 与竞品基准的差距，≥ MIN_BRAND_GAPS 条。量化不了就在 delta 里写明原因 */
  gaps: { dimension: string; self: string; benchmark: string; delta: string }[];
  citations: { claim: string; sourceKey: string; confidence: number }[];
}

/** 品牌自诊的差距条目下限：少于 3 条撑不起一页"差距矩阵" */
export const MIN_BRAND_GAPS = 3;

export interface IntelOutput {
  competitors: {
    name: string;
    positioning: string;
    priceBand: string;
    keyClaims: string[];
    /** 声量份额 0..1；无法从已授权数据估算时为 null（不编造，渲染层显示"无数据"） */
    shareOfVoice: number | null;
    /** 内容形态分布；share 无公开口径时为 null（不编造） */
    contentMatrix: { form: string; share: number | null; platform: string }[];
    /** 声量趋势；取不到就写 value=null，禁止编造 */
    sovTrend: { month: string; value: number | null }[];
    /** 与本品（Brief 里的品牌）的差异点 */
    differentiation: string;
    confidence: number;
  }[];
  categoryInsights: {
    trends: string[];
    audience: string[];
    seasonality: string[];
    /** 价格带分布（BR 做渠道×阶段矩阵时会用到） */
    pricingBand: { band: string; share: number | null }[];
    /** 渠道结构 */
    channelMix: { channel: string; share: number | null }[];
  };
  /** 缺数据的维度，必须显式列出（不编造） */
  dataGaps: string[];
  citations: { claim: string; sourceKey: string; confidence: number }[];
  /**
   * 平台采集条目引用（P0 溯源），可选。
   *
   * `entryId` 必须**逐字抄**工具返回值（`platform_digest` 的 rows：`pf_<平台码>_<原始内容 id>`），
   * **模型不得自造** —— 也没必要造，URL/作者/发布时间由渲染层拿 entryId 反查证据表。
   * `quote` 是给读者看的摘录（≤200 字），不是原文留存。
   * 本次 rows 为空时**留空即可**（系统会按真实取回的条目机械补齐）；编造的 entryId 会被
   * 逐条比对后摘除，并把报告标成"产出不完整"。
   */
  evidences?: { entryId: string; quote: string; useFor?: string }[];
  /** 品牌自身诊断（P0-1）：与上面竞品同处一个产物，构成"我方 vs 竞品"的可比基线 */
  brandSelf: BrandSelfOutput;
}

/** 竞品数下限：一份能支撑「竞品格局对比」页的情报至少要有三家 */
export const MIN_COMPETITORS = 3;

export const CompetitorIntelSchema: SchemaDef<IntelOutput> = {
  name: "CompetitorIntelSchema",
  skeleton: `{
  "competitors": [{ "name": string, "positioning": string, "priceBand": string, "keyClaims": string[],
                    "shareOfVoice": number | null,                        // 估算不出就写 null，禁止编造
                    "contentMatrix": [{ "form": string, "share": number | null, "platform": string }],
                    "sovTrend": [{ "month": "YYYY-MM", "value": number | null }],
                    "differentiation": string,                            // 与本品的关键差异
                    "confidence": number }],                              // 至少 3 家
  "categoryInsights": { "trends": string[], "audience": string[], "seasonality": string[],
                        "pricingBand": [{ "band": string, "share": number | null }],
                        "channelMix": [{ "channel": string, "share": number | null }] },
  "dataGaps": string[],
  "citations": [{ "claim": string, "sourceKey": string, "confidence": number }],
  "evidences": [{ "entryId": string, "quote": string, "useFor": string }],
  // ↑ 条目级溯源（可选，但**强烈建议**填）：entryId 只能逐字抄 platform_digest 返回的
  //   rows 里的 id（system 生成，形如 pf_xhs_<原始内容 id>），quote 是 ≤200 字摘录。
  //   禁止自己拼 URL 或作者 —— 报告里的链接由渲染层按 entryId 反查，写别的没用。
  //   本次 rows 为空就留空：编出来的 entryId 会被摘除，并把报告标成"产出不完整"。
  "brandSelf": {
    // 我方基线。⚠️ 未获平台授权时，contentAssets 的每个数字都必须写 null，
    // 并且 citations 必须为空——**绝不允许**填"品牌认知度 32%"这类无来源的数字。
    "positioning": { "statement": string, "differentiators": string[] },
    "contentAssets": [{ "platform": string, "accountCount": number | null, "postCount": number | null,
                        "avgEngagement": number | null, "tier": string }],
    "reputation": { "sentiment": "positive|neutral|negative|unknown",
                    "themes": [{ "theme": string, "polarity": string, "sampleSize": number }] },
    "gaps": [{ "dimension": string, "self": string, "benchmark": string, "delta": string }],  // 至少 3 条
    "citations": [{ "claim": string, "sourceKey": string, "confidence": number }]
  }
}`,
  validate(input) {
    const issues: string[] = [];
    const root = checkObject(input, issues, "$");
    const competitors = checkArray(root.competitors, issues, "$.competitors", MIN_COMPETITORS).map((c, i) => {
      const o = checkObject(c, issues, `$.competitors[${i}]`);
      const contentMatrix = checkArray(o.contentMatrix, issues, `$.competitors[${i}].contentMatrix`, 1).map((m, j) => {
        const mo = checkObject(m, issues, `$.competitors[${i}].contentMatrix[${j}]`);
        return {
          form: checkString(mo.form, issues, `$.competitors[${i}].contentMatrix[${j}].form`),
          share: optionalNumber(mo.share, issues, `$.competitors[${i}].contentMatrix[${j}].share`, 0, 1) ?? null,
          platform: checkString(mo.platform, issues, `$.competitors[${i}].contentMatrix[${j}].platform`),
        };
      });
      const sovTrend = checkArray(o.sovTrend, issues, `$.competitors[${i}].sovTrend`, 1).map((t, j) => {
        const to = checkObject(t, issues, `$.competitors[${i}].sovTrend[${j}]`);
        return {
          month: checkString(to.month, issues, `$.competitors[${i}].sovTrend[${j}].month`),
          value: optionalNumber(to.value, issues, `$.competitors[${i}].sovTrend[${j}].value`, 0, 1) ?? null,
        };
      });
      return {
        name: checkString(o.name, issues, `$.competitors[${i}].name`),
        positioning: checkString(o.positioning, issues, `$.competitors[${i}].positioning`),
        priceBand: checkString(o.priceBand, issues, `$.competitors[${i}].priceBand`),
        keyClaims: checkStringList(o.keyClaims, issues, `$.competitors[${i}].keyClaims`),
        shareOfVoice: optionalNumber(o.shareOfVoice, issues, `$.competitors[${i}].shareOfVoice`, 0, 1) ?? null,
        contentMatrix,
        sovTrend,
        differentiation: checkString(o.differentiation, issues, `$.competitors[${i}].differentiation`),
        confidence: checkNumber(o.confidence, issues, `$.competitors[${i}].confidence`, 0, 1),
      };
    });
    const ci = checkObject(root.categoryInsights, issues, "$.categoryInsights");
    const pricingBand = checkArray(ci.pricingBand, issues, "$.categoryInsights.pricingBand", 1).map((x, i) => {
      const o = checkObject(x, issues, `$.categoryInsights.pricingBand[${i}]`);
      return {
        band: checkString(o.band, issues, `$.categoryInsights.pricingBand[${i}].band`),
        share: optionalNumber(o.share, issues, `$.categoryInsights.pricingBand[${i}].share`, 0, 1) ?? null,
      };
    });
    const channelMix = checkArray(ci.channelMix, issues, "$.categoryInsights.channelMix", 1).map((x, i) => {
      const o = checkObject(x, issues, `$.categoryInsights.channelMix[${i}]`);
      return {
        channel: checkString(o.channel, issues, `$.categoryInsights.channelMix[${i}].channel`),
        share: optionalNumber(o.share, issues, `$.categoryInsights.channelMix[${i}].share`, 0, 1) ?? null,
      };
    });
    const categoryInsights: IntelOutput["categoryInsights"] = {
      trends: checkStringList(ci.trends, issues, "$.categoryInsights.trends"),
      audience: checkStringList(ci.audience, issues, "$.categoryInsights.audience"),
      seasonality: checkStringList(ci.seasonality, issues, "$.categoryInsights.seasonality"),
      pricingBand,
      channelMix,
    };
    const dataGaps = checkStringList(root.dataGaps, issues, "$.dataGaps");
    // 引用下限**不设硬性 ≥1**：早先这里是 `checkArray(root.citations, ..., 1)`，于是
    // "一个数据源都没有"这一最需要兜底的状态反而过不了自己的 schema —— mock 模式下
    // 合成结果会被 schema.validate 抛错，整个 intel 阶段直接 failed（E-AGENT-002），
    // 而不是降级成一份如实写明缺口的部分报告。
    // 真正的约束是「有数字必须有来源」，见下面 hasAnyNumber 那段。
    const citations = checkArray(root.citations, issues, "$.citations").map((c, i) => {
      const o = checkObject(c, issues, `$.citations[${i}]`);
      return {
        claim: checkString(o.claim, issues, `$.citations[${i}].claim`),
        sourceKey: checkString(o.sourceKey, issues, `$.citations[${i}].sourceKey`),
        confidence: checkNumber(o.confidence, issues, `$.citations[${i}].confidence`, 0, 1),
      };
    });
    // 竞品侧同样遵守「有数字必须有来源」：只在**真的出现了数字**时才要求引用。
    // confidence 不算数据断言（它是模型自评），所以不计入。
    const hasIntelNumber =
      competitors.some(
        (c) =>
          c.shareOfVoice !== null ||
          c.contentMatrix.some((m) => m.share !== null) ||
          c.sovTrend.some((t) => t.value !== null),
      ) ||
      pricingBand.some((p) => p.share !== null) ||
      channelMix.some((c) => c.share !== null);
    if (hasIntelNumber && citations.length === 0) {
      issues.push(
        "$.competitors / $.categoryInsights 出现了具体数字（份额、声量、占比）但 $.citations 为空：" +
          "竞品数字必须有来源，否则就是编造市场数据",
      );
    }

    /* 条目级溯源（P0）。这里只做**结构**校验：entryId 是否存在、quote 是否超长。
     * 真实性校验必须放在阶段后处理里做 —— schema 层拿不到"本 job 登记了哪些条目"，
     * 没有证据集就没法判定一个 entryId 是真引用还是编的（见 agents.ts enforceEvidence）。 */
    const evidences = checkArray(root.evidences ?? [], issues, "$.evidences").map((e, i) => {
      const o = checkObject(e, issues, `$.evidences[${i}]`);
      const quote = checkString(o.quote, issues, `$.evidences[${i}].quote`);
      if (quote.length > EVIDENCE_QUOTE_MAX) {
        issues.push(`$.evidences[${i}].quote 超过 ${EVIDENCE_QUOTE_MAX} 字（摘录不是原文留存，请截断）`);
      }
      return {
        entryId: checkString(o.entryId, issues, `$.evidences[${i}].entryId`),
        quote,
        ...(typeof o.useFor === "string" && o.useFor.trim() ? { useFor: o.useFor } : {}),
      };
    });

    /* 品牌自身诊断（P0-1）。校验重点不是"字段齐不齐"，而是**有数字必须有来源**。 */
    const bs = checkObject(root.brandSelf, issues, "$.brandSelf");
    const bsPos = checkObject(bs.positioning, issues, "$.brandSelf.positioning");
    const positioning = {
      statement: checkString(bsPos.statement, issues, "$.brandSelf.positioning.statement"),
      differentiators: checkStringList(bsPos.differentiators, issues, "$.brandSelf.positioning.differentiators", 1),
    };
    const bsAssets = checkArray(bs.contentAssets, issues, "$.brandSelf.contentAssets", 1).map((x, i) => {
      const o = checkObject(x, issues, `$.brandSelf.contentAssets[${i}]`);
      const p = `$.brandSelf.contentAssets[${i}]`;
      return {
        platform: checkString(o.platform, issues, `${p}.platform`),
        accountCount: optionalNumber(o.accountCount, issues, `${p}.accountCount`, 0) ?? null,
        postCount: optionalNumber(o.postCount, issues, `${p}.postCount`, 0) ?? null,
        avgEngagement: optionalNumber(o.avgEngagement, issues, `${p}.avgEngagement`, 0) ?? null,
        tier: checkString(o.tier, issues, `${p}.tier`),
      };
    });
    const bsRep = checkObject(bs.reputation, issues, "$.brandSelf.reputation");
    const sentiment = checkString(bsRep.sentiment, issues, "$.brandSelf.reputation.sentiment");
    const SENTIMENTS = ["positive", "neutral", "negative", "unknown"] as const;
    if (!(SENTIMENTS as readonly string[]).includes(sentiment)) {
      issues.push(`$.brandSelf.reputation.sentiment 必须是 ${SENTIMENTS.join(" / ")} 之一，实际是 ${sentiment}`);
    }
    const bsThemes = checkArray(bsRep.themes ?? [], issues, "$.brandSelf.reputation.themes").map((x, i) => {
      const o = checkObject(x, issues, `$.brandSelf.reputation.themes[${i}]`);
      return {
        theme: checkString(o.theme, issues, `$.brandSelf.reputation.themes[${i}].theme`),
        polarity: checkString(o.polarity, issues, `$.brandSelf.reputation.themes[${i}].polarity`),
        sampleSize: checkNumber(o.sampleSize, issues, `$.brandSelf.reputation.themes[${i}].sampleSize`, 0),
      };
    });
    const bsGaps = checkArray(bs.gaps, issues, "$.brandSelf.gaps", MIN_BRAND_GAPS).map((x, i) => {
      const o = checkObject(x, issues, `$.brandSelf.gaps[${i}]`);
      const p = `$.brandSelf.gaps[${i}]`;
      return {
        dimension: checkString(o.dimension, issues, `${p}.dimension`),
        self: checkString(o.self, issues, `${p}.self`),
        benchmark: checkString(o.benchmark, issues, `${p}.benchmark`),
        delta: checkString(o.delta, issues, `${p}.delta`),
      };
    });
    const bsCitations = checkArray(bs.citations ?? [], issues, "$.brandSelf.citations").map((c, i) => {
      const o = checkObject(c, issues, `$.brandSelf.citations[${i}]`);
      return {
        claim: checkString(o.claim, issues, `$.brandSelf.citations[${i}].claim`),
        sourceKey: checkString(o.sourceKey, issues, `$.brandSelf.citations[${i}].sourceKey`),
        confidence: checkNumber(o.confidence, issues, `$.brandSelf.citations[${i}].confidence`, 0, 1),
      };
    });

    // ── 本章的两条硬防线 ──────────────────────────────────
    // ① 有数字必须有来源。品牌自诊是全篇最容易编造的一章："我方"看起来像"已知信息"，
    //    模型会顺手写"品牌认知度 32%"。没有引用就不许出现数字。
    const hasSelfNumber = bsAssets.some(
      (a) => a.accountCount !== null || a.postCount !== null || a.avgEngagement !== null,
    );
    if (hasSelfNumber && bsCitations.length === 0) {
      issues.push(
        "$.brandSelf.contentAssets 出现具体数字但 $.brandSelf.citations 为空：" +
          "自有资产数字必须逐项说明来源（平台后台 / 甲方提供 / 授权数据），否则就是编造自家数据",
      );
    }
    // ② 无样本不得下情感结论。没有主题样本时 sentiment 只能写 unknown。
    if (sentiment !== "unknown" && bsThemes.length === 0) {
      issues.push(
        "$.brandSelf.reputation.themes 为空时 sentiment 必须是 unknown：" +
          "没有口碑样本就不能给出正面/中性/负面结论",
      );
    }

    throwIfAny(issues);
    return {
      competitors,
      categoryInsights,
      dataGaps,
      citations,
      ...(evidences.length > 0 ? { evidences } : {}),
      brandSelf: {
        positioning,
        contentAssets: bsAssets,
        reputation: { sentiment: sentiment as BrandSelfOutput["reputation"]["sentiment"], themes: bsThemes },
        gaps: bsGaps,
        citations: bsCitations,
      },
    };
  },
  mock: () => ({
    competitors: [
      {
        name: "竞品X",
        positioning: "成分党抗老",
        priceBand: "¥399–699",
        keyClaims: ["专利肽浓度更高", "28天临床数据"],
        shareOfVoice: 0.31,
        contentMatrix: [
          { form: "成分科普短视频", share: 0.45, platform: "douyin" },
          { form: "成分对比笔记", share: 0.3, platform: "xiaohongshu" },
        ],
        sovTrend: [
          { month: "2026-03", value: 0.28 },
          { month: "2026-04", value: 0.31 },
        ],
        differentiation: "主打高浓度专利肽，价格带高于本品，抢占的是成分党而非价格敏感人群",
        confidence: 0.72,
      },
      {
        name: "竞品Y",
        positioning: "平价平替",
        priceBand: "¥159–259",
        keyClaims: ["同等成分更低价格"],
        shareOfVoice: 0.24,
        contentMatrix: [{ form: "价格对比种草", share: 0.6, platform: "xiaohongshu" }],
        sovTrend: [{ month: "2026-04", value: 0.24 }],
        differentiation: "以价格优势争夺同一批新人用户，对本品构成入门级替代压力",
        confidence: 0.68,
      },
      {
        name: "竞品Z",
        positioning: "医研共创",
        priceBand: "¥299–499",
        keyClaims: ["皮肤科医生背书"],
        shareOfVoice: null,
        contentMatrix: [{ form: "医生科普长视频", share: null, platform: "douyin" }],
        sovTrend: [{ month: "2026-04", value: null }],
        differentiation: "以专业背书建立信任，与本品的目标人群重叠度最高",
        confidence: 0.55,
      },
    ],
    categoryInsights: {
      trends: ["「早C晚A」向「精简护肤」迁移", "抗老成分话语权从 A醇 转向 胜肽+玻色因复配"],
      audience: ["25–34 岁一二线城市女性为主", "决策路径：短视频种草 → 搜索比价 → 直播间成交"],
      seasonality: ["618 前 2 周为声量峰值", "夏季控油需求上升，精华轻质化明显"],
      pricingBand: [
        { band: "¥159–259", share: 0.28 },
        { band: "¥299–499", share: 0.44 },
        { band: "¥500+", share: 0.28 },
      ],
      channelMix: [
        { channel: "douyin", share: 0.52 },
        { channel: "xiaohongshu", share: 0.31 },
        { channel: "货架电商", share: 0.17 },
      ],
    },
    dataGaps: ["竞品投放消耗（预期不可得，须走 L3 / 人工）", "达人报价（官方无公开接口）", "自有内容资产指标（未获平台授权）"],
    citations: [
      { claim: "竞品X声量份额 31%", sourceKey: "public_intel", confidence: 0.72 },
      { claim: "抗老成分话语迁移", sourceKey: "methodology", confidence: 0.55 },
    ],
    // 兜底必须演示**正确的**未授权形态：数字全 null、citations 为空、sentiment=unknown。
    // 如果这里填了占位数字，兜底报告就会开始编造甲方自己的经营数据。
    brandSelf: {
      positioning: {
        statement: "本品定位与差异点须由甲方确认：本轮未获品牌资产数据授权，以下仅为待确认的定性框架",
        differentiators: ["待甲方确认（未获授权，不做推断）"],
      },
      contentAssets: [
        { platform: "douyin", accountCount: null, postCount: null, avgEngagement: null, tier: "未获授权" },
        { platform: "xiaohongshu", accountCount: null, postCount: null, avgEngagement: null, tier: "未获授权" },
      ],
      reputation: { sentiment: "unknown", themes: [] },
      gaps: [
        {
          dimension: "价格带覆盖",
          self: "待甲方确认",
          benchmark: "竞品覆盖 ¥159–699（公开情报）",
          delta: "无法计算：缺本品价格带与销量结构",
        },
        {
          dimension: "内容声量",
          self: "待甲方确认",
          benchmark: "竞品以成分科普短视频为主（公开可见）",
          delta: "无法计算：未接入本品内容资产与投放数据",
        },
        {
          dimension: "人群重合度",
          self: "待甲方确认",
          benchmark: "竞品主攻 25–34 岁一二线成分党",
          delta: "无法计算：缺本品粉丝画像（需平台授权）",
        },
      ],
      citations: [],
    },
  }),
};

/* ── 3. CreatorCandidatesSchema（CT 人选匹配） ──────────── */

export type CreatorTier = "head" | "mid" | "tail";

export interface CreatorOutput {
  candidates: {
    talentId: string;
    nickname: string;
    platform: string;
    followers: number;
    category: string;
    matchScore: number;
    rationale: string;
    estimatedCost: number;
    costRange: { low: number; high: number };
    riskFlags: string[];
    /** 分层：头部 / 腰部 / 尾部。三层都必须至少各 1 人。 */
    tier: CreatorTier;
    /** 内容形态契合度说明 */
    contentFit: string;
    /** 历史表现（取自 KB-2 私域库；无样本时如实写"无样本"） */
    historicalPerformance: string;
    confidence: number;
  }[];
  /** 明确说明筛掉了什么，以及为什么 */
  excluded: { reason: string; count: number }[];
  /** 候选人选所依据的检索命中（报告里必须能追溯到来源） */
  citations: { claim: string; sourceKey: string; confidence: number }[];
}

export const CreatorCandidatesSchema: SchemaDef<CreatorOutput> = {
  name: "CreatorCandidatesSchema",
  skeleton: `{
  "candidates": [{ "talentId": string, "nickname": string, "platform": string, "followers": number,
                   "category": string, "matchScore": number, "rationale": string, "estimatedCost": number,
                   "costRange": { "low": number, "high": number }, "riskFlags": string[],
                   "tier": "head|mid|tail",              // 三层必须各至少 1 人
                   "contentFit": string,                 // 内容形态契合度
                   "historicalPerformance": string,      // 历史表现，无样本写"无样本"
                   "confidence": number }],
  "excluded": [{ "reason": string, "count": number }],
  "citations": [{ "claim": string, "sourceKey": string, "confidence": number }]
}`,
  validate(input) {
    const issues: string[] = [];
    const root = checkObject(input, issues, "$");
    const candidates = checkArray(root.candidates, issues, "$.candidates", 1).map((c, i) => {
      const o = checkObject(c, issues, `$.candidates[${i}]`);
      const range = checkObject(o.costRange, issues, `$.candidates[${i}].costRange`);
      return {
        talentId: checkString(o.talentId, issues, `$.candidates[${i}].talentId`),
        nickname: checkString(o.nickname, issues, `$.candidates[${i}].nickname`),
        platform: checkString(o.platform, issues, `$.candidates[${i}].platform`),
        followers: checkNumber(o.followers, issues, `$.candidates[${i}].followers`, 0),
        category: checkString(o.category, issues, `$.candidates[${i}].category`),
        matchScore: checkNumber(o.matchScore, issues, `$.candidates[${i}].matchScore`, 0, 1),
        rationale: checkString(o.rationale, issues, `$.candidates[${i}].rationale`),
        estimatedCost: checkNumber(o.estimatedCost, issues, `$.candidates[${i}].estimatedCost`, 0),
        costRange: {
          low: checkNumber(range.low, issues, `$.candidates[${i}].costRange.low`, 0),
          high: checkNumber(range.high, issues, `$.candidates[${i}].costRange.high`, 0),
        },
        riskFlags: checkArray(o.riskFlags, issues, `$.candidates[${i}].riskFlags`).map((x, j) => checkString(x, issues, `$.candidates[${i}].riskFlags[${j}]`)).filter(Boolean),
        tier: checkEnum(o.tier, ["head", "mid", "tail"] as const, issues, `$.candidates[${i}].tier`, "mid"),
        contentFit: checkString(o.contentFit, issues, `$.candidates[${i}].contentFit`),
        historicalPerformance: checkString(o.historicalPerformance, issues, `$.candidates[${i}].historicalPerformance`),
        confidence: checkNumber(o.confidence, issues, `$.candidates[${i}].confidence`, 0, 1),
      };
    });
    // 三层覆盖：缺层会导致报告的人选建议页出现"分层缺失"的空洞
    const tiers = new Set(candidates.map((c) => c.tier));
    const missing = (["head", "mid", "tail"] as const).filter((t) => !tiers.has(t));
    if (missing.length > 0) {
      issues.push(`$.candidates 缺少分层：${missing.join("、")}（head/mid/tail 三层都必须至少 1 人）`);
    }
    const excluded = checkArray(root.excluded, issues, "$.excluded").map((e, i) => {
      const o = checkObject(e, issues, `$.excluded[${i}]`);
      return { reason: checkString(o.reason, issues, `$.excluded[${i}].reason`), count: checkNumber(o.count, issues, `$.excluded[${i}].count`, 0) };
    });
    const citations = checkArray(root.citations, issues, "$.citations", 1).map((c, i) => {
      const o = checkObject(c, issues, `$.citations[${i}]`);
      return {
        claim: checkString(o.claim, issues, `$.citations[${i}].claim`),
        sourceKey: checkString(o.sourceKey, issues, `$.citations[${i}].sourceKey`),
        confidence: checkNumber(o.confidence, issues, `$.citations[${i}].confidence`, 0, 1),
      };
    });
    throwIfAny(issues);
    return { candidates, excluded, citations };
  },
  mock: () => ({
    candidates: [
      {
        talentId: "t_1003",
        nickname: "皮肤科医生老王",
        platform: "douyin",
        followers: 2_150_000,
        category: "美妆护肤",
        matchScore: 0.74,
        rationale: "专业背书能力强，适合建立抗老功效信任，但互动率偏低，短时间拉声量效率一般",
        estimatedCost: 330_000,
        costRange: { low: 260_000, high: 420_000 },
        riskFlags: ["互动量/千粉偏低，触达效率存疑"],
        tier: "head" as const,
        contentFit: "成分科普 + 医生背书，与「胜肽抗老」卖点契合",
        historicalPerformance: "无样本",
        confidence: 0.68,
      },
      {
        talentId: "t_1001",
        nickname: "护肤成分实验室",
        platform: "douyin",
        followers: 1_280_000,
        category: "美妆护肤",
        matchScore: 0.86,
        rationale: "成分讲解型内容与「抗老胜肽」卖点契合，历史带精华类目转化率高于类目均值",
        estimatedCost: 185_000,
        costRange: { low: 150_000, high: 230_000 },
        riskFlags: ["近 3 个月更换过 MCN"],
        tier: "head" as const,
        contentFit: "成分拆解短视频，天然承接功效叙事",
        historicalPerformance: "精华类目转化率高于类目均值 34%（KB-2）",
        confidence: 0.71,
      },
      {
        talentId: "t_1005",
        nickname: "精致阿姨的梳妆台",
        platform: "douyin",
        followers: 890_000,
        category: "美妆护肤",
        matchScore: 0.7,
        rationale: "受众偏成熟，与抗老心智匹配，但价格带敏感度更高",
        estimatedCost: 121_000,
        costRange: { low: 95_000, high: 158_000 },
        riskFlags: [],
        tier: "mid" as const,
        contentFit: "日常护肤 vlog，适合做使用场景与前后对比",
        historicalPerformance: "无样本",
        confidence: 0.6,
      },
      {
        talentId: "t_1002",
        nickname: "三十岁护肤日记",
        platform: "xiaohongshu",
        followers: 460_000,
        category: "美妆护肤",
        matchScore: 0.79,
        rationale: "受众与目标人群高度重合，笔记收藏率高，适合做搜索承接",
        estimatedCost: 62_000,
        costRange: { low: 45_000, high: 88_000 },
        riskFlags: [],
        tier: "mid" as const,
        contentFit: "图文笔记 + 收藏型干货，适合搜索沉淀",
        historicalPerformance: "收藏率高于类目均值（KB-2 领先指标）",
        confidence: 0.64,
      },
      {
        talentId: "t_1004",
        nickname: "成分党小圆",
        platform: "xiaohongshu",
        followers: 168_000,
        category: "美妆护肤",
        matchScore: 0.77,
        rationale: "互动率最高，适合做小成本口碑铺量",
        estimatedCost: 19_500,
        costRange: { low: 15_000, high: 26_000 },
        riskFlags: [],
        tier: "tail" as const,
        contentFit: "成分党口碑笔记，适合长尾铺量与搜索占位",
        historicalPerformance: "无样本",
        confidence: 0.58,
      },
    ],
    excluded: [
      { reason: "本系统未接入平台官方达人画像接口（需企业主体 + 关系数据权限审核），粉丝画像类指标缺失", count: 0 },
      { reason: "报价样本不足 3 条，仅给区间不给点估计", count: 4 },
    ],
    citations: [
      { claim: "成分讲解型达人的精华类目转化率平均比颜值型高 34%", sourceKey: "internal_review", confidence: 0.6 },
      { claim: "小红书笔记收藏率是搜索型转化的领先指标", sourceKey: "methodology", confidence: 0.5 },
    ],
  }),
};

/* ── 4. PlaybookSchema（PL 打法排期） ──────────────────── */

export interface PlaybookOutput {
  phases: {
    label: string;
    from: string;
    to: string;
    platforms: string[];
    contentTypes: string[];
    budgetShare: number;
    creatorIds: string[];
    kpiTargets: { metric: string; target: number; unit: string; stopLoss: number; trigger: string }[];
  }[];
  /** 按周的内容日历：报告「内容日历」页直接用它 */
  weeklyCalendar: {
    week: number;
    from: string;
    to: string;
    platform: string;
    contentType: string;
    creatorIds: string[];
    theme: string;
  }[];
  rationale: string;
  /** 排序冲突或资源冲突，明确列出 */
  conflicts: string[];
  /** 排期所依据的检索命中（报告里必须能追溯到来源） */
  citations: { claim: string; sourceKey: string; confidence: number }[];
}

export const PlaybookSchema: SchemaDef<PlaybookOutput> = {
  name: "PlaybookSchema",
  skeleton: `{
  "phases": [{ "label": string, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "platforms": string[],
               "contentTypes": string[], "budgetShare": number, "creatorIds": string[],
               "kpiTargets": [{ "metric": string, "target": number, "unit": string,
                                "stopLoss": number,                 // 止损线（同口径下限）
                                "trigger": string }] }],            // 触发止损的信号
  "weeklyCalendar": [{ "week": number, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "platform": string,
                       "contentType": string, "creatorIds": string[], "theme": string }],
  "rationale": string,                    // ≥10 字，说明为什么这样排
  "conflicts": string[],
  "citations": [{ "claim": string, "sourceKey": string, "confidence": number }]
}                                        // 所有 phases 的 budgetShare 之和必须 = 1`,
  validate(input) {
    const issues: string[] = [];
    const root = checkObject(input, issues, "$");
    const phases = checkArray(root.phases, issues, "$.phases", 1).map((p, i) => {
      const o = checkObject(p, issues, `$.phases[${i}]`);
      const kpis = checkArray(o.kpiTargets, issues, `$.phases[${i}].kpiTargets`).map((k, j) => {
        const ko = checkObject(k, issues, `$.phases[${i}].kpiTargets[${j}]`);
        return {
          metric: checkString(ko.metric, issues, `$.phases[${i}].kpiTargets[${j}].metric`),
          target: checkNumber(ko.target, issues, `$.phases[${i}].kpiTargets[${j}].target`, 0),
          unit: typeof ko.unit === "string" ? ko.unit : "",
          stopLoss: checkNumber(ko.stopLoss, issues, `$.phases[${i}].kpiTargets[${j}].stopLoss`, 0),
          trigger: checkString(ko.trigger, issues, `$.phases[${i}].kpiTargets[${j}].trigger`),
        };
      });
      return {
        label: checkString(o.label, issues, `$.phases[${i}].label`),
        from: checkString(o.from, issues, `$.phases[${i}].from`),
        to: checkString(o.to, issues, `$.phases[${i}].to`),
        platforms: checkArray(o.platforms, issues, `$.phases[${i}].platforms`).map((x) => String(x)),
        contentTypes: checkArray(o.contentTypes, issues, `$.phases[${i}].contentTypes`).map((x) => String(x)),
        budgetShare: checkNumber(o.budgetShare, issues, `$.phases[${i}].budgetShare`, 0, 1),
        creatorIds: checkArray(o.creatorIds, issues, `$.phases[${i}].creatorIds`).map((x) => String(x)),
        kpiTargets: kpis,
      };
    });
    const totalShare = phases.reduce((n, p) => n + p.budgetShare, 0);
    if (Math.abs(totalShare - 1) > 0.02) issues.push(`$.phases[].budgetShare 之和必须为 1，实际 ${totalShare.toFixed(3)}`);

    const weeklyCalendar = checkArray(root.weeklyCalendar, issues, "$.weeklyCalendar", 1).map((w, i) => {
      const o = checkObject(w, issues, `$.weeklyCalendar[${i}]`);
      return {
        week: checkNumber(o.week, issues, `$.weeklyCalendar[${i}].week`, 1),
        from: checkString(o.from, issues, `$.weeklyCalendar[${i}].from`),
        to: checkString(o.to, issues, `$.weeklyCalendar[${i}].to`),
        platform: checkString(o.platform, issues, `$.weeklyCalendar[${i}].platform`),
        contentType: checkString(o.contentType, issues, `$.weeklyCalendar[${i}].contentType`),
        creatorIds: checkArray(o.creatorIds, issues, `$.weeklyCalendar[${i}].creatorIds`).map((x) => String(x)),
        theme: checkString(o.theme, issues, `$.weeklyCalendar[${i}].theme`),
      };
    });

    const rationale = checkString(root.rationale, issues, "$.rationale", 10);
    const conflicts = checkArray(root.conflicts, issues, "$.conflicts").map((x) => String(x));
    const citations = checkArray(root.citations, issues, "$.citations", 1).map((c, i) => {
      const o = checkObject(c, issues, `$.citations[${i}]`);
      return {
        claim: checkString(o.claim, issues, `$.citations[${i}].claim`),
        sourceKey: checkString(o.sourceKey, issues, `$.citations[${i}].sourceKey`),
        confidence: checkNumber(o.confidence, issues, `$.citations[${i}].confidence`, 0, 1),
      };
    });
    throwIfAny(issues);
    return { phases, weeklyCalendar, rationale, conflicts, citations };
  },
  mock: () => ({
    phases: [
      { label: "预热期", from: "2026-05-20", to: "2026-05-31", platforms: ["xiaohongshu"], contentTypes: ["成分科普笔记"], budgetShare: 0.2, creatorIds: ["t_1002"], kpiTargets: [{ metric: "互动量", target: 60_000, unit: "次", stopLoss: 30_000, trigger: "连续 3 天互动量低于止损线" }] },
      { label: "爆发期", from: "2026-06-01", to: "2026-06-15", platforms: ["douyin"], contentTypes: ["达人种草短视频", "直播间承接"], budgetShare: 0.6, creatorIds: ["t_1001"], kpiTargets: [{ metric: "ROI", target: 2.1, unit: "", stopLoss: 1.5, trigger: "日 ROI 连续 2 天低于止损线" }] },
      { label: "长尾期", from: "2026-06-16", to: "2026-06-20", platforms: ["douyin", "xiaohongshu"], contentTypes: ["搜索承接", "用户口碑"], budgetShare: 0.2, creatorIds: ["t_1001", "t_1002"], kpiTargets: [{ metric: "搜索指数", target: 5_200, unit: "", stopLoss: 3_000, trigger: "搜索指数一周下滑超过 30%" }] },
    ],
    weeklyCalendar: [
      { week: 1, from: "2026-05-20", to: "2026-05-26", platform: "xiaohongshu", contentType: "成分科普笔记", creatorIds: ["t_1002"], theme: "建立「胜肽抗老」类目话语权" },
      { week: 2, from: "2026-05-27", to: "2026-06-02", platform: "xiaohongshu", contentType: "成分对比与收藏型干货", creatorIds: ["t_1002", "t_1004"], theme: "沉淀搜索关键词与收藏资产" },
      { week: 3, from: "2026-06-03", to: "2026-06-09", platform: "douyin", contentType: "头部达人种草短视频", creatorIds: ["t_1001", "t_1003"], theme: "集中爆发，拉声量与人群破圈" },
      { week: 4, from: "2026-06-10", to: "2026-06-16", platform: "douyin", contentType: "直播间承接 + 信息流", creatorIds: ["t_1001", "t_1005"], theme: "承接达人外溢流量并转化" },
      { week: 5, from: "2026-06-17", to: "2026-06-20", platform: "xiaohongshu", contentType: "搜索承接与用户口碑", creatorIds: ["t_1002", "t_1004"], theme: "长尾搜索占位，防流量溢出到竞品" },
    ],
    rationale: "先在小红书建立成分话语权降低教育成本，再在抖音用头部达人做爆发，最后用搜索承接长尾，避免预算全压在爆发期导致断档。",
    conflicts: ["t_1001 在 6/1–6/15 档期与竞品X 的历史合作可能冲突，需商务确认"],
    citations: [
      { claim: "三段式打法模板：预热 20% / 爆发 60% / 长尾 20%", sourceKey: "methodology", confidence: 0.55 },
      { claim: "搜索承接页必须在达人内容上线前 3 天完成", sourceKey: "internal_review", confidence: 0.6 },
    ],
  }),
};

/* ── 5. BudgetSchema（BR 预算风控） ────────────────────── */

export interface BudgetOutput {
  allocation: { channel: string; amount: number; share: number; expectedRoi: number; rationale: string; confidence: number }[];
  /** 渠道 × 阶段交叉矩阵：报告「渠道×阶段矩阵」页直接用它 */
  stageMatrix: { channel: string; stage: string; amount: number; expectedRoi: number }[];
  scenarios: { base: { roi: number; gmv: number }; best: { roi: number; gmv: number }; worst: { roi: number; gmv: number } };
  risks: { risk: string; probability: number; impact: string; mitigation: string; owner: string; signal: string }[];
  /** 必须存在的免责声明（三档情景模拟的强制要求） */
  disclaimer: string;
}

export const BudgetSchema: SchemaDef<BudgetOutput> = {
  name: "BudgetSchema",
  skeleton: `{
  "allocation": [{ "channel": string, "amount": number, "share": number, "expectedRoi": number,
                   "rationale": string, "confidence": number }],
  "stageMatrix": [{ "channel": string, "stage": string, "amount": number, "expectedRoi": number }],
  "scenarios": { "base": { "roi": number, "gmv": number }, "best": { "roi": number, "gmv": number },
                 "worst": { "roi": number, "gmv": number } },
  "risks": [{ "risk": string, "probability": number, "impact": string, "mitigation": string,
              "owner": string,                 // 责任人/责任方
              "signal": string }],             // 触发信号（什么情况下这条风险算发生了）
  "disclaimer": string                    // 必须有，三档情景是模拟值不构成承诺
}                                        // 所有 allocation 的 share 之和必须 = 1`,
  validate(input) {
    const issues: string[] = [];
    const root = checkObject(input, issues, "$");
    const allocation = checkArray(root.allocation, issues, "$.allocation", 1).map((a, i) => {
      const o = checkObject(a, issues, `$.allocation[${i}]`);
      return {
        channel: checkString(o.channel, issues, `$.allocation[${i}].channel`),
        amount: checkNumber(o.amount, issues, `$.allocation[${i}].amount`, 0),
        share: checkNumber(o.share, issues, `$.allocation[${i}].share`, 0, 1),
        expectedRoi: checkNumber(o.expectedRoi, issues, `$.allocation[${i}].expectedRoi`, 0),
        rationale: checkString(o.rationale, issues, `$.allocation[${i}].rationale`),
        confidence: checkNumber(o.confidence, issues, `$.allocation[${i}].confidence`, 0, 1),
      };
    });
    const totalShare = allocation.reduce((n, a) => n + a.share, 0);
    if (Math.abs(totalShare - 1) > 0.02) issues.push(`$.allocation[].share 之和必须为 1，实际 ${totalShare.toFixed(3)}`);

    const stageMatrix = checkArray(root.stageMatrix, issues, "$.stageMatrix", 1).map((m, i) => {
      const o = checkObject(m, issues, `$.stageMatrix[${i}]`);
      return {
        channel: checkString(o.channel, issues, `$.stageMatrix[${i}].channel`),
        stage: checkString(o.stage, issues, `$.stageMatrix[${i}].stage`),
        amount: checkNumber(o.amount, issues, `$.stageMatrix[${i}].amount`, 0),
        expectedRoi: checkNumber(o.expectedRoi, issues, `$.stageMatrix[${i}].expectedRoi`, 0),
      };
    });

    const s = checkObject(root.scenarios, issues, "$.scenarios");
    const scene = (k: "base" | "best" | "worst") => {
      const o = checkObject(s[k], issues, `$.scenarios.${k}`);
      return { roi: checkNumber(o.roi, issues, `$.scenarios.${k}.roi`, 0), gmv: checkNumber(o.gmv, issues, `$.scenarios.${k}.gmv`, 0) };
    };
    const scenarios = { base: scene("base"), best: scene("best"), worst: scene("worst") };
    const risks = checkArray(root.risks, issues, "$.risks", 1).map((r, i) => {
      const o = checkObject(r, issues, `$.risks[${i}]`);
      return {
        risk: checkString(o.risk, issues, `$.risks[${i}].risk`),
        probability: checkNumber(o.probability, issues, `$.risks[${i}].probability`, 0, 1),
        impact: checkString(o.impact, issues, `$.risks[${i}].impact`),
        mitigation: checkString(o.mitigation, issues, `$.risks[${i}].mitigation`),
        owner: checkString(o.owner, issues, `$.risks[${i}].owner`),
        signal: checkString(o.signal, issues, `$.risks[${i}].signal`),
      };
    });
    const disclaimer = checkString(root.disclaimer, issues, "$.disclaimer", 10);
    throwIfAny(issues);
    return { allocation, stageMatrix, scenarios, risks, disclaimer };
  },
  mock: () => ({
    allocation: [
      { channel: "抖音-达人种草", amount: 1_500_000, share: 0.5, expectedRoi: 2.2, rationale: "爆发期主力，头部达人拉声量", confidence: 0.68 },
      { channel: "抖音-千川投放", amount: 900_000, share: 0.3, expectedRoi: 2.6, rationale: "承接达人流量，控制流失", confidence: 0.74 },
      { channel: "小红书-笔记与搜索", amount: 600_000, share: 0.2, expectedRoi: 1.4, rationale: "降低教育成本、承接搜索", confidence: 0.6 },
    ],
    stageMatrix: [
      { channel: "小红书-笔记与搜索", stage: "预热期", amount: 400_000, expectedRoi: 1.2 },
      { channel: "抖音-达人种草", stage: "爆发期", amount: 1_200_000, expectedRoi: 2.3 },
      { channel: "抖音-千川投放", stage: "爆发期", amount: 800_000, expectedRoi: 2.7 },
      { channel: "抖音-达人种草", stage: "长尾期", amount: 300_000, expectedRoi: 1.8 },
      { channel: "小红书-笔记与搜索", stage: "长尾期", amount: 200_000, expectedRoi: 1.5 },
      { channel: "抖音-千川投放", stage: "长尾期", amount: 100_000, expectedRoi: 2.1 },
    ],
    scenarios: { base: { roi: 2.1, gmv: 6_300_000 }, best: { roi: 2.8, gmv: 8_400_000 }, worst: { roi: 1.3, gmv: 3_900_000 } },
    risks: [
      { risk: "头部达人档期冲突", probability: 0.4, impact: "爆发期声量不达标", mitigation: "预留 15% 预算作为备选达人池", owner: "商务/达人合作组", signal: "开播前 7 天仍未确认档期" },
      { risk: "达人报价上浮", probability: 0.55, impact: "预算缺口约 8–12%", mitigation: "按成交价而非刊例价签约，锁定阶梯价", owner: "商务/采购", signal: "签约价高于刊例折扣 0.8 的比例超过 30%" },
    ],
    disclaimer: "以上为基于历史数据与公开指数的情景模拟，不构成投放承诺；实际 ROI 受供给、竞品、平台规则影响。",
  }),
};

/* ── 6. ReportDslSchema（RG 研报生成） ─────────────────── */

const BLOCK_STYLES = ["h2", "h3", "body", "caption"] as const;
const CALLOUT_TONES = ["info", "warn", "risk"] as const;
const CHART_TYPES = ["bar", "line", "pie", "scatter", "funnel"] as const;
const CONFIDENCE_TIERS = ["high", "medium", "low"] as const;
const CITATION_KINDS = ["data_source", "kb_chunk", "model_inference"] as const;
const GRADES = ["L1", "L2", "L3", "L4"] as const;

/**
 * 逐块结构校验。
 *
 * 为什么非做不可：`numericClaims()` / 渲染器会直接读 block 的字段（series / cells / rows …），
 * 模型漏给 `series` 时，校验期不报错、渲染期才崩。这里把每种块型的必需字段都验一遍，
 * 错误信息直接告诉模型缺哪一项。
 */
function validateBlock(b: unknown, issues: string[], path: string): Block {
  const o = checkObject(b, issues, path);
  const srcRef = optionalString(o.sourceRef, issues, `${path}.sourceRef`);
  const sref = srcRef ? { sourceRef: srcRef } : {};
  const type = typeof o.type === "string" ? o.type : "";
  switch (type) {
    case "text":
      return { type: "text", style: checkEnum(o.style, BLOCK_STYLES, issues, `${path}.style`, "body"), content: checkString(o.content, issues, `${path}.content`), ...sref };
    case "bullets":
      return { type: "bullets", items: checkStringList(o.items, issues, `${path}.items`, 1), ...sref };
    case "kpi": {
      const items = checkArray(o.items, issues, `${path}.items`, 1).map((it, i) => {
        const io = checkObject(it, issues, `${path}.items[${i}]`);
        const confidence = optionalNumber(io.confidence, issues, `${path}.items[${i}].confidence`, 0, 1);
        const tier = io.tier === undefined || io.tier === null ? undefined : checkEnum(io.tier, CONFIDENCE_TIERS, issues, `${path}.items[${i}].tier`, "medium");
        const itemRef = optionalString(io.sourceRef, issues, `${path}.items[${i}].sourceRef`);
        return {
          label: checkString(io.label, issues, `${path}.items[${i}].label`),
          value: checkString(io.value, issues, `${path}.items[${i}].value`),
          ...(typeof io.unit === "string" ? { unit: io.unit } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(tier !== undefined ? { tier } : {}),
          ...(itemRef ? { sourceRef: itemRef } : {}),
        };
      });
      return { type: "kpi", items, ...sref };
    }
    case "table": {
      const columns = checkStringList(o.columns, issues, `${path}.columns`, 1);
      const rows = checkArray(o.rows, issues, `${path}.rows`, 1).map((r, i) => checkStringList(r, issues, `${path}.rows[${i}]`));
      const caption = optionalString(o.caption, issues, `${path}.caption`);
      return { type: "table", columns, rows, ...(caption ? { caption } : {}), ...sref };
    }
    case "chart": {
      const chartType = checkEnum(o.chartType, CHART_TYPES, issues, `${path}.chartType`, "bar");
      const series = checkArray(o.series, issues, `${path}.series`, 1).map((s, i) => {
        const so = checkObject(s, issues, `${path}.series[${i}]`);
        const points = checkArray(so.points, issues, `${path}.series[${i}].points`, 1).map((p, j) => {
          const po = checkObject(p, issues, `${path}.series[${i}].points[${j}]`);
          return {
            x: checkString(po.x, issues, `${path}.series[${i}].points[${j}].x`),
            y: checkNumber(po.y, issues, `${path}.series[${i}].points[${j}].y`),
          };
        });
        return { name: checkString(so.name, issues, `${path}.series[${i}].name`), points };
      });
      const axisObj = isObj(o.axis) ? o.axis : undefined;
      const axis = axisObj
        ? {
            ...(typeof axisObj.xLabel === "string" ? { xLabel: axisObj.xLabel } : {}),
            ...(typeof axisObj.yLabel === "string" ? { yLabel: axisObj.yLabel } : {}),
          }
        : undefined;
      return { type: "chart", chartType, series, ...(axis ? { axis } : {}), ...sref };
    }
    case "matrix": {
      const cells = checkArray(o.cells, issues, `${path}.cells`, 1).map((c, i) => {
        const co = checkObject(c, issues, `${path}.cells[${i}]`);
        const size = optionalNumber(co.size, issues, `${path}.cells[${i}].size`);
        return {
          x: checkNumber(co.x, issues, `${path}.cells[${i}].x`),
          y: checkNumber(co.y, issues, `${path}.cells[${i}].y`),
          label: checkString(co.label, issues, `${path}.cells[${i}].label`),
          ...(size !== undefined ? { size } : {}),
        };
      });
      return { type: "matrix", xLabel: checkString(o.xLabel, issues, `${path}.xLabel`), yLabel: checkString(o.yLabel, issues, `${path}.yLabel`), cells, ...sref };
    }
    case "timeline": {
      const phases = checkArray(o.phases, issues, `${path}.phases`, 1).map((p, i) => {
        const po = checkObject(p, issues, `${path}.phases[${i}]`);
        return {
          label: checkString(po.label, issues, `${path}.phases[${i}].label`),
          from: checkString(po.from, issues, `${path}.phases[${i}].from`),
          to: checkString(po.to, issues, `${path}.phases[${i}].to`),
          items: checkStringList(po.items, issues, `${path}.phases[${i}].items`),
        };
      });
      return { type: "timeline", phases, ...sref };
    }
    case "callout":
      return { type: "callout", tone: checkEnum(o.tone, CALLOUT_TONES, issues, `${path}.tone`, "info"), text: checkString(o.text, issues, `${path}.text`), ...sref };
    case "quote": {
      const attribution = optionalString(o.attribution, issues, `${path}.attribution`);
      return { type: "quote", text: checkString(o.text, issues, `${path}.text`), ...(attribution ? { attribution } : {}), ...sref };
    }
    case "image": {
      const caption = optionalString(o.caption, issues, `${path}.caption`);
      return { type: "image", ref: checkString(o.ref, issues, `${path}.ref`), ...(caption ? { caption } : {}), ...sref };
    }
    default:
      issues.push(`${path}.type 缺失或不是支持的块型，必须是 text|bullets|kpi|table|chart|matrix|timeline|callout|quote|image 之一，实际 ${JSON.stringify(o.type)}`);
      return { type: "text", style: "body", content: "" };
  }
}

/**
 * 单页校验。
 *
 * 抽出来是为了**两个 schema 共用同一份规则**：
 *   · `ReportDslSchema`（整份报告）
 *   · `ReportPagePatchSchema`（P1 按页补丁，只回喂出问题的那几页）
 *
 * 两套校验各写一遍必然分叉——补丁页会「生成期过、渲染期不过」或者反过来，这正是
 * 2026-10-16 那轮事故的形状（生成期判阻塞 / 渲染期能修，口径不一致烧掉 23 分钟）。
 */
function validateSlide(raw: unknown, issues: string[], path: string): SlideSpec {
  const o = checkObject(raw, issues, path);
  const pageRole = checkEnum(o.pageRole, PAGE_ROLES, issues, `${path}.pageRole`, "content");
  const blocks = checkArray(o.blocks, issues, `${path}.blocks`, 1).map((b, j) => validateBlock(b, issues, `${path}.blocks[${j}]`));
  const citations: SlideSpec["citations"] = checkArray(o.citations ?? [], issues, `${path}.citations`).map((c, j) => {
    const cPath = `${path}.citations[${j}]`;
    const co = checkObject(c, issues, cPath);
    // kind 缺失必须报错，不能静默兜底成 model_inference —— 兜底会把「模型漏字段」
    // 洗成「一条合法的推断引用」，问题被掩盖到渲染期才暴露。
    if (co.kind === undefined || co.kind === null) {
      issues.push(`${cPath}.kind 缺失，必须是 data_source|kb_chunk|model_inference`);
    }
    const kind = checkEnum(co.kind, CITATION_KINDS, issues, `${cPath}.kind`, "model_inference");
    const refObj = isObj(co.ref) ? (co.ref as Record<string, unknown>) : {};
    // kind 与 ref 必须自洽：sourceKey 对应 data_source、chunkId 对应 kb_chunk
    if (kind === "data_source" && typeof refObj.sourceKey !== "string") {
      issues.push(`${cPath}：kind=data_source 时 ref.sourceKey 必填`);
    }
    if (kind === "kb_chunk" && typeof refObj.chunkId !== "string") {
      issues.push(`${cPath}：kind=kb_chunk 时 ref.chunkId 必填`);
    }
    const tier = checkEnum(co.tier, CONFIDENCE_TIERS, issues, `${cPath}.tier`, kind === "model_inference" ? "low" : "medium");
    if (kind === "model_inference" && tier !== "low") {
      issues.push(`${cPath}：kind=model_inference 必须 tier=low（当前 ${tier}）——推断不是引用依据`);
    }
    const grade = checkEnum(co.grade, GRADES, issues, `${cPath}.grade`, "L3");
    return {
      claim: checkString(co.claim, issues, `${cPath}.claim`),
      kind,
      ref: {
        ...(typeof refObj.sourceKey === "string" ? { sourceKey: refObj.sourceKey } : {}),
        ...(typeof refObj.chunkId === "string" ? { chunkId: refObj.chunkId } : {}),
        ...(typeof refObj.runId === "string" ? { runId: refObj.runId } : {}),
        ...(typeof refObj.fieldPath === "string" ? { fieldPath: refObj.fieldPath } : {}),
      },
      grade,
      confidence: checkNumber(co.confidence, issues, `${cPath}.confidence`, 0, 1),
      tier,
      verifiedBy: (co.verifiedBy === "human" ? "human" : "auto") as "auto" | "human",
    };
  });
  const notes = optionalString(o.notes, issues, `${path}.notes`);
  return {
    index: checkNumber(o.index, issues, `${path}.index`, 0),
    pageRole,
    title: checkString(o.title, issues, `${path}.title`),
    layoutId: typeof o.layoutId === "string" && o.layoutId ? o.layoutId : "content/default",
    blocks,
    citations,
    ...(notes ? { notes } : {}),
  };
}

export const ReportDslSchema: SchemaDef<ReportDsl> = {
  name: "ReportDslSchema",
  /**
   * 骨架 = 模型唯一能看到的结构说明。
   * ⚠️ 改这里必须同步 `tests/schema-coverage.test.ts` 里的全量清单断言。
   */
  skeleton: `{
  "meta": { "dslVersion": "1.0", "title": string,
            "brand": { "id": string, "name": string },
            "window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
            "generatedAt": "ISO8601" },              // 注意：meta 里没有租户字段，不要写
  "sourceDeclaration": {
    "grade": "L2|L3",                                // 本系统没有 L1 实测源；L4 一律禁止
    "sources":    [{ "key": string, "displayName": string, "grade": "L2|L3",
                     "asOf": "ISO8601", "coverage": string }],
    "exclusions": [{ "key": string, "reason": string }] },
  "slides": [{ "index": number,                       // 第一页是 0，逐页 +1
               "pageRole": "cover|toc|section|content|data|appendix|closing",
               "title": string,
               "layoutId": string,
               "blocks": [                            // 共 10 种，按需选用，不要只用 table
                 { "type": "text",     "style": "h2|h3|body|caption", "content": string, "sourceRef?": string },
                 { "type": "bullets",  "items": string[], "sourceRef?": string },
                 { "type": "kpi",      "items": [{ "label": string, "value": string, "unit?": string,
                                                   "confidence?": number, "tier?": "high|medium|low",
                                                   "sourceRef?": string }], "sourceRef?": string },
                 { "type": "table",    "columns": string[], "rows": string[][], "caption?": string, "sourceRef?": string },
                 { "type": "chart",    "chartType": "bar|line|pie|scatter|funnel",
                                       "series": [{ "name": string, "points": [{ "x": string, "y": number }] }],
                                       "axis?": { "xLabel?": string, "yLabel?": string }, "sourceRef?": string },
                 { "type": "matrix",   "xLabel": string, "yLabel": string,
                                       "cells": [{ "x": number, "y": number, "label": string, "size?": number }],
                                       "sourceRef?": string },
                 { "type": "timeline", "phases": [{ "label": string, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD",
                                                    "items": string[] }], "sourceRef?": string },
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
}  // 硬性规则：slide 0 必须是 cover 且 index 从 0 递增；含数字（含日期/百分比/等级标签）的页面必须有 citations 或给含数字的 block 加 sourceRef；禁止 L4；kind=model_inference 必须 tier=low`,
  validate(input) {
    const issues: string[] = [];
    const root = checkObject(input, issues, "$");
    const meta = checkObject(root.meta, issues, "$.meta");
    if (meta.tenantId !== undefined) {
      issues.push("$.meta 不得出现租户字段（本系统按令牌解析租户，报告里不写）");
    }
    const brand = checkObject(meta.brand, issues, "$.meta.brand");
    const brandId = checkString(brand.id, issues, "$.meta.brand.id");
    const brandName = checkString(brand.name, issues, "$.meta.brand.name");
    const metaWindow = checkObject(meta.window, issues, "$.meta.window");
    const windowFrom = checkString(metaWindow.from, issues, "$.meta.window.from");
    const windowTo = checkString(metaWindow.to, issues, "$.meta.window.to");

    const slidesRaw = checkArray(root.slides, issues, "$.slides", 1);
    const slides: SlideSpec[] = slidesRaw.map((s, i) => validateSlide(s, issues, `$.slides[${i}]`));

    const sd = checkObject(root.sourceDeclaration, issues, "$.sourceDeclaration");
    const sources = checkArray(sd.sources, issues, "$.sourceDeclaration.sources", 1).map((s, i) => {
      const o = checkObject(s, issues, `$.sourceDeclaration.sources[${i}]`);
      if (o.sourceId !== undefined) {
        issues.push(`$.sourceDeclaration.sources[${i}] 字段名是 key，不是 sourceId`);
      }
      return {
        key: checkString(o.key, issues, `$.sourceDeclaration.sources[${i}].key`),
        displayName: checkString(o.displayName, issues, `$.sourceDeclaration.sources[${i}].displayName`),
        grade: checkEnum(o.grade, GRADES, issues, `$.sourceDeclaration.sources[${i}].grade`, "L3"),
        asOf: typeof o.asOf === "string" ? o.asOf : new Date().toISOString(),
        coverage: typeof o.coverage === "string" ? o.coverage : "",
      };
    });
    const exclusions = checkArray(sd.exclusions ?? [], issues, "$.sourceDeclaration.exclusions").map((e, i) => {
      const o = checkObject(e, issues, `$.sourceDeclaration.exclusions[${i}]`);
      return { key: checkString(o.key, issues, `$.sourceDeclaration.exclusions[${i}].key`), reason: checkString(o.reason, issues, `$.sourceDeclaration.exclusions[${i}].reason`) };
    });
    throwIfAny(issues);
    return {
      meta: {
        dslVersion: "1.0",
        title: checkString(meta.title, issues, "$.meta.title"),
        brand: { id: brandId, name: brandName },
        window: { from: windowFrom, to: windowTo },
        generatedAt: typeof meta.generatedAt === "string" ? meta.generatedAt : new Date().toISOString(),
        ...(isObj(meta.degraded) ? { degraded: meta.degraded as ReportDsl["meta"]["degraded"] } : {}),
      },
      sourceDeclaration: { grade: checkEnum(sd.grade, GRADES, issues, "$.sourceDeclaration.grade", "L3"), sources, exclusions },
      slides,
    };
  },
  mock: () => ({
    meta: { dslVersion: "1.0", title: "占位报告", brand: { id: "brand_A", name: "品牌A" }, window: { from: "", to: "" }, generatedAt: new Date().toISOString() },
    sourceDeclaration: { grade: "L3", sources: [{ key: "mock", displayName: "mock", grade: "L3", asOf: new Date().toISOString(), coverage: "" }], exclusions: [] },
    slides: [],
  }),
};

/* ── 7. ReportPagePatchSchema（P1 按页补丁回喂） ───────────
 *
 * 为什么要有它：整份回喂（`ReportDslSchema`）的代价是 **输出 4 万 token / 10–20 分钟**，
 * 而且重写有副作用——真机 job_0mv9k0wvg8vvpwmqd9y 里模型为了修 slides[9] 的 matrix，
 * 把整份重写了一遍，同一块依旧漏 `sourceRef`，别的页面还可能被改坏。
 *
 * 补丁模式只让模型输出**出问题的那几页**（通常是 1–2 页），其余页面原样保留：
 *   · 输出量从 40k 降到 1–2k token；
 *   · 没被点名的页**物理上不可能被改坏**；
 *   · 合并时按 `index` 对位替换，页序与页数不变。
 *
 * ⚠️ 两处硬约束：
 *   ① 页结构校验必须**复用** `validateSlide`（与整份 schema 共用一份规则，不许各写一套）；
 *   ② `blocks` 是**整页替换**而非增量合并——增量语义会让模型只输出"改动的块"，
 *      然后丢掉原来的图表，这不是修复而是删内容。
 */
export interface ReportPagePatch {
  slides: SlideSpec[];
}

export const ReportPagePatchSchema: SchemaDef<ReportPagePatch> = {
  name: "ReportPagePatchSchema",
  skeleton: `{
  "slides": [{ "index": number,                     // 必须与「需要重写的页」清单中的 index 完全一致
               "pageRole": "cover|toc|section|content|data|appendix|closing",   // 保持原值
               "title": string,                     // 保持原值
               "layoutId": string,                  // 保持原值
               "blocks": [                          // **整页完整列表**：没问题的块要原样带上，不是只写改动
                 { "type": "text",     "style": "h2|h3|body|caption", "content": string, "sourceRef?": string },
                 { "type": "bullets",  "items": string[], "sourceRef?": string },
                 { "type": "kpi",      "items": [{ "label": string, "value": string, "unit?": string,
                                                   "confidence?": number, "tier?": "high|medium|low",
                                                   "sourceRef?": string }], "sourceRef?": string },
                 { "type": "table",    "columns": string[], "rows": string[][], "caption?": string, "sourceRef?": string },
                 { "type": "chart",    "chartType": "bar|line|pie|scatter|funnel",
                                       "series": [{ "name": string, "points": [{ "x": string, "y": number }] }],
                                       "axis?": { "xLabel?": string, "yLabel?": string }, "sourceRef?": string },
                 { "type": "matrix",   "xLabel": string, "yLabel": string,
                                       "cells": [{ "x": number, "y": number, "label": string, "size?": number }],
                                       "sourceRef?": string },
                 { "type": "timeline", "phases": [{ "label": string, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD",
                                                    "items": string[] }], "sourceRef?": string },
                 { "type": "callout",  "tone": "info|warn|risk", "text": string, "sourceRef?": string },
                 { "type": "quote",    "text": string, "attribution?": string, "sourceRef?": string },
                 { "type": "image",    "ref": string, "caption?": string, "sourceRef?": string }
               ],
               "citations": [{ "claim": string,
                               "kind": "data_source|kb_chunk|platform_entry|model_inference",
                               "ref": { "sourceKey?": string, "chunkId?": string, "entryId?": string },
                               "grade": "L2|L3", "confidence": number,
                               "tier": "high|medium|low", "verifiedBy": "auto|human" }],
               "notes?": string }]
}  // 只返回被点名的页；每页 blocks 为完整列表；含数字的块必须给 sourceRef`,
  validate(input) {
    const issues: string[] = [];
    const root = checkObject(input, issues, "$");
    // 空补丁视为失败：没有任何页被重写却消耗了一轮，不该被当成"修好了"
    const raw = checkArray(root.slides, issues, "$.slides", 1);
    const slides = raw.map((s, i) => validateSlide(s, issues, `$.slides[${i}]`));
    throwIfAny(issues);
    return { slides };
  },
  mock: () => ({
    slides: [
      {
        index: 0,
        pageRole: "content",
        title: "占位页",
        layoutId: "content/default",
        blocks: [{ type: "text", style: "body", content: "占位" }],
        citations: [],
      },
    ],
  }),
};

export const ALL_SCHEMAS = [
  BriefSchema,
  CompetitorIntelSchema,
  CreatorCandidatesSchema,
  PlaybookSchema,
  BudgetSchema,
  ReportDslSchema,
  ReportPagePatchSchema,
] as const;

export { SchemaError };

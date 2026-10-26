/**
 * 报告 DSL（对应 LLD §4.4）
 *
 * DSL 是「内容」的唯一表达；排版决策（LayoutPlan）与元素指令（SlideSpec）在 M11 内部完成。
 * 这里同时承载**渲染层不变量**的校验实现——它是产品质量的最后一道保险。
 *
 * P0-2 起，校验分两级：
 *   - 结构不变量（本文件原有的 ①~⑤）：无需外部信息即可判定，永远生效；
 *   - 来源合法性（R1~R9）：需要一份「本次真实可用的数据源目录」(SourceCatalog)。
 *     目录由 governance 组装（台账源 ∪ 本地 KB 语料源 ∪ 内部数据仓），
 *     以纯数据形式传入——render 包只允许依赖 contracts/config，不能在渲染期查库。
 */

import type { ConfidenceTier } from "./kb.ts";
import type { TimeWindow } from "./job.ts";

export type ComplianceGrade = "L1" | "L2" | "L3" | "L4";

export interface DslIssue {
  level: "error" | "warn";
  path: string;
  message: string;
  /** 可自动修复的问题给出修复动作 */
  fix?: string;
  /**
   * true = 可由 autoRepair 机械修复（顺手记 degraded）；
   * false / 缺省 = 硬拒绝，必须回到上游改。
   *
   * 这条字段是「收紧校验」与「不让任务直接失败」之间的缓冲带：
   * 未登记来源走**降级修复**（改标 model_inference/low），而不是拒绝渲染——
   * 否则收紧校验就把「报告不够细致」换成了「报告根本没有」。
   */
  repairable?: boolean;
}

export type Block =
  | { type: "text"; style: "h2" | "h3" | "body" | "caption"; content: string; sourceRef?: string }
  | { type: "bullets"; items: string[]; sourceRef?: string }
  | {
      type: "kpi";
      items: { label: string; value: string; unit?: string; confidence?: number; tier?: ConfidenceTier; sourceRef?: string }[];
      /** 整块级别的来源（与逐条 item.sourceRef 并存：块级用于「本页 KPI 同源自某阶段」的常见情形） */
      sourceRef?: string;
    }
  | { type: "table"; columns: string[]; rows: string[][]; caption?: string; sourceRef?: string }
  | {
      type: "chart";
      chartType: "bar" | "line" | "pie" | "scatter" | "funnel";
      series: { name: string; points: { x: string; y: number }[] }[];
      axis?: { xLabel?: string; yLabel?: string };
      sourceRef?: string;
    }
  | { type: "image"; ref: string; caption?: string; sourceRef?: string }
  | { type: "timeline"; phases: { label: string; from: string; to: string; items: string[] }[]; sourceRef?: string }
  | { type: "quote"; text: string; attribution?: string; sourceRef?: string }
  | { type: "callout"; tone: "info" | "warn" | "risk"; text: string; sourceRef?: string }
  | {
      type: "matrix";
      xLabel: string;
      yLabel: string;
      cells: { x: number; y: number; label: string; size?: number }[];
      /**
       * 矩阵单元渲染的是**数字坐标**（x/y），因此和 chart/table 一样需要能声明来源 ——
       * 否则 R6（无来源数字断言）会把整页判为错误，而作者没有任何合规的补救手段，
       * 只能删掉矩阵。此前只有 matrix 缺这个字段，属于契约缺口而非设计取舍。
       */
      sourceRef?: string;
    };

/** 全量块型（防漂移测试与骨架共用同一份清单） */
export const BLOCK_TYPES = [
  "text",
  "bullets",
  "kpi",
  "table",
  "chart",
  "image",
  "timeline",
  "quote",
  "callout",
  "matrix",
] as const satisfies readonly Block["type"][];

/**
 * 采集条目证据（P0 溯源）。
 *
 * 为什么要有这一层：平台采集的**逐条**信息（URL / 作者 / 发布时间 / 指标 / 采集时点）
 * 在 LLM 总结成 `citations` 的那一刻就丢了 —— 报告只能说到「小红书 · mc_xhs」这一级，
 * 至于是哪条帖子支撑的结论，链路上没有任何地方保留。
 *
 * 现在的分工是刻意的：
 *   · `entryId` 由**工具登记**（platform_digest 落盘到 intel_evidence 产物），不是模型写的；
 *   · 模型只被允许引用 `entryId` + 一段摘录（见 IntelOutput.evidences）；
 *   · URL / 平台 / 时间由渲染层拿 entryId 反查本表拼接 —— **模型从不生成 URL**，
 *     所以"编一个看起来很像的链接"这条路在结构上就不通。
 */
export interface EvidenceEntry {
  /** `pf_<平台码>_<原始内容 id>`，全局唯一且可反查 */
  entryId: string;
  /** 采集码：xhs / dy / ks / bili / wb / tieba / zhihu */
  platform: string;
  platformName: string;
  /** 产出该条目的算子：search / content_detail / comments / creator */
  op: string;
  kind: "content" | "comment";
  title: string;
  /** 正文摘录（截断，仅用于报告内展示与人工核对） */
  excerpt: string;
  author: string;
  url: string;
  /** 内容发布时间；取不到为空串（渲染时显示「未知」） */
  publishedAt: string;
  metrics: Record<string, number>;
  /** 采集时点（ISO），即条目级 asOf */
  collectedAt: string;
  /**
   * 平台内账号标识的**哈希**（内容行与主页资料行共有）。
   *
   * 只做内存关联用：把主页资料行拼到同一作者的内容行上（见
   * `apps/collector/src/server.ts` 的 `/query`）。**不落报告** —— 它是脱敏哈希，
   * 对读者没有可操作价值。
   */
  authorId?: string;
  /**
   * 该账号在平台侧的**原始 UID**（抖音 `user_id`、小红书 `user_id`、B站 `mid`…）。
   *
   * 与 `authorId` 的区别很重要：`authorId` 是归一化时算出的哈希（喂回采集必失败），
   * `uid` 是平台自己认的标识（能直接拿去平台站内检索/打开主页）。
   * 报告里的人选标识列用它，而不是内部哈希。
   */
  uid?: string;
}

export interface ReportCitation {
  /** 报告里出现的原始数字/结论 */
  claim: string;
  /**
   * data_source / kb_chunk / platform_entry 都算「可溯源」，model_inference 不算。
   * platform_entry 是条目级（比来源级更细）：指向某一条真实采集到的平台内容。
   */
  kind: "data_source" | "kb_chunk" | "platform_entry" | "model_inference";
  ref: {
    sourceKey?: string;
    chunkId?: string;
    runId?: string;
    fieldPath?: string;
    /** kind=platform_entry 时必填：证据条目 id（见 EvidenceEntry.entryId） */
    entryId?: string;
  };
  grade?: ComplianceGrade;
  confidence: number;
  tier: ConfidenceTier;
  verifiedBy: "auto" | "human";
}

export type PageRole = "cover" | "toc" | "section" | "content" | "data" | "appendix" | "closing";

/** 全量页面角色（防漂移测试与骨架共用同一份清单） */
export const PAGE_ROLES = ["cover", "toc", "section", "content", "data", "appendix", "closing"] as const satisfies readonly PageRole[];

export interface SlideSpec {
  index: number;
  pageRole: PageRole;
  title: string;
  /** KB-4 中的布局 id */
  layoutId: string;
  blocks: Block[];
  citations: ReportCitation[];
  notes?: string;
}

export interface SourceDeclaration {
  grade: ComplianceGrade;
  sources: { key: string; displayName: string; grade: ComplianceGrade; asOf: string; coverage: string }[];
  /** 明确列出「没用什么、为什么」 */
  exclusions: { key: string; reason: string }[];
}

export interface ReportDsl {
  meta: {
    dslVersion: "1.0";
    title: string;
    brand: { id: string; name: string };
    window: TimeWindow;
    generatedAt: string;
    degraded?: { reason: string; missingSections: string[] };
  };
  sourceDeclaration: SourceDeclaration;
  slides: SlideSpec[];
}

/* ── 来源目录（P0-2） ───────────────────────────────────── */

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
  /** 真实可用的数据源（外部适配器 + 本地 KB + 内部数据仓）——只有这些能进 sourceDeclaration */
  entries: SourceCatalogEntry[];
  /** 逻辑来源：报告内部产物与工具产出，只能出现在 block.sourceRef，不能进 sourceDeclaration */
  logicalRefs: string[];
  /** 已知 KB chunkId，用于 kb_chunk 引用的存在性校验 */
  chunkIds?: string[];
  /**
   * 本次任务真实登记到的平台采集条目，用于 platform_entry 引用的存在性校验（R13）。
   *
   * 缺省 `undefined` = 不校验（保持既有调用方零行为变化）；
   * 显式给空数组 = "本次任务没有任何平台证据"，此时任何条目级引用都会被判非法 ——
   * 这个区别很重要：前者是"我不知道"，后者是"我知道没有"。
   */
  evidenceEntries?: EvidenceEntry[];
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
  "phase:brief",
  "phase:intake",
  "phase:intel",
  "phase:creator",
  "phase:playbook",
  "phase:budget",
  "meta:sourceDeclaration",
  "meta:disclaimer",
  "degrade:synthesis",
  "tool:pricing",
  "tool:scenario_simulate",
  "tool:calendar_plan",
  "tool:render_outline",
] as const;

/**
 * 别名归一小表：只处理**观测到的真实写法**，不猜。
 * 旧报告里的 `brief_input` / `intel_insights` / `budget_risks` 等自由写法在这里收敛，
 * 使「收紧校验」不等于「历史产物全部非法」。
 */
export const REF_ALIASES: Record<string, string> = {
  brief: "phase:brief",
  brief_input: "phase:brief",
  intake: "phase:intake",
  intel: "phase:intel",
  intel_insights: "phase:intel",
  creator: "phase:creator",
  creator_candidates: "phase:creator",
  playbook: "phase:playbook",
  playbook_phases: "phase:playbook",
  playbook_rationale: "phase:playbook",
  budget: "phase:budget",
  budget_scenarios: "phase:budget",
  budget_risks: "phase:budget",
  budget_disclaimer: "phase:budget",
  sourceDeclaration: "meta:sourceDeclaration",
  source_declaration: "meta:sourceDeclaration",
  disclaimer: "meta:disclaimer",
  synthesis: "degrade:synthesis",
  degraded: "degrade:synthesis",
  pricing: "tool:pricing",
  pricing_query: "tool:pricing",
  scenario_simulate: "tool:scenario_simulate",
  calendar_plan: "tool:calendar_plan",
  render_outline: "tool:render_outline",
};

/** 把块级 sourceRef 归一化到命名空间写法；未知写法原样返回 */
export function normalizeRef(raw: string): string {
  const s = raw.trim();
  return REF_ALIASES[s] ?? s;
}

/* ── 校验实现 ───────────────────────────────────────────── */

const NUMBER_RE = /[-+]?\d[\d,]*\.?\d*\s*(%|万|亿|元|次|人|条|个|CPM|CPC|CPE|ROI|GMV)?/;

/**
 * 从 block 里抽出「带数字的断言」，用于引用完整性检查。
 *
 * ⚠️ 每新增一种块型都必须在这里补 case：否则「画出 12 个数字的柱状图却不写 citation」
 * 会直接漏检——这不是理论风险，P0-1 放开 chart/matrix 时就会踩到。
 */
export function numericClaims(block: Block): string[] {
  const claims: string[] = [];
  const push = (s: string | undefined) => {
    if (s && NUMBER_RE.test(s)) claims.push(s);
  };
  switch (block.type) {
    case "kpi":
      for (const item of block.items) push(`${item.label}:${item.value}${item.unit ?? ""}`);
      break;
    case "bullets":
      block.items.forEach(push);
      break;
    case "text":
      push(block.content);
      break;
    case "table":
      for (const row of block.rows) row.forEach(push);
      push(block.caption); // 表注也常含数字与口径
      break;
    case "chart":
      for (const s of block.series) for (const p of s.points) push(`${s.name} ${p.x}:${p.y}`);
      break;
    case "matrix":
      for (const c of block.cells) push(`${c.label}(${c.x}, ${c.y})`);
      break;
    case "image":
      push(block.caption);
      break;
    case "quote":
      push(block.text);
      break;
    case "callout":
      push(block.text);
      break;
    case "timeline":
      for (const p of block.phases) p.items.forEach(push);
      break;
    default:
      break;
  }
  return claims;
}

/** 只对 data_source / kb_chunk 计入「可溯源」——模型推断不算引用依据 */
export const isTraceableCitation = (c: ReportCitation): boolean => c.kind !== "model_inference";

export const traceableRatio = (dsl: ReportDsl): number => {
  const all = dsl.slides.flatMap((s) => s.citations);
  if (all.length === 0) return 0;
  return all.filter(isTraceableCitation).length / all.length;
};

const refOf = (b: Block): string | undefined => ("sourceRef" in b ? (b as { sourceRef?: string }).sourceRef : undefined);

/**
 * 逻辑命名空间（`phase:*` / `meta:*` / `tool:*` / `degrade:*`）是**块级 sourceRef** 的写法，
 * 不是数据源。模型被提示词同时教了两套写法，实测会把前者搬进 `citations`。
 *
 * ⚠️ 这个判定**必须只有一处**：`validateReportDsl` 的 R6 与 `autoRepair` 若各写一遍且不一致，
 * 就会出现「校验时算有效引用 → 修复时被删掉 → 修复后再校验变成硬失败」的死结（真机事故
 * job_0mv5ydf69a7aio1uhfd：报告整份丢失，且该错误既进不了回喂清单、也无法被机械修复）。
 */
const MISPLACED_LOGICAL_REF_RE = /^(meta|phase|tool|degrade):/;

/**
 * 逻辑引用的**裸写**形式（`pricing` / `budget` / `intel` …）与带前缀的写法等价。
 *
 * `REF_ALIASES` 的存在意义就是"把观测到的自由写法收敛到命名空间"，但这个判定此前
 * 只对**带前缀**的字符串做正则匹配，别名表根本没参与 —— 于是模型写 `tool:pricing`
 * 会被正确"降落"到块级 sourceRef，写裸的 `pricing` 却掉进"引用了未声明的来源"降级路径。
 * 同一个东西两种命运，只取决于模型有没有敲那个前缀（真机 job_0mv86by83ilvbnn0h1a 的
 * slides[7] 正是裸写）。
 *
 * ⚠️ 只有**别名表能归一**的写法才参与判定：不认识的自造 key（如 `mc_unknown` 这类真来源
 * 写错了名）必须继续走降级 —— 那不是逻辑引用，是编造。
 */
const isBareLogicalRef = (c: ReportCitation): boolean =>
  c.kind === "data_source" &&
  typeof c.ref?.sourceKey === "string" &&
  REF_ALIASES[c.ref.sourceKey.trim()] !== undefined;

const isMisplacedLogicalRef = (c: ReportCitation): boolean =>
  c.kind === "data_source" &&
  typeof c.ref?.sourceKey === "string" &&
  (MISPLACED_LOGICAL_REF_RE.test(c.ref.sourceKey) || isBareLogicalRef(c));

/**
 * 「缺失声明」型引用：claim 在说"这里没有数据"，而不是"数据来自某处"。
 *
 * 模型没有专门的地方表达"未采集"，会把这类声明塞进 `citations`（真机 job_0mv86by83ilvbnn0h1a
 * 的 slides[7]：`{"sourceKey":"pricing","claim":"所有候选人报价未采集"}`）—— 结果被当成
 * "引用了未声明的来源"降级成 `model_inference/low`，报告里凭空多出一条
 * 「模型推断：所有候选人报价未采集」。**缺失不是推断**。
 *
 * 判据取 **claim 的语义**而不是 key 的形态：同一个 key 配上真实断言（"报价区间 1–3 万"）
 * 仍按正常的未声明来源降级处理 —— 那时它确实是在编造，必须标脏。
 */
const ABSENCE_CLAIM_RE = /(未采集|未获取|未能获取|无法获取|无样本|暂无样本|暂无数据|无公开数据|数据缺失)/;
const isAbsenceClaimCitation = (c: ReportCitation): boolean =>
  c.kind === "data_source" && ABSENCE_CLAIM_RE.test(c.claim);

export interface ReportValidationOptions {
  /** 本次真实可用的数据源目录；缺省时跳过 R1/R2/R4 的来源存在性校验 */
  catalog?: SourceCatalog;
  /** 可溯源引用占比下限（低于则 warn，不阻塞渲染） */
  minTraceableRatio?: number;
  /**
   * 本轮 Brief 是否指定了自有品牌（`Brief.ownBrandId`）。
   *
   * `false` → 启用 **R14**：报告渲染文本里不得出现「我方 / 本品 / 本方 / 品牌自诊」。
   * `true` / 缺省 → 跳过 R14。**缺省不等于 false**：渲染期单独调 `compile()` 的调用方
   * （测试、回放工具）不该因为没传这个字段就被凭空收紧。
   */
  hasOwnBrand?: boolean;
}

/* ── R14：未指定自有品牌时的「我方口径」泄漏 ───────────────── */

/**
 * 违禁词：**本轮没指定自有品牌**（`Brief.ownBrandId` 缺省）时，这些字样在报告里
 * 没有任何合法形态 —— 那时「我方」不是个已知实体，写出来只能是编的。
 *
 * 为什么连"负面声明"也算：模型很爱写「由于未指定自有品牌，报告不含任何『我方』或『本品』
 * 的自诊数据」。它是在守规矩，但**声明本身就把这两个词写进了报告**，读者看到的是同一串字。
 * 正确写法是描述动作、不复述名词：「本轮未指定自有品牌，报告聚焦公开市场与竞品调研」。
 *
 * 为什么**不**纳入「我们」：它在报告里有两义（品牌自称 vs 顾问自称，如"我们建议…"），
 * 机械判定会误伤后者 —— 那一半只由提示词约束（`agent-pack/src/prompts.ts` 的 RG 段）。
 *
 * ⚠️ 这是词表的**可读形式**，**不参与匹配** —— 真正的判定/修复一律走 `scanLeaks()`
 * （中文没有词边界，裸正则会子串误伤，见 `LEAK_EXEMPT`）。改词表请改 `LEAK_DROP` / `LEAK_NEUTRALIZE`。
 */
export const OWN_BRAND_LEAK_RE = /我方|本品|本方|品牌自诊/;

/** 剔除泄漏句后整串为空时的兜底：无数字、无违禁词、不引入任何新断言 */
const OWN_BRAND_NEUTRAL_FILL = "本轮未指定自有品牌，本页只呈现公开市场与竞品信息。";
const OWN_BRAND_NEUTRAL_TITLE = "市场与竞品调研";
/** 标签类槽位（列名 / 轴标签 / KPI 标签）的兜底：标签是结构骨架，不能整块删掉 */
const OWN_BRAND_NEUTRAL_LABEL = "指标";

/**
 * **命中即删**的自我指涉词（按"最长优先"匹配，不是正则交替）。
 */
const LEAK_DROP = ["品牌自诊", "我方", "本方", "本品"] as const;

/**
 * **命中即整词换主语**的长词：形如"中性名词 + 自我指涉限定词"，去掉限定词即可。
 *
 * 「本品牌」必须走这条路，不能走删词：`本品` 是它的子串，删词会把两个**字**从词中间挖掉，
 * 留下「…挤压**牌**声量份额」这种残句（真机 job_0mv9k0wvg8vvpwmqd9y 的
 * slides[11].blocks[0].rows[3][0]）。要的是**换主语**（本品牌 → 品牌），不是**删断言**。
 *
 * 表里两侧都不含数字，所以"纯替换"这条路径天然不碰任何数字（见 `LeakFix.cosmetic`）。
 */
const LEAK_NEUTRALIZE: ReadonlyArray<readonly [string, string]> = [["本品牌", "品牌"]];

/**
 * **中性词豁免表**：形如违禁词、实为普通名词的写法 —— 不检测、也不修复。
 *
 * 为什么必须有它：违禁词都是两个汉字，而中文没有词边界可用，子串匹配必然误伤。
 * 真机 job_0mv9k0wvg8vvpwmqd9y 一天之内踩了两次，都是同一类：
 *   · 「本品牌」含「本品」→ 被从词中间挖掉两个字，产出「挤压**牌**声量份额」；
 *   · 「本方案」含「本方」→ 整句「…**这也是本方案把预算重心压在中段的依据。**」被删掉
 *     （而且还按数据级记了账，把任务标脏）—— 它说的是"本报告提出的方案"，跟"我方"毫无关系。
 *
 * 新增误伤词就加在这张表里；**不要**改成"把违禁词表写松"，那会让真正的越界写法溜过去。
 */
const LEAK_EXEMPT = ["本方案", "本方略", "本方式", "本方向", "本品类", "本品线"] as const;

/** 一次命中：位置 + 长度 + 原文 + 替换词（无 `to` = 删除） */
interface LeakSpan {
  at: number;
  len: number;
  word: string;
  to?: string;
}

const NEUTRALIZE_FROM = LEAK_NEUTRALIZE.map(([from]) => from);

/**
 * **R14 的唯一扫描器** —— 判定与修复共用，避免两套实现分叉
 * （分叉的后果是把违禁词留在报告里 → 修复后二次校验仍报 error → 整份拒绝渲染）。
 *
 * 从左到右走一遍，每个位置**先看豁免表、再看替换表、最后看删词表**，各取最长命中 ——
 * 这就是中文版的"词边界"，也是"本品牌"不会被拆成「本品」+「牌」的原因。
 */
function scanLeaks(s: string): LeakSpan[] {
  const spans: LeakSpan[] = [];
  const longest = (words: readonly string[]): string | undefined => {
    let best: string | undefined;
    for (const w of words) if (s.startsWith(w, i) && (best === undefined || w.length > best.length)) best = w;
    return best;
  };
  let i = 0;
  while (i < s.length) {
    /* 豁免词只在此处被"跨过"：它内部的违禁子串永远不算命中 */
    const exempt = longest(LEAK_EXEMPT);
    if (exempt) {
      i += exempt.length;
      continue;
    }
    const neu = longest(NEUTRALIZE_FROM);
    if (neu) {
      spans.push({ at: i, len: neu.length, word: neu, to: LEAK_NEUTRALIZE.find(([f]) => f === neu)![1] });
      i += neu.length;
      continue;
    }
    const drop = longest(LEAK_DROP);
    if (drop) {
      spans.push({ at: i, len: drop.length, word: drop });
      i += drop.length;
      continue;
    }
    i += 1;
  }
  return spans;
}

/** 按扫描结果改写：`neutralize` 只做替换，`drop` 只做删除（未命中该模式的 span 原样保留） */
function rewriteByLeaks(s: string, spans: LeakSpan[], mode: "neutralize" | "drop"): string {
  let out = "";
  let cur = 0;
  for (const sp of spans) {
    const wanted = mode === "neutralize" ? sp.to !== undefined : sp.to === undefined;
    if (!wanted) continue;
    out += s.slice(cur, sp.at) + (mode === "neutralize" ? sp.to! : "");
    cur = sp.at + sp.len;
  }
  return out + s.slice(cur);
}

/** 是否需要处置（扫描与修复共用同一遍判定） */
const hasLeak = (s: string): boolean => scanLeaks(s).length > 0;

/**
 * 判定一段文本里有没有自我指涉命中 —— 扫描与修复的**唯一入口**，供测试与外部工具使用。
 *
 * ⚠️ 别拿 `OWN_BRAND_LEAK_RE` 直接 `.test()` 文本（它是词表的可读形式，会子串误伤）；
 * 也别把它当成"违规判定"用在整页 JSON 上 —— 中性词（「本方案」）本来就应该原样出现。
 */
export const hasOwnBrandLeak = hasLeak;

/** 把长词换成中性主语；`hit` 表示确实替换过 */
function neutralizeLeakTokens(s: string): { value: string; hit: boolean } {
  const value = rewriteByLeaks(s, scanLeaks(s), "neutralize");
  return { value, hit: value !== s };
}

/** 单个槽位的处置结果 */
type LeakFix =
  | { kind: "none" }
  /**
   * `removed` = 被摘掉的原文片段，用于判定该修复是否动了数字（见 autoRepair 的分级）。
   * `cosmetic` = 本次**只做了中性化替换**（本品牌 → 品牌）：没删任何断言、也没引入新事实，
   *   按分级原则归观感级。**只标"纯替换"这一种情况**，绝不用 `removed` 是否为空去反推 ——
   *   「我方声量」按词摘掉「我方」同样不含数字，但那把断言变成了悬空的，必须保守标脏。
   */
  | { kind: "text"; value: string; removed: string; cosmetic?: true }
  | { kind: "empty"; removed: string };

/** 只做删除型命中的句子判定（替换型命中不算——那类句子中性化之后就干净了） */
const hasDropLeak = (s: string): boolean => scanLeaks(s).some((sp) => sp.to === undefined);

/** 删掉含违禁词的**句子**；整串都被删光时返回 null */
function dropLeakSentences(s: string): { value: string | null; removed: string; neutralizedOnly: boolean } {
  const n = neutralizeLeakTokens(s);
  const parts = n.value.split(/(?<=[。；！？!?;\n])/);
  const dropped = parts.filter(hasDropLeak);
  const kept = parts.filter((p) => !hasDropLeak(p));
  const joined = kept.join("").trim();
  const value = joined === "" ? null : joined;
  if (dropped.length === 0) return { value, removed: "", neutralizedOnly: n.hit };
  return { value, removed: dropped.join("").trim(), neutralizedOnly: false };
}

/** 只摘掉违禁**词**（用于列名 / 轴标签 / KPI 标签这类短标签）；摘空返回 null */
function dropLeakTokens(s: string): { value: string | null; removed: string; neutralizedOnly: boolean } {
  const n = neutralizeLeakTokens(s);
  /* 长词已经在上面被换掉了，这里剩下的才是真正该摘掉的独立违禁词 */
  const spans = scanLeaks(n.value);
  const droppedWords = spans.filter((sp) => sp.to === undefined).map((sp) => sp.word);
  const out = rewriteByLeaks(n.value, spans, "drop")
    /* 摘掉词以后留下的空引号/空括号（「我方」→「」）要一并清掉，否则报告里会出现残缺标点 */
    .replace(/[「『"'（(]\s*[」』"'）)]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const value = out === "" ? null : out;
  if (value === null) return { value, removed: s, neutralizedOnly: false };
  const neutralizedOnly = n.hit && droppedWords.length === 0;
  return { value, removed: neutralizedOnly ? "" : droppedWords.join(""), neutralizedOnly };
}

const fixSentence = (s: string): LeakFix => {
  if (!hasLeak(s)) return { kind: "none" };
  const { value, removed, neutralizedOnly } = dropLeakSentences(s);
  if (value === null) return { kind: "empty", removed: s };
  return neutralizedOnly ? { kind: "text", value, removed, cosmetic: true } : { kind: "text", value, removed };
};

const fixLabel = (s: string): LeakFix => {
  if (!hasLeak(s)) return { kind: "none" };
  const { value, removed, neutralizedOnly } = dropLeakTokens(s);
  if (value === null) return { kind: "empty", removed: s };
  return neutralizedOnly ? { kind: "text", value, removed, cosmetic: true } : { kind: "text", value, removed };
};

export interface OwnBrandLeakHit {
  path: string;
  /** 原文（调用方负责截断） */
  text: string;
  /** 处置说明，直接拼进 autoRepair 的 action 文案 */
  action: string;
  /**
   * 该修复是否要按**数据级**记账（`true` → 进 `actions`，任务必须标 partial）。
   *
   * 判 false（观感级）只有两种情形，其余一律保守按 true：
   *   ① **纯中性化替换**（本品牌 → 品牌）：没删任何断言、也没引入新事实（`LeakFix.cosmetic`）；
   *   ② 句子级删除，且**被删掉的那几句不含数字**（删掉的是一句纯措辞，不承载任何事实）。
   * 标签替换 / 整块删除 / 整列删除一律按 true 保守处理（那类改动动了结构，宁可标脏）。
   */
  digits: boolean;
}

/**
 * **R14 的唯一实现**：扫描并（可选）剔除「未指定自有品牌却出现我方口径」的文本。
 *
 * 为什么扫描与修复必须共用这一个函数：R14 是 `repairable: true` 的 error，
 * `render.compile` 的流程是「autoRepair → 再校验一次 → 仍有 error 就抛错拒绝渲染」。
 * 只要扫描覆盖的槽位比修复覆盖的多**一个**，那个槽位上的违禁词就会在修复后继续报 error
 * → 报告整份丢失（与 `MISPLACED_LOGICAL_REF_RE` 注释里记的那次真机事故同一形态）。
 * 所以这里不做"扫描一份、修复另一份"，而是同一遍 walk（`apply: false` 时只收集不改写）。
 *
 * 槽位边界（**有意留下**的两处）：
 *   · `citations[].claim` 虽然会渲染进溯源附录，但**只改写、绝不删除** ——
 *     删引用会撞 R6（无来源数字断言），那是另一个不变量，不能在这个修复里顺手破坏；
 *   · `slide.notes` 不渲染，不参与。
 */
export function stripOwnBrandLeak(dsl: ReportDsl, opts: { apply?: boolean } = {}): { dsl: ReportDsl; hits: OwnBrandLeakHit[] } {
  const apply = opts.apply !== false;
  const hits: OwnBrandLeakHit[] = [];
  const record = (path: string, text: string, action: string, removed?: string, cosmetic = false): void => {
    hits.push({
      path,
      text: text.replace(/\s+/g, " ").slice(0, 60),
      action,
      /* 显式观感级优先；否则"没给出被摘片段"或"摘掉的片段含数字"都按数据级保守处理 */
      digits: cosmetic ? false : removed === undefined ? true : /\d/.test(removed),
    });
  };

  /**
   * 摊平一次**短标签级**修复（列名 / 表格单元格 / 轴标签 / KPI 标签）的分级。
   *
   * 只有纯中性化替换（本品牌 → 品牌）算观感级；其余（删词、摘空）维持原口径 ——
   * `record` 收不到 `removed` 就按数据级保守记账，与改动前完全一致。
   */
  const grade = (f: LeakFix): { removed?: string; cosmetic: boolean } =>
    f.kind === "text" && f.cosmetic ? { removed: f.removed, cosmetic: true } : { cosmetic: false };

  /* ── 元信息 ── */
  let meta = dsl.meta;
  const titleFix = fixSentence(dsl.meta.title);
  if (titleFix.kind !== "none") {
    const value = titleFix.kind === "text" ? titleFix.value : OWN_BRAND_NEUTRAL_TITLE;
    record("meta.title", dsl.meta.title, `报告标题改为「${value}」`, titleFix.removed);
    meta = { ...dsl.meta, title: value };
  }

  /* ── 来源声明里会被渲染的两处自由文本 ── */
  let sources = dsl.sourceDeclaration?.sources ?? [];
  sources = sources.map((s, i) => {
    const f = fixSentence(s.coverage ?? "");
    if (f.kind === "none") return s;
    const value = f.kind === "text" ? f.value : "—";
    record(`sourceDeclaration.sources[${i}].coverage`, s.coverage ?? "", `取数口径改写为「${value}」`, f.removed);
    return { ...s, coverage: value };
  });
  let exclusions = dsl.sourceDeclaration?.exclusions ?? [];
  exclusions = exclusions.map((e, i) => {
    const f = fixSentence(e.reason ?? "");
    if (f.kind === "none") return e;
    const value = f.kind === "text" ? f.value : "本轮未使用该来源";
    record(`sourceDeclaration.exclusions[${i}].reason`, e.reason ?? "", `排除理由改写为「${value}」`, f.removed);
    return { ...e, reason: value };
  });

  const slides = dsl.slides.map((slide) => {
    const p = `slides[${slide.index}]`;
    let title = slide.title;
    const tf = fixSentence(slide.title);
    if (tf.kind !== "none") {
      title = tf.kind === "text" ? tf.value : OWN_BRAND_NEUTRAL_TITLE;
      record(`${p}.title`, slide.title, `页标题改为「${title}」`, tf.removed);
    }

    /** 必填自由文本：删句；删空用中性文案补位（不删块，保住块型结构） */
    const fillText = (text: string, path: string, what: string): string => {
      const f = fixSentence(text);
      if (f.kind === "none") return text;
      const value = f.kind === "text" ? f.value : OWN_BRAND_NEUTRAL_FILL;
      record(path, text, `${what}改写为「${value.slice(0, 24)}…」`, f.removed);
      return value;
    };
    /**
     * 短标签的统一入口。`hit=false` 表示没动过（**必须保留原值，包括 undefined**：
     * 给原本没有的轴标题凭空补一个「指标」是另一种失真）；
     * `hit=true` 且 `value=undefined` 表示整个槽位该删（可选槽位）或该用中性词补位（必填槽位）。
     */
    const editLabel = (text: string | undefined, path: string, what: string, fallback?: string): { hit: boolean; value?: string } => {
      if (!text || !hasLeak(text)) return { hit: false };
      const f = fixLabel(text);
      const value = f.kind === "text" ? f.value : fallback;
      const g = grade(f);
      record(path, text, value === undefined ? `删除${what}` : `${what}改写为「${value}」`, g.removed, g.cosmetic);
      return { hit: true, value };
    };
    /** 短标签的通用改写：未命中 → 原值原样返回（含 undefined）；命中且摘空 → 用 fallback，没有 fallback 就删掉该槽位 */
    const relabel = (text: string | undefined, path: string, what: string, fallback?: string): string | undefined => {
      const r = editLabel(text, path, what, fallback);
      return r.hit ? r.value : text;
    };
    /** 必填短标签：摘空 → 用中性词补位（标签是结构骨架，不能为空、也不能整块删） */
    const requiredLabel = (text: string, path: string, what: string, fallback = OWN_BRAND_NEUTRAL_LABEL): string =>
      relabel(text, path, what, fallback) ?? fallback;

    const blocks: Block[] = [];
    for (const [bi, b] of slide.blocks.entries()) {
      const bp = `${p}.blocks[${bi}]`;

      if (b.type === "text") {
        blocks.push({ ...b, content: fillText(b.content, `${bp}.content`, "正文") });
        continue;
      }
      if (b.type === "callout") {
        blocks.push({ ...b, text: fillText(b.text, `${bp}.text`, "警示语") });
        continue;
      }
      if (b.type === "quote") {
        blocks.push({ ...b, text: fillText(b.text, `${bp}.text`, "引文"), attribution: relabel(b.attribution, `${bp}.attribution`, "出处") });
        continue;
      }
      if (b.type === "image") {
        const caption = relabel(b.caption, `${bp}.caption`, "图注");
        blocks.push(caption === undefined ? { ...b, caption: undefined } : { ...b, caption });
        continue;
      }
      if (b.type === "bullets") {
        const items = b.items.flatMap((it, i) => {
          const f = fixSentence(it);
          if (f.kind === "none") return [it];
          if (f.kind === "text") {
            record(`${bp}.items[${i}]`, it, "条目改写", f.removed);
            return [f.value];
          }
          record(`${bp}.items[${i}]`, it, "删除整条（整条都在讲自有品牌）", f.removed);
          return [];
        });
        if (items.length === 0) {
          record(bp, "", "整块删除（条目全被剔除）");
          continue;
        }
        blocks.push({ ...b, items });
        continue;
      }
      if (b.type === "kpi") {
        const items = b.items.flatMap((it, i) => {
          const labelF = fixLabel(it.label);
          const valueF = fixSentence(it.value);
          if (labelF.kind === "none" && valueF.kind === "none") return [it];
          if (labelF.kind === "empty" || valueF.kind === "empty") {
            record(`${bp}.items[${i}]`, `${it.label}:${it.value}`, "删除该 KPI（名称/取值整条都在讲自有品牌）");
            return [];
          }
          const label = labelF.kind === "text" ? labelF.value : it.label;
          const value = valueF.kind === "text" ? valueF.value : it.value;
          const unit = relabel(it.unit, `${bp}.items[${i}].unit`, "单位");
          const g = grade(labelF);
          record(`${bp}.items[${i}]`, `${it.label}:${it.value}`, `KPI 改写为「${label}:${value}」`, g.removed, g.cosmetic);
          return [{ ...it, label, value, unit }];
        });
        if (items.length === 0) {
          record(bp, "", "整块删除（KPI 全被剔除）");
          continue;
        }
        blocks.push({ ...b, items });
        continue;
      }
      if (b.type === "table") {
        const dropCols = new Set<number>();
        const columns = b.columns.flatMap((c, i) => {
          const f = fixLabel(c);
          if (f.kind === "none") return [c];
          if (f.kind === "text") {
            const g = grade(f);
            record(`${bp}.columns[${i}]`, c, `列名改写为「${f.value}」`, g.removed, g.cosmetic);
            return [f.value];
          }
          record(`${bp}.columns[${i}]`, c, "整列删除（列名与内容都在讲自有品牌）");
          dropCols.add(i);
          return [];
        });
        if (columns.length === 0) {
          record(bp, "", "整块删除（列全被剔除）");
          continue;
        }
        const rows = b.rows.map((row, ri) =>
          row.flatMap((cell, ci) => {
            if (dropCols.has(ci)) return [];
            const f = fixLabel(cell);
            if (f.kind === "none") return [cell];
            const value = f.kind === "text" ? f.value : "—";
            const g = grade(f);
            record(`${bp}.rows[${ri}][${ci}]`, cell, `单元格改写为「${value}」`, g.removed, g.cosmetic);
            return [value];
          }),
        );
        const caption = relabel(b.caption, `${bp}.caption`, "表注");
        blocks.push(caption === undefined ? { ...b, columns, rows, caption: undefined } : { ...b, columns, rows, caption });
        continue;
      }
      if (b.type === "timeline") {
        const phases = b.phases.map((ph, pi) => {
          const label = requiredLabel(ph.label, `${bp}.phases[${pi}].label`, "阶段名");
          const items = ph.items.flatMap((it, ii) => {
            const f = fixSentence(it);
            if (f.kind === "none") return [it];
            if (f.kind === "text") {
              record(`${bp}.phases[${pi}].items[${ii}]`, it, "条目改写", f.removed);
              return [f.value];
            }
            record(`${bp}.phases[${pi}].items[${ii}]`, it, "删除整条", f.removed);
            return [];
          });
          return { ...ph, label, items };
        });
        blocks.push({ ...b, phases });
        continue;
      }
      if (b.type === "chart") {
        const axis = b.axis
          ? {
              ...b.axis,
              /* ⚠️ 兜底用中性词，不能回落到原值 —— 那会把刚摘掉的违禁词又写回去 */
              xLabel: relabel(b.axis.xLabel, `${bp}.axis.xLabel`, "X 轴标题", OWN_BRAND_NEUTRAL_LABEL),
              yLabel: relabel(b.axis.yLabel, `${bp}.axis.yLabel`, "Y 轴标题", OWN_BRAND_NEUTRAL_LABEL),
            }
          : undefined;
        const series = b.series.map((s, si) => {
          const name = requiredLabel(s.name, `${bp}.series[${si}].name`, "系列名");
          const points = s.points.map((pt, pi2) => {
            const x = requiredLabel(pt.x, `${bp}.series[${si}].points[${pi2}].x`, "横轴取值", "—");
            return { ...pt, x };
          });
          return { ...s, name, points };
        });
        blocks.push(axis ? { ...b, series, axis } : { ...b, series });
        continue;
      }
      if (b.type === "matrix") {
        const cells = b.cells.map((c, ci) => {
          const label = requiredLabel(c.label, `${bp}.cells[${ci}].label`, "点位标签", "—");
          return { ...c, label };
        });
        blocks.push({
          ...b,
          xLabel: requiredLabel(b.xLabel, `${bp}.xLabel`, "X 轴标题"),
          yLabel: requiredLabel(b.yLabel, `${bp}.yLabel`, "Y 轴标题"),
          cells,
        });
        continue;
      }
      blocks.push(b);
    }

    const citations = slide.citations.map((c, ci) => {
      const f = fixSentence(c.claim);
      if (f.kind === "none") return c;
      const value = f.kind === "text" ? f.value : OWN_BRAND_NEUTRAL_FILL;
      record(`${p}.citations[${ci}].claim`, c.claim, `引用表述改写为「${value.slice(0, 24)}…」（只改写不删除：删引用会撞 R6）`, f.removed);
      return { ...c, claim: value };
    });

    /* 块全被剔除时补一个中性正文块：空页在渲染层没有意义，而 R14 的修法本身不该产出空页 */
    const finalBlocks: Block[] = blocks.length > 0 ? blocks : [{ type: "text", style: "body", content: OWN_BRAND_NEUTRAL_FILL }];
    if (blocks.length === 0 && slide.blocks.length > 0) record(`${p}.blocks`, "", "补一个中性正文块（块被剔空）");

    return { ...slide, title, blocks: finalBlocks, citations };
  });

  if (!apply) return { dsl, hits };
  return {
    dsl: { ...dsl, meta, sourceDeclaration: { ...dsl.sourceDeclaration, sources, exclusions }, slides },
    hits,
  };
}

/**
 * 渲染层不变量校验（LLD §4.4 表格 + P0-2 来源合法性）。
 *
 * 关于「每个数字必须有引用」的落地方式：
 *   逐字符比对 claim 文本在实践中不可行（生成文本与 citation 文案不可能字字相同）。
 *   因此本实现把该不变量具化为**可判定的规则**：
 *     R7 结构性页面（cover / closing / toc / section）豁免——它们承载的是用户输入与声明；
 *     R6 含数字断言的页面，必须要么整页至少有一条**可用** citation
 *         （可用 = 不是被误当来源的逻辑引用，见 isMisplacedLogicalRef），
 *         要么该页所有含数字的 block 都声明了**有效**的 `sourceRef`
 *         （有效 = 归一名后 ∈ logicalRefs，或 ∈ 已声明 sources）；
 *         两者皆无 → **error，不可修复，拒绝渲染**（这就是"不许有无来源数字"的执行点）；
 *     R8 任何 citation 的 grade === "L4" → error（闸门最后一道保险）；
 *     R9 KPI tier === "low" 的页面必须含 warn callout（可自动修复）；
 *     R10 sourceDeclaration 必须存在且非空。
 *
 * 来源合法性（需 catalog）：
 *     R1 声明的 key 不在 catalog → error / 可修复（移出声明并降级相关引用）
 *     R2 displayName 与 catalog 不一致 → warn / 可修复
 *     R3 kind=data_source 的 ref.sourceKey 不在已声明 sources → error / 可修复
 *     R4 kind=kb_chunk 的 ref.chunkId 不在 catalog.chunkIds → error / 可修复
 *     R5 kind=model_inference 却带 tier≠low → warn / 可修复
 *     R11 block.sourceRef 不在 logicalRefs ∪ 已声明 sources → warn / 可修复（别名归一）
 *     R13 kind=platform_entry 的 ref.entryId 不在 catalog.evidenceEntries → error / 可修复
 *         （降级优先级：条目级 → 来源级（保留 sourceKey）→ model_inference/low）
 *     R14 未指定自有品牌（`opts.hasOwnBrand === false`）时报告出现「我方 / 本品 / 本方 / 品牌自诊」
 *         → error / 可修复（剔除含违禁词的句子/条目/列；见 stripOwnBrandLeak）
 */
export function validateReportDsl(
  dsl: ReportDsl,
  opts: ReportValidationOptions = {},
): { ok: boolean; issues: DslIssue[] } {
  const issues: DslIssue[] = [];
  const catalogKeys = new Set((opts.catalog?.entries ?? []).map((e) => e.key));
  const catalogByName = new Map((opts.catalog?.entries ?? []).map((e) => [e.key, e.displayName]));
  // 逻辑来源清单以目录为准（governance 组装时带入）；目录缺省时退回内置全量清单
  const logicalRefs = new Set<string>(opts.catalog?.logicalRefs ?? [...LOGICAL_REFS]);

  if (!dsl.sourceDeclaration || dsl.sourceDeclaration.sources.length === 0) {
    issues.push({
      level: "error",
      path: "sourceDeclaration",
      message: "数据来源声明缺失或为空，报告首页无法展示合规声明",
    });
  }

  if (dsl.sourceDeclaration?.sources.some((s) => s.grade === "L4")) {
    issues.push({
      level: "error",
      path: "sourceDeclaration.sources",
      message: "包含 L4 数据源引用，闸门最后一道保险拒绝渲染",
    });
  }

  if (dsl.slides.length === 0) {
    issues.push({ level: "error", path: "slides", message: "报告无任何页面" });
  }

  const declaredKeys = new Set((dsl.sourceDeclaration?.sources ?? []).map((s) => s.key));

  /* R1 / R2：声明的来源必须真实存在，且名称与台账一致 */
  for (const s of dsl.sourceDeclaration?.sources ?? []) {
    if (!opts.catalog) break;
    if (!catalogKeys.has(s.key)) {
      issues.push({
        level: "error",
        path: `sourceDeclaration.sources[${s.key}]`,
        message: `声明了不存在的来源「${s.displayName}」（key=${s.key}），不在本次可用数据源目录内`,
        fix: "从来源声明中移除，并把指向它的引用降级为 model_inference/low",
        repairable: true,
      });
      continue;
    }
    const expected = catalogByName.get(s.key);
    if (expected && expected !== s.displayName) {
      issues.push({
        level: "warn",
        path: `sourceDeclaration.sources[${s.key}].displayName`,
        message: `来源名称与台账不一致：写了「${s.displayName}」，应为「${expected}」`,
        fix: "按目录改写 displayName",
        repairable: true,
      });
    }
  }

  dsl.slides.forEach((slide, i) => {
    const path = `slides[${i}]`;

    if (!slide.layoutId) {
      issues.push({ level: "warn", path, message: "缺少 layoutId", fix: "回退默认模板 content/default", repairable: true });
    }

    // R8 L4 引用一律拒绝（先于其它规则）
    const l4 = slide.citations.filter((c) => c.grade === "L4");
    if (l4.length > 0) {
      issues.push({ level: "error", path, message: `页面引用了 L4 数据源：${l4.map((c) => c.claim).join("、")}` });
    }

    slide.citations.forEach((c, j) => {
      const cPath = `${path}.citations[${j}]`;
      // R3 data_source 必须指向已声明的来源
      if (c.kind === "data_source") {
        const key = c.ref?.sourceKey;
        if (typeof key !== "string" || key.length === 0) {
          issues.push({
            level: "error",
            path: cPath,
            message: "kind=data_source 时 ref.sourceKey 必填",
            fix: "降级为 model_inference/low",
            repairable: true,
          });
        } else if (!declaredKeys.has(key)) {
          issues.push({
            level: "error",
            path: cPath,
            message: `引用指向未声明的来源「${key}」（claims: ${c.claim.slice(0, 24)}）`,
            fix: "该条引用降级为 model_inference/low，或把它补进来源声明",
            repairable: true,
          });
        }
      }
      // R4 kb_chunk 必须指向真实存在的 chunk
      if (c.kind === "kb_chunk") {
        const chunkId = c.ref?.chunkId;
        if (typeof chunkId !== "string" || chunkId.length === 0) {
          issues.push({
            level: "error",
            path: cPath,
            message: "kind=kb_chunk 时 ref.chunkId 必填",
            fix: "降级为 model_inference/low",
            repairable: true,
          });
        } else if (opts.catalog?.chunkIds && !opts.catalog.chunkIds.includes(chunkId)) {
          issues.push({
            level: "error",
            path: cPath,
            message: `引用指向不存在的知识片段「${chunkId}」`,
            fix: "降级为 model_inference/low",
            repairable: true,
          });
        }
      }
      // R5 模型推断必须标 low（“不许编造”在类型层的落点）
      if (c.kind === "model_inference" && c.tier !== "low") {
        issues.push({
          level: "warn",
          path: cPath,
          message: `kind=model_inference 必须 tier=low（当前 ${c.tier}）`,
          fix: "把 tier 改为 low",
          repairable: true,
        });
      }
      /**
       * R13 条目级平台引用必须指向**本次真实登记**的采集条目。
       *
       * 这是整个溯源设计的执行点：模型可以引用条目，但不能凭想象编一个 entryId。
       * catalog.evidenceEntries 缺省时跳过（调用方没提供证据集 = 无法判定，不冤杀）；
       * 给了空数组则一律判非法（本次确实没采到任何东西）。
       */
      if (c.kind === "platform_entry") {
        const entryId = c.ref?.entryId;
        if (typeof entryId !== "string" || entryId.length === 0) {
          issues.push({
            level: "error",
            path: cPath,
            message: "kind=platform_entry 时 ref.entryId 必填",
            fix: "降级为来源级引用（保留 sourceKey）或 model_inference/low",
            repairable: true,
          });
        } else if (opts.catalog?.evidenceEntries && !opts.catalog.evidenceEntries.some((e) => e.entryId === entryId)) {
          issues.push({
            level: "error",
            path: cPath,
            message: `条目级引用指向未登记的采集条目「${entryId}」（claims: ${c.claim.slice(0, 24)}）`,
            fix: "降级为来源级引用（保留 sourceKey）或 model_inference/low",
            repairable: true,
          });
        }
      }
    });

    /* R7 结构性页面豁免 */
    const structural = slide.pageRole === "cover" || slide.pageRole === "closing" || slide.pageRole === "toc" || slide.pageRole === "section";
    if (structural) return;

    /* R11 块级 sourceRef 必须是已知逻辑来源或已声明来源 */
    slide.blocks.forEach((b, j) => {
      const ref = refOf(b);
      if (!ref) return;
      const normalized = normalizeRef(ref);
      if (!logicalRefs.has(normalized) && !declaredKeys.has(normalized) && !declaredKeys.has(ref)) {
        issues.push({
          level: "warn",
          path: `${path}.blocks[${j}].sourceRef`,
          message: `sourceRef「${ref}」不是已知逻辑来源，也未在来源声明中登记`,
          fix: "归一化为 phase:* / meta:* / tool:* 命名空间写法",
          repairable: true,
        });
      }
    });

    /* R6 无来源数字检查
     * 「有引用」的判定基准与 autoRepair 严格一致：**被误当来源的逻辑引用不算引用**
     * （见 isMisplacedLogicalRef）。两处若不一致，同一份 DSL 会在「修复前算过、修复后不过」，
     * 而这条 error 又拿不到可回挂的来源时不可修复 → render.compile 抛错、报告整份丢失
     * （真机事故 job_0mv5ydf69a7aio1uhfd）。
     *
     * 可修复性**取决于该页有没有可回挂的逻辑引用**，见下面 relocatable 的注释。 */
    const numericBlocks = slide.blocks.filter((b) => numericClaims(b).length > 0);
    const refIsValid = (ref: string): boolean => {
      const normalized = normalizeRef(ref);
      return logicalRefs.has(normalized) || declaredKeys.has(normalized) || declaredKeys.has(ref);
    };
    const undeclared = numericBlocks.filter((b) => {
      const ref = refOf(b);
      return ref === undefined || !refIsValid(ref);
    });
    const usableCitations = slide.citations.filter((c) => !isMisplacedLogicalRef(c));
    if (numericBlocks.length > 0 && usableCitations.length === 0 && undeclared.length > 0) {
      const sample = numericBlocks.flatMap((b) => numericClaims(b)).slice(0, 3);
      /**
       * **可机械修复的判定**：本页 citations 里有一条"被误当来源的逻辑引用"，且它归一后是
       * **已知**逻辑来源 —— 那 `autoRepair` 会把它从 citations 摘出来、回挂到所有"含数字且
       * 自己没有 sourceRef"的块上（见该函数里 `misplacedRefs` 那段），这条 error 随即消失。
       *
       * 不这么标就会退化成真机 job_0mv9k0wvg8vvpwmqd9y 那次：生成期把 R6 当成"不可修的阻塞项"
       * → 整份报告回喂一次（23 分钟 / 单次 4 万 token），而渲染期同一份 DSL 其实被静默修好、
       * 且归观感级 —— **报告内容一字未变，任务却被标成「产出不完整」**。
       *
       * 反过来，页面里**没有可回挂的逻辑引用**时依旧不标 `repairable`：那种情况只能靠回喂，
       * 系统绝不能凭空给数字块捏一个来源（R6 的底线，测试 ⑨ 钉的就是它）。
       */
      const relocatable = slide.citations.some((c) => {
        const key = c.ref?.sourceKey;
        return isMisplacedLogicalRef(c) && typeof key === "string" && refIsValid(normalizeRef(key));
      });
      issues.push({
        level: "error",
        path,
        message:
          `页面存在无来源的数字断言（如「${sample.join("」「")}」）：${undeclared.length} 个含数字的块` +
          `（${[...new Set(undeclared.map((b) => b.type))].join(" / ")}）没有有效 sourceRef，且该页没有可用 citation`,
        fix:
          "给这些块补 sourceRef（phase:* / meta:* / tool:* 形式），或把数字改写成不含数字的定性表述；" +
          `缺 sourceRef 的块序号：${undeclared.map((b) => `blocks[${slide.blocks.indexOf(b)}](${b.type})`).join("、")}`,
        ...(relocatable ? { repairable: true } : {}),
      });
    }

    // R9 low 置信度必须有 warn callout
    const hasLowTier = slide.blocks.some((b) => b.type === "kpi" && b.items.some((it) => it.tier === "low"));
    if (hasLowTier && !slide.blocks.some((b) => b.type === "callout" && b.tone === "warn")) {
      issues.push({
        level: "warn",
        path,
        message: "存在 low 置信度 KPI 但页面缺少 warn 类型的 callout",
        fix: "自动补一个 warn callout",
        repairable: true,
      });
    }
  });

  /* R12 可溯源引用占比（只提示，不阻塞——深度问题该由深度策略处理） */
  if (opts.minTraceableRatio !== undefined && dsl.slides.length > 0) {
    const ratio = traceableRatio(dsl);
    if (ratio < opts.minTraceableRatio) {
      issues.push({
        level: "warn",
        path: "citations",
        message: `可溯源引用占比 ${(ratio * 100).toFixed(0)}%，低于下限 ${(opts.minTraceableRatio * 100).toFixed(0)}%（引用多为模型推断，请补工具/知识库引用）`,
      });
    }
  }

  /* R14 未指定自有品牌时的「我方口径」泄漏
   * 扫描与修复共用 stripOwnBrandLeak 的同一遍 walk —— 见该函数的注释（两套实现必然分叉）。 */
  if (opts.hasOwnBrand === false) {
    const leak = stripOwnBrandLeak(dsl, { apply: false });
    if (leak.hits.length > 0) {
      const sample = leak.hits.slice(0, 3).map((h) => `${h.path}「${h.text}」`);
      issues.push({
        level: "error",
        path: leak.hits[0]!.path,
        message:
          `本轮未指定自有品牌（Brief.ownBrandId 缺省），但报告里出现了以「我方」为主语（含「本品牌」这类同义的自我指涉）的文本：${sample.join("；")}` +
          `（共 ${leak.hits.length} 处）`,
        fix: "剔除这些句子 / 条目 / 列（「本品牌」按整词换成中性主语「品牌」，不要挖掉词中间的字）。注意「本报告不含任何『我方』或『本品』数据」这类**负面声明也算违规**——声明本身就把词写进了报告",
        repairable: true,
      });
    }
  }

  return { ok: issues.every((i) => i.level !== "error"), issues };
}

/**
 * 自动修复（只处理 repairable 的项）。
 *
 * 关键取舍：**每个 action 都会让任务被标成 partial**（orchestrator 会把 repairs 写进 job.degraded），
 * 所以这里只在**确实改动了内容**时才记 action —— 幂等、无副作用，避免"修了个空"把好任务标脏。
 *
 * 第二个取舍：action 分两档。
 *   - `actions`：影响**数据断言**的修复（改写了带数字的结论、丢了真实出处），任务必须标 partial；
 *   - `cosmeticActions`：只影响**观感**的修复（结构页/免责页上不含数字的装饰性引用），
 *     内容语义零损伤，orchestrator 只忽略、不标脏——否则"免责页引用写法不规范"
 *     会把 15 页完好报告升格成「产出不完整」，状态语义失真。
 */
export function autoRepair(dsl: ReportDsl, opts: ReportValidationOptions = {}): {
  dsl: ReportDsl;
  actions: string[];
  cosmeticActions: string[];
} {
  const actions: string[] = [];
  const cosmeticActions: string[] = [];
  const catalogByKey = new Map((opts.catalog?.entries ?? []).map((e) => [e.key, e]));
  const logicalRefs = new Set<string>(opts.catalog?.logicalRefs ?? [...LOGICAL_REFS]);

  /* R1 / R2：来源声明修正 */
  let sources = dsl.sourceDeclaration?.sources ?? [];
  sources = sources.flatMap((s) => {
    if (opts.catalog && !catalogByKey.has(s.key)) {
      actions.push(`sourceDeclaration.sources: 移除不存在的来源「${s.displayName}」(${s.key})，相关引用降级为模型推断`);
      return [];
    }
    const entry = catalogByKey.get(s.key);
    if (entry && entry.displayName !== s.displayName) {
      actions.push(`sourceDeclaration.sources[${s.key}]: displayName「${s.displayName}」按台账改写为「${entry.displayName}」`);
      return [{ ...s, displayName: entry.displayName, grade: entry.grade, coverage: s.coverage || entry.coverage }];
    }
    return [s];
  });

  const declaredKeys = new Set(sources.map((s) => s.key));
  // 文案必须带页码：渲染层靠 action 文本回查 severity，两页同文案会撞车
  const downgrade = (slideIndex: number, c: ReportCitation, why: string, cosmetic = false): ReportCitation => {
    const text = `slides[${slideIndex}].citations: 「${c.claim.slice(0, 20)}」${why}，降级为 model_inference/low`;
    if (cosmetic) cosmeticActions.push(text);
    else actions.push(text);
    return { ...c, kind: "model_inference", ref: {}, tier: "low", verifiedBy: "auto" };
  };

  /**
   * 装饰性修复的判定：结构页（封面/目录/章节/免责）与免责类附录页**不含数据断言**，
   * 其上的引用修复不影响任何结论；附录页上含数字的条目仍按数据修复对待。
   */
  const isCosmeticContext = (slide: SlideSpec, claim: string): boolean =>
    slide.pageRole === "cover" ||
    slide.pageRole === "toc" ||
    slide.pageRole === "section" ||
    slide.pageRole === "closing" ||
    (slide.pageRole === "appendix" && !/\d/.test(claim));

  const slides = dsl.slides.map((slide) => {
    let blocks = slide.blocks;
    let citations = slide.citations;

    /* R3 前置特例：逻辑引用命名空间被误当成数据来源。
     * meta:* / phase:* / tool:* / degrade:* 是**块级 sourceRef** 的命名空间，不是数据源；
     * 模型（提示词同时教了两套写法）会把前者搬进 citations。
     *
     * ⚠️ 这类引用**不能一删了之**：删掉后本页 citations 归零，而 R6 只看 citations 是否为空，
     * 于是"被修好的" DSL 会在紧接着的第二次校验里多报一条 `repairable: false` 的 error →
     * render.compile 抛「拒绝渲染」，整份报告丢失（真机事故 job_0mv5ydf69a7aio1uhfd）。
     * 正确做法是把它**降落到本该待的地方**：赋给本页含数字断言的块当 sourceRef ——
     * 模型的原意本来就是「这页数据出自 X 阶段产物」，这正是块级 sourceRef 的定义，语义零损伤。
     * 认不出的写法（不在 logicalRefs 里）才退回移除 —— 那种引用谁也不认识，留着也是错的。 */

    /* R3 前置特例 ①：**缺失声明**被写成了引用 —— 直接移除，既不降级也不改挂。
     *
     * 「所有候选人报价未采集」不是数据来源主张，而是"这里没有数据"的告知；模型没有别的地方
     * 放它，就塞进了 citations（真机 job_0mv86by83ilvbnn0h1a 的 slides[7]）。这类引用：
     *   - 降级成 model_inference/low → 凭空造一条「模型推断：报价未采集」，缺失不是推断；
     *   - 改挂块级 sourceRef 更糟 → 本页含数字的人选矩阵会被标成"数据出自报价工具"，
     *     而矩阵跟报价毫无关系（真实 DSL 里正是这么被误挂的）。
     * 正确处置是移除，缺失信息由同页 callout 承载（提示词也明确要求这么写）。
     *
     * ⚠️ 必须带 R6 保护：删掉后本页若既无可用引用、又有含数字且无来源的块，就会在紧接着的
     * 第二次校验里多报一条 `repairable: false` 的 error → 报告整份丢失（同 job_0mv5ydf69a7aio1uhfd
     * 的事故形态）。此时退回原来的降级路径，宁可贵一条引用也不丢报告。
     */
    const absence = citations.filter(isAbsenceClaimCitation);
    /**
     * 被 R6 保护**留下**（没能移除）的缺失声明 —— 它们会往下走普通的"未声明来源"降级。
     * 那一步必须按**观感级**记账，理由见下面 R3 降级处的注释。
     */
    const keptAbsence = new Set<ReportCitation>();
    if (absence.length > 0) {
      const survivors = citations.filter((c) => !isAbsenceClaimCitation(c));
      const usableSurvivors = survivors.filter((c) => !isMisplacedLogicalRef(c)).length;
      const everyNumericBlockSourced = blocks.every((b) => numericClaims(b).length === 0 || !!refOf(b));
      if (usableSurvivors > 0 || everyNumericBlockSourced) {
        citations = survivors;
        for (const c of absence) {
          cosmeticActions.push(
            `slides[${slide.index}].citations: 移除缺失声明「${c.claim.slice(0, 20)}」（"未采集/无样本"不是数据来源，缺失应由 callout 或正文说明）`,
          );
        }
      } else {
        for (const c of absence) keptAbsence.add(c);
      }
    }

    const misplacedRefs: string[] = [];
    const beforeMisplaced = citations;
    citations = citations.filter((c) => {
      /* 缺失声明引用走到这里 = 上面的 R6 保护判定"不能删"（删了本页数字断言会失去来源）。
       * 此时必须**豁免**下面的误置处理：它同样会把裸写的 `pricing` 移除，保护就白做了。
       * 让它按普通"未声明来源"降级，宁可多一条可见的推断标注，也不丢报告。 */
      if (isAbsenceClaimCitation(c)) return true;
      if (!isMisplacedLogicalRef(c)) return true;
      const raw = c.ref.sourceKey as string;
      const key = normalizeRef(raw);
      const relocatable = logicalRefs.has(key);
      /**
       * ⚠️ **同一条 R6 保护**（与上面「缺失声明」那段同源）：
       * 认不出的命名空间写法（`phase:xxx` / `tool:xxx` 里不在 logicalRefs 的那些）会被移除、
       * 又回挂不了任何块 —— 如果本页就靠它撑着数字断言，移除之后紧接着的第二次校验就会多报
       * 一条 `repairable: false` 的 error → render.compile 抛「拒绝渲染」、**报告整份丢失**
       * （与 job_0mv5ydf69a7aio1uhfd 同一形态，实测 `phase:unknown_thing` 可复现）。
       *
       * 「认不出的引用留着也是错的」这条判断**孤立看成立**，但不能以丢掉整份报告为代价：
       * 此时退回普通降级路径（下面的 R3 会把它降成 model_inference/low），
       * 读者看到的是一条可见的推断标注，而不是什么都看不到。
       */
      const otherUsable = beforeMisplaced.some((o) => o !== c && !isMisplacedLogicalRef(o));
      const everyNumericBlockSourced = blocks.every((b) => numericClaims(b).length === 0 || !!refOf(b));
      if (!relocatable && !otherUsable && !everyNumericBlockSourced) return true;
      const where = relocatable ? `已改挂为本页数字块的 sourceRef「${key}」` : "已移除（逻辑引用只用于块级 sourceRef）";
      if (relocatable) misplacedRefs.push(key);
      cosmeticActions.push(`slides[${slide.index}].citations: 「${c.claim.slice(0, 20)}」把逻辑引用「${raw}」当成了数据来源，${where}`);
      return false;
    });
    if (misplacedRefs.length > 0) {
      // 只挂给「含数字断言且自己没有来源」的块：刚好是 R6 会检查的那批，最小改动
      const ref = misplacedRefs[0]!;
      blocks = blocks.map((b) =>
        !refOf(b) && numericClaims(b).length > 0 ? ({ ...(b as Record<string, unknown>), sourceRef: ref } as Block) : b,
      );
    }

    /* R3 / R4 / R5：引用降级 */
    citations = citations.map((c) => {
      /**
       * 分级口径与"把逻辑引用当成数据来源"保持一致（2026-10-15 的结论：那种改动是**改写写作形式**，
       * 内容语义零损伤 → 观感级）。被 R6 保护留下的缺失声明走的是同一条路 —— 它只是**没能被移除**、
       * 于是退而求其次降级标注，报告文本一字未改。不这么标就会出现一个说不通的结果：
       * 同一个写作瑕疵（把"无样本"写成 citation、且 sourceKey 用了逻辑命名空间），
       * 页面上还有别的可用引用时算观感级、恰好没有时算数据级 → **任务被标脏与否取决于同页其他槽位**。
       * 真机 job_0mv9k0wvg8vvpwmqd9y 的第二次重跑正是被这一条标成 partial。
       */
      const cosmetic = isCosmeticContext(slide, c.claim) || keptAbsence.has(c);
      if (c.kind === "data_source") {
        const key = c.ref?.sourceKey;
        if (!key) return downgrade(slide.index, c, "缺少 ref.sourceKey", cosmetic);
        if (!declaredKeys.has(key)) return downgrade(slide.index, c, `引用了未声明的来源 ${key}`, cosmetic);
      }
      if (c.kind === "kb_chunk") {
        const chunkId = c.ref?.chunkId;
        if (!chunkId) return downgrade(slide.index, c, "缺少 ref.chunkId", cosmetic);
        if (opts.catalog?.chunkIds && !opts.catalog.chunkIds.includes(chunkId)) return downgrade(slide.index, c, `引用了不存在的片段 ${chunkId}`, cosmetic);
      }
      if (c.kind === "model_inference" && c.tier !== "low") {
        actions.push(`citations: 「${c.claim.slice(0, 20)}」模型推断改标 tier=low`);
        return { ...c, tier: "low" as const };
      }
      /**
       * R13：条目级引用失效时的降级阶梯。
       *
       * 优先退到**来源级**（保留 sourceKey）而不是直接退成模型推断：条目查不到不代表
       * "这个平台的数据都是编的"，它至少还有来源级出处；只有在连 sourceKey 都没声明时
       * 才退到 model_inference。降太多等于把收紧校验变成"把内容删掉"。
       */
      if (c.kind === "platform_entry") {
        const entryId = c.ref?.entryId;
        const known = opts.catalog?.evidenceEntries;
        const invalid = !entryId || (known ? !known.some((e) => e.entryId === entryId) : false);
        if (invalid) {
          const key = c.ref?.sourceKey;
          if (key && declaredKeys.has(key)) {
            actions.push(`citations: 「${c.claim.slice(0, 20)}」条目级引用无效（${entryId ?? "缺 entryId"}），降级为来源级引用 ${key}`);
            return { ...c, kind: "data_source", ref: { sourceKey: key }, verifiedBy: "auto" };
          }
          return downgrade(slide.index, c, `条目级引用无效（${entryId ?? "缺 entryId"}）且无可用来源级出处`, cosmetic);
        }
      }
      return c;
    });

    /* R11：块级 sourceRef 归一化（仅在有别名可归一时才动） */
    blocks = blocks.map((b) => {
      const ref = refOf(b);
      if (!ref) return b;
      const normalized = normalizeRef(ref);
      if (normalized === ref) return b;
      if (logicalRefs.has(normalized) || declaredKeys.has(normalized)) {
        actions.push(`slides[${slide.index}].blocks: sourceRef「${ref}」归一化为「${normalized}」`);
        return { ...(b as Record<string, unknown>), sourceRef: normalized } as Block;
      }
      return b;
    });

    /* R9：low 置信度补 warn callout
     *
     * 归 **cosmetic**：这是"补全一个合规提示"，既不改写任何数字、也不丢任何出处 ——
     * 按本函数顶部的分级原则（`cosmeticActions` = 内容语义零损伤）就该算观感修复。
     * 归 data 级会让一份 15 页完好报告被标成「产出不完整」，读者看到的是一个**更**安全的
     * 报告，状态却在说"有东西缺失"，语义正好反了（真机 job_0mv86by83ilvbnn0h1a 即此）。
     * 根因（模型漏写配套 callout）由提示词侧修：R9 的判定是 `tier === "low"`，
     * 而提示词此前写的是「confidence < 0.45」，术语对不上，模型无从遵守。 */
    const hasLowTier = blocks.some((b) => b.type === "kpi" && b.items.some((it) => it.tier === "low"));
    const hasWarn = blocks.some((b) => b.type === "callout" && b.tone === "warn");
    if (hasLowTier && !hasWarn) {
      cosmeticActions.push(`slides[${slide.index}]: 自动补 warn callout（存在 low 置信度 KPI）`);
      blocks = [
        ...blocks,
        {
          type: "callout" as const,
          tone: "warn" as const,
          text: "本页含低置信度估算值，样本不足或来源单一，请结合人工判断使用。",
        },
      ];
    }

    if (!slide.layoutId) {
      actions.push(`slides[${slide.index}]: layoutId 缺失，回退 content/default`);
      return { ...slide, blocks, citations, layoutId: "content/default" };
    }
    return { ...slide, blocks, citations };
  });

  /* R14：未指定自有品牌时的「我方口径」剔除。
   *
   * 分级标准沿用现有原则（见本函数顶部注释）：**含数字的修复算 data，纯措辞算 cosmetic**。
   * 那条负面声明（「本报告不含任何『我方』或『本品』数据」）没有数字、也没有承载任何事实，
   * 抹掉它属于观感级修复，不该把一份完好报告升格成「产出不完整」；
   * 反过来，删掉「我方抖音账号互动率 3.2%」这类带数字的越界断言必须标脏。 */
  let repaired: ReportDsl = { ...dsl, sourceDeclaration: { ...dsl.sourceDeclaration, sources }, slides };
  if (opts.hasOwnBrand === false) {
    const leak = stripOwnBrandLeak(repaired, { apply: true });
    for (const h of leak.hits) {
      const text = `${h.path}: ${h.action}（本轮未指定自有品牌，报告不得出现「我方」口径）`;
      if (h.digits) actions.push(text);
      else cosmeticActions.push(text);
    }
    repaired = leak.dsl;
  }

  return { dsl: repaired, actions, cosmeticActions };
}

export const DISCLAIMER_TEXT =
  "本报告由 AI 辅助生成，结论基于所声明数据源与模型推断，不构成投放承诺或收益保证。" +
  "标注为「估算」的内容样本不足，请结合业务判断使用。";

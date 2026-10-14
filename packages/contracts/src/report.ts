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
const isMisplacedLogicalRef = (c: ReportCitation): boolean =>
  c.kind === "data_source" && typeof c.ref?.sourceKey === "string" && MISPLACED_LOGICAL_REF_RE.test(c.ref.sourceKey);

export interface ReportValidationOptions {
  /** 本次真实可用的数据源目录；缺省时跳过 R1/R2/R4 的来源存在性校验 */
  catalog?: SourceCatalog;
  /** 可溯源引用占比下限（低于则 warn，不阻塞渲染） */
  minTraceableRatio?: number;
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
     * 而这条 error 不可修复 → render.compile 抛错、报告整份丢失（真机事故 job_0mv5ydf69a7aio1uhfd）。 */
    const numericBlocks = slide.blocks.filter((b) => numericClaims(b).length > 0);
    const allDeclared = numericBlocks.every((b) => {
      const ref = refOf(b);
      if (!ref) return false;
      const normalized = normalizeRef(ref);
      return logicalRefs.has(normalized) || declaredKeys.has(normalized) || declaredKeys.has(ref);
    });
    const usableCitations = slide.citations.filter((c) => !isMisplacedLogicalRef(c));
    if (numericBlocks.length > 0 && usableCitations.length === 0 && !allDeclared) {
      const sample = numericBlocks.flatMap((b) => numericClaims(b)).slice(0, 3);
      issues.push({
        level: "error",
        path,
        message: `页面存在无来源的数字断言（如「${sample.join("」「")}」），且该页既无 citation 也未声明有效 sourceRef`,
        fix: "为该页补 citations，或给含数字的 block 加 phase:* / meta:* 形式的 sourceRef",
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
    const misplacedRefs: string[] = [];
    citations = citations.filter((c) => {
      if (!isMisplacedLogicalRef(c)) return true;
      const raw = c.ref.sourceKey as string;
      const key = normalizeRef(raw);
      const where = logicalRefs.has(key) ? `已改挂为本页数字块的 sourceRef「${key}」` : "已移除（逻辑引用只用于块级 sourceRef）";
      if (logicalRefs.has(key)) misplacedRefs.push(key);
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
      if (c.kind === "data_source") {
        const key = c.ref?.sourceKey;
        if (!key) return downgrade(slide.index, c, "缺少 ref.sourceKey", isCosmeticContext(slide, c.claim));
        if (!declaredKeys.has(key)) return downgrade(slide.index, c, `引用了未声明的来源 ${key}`, isCosmeticContext(slide, c.claim));
      }
      if (c.kind === "kb_chunk") {
        const chunkId = c.ref?.chunkId;
        if (!chunkId) return downgrade(slide.index, c, "缺少 ref.chunkId", isCosmeticContext(slide, c.claim));
        if (opts.catalog?.chunkIds && !opts.catalog.chunkIds.includes(chunkId)) return downgrade(slide.index, c, `引用了不存在的片段 ${chunkId}`, isCosmeticContext(slide, c.claim));
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
          return downgrade(slide.index, c, `条目级引用无效（${entryId ?? "缺 entryId"}）且无可用来源级出处`, isCosmeticContext(slide, c.claim));
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

    /* R9：low 置信度补 warn callout */
    const hasLowTier = blocks.some((b) => b.type === "kpi" && b.items.some((it) => it.tier === "low"));
    const hasWarn = blocks.some((b) => b.type === "callout" && b.tone === "warn");
    if (hasLowTier && !hasWarn) {
      actions.push(`slides[${slide.index}]: 自动补 warn callout（存在 low 置信度 KPI）`);
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

  return {
    dsl: { ...dsl, sourceDeclaration: { ...dsl.sourceDeclaration, sources }, slides },
    actions,
    cosmeticActions,
  };
}

export const DISCLAIMER_TEXT =
  "本报告由 AI 辅助生成，结论基于所声明数据源与模型推断，不构成投放承诺或收益保证。" +
  "标注为「估算」的内容样本不足，请结合业务判断使用。";

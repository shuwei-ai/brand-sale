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

export interface ReportCitation {
  /** 报告里出现的原始数字/结论 */
  claim: string;
  kind: "data_source" | "kb_chunk" | "model_inference";
  ref: { sourceKey?: string; chunkId?: string; runId?: string; fieldPath?: string };
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
 *     R6 含数字断言的页面，必须要么整页至少有一条 citation，
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

    /* R6 无来源数字检查 */
    const numericBlocks = slide.blocks.filter((b) => numericClaims(b).length > 0);
    const allDeclared = numericBlocks.every((b) => {
      const ref = refOf(b);
      if (!ref) return false;
      const normalized = normalizeRef(ref);
      return logicalRefs.has(normalized) || declaredKeys.has(normalized) || declaredKeys.has(ref);
    });
    if (numericBlocks.length > 0 && slide.citations.length === 0 && !allDeclared) {
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
 */
export function autoRepair(dsl: ReportDsl, opts: ReportValidationOptions = {}): { dsl: ReportDsl; actions: string[] } {
  const actions: string[] = [];
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
  const downgrade = (c: ReportCitation, why: string): ReportCitation => {
    actions.push(`citations: 「${c.claim.slice(0, 20)}」${why}，降级为 model_inference/low`);
    return { ...c, kind: "model_inference", ref: {}, tier: "low", verifiedBy: "auto" };
  };

  const slides = dsl.slides.map((slide) => {
    let blocks = slide.blocks;
    let citations = slide.citations;

    /* R3 / R4 / R5：引用降级 */
    citations = citations.map((c) => {
      if (c.kind === "data_source") {
        const key = c.ref?.sourceKey;
        if (!key) return downgrade(c, "缺少 ref.sourceKey");
        if (!declaredKeys.has(key)) return downgrade(c, `引用了未声明的来源 ${key}`);
      }
      if (c.kind === "kb_chunk") {
        const chunkId = c.ref?.chunkId;
        if (!chunkId) return downgrade(c, "缺少 ref.chunkId");
        if (opts.catalog?.chunkIds && !opts.catalog.chunkIds.includes(chunkId)) return downgrade(c, `引用了不存在的片段 ${chunkId}`);
      }
      if (c.kind === "model_inference" && c.tier !== "low") {
        actions.push(`citations: 「${c.claim.slice(0, 20)}」模型推断改标 tier=low`);
        return { ...c, tier: "low" as const };
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
  };
}

export const DISCLAIMER_TEXT =
  "本报告由 AI 辅助生成，结论基于所声明数据源与模型推断，不构成投放承诺或收益保证。" +
  "标注为「估算」的内容样本不足，请结合业务判断使用。";

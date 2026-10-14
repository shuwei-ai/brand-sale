/**
 * 报告深度策略（P1-2）
 *
 * 为什么单独一份策略：提示词只是第一道。放一行「页数不少于 12」在提示词里，
 * 模型可能照做，也可能不做，而且**没人能判定**它到底做没做。
 * 这里把它变成可执行、可断言、可回喂的度量：
 *   - 提示词里贴 policy 的人类可读描述（第一道）；
 *   - 生成后 measureReportDepth 度量，不达标把 gaps 拼进提示词回喂一次（第二道）；
 *   - 仍不达标则接受 + 落 meta.degraded（如实标注，不假装达标）。
 *
 * 纯函数、零依赖、只依赖 contracts 自身的类型——render 与 agent-pack 都能用。
 */

import { BLOCK_TYPES, PAGE_ROLES, type Block, type ReportDsl } from "./report.ts";

/**
 * 每种块型的用途（**单一事实源**）。
 * `describeDepthPolicy()` 的清单与深度缺口文案都从这里生成 —— 不要在提示词里另抄一份再写歪。
 */
export const BLOCK_TYPE_HINTS: Record<Block["type"], string> = {
  text: "分节小标题 / 正文 / 图注",
  bullets: "要点清单",
  kpi: "关键指标卡（含 confidence 与 tier）",
  table: "结构化对照表",
  chart: "趋势或构成图表（必须给轴标签与口径）",
  timeline: "时间轴（内容日历 / 排期）",
  quote: "引用原文（平台采集到的原文摘录、竞品原话、知识库结论原文），attribution 写清出处",
  callout: "提示 / 警示块（tone=info|warn|risk）",
  matrix: "二维矩阵（象限图 / 渠道×阶段）",
  image: "插图（需真实图片素材；ref 仅放行 https:// 与 data:image/，本链路不下发任何图片 URL）",
};

/**
 * 需要外部素材的块型：**不计入任何下限要求**。
 *
 * `image` 的 `ref` 只放行 `https://` 与 `data:image/`（见 render 的图片协议白名单），
 * 而报告链路不下发任何图片 URL —— 于是"要求模型用 image 凑块型数"只会换来一个
 * 渲染时被摘掉的空块，下限反而变成**不可能达成的约束**。所以下限只约束可表达的块型。
 */
export const ASSET_BLOCK_TYPES: readonly Block["type"][] = ["image"];

/** 报告里可自由表达的块型（全集 − 需外部素材者）；下限与缺口文案都基于它 */
export const USABLE_BLOCK_TYPES: readonly Block["type"][] = BLOCK_TYPES.filter(
  (t) => !(ASSET_BLOCK_TYPES as readonly string[]).includes(t),
);

export interface ReportDepthPolicy {
  minSlides: number;
  /** 正文页（pageRole = content | data）每页最少块数 */
  minBlocksPerBodySlide: number;
  minBlockTypes: number;
  /** 必须出现的块型 */
  requiredBlockTypes: Block["type"][];
  /** 可溯源引用（data_source / kb_chunk）占全部引用的比例下限 */
  minTraceableRatio: number;
  /** 来源声明条数下限 */
  minSources: number;
  /** 图表类块（chart / matrix）总数下限 */
  minVisualBlocks: number;
}

export const DEFAULT_DEPTH_POLICY: ReportDepthPolicy = {
  minSlides: 12,
  minBlocksPerBodySlide: 3,
  /**
   * 下限 9 = **可表达块型的全覆盖**（USABLE_BLOCK_TYPES 共 9 种，image 因需外部素材被排除）。
   *
   * 这不是"要求苛刻"：text / bullets 在正文页几乎必然出现（每页 ≥ 3 块），
   * 只要再把 requiredBlockTypes 的 7 种用齐，9 种自然达成。
   * ⚠️ 正因如此，**必需清单必须是可行解**：image 不可达、不许进清单，
   * 否则模型会拿一个渲染时被摘掉的块来凑数，缺口永远补不上（真机踩过：模型只产 8 种，
   * 缺的正是 quote，而提示词当时根本没介绍过这个块型）。
   */
  minBlockTypes: 9,
  requiredBlockTypes: ["kpi", "table", "chart", "matrix", "timeline", "callout", "quote"],
  minTraceableRatio: 0.6,
  minSources: 3,
  minVisualBlocks: 4,
};

export interface DepthReport {
  slides: number;
  bodySlides: number;
  blocks: number;
  blockTypes: Block["type"][];
  missingRequiredTypes: Block["type"][];
  visualBlocks: number;
  totalCitations: number;
  traceable: number;
  traceableRatio: number;
  declaredSources: number;
  /** 人类可读缺口清单，直接拼进回喂提示词 */
  gaps: string[];
}

const BODY_ROLES = new Set(["content", "data"]);

/** 把策略的硬性下限渲染成人类可读文本，供提示词与回喂共用（避免两处各写一遍再写歪） */
export function describeDepthPolicy(policy: ReportDepthPolicy = DEFAULT_DEPTH_POLICY): string {
  return [
    `- slides 总数 ≥ ${policy.minSlides}，其中 pageRole=content|data 的页每页 ≥ ${policy.minBlocksPerBodySlide} 个 block；`,
    `- 至少使用 ${policy.minBlockTypes} 种不同 block type，且必须包含 ${policy.requiredBlockTypes.join(" / ")}；`,
    `- chart 与 matrix 这类可视化块合计 ≥ ${policy.minVisualBlocks} 个；`,
    `- 可溯源引用（kind=data_source|kb_chunk|platform_entry）占全部引用 ≥ ${Math.round(policy.minTraceableRatio * 100)}%；`,
    `- sourceDeclaration.sources ≥ ${policy.minSources} 条，且每个 key 至少有 1 条 citation 指向它；`,
    `- 可用块型共 ${USABLE_BLOCK_TYPES.length} 种，逐种用途如下（**照着这份清单凑够 ${policy.minBlockTypes} 种**，不要用清单外的写法）：`,
    ...USABLE_BLOCK_TYPES.map((t) => `    · ${t}：${BLOCK_TYPE_HINTS[t]}`),
    `  ⚠️ **不要用 image 块凑块型数**：${BLOCK_TYPE_HINTS.image}，` +
      `写了也会在渲染时被摘掉（既白写、也不算数）。`,
  ].join("\n");
}

export function measureReportDepth(dsl: ReportDsl, policy: ReportDepthPolicy = DEFAULT_DEPTH_POLICY): DepthReport {
  const slides = dsl.slides ?? [];
  const body = slides.filter((s) => BODY_ROLES.has(s.pageRole));
  const blocks = slides.flatMap((s) => s.blocks ?? []);
  const blockTypes = [...new Set(blocks.map((b) => b.type))].sort() as Block["type"][];
  const missingRequiredTypes = policy.requiredBlockTypes.filter((t) => !blockTypes.includes(t));
  const visualBlocks = blocks.filter((b) => b.type === "chart" || b.type === "matrix").length;

  const citations = slides.flatMap((s) => s.citations ?? []);
  const traceable = citations.filter((c) => c.kind !== "model_inference").length;
  const traceableRatio = citations.length === 0 ? 0 : traceable / citations.length;

  const gaps: string[] = [];
  if (slides.length < policy.minSlides) gaps.push(`slides 总数 ${slides.length} < 下限 ${policy.minSlides}`);
  const thinBody = body.filter((s) => (s.blocks ?? []).length < policy.minBlocksPerBodySlide);
  if (thinBody.length > 0) {
    gaps.push(
      `以下正文页块数不足 ${policy.minBlocksPerBodySlide}：${thinBody.map((s) => `#${s.index + 1}「${s.title}」(${(s.blocks ?? []).length} 块)`).join("、")}`,
    );
  }
  if (blockTypes.length < policy.minBlockTypes) {
    // 只说"数量不够"没有用 —— 模型看到也不知道该补哪种。把**还没用上的可用块型**点名列出，
    // 回喂才有可执行性（真机踩过：gap 只写了「只用到 8 种（下限 9）」，回喂后模型仍只产 8 种）。
    const unused = USABLE_BLOCK_TYPES.filter((t) => !blockTypes.includes(t));
    gaps.push(
      `只用到 ${blockTypes.length} 种 block type（下限 ${policy.minBlockTypes}）：${blockTypes.join("、")}；` +
        `本报告还没用上 ${unused.map((t) => `${t}（${BLOCK_TYPE_HINTS[t]}）`).join("、")}`,
    );
  }
  if (missingRequiredTypes.length > 0) gaps.push(`缺少必需的 block type：${missingRequiredTypes.join("、")}`);
  if (visualBlocks < policy.minVisualBlocks) gaps.push(`chart/matrix 合计只有 ${visualBlocks} 个（下限 ${policy.minVisualBlocks}）`);
  if (traceableRatio < policy.minTraceableRatio) {
    gaps.push(`可溯源引用占比 ${(traceableRatio * 100).toFixed(0)}% < 下限 ${Math.round(policy.minTraceableRatio * 100)}%（${traceable}/${citations.length}）`);
  }
  if ((dsl.sourceDeclaration?.sources ?? []).length < policy.minSources) {
    gaps.push(`来源声明只有 ${(dsl.sourceDeclaration?.sources ?? []).length} 条（下限 ${policy.minSources}）`);
  }

  return {
    slides: slides.length,
    bodySlides: body.length,
    blocks: blocks.length,
    blockTypes,
    missingRequiredTypes,
    visualBlocks,
    totalCitations: citations.length,
    traceable,
    traceableRatio: Number(traceableRatio.toFixed(4)),
    declaredSources: (dsl.sourceDeclaration?.sources ?? []).length,
    gaps,
  };
}

export { PAGE_ROLES };

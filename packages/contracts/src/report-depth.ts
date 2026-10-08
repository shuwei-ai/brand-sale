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

import { PAGE_ROLES, type Block, type ReportDsl } from "./report.ts";

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
  minBlockTypes: 9,
  requiredBlockTypes: ["kpi", "table", "chart", "matrix", "timeline", "callout"],
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
    `- 可溯源引用（kind=data_source|kb_chunk）占全部引用 ≥ ${Math.round(policy.minTraceableRatio * 100)}%；`,
    `- sourceDeclaration.sources ≥ ${policy.minSources} 条，且每个 key 至少有 1 条 citation 指向它。`,
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
    gaps.push(`只用到 ${blockTypes.length} 种 block type（下限 ${policy.minBlockTypes}）：${blockTypes.join("、")}`);
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

/**
 * 置信度策略（对应 LLD §3.4.2）
 *
 * 打分维度：来源类型 + 样本量 + 新鲜度 + 是否人工核验 + 多源交叉一致度。
 * 分级阈值：≥0.75 high / 0.45–0.75 medium / <0.45 low。
 */

import type { ConfidenceInput, ConfidencePresentation, ConfidenceTier, IConfidencePolicy, KbSourceTypeValue } from "@brandsale/contracts";

const BASE_BY_SOURCE: Record<KbSourceTypeValue, number> = {
  l1_platform: 0.7,
  l2_execution: 0.62,
  l3_public: 0.5,
  l4_purchased: 0.45,
  human_verified: 0.8,
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export class ConfidencePolicy implements IConfidencePolicy {
  score(input: ConfidenceInput): number {
    let s = BASE_BY_SOURCE[input.sourceType] ?? 0.5;

    // 样本量：1 条几乎不加分，1 万条接近满分
    const sampleBonus = Math.min(1, Math.log10(Math.max(1, input.sampleSize)) / 4);
    s += sampleBonus * 0.15;

    // 新鲜度：过期数据显著降分
    if (input.ageDays > 365) s -= 0.2;
    else if (input.ageDays > 180) s -= 0.12;
    else if (input.ageDays > 90) s -= 0.06;
    else if (input.ageDays > 30) s -= 0.02;

    if (input.humanVerified) s += 0.15;

    if (input.crossSourceAgreement !== undefined) {
      s += (clamp01(input.crossSourceAgreement) - 0.5) * 0.2;
    }

    return Number(clamp01(s).toFixed(4));
  }

  tier(score: number): ConfidenceTier {
    if (score >= 0.75) return "high";
    if (score >= 0.45) return "medium";
    return "low";
  }

  presentation(tier: ConfidenceTier): ConfidencePresentation {
    switch (tier) {
      case "high":
        return { label: "已核验 / 多源一致", color: "green", disclaimer: false };
      case "medium":
        return { label: "单一来源", color: "amber", disclaimer: true };
      default:
        return { label: "估算 / 样本不足", color: "red", disclaimer: true, strongDisclaimer: true };
    }
  }

  /** 便捷方法：一步到 tier */
  evaluate(input: ConfidenceInput): { score: number; tier: ConfidenceTier; presentation: ConfidencePresentation } {
    const score = this.score(input);
    const tier = this.tier(score);
    return { score, tier, presentation: this.presentation(tier) };
  }
}

export const ageInDays = (iso: string, now = Date.now()): number =>
  Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));

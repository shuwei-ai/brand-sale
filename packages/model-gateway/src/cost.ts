/**
 * 成本核算（M14）。金额单位统一为「元」。
 */

import type { Money, TokenUsage } from "@brandsale/contracts";

export interface PriceTable {
  inputPer1k: number;
  outputPer1k: number;
}

export function computeCost(usage: TokenUsage, price: PriceTable): Money {
  const billableInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const amount = (billableInput / 1000) * price.inputPer1k + (usage.outputTokens / 1000) * price.outputPer1k;
  return { currency: "CNY", amount: Number(amount.toFixed(6)) };
}

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 });

export const mergeUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  calls: a.calls + b.calls,
});

/**
 * 成本预估。用于 LLD §7.3 E2E 用例 8「成本预估与实际偏差 < 20%」。
 * 粗估：中文 1 token ≈ 1.5 字符。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

export function estimateCost(promptChars: number, expectedOutputTokens: number, price: PriceTable): Money {
  return computeCost(
    {
      inputTokens: Math.ceil(promptChars / 1.5),
      outputTokens: expectedOutputTokens,
      cachedInputTokens: 0,
      calls: 1,
    },
    price,
  );
}

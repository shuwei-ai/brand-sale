/**
 * WP-B 品牌自身诊断（P0-1）验收测试。
 *
 * 这一章最大的风险不是"没写"，而是**写成编造**：品牌自诊读起来像在陈述"已知的自家情况"，
 * 于是最容易出现"品牌认知度 32%"这类没有任何来源的数字。
 * 所以这里的断言集中在"没数据时它是否老老实实说没有"。
 *
 * 对应方案 `docs/requirements-implementation-plan.md` §WP-B：
 *   报告含该 2 页；gaps.length >= 3；未授权场景 contentAssets[].avgEngagement === null
 *   且存在 warn callout；measureReportDepth().slides >= 15。
 *
 * 运行：npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEPTH_POLICY, measureReportDepth } from "@brandsale/contracts";
import { CompetitorIntelSchema, synthIntel, synthReport } from "@brandsale/agent-pack";

/** 未接入任何品牌资产数据源的最小 Brief（这是当前的真实处境） */
const brief = {
  industry: "美妆个护",
  category: "抗老精华",
  platforms: ["douyin", "xiaohongshu"],
  window: { from: "2026-10-01", to: "2026-12-31" },
  brandIds: ["b_demo_1"],
  budget: { amount: 3_000_000 },
};

const noTools = {};

test("WP-B-1 未授权场景：自有资产数字必须全为 null，且不挂任何引用", () => {
  const intel = synthIntel(brief, noTools);
  const bs = intel.brandSelf;

  assert.ok(bs, "intel 必须带 brandSelf");
  assert.ok(bs.contentAssets.length > 0, "至少要按 Brief 的平台列表列出待确认的行");
  for (const a of bs.contentAssets) {
    assert.equal(a.accountCount, null, `${a.platform} 的账号数无来源，必须是 null`);
    assert.equal(a.postCount, null, `${a.platform} 的作品数无来源，必须是 null`);
    assert.equal(a.avgEngagement, null, `${a.platform} 的互动率无来源，必须是 null`);
    assert.match(a.tier, /未获授权/, "tier 必须如实写明这一行数据的可得性");
  }
  assert.equal(bs.reputation.sentiment, "unknown", "没有口碑样本就不能给情感倾向");
  assert.equal(bs.reputation.themes.length, 0);
  assert.equal(bs.citations.length, 0, "一个数字都没有，就不该有任何引用（否则引用是装饰）");
});

test("WP-B-2 差距矩阵不少于 3 条，且量化不了要写明原因而不是给 0", () => {
  const bs = synthIntel(brief, noTools).brandSelf;
  assert.ok(bs.gaps.length >= 3, `差距条目 ${bs.gaps.length} 条应 ≥ 3`);
  for (const g of bs.gaps) {
    assert.ok(g.dimension && g.benchmark && g.delta, "四段式（dimension/self/benchmark/delta）必须齐全");
    assert.ok(!/^0$/.test(g.delta.trim()), `「${g.dimension}」的差距不得用 0 冒充"没有差距"`);
  }
});

test("WP-B-3 兜底产物必须能通过自己的 Schema（有数字必须有来源的硬校验）", () => {
  // 兜底路径不能成为绕开校验的后门：它自己写出来的东西必须过自己的 schema
  const intel = synthIntel(brief, noTools);
  const validated = CompetitorIntelSchema.validate(intel);
  assert.ok(validated.brandSelf, "校验后 brandSelf 不能丢");
  assert.deepEqual(validated.brandSelf.citations, []);
});

test("WP-B-4 有数字却没引用时，Schema 必须拒绝（这是本章的核心防线）", () => {
  const intel = synthIntel(brief, noTools);
  const forged = structuredClone(intel);
  // 模拟模型"顺手填了个合理数字"：把 avgEngagement 填上，但仍不给引用
  forged.brandSelf.contentAssets[0]!.avgEngagement = 0.032;
  assert.throws(
    () => CompetitorIntelSchema.validate(forged),
    /citations 为空|自有资产数字必须逐项说明来源/,
    "无来源的自有资产数字必须被拒 —— 否则这一章就成了编造甲方经营数据的入口",
  );

  // 补上来源后就应放行（说明拦截的是"无来源"，不是"不许有数字"）
  const sourced = structuredClone(forged);
  sourced.brandSelf.citations = [{ claim: "抖音后台导出近 30 天互动率 3.2%", sourceKey: "internal_review", confidence: 0.8 }];
  assert.doesNotThrow(() => CompetitorIntelSchema.validate(sourced));
});

test("WP-B-5 无样本时不得给情感结论", () => {
  const intel = synthIntel(brief, noTools);
  const forged = structuredClone(intel);
  forged.brandSelf.reputation.sentiment = "positive"; // themes 仍为空
  assert.throws(
    () => CompetitorIntelSchema.validate(forged),
    /sentiment 必须是 unknown/,
    "没有口碑样本就给「偏正面」等于凭空造结论",
  );
});

test("WP-B-6 报告含品牌自诊 2 页，且概览页带 warn callout、KPI 不写 0", () => {
  const dsl = synthReport(brief, { intel: synthIntel(brief, noTools) }, { synthesized: true });
  const titles = dsl.slides.map((s) => s.title);
  assert.ok(titles.includes("品牌自诊概览"), "报告必须含「品牌自诊概览」页");
  assert.ok(titles.includes("品牌 vs 竞品差距矩阵"), "报告必须含「品牌 vs 竞品差距矩阵」页");

  const selfSlide = dsl.slides.find((s) => s.title === "品牌自诊概览");
  assert.ok(selfSlide, "品牌自诊概览页应存在");
  assert.ok(
    selfSlide.blocks.some((b) => b.type === "callout" && b.tone === "warn"),
    "未授权时该页必须有 tone=warn 的 callout 声明本页为定性判断",
  );

  const kpi = selfSlide.blocks.find((b) => b.type === "kpi");
  assert.ok(kpi && kpi.type === "kpi", "概览页应含 KPI 块");
  for (const item of kpi.items) {
    assert.notEqual(item.value, "0", `「${item.label}」未授权时必须写「无数据」，写 0 会被读成确实为零`);
  }

  const gapSlide = dsl.slides.find((s) => s.title === "品牌 vs 竞品差距矩阵");
  assert.ok(
    gapSlide?.blocks.some((b) => b.type === "matrix"),
    "差距页应含象限矩阵（可视化块）",
  );
  assert.ok(
    gapSlide?.blocks.some((b) => b.type === "table"),
    "差距页应含差距表格",
  );
});

test("WP-B-7 报告页数达到方案验收的 15 页下限", () => {
  const dsl = synthReport(brief, { intel: synthIntel(brief, noTools) }, { synthesized: true });
  const depth = measureReportDepth(dsl);
  assert.ok(
    depth.slides >= 15,
    `页数 ${depth.slides} 应 ≥ 15（方案 WP-B 把 13 页扩到 15 页）；当前策略下限为 ${DEFAULT_DEPTH_POLICY.minSlides}`,
  );
});

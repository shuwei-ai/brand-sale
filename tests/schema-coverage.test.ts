/**
 * 骨架 / 块型 / 页面角色的「防漂移」测试（P0-1）
 *
 * 为什么需要它：`Block` 与 `PageRole` 是联合类型，加第 11 种块型（比如 gantt）时，
 * 编译器**不会**提醒你同步这三处：
 *   ① `ReportDslSchema.skeleton`（模型唯一能看到的结构说明）；
 *   ② `validateBlock()` 的 switch（漏 case 会 fallthrough 到 default 报错或静默吞掉）；
 *   ③ `numericClaims()` 的 switch（漏 case = "画了 12 个数字却不写引用"完全漏检）。
 *
 * 这三处一旦漂移都不会报错，只会让报告悄悄变差——所以只能用测试钉死。
 * 运行：npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_TYPES,
  PAGE_ROLES,
  numericClaims,
  type Block,
} from "@brandsale/contracts";
import { ReportDslSchema } from "../packages/agent-pack/src/schemas.ts";

test("骨架覆盖：ReportDslSchema.skeleton 必须包含全部块型、页面角色与关键字段", () => {
  const s = ReportDslSchema.skeleton;

  for (const t of BLOCK_TYPES) {
    assert.match(s, new RegExp(`"type": "${t}"`), `骨架漏了块型 ${t}——模型看不到它，就永远不会用`);
  }
  for (const r of PAGE_ROLES) {
    assert.match(s, new RegExp(r), `骨架漏了 pageRole ${r}`);
  }
  for (const f of ["kind", "ref", "tier", "verifiedBy", "dslVersion", "brand", "exclusions", "window"]) {
    assert.match(s, new RegExp(`"?${f}"?`), `骨架漏了字段 ${f}`);
  }

  // meta 里没有租户字段：模型曾凭空写出 tenantId，与真实类型对不上
  assert.doesNotMatch(s, /tenantId/, "meta 不得出现 tenantId（真实类型没有这个字段）");
});

test("块型全覆盖：每个块型都能被 validate 接受，且都能抽出数字断言", () => {
  const blocks: Record<Block["type"], Block> = {
    text: { type: "text", style: "body", content: "市场规模增长 12%" },
    bullets: { type: "bullets", items: ["声量份额 31%"] },
    kpi: { type: "kpi", items: [{ label: "GMV", value: "1,234", unit: "万元" }] },
    table: { type: "table", columns: ["渠道", "金额"], rows: [["抖音", "150 万"]] },
    chart: { type: "chart", chartType: "bar", series: [{ name: "预算", points: [{ x: "抖音", y: 150 }] }] },
    matrix: { type: "matrix", xLabel: "粉丝量", yLabel: "匹配度", cells: [{ x: 128, y: 86, label: "达人A" }] },
    timeline: { type: "timeline", phases: [{ label: "预热期", from: "2026-05-20", to: "2026-05-31", items: ["预算 20%"] }] },
    quote: { type: "quote", text: "种草占比 45% 时 ROI 最优" },
    callout: { type: "callout", tone: "info", text: "样本量 12 条" },
    image: { type: "image", ref: "https://example.com/a.png", caption: "声量趋势（近 6 个月）" },
  };

  assert.equal(Object.keys(blocks).length, BLOCK_TYPES.length, "本用例必须覆盖全部块型：新增块型时请同步这里");

  for (const t of BLOCK_TYPES) {
    const block = blocks[t];
    assert.ok(block, `块型 ${t} 缺少测试样本`);
    const claims = numericClaims(block);
    assert.ok(claims.length > 0, `numericClaims 未覆盖块型 ${t}——该块型里的数字将不受"无来源数字"检查约束`);
  }
});

test("骨架可产出：用骨架里的全部块型拼一份 DSL，Schema 校验必须通过", () => {
  const dsl = {
    meta: {
      dslVersion: "1.0",
      title: "骨架自检报告",
      brand: { id: "brand_A", name: "品牌A" },
      window: { from: "2026-05-20", to: "2026-06-20" },
      generatedAt: new Date().toISOString(),
    },
    sourceDeclaration: {
      grade: "L3",
      sources: [{ key: "public_intel", displayName: "行业公开情报库（KB-3）", grade: "L3", asOf: "now", coverage: "本地知识库检索命中" }],
      exclusions: [{ key: "qianchuan", reason: "该源已从系统移除" }],
    },
    slides: [
      {
        index: 0,
        pageRole: "cover",
        title: "封面",
        layoutId: "cover/hero",
        blocks: [
          { type: "text", style: "h2", content: "骨架自检" },
          { type: "text", style: "caption", content: "分析窗口 2026-05-20 ~ 2026-06-20" },
        ],
        citations: [],
      },
      {
        index: 1,
        pageRole: "data",
        title: "全块型",
        layoutId: "content/2col",
        blocks: [
          { type: "text", style: "h3", content: "文本块", sourceRef: "phase:intel" },
          { type: "bullets", items: ["要点一"], sourceRef: "phase:intel" },
          { type: "kpi", items: [{ label: "声量", value: "31%", tier: "medium" }] },
          { type: "table", columns: ["a"], rows: [["1"]], caption: "口径：近 30 天" },
          { type: "chart", chartType: "line", series: [{ name: "s", points: [{ x: "5月", y: 1 }] }] },
          { type: "matrix", xLabel: "x", yLabel: "y", cells: [{ x: 1, y: 2, label: "A" }] },
          { type: "timeline", phases: [{ label: "预热", from: "2026-05-20", to: "2026-05-31", items: ["铺量"] }] },
          { type: "callout", tone: "warn", text: "存在估算值", sourceRef: "meta:disclaimer" },
          { type: "quote", text: "引用一句", attribution: "KB-4" },
          { type: "image", ref: "https://example.com/a.png", caption: "示意图" },
        ],
        citations: [
          { claim: "声量 31%", kind: "data_source", ref: { sourceKey: "public_intel" }, grade: "L3", confidence: 0.7, tier: "medium", verifiedBy: "auto" },
        ],
      },
    ],
  };

  const parsed = ReportDslSchema.validate(dsl);
  assert.equal(parsed.slides.length, 2);
  assert.equal(parsed.slides[1]!.blocks.length, 10, "十种块型都应被保留");
});

test("引用校验：缺 kind / kind 与 ref 不自洽 / 推断标非 low 都必须报错", () => {
  const base = {
    meta: { dslVersion: "1.0", title: "t", brand: { id: "b", name: "b" }, window: { from: "a", to: "b" }, generatedAt: "now" },
    sourceDeclaration: { grade: "L3", sources: [{ key: "s1", displayName: "s1", grade: "L3", asOf: "now", coverage: "c" }], exclusions: [] },
    slides: [{ index: 0, pageRole: "content", title: "t", layoutId: "content/x", blocks: [{ type: "kpi", items: [{ label: "GMV", value: "1" }] }], citations: [] }],
  };

  const missingKind = structuredClone(base);
  missingKind.slides[0]!.citations = [{ claim: "c", ref: { sourceKey: "s1" }, grade: "L3", confidence: 0.5, tier: "medium", verifiedBy: "auto" }] as never;
  assert.throws(() => ReportDslSchema.validate(missingKind), /kind/, "缺 kind 必须报错，不得静默兜底");

  const dsWithoutKey = structuredClone(base);
  dsWithoutKey.slides[0]!.citations = [{ claim: "c", kind: "data_source", ref: {}, grade: "L3", confidence: 0.5, tier: "medium", verifiedBy: "auto" }] as never;
  assert.throws(() => ReportDslSchema.validate(dsWithoutKey), /sourceKey/, "kind=data_source 必须有 ref.sourceKey");

  const inferredNotLow = structuredClone(base);
  inferredNotLow.slides[0]!.citations = [{ claim: "c", kind: "model_inference", ref: {}, grade: "L3", confidence: 0.9, tier: "high", verifiedBy: "auto" }] as never;
  assert.throws(() => ReportDslSchema.validate(inferredNotLow), /tier=low/, "模型推断必须标 low");
});

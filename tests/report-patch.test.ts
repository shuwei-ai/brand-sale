/**
 * P1「按页补丁回喂」的契约测试
 *
 * 背景：整份回喂的代价是输出 4 万 token / 10–20 分钟，而且会**顺手改坏别的页**
 * （真机 job_0mv9k0wvg8vvpwmqd9y：为修 slides[9] 的 matrix 重写整份，同一块依旧漏 sourceRef）。
 * P1 改成"只重写出问题的那几页"，再用 `mergePatchedPages` 按 index 对位替换回原 DSL。
 *
 * 这里钉的是补丁模式**不能破的四条**：
 *   ① 补丁页的校验必须与整份 schema **同一份规则**（不许各写一套，否则生成期过、渲染期不过）；
 *   ② 只替换被点名的页，页序与页数不变（模型没有增删页的权限）；
 *   ③ 不认识的 index 一律忽略（否则会多出重复页，页码/目录全错）；
 *   ④ 补丁把页掏空时保留原页（"这不是修复而是删内容"）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mergePatchedPages, ReportPagePatchSchema } from "@brandsale/agent-pack";
import {
  LOGICAL_REFS,
  validateReportDsl,
  type Block,
  type ReportDsl,
  type SlideSpec,
  type SourceCatalog,
} from "@brandsale/contracts";

const CATALOG: SourceCatalog = {
  entries: [
    { key: "mc_xhs", displayName: "小红书公开内容", grade: "L3", origin: "external", asOf: "2026-10-12", coverage: "search" },
  ],
  logicalRefs: [...LOGICAL_REFS],
};

const slide = (index: number, blocks: Block[], citations: SlideSpec["citations"] = [], pageRole: SlideSpec["pageRole"] = "data"): SlideSpec => ({
  index,
  pageRole,
  title: `页 ${index}`,
  layoutId: "content/default",
  blocks,
  citations,
});

const dsl = (slides: SlideSpec[]): ReportDsl => ({
  meta: {
    dslVersion: "1.0",
    title: "测试报告",
    brand: { id: "b1", name: "品牌" },
    window: { from: "2026-10-01", to: "2026-10-31" },
    generatedAt: "2026-10-18T00:00:00.000Z",
  },
  sourceDeclaration: {
    grade: "L3",
    sources: [{ key: "mc_xhs", displayName: "小红书公开内容", grade: "L3", asOf: "2026-10-12", coverage: "search" }],
    exclusions: [],
  },
  slides,
});

const matrixBlock = (sourceRef?: string): Block =>
  ({
    type: "matrix",
    xLabel: "阶段",
    yLabel: "渠道",
    cells: [{ x: 1, y: 1, label: "抖音 P1: 45万" }],
    ...(sourceRef ? { sourceRef } : {}),
  }) as Block;

/* ① ───────────────────────────────────────────────────── */

test("⑲ 补丁 schema 复用整份的页校验：同一份规则，不是另一套", () => {
  const ok = ReportPagePatchSchema.validate({
    slides: [
      {
        index: 3,
        pageRole: "data",
        title: "预算分配",
        blocks: [{ type: "table", columns: ["渠道", "预算"], rows: [["抖音", "150 万"]], sourceRef: "phase:budget" }],
        citations: [],
      },
    ],
  });
  assert.equal(ok.slides.length, 1);
  assert.equal(ok.slides[0]!.index, 3);
  assert.equal(ok.slides[0]!.blocks[0]!.type, "table");

  // 与整份 schema 同源：citation 缺 kind 在两边都必须报同一句话
  assert.throws(
    () =>
      ReportPagePatchSchema.validate({
        slides: [{ index: 0, pageRole: "data", title: "x", blocks: [{ type: "text", style: "body", content: "y" }], citations: [{ claim: "c" }] }],
      }),
    /kind 缺失/,
    "补丁页的引用缺 kind 必须报错（兜底成 model_inference 会把漏字段洗成合法引用）",
  );

  // 空补丁视为失败：没有页被重写却消耗了一轮，不该被当成"修好了"
  assert.throws(() => ReportPagePatchSchema.validate({ slides: [] }), /slides/);

  // 块型字段不全也必须报错（与整份一致：漏 series 的 chart 会在渲染期崩）
  assert.throws(
    () => ReportPagePatchSchema.validate({ slides: [{ index: 0, pageRole: "data", title: "x", blocks: [{ type: "chart" }], citations: [] }] }),
    /series/,
  );
});

/* ②③④ ────────────────────────────────────────────────── */

test("⑳ 补丁合并：只换被点名的页，页序与页数不变", () => {
  const base = dsl([
    slide(0, [matrixBlock()]),
    slide(1, [matrixBlock()]),
    slide(2, [matrixBlock()]),
  ]);

  const { dsl: merged, replaced, ignored } = mergePatchedPages(base, [
    slide(1, [matrixBlock("phase:budget"), { type: "callout", tone: "info", text: "补充口径", sourceRef: "phase:budget" }]),
    // 不认识的页号：忽略，不许凭空加页 / 重复页
    slide(9, [matrixBlock("phase:budget")]),
  ]);

  assert.deepEqual(replaced, [1], "只有 slides[1] 被替换");
  assert.deepEqual(ignored, [9], "不存在的页号必须记进 ignored");
  assert.equal(merged.slides.length, 3, "页数不变（模型没有增删页的权限）");
  assert.deepEqual(merged.slides.map((s) => s.index), [0, 1, 2], "页序不变");
  assert.equal(merged.slides[1]!.blocks.length, 2, "目标页换成补丁内容");
  assert.equal(merged.slides[0]!.blocks.length, 1, "没被点名的页一字未动");
  assert.equal((merged.slides[1]!.blocks[0] as { sourceRef?: string }).sourceRef, "phase:budget");
});

test("㉑ 补丁合并的掏空保护：块数腰斩时保留原页（这不是修复，是删内容）", () => {
  const base = dsl([
    slide(0, [matrixBlock(), matrixBlock(), matrixBlock(), matrixBlock()]),
  ]);

  const { dsl: merged, replaced, ignored } = mergePatchedPages(base, [
    // 4 块 → 1 块：模型被要求"补 sourceRef"时把整页写成一句话（真机见过）
    slide(0, [{ type: "text", style: "body", content: "详见附录", sourceRef: "phase:brief" }]),
  ]);

  assert.deepEqual(replaced, [], "不许采纳");
  assert.deepEqual(ignored, [0], "被拒的页要留痕，便于观察模型在偷懒");
  assert.equal(merged.slides[0]!.blocks.length, 4, "原页必须完整保留");
});

test("㉒ 补丁 index 被钉回原值：模型写错 index 也漂不了页序", () => {
  const base = dsl([slide(0, [matrixBlock()]), slide(1, [matrixBlock()])]);
  const { dsl: merged } = mergePatchedPages(base, [
    // index 用来定位，替换后必须原样保留原页的 index
    slide(1, [matrixBlock("phase:budget")]),
  ]);
  assert.deepEqual(merged.slides.map((s) => s.index), [0, 1]);
});

/* ⑤ 端到端价值 ──────────────────────────────────────────── */

test("㉓ 真机形态：slides[9] 的 matrix 漏 sourceRef → 补丁补上即闭合，不必重写整份", () => {
  /* 复刻 job_0mv9k0wvg8vvpwmqd9y 的 slides[9]：含数字的 matrix、无 sourceRef、本页没有任何可用 citation。
   * 这种形态 R6 报的是 `repairable: undefined`（系统不许凭空给数字块编一个来源），只能靠模型补——
   * 也正是旧实现里"整份回喂 23 分钟"的那一条。 */
  const base = dsl([slide(0, [matrixBlock()]), slide(1, [{ type: "text", style: "body", content: "背景" }])]);

  const before = validateReportDsl(base, { catalog: CATALOG }).issues.filter((i) => i.level === "error");
  assert.equal(before.length, 1, "先确认这条形态确实不可机械修复");
  assert.equal(before[0]!.repairable, undefined);
  assert.match(before[0]!.path, /^slides\[0\]/);

  const { dsl: merged } = mergePatchedPages(base, [slide(0, [matrixBlock("phase:budget")])]);
  const after = validateReportDsl(merged, { catalog: CATALOG }).issues.filter((i) => i.level === "error");
  assert.equal(after.length, 0, "只换一页就闭合——输出量从整份 4 万 token 降到 1 页");
  assert.equal(merged.slides.length, 2, "其余页原样保留");
  assert.equal(merged.slides[1]!.blocks[0]!.type, "text");
});

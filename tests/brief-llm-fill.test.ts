/**
 * WP-C LLM 补全段测试。
 *
 * 这里要钉住的不是"模型能不能补字段"，而是**规则结果的权威性**：
 * 模型只能填规则没抽到的字段，绝不能改写规则已经确定的预算/时间窗。
 * 预算与时间窗决定了整份排期，被模型悄悄改掉的话，
 * 报告会基于一个用户从未同意的数字展开，而且没有任何地方能看出来。
 *
 * 运行：npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBriefUtterance, type Brief } from "@brandsale/contracts";
import type { ModelGateway } from "@brandsale/model-gateway";
import { completeBriefDraft } from "@brandsale/agent-pack";

const NOW = new Date("2026-10-08T10:00:00+08:00");

type StubResult =
  | { kind: "ok"; raw: string }
  | { kind: "fail"; code: "E-AGENT-001" | "E-AGENT-002" }
  | { kind: "throw" };

/** 只实现 completeJson 的最小网关替身；记录被调用次数以断言"该不该调" */
function stubGateway(res: StubResult): { gateway: ModelGateway; calls: () => number } {
  let calls = 0;
  const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
  const zeroCost = { currency: "CNY" as const, amount: 0 };
  const gateway = {
    async completeJson(): Promise<unknown> {
      calls += 1;
      if (res.kind === "throw") throw new Error("连接模型失败");
      if (res.kind === "ok") {
        return { ok: true, value: {}, raw: res.raw, usage: zeroUsage, cost: zeroCost, model: "stub", mocked: true, retries: 0 };
      }
      return { ok: false, code: res.code, errors: ["stub"], raw: "", usage: zeroUsage, cost: zeroCost, model: "stub" };
    },
  } as unknown as ModelGateway;
  return { gateway, calls: () => calls };
}

const noSignal = { jobId: "job_test" };

test("WP-C-LLM-1 规则段已抽全时不调模型（不烧 token，也不给模型改写的窗口）", async () => {
  const draft = parseBriefUtterance(
    "双11 小红书抖音投精华，预算 300 万，要曝光也要销量",
    undefined,
    NOW,
  );
  assert.deepEqual(draft.missing, []);
  const { gateway, calls } = stubGateway({ kind: "throw" }); // 若被调用会抛错，从而暴露"不该调"
  const out = await completeBriefDraft("双11 小红书抖音投精华，预算 300 万，要曝光也要销量", draft, {
    gateway,
    ...noSignal,
  });
  assert.equal(calls(), 0, "关键字段齐全时一次模型调用都不该有");
  assert.equal(out.source, "rule");
  assert.deepEqual(out.brief, draft.brief);
});

test("WP-C-LLM-2 模型只能补缺失字段：试图改写规则已确定的预算必须被丢弃", async () => {
  const utterance = "Q4 抖音投放，预算 200 万，要曝光和转化";
  const draft = parseBriefUtterance(utterance, undefined, NOW);
  assert.deepEqual(draft.missing, ["industry", "category"]);

  const { gateway } = stubGateway({
    kind: "ok",
    raw: JSON.stringify({
      brief: {
        // 越权：这两个字段规则段已经定了，模型不得改写
        budget: { amount: 99_000_000 },
        window: { from: "2020-01-01", to: "2020-01-02" },
        // 该补的
        industry: "美妆个护",
        category: "护肤品-精华",
      },
      clarifications: [],
    }),
  });

  const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });

  assert.equal(out.brief.budget?.amount, 2_000_000, "模型不得改写规则抽出的预算");
  assert.deepEqual({ from: out.brief.window?.from, to: out.brief.window?.to }, { from: "2026-10-01", to: "2026-12-31" }, "模型不得改写规则抽出的时间窗");
  assert.equal(out.brief.industry, "美妆个护", "缺失字段应被补上");
  assert.equal(out.brief.category, "护肤品-精华");
  assert.deepEqual(out.filledByModel, ["industry", "category"]);
  assert.deepEqual(out.missing, []);
  assert.equal(out.source, "rule+llm");
});

test("WP-C-LLM-3 模型返回的形状不可信：越界平台与非日期窗口都要被丢掉", async () => {
  const utterance = "抖音投放，预算 100 万，要曝光和转化";
  const draft = parseBriefUtterance(utterance, undefined, NOW);
  const { gateway } = stubGateway({
    kind: "ok",
    raw: JSON.stringify({
      brief: {
        industry: "美妆个护",
        platforms: ["zhihu", "douyin"], // 只保留受支持的
        window: { from: "下个月", to: "月底" }, // 不是 ISO 日期 → 丢弃
      },
      clarifications: ["请问具体品类？"],
    }),
  });

  const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });
  assert.equal(out.brief.industry, "美妆个护");
  assert.deepEqual(out.brief.platforms, ["douyin"], "不在 POPULAR_PLATFORMS 里的平台必须被丢弃（规则段的 platforms 本就已定，这里指被 model 覆盖的部分不可信）");
  // window 规则段没抽到（"下个月"这类相对表述不在规则覆盖范围），模型给的不是 ISO 日期 → 仍缺失
  assert.deepEqual(out.missing.includes("window"), true, "非法窗口不应被采纳");
  assert.deepEqual(out.clarifications, ["请问具体品类？"], "模型提出的澄清要透传给前端");
  assert.equal(out.source, "rule+llm", "模型成功参与过（哪怕只是提问），source 就该体现出来");
});

test("WP-C-LLM-4 模型不可用不抛异常，退回规则结果并给出提示", async () => {
  const utterance = "Q4 抖音投放，预算 200 万，要曝光和转化";
  const draft = parseBriefUtterance(utterance, undefined, NOW);

  for (const res of [{ kind: "fail", code: "E-AGENT-002" } as const, { kind: "throw" } as const]) {
    const { gateway } = stubGateway(res);
    const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });
    assert.equal(out.source, "rule", "模型没走通就如实标成 rule");
    assert.equal(out.brief.budget?.amount, 2_000_000, "规则结果必须完整保留");
    assert.deepEqual(out.missing, ["industry", "category"], "缺失字段仍要如实列出");
    assert.ok(out.llmNote && /AI 补全/.test(out.llmNote), "要给前端一个可展示的降级提示");
  }
});

test("WP-C-LLM-5 模型输出不是合法 JSON 时同样降级，不炸", async () => {
  const utterance = "Q4 抖音投放，预算 200 万，要曝光和转化";
  const draft = parseBriefUtterance(utterance, undefined, NOW);
  const { gateway } = stubGateway({ kind: "ok", raw: "{ 这不是 JSON" });
  const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });
  assert.equal(out.source, "rule");
  assert.equal(out.brief.budget?.amount, 2_000_000);
  assert.ok(out.llmNote);
});

test("WP-C-LLM-6 表单默认值不会被模型的缺失输出抹掉", async () => {
  const defaults: Partial<Brief> = { brandIds: ["brand_A"], industry: "家居" };
  const utterance = "Q4 抖音投放，预算 200 万，要曝光和转化";
  const draft = parseBriefUtterance(utterance, defaults, NOW);
  assert.deepEqual(draft.brief.brandIds, ["brand_A"], "文本没提品牌，应沿用表单里的值");

  const { gateway } = stubGateway({ kind: "ok", raw: JSON.stringify({ brief: {}, clarifications: [] }) });
  const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });
  assert.deepEqual(out.brief.brandIds, ["brand_A"]);
  assert.equal(out.brief.industry, "家居", "模型没给 industry 时，也不该把表单里的默认值弄丢");
});

test("WP-C-LLM-7 原话里点名品牌时，即使关键字段已齐也要问模型摘录 brandIds", async () => {
  // 用户原话（历史上真实提过的 case）：品牌名夹在中文里，规则段无品牌解析器，只能靠模型摘录
  const utterance = "想在抖音与小红书 投放 精华 关注 欧莱雅、适乐肤品牌需要明星代言，你需要挖掘相关信息";
  // 前端总会带上预算/时间窗默认值，于是 missing 为空 —— 旧实现在这里直接 return，模型一次都不调
  const defaults: Partial<Brief> = {
    budget: { currency: "CNY", amount: 3_000_000 },
    window: { from: "2026-10-27", to: "2026-11-26" },
  };
  const draft = parseBriefUtterance(utterance, defaults, NOW);
  assert.deepEqual(draft.missing, [], "前置条件：关键字段已由默认值补齐");

  const { gateway, calls } = stubGateway({
    kind: "ok",
    raw: JSON.stringify({ brief: { brandIds: ["欧莱雅", "适乐肤"] }, clarifications: [] }),
  });
  const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });

  assert.equal(calls(), 1, "有品牌语境时必须问一次模型");
  assert.deepEqual(out.brief.brandIds, ["欧莱雅", "适乐肤"], "品牌名要原样摘录");
  assert.deepEqual(out.filledByModel, ["brandIds"], "让前端知道哪个字段是模型给的");
  assert.ok(out.filled.includes("brandIds"), "filled 要含 brandIds，前端据此提示『已识别品牌』");
  assert.deepEqual(out.missing, [], "brandIds 是可选字段，不该把自己算进缺失清单");
  assert.equal(out.source, "rule+llm");
});

test("WP-C-LLM-9 直接点名品牌但不写「品牌」元词时，关键字段齐全也要问模型摘录", async () => {
  // 真实 case：用户只说「波司登或鸭鸭羽绒服的明星同款投放」，一个品牌元词都没有。
  // 旧实现 BRAND_CONTEXT_RE 只认「品牌/竞品/竞对/对标/牌子」，这里 wantBrands=false，
  // 叠加 missing 为空 → 直接短路 return，两个品牌被静默丢掉。
  const utterance = "双11 想在小红书和抖音做一波波司登或鸭鸭羽绒服的明星同款投放，预算 300 万，主要要曝光也要销量";
  const defaults: Partial<Brief> = {
    industry: "服饰鞋包",
    category: "羽绒服",
    budget: { currency: "CNY", amount: 3_000_000 },
    window: { from: "2026-11-01", to: "2026-11-11" },
  };
  const draft = parseBriefUtterance(utterance, defaults, NOW);
  assert.deepEqual(draft.missing, [], "前置条件：关键字段已由默认值补齐，模型唯一要补的就是 brandIds");

  const { gateway, calls } = stubGateway({
    kind: "ok",
    raw: JSON.stringify({ brief: { brandIds: ["波司登", "鸭鸭"] }, clarifications: [] }),
  });
  const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });

  assert.equal(calls(), 1, "直接点名品牌（即使无「品牌」元词）时必须问一次模型");
  assert.deepEqual(out.brief.brandIds, ["波司登", "鸭鸭"], "品牌名要原样摘录");
  assert.deepEqual(out.filledByModel, ["brandIds"]);
  assert.ok(out.filled.includes("brandIds"));
  assert.equal(out.source, "rule+llm");
});

test("WP-C-LLM-8 原话没提品牌时，模型越权返回的 brandIds 必须被丢弃", async () => {
  const utterance = "Q4 抖音投放，预算 200 万，要曝光和转化";
  const draft = parseBriefUtterance(utterance, undefined, NOW);
  assert.deepEqual(draft.missing, ["industry", "category"]);

  const { gateway } = stubGateway({
    kind: "ok",
    raw: JSON.stringify({
      brief: { industry: "美妆个护", category: "护肤品-精华", brandIds: ["欧莱雅"] },
      clarifications: [],
    }),
  });
  const out = await completeBriefDraft(utterance, draft, { gateway, ...noSignal });

  assert.equal(out.brief.brandIds, undefined, "没有品牌语境时不得凭空收下品牌（竞品集合会被污染）");
  assert.deepEqual(out.filledByModel, ["industry", "category"], "只有缺失字段能进 filledByModel");
  assert.equal(out.brief.industry, "美妆个护", "其余缺失字段的补全不受影响");
});

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

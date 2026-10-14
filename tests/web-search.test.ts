/**
 * 唯一外部数据源（`volc_web_search`）自检
 *
 * 运行：npm test —— 全部在 mock 模式下跑，**打桩 globalThis.fetch**，不发任何真实外部请求。
 *
 * 为什么这些用例必须存在：
 *   联网检索是**全系统唯一**会真正发起外部请求、且**按次计费**的通道。它最大的风险
 *   不是"取不到数据"，而是四个静默错误：
 *     ① 来源被模型参数带偏 —— 闸门去检查了另一个已登记的 sourceId，而真实来源一次都没被检查；
 *     ② 分级写错 —— 公开网页被标成 L1/L2 授权实测，报告据此把数字标成高置信度；
 *     ③ 调用次数失控 —— 模型换着关键词把一个计费接口问到底；
 *     ④ 未配置时仍然把工具暴露给 Agent —— 让模型反复调一个必然失败的工具。
 *   这四个都不会报错，只会累积 —— 所以每一条都要有用例把住，否则它只活在注释里。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@brandsale/config";
import type { TenantContext } from "@brandsale/contracts";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { seed, DEMO_TENANT } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_ds", traceId: "trace_ds", locale: "zh-CN" };
const toolCtx = {
  ctx,
  jobId: "job_ds",
  phase: "intel" as const,
  attempt: 1,
  emit: () => {},
  signal: new AbortController().signal,
};

/* ── 打桩 fetch ─────────────────────────────────────────── */

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown): { sent: Sent[]; restore: () => void } {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const out = handler(url, body);
    // handler 返回 Error 表示"模拟网络层失败"（如 abort），直接抛出
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

/** 火山引擎联网搜索 Lite 的成功响应（字段名保持上游大小写，便于对账） */
const volcOk = (): unknown => ({
  ResponseMetadata: { RequestId: "req-1" },
  Result: {
    ResultCount: 2,
    WebResults: [
      {
        Title: "2026 年精华类目趋势报告",
        SiteName: "行业研究院",
        Url: "https://example.invalid/report-1",
        PublishTime: "2026-09-30T00:00:00Z",
        Snippet: "抗老胜肽与玻色因复配成为主流叙事…",
        Summary: "摘要",
      },
      {
        Title: "广告法功效宣称口径趋严",
        SiteName: "法规解读",
        Url: "https://example.invalid/report-2",
        PublishTime: "2026-08-12T00:00:00Z",
        Snippet: "抗老类内容需避免疗效承诺表述…",
        Summary: "",
      },
    ],
  },
});

/* ── 容器与种子 ─────────────────────────────────────────── */

interface SearchOut {
  result: { query: string; count: number; results: { title: string; siteName: string; url: string }[] };
  provenance: { sourceId: string; tier: string; synthetic: boolean; note: string }[];
  note: string;
}

const KEY_ON = { BM_WEB_SEARCH_API_KEY: "test-key" };

async function freshContainer(env: Record<string, string>): Promise<{ c: Container; dir: string; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-ws-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", ...env });
  const c = createContainer(config);
  const saved = process.env.BM_DATA_DIR;
  process.env.BM_DATA_DIR = dir;
  try {
    await seed();
  } finally {
    if (saved === undefined) delete process.env.BM_DATA_DIR;
    else process.env.BM_DATA_DIR = saved;
  }
  return {
    c,
    dir,
    dispose: () => {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ── 检索本身 ───────────────────────────────────────────── */

test("联网检索：字段透传、L3 分级、请求形态与鉴权头正确", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  const stub = stubFetch(volcOk);
  try {
    assert.ok(c.agentPack.registry.get("web_search"), "配置了 Key 后应注册 web_search");

    const out = (await c.agentPack.registry.invoke(
      "web_search",
      { query: "美妆 精华 类目趋势 2026" },
      "CI",
      toolCtx,
    )) as SearchOut;

    assert.equal(out.result.count, 2);
    assert.equal(out.result.results[0]?.title, "2026 年精华类目趋势报告");
    assert.equal(out.result.results[0]?.siteName, "行业研究院", "来源站点必须保留 —— 报告引用要靠它");
    assert.equal(out.result.results[0]?.url, "https://example.invalid/report-1");

    assert.equal(out.provenance[0]?.tier, "L3", "公开网页检索必须是 L3，不能是 L1/L2");
    assert.equal(out.provenance[0]?.sourceId, "volc_web_search");
    assert.equal(out.provenance[0]?.synthetic, false, "真实抓取的网页不得被标成合成值");
    assert.match(out.provenance[0]?.note ?? "", /未经人工核验/, "L3 但未经核验这件事必须写进口径");

    assert.equal(stub.sent.length, 1);
    assert.equal(stub.sent[0]!.url, "https://open.feedcoopapi.com/search_api/web_search");
    assert.equal(stub.sent[0]!.headers.Authorization, "Bearer test-key", "鉴权头必须带上");
    assert.equal(stub.sent[0]!.body.Query, "美妆 精华 类目趋势 2026");
    assert.equal(stub.sent[0]!.body.SearchType, "web");
  } finally {
    stub.restore();
    dispose();
  }
});

test("联网检索：空查询不发起请求（省一次计费调用）", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  const stub = stubFetch(volcOk);
  try {
    const out = (await c.agentPack.registry.invoke("web_search", { query: "   " }, "CI", toolCtx)) as SearchOut;
    assert.equal(out.result.count, 0);
    assert.equal(stub.sent.length, 0, "空查询不得触达计费端点");
  } finally {
    stub.restore();
    dispose();
  }
});

test("联网检索：闸门检查的是绑定来源，参数里塞一个会被拒的 sourceId 仍然放行", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  const stub = stubFetch(volcOk);
  try {
    /* 这是最关键的一条安全不变量。`l4_example_vendor` 已登记但法务未批准，
     * 直接访问会被闸门拦下。若闸门相信模型自报的 sourceId，这里必然降级；
     * 工具声明了 boundSourceId，闸门检查的是真实来源（volc_web_search），因此应正常放行。
     * —— 放行本身即证明闸门没有被参数带偏。 */
    const out = (await c.agentPack.registry.invoke(
      "web_search",
      { query: "政策法规", sourceId: "l4_example_vendor" },
      "CI",
      toolCtx,
    )) as SearchOut;

    assert.ok(!("degraded" in out) || (out as { degraded?: boolean }).degraded !== true, "不得因参数里的 sourceId 而降级");
    assert.equal(out.provenance[0]?.sourceId, "volc_web_search", "provenance 必须是绑定源");
    assert.equal(stub.sent.length, 1, "应真实触达检索端点");
  } finally {
    stub.restore();
    dispose();
  }
});

test("联网检索：同参数命中缓存，不重复计费", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  const stub = stubFetch(volcOk);
  try {
    await c.agentPack.registry.invoke("web_search", { query: "精华 趋势" }, "CI", toolCtx);
    const afterFirst = stub.sent.length;
    assert.equal(afterFirst, 1);

    const again = (await c.agentPack.registry.invoke("web_search", { query: "精华 趋势" }, "CI", toolCtx)) as SearchOut;
    assert.equal(stub.sent.length, afterFirst, "同参数应命中缓存，不重复检索");
    assert.match(again.provenance[0]?.note ?? "", /命中缓存/);
  } finally {
    stub.restore();
    dispose();
  }
});

test("联网检索：单任务调用上限触发降级后不再触达端点（计费接口必须有界）", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  const stub = stubFetch(volcOk);
  try {
    let capped: { degraded?: boolean; code?: string } | undefined;
    for (let i = 0; i < 60 && !capped; i++) {
      const r = (await c.agentPack.registry.invoke("web_search", { query: `关键词-${i}` }, "CI", toolCtx)) as {
        degraded?: boolean;
        code?: string;
      };
      if (r.degraded) capped = r;
    }
    assert.ok(capped, "超过单任务上限后应降级");
    assert.equal(capped.code, "E-DATA-003");

    const atCap = stub.sent.length;
    await c.agentPack.registry.invoke("web_search", { query: "越界查询" }, "CI", toolCtx);
    assert.equal(stub.sent.length, atCap, "超限后不得再触达计费端点");
  } finally {
    stub.restore();
    dispose();
  }
});

test("联网检索：超时归一化 —— AbortError 被判成超时（E-DATA-001）而不是不可用", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  const stub = stubFetch(() => Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
  try {
    const out = (await c.agentPack.registry.invoke("web_search", { query: "任意" }, "CI", toolCtx)) as {
      degraded?: boolean;
      code?: string;
      reason?: string;
    };
    assert.equal(out.degraded, true);
    assert.equal(out.code, "E-DATA-001", "超时必须分类为超时；否则排障方向会跑偏");
    assert.match(out.reason ?? "", /超时/);
  } finally {
    stub.restore();
    dispose();
  }
});

test("联网检索：上游返回业务错误码时降级并保留原始 code/message", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  const stub = stubFetch(() => ({
    ResponseMetadata: { Error: { Code: "QuotaExceeded", Message: "本月配额已用尽" } },
  }));
  try {
    const out = (await c.agentPack.registry.invoke("web_search", { query: "任意" }, "CI", toolCtx)) as {
      degraded?: boolean;
      code?: string;
      reason?: string;
    };
    assert.equal(out.degraded, true);
    assert.equal(out.code, "E-DATA-002");
    assert.match(out.reason ?? "", /QuotaExceeded/, "原始错误码要保留，便于对账");
  } finally {
    stub.restore();
    dispose();
  }
});

/* ── 注册与合规边界 ──────────────────────────────────────── */

test("未配置 Key 时适配器与工具都不注册，且给出启动告警", async () => {
  const { c, dispose } = await freshContainer({ BM_WEB_SEARCH_API_KEY: "" });
  try {
    assert.equal(c.agentPack.registry.get("web_search"), undefined, "没有 Key 就不该把工具暴露给 Agent");
    // 10 - 1(联网检索缺席) = 9：只有这一条外部源，缺席时其余工具照常
    assert.equal(c.agentPack.registry.list().length, 9, "未配置的外部源不应注册，也不能影响其他工具");
    assert.ok(c.warnings.some((w) => w.includes("BM_WEB_SEARCH_API_KEY")), "应告警说明联网检索能力缺席");
  } finally {
    dispose();
  }
});

test("配置齐全时工具清单里没有任何写能力入口", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  try {
    assert.equal(c.agentPack.registry.list().length, 10, "工具总数应为 10");
    // 工具清单里不得存在任何 mutating 工具：公开采集类工具包普遍读写同包，
    // 这里确认"只读"这条边界真的守住了
    assert.equal(c.agentPack.registry.list().filter((t) => t.policy.mutating).length, 0, "不得注册任何写能力工具");
  } finally {
    dispose();
  }
});

test("唯一外部源进报告来源目录，L4 未法务批准仍被排除", async () => {
  const { c, dispose } = await freshContainer(KEY_ON);
  try {
    const catalog = c.agentPack.sourceCatalog(ctx);
    const keys = catalog.entries.map((e) => e.key);
    assert.ok(
      keys.includes("volc_web_search"),
      "volc_web_search 应出现在来源目录里 —— 否则报告无法声明这一来源，引用校验会把合法数字判成 model_inference",
    );

    const entry = catalog.entries.find((e) => e.key === "volc_web_search");
    assert.equal(entry?.grade, "L3", "公开源的分级必须是 L3（不得被标成 L1）");
    assert.equal(entry?.origin, "external", "应在来源声明里体现为外部源");

    assert.ok(!keys.includes("l4_example_vendor"), "L4 未过法务不得进来源目录");
  } finally {
    dispose();
  }
});

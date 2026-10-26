/**
 * 七个平台内容采集工具与适配器的自检。
 *
 * 运行：npm test —— 全部打桩 `globalThis.fetch`，**不触碰 MediaCrawler**，也不发起真实采集。
 *
 * 为什么必须有用例把住这几条：
 *   1. **许可证闸**：MediaCrawler 是非商用许可（NON-COMMERCIAL LEARNING LICENSE 1.1）。
 *      未显式确认就不得装配 —— 这条一旦回归，等于悄悄把非商用组件放进商业交付链路。
 *   2. **来源绑定**：七个工具各绑各的 `mc_*` 源。绑定错了（或让模型参数决定来源），
 *      闸门就会去检查另一个已登记的源，而工具真正打的源一次都没被检查。
 *   3. **分级口径**：平台公开内容必须是 L3 + synthetic=false + note 写明"未经人工核验"。
 *   4. **空结果不缓存**：首次无数据时要能"排队采集 → 下次重试拿到"，不能被自己的缓存堵死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, MEDIA_CRAWLER_PLATFORM_META, MEDIA_CRAWLER_PLATFORMS, comparableCommentMetrics, comparableContentMetrics } from "@brandsale/config";
import { POPULAR_PLATFORMS, type Brief, type TenantContext } from "@brandsale/contracts";
import { MEDIA_CRAWLER_SOURCE_IDS } from "@brandsale/datasource";
import { BRIEF_PLATFORM_TO_MC, PHASE_TOOL_HINT, PLATFORM_DIGEST_TOOL_NAME, PLATFORM_TOOL_NAME, needsPlatformRefresh, platformPrefetchArgs, toEvidenceEntries } from "@brandsale/agent-pack";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { seed, DEMO_TENANT } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_mc", traceId: "trace_mc", locale: "zh-CN" };
const toolCtx = {
  ctx,
  jobId: "job_mc",
  phase: "intel" as const,
  attempt: 1,
  emit: () => {},
  signal: new AbortController().signal,
};

/** 与 e2e 用例同形的最小 brief：两个平台，足以覆盖 brief→采集码映射与"覆盖范围"相关断言 */
const BRIEF: Brief = {
  industry: "美妆",
  category: "护肤品-精华",
  brandIds: ["brand_A"],
  budget: { currency: "CNY", amount: 3_000_000 },
  objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
  window: { from: "2026-05-20", to: "2026-06-20" },
  platforms: ["douyin", "xiaohongshu"],
};

async function waitDone(c: Container, jobId: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await c.orchestrator.getJob(jobId, DEMO_TENANT);
    if (job && ["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return;
    if (Date.now() > deadline) throw new Error(`等待任务 ${jobId} 超时`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/** 打桩 fetch；handler 返回 Error 表示网络层失败，返回 {status, body} 表示 HTTP 响应 */
function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown): { sent: Sent[]; restore: () => void } {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, body });
    const out = handler(url, body);
    if (out instanceof Error) throw out;
    const shaped = out as { status?: number; body: unknown };
    return new Response(JSON.stringify(shaped.body ?? shaped), {
      status: shaped.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const COLLECTOR = "http://collector.invalid:8890";
const MC_ON = { BM_MC_ENABLED: "true", BM_MC_LICENSE_ACK: "true", BM_MC_COLLECTOR_URL: COLLECTOR };

async function freshContainer(env: Record<string, string>): Promise<{ c: Container; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-mc-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", BM_WEB_SEARCH_API_KEY: "", ...env });
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
    dispose: () => {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 一条符合 collector /query 契约的响应 */
const queryOk = (rows: Record<string, unknown>[]) => ({
  body: {
    platform: "xhs",
    rows,
    meta: { total: rows.length, returned: rows.length, collectedAt: "2026-10-09T08:00:00.000Z", sourceId: "mc_xhs" },
  },
});

const collectOk = { status: 202, body: { ok: true, reused: false, task: { id: "ct_1", state: "running" } } };

/* ── 1. 许可证闸 ─────────────────────────────────────────── */

test("未确认许可时，七个平台工具都不装配，来源目录里也没有它们", async () => {
  // BM_MC_ENABLED=true 但 LICENSE_ACK=false —— 这正是"顺手配了地址"的典型形态
  const { c, dispose } = await freshContainer({ BM_MC_ENABLED: "true", BM_MC_COLLECTOR_URL: COLLECTOR });
  try {
    assert.equal(c.config.mediaCrawler.licenseAcknowledged, false);
    for (const p of MEDIA_CRAWLER_PLATFORMS) {
      assert.equal(c.agentPack.registry.get(PLATFORM_TOOL_NAME[p]), undefined, `${PLATFORM_TOOL_NAME[p]} 工具不应注册`);
    }
    // 适配器是否装配由来源目录反映（能力就绪才进目录）
    const keys = c.agentPack.sourceCatalog(ctx).entries.map((e) => e.key);
    for (const id of MEDIA_CRAWLER_SOURCE_IDS) {
      assert.ok(!keys.includes(id), `${id} 适配器不应装配`);
    }
    // 非平台工具照常
    assert.ok(c.agentPack.registry.get("kb_retrieve"), "本地检索与平台采集无关，应照常注册");
  } finally {
    dispose();
  }
});

test("未配置 collector 地址时同样不装配（三道门缺一不可）", async () => {
  const { c, dispose } = await freshContainer({ BM_MC_ENABLED: "true", BM_MC_LICENSE_ACK: "true" });
  try {
    for (const p of MEDIA_CRAWLER_PLATFORMS) {
      assert.equal(c.agentPack.registry.get(PLATFORM_TOOL_NAME[p]), undefined);
    }
  } finally {
    dispose();
  }
});

test("平台开关可逐个收窄：BM_MC_PLATFORMS 只留两个平台", async () => {
  const { c, dispose } = await freshContainer({ ...MC_ON, BM_MC_PLATFORMS: "xhs,dy" });
  try {
    assert.ok(c.agentPack.registry.get("xhs_web"));
    assert.ok(c.agentPack.registry.get("douyin_web"));
    assert.equal(c.agentPack.registry.get("zhihu_web"), undefined, "未启用的平台不得暴露工具");
    const keys = c.agentPack.sourceCatalog(ctx).entries.map((e) => e.key);
    assert.ok(keys.includes("mc_xhs") && keys.includes("mc_dy"));
    assert.ok(!keys.includes("mc_zhihu"), "未启用的平台适配器也不应装配");
  } finally {
    dispose();
  }
});

/* ── 2. 装配齐全时的形态 ─────────────────────────────────── */

test("许可确认 + collector 已配时，七源七工具就位且来源绑定正确", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  try {
    const byKey = new Map(c.agentPack.sourceCatalog(ctx).entries.map((e) => [e.key, e]));
    for (const p of MEDIA_CRAWLER_PLATFORMS) {
      const meta = MEDIA_CRAWLER_PLATFORM_META[p];
      const entry = byKey.get(meta.sourceId);
      assert.ok(entry, `${meta.sourceId} 适配器应装配（应进来源目录）`);
      assert.equal(entry.grade, "L3", "平台公开内容一律 L3");

      const tool = c.agentPack.registry.get(PLATFORM_TOOL_NAME[p]);
      assert.ok(tool, `${PLATFORM_TOOL_NAME[p]} 工具应注册`);
      // 来源由工具声明、不由模型参数决定 —— 这条是闸门有效性的前提
      assert.equal(tool.policy.boundSourceId, meta.sourceId, `${PLATFORM_TOOL_NAME[p]} 必须绑死 ${meta.sourceId}`);
      assert.equal(tool.policy.mutating, false, "采集是只读的，绝不能标成写工具");
      assert.deepEqual(tool.policy.allowedAgents, ["CI", "CT"], "白名单应只给情报与选人两个角色");
      assert.ok(tool.policy.governance.includes("authz"), "必须过授权检查");
    }
  } finally {
    dispose();
  }
});

test("工具清单里有平台工具时，仍然没有任何写能力入口", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  try {
    const mutating = c.agentPack.registry.list().filter((t) => t.policy.mutating);
    assert.deepEqual(mutating, [], "采集链路只能读，任何写能力都不允许出现在清单里");
  } finally {
    dispose();
  }
});

/* ── 3. 调用路径 ─────────────────────────────────────────── */

test("平台工具：请求打到 collector /query，字段透传且 provenance 为 L3 未核验", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url) => {
    if (url.endsWith("/query")) {
      return queryOk([
        { id: "n_1", title: "精华怎么选", text: "抗老实测", author: "成分党", authorId: "u_1", url: "https://x.invalid/1", publishedAt: "2026-09-01T00:00:00.000Z", metrics: { likes: 120, collects: 33 } },
      ]);
    }
    throw new Error(`未预期的请求：${url}`);
  });
  try {
    const out = (await c.agentPack.registry.invoke("xhs_web", { op: "search", keyword: "精华" }, "CI", toolCtx)) as {
      result: { count: number; rows: { id: string; metrics: Record<string, number> }[]; platformName: string };
      provenance: { sourceId: string; tier: string; synthetic: boolean; note: string; rowCount: number }[];
    };

    assert.equal(out.result.count, 1);
    assert.equal(out.result.platformName, "小红书");
    assert.equal(out.result.rows[0]?.id, "n_1");
    assert.equal(out.result.rows[0]?.metrics.likes, 120);

    assert.equal(out.provenance[0]?.sourceId, "mc_xhs");
    assert.equal(out.provenance[0]?.tier, "L3");
    assert.equal(out.provenance[0]?.synthetic, false);
    assert.match(out.provenance[0]?.note ?? "", /未经人工核验/, "L3 但未经核验这件事必须写进口径");
    assert.match(out.provenance[0]?.note ?? "", /无授权合同/, "与平台无授权合同这一点也必须写明");

    assert.equal(stub.sent.length, 1, "有数据时不应再投递采集");
    assert.equal(stub.sent[0]!.url, `${COLLECTOR}/query`);
    assert.equal(stub.sent[0]!.body.platform, "xhs");
    assert.equal(stub.sent[0]!.body.op, "search");
    assert.equal(stub.sent[0]!.body.keyword, "精华");
  } finally {
    stub.restore();
    dispose();
  }
});

test("平台工具：本地无数据时投递一次采集，并在说明里给出下一步", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url, body) => {
    if (url.endsWith("/query")) return queryOk([]);
    if (url.endsWith("/collect")) {
      // 断言投递内容正确：算子与关键词都要带过去，否则后台采的是"空关键词"
      assert.equal(body.platform, "xhs");
      assert.equal(body.op, "search");
      assert.deepEqual(body.params, { keyword: "精华" });
      return collectOk;
    }
    throw new Error(`未预期的请求：${url}`);
  });
  try {
    const out = (await c.agentPack.registry.invoke("xhs_web", { op: "search", keyword: "精华" }, "CI", toolCtx)) as {
      result: { count: number; note: string };
      provenance: { note: string }[];
    };
    assert.equal(out.result.count, 0);
    assert.match(out.result.note, /后台排队采集/, "空结果必须告诉模型'已排队、稍后重试'，而不是让它以为这里没有数据");
    assert.match(out.provenance[0]?.note ?? "", /已排队采集/);

    const urls = stub.sent.map((s) => s.url);
    assert.deepEqual(urls, [`${COLLECTOR}/query`, `${COLLECTOR}/collect`]);
  } finally {
    stub.restore();
    dispose();
  }
});

test("平台工具：空结果不进缓存，重试能拿到后续采到的数据", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  let queryCount = 0;
  const stub = stubFetch((url) => {
    if (url.endsWith("/query")) {
      queryCount++;
      // 第一次空、第二次有数据 —— 模拟"排队采集后数据到货"
      return queryOk(queryCount === 1 ? [] : [{ id: "n_1", title: "到货了", text: "", author: "", authorId: "", url: "", publishedAt: "", metrics: {} }]);
    }
    return collectOk;
  });
  try {
    const first = (await c.agentPack.registry.invoke("xhs_web", { op: "search", keyword: "精华" }, "CI", toolCtx)) as { result: { count: number } };
    assert.equal(first.result.count, 0);
    const second = (await c.agentPack.registry.invoke("xhs_web", { op: "search", keyword: "精华" }, "CI", toolCtx)) as { result: { count: number } };
    assert.equal(second.result.count, 1, "第二次调用必须真的再打一次 collector —— 空结果被缓存的话这里会永远是 0");
  } finally {
    stub.restore();
    dispose();
  }
});

test("适配器缓存：命中与否是结构化字段，「本次无本地缓存」不得被记成命中", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const row = { id: "n_1", title: "到货了", text: "", author: "", authorId: "", url: "", publishedAt: "", metrics: {} };
  let queryCount = 0;
  const stub = stubFetch((url) => {
    if (url.endsWith("/query")) {
      queryCount++;
      // 第一次到货，之后走本地缓存
      return queryOk([row]);
    }
    return collectOk;
  });
  try {
    const first = (await c.agentPack.registry.invoke("xhs_web", { op: "search", keyword: "精华" }, "CI", toolCtx)) as {
      provenance: { cacheHit?: boolean; note: string }[];
    };
    assert.equal(first.provenance[0]?.cacheHit, false, "第一次是真打了一次采集服务");

    const second = (await c.agentPack.registry.invoke("xhs_web", { op: "search", keyword: "精华" }, "CI", toolCtx)) as {
      provenance: { cacheHit?: boolean; note: string }[];
    };
    assert.equal(second.provenance[0]?.cacheHit, true, "第二次命中本地缓存，必须由结构化字段表达");
    assert.equal(queryCount, 1, "命中缓存时不该再打采集服务");
  } finally {
    stub.restore();
    dispose();
  }
});

test("平台工具：本地无数据时 cacheHit 必须是 false（否则「未命中」被记成「命中」）", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url) => (url.endsWith("/query") ? queryOk([]) : collectOk));
  try {
    const out = (await c.agentPack.registry.invoke("xhs_web", { op: "search", keyword: "精华" }, "CI", toolCtx)) as {
      provenance: { cacheHit?: boolean; note: string }[];
    };
    // 说明文案里含"本次无本地缓存" —— 台账早期就是被这五个字骗出的 cached=true
    assert.match(out.provenance[0]?.note ?? "", /无本地缓存/);
    assert.equal(out.provenance[0]?.cacheHit, false, "空结果不进缓存，也就谈不上命中");
  } finally {
    stub.restore();
    dispose();
  }
});

test("调用上限只约束模型：阶段收尾的系统补取不计入 maxCallsPerJob", async () => {
  // 为什么要专门钉住这条：上限是防模型换关键词放射式采集的（8 次），但实测模型能在
  // 2 分钟内把额度烧光 —— 若系统自己的收尾补取也被挡下，"数据到了报告却拿不到"这个
  // 事故形态就会原样复现（补取是那条链上唯一的救命绳）。
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url) => (url.endsWith("/query") ? queryOk([]) : collectOk));
  try {
    const args = { op: "search", keyword: "精华", platforms: ["xhs"] };
    for (let i = 0; i < 8; i++) {
      await c.agentPack.registry.invoke(PLATFORM_DIGEST_TOOL_NAME, args, "CI", toolCtx);
    }
    const ninth = (await c.agentPack.registry.invoke(PLATFORM_DIGEST_TOOL_NAME, args, "CI", toolCtx)) as {
      degraded?: boolean;
      reason?: string;
    };
    assert.equal(ninth.degraded, true, "第 9 次（模型发起）必须被单任务上限挡下");

    const system = (await c.agentPack.registry.invoke(PLATFORM_DIGEST_TOOL_NAME, args, "CI", {
      ...toolCtx,
      systemCall: true,
    })) as { degraded?: boolean; result?: unknown };
    assert.equal(system.degraded, undefined, "系统补取必须豁免上限并真正执行");
    assert.ok(system.result, "系统补取要返回正常结果（而不是降级空壳）");
  } finally {
    stub.restore();
    dispose();
  }
});

test("平台工具：非法算子不抛错，而是回一条可操作的说明", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch(() => {
    throw new Error("非法算子不应触达 collector");
  });
  try {
    const out = (await c.agentPack.registry.invoke("xhs_web", { op: "fans" }, "CI", toolCtx)) as {
      result: { rows: unknown[]; validOps: string[]; note: string };
    };
    assert.deepEqual(out.result.rows, []);
    assert.deepEqual(out.result.validOps, ["search", "content_detail", "comments", "creator"]);
    assert.match(out.result.note, /不支持算子/);
    assert.equal(stub.sent.length, 0, "参数错就不该把请求打出去");
  } finally {
    stub.restore();
    dispose();
  }
});

test("平台工具：缺必要参数时给出缺哪个参数", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch(() => {
    throw new Error("缺参数不应触达 collector");
  });
  try {
    const out = (await c.agentPack.registry.invoke("xhs_web", { op: "comments" }, "CI", toolCtx)) as {
      result: { note: string };
    };
    assert.match(out.result.note, /contentId/);
    assert.equal(stub.sent.length, 0);
  } finally {
    stub.restore();
    dispose();
  }
});

/* ── 4. 来源目录口径 ─────────────────────────────────────── */

test("来源目录只列已装配的适配器：未开采集能力时七个平台源不进目录", async () => {
  const { c, dispose } = await freshContainer({ BM_MC_ENABLED: "false" });
  try {
    const catalog = c.agentPack.sourceCatalog(ctx);
    const keys = catalog.entries.map((e) => e.key);
    for (const id of MEDIA_CRAWLER_SOURCE_IDS) {
      assert.ok(!keys.includes(id), `${id} 能力未装配，不得出现在报告来源声明里`);
    }
  } finally {
    dispose();
  }
});

test("来源目录：开启采集能力后，七个平台源进入目录", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  try {
    const catalog = c.agentPack.sourceCatalog(ctx);
    const keys = catalog.entries.map((e) => e.key);
    for (const id of MEDIA_CRAWLER_SOURCE_IDS) {
      assert.ok(keys.includes(id), `${id} 已装配，应可作为来源被引用`);
    }
    assert.ok(catalog.entries.filter((e) => e.grade === "L3").length >= 8, "七个平台源 + 联网检索都是 L3");
  } finally {
    dispose();
  }
});

/* ── 5. intel 阶段平台预采集 ─────────────────────────────── */

/**
 * 预采集的意义：平台采集是**分钟级异步**（首次调用只返回 0 条 + 后台排队，下一次才命中缓存）。
 * 若等 CI 在工具循环里现调，报告往往在数据到货前就生成了 —— 平台数据等于白接。
 * 所以 intel 阶段必须先投递一轮。这两条用例把住"映射不漏"与"mock 绝不联网"。
 */

test("预采集映射：brief 的每个业务平台码都能落到一个已装配的采集工具", () => {
  for (const bp of POPULAR_PLATFORMS) {
    const mc = BRIEF_PLATFORM_TO_MC[bp];
    assert.ok(mc, `业务平台 ${bp} 没有对应的采集平台码 —— 新增业务平台时忘了接采集`);
    assert.ok(
      (MEDIA_CRAWLER_PLATFORMS as readonly string[]).includes(mc),
      `${mc} 不是合法的采集平台码`,
    );
    // 采集工具名与落盘目录名都要能解析，否则预采集投出去也是空手
    assert.ok(PLATFORM_TOOL_NAME[mc], `${bp} → ${mc} 没有对应的工具名`);
    assert.ok(MEDIA_CRAWLER_PLATFORM_META[mc].dataDirName, `${mc} 缺少落盘目录名`);
  }
  // 反向防漂移：两边数量必须一致，避免"加了映射但 brief 里不会出现"或反之
  assert.equal(Object.keys(BRIEF_PLATFORM_TO_MC).length, POPULAR_PLATFORMS.length);
  // 快手 / 贴吧 / 知乎不在 Brief.platforms 候选集里，映射表里**没有**它们 ——
  // 默认（BM_MC_PREFETCH_SCOPE=brief）下它们因而不会被预采集，只在模型主动调
  // platform_digest 时按需采。所以这里只断言映射表本身的构成，不涉及"会不会被采到"。
  assert.deepEqual(Object.values(BRIEF_PLATFORM_TO_MC).sort(), ["bili", "dy", "wb", "xhs"]);
});

test("预采集：mock 模式下不发任何外部请求（E2E 全离线的保护）", async () => {
  // MC 三开门全开 + mock LLM：工具已装配，但预采集必须因 mock 而整体跳过
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url) => {
    throw new Error(`mock 模式不得发起任何外部请求，却打了：${url}`);
  });
  try {
    const { jobId } = await c.orchestrator.startJob(
      { idempotencyKey: "k_mc_prefetch_mock", spec: { brief: BRIEF } },
      ctx,
    );
    await waitDone(c, jobId);
    const job = await c.orchestrator.getJob(jobId, DEMO_TENANT);
    assert.equal(job?.status, "succeeded", "mock 下全流程应成功");
    assert.equal(stub.sent.length, 0, "mock 模式必须全程离线 —— 预采集不能绕过 gateway.mocked");
  } finally {
    stub.restore();
    dispose();
  }
});

test("预采集参数：默认只覆盖 brief 声明的平台（BM_MC_PREFETCH_SCOPE=brief）", () => {
  const cfg = loadConfig();
  const ALL: string[] = ["xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu"];

  // 直投聚合工具（不是逐平台循环）—— 合并与可比指标计算都在工具内部完成。
  // 覆盖范围 = brief 声明的平台：客户没打算投的平台不预先烧一轮分钟级采集。
  // 依据是报告侧的行为 —— 实测手机报告的 exclusions 里就写着「快手/微博/贴吧/知乎
  // 不在本次调研范围」，采了也只会进排除项，这批数据从产出到引用没有一处会用到它。
  const args = platformPrefetchArgs({ platforms: ["xiaohongshu", "douyin"], category: "护肤品-精华" }, cfg);
  assert.deepEqual(args, {
    op: "search",
    keyword: "护肤品-精华",
    platforms: ["xhs", "dy"], // 顺序 = brief 声明顺序，便于确定性断言
    limit: 20,
  });

  // 去重：brief 里同一个平台写两次也只投一次，否则白跑一次分钟级采集
  const dedup = platformPrefetchArgs({ platforms: ["douyin", "douyin"], category: "面膜" }, cfg);
  assert.deepEqual(dedup?.platforms, ["dy"]);

  const onlyXhsDy = {
    mediaCrawler: {
      ...cfg.mediaCrawler,
      platforms: { xhs: true, dy: true, ks: false, bili: false, wb: false, tieba: false, zhihu: false },
    },
  };

  // 声明了、但一个都没装配 → null。刻意**不**退而采别的平台：
  // 报告会按"该平台未接入"如实写，而不是把另一批平台的证据冒充成这次调研的结论。
  assert.equal(
    platformPrefetchArgs({ platforms: ["weibo"], category: "面膜" }, onlyXhsDy),
    null,
    "brief 只要了微博而微博没装配 → 不该改采小红书/抖音",
  );

  // brief 没声明平台 → 不设范围，退回全部已装配平台。
  // 这条是防悬崖的：brief.platforms 允许为空（网关直接透传 brief，不做校验），
  // 若空即 null，报告会整份拿不到平台证据 —— 正是业主投诉过的"章节空白"形态。
  const fallback = platformPrefetchArgs({ platforms: [], category: "面膜" }, cfg);
  assert.deepEqual(fallback?.platforms, ALL, "brief 没声明平台时不设范围");

  // 平台开关收窄（只登录/只开了两个平台）时，声明的交集跟着收窄
  const narrowed = platformPrefetchArgs({ platforms: ["xiaohongshu", "douyin"], category: "面膜" }, onlyXhsDy);
  assert.deepEqual(narrowed?.platforms, ["xhs", "dy"]);
});

/* ── 5b. creator 阶段的补读条件（"为什么还有未采集的？"）────────
 *
 * 业主截图追问：77 条真实条目、79 位真实账号都进了报告，粉丝量一列**仍有 7 位「未采集」**。
 * 其中 5 位不是采不到，而是报告读缓存时资料行还没落库（内容行先到、主页补采晚一轮）。
 * 旧条件只在"证据池完全为空"时补读，而 B站搜索顺带写回的资料行已经把池子填满
 * → 判定为假 → 补读被跳过 → 晚一批落库的抖音/小红书作者永远拿不到粉丝量。
 */
test("补读条件：空池要补、半池（有人缺粉丝量）要补、全有粉丝量才不补", () => {
  /** 内容行（搜索落库，天生不带粉丝量） */
  const content = (platform: string, platformName: string, id: string, author: string) =>
    toEvidenceEntries([{ platform, platformName, id, text: "正文", author, url: `https://example.invalid/${id}`, metrics: { likes: 3 } }], {
      op: "search",
      collectedAt: "2026-05-20T08:00:00Z",
    });
  /** 个人主页资料行（补采落库，含粉丝量） */
  const profile = (platform: string, platformName: string, id: string, author: string, followers: number) =>
    toEvidenceEntries([{ platform, platformName, id, text: "", author, url: `https://example.invalid/${id}`, metrics: { followers } }], {
      op: "creator",
      collectedAt: "2026-05-20T08:02:00Z",
    });

  // ① 空池 → 补（原有行为：数据到了、池子还是空的）
  assert.equal(needsPlatformRefresh([]), true, "证据表为空时必须补读");

  // ② 只有内容行、一条资料行都没有 → 补（粉丝量全缺）
  const onlyContent = [...content("xhs", "小红书", "n1", "甲"), ...content("dy", "抖音", "v1", "乙")];
  assert.equal(needsPlatformRefresh(onlyContent), true, "池子非空但没有一位有粉丝量 → 仍要补读");

  // ③ **半池**：B站搜索顺带写回了资料行，抖音那批还在路上 → 必须补。
  // 这正是旧条件（只看"池子是否为空"）漏掉的形态。
  const half = [
    ...content("xhs", "小红书", "n1", "甲"),
    ...content("dy", "抖音", "v1", "乙"),
    ...profile("xhs", "小红书", "n1_profile", "甲", 12800),
  ];
  assert.equal(needsPlatformRefresh(half), true, "半池：有人有粉丝量、有人没有 → 必须再补读一次");

  // ④ 每人都拿到粉丝量 → 不补（省掉一次本地查询）
  const full = [...half, ...profile("dy", "抖音", "v1_profile", "乙", 30500)];
  assert.equal(needsPlatformRefresh(full), false, "粉丝量到齐后不该再补读");

  // ⑤ 资料行与内容行同名同平台才算同一账号：只补到一个平台时另一个平台仍算缺
  assert.equal(
    needsPlatformRefresh([...content("xhs", "小红书", "n1", "甲"), ...profile("dy", "抖音", "v1_profile", "乙", 1)]),
    true,
    "按（平台+作者）聚合：平台对不上的资料行不能算作该账号已有粉丝量",
  );
});

test("预采集参数：BM_MC_PREFETCH_SCOPE=all 才恢复「覆盖全部已装配平台」", () => {
  const cfg = loadConfig();
  const ALL: string[] = ["xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu"];

  // brief 声明的排在最前（顺序稳定），其余已装配平台一并纳入 —— 这是本次改动前的默认行为，
  // 保留给"要回答这个话题此刻在哪些平台被讨论"的跨平台视野场景。
  const all = platformPrefetchArgs(
    { platforms: ["xiaohongshu", "douyin"], category: "护肤品-精华" },
    { mediaCrawler: { ...cfg.mediaCrawler, prefetchScope: "all" } },
  );
  assert.deepEqual(all?.platforms, ALL);

  // 未传 config 的老调用方（纯函数测试）：装配面按"七平台全开"处理，scope 取默认 brief ——
  // 所以声明了平台时仍只采声明的那个
  assert.deepEqual(
    (platformPrefetchArgs({ platforms: ["douyin"], category: "面膜" })?.platforms as string[]),
    ["dy"],
  );
});

/* ── 6. 能力矩阵（跨平台可比性的唯一事实源）─────────────── */
/**
 * 这张矩阵是 `platform_digest` 算"哪些指标可横向比"的依据，也是报告口径页的依据。
 * 断言的是**真机核对过的结论**而不是复述代码：一旦有人"顺手补齐"成看起来更全的样子
 * （给快手加评论数、给贴吧加点赞），跨平台对比就会得出一个不存在的可比性。
 */
test("能力矩阵：指标声明与真机结论一致", () => {
  const meta = MEDIA_CRAWLER_PLATFORM_META;
  assert.deepEqual(meta.ks.contentMetrics, ["likes", "views"], "快手内容记录没有评论数（唯一缺评论数的平台），也没有收藏/转发");
  assert.deepEqual(meta.tieba.contentMetrics, ["comments"], "贴吧最贫：只有正文与评论数，连点赞都没有");
  assert.deepEqual(meta.dy.contentMetrics, ["likes", "comments", "collects", "shares"], "抖音内容记录没有播放量");
  assert.deepEqual(meta.xhs.contentMetrics, ["likes", "comments", "collects", "shares"], "小红书没有播放量");
  assert.deepEqual(meta.wb.contentMetrics, ["likes", "comments", "shares"], "微博没有收藏（且字段名是 shared_count）");
  assert.ok(meta.bili.contentMetrics.includes("views"), "播放量只有 B站与快手有");
  assert.deepEqual(meta.ks.commentMetrics, ["subComments"], "快手评论模型没有点赞字段");
  assert.deepEqual(meta.tieba.commentMetrics, ["subComments"], "贴吧评论模型没有点赞字段");

  // 可比集 = 交集（按第一个平台的顺序，保证同输入同输出）
  assert.deepEqual(comparableContentMetrics(["xhs", "dy"]), ["likes", "comments", "collects", "shares"]);
  assert.deepEqual(comparableContentMetrics(["bili", "xhs"]), ["likes", "comments", "collects", "shares"], "B站独有播放量不参与交集");
  assert.deepEqual(comparableCommentMetrics(["ks", "tieba"]), ["subComments"]);
  // 空交集是**合法且必须如实报出**的结果：不能让调用方挑一个指标硬比
  assert.deepEqual(comparableContentMetrics(["tieba", "ks"]), [], "贴吧只有评论数、快手没有评论数 → 无共有指标");
  assert.deepEqual(comparableContentMetrics([]), [], "空平台集返回空集，不应抛错");
});

/* ── 7. 聚合工具 platform_digest ─────────────────────────── */

const fetchRow = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  title: "标题",
  text: "正文",
  author: "某人",
  authorId: "hash1",
  url: "https://example.invalid/r1",
  publishedAt: "2026-05-01T00:00:00.000Z",
  metrics: { likes: 10, comments: 2, collects: 1, shares: 1 },
  ...over,
});

test("聚合工具：一次调用合并多平台，并给出跨平台可比指标", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url, body) => {
    if (url.endsWith("/query")) {
      const p = String(body.platform);
      if (p === "xhs") return queryOk([fetchRow({ id: "n1", metrics: { likes: 10, comments: 2, collects: 1, shares: 0 } })]);
      if (p === "dy") return queryOk([fetchRow({ id: "v1", metrics: { likes: 99, comments: 8, collects: 3, shares: 0 } })]);
      return queryOk([]);
    }
    return collectOk;
  });
  try {
    const out = (await c.agentPack.registry.invoke(
      PLATFORM_DIGEST_TOOL_NAME,
      { op: "search", keyword: "精华", platforms: ["xiaohongshu", "douyin"] },
      "CI",
      toolCtx,
    )) as { result: Record<string, any> };
    const r = out.result;

    assert.deepEqual(r.platformsRequested, ["xhs", "dy"], "业务平台码必须被归一成采集码 —— 模型不该被迫记住两套编码");
    assert.equal(r.totalCount, 2, "两个平台的记录要合并进同一个 rows");
    assert.deepEqual(r.rows.map((x: any) => x.platform).sort(), ["dy", "xhs"], "每行都要带平台标签，否则合并后分不清来源");
    assert.deepEqual(r.platformsSkipped, [], "两个平台都装配且授权，不该有跳过项");

    assert.equal(r.comparison.scope, "content");
    assert.deepEqual(r.comparison.metrics, ["likes", "comments", "collects"], "shares 两边都为 0 → 不进可比集");
    assert.deepEqual(r.comparison.dropped, ["shares"], "声明共有但本批全为 0 的指标必须单列：它是缺失，不是 0");
    // 播放量是 B站独有，本组平台里根本不存在，连 dropped 都不该出现
    assert.ok(!r.comparison.dropped.includes("views"), "平台根本没有的指标不该被当成「本批为 0」");
  } finally {
    stub.restore();
    dispose();
  }
});

test("聚合工具：未装配的平台被跳过并记名，其余平台照常返回", async () => {
  // 只启用小红书：抖音的适配器不注册，于是"聚合"必须如实报出少了一个平台
  const { c, dispose } = await freshContainer({ ...MC_ON, BM_MC_PLATFORMS: "xhs" });
  const stub = stubFetch((url) => (url.endsWith("/query") ? queryOk([fetchRow()]) : collectOk));
  try {
    const out = (await c.agentPack.registry.invoke(
      PLATFORM_DIGEST_TOOL_NAME,
      { op: "search", keyword: "精华", platforms: ["xiaohongshu", "douyin"] },
      "CI",
      toolCtx,
    )) as { result: Record<string, any> };
    const r = out.result;

    assert.equal(r.totalCount, 1, "已装配的小红书照常返回");
    assert.deepEqual(r.platformsSkipped.map((s: any) => s.platform), ["dy"], "未装配的平台必须被记名，而不是静默少一个");
    assert.match(r.platformsSkipped[0].reason, /未装配/);
    assert.equal(r.platforms.find((p: any) => p.platform === "dy").used, false);
    assert.equal(r.platforms.find((p: any) => p.platform === "xhs").used, true);
    // 只剩一个平台时可比集退化为它自己的声明集；B站独有指标依然不该出现
    assert.deepEqual(r.comparison.metrics, ["likes", "comments", "collects", "shares"]);
  } finally {
    stub.restore();
    dispose();
  }
});

test("聚合工具：平台参数无法识别时给出可操作说明，且不打任何请求", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url) => {
    throw new Error(`参数不可识别时不该触达 collector，却打了：${url}`);
  });
  try {
    const out = (await c.agentPack.registry.invoke(
      PLATFORM_DIGEST_TOOL_NAME,
      { op: "search", keyword: "精华", platforms: ["tiktok"] },
      "CI",
      toolCtx,
    )) as { result: Record<string, any> };
    assert.deepEqual(out.result.rows, []);
    assert.deepEqual(out.result.unknownPlatforms, ["tiktok"]);
    assert.match(out.result.note, /没有可识别/);
    assert.equal(stub.sent.length, 0);
  } finally {
    stub.restore();
    dispose();
  }
});

/* ── 8. 工具面收敛：模型只看得到聚合入口 ─────────────────── */

test("模型可见的工具面里只有 platform_digest，七个单平台工具仍注册但不可见", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  try {
    const visible = c.agentPack.registry.list().map((t) => t.policy.name);
    assert.ok(visible.includes(PLATFORM_DIGEST_TOOL_NAME));
    for (const p of MEDIA_CRAWLER_PLATFORMS) {
      const name = PLATFORM_TOOL_NAME[p];
      assert.ok(!visible.includes(name), `${name} 必须对模型隐藏 —— 否则模型会在上下文里自己合并跨平台结果`);
      // 隐藏只影响"暴露"，不影响"治理"：它仍是可被单测直接调用的受治理原语
      assert.ok(c.agentPack.registry.get(name), `${name} 仍要注册`);
    }
    // toAgentTools 才是模型真正的工具清单，也必须过滤掉
    const exposed = c.agentPack.registry.toAgentTools("CI", toolCtx).map((t) => t.name);
    assert.ok(exposed.includes(PLATFORM_DIGEST_TOOL_NAME));
    for (const p of MEDIA_CRAWLER_PLATFORMS) {
      assert.ok(!exposed.includes(PLATFORM_TOOL_NAME[p]), `${PLATFORM_TOOL_NAME[p]} 不该出现在模型工具清单里`);
    }
    // 提示词也不能再把模型往单平台工具上引（描述与真实工具面不一致 = 诱发无效调用）
    for (const p of MEDIA_CRAWLER_PLATFORMS) {
      assert.ok(!PHASE_TOOL_HINT.intel.includes(PLATFORM_TOOL_NAME[p]), `intel 提示词不该再教模型挑单平台工具（${PLATFORM_TOOL_NAME[p]}）`);
    }
    assert.ok(PHASE_TOOL_HINT.intel.includes(PLATFORM_DIGEST_TOOL_NAME));
  } finally {
    dispose();
  }
});

test("未装配任何平台源时聚合工具不注册（不留「聚合可用但一个平台都没有」的假能力）", async () => {
  const cases: Array<Record<string, string>> = [
    { BM_MC_ENABLED: "false" },
    { BM_MC_ENABLED: "true", BM_MC_LICENSE_ACK: "false", BM_MC_COLLECTOR_URL: COLLECTOR },
  ];
  for (const env of cases) {
    const { c, dispose } = await freshContainer(env);
    try {
      assert.equal(c.agentPack.registry.get(PLATFORM_DIGEST_TOOL_NAME), undefined, `${JSON.stringify(env)} 下不该注册聚合工具`);
      assert.ok(!c.agentPack.registry.listAll().some((t) => t.policy.name === PLATFORM_DIGEST_TOOL_NAME));
    } finally {
      dispose();
    }
  }
});

test("聚合工具：绑一组源，但未通过闸门的平台不该拖垮整批", async () => {
  // 逐源过闸门是这层的关键：绑七个源 ≠ 放开来源。
  // 这里用"平台开关只开 xhs"模拟一个平台不可用的形态，断言其余平台照常返回。
  const { c, dispose } = await freshContainer({ ...MC_ON, BM_MC_PLATFORMS: "xhs,ks" });
  const stub = stubFetch((url, body) => {
    if (url.endsWith("/query")) {
      return String(body.platform) === "ks"
        ? queryOk([fetchRow({ id: "k1", metrics: { likes: 7, views: 100 } })])
        : queryOk([fetchRow({ metrics: { likes: 10, comments: 2, collects: 1, shares: 1 } })]);
    }
    return collectOk;
  });
  try {
    const out = (await c.agentPack.registry.invoke(
      PLATFORM_DIGEST_TOOL_NAME,
      { op: "search", keyword: "精华", platforms: ["xhs", "ks"] },
      "CI",
      toolCtx,
    )) as { result: Record<string, any> };
    const r = out.result;
    assert.equal(r.totalCount, 2);
    // 小红书有评论数、快手没有 → 评论数不进可比集；两边都有点赞 → 进
    assert.deepEqual(r.comparison.metrics, ["likes"], "可比集必须是交集：快手没有评论数，评论数就不能拿来横向比");
    assert.ok(r.comparison.dropped.includes("comments") === false, "被交集排除的指标进的是「不可比」，不是 dropped");
    // 单平台侧要能看出"我声明有、但这批没值"
    const ks = r.platforms.find((p: any) => p.platform === "ks");
    assert.deepEqual(ks.absentMetrics, [], "快手声明 likes/views，本批两者都有值");
    const xhs = r.platforms.find((p: any) => p.platform === "xhs");
    assert.deepEqual(xhs.absentMetrics, []);
  } finally {
    stub.restore();
    dispose();
  }
});

test("聚合工具：逐源过闸门 —— 单个平台被撤销授权时只跳过它，其余照常返回", async () => {
  /* 这条把住"绑一组源 ≠ 放开来源"。
   * 绑了七个源之后，很容易图省事只跑一次闸门（或者干脆用第一个平台的判定结果代表全组），
   * 那样一个未授权平台会跟着另外六个一起被放行——或者反过来拖垮整批。
   * 用"撤销 dy 的授权"制造真实的闸门拒绝：跳过必须带闸门原因，且不影响 xhs 的取数。 */
  const { c, dispose } = await freshContainer(MC_ON);
  const stub = stubFetch((url) => (url.endsWith("/query") ? queryOk([fetchRow()]) : collectOk));
  try {
    const grants = c.repos.authz.list(DEMO_TENANT).filter((a) => a.sourceId === "mc_dy" && a.status === "active");
    assert.ok(grants.length > 0, "前提：dy 原本是已授权的，否则这条用例测不到闸门");
    for (const g of grants) c.repos.authz.revoke(g.authzId, DEMO_TENANT, "测试：撤销单平台授权");

    const out = (await c.agentPack.registry.invoke(
      PLATFORM_DIGEST_TOOL_NAME,
      { op: "search", keyword: "精华", platforms: ["xhs", "dy"] },
      "CI",
      toolCtx,
    )) as { result: Record<string, any> };
    const r = out.result;

    assert.equal(r.totalCount, 1, "未被撤销的 xhs 要照常返回");
    const dy = r.platformsSkipped.find((s: any) => s.platform === "dy");
    assert.ok(dy, "被撤销授权的 dy 必须出现在 platformsSkipped 里");
    assert.match(dy.reason, /闸门|授权/, "跳过原因要指向闸门而不是含糊的采集失败");
    assert.equal(r.platforms.find((p: any) => p.platform === "xhs").used, true);
    assert.equal(r.platforms.find((p: any) => p.platform === "dy").used, false);
  } finally {
    stub.restore();
    dispose();
  }
});

/* 报告阶段的补读权限（2026-10-20）：漏掉这条 = 粉丝量永远「未采集」。
 *
 * 事故链：作者主页资料行比 creator 阶段晚到 → 只有 report 阶段还有机会补读 →
 * `refreshPlatformData` 用 `PHASE_AGENT["report"]`（= RG）调 `platform_digest` →
 * 但白名单只有 CI/CT → `invoke` 第一步就抛 E-GOV-004 → 补读失效。
 * 这是隐藏在"数据没采到"后面的第四层原因，静默且在日志里只表现为一条降级项。 */
test("platform_digest 的白名单必须包含 RG（否则报告阶段的终稿前补读被拒）", async () => {
  const { c, dispose } = await freshContainer(MC_ON);
  try {
    const tool = c.agentPack.registry.get("platform_digest");
    assert.ok(tool, "platform_digest 应注册");
    assert.ok(
      tool.policy.allowedAgents.includes("RG"),
      `RG 必须在白名单里，实际：${tool.policy.allowedAgents.join("/")}。` +
        "少了它，report 阶段那次补读会撞 E-GOV-004 —— 数据躺在缓存里，报告还是写「未采集」",
    );
    assert.ok(tool.policy.allowedAgents.includes("CI") && tool.policy.allowedAgents.includes("CT"), "情报与选人两个角色本来就要有");
    /* 有界性不受影响：系统侧补取走 systemCall 不计入，模型侧仍受 maxCallsPerJob 约束 */
    assert.equal(tool.policy.maxCallsPerJob, 8, "外部计费源必须有单任务调用上限");
  } finally {
    dispose();
  }
});

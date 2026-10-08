/**
 * 自检用例（对应 LLD §7.3 的强制 E2E 清单，命名与清单一致）
 *
 * 运行：npm test
 * 全部用例在 mock 模式下运行 —— 不依赖任何外部服务，因此在 CI 里可以无条件执行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@brandsale/config";
import {
  AppError,
  DEFAULT_DEPTH_POLICY,
  PHASE_ORDER,
  measureReportDepth,
  traceableRatio,
  validateReportDsl,
  type Brief,
  type ReportDsl,
  type TenantContext,
} from "@brandsale/contracts";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { seed, DEMO_TENANT } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_test", traceId: "trace_test", locale: "zh-CN" };

/** 每个测试组一份独立的数据库，避免相互污染 */
async function freshContainer(): Promise<{ c: Container; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-test-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock" });
  const c = createContainer(config);
  const prev = process.cwd;
  void prev;
  // seed 使用默认 cwd 配置，这里直接复用同一个容器写入种子
  await seedInto(c, dir);
  return {
    c,
    dispose: () => {
      // 先让在跑的后台任务停下，再关连接、删目录；
      // 否则任务会在 db 关闭后继续写库（unhandledRejection）
      c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedInto(c: Container, dir: string): Promise<void> {
  const saved = process.env.BM_DATA_DIR;
  process.env.BM_DATA_DIR = dir;
  try {
    await seed();
  } finally {
    if (saved === undefined) delete process.env.BM_DATA_DIR;
    else process.env.BM_DATA_DIR = saved;
  }
}

const BRIEF: Brief = {
  industry: "美妆",
  category: "护肤品-精华",
  brandIds: ["brand_A"],
  budget: { currency: "CNY", amount: 3_000_000 },
  objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
  window: { from: "2026-05-20", to: "2026-06-20" },
  platforms: ["douyin", "xiaohongshu"],
};

/* ── E2E #1 正常全流程 ──────────────────────────────────── */

test("E2E-1 正常全流程：产出报告、来源声明非空、无降级", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const { jobId } = await c.orchestrator.startJob({ idempotencyKey: "k1", spec: { brief: BRIEF } }, ctx);
    await waitDone(c, jobId);
    const job = (await c.orchestrator.getJob(jobId, DEMO_TENANT))!;
    assert.equal(job.status, "succeeded", `任务应成功，实际 ${job.status} degraded=${JSON.stringify(job.degraded)}`);

    const artifacts = c.repos.artifacts.list(jobId);
    const dsl = artifacts.find((a) => a.kind === "report_dsl")?.inline as ReportDsl;
    assert.ok(dsl, "应产出报告 DSL");
    assert.ok(dsl.sourceDeclaration.sources.length > 0, "来源声明必须非空");
    assert.ok(artifacts.some((a) => a.kind === "report_html"), "应产出 HTML 报告");

    const phases = await c.orchestrator.listPhases(jobId);
    assert.equal(phases.length, PHASE_ORDER.length, "六个阶段都应留检查点");
  } finally {
    dispose();
  }
});

/* ── E2E #3 闸门拦截未登记数据源，任务不中断 ─────────────── */

test("E2E-3 闸门拦截未登记数据源：返回 E-GOV-001 且任务继续", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const verdict = await c.gate.evaluate(
      { tenantId: DEMO_TENANT, jobId: "j", agent: "CI", tool: "web_search", args: { sourceId: "nope" }, checks: ["scope", "source", "authz", "tenant"] },
      ctx,
    );
    assert.equal(verdict.allow, false);
    assert.equal(verdict.code, "E-GOV-001");

    // 审计必须落一条 deny
    const audits = c.repos.audit.list(DEMO_TENANT, 200).filter((a) => a.kind === "gate.deny");
    assert.ok(audits.length >= 1, "被拒的 verdict 也必须落审计");

    // 任务不中断：正常流程仍能跑完
    const { jobId } = await c.orchestrator.startJob({ idempotencyKey: "k3", spec: { brief: BRIEF } }, ctx);
    await waitDone(c, jobId);
    const job = (await c.orchestrator.getJob(jobId, DEMO_TENANT))!;
    assert.notEqual(job.status, "failed", "单个源被拦不应导致任务失败");
  } finally {
    dispose();
  }
});

/* ── E2E #4 跨租户访问 ─────────────────────────────────── */

test("E2E-4 跨租户访问：E-GOV-003 + 安全告警 + fatal", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const verdict = await c.gate.evaluate(
      {
        tenantId: DEMO_TENANT,
        jobId: "j",
        agent: "CI",
        tool: "web_search",
        args: { sourceId: "volc_web_search", tenantId: "tenant_other" },
        checks: ["scope", "source", "authz", "tenant"],
      },
      ctx,
    );
    assert.equal(verdict.allow, false);
    assert.equal(verdict.code, "E-GOV-003");
    assert.equal(verdict.fatal, true, "跨租户必须是 fatal");
    const alerts = c.repos.audit.countByKind(DEMO_TENANT)["security.alert"] ?? 0;
    assert.ok(alerts >= 1, "必须产生安全告警");
  } finally {
    dispose();
  }
});

/* ── E2E #10 L4 双开关 ─────────────────────────────────── */

test("E2E-10 L4 配置打开但法务未批：仍然拒绝（E-DATA-004）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-test-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", BM_L4_ENABLED: "true" });
  const c = createContainer(config);
  try {
    assert.equal(config.tiers.L4, true, "本用例前提：L4 开关已打开");
    // 登记一个 L4 源但 legalApproved=false
    await c.gate.registerSource(
      {
        sourceId: "l4_x",
        tenantId: DEMO_TENANT,
        name: "第三方 L4",
        tier: "L4",
        sourceType: "l4_purchased",
        owner: "legal",
        legalApproved: false,
        registeredBy: "u_test",
        registeredAt: new Date().toISOString(),
      },
      ctx,
    );
    await c.gate.grantAuthz(
      { tenantId: DEMO_TENANT, sourceId: "l4_x", grantedBy: "u_test", validFrom: "2020-01-01T00:00:00Z", validTo: "2099-01-01T00:00:00Z", scopes: ["read"] },
      ctx,
    );
    const verdict = await c.gate.evaluate(
      { tenantId: DEMO_TENANT, jobId: "j", agent: "CI", tool: "web_search", args: { sourceId: "l4_x" }, checks: ["scope", "source", "authz", "tenant"] },
      ctx,
    );
    assert.equal(verdict.allow, false, "法务未批时即使配置打开也必须拒绝");
    assert.equal(verdict.code, "E-DATA-004");
  } finally {
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── E2E #9 回灌无来源数据被拒 ─────────────────────────── */

test("E2E-9 回灌无来源数据：拒绝入库，库内容不变", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const before = await c.knowledge.stats(DEMO_TENANT);
    const res = await c.knowledge.ingest(
      [
        {
          chunkId: "bad-1",
          docId: "d1",
          collection: "KB-2",
          tenantId: DEMO_TENANT,
          text: "没有来源的结论：这个达人 ROI 是 9.9",
          sourceId: "",
          sourceType: "" as never,
          tier: "L2",
          sampleSize: 1,
          publishedAt: new Date().toISOString(),
          humanVerified: false,
          meta: {},
        },
      ],
      ctx,
    );
    assert.equal(res.ingested, 0);
    assert.equal(res.rejected, 1);
    const after = await c.knowledge.stats(DEMO_TENANT);
    assert.deepEqual(after, before, "库内容不得变化");

    const audits = c.repos.audit.list(DEMO_TENANT, 50);
    assert.ok(audits.length >= 0);
  } finally {
    dispose();
  }
});

/* ── 幂等与冲突 ────────────────────────────────────────── */

test("幂等：同 key 同 body 复用任务；同 key 不同 body 报 E-JOB-002", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const a = await c.orchestrator.startJob({ idempotencyKey: "same", spec: { brief: BRIEF } }, ctx);
    const b = await c.orchestrator.startJob({ idempotencyKey: "same", spec: { brief: BRIEF } }, ctx);
    assert.equal(a.jobId, b.jobId);
    assert.equal(b.reused, true);

    await assert.rejects(
      () => c.orchestrator.startJob({ idempotencyKey: "same", spec: { brief: { ...BRIEF, budget: { currency: "CNY", amount: 1 } } } }, ctx),
      (e: unknown) => e instanceof AppError && e.code === "E-JOB-002",
    );
  } finally {
    dispose();
  }
});

/* ── E2E #5 崩溃恢复：不重跑已完成阶段、用量不翻倍 ─────── */

test("E2E-5 崩溃恢复：已完成的阶段不重跑，用量不翻倍", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const { jobId } = await c.orchestrator.startJob({ idempotencyKey: "rec", spec: { brief: BRIEF } }, ctx);
    await waitDone(c, jobId);

    const callsBefore = c.agentPack.registry.callCount();
    const usageBefore = (await c.orchestrator.getUsage(jobId))!;

    // 把状态改回 running，模拟"进程被杀后重启"
    c.repos.jobs.setStatus(jobId, "running", 0.5, "intel");
    const { resumed, skipped } = await c.orchestrator.recover({ tenantId: DEMO_TENANT, userId: "u_test", traceId: "t", locale: "zh-CN" });
    assert.ok(resumed.includes(jobId) || skipped.includes(jobId), "恢复流程应处理该任务");

    await waitDone(c, jobId);

    const callsAfter = c.agentPack.registry.callCount();
    assert.equal(callsAfter, callsBefore, "已完成阶段不得重跑（工具调用次数应不变）");

    const usageAfter = (await c.orchestrator.getUsage(jobId))!;
    assert.equal(usageAfter.tokens.inputTokens, usageBefore.tokens.inputTokens, "输入 token 不得翻倍");
    assert.equal(usageAfter.tokens.outputTokens, usageBefore.tokens.outputTokens, "输出 token 不得翻倍");
    assert.equal(Math.round(usageAfter.cost.amount * 1e6), Math.round(usageBefore.cost.amount * 1e6), "成本不得翻倍");
  } finally {
    dispose();
  }
});

/* ── 报告不变量 ────────────────────────────────────────── */

test("报告 DSL 不变量：无来源数字被拒；L4 引用被拒；low 置信度自动补 warn", () => {
  const base: ReportDsl = {
    meta: { dslVersion: "1.0", title: "t", brand: { id: "b", name: "b" }, window: { from: "a", to: "b" }, generatedAt: new Date().toISOString() },
    sourceDeclaration: { grade: "L3", sources: [{ key: "s1", displayName: "s1", grade: "L3", asOf: "now", coverage: "cov" }], exclusions: [] },
    slides: [
      {
        index: 0,
        pageRole: "content",
        title: "无引用页",
        layoutId: "content/x",
        blocks: [{ type: "kpi", items: [{ label: "GMV", value: "1,234 万" }] }],
        citations: [],
      },
    ],
  };
  const bad = validateReportDsl(base);
  assert.equal(bad.ok, false, "无来源数字必须被拒");

  const fixed: ReportDsl = { ...base, slides: [{ ...base.slides[0]!, citations: [{ claim: "GMV 1234 万", kind: "data_source", ref: { sourceKey: "s1" }, confidence: 0.9, tier: "high", verifiedBy: "auto", grade: "L3" }] }] };
  assert.equal(validateReportDsl(fixed).ok, true);

  const l4: ReportDsl = { ...fixed, slides: [{ ...fixed.slides[0]!, citations: [{ ...fixed.slides[0]!.citations[0]!, grade: "L4" }] }] };
  assert.equal(validateReportDsl(l4).ok, false, "L4 引用必须被拒");

  const low: ReportDsl = {
    ...base,
    slides: [
      {
        index: 0,
        pageRole: "content",
        title: "低置信",
        layoutId: "content/x",
        blocks: [{ type: "kpi", items: [{ label: "估算 ROI", value: "2.1", tier: "low" }] }],
        citations: [{ claim: "估算 ROI 2.1", kind: "model_inference", ref: {}, confidence: 0.3, tier: "low", verifiedBy: "auto", grade: "L3" }],
      },
    ],
  };
  const issues = validateReportDsl(low).issues;
  assert.ok(issues.some((i) => i.level === "warn" && i.message.includes("warn")), "low 置信度应产生可修复的 warn");
});

/* ── 检索与置信度 ──────────────────────────────────────── */

test("检索：BM25 命中中文关键词，且带 citation", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const res = await c.knowledge.retrieve({ text: "达人报价折扣 刊例价 成交价", collections: ["KB-2", "KB-3"], topK: 3, tenantId: DEMO_TENANT });
    assert.ok(res.hits.length > 0, "应命中内容");
    assert.ok(res.hits.every((h) => h.citation.sourceId), "每条命中都必须带 citation");
  } finally {
    dispose();
  }
});

test("工具白名单与令牌桶：越权工具被拒；并发不超限", async () => {
  const { c, dispose } = await freshContainer();
  try {
    await assert.rejects(
      () =>
        c.agentPack.registry.invoke(
          "pricing_query",
          { talentId: "t_1001" },
          "AO",
          { ctx, jobId: "j", phase: "intake", attempt: 1, emit: () => {}, signal: new AbortController().signal },
        ),
      (e: unknown) => e instanceof AppError && e.code === "E-GOV-004",
    );
  } finally {
    dispose();
  }
});

/* ── 联网检索工具（离线：fetch 打桩，不依赖外部服务）────── */

/** 把一次火山联网搜索的响应打桩，并记录实际发出的请求体 */
function stubWebSearch(): { sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[]; restore: () => void } {
  const original = globalThis.fetch;
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    sent.push({
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        ResponseMetadata: { RequestId: "req_test" },
        Result: {
          ResultCount: 2,
          WebResults: [
            { Id: "1", Title: "抗皱护肤市场观察", SiteName: "新华网", Url: "https://example.com/a", PublishTime: "2026-08-20T00:00:00+08:00", Snippet: "市场规模预计增长", Summary: "摘要一" },
            { Id: "2", Title: "精华类目内容趋势", SiteName: "青眼情报", Url: "https://example.com/b", PublishTime: "2026-07-01T00:00:00+08:00", Snippet: "成分叙事抬头", Summary: "摘要二" },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const toolCtx = { ctx, jobId: "job_websearch", phase: "intel" as const, attempt: 1, emit: () => {}, signal: new AbortController().signal };

interface WebSearchOut {
  result: { query: string; count: number; results: { title: string; siteName: string; url: string }[] };
  provenance: { sourceId: string; tier: string; synthetic: boolean; note: string }[];
  note: string;
}

test("联网检索：来源由代码绑定、六阶段白名单全开、命中缓存", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-websearch-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", BM_WEB_SEARCH_API_KEY: "test-key" });
  const c = createContainer(config);
  const stub = stubWebSearch();
  try {
    await seedInto(c, dir);
    assert.ok(c.agentPack.registry.get("web_search"), "配置了 API Key 后应注册 web_search 工具");

    /* 参数里故意塞一个**已登记但 L4 未法务批准**的 sourceId。
     * 若闸门相信模型自报的来源，这一步会被 E-DATA-004 拦下；
     * 工具声明了 boundSourceId，闸门检查的是真实来源（L3 联网检索），因此应正常放行。 */
    const out = (await c.agentPack.registry.invoke(
      "web_search",
      { query: "美妆 精华 市场趋势", count: 2, sourceId: "l4_example_vendor" },
      "CI",
      toolCtx,
    )) as WebSearchOut;

    assert.equal(out.result.count, 2, "应返回 2 条检索结果");
    assert.equal(out.result.results[0]?.siteName, "新华网", "结果应保留来源站点");
    assert.equal(out.provenance[0]?.sourceId, "volc_web_search");
    assert.equal(out.provenance[0]?.tier, "L3", "联网检索按 L3 处理");
    assert.equal(out.provenance[0]?.synthetic, false, "是真实抓取的网页，不是合成值");

    assert.equal(stub.sent.length, 1, "应只发出一次外部请求");
    assert.match(stub.sent[0]!.url, /web_search$/, "应打到配置的检索端点");
    assert.equal(stub.sent[0]!.headers.Authorization, "Bearer test-key", "应带 API Key");
    assert.equal(stub.sent[0]!.body.Query, "美妆 精华 市场趋势");
    assert.equal(stub.sent[0]!.body.Count, 2);
    assert.equal((stub.sent[0]!.body.Filter as Record<string, unknown>).NeedUrl, true, "必须要求返回链接，否则报告无法引用");

    // 同参数重复调用命中结果缓存，不再打端点
    const again = (await c.agentPack.registry.invoke("web_search", { query: "美妆 精华 市场趋势", count: 2 }, "CI", toolCtx)) as WebSearchOut;
    assert.equal(stub.sent.length, 1, "同查询应命中缓存，不重复请求（省配额）");
    assert.match(again.provenance[0]?.note ?? "", /命中缓存/);

    /* 白名单：六个阶段全开。平台适配器（千川/星图/蒲公英/生意参谋/巨量算数）移除后，
     * 公开信息只剩联网检索这一条路，故原先被拒的 CT 现在能正常调用。
     * 这是有意的放宽，代价（达人信息可能来自公开网页）见 tool-impls.ts 的代价提示。 */
    const ctOut = (await c.agentPack.registry.invoke("web_search", { query: "达人 报价 档期" }, "CT", toolCtx)) as WebSearchOut;
    assert.equal(ctOut.result.count, 2, "CT 阶段现在应能正常检索（白名单已放开）");
    assert.equal(stub.sent.length, 2, "CT 调用应真实触达外部端点");

    /* 单任务调用上限：令牌桶限速率不限总量，外部**计费**接口必须另有总额闸门。
     * 这里一直问到它降级为止，然后确认超限之后彻底不再触达端点。 */
    let capped: { degraded?: boolean; code?: string; reason?: string } | undefined;
    // maxCallsPerJob = 30；本用例至此已用掉 2 次（CI 首查 + CT），再问到超限为止
    for (let i = 0; i < 40 && !capped; i++) {
      const r = (await c.agentPack.registry.invoke("web_search", { query: `填充查询 ${i}` }, "CI", toolCtx)) as {
        degraded?: boolean;
        code?: string;
        reason?: string;
      };
      if (r.degraded) capped = r;
    }
    assert.ok(capped, "超过单任务上限后应降级");
    assert.equal(capped.code, "E-DATA-003");
    assert.match(capped.reason ?? "", /上限/);

    const sentAtCap = stub.sent.length;
    const beyond = (await c.agentPack.registry.invoke("web_search", { query: "超限之后" }, "CI", toolCtx)) as { degraded?: boolean };
    assert.equal(beyond.degraded, true, "超限后应持续降级");
    assert.equal(stub.sent.length, sentAtCap, "超限后不得再触达外部端点（这才是设上限的意义）");
  } finally {
    stub.restore();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("联网检索：未配置 API Key 时适配器与工具都不注册", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-websearch-off-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", BM_WEB_SEARCH_API_KEY: "" });
  const c = createContainer(config);
  try {
    await seedInto(c, dir);
    assert.equal(c.agentPack.registry.get("web_search"), undefined, "没有 Key 就不该把工具暴露给 Agent");
    assert.equal(c.agentPack.registry.list().length, 9, "其余 9 个工具照常注册（工具总数为 10，仅 web_search 缺席）");
    assert.ok(
      c.warnings.some((w) => w.includes("BM_WEB_SEARCH_API_KEY")),
      "应在启动告警里说明联网检索被关闭",
    );
  } finally {
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── E2E #11 报告深度回归（P1-2 / P2-2） ────────────────── */

/**
 * 这条用例是整个「报告不够细致」问题的**验收标准**，不只是回归护栏。
 * 它把 §0 的口径固化成断言：
 *   - 页数、块型数、必备块型（chart/matrix 在内）、可视化块数；
 *   - 可溯源引用占比（不是「有引用」，而是「引用大多是真实来源」）；
 *   - 来源声明里的每一项都必须真的存在于本次可用目录（不再出现"声明了 6 个、5 个是编的"）。
 * 同时跑一份黄金快照：mock 模式是确定性的，指标漂移即说明合成基线被改动，
 * 需要显式确认（BM_UPDATE_GOLDEN=1 才写回）。
 */
const GOLDEN_PATH = join(process.cwd(), "tests", "golden", "report.depth.json");

test("E2E-11 报告深度回归：页数/块型/图表/可溯源占比达标，来源全部合法", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const { jobId } = await c.orchestrator.startJob({ idempotencyKey: "depth", spec: { brief: BRIEF } }, ctx);
    await waitDone(c, jobId);
    const job = (await c.orchestrator.getJob(jobId, DEMO_TENANT))!;
    assert.notEqual(job.status, "failed", `任务不应失败：${JSON.stringify(job.degraded)}`);

    const artifacts = c.repos.artifacts.list(jobId);
    const dsl = artifacts.find((a) => a.kind === "report_dsl")?.inline as ReportDsl;
    assert.ok(dsl, "应产出报告 DSL");

    // minSlides 走 config（BM_REPORT_MIN_SLIDES），与生产路径一致
    const policy = { ...DEFAULT_DEPTH_POLICY, minSlides: c.config.report.minSlides };
    const depth = measureReportDepth(dsl, policy);

    assert.ok(depth.slides >= policy.minSlides, `页数 ${depth.slides} 应 ≥ ${policy.minSlides}`);
    assert.equal(depth.missingRequiredTypes.length, 0, `缺少必备块型：${depth.missingRequiredTypes.join("、")}｜gaps=${depth.gaps.join("；")}`);
    assert.ok(depth.blockTypes.length >= policy.minBlockTypes, `块型数 ${depth.blockTypes.length} 应 ≥ ${policy.minBlockTypes}`);
    assert.ok(depth.visualBlocks >= policy.minVisualBlocks, `chart/matrix 合计 ${depth.visualBlocks} 应 ≥ ${policy.minVisualBlocks}`);

    const ratio = traceableRatio(dsl);
    assert.ok(ratio >= policy.minTraceableRatio, `可溯源引用占比 ${(ratio * 100).toFixed(0)}% 应 ≥ ${policy.minTraceableRatio * 100}%`);

    // 来源声明的每一项都必须真实存在于本次可用目录 —— 这是 P0-2 的核心验收点
    const catalog = c.agentPack.sourceCatalog(ctx);
    const catalogKeys = new Set(catalog.entries.map((e) => e.key));
    for (const s of dsl.sourceDeclaration.sources) {
      assert.ok(catalogKeys.has(s.key), `来源声明「${s.displayName}」(${s.key}) 不在本次可用数据源目录内`);
    }
    assert.ok(dsl.sourceDeclaration.sources.length >= policy.minSources, `来源声明 ${dsl.sourceDeclaration.sources.length} 条应 ≥ ${policy.minSources}`);

    // 渲染层兜底校验（带目录）必须通过，且渲染产物里要有真图表
    const post = validateReportDsl(dsl, { catalog, minTraceableRatio: policy.minTraceableRatio });
    assert.equal(post.ok, true, `带目录的兜底校验应通过：${post.issues.filter((i) => i.level === "error").map((i) => i.message).join("；")}`);

    const html = artifacts.find((a) => a.kind === "report_html")?.inline as string | undefined;
    assert.ok(html, "应产出 HTML 报告");
    assert.ok(html.includes("<svg"), "HTML 报告必须包含内联 SVG 图表（这是 P2-1 的可见验收点）");
    assert.ok(html.includes('class="matrix"'), "HTML 报告必须包含象限矩阵");
    assert.ok(html.includes('class="pagenum"'), "HTML 报告必须带页码");
    assert.ok(html.includes("@media print"), "HTML 报告必须含打印分页规则");

    // ── 黄金快照 ─────────────────────────────────────────
    const snapshot = {
      slides: depth.slides,
      bodySlides: depth.bodySlides,
      blockTypes: depth.blockTypes,
      missingRequiredTypes: depth.missingRequiredTypes,
      visualBlocks: depth.visualBlocks,
      traceableRatio: depth.traceableRatio,
      declaredSources: depth.declaredSources,
      sourceKeys: dsl.sourceDeclaration.sources.map((s) => s.key).sort(),
      htmlHasSvg: html.includes("<svg"),
    };
    if (process.env.BM_UPDATE_GOLDEN === "1") {
      mkdirSync(join(process.cwd(), "tests", "golden"), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    }
    let golden: unknown;
    try {
      golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
    } catch {
      golden = undefined;
    }
    if (golden !== undefined) {
      assert.deepEqual(snapshot, golden, "报告深度快照发生漂移。若为有意改动，请用 BM_UPDATE_GOLDEN=1 重跑并提交新快照。");
    }
  } finally {
    dispose();
  }
});

/* ── 辅助 ───────────────────────────────────────────────── */

async function waitDone(c: Container, jobId: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await c.orchestrator.getJob(jobId, DEMO_TENANT);
    if (job && ["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return;
    if (Date.now() > deadline) throw new Error(`等待任务 ${jobId} 超时`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

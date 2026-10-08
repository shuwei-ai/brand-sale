/**
 * 治理口径修正的回归测试。
 *
 * 这三条都不是"功能坏了"，而是**口径错了** —— 所以原先没有任何用例失败，
 * 只能靠专门写测试把不变量钉住：
 *
 *   1. 合规布尔量 `legalApproved` 不得依赖默认值（漏写 = 法务已批准，方向反了）
 *   2. 源的"排除项"必须把**所有**未通过的门列全，而不是只报第一道
 *   3. 兜底文案不得引用本系统未接入的数据源（否则报告会声明一个不存在的来源）
 *
 * 运行：npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@brandsale/config";
import type { TenantContext } from "@brandsale/contracts";
import {
  CreatorCandidatesSchema,
  type ToolCallContext,
} from "@brandsale/agent-pack";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { resolveLegalApproved, seed, DEMO_TENANT } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_test", traceId: "trace_test", locale: "zh-CN" };

async function freshContainer(): Promise<{ c: Container; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-gov-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock" });
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

const toolCtx = (): ToolCallContext => ({
  ctx,
  jobId: "job_gov_test",
  phase: "intake",
  attempt: 1,
  emit: () => {},
  signal: new AbortController().signal,
});

/* ── 1. legalApproved：默认拒绝，不默认放行 ───────────────── */

test("E2E-GOV-DEFAULT-1：L4 条目漏写 legalApproved 必须报错，不得静默变成'法务已批准'", () => {
  // 这是本次修正的核心：早先默认值是 true，于是"漏写"等于"法务已批准"，
  // 而 legalApproved 正是 L4 双重开关（config.tiers.L4 + 本字段）的一半。
  assert.throws(
    () => resolveLegalApproved({ sourceId: "l4_forgot", tier: "L4" }),
    /必须显式声明 legalApproved/,
    "L4 漏写是意图错误，应在 seed 期就炸掉而不是带着默认值写进台账",
  );
});

test("E2E-GOV-DEFAULT-2：非 L4 漏写按默认拒绝处理，显式值原样保留", () => {
  assert.equal(resolveLegalApproved({ sourceId: "l3_forgot", tier: "L3" }), false, "漏写必须默认拒绝");
  assert.equal(resolveLegalApproved({ sourceId: "l3_ok", tier: "L3", legalApproved: true }), true, "显式 true 保留");
  assert.equal(
    resolveLegalApproved({ sourceId: "l4_declared", tier: "L4", legalApproved: false }),
    false,
    "显式 false 不得被覆盖 —— 否则'先登记、法务后补'的既有设计就没了",
  );
});

test("E2E-GOV-DEFAULT-3：种子台账里三条 L3 源显式批准、L4 源未批准", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const rows = c.repos.sources.list(DEMO_TENANT);
    const byId = new Map(rows.map((r) => [r.sourceId, r]));
    for (const id of ["volc_web_search", "douyin_web_public", "xhs_web_public"]) {
      assert.equal(byId.get(id)?.legalApproved, true, `${id} 是公开源，应显式批准`);
    }
    assert.equal(byId.get("l4_example_vendor")?.legalApproved, false, "L4 源必须保持未批准");
  } finally {
    dispose();
  }
});

/* ── 2. 排除项必须把门列全 ────────────────────────────────── */

test("E2E-GOV-REASON-1：L4 源既无授权又未过法务时，两个原因都要出现", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const tool = c.agentPack.registry.get("resolve_authorization");
    assert.ok(tool, "resolve_authorization 应已注册");

    const out = (await tool.execute({}, toolCtx())) as {
      result: { usableSources: { sourceId: string; tier: string; expiresAt: string }[]; blockedSources: { sourceId: string; reason: string }[] };
    };

    // 三条 L3 可用
    const usableIds = out.result.usableSources.map((s) => s.sourceId).sort();
    assert.deepEqual(usableIds, ["douyin_web_public", "volc_web_search", "xhs_web_public"]);
    assert.ok(out.result.usableSources.every((s) => s.tier === "L3"), "可用的必须都是 L3");

    // L4 被拦，且原因必须**两条都写出来**
    const blocked = out.result.blockedSources.find((b) => b.sourceId === "l4_example_vendor");
    assert.ok(blocked, "l4_example_vendor 应出现在 blockedSources");
    assert.match(blocked.reason, /无生效授权/, "应说明缺授权");
    assert.match(
      blocked.reason,
      /L4 源法务未批准/,
      "还必须说明法务未批 —— 只报'无生效授权'会让读者以为补个授权就能用",
    );
  } finally {
    dispose();
  }
});

test("E2E-GOV-REASON-2：补上授权后，原因只剩法务那条（证明两条门是并列而非短路）", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const now = Date.now();
    await c.gate.grantAuthz(
      {
        tenantId: DEMO_TENANT,
        sourceId: "l4_example_vendor",
        grantedBy: "测试",
        validFrom: new Date(now).toISOString(),
        validTo: new Date(now + 86_400_000).toISOString(),
        scopes: ["read"],
      },
      ctx,
    );

    const tool = c.agentPack.registry.get("resolve_authorization");
    const out = (await tool!.execute({}, toolCtx())) as {
      result: { blockedSources: { sourceId: string; reason: string }[] };
    };
    const blocked = out.result.blockedSources.find((b) => b.sourceId === "l4_example_vendor");
    assert.ok(blocked, "授权有了但法务没批，仍必须被拦");
    assert.equal(blocked.reason, "L4 源法务未批准", "此时只剩法务一道门");
  } finally {
    dispose();
  }
});

/* ── 3. 兜底文案不得引用未接入的数据源 ───────────────────── */

test("E2E-GOV-STALE-1：兜底产物不得声明本系统没有的数据源", () => {
  // 背景：agents.ts 的提示词明令"本系统没有千川/星图/蒲公英/生意参谋/巨量算数，
  // 禁止在 sourceDeclaration 里声明它们"，而兜底字符串却写过
  // "无生效授权，无法访问星图达人画像" —— 模型失败时反而由兜底编出一个来源。
  // 模型失败时的产出同样要过这一关。
  const absent = ["星图", "千川", "蒲公英", "生意参谋", "巨量算数"];

  const mock = CreatorCandidatesSchema.mock();
  const excluded = mock.excluded.map((e) => e.reason).join("；");
  for (const name of absent) {
    assert.doesNotMatch(excluded, new RegExp(name), `兜底的排除项不得提及未接入的「${name}」`);
  }
  assert.match(excluded, /粉丝画像|报价/, "排除项仍应说明真实存在的数据缺口，不能是空话");
});

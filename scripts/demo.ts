/**
 * 端到端演示：Brief → 情报 → 人选 → 打法 → 预算 → 研报
 *
 *   tsx scripts/demo.ts            # 走真实模型端点
 *   BM_LLM_MODE=mock tsx scripts/demo.ts   # 离线桩，无模型也能跑通全链路
 *
 * 演示会依次打印：阶段进度 → 工具调用 → 闸门拦截 → 降级 → 成本 → 报告落盘。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@brandsale/config";
import { PHASE_LABEL } from "@brandsale/contracts";
import type { JobStreamEvent } from "@brandsale/contracts";
import { createContainer } from "../apps/gateway/src/container.ts";
import { seed, DEMO_TENANT } from "./seed.ts";

const OUT = resolve(process.cwd(), "out");

async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config);

  for (const w of container.warnings) console.warn(`[demo] ⚠️  ${w}`);

  const health = await container.gateway.health();
  console.log(`\n=== 环境 ===`);
  console.log(`模型模式：${config.llm.mode === "mock" ? "mock（离线桩）" : "live"}`);
  console.log(`端点：${config.llm.baseUrl}  模型：${config.llm.models.medium}`);
  console.log(`端点健康：${health.ok ? `可用，模型 ${health.models.join(", ")}` : `不可用（${health.error}）`}`);
  console.log(`数据库：${config.storage.sqlitePath}`);

  if (container.repos.sources.list(DEMO_TENANT).length === 0) {
    console.log(`\n=== 首次运行，写入种子数据 ===`);
    const out = await seed();
    console.log(`知识库 ${out.chunks} 条 / 达人 ${out.talents} 位`);
    container.repos.sources.list(DEMO_TENANT);
  }

  console.log(`\n=== 数据源台账 ===`);
  for (const s of container.repos.sources.list(DEMO_TENANT)) {
    const az = container.repos.authz.active(DEMO_TENANT, s.sourceId);
    console.log(
      `  ${s.sourceId.padEnd(20)} ${s.tier}  ${az ? `已授权至 ${az.validTo.slice(0, 10)}` : s.tier === "L4" ? "法务未批准（预期被拦）" : "未授权"}`,
    );
  }

  const ctx = { tenantId: DEMO_TENANT, userId: "u_demo", traceId: `trace_${Date.now()}`, locale: "zh-CN" as const };

  console.log(`\n=== 启动任务 ===`);
  const started = await container.orchestrator.startJob(
    {
      idempotencyKey: `demo_${Date.now()}`,
      spec: {
        brief: {
          industry: "美妆",
          category: "护肤品-精华",
          brandIds: ["brand_A"],
          budget: { currency: "CNY", amount: 3_000_000 },
          objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
          window: { from: "2026-05-20", to: "2026-06-20" },
          platforms: ["douyin", "xiaohongshu"],
          notes: "主打新品抗老精华，竞品锁定 X/Y",
        },
      },
    },
    ctx,
  );
  const jobId = started.jobId;
  console.log(`jobId = ${jobId}`);

  /* 订阅事件 */
  const seen = new Map<string, number>();
  let blocks = 0;
  let lastPhase = "";
  const subscribe = container.orchestrator.subscribe(jobId, -1, (e: JobStreamEvent) => {
    seen.set(e.type, (seen.get(e.type) ?? 0) + 1);
    switch (e.type) {
      case "phase.start":
        lastPhase = e.phase;
        console.log(`\n▶ ${PHASE_LABEL[e.phase]}（预计 ${(e.estimatedMs / 1000).toFixed(0)}s）`);
        break;
      case "phase.complete":
        console.log(`✔ ${e.summary}`);
        break;
      case "governance.block":
        blocks += 1;
        console.log(`⛔ 闸门拦截 [${e.code}] ${e.tool}：${e.reason}`);
        break;
      case "data.degraded":
        console.log(`⚠️  降级 ${e.source}：${e.reason}（缺失 ${e.missing.length} 项）`);
        break;
      case "cost.update":
        console.log(`💰 阶段成本 ¥${e.amount.amount.toFixed(4)} / ${e.tokens.inputTokens + e.tokens.outputTokens} tokens`);
        break;
      case "agent.delta":
        process.stdout.write(e.delta);
        break;
      case "job.done":
        console.log(`\n\n=== 任务完成 ===`);
        break;
      default:
        break;
    }
  });

  /* 等待终态。live 模式下真实生成比 mock 慢 1~2 个数量级，
   * 上限取配置的任务预算；mock 模式 5 分钟绰绰有余 */
  const waitBudgetMs = (config.llm.mode === "mock" ? 5 : Math.min(config.job.maxJobMinutes, 20)) * 60_000;
  const deadline = Date.now() + waitBudgetMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const job = await container.orchestrator.getJob(jobId, DEMO_TENANT);
    if (job && (job.status === "succeeded" || job.status === "partial" || job.status === "failed" || job.status === "cancelled")) break;
    if (Date.now() > deadline) {
      console.log("\n[demo] 等待超时，强制结束观察");
      break;
    }
  }
  subscribe();
  void lastPhase;

  const job = (await container.orchestrator.getJob(jobId, DEMO_TENANT))!;
  const phases = await container.orchestrator.listPhases(jobId);
  const usage = await container.orchestrator.getUsage(jobId);

  console.log(`\n状态：${job.status}  进度：${(job.progress.percent * 100).toFixed(0)}%`);
  console.log(`\n=== 阶段检查点 ===`);
  for (const p of phases) {
    console.log(`  ${PHASE_LABEL[p.phase].padEnd(12)} ${p.status.padEnd(10)} 尝试 ${p.attempts} 次  成本 ¥${p.cost.amount.toFixed(4)}  ${p.errorCode ?? ""}`);
  }

  console.log(`\n=== 成本 ===`);
  console.log(`  合计 ¥${usage?.cost.amount.toFixed(4)}（${usage?.tokens.calls} 次模型调用，${usage?.tokens.inputTokens} 输入 / ${usage?.tokens.outputTokens} 输出 tokens）`);

  console.log(`\n=== 工具调用与治理 ===`);
  console.log(`  工具调用总数：${container.agentPack.registry.callCount()}`);
  console.log(`  主流程闸门拦截次数：${blocks}（治理验证见文末）`);
  const auditSummary = container.repos.audit.countByKind(DEMO_TENANT);
  console.log(`  审计分布：${Object.entries(auditSummary).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  console.log(`\n=== 血缘台账（M5） ===`);
  for (const l of container.ledger.byJob(jobId)) {
    console.log(`  ${l.phase.padEnd(9)} 输入 ${l.inputs.length} 个源（${l.inputs.map((i) => i.sourceId).join(",") || "无"}）  输出 ${l.outputs.length} 项`);
  }

  console.log(`\n=== 降级与缺失（报告「排除项」来源） ===`);
  if (job.degraded.length === 0) console.log("  无降级");
  for (const d of job.degraded) console.log(`  [${d.reason}] ${d.note ?? ""}  缺失：${d.missing.slice(0, 4).join(" | ")}`);

  /* 落盘报告 */
  mkdirSync(OUT, { recursive: true });
  const artifacts = container.repos.artifacts.list(jobId);
  const html = artifacts.find((a) => a.kind === "report_html");
  const md = artifacts.find((a) => a.kind === "report_markdown");
  const dsl = artifacts.find((a) => a.kind === "report_dsl");
  if (html?.inline) {
    const p = resolve(OUT, `报告-${jobId}.html`);
    writeFileSync(p, String(html.inline));
    console.log(`\n报告 HTML：${p}`);
  }
  if (md?.inline) {
    const p = resolve(OUT, `报告-${jobId}.md`);
    writeFileSync(p, String(md.inline));
    console.log(`报告 Markdown：${p}`);
  }
  if (dsl?.inline) {
    const p = resolve(OUT, `报告DSL-${jobId}.json`);
    writeFileSync(p, JSON.stringify(dsl.inline, null, 2));
    console.log(`报告 DSL：${p}`);
  }
  if (!html && !md) console.log("\n未产出报告（任务未走到 RG 阶段或缺 DSL）");

  /* 治理验证：证明"闸门是唯一通路" */
  console.log(`\n=== 治理验证（M3 闸门） ===`);
  const gateCases: { name: string; req: Parameters<typeof container.gate.evaluate>[0]; expect: string }[] = [
    {
      name: "访问 L4 源（配置开但法务未批 → 双重开关）",
      expect: "E-DATA-004",
      req: { tenantId: DEMO_TENANT, jobId, agent: "CI", tool: "web_search", args: { sourceId: "l4_example_vendor" }, checks: ["scope", "source", "authz", "tenant"] },
    },
    {
      name: "访问未登记的数据源",
      expect: "E-GOV-001",
      req: { tenantId: DEMO_TENANT, jobId, agent: "CI", tool: "web_search", args: { sourceId: "not_registered_source" }, checks: ["scope", "source", "authz", "tenant"] },
    },
    {
      name: "请求体 tenantId 与令牌不一致（跨租户）",
      expect: "E-GOV-003",
      req: { tenantId: DEMO_TENANT, jobId, agent: "CI", tool: "web_search", args: { sourceId: "volc_web_search", tenantId: "tenant_other" }, checks: ["scope", "source", "authz", "tenant"] },
    },
    {
      name: "语义拒绝清单命中",
      expect: "E-GOV-005",
      req: { tenantId: DEMO_TENANT, jobId, agent: "BR", tool: "scenario_simulate", args: { budgetAmount: 99_000_000 }, checks: ["scope", "source", "authz", "tenant", "semantic"] },
    },
  ];
  for (const gc of gateCases) {
    const v = await container.gate.evaluate(gc.req, ctx);
    const mark = !v.allow && v.code === gc.expect ? "✅" : "❌";
    console.log(`  ${mark} ${gc.name}\n      → allow=${v.allow} code=${v.code} fatal=${v.fatal} reason=${v.reason}`);
  }

  /* 工具白名单：AO 调用只属于 CT 的工具 */
  try {
    await container.agentPack.registry.invoke(
      "pricing_query",
      { talentId: "t_1001" },
      "AO",
      { ctx, jobId, phase: "intake", attempt: 1, emit: () => {}, signal: new AbortController().signal },
    );
    console.log("  ❌ 工具白名单未生效（AO 竟然能调用 pricing_query）");
  } catch (e) {
    console.log(`  ✅ 工具白名单生效：AO 调用 pricing_query 被拒（${(e as Error).message.slice(0, 60)}）`);
  }

  /* 事件类型分布 */
  console.log(`\n=== SSE 事件分布 ===`);
  for (const [t, c] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(20)} ${c}`);

  container.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

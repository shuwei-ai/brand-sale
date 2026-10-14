/**
 * 「进度不实时 / 刷新后流式输出消失」两条前端反馈的回归用例。
 *
 * 两条都属于"实现看起来是对的、行为却是错的"那一类，所以必须有确定性用例盯着：
 *
 * ① **进度不落库**。编排器一直在 publish `job.status`，前端也一直在渲染事件流 ——
 *    但库里的 `jobs.percent` 从任务开始到结束只写过两次（0 与 1）。
 *    任务列表（5s 轮询）与**刷新后的**详情页都只读库，于是永远显示 0%。
 *    实测证据：`job_0mv3naqbof24i3dzdur` 的 job_phases 已跑到 report，
 *    而 `GET /api/v1/jobs/<id>` 仍返回 `progress {"percent":0,"currentPhase":"intake"}`。
 *
 * ② **delta 洪水挤爆回放窗口**。事件表只保留最近 2000 条，而一次真实任务有 1.6 万条
 *    `agent.delta` —— 混在一个窗口里按 seq 裁剪，几十条状态事件会被整段挤出去。
 *    实测：刷新（不带 Last-Event-ID）连 `/stream` 抓 8 秒，收到 2716 帧里
 *    **2715 帧是 delta、0 帧 phase.* / job.status**，事件日志空白。
 *
 * 运行：npm test（mock 模式，不依赖外部服务）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@brandsale/config";
import { DELTA_BUFFER_SIZE, PHASE_ORDER, type Brief, type PhaseName, type TenantContext } from "@brandsale/contracts";
import { migrate, openDb, Repositories } from "@brandsale/storage";
import { DeltaPump } from "@brandsale/agent-pack";
import { EventBus } from "@brandsale/orchestrator";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { DEMO_TENANT, seed } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_test", traceId: "trace_test", locale: "zh-CN" };

const BRIEF: Brief = {
  industry: "美妆",
  category: "护肤品-精华",
  brandIds: ["brand_A"],
  budget: { currency: "CNY", amount: 3_000_000 },
  objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
  window: { from: "2026-05-20", to: "2026-06-20" },
  platforms: ["douyin", "xiaohongshu"],
};

/* ── 事件缓冲：分桶裁剪 ─────────────────────────────────── */

test("事件缓冲分桶：1.6 万条 delta 不会把状态类事件挤出回放窗口", () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-events-"));
  try {
    const db = openDb(join(dir, "events.sqlite"));
    migrate(db);
    const repos = new Repositories(db);

    // 按真实节奏造：每 200 条 delta 夹 1 条状态事件（实测 30k+ 事件里绝大多数是 delta）
    let seq = 0;
    const STATE_EVENTS = 40;
    for (let i = 0; i < STATE_EVENTS; i++) {
      for (let k = 0; k < 200; k++) repos.events.append("j1", ++seq, "agent.delta", { type: "agent.delta", delta: "x" });
      repos.events.append("j1", ++seq, "phase.complete", { type: "phase.complete", phase: "intel" });
    }

    const kept = repos.events.since("j1", 0);
    const state = kept.filter((r) => r.type !== "agent.delta");
    const deltas = kept.filter((r) => r.type === "agent.delta");

    assert.equal(state.length, STATE_EVENTS, "状态类事件必须一条都不能丢（远未到自身容量上限）");
    assert.ok(
      deltas.length <= DELTA_BUFFER_SIZE,
      `delta 桶应被裁到 ${DELTA_BUFFER_SIZE} 条以内，实际 ${deltas.length}`,
    );
    assert.ok(deltas.length > 0, "delta 仍要保留最近一段，供带 Last-Event-ID 的续传补缺口");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回放：显式排除 agent.delta 时只返回状态类事件，且顺序不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-events-"));
  try {
    const db = openDb(join(dir, "replay.sqlite"));
    migrate(db);
    const repos = new Repositories(db);
    const bus = new EventBus(repos);

    bus.publish("j1", { type: "phase.start", phase: "intel", estimatedMs: 1000 });
    bus.publish("j1", { type: "agent.delta", agent: "CI", kind: "text", delta: "a" });
    bus.publish("j1", { type: "agent.delta", agent: "CI", kind: "text", delta: "b" });
    bus.publish("j1", { type: "phase.complete", phase: "intel", summary: "ok" });

    assert.deepEqual(
      bus.replay("j1", -1, ["agent.delta"]).map((e) => e.type),
      ["phase.start", "phase.complete"],
      "全量回放应当只补状态类事件",
    );
    assert.deepEqual(
      bus.replay("j1", -1).map((e) => e.type),
      ["phase.start", "agent.delta", "agent.delta", "phase.complete"],
      "默认回放行为不变（断线续传要补上缺口里的正文）",
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Orchestrator.subscribe：新开页面（无 Last-Event-ID）不回放 delta，续传仍然回放", () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-events-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock" });
  const c = createContainer(config);
  try {
    // 用真实的 Orchestrator（不是它的复刻件）：回放语义只该有一份实现
    c.bus.publish("j2", { type: "job.status", status: "running", progress: { percent: 0.5, currentPhase: "intel" } });
    c.bus.publish("j2", { type: "agent.delta", agent: "CI", kind: "text", delta: "hello" });

    const fresh: string[] = [];
    c.orchestrator.subscribe("j2", null, (e) => fresh.push(e.type))();
    assert.deepEqual(fresh, ["job.status"], "刷新后只需要状态事件来重建进度条与日志");

    const resumed: string[] = [];
    c.orchestrator.subscribe("j2", 1, (e) => resumed.push(e.type))();
    assert.deepEqual(resumed, ["agent.delta"], "带 Last-Event-ID 的续传不该丢掉正文增量");
  } finally {
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 进度落库 ───────────────────────────────────────────── */

/** 每个用例一份独立库 + 一份种子数据 */
async function freshContainer(): Promise<{ c: Container; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-stream-"));
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

async function waitDone(c: Container, jobId: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await c.orchestrator.getJob(jobId, DEMO_TENANT);
    if (job && ["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return;
    if (Date.now() > deadline) throw new Error(`等待任务 ${jobId} 超时`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("运行期进度落库：每个阶段开跑时 jobs.progress 已经是该阶段的真实进度", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const { jobId } = await c.orchestrator.startJob({ idempotencyKey: "k-progress", spec: { brief: BRIEF } }, ctx);
    await waitDone(c, jobId);

    /* 重算 playbook 及其下游，并在**订阅之后**触发 —— 这样整段执行都在观察窗口内，
     * 不会出现"intake 的 phase.start 在我们挂上监听之前就发完了"的竞态。 */
    const seen: { phase: PhaseName; percent: number; currentPhase: PhaseName | null }[] = [];
    const unsubscribe = c.bus.subscribe(jobId, (e) => {
      if (e.type !== "phase.start") return;
      const job = c.repos.jobs.get(jobId)!;
      seen.push({ phase: e.phase, percent: job.progress.percent, currentPhase: job.progress.currentPhase });
    });
    await c.orchestrator.rerunPhase(jobId, DEMO_TENANT, "playbook");
    await waitDone(c, jobId);
    unsubscribe();

    assert.deepEqual(
      seen.map((s) => s.phase),
      ["playbook", "budget", "report"],
      "重算应恰好重跑该阶段及其下游",
    );
    // 关键断言：库里写的是"正在跑的这个阶段"的进度，而不是任务开始时那句 percent=0
    for (const s of seen) {
      const expected = PHASE_ORDER.indexOf(s.phase) / PHASE_ORDER.length;
      assert.equal(s.percent, expected, `${s.phase} 落库进度应为 ${expected}，实际 ${s.percent}`);
      assert.equal(s.currentPhase, s.phase, `落库 currentPhase 应为 ${s.phase}，实际 ${String(s.currentPhase)}`);
    }
    assert.ok(seen.length >= 3, "至少要观察到下游三个阶段");
  } finally {
    dispose();
  }
});

/* ── 流式合帧 ───────────────────────────────────────────── */

test("DeltaPump：细碎增量被合帧，且收尾时最后一段必须吐出去", () => {
  const frames: string[] = [];
  // flushMs 调到极大 → 只由 maxChars 触发成帧，测试因此完全确定性
  const pump = new DeltaPump((d) => frames.push(d), 60_000, 10);

  const chunks = ["abcde", "fghij", "klmno", "pqrst", "uvwxy"];
  for (const ch of chunks) pump.push(ch);

  assert.ok(frames.length > 0 && frames.length < chunks.length, `应合帧：${chunks.length} 个增量 → ${frames.length} 帧`);
  pump.flush(); // 尾巴
  assert.equal(frames.join(""), chunks.join(""), "合帧不得丢字");

  const before = frames.length;
  pump.flush();
  assert.equal(frames.length, before, "空缓冲不应产生空帧");

  pump.push(undefined);
  pump.flush();
  assert.equal(frames.length, before, "空增量不应产生空帧");
});

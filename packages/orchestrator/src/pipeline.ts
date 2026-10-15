/**
 * M2 OrchestratorPort 实现（对应 LLD §2.3 + §2.13）
 *
 * 这是全系统唯一 import Pi 生态的编排实现（通过 AgentPack 间接使用 pi-agent-core）。
 * 业务侧只依赖 `IOrchestratorPort`，将来换实现（预案 Mastra）不影响调用方。
 *
 * 崩溃恢复的语义（对应 E2E 用例 5）：
 *   - 阶段完成即写 checkpoint（job_phases.status + output_json）；
 *   - 重启后 `recover()` 从未完成的阶段继续，已完成的阶段**不重跑**；
 *   - 用量以 (jobId, phase, attempt, callId) 幂等写入，恢复后**不重复扣费**。
 */

import {
  AppError,
  DEFAULT_DEPTH_POLICY,
  PHASE_LABEL,
  PHASE_ORDER,
  type IOrchestratorPort,
  type JobHandle,
  type ArtifactKind,
  type JobRecord,
  type JobStreamEvent,
  type PhaseName,
  type PhaseRunInput,
  type PhaseState,
  type ReportDsl,
  type StartJobInput,
  type TenantContext,
  type UsageSummary,
} from "@brandsale/contracts";
import type { Config } from "@brandsale/config";
import type { AgentPack } from "@brandsale/agent-pack";
import type { RenderService } from "@brandsale/render";
import { newId, type Repositories } from "@brandsale/storage";
import { EventBus } from "./event-bus.ts";

const PHASE_ESTIMATE_MS: Record<PhaseName, number> = {
  intake: 4_000,
  intel: 45_000,
  creator: 40_000,
  playbook: 35_000,
  budget: 35_000,
  report: 60_000,
};

export interface OrchestratorDeps {
  config: Config;
  repos: Repositories;
  agentPack: AgentPack;
  render: RenderService;
  bus: EventBus;
  /**
   * 报告产出后的收尾钩子（可选，**best-effort**）。
   *
   * 为什么做成注入的回调、而不是在这里直接调 knowledge：
   *   依赖矩阵是 `apps → orchestrator → agent-pack → knowledge`，
   *   orchestrator **不允许**依赖 knowledge。把"报告摘要回灌"这件事放在装配层
   *   （container，它可以同时看到两边），编排层只负责在正确的时机调用它。
   *
   * 契约：**不得抛错**；万一异常由编排层捕获并记 degraded，绝不影响任务成败——
   * 回灌是"锦上添花"，不是报告产出的一部分。
   */
  onReportReady?: (input: { job: JobRecord; dsl: ReportDsl; ctx: TenantContext }) => Promise<void>;
}

const ARTIFACT_KIND_BY_PHASE: Record<PhaseName, ArtifactKind> = {
  intake: "brief",
  intel: "intel",
  creator: "creator_candidates",
  playbook: "playbook",
  budget: "budget",
  report: "report_dsl",
};

/**
 * 请求体指纹（幂等判定用）。
 *
 * 注意：不能用 `JSON.stringify(v, Object.keys(v).sort())` —— 那个 replacer 数组
 * 对**所有层级**都生效，只保留顶层出现过的键名，于是 `{brief:{a:1}}` 与
 * `{brief:{a:2}}` 会被同时压成 `{"brief":{}}`，指纹恒等，冲突永远发现不了。
 * 这里改成显式递归、逐层按键名排序后序列化。
 */
const fingerprintOf = (spec: unknown): string => {
  const json = stableStringify(spec);
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

/** 进程/容器关闭时中断后台任务用的内部控制流信号（不落库、不通知） */
class JobAbortedError extends Error {
  constructor() {
    super("orchestrator shutting down");
    this.name = "JobAbortedError";
  }
}

export class Orchestrator implements IOrchestratorPort {
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  /** 关闭后所有后台任务立即停手，避免写已关闭的数据库 */
  private shuttingDown = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  get bus(): EventBus {
    return this.deps.bus;
  }

  /**
   * 幂等关闭：中断全部在跑的任务。
   * 必须在 db.close() 之前同步调用 —— 它只置标志 + abort，
   * 在途任务恢复执行时会在下一个守卫点自行退出，不再触碰连接。
   */
  shutdown(): void {
    this.shuttingDown = true;
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.running.clear();
  }

  /** 每个 await 之后、任何落库动作之前调用 */
  private assertAlive(): void {
    if (this.shuttingDown) throw new JobAbortedError();
  }

  /* ── 启动 ─────────────────────────────────────────────── */

  async startJob(input: StartJobInput, ctx: TenantContext): Promise<JobHandle> {
    const fp = fingerprintOf(input.spec);
    const existing = this.deps.repos.idempotency.get(ctx.tenantId, input.idempotencyKey);

    if (existing) {
      if (existing.fingerprint !== fp) {
        throw new AppError({
          code: "E-JOB-002",
          message: "同一 Idempotency-Key 对应的请求体不一致",
          userMessage: "该请求标识已被用于另一份不同的参数，请更换标识后重试",
          details: { idempotencyKey: input.idempotencyKey },
        });
      }
      return { jobId: existing.jobId, reused: true };
    }

    const jobId = newId("job");
    const job = this.deps.repos.jobs.create({
      jobId,
      tenantId: ctx.tenantId,
      createdBy: ctx.userId,
      spec: input.spec,
      idempotencyKey: input.idempotencyKey,
    });
    this.deps.repos.idempotency.put(ctx.tenantId, input.idempotencyKey, fp, jobId);
    for (const p of PHASE_ORDER) this.deps.repos.phases.ensure(jobId, p);

    this.deps.bus.publish(jobId, {
      type: "job.status",
      status: "queued",
      progress: { percent: 0, currentPhase: null },
    });

    // 后台执行，立即返回
    void this.runJob(jobId, { ...ctx, jobId }, input.rerunFrom ? PHASE_ORDER.indexOf(input.rerunFrom) : 0);

    return { jobId, reused: false };
  }

  /* ── 执行 ─────────────────────────────────────────────── */

  private async runJob(jobId: string, ctx: TenantContext, startIndex: number): Promise<void> {
    if (this.running.has(jobId) || this.shuttingDown) return;
    this.running.add(jobId);
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    this.deps.repos.jobs.setStatus(jobId, "running", undefined, PHASE_ORDER[startIndex] ?? null);

    const upstream: Partial<Record<PhaseName, unknown>> = {};

    try {
      // 恢复：把已完成阶段的上游产物读回来，避免重跑
      for (let i = 0; i < startIndex; i++) {
        const p = PHASE_ORDER[i]!;
        const st = this.deps.repos.phases.get(jobId, p);
        if (st?.status === "succeeded" || st?.status === "partial") upstream[p] = st.output;
      }

      for (let i = startIndex; i < PHASE_ORDER.length; i++) {
        this.assertAlive();
        const phase = PHASE_ORDER[i]!;
        const job = this.deps.repos.jobs.get(jobId)!;

        const existing = this.deps.repos.phases.get(jobId, phase);
        if (existing && (existing.status === "succeeded" || existing.status === "partial")) {
          // 断点续跑：该阶段已完成，直接复用
          upstream[phase] = existing.output;
          this.deps.repos.jobs.setStatus(jobId, "running", (i + 1) / PHASE_ORDER.length, phase);
          this.deps.bus.publish(jobId, {
            type: "job.status",
            status: "running",
            progress: { percent: (i + 1) / PHASE_ORDER.length, currentPhase: phase },
          });
          this.deps.bus.publish(jobId, {
            type: "phase.complete",
            phase,
            summary: `${PHASE_LABEL[phase]}（复用已完成的检查点，未重跑）`,
            ...(existing.degraded ? { degraded: existing.degraded } : {}),
          });
          continue;
        }

        const attempt = (existing?.attempts ?? 0) + 1;
        this.deps.repos.phases.ensure(jobId, phase);
        this.deps.repos.phases.markStarted(jobId, phase, attempt);
        /* 进度必须**同时落库**：列表页（5s 轮询）与详情页刷新后都只读 `jobs.progress`。
         * 只 publish 不写库是曾经的 bug —— 运行期 percent 恒为 0，
         * 前端刷得再勤也拿不到真实进度（job_phases 早已跑到 report，列表仍显示 0%）。 */
        this.deps.repos.jobs.setStatus(jobId, "running", i / PHASE_ORDER.length, phase);
        this.deps.bus.publish(jobId, { type: "phase.start", phase, estimatedMs: PHASE_ESTIMATE_MS[phase] });
        this.deps.bus.publish(jobId, {
          type: "job.status",
          status: "running",
          progress: { percent: i / PHASE_ORDER.length, currentPhase: phase },
        });

        const input: PhaseRunInput = {
          job,
          ctx,
          upstream,
          emit: (e: JobStreamEvent) => {
            this.deps.bus.publish(jobId, e as never);
          },
          signal: controller.signal,
        };

        const result = await this.deps.agentPack.runPhase(phase, input);
        this.assertAlive(); // 阶段跑完先确认容器还在，再开始写检查点
        const cost = result.cost;

        this.deps.repos.phases.markFinished(jobId, phase, result.status, {
          output: result.output,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          ...(result.degradedKeys?.length
            ? { degraded: { missing: result.degradedKeys, reason: "partial_output" as const, note: `${PHASE_LABEL[phase]} 存在缺失项` } }
            : {}),
          cost,
        });

        if (result.degradedKeys?.length) {
          this.deps.repos.jobs.addDegraded(jobId, { missing: result.degradedKeys, reason: "partial_output", note: `${PHASE_LABEL[phase]} 降级` });
          this.deps.bus.publish(jobId, {
            type: "data.degraded",
            source: phase,
            missing: result.degradedKeys,
            reason: "partial_output",
          });
        }

        this.deps.bus.publish(jobId, {
          type: "cost.update",
          amount: cost,
          tokens: result.usage,
        });

        if (result.status === "succeeded" || result.status === "partial") {
          upstream[phase] = result.output;
          this.storeArtifact(jobId, phase, result.output);
          this.deps.bus.publish(jobId, {
            type: "artifact.ready",
            kind: ARTIFACT_KIND_BY_PHASE[phase],
            inline: phase === "report" ? undefined : result.output,
          });
          this.deps.bus.publish(jobId, {
            type: "phase.complete",
            phase,
            summary: `${PHASE_LABEL[phase]} ${result.status === "partial" ? "部分完成" : "完成"}（策略 ${result.strategy}，工具调用 ${result.toolCalls.length} 次）`,
          });
        } else {
          this.deps.bus.publish(jobId, {
            type: "phase.complete",
            phase,
            summary: `${PHASE_LABEL[phase]} 失败：${result.errorCode ?? "未知"} ${result.errorMessage ?? ""}`,
          });
          if (!this.deps.config.job.allowPartial) {
            this.finish(jobId, "failed", controller);
            return;
          }
        }

        // 阶段收尾：进度同样落库（列表页/刷新后的进度条都读这里）
        this.deps.repos.jobs.setStatus(jobId, "running", (i + 1) / PHASE_ORDER.length, phase);
        this.deps.bus.publish(jobId, {
          type: "job.status",
          status: "running",
          progress: { percent: (i + 1) / PHASE_ORDER.length, currentPhase: phase },
        });
      }

      // 渲染报告
      const rendered = await this.renderReport(jobId, ctx, upstream);
      this.assertAlive();

      /* 报告收尾：把机械抽取的摘要回灌知识库（best-effort，失败只记 degraded）。
       * 只在**渲染确实成功**时做：渲染被拒说明这份 DSL 没通过不变量校验，
       * 把它投影成摘要存进知识库，等于让一份不合格产物进入后续检索。 */
      if (rendered) {
        await this.runReportHook(jobId, ctx, upstream);
        this.assertAlive();
      }

      const job = this.deps.repos.jobs.get(jobId)!;
      const degraded = job.degraded.length > 0 || this.deps.repos.phases.list(jobId).some((p) => p.status === "partial" || p.status === "failed");
      this.finish(jobId, degraded ? "partial" : "succeeded", controller);
    } catch (e) {
      if (e instanceof JobAbortedError || this.shuttingDown) return; // 关闭中：不写库、不报错
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.bus.publish(jobId, { type: "job.error", code: "E-SYS-500", retryable: true, traceId: ctx.traceId });
      this.deps.repos.jobs.addDegraded(jobId, { missing: [msg], reason: "unavailable", note: "编排层异常" });
      this.finish(jobId, "failed", controller);
    } finally {
      this.running.delete(jobId);
      this.controllers.delete(jobId);
    }
  }

  private storeArtifact(jobId: string, phase: PhaseName, output: unknown): void {
    if (output === undefined) return;
    this.deps.repos.artifacts.addIfAbsent(jobId, ARTIFACT_KIND_BY_PHASE[phase], { inline: output });
  }

  /**
   * 报告渲染。返回是否**成功产出**（false = 被校验拒绝或上游缺产物）。
   *
   * 返回值不是可有可无的：`renderReport` 内部把失败吞成 degraded（这是对的，
   * 失败不该让整条任务链崩掉），但调用方需要知道"到底有没有产出报告"，
   * 才能决定要不要把摘要回灌知识库。
   */
  private async renderReport(jobId: string, ctx: TenantContext, upstream: Partial<Record<PhaseName, unknown>>): Promise<boolean> {
    const dsl = upstream.report;
    if (!dsl) return false;
    try {
      /* 来源目录由 agent-pack（内部走 governance）组装后**以纯数据传入** render ——
       * render 包只允许依赖 contracts/config，不允许在渲染期查库。
       * 少了这一步，渲染期兜底校验就无法识别「未登记来源」，收紧后的 R1~R4 会全部静默跳过。 */
      const catalog = this.deps.agentPack.sourceCatalog(ctx, jobId);
      /* `hasOwnBrand` 必须传到渲染期：R14（未指定自有品牌时不得出现「我方」口径）
       * 在 agent-pack 的自校验与渲染期的 compile 里各跑一次，
       * 少传一个地方就会出现「自校验说没问题、渲染期却拒绝渲染」的分叉。 */
      const brief = this.deps.repos.jobs.get(jobId)?.spec?.brief;
      const compiled = await this.deps.render.compile(dsl as never, {
        catalog,
        minTraceableRatio: DEFAULT_DEPTH_POLICY.minTraceableRatio,
        hasOwnBrand: Boolean((brief?.ownBrandId ?? "").trim()),
      });
      this.assertAlive();
      this.deps.repos.artifacts.addIfAbsent(jobId, compiled.kind === "html" ? "report_html" : "report_markdown", { inline: compiled.ref.inline });
      this.deps.repos.artifacts.addIfAbsent(jobId, "report_markdown", {
        // 目录一起传：条目级引用的 URL/发布时间靠它反查（否则 Markdown 里只剩 entryId）
        inline: this.deps.render.toMarkdown(dsl as never, { catalog }),
      });
      this.deps.bus.publish(jobId, { type: "artifact.ready", kind: "report_html" });
      for (const r of compiled.repairs) {
        // cosmetic = 结构页/免责页上的装饰性引用修复，内容语义零损伤，
        // 不计入 degraded（否则"免责页引用写法不规范"会把完好报告标成「产出不完整」）。
        if (r.severity === "cosmetic") continue;
        this.deps.repos.jobs.addDegraded(jobId, { missing: [r.action], reason: "partial_output", note: "渲染期自动修复" });
      }
      for (const d of compiled.dropped) {
        this.deps.repos.jobs.addDegraded(jobId, { missing: [d.content], reason: "partial_output", note: `渲染期丢弃：${d.reason}` });
      }
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.repos.jobs.addDegraded(jobId, { missing: [msg], reason: "partial_output", note: "报告渲染被拒（DSL 校验失败）" });
      this.deps.bus.publish(jobId, { type: "job.error", code: "E-RENDER-001", retryable: false, traceId: ctx.traceId });
      return false;
    }
  }

  /**
   * 调用注入的报告收尾钩子。
   *
   * **必须吞掉一切异常**：回灌知识库是可选增强，它失败不该把一份已经渲染成功的
   * 报告标成 failed。失败记 degraded（"产出完整性"里会如实列出），任务照常收尾。
   */
  private async runReportHook(jobId: string, ctx: TenantContext, upstream: Partial<Record<PhaseName, unknown>>): Promise<void> {
    const hook = this.deps.onReportReady;
    if (!hook) return;
    const dsl = upstream.report as ReportDsl | undefined;
    if (!dsl) return;
    const job = this.deps.repos.jobs.get(jobId);
    if (!job) return;
    try {
      await hook({ job, dsl, ctx });
    } catch (e) {
      if (e instanceof JobAbortedError || this.shuttingDown) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.repos.jobs.addDegraded(jobId, { missing: [msg], reason: "unavailable", note: "报告摘要回灌失败（不影响报告本身）" });
    }
  }

  private finish(jobId: string, status: "succeeded" | "partial" | "failed", controller: AbortController): void {
    if (this.shuttingDown) return;
    const artifacts = this.deps.repos.artifacts.list(jobId);
    const usage = this.usageOf(jobId);
    this.deps.repos.jobs.setStatus(jobId, status, 1, null);
    this.deps.bus.publish(jobId, { type: "job.status", status, progress: { percent: 1, currentPhase: null } });
    if (status === "failed") {
      this.deps.bus.publish(jobId, { type: "job.error", code: "E-SYS-500", retryable: true, traceId: jobId });
    } else {
      this.deps.bus.publish(jobId, { type: "job.done", artifacts, usage });
    }
    this.controllers.delete(jobId);
    void controller;
  }

  private usageOf(jobId: string): UsageSummary {
    return this.deps.repos.usage.summarize(jobId);
  }

  /* ── 查询 ─────────────────────────────────────────────── */

  async getJob(jobId: string, tenantId: string): Promise<JobRecord | null> {
    const job = this.deps.repos.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) return null;
    return job;
  }

  async listPhases(jobId: string): Promise<PhaseState[]> {
    return this.deps.repos.phases.list(jobId);
  }

  async getUsage(jobId: string): Promise<UsageSummary | null> {
    return this.usageOf(jobId);
  }

  /**
   * 订阅任务事件流。
   *
   * sinceSeq 语义（与 LLD §3.3 对齐）：
   *   - `null`：客户端**没带** Last-Event-ID。这是中途新开一个页面的常见情况，
   *     必须从头回放，否则前端拿不到已发生的事件、进度条永远停在 0。
   *   - `-1`：显式要求从头回放。
   *   - `>= 0`：断线重连，从该 seq 之后续传；若事件缓冲已过期则退化为一次视图快照。
   *
   * 全量回放（`from < 0`）会跳过 `agent.delta`：回放要解决的是"界面状态重建"，
   * 而不是重放几十万字符的正文碎片（那只会把状态事件挤出带宽与注意力）。
   * 因此前端在刷新后应当把流式正文视为"从当前时刻重新开始"。
   */
  subscribe(jobId: string, sinceSeq: number | null, listener: (e: JobStreamEvent) => void): () => void {
    const from = sinceSeq ?? -1; // 不带 = 从头回放
    const fullReplay = from < 0;

    if (this.deps.bus.canReplay(jobId, from)) {
      for (const e of this.deps.bus.replay(jobId, from, fullReplay ? ["agent.delta"] : [])) listener(e);
    } else {
      // 缓冲区已过期 → 推一次视图快照，客户端据此重建界面
      const job = this.deps.repos.jobs.get(jobId);
      if (job) {
        listener({
          type: "view.snapshot",
          seq: -1,
          at: new Date().toISOString(),
          jobId,
          status: job.status,
          progress: job.progress,
          artifacts: this.deps.repos.artifacts.list(jobId),
        } as JobStreamEvent);
      }
    }
    return this.deps.bus.subscribe(jobId, listener);
  }

  async cancelJob(jobId: string, tenantId: string, reason: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    if (!job) throw new AppError({ code: "E-AUTH-002", message: "任务不存在或不属于该租户" });
    this.controllers.get(jobId)?.abort();
    this.deps.repos.jobs.addDegraded(jobId, { missing: [], reason: "unavailable", note: `已取消：${reason}` });
    this.deps.repos.jobs.setStatus(jobId, "cancelled", job.progress.percent, null);
    this.deps.bus.publish(jobId, { type: "job.status", status: "cancelled", progress: job.progress });
  }

  /** 单模块联动重算：只重跑该阶段及其下游（E2E 用例 8） */
  async rerunPhase(jobId: string, tenantId: string, phase: PhaseName): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    if (!job) throw new AppError({ code: "E-AUTH-002", message: "任务不存在或不属于该租户" });
    const idx = PHASE_ORDER.indexOf(phase);
    const downstream = PHASE_ORDER.slice(idx);
    // 清历史降级记录：否则"已被修掉的降级"会跟着重跑活下来，重跑后仍显示「产出不完整」
    this.deps.repos.jobs.clearDegraded(jobId);
    this.deps.repos.phases.resetForRerun(jobId, downstream);
    // 清理下游产物，避免新旧混杂
    for (const p of downstream) {
      this.deps.repos.db.run(
        "DELETE FROM artifacts WHERE job_id = ? AND kind IN (?, 'report_dsl', 'report_markdown', 'report_html')",
        jobId,
        p,
      );
    }
    this.deps.repos.jobs.setStatus(jobId, "running", idx / PHASE_ORDER.length, phase);
    this.deps.bus.publish(jobId, { type: "job.status", status: "running", progress: { percent: idx / PHASE_ORDER.length, currentPhase: phase } });
    void this.runJob(jobId, { ...tenantCtxFromJob(job), jobId, tenantId }, idx);
  }

  /* ── 崩溃恢复 ─────────────────────────────────────────── */

  async recover(ctx: Omit<TenantContext, "jobId">): Promise<{ resumed: string[]; skipped: string[] }> {
    const resumed: string[] = [];
    const skipped: string[] = [];
    for (const job of this.deps.repos.jobs.findUnfinished()) {
      const phases = this.deps.repos.phases.list(job.jobId);
      const next = phases.find((p) => p.status !== "succeeded" && p.status !== "partial" && p.status !== "skipped");
      if (!next) {
        // 所有阶段都已完成，只是没写终态 → 直接补终态，不重跑
        this.deps.repos.jobs.setStatus(job.jobId, "succeeded", 1, null);
        skipped.push(job.jobId);
        continue;
      }
      resumed.push(job.jobId);
      void this.runJob(job.jobId, { ...ctx, jobId: job.jobId, tenantId: job.tenantId }, PHASE_ORDER.indexOf(next.phase));
    }
    return { resumed, skipped };
  }

  /** 运行中的 job 的 tenant 上下文（恢复时可重建 traceId） */
  private tenantCtx(job: JobRecord): TenantContext {
    return tenantCtxFromJob(job);
  }

  get _tenantCtxForTest(): (j: JobRecord) => TenantContext {
    return (j) => this.tenantCtx(j);
  }
}

function tenantCtxFromJob(job: JobRecord): TenantContext {
  return {
    tenantId: job.tenantId,
    userId: job.createdBy,
    traceId: `trace_${job.jobId}`,
    jobId: job.jobId,
    locale: "zh-CN",
  };
}

/** 断点续跑：由阶段状态本身判定，见 runJob 主循环 */

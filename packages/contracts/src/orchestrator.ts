/**
 * M2 OrchestratorPort 防腐层契约（对应 LLD §2.3）
 *
 * 这是 Pi（pi-durable Harness + pi-agent-core Agent）与业务代码之间的**唯一接触面**。
 * 业务侧只认这套接口；框架升级或替换（预案：Mastra）时只改实现，不改调用方。
 * 因此本文件**不 import 任何 pi 包**。
 */

import type { TenantContext } from "./common.ts";
import type { JobSpec, JobRecord, JobStatus, PhaseName, PhaseState, UsageSummary } from "./job.ts";
import type { JobStreamEvent } from "./events.ts";

/** 启动一次任务（幂等：同 idempotencyKey 直接返回既有 job） */
export interface StartJobInput {
  spec: JobSpec;
  /** = Idempotency-Key = requestId，pi-durable 的 requestId 语义 */
  idempotencyKey: string;
  /** 只重算这些阶段及其下游（局部重算） */
  rerunFrom?: PhaseName;
}

export interface JobHandle {
  jobId: string;
  /** 已存在的任务被幂等命中 */
  reused: boolean;
}

export interface IOrchestratorPort {
  /** 创建并入队；立即返回，不等阶段完成 */
  startJob(input: StartJobInput, ctx: TenantContext): Promise<JobHandle>;

  /** 崩溃恢复：把所有 running 中未终态的任务接着跑完 */
  recover(ctx: Omit<TenantContext, "jobId">): Promise<{ resumed: string[]; skipped: string[] }>;

  getJob(jobId: string, tenantId: string): Promise<JobRecord | null>;
  listPhases(jobId: string): Promise<PhaseState[]>;
  getUsage(jobId: string): Promise<UsageSummary | null>;

  /** 订阅事件流：先回放 sinceSeq 之后的历史，然后持续推送 */
  subscribe(jobId: string, sinceSeq: number | null, listener: (e: JobStreamEvent) => void): () => void;

  cancelJob(jobId: string, tenantId: string, reason: string): Promise<void>;
  /** 单模块联动重算：只重跑该阶段及其下游 */
  rerunPhase(jobId: string, tenantId: string, phase: PhaseName): Promise<void>;
  /** 删除任务及其全部关联数据（级联）。任务不存在或不属于该租户时抛 E-AUTH-002 */
  deleteJob(jobId: string, tenantId: string): Promise<void>;
}

/** 阶段执行器：由 M9 AgentPack 提供的实际业务逻辑 */
export interface PhaseExecutor {
  phase: PhaseName;
  /** 检查点前置条件：上游产物是否齐全 */
  requires: PhaseName[];
  run(input: PhaseRunInput): Promise<PhaseRunOutput>;
}

export interface PhaseRunInput {
  job: JobRecord;
  ctx: TenantContext;
  /** 上游阶段产物，按阶段名索引 */
  upstream: Partial<Record<PhaseName, unknown>>;
  /** 事件回调：Agent 边产出边推 */
  emit: (e: JobStreamEvent) => void;
  /** 阶段级取消信号 */
  signal: AbortSignal;
}

export interface PhaseRunOutput {
  status: "succeeded" | "partial" | "failed";
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  degradedKeys?: string[];
  note?: string;
}

export interface JobStatusQuery {
  jobId: string;
  tenantId: string;
  status: JobStatus;
}

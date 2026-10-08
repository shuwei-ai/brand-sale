/**
 * SSE 事件协议（对应 LLD §3.3）
 *
 * 关键语义：
 * - 每个事件带单调递增 `seq`，用作 SSE 的 `id:`，支持 `Last-Event-ID` 断线重放；
 * - 环形缓冲保留最近 2000 条 / 30 分钟；过期则改为推 `job.status` + 全量视图快照；
 * - `governance.block` **不得静默**，前端必须显式红色提示。
 */

import type { Degraded, Money } from "./common.ts";
import type { AgentCode } from "./agent.ts";
import type { Artifact, ArtifactKind, JobStatus, PhaseName, Progress, TokenUsage, UsageSummary } from "./job.ts";

export type JobStreamEvent =
  | { type: "job.status"; seq: number; at: string; jobId: string; status: JobStatus; progress: Progress }
  | { type: "phase.start"; seq: number; at: string; phase: PhaseName; estimatedMs: number }
  | { type: "phase.progress"; seq: number; at: string; phase: PhaseName; percent: number; note?: string }
  | { type: "phase.complete"; seq: number; at: string; phase: PhaseName; summary: string; degraded?: Degraded }
  | { type: "agent.delta"; seq: number; at: string; agent: AgentCode; kind: "text" | "thinking" | "tool"; delta: string }
  | { type: "artifact.ready"; seq: number; at: string; kind: ArtifactKind; inline?: unknown; url?: string }
  | { type: "governance.block"; seq: number; at: string; tool: string; code: string; reason: string; fatal: boolean }
  | { type: "data.degraded"; seq: number; at: string; source: string; missing: string[]; reason: string }
  | { type: "cost.update"; seq: number; at: string; amount: Money; tokens: TokenUsage }
  | { type: "job.error"; seq: number; at: string; code: string; retryable: boolean; traceId: string }
  | { type: "job.done"; seq: number; at: string; artifacts: Artifact[]; usage: UsageSummary }
  | { type: "heartbeat"; seq: number; at: string; ts: string }
  | { type: "view.snapshot"; seq: number; at: string; jobId: string; status: JobStatus; progress: Progress; artifacts: Artifact[] };

export type JobStreamEventType = JobStreamEvent["type"];

/** SSE 帧：`id:` 用 seq，`event:` 用 type，`data:` 为去掉 seq 的 JSON */
export function toSseFrame(event: JobStreamEvent): string {
  const { seq, ...rest } = event as JobStreamEvent & { seq: number };
  return `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(rest)}\n\n`;
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
/** 环形缓冲容量（LLD §3.3：≥2000 条 / ≥30 分钟） */
export const EVENT_BUFFER_SIZE = 2000;
export const EVENT_BUFFER_TTL_MS = 30 * 60 * 1000;

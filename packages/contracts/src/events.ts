/**
 * SSE 事件协议（对应 LLD §3.3）
 *
 * 关键语义：
 * - 每个事件带单调递增 `seq`，用作 SSE 的 `id:`，支持 `Last-Event-ID` 断线重放；
 * - 环形缓冲**按类型分桶**保留：状态类事件 2000 条（`EVENT_BUFFER_SIZE`），
 *   流式增量单独一档 `DELTA_BUFFER_SIZE`；过期则改为推 `job.status` + 全量视图快照；
 * - **全量回放不回放 `agent.delta`**（只补状态类事件）—— 刷页面时靠它重建进度与日志，
 *   而不是回放一两秒、几十万字符的正文碎片；
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
/** 状态类事件的环形缓冲容量（LLD §3.3：≥2000 条 / ≥30 分钟） */
export const EVENT_BUFFER_SIZE = 2000;
/**
 * `agent.delta` 单独一档容量。
 *
 * 为什么必须和状态类事件分开裁剪：一次真实任务会产生 1.6 万条 `agent.delta`，
 * 而状态类事件（phase.start/phase.complete/job.status/artifact.ready/...）只有几十条。
 * 混在一个窗口里按 seq 裁剪时，delta 洪水会把状态事件整段挤出回放窗口 ——
 * 表现为"刷新页面后事件日志空白、进度掉回起点"，且刷得越晚越严重。
 */
export const DELTA_BUFFER_SIZE = 600;
export const EVENT_BUFFER_TTL_MS = 30 * 60 * 1000;

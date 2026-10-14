/**
 * 事件总线：把阶段产出实时推给 SSE 客户端，同时落库做断线重放。
 *
 * 语义与 LLD §3.3 一致：
 *   - seq 单调递增，作为 SSE 的 `id:`；
 *   - 环形缓冲保留最近 2000 条；客户端带 Last-Event-ID 重连时先回放；
 *   - 若 Last-Event-ID 已过期（早于缓冲下界），改为一次 `view.snapshot`；
 *   - 本地内存订阅用于同一进程内的实时推送。
 */

import {
  EVENT_BUFFER_SIZE,
  type JobStreamEvent,
  type JobStreamEventType,
} from "@brandsale/contracts";
import type { Repositories } from "@brandsale/storage";

type Listener = (e: JobStreamEvent) => void;

/**
 * 事件的「输入」形态：由调用方提供 type 与业务字段，
 * seq/at/jobId 由总线补齐。
 *
 * 注意必须用分配式 Omit：直接对联合类型做 Omit 会把成员塌缩成公共字段。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JobEventInput = DistributiveOmit<JobStreamEvent, "seq" | "at" | "jobId">;

export class EventBus {
  private readonly seqByJob = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly repos: Repositories) {}

  /** 发布事件：补 jobId/seq/at，落库，推给内存订阅者 */
  publish(jobId: string, e: JobEventInput & { seq?: number; at?: string }): JobStreamEvent {
    const seq = (this.seqByJob.get(jobId) ?? this.repos.events.maxSeq(jobId)) + 1;
    this.seqByJob.set(jobId, seq);
    const full = { ...e, jobId, seq, at: e.at ?? new Date().toISOString() } as JobStreamEvent;
    const { seq: _s, ...rest } = full as JobStreamEvent & { seq: number };
    void _s;
    this.repos.events.append(jobId, seq, full.type, rest);
    for (const l of this.listeners.get(jobId) ?? []) {
      try {
        l(full);
      } catch {
        /* 单个订阅者异常不影响其它订阅者 */
      }
    }
    return full;
  }

  /** 内存订阅（仅本进程） */
  subscribe(jobId: string, listener: Listener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(jobId);
    };
  }

  /**
   * 回放历史（用于 Last-Event-ID 重连 / 新开页面全量回放）。
   *
   * `excludeTypes` 允许跳过整类事件。**全量回放时调用方必须排掉 `agent.delta`**：
   * 那不是"状态"，而是已经渲染过的正文碎片 —— 一次任务 1.6 万条，
   * 回放它们既挤占带宽（实测一个刷新就能灌 2700 帧），又会把真正的状态事件淹没。
   * 断线续传（有 Last-Event-ID）则不该排，缺口里的正文要补上。
   */
  replay(jobId: string, sinceSeq: number, excludeTypes: JobStreamEventType[] = []): JobStreamEvent[] {
    const skip = excludeTypes.length ? new Set<string>(excludeTypes) : null;
    return this.repos.events
      .since(jobId, sinceSeq)
      .filter((r) => !skip?.has(r.type))
      .map((r) => ({ ...(r.payload as object), seq: r.seq, type: r.type }) as JobStreamEvent);
  }

  /** Last-Event-ID 是否仍可回放 */
  canReplay(jobId: string, sinceSeq: number): boolean {
    if (!Number.isFinite(sinceSeq)) return false;
    // 负值表示"从头回放"
    if (sinceSeq < 0) return true;
    const min = this.repos.events.minSeq(jobId);
    return min === 0 || sinceSeq >= min - 1;
  }

  bufferCapacity(): number {
    return EVENT_BUFFER_SIZE;
  }
}

function jobIdOf(e: Partial<JobStreamEvent>): string {
  const anyE = e as Record<string, unknown>;
  return String(anyE.jobId ?? (anyE["job"] as string) ?? "");
}

export type { JobStreamEventType };

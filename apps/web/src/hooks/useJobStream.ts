/**
 * 任务 SSE 实时流。
 *
 * 三个关键设计点，都是踩过坑之后的结论：
 *
 * ① **用 fetch + ReadableStream，不用 EventSource。**
 *    EventSource 不能自定义请求头，用它就必须把 Bearer token 塞进 URL 查询串
 *    （会进网关访问日志与 Referer）。宁可自己写几十行分帧解析，也不弱化鉴权边界。
 *
 * ② **断线重连带 Last-Event-ID。**
 *    服务端事件带单调 `seq` 并保留 30 分钟环形缓冲，重连时把最后收到的 seq
 *    放进请求头，服务端只补发缺口，不重放全量。seq 过期时服务端会改推
 *    `view.snapshot`，此时前端应当重新拉一次任务详情而不是只信事件流。
 *
 * ③ **流式增量不逐条 setState。**
 *    一次真实任务会产生 1.6 万条 `agent.delta`，逐条 setState 会打爆 React 的
 *    调度（实测卡到不可用）。这里全部写进 ref，用 requestAnimationFrame 合帧，
 *    每帧最多一次渲染。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AGENT_CODE_LABEL, PHASE_LABEL, type AgentCode, type PhaseName } from "@brandsale/contracts";
import { apiPath, url } from "../api/client.ts";
import { getToken } from "../api/session.ts";
import type { LiveDelta } from "../api/types.ts";

export type LogLevel = "info" | "warn" | "err" | "ok";

export interface LogEntry {
  seq: number;
  at: string;
  type: string;
  tag: string;
  text: string;
  level: LogLevel;
}

export interface LiveMessage {
  key: string;
  agent: AgentCode;
  kind: LiveDelta["kind"];
  who: string;
  text: string;
}

export interface JobStreamSnapshot {
  connected: boolean;
  error: string | null;
  log: LogEntry[];
  live: LiveMessage[];
  lastSeq: number | null;
  /** 已落地的流式字符数，用于给用户一个"确实在动"的量化信号 */
  deltaCount: number;
}

const MAX_LOG = 400;
const MAX_LIVE = 24;
const RECONNECT_DELAY_MS = 3000;

const emptySnapshot = (): JobStreamSnapshot => ({
  connected: false,
  error: null,
  log: [],
  live: [],
  lastSeq: null,
  deltaCount: 0,
});

export type StreamEventHandler = (type: string, payload: Record<string, unknown>) => void;

export function useJobStream(jobId: string | null, onEvent?: StreamEventHandler) {
  const [snapshot, setSnapshot] = useState<JobStreamSnapshot>(emptySnapshot);

  const logRef = useRef<LogEntry[]>([]);
  const liveRef = useRef<Map<string, LiveMessage>>(new Map());
  const seqRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  const deltaCountRef = useRef(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  /** 事件回调放 ref：否则父组件每次重渲染都会重建连接 */
  const handlerRef = useRef<StreamEventHandler | undefined>(onEvent);
  handlerRef.current = onEvent;

  const flushQueued = useRef(false);
  const scheduleFlush = useCallback(() => {
    if (flushQueued.current) return;
    flushQueued.current = true;
    requestAnimationFrame(() => {
      flushQueued.current = false;
      setSnapshot({
        connected: connectedRef.current,
        error: errorRef.current,
        // 复制一份：Map/数组是可变容器，直接交给 React 会让 memo 失效
        log: [...logRef.current],
        live: [...liveRef.current.values()],
        lastSeq: seqRef.current,
        deltaCount: deltaCountRef.current,
      });
    });
  }, []);

  const pushLog = useCallback((type: string, tag: string, text: string, level: LogLevel, seq = 0) => {
    logRef.current = [...logRef.current, { seq, at: new Date().toISOString(), type, tag, text, level }].slice(-MAX_LOG);
  }, []);

  const clear = useCallback(() => {
    logRef.current = [];
    liveRef.current = new Map();
    deltaCountRef.current = 0;
    scheduleFlush();
  }, [scheduleFlush]);

  useEffect(() => {
    // 换任务：清空缓冲并重连。seq 必须一起清，否则会把上一个任务的 Last-Event-ID 带过去
    logRef.current = [];
    liveRef.current = new Map();
    deltaCountRef.current = 0;
    seqRef.current = null;
    connectedRef.current = false;
    errorRef.current = null;
    setSnapshot(emptySnapshot());
    bump();

    if (!jobId) return;

    const ctrl = new AbortController();
    let stopped = false;
    let timer: number | undefined;

    const absorb = (type: string, payload: Record<string, unknown>) => {
      switch (type) {
        case "job.status": {
          const p = (payload.progress ?? {}) as { percent?: number; currentPhase?: PhaseName | null };
          pushLog(
            type,
            "job.status",
            `${String(payload.status)} · ${Math.round((p.percent ?? 0) * 100)}%${p.currentPhase ? ` · ${p.currentPhase}` : ""}`,
            "info",
          );
          break;
        }
        case "phase.start":
          pushLog(type, String(payload.phase), `开始（预计 ${Math.round(Number(payload.estimatedMs ?? 0) / 1000)}s）`, "info");
          break;
        case "phase.progress":
          pushLog(
            type,
            String(payload.phase),
            `${Math.round(Number(payload.percent ?? 0) * 100)}%${payload.note ? ` · ${String(payload.note)}` : ""}`,
            "info",
          );
          break;
        case "phase.complete":
          pushLog(
            type,
            String(payload.phase),
            String(payload.summary ?? "完成"),
            payload.degraded ? "warn" : "ok",
          );
          break;
        case "cost.update": {
          const amount = payload.amount as { amount?: number } | undefined;
          const tokens = payload.tokens as { calls?: number } | undefined;
          pushLog(type, "cost.update", `¥${Number(amount?.amount ?? 0).toFixed(4)} · ${tokens?.calls ?? 0} 次调用`, "info");
          break;
        }
        case "data.degraded":
          pushLog(
            type,
            "data.degraded",
            `${String(payload.source)} ${String(payload.reason)} 缺失：${((payload.missing as string[]) ?? []).slice(0, 3).join(" | ")}`,
            "warn",
          );
          break;
        case "governance.block":
          pushLog(
            type,
            "governance.block",
            `${String(payload.tool)} ${String(payload.code)} ${String(payload.reason)}${payload.fatal ? "（致命）" : ""}`,
            "err",
          );
          break;
        case "artifact.ready":
          pushLog(type, "artifact.ready", `产物就绪：${String(payload.kind)}`, "ok");
          break;
        case "job.error":
          pushLog(type, "job.error", `${String(payload.code)} ${String(payload.traceId)}`, "err");
          break;
        case "job.done":
          pushLog(type, "job.done", `任务结束 · 成本 ¥${Number((payload.usage as { cost?: { amount?: number } })?.cost?.amount ?? 0).toFixed(4)}`, "ok");
          break;
        case "view.snapshot":
          pushLog(type, "view.snapshot", `缓冲过期，已切换视图快照 status=${String(payload.status)}`, "warn");
          break;
        default:
          break;
      }
      scheduleFlush();
      handlerRef.current?.(type, payload);
    };

    const absorbDelta = (delta: LiveDelta) => {
      const key = `${delta.agent}/${delta.kind}`;
      const prev = liveRef.current.get(key);
      const next: LiveMessage = {
        key,
        agent: delta.agent,
        kind: delta.kind,
        who: `${AGENT_CODE_LABEL[delta.agent] ?? delta.agent} · ${delta.kind === "tool" ? "工具调用" : delta.kind === "thinking" ? "推理" : "正文"}`,
        // 保留完整正文：上限 20000 仅作防御（单阶段正文最大约 25KB），不做 500 字符硬截断
        text: ((prev?.text ?? "") + delta.delta).slice(-20000),
      };
      // 重新 set 一次以保持"最近更新排最后"；Map 的 set 不改变已有键的顺序，
      // 因此先删后插
      liveRef.current.delete(key);
      liveRef.current.set(key, next);
      deltaCountRef.current += delta.delta.length;
      while (liveRef.current.size > MAX_LIVE) {
        const oldest = liveRef.current.keys().next().value;
        if (oldest === undefined) break;
        liveRef.current.delete(oldest);
      }
      scheduleFlush();
    };

    const handleFrame = (frame: string) => {
      let type = "";
      let data = "";
      let id = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) type = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
        else if (line.startsWith("id: ")) id = line.slice(4).trim();
      }
      if (/^\d+$/.test(id)) seqRef.current = Number(id);
      if (!type || type === "heartbeat") return;
      let payload: Record<string, unknown> = {};
      if (data) {
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          payload = { raw: data };
        }
      }
      if (type === "agent.delta") absorbDelta(payload as unknown as LiveDelta);
      else absorb(type, payload);
    };

    const connect = async (): Promise<void> => {
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
        if (seqRef.current !== null) headers["Last-Event-ID"] = String(seqRef.current);
        const res = await fetch(url(apiPath(`/jobs/${encodeURIComponent(jobId)}/stream`)), {
          headers,
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        connectedRef.current = true;
        errorRef.current = null;
        pushLog(
          "stream.open",
          "stream.open",
          seqRef.current !== null
            ? `已连接事件流（续传自 #${seqRef.current}）`
            : "已连接事件流（全量回放：补齐进度与日志，流式正文不重放）",
          "ok",
        );
        scheduleFlush();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            handleFrame(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 2);
            idx = buffer.indexOf("\n\n");
          }
        }
        throw new Error("连接已被服务端关闭");
      } catch (e) {
        if (stopped || ctrl.signal.aborted) return;
        connectedRef.current = false;
        errorRef.current = e instanceof Error ? e.message : String(e);
        pushLog("stream.error", "stream.error", `事件流中断：${errorRef.current}（${RECONNECT_DELAY_MS / 1000} 秒后重连）`, "err");
        scheduleFlush();
        timer = window.setTimeout(() => void connect(), RECONNECT_DELAY_MS);
      }
    };

    void connect();

    return () => {
      stopped = true;
      ctrl.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      connectedRef.current = false;
    };
  }, [jobId, pushLog, scheduleFlush]);

  return { ...snapshot, clear };
}

/** 供文本渲染：阶段码 → 中文名（事件列表里用得到） */
export const phaseLabel = (phase: string): string => PHASE_LABEL[phase as PhaseName] ?? phase;

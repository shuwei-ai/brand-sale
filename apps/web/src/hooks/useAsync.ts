/**
 * 数据获取与轮询小工具。
 *
 * 为什么不用 react-query：
 *   控制台的取数模式只有两种——"进页面拉一次 + 手动/事件驱动重取"和"定时轮询"，
 *   这两种用 60 行就能写对。引一个缓存库会带来一整套心智模型（失效策略、乐观更新、
 *   缓存键），而这里既没有共享缓存的需求，也没有并发写冲突。
 *
 * 但有一点必须自己做对：**竞态与卸载**。切换任务时上一个请求可能后返回，
 * 不 abort 就会把旧任务的数据画到新任务页面上。所以每次重取都先 abort 上一次。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.ts";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
}

export interface AsyncResult<T> extends AsyncState<T> {
  reload: () => void;
  setData: (updater: T | ((prev: T | null) => T)) => void;
}

const toApiError = (e: unknown): ApiError =>
  e instanceof ApiError
    ? e
    : new ApiError({
        code: "E-UI-000",
        status: 0,
        message: e instanceof Error ? e.message : String(e),
      });

/**
 * @param fn   取数函数，接收 AbortSignal（务必透传给 fetch）
 * @param deps 依赖变化时自动重取
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const ctrlRef = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState((s) => ({ ...s, loading: true, error: null }));
    void (async () => {
      try {
        const data = await fnRef.current(ctrl.signal);
        if (ctrl.signal.aborted) return;
        setState({ data, loading: false, error: null });
      } catch (e) {
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
        setState((s) => ({ ...s, loading: false, error: toApiError(e) }));
      }
    })();
  }, []);

  useEffect(() => {
    run();
    return () => ctrlRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setData = useCallback((updater: T | ((prev: T | null) => T)) => {
    setState((s) => ({
      ...s,
      data: typeof updater === "function" ? (updater as (p: T | null) => T)(s.data) : updater,
    }));
  }, []);

  return { ...state, reload: run, setData };
}

/** 定时轮询。enabled=false 时挂起（例如任务已结束就不必再刷列表）。 */
export function usePolling(cb: () => void, intervalMs: number, enabled = true): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const timer = window.setInterval(() => cbRef.current(), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
}

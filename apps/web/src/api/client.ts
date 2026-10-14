/**
 * 统一请求层。
 *
 * 三件事必须集中在一处做，否则每个页面都会各写一版：
 *  ① 贴 `Authorization: Bearer <token>`；
 *  ② 把网关的统一错误体（`{ error: { code, message, userMessage, traceId } }`）
 *     归一成 `ApiError`，页面只需要 `catch (e) { message.error(e.display) }`；
 *  ③ 处理"HTTP 200 但 body 带 error"的历史约定。
 *
 * 注意：网关对**长任务内的降级**一律回 200（业务错误放事件里），
 * 只有鉴权、限流、入库前置条件这类同步失败才回 4xx/5xx。
 * 因此这里判错看的是 `body.error` 而不是只看 `res.ok`。
 */

import { API_PREFIX } from "@brandsale/contracts";
import { getToken } from "./session.ts";

/** 构建期可用 `VITE_API_BASE` 指定跨域网关；同源部署留空即可 */
const BASE = String(import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string;
  readonly userMessage?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(init: {
    code: string;
    status: number;
    message: string;
    traceId?: string;
    userMessage?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.traceId = init.traceId ?? "";
    this.retryable = init.retryable ?? false;
    if (init.userMessage !== undefined) this.userMessage = init.userMessage;
    if (init.details !== undefined) this.details = init.details;
  }

  /** 可直接展示给用户的一句话（优先 userMessage，缺省用 code + message） */
  get display(): string {
    return this.userMessage ?? `${this.code} ${this.message}`;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 覆盖令牌（默认取全局会话令牌） */
  token?: string;
  /** 返回原始文本而不是 JSON（产物预览/下载用） */
  raw?: boolean;
}

/** 拼出绝对地址。CDN 与 Vite dev 代理都走同一条路径。 */
export const url = (path: string): string =>
  path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? path : `/${path}`}`;

/** 是否是一条 API 路径（用于区分静态资源） */
export const apiPath = (sub: string): string => `${API_PREFIX}${sub}`;

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token ?? getToken()}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  let res: Response;
  try {
    res = await fetch(url(path), init);
  } catch (e) {
    // 网络层失败（断网、被 abort、CORS）也要归一到 ApiError，
    // 否则调用方要同时 catch 两种错误类型
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError({
      code: "E-NET-001",
      status: 0,
      message: e instanceof Error ? e.message : String(e),
      userMessage: "无法连接网关，请确认服务已启动",
      retryable: true,
    });
  }

  const text = await res.text();
  if (opts.raw) {
    if (!res.ok) {
      throw new ApiError({
        code: "E-NET-002",
        status: res.status,
        message: `HTTP ${res.status} ${text.slice(0, 200)}`,
        userMessage: `取回内容失败（HTTP ${res.status}）`,
      });
    }
    return text as unknown as T;
  }

  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  const errBody = (body as { error?: Record<string, unknown> } | null)?.error;
  if (errBody) {
    throw new ApiError({
      code: String(errBody.code ?? "E-SYS-500"),
      status: res.status,
      message: String(errBody.message ?? `HTTP ${res.status}`),
      traceId: String(errBody.traceId ?? ""),
      ...(typeof errBody.userMessage === "string" ? { userMessage: errBody.userMessage } : {}),
      retryable: Boolean(errBody.retryable),
      ...(errBody.details && typeof errBody.details === "object"
        ? { details: errBody.details as Record<string, unknown> }
        : {}),
    });
  }

  if (!res.ok) {
    throw new ApiError({
      code: `E-HTTP-${res.status}`,
      status: res.status,
      message: text.slice(0, 300) || `HTTP ${res.status}`,
      retryable: res.status >= 500,
    });
  }

  return body as T;
}

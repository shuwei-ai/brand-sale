/**
 * 错误码表（对应 LLD §3.7）
 *
 * 设计要点：**除鉴权与限流外，业务错误一律 HTTP 200**，通过事件内的 `code` 表达。
 * 原因是长任务里的"某个源失败"不是请求失败，前端要继续渲染其余结果。
 */

export const ERROR_CODES = {
  "E-AUTH-001": { http: 401, domain: "鉴权", message: "token 无效或已过期", retryable: false },
  "E-AUTH-002": { http: 403, domain: "鉴权", message: "租户无该资源权限", retryable: false },

  "E-GOV-001": { http: 200, domain: "闸门", message: "数据源未登记", retryable: false },
  "E-GOV-002": { http: 200, domain: "闸门", message: "授权已过期", retryable: false },
  "E-GOV-003": { http: 200, domain: "闸门", message: "跨租户访问", retryable: false },
  "E-GOV-004": { http: 200, domain: "闸门", message: "工具不在白名单", retryable: false },
  "E-GOV-005": { http: 200, domain: "闸门", message: "参数越界", retryable: false },
  "E-GOV-500": { http: 200, domain: "闸门", message: "闸门自身异常（fail-closed）", retryable: true },

  "E-DATA-001": { http: 200, domain: "数据", message: "数据源超时", retryable: true },
  "E-DATA-002": { http: 200, domain: "数据", message: "授权失效", retryable: false },
  "E-DATA-003": { http: 200, domain: "数据", message: "频控排队超时", retryable: true },
  "E-DATA-004": { http: 200, domain: "数据", message: "L4 数据源被策略禁用", retryable: false },

  "E-KB-001": { http: 200, domain: "检索", message: "重排超时", retryable: true },
  "E-KB-002": { http: 200, domain: "检索", message: "向量库不可用", retryable: true },
  "E-KB-003": { http: 200, domain: "检索", message: "库为空（冷启动）", retryable: false },

  "E-AGENT-001": { http: 200, domain: "Agent", message: "Schema 校验失败（已重试）", retryable: false },
  "E-AGENT-002": { http: 200, domain: "Agent", message: "Agent 超时", retryable: true },

  "E-PARSE-001": { http: 200, domain: "解析", message: "OCR 质量低", retryable: false },
  "E-PARSE-002": { http: 200, domain: "解析", message: "解析器不可用（已降级）", retryable: true },

  "E-RENDER-001": { http: 200, domain: "渲染", message: "模板不匹配", retryable: false },
  "E-RENDER-002": { http: 200, domain: "渲染", message: "渲染器不可用", retryable: true },

  "E-JOB-001": { http: 429, domain: "任务", message: "租户并发超限", retryable: true },
  "E-JOB-002": { http: 409, domain: "任务", message: "同 Idempotency-Key 参数不一致", retryable: false },
  "E-JOB-003": { http: 200, domain: "任务", message: "整体超时", retryable: true },

  "E-SYS-500": { http: 500, domain: "系统", message: "未分类异常", retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface AppErrorOptions {
  code: ErrorCode;
  /** 面向开发者 */
  message?: string;
  /** 面向用户，前端可直接展示 */
  userMessage?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** fatal=true 表示连后续流程一并终止（如跨租户） */
  fatal?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage?: string;
  readonly details?: Record<string, unknown>;
  readonly fatal: boolean;
  override readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    const spec = ERROR_CODES[options.code];
    super(options.message ?? spec.message);
    this.name = "AppError";
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.details = options.details;
    this.fatal = options.fatal ?? options.code === "E-GOV-003";
    this.cause = options.cause;
  }

  get httpStatus(): number {
    return ERROR_CODES[this.code].http;
  }

  get retryable(): boolean {
    return ERROR_CODES[this.code].retryable;
  }

  toApiError(traceId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.userMessage ? { userMessage: this.userMessage } : {}),
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
        traceId,
      },
    };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

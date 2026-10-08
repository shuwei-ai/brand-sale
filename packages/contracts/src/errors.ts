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

  /**
   * 入库（知识库写入）。
   *
   * 为什么单开一个域而不是复用 E-KB-*：E-KB-001/002/003 是**检索**语义
   * （重排超时 / 向量库不可用 / 库为空），复用会把"来源未登记"误报成"重排超时"，
   * 排障方向直接反了。
   *
   * 为什么这里用 4xx，而本表开头写着"业务错误一律 HTTP 200"：
   * 那条规则的原因写得很清楚——"长任务里的'某个源失败'不是请求失败，
   * 前端要继续渲染其余结果"。它约束的是**长任务内的降级**。
   * 入库是**同步请求**，调用方必须当场知道写没写进去，前提条件错了却回 200
   * 会让人误以为入库成功。所以这三条是真正的请求级错误。
   */
  "E-INGEST-001": { http: 400, domain: "入库", message: "入库前置条件不满足（来源未登记/未授权，或入参不合法）", retryable: false },
  "E-INGEST-002": { http: 415, domain: "入库", message: "不支持的文档格式（需配置解析器）", retryable: false },
  "E-INGEST-003": { http: 409, domain: "入库", message: "同一文档正在入库（幂等冲突）", retryable: true },

  /**
   * 录入解析（自然语言 → Brief 草稿）。
   *
   * 与 E-INGEST-* 同理用 4xx：`POST /brief/parse` 是**同步请求**，
   * 入参为空却回 200 会让前端以为"解析成功但没有识别到任何字段"。
   *
   * 只保留一条：解析本身**不会因"识别不出字段"而失败** —— 抽不到就放进 missing 并追问用户，
   * 那是正常业务结果而不是错误。这里拦的仅仅是"请求本身没带东西"。
   */
  "E-BRIEF-001": { http: 400, domain: "录入解析", message: "utterance 为空或不是字符串", retryable: false },

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

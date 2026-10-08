/**
 * 通用约定（对应 LLD §3.1）
 *
 * 这里定义的是**全系统唯一的类型源**。任何其它包不得重复定义同名类型
 * （由 `scripts/check-boundaries.ts` 在构建期强制）。
 */

export type Currency = "CNY";

/** 金额一律为「元」，最多 2 位小数。 */
export interface Money {
  currency: Currency;
  amount: number;
}

export const money = (amount: number, currency: Currency = "CNY"): Money => ({ currency, amount });

export const addMoney = (a: Money, b: Money): Money => ({ currency: a.currency, amount: a.amount + b.amount });

export const formatMoney = (m: Money): string => `¥${m.amount.toFixed(2)}`;

/**
 * 租户上下文。由 M1 网关在入口一次性构造，之后**只允许透传**，
 * 任何模块不得自行拼装（防越权，对应 E2E 用例 4）。
 */
export interface TenantContext {
  tenantId: string;
  /** 终端用户标识（客户方账号） */
  userId: string;
  traceId: string;
  /** 可选：本次调用所属任务 */
  jobId?: string;
  locale: "zh-CN" | "en-US";
}

/** 降级原因。降级不是错误，是业务状态（LLD §3.1）。 */
export type DegradeReason =
  | "authz_expired"
  | "source_blocked"
  | "source_not_registered"
  | "timeout"
  | "unavailable"
  | "rate_limited"
  | "no_data"
  | "rerank_timeout"
  | "rerank_disabled"
  | "partial_output"
  | "gate_fail_closed";

/**
 * 降级统一表达。任何成功响应都可携带顶层 `degraded` 字段。
 * **约定：不允许通过 HTTP 状态码表达降级。**
 */
export interface Degraded {
  /** 缺失的能力/维度，前端据此在报告「排除项」里列出 */
  missing: string[];
  reason: DegradeReason;
  /** 涉及的来源（如 "qianchuan", "xingtu"） */
  sources?: string[];
  /** 人类可读说明，直接展示给用户 */
  note?: string;
}

/** 分页（游标式，避免深分页） */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** 统一错误体 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    userMessage?: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    traceId: string;
  };
}

export type Result<T, E = ApiError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** 数据源分级（LLD §2.5） */
export type DataTier = "L1" | "L2" | "L3" | "L4";

export const TIER_LABEL: Record<DataTier, string> = {
  L1: "L1 客户授权平台数据",
  L2: "L2 历史执行与私域知识",
  L3: "L3 公开指数与人工核验",
  L4: "L4 第三方数据采购",
};

/** 系统当前支持的平台 */
export const POPULAR_PLATFORMS = ["douyin", "xiaohongshu", "bilibili", "weibo"] as const;
export type Platform = (typeof POPULAR_PLATFORMS)[number];

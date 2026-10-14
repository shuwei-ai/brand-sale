/**
 * 任务与阶段契约（对应 LLD §3.2、§5）
 */

import type { Degraded, Money, TenantContext } from "./common.ts";

/** 六个阶段，与 M9 的六个 Agent 一一对应 */
export type PhaseName =
  /** AO 任务录入：Brief 校验 + 授权范围解析 */
  | "intake"
  /** CI 竞品情报 */
  | "intel"
  /** CT 人选匹配 */
  | "creator"
  /** PL 打法排期 */
  | "playbook"
  /** BR 预算风控 */
  | "budget"
  /** RG 研报生成（含渲染） */
  | "report";

export const PHASE_ORDER: PhaseName[] = ["intake", "intel", "creator", "playbook", "budget", "report"];

export const PHASE_LABEL: Record<PhaseName, string> = {
  intake: "任务录入与授权核验",
  intel: "竞品情报分析",
  creator: "达人/人选匹配",
  playbook: "打法与排期",
  budget: "预算与风控",
  report: "研报生成与渲染",
};

export type JobStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type PhaseStatus = "pending" | "running" | "partial" | "succeeded" | "failed" | "skipped";

export interface Progress {
  /** 0..1 */
  percent: number;
  currentPhase: PhaseName | null;
}

export interface TimeWindow {
  from: string;
  to: string;
}

/** 用户录入的 Brief（LLD §3.2.1 的请求体） */
export interface Brief {
  industry: string;
  category: string;
  brandIds: string[];
  /**
   * 甲方**自有品牌**。与 `brandIds` 语义不同，**不要混用**：
   *   - `brandIds` = 本轮在投 / 在看的品牌集合，报告按「竞品格局」呈现；
   *   - `ownBrandId` = "我是谁"，只有给了它，报告才会做**品牌自诊**
   *     （第 6 页「品牌自诊概览」+ 第 7 页「品牌 vs 竞品差距矩阵」）。
   *
   * **不填 = 本轮只做市场与竞品调研**：报告里不出现任何「我方」页、列与字样，
   * 也就不需要品牌资产授权。这解决了历史上的一个死结 ——
   * 以前 `brandIds` 被两处按**相反**语义消费（`buildBrandSelf()` 当"我方"、
   * 竞品表当"竞品集"），导致「品牌自诊概览」页在任何 brief 下都填不实。
   */
  ownBrandId?: string;
  budget: Money;
  objectiveWeights: { awareness: number; conversion: number; retention: number };
  window: TimeWindow;
  platforms: ("douyin" | "xiaohongshu" | "bilibili" | "weibo")[];
  notes?: string;
}

export interface JobSpec {
  brief: Brief;
  /** 允许使用的数据分级，默认由租户策略决定 */
  allowedTiers?: ("L1" | "L2" | "L3" | "L4")[];
}

export interface JobRecord {
  jobId: string;
  tenantId: string;
  createdBy: string;
  status: JobStatus;
  progress: Progress;
  spec: JobSpec;
  degraded: Degraded[];
  createdAt: string;
  updatedAt: string;
  /** 幂等键（= Idempotency-Key = requestId） */
  idempotencyKey: string;
  finishedAt?: string;
}

export interface PhaseState {
  jobId: string;
  phase: PhaseName;
  status: PhaseStatus;
  /** 尝试次数，崩溃恢复时用于去重 */
  attempts: number;
  /** 该阶段的结构化产出（JSON） */
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  degraded?: Degraded;
  startedAt?: string;
  endedAt?: string;
  cost: Money;
}

export type ArtifactKind =
  | "brief"
  | "intel"
  /**
   * 平台采集证据集（P0 溯源）：intel 阶段真实取回的逐条平台内容白名单快照。
   * 报告里的条目级引用（ReportCitation.kind=platform_entry）只能指向它。
   */
  | "intel_evidence"
  | "creator_candidates"
  | "playbook"
  | "budget"
  | "report_dsl"
  | "report_markdown"
  | "report_html";

export interface Artifact {
  artifactId: string;
  jobId: string;
  kind: ArtifactKind;
  inline?: unknown;
  url?: string;
  createdAt: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中缓存而未计费的输入 token */
  cachedInputTokens: number;
  calls: number;
}

export interface UsageSummary {
  jobId: string;
  tokens: TokenUsage;
  cost: Money;
  /** 按阶段拆分的成本 */
  byPhase: { phase: PhaseName; tokens: TokenUsage; cost: Money }[];
}

/** 创建任务的结果 */
export interface CreateJobResult {
  job: JobRecord;
}

/** 幂等键冲突判定：同 key 不同体 → E-JOB-002 */
export interface IdempotencyRecord {
  key: string;
  tenantId: string;
  /** 请求体指纹 */
  fingerprint: string;
  jobId: string;
  createdAt: string;
}

export interface JobContext {
  ctx: TenantContext;
  job: JobRecord;
}

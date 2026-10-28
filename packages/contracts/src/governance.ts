/**
 * M3 GovernanceGate + M5 LineageLedger 的对外契约（对应 LLD §3.4.1）
 */

import type { DataTier, TenantContext } from "./common.ts";

/** 检查项顺序固定：先便宜后昂贵，首个失败即返回（短路）。 */
export const GOVERNANCE_CHECK_ORDER = ["scope", "source", "authz", "tenant", "semantic"] as const;
export type GovernanceCheck = (typeof GOVERNANCE_CHECK_ORDER)[number];

export interface GateRequest {
  tenantId: string;
  jobId: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  /** 该工具声明的治理检查项（来自 ToolPolicy.governance） */
  checks: GovernanceCheck[];
}

export interface GateVerdict {
  allow: boolean;
  code: string;
  reason: string;
  /** 是否连后续流程一并终止（严重违规如跨租户） */
  fatal: boolean;
  checks: { check: GovernanceCheck; ok: boolean; note?: string }[];
  /** 命中检查耗时 ms，用于性能预算核算 */
  elapsedMs: number;
}

/* ── 数据源台账（准入登记） ─────────────────────────────── */

export interface SourceRegistration {
  sourceId: string;
  tenantId: string;
  name: string;
  tier: DataTier;
  /** 数据来源类型，用于置信度打分 */
  sourceType: KbSourceTypeValue;
  owner: string;
  /** 授权凭据形式（如 "千川子账号 OAuth"、"巨量星图商家授权"） */
  authMethod?: string;
  /** 数据合同/授权条款出处，L4 必填 */
  contractRef?: string;
  /** 法务是否已批准（L4 双开关之一） */
  legalApproved: boolean;
  registeredBy: string;
  registeredAt: string;
}

export interface AuthzGrant {
  tenantId: string;
  sourceId: string;
  /** 授权方（客户方联系人/账号） */
  grantedBy: string;
  validFrom: string;
  validTo: string;
  scopes: string[];
}

export type AuthzStatus = "active" | "expired" | "revoked";

export interface AuthzRecord extends AuthzGrant {
  authzId: string;
  status: AuthzStatus;
  revokedReason?: string;
}

/* ── 血缘台账（M5） ─────────────────────────────────────── */

/** 一次数据访问的台账记录，对应 OpenLineage RunEvent 的核心字段。 */
export interface LedgerEntry {
  ledgerId: string;
  tenantId: string;
  jobId: string;
  phase: string;
  agent: string | null;
  /** 数据 IO：哪个源、取了什么、几条 */
  inputs: { sourceId: string; tier: DataTier; query: string; rowCount: number; cached: boolean }[];
  outputs: { artifactKind: string; ref: string; kbCollection?: string }[];
  startedAt: string;
  endedAt: string;
  /** 归属的 pipeline run，用于 Marquez 侧核对 */
  runId: string;
}

/* ── 审计 ───────────────────────────────────────────────── */

export type AuditKind =
  | "gate.allow"
  | "gate.deny"
  | "gate.error"
  | "source.register"
  | "authz.grant"
  | "authz.revoke"
  | "kb.ingest"
  | "kb.ingest.rejected"
  | "job.delete"
  | "security.alert";

export interface AuditRecord {
  auditId: string;
  tenantId: string;
  kind: AuditKind;
  jobId?: string;
  agent?: string;
  tool?: string;
  code?: string;
  reason?: string;
  /** 只记摘要，prod 下不记原文（BM_TRACE_CONTENT） */
  payload?: Record<string, unknown>;
  traceId: string;
  at: string;
}

export interface IGovernanceGate {
  /** 串行、短路、fail-closed */
  evaluate(req: GateRequest, ctx: TenantContext): Promise<GateVerdict>;
  registerSource(src: SourceRegistration, ctx: TenantContext): Promise<{ sourceId: string }>;
  grantAuthz(grant: AuthzGrant, ctx: TenantContext): Promise<{ authzId: string }>;
  revokeAuthz(authzId: string, tenantId: string, reason: string, ctx: TenantContext): Promise<void>;
  listAuthorizations(tenantId: string): Promise<AuthzRecord[]>;
}

/* KbSourceType 的取值在这里先行声明，避免 governance → kb 的反向依赖 */
export type KbSourceTypeValue =
  | "l1_platform"
  | "l2_execution"
  | "l3_public"
  | "l4_purchased"
  | "human_verified";

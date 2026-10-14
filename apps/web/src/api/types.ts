/**
 * 接口返回类型。
 *
 * 原则：**能复用契约包的一律复用**，只在网关对契约做过"投影"的地方本地补一层
 * （例如 `phases` 接口给每条记录补了 `label`、`job.done` 事件里的 usage 是摘要）。
 * 一旦发现本地类型与网关实现不一致，改的应该是这里或网关，而不是在页面里 `as any`。
 */

import type {
  AgentCode,
  Artifact,
  ArtifactKind,
  AuditRecord,
  AuthzRecord,
  Brief,
  BriefDraft,
  DataTier,
  Degraded,
  JobRecord,
  JobStatus,
  KbCollection,
  KbDocument,
  LedgerEntry,
  Money,
  PhaseName,
  PhaseState,
  PhaseStatus,
  SourceRegistration,
  UsageSummary,
} from "@brandsale/contracts";

export type {
  AgentCode,
  Artifact,
  ArtifactKind,
  AuditRecord,
  AuthzRecord,
  Brief,
  DataTier,
  Degraded,
  JobRecord,
  JobStatus,
  KbCollection,
  KbDocument,
  LedgerEntry,
  Money,
  PhaseName,
  PhaseState,
  PhaseStatus,
  SourceRegistration,
  UsageSummary,
};

/** `GET /health` */
export interface HealthResponse {
  ok: boolean;
  env: string;
  llm: {
    mode: "mock" | "live";
    baseUrl: string;
    model: string;
    ok: boolean;
    models: string[];
    error?: string;
  };
  tiers: string[];
  gateFailClosed: boolean;
  warnings: string[];
  /** 前端产物形态（由网关自证）。旧版本网关不返回此字段，故为可选 */
  web?: { built: boolean; dist: string; builtAt: string | null };
}

/** `GET /jobs/:id/phases` —— 网关在 PhaseState 上补了中文 `label` */
export interface PhaseWithLabel extends PhaseState {
  label: string;
}

export interface PhaseListResponse {
  items: PhaseWithLabel[];
  order: PhaseName[];
}

/** `GET /jobs/:id/artifacts` —— 列表刻意不回传 inline（报告 DSL 可达数十 KB） */
export interface ArtifactListItem {
  artifactId: string;
  kind: ArtifactKind;
  createdAt: string;
  url?: string;
}

/** `GET /sources` —— 每条来源带上"当前是否有效授权" */
export interface SourceWithAuthz extends SourceRegistration {
  authz: AuthzRecord | null;
}

/** `GET /audit` —— 登记/授权类审计没有 error code，网关统一补了 OK */
export type AuditListItem = AuditRecord & { code: string };

export interface AuditResponse {
  items: AuditListItem[];
  summary: Record<string, number>;
}

/** `POST /brief/parse` —— 与 agent-pack 的 BriefParseResult 同形 */
export interface BriefParseResponse extends BriefDraft {
  source: "rule" | "rule+llm";
  filledByModel: string[];
  clarifications: string[];
  llmNote?: string;
}

/** `POST /jobs` */
export interface CreateJobResponse {
  job: JobRecord;
  reused: boolean;
}

export interface JobListResponse {
  items: JobRecord[];
  nextCursor: string | null;
}

/** `POST /kb/retrieve` */
export interface KbRetrieveResponse {
  reranked: boolean;
  degraded: Degraded | null;
  hits: { chunkId: string; collection: KbCollection; score: number; rerankScore?: number; text: string }[];
}

/** `GET /kb/stats` —— 按库聚合，"租户私有"与"全局共享"分开计数 */
export interface KbStatsItem {
  collection: KbCollection;
  chunks: number;
  scope: "tenant" | "global";
}

export interface IngestResponse {
  docId: string;
  chunks: number;
  rejected: number;
  collection: KbCollection;
  sourceId: string;
  replaced: boolean;
  parser: string;
  global: boolean;
}

/* ── SSE 事件（与 packages/contracts/src/events.ts 的 JobStreamEvent 同形，
       但前端只关心 data 载荷，seq 通过 `id:` 行单独取，因此这里不带 seq） ── */

export interface LiveDelta {
  agent: AgentCode;
  kind: "text" | "thinking" | "tool";
  delta: string;
}

export interface EventPayloadMap {
  "job.status": { jobId: string; status: JobStatus; progress: { percent: number; currentPhase: PhaseName | null } };
  "phase.start": { phase: PhaseName; estimatedMs: number };
  "phase.progress": { phase: PhaseName; percent: number; note?: string };
  "phase.complete": { phase: PhaseName; summary: string; degraded?: Degraded };
  "agent.delta": LiveDelta;
  "artifact.ready": { kind: ArtifactKind; url?: string };
  "governance.block": { tool: string; code: string; reason: string; fatal: boolean };
  "data.degraded": { source: string; missing: string[]; reason: string };
  "cost.update": { amount: Money; tokens: { calls: number; inputTokens: number; outputTokens: number } };
  "job.error": { code: string; retryable: boolean; traceId: string };
  "job.done": { artifacts: Artifact[]; usage: UsageSummary };
  "view.snapshot": { jobId: string; status: JobStatus };
}

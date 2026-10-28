/**
 * 接口清单。
 *
 * 全部收敛在这一个文件里，页面只调用 `api.xxx()`：
 * 好处是路径与查询参数的写法只有一份，后端改路由时改这里一处，
 * TypeScript 会直接把所有受影响页面标红。
 */

import type { ArtifactKind, Brief, KbCollection, PhaseName } from "@brandsale/contracts";
import { apiPath, request } from "./client.ts";
import type {
  ArtifactListItem,
  AuditResponse,
  AuthzRecord,
  BriefParseResponse,
  CreateJobResponse,
  HealthResponse,
  IngestResponse,
  JobListResponse,
  JobRecord,
  KbDocument,
  KbRetrieveResponse,
  KbStatsItem,
  LedgerEntry,
  PhaseListResponse,
  PlatformBinding,
  PlatformLoginResponse,
  PlatformsResponse,
  SourceWithAuthz,
  UsageSummary,
} from "./types.ts";

/** 幂等键：同一次"提交意图"复用它，重复点击不会开出两个任务 */
export const newIdempotencyKey = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const api = {
  /* ── 健康检查（无需鉴权） ────────────────────────────── */
  health: (signal?: AbortSignal) => request<HealthResponse>("/health", { ...(signal ? { signal } : {}) }),

  /* ── 任务 ────────────────────────────────────────────── */
  listJobs: (limit = 20) => request<JobListResponse>(`${apiPath("/jobs")}?limit=${limit}`),

  createJob: (brief: Brief, idempotencyKey: string) =>
    request<CreateJobResponse>(apiPath("/jobs"), {
      method: "POST",
      body: { brief },
      headers: { "Idempotency-Key": idempotencyKey },
    }),

  getJob: (jobId: string) => request<{ job: JobRecord }>(apiPath(`/jobs/${encodeURIComponent(jobId)}`)),

  listPhases: (jobId: string) => request<PhaseListResponse>(apiPath(`/jobs/${encodeURIComponent(jobId)}/phases`)),

  getUsage: (jobId: string) => request<UsageSummary>(apiPath(`/jobs/${encodeURIComponent(jobId)}/usage`)),

  getLedger: (jobId: string) =>
    request<{ items: LedgerEntry[] }>(apiPath(`/jobs/${encodeURIComponent(jobId)}/ledger`)),

  listArtifacts: (jobId: string) =>
    request<{ items: ArtifactListItem[] }>(apiPath(`/jobs/${encodeURIComponent(jobId)}/artifacts`)),

  /** 单个产物的原始文本（html / markdown / json 一律按文本取，前端再决定怎么渲染） */
  getArtifactText: (jobId: string, kind: ArtifactKind, signal?: AbortSignal) =>
    request<string>(apiPath(`/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(kind)}`), {
      raw: true,
      ...(signal ? { signal } : {}),
    }),

  getReportHtml: (jobId: string, signal?: AbortSignal) =>
    request<string>(apiPath(`/jobs/${encodeURIComponent(jobId)}/report`), {
      raw: true,
      ...(signal ? { signal } : {}),
    }),

  cancelJob: (jobId: string, reason: string) =>
    request<{ ok: true }>(apiPath(`/jobs/${encodeURIComponent(jobId)}/cancel`), {
      method: "POST",
      body: { reason },
    }),

  deleteJob: (jobId: string) =>
    request<{ ok: true }>(apiPath(`/jobs/${encodeURIComponent(jobId)}`), { method: "DELETE" }),

  rerunPhase: (jobId: string, phase: PhaseName) =>
    request<{ ok: true; rerunFrom: PhaseName }>(
      apiPath(`/jobs/${encodeURIComponent(jobId)}/rerun/${encodeURIComponent(phase)}`),
      { method: "POST", body: {} },
    ),

  recover: () => request<Record<string, unknown>>(apiPath("/recover"), { method: "POST", body: {} }),

  /* ── 自然语言 Brief 解析（只产草稿，不建任务） ────────── */
  parseBrief: (utterance: string, defaults?: Partial<Brief>, signal?: AbortSignal) =>
    request<BriefParseResponse>(apiPath("/brief/parse"), {
      method: "POST",
      body: { utterance, ...(defaults ? { defaults } : {}) },
      ...(signal ? { signal } : {}),
    }),

  /* ── 数据源台账与授权 ─────────────────────────────────── */
  listSources: () => request<{ items: SourceWithAuthz[] }>(apiPath("/sources")),

  registerSource: (body: {
    sourceId: string;
    name: string;
    tier: string;
    owner?: string;
    contractRef?: string;
    legalApproved?: boolean;
    authMethod?: string;
  }) => request<{ sourceId: string }>(apiPath("/sources"), { method: "POST", body }),

  listAuthz: () => request<{ items: AuthzRecord[] }>(apiPath("/authz")),

  grantAuthz: (body: { sourceId: string; grantedBy?: string; days?: number; scopes?: string[] }) =>
    request<{ authzId: string }>(apiPath("/authz"), { method: "POST", body }),

  /* ── 平台绑定（服务端无头扫码）─────────────────────────── */
  /** 读绑定状态（不触发探测，秒回；`checkedAt` 是上次探测时间） */
  platforms: (signal?: AbortSignal) =>
    request<PlatformsResponse>(apiPath("/platforms"), { ...(signal ? { signal } : {}) }),

  /** 真起浏览器探一遍登录态。串行七平台 → 十几秒到一分钟，调用方要给 loading */
  checkPlatforms: (platforms: string[] = []) =>
    request<PlatformsResponse>(apiPath("/platforms/check"), { method: "POST", body: { platforms } }),

  startPlatformLogin: (platform: string) =>
    request<PlatformLoginResponse>(apiPath(`/platforms/${encodeURIComponent(platform)}/login`), { method: "POST" }),

  pollPlatformLogin: (sessionId: string) =>
    request<PlatformLoginResponse>(apiPath(`/platforms/login/${encodeURIComponent(sessionId)}`)),

  cancelPlatformLogin: (sessionId: string) =>
    request<{ ok: boolean }>(apiPath(`/platforms/login/${encodeURIComponent(sessionId)}/cancel`), { method: "POST" }),

  /** 手动导入 cookie（扫码被风控挡住时的兜底）。写入 profile 后探活，同步返回结果 */
  setPlatformCookie: (platform: string, cookie: string) =>
    request<{ ok: boolean; status: PlatformBinding }>(apiPath(`/platforms/${encodeURIComponent(platform)}/cookie`), {
      method: "POST",
      body: { cookie },
    }),

  /* ── 知识库 ───────────────────────────────────────────── */
  kbStats: () => request<{ items: KbStatsItem[] }>(apiPath("/kb/stats")),

  kbRetrieve: (body: { query: string; collections?: KbCollection[]; topK?: number }, signal?: AbortSignal) =>
    request<KbRetrieveResponse>(apiPath("/kb/retrieve"), {
      method: "POST",
      body,
      ...(signal ? { signal } : {}),
    }),

  kbDocuments: (collection?: KbCollection) =>
    request<{ items: KbDocument[] }>(
      `${apiPath("/kb/documents")}${collection ? `?collection=${encodeURIComponent(collection)}` : ""}`,
    ),

  kbIngest: (body: {
    title: string;
    collection: KbCollection;
    sourceId: string;
    mime: string;
    content: string;
    publishedAt: string;
    sampleSize?: number;
    humanVerified?: boolean;
    global?: boolean;
  }) =>
    request<IngestResponse>(apiPath("/kb/documents"), {
      method: "POST",
      body,
      headers: { "Idempotency-Key": newIdempotencyKey() },
    }),

  kbDelete: (docId: string) =>
    request<{ removedChunks: number }>(apiPath(`/kb/documents/${encodeURIComponent(docId)}`), {
      method: "DELETE",
    }),

  /* ── 审计 ─────────────────────────────────────────────── */
  audit: (limit = 50) => request<AuditResponse>(`${apiPath("/audit")}?limit=${limit}`),
};

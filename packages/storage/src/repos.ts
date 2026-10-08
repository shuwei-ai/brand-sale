/**
 * 仓储实现（M15）。所有 SQL 都集中在这里，上层只操作类型化对象。
 */

import type {
  Artifact,
  ArtifactKind,
  AuditRecord,
  AuthzGrant,
  AuthzRecord,
  AuthzStatus,
  Degraded,
  JobRecord,
  JobSpec,
  JobStatus,
  LedgerEntry,
  Money,
  PhaseName,
  PhaseState,
  PhaseStatus,
  Progress,
  SourceRegistration,
  TokenUsage,
  UsageSummary,
} from "@brandsale/contracts";
import { type Db, newId, nowIso, parseJson, stringify } from "./db.ts";

/* ── 任务 ───────────────────────────────────────────────── */

interface JobRow {
  job_id: string;
  tenant_id: string;
  created_by: string;
  status: string;
  current_phase: string | null;
  percent: number;
  spec_json: string;
  degraded_json: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const toJob = (r: JobRow): JobRecord => ({
  jobId: r.job_id,
  tenantId: r.tenant_id,
  createdBy: r.created_by,
  status: r.status as JobStatus,
  progress: { percent: r.percent, currentPhase: (r.current_phase as PhaseName | null) ?? null },
  spec: parseJson<JobSpec>(r.spec_json, {} as JobSpec),
  degraded: parseJson<Degraded[]>(r.degraded_json, []),
  idempotencyKey: r.idempotency_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at ?? undefined,
});

export class JobRepo {
  constructor(private db: Db) {}

  create(input: {
    jobId: string;
    tenantId: string;
    createdBy: string;
    spec: JobSpec;
    idempotencyKey: string;
  }): JobRecord {
    const at = nowIso();
    this.db.run(
      `INSERT INTO jobs (job_id, tenant_id, created_by, status, current_phase, percent, spec_json,
                         degraded_json, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', NULL, 0, ?, '[]', ?, ?, ?)`,
      input.jobId,
      input.tenantId,
      input.createdBy,
      stringify(input.spec),
      input.idempotencyKey,
      at,
      at,
    );
    return this.get(input.jobId)!;
  }

  get(jobId: string): JobRecord | null {
    const row = this.db.get<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId);
    return row ? toJob(row) : null;
  }

  findByTenant(tenantId: string, limit = 50, cursor?: string): JobRecord[] {
    const rows = cursor
      ? this.db.all<JobRow>(
          "SELECT * FROM jobs WHERE tenant_id = ? AND job_id < ? ORDER BY job_id DESC LIMIT ?",
          tenantId,
          cursor,
          limit,
        )
      : this.db.all<JobRow>(
          "SELECT * FROM jobs WHERE tenant_id = ? ORDER BY job_id DESC LIMIT ?",
          tenantId,
          limit,
        );
    return rows.map(toJob);
  }

  setStatus(jobId: string, status: JobStatus, percent?: number, currentPhase?: PhaseName | null): void {
    const job = this.get(jobId);
    if (!job) return;
    const finished = status === "succeeded" || status === "failed" || status === "cancelled" || status === "partial";
    this.db.run(
      `UPDATE jobs SET status = ?, percent = ?, current_phase = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
       WHERE job_id = ?`,
      status,
      percent ?? job.progress.percent,
      currentPhase === undefined ? job.progress.currentPhase : currentPhase,
      nowIso(),
      finished ? nowIso() : null,
      jobId,
    );
  }

  addDegraded(jobId: string, degraded: Degraded): void {
    const job = this.get(jobId);
    if (!job) return;
    const list = [...job.degraded.filter((d) => d.reason !== degraded.reason || d.sources?.join() !== degraded.sources?.join()), degraded];
    this.db.run("UPDATE jobs SET degraded_json = ?, updated_at = ? WHERE job_id = ?", stringify(list), nowIso(), jobId);
  }

  /** 崩溃恢复：找出所有未终态任务 */
  findUnfinished(): JobRecord[] {
    return this.db
      .all<JobRow>("SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at ASC")
      .map(toJob);
  }

  findRunning(): JobRecord[] {
    return this.db.all<JobRow>("SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at ASC").map(toJob);
  }
}

/* ── 阶段 ───────────────────────────────────────────────── */

interface PhaseRow {
  job_id: string;
  phase: string;
  status: string;
  attempts: number;
  output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  degraded_json: string | null;
  started_at: string | null;
  ended_at: string | null;
  cost_json: string;
}

const toPhase = (r: PhaseRow): PhaseState => ({
  jobId: r.job_id,
  phase: r.phase as PhaseName,
  status: r.status as PhaseStatus,
  attempts: r.attempts,
  output: parseJson<unknown>(r.output_json, null),
  errorCode: r.error_code ?? undefined,
  errorMessage: r.error_message ?? undefined,
  degraded: parseJson<Degraded | undefined>(r.degraded_json, undefined),
  startedAt: r.started_at ?? undefined,
  endedAt: r.ended_at ?? undefined,
  cost: parseJson<Money>(r.cost_json, { currency: "CNY", amount: 0 }),
});

export class PhaseRepo {
  constructor(private db: Db) {}

  ensure(jobId: string, phase: PhaseName): PhaseState {
    const existing = this.db.get<PhaseRow>(
      "SELECT * FROM job_phases WHERE job_id = ? AND phase = ?",
      jobId,
      phase,
    );
    if (existing) return toPhase(existing);
    this.db.run(
      "INSERT INTO job_phases (job_id, phase, status, attempts, cost_json) VALUES (?, ?, 'pending', 0, '{\"currency\":\"CNY\",\"amount\":0}')",
      jobId,
      phase,
    );
    return this.get(jobId, phase)!;
  }

  get(jobId: string, phase: PhaseName): PhaseState | null {
    const row = this.db.get<PhaseRow>("SELECT * FROM job_phases WHERE job_id = ? AND phase = ?", jobId, phase);
    return row ? toPhase(row) : null;
  }

  list(jobId: string): PhaseState[] {
    return this.db
      .all<PhaseRow>("SELECT * FROM job_phases WHERE job_id = ? ORDER BY rowid ASC", jobId)
      .map(toPhase);
  }

  markStarted(jobId: string, phase: PhaseName, attempt: number): void {
    this.db.run(
      `UPDATE job_phases SET status = 'running', attempts = ?, started_at = ? WHERE job_id = ? AND phase = ?`,
      attempt,
      nowIso(),
      jobId,
      phase,
    );
  }

  markFinished(
    jobId: string,
    phase: PhaseName,
    status: PhaseStatus,
    patch: { output?: unknown; errorCode?: string; errorMessage?: string; degraded?: Degraded; cost?: Money } = {},
  ): void {
    this.db.run(
      `UPDATE job_phases SET status = ?, output_json = ?, error_code = ?, error_message = ?,
                             degraded_json = ?, cost_json = COALESCE(?, cost_json), ended_at = ?
       WHERE job_id = ? AND phase = ?`,
      status,
      patch.output === undefined ? null : stringify(patch.output),
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      patch.degraded ? stringify(patch.degraded) : null,
      patch.cost ? stringify(patch.cost) : null,
      nowIso(),
      jobId,
      phase,
    );
  }

  resetForRerun(jobId: string, phases: PhaseName[]): void {
    for (const p of phases) {
      this.db.run(
        `UPDATE job_phases SET status = 'pending', attempts = 0, output_json = NULL, error_code = NULL,
                               error_message = NULL, degraded_json = NULL, started_at = NULL, ended_at = NULL,
                               cost_json = '{"currency":"CNY","amount":0}'
         WHERE job_id = ? AND phase = ?`,
        jobId,
        p,
      );
    }
  }
}

/* ── 产物 ───────────────────────────────────────────────── */

export class ArtifactRepo {
  constructor(private db: Db) {}

  add(jobId: string, kind: ArtifactKind, payload: { inline?: unknown; url?: string }): Artifact {
    const artifact: Artifact = {
      artifactId: newId("art"),
      jobId,
      kind,
      inline: payload.inline,
      url: payload.url,
      createdAt: nowIso(),
    };
    this.db.run(
      "INSERT INTO artifacts (artifact_id, job_id, kind, inline_json, url, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      artifact.artifactId,
      jobId,
      kind,
      payload.inline === undefined ? null : stringify(payload.inline),
      payload.url ?? null,
      artifact.createdAt,
    );
    return artifact;
  }

  list(jobId: string): Artifact[] {
    return this.db
      .all<{ artifact_id: string; job_id: string; kind: string; inline_json: string | null; url: string | null; created_at: string }>(
        "SELECT * FROM artifacts WHERE job_id = ? ORDER BY rowid ASC",
        jobId,
      )
      .map((r) => ({
        artifactId: r.artifact_id,
        jobId: r.job_id,
        kind: r.kind as ArtifactKind,
        inline: parseJson<unknown>(r.inline_json, undefined),
        url: r.url ?? undefined,
        createdAt: r.created_at,
      }));
  }

  /** 重放安全：同 kind 已存在则不重复写入（避免崩溃恢复后产出重复报告） */
  addIfAbsent(jobId: string, kind: ArtifactKind, payload: { inline?: unknown; url?: string }): Artifact {
    const existing = this.db.get<{ artifact_id: string }>(
      "SELECT artifact_id FROM artifacts WHERE job_id = ? AND kind = ? LIMIT 1",
      jobId,
      kind,
    );
    if (existing) {
      return this.list(jobId).find((a) => a.artifactId === existing.artifact_id)!;
    }
    return this.add(jobId, kind, payload);
  }
}

/* ── 幂等 ───────────────────────────────────────────────── */

export class IdempotencyRepo {
  constructor(private db: Db) {}

  get(tenantId: string, key: string): { jobId: string; fingerprint: string } | null {
    const row = this.db.get<{ job_id: string; fingerprint: string }>(
      "SELECT job_id, fingerprint FROM idempotency WHERE tenant_id = ? AND key = ?",
      tenantId,
      key,
    );
    return row ? { jobId: row.job_id, fingerprint: row.fingerprint } : null;
  }

  put(tenantId: string, key: string, fingerprint: string, jobId: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO idempotency (key, tenant_id, fingerprint, job_id, created_at) VALUES (?, ?, ?, ?, ?)",
      key,
      tenantId,
      fingerprint,
      jobId,
      nowIso(),
    );
  }
}

/* ── 事件环形缓冲 ───────────────────────────────────────── */

export class EventRepo {
  constructor(private db: Db, private capacity = 2000) {}

  append(jobId: string, seq: number, type: string, payload: unknown): void {
    this.db.run(
      "INSERT OR REPLACE INTO job_events (job_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)",
      jobId,
      seq,
      type,
      stringify(payload),
      nowIso(),
    );
    // 环形裁剪：只保留最近 capacity 条
    this.db.run(
      `DELETE FROM job_events WHERE job_id = ? AND seq <= (
         SELECT MAX(seq) - ? FROM job_events WHERE job_id = ?
       )`,
      jobId,
      this.capacity,
      jobId,
    );
  }

  since(jobId: string, seq: number): { seq: number; type: string; payload: unknown }[] {
    return this.db
      .all<{ seq: number; type: string; payload: string }>(
        "SELECT seq, type, payload FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC",
        jobId,
        seq,
      )
      .map((r) => ({ seq: r.seq, type: r.type, payload: parseJson<unknown>(r.payload, null) }));
  }

  maxSeq(jobId: string): number {
    const row = this.db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM job_events WHERE job_id = ?", jobId);
    return row?.m ?? 0;
  }

  /** 最早可回放的 seq，用于判断 Last-Event-ID 是否已过期 */
  minSeq(jobId: string): number {
    const row = this.db.get<{ m: number | null }>("SELECT MIN(seq) AS m FROM job_events WHERE job_id = ?", jobId);
    return row?.m ?? 0;
  }
}

/* ── 用量（幂等扣费） ───────────────────────────────────── */

export class UsageRepo {
  constructor(private db: Db) {}

  /**
   * 写入一条用量。唯一键 (job_id, phase, attempt, call_id) 保证
   * **崩溃重放后不重复扣费**（E2E 用例 5）。
   */
  record(input: {
    jobId: string;
    phase: PhaseName;
    attempt: number;
    callId: string;
    model: string;
    tokens: TokenUsage;
    cost: Money;
  }): boolean {
    const res = this.db.run(
      `INSERT OR IGNORE INTO usage_records
       (record_id, job_id, phase, attempt, call_id, model, input_tokens, output_tokens, cached_tokens, cost_amount, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("usg"),
      input.jobId,
      input.phase,
      input.attempt,
      input.callId,
      input.model,
      input.tokens.inputTokens,
      input.tokens.outputTokens,
      input.tokens.cachedInputTokens,
      input.cost.amount,
      nowIso(),
    );
    return res.changes > 0;
  }

  summarize(jobId: string): UsageSummary {
    const rows = this.db.all<{
      phase: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cost: number;
      calls: number;
    }>(
      `SELECT phase,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens,
              SUM(cost_amount) AS cost,
              COUNT(*) AS calls
       FROM usage_records WHERE job_id = ? GROUP BY phase`,
      jobId,
    );
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
    let cost = 0;
    const byPhase: UsageSummary["byPhase"] = [];
    for (const r of rows) {
      const tokens: TokenUsage = {
        inputTokens: r.input_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        cachedInputTokens: r.cached_tokens ?? 0,
        calls: r.calls ?? 0,
      };
      total.inputTokens += tokens.inputTokens;
      total.outputTokens += tokens.outputTokens;
      total.cachedInputTokens += tokens.cachedInputTokens;
      total.calls += tokens.calls;
      cost += r.cost ?? 0;
      byPhase.push({ phase: r.phase as PhaseName, tokens, cost: { currency: "CNY", amount: r.cost ?? 0 } });
    }
    return { jobId, tokens: total, cost: { currency: "CNY", amount: Number(cost.toFixed(6)) }, byPhase };
  }
}

/* ── 审计 ───────────────────────────────────────────────── */

export class AuditRepo {
  constructor(private db: Db) {}

  add(rec: Omit<AuditRecord, "auditId" | "at"> & { at?: string }): AuditRecord {
    const full: AuditRecord = { ...rec, auditId: newId("aud"), at: rec.at ?? nowIso() };
    this.db.run(
      `INSERT INTO audit (audit_id, tenant_id, kind, job_id, agent, tool, code, reason, payload, trace_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      full.auditId,
      full.tenantId,
      full.kind,
      full.jobId ?? null,
      full.agent ?? null,
      full.tool ?? null,
      full.code ?? null,
      full.reason ?? null,
      full.payload ? stringify(full.payload) : null,
      full.traceId,
      full.at,
    );
    return full;
  }

  list(tenantId: string, limit = 100): AuditRecord[] {
    return this.db
      .all<{
        audit_id: string;
        tenant_id: string;
        kind: string;
        job_id: string | null;
        agent: string | null;
        tool: string | null;
        code: string | null;
        reason: string | null;
        payload: string | null;
        trace_id: string;
        at: string;
      }>("SELECT * FROM audit WHERE tenant_id = ? ORDER BY at DESC LIMIT ?", tenantId, limit)
      .map((r) => ({
        auditId: r.audit_id,
        tenantId: r.tenant_id,
        kind: r.kind as AuditRecord["kind"],
        jobId: r.job_id ?? undefined,
        agent: r.agent ?? undefined,
        tool: r.tool ?? undefined,
        code: r.code ?? undefined,
        reason: r.reason ?? undefined,
        payload: parseJson<Record<string, unknown> | undefined>(r.payload, undefined),
        traceId: r.trace_id,
        at: r.at,
      }));
  }

  countByKind(tenantId: string): Record<string, number> {
    const rows = this.db.all<{ kind: string; c: number }>(
      "SELECT kind, COUNT(*) AS c FROM audit WHERE tenant_id = ? GROUP BY kind",
      tenantId,
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.c]));
  }
}

/* ── 台账 ───────────────────────────────────────────────── */

export class LedgerRepo {
  constructor(private db: Db) {}

  add(entry: Omit<LedgerEntry, "ledgerId">): LedgerEntry {
    const full: LedgerEntry = { ...entry, ledgerId: newId("led") };
    this.db.run(
      `INSERT INTO ledger (ledger_id, tenant_id, job_id, phase, agent, inputs_json, outputs_json, run_id, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      full.ledgerId,
      full.tenantId,
      full.jobId,
      full.phase,
      full.agent ?? null,
      stringify(full.inputs),
      stringify(full.outputs),
      full.runId,
      full.startedAt,
      full.endedAt,
    );
    return full;
  }

  byJob(jobId: string): LedgerEntry[] {
    return this.db
      .all<{
        ledger_id: string;
        tenant_id: string;
        job_id: string;
        phase: string;
        agent: string | null;
        inputs_json: string;
        outputs_json: string;
        run_id: string;
        started_at: string;
        ended_at: string;
      }>("SELECT * FROM ledger WHERE job_id = ? ORDER BY started_at ASC", jobId)
      .map((r) => ({
        ledgerId: r.ledger_id,
        tenantId: r.tenant_id,
        jobId: r.job_id,
        phase: r.phase as PhaseName,
        agent: r.agent,
        inputs: parseJson<LedgerEntry["inputs"]>(r.inputs_json, []),
        outputs: parseJson<LedgerEntry["outputs"]>(r.outputs_json, []),
        runId: r.run_id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      }));
  }
}

/* ── 数据源与授权 ───────────────────────────────────────── */

export class SourceRepo {
  constructor(private db: Db) {}

  upsert(src: SourceRegistration): void {
    this.db.run(
      `INSERT OR REPLACE INTO sources
       (source_id, tenant_id, name, tier, source_type, owner, auth_method, contract_ref, legal_approved, registered_by, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      src.sourceId,
      src.tenantId,
      src.name,
      src.tier,
      src.sourceType,
      src.owner,
      src.authMethod ?? null,
      src.contractRef ?? null,
      src.legalApproved ? 1 : 0,
      src.registeredBy,
      src.registeredAt,
    );
  }

  get(tenantId: string, sourceId: string): SourceRegistration | null {
    const r = this.db.get<{
      source_id: string;
      tenant_id: string;
      name: string;
      tier: string;
      source_type: string;
      owner: string;
      auth_method: string | null;
      contract_ref: string | null;
      legal_approved: number;
      registered_by: string;
      registered_at: string;
    }>("SELECT * FROM sources WHERE tenant_id = ? AND source_id = ?", tenantId, sourceId);
    if (!r) return null;
    return {
      sourceId: r.source_id,
      tenantId: r.tenant_id,
      name: r.name,
      tier: r.tier as SourceRegistration["tier"],
      sourceType: r.source_type as SourceRegistration["sourceType"],
      owner: r.owner,
      authMethod: r.auth_method ?? undefined,
      contractRef: r.contract_ref ?? undefined,
      legalApproved: r.legal_approved === 1,
      registeredBy: r.registered_by,
      registeredAt: r.registered_at,
    };
  }

  list(tenantId: string): SourceRegistration[] {
    const rows = this.db.all<{ source_id: string }>("SELECT source_id FROM sources WHERE tenant_id = ?", tenantId);
    return rows.map((r) => this.get(tenantId, r.source_id)!).filter(Boolean);
  }

  /** L4 数据源的双开关检查：配置开 + 法务批 */
  isL4Usable(tenantId: string, sourceId: string): boolean {
    const src = this.get(tenantId, sourceId);
    return Boolean(src && src.tier === "L4" && src.legalApproved);
  }
}

export class AuthzRepo {
  constructor(private db: Db) {}

  add(grant: AuthzGrant): AuthzRecord {
    const rec: AuthzRecord = { ...grant, authzId: newId("az"), status: "active" };
    this.db.run(
      `INSERT INTO authz (authz_id, tenant_id, source_id, granted_by, valid_from, valid_to, scopes_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      rec.authzId,
      rec.tenantId,
      rec.sourceId,
      rec.grantedBy,
      rec.validFrom,
      rec.validTo,
      stringify(rec.scopes),
    );
    return rec;
  }

  list(tenantId: string): AuthzRecord[] {
    return this.db
      .all<{
        authz_id: string;
        tenant_id: string;
        source_id: string;
        granted_by: string;
        valid_from: string;
        valid_to: string;
        scopes_json: string;
        status: string;
        revoked_reason: string | null;
      }>("SELECT * FROM authz WHERE tenant_id = ? ORDER BY valid_to DESC", tenantId)
      .map((r) => ({
        authzId: r.authz_id,
        tenantId: r.tenant_id,
        sourceId: r.source_id,
        grantedBy: r.granted_by,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        scopes: parseJson<string[]>(r.scopes_json, []),
        status: r.status as AuthzStatus,
        revokedReason: r.revoked_reason ?? undefined,
      }));
  }

  /** 找到该租户对该源当前生效的授权（考虑有效期与撤销） */
  active(tenantId: string, sourceId: string, at = new Date()): AuthzRecord | null {
    const all = this.list(tenantId).filter((a) => a.sourceId === sourceId);
    const iso = at.toISOString();
    return (
      all.find((a) => a.status === "active" && a.validFrom <= iso && a.validTo >= iso) ?? null
    );
  }

  revoke(authzId: string, tenantId: string, reason: string): void {
    this.db.run(
      "UPDATE authz SET status = 'revoked', revoked_reason = ? WHERE authz_id = ? AND tenant_id = ?",
      reason,
      authzId,
      tenantId,
    );
  }
}

/* ── 外部缓存 ───────────────────────────────────────────── */

export class CacheRepo {
  constructor(private db: Db) {}

  get<T>(key: string): { value: T; fresh: boolean } | null {
    const row = this.db.get<{ payload: string; expires_at: string }>(
      "SELECT payload, expires_at FROM external_cache WHERE cache_key = ?",
      key,
    );
    if (!row) return null;
    return { value: parseJson<T>(row.payload, null as T), fresh: row.expires_at > nowIso() };
  }

  put(key: string, value: unknown, ttlSeconds: number): void {
    this.db.run(
      "INSERT OR REPLACE INTO external_cache (cache_key, payload, expires_at) VALUES (?, ?, ?)",
      key,
      stringify(value),
      new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    );
  }
}

/** 聚合所有仓储的容器 */
export class Repositories {
  readonly jobs: JobRepo;
  readonly phases: PhaseRepo;
  readonly artifacts: ArtifactRepo;
  readonly idempotency: IdempotencyRepo;
  readonly events: EventRepo;
  readonly usage: UsageRepo;
  readonly audit: AuditRepo;
  readonly ledger: LedgerRepo;
  readonly sources: SourceRepo;
  readonly authz: AuthzRepo;
  readonly cache: CacheRepo;

  constructor(public readonly db: Db) {
    this.jobs = new JobRepo(db);
    this.phases = new PhaseRepo(db);
    this.artifacts = new ArtifactRepo(db);
    this.idempotency = new IdempotencyRepo(db);
    this.events = new EventRepo(db);
    this.usage = new UsageRepo(db);
    this.audit = new AuditRepo(db);
    this.ledger = new LedgerRepo(db);
    this.sources = new SourceRepo(db);
    this.authz = new AuthzRepo(db);
    this.cache = new CacheRepo(db);
  }
}

export type { Progress, JobStatus };

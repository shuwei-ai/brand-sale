/**
 * M3 GovernanceGate（对应 LLD §2.4 / §3.4.1）
 *
 * 实现约束（不可协商，写在代码里而不是文档里）：
 *   1. 检查项按 scope → source → authz → tenant → semantic 串行，先便宜后昂贵，首个失败即返回；
 *   2. 任一步抛异常 → allow:false, code:"E-GOV-500"（fail-closed）；
 *   3. evaluate 总预算 50ms（不含语义检查）；超时同样 fail-closed；
 *   4. 所有 verdict（含被拒的）必须落 audit 表。
 */

import {
  AppError,
  GOVERNANCE_CHECK_ORDER,
  type AuditKind,
  type AuthzGrant,
  type AuthzRecord,
  type DataTier,
  type GateRequest,
  type GateVerdict,
  type GovernanceCheck,
  type IGovernanceGate,
  type SourceRegistration,
  type TenantContext,
} from "@brandsale/contracts";
import type { Config } from "@brandsale/config";
import type { Repositories } from "@brandsale/storage";
import { assertSourceRegistration } from "./source-guard.ts";

export interface GovernanceDeps {
  repos: Repositories;
  config: Config;
  /** 语义检查用的额外策略；Phase 1 只有预算上限与 L4 目的限制 */
  semanticPolicy?: {
    maxBudgetAmount?: number;
    /** 明确禁止使用的源 */
    deniedSources?: string[];
  };
}

/** 从工具参数中解析出本次访问的数据源与分级 */
function resolveAccessTargets(req: GateRequest): { sourceId: string | null; tier: DataTier | null } {
  const raw = req.args as Record<string, unknown>;
  const sourceId = (raw.sourceId ?? raw.source_id ?? raw.source) as string | undefined;
  const tier = (raw.tier as DataTier | undefined) ?? null;
  return { sourceId: sourceId ?? null, tier };
}

export class GovernanceGate implements IGovernanceGate {
  private readonly evalBudgetMs = 50;

  constructor(private deps: GovernanceDeps) {}

  async evaluate(req: GateRequest, ctx: TenantContext): Promise<GateVerdict> {
    const started = performance.now();
    const checks: GateVerdict["checks"] = [];
    const failClosed = this.deps.config.gateFailClosed;

    const deny = (code: string, reason: string, fatal = false): GateVerdict => {
      const verdict: GateVerdict = { allow: false, code, reason, fatal, checks, elapsedMs: performance.now() - started };
      this.audit(ctx, "gate.deny", req, code, reason);
      if (code === "E-GOV-003") this.audit(ctx, "security.alert", req, code, reason);
      return verdict;
    };

    try {
      const { sourceId, tier } = resolveAccessTargets(req);

      // 按声明的检查项顺序执行，未声明的跳过但记录
      for (const check of GOVERNANCE_CHECK_ORDER) {
        if (!req.checks.includes(check)) {
          checks.push({ check, ok: true, note: "未声明，跳过" });
          continue;
        }
        if (performance.now() - started > this.evalBudgetMs && check !== "semantic") {
          return deny("E-GOV-500", `闸门预算 ${this.evalBudgetMs}ms 超时，fail-closed`);
        }

        const result = this.runCheck(check, { req, ctx, sourceId, tier });
        checks.push({ check, ok: result.ok, note: result.note });
        if (!result.ok) {
          return deny(result.code, result.note, result.fatal);
        }
      }

      const verdict: GateVerdict = { allow: true, code: "OK", reason: "全部检查通过", fatal: false, checks, elapsedMs: performance.now() - started };
      this.audit(ctx, "gate.allow", req, "OK", verdict.reason);
      return verdict;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (failClosed) {
        return deny("E-GOV-500", `闸门异常（fail-closed）: ${msg}`);
      }
      // 仅测试允许 fail-open
      return { allow: true, code: "E-GOV-500-OPEN", reason: `闸门异常但 fail-open: ${msg}`, fatal: false, checks, elapsedMs: performance.now() - started };
    }
  }

  private runCheck(
    check: GovernanceCheck,
    c: { req: GateRequest; ctx: TenantContext; sourceId: string | null; tier: DataTier | null },
  ): { ok: boolean; code: string; note: string; fatal?: boolean } {
    switch (check) {
      case "scope": {
        // 请求的数据分级必须在租户策略允许范围内
        const tier = c.tier ?? this.deps.repos.sources.get(c.ctx.tenantId, c.sourceId ?? "")?.tier ?? null;
        if (tier && !this.deps.config.tiers[tier]) {
          return { ok: false, code: "E-DATA-004", note: `分级 ${tier} 已被策略关闭（BM_${tier}_ENABLED=false）` };
        }
        return { ok: true, code: "OK", note: tier ? `分级 ${tier} 在策略内` : "无分级声明，跳过" };
      }

      case "source": {
        if (!c.sourceId) return { ok: true, code: "OK", note: "非数据访问类工具，无 sourceId" };
        const src = this.deps.repos.sources.get(c.ctx.tenantId, c.sourceId);
        if (!src) {
          return { ok: false, code: "E-GOV-001", note: `数据源 ${c.sourceId} 未在台账登记，禁止访问` };
        }
        if (src.tier === "L4" && !src.legalApproved) {
          return { ok: false, code: "E-DATA-004", note: `L4 源 ${c.sourceId} 法务未批准，双重开关未同时满足` };
        }
        return { ok: true, code: "OK", note: `源 ${c.sourceId}(${src.tier}) 已登记` };
      }

      case "authz": {
        if (!c.sourceId) return { ok: true, code: "OK", note: "无 sourceId，跳过授权检查" };
        const az = this.deps.repos.authz.active(c.ctx.tenantId, c.sourceId);
        if (!az) {
          const any = this.deps.repos.authz.list(c.ctx.tenantId).find((a) => a.sourceId === c.sourceId);
          if (any && any.status === "active" && new Date(any.validTo) < new Date()) {
            return { ok: false, code: "E-GOV-002", note: `源 ${c.sourceId} 授权已于 ${any.validTo} 过期` };
          }
          return { ok: false, code: "E-DATA-002", note: `源 ${c.sourceId} 无生效授权` };
        }
        return { ok: true, code: "OK", note: `授权 ${az.authzId} 有效期至 ${az.validTo}` };
      }

      case "tenant": {
        if (!c.sourceId) return { ok: true, code: "OK", note: "无 sourceId，跳过租户检查" };
        const src = this.deps.repos.sources.get(c.ctx.tenantId, c.sourceId);
        // 台账按 (tenant_id, source_id) 主键存储，能查到即同租户；
        // 这里额外做一次显式比对，防止未来跨租户共享源时漏检。
        if (src && src.tenantId !== c.ctx.tenantId) {
          return { ok: false, code: "E-GOV-003", note: `跨租户访问：源属于 ${src.tenantId}，当前租户 ${c.ctx.tenantId}`, fatal: true };
        }
        const bodyTenant = (c.req.args as Record<string, unknown>).tenantId;
        if (typeof bodyTenant === "string" && bodyTenant !== c.ctx.tenantId) {
          return { ok: false, code: "E-GOV-003", note: `请求体 tenantId(${bodyTenant}) 与令牌租户(${c.ctx.tenantId}) 不一致`, fatal: true };
        }
        return { ok: true, code: "OK", note: "租户一致" };
      }

      case "semantic": {
        const policy = this.deps.semanticPolicy;
        if (policy?.deniedSources?.includes(c.sourceId ?? "")) {
          return { ok: false, code: "E-GOV-005", note: `源 ${c.sourceId} 在语义拒绝清单中` };
        }
        const budget = (c.req.args as Record<string, unknown>).budgetAmount;
        if (policy?.maxBudgetAmount !== undefined && typeof budget === "number" && budget > policy.maxBudgetAmount) {
          return { ok: false, code: "E-GOV-005", note: `预算 ${budget} 超过上限 ${policy.maxBudgetAmount}` };
        }
        return { ok: true, code: "OK", note: "语义检查通过" };
      }
      default:
        return { ok: true, code: "OK", note: "未知检查项，跳过" };
    }
  }

  private audit(ctx: TenantContext, kind: AuditKind, req: GateRequest, code: string, reason: string): void {
    this.deps.repos.audit.add({
      tenantId: ctx.tenantId,
      kind,
      jobId: req.jobId || ctx.jobId,
      agent: req.agent,
      tool: req.tool,
      code,
      reason,
      // prod 下不记原文（BM_TRACE_CONTENT=false）
      payload: this.deps.config.observability.traceContent ? { args: req.args } : { argKeys: Object.keys(req.args) },
      traceId: ctx.traceId,
    });
  }

  /* ── 台账登记与授权 ───────────────────────────────────── */

  async registerSource(src: SourceRegistration, ctx: TenantContext): Promise<{ sourceId: string }> {
    // 组合校验先于写入：非法组合直接拒绝，不在台账里留下"看起来已授权"的源。
    // 与下面 L4 的"允许登记但标记未批准"不冲突——那条是**访问时**由闸门双开关拦截，
    // 而这里拦的是字段本身自相矛盾（如 L3 填了合同编号）。
    assertSourceRegistration(src);

    if (src.tier === "L4" && !src.legalApproved) {
      // 允许登记但标记未批准；真到使用时会被 source 检查挡住
      this.deps.repos.audit.add({
        tenantId: ctx.tenantId,
        kind: "source.register",
        code: "E-DATA-004",
        reason: `L4 源 ${src.sourceId} 登记时未获法务批准，将在访问时被拦截`,
        traceId: ctx.traceId,
      });
    }
    this.deps.repos.sources.upsert({ ...src, tenantId: ctx.tenantId });
    this.deps.repos.audit.add({
      tenantId: ctx.tenantId,
      kind: "source.register",
      reason: `登记数据源 ${src.sourceId}(${src.tier})`,
      traceId: ctx.traceId,
    });
    return { sourceId: src.sourceId };
  }

  async grantAuthz(grant: AuthzGrant, ctx: TenantContext): Promise<{ authzId: string }> {
    const rec = this.deps.repos.authz.add({ ...grant, tenantId: ctx.tenantId });
    this.deps.repos.audit.add({
      tenantId: ctx.tenantId,
      kind: "authz.grant",
      reason: `授权 ${rec.sourceId}，有效期 ${rec.validFrom} ~ ${rec.validTo}`,
      traceId: ctx.traceId,
    });
    return { authzId: rec.authzId };
  }

  async revokeAuthz(authzId: string, tenantId: string, reason: string, ctx: TenantContext): Promise<void> {
    this.deps.repos.authz.revoke(authzId, tenantId, reason);
    this.deps.repos.audit.add({ tenantId, kind: "authz.revoke", reason, traceId: ctx.traceId });
  }

  async listAuthorizations(tenantId: string): Promise<AuthzRecord[]> {
    return this.deps.repos.authz.list(tenantId);
  }
}

/** 工具级白名单校验：不属于该 Agent 的工具一律拒绝（E-GOV-004） */
export function assertToolAllowed(tool: string, allowed: string[], agent: string): void {
  if (!allowed.includes(tool)) {
    throw new AppError({
      code: "E-GOV-004",
      message: `工具 ${tool} 不在 ${agent} 的白名单中`,
      details: { tool, agent, allowed },
    });
  }
}

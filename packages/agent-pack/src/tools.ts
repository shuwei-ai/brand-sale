/**
 * M10 ToolRegistry：工具注册与治理（对应 LLD §2.11）
 *
 * 三条硬约束写在代码里：
 *   1. **令牌桶的唯一权威在这里**。数据源适配器内部不做限流，M12 也不做——
 *      全系统只有这一处按（租户 × 工具 × 源）三维计数，避免三处限流打架（风险 T4）。
 *   2. 每次调用先过白名单，再过 M3 闸门，最后才执行；被拒**不静默**，发出 `governance.block` 事件。
 *   3. 超时/失败按 policy.fallback 降级，绝不把"空结果"伪装成"真实结果"。
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentCode,
  type DataTier,
  type JobStreamEvent,
  type PhaseName,
  type TenantContext,
  type ToolPolicy,
  AppError,
} from "@brandsale/contracts";
import type { Config } from "@brandsale/config";
import { DataSourceRegistry, type Provenance } from "@brandsale/datasource";
import type { GovernanceGate } from "@brandsale/governance";
import type { KnowledgeService, PricingStore } from "@brandsale/knowledge";
import type { Repositories } from "@brandsale/storage";

/* ── 令牌桶 ─────────────────────────────────────────────── */

class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(private readonly rps: number, private readonly burst: number) {
    this.tokens = burst;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rps);
  }

  /** 排队而非丢弃；超时抛错交给降级链 */
  async acquire(maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      if (Date.now() >= deadline) throw new Error(`限流排队超时（${maxWaitMs}ms）`);
      if (signal?.aborted) throw new Error("aborted");
      const need = (1 - this.tokens) / this.rps;
      await new Promise((r) => setTimeout(r, Math.max(10, Math.min(200, need * 1000))));
    }
  }
}

class TokenBucketRegistry {
  private readonly buckets = new Map<string, TokenBucket>();
  get(key: string, rps: number, burst: number): TokenBucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(rps, burst);
      this.buckets.set(key, b);
    }
    return b;
  }
}

/* ── 工具上下文与实现 ───────────────────────────────────── */

export interface ToolCallContext {
  ctx: TenantContext;
  jobId: string;
  phase: PhaseName;
  attempt: number;
  emit: (e: JobStreamEvent) => void;
  signal: AbortSignal;
}

export interface ToolCallRecord {
  tool: string;
  agent: AgentCode;
  at: string;
  ms: number;
  ok: boolean;
  cached: boolean;
  note?: string;
}

export interface ToolImpl {
  policy: ToolPolicy;
  description: string;
  /** 该工具产出是否必须带 citation */
  producesCitedData: boolean;
  parameters: ReturnType<typeof Type.Object>;
  execute(params: Record<string, unknown>, tc: ToolCallContext): Promise<{ result: unknown; provenance?: Provenance[]; note?: string }>;
}

export interface ToolDeps {
  config: Config;
  repos: Repositories;
  gate: GovernanceGate;
  knowledge: KnowledgeService;
  pricing: PricingStore;
  datasources: DataSourceRegistry;
}

/* ── 注册表 ─────────────────────────────────────────────── */

export class ToolRegistry {
  private readonly tools = new Map<string, ToolImpl>();
  private readonly buckets = new TokenBucketRegistry();
  /** 调用计数，供 E2E「联动重算时上游工具调用次数不增加」断言 */
  private callLog: ToolCallRecord[] = [];
  /** 单任务调用计数：key = `${jobId}|${tool}`，用于 maxCallsPerJob 的总额熔断 */
  private readonly jobCalls = new Map<string, number>();

  constructor(private readonly deps: ToolDeps) {}

  register(tool: ToolImpl): void {
    this.tools.set(tool.policy.name, tool);
  }

  list(): ToolImpl[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolImpl | undefined {
    return this.tools.get(name);
  }

  calls(): ToolCallRecord[] {
    return this.callLog;
  }

  resetCallLog(): void {
    this.callLog = [];
    this.jobCalls.clear();
  }

  /** 调用次数（可按工具过滤） */
  callCount(tool?: string): number {
    return tool ? this.callLog.filter((c) => c.tool === tool).length : this.callLog.length;
  }

  /**
   * 统一入口：白名单 → 闸门 → 限流 → 超时 → 重试 → 降级。
   */
  async invoke(name: string, params: Record<string, unknown>, agent: AgentCode, tc: ToolCallContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AppError({ code: "E-GOV-004", message: `未注册的工具 ${name}` });
    }
    const started = Date.now();

    // 1) 白名单
    if (!tool.policy.allowedAgents.includes(agent)) {
      tc.emit({
        type: "governance.block",
        seq: 0,
        at: new Date().toISOString(),
        tool: name,
        code: "E-GOV-004",
        reason: `工具 ${name} 不在 ${agent} 的白名单中（这是实现 bug，需要告警）`,
        fatal: false,
      });
      throw new AppError({ code: "E-GOV-004", message: `工具 ${name} 不在 ${agent} 白名单`, details: { agent, allowed: tool.policy.allowedAgents } });
    }

    // 1.5) 单任务调用上限：外部计费接口必须有界。
    // 令牌桶限速率不限总量，模型换着关键词就能把同一个源问一百遍；
    // 这里按 (jobId, tool) 计数，超限直接降级，让 Agent 用已有结果收尾。
    if (tool.policy.maxCallsPerJob !== undefined) {
      const key = `${tc.jobId}|${name}`;
      const used = this.jobCalls.get(key) ?? 0;
      if (used >= tool.policy.maxCallsPerJob) {
        const reason = `${name} 在本次任务内已调用 ${used} 次，达到上限 ${tool.policy.maxCallsPerJob}，后续调用被拒（防外部计费接口失控）`;
        this.log(name, agent, started, false, reason);
        tc.emit({ type: "data.degraded", seq: 0, at: new Date().toISOString(), source: name, missing: [], reason: "rate_limited" });
        return this.degrade(tool, params, tc, "E-DATA-003", reason);
      }
      this.jobCalls.set(key, used + 1);
    }

    // 2) 闸门
    // 数据源由**工具声明**（policy.boundSourceId），不由模型参数决定。
    // 原因：闸门的 source / authz / tenant 三项都按 args.sourceId 定位数据源，
    // 若来源由模型"自报"，模型传另一个已登记的 sourceId 就能让闸门检查错对象，
    // 而工具真正访问的源一次都没被检查。绑定值在这里覆盖参数值。
    const gateArgs = tool.policy.boundSourceId ? { ...params, sourceId: tool.policy.boundSourceId } : params;
    const verdict = await this.deps.gate.evaluate(
      {
        tenantId: tc.ctx.tenantId,
        jobId: tc.jobId,
        agent,
        tool: name,
        args: gateArgs,
        checks: tool.policy.governance,
      },
      tc.ctx,
    );
    if (!verdict.allow) {
      tc.emit({
        type: "governance.block",
        seq: 0,
        at: new Date().toISOString(),
        tool: name,
        code: verdict.code,
        reason: verdict.reason,
        fatal: verdict.fatal,
      });
      if (verdict.fatal) {
        throw new AppError({ code: verdict.code as never, message: verdict.reason, fatal: true });
      }
      return this.degrade(tool, params, tc, verdict.code, verdict.reason);
    }

    // 3) 限流（桶键 = 租户 × 工具）
    const bucketKey = `${tc.ctx.tenantId}|${name}`;
    try {
      await this.buckets.get(bucketKey, tool.policy.rateLimit.rpsPerTenant, tool.policy.rateLimit.burst).acquire(
        tool.policy.rateLimit.queueMaxMs,
        tc.signal,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tc.emit({ type: "data.degraded", seq: 0, at: new Date().toISOString(), source: name, missing: [], reason: "rate_limited", });
      this.log(name, agent, started, false, `限流排队失败：${msg}`);
      return this.degrade(tool, params, tc, "E-DATA-003", msg);
    }

    // 4) 超时 + 重试
    let lastErr: unknown;
    for (let attempt = 0; attempt <= tool.policy.retry.attempts; attempt++) {
      try {
        const res = await withTimeout(tool.policy.timeoutMs, tc.signal, () => tool.execute(params, tc));
        this.log(name, agent, started, true, res.note);
        return res;
      } catch (e) {
        lastErr = e;
        if (e instanceof AppError && e.fatal) throw e;
        if (attempt < tool.policy.retry.attempts) {
          const base = tool.policy.retry.baseMs;
          const delay = tool.policy.retry.backoff === "exponential" ? base * 2 ** attempt : base;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const code = /超时|timeout/i.test(msg) ? "E-DATA-001" : "E-DATA-002";
    this.log(name, agent, started, false, msg);
    tc.emit({ type: "data.degraded", seq: 0, at: new Date().toISOString(), source: name, missing: [], reason: code === "E-DATA-001" ? "timeout" : "unavailable" });
    return this.degrade(tool, params, tc, code, msg);
  }

  /** 按 policy.fallback 返回降级结果；不允许把空结果伪装成真实结果 */
  private degrade(tool: ToolImpl, _params: Record<string, unknown>, _tc: ToolCallContext, code: string, reason: string): unknown {
    const fb = tool.policy.fallback ?? "none";
    if (fb === "none") {
      return { degraded: true, code, reason, rows: null, note: "该工具无降级返回，调用方必须显式处理缺失" };
    }
    return {
      degraded: true,
      code,
      reason,
      rows: fb === "empty" ? [] : null,
      note: `降级返回（fallback=${fb}）：${reason}`,
    };
  }

  private log(tool: string, agent: AgentCode, startedAt: number, ok: boolean, note?: string): void {
    this.callLog.push({ tool, agent, at: new Date().toISOString(), ms: Date.now() - startedAt, ok, cached: Boolean(note?.includes("缓存")), ...(note ? { note } : {}) });
  }

  /** 暴露给 pi-agent-core Agent 的工具定义（按 Agent 的权限过滤） */
  toAgentTools(agent: AgentCode, tc: ToolCallContext): AgentTool[] {
    return this.list()
      .filter((t) => t.policy.allowedAgents.includes(agent))
      .map((t) => ({
        name: t.policy.name,
        label: t.policy.name,
        description: t.description,
        parameters: t.parameters,
        executionMode: t.policy.parallelism === "parallel" ? ("parallel" as const) : ("sequential" as const),
        replay: t.policy.replaySafe ? ("safe" as const) : ("never" as const),
        execute: async (_id: string, params: unknown) => {
          try {
            const out = await this.invoke(t.policy.name, (params ?? {}) as Record<string, unknown>, agent, tc);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(out) }],
              details: out,
              structuredContent: out as never,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
              details: { error: msg },
              isError: true,
            };
          }
        },
      })) as unknown as AgentTool[];
  }
}

async function withTimeout<T>(ms: number, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`工具执行超时（${ms}ms）`)), ms);
    t.unref?.();
  });
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return Promise.race([fn(), timeout, aborted]);
}

/* ── 工具策略默认值 ─────────────────────────────────────── */

export function policy(partial: Partial<ToolPolicy> & Pick<ToolPolicy, "name" | "allowedAgents">): ToolPolicy {
  return {
    governance: [],
    rateLimit: { rpsPerTenant: 8, burst: 8, queueMaxMs: 5000 },
    timeoutMs: 15_000,
    retry: { attempts: 1, backoff: "exponential", baseMs: 300 },
    parallelism: "parallel",
    replaySafe: true,
    // 缺省只读。写工具必须显式声明 mutating: true，并因此受装配期的三重约束
    // （默认不注册 / 必须挂 authz / 必须 replaySafe=false）。见 ToolPolicy.mutating。
    mutating: false,
    ...partial,
  };
}

export const TIER_GOVERNANCE = (tier: DataTier): ToolPolicy["governance"] =>
  tier === "L4" ? ["scope", "source", "authz", "tenant", "semantic"] : ["scope", "source", "authz", "tenant"];

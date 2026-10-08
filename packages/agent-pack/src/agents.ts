/**
 * M9 AgentPack 运行时：把六个 Agent 与 Pi 框架真正接起来
 *
 * 执行路径（三条，优先级从高到低）：
 *   ① pi-agent   —— 用 pi-agent-core 的 `Agent` 跑完整 Agent 循环（模型自主调用工具）
 *   ② json-direct —— 确定性预取工具 + 单次结构化输出（模型不可用/工具编排不稳定时的稳定路径）
 *   ③ synthesized —— 模型完全不可用时，用工具实测数据 + 保守模板合成，并强制标注降级
 *
 * 三条路径共用同一套 M3 闸门与 M10 工具治理，因此**治理强度不随路径变化**。
 */

import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_DEPTH_POLICY,
  POPULAR_PLATFORMS,
  describeDepthPolicy,
  measureReportDepth,
  validateReportDsl,
  type AgentCode,
  type Degraded,
  type JobRecord,
  type JobStreamEvent,
  type Money,
  type PhaseName,
  type PhaseRunInput,
  type PhaseRunOutput,
  type ReportDsl,
  type ReportDepthPolicy,
  type SourceCatalog,
  type TenantContext,
  type TokenUsage,
} from "@brandsale/contracts";
import { PHASE_AGENT } from "@brandsale/contracts";
import type { ModelGateway, ModelTier } from "@brandsale/model-gateway";
import { createVllmModel, loadPiStreamFn } from "@brandsale/model-gateway";
import type { Provenance } from "@brandsale/datasource";
import { buildSourceCatalog, type LineageLedger } from "@brandsale/governance";
import { ToolRegistry, type ToolCallContext, type ToolCallRecord, type ToolDeps } from "./tools.ts";
import { PHASE_TOOL_HINT, registerAllTools } from "./tool-impls.ts";
import { SYSTEM_PROMPTS, contextBlock } from "./prompts.ts";
import {
  BriefSchema,
  BudgetSchema,
  CompetitorIntelSchema,
  CreatorCandidatesSchema,
  PlaybookSchema,
  ReportDslSchema,
  type BudgetOutput,
  type CreatorOutput,
  type IntelOutput,
  type PlaybookOutput,
} from "./schemas.ts";
import { synthBudget, synthCreators, synthIntel, synthPlaybook, synthReport } from "./synthesis.ts";

export interface AgentRuntimeDeps extends ToolDeps {
  gateway: ModelGateway;
  ledger: LineageLedger;
}

export type PhaseStrategy = "pi-agent" | "json-direct" | "synthesized";

const ARTIFACT_KIND_BY_PHASE: Record<PhaseName, string> = {
  intake: "brief",
  intel: "intel",
  creator: "creator_candidates",
  playbook: "playbook",
  budget: "budget",
  report: "report_dsl",
};

export interface PhaseResult extends PhaseRunOutput {
  /** 该阶段的台账 id */
  ledgerId?: string;
  usage: TokenUsage;
  cost: Money;
  strategy: PhaseStrategy;
  toolCalls: ToolCallRecord[];
  /** 结构化产出（Schema 校验通过的对象）；失败时为 undefined */
  structured?: unknown;
}

const TIER_BY_PHASE: Record<PhaseName, ModelTier> = {
  intake: "light",
  intel: "strong",
  creator: "medium",
  playbook: "medium",
  budget: "medium",
  report: "strong",
};

const SCHEMA_BY_PHASE = {
  intake: BriefSchema,
  intel: CompetitorIntelSchema,
  creator: CreatorCandidatesSchema,
  playbook: PlaybookSchema,
  budget: BudgetSchema,
  report: ReportDslSchema,
} as const;

/**
 * 各阶段输出 token 上限（不列出的用网关默认值）。
 *
 * 为什么要分级而不是一个全局值：
 *   - 输出预算给少了 → 模型每轮都恰好截在 max_tokens（finish_reason=length），
 *     解析全失败后走合成兜底，报告顶部出现误导性的「模型不可用」横幅。
 *     实际模型一直是好的，是输出预算给少了；
 *   - 给所有阶段一个很大的值 → 短任务（intake）也会按大预算计费与等待。
 * 一份 13 页、含真表格与图表的 DSL 约 40–60KB JSON（≈2 万+ token），
 * 所以 report 必须显著高于其它阶段；具体值可由 BM_REPORT_MAX_TOKENS 覆盖。
 */
const MAX_TOKENS_BY_PHASE: Partial<Record<PhaseName, number>> = {
  intake: 4_096,
  intel: 8_192,
  creator: 8_192,
  playbook: 10_240,
  budget: 8_192,
  report: 32_768,
};

/**
 * 上下文预算按阶段给：`contextBlock` 会把上游产物裁到 maxChars。
 * 旧实现全局 24000，report 阶段装不下「竞品 + 人选 + 排期 + 预算」四份表格，
 * 模型只能凭残缺信息写报告 —— 上游好不容易加厚的维度在下游又被丢掉了。
 */
const CONTEXT_MAX_CHARS: Record<PhaseName, number> = {
  intake: 8_000,
  intel: 16_000,
  creator: 16_000,
  playbook: 24_000,
  budget: 16_000,
  report: 48_000,
};

const PHASE_TIMEOUT_MS: Record<PhaseName, number> = {
  // intake 要跑完「工具往返 + 完整 JSON 生成」，实测自建端点 60s 会被截断在半截 JSON 上
  intake: 120_000,
  intel: 180_000,
  creator: 150_000,
  playbook: 150_000,
  budget: 150_000,
  report: 240_000,
};

export class AgentPack {
  readonly registry: ToolRegistry;
  private streamFn: StreamFn | null = null;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.registry = new ToolRegistry(deps);
    registerAllTools(this.registry, deps);
    for (const [name, def] of Object.entries(SCHEMA_BY_PHASE)) {
      // mock 模式的桩：用工具实测数据合成，保证 mock 与真实路径结构一致
      deps.gateway.registerMock(def.name, (prompt) => JSON.stringify(this.mockPayloadFor(name as PhaseName, prompt)));
    }
  }

  /* ── 主入口 ───────────────────────────────────────────── */

  async runPhase(phase: PhaseName, input: PhaseRunInput): Promise<PhaseResult> {
    const agent = PHASE_AGENT[phase];
    const ledgerRun = this.deps.ledger.begin({
      ctx: input.ctx,
      jobId: input.job.jobId,
      phase,
      agent,
      runId: `run_${input.job.jobId}_${phase}_${input.job.updatedAt}`,
    });

    const tc: ToolCallContext = {
      ctx: { ...input.ctx, jobId: input.job.jobId },
      jobId: input.job.jobId,
      phase,
      attempt: 1,
      emit: input.emit,
      signal: input.signal,
    };

    const callsBefore = this.registry.callCount();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
    let cost: Money = { currency: "CNY", amount: 0 };
    const degradedKeys: string[] = [];

    try {
      // ① 预取：无论走哪条路径，工具都要真实跑一遍（M3 + M10 全程生效）
      const { data: prefetched, provenances } = await this.prefetch(phase, input, tc, degradedKeys);
      // 台账记录输入：每条数据从哪个源、取了多少行、是否命中缓存
      for (const p of provenances) {
        ledgerRun.addInput({
          sourceId: p.sourceId,
          tier: p.tier,
          query: p.note,
          rowCount: p.rowCount,
          cached: p.note.includes("缓存"),
        });
      }

      // ② 依次尝试三条路径
      const attempt = await this.runStrategies(phase, input, tc, prefetched, degradedKeys);

      usage = attempt.usage;
      cost = attempt.cost;

      const toolCalls = this.registry.calls().slice(callsBefore);

      if (attempt.ok) {
        ledgerRun.addOutput({ artifactKind: ARTIFACT_KIND_BY_PHASE[phase], ref: `artifact://${tc.jobId}/${phase}` });
        const finishedLedger = ledgerRun.finish();
        return {
          status: degradedKeys.length > 0 ? "partial" : "succeeded",
          output: attempt.value,
          structured: attempt.value,
          ...(degradedKeys.length > 0 ? { degradedKeys } : {}),
          usage,
          cost,
          strategy: attempt.strategy,
          toolCalls,
          note: attempt.note,
          ledgerId: finishedLedger.ledgerId,
        };
      }

      const failedLedger = ledgerRun.finish();
      return {
        status: this.deps.config.job.allowPartial ? "partial" : "failed",
        errorCode: attempt.code,
        ledgerId: failedLedger.ledgerId,
        errorMessage: attempt.errors.join("; "),
        degradedKeys: [...degradedKeys, ...attempt.errors],
        usage,
        cost,
        strategy: attempt.strategy,
        toolCalls,
        note: `阶段降级：${attempt.code}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ledgerRun.finish();
      return {
        status: "failed",
        errorCode: "E-AGENT-002",
        errorMessage: msg,
        degradedKeys: [...degradedKeys, msg],
        usage,
        cost,
        strategy: "json-direct",
        toolCalls: this.registry.calls().slice(callsBefore),
      };
    }
  }

  /* ── 工具预取：每个阶段固定跑一遍取数 ─────────────────── */

  /**
   * 本次真实可用的数据源目录（台账源 ∪ 本地 KB 语料源 ∪ 内部数据仓）。
   *
   * 这是「来源必须可溯源」的单一事实源：提示词里注入它、RG 产出后自校验用它、
   * 渲染期兜底校验也用它。放在 governance 组装（render 不允许查库）。
   */
  sourceCatalog(ctx: TenantContext): SourceCatalog {
    return buildSourceCatalog({
      repos: this.deps.repos,
      tenantId: ctx.tenantId,
      knowledgeSourceIds: this.deps.knowledge.sourceIds(ctx.tenantId).map((x) => x.sourceId),
      chunkIds: this.deps.knowledge.chunkIds(ctx.tenantId),
    });
  }

  /** 深度策略：页数下限可由 config 覆盖，其余沿用契约里的默认值 */
  private depthPolicy(): ReportDepthPolicy {
    return { ...DEFAULT_DEPTH_POLICY, minSlides: this.deps.config.report.minSlides };
  }

  private maxTokensFor(phase: PhaseName): number | undefined {
    if (phase === "report") return this.deps.config.report.maxTokens;
    return MAX_TOKENS_BY_PHASE[phase];
  }

  private contextCharsFor(phase: PhaseName): number {
    if (phase === "report") return this.deps.config.report.contextMaxChars;
    return CONTEXT_MAX_CHARS[phase];
  }

  private async prefetch(
    phase: PhaseName,
    input: PhaseRunInput,
    tc: ToolCallContext,
    degradedKeys: string[],
  ): Promise<{ data: Record<string, unknown>; provenances: Provenance[] }> {
    const out: Record<string, unknown> = {};
    const provenances: Provenance[] = [];
    const brief = input.job.spec.brief;
    const intel = input.upstream.intel as IntelOutput | undefined;
    const playbookUp = input.upstream.playbook as PlaybookOutput | undefined;

    const run = async (key: string, tool: string, params: Record<string, unknown>): Promise<void> => {
      try {
        const res = (await this.registry.invoke(tool, { ...params, tenantId: tc.ctx.tenantId }, PHASE_AGENT[phase], tc)) as {
          result?: unknown;
          provenance?: Provenance[];
        };
        out[key] = res;
        for (const p of res?.provenance ?? []) {
          if (!provenances.some((x) => x.sourceId === p.sourceId && x.note === p.note)) provenances.push(p);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        degradedKeys.push(`${tool}: ${msg}`);
        out[key] = { degraded: true, error: msg };
      }
    };

    switch (phase) {
      case "intake": {
        await run("validate_brief", "validate_brief", {
          brief: {
            industry: brief.industry,
            category: brief.category,
            budgetAmount: brief.budget.amount,
            awareness: brief.objectiveWeights.awareness,
            conversion: brief.objectiveWeights.conversion,
            retention: brief.objectiveWeights.retention,
            platforms: brief.platforms,
          },
        });
        await run("resolve_authorization", "resolve_authorization", {});
        break;
      }
      case "intel": {
        /* 三路并行检索，而不是一条笼统 query。
         * 旧实现只有一条「竞品 趋势」，检索面太窄 —— 报告里"类目趋势与人群洞察""法规与合规口径"
         * 两页永远只有一句泛泛之谈。三路各带 topK，命中量提升但仍然是确定性的本地检索。 */
        await run("kb_retrieve", "kb_retrieve", { query: `${brief.category} ${brief.industry} 竞品格局 定位 价格带`, collections: ["KB-3", "KB-1"], topK: 5 });
        await run("kb_category", "kb_retrieve", { query: `${brief.category} 类目趋势 人群 季节性`, collections: ["KB-3", "KB-4"], topK: 5 });
        await run("kb_compliance", "kb_retrieve", { query: `${brief.industry} 广告法 功效宣称 合规 口径`, collections: ["KB-3", "KB-4"], topK: 5 });
        /* 联网检索（可选能力，三条前置都满足才跑）：
         *   registry 里没有 → 说明没配 API Key 或已被策略关闭，直接跳过，
         *     否则会因 E-GOV-004 把 intel 误标成降级；
         *   mock 模式 → 全离线可复现，不发任何外部请求（E2E 用例靠这条保证不联网）。
         * count 走 config（BM_WEB_SEARCH_COUNT），不在代码里写死，避免两处漂移。 */
        if (this.deps.config.webSearch.prefetch && !this.deps.gateway.mocked && this.registry.get("web_search")) {
          await run("web_search", "web_search", {
            query: `${brief.industry} ${brief.category} 市场趋势 竞品动态 ${brief.window.to.slice(0, 4)}`,
            count: this.deps.config.webSearch.defaultCount,
          });
        }
        break;
      }
      case "creator": {
        await run("kb_retrieve", "kb_retrieve", { query: `${brief.category} 达人 人选 匹配 分层`, collections: ["KB-2", "KB-3"], topK: 6 });
        await run("pricing_query", "pricing_query", { category: brief.category, topK: 6 });
        /* 风控必须覆盖**全部**候选：旧实现只筛 candidates[0]，
         * 于是报告的风险列只对一个人有效，其余候选全是"无风险"——这不是风控，是漏检。 */
        const cands =
          (out["pricing_query"] as { candidates?: { talent: { talentId: string; followers: number; engagementRate: number; category: string } }[] } | undefined)?.candidates ?? [];
        for (const c of cands) {
          await run(`risk_${c.talent.talentId}`, "risk_screen", {
            talentId: c.talent.talentId,
            followers: c.talent.followers,
            engagementRate: c.talent.engagementRate,
            category: c.talent.category,
          });
        }
        break;
      }
      case "playbook": {
        await run("kb_retrieve", "kb_retrieve", { query: `${brief.category} 打法 节奏 排期 内容日历`, collections: ["KB-4", "KB-1"], topK: 5 });
        const creators = (input.upstream.creator as CreatorOutput | undefined)?.candidates?.map((c) => c.talentId) ?? [];
        await run("calendar_plan", "calendar_plan", {
          from: brief.window.from,
          to: brief.window.to,
          phases: [
            { label: "预热期", days: 12, budgetShare: 0.2, creators: creators.slice(0, 1) },
            { label: "爆发期", days: 15, budgetShare: 0.6, creators: creators.slice(0, 2) },
            { label: "长尾期", days: 5, budgetShare: 0.2, creators },
          ],
        });
        break;
      }
      case "budget": {
        await run("pricing_query", "pricing_query", { talentId: (input.upstream.creator as CreatorOutput | undefined)?.candidates?.[0]?.talentId ?? "t_1001" });
        /* baseRoi 不再硬编码 1.9：从 KB-2 的历史复盘里取锚点。
         * 取不到再退回保守缺省，并在报告里标明是估算 —— 硬编码的数字最容易被当成实测值。 */
        await run("kb_retrieve", "kb_retrieve", { query: `${brief.category} 达人种草 占比 ROI 复盘 最优`, collections: ["KB-2", "KB-3"], topK: 4 });
        const baseRoi = this.roiAnchorFromKb(out["kb_retrieve"]);
        await run("scenario_simulate", "scenario_simulate", { totalBudget: brief.budget.amount, baseRoi, volatility: 0.3 });
        break;
      }
      case "report": {
        /* 来源目录必须随预取一起进提示词：模型看不到「本次真实可用的源有哪些」，
         * 就只能凭训练记忆编 —— 实测它写出了千川/星图/蒲公英/生意参谋/巨量算数
         * 五个系统里根本不存在的源，而真实的联网检索被写成"火山搜索"。 */
        out["source_catalog"] = this.sourceCatalog(tc.ctx);
        await run("render_outline", "render_outline", {
          title: `${brief.category} 品牌营销策略建议`,
          sections: ["竞品格局与类目洞察", "人选建议与成本估计", "打法与排期", "预算分配与三档情景模拟", "风险登记与应对"],
        });
        await run("cite_fact", "cite_fact", { claim: intel?.citations?.[0]?.claim ?? "占位", confidence: intel?.citations?.[0]?.confidence ?? 0.5 });
        break;
      }
    }
    void playbookUp;
    return { data: out, provenances };
  }

  /**
   * 从 KB-2 复盘语料里取 ROI 锚点。
   *
   * 语料形如「达人种草占比 45% 时 ROI 最优（2.3）」。解析失败就返回保守缺省 1.8，
   * 由调用方在报告里标成估算值 —— **不猜**。
   */
  private roiAnchorFromKb(raw: unknown): number {
    const hits = (raw as { result?: { hits?: { text?: string }[] } } | undefined)?.result?.hits ?? [];
    for (const h of hits) {
      const text = String(h.text ?? "");
      if (!/ROI/i.test(text)) continue;
      // 覆盖「ROI 最优（2.3）」「ROI 2.3」两种常见写法
      const m = /ROI[^0-9]{0,16}(\d+(?:\.\d+)?)/i.exec(text);
      const v = Number(m?.[1]);
      if (Number.isFinite(v) && v > 0.5 && v < 10) return v;
    }
    return 1.8;
  }

  /* ── 三条执行路径 ─────────────────────────────────────── */

  private async runStrategies(
    phase: PhaseName,
    input: PhaseRunInput,
    tc: ToolCallContext,
    prefetched: Record<string, unknown>,
    degradedKeys: string[],
  ): Promise<
    | { ok: true; value: unknown; strategy: PhaseStrategy; usage: TokenUsage; cost: Money; note?: string }
    | { ok: false; strategy: PhaseStrategy; code: string; errors: string[]; usage: TokenUsage; cost: Money }
  > {
    const agent = PHASE_AGENT[phase];
    const schema = SCHEMA_BY_PHASE[phase];
    const prompt = this.buildPrompt(phase, input, prefetched);
    const usableTools = this.registry.list().filter((t) => t.policy.allowedAgents.includes(agent)).map((t) => t.policy.name);

    // ③ mock 模式：用工具实测数据合成，并对合成结果跑一遍 Schema 校验（保证桩与真实路径同构）
    if (this.deps.gateway.mocked) {
      const value = this.synthesize(phase, input, prefetched, false);
      schema.validate(value); // 合成结果不合法就直接暴露为测试失败，而不是悄悄放过
      const res = await this.deps.gateway.complete({
        tier: TIER_BY_PHASE[phase],
        system: SYSTEM_PROMPTS[agent],
        messages: [{ role: "user", content: `${prompt}\n\nschemaName=${schema.name}` }],
        jobId: tc.jobId,
        phase,
        attempt: tc.attempt,
        callId: `mock_${tc.jobId}_${phase}`,
      });
      return {
        ok: true,
        value,
        strategy: "synthesized",
        usage: res.usage,
        cost: res.cost,
        note: `mock 模式（无真实模型调用，Schema ${schema.name} 校验通过）`,
      };
    }

    // ① Pi Agent 循环
    const pi = await this.tryPiAgent(phase, agent, input, tc, prompt, usableTools);
    if (pi.ok) {
      if (phase !== "report") return pi;
      const refined = await this.finalizeReport(tc, prompt, pi.value as ReportDsl, degradedKeys);
      return { ...pi, value: refined.value, note: refined.note ? `${pi.note ?? ""}；${refined.note}`.replace(/^；/, "") : pi.note };
    }
    console.warn(`[agent-pack] ${phase} Pi 循环未通过：${pi.errors.join(" | ").slice(0, 200)}`);

    // ② 单次结构化输出
    const direct = await this.deps.gateway.completeJson({
      tier: TIER_BY_PHASE[phase],
      system: SYSTEM_PROMPTS[agent],
      prompt,
      maxTokens: this.maxTokensFor(phase),
      schemaName: schema.name,
      parse: (raw) => schema.validate(JSON.parse(raw)),
      jobId: tc.jobId,
      phase,
      attempt: tc.attempt,
      callId: `direct_${tc.jobId}_${phase}`,
      signal: tc.signal,
    });
    if (direct.ok) {
      let value: unknown = direct.value;
      let note = `结构化输出通过（重试 ${direct.retries} 次）`;
      if (phase === "report") {
        const refined = await this.finalizeReport(tc, prompt, value as ReportDsl, degradedKeys);
        value = refined.value;
        if (refined.note) note += `；${refined.note}`;
      }
      return { ok: true, value, strategy: "json-direct", usage: direct.usage, cost: direct.cost, note };
    }
    console.warn(`[agent-pack] ${phase} 直连结构化输出未通过：${direct.code} ${direct.errors.join(" | ").slice(0, 200)}`);

    // ③ 合成兜底
    if (this.deps.config.job.allowPartial) {
      // 降级文案必须如实：E-AGENT-002 是调用层失败（网络/超时/熔断），说"模型不可用"没问题；
      // E-AGENT-001 是模型有输出但没通过解析/校验（常见于被 max_tokens 截断），
      // 此时模型是通的，写"模型不可用"会误导排障方向 —— 曾因此把截断问题误判成端点故障。
      const unavailable = direct.code === "E-AGENT-002";
      const fallbackReason = unavailable
        ? `模型调用失败（${direct.code}：${direct.errors[0] ?? "未知"}），报告由工具实测数据 + 保守模板合成`
        : `模型输出未通过结构校验（${direct.code}，可能被 max_tokens 截断），报告由工具实测数据 + 保守模板合成`;
      const value = this.synthesize(phase, input, prefetched, true, fallbackReason);
      if (value !== undefined) {
        return {
          ok: true,
          value,
          strategy: "synthesized",
          usage: direct.usage,
          cost: direct.cost,
          note: `${unavailable ? "模型不可用" : "模型输出未通过校验"}（${direct.code}），改用工具实测数据 + 保守模板合成，置信度已下调`,
        };
      }
    }

    return { ok: false, strategy: "json-direct", code: direct.code, errors: direct.errors, usage: direct.usage, cost: direct.cost };
  }

  /**
   * RG 产出后的自校验 + **一次**回喂修复（P0-2 / P1-2 里性价比最高的一步）。
   *
   * 现状对比：旧实现是「渲染期才拦」，拦下来任务就废了；
   * 现在是「RG 产出后立刻核对来源合法性与深度下限，把问题清单原样告诉模型再生成一次」。
   * 它把"模型不知道错在哪"变成"模型被明确告知错在哪"。
   *
   * 只回喂一次，是刻意的：仍不达标就**接受 + 如实标注 degraded**，而不是死循环或硬失败。
   * 收紧校验的目的是让报告更可信，不是让报告消失。
   */
  private async finalizeReport(
    tc: ToolCallContext,
    prompt: string,
    value: ReportDsl,
    degradedKeys: string[],
  ): Promise<{ value: ReportDsl; note?: string }> {
    const policy = this.depthPolicy();
    const catalog = this.sourceCatalog(tc.ctx);
    const first = validateReportDsl(value, { catalog, minTraceableRatio: policy.minTraceableRatio });
    // 只有「不可机械修复」的 error 才值得回喂；可修复项交给渲染期 autoRepair 降级处理
    const blocking = first.issues.filter((i) => i.level === "error" && !i.repairable);
    const depth = measureReportDepth(value, policy);

    if (blocking.length === 0 && depth.gaps.length === 0) return { value };

    const problems = [
      ...blocking.map((i) => `- ${i.path}: ${i.message}`),
      ...depth.gaps.map((g) => `- 深度未达标：${g}`),
    ];
    const repairPrompt = `${prompt}

【上一次输出被拒绝，必须逐条修正后重新输出完整 JSON】
${problems.join("\n")}

【颗粒度下限 · 违反即需要重做】
${describeDepthPolicy(policy)}`;

    const repaired = await this.deps.gateway.completeJson({
      tier: TIER_BY_PHASE.report,
      system: SYSTEM_PROMPTS.RG,
      prompt: repairPrompt,
      maxTokens: this.maxTokensFor("report"),
      schemaName: ReportDslSchema.name,
      parse: (raw) => ReportDslSchema.validate(JSON.parse(raw)),
      jobId: tc.jobId,
      phase: "report",
      attempt: tc.attempt,
      callId: `repair_${tc.jobId}_report`,
      signal: tc.signal,
    });

    const markDegraded = (dsl: ReportDsl, reason: string, missing: string[]): ReportDsl => ({
      ...dsl,
      meta: { ...dsl.meta, degraded: { reason, missingSections: missing } },
    });

    if (repaired.ok) {
      const v2 = repaired.value as ReportDsl;
      const stillBlocking = validateReportDsl(v2, { catalog, minTraceableRatio: policy.minTraceableRatio }).issues.filter(
        (i) => i.level === "error" && !i.repairable,
      );
      const depth2 = measureReportDepth(v2, policy);
      if (stillBlocking.length === 0 && depth2.gaps.length === 0) {
        return { value: v2, note: `按问题清单回喂修复 1 次后通过（原问题 ${problems.length} 项）` };
      }
      const missing = [...stillBlocking.map((i) => i.message), ...depth2.gaps];
      degradedKeys.push(`报告未达深度/校验下限（已回喂 1 次）：${missing.slice(0, 3).join("；")}`);
      return {
        value: markDegraded(v2, `报告仍有 ${missing.length} 项未达标（已回喂 1 次，如实标注）`, missing),
        note: `回喂 1 次后仍有 ${missing.length} 项未达标，已落 meta.degraded 并标 partial`,
      };
    }

    degradedKeys.push(`报告未达深度/校验下限，且回喂修复调用失败（${repaired.code}）`);
    return {
      value: markDegraded(value, `报告未达深度下限且回喂修复失败（${repaired.code}）`, depth.gaps),
      note: `回喂修复失败（${repaired.code}），保留原始输出并如实标注降级`,
    };
  }

  private async tryPiAgent(
    phase: PhaseName,
    agentCode: AgentCode,
    input: PhaseRunInput,
    tc: ToolCallContext,
    prompt: string,
    usableTools: string[],
  ): Promise<
    | { ok: true; value: unknown; strategy: "pi-agent"; usage: TokenUsage; cost: Money; note?: string }
    | { ok: false; strategy: "pi-agent"; code: string; errors: string[]; usage: TokenUsage; cost: Money }
  > {
    const zero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
    const noCost: Money = { currency: "CNY", amount: 0 };

    if (usableTools.length === 0) {
      return { ok: false, strategy: "pi-agent", code: "E-AGENT-002", errors: ["该 Agent 无可用工具，跳过 Agent 循环"], usage: zero, cost: noCost };
    }

    // 端点已熔断时直接跳过 Pi 循环（省掉整段超时预算），把机会留给直连与合成路径
    try {
      this.deps.gateway.checkBreaker();
    } catch (e) {
      return { ok: false, strategy: "pi-agent", code: "E-AGENT-002", errors: [e instanceof Error ? e.message : String(e)], usage: zero, cost: noCost };
    }

    let agent: Agent;
    try {
      this.streamFn ??= await loadPiStreamFn(this.deps.config);
      const model = createVllmModel(this.deps.config, TIER_BY_PHASE[phase]);
      // 大输出阶段（report）放宽 Pi 路径的输出上限，理由见 MAX_TOKENS_BY_PHASE 注释
      const phaseMaxTokens = this.maxTokensFor(phase);
      if (phaseMaxTokens) model.maxTokens = phaseMaxTokens;
      agent = new Agent({
        initialState: {
          systemPrompt: SYSTEM_PROMPTS[agentCode],
          model,
          tools: this.registry.toAgentTools(agentCode, tc),
          messages: [],
        },
        streamFn: this.streamFn,
        getApiKey: async () => this.deps.config.llm.apiKey,
        beforeToolCall: async (ctx) => {
          // 钩子层的白名单前置校验：模型幻觉出一个不存在的工具时，在这里就挡掉并告知模型
          const name = (ctx as { toolCall?: { name?: string } }).toolCall?.name ?? "";
          if (name && !usableTools.includes(name)) {
            return { block: true, reason: `工具 ${name} 不在本阶段白名单内。可用工具：${usableTools.join(", ")}` };
          }
          return undefined;
        },
      });
    } catch (e) {
      return { ok: false, strategy: "pi-agent", code: "E-AGENT-002", errors: [e instanceof Error ? e.message : String(e)], usage: zero, cost: noCost };
    }

    const deltas: string[] = [];
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_update") {
        const ev = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ev?.type === "text_delta" && ev.delta) {
          deltas.push(ev.delta);
          input.emit({
            type: "agent.delta",
            seq: 0,
            at: new Date().toISOString(),
            agent: agentCode,
            kind: "text",
            delta: ev.delta,
          });
        }
      }
    });

    const timer = setTimeout(() => agent.abort(), PHASE_TIMEOUT_MS[phase]);
    timer.unref?.();

    // 硬杀兜底：abort() 只是个请求，不保证 waitForIdle 会返回
    // （实测端点挂死时，流未关闭则 idle 永远不来）。超过预算 5s 仍未结束就放弃等待，
    // 让这个阶段走降级路径，而不是把整个任务拖死。
    const HARD_KILL_GRACE_MS = 5_000;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
    const budget = PHASE_TIMEOUT_MS[phase];
    const run = (async () => {
      await agent.waitForIdle();
      await agent.prompt(prompt);
      await agent.waitForIdle();
    })();
    const hardKill = new Promise<never>((_, reject) => {
      hardKillTimer = setTimeout(
        () => reject(new Error(`Pi 循环超过 ${budget + HARD_KILL_GRACE_MS}ms 仍未结束（已强制中止），放弃该策略`)),
        budget + HARD_KILL_GRACE_MS,
      );
      hardKillTimer.unref?.();
    });

    try {
      await Promise.race([run, hardKill]);
      this.deps.gateway.noteLlmSuccess();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const callerAborted = tc.signal.aborted;
      this.deps.gateway.noteLlmFailure(e, !callerAborted);
      return { ok: false, strategy: "pi-agent", code: "E-AGENT-002", errors: [msg], usage: zero, cost: noCost };
    } finally {
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      unsubscribe();
    }

    const text = deltas.join("") || this.lastAssistantText(agent);
    if (!text.trim()) {
      // 把最后一条助手消息的内容形态带出来：区分「模型只调了工具没答话」
      // 和「内容全在 thinking 块里」和「真的空响应」——三种情况的修法完全不同
      const dump = agent.state.messages
        .map((m) => {
          const role = (m as { role?: string }).role ?? "?";
          const blocks = (m as { content?: { type?: string }[] }).content;
          const shape = Array.isArray(blocks) ? blocks.map((b) => b?.type ?? "?").join("+") : String(typeof blocks);
          return `${role}[${shape}]`;
        })
        .join(" → ");
      const last = [...agent.state.messages].reverse().find((m) => (m as { role?: string }).role === "assistant");
      const blocks = (last as { content?: { type?: string }[] } | undefined)?.content ?? [];
      const preview = JSON.stringify(blocks).slice(0, 240);
      return {
        ok: false,
        strategy: "pi-agent",
        code: "E-AGENT-002",
        errors: [`Agent 循环未产出任何文本（消息序列：${dump}；最后助手消息预览：${preview}）`],
        usage: zero,
        cost: noCost,
      };
    }

    const schema = SCHEMA_BY_PHASE[phase];
    try {
      const parsed = JSON.parse(extractJsonObject(text));
      const value = schema.validate(parsed);
      // Pi 路径的用量与成本由 M14 记账（此处仅估）
      const usage: TokenUsage = {
        inputTokens: Math.ceil(prompt.length / 1.5) + Math.ceil(SYSTEM_PROMPTS[agentCode].length / 1.5),
        outputTokens: Math.ceil(text.length / 1.5),
        cachedInputTokens: 0,
        calls: 1,
      };
      this.deps.repos.usage.record({
        jobId: tc.jobId,
        phase,
        attempt: tc.attempt,
        callId: `pi_${tc.jobId}_${phase}`,
        model: this.deps.config.llm.models[TIER_BY_PHASE[phase]],
        tokens: usage,
        cost: { currency: "CNY", amount: 0 },
      });
      return { ok: true, value, strategy: "pi-agent", usage, cost: noCost, note: "Pi Agent 循环产出" };
    } catch (e) {
      // 注意：走到这里说明流式请求本身成功了（有文本产出），失败在解析/校验层，
      // 不应给熔断器记一笔端点失败 —— 所以这里不调用 noteLlmFailure
      return {
        ok: false,
        strategy: "pi-agent",
        code: "E-AGENT-001",
        errors: [e instanceof Error ? e.message : String(e)],
        usage: zero,
        cost: noCost,
      };
    }
  }

  private lastAssistantText(agent: Agent): string {
    for (let i = agent.state.messages.length - 1; i >= 0; i--) {
      const m = agent.state.messages[i] as { role?: string; content?: unknown };
      if (m?.role !== "assistant") continue;
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c): c is { type: string; text?: string } => typeof c === "object" && c !== null)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
      }
    }
    return "";
  }

  /* ── 提示词与合成 ─────────────────────────────────────── */

  private buildPrompt(phase: PhaseName, input: PhaseRunInput, prefetched: Record<string, unknown>): string {
    const agent = PHASE_AGENT[phase];
    const schema = SCHEMA_BY_PHASE[phase];
    const maxChars = this.contextCharsFor(phase);
    const catalog = prefetched["source_catalog"] as SourceCatalog | undefined;
    const policy = this.depthPolicy();

    /* 三个数据区，职责必须分清：
     *   Brief   —— 客户输入，是"事实基准"，直接采用，不要改写、不要置 null；
     *   工具数据 —— 本次实测取回的，带来源与分级；
     *   上游产物 —— 前序阶段的结论，只可引用不可改写。
     * 之前吃过亏：Brief 没进提示词，模型拿不到输入，只能对着 Schema 全填 null；
     * 而"无来源数字写 null"这条合规指令又把用户输入的预算/权重一起清掉了。 */
    const sections = [
      `【当前阶段】${phase}（${agent}）`,
      `【阶段作业指引】${PHASE_TOOL_HINT[phase]}`,
      `【客户输入 Brief（事实基准，直接采用）】\n${JSON.stringify(input.job.spec.brief, null, 2)}`,
      `【输出结构模板（字段名必须完全一致，不要增删改字段名）】\n${schema.skeleton}`,
      `【可调用工具】${this.registry.list().filter((t) => t.policy.allowedAgents.includes(agent)).map((t) => `${t.policy.name}(${t.description})`).join("\n- ")}`,
      `【可用数据源清单（唯一合法的来源集合）】\n${this.renderCatalog(catalog)}`,
      `【本次工具已取回的数据】\n${contextBlock(prefetched, maxChars)}`,
      `【上游阶段产物】\n${contextBlock({
        intake: input.upstream.intake ?? null,
        intel: input.upstream.intel ?? null,
        creator: input.upstream.creator ?? null,
        playbook: input.upstream.playbook ?? null,
        budget: input.upstream.budget ?? null,
      }, maxChars)}`,
      `【输出要求】
1. 只输出**一个**符合 ${schema.name} 的 JSON 对象：不要 markdown 代码块、不要解释文字、不要输出 Schema 本身。
2. Brief 里客户已给的值（行业、类目、预算金额、目标权重、时间窗、平台）**原样写入结果**，它们是用户输入，不需要来源标注，禁止改成 null。
3. 只有你基于工具数据/上游产物**推断或估算**出来的数字才必须有 citations 支撑；确实推断不出的写 null 并在对应 note 里说明原因。
4. 不要编造数据源、达人或结论；宁可写 null，不可编造。
5. 引用必须真实：数字来自工具/知识库用 kind=data_source|kb_chunk 且 ref 指向上面清单里的 key；
   你自己推断的数字必须 kind=model_inference + tier=low。**禁止**把推断写成 data_source。
6. block.sourceRef 只允许用命名空间写法：phase:brief / phase:intel / phase:creator / phase:playbook / phase:budget /
   meta:sourceDeclaration / meta:disclaimer / tool:pricing / tool:scenario_simulate / tool:calendar_plan / tool:render_outline。`,
    ];
    if (phase === "report") {
      sections.push(`【颗粒度下限 · 违反即需要重做】\n${describeDepthPolicy(policy)}`);
    }
    return sections.join("\n\n");
  }

  /** 把来源目录渲染成提示词里的一段：模型唯一的"合法来源"依据 */
  private renderCatalog(catalog: SourceCatalog | undefined): string {
    if (!catalog || catalog.entries.length === 0) {
      return "（本次没有任何可用数据源：所有数字必须标 kind=model_inference 且 tier=low，不得声称来自任何数据源）";
    }
    const lines = catalog.entries.map((e) => `- ${e.key}（${e.displayName} · ${e.grade}）：${e.coverage}`);
    lines.push(
      "- 本系统**没有**千川 / 星图 / 蒲公英 / 生意参谋 / 巨量算数 的数据源，禁止在 sourceDeclaration 里声明它们。",
      "- sourceDeclaration.sources 只能从上面这份清单里选，key 与 displayName 必须逐字一致；未使用的源写进 exclusions 并说明原因。",
      "- 每个来源声明的 key，必须至少有 1 条 citation 指向它；否则删掉这条声明。",
    );
    return lines.join("\n");
  }

  /** 合成（同时作为 mock 桩） */
  /** 合成（同时作为 mock 桩）；fallbackReason 用于降级说明，如实描述失败原因 */
  private synthesize(
    phase: PhaseName,
    input: PhaseRunInput,
    prefetched: Record<string, unknown>,
    asFallback: boolean,
    fallbackReason = "模型不可用，报告由工具实测数据 + 保守模板合成",
  ): unknown {
    const brief = input.job.spec.brief;
    switch (phase) {
      case "intake": {
        const v = prefetched["validate_brief"] as { ok?: boolean; issues?: string[] } | undefined;
        const auth = prefetched["resolve_authorization"] as { usableSources?: BriefAuth["usable"]; blockedSources?: BriefAuth["blocked"] } | undefined;
        return {
          brief,
          authorization: { usableSources: auth?.usableSources ?? [], blockedSources: auth?.blockedSources ?? [] },
          clarifications: v?.ok === false ? (v.issues ?? []) : [],
          confidence: asFallback ? 0.4 : 0.9,
        };
      }
      case "intel":
        return synthIntel(brief, prefetched);
      case "creator":
        return synthCreators(brief, prefetched);
      case "playbook":
        return synthPlaybook(brief, prefetched);
      case "budget":
        // 渠道 × 阶段矩阵要用上游排期的阶段划分，别在预算阶段自己编阶段名
        return synthBudget(brief, prefetched, {
          phases: (input.upstream.playbook as PlaybookOutput | undefined)?.phases,
        });
      case "report": {
        const degraded = asFallback
          ? { reason: fallbackReason, missingSections: [] as string[] }
          : undefined;
        return synthReport(
          brief,
          {
            intel: input.upstream.intel as IntelOutput | undefined,
            creator: input.upstream.creator as CreatorOutput | undefined,
            playbook: input.upstream.playbook as PlaybookOutput | undefined,
            budget: input.upstream.budget as BudgetOutput | undefined,
          },
          {
            synthesized: asFallback,
            catalog: prefetched["source_catalog"] as SourceCatalog | undefined,
            ...(degraded ? { degraded } : {}),
          },
        );
      }
    }
  }

  /** mock 模式下的桩：用已注册的合成器产出合法 JSON */
  private mockPayloadFor(phase: PhaseName, _prompt: string): unknown {
    const fakeJob = {
      job: { spec: { brief: MOCK_BRIEF } },
      upstream: {},
      ctx: { tenantId: "mock", userId: "mock", traceId: "mock", locale: "zh-CN" },
      emit: () => {},
      signal: new AbortController().signal,
    } as unknown as PhaseRunInput;
    return this.synthesize(phase, fakeJob, {}, false);
  }

  get platformFallback(): readonly string[] {
    return POPULAR_PLATFORMS;
  }

  degradedFrom(keys: string[], phase: PhaseName): Degraded {
    return { missing: keys, reason: "partial_output", note: `${phase} 阶段存在缺失项，报告已标注` };
  }
}

interface BriefAuth {
  usable: { sourceId: string; tier: string; expiresAt: string }[];
  blocked: { sourceId: string; reason: string }[];
}

export const MOCK_BRIEF = {
  industry: "美妆",
  category: "护肤品-精华",
  brandIds: ["brand_A"],
  budget: { currency: "CNY" as const, amount: 3_000_000 },
  objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
  window: { from: "2026-05-20", to: "2026-06-20" },
  platforms: ["douyin", "xiaohongshu"],
};

/** 从文本里抠出最外层 JSON 对象 */
/**
 * 从模型输出中提取 JSON 对象文本。
 *
 * 为什么是"逐个候选试到能解析为止"：真实模型输出经常是
 * 「[Tool: kb_retrieve] returned 6 hits.\n 竞品如{竞品X}的份额…\n {"competitors": [...]}」——
 * 正文里可能先出现别的 `{`（花括号、示例、工具回显）。
 * 旧实现取第一个平衡块就返回，遇到这种输出直接 JSON.parse 报
 * `Unexpected token 'T'`，一整段好好的 JSON 被浪费掉。
 */
export function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const src = fenced?.[1] ?? text;

  // 逐个 `{` 起点，切出平衡块，第一个能通过 JSON.parse 的就是答案
  for (let start = src.indexOf("{"); start !== -1; start = src.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i]!;
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = src.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break; // 这个块不是合法 JSON，继续找下一个起点
          }
        }
      }
    }
  }
  return src.trim();
}

export type { JobRecord, JobStreamEvent };

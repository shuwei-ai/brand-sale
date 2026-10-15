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
  type Brief,
  type Degraded,
  type EvidenceEntry,
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
import type { ModelGateway, ModelTier, StreamDelta } from "@brandsale/model-gateway";
import { createVllmModel, loadPiStreamFn } from "@brandsale/model-gateway";
import {
  BRIEF_PLATFORM_TO_MC,
  MEDIA_CRAWLER_PLATFORM_META,
  MEDIA_CRAWLER_PLATFORMS,
  type Config,
  type MediaCrawlerPlatform,
} from "@brandsale/config";
import { mediaCrawlerReady, type Provenance } from "@brandsale/datasource";
import { buildSourceCatalog, type LineageLedger } from "@brandsale/governance";
import { EvidenceRegistry } from "./evidence.ts";
import { ToolRegistry, type ToolCallContext, type ToolCallRecord, type ToolDeps } from "./tools.ts";
import { PLATFORM_DIGEST_TOOL_NAME, PHASE_TOOL_HINT, registerAllTools } from "./tool-impls.ts";
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
import {
  aggregatePlatformAccounts,
  enrichReportProvenance,
  ensurePlatformCreators,
  mergePlatformEvidences,
  PLATFORM_CREATOR_KEY,
  platformCreatorCandidates,
  pruneUnverifiableCreators,
  synthBudget,
  synthCreators,
  synthIntel,
  synthPlaybook,
  synthReport,
  unwrap,
} from "./synthesis.ts";

export interface AgentRuntimeDeps extends ToolDeps {
  gateway: ModelGateway;
  ledger: LineageLedger;
}

export type PhaseStrategy = "pi-agent" | "json-direct" | "synthesized";

/** 三条执行路径的统一返回形态（阶段内循环与入口共用） */
type StrategyOutcome =
  | { ok: true; value: unknown; strategy: PhaseStrategy; usage: TokenUsage; cost: Money; note?: string }
  | { ok: false; strategy: PhaseStrategy; code: string; errors: string[]; usage: TokenUsage; cost: Money };

/** 从上游产物里取人选结果（报告阶段给它标"来源=本地报价库、平台账号未核验"用） */
const creatorsOf = (input: PhaseRunInput): CreatorOutput | undefined =>
  input.upstream.creator as CreatorOutput | undefined;

const ARTIFACT_KIND_BY_PHASE: Record<PhaseName, string> = {
  intake: "brief",
  intel: "intel",
  creator: "creator_candidates",
  playbook: "playbook",
  budget: "budget",
  report: "report_dsl",
};

/**
 * 流式增量合帧器（把细碎的 token 增量并成少量 `agent.delta` 事件）。
 *
 * 解决两个方向相反的问题：
 *   · **发得太少**：直连结构化输出（`json-direct`）与报告回喂修复此前完全没有流式输出
 *     （`completeJson` 支持 `onDelta` 却没人传）。而这两条恰恰是当前端点下**每阶段都会走到**
 *     的路径，所以界面上"模型在思考"的过程整个是看不到的。
 *   · **发得太多**：Pi 路径逐 token 直发，一次任务 1.6 万条 `agent.delta`，既压事件环形缓冲
 *     （状态类事件被挤掉，刷新后日志空白），又制造大量无意义写库。
 *
 * 折中：按 ~120ms 或 ~160 字符合帧。观感仍是逐字实时（慢速流每来一个 token 就成帧），
 * 事件量则降一个数量级。
 *
 * 导出它只为可测性：合帧最容易犯的错是"最后一段没吐出去"，而那正是报告结论段所在的位置，
 * 必须有一个不依赖真实端点的用例把它钉住。第 3、4 个参数同样是给测试用的。
 */
export class DeltaPump {
  private buf = "";
  private lastAt = Date.now();

  constructor(
    private readonly emit: (delta: string) => void,
    private readonly flushMs = 120,
    private readonly maxChars = 160,
  ) {}

  push(delta: string | undefined): void {
    if (!delta) return;
    this.buf += delta;
    if (this.buf.length >= this.maxChars || Date.now() - this.lastAt >= this.flushMs) this.flush();
  }

  flush(): void {
    if (!this.buf) return;
    const d = this.buf;
    this.buf = "";
    this.lastAt = Date.now();
    this.emit(d);
  }
}

/**
 * 业务平台码 → 采集平台码。
 *
 * 两套编码**不通用**，必须显式映射：
 *   · `Brief.platforms` 用业务码（`POPULAR_PLATFORMS`：douyin / xiaohongshu / bilibili / weibo）；
 *   · 采集侧用短码（`MEDIA_CRAWLER_PLATFORMS`：dy / xhs / bili / wb）。
 * 写死在一处而不是在调用点散落 `if`，是为了让"brief 里出现的新平台忘了接采集"这件事
 * 只在有契约用例盯着的地方发生（见 tests/collector.test.ts 的映射用例）。
 *
 * 刻意只映射 brief 里可能出现的四个：快手 / 贴吧 / 知乎不在 `Brief.platforms` 的候选集里，
 * 预采集不该替它们凭空造平台主张；确有需要时由 CI 在工具循环里按需触发。
 * 与 `prefetchScope="brief"`（默认）合起来的后果要清楚：快手/贴吧/知乎**不会被预采集**，
 * 只会在模型主动调 `platform_digest` 时按需采 —— 这是有意的（客户没要的平台不预先烧时间）。
 *
 * 映射表本身定义在 `@brandsale/config` —— `tool-impls.ts` 的聚合工具要用同一份做参数别名
 * 归一，两处各写一份迟早对不上。这里只做再导出，保住既有的导入路径。
 */
export { BRIEF_PLATFORM_TO_MC } from "@brandsale/config";

/** 预采集每平台取多少条：够做题材分布与口碑判断，又不至于把上下文挤爆 */
const PLATFORM_PREFETCH_LIMIT = 20;

/**
 * 构造 intel 阶段平台预采集的参数；`null` 表示没有可投递的采集平台。
 *
 * **覆盖范围 = brief 声明的平台**（`config.mediaCrawler.prefetchScope`，默认 `brief`）。
 * 为什么默认收窄（2026-10-14 改）：平台采集是分钟级的 Playwright 子进程，一次报告对
 * 七个平台各投一轮，"客户没打算投"的那几个平台就是在白烧时间与机器；而报告在来源声明里
 * **本来就**如实写着「快手不在本次调研范围」（手机报告实测 exclusions 四条正是如此）——
 * 采了也照样进排除项，说明这批数据从产出到引用整条链路上没有任何一处会用到它。
 *
 * 三个分支（顺序即优先级）：
 *   1. `scope="all"` → 联合集：全部已装配平台，brief 声明的排在最前。这是**旧默认**，
 *      保留给"要回答这个话题此刻在哪些平台被讨论"的跨平台视野场景；
 *   2. `scope="brief"` 且 brief 声明了平台 → **取声明的那个集合**（映射后按已装配过滤，
 *      顺序即声明顺序，便于确定性断言）。声明了但一个都没装配 → `null`：
 *      本次确实没有可采的平台，报告按"该平台未接入"如实写，而不是悄悄改采别的平台；
 *   3. `scope="brief"` 且 brief 没声明平台 → 不设范围，退回全部已装配平台。
 *      这条是**防悬崖**用的：`brief.platforms` 允许为空（网关直接透传 brief，不做校验），
 *      若空即 `null`，报告会整份拿不到平台证据 —— 那正是业主投诉过的"章节空白"形态。
 *
 * 注意范围只约束**预采集**：工具装配与闸门仍按 `platforms` 全量生效，模型在工具循环里
 * 仍可主动采任何已装配平台（`platform_digest` 的 `platforms` 参数接受全部七个采集码）。
 * 也就是说收窄的是"默认行为"，不是"能力"。
 *
 * 抽成纯函数是为了让"业务码 → 采集码、去重、覆盖范围"这三件事**可被确定性测试**：
 * 它原本内联在 prefetch 里，只能靠"mock 模式不联网"间接验证，而那恰恰测不到
 * "参数构造对不对"。真正的投递（`run`）仍留在 prefetch 里。
 */
export function platformPrefetchArgs(
  brief: Pick<Brief, "platforms" | "category">,
  config?: Pick<Config, "mediaCrawler">,
): Record<string, unknown> | null {
  const declared = [
    ...new Set(
      brief.platforms
        .map((bp) => BRIEF_PLATFORM_TO_MC[bp])
        .filter((p): p is MediaCrawlerPlatform => Boolean(p)),
    ),
  ];
  // 未传 config（纯函数测试 / 老调用方）时装配面按"七平台全开"处理；scope 无法得知时
  // 按 `loadConfig` 的同一默认值 `brief` 处理，两处默认必须一致，否则纯函数测的
  // 和线上跑的不是同一条路径。
  const enabled = config
    ? MEDIA_CRAWLER_PLATFORMS.filter((p) => config.mediaCrawler.platforms[p])
    : MEDIA_CRAWLER_PLATFORMS;
  const scope = config?.mediaCrawler.prefetchScope ?? "brief";
  const platforms =
    scope === "all"
      ? [...new Set([...declared, ...enabled])]
      : declared.length > 0
        ? declared.filter((p) => enabled.includes(p))
        : enabled;
  if (platforms.length === 0) return null;
  /* ⚠️ `category` 在这里是**逐字当搜索关键词**用的，不是分类标签。
   * 所以它必须是一个"人真的会输进搜索框的词"（中文短语），而不是 `headphones` 这类英文标识符：
   * 英文词在抖音/小红书/B站搜不到内容（实测小红书 0 条、抖音 14 条混进 3 条英语教学视频）。
   * 这条不改，另外两处必须保证 category 是中文：
   *   ① `INDUSTRY_LEXICON`（packages/contracts/src/brief-parse.ts）——规则段命中的优先路径；
   *   ② `FILL_PROMPT` 第 7 条（packages/agent-pack/src/brief-parse.ts）——规则段未命中时的兜底。
   * 新增品类时优先补词表，不要指望模型每次都对。 */
  return { op: "search", keyword: brief.category, platforms, limit: PLATFORM_PREFETCH_LIMIT };
}

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

/**
 * 各阶段 Pi 循环的**时间下限**（毫秒）。
 *
 * 注意：这只是下限，实际预算见 tryPiAgent —— 会取
 * `max(本表, BM_LLM_TIMEOUT_MS + PHASE_TIMEOUT_SLACK_MS)`。
 * 因为自建端点有**冷启动**：模型未驻留时，请求会先"连上但不吐 token"好几分钟，
 * 冷启动完成后同一次请求会正常返回，之后一段时间内都很快。
 * 若阶段预算小于单次请求超时，阶段会在请求本身还没超时前就 abort 掉，
 * 表现就是任务卡在 0%、既不前进也不降级。
 */
const PHASE_TIMEOUT_MS: Record<PhaseName, number> = {
  // intake 要跑完「工具往返 + 完整 JSON 生成」，实测自建端点 60s 会被截断在半截 JSON 上
  intake: 120_000,
  intel: 180_000,
  creator: 150_000,
  playbook: 150_000,
  budget: 150_000,
  report: 240_000,
};

/** 请求超时之外，留给「冷启动完成后真正生成」的余量 */
const PHASE_TIMEOUT_SLACK_MS = 60_000;

/* ── Pi 循环的「工具调用风暴」闸门 ──────────────────────────
 *
 * 实测踩到的形态（真机日志，双十一自测那次）：intel 阶段同一个 `platform_digest`
 * 被**连续调用 131 次**，每一次都被 `maxCallsPerJob` 拒绝、每一次都记一条
 * `rate_limited` 降级事件。整个阶段的预算被这些必然失败的往返烧光，Pi 循环最后
 * 只吐出一句半截话（"I'll start…"），结构化解析失败；等轮到直连兜底时阶段预算已耗尽，
 * 又被打成 E-AGENT-002 —— 报告整体降级成模板合成。用户看到的就是"数据明明采到了，
 * 报告却还是占位与无数据"。
 *
 * 根因：提示词鼓励"首次常返回 0 条，重试即可"，模型就把"重试"当成了循环条件；
 * 而治理层只会「拒绝并解释」，**没有终止循环的手段**，模型并不会因为被拒就停手。
 *
 * 这里补两层闸门：同一调用重复超过 N 次即拒；连续被拒 N 次后置 `terminate`，
 * 让 Pi 循环提前收手，把剩余预算留给直连兜底 —— 在当前端点下，后者才是真正
 * 能产出合法 JSON 的那条路径。
 */
const PI_MAX_IDENTICAL_CALLS = 3;
const PI_MAX_TOOL_CALLS_PER_PHASE = 30;
const PI_MAX_BLOCKED_STREAK = 6;

/** 工具参数指纹：用于识别"同一调用"。序列化失败时退化为类型名，不抛。 */
function stableArgsKey(args: unknown): string {
  try {
    return JSON.stringify(args ?? null) ?? "null";
  } catch {
    return typeof args;
  }
}

export interface ToolCallGuardDecision {
  block?: boolean;
  terminate?: boolean;
  reason?: string;
}

/**
 * Pi 循环的「工具调用风暴」闸门。
 *
 * 抽成**纯状态机**而不是内联在 `beforeToolCall` 里，是为了让"什么情况下必须拦、
 * 什么情况下必须终止循环"变成可确定性测试的规则 —— 它真正的判据是计数器，
 * 而不是 Agent 循环本身。
 */
export function createToolCallGuard(usableTools: readonly string[]) {
  const callCounts = new Map<string, number>();
  let toolCalls = 0;
  let blockedStreak = 0;

  return {
    attempt(name: string, args: unknown): ToolCallGuardDecision | undefined {
      // 白名单：模型幻觉出一个不存在的工具时，在这里挡掉并告知可用集合
      if (name && !usableTools.includes(name)) {
        blockedStreak += 1;
        return {
          block: true,
          ...(blockedStreak >= PI_MAX_BLOCKED_STREAK ? { terminate: true } : {}),
          reason: `工具 ${name} 不在本阶段白名单内。可用工具：${usableTools.join(", ")}`,
        };
      }
      if (!name) return undefined;

      toolCalls += 1;
      if (toolCalls > PI_MAX_TOOL_CALLS_PER_PHASE) {
        blockedStreak += 1;
        return {
          block: true,
          terminate: true,
          reason:
            `本阶段工具调用已达上限 ${PI_MAX_TOOL_CALLS_PER_PHASE} 次，循环提前结束。` +
            `请基于**已有数据**直接输出最终 JSON，不要再调用任何工具。`,
        };
      }

      const key = `${name}|${stableArgsKey(args)}`;
      const seen = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, seen);
      if (seen > PI_MAX_IDENTICAL_CALLS) {
        blockedStreak += 1;
        const stop = blockedStreak >= PI_MAX_BLOCKED_STREAK;
        return {
          block: true,
          ...(stop ? { terminate: true } : {}),
          reason:
            `同一调用（${name} + 相同参数）已重复 ${seen - 1} 次且未返回新数据，本次被拒。` +
            (stop
              ? "循环提前结束：请基于已有数据直接输出最终 JSON。"
              : "数据若已够请**立刻**输出最终 JSON；确需更多数据请换不同参数。"),
        };
      }
      blockedStreak = 0;
      return undefined;
    },
    stats(): { toolCalls: number; blockedStreak: number; distinctCalls: number } {
      return { toolCalls, blockedStreak, distinctCalls: callCounts.size };
    },
  };
}

export class AgentPack {
  readonly registry: ToolRegistry;
  /**
   * 平台采集证据登记表（P0 溯源）。
   *
   * 生命周期挂在 AgentPack 上（进程级），按 jobId 分桶：同一 job 的 intel / creator
   * 阶段共享一份证据集，report 阶段据此组装目录并做 R13 校验。
   * 换 job 不需要清理 —— 上限是每 job 一份小数组，重启即清空。
   */
  readonly evidence: EvidenceRegistry;
  private streamFn: StreamFn | null = null;

  constructor(private readonly deps: AgentRuntimeDeps) {
    // deps 上的 evidence 是**同一个对象**：工具侧通过 bindDeps 拿到它登记，这里读它做校验。
    // 没给就补一个缺省实例，避免每个构造 deps 的地方都要记得传。
    const evidence = deps.evidence ?? new EvidenceRegistry();
    deps.evidence = evidence;
    this.evidence = evidence;
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
    // 证据表是进程内的，产物才是持久的 —— 崩溃恢复/重启后重算 report 前先把证据回灌
    this.ensureEvidenceLoaded(input.job.jobId);
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
          // 命中与否取适配器给的**结构化**标记，不做文案匹配：
          // 采集侧说明里那句"本次无本地缓存"曾把未命中记成命中（见 Provenance.cacheHit）
          cached: p.cacheHit === true,
        });
      }

      // ② 依次尝试三条路径
      const attempt = await this.runStrategies(phase, input, tc, prefetched, degradedKeys);

      usage = attempt.usage;
      cost = attempt.cost;

      const toolCalls = this.registry.calls().slice(callsBefore);

      if (attempt.ok) {
        /**
         * intel 产出后立刻做**条目级溯源校验**（R13 的上游版本）。
         *
         * 模型可能引用一个不存在的 entryId（幻觉，或引用了别次任务的条目）。
         * 在进报告之前就摘掉并记降级，比等渲染期兜底更好：渲染期只能知道"DSL 里有非法引用"，
         * 这里还能说清是**哪几条**、并从产物里一并清理。
         */
        const value =
          phase === "intel"
            ? this.enforceEvidence(
                this.attachPlatformEvidences(attempt.value as IntelOutput, prefetched),
                tc,
                degradedKeys,
              )
            : phase === "creator"
              ? this.enforceRealCreators(attempt.value as CreatorOutput, tc, prefetched, degradedKeys)
              : attempt.value;
        // 证据集落成 job 产物（重放安全：只写第一份，审计要的是"这次采到了什么"）
        this.persistEvidence(tc.jobId);
        ledgerRun.addOutput({ artifactKind: ARTIFACT_KIND_BY_PHASE[phase], ref: `artifact://${tc.jobId}/${phase}` });
        const finishedLedger = ledgerRun.finish();
        return {
          status: degradedKeys.length > 0 ? "partial" : "succeeded",
          output: value,
          structured: value,
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
   * 把本次平台采集的原始条目**机械补进** intel 的 `evidences`。
   *
   * 为什么必须有这一步（实测踩到的断点）：`evidences` 在结构定义里是**可选**字段，
   * 模型路径（Pi 循环 / 单次结构化输出）不填它时，链路就断在这里 ——
   * `platform_digest` 明明取回了 90 条真实平台内容、也登记进了证据表，
   * 但下游报告拿到的 intel 里 `evidences` 是空的，于是：
   *   · 报告一条 `platform_entry` 也写不出来（读者点不回原帖）；
   *   · 来源声明里那几个平台算"没被引用"，只能列成"未使用"。
   * 即"平台取到了、报告没认领它"。
   *
   * 三条刻意的取舍：
   *   ① 模型自己写的条目**排前面**（它知道哪条支撑哪个结论），机械补的只做兜底、按 entryId 去重；
   *   ② 只搬 entryId/摘录，不生成 URL —— 出处仍然由渲染层按 entryId 反查，模型编不出链接；
   *   ③ 取不到 rows（没开平台采集、或本次仍在后台排队）时**原样返回**，不凭空造证据。
   *
   * 合成路径不需要：`synthIntel` 自己就用同一份 rows 生成 evidences（同源，重复调用是幂等的）。
   */
  private attachPlatformEvidences(value: IntelOutput, prefetched: Record<string, unknown>): IntelOutput {
    /* 必须走 `unwrap`：invoke 返回的是 `{ result, provenance, note }`。
     * 早先这里直接读 `pd?.rows`，于是**这一段从来没生效过** —— 机械补齐是本功能
     * 的唯一兜底，它悄悄不工作，才会出现"证据表里几十条真条目、报告一条都引不出来"。 */
    const pd = unwrap(prefetched[PLATFORM_DIGEST_TOOL_NAME]) as { rows?: Record<string, unknown>[] };
    const rows = Array.isArray(pd.rows) ? pd.rows : [];
    return mergePlatformEvidences(value, rows);
  }

  /**
   * 真实采集账号 → creator 阶段的人选池（写进 prefetched 的 `PLATFORM_CREATOR_KEY`）。
   *
   * 抽出来是因为它现在有**两个**调用时机：creator 阶段预取时、以及补取平台数据之后。
   * 池子必须跟着证据表走 —— 证据表从空变非空之后不重建，模型手里就还是空池，
   * 于是又去编人选（实测量产过 `待确认头部达人` 这类占位）。
   */
  private buildCreatorPool(input: PhaseRunInput, tc: ToolCallContext, prefetched: Record<string, unknown>): void {
    const entries = this.evidence.list(tc.jobId);
    const accounts = aggregatePlatformAccounts(entries);
    if (accounts.length === 0) return;
    const brief = input.job.spec.brief;
    prefetched[PLATFORM_CREATOR_KEY] = {
      candidates: platformCreatorCandidates(entries, {
        ...(brief.category ? { category: brief.category } : {}),
        platforms: brief.platforms,
      }),
      note: `来自 ${new Set(accounts.map((a) => a.platformName)).size} 个平台的真实采集账号（L3，账号昵称完整显示、粉丝量取自个人主页公开统计、报价未采集）`,
    };
  }

  /**
   * 补取一次平台数据（**降级路径与终稿前的最后一次自愈机会**）。
   *
   * 为什么非补不可：平台采集是分钟级的，intel/creator 阶段开头那次预取只能拿到
   * "已排队"的空结果，数据要几分钟后才落库。而 Pi 工具循环一旦失败（当前端点下
   * 几乎每个阶段都会降级到单次结构化输出），**降级路径不会再调任何工具** ——
   * 于是一个很荒诞的结果：数据在 20:30 就落库了，阶段却拿到 0 条，
   * 模型在没有数据的前提下编出 entryId，又被机械校验摘掉，报告被打上"产出不完整"。
   * 实测这一条就是业主看到的那条降级提示的成因。
   *
   * 另外这里**不重复触发采集**：同平台同算子的请求侧车会去重复用（见 apps/collector
   * 的 TaskManager），所以补取只花一次本地查询的时间。
   */
  private async refreshPlatformData(
    phase: PhaseName,
    input: PhaseRunInput,
    tc: ToolCallContext,
    prefetched: Record<string, unknown>,
    degradedKeys: string[],
  ): Promise<void> {
    if (this.deps.gateway.mocked) return; // E2E 全离线
    if (phase !== "intel" && phase !== "creator") return;
    if (!mediaCrawlerReady(this.deps.config)) return;
    if (!this.registry.get(PLATFORM_DIGEST_TOOL_NAME)) return;
    const args = platformPrefetchArgs(input.job.spec.brief, this.deps.config);
    if (!args) return;

    const before = this.evidence.list(tc.jobId).length;
    try {
      const res = await this.registry.invoke(
        PLATFORM_DIGEST_TOOL_NAME,
        { ...args, tenantId: tc.ctx.tenantId },
        PHASE_AGENT[phase],
        // systemCall：不计入模型的单任务调用上限。实测模型能在 2 分钟内把 8 次额度烧光
        // （每次都是空结果、却各触发一批后台采集），不豁免的话这次补取会被上限挡下，
        // 数据照样进不了报告 —— 那正是本次事故的形态。
        { ...tc, systemCall: true },
      );
      // 覆盖预取那份（预取的是"已排队"的空结果）：下游 attachPlatformEvidences /
      // synthIntel / 机械补齐都从 prefetched 里读 rows，不覆盖等于白补
      prefetched[PLATFORM_DIGEST_TOOL_NAME] = res;
      if (phase === "creator") this.buildCreatorPool(input, tc, prefetched);
      const added = this.evidence.list(tc.jobId).length - before;
      const total = this.evidence.list(tc.jobId).length;
      if (added > 0) {
        console.info(`[agent-pack] ${phase} 补取到 ${added} 条平台证据（预取时后台采集还没落库），证据表共 ${total} 条`);
      } else if (total > 0) {
        /* 「无新增」不等于「没数据」：同一批采集结果在**预取**时就已经登记过一遍。
         * 早先这里一律打「仍为 0 条」，于是日志把"数据早就到了"说成"一直没数据"，
         * 排查时被这句话带偏过。 */
        console.info(`[agent-pack] ${phase} 补取无新增（证据表已有 ${total} 条，同批采集结果在预取时已登记）`);
      } else {
        /* 补取也没拿到（采集未就绪 / 仍在后台排队 / 该平台没有该关键词的结果）。
         * 刻意**只记日志、不写 degradedKeys**：这是数据可用性事实，不是模型产出缺陷，
         * 报告侧会由来源声明与附录如实写明"本次没有条目级平台引用"；
         * 把它塞进 degraded 列表只会让"产出不完整"这个提示变廉价。 */
        console.info(`[agent-pack] ${phase} 补取平台数据仍为 0 条（后台采集未就绪或该关键词无结果）`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      degradedKeys.push(`${PLATFORM_DIGEST_TOOL_NAME}(补取): ${msg}`);
      console.warn(`[agent-pack] ${phase} 补取平台数据失败：${msg}`);
    }
  }

  /**
   * 人选必须能溯源：把无法在真实数据源里对上的候选机械剔除。
   *
   * 起因（业主反馈）：报告里的人选昵称在平台上搜不到 —— 那是 seed 的样例达人。
   * 样例数据已经从读取侧挡掉了（`PricingStore.allowDemo`），但还有第二种"假数据"：
   * **模型自己编的人选**。提示词写了"禁止编造达人"，降级到单次结构化输出时它照样会
   * 给出看着很像真的昵称与粉丝量。判定只认真实数据：
   *   · talentId 命中本次真实报价库候选；或
   *   · （平台 + 昵称）命中本次真实采集到的账号。
   * 剔除不是小事：剔完某一层可能空掉，所以必须再补层（`fillCreatorTiers`），
   * 否则报告的人选页会缺层 —— 那反而是更明显的"数据不全"。
   */
  private enforceRealCreators(
    value: CreatorOutput,
    tc: ToolCallContext,
    prefetched: Record<string, unknown>,
    degradedKeys: string[],
  ): CreatorOutput {
    const realTalentIds =
      (prefetched["pricing_query"] as { candidates?: { talent?: { talentId?: string } }[] } | undefined)?.candidates
        ?.map((c) => c.talent?.talentId)
        .filter((id): id is string => Boolean(id)) ?? [];
    const accounts = aggregatePlatformAccounts(this.evidence.list(tc.jobId));
    const { value: pruned, dropped } = pruneUnverifiableCreators(value, { talentIds: realTalentIds, accounts });

    /* 闸门只做"剔除"是不够的。剔完仍可能一条真实账号都不剩（模型压根没用上游给的
     * 平台账号池，直接写占位），而池子明明躺着几十个真实账号。所以这里必须补上
     * "数据在手就必须进报告"这一步，否则报告的人选页会是一片「暂无人选」。 */
    const pool = (unwrap(prefetched[PLATFORM_CREATOR_KEY]) as { candidates?: CreatorOutput["candidates"] }).candidates ?? [];
    const { value: completed, injected } = ensurePlatformCreators(pruned, pool);
    if (injected > 0) {
      console.info(`[agent-pack] creator：模型未使用平台账号池，机械补入 ${injected} 位真实采集账号（池内共 ${pool.length} 位）`);
    }

    if (dropped.length === 0) return completed;
    degradedKeys.push(
      `creator.candidates：${dropped.length} 位人选无法在真实数据源中溯源（本地报价库无记录、平台采集无此账号），已剔除`,
    );
    tc.emit({
      type: "data.degraded",
      seq: 0,
      at: new Date().toISOString(),
      source: "pricing_query",
      missing: dropped.slice(0, 5).map((d) => `${d.nickname}(${d.talentId})`),
      reason: "untraceable_creator",
    });
    console.warn(`[agent-pack] creator 剔除不可溯源人选 ${dropped.length} 条：${dropped.map((d) => d.nickname).join("、").slice(0, 200)}`);
    return completed;
  }

  /**
   * 条目级引用校验：`IntelOutput.evidences[].entryId` 必须真的在本任务证据表里。
   *
   * 为什么不在 schema 里做：schema 校验是纯函数，拿不到"本 job 登记了哪些条目"。
   * 为什么值得单独做：这是"模型不能编造出处"从**口头约定**变成**机械约束**的那一步。
   */
  private enforceEvidence(value: IntelOutput, tc: ToolCallContext, degradedKeys: string[]): IntelOutput {
    const evidences = value?.evidences;
    if (!evidences || evidences.length === 0) return value;
    const known = this.evidence.entryIds(tc.jobId);
    const kept = evidences.filter((e) => known.has(e.entryId));
    const unknown = evidences.filter((e) => !known.has(e.entryId)).map((e) => e.entryId);
    if (unknown.length === 0) return value;
    degradedKeys.push(
      `intel.evidences：${unknown.length} 条条目级引用未通过校验（entryId 不在本任务证据表内），已摘除`,
    );
    tc.emit({
      type: "data.degraded",
      seq: 0,
      at: new Date().toISOString(),
      source: PLATFORM_DIGEST_TOOL_NAME,
      missing: unknown.slice(0, 5),
      reason: "unverified_entry",
    });
    return { ...value, evidences: kept };
  }

  /**
   * 把本 job 的平台证据集落成 `intel_evidence` 产物。
   *
   * 只在真的有证据时写；用 addIfAbsent 保证重放/崩溃恢复不会产出重复产物。
   * 内存里没有证据（没配 collector、或 brief 声明的平台都没有采集通道）时不写 ——
   * 空产物只会让产物面板多一个"点开是空"的条目。
   */
  private persistEvidence(jobId: string): void {
    const entries = this.evidence.list(jobId);
    if (entries.length === 0) return;
    this.deps.repos.artifacts.addIfAbsent(jobId, "intel_evidence", {
      inline: { entries, truncated: this.evidence.truncatedCount(jobId), asOf: new Date().toISOString() },
    });
  }

  /**
   * 把 `intel_evidence` 产物回灌进进程内的证据表（幂等；已有则不读库）。
   *
   * 为什么必须有：证据表是**进程内**的（见 evidence.ts 的存储形态说明），而
   * 「重算 report」「崩溃恢复后续跑」都发生在新进程里 —— 不回灌的话，
   * 附录会退化成"本次没有任何平台条目"，报告读起来像"平台采集根本没跑"，
   * 而实际上证据就躺在产物里。这属于"数据取到了却被自己的进程边界丢掉"。
   */
  private ensureEvidenceLoaded(jobId: string): void {
    if (this.evidence.list(jobId).length > 0) return;
    const art = this.deps.repos.artifacts.list(jobId).find((a) => a.kind === "intel_evidence");
    const entries = (art?.inline as { entries?: EvidenceEntry[] } | undefined)?.entries;
    if (entries && entries.length > 0) this.evidence.record(jobId, entries);
  }

  /**
   * 本次真实可用的数据源目录（台账源 ∪ 本地 KB 语料源 ∪ 内部数据仓）。
   *
   * 这是「来源必须可溯源」的单一事实源：提示词里注入它、RG 产出后自校验用它、
   * 渲染期兜底校验也用它。放在 governance 组装（render 不允许查库）。
   *
   * `jobId` 给定时同时带上**本 job 登记的平台证据条目**（R13 条目级校验的依据）。
   * 不给则不带该字段 = 不校验条目级引用（装配期的不变量检查就是这种调用）。
   */
  sourceCatalog(ctx: TenantContext, jobId?: string): SourceCatalog {
    return buildSourceCatalog({
      repos: this.deps.repos,
      tenantId: ctx.tenantId,
      knowledgeSourceIds: this.deps.knowledge.sourceIds(ctx.tenantId).map((x) => x.sourceId),
      chunkIds: this.deps.knowledge.chunkIds(ctx.tenantId),
      // 只列**真正装配了适配器**的源：台账登记与能力就绪是两件事，
      // 平台采集源会先登记、但适配器要过许可确认才装配（见 media-crawler.ts）。
      availableSourceIds: this.deps.datasources.list().map((a) => a.sourceId),
      ...(jobId ? { evidenceEntries: this.evidence.list(jobId) } : {}),
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
        /* 平台内公开内容预采集（可选能力）。**为什么必须在这里预取、而不能等 CI 现调**：
         *   平台采集是分钟级的（起 Playwright 子进程），首次调用只会返回 0 条并在后台排队，
         *   要到**下一次**调用才命中缓存。若由 CI 在工具循环里现调，报告往往在数据到货前
         *   就生成了 —— 平台数据等于白接（这是接进来之后暴露的最大断点）。
         *   这里与 web_search 同构地先投递一轮：本次仍是 0 条，但"稍后重试"有东西可拿。
         * 前置四重，缺一即跳过：
         *   ① 三道门（enabled + 许可确认 + collector 地址）—— 没有能力时发起会因 E-GOV-004 误标降级；
         *   ② 非 mock —— 保证 E2E 用例全离线、不发任何外部请求；
         *   ③ 聚合工具已装配 —— 七个平台全都没开时它不注册，不该照样投递；
         *   ④ 至少有一个可采平台 —— brief 声明的平台一个都没装配时 platformPrefetchArgs 返回 null。
         * 一次 `platform_digest` 覆盖**brief 声明的平台**（默认 `BM_MC_PREFETCH_SCOPE=brief`；
         * 显式设为 `all` 才覆盖全部已装配平台），而不是逐平台循环七次：
         *   合并、可比指标计算、逐源过闸门都在工具内部确定性完成，预取只负责把请求递进去。
         * 只投递、不等待：拿到的是"已排队"的空结果，这正是预期形态。 */
        if (mediaCrawlerReady(this.deps.config) && !this.deps.gateway.mocked && this.registry.get(PLATFORM_DIGEST_TOOL_NAME)) {
          const args = platformPrefetchArgs(brief, this.deps.config);
          if (args) await run(PLATFORM_DIGEST_TOOL_NAME, PLATFORM_DIGEST_TOOL_NAME, args);
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

        /* 真实采集账号 → 候选人池。
         *
         * 业主的要求是「本地那些假数据不要参考，我要真实数据」。本地报价库在默认配置下
         * 已经不返回演示样例（见 PricingStore 的 allowDemo 过滤），于是这里把
         * **本任务真实采集回来的平台账号**作为真实人选池交下去：
         * 账号真实存在、名下条目可点回原帖；没有的字段（粉丝量/报价）如实留空。
         * 不做"接着编"——报告宁可写"无样本"，也不要给出搜不到的人。
         *
         * 证据表为空时先补取一次：intel 用的是预取那一刻的空结果，而采集通常在
         * 几分钟后才落库；不补的话这里拿到的永远是空池（实测产出了 `待确认头部达人`
         * 这类占位人选）。补取的代价是一次本地查询（同参数采集会被侧车去重）。 */
        if (aggregatePlatformAccounts(this.evidence.list(tc.jobId)).length === 0) {
          await this.refreshPlatformData(phase, input, tc, out, degradedKeys);
        }
        this.buildCreatorPool(input, tc, out);
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
        /* 报价查询只对**有真实报价样本**的人选发起。
         *
         * 旧实现写死 `?? "t_1001"`：那是 seed 的演示达人 ID —— 一旦人选为空，
         * 预算阶段就会去查一位样例达人的报价，并把结果当成本次人选的成本依据。
         * 现在没有真候选人就不查，报告相应地在成本项写"无样本"（`estimate` 缺省即降级）。 */
        const firstRealTalent = (input.upstream.creator as CreatorOutput | undefined)?.candidates?.find(
          (c) => !c.talentId.startsWith("none_") && !c.talentId.startsWith("pfcre_"),
        );
        if (firstRealTalent) await run("pricing_query", "pricing_query", { talentId: firstRealTalent.talentId });
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
        out["source_catalog"] = this.sourceCatalog(tc.ctx, tc.jobId);
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

  /**
   * 阶段执行入口：只做一件事 —— 建一个流式合帧器（`DeltaPump`），并保证收尾时把尾巴吐出去。
   *
   * 为什么合帧器要包住**所有**策略，而不是只在 Pi 路径里：三条路径都可能产出 token，
   * 而"这一次走哪条"取决于端点的脾气。把它放在策略之外，才能保证
   * 「换端点 / 换路径」不影响"界面上有没有流式输出"这件事 —— 这正是之前的缺陷：
   * 只有 Pi 路径发 `agent.delta`，而当前端点下几乎每个阶段都降级到 json-direct，
   * 于是用户看到的是一个从头到尾不动的界面。
   */
  private async runStrategies(
    phase: PhaseName,
    input: PhaseRunInput,
    tc: ToolCallContext,
    prefetched: Record<string, unknown>,
    degradedKeys: string[],
  ): Promise<StrategyOutcome> {
    const agent = PHASE_AGENT[phase];
    const pump = new DeltaPump((delta) =>
      input.emit({
        type: "agent.delta",
        seq: 0,
        at: new Date().toISOString(),
        agent,
        kind: "text",
        delta,
      }),
    );
    try {
      return await this.runStrategiesInner(phase, input, tc, prefetched, degradedKeys, pump);
    } finally {
      // 尾巴必须吐出去：否则最后不足一帧的正文（可能是结论段）会凭空消失
      pump.flush();
    }
  }

  private async runStrategiesInner(
    phase: PhaseName,
    input: PhaseRunInput,
    tc: ToolCallContext,
    prefetched: Record<string, unknown>,
    degradedKeys: string[],
    pump: DeltaPump,
  ): Promise<StrategyOutcome> {
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
    const pi = await this.tryPiAgent(phase, agent, input, tc, prompt, usableTools, pump);

    /* 终稿之前补取一次平台数据。
     *
     * Pi 循环跑了十几分钟（实测 intel 11 分钟），期间后台采集往往已经落库；
     * 而接下去无论走哪条路，**只有这一次机会**把数据捞回来：
     *   · Pi 成功 → 后面的机械补齐（attachPlatformEvidences）要用到 rows；
     *   · Pi 失败 → 降级到单次结构化输出，那条路径压根不调工具（这是业主看到的
     *     "数据到了、报告还是没引用"的直接成因）。
     * 放在这里而不是每个分支里各写一次，是为了防止"将来新增第四条路径时漏掉"。 */
    await this.refreshPlatformData(phase, input, tc, prefetched, degradedKeys);

    if (pi.ok) {
      if (phase !== "report") return pi;
      const refined = await this.finalizeReport(tc, prompt, pi.value as ReportDsl, degradedKeys, pump, creatorsOf(input), input.job.spec.brief.ownBrandId);
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
      // 降级路径同样要有流式回显：这是用户实际看到的唯一"模型在工作"的证据
      onDelta: (d: StreamDelta) => pump.push(d.delta),
    });
    if (direct.ok) {
      let value: unknown = direct.value;
      let note = `结构化输出通过（重试 ${direct.retries} 次）`;
      if (phase === "report") {
        const refined = await this.finalizeReport(tc, prompt, value as ReportDsl, degradedKeys, pump, creatorsOf(input), input.job.spec.brief.ownBrandId);
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
    pump?: DeltaPump,
    creators?: CreatorOutput,
    /** 本轮是否指定了自有品牌 —— R14（未指定时不得出现「我方」口径）需要它 */
    ownBrandId?: string,
  ): Promise<{ value: ReportDsl; note?: string }> {
    const policy = this.depthPolicy();
    const catalog = this.sourceCatalog(tc.ctx, tc.jobId);
    const hasOwnBrand = Boolean((ownBrandId ?? "").trim());
    const enriched = this.enrichProvenance(tc, value, catalog, creators);
    const first = validateReportDsl(enriched, { catalog, minTraceableRatio: policy.minTraceableRatio, hasOwnBrand });
    // 只有「不可机械修复」的 error 才值得回喂；可修复项交给渲染期 autoRepair 降级处理
    const blocking = first.issues.filter((i) => i.level === "error" && !i.repairable);
    const depth = measureReportDepth(enriched, policy);

    if (blocking.length === 0 && depth.gaps.length === 0) return { value: enriched };

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
      // 回喂修复是**又一次整份报告生成**（report 阶段最慢的一段），同样要有流式回显
      onDelta: pump ? (d: StreamDelta) => pump.push(d.delta) : undefined,
    });

    const markDegraded = (dsl: ReportDsl, reason: string, missing: string[]): ReportDsl => ({
      ...dsl,
      meta: { ...dsl.meta, degraded: { reason, missingSections: missing } },
    });

    if (repaired.ok) {
      // 回喂得到的是一份**全新的**模型输出：机械补齐必须再走一遍，否则修好的报告反而丢了溯源
      const v2 = this.enrichProvenance(tc, repaired.value as ReportDsl, catalog, creators);
      const stillBlocking = validateReportDsl(v2, { catalog, minTraceableRatio: policy.minTraceableRatio, hasOwnBrand }).issues.filter(
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
      value: markDegraded(enriched, `报告未达深度下限且回喂修复失败（${repaired.code}）`, depth.gaps),
      note: `回喂修复失败（${repaired.code}），保留原始输出并如实标注降级`,
    };
  }

  /**
   * 机械补齐报告里的平台溯源与**人选来源**（模型路径专用；合成路径由 `synthReport` 覆盖）。
   *
   * 为什么不能只靠提示词：报告 DSL 由模型生成，实测它会整份报告一条 `platform_entry`
   * 都不写（该字段可选、且模型倾向只写"模型推断"），于是出现最尴尬的一种结果 ——
   * 数据其实取回来了（证据表里有几十条真实平台内容），报告读起来却像"没接平台"：
   * 来源表只有报价库、附录写着"本次报告没有条目级平台引用"。
   *
   * 同理，**人选名单的来源也必须机械标注**：人选来自本地达人报价库（只有昵称、没有
   * 平台账号 ID），不标的话读者会拿昵称去平台上搜，搜不到就怀疑整份报告的数据是编的。
   * 实现见 synthesis.ts 的 `enrichReportProvenance`（纯函数，可被确定性测试钉住）。
   */
  private enrichProvenance(
    tc: ToolCallContext,
    dsl: ReportDsl,
    catalog: SourceCatalog,
    creators?: CreatorOutput,
  ): ReportDsl {
    return enrichReportProvenance(dsl, this.evidence.list(tc.jobId), catalog, { creators });
  }

  private async tryPiAgent(
    phase: PhaseName,
    agentCode: AgentCode,
    input: PhaseRunInput,
    tc: ToolCallContext,
    prompt: string,
    usableTools: string[],
    pump?: DeltaPump,
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

    // 反「工具调用风暴」闸门（见 createToolCallGuard 注释）：按阶段重置，不跨阶段累加
    const guard = createToolCallGuard(usableTools);

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
          const call = ctx as { toolCall?: { name?: string }; args?: unknown };
          return guard.attempt(call.toolCall?.name ?? "", call.args);
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
          if (pump) pump.push(ev.delta);
          else
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

    /* 阶段预算必须 ≥ 单次请求超时（见 PHASE_TIMEOUT_MS 注释）：自建端点冷启动时，
     * 请求会长时间"连上但不吐 token"，阶段若先于请求超时把自己 abort 掉，
     * 就会卡在 0% 且不降级。让预算跟着 BM_LLM_TIMEOUT_MS 走 —— 调整超时只需改这一处。 */
    const budget = Math.max(PHASE_TIMEOUT_MS[phase], this.deps.config.llm.timeoutMs + PHASE_TIMEOUT_SLACK_MS);
    const timer = setTimeout(() => agent.abort(), budget);
    timer.unref?.();

    // 硬杀兜底：abort() 只是个请求，不保证 waitForIdle 会返回
    // （实测端点挂死时，流未关闭则 idle 永远不来）。超过预算 5s 仍未结束就放弃等待，
    // 让这个阶段走降级路径，而不是把整个任务拖死。
    const HARD_KILL_GRACE_MS = 5_000;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
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
      /* 真实采集账号单独提前一段：它是 CT 阶段人选的**唯一合法来源**。
       * 放在通用数据块里有两个问题：① 它在键序末尾，一旦 contextBlock 截断就整段丢掉；
       * ② 混在工具返回里，模型容易把"参考"当"建议"，转头又编一位达人出来。
       * 明确写成"只能从这里选"，配合产出的机械剔除（enforceRealCreators）才闭环。 */
      ...(phase === "creator" && prefetched[PLATFORM_CREATOR_KEY]
        ? [
            `【本任务真实采集到的平台账号（人选的唯一合法来源）】\n${contextBlock(prefetched[PLATFORM_CREATOR_KEY], 8_000)}\n` +
              `规则：candidates 只能从上面这些账号里选（talentId 必须原样照抄）；` +
              `粉丝量与报价**未采集**，必须写 0 并在 rationale 里说明"未采集、无样本"，禁止填任何数字；` +
              `模型自己编出来的达人会被机械剔除（这不是建议，是校验）。`,
          ]
        : []),
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

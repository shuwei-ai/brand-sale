/**
 * M14 ModelGateway（对应 LLD §2.15）
 *
 * 职责：
 *   分级路由（strong/medium/light）、并发控制、重试、成本核算、缓存、结构化输出重试。
 *
 * 两条硬约束：
 *   1. **并发只在这一层控制**。数据源限流在 M10，任务并发预算在 M12，互不干涉
 *      （LLD §7.3 集成用例「限流不打架」）。
 *   2. **用量以 (jobId, phase, attempt, callId) 幂等落库**。崩溃重放后不重复扣费
 *      （E2E 用例 5）。
 */

import type { Money, PhaseName, TokenUsage } from "@brandsale/contracts";
import type { Config } from "@brandsale/config";
import type { Repositories } from "@brandsale/storage";
import { ChatMessage, LlmHttpError, OpenAiCompatibleClient, type StreamDelta } from "./client.ts";
import { computeCost } from "./cost.ts";
import { Semaphore } from "./semaphore.ts";

export type ModelTier = "strong" | "medium" | "light";

export interface CompleteRequest {
  tier: ModelTier;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  jobId: string;
  phase: PhaseName;
  /** 阶段尝试次数，参与用量幂等键 */
  attempt: number;
  /** 单次调用唯一 id，参与用量幂等键；默认由 (jobId,phase,attempt,序号) 生成 */
  callId: string;
  signal?: AbortSignal;
  /** 流式增量回调；提供时走流式通道 */
  onDelta?: (d: StreamDelta) => void;
}

export interface CompleteResult {
  text: string;
  usage: TokenUsage;
  cost: Money;
  model: string;
  mocked: boolean;
  latencyMs: number;
  /** 用量是否被幂等去重（重放场景为 true，不再计费） */
  deduped: boolean;
}

export interface JsonCompleteRequest<T> {
  tier: ModelTier;
  system?: string;
  prompt: string;
  /**
   * 输出 token 上限，不传用网关默认值。
   * 坑：报告类大 JSON（≈25KB DSL）在默认 4096 下必然被截断（finish_reason=length），
   * 三次重试全部解析失败后误报"模型不可用"。大输出阶段必须显式放大。
   */
  maxTokens?: number;
  /** 输出结构名，用于错误定位与 mock 分发 */
  schemaName: string;
  /** 解析 + 校验：返回 null 或抛出表示不合规 */
  parse: (raw: string) => T;
  /** 校验失败时回喂给模型的纠错提示 */
  repairHint?: (errors: string[]) => string;
  jobId: string;
  phase: PhaseName;
  attempt: number;
  callId: string;
  signal?: AbortSignal;
  onDelta?: (d: StreamDelta) => void;
}

export type JsonCompleteResult<T> =
  | { ok: true; value: T; raw: string; usage: TokenUsage; cost: Money; model: string; mocked: boolean; retries: number }
  | { ok: false; code: "E-AGENT-001" | "E-AGENT-002"; errors: string[]; raw: string; usage: TokenUsage; cost: Money; model: string };

type MockResponder = (prompt: string) => string;

export class ModelGateway {
  private readonly client: OpenAiCompatibleClient;
  private readonly semaphore: Semaphore;
  private readonly mockResponders = new Map<string, MockResponder>();
  private readonly cache = new Map<string, CompleteResult>();

  /**
   * 熔断状态。
   *
   * 为什么必须有：真实端点在"能连上但不吐 token"时（vLLM 排队、后端 worker 挂死、
   * 网络中间设备静默丢包），每次调用都要等到 timeoutMs 才失败。一次任务 6 个阶段，
   * 每阶段 3 次重试 × 3 分钟 = 54 分钟才走完降级路径 —— 用户看到的是一个卡死的系统，
   * 而不是一份"数据降级但结论可用"的报告。
   *
   * 熔断把「端点级失败」的代价从 O(阶段数 × 超时 × 重试) 压到 O(超时 × 阈值)。
   */
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private breakerTripCount = 0;

  constructor(
    private readonly config: Config,
    private readonly repos: Repositories,
  ) {
    this.client = new OpenAiCompatibleClient(config.llm.baseUrl, config.llm.apiKey, {
      timeoutMs: config.llm.timeoutMs,
      maxRetries: config.llm.maxRetries,
      maxOutputTokens: config.llm.maxOutputTokens,
      disableThinking: config.llm.disableThinking,
    });
    this.semaphore = new Semaphore(config.llm.concurrency);
  }

  get mocked(): boolean {
    return this.config.llm.mode === "mock";
  }

  /* ── 供绕过 complete() 的直连路径（Pi StreamFn）使用 ──
   * Pi 循环不经过 complete()，若不上报成败，熔断器对它就是瞎的：
   * 端点病态时每个阶段照样先烧满 Pi 超时预算再降级。 */

  /** 熔断打开则抛错（快速失败），关闭则静默返回 */
  checkBreaker(): void {
    this.assertBreakerClosed();
  }

  noteLlmSuccess(): void {
    this.recordSuccess();
  }

  /** endpointLevel：失败是否属于「端点不可用」类（超时/连接/5xx）。调用方自行判定 */
  noteLlmFailure(e: unknown, endpointLevel: boolean): void {
    if (!endpointLevel) return;
    this.recordFailure(e ?? new Error("unknown llm failure"));
  }

  /** 熔断器当前状态（供 /health 与演示脚本观测） */
  breakerState(): { open: boolean; consecutiveFailures: number; reopenInMs: number; trips: number } {
    const left = this.breakerOpenUntil - Date.now();
    return {
      open: left > 0,
      consecutiveFailures: this.consecutiveFailures,
      reopenInMs: left > 0 ? left : 0,
      trips: this.breakerTripCount,
    };
  }

  private assertBreakerClosed(): void {
    const left = this.breakerOpenUntil - Date.now();
    if (left <= 0) return;
    throw new LlmHttpError(
      `模型端点处于熔断状态，${Math.ceil(left / 1000)}s 后自动探测。本次调用快速失败，由调用方走确定性降级路径。`,
      null,
      false,
      undefined,
      "network",
    );
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
  }

  /** 只对「端点级失败」计数：超时 / 连接失败 / 5xx。4xx（鉴权、参数）不算端点不可用 */
  private recordFailure(e: unknown): void {
    const endpointLevel =
      e instanceof LlmHttpError
        ? e.kind === "timeout" || e.kind === "network" || (e.status !== null && e.status >= 500)
        : false;
    if (!endpointLevel) return;

    this.consecutiveFailures += 1;
    const threshold = this.config.llm.breakerThreshold;
    if (threshold > 0 && this.consecutiveFailures >= threshold) {
      this.breakerOpenUntil = Date.now() + this.config.llm.breakerCooldownMs;
      this.breakerTripCount += 1;
      this.consecutiveFailures = 0;
    }
  }

  /** 注册结构化输出的离线桩（由 M9 在装配时注入其 Schema 的 mock 生成器） */
  registerMock(schemaName: string, responder: MockResponder): void {
    this.mockResponders.set(schemaName, responder);
  }

  modelFor(tier: ModelTier): string {
    return this.config.llm.models[tier];
  }

  async health(): Promise<{ ok: boolean; models: string[]; error?: string; breaker?: ReturnType<ModelGateway["breakerState"]> }> {
    const breaker = this.breakerState();
    if (this.mocked) return { ok: true, models: [this.modelFor("medium")], error: "mock 模式", breaker };
    const h = await this.client.health();
    return { ...h, breaker };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const model = this.modelFor(req.tier);
    const started = Date.now();

    if (this.mocked) {
      const text = this.mockText(req);
      return this.settle(req, {
        text,
        usage: { inputTokens: 128, outputTokens: Math.ceil(text.length / 1.5), cachedInputTokens: 0, calls: 1 },
        model: `${model}#mock`,
        mocked: true,
        latencyMs: Date.now() - started,
      });
    }

    this.assertBreakerClosed();

    const release = await this.semaphore.acquire(req.signal);
    try {
      const messages: ChatMessage[] = [
        ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
        ...req.messages,
      ];

      let text = "";
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 1 };

      if (req.onDelta) {
        for await (const delta of this.client.stream(
          { model, messages, maxTokens: req.maxTokens, temperature: req.temperature },
          req.signal,
        )) {
          if (delta.type === "text") {
            text += delta.delta;
            req.onDelta(delta);
          }
        }
        // 流式响应没有 usage，用估算值，避免成本核算失真过大
        usage = {
          inputTokens: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 1.5),
          outputTokens: Math.ceil(text.length / 1.5),
          cachedInputTokens: 0,
          calls: 1,
        };
      } else {
        const res = await this.client.chat(
          { model, messages, maxTokens: req.maxTokens, temperature: req.temperature },
          req.signal,
        );
        text = res.text;
        usage = { ...res.usage, calls: 1 };
      }

      this.recordSuccess();
      return this.settle(req, { text, usage, model, mocked: false, latencyMs: Date.now() - started });
    } catch (e) {
      this.recordFailure(e);
      throw e;
    } finally {
      release();
    }
  }

  /**
   * 结构化输出：最多重试 2 次（把校验错误回喂）。
   * 仍失败 → E-AGENT-001，该阶段标 partial，下游继续（LLD §2.10 失败模式）。
   */
  async completeJson<T>(req: JsonCompleteRequest<T>): Promise<JsonCompleteResult<T>> {
    const maxRetries = 2;
    let lastRaw = "";
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
    let totalCost: Money = { currency: "CNY", amount: 0 };
    let model = this.modelFor(req.tier);
    let mocked = false;
    let lastErrors: string[] = [];

    for (let i = 0; i <= maxRetries; i++) {
      const callId = i === 0 ? req.callId : `${req.callId}#retry${i}`;
      const prompt =
        i === 0
          ? req.prompt
          : `${req.prompt}\n\n【上一次输出未通过校验，请修正后重新输出】\n校验错误：\n${lastErrors
              .map((e) => `- ${e}`)
              .join("\n")}\n${req.repairHint?.(lastErrors) ?? ""}`;

      // 重放安全：mock/缓存在重试路径上不参与，保证行为可预测
      let res: CompleteResult;
      try {
        res = await this.complete({
          tier: req.tier,
          system: req.system,
          messages: [{ role: "user", content: prompt }],
          maxTokens: req.maxTokens,
          jobId: req.jobId,
          phase: req.phase,
          attempt: req.attempt,
          callId,
          signal: req.signal,
          onDelta: req.onDelta,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 端到端超时 → E-AGENT-002
        return {
          ok: false,
          code: "E-AGENT-002",
          errors: [`模型调用失败：${msg}`],
          raw: lastRaw,
          usage: totalUsage,
          cost: totalCost,
          model,
        };
      }

      totalUsage = {
        inputTokens: totalUsage.inputTokens + res.usage.inputTokens,
        outputTokens: totalUsage.outputTokens + res.usage.outputTokens,
        cachedInputTokens: totalUsage.cachedInputTokens + res.usage.cachedInputTokens,
        calls: totalUsage.calls + 1,
      };
      totalCost = { currency: "CNY", amount: totalCost.amount + res.cost.amount };
      model = res.model;
      mocked = res.mocked;
      lastRaw = res.text;

      const jsonText = extractJson(res.text);
      try {
        const value = req.parse(jsonText);
        return { ok: true, value, raw: jsonText, usage: totalUsage, cost: totalCost, model, mocked, retries: i };
      } catch (e) {
        lastErrors = e instanceof Error ? [e.message] : [String(e)];
      }
    }

    return {
      ok: false,
      code: "E-AGENT-001",
      errors: lastErrors,
      raw: lastRaw,
      usage: totalUsage,
      cost: totalCost,
      model,
    };
  }

  /* ── 内部 ─────────────────────────────────────────────── */

  private settle(
    req: CompleteRequest,
    partial: { text: string; usage: TokenUsage; model: string; mocked: boolean; latencyMs: number },
  ): CompleteResult {
    const cost = computeCost(partial.usage, {
      inputPer1k: this.config.llm.priceInputPer1k,
      outputPer1k: this.config.llm.priceOutputPer1k,
    });
    const deduped = !this.repos.usage.record({
      jobId: req.jobId,
      phase: req.phase,
      attempt: req.attempt,
      callId: req.callId,
      model: partial.model,
      tokens: partial.usage,
      cost,
    });
    return { ...partial, cost, deduped };
  }

  private mockText(req: CompleteRequest): string {
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    // 尝试按已注册的 schema 桩回应：「schemaName=XXX」约定由 M9 拼进 prompt
    const m = /schemaName=([A-Za-z]+)/.exec(last);
    if (m) {
      const responder = this.mockResponders.get(m[1]);
      if (responder) return responder(last);
    }
    return `[mock] 已收到请求（${req.phase}）：${last.slice(0, 120)}`;
  }

  /** 仅测试用 */
  clearCache(): void {
    this.cache.clear();
  }

  get concurrency(): { available: number; pending: number } {
    return { available: this.semaphore.available, pending: this.semaphore.pending };
  }
}

/** 从模型输出中抽出 JSON（容忍 ```json 包裹与前后废话） */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return candidate.trim();
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return candidate.slice(start).trim();
}

export { LlmHttpError, type StreamDelta } from "./client.ts";

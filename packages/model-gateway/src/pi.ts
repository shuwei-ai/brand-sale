/**
 * Pi 框架接入点（pi-ai / pi-agent-core）
 *
 * 这里把自建 vLLM 端点包装成 Pi 的 `Model<"openai-completions">` + `StreamFn`，
 * 于是 pi-agent-core 的 `Agent`（Agent 循环、工具调用、beforeToolCall 钩子）
 * 可以直接跑在我们的端点上，不需要经过任何 Pi 之外的抽象。
 *
 * 这是 LLD §3.5「Pi 扩展、工具与 Agent 装配」的真实接触面。
 */

import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Config } from "@brandsale/config";
import { ModelGateway, type ModelTier } from "./gateway.ts";

export type PiModel = Model<"openai-completions">;

/**
 * 构造指向自建端点的 Pi 模型。
 * `compat` 显式声明为 vLLM 友好档：不发 `store`、不用 `developer` 角色、
 * 思维链走 `chat_template_kwargs`（qwen3 系）。
 */
export function createVllmModel(config: Config, tier: ModelTier = "medium"): PiModel {
  return {
    id: config.llm.models[tier],
    name: `${config.llm.models[tier]} (self-hosted vLLM)`,
    api: "openai-completions",
    provider: "brandsale-vllm",
    baseUrl: config.llm.baseUrl,
    input: ["text"],
    reasoning: false,
    contextWindow: 1_179_648,
    maxTokens: config.llm.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      supportsStrictMode: false,
      supportsMidConvoSystemMessages: false,
    },
  };
}

/**
 * 供 `Agent` 使用的 StreamFn。
 *
 * 说明：pi-ai 的 `streamSimple` 满足 pi-agent-core 的 `StreamFn` 形状，
 * 默认直接用它；此处包一层是为了把我们的 apiKey / 超时 / 并发闸门注入进去，
 * 并保证**不重试**（重试由 M14 的 retry 策略统一负责，避免两处叠加）。
 */
export async function loadPiStreamFn(config: Config) {
  const mod = await import("@earendil-works/pi-ai/api/openai-completions");
  const streamSimple = mod.streamSimple;
  return ((model: PiModel, context: unknown, options?: SimpleStreamOptions) =>
    streamSimple(model, context as never, {
      apiKey: config.llm.apiKey,
      timeoutMs: config.llm.timeoutMs,
      maxRetries: 0,
      ...options,
      onPayload: (payload) => {
        // qwen3 系 + vLLM：不显式关思维链的话，模型会把 max_tokens 全部烧在
        // 推理上，正文一个字都出不来（表现为 assistant 消息只有 thinking 块）。
        // pi-ai 不认识 vLLM 的 chat_template_kwargs，所以借 onPayload 钩子注入。
        // 与 M14 直连路径的 BM_LLM_DISABLE_THINKING 行为保持一致。
        if (!config.llm.disableThinking) return undefined;
        const params = payload as { chat_template_kwargs?: Record<string, unknown> };
        return {
          ...params,
          chat_template_kwargs: { ...(params.chat_template_kwargs ?? {}), enable_thinking: false },
        };
      },
    })) as unknown as import("@earendil-works/pi-agent-core").StreamFn;
}

/** 模型网关的并发/成本快照，供健康检查与压测使用 */
export function gatewaySnapshot(gateway: ModelGateway) {
  return { concurrency: gateway.concurrency, mocked: gateway.mocked, model: gateway.modelFor("medium") };
}

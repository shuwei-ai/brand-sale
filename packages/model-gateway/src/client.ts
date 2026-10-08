/**
 * OpenAI 兼容 Chat Completions 客户端。
 *
 * 面向的是自建 vLLM 端点（如 http://…:8000/v1），因此：
 * - 复用 `/v1/models` 做健康探测（不消耗生成配额）；
 * - 支持 `chat_template_kwargs.enable_thinking`（qwen3 系可显著降延迟）；
 * - 兼容 `content` 为字符串或分块数组两种返回形态。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** 关闭思维链（qwen3 系） */
  disableThinking?: boolean;
  /** 要求模型输出严格 JSON */
  jsonMode?: boolean;
  stop?: string[];
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  model: string;
  finishReason?: string;
  /** 请求 id，vLLM 会返回，用于幂等扣费 */
  requestId?: string;
}

export interface StreamDelta {
  type: "text" | "done";
  delta: string;
}

export type LlmFailureKind = "timeout" | "network" | "http" | "aborted";

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly body?: string,
    /** 失败类别：熔断器据此判断"端点整体不可用"还是"这一次请求运气不好" */
    readonly kind: LlmFailureKind = "http",
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

const normalizeContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        return "";
      })
      .join("");
  }
  return "";
};

const isRetryableStatus = (s: number): boolean => s === 408 || s === 409 || s === 429 || s >= 500;

export class OpenAiCompatibleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaults: { timeoutMs: number; maxRetries: number; maxOutputTokens: number; disableThinking: boolean },
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? this.defaults.maxOutputTokens,
      stream,
      temperature: req.temperature ?? 0.3,
    };
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stop?.length) body.stop = req.stop;
    const disableThinking = req.disableThinking ?? this.defaults.disableThinking;
    if (disableThinking) {
      // vLLM + qwen3 系模板参数；不支持的服务端会忽略未知字段
      body.chat_template_kwargs = { enable_thinking: false };
    }
    if (req.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    return body;
  }

  /** 健康探测：只读 /models，不触发生成 */
  async health(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    try {
      const res = await fetch(this.url("/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(Math.min(this.defaults.timeoutMs, 10_000)),
      });
      if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
      const json = (await res.json()) as { data?: { id?: string }[] };
      return { ok: true, models: (json.data ?? []).map((m) => m.id ?? "").filter(Boolean) };
    } catch (e) {
      return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    return this.withRetry(async () => {
      const res = await this.fetchOnce(req, false, signal);
      const json = (await res.json()) as {
        id?: string;
        model?: string;
        choices?: { message?: { content?: unknown }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      const choice = json.choices?.[0];
      return {
        text: normalizeContent(choice?.message?.content),
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        model: json.model ?? req.model,
        finishReason: choice?.finish_reason,
        requestId: json.id,
      };
    });
  }

  /**
   * 流式调用。超时语义与 chat() 不同：
   *   - chat() 是**总时长**上限（一次问答就该在 timeout 内给结果）；
   *   - stream() 是**空闲**上限（两次 chunk 之间的最大间隔）。
   * 原因：长生成（4096 tokens）流式耗时超过 timeoutMs 是正常的，
   * 但"头已到、体一个字节都不来"是端点病态（vLLM 排队打满 / worker 挂死）；
   * 若不加空闲超时，reader.read() 会永远挂起，把整个任务卡死。
   */
  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamDelta> {
    const res = await this.fetchOnce(req, true, signal);
    if (!res.body) throw new LlmHttpError("流式响应无 body", null, true);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void reader.cancel(
          new LlmHttpError(
            `流式响应空闲超过 ${this.defaults.timeoutMs}ms（端点已连上但不再吐 token）`,
            null,
            false,
            undefined,
            "timeout",
          ),
        ).catch(() => undefined);
      }, this.defaults.timeoutMs);
      idleTimer.unref?.();
    };
    armIdle();

    try {
      while (true) {
        const { done, value } = await reader.read();
        armIdle(); // 收到数据就重置空闲计时
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            yield { type: "done", delta: "" };
            return;
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: { delta?: { content?: unknown } }[];
            };
            const delta = normalizeContent(json.choices?.[0]?.delta?.content);
            if (delta) yield { type: "text", delta };
          } catch {
            // 忽略半包 JSON
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.releaseLock();
    }
    yield { type: "done", delta: "" };
  }

  private async fetchOnce(req: ChatRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.defaults.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(req, stream)),
        signal: composed,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const callerAborted = signal?.aborted ?? false;
      if (callerAborted) {
        throw new LlmHttpError(`调用方取消：${msg}`, null, false, undefined, "aborted");
      }
      // 超时由我们自己的 AbortSignal.timeout 触发。
      // 它**不可重试**：端点已经证明"在这段时间内一句话都吐不出来"，
      // 再重试 maxRetries 次只是把等待时间乘以 (maxRetries+1)，
      // 让一次任务从 3 分钟变成 9 分钟，比失败本身更伤。
      if (timeout.aborted) {
        throw new LlmHttpError(
          `模型请求超时（${this.defaults.timeoutMs}ms 内无任何响应）`,
          null,
          false,
          undefined,
          "timeout",
        );
      }
      throw new LlmHttpError(`请求失败: ${msg}`, null, true, undefined, "network");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const kind: LlmFailureKind = res.status === 401 || res.status === 403 ? "http" : "http";
      throw new LlmHttpError(`模型服务返回 ${res.status}: ${body.slice(0, 400)}`, res.status, isRetryableStatus(res.status), body, kind);
    }
    return res;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.defaults.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const retryable = !(e instanceof LlmHttpError) || e.retryable;
        if (!retryable || attempt === this.defaults.maxRetries) break;
        const base = 400 * 2 ** attempt;
        const jitter = Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, base + jitter));
      }
    }
    throw lastErr;
  }
}

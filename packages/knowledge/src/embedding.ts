/**
 * EmbeddingProvider —— 检索语义通道的可插拔向量来源（P2）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它解决什么问题
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 检索链路是 `BM25 ⊕ 语义(向量) ──RRF──▶ 候选池 ──重排──▶ Top-K`。
 * 其中"语义"这一路原先写死为 `hashEmbed()`（256 维字符 n-gram 哈希）——
 * 它不依赖任何服务、行为确定，但**本质是词袋：没有语义**。
 *
 * 本文件把"向量从哪来"抽成接口，于是换模型不动检索逻辑：
 *   · `HashEmbeddingProvider`   —— 现有哈希实现，**默认与兜底**，行为与历史完全一致；
 *   · `HttpEmbeddingProvider`   —— 打 OpenAI 兼容的 `/v1/embeddings`
 *     （EmbeddingGemma 2 / bge-m3 / Ollama / llama.cpp server / TEI 都原生支持）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条改动前必须知道的纪律（每条都对应一类**静默失败**）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **查询与文档必须用不同的任务前缀**。EmbeddingGemma 系列是 task-steered 的：
 *        查询 → `task: search result | query: {q}`
 *        文档 → `title: {t} | text: {c}`
 *    省略"仍能工作，但精度下降"——静默劣化。这里由 `input_type` 区分，
 *    由嵌入服务按类型注入前缀，**调用方必须显式传 inputType**（下面 embed 的
 *    第二参数不是可选装饰，默认值只是给"确实分不清"的旧调用点兜底）。
 *
 * 2. **维度不一致必须立刻失败**。256 维哈希向量与 768 维模型向量不在同一空间，
 *    跨维度算余弦得到的是**无意义的数字且不报错**。所以 HttpEmbeddingProvider
 *    拿到结果先校验维度，不符直接抛 `EmbeddingUnavailableError`。
 *    （SQLite 侧的对应守卫见 `retrieval.ts`：只比较 embed_model + embed_dim 都一致的行。）
 *
 * 3. **可失败是设计要求，不是缺陷**。嵌入服务可能没起、可能超时。检索侧必须能
 *    退回纯 BM25 并记 degraded，而不是把一次 `kb_retrieve` 拖死。
 *    故有 `health()` 与 `local`（本地现算 = 永不失败；远端 = 可能失败）。
 */

/* ── 分词与哈希向量（自 retrieval.ts 迁入，行为逐字不变） ── */

const LATIN_RE = /[a-z0-9]+/gi;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(LATIN_RE)) {
    const w = m[0];
    if (/^\d+$/.test(w)) {
      out.push(w);
      continue;
    }
    if (w.length >= 2) out.push(w);
    if (w.length > 4) for (let i = 0; i + 4 <= w.length; i++) out.push(w.slice(i, i + 4));
  }
  const hans = lower.replace(/[^\u4e00-\u9fff]+/g, " ").trim();
  for (const seg of hans.split(/\s+/).filter(Boolean)) {
    if (seg.length === 1) out.push(seg);
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    if (seg.length > 2) for (let i = 0; i < seg.length - 2; i++) out.push(seg.slice(i, i + 3));
  }
  return out;
}

/** 哈希向量维度。改它会让所有历史 `hash-256` 向量失效（需重建），**不要顺手改**。 */
export const HASH_DIM = 256;

export function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(HASH_DIM);
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    let h = 2166136261;
    for (let j = 0; j < t.length; j++) {
      h ^= t.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % HASH_DIM;
    const sign = (h >>> 16) % 2 === 0 ? 1 : -1;
    v[idx] += sign * (1 + 1 / (1 + i / 50));
  }
  let norm = 0;
  for (let i = 0; i < HASH_DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < HASH_DIM; i++) v[i] = v[i]! / norm;
  return v;
}

export const cosine = (a: Float32Array, b: Float32Array): number => {
  // 维度不同直接返回 0 而不是抛错：调用方（retrieve）本就不该把不同维度的向量送到这里，
  // 但"回退到 0"与"整次检索失败"相比，前者至少还能靠 BM25 出结果。
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/* ── 向量的磁盘表示（SQLite BLOB） ──────────────────────── */

/**
 * Float32Array → BLOB。
 *
 * 用显式的字节拷贝而不是直接把 `v.buffer` 交出去：subarray 视图的 buffer 可能
 * 大于实际数据，写进去会连带写入相邻内存。这里按视图范围裁剪后再复制。
 */
export function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/**
 * BLOB → Float32Array。
 *
 * **不能**直接 `new Float32Array(b.buffer)` 套视图：node:sqlite 返回的 BLOB 是
 * `Uint8Array`，其底层 `buffer` 可能大于实际数据（共享 ArrayBuffer），
 * 直接套视图会读到相邻数据、算出错误的相似度，而且完全不报错。
 * 故先复制到独立且按 4 字节对齐的 ArrayBuffer。
 */
export function blobToVector(b: Uint8Array | null): Float32Array | null {
  if (!b || b.byteLength === 0) return null;
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return new Float32Array(ab);
}

/* ── 接口 ───────────────────────────────────────────────── */

export type EmbedInputType = "query" | "document";

/**
 * 嵌入服务的「方言」—— 决定请求体长什么样、怎么鉴权、健康检查打哪里。
 *
 * 这两类端点的差异不是格式洁癖，每一条都对应过真实的 4xx：
 *
 *   `embeddinggemma`：`services/embedding-core`（本地，无鉴权）。
 *     · 认 `input_type` / `title` —— 它靠这个注入 task 前缀，**省略就静默掉精度**；
 *     · 认 `dimensions` —— 允许把原生 768 压到更小；
 *     · `GET /health` 是它自己实现的路由。
 *
 *   `openai`：云端 OpenAI 兼容端点（SiliconFlow / 通义 / OpenAI / TEI）。
 *     · **不认** `input_type` / `title`：严格实现的网关直接 400，宽松的静默忽略；
 *     · `dimensions` 只有 text-embedding-3 这类支持可变维的模型才认，bge-m3 传了会报错；
 *     · 需要 `Authorization: Bearer`；
 *     · **没有** `/health`（打过去是 404）→ 探活必须换成一次极小体积的真实嵌入请求。
 *
 * 早期实现无条件发 `input_type` + `dimensions` 且不带头，因此只能对接本地内核。
 */
export type EmbedDialect = "embeddinggemma" | "openai";

/** 配置里的形态：`auto` 按"有没有 API Key"推断（本地内核不需要 Key）。 */
export type EmbedDialectConfig = EmbedDialect | "auto";

export function resolveEmbedDialect(dialect: EmbedDialectConfig | undefined, apiKey: string): EmbedDialect {
  if (dialect === "openai" || dialect === "embeddinggemma") return dialect;
  return apiKey ? "openai" : "embeddinggemma";
}

export interface EmbedRequestShape {
  model: string;
  dialect: EmbedDialect;
  apiKey?: string;
  inputType?: EmbedInputType;
  title?: string;
  dimensions?: number;
}

/** 组装请求头与请求体（两个调用点共用，避免"一处改了另一处没改"）。 */
export function embedRequestInit(
  shape: EmbedRequestShape,
  texts: string[],
  signal?: AbortSignal,
): { headers: Record<string, string>; body: string; signal?: AbortSignal } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (shape.apiKey) headers.Authorization = `Bearer ${shape.apiKey}`;

  if (shape.dialect === "embeddinggemma") {
    const body: Record<string, unknown> = {
      model: shape.model,
      input: texts,
      input_type: shape.inputType ?? "document",
    };
    if (shape.title) body.title = shape.title;
    if (shape.dimensions) body.dimensions = shape.dimensions;
    return { headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) };
  }

  // openai 方言：只发标准字段。多一个未知字段就可能被严格网关判 400。
  return {
    headers,
    body: JSON.stringify({ model: shape.model, input: texts }),
    ...(signal ? { signal } : {}),
  };
}

/** 从 OpenAI 兼容响应里取向量，并逐条校验维度与条数。 */
export function parseEmbedResponse(json: unknown, dim: number, expectedCount: number): Float32Array[] {
  const rows = (json as { data?: { embedding?: number[] }[] } | null)?.data ?? [];
  if (rows.length !== expectedCount) {
    throw new EmbeddingUnavailableError(`嵌入服务返回条数与请求不一致：请求 ${expectedCount}，返回 ${rows.length}`);
  }
  return rows.map((r, i) => {
    const vec = r.embedding ?? [];
    // 维度不符立刻炸：静默放过会让后续所有 cosine 分数失去意义
    if (vec.length !== dim) {
      throw new EmbeddingUnavailableError(
        `嵌入维度不匹配（第 ${i} 条）：期望 ${dim}，实得 ${vec.length}。` +
          `查询与文档必须同维度，且该维度决定落盘向量能参与比较的范围。` +
          `换模型后请同步改 BM_EMBED_DIM（bge-m3 = 1024，EmbeddingGemma 2 = 768），` +
          `再跑 npm run embedding:backfill -- --force 与 npm run vector:rebuild -- --reset。`,
      );
    }
    return Float32Array.from(vec);
  });
}

/** 429 / 5xx 的退避重试。远端按次计费且有 RPS 限制，直连 burst 会整批失败。 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  attempts = 3,
): Promise<Response> {
  let last: Response | undefined;
  for (let i = 0; i < attempts; i++) {
    const res = await doFetch();
    if (!RETRYABLE.has(res.status)) return res;
    last = res;
    if (i === attempts - 1) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** i;
    await new Promise((r) => setTimeout(r, wait));
  }
  return last!;
}

export interface EmbedOptions {
  /** 任务前缀（见文件头第 1 条）。缺省 "document"。 */
  inputType?: EmbedInputType;
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  /** 写入 `kb_chunks.embed_model` 的模型标识。**混用守卫的比对键之一**。 */
  readonly model: string;
  /** 写入 `kb_chunks.embed_dim`。与 model 一起决定"这个向量能不能和查询向量比"。 */
  readonly dim: number;
  /**
   * true = 本地现算、对任意文本可即时向量化（哈希）；
   * false = 远端服务。差别只在检索侧：远端 provider 对**没有落盘向量**的行
   * 不做逐行现算（那会变成 N 次网络往返），一律退回该行的 BM25 分。
   */
  readonly local: boolean;
  embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
  /** 探测可用性。哈希恒 true；远端打服务健康端点。 */
  health(): Promise<boolean>;
}

export class EmbeddingUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "EmbeddingUnavailableError";
  }
}

/* ── 实现 1：哈希（默认与兜底） ─────────────────────────── */

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = "hash-256";
  readonly dim = HASH_DIM;
  readonly local = true;

  async embed(texts: string[]): Promise<Float32Array[]> {
    // 刻意 return Promise 而不是声明 async 之外的东西：哈希是纯 CPU，
    // 用 await 只为统一接口；真实 provider 是网络调用。
    return texts.map((t) => hashEmbed(t));
  }

  async health(): Promise<boolean> {
    return true;
  }
}

/* ── 实现 2：HTTP（EmbeddingGemma 2 / 任意 OpenAI 兼容端点） ── */

export interface HttpEmbeddingOptions {
  /** OpenAI 兼容的嵌入端点，如 http://127.0.0.1:8899/v1/embeddings 或 https://api.siliconflow.cn/v1/embeddings */
  url: string;
  /** 模型标识（写进 embed_model） */
  model: string;
  dim: number;
  /** 单次请求最多几条文本；超出的分批。默认 32。 */
  batchSize?: number;
  timeoutMs?: number;
  /** 云端端点必填；本地内核留空 */
  apiKey?: string;
  /** 不填 = 按 apiKey 有无推断（见 resolveEmbedDialect） */
  dialect?: EmbedDialect;
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  readonly local = false;
  private readonly url: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly apiKey: string;
  readonly dialect: EmbedDialect;

  constructor(opts: HttpEmbeddingOptions) {
    if (!opts.url) throw new EmbeddingUnavailableError("HttpEmbeddingProvider 需要非空的 url");
    this.url = opts.url;
    this.model = opts.model || "embeddinggemma-2";
    this.dim = opts.dim;
    this.batchSize = Math.max(1, opts.batchSize ?? 32);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.apiKey = opts.apiKey ?? "";
    this.dialect = resolveEmbedDialect(opts.dialect, this.apiKey);
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const slice = texts.slice(i, i + this.batchSize);
      const vectors = await this.request(slice, opts);
      out.push(...vectors);
    }
    return out;
  }

  /**
   * 探活。两种方言的打法不同：
   *   · 本地内核有 `GET /health`；
   *   · 云端没有这个路由（打过去 404），只能发一次 1 条文本的真实嵌入请求 ——
   *     它顺带验证了 Key 与模型名，比"端口通"更有意义。
   */
  async health(): Promise<boolean> {
    if (this.dialect === "openai") {
      try {
        await this.embed(["health"], { inputType: "query" });
        return true;
      } catch {
        return false;
      }
    }
    try {
      const base = this.url.replace(/\/v1\/embeddings\/?$/, "");
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request(texts: string[], opts: EmbedOptions): Promise<Float32Array[]> {
    const init = embedRequestInit(
      { model: this.model, dialect: this.dialect, ...(this.apiKey ? { apiKey: this.apiKey } : {}), dimensions: this.dim, ...(opts.inputType ? { inputType: opts.inputType } : {}) },
      texts,
      opts.signal ?? AbortSignal.timeout(this.timeoutMs),
    );

    let res: Response;
    try {
      res = await fetchWithRetry(() => fetch(this.url, { method: "POST", headers: init.headers, body: init.body, signal: init.signal }));
    } catch (e) {
      throw new EmbeddingUnavailableError(
        `无法连接嵌入服务 ${this.url}：${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
    if (!res.ok) {
      throw new EmbeddingUnavailableError(
        `嵌入服务返回 HTTP ${res.status}${res.status === 401 || res.status === 403 ? "（API Key 无效或无权限）" : ""}：${(await res.text()).slice(0, 200)}`,
      );
    }
    return parseEmbedResponse(await res.json(), this.dim, texts.length);
  }
}

/* ── 工厂：从配置装配 ───────────────────────────────────── */

export interface EmbeddingConfigLike {
  embedUrl: string;
  embedModel: string;
  embedDim: number;
  embedBatchSize?: number;
  embedTimeoutMs?: number;
  /** 云端端点必填；本地内核留空 */
  embedApiKey?: string;
  /** `auto` = 有 Key 就按 openai 方言、没有就按本地内核 */
  embedDialect?: EmbedDialectConfig;
}

/**
 * `BM_EMBED_URL` 非空 → 用远端模型；为空 → 退回哈希。
 *
 * 为什么默认退回哈希而不是报错：语义通道是**可失败的旁路**。
 * 没配嵌入服务时系统仍应能跑（退化为关键词检索），这与重排未配置时的行为一致。
 * 但调用方应当把"当前用的是哈希占位"这件事显式告知运维——见 `providerKind()`。
 */
export function embeddingProviderFromConfig(cfg: EmbeddingConfigLike): EmbeddingProvider {
  if (!cfg.embedUrl) return new HashEmbeddingProvider();
  const apiKey = cfg.embedApiKey ?? "";
  return new HttpEmbeddingProvider({
    url: cfg.embedUrl,
    model: cfg.embedModel,
    dim: cfg.embedDim,
    ...(cfg.embedBatchSize !== undefined ? { batchSize: cfg.embedBatchSize } : {}),
    ...(cfg.embedTimeoutMs !== undefined ? { timeoutMs: cfg.embedTimeoutMs } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(cfg.embedDialect ? { dialect: resolveEmbedDialect(cfg.embedDialect, apiKey) } : {}),
  });
}

export const providerKind = (p: EmbeddingProvider): "hash" | "http" => (p.local ? "hash" : "http");

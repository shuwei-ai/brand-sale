/**
 * SemanticMemory —— 语义记忆库（EmbeddingGemma 2 + Milvus）
 *
 * 把「文本 → 768 维向量 → Milvus → 按语义检索」封装成一个类。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计约束（每一条都对应一个**静默失败**，改动前务必读完）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **零外部依赖**。只用全局 `fetch`（Node 18+）。刻意不引 `@zilliz/milvus2-sdk-node`：
 *    本文件要能被原样拎到任何项目里用。代价是走 HTTP REST 而非 gRPC，
 *    对本项目的量级（万级 chunk）性能差异可以忽略。
 *
 * 2. **Milvus 的 RESTful API 在 19530，不是 9091**。9091 只有健康与指标端点，
 *    打 `/v2/vectordb/*` 会返回 `404 page not found`。
 *    网上大量旧文章写"REST 在 9091"，照抄会得到一个 404，且看起来像"接口不对"而非"端口不对"。
 *
 * 3. **租户过滤必须下推到 Milvus 的 filter 表达式**，不能拉回来再筛。
 *    否则"先按向量取全局 topK"这一步就已经让别的租户的向量参与了竞争，
 *    即使最后回表过滤掉，本租户的命中名额也已经被挤占——
 *    表现为「本租户的资料明明有，却检不出来」，**而且不报错**。
 *    这里由 `tenantFilter()` 统一生成，不要绕开它自己拼字符串。
 *
 * 4. **写入后立刻读要用 `consistencyLevel: "Strong"`**。
 *    Milvus 默认是 Bounded，刚 insert/delete 的数据可能读不到。
 *    实测：delete 返回成功后立刻 query，被删的行**仍然查得到**。
 *    所以 `search()` 的 `fresh` 选项、以及 `removeByDoc()` 的校验，都走 Strong；
 *    常规检索走 Bounded（Strong 会强制等副本同步，牺牲延迟）。
 *
 * 5. **模型是 task-steered 的，查询与文档必须用不同前缀**：
 *        查询 → `task: search result | query: {q}`
 *        文档 → `title: {title} | text: {content}`
 *    省略"仍能工作，但精度下降" —— 又是静默劣化。
 *    前缀由嵌入服务按 `input_type` 注入，**调用方必须显式区分 query / document**。
 *
 * 6. **截断维度后必须重新归一化**（MRL）。取前 N 维会破坏单位长度，
 *    不重新归一化会让相似度排序静默变差。嵌入服务已处理，这里只需保证
 *    **查询与文档用同一个 dim**（跨维度比较算出的分数毫无意义且不报错）。
 *
 * 7. **Milvus 是可重建的索引，不是真相源**。本项目里文本的权威副本在 SQLite
 *    （`kb_docs` / `kb_chunks`）。本类为了能独立使用，把 `text` 也存了一份，
 *    但集成进 brandsale 时应当把它当缓存看待：删掉 collection 重建即可恢复。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 最小用法：
 * ```ts
 * const mem = new SemanticMemory({
 *   embedUrl: "http://127.0.0.1:8899/v1/embeddings",
 *   milvusUrl: "http://127.0.0.1:19530",
 *   dim: 768,
 * });
 * await mem.ensureCollection();
 *
 * await mem.upsert([{
 *   id: "rep_001#0",
 *   text: "小红书美妆赛道：护肤品类以功效测评类内容转化最优……",
 *   tenantId: "tenant_a",
 *   docId: "rep_001",
 *   title: "某品牌 2026Q3 投放复盘",
 *   kind: "report_summary",
 * }]);
 *
 * const hits = await mem.search("美妆种草怎么投", { tenantId: "tenant_a", topK: 5 });
 * ```
 */

/* ── 对外类型 ───────────────────────────────────────────── */

export interface SemanticMemoryOptions {
  /** 嵌入服务地址（OpenAI 兼容的 /v1/embeddings） */
  embedUrl: string;
  /** Milvus RESTful 基址。**是 19530 不是 9091** */
  milvusUrl: string;
  /** collection 名 */
  collection?: string;
  /** 向量维度，必须与嵌入服务一致。可选 768 / 512 / 256 / 128 */
  dim?: number;
  /** 写入 Milvus 的向量模型标识，用于识别跨模型混用 */
  embedModel?: string;
  embedTimeoutMs?: number;
  milvusTimeoutMs?: number;
  /** 常规检索用 Bounded；写入后立刻读的场景用 Strong */
  consistency?: "Bounded" | "Strong";
  /** 鉴权 token（Milvus 开启 authorizationEnabled 时填 "user:password"） */
  milvusToken?: string;
}

/** 一条待入库的语义记忆 */
export interface MemoryRecord {
  /** 主键。同一 id 重复写入 = 覆盖（upsert），保证幂等 */
  id: string;
  text: string;
  /** 租户。空串 `""` 表示**全局共享**（跨租户可见），与 KB-3/KB-4 的约定一致 */
  tenantId: string;
  docId?: string;
  /** 业务集合标签，如 KB-1..KB-4 */
  collection?: string;
  /** 记录类别，如 report_summary / kb_chunk。用于把"派生语料"识别出来 */
  kind?: string;
  sourceId?: string;
  title?: string;
  publishedAt?: string;
  meta?: Record<string, unknown>;
}

export interface MemoryHit extends MemoryRecord {
  /** 余弦相似度，越大越相关（Milvus COSINE 返回相似度，1 = 完全相同） */
  score: number;
}

export interface SearchOptions {
  /** 必填。不传就无法保证租户隔离 —— 这里刻意不给默认值 */
  tenantId: string;
  topK?: number;
  /** 额外的 Milvus 过滤表达式（会与租户谓词做 AND） */
  filter?: string;
  /** 只要分数 >= 该值的命中 */
  minScore?: number;
  /** true = Strong 一致性，用于写入后立刻验证 */
  fresh?: boolean;
  /** 限制只在这些 collection 标签里检索，如 ["KB-2"] */
  collections?: string[];
}

export interface SearchResult {
  hits: MemoryHit[];
  /** 非空表示本次检索被降级（而非"真的没有结果"） */
  degraded?: { reason: string; note: string };
}

export type SemanticMemoryErrorCode =
  | "embed_unavailable"
  | "milvus_unavailable"
  | "milvus_error"
  | "bad_request";

export class SemanticMemoryError extends Error {
  /** 不要把它写成参数属性（constructor 里的 `readonly cause`）：
   *  `cause` 已经是 ES2022 `Error` 的成员，声明属性会触发 TS4115（需要 override），
   *  而且会覆盖掉 `super(message, { cause })` 设置的那个 cause。用 super 的第二参数传。 */
  constructor(
    readonly code: SemanticMemoryErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SemanticMemoryError";
  }
}

/* ── 实现 ───────────────────────────────────────────────── */

const DEFAULTS = {
  collection: "brandsale_semantic_memory",
  dim: 768,
  embedTimeoutMs: 60_000,
  milvusTimeoutMs: 3_000,
  consistency: "Bounded" as const,
};

/** Milvus VarChar 的硬上限是 65535 字节。中文按 UTF-8 每字 3 字节，
 *  所以这里按"字符数"保守截断到 20000，避免把一条超长文本变成整批写入失败。
 *  **不要**把超长文本静默截断当作正常行为 —— 调用方应自己先切块。 */
const MAX_TEXT_CHARS = 20_000;
const MAX_TITLE_CHARS = 512;
const MAX_META_CHARS = 4_000;

/** 把字符串转义成 Milvus filter 表达式里的双引号字面量。
 *  不做这一步，租户 id 里一个 `"` 就能改掉整个过滤语义（过滤注入）。 */
function lit(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function clamp(v: string, max: number): string {
  return v.length <= max ? v : v.slice(0, max);
}

export class SemanticMemory {
  /** 已填充默认值的配置。用交叉类型而不是 `Required<Omit<...>>`：
   *  后者会把 `embedModel?: string` 也强制成必填，与"没配就是空"的语义不符。 */
  private readonly opts: SemanticMemoryOptions & {
    collection: string;
    dim: number;
    embedTimeoutMs: number;
    milvusTimeoutMs: number;
    consistency: "Bounded" | "Strong";
  };
  private ensured = false;

  /** 缓存"最近一次失败"，避免 Milvus 挂掉时每条 chunk 都白等一次超时。
   *  这与项目里重排失败后的冷却纪律是同一种做法。 */
  private milvusCooldownUntil = 0;
  private lastMilvusError: string | null = null;

  constructor(options: SemanticMemoryOptions) {
    if (!options.embedUrl) throw new SemanticMemoryError("bad_request", "embedUrl 必填");
    if (!options.milvusUrl) throw new SemanticMemoryError("bad_request", "milvusUrl 必填");
    this.opts = {
      ...DEFAULTS,
      ...options,
      collection: options.collection ?? DEFAULTS.collection,
      dim: options.dim ?? DEFAULTS.dim,
    };
  }

  /* ── 健康检查 ─────────────────────────────────────────── */

  async health(): Promise<{
    embed: boolean;
    milvus: boolean;
    dim: number;
    collection: string;
    detail?: string;
  }> {
    const [embed, milvus] = await Promise.all([
      fetch(`${this.opts.embedUrl.replace(/\/v1\/embeddings$/, "")}/health`, {
        signal: AbortSignal.timeout(this.opts.embedTimeoutMs),
      })
        .then((r) => r.ok)
        .catch(() => false),
      this.callMilvus("/v2/vectordb/collections/list", { dbName: "default" }, { probe: true })
        .then(() => true)
        .catch(() => false),
    ]);
    return { embed, milvus, dim: this.opts.dim, collection: this.opts.collection };
  }

  /* ── collection 生命周期 ──────────────────────────────── */

  /** 幂等：已存在则直接返回。写入前必须先调用（或直接调 upsert，它内部会调）。 */
  async ensureCollection(): Promise<void> {
    if (this.ensured) return;

    const existing = await this.callMilvus<unknown[]>("/v2/vectordb/collections/list", {
      dbName: "default",
    });
    if (Array.isArray(existing) && existing.includes(this.opts.collection)) {
      this.ensured = true;
      return;
    }

    await this.callMilvus("/v2/vectordb/collections/create", {
      collectionName: this.opts.collection,
      schema: {
        autoId: false,
        // 开启动态字段：将来加一个标量标签（如 reportId）不必改 schema、不必重建库。
        // 代价是字段名不做校验，所以**关键字段仍然显式声明**，别依赖动态字段存重要信息。
        enableDynamicField: true,
        fields: [
          { fieldName: "id", dataType: "VarChar", isPrimary: true, elementTypeParams: { max_length: "128" } },
          // tenant_id 空串 = 全局共享；检索谓词见 tenantFilter()
          { fieldName: "tenant_id", dataType: "VarChar", elementTypeParams: { max_length: "64" } },
          { fieldName: "collection", dataType: "VarChar", elementTypeParams: { max_length: "16" } },
          { fieldName: "kind", dataType: "VarChar", elementTypeParams: { max_length: "32" } },
          { fieldName: "source_id", dataType: "VarChar", elementTypeParams: { max_length: "64" } },
          { fieldName: "doc_id", dataType: "VarChar", elementTypeParams: { max_length: "128" } },
          { fieldName: "title", dataType: "VarChar", elementTypeParams: { max_length: "512" } },
          { fieldName: "text", dataType: "VarChar", elementTypeParams: { max_length: "65535" } },
          { fieldName: "published_at", dataType: "VarChar", elementTypeParams: { max_length: "32" } },
          { fieldName: "embed_model", dataType: "VarChar", elementTypeParams: { max_length: "64" } },
          { fieldName: "meta_json", dataType: "VarChar", elementTypeParams: { max_length: "4096" } },
          { fieldName: "vector", dataType: "FloatVector", elementTypeParams: { dim: String(this.opts.dim) } },
        ],
      },
      indexParams: [
        {
          fieldName: "vector",
          indexName: "vec_hnsw",
          metricType: "COSINE",
          indexType: "HNSW",
          params: { M: 16, efConstruction: 200 },
        },
      ],
    });

    // 建完要 load 进内存才能检索。已经 load 过会报错，忽略即可 —— 幂等。
    await this.callMilvus("/v2/vectordb/collections/load", { collectionName: this.opts.collection }).catch(
      () => undefined,
    );

    this.ensured = true;
  }

  async dropCollection(): Promise<void> {
    await this.callMilvus("/v2/vectordb/collections/drop", { collectionName: this.opts.collection });
    this.ensured = false;
  }

  /* ── 写入 ─────────────────────────────────────────────── */

  /**
   * 幂等写入。同一 `id` 重复写入即覆盖（用 upsert 而非 insert，
   * 避免"网关重试 / 批处理重跑"在库里堆出两份几乎相同的记录，
   * 进而让同一句话在检索结果里出现两次、挤占 topK 名额）。
   */
  async upsert(
    records: MemoryRecord[],
    opts: { verify?: boolean } = {},
  ): Promise<{ upserted: number }> {
    if (records.length === 0) return { upserted: 0 };
    await this.ensureCollection();

    // 文本按 kind 分流：报告摘要这类"派生语料"没有独立标题，
    // 有标题的走 `title: {t} | text: {c}`，没有标题的走 `title: none`。
    const vectors = await this.embed(
      records.map((r) => r.text),
      "document",
      undefined,
    );

    if (vectors.length !== records.length) {
      throw new SemanticMemoryError(
        "embed_unavailable",
        `嵌入服务返回条数与请求不一致：请求 ${records.length}，返回 ${vectors.length}`,
      );
    }

    const rows = records.map((r, i) => ({
      id: clamp(r.id, 128),
      tenant_id: clamp(r.tenantId ?? "", 64),
      collection: clamp(r.collection ?? "", 16),
      kind: clamp(r.kind ?? "", 32),
      source_id: clamp(r.sourceId ?? "", 64),
      doc_id: clamp(r.docId ?? "", 128),
      title: clamp(r.title ?? "", MAX_TITLE_CHARS),
      text: clamp(r.text, MAX_TEXT_CHARS),
      published_at: clamp(r.publishedAt ?? "", 32),
      embed_model: clamp(this.opts.embedModel ?? "", 64),
      meta_json: r.meta ? clamp(JSON.stringify(r.meta), MAX_META_CHARS) : "",
      vector: vectors[i]!,
    }));

    // Milvus 单次请求体量限制：分批防超限
    const BATCH = 200;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const res = await this.callMilvus<{ upsertCount?: number }>("/v2/vectordb/entities/upsert", {
        collectionName: this.opts.collection,
        data: slice,
      });
      upserted += res?.upsertCount ?? slice.length;
    }

    // 写入后立刻读要用 Strong 才能看到；Bounded 下会"刚写完却查不到"。
    if (opts.verify) {
      await this.count({ tenantId: records[0]!.tenantId, fresh: true });
    }
    return { upserted };
  }

  /* ── 检索 ─────────────────────────────────────────────── */

  /** 检索。Milvus 不可达时**抛错**——需要"不许失败"的调用点请用 trySearch()。 */
  async search(query: string, options: SearchOptions): Promise<MemoryHit[]> {
    const r = await this.trySearch(query, options);
    if (r.degraded) {
      throw new SemanticMemoryError("milvus_unavailable", r.degraded.note);
    }
    return r.hits;
  }

  /**
   * 永不抛错的检索：外部依赖挂掉时返回空命中 + `degraded` 说明。
   *
   * 为什么必须有这个方法：Milvus 是**可失败的旁路**。它挂了应该让上层
   * 退回关键词检索（BM25）并把原因记进 degraded，而不是把整次报告生成打挂。
   * 注意「没有命中」与「检索不可用」是两件事，**不要用空数组表达后者**，
   * 否则上层会把"依赖挂了"当成"确实没有相关资料"。
   */
  async trySearch(query: string, options: SearchOptions): Promise<SearchResult> {
    if (Date.now() < this.milvusCooldownUntil) {
      return {
        hits: [],
        degraded: {
          reason: "milvus_unavailable",
          note: `Milvus 处于冷却中（上次失败：${this.lastMilvusError ?? "未知"}），本次跳过语义检索`,
        },
      };
    }

    let vector: number[];
    try {
      const vs = await this.embed([query], "query", undefined);
      vector = vs[0]!;
    } catch (e) {
      return {
        hits: [],
        degraded: {
          reason: "embed_unavailable",
          note: `嵌入服务不可用（${e instanceof Error ? e.message : String(e)}），本次跳过语义检索`,
        },
      };
    }

    try {
      const raw = await this.callMilvus<Record<string, unknown>[]>("/v2/vectordb/entities/search", {
        collectionName: this.opts.collection,
        data: [vector],
        limit: options.topK ?? 8,
        outputFields: [
          "id",
          "tenant_id",
          "collection",
          "kind",
          "source_id",
          "doc_id",
          "title",
          "text",
          "published_at",
          "meta_json",
        ],
        filter: this.buildFilter(options),
        // fresh=true 用于"刚写完要立刻验证"；常规检索用 Bounded 换延迟
        consistencyLevel: options.fresh ? "Strong" : this.opts.consistency,
      });

      let hits: MemoryHit[] = (raw ?? []).map((r) => ({
        id: String(r.id ?? ""),
        text: String(r.text ?? ""),
        tenantId: String(r.tenant_id ?? ""),
        collection: String(r.collection ?? "") || undefined,
        kind: String(r.kind ?? "") || undefined,
        sourceId: String(r.source_id ?? "") || undefined,
        docId: String(r.doc_id ?? "") || undefined,
        title: String(r.title ?? "") || undefined,
        publishedAt: String(r.published_at ?? "") || undefined,
        meta: r.meta_json ? safeJson(String(r.meta_json)) : undefined,
        score: Number(r.distance ?? 0),
      }));

      if (options.minScore !== undefined) {
        hits = hits.filter((h) => h.score >= options.minScore!);
      }
      return { hits };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastMilvusError = msg;
      this.milvusCooldownUntil = Date.now() + 30_000;
      return {
        hits: [],
        degraded: { reason: "milvus_unavailable", note: `Milvus 检索失败（${msg}），已进入 30s 冷却` },
      };
    }
  }

  /* ── 统计与删除 ───────────────────────────────────────── */

  /**
   * 统计行数。
   *
   * **语义易被误解，请注意**：传了 `tenantId` 时，数的是该租户**可见**的行，
   * 即「本租户 + 全局共享（tenant_id=''）」，**不是"属于该租户的行"**。
   * 这与 `retrieve()` 的可见性口径一致。若需要"仅本租户拥有"的数量，
   * 请用 `trySearch(q, { tenantId, filter: 'tenant_id != ""' })` 自行统计，
   * 或直接查真相源（SQLite 的 kb_chunks）。
   */
  async count(opts: { tenantId?: string; fresh?: boolean } = {}): Promise<number> {
    const filter = opts.tenantId !== undefined ? this.tenantFilter(opts.tenantId) : undefined;
    const raw = await this.callMilvus<unknown>("/v2/vectordb/entities/query", {
      collectionName: this.opts.collection,
      filter: filter ?? 'id != ""',
      outputFields: ["count(*)"],
      ...(opts.fresh ? { consistencyLevel: "Strong" } : {}),
    });
    const first = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined) : undefined;
    const n = first?.["count(*)"];
    return typeof n === "number" ? n : Array.isArray(raw) ? raw.length : 0;
  }

  /**
   * 按 docId 删除整份文档的向量。
   *
   * 为什么删文档要显式做补偿删除：SQLite 侧删了、Milvus 侧没删的话，
   * 已删除的内容**仍能被召回** —— 对"撤回的客户资料"来说这是内容泄露。
   */
  async removeByDoc(docId: string, tenantId?: string): Promise<{ deleted: number }> {
    const parts = [`doc_id == ${lit(docId)}`];
    if (tenantId !== undefined) parts.push(this.tenantFilter(tenantId));
    const res = await this.callMilvus<{ deleteCount?: number }>("/v2/vectordb/entities/delete", {
      collectionName: this.opts.collection,
      filter: parts.join(" and "),
    });
    return { deleted: res?.deleteCount ?? 0 };
  }

  /* ── 内部：过滤表达式 ─────────────────────────────────── */

  /**
   * 租户可见性谓词。**所有检索路径都必须经过这里**。
   *
   * 语义与 `packages/knowledge/src/retrieval.ts` 的 `visibleScopeSql()` 严格对齐：
   *   本租户的 + 全局共享的（tenant_id = ''）。
   * 少写后半段会表现为"公开情报一条都用不上"，多写会跨租户泄露，两者都不报错。
   */
  private tenantFilter(tenantId: string): string {
    return `(tenant_id == ${lit(tenantId)} or tenant_id == "")`;
  }

  private buildFilter(options: SearchOptions): string {
    const parts = [this.tenantFilter(options.tenantId)];
    if (options.collections?.length) {
      parts.push(`collection in [${options.collections.map(lit).join(", ")}]`);
    }
    if (options.filter) parts.push(`(${options.filter})`);
    return parts.join(" and ");
  }

  /* ── 内部：嵌入调用 ───────────────────────────────────── */

  private async embed(
    texts: string[],
    inputType: "query" | "document",
    title: string | undefined,
  ): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(this.opts.embedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: texts,
          input_type: inputType,
          ...(title ? { title } : {}),
          dimensions: this.opts.dim,
        }),
        signal: AbortSignal.timeout(this.opts.embedTimeoutMs),
      });
    } catch (e) {
      throw new SemanticMemoryError(
        "embed_unavailable",
        `无法连接嵌入服务 ${this.opts.embedUrl}：${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
    if (!res.ok) {
      throw new SemanticMemoryError(
        "embed_unavailable",
        `嵌入服务返回 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    const out = (json.data ?? []).map((d) => d.embedding ?? []);
    if (out.length === 0) {
      throw new SemanticMemoryError("embed_unavailable", "嵌入服务返回空结果");
    }
    // 维度不一致必须立刻炸：跨维度比较算出来的分数毫无意义，而且**不报错**。
    const bad = out.find((v) => v.length !== this.opts.dim);
    if (bad) {
      throw new SemanticMemoryError(
        "bad_request",
        `嵌入维度不匹配：期望 ${this.opts.dim}，实得 ${bad.length}。` +
          `查询与文档必须同维度，且 collection 的 dim 一旦建表就不能改（需重建 collection）。`,
      );
    }
    return out;
  }

  /* ── 内部：Milvus REST 调用 ───────────────────────────── */

  private async callMilvus<T = unknown>(
    path: string,
    body: unknown,
    opts: { probe?: boolean } = {},
  ): Promise<T> {
    const url = `${this.opts.milvusUrl.replace(/\/$/, "")}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.milvusToken ? { Authorization: `Bearer ${this.opts.milvusToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.milvusTimeoutMs),
      });
    } catch (e) {
      const note = `无法连接 Milvus ${this.opts.milvusUrl}（${e instanceof Error ? e.message : String(e)}）`;
      if (!opts.probe) {
        this.lastMilvusError = note;
        this.milvusCooldownUntil = Date.now() + 30_000;
      }
      throw new SemanticMemoryError("milvus_unavailable", note, e);
    }

    if (!res.ok) {
      throw new SemanticMemoryError("milvus_error", `Milvus HTTP ${res.status}（${path}）`);
    }

    const json = (await res.json()) as { code?: number; message?: string; data?: T };
    // Milvus 即使业务失败也返回 HTTP 200，靠 body 里的 code 判断。
    // **只看 res.ok 会把所有业务错误当成成功** —— 这是最隐蔽的一类问题。
    if (typeof json.code === "number" && json.code !== 0) {
      throw new SemanticMemoryError(
        "milvus_error",
        `Milvus 业务错误 code=${json.code}：${json.message ?? "(无 message)"}（${path}）`,
      );
    }
    return json.data as T;
  }
}

/* ── 便捷工厂：从环境变量装配 ─────────────────────────────── */

/**
 * 从环境变量构造（与项目的 `BM_*` 命名保持一致）：
 *   BM_EMBED_URL        http://127.0.0.1:8899/v1/embeddings
 *   BM_MILVUS_URI       http://127.0.0.1:19530
 *   BM_MILVUS_COLLECTION
 *   BM_EMBED_DIM        768 / 512 / 256 / 128
 *   BM_MILVUS_TOKEN
 */
export function semanticMemoryFromEnv(
  env: Record<string, string | undefined> = process.env,
): SemanticMemory {
  return new SemanticMemory({
    embedUrl: env.BM_EMBED_URL ?? "http://127.0.0.1:8899/v1/embeddings",
    milvusUrl: env.BM_MILVUS_URI ?? "http://127.0.0.1:19530",
    collection: env.BM_MILVUS_COLLECTION,
    dim: env.BM_EMBED_DIM ? Number(env.BM_EMBED_DIM) : undefined,
    embedModel: env.BM_EMBED_MODEL,
    milvusToken: env.BM_MILVUS_TOKEN || undefined,
    milvusTimeoutMs: env.BM_MILVUS_TIMEOUT_MS ? Number(env.BM_MILVUS_TIMEOUT_MS) : undefined,
  });
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * M7 KnowledgeService：四库管理 + 混合检索 + 重排 + 降级
 *
 * 检索链路（与 LLD §2.7 一致）：
 *   词法(BM25) ⊕ 语义(向量) ──RRF 融合──▶ 候选池 ──重排──▶ Top-K
 *                                            │
 *                                            └─ 重排超时/不可用 → 原序 + 30s 冷却 + 置信度下调一档（E-KB-001）
 *
 * 语义通道的向量来源是可插拔的（见 `embedding.ts`）：
 *   · 默认 `HashEmbeddingProvider`（256 维字符哈希）——不依赖外部服务、行为确定；
 *   · 配了 `BM_EMBED_URL` 后换成 `HttpEmbeddingProvider`（EmbeddingGemma 2 等）。
 *
 * 无论用哪个 provider，向量都**落盘在 `kb_chunks.vec`**（迁移 M4）：
 * 落盘把"每次查询对每个候选行做一次前向"的成本压到"写入一次"，
 * 并让"向量与 chunk 同生共死"（同事务删除，不会留下孤儿向量）。
 * 落盘向量带 `embed_model` / `embed_dim`，与当前 provider 不一致的行一律不参与
 * 语义比较（跨模型比较算出的分数**没有意义且不报错**）。
 */

import {
  AppError,
  chunkText,
  type Citation,
  type IKnowledgeService,
  type IngestDocumentInput,
  type IngestDocumentResult,
  type IngestSourceGuard,
  type IngestSourceVerdict,
  type KbChunk,
  type KbCollection,
  type RetrievalHit,
  type RetrievalQuery,
  type RetrievalResult,
} from "@brandsale/contracts";
import type { Config } from "@brandsale/config";
import type { Db } from "@brandsale/storage";
import { nowIso, parseJson, stringify } from "@brandsale/storage";
import {
  blobToVector,
  cosine,
  embeddingProviderFromConfig,
  hashEmbed,
  tokenize,
  vectorToBlob,
  type EmbeddingProvider,
} from "./embedding.ts";
import { SUMMARY_SOURCE_ID } from "./summarize.ts";
import { createVectorIndex, type VectorIndex } from "./vector-index.ts";

/* ── BM25 ───────────────────────────────────────────────── */

interface ChunkRow {
  chunk_id: string;
  doc_id: string;
  collection: string;
  tenant_id: string | null;
  text: string;
  source_id: string;
  source_type: string;
  tier: string;
  sample_size: number;
  published_at: string;
  human_verified: number;
  meta_json: string;
  /** 落盘的语义向量（Float32 字节序列）。NULL = 该块尚无向量（尚未 backfill / 写入时服务不可用） */
  vec: Uint8Array | null;
  /** 产出该向量的模型标识。与当前 provider 不一致 → 不参与余弦比较 */
  embed_model: string | null;
  embed_dim: number | null;
}

const K1 = 1.4;
const B = 0.72;

export interface RerankOptions {
  url: string;
  model: string;
  poolSize: number;
  timeoutMs: number;
  cooldownMs: number;
}

/**
 * 知识库的「可见作用域」。
 *
 * 四库的租户归属并不相同：
 *   KB-1 客户授权平台数据、KB-2 历史执行与私域知识 → **租户私有**
 *   KB-3 公开指数情报、KB-4 方法论与模板            → **全局共享**
 *
 * 全局集合在写入时用空串表示（见 seed.ts）。查询若只判 `tenant_id = ?`
 * 会把全局库整个漏掉 —— 表现为「报告永远只用私域数据、公开情报一句没用上」，
 * 而且不会报错，所以这里把谓词收敛到一处，避免两处各写一遍再写歪。
 */
const GLOBAL_SCOPE_SQL = `(tenant_id = '' OR tenant_id IS NULL)`;
const VISIBLE_SCOPE_SQL = `(tenant_id = ? OR ${GLOBAL_SCOPE_SQL})`;
/**
 * 演示样例过滤：默认把 `provenance='demo'` 的语料挡在检索之外。
 *
 * 与 `PricingStore` 同源（`Config.allowDemoData`）：demo 是 seed 为了让空库
 * 能跑通而灌的样例，**不是任何客户的真实数据**。若它出现在报告里，读者会
 * 拿它当真实情报引用 —— 这正是「报告里出现了搜不到的账号」那类问题的成因。
 */
const LIVE_ONLY_SQL = `COALESCE(provenance, 'unknown') <> 'demo'`;

/**
 * 当前可见作用域谓词（含演示数据过滤）。
 *
 * 收敛成一个方法而不是四处拼接：`scopeSql` 里多一个谓词、少一个空格都会
 * 让"样例数据是否可见"在四个查询之间不一致，而这种不一致最难查 ——
 * 报告里可能只漏出一句样例情报，来源校验却仍显示"来源合法"。
 */
function visibleScopeSql(includeDemo: boolean): string {
  return includeDemo ? VISIBLE_SCOPE_SQL : `${VISIBLE_SCOPE_SQL} AND ${LIVE_ONLY_SQL}`;
}

/**
 * 允许**绕过外部来源闸门**写入的系统自产来源（白名单，不是"开关"）。
 *
 * 为什么存在：来源闸门校验的是"外部来源是否登记并授权"。系统自产的语料
 * （报告摘要）没有外部来源，也没有合同出处可填，走闸门必然被拒。
 * 与其给闸门开一个 `bypass` 布尔（那会把纪律变成配置项），不如把能写入的
 * sourceId 一个一个列出来——新增一类系统语料时必须显式改这张表，
 * 于是"这条通道能被谁用"永远是代码里可读的一件事。
 *
 * 分级取 L2：它属于「历史执行与私域知识」这一类（客户自己的既往结论），
 * 与 `internal_review` 同级；但它**不是原始数据**，因此
 *   · 摘要内容由 DSL 机械投影（renderSummaryText 首行即声明"派生自历史报告"），
 *   · 计算多源交叉一致度时必须排除（见 summarize.ts 头部的 §5.2 说明）。
 */
export const INTERNAL_INGEST_SOURCES: Record<string, { tier: "L1" | "L2" | "L3" | "L4"; sourceType: KbChunk["sourceType"]; name: string }> = {
  [SUMMARY_SOURCE_ID]: { tier: "L2", sourceType: "l2_execution", name: "历史报告摘要（本系统生成）" },
};

/** kb_docs 的查询投影 */
interface DocRow {
  doc_id: string;
  title: string;
  collection: string;
  source_id: string;
  chunk_count: number;
  ingested_at: string;
}

/**
 * 由内容指纹推导稳定的 doc_id。
 *
 * 为什么不用自增/随机 id：入库必须**幂等**。同一份文件重复上传
 * （运营手滑点两次、网关重试、批处理重跑）应当得到同一个 doc_id 并覆盖，
 * 而不是产生两份几乎相同的语料——后者会让同一句话在检索结果里出现两次，
 * 挤占 topK 名额，还会让报告里出现"两个来源说同一件事"的假交叉验证。
 *
 * 指纹取 4 个维度：租户 + 来源 + 标题 + 数据时点。
 * 只要其中之一变化（例如更新了 2026-10 的版本），就是一份新文档，符合预期。
 */
export function stableDocId(parts: string[]): string {
  const s = parts.join("\u0001");
  let h1 = 2166136261;
  let h2 = 2166136261;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ (c + 0x9e3779b9), 16777619);
  }
  const a = (h1 >>> 0).toString(36).padStart(7, "0");
  const b = (h2 >>> 0).toString(36).padStart(7, "0");
  return `doc_${a}${b}`;
}

export class KnowledgeService implements IKnowledgeService {
  /** 本地哈希向量的内存缓存（仅 local provider 用；远端 provider 的结果落盘，无需内存缓存） */
  private readonly embedCache = new Map<string, Float32Array>();
  private rerankCooldownUntil = 0;
  private lastRerankError: string | null = null;
  private readonly embedding: EmbeddingProvider;
  /**
   * 可选的外部向量索引（Milvus）。`null` = 默认路径，只用 SQLite 里的落盘向量。
   * 它**永远只是可重建的索引**：检索结果必须回 SQLite 校验后才会出现在报告里。
   */
  private readonly index: VectorIndex | null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    /**
     * 入库来源守卫，由装配层（container）注入。
     *
     * 为什么不让 KnowledgeService 自己查表：来源校验需要 sources 与 authz 两张表的
     * "当前是否生效"语义，那套语义已经在 AuthzRepo.active() 里写过一次；
     * 在 knowledge 里再写一遍 SQL 就是第二份真相，改一处漏一处。
     * 而 knowledge **不能**依赖 governance（会让依赖矩阵多一条边），
     * 所以改成把校验能力注入进来。
     *
     * 未注入时**一律拒绝**（fail-closed）：一个没接校验的入库通道等于没有来源门槛。
     */
    private readonly sourceGuard?: IngestSourceGuard,
    /**
     * 语义向量来源。缺省按配置推导：`BM_EMBED_URL` 非空 = 远端模型，否则哈希。
     * 显式注入（第 4 参）主要用于测试与将来的 Milvus 驱动共用同一实例。
     */
    embedding?: EmbeddingProvider,
    /** 外部向量索引；缺省按 `BM_VECTOR_DRIVER` 推导（默认不启用） */
    index?: VectorIndex | null,
  ) {
    this.embedding = embedding ?? embeddingProviderFromConfig(config.retrieval);
    this.index = index !== undefined ? index : createVectorIndex(config.retrieval);
  }

  /* ── 入库 ─────────────────────────────────────────────── */

  async ingest(chunks: KbChunk[], ctx: { tenantId: string; jobId?: string; traceId: string }): Promise<{ ingested: number; rejected: number }> {
    void ctx; // 调用方负责审计落库；本方法只保证写入的原子性
    // 向量**先于事务**算好：node:sqlite 的事务体必须是同步的，不能在 tx 里 await。
    // 算失败只是让这批块没有语义通道（仍可被 BM25 检索到），不该让入库整体失败。
    const vectors = await this.vectorize(chunks.map((c) => c.text));
    const out = this.db.tx(() => this.writeChunks(chunks, vectors));
    await this.indexUpsert(chunks, "");
    return out;
  }

  /**
   * 把块同步进外部向量索引（Milvus），**best-effort**。
   *
   * 三条纪律：
   *   · **先提交 SQLite、后写索引**：反过来的话，事务回滚会留下无法自愈的孤儿向量；
   *   · **失败只吞不抛**：SQLite 是唯一真相源，`npm run vector:rebuild` 能完整重建索引，
   *     所以这里没有"必须成功"的理由，也不该让入库因此失败；
   *   · 未启用索引时是零开销的空操作（默认路径）。
   */
  private async indexUpsert(chunks: KbChunk[], title: string): Promise<void> {
    if (!this.index || chunks.length === 0) return;
    await this.index
      .upsert(
        chunks.map((c) => ({
          id: c.chunkId,
          text: c.text,
          tenantId: c.tenantId,
          docId: c.docId,
          collection: c.collection,
          sourceId: c.sourceId,
          ...(title ? { title } : {}),
          publishedAt: c.publishedAt,
          kind: "kb_chunk",
          meta: c.meta,
        })),
      )
      .catch(() => undefined);
  }

  /**
   * 文档级入库：切分 → 来源校验 → 覆盖写 → 落 kb_docs。
   *
   * **校验先于写入**：来源不合法时一行都不写。否则会出现"内容进去了、
   * 来源是假的"的中间态，而报告会把它当合法来源引用。
   *
   * **幂等**：doc_id 由 (tenantId, sourceId, title, publishedAt) 稳定推导，
   * 同键重复上传 = 覆盖（先删旧 chunk 与倒排词项）。chunk_id = `${docId}#${index}`，
   * 天然稳定。
   */
  async ingestDocument(
    input: IngestDocumentInput,
    ctx: { tenantId: string; jobId?: string; traceId: string },
  ): Promise<IngestDocumentResult> {
    const sourceId = (input.sourceId ?? "").trim();
    if (!sourceId) throw new AppError({ code: "E-INGEST-001", message: "sourceId 必填", details: { field: "sourceId" } });

    const verdict = this.sourceGuard
      ? this.sourceGuard(ctx.tenantId, sourceId)
      : { ok: false as const, reason: "未配置来源守卫（装配层未注入），拒绝入库" };
    if (!verdict.ok) {
      throw new AppError({
        code: "E-INGEST-001",
        message: `来源校验未通过：${verdict.reason ?? "来源未登记或授权已失效"}`,
        userMessage: `数据来源「${sourceId}」未登记或授权已失效，无法入库。请先在来源台账登记并授权。`,
        details: { sourceId, tenantId: ctx.tenantId },
      });
    }
    return this.writeDocument(input, ctx, verdict);
  }

  /**
   * 写入**系统自产**的文档（当前只有「历史报告摘要」）。
   *
   * 为什么不走 `ingestDocument` 的来源闸门：`report_summary` 不是外部来源，
   * 台账里的 `contractRef`（授权条款出处）对它无处可填——那是为"外部采集/采购"
   * 准备的字段。它与其他内部语料源（`internal_review` / `methodology`）一样，
   * **本来就不在 sources 表里**，靠 `sourceIds()` 被目录识别（见 governance/catalog.ts）。
   *
   * 但"不走外部闸门"不等于"没有门槛"：这里用**白名单**替代——
   * 只有 `INTERNAL_INGEST_SOURCES` 里列出的 sourceId 可通过，其余一律拒绝。
   * 于是这条通道不可能被当成"绕过来源校验的后门"，
   * 也不会让上传接口能伪造出 report_summary 这样的来源。
   */
  async ingestGeneratedDocument(
    input: Omit<IngestDocumentInput, "sourceId"> & { sourceId: string },
    ctx: { tenantId: string; jobId?: string; traceId: string },
  ): Promise<IngestDocumentResult> {
    const internal = INTERNAL_INGEST_SOURCES[input.sourceId];
    if (!internal) {
      throw new AppError({
        code: "E-INGEST-003",
        message: `sourceId「${input.sourceId}」不是允许的系统自产来源`,
        userMessage: `「${input.sourceId}」不是系统自产语料，请走常规入库通道（需来源台账登记与授权）。`,
        details: { sourceId: input.sourceId, allowed: Object.keys(INTERNAL_INGEST_SOURCES) },
      });
    }
    return this.writeDocument(input, ctx, { ok: true, tier: internal.tier, sourceType: internal.sourceType, sourceName: internal.name });
  }

  /** `ingestDocument` 与 `ingestGeneratedDocument` 的共同实现（校验 → 切分 → 事务写入）。 */
  private async writeDocument(
    input: IngestDocumentInput,
    ctx: { tenantId: string; jobId?: string; traceId: string },
    verdict: IngestSourceVerdict,
  ): Promise<IngestDocumentResult> {
    const title = (input.title ?? "").trim();
    const content = input.content ?? "";
    const sourceId = (input.sourceId ?? "").trim();

    if (!title) throw new AppError({ code: "E-INGEST-001", message: "文档标题不能为空", details: { field: "title" } });
    if (!sourceId) throw new AppError({ code: "E-INGEST-001", message: "sourceId 必填", details: { field: "sourceId" } });
    if (!content.trim()) throw new AppError({ code: "E-INGEST-001", message: "文档内容为空，无可入库的文本", details: { field: "content" } });

    const publishedAt = input.publishedAt || nowIso();

    // 全局语料只允许公开情报与方法论两类。KB-1/KB-2 装的是客户授权数据，
    // 写成全局等于把甲方的私域数据对所有租户可见。
    const isGlobal = Boolean(input.global);
    if (isGlobal && input.collection !== "KB-3" && input.collection !== "KB-4") {
      throw new AppError({
        code: "E-INGEST-001",
        message: `${input.collection} 不允许写入全局作用域（仅 KB-3 公开情报 / KB-4 方法论可跨租户共享）`,
        details: { collection: input.collection, global: true },
      });
    }
    // 用空串表示全局，与 GLOBAL_SCOPE_SQL 的既有约定保持一致
    const scopeTenant = isGlobal ? "" : ctx.tenantId;

    const docId = stableDocId([scopeTenant, sourceId, title, publishedAt]);
    const raw = chunkText(content);
    if (raw.length === 0) {
      throw new AppError({ code: "E-INGEST-001", message: "切分后没有有效内容", details: { field: "content" } });
    }

    const tier = verdict.tier ?? "L3";
    const sourceType = verdict.sourceType ?? "l3_public";
    const chunks: KbChunk[] = raw.map((c) => ({
      chunkId: `${docId}#${c.index}`,
      docId,
      collection: input.collection,
      tenantId: scopeTenant,
      text: c.text,
      sourceId,
      sourceType,
      tier,
      sampleSize: input.sampleSize ?? c.sampleSize,
      publishedAt,
      humanVerified: Boolean(input.humanVerified),
      meta: {
        ...(input.meta ?? {}),
        chunkIndex: c.index,
        ...(c.headingPath.length ? { headingPath: c.headingPath.join(" > ") } : {}),
      },
    }));

    const replaced = Boolean(this.db.get<{ doc_id: string }>("SELECT doc_id FROM kb_docs WHERE doc_id = ?", docId));

    // 向量先算、后写：事务体必须同步。失败 → 这批块只有 BM25 通道（不是错误）。
    const vectors = await this.vectorize(chunks.map((c) => c.text));

    const written = this.db.tx(() => {
      this.purgeChunks(docId);
      const out = this.writeChunks(chunks, vectors);
      this.db.run(
        `INSERT OR REPLACE INTO kb_docs
         (doc_id, tenant_id, collection, title, source_id, mime, byte_size, chunk_count, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        docId,
        scopeTenant,
        input.collection,
        title,
        sourceId,
        input.mime || "text/plain",
        content.length,
        out.ingested,
        nowIso(),
      );
      return out;
    });

    // 外部索引的同步放在事务**之外**（见 indexUpsert 的三条纪律）
    await this.indexUpsert(chunks, title);

    return {
      docId,
      chunks: written.ingested,
      rejected: written.rejected,
      collection: input.collection,
      sourceId,
      replaced,
      embedded: written.embedded,
    };
  }

  /**
   * 清掉某文档的全部 chunk 与倒排词项。
   *
   * 顺序不能反：kb_terms 没有 doc_id 列，只能按 chunk_id 删，
   * 所以**必须先查出 chunk_id 再删 chunk**。先删 chunk 会让随后的 SELECT 返回空集，
   * 残留的词项在 BM25 里仍然能命中，回表时却查不到 chunk——
   * 表现为"检索结果里出现空白条目"，而且不会报错。
   */
  private purgeChunks(docId: string): number {
    const ids = this.db.all<{ chunk_id: string }>("SELECT chunk_id FROM kb_chunks WHERE doc_id = ?", docId);
    for (const r of ids) this.db.run("DELETE FROM kb_terms WHERE chunk_id = ?", r.chunk_id);
    if (ids.length === 0) return 0;
    return this.db.run("DELETE FROM kb_chunks WHERE doc_id = ?", docId).changes;
  }

  /**
   * 块写入的唯一实现。必须在事务内调用；`ingest` 与 `ingestDocument` 共用。
   *
   * `vectors[i]` 与 `chunks[i]` 一一对应；`null` 表示该块这次没算出向量
   * （嵌入服务不可用）——此时 `embed_model` / `embed_dim` 一起留空，
   * 检索侧据此把它当作"无语义向量"的行，而不是拿一个空向量去参与余弦。
   */
  private writeChunks(chunks: KbChunk[], vectors: (Float32Array | null)[] = []): { ingested: number; rejected: number; embedded: number } {
    let ingested = 0;
    let rejected = 0;
    let embedded = 0;

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      // 回灌不变量：无来源（sourceId/sourceType）的一律拒绝入库（E2E 用例 9）
      if (!c.sourceId || !c.sourceType) {
        rejected += 1;
        continue;
      }
      const existing = this.db.get<{ chunk_id: string }>("SELECT chunk_id FROM kb_chunks WHERE chunk_id = ?", c.chunkId);
      if (existing) {
        rejected += 1;
        continue;
      }
      const vec = vectors[i] ?? null;
      this.db.run(
        `INSERT INTO kb_chunks (chunk_id, doc_id, collection, tenant_id, text, source_id, source_type, tier,
                                sample_size, published_at, human_verified, meta_json, provenance,
                                vec, embed_model, embed_dim)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.chunkId,
        c.docId,
        c.collection,
        c.tenantId,
        c.text,
        c.sourceId,
        c.sourceType,
        c.tier,
        c.sampleSize,
        c.publishedAt,
        c.humanVerified ? 1 : 0,
        stringify(c.meta),
        // 缺省 = live：漏标只会让数据"可见"，不会让真实数据消失（见 DataProvenance）
        c.provenance ?? "live",
        vec ? vectorToBlob(vec) : null,
        vec ? this.embedding.model : null,
        vec ? this.embedding.dim : null,
      );
      if (vec) embedded += 1;
      const seen = new Set<string>();
      for (const t of tokenize(`${c.text} ${c.sourceId}`)) {
        if (seen.has(t)) continue;
        seen.add(t);
        this.db.run("INSERT INTO kb_terms (chunk_id, term) VALUES (?, ?)", c.chunkId, t);
      }
      ingested += 1;
    }

    return { ingested, rejected, embedded };
  }

  /** 文档列表（运营视图）。 */
  listDocuments(tenantId: string, collection?: KbCollection): { docId: string; title: string; collection: KbCollection; sourceId: string; chunkCount: number; ingestedAt: string }[] {
    const rows = collection
      ? this.db.all<DocRow>(
          "SELECT doc_id, title, collection, source_id, chunk_count, ingested_at FROM kb_docs WHERE tenant_id = ? AND collection = ? ORDER BY ingested_at DESC",
          tenantId,
          collection,
        )
      : this.db.all<DocRow>(
          "SELECT doc_id, title, collection, source_id, chunk_count, ingested_at FROM kb_docs WHERE tenant_id = ? ORDER BY ingested_at DESC",
          tenantId,
        );
    return rows.map((r) => ({
      docId: r.doc_id,
      title: r.title,
      collection: r.collection as KbCollection,
      sourceId: r.source_id,
      chunkCount: r.chunk_count,
      ingestedAt: r.ingested_at,
    }));
  }

  /** 软删：整份文档的 chunk 与倒排词项一并清掉，并移除文档行。 */
  deleteDocument(tenantId: string, docId: string): { removedChunks: number } {
    const doc = this.db.get<{ doc_id: string }>("SELECT doc_id FROM kb_docs WHERE doc_id = ? AND tenant_id = ?", docId, tenantId);
    if (!doc) throw new AppError({ code: "E-INGEST-001", message: `文档不存在：${docId}`, details: { docId } });
    const removed = this.db.tx(() => {
      const n = this.purgeChunks(docId);
      this.db.run("DELETE FROM kb_docs WHERE doc_id = ? AND tenant_id = ?", docId, tenantId);
      return n;
    });
    /* 索引侧的**补偿删除**（尽力而为）。
     * 不做这一步，已撤回的内容仍会被语义召回——那是内容泄露，比"少召回"严重得多。
     * 失败不抛：索引可重建，`vector:rebuild` 会以 SQLite 为准把它们清干净。 */
    void this.index?.removeByDoc(docId, tenantId).catch(() => undefined);
    return { removedChunks: removed };
  }

  async stats(tenantId: string): Promise<{ collection: KbCollection; chunks: number; scope: "tenant" | "global" }[]> {
    const rows = this.db.all<{ collection: string; c: number; global_c: number }>(
      `SELECT collection,
              COUNT(*) AS c,
              SUM(CASE WHEN ${GLOBAL_SCOPE_SQL} THEN 1 ELSE 0 END) AS global_c
       FROM kb_chunks
       WHERE ${visibleScopeSql(this.config.allowDemoData)}
       GROUP BY collection ORDER BY collection`,
      tenantId,
    );
    return rows.map((r) => ({
      collection: r.collection as KbCollection,
      chunks: r.c,
      scope: r.global_c === r.c ? "global" : "tenant",
    }));
  }

  /* ── 来源目录用（P0-2） ───────────────────────────────── */

  /**
   * 该租户可见范围内的语料来源清单。
   *
   * 为什么需要它：KB 语料的 sourceId（public_intel / internal_review / methodology）
   * **不在 sources 表里**——它们是内部语料，不走外部授权与闸门。
   * 来源目录若不把这两类合起来，真实合法的 KB 引用会被来源校验误判为非法，
   * 于是「收紧校验」直接变成「报告没法引用知识库」。
   */
  sourceIds(tenantId: string): { sourceId: string; collection: KbCollection }[] {
    return this.db
      .all<{ source_id: string; collection: string }>(
        `SELECT DISTINCT source_id, collection FROM kb_chunks WHERE ${visibleScopeSql(this.config.allowDemoData)} ORDER BY collection, source_id`,
        tenantId,
      )
      .map((r) => ({ sourceId: r.source_id, collection: r.collection as KbCollection }));
  }

  /** 该租户可见的全部 chunkId，用于 kb_chunk 引用的存在性校验 */
  chunkIds(tenantId: string): string[] {
    return this.db
      .all<{ chunk_id: string }>(`SELECT chunk_id FROM kb_chunks WHERE ${visibleScopeSql(this.config.allowDemoData)}`, tenantId)
      .map((r) => r.chunk_id);
  }

  /* ── 检索 ─────────────────────────────────────────────── */

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const topK = query.topK ?? 8;
    const collections = query.collections ?? ["KB-1", "KB-2", "KB-3", "KB-4"];

    const rows = this.db.all<ChunkRow>(
      `SELECT * FROM kb_chunks
       WHERE collection IN (${collections.map(() => "?").join(",")})
         AND ${visibleScopeSql(this.config.allowDemoData)}`,
      ...collections,
      query.tenantId,
    );

    if (rows.length === 0) {
      return {
        hits: [],
        reranked: false,
        degraded: { reason: "E-KB-003", note: "库为空（冷启动），本阶段结论基于公开数据推断" },
      };
    }

    const terms = [...new Set(tokenize(query.text))];
    const docCount = rows.length;
    const df = new Map<string, number>();
    const termCount = new Map<string, number>();
    const chunkTerms = new Map<string, string[]>();

    for (const r of rows) {
      const ts = this.db.all<{ term: string }>("SELECT term FROM kb_terms WHERE chunk_id = ?", r.chunk_id).map((x) => x.term);
      chunkTerms.set(r.chunk_id, ts);
      const uniq = new Set(ts);
      for (const t of uniq) df.set(t, (df.get(t) ?? 0) + 1);
      for (const t of ts) termCount.set(`${r.chunk_id}\u0000${t}`, (termCount.get(`${r.chunk_id}\u0000${t}`) ?? 0) + 1);
    }

    const avgLen = rows.reduce((n, r) => n + (chunkTerms.get(r.chunk_id)?.length ?? 0), 0) / Math.max(1, docCount);

    /* 查询向量。远端 provider 失败时**不抛错**：本次退化为纯关键词检索（BM25），
     * 原因记进 degraded。语义通道是旁路，它挂了不该让整个 kb_retrieve 失败。 */
    const notes: { reason: string; note: string }[] = [];
    let qVec: Float32Array | null = null;
    if (this.embedding.local) {
      qVec = this.embedCached(query.text);
    } else {
      try {
        const [v] = await this.embedding.embed([query.text], { inputType: "query" });
        qVec = v ?? null;
      } catch (e) {
        notes.push({
          reason: "E-KB-002",
          note: `嵌入服务不可用（${e instanceof Error ? e.message : String(e)}），本次检索降级为纯关键词（BM25）`,
        });
      }
    }

    let staleVectors = 0;
    const scored = rows.map((r) => {
      const ts = chunkTerms.get(r.chunk_id) ?? [];
      const len = ts.length || 1;
      let bm25 = 0;
      for (const t of terms) {
        const n = df.get(t) ?? 0;
        if (n === 0) continue;
        const f = termCount.get(`${r.chunk_id}\u0000${t}`) ?? 0;
        if (f === 0) continue;
        const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5));
        bm25 += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgLen)));
      }
      const cos = this.semanticScore(r, qVec, () => {
        staleVectors += 1;
      });
      return { row: r, bm25, cos };
    });

    /* 落盘向量是别的模型产的（如 256 维哈希 vs 768 维模型）：那些行退回关键词。
     * **必须记 degraded** —— 跨模型比较算出的分数没有意义却不报错，
     * 不标记的话"换模型之后检索悄悄变差"将无人知晓。 */
    if (staleVectors > 0 && !this.embedding.local) {
      notes.push({
        reason: "E-KB-002",
        note: `${staleVectors} 个片段的向量来自其他模型（当前 ${this.embedding.model}/${this.embedding.dim}），这些片段本次仅用关键词匹配；如需语义召回请先重建向量`,
      });
    }

    // RRF 融合（无需调参，对两路分数尺度不敏感）
    const rankByBm25 = [...scored].sort((a, b) => b.bm25 - a.bm25).map((s) => s.row.chunk_id);
    const rrf = new Map<string, number>();
    const K_RRF = 60;
    rankByBm25.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (K_RRF + i + 1)));
    /* 语义一路只有在"确实算出了非零相似度"时才计入 RRF：
     * 全 0 的排序是任意的（等于按 chunk_id 排列），把它并进融合只会注入噪声。 */
    const hasSemantic = qVec !== null && scored.some((s) => s.cos !== 0);
    if (hasSemantic) {
      const rankByCos = [...scored].sort((a, b) => b.cos - a.cos).map((s) => s.row.chunk_id);
      rankByCos.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (K_RRF + i + 1)));
    }

    /* 外部向量索引（Milvus，可选）。命中必须**回表校验**：
     * 索引里可能存在 SQLite 已删除的孤儿向量（双写不一致的必然产物），
     * 放它们进结果就会变成"检索里出现一条空白条目"，且看起来像数据问题。 */
    if (this.index) {
      const known = new Set(rows.map((r) => r.chunk_id));
      const idxRes = await this.index.search(query.text, {
        tenantId: query.tenantId,
        topK: Math.max(topK, this.config.retrieval.rerankPoolSize),
        collections,
      });
      if (idxRes.degraded) {
        notes.push({
          reason: "E-KB-002",
          note: `外部向量索引不可用（${idxRes.degraded.note}），本次仅用 SQLite 语义 + 关键词`,
        });
      } else {
        const ranked = idxRes.hits.filter((h) => known.has(h.chunkId));
        const orphans = idxRes.hits.length - ranked.length;
        ranked.forEach((h, i) => rrf.set(h.chunkId, (rrf.get(h.chunkId) ?? 0) + 1 / (K_RRF + i + 1)));
        if (orphans > 0) {
          notes.push({
            reason: "E-KB-002",
            note: `${orphans} 条向量索引命中在 SQLite 中找不到对应片段（索引与真相源不一致），已丢弃；跑一次 vector:rebuild 可修复`,
          });
        }
      }
    }

    const fused = scored
      .map((s) => ({ ...s, score: rrf.get(s.row.chunk_id) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    const pool = fused.slice(0, Math.max(topK, this.config.retrieval.rerankPoolSize));

    // 重排
    let reranked = false;
    let ordered: { row: ChunkRow; bm25: number; cos: number; score: number; rerankScore?: number }[] = pool;

    const rr = this.rerankOptions();
    if (query.rerank !== false && rr && pool.length > 1) {
      const now = Date.now();
      if (now < this.rerankCooldownUntil) {
        notes.push({
          reason: "E-KB-001",
          note: `重排处于 ${Math.ceil((this.rerankCooldownUntil - now) / 1000)}s 冷却中（上次失败：${this.lastRerankError ?? "未知"}），本次按融合原序返回`,
        });
      } else {
        try {
          const scores = await this.callRerank(rr, query.text, pool.map((p) => p.row.text));
          ordered = pool
            .map((p, i) => ({ ...p, rerankScore: scores[i] }))
            .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
          reranked = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.lastRerankError = msg;
          this.rerankCooldownUntil = Date.now() + rr.cooldownMs;
          notes.push({
            reason: "E-KB-001",
            note: `重排失败（${msg}），已降级为融合原序，并进入 ${Math.round(rr.cooldownMs / 1000)}s 冷却`,
          });
        }
      }
    }

    const hits: RetrievalHit[] = ordered.slice(0, topK).map((s) => ({
      chunk: this.toChunk(s.row),
      score: s.score,
      ...(s.rerankScore !== undefined ? { rerankScore: s.rerankScore } : {}),
      citation: this.toCitation(s.row),
    }));

    const degraded = notes.length > 0 ? { reason: notes[0]!.reason, note: notes.map((n) => n.note).join("；") } : undefined;
    return { hits, reranked, ...(degraded ? { degraded } : {}) };
  }

  /**
   * 单行的语义相似度。
   *
   * 四种情形，**顺序不能换**：
   *   ① 有落盘向量且 model/dim 与当前 provider 一致 → 直接算余弦（正常路径）；
   *   ② 有落盘向量但模型不符 → 记 stale，本地 provider 可当场重算；远端 provider 一律 0；
   *   ③ 无落盘向量 + 本地 provider → 现算哈希（兼容尚未 backfill 的历史行）；
   *   ④ 无向量 + 远端 provider → 0（逐行发网络请求会把一次检索变成 N 次往返）。
   * `qVec === null`（嵌入服务不可用）时一律 0 → 本次退化为纯 BM25。
   */
  private semanticScore(row: ChunkRow, qVec: Float32Array | null, onStale: () => void): number {
    if (!qVec) return 0;
    const stored = blobToVector(row.vec);
    if (stored) {
      if (row.embed_model === this.embedding.model && row.embed_dim === this.embedding.dim) {
        return cosine(qVec, stored);
      }
      onStale();
      return this.embedding.local ? cosine(qVec, hashEmbed(row.text)) : 0;
    }
    return this.embedding.local ? cosine(qVec, hashEmbed(row.text)) : 0;
  }

  private rerankOptions(): RerankOptions | null {
    const r = this.config.retrieval;
    if (!r.rerankUrl) return null;
    return { url: r.rerankUrl, model: r.rerankModel, poolSize: r.rerankPoolSize, timeoutMs: r.rerankTimeoutMs, cooldownMs: r.rerankCooldownMs };
  }

  private async callRerank(o: RerankOptions, query: string, docs: string[]): Promise<number[]> {
    const res = await fetch(o.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: o.model, query, documents: docs, top_n: docs.length }),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
    const out = new Array<number>(docs.length).fill(0);
    for (const r of json.results ?? []) out[r.index] = r.relevance_score;
    return out;
  }

  private toChunk(r: ChunkRow): KbChunk {
    return {
      chunkId: r.chunk_id,
      docId: r.doc_id,
      collection: r.collection as KbCollection,
      tenantId: r.tenant_id ?? "",
      text: r.text,
      sourceId: r.source_id,
      sourceType: r.source_type as KbChunk["sourceType"],
      tier: r.tier as KbChunk["tier"],
      sampleSize: r.sample_size,
      publishedAt: r.published_at,
      humanVerified: r.human_verified === 1,
      meta: parseJson<Record<string, string | number | boolean>>(r.meta_json, {}),
    };
  }

  private toCitation(r: ChunkRow): Citation {
    return {
      id: `cit_${r.chunk_id}`,
      sourceId: r.source_id,
      sourceName: r.source_id,
      tier: r.tier as Citation["tier"],
      collectedAt: r.published_at,
      note: `${r.collection} / ${r.doc_id}`,
    };
  }

  /** 本地哈希向量的缓存（仅 local provider 走这里；远端的向量落在 kb_chunks.vec） */
  private embedCached(text: string): Float32Array {
    const cached = this.embedCache.get(text);
    if (cached) return cached;
    const v = hashEmbed(text);
    if (this.embedCache.size > 5000) this.embedCache.clear();
    this.embedCache.set(text, v);
    return v;
  }

  /**
   * 批量向量化（写入路径用）。**永不抛错**：任一文本出错或服务不可用，
   * 一律返回全 null —— 这批块仍然入库、仍可被 BM25 检索到，只是没有语义通道。
   *
   * 刻意不在失败时抛出：入库通道的首要职责是"内容进得来"。
   * 因为嵌入服务没起就拒绝入库，等于把"可选的增强能力"变成了"必需的依赖"。
   */
  private async vectorize(texts: string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) return [];
    if (this.embedding.local) {
      return texts.map((t) => this.embedCached(t));
    }
    try {
      const vecs = await this.embedding.embed(texts, { inputType: "document" });
      return texts.map((_, i) => vecs[i] ?? null);
    } catch {
      return texts.map(() => null);
    }
  }

  /** 台账/血缘用：记录一次检索的输入摘要 */
  static citationNote(hits: RetrievalHit[]): string {
    return hits.map((h) => `${h.citation.sourceId}#${h.chunk.chunkId}`).join(", ");
  }
}

export const ingestStamp = (): string => nowIso();

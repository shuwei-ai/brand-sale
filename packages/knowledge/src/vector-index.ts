/**
 * VectorIndex —— 可选的外部向量索引（P3，默认关闭）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 先明确它的地位：**可重建的索引，不是真相源**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 本项目的文本与向量的权威副本在 SQLite（`kb_chunks.text` / `kb_chunks.vec`）。
 * 当 `BM_VECTOR_DRIVER=milvus` 时，密向量**额外**写入 Milvus，用于：
 *   · 语料量超出单机暴力余弦的舒适区（>10 万 chunk）；
 *   · 单次检索 p95 超过 500ms；
 *   · 出现多实例部署需求（进程内向量无处共享）。
 *
 * 三条由这个定位推出来的硬约束：
 *   ① **删掉 Milvus 数据卷 + 跑一次 `npm run vector:rebuild`，系统必须完全恢复**；
 *   ② 任何 Milvus 失败都只记 degraded，**不得让检索失败**（退回 SQLite 语义 + BM25）；
 *   ③ 检索结果必须回 SQLite 校验：命中但回表无对应 chunk 的（孤儿向量）直接丢弃 ——
 *      否则会出现"检索结果里一条空白条目"，且看起来像数据问题而不是索引问题。
 *
 * 租户隔离**下推到 Milvus 的 filter 表达式**（见 SemanticMemory.tenantFilter）：
 * 不能"先取全局 topK 再过滤"，那样别的租户的向量已经挤占了本租户的命中名额——
 * 表现为「本租户的资料明明有，却检不出来」，而且不报错。
 */

import type { Config } from "@brandsale/config";
import { SemanticMemory, type MemoryRecord } from "./semantic-memory.ts";

export interface VectorIndexHit {
  /** 与 `kb_chunks.chunk_id` 对齐 */
  chunkId: string;
  score: number;
}

export interface VectorIndexSearchResult {
  hits: VectorIndexHit[];
  degraded?: { reason: string; note: string };
}

export interface VectorIndex {
  readonly kind: "milvus";
  search(query: string, opts: { tenantId: string; topK: number; collections?: string[] }): Promise<VectorIndexSearchResult>;
  /** 写入（幂等：同 id 覆盖）。失败抛错，由调用方决定是否吞掉 */
  upsert(records: MemoryRecord[]): Promise<void>;
  /** 按文档删除（删 SQLite 之后的补偿删除） */
  removeByDoc(docId: string, tenantId?: string): Promise<void>;
}

/**
 * Milvus 实现。刻意**只做这一件事**：把 chunkId 与相似度分取回来。
 * 融合（RRF）与回表校验留在 KnowledgeService —— 那里才有 SQLite 的行。
 */
export class MilvusVectorIndex implements VectorIndex {
  readonly kind = "milvus" as const;
  private readonly mem: SemanticMemory;

  constructor(opts: {
    milvusUrl: string;
    collection: string;
    token?: string;
    timeoutMs: number;
    embedUrl: string;
    embedModel: string;
    embedDim: number;
    embedTimeoutMs: number;
    /** 云端嵌入端点的 Key（本地内核留空） */
    embedApiKey?: string;
    /** 嵌入方言；缺省按"有没有 Key"推断 */
    embedDialect?: "auto" | "openai" | "embeddinggemma";
  }) {
    this.mem = new SemanticMemory({
      embedUrl: opts.embedUrl,
      milvusUrl: opts.milvusUrl,
      collection: opts.collection,
      dim: opts.embedDim,
      embedModel: opts.embedModel,
      embedTimeoutMs: opts.embedTimeoutMs,
      milvusTimeoutMs: opts.timeoutMs,
      ...(opts.embedApiKey ? { embedApiKey: opts.embedApiKey } : {}),
      ...(opts.embedDialect ? { embedDialect: opts.embedDialect } : {}),
      ...(opts.token ? { milvusToken: opts.token } : {}),
    });
  }

  async search(query: string, opts: { tenantId: string; topK: number; collections?: string[] }): Promise<VectorIndexSearchResult> {
    // trySearch 永不抛错：Milvus 挂了返回空命中 + degraded
    const r = await this.mem.trySearch(query, {
      tenantId: opts.tenantId,
      topK: opts.topK,
      ...(opts.collections ? { collections: opts.collections } : {}),
    });
    return {
      hits: r.hits.map((h) => ({ chunkId: h.id, score: h.score })),
      ...(r.degraded ? { degraded: r.degraded } : {}),
    };
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.mem.upsert(records);
  }

  async removeByDoc(docId: string, tenantId?: string): Promise<void> {
    await this.mem.removeByDoc(docId, tenantId);
  }

  /** 供 `vector:rebuild` 与运维用 */
  raw(): SemanticMemory {
    return this.mem;
  }
}

/**
 * 按配置装配外部向量索引。
 *
 * 返回 `null` 的两种情况都是**有意为之**（而不是错误）：
 *   · `vectorDriver !== "milvus"` —— 默认路径，纯 SQLite；
 *   · 没配 `BM_EMBED_URL` —— Milvus 里存的必须是模型向量；
 *     用哈希向量去填 Milvus 毫无意义（既不省事也不提升召回）。
 */
export function createVectorIndex(cfg: Config["retrieval"]): VectorIndex | null {
  if (cfg.vectorDriver !== "milvus") return null;
  if (!cfg.embedUrl) return null;
  return new MilvusVectorIndex({
    milvusUrl: cfg.milvusUri,
    collection: cfg.milvusCollection,
    ...(cfg.milvusToken ? { token: cfg.milvusToken } : {}),
    timeoutMs: cfg.milvusTimeoutMs,
    embedUrl: cfg.embedUrl,
    embedModel: cfg.embedModel,
    embedDim: cfg.embedDim,
    embedTimeoutMs: cfg.embedTimeoutMs,
    ...(cfg.embedApiKey ? { embedApiKey: cfg.embedApiKey } : {}),
    ...(cfg.embedDialect ? { embedDialect: cfg.embedDialect } : {}),
  });
}

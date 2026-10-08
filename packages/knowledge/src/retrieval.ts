/**
 * M7 KnowledgeService：四库管理 + 混合检索 + 重排 + 降级
 *
 * 检索链路（与 LLD §2.7 一致）：
 *   词法(BM25) ⊕ 语义(向量) ──RRF 融合──▶ 候选池 ──重排──▶ Top-K
 *                                            │
 *                                            └─ 重排超时/不可用 → 原序 + 30s 冷却 + 置信度下调一档（E-KB-001）
 *
 * Phase 1 的语义通道用**本地字符三元组哈希向量**作为占位实现：
 * 它不依赖外部服务，行为确定，接口与真实 embedding 完全一致，
 * 接入 Infinity / bge-m3 时只需替换 `embed()` 的实现。
 */

import {
  type Citation,
  type IKnowledgeService,
  type KbChunk,
  type KbCollection,
  type RetrievalHit,
  type RetrievalQuery,
  type RetrievalResult,
} from "@brandsale/contracts";
import type { Config } from "@brandsale/config";
import type { Db } from "@brandsale/storage";
import { nowIso, parseJson, stringify } from "@brandsale/storage";

/* ── 分词：中文 bigram + 英文/数字小写词 ────────────────── */

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

/* ── 语义通道占位实现 ───────────────────────────────────── */

const VEC_DIM = 256;

export function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(VEC_DIM);
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    let h = 2166136261;
    for (let j = 0; j < t.length; j++) {
      h ^= t.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % VEC_DIM;
    const sign = (h >>> 16) % 2 === 0 ? 1 : -1;
    v[idx] += sign * (1 + 1 / (1 + i / 50));
  }
  let norm = 0;
  for (let i = 0; i < VEC_DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < VEC_DIM; i++) v[i] = v[i]! / norm;
  return v;
}

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

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

export class KnowledgeService implements IKnowledgeService {
  private readonly embedCache = new Map<string, Float32Array>();
  private rerankCooldownUntil = 0;
  private lastRerankError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  /* ── 入库 ─────────────────────────────────────────────── */

  async ingest(chunks: KbChunk[], ctx: { tenantId: string; jobId?: string; traceId: string }): Promise<{ ingested: number; rejected: number }> {
    let ingested = 0;
    let rejected = 0;

    this.db.tx(() => {
      for (const c of chunks) {
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
        this.db.run(
          `INSERT INTO kb_chunks (chunk_id, doc_id, collection, tenant_id, text, source_id, source_type, tier,
                                  sample_size, published_at, human_verified, meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
        const seen = new Set<string>();
        for (const t of tokenize(`${c.text} ${c.sourceId}`)) {
          if (seen.has(t)) continue;
          seen.add(t);
          this.db.run("INSERT INTO kb_terms (chunk_id, term) VALUES (?, ?)", c.chunkId, t);
        }
        ingested += 1;
      }
    });

    return { ingested, rejected };
  }

  async stats(tenantId: string): Promise<{ collection: KbCollection; chunks: number; scope: "tenant" | "global" }[]> {
    const rows = this.db.all<{ collection: string; c: number; global_c: number }>(
      `SELECT collection,
              COUNT(*) AS c,
              SUM(CASE WHEN ${GLOBAL_SCOPE_SQL} THEN 1 ELSE 0 END) AS global_c
       FROM kb_chunks
       WHERE ${VISIBLE_SCOPE_SQL}
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
        `SELECT DISTINCT source_id, collection FROM kb_chunks WHERE ${VISIBLE_SCOPE_SQL} ORDER BY collection, source_id`,
        tenantId,
      )
      .map((r) => ({ sourceId: r.source_id, collection: r.collection as KbCollection }));
  }

  /** 该租户可见的全部 chunkId，用于 kb_chunk 引用的存在性校验 */
  chunkIds(tenantId: string): string[] {
    return this.db
      .all<{ chunk_id: string }>(`SELECT chunk_id FROM kb_chunks WHERE ${VISIBLE_SCOPE_SQL}`, tenantId)
      .map((r) => r.chunk_id);
  }

  /* ── 检索 ─────────────────────────────────────────────── */

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const topK = query.topK ?? 8;
    const collections = query.collections ?? ["KB-1", "KB-2", "KB-3", "KB-4"];

    const rows = this.db.all<ChunkRow>(
      `SELECT * FROM kb_chunks
       WHERE collection IN (${collections.map(() => "?").join(",")})
         AND ${VISIBLE_SCOPE_SQL}`,
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
    const qVec = this.embed(query.text);

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
      const cos = cosine(qVec, this.embed(r.text));
      return { row: r, bm25, cos };
    });

    // RRF 融合（无需调参，对两路分数尺度不敏感）
    const rankByBm25 = [...scored].sort((a, b) => b.bm25 - a.bm25).map((s) => s.row.chunk_id);
    const rankByCos = [...scored].sort((a, b) => b.cos - a.cos).map((s) => s.row.chunk_id);
    const rrf = new Map<string, number>();
    const K_RRF = 60;
    rankByBm25.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (K_RRF + i + 1)));
    rankByCos.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (K_RRF + i + 1)));

    const fused = scored
      .map((s) => ({ ...s, score: rrf.get(s.row.chunk_id) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    const pool = fused.slice(0, Math.max(topK, this.config.retrieval.rerankPoolSize));

    // 重排
    let reranked = false;
    let degraded: RetrievalResult["degraded"];
    let ordered: { row: ChunkRow; bm25: number; cos: number; score: number; rerankScore?: number }[] = pool;

    const rr = this.rerankOptions();
    if (query.rerank !== false && rr && pool.length > 1) {
      const now = Date.now();
      if (now < this.rerankCooldownUntil) {
        degraded = {
          reason: "E-KB-001",
          note: `重排处于 ${Math.ceil((this.rerankCooldownUntil - now) / 1000)}s 冷却中（上次失败：${this.lastRerankError ?? "未知"}），本次按融合原序返回`,
        };
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
          degraded = {
            reason: "E-KB-001",
            note: `重排失败（${msg}），已降级为融合原序，并进入 ${Math.round(rr.cooldownMs / 1000)}s 冷却`,
          };
        }
      }
    }

    const hits: RetrievalHit[] = ordered.slice(0, topK).map((s) => ({
      chunk: this.toChunk(s.row),
      score: s.score,
      ...(s.rerankScore !== undefined ? { rerankScore: s.rerankScore } : {}),
      citation: this.toCitation(s.row),
    }));

    return { hits, reranked, ...(degraded ? { degraded } : {}) };
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

  private embed(text: string): Float32Array {
    const cached = this.embedCache.get(text);
    if (cached) return cached;
    const v = hashEmbed(text);
    if (this.embedCache.size > 5000) this.embedCache.clear();
    this.embedCache.set(text, v);
    return v;
  }

  /** 台账/血缘用：记录一次检索的输入摘要 */
  static citationNote(hits: RetrievalHit[]): string {
    return hits.map((h) => `${h.citation.sourceId}#${h.chunk.chunkId}`).join(", ");
  }
}

export const ingestStamp = (): string => nowIso();

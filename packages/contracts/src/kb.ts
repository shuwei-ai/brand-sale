/**
 * M7 KnowledgeService / M8 PricingStore 的对外契约
 */

import type { DataTier, Money } from "./common.ts";
import type { KbSourceTypeValue } from "./governance.ts";

/** 四个库的分工（LLD §2.7） */
export type KbCollection =
  /** 客户授权平台数据（千川/星图/蒲公英/生意参谋等） */
  | "KB-1"
  /** 历史执行与私域知识（投放复盘、达人履约、合同） */
  | "KB-2"
  /** 行业公开情报（巨量算数等公开聚合、行业报告） */
  | "KB-3"
  /** 方法论与案例模板（打法库、模板、SOP） */
  | "KB-4";

export const KB_LABEL: Record<KbCollection, string> = {
  "KB-1": "客户授权平台效果库",
  "KB-2": "历史执行与私域知识库",
  "KB-3": "行业公开情报库",
  "KB-4": "方法论与案例模板库",
};

export interface KbChunk {
  chunkId: string;
  docId: string;
  collection: KbCollection;
  tenantId: string;
  /** 允许为 null 表示跨租户共享的公开情报（L3） */
  text: string;
  sourceId: string;
  sourceType: KbSourceTypeValue;
  tier: DataTier;
  /** 该 chunk 支撑的样本量（用于置信度） */
  sampleSize: number;
  /** 数据新鲜度 */
  publishedAt: string;
  humanVerified: boolean;
  meta: Record<string, string | number | boolean>;
}

export interface KbDocument {
  docId: string;
  title: string;
  collection: KbCollection;
  sourceId: string;
  mime: string;
  byteSize: number;
  chunkCount: number;
  ingestedAt: string;
}

/** 引用：报告中每一个数字都必须挂 citation（强制不变量） */
export interface Citation {
  id: string;
  sourceId: string;
  sourceName: string;
  tier: DataTier;
  collectedAt: string;
  /** 人类可读的取数说明，例如「千川-店铺自有-近90天」 */
  note: string;
}

export interface RetrievalHit {
  chunk: KbChunk;
  /** 混合检索分（BM25 ⊕ 向量），未重排前 */
  score: number;
  /** 重排分，重排被跳过时为 undefined */
  rerankScore?: number;
  citation: Citation;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  /** 重排是否实际生效 */
  reranked: boolean;
  degraded?: { reason: string; note: string };
}

export interface RetrievalQuery {
  text: string;
  collections?: KbCollection[];
  topK?: number;
  /** 仅返回该租户可见内容（跨租户内容需 tenantId=null 且 tier=L3） */
  tenantId: string;
  rerank?: boolean;
}

export interface IKnowledgeService {
  ingest(chunks: KbChunk[], ctx: { tenantId: string; jobId?: string; traceId: string }): Promise<{ ingested: number; rejected: number }>;
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
  stats(tenantId: string): Promise<{ collection: KbCollection; chunks: number }[]>;
}

/* ── 置信度（LLD §3.4.2） ───────────────────────────────── */

export type ConfidenceTier = "high" | "medium" | "low";

export interface ConfidenceInput {
  sourceType: KbSourceTypeValue;
  sampleSize: number;
  ageDays: number;
  humanVerified: boolean;
  /** 多源交叉一致度 0..1 */
  crossSourceAgreement?: number;
}

export interface ConfidencePresentation {
  label: string;
  color: "green" | "amber" | "red";
  disclaimer: boolean;
  /** low 档要求的加粗免责声明 */
  strongDisclaimer?: boolean;
}

export interface IConfidencePolicy {
  score(input: ConfidenceInput): number;
  tier(score: number): ConfidenceTier;
  presentation(tier: ConfidenceTier): ConfidencePresentation;
}

/* ── M8 报价库 ──────────────────────────────────────────── */

export interface TalentProfile {
  talentId: string;
  platform: "douyin" | "xiaohongshu" | "bilibili" | "weibo";
  nickname: string;
  category: string;
  followers: number;
  /** 近 30 天互动率 */
  engagementRate: number;
}

export interface PricingRecord {
  recordId: string;
  talentId: string;
  /** 平台报价（刊例价） */
  quoted: Money;
  /** 实际成交价，可为空 */
  actual?: Money;
  /** 记录来源 */
  sourceType: KbSourceTypeValue;
  observedAt: string;
  humanVerified: boolean;
}

export interface PricingQuery {
  platform?: string;
  category?: string;
  followersMin?: number;
  followersMax?: number;
  topK?: number;
}

export interface PricingEstimate {
  talentId: string;
  /** 估计成交价 */
  estimate: Money;
  /** 估计区间（三档情景的下界/上界） */
  range: { low: Money; high: Money };
  /** 基于几条样本 */
  basis: number;
  confidence: ConfidenceTier;
  citations: Citation[];
}

export interface IPricingStore {
  upsertTalent(t: TalentProfile): Promise<void>;
  addPricing(r: PricingRecord): Promise<void>;
  query(q: PricingQuery): Promise<TalentProfile[]>;
  estimate(talentId: string, tenantId: string): Promise<PricingEstimate | null>;
}

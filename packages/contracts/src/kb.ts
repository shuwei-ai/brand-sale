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

/** 运行时校验用。与 KbCollection 同源（用 satisfies 锁住，避免两处写歪）。 */
export const KB_COLLECTIONS = ["KB-1", "KB-2", "KB-3", "KB-4"] as const satisfies readonly KbCollection[];

/** 允许写入跨租户共享作用域的库：只有公开情报与方法论，不含客户私有数据 */
export const GLOBAL_WRITABLE_COLLECTIONS = ["KB-3", "KB-4"] as const satisfies readonly KbCollection[];

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

/* ── 文档入库（P1-5） ───────────────────────────────────── */

/**
 * 切分参数。
 *
 * 为什么要有"重叠"：中文长文档里一句话的因果关系常跨段落边界，
 * 硬切会把「因为 A，所以 B」拆到两个 chunk，检索时只召回半句。
 * 重叠区让边界句在两个块里都完整出现。
 */
export interface ChunkOptions {
  /** 目标块长度（字符）。默认 400 —— 约 1 个自然段，检索粒度与上下文完整性的折中 */
  targetChars?: number;
  /** 硬上限。单句超过它才允许硬切，避免正文被切碎。默认 800 */
  maxChars?: number;
  /** 相邻块重叠字符数。默认 80 */
  overlapChars?: number;
}

export interface RawChunk {
  index: number;
  /** 已带标题路径前缀的块文本（前缀提升"章节名"类查询的命中率） */
  text: string;
  /** 该块所属的标题层级路径，如 ["二、竞品格局", "2.1 声量份额"] */
  headingPath: string[];
  /** 从正文里提取到的样本量提示（"样本量 1200"/"n=350" 等），提取不到为 0 */
  sampleSize: number;
}

/**
 * 文档入库入参。
 *
 * 注意：`content` 必须是**已解析的纯文本**。二进制（docx/pdf）由
 * `DocumentParser` 先行解析；解析器不可用时**必须抛错**，
 * 不允许把二进制当文本塞进来——那会产生"看起来像数据"的垃圾 chunk，
 * 且报告会把它当真实语料引用。
 */
export interface IngestDocumentInput {
  title: string;
  collection: KbCollection;
  /** 必须已在来源台账登记且授权有效（由装配层注入的 IngestSourceGuard 校验） */
  sourceId: string;
  mime: string;
  content: string;
  /** 数据新鲜度（ISO8601）。用于置信度的时间衰减 */
  publishedAt: string;
  /** 该文档支撑的样本量；不传则用正文提取值 */
  sampleSize?: number;
  humanVerified?: boolean;
  meta?: Record<string, string | number | boolean>;
  /**
   * 写入**跨租户共享**的全局语料（tenant_id=''）。
   *
   * 只有 KB-3/KB-4 这类公开情报与方法论才允许；KB-1/KB-2 是租户私有数据，
   * 设为 true 会被拒绝——那等于把客户授权数据泄露给所有租户。
   * 网关另有一道 admin 角色限制（能影响所有租户的写入不该对普通用户开放）。
   */
  global?: boolean;
}

export interface IngestDocumentResult {
  docId: string;
  chunks: number;
  rejected: number;
  collection: KbCollection;
  sourceId: string;
  /** 本次是否为覆盖既有同名文档 */
  replaced: boolean;
}

/**
 * 入库来源守卫。
 *
 * 为什么做成注入的函数、而不是让 KnowledgeService 自己查表：
 * 校验需要 `sources` 与 `authz` 两张表的"当前是否生效"语义，
 * 那套语义已经在 AuthzRepo.active() 里实现过一次。在 knowledge 里再写一遍 SQL
 * 就是第二份真相，改一处漏一处。而 knowledge **不能**依赖 governance
 * （会让依赖矩阵多一条边），所以由装配层把校验能力注入进来。
 *
 * 缺省（未注入）时**一律拒绝**——fail-closed：
 * 一个没接校验的入库通道等于没有来源门槛。
 */
export interface IngestSourceVerdict {
  ok: boolean;
  /** ok=false 时面向用户的拒绝原因 */
  reason?: string;
  /** ok=true 时回填到 chunk 上的台账信息 */
  tier?: DataTier;
  sourceType?: KbSourceTypeValue;
  sourceName?: string;
}

export type IngestSourceGuard = (tenantId: string, sourceId: string) => IngestSourceVerdict;

/* ── 切分器（纯函数，零依赖） ───────────────────────────── */

function parseSegments(text: string): { text: string; headingPath: string[] }[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segs: { text: string; headingPath: string[] }[] = [];
  const stack: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) segs.push({ text: t, headingPath: stack.filter(Boolean).slice() });
    buf = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    const md = /^(#{1,6})\s+(.+)$/.exec(line);
    // 中文文档大量使用「一、」「（二）」「2.1」这类序号做结构，Markdown 标题未必存在。
    // 只认长度短的行，避免把正文里以数字开头的句子误判成标题。
    const cjk = line.length <= 40 ? /^(?:第?[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十]+）|\d+(?:\.\d+){0,3}[、.．]\s?)/.exec(line) : null;
    if (md || cjk) {
      flush();
      if (md) {
        const level = md[1]!.length;
        stack.length = Math.min(stack.length, level - 1);
        stack[level - 1] = md[2]!.trim();
      } else {
        stack.length = 1;
        stack[0] = line;
      }
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return segs;
}

const SENTENCE_END = "。！？；!?;";

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "\n") {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
      continue;
    }
    buf += ch;
    if (SENTENCE_END.includes(ch)) {
      out.push(buf.trim());
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

const SAMPLE_PATTERNS: RegExp[] = [
  /样本量\s*[:：]?\s*(\d[\d,]*)/,
  /\bn\s*=\s*(\d[\d,]*)/i,
  /(?:共计|覆盖|基于|抽样)\s*(\d[\d,]*)\s*(?:条|个|份|人|次|样本)/,
];

export function extractSampleSize(text: string): number {
  for (const re of SAMPLE_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

/**
 * 把一份长文本切成可检索的块。
 *
 * 三步：结构切分（标题/空行）→ 单句拆分（只对超长段）→ 按目标长度装填（带重叠）。
 * 纯函数、无 I/O、无依赖，因此可以放在 L0 契约层被各处复用与单测。
 */
export function chunkText(text: string, opts: ChunkOptions = {}): RawChunk[] {
  const target = Math.max(80, opts.targetChars ?? 400);
  const max = Math.max(target, opts.maxChars ?? 800);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? 80, Math.floor(target / 2)));

  const segments = parseSegments(text);
  const units: { text: string; headingPath: string[] }[] = [];
  for (const seg of segments) {
    if (seg.text.length <= max) {
      units.push(seg);
      continue;
    }
    for (const piece of splitSentences(seg.text)) {
      if (piece.length <= max) {
        units.push({ text: piece, headingPath: seg.headingPath });
        continue;
      }
      for (let i = 0; i < piece.length; i += max) {
        units.push({ text: piece.slice(i, i + max), headingPath: seg.headingPath });
      }
    }
  }

  const out: RawChunk[] = [];
  let buf: string[] = [];
  let len = 0;
  let path: string[] = [];
  let hasPrimary = false;

  const flushChunk = () => {
    const body = buf.join("\n").trim();
    if (!body) {
      buf = [];
      len = 0;
      hasPrimary = false;
      return;
    }
    const heading = path.join(" > ");
    out.push({
      index: out.length,
      text: heading ? `${heading}\n${body}` : body,
      headingPath: path.slice(),
      sampleSize: extractSampleSize(body),
    });
    // 只在块确实比重叠区长时才带尾巴，否则会产生整段重复
    const tail = overlap > 0 && body.length > overlap ? body.slice(-overlap) : "";
    buf = tail ? [tail] : [];
    len = tail.length;
    hasPrimary = false;
  };

  for (const u of units) {
    const samePath = !hasPrimary || u.headingPath.join("\u0001") === path.join("\u0001");
    if (len > 0 && (!samePath || len + u.text.length + 1 > target)) flushChunk();
    if (!hasPrimary) {
      path = u.headingPath.slice();
      hasPrimary = true;
    }
    buf.push(u.text);
    len += u.text.length + 1;
  }
  flushChunk();
  return out;
}

/* ── 引用：报告中每一个数字都必须挂 citation（强制不变量） ── */
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
  /** 文档级入库：解析 → 切分 → 来源校验 → 落库（P1-5） */
  ingestDocument(
    input: IngestDocumentInput,
    ctx: { tenantId: string; jobId?: string; traceId: string },
  ): Promise<IngestDocumentResult>;
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

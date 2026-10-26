/**
 * 平台采集证据登记表（P0 报告溯源）。
 *
 * 解决的问题：平台采集的逐条信息（URL / 作者 / 发布时间 / 指标 / 采集时点）
 * 原来只存在于**模型上下文**里 —— `platform_digest` 把 rows 递给模型，模型总结成
 * 一句「小红书声量约 40%（mc_xhs）」之后，条目就永久消失了。报告因此只能说清
 * "数据来自小红书"，说不清"来自哪条帖子"。
 *
 * 这里加一层**机械登记**，它有三个刻意的性质：
 *   1. **不经模型**：`entryId` 由工具在返回前生成并登记，模型只被允许引用它。
 *      所以模型编不出 URL —— 它压根不产生 URL，渲染层拿 entryId 反查。
 *   2. **落 job 维度**：同一 job 的多个阶段（CI 取竞品、CT 取作品）共享一份证据集，
 *      校验与附录都按 job 取。
 *   3. **有上限**：search 一次可能几百条，全量存进产物会让报告资产失控。
 *      上限之外只计数、不保存（截断是显式的，不做静默丢弃）。
 *
 * 存储形态：内存 map（校验用）+ `intel_evidence` 产物（审计用，见 agents.ts）。
 * 不做独立 sqlite 表：证据是 job 的附属产物，随 artifact 一起清理，不需要额外索引。
 */

import type { EvidenceEntry } from "@brandsale/contracts";

/** 单 job 证据上限：500 条 × ~300 字节 ≈ 150KB，是"够用且不失控"的量级 */
export const EVIDENCE_MAX_PER_JOB = 500;
/** 摘录上限：只用于报告内展示与人工核对，不承担全文留存职责 */
export const EVIDENCE_EXCERPT_MAX = 120;
/** 模型写进 IntelOutput.evidences[].quote 的上限（比证据表摘录宽，因为那是给读者看的引文） */
export const EVIDENCE_QUOTE_MAX = 200;

/** 证据条目 id：平台内原始 id 唯一，加平台前缀即可全局唯一且一眼可读 */
export const evidenceIdOf = (platform: string, contentId: string): string => `pf_${platform}_${contentId}`;

/** 算子 → 条目属于内容层还是评论层（决定报告里显示"内容/评论"） */
export const evidenceKindOfOp = (op: string): EvidenceEntry["kind"] => (op === "comments" ? "comment" : "content");

/** 工具返回给模型的 row 里我们关心的那些字段（其余字段不入证据表） */
export interface EvidenceRowInput {
  platform?: unknown;
  platformName?: unknown;
  id?: unknown;
  title?: unknown;
  text?: unknown;
  author?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  metrics?: unknown;
  /** 账号哈希：把主页资料行拼到内容行上要它（不落报告） */
  authorId?: unknown;
  /** 平台原始 UID：报告里给人看的账号标识 */
  uid?: unknown;
}

const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * rows → 证据条目（纯函数，便于单测）。
 *
 * 丢弃规则刻意保守：**没有原始 id 就丢弃** —— entryId 是整条溯源链的主键，
 * 造不出主键的条目留着只会成为一个永远无法被引用的死数据。
 */
export function toEvidenceEntries(
  rows: readonly EvidenceRowInput[],
  opts: { platform?: string; platformName?: string; op?: string; collectedAt?: string } = {},
): EvidenceEntry[] {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const op = opts.op ?? "search";
  const out: EvidenceEntry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const platform = asStr(r.platform) || asStr(opts.platform);
    const contentId = asStr(r.id);
    if (!platform || !contentId) continue;
    const entryId = evidenceIdOf(platform, contentId);
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    const text = asStr(r.text);
    const authorId = asStr(r.authorId);
    const uid = asStr(r.uid);
    out.push({
      entryId,
      platform,
      platformName: asStr(r.platformName) || asStr(opts.platformName) || platform,
      op,
      kind: evidenceKindOfOp(op),
      title: asStr(r.title),
      excerpt: clip(text, EVIDENCE_EXCERPT_MAX),
      author: asStr(r.author),
      url: asStr(r.url),
      publishedAt: asStr(r.publishedAt),
      metrics: metricsOf(r.metrics),
      collectedAt,
      // 两个字段都是可选的：老产物里没有它们，读侧必须能接受缺省（不写空串）
      ...(authorId ? { authorId } : {}),
      ...(uid ? { uid } : {}),
    });
  }
  return out;
}

/** 只保留有限数值型指标：指标表里混进字符串会让"可比性"判断失效 */
function metricsOf(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 登记结果：截断了多少条要显式告诉调用方，不做静默丢弃 */
export interface EvidenceRecordResult {
  added: number;
  truncated: number;
  total: number;
}

export class EvidenceRegistry {
  private readonly byJob = new Map<string, EvidenceEntry[]>();
  private readonly truncated = new Map<string, number>();

  constructor(private readonly limit = EVIDENCE_MAX_PER_JOB) {}

  /** 登记一批证据（按 entryId 去重；超出上限的只计数不保存） */
  record(jobId: string, entries: readonly EvidenceEntry[]): EvidenceRecordResult {
    const cur = this.byJob.get(jobId) ?? [];
    const seen = new Set(cur.map((e) => e.entryId));
    let added = 0;
    let truncated = this.truncated.get(jobId) ?? 0;
    for (const e of entries) {
      if (seen.has(e.entryId)) continue;
      if (cur.length >= this.limit) {
        truncated += 1;
        continue;
      }
      seen.add(e.entryId);
      cur.push(e);
      added += 1;
    }
    this.byJob.set(jobId, cur);
    this.truncated.set(jobId, truncated);
    return { added, truncated, total: cur.length };
  }

  list(jobId: string): EvidenceEntry[] {
    return this.byJob.get(jobId) ?? [];
  }

  /** R13 校验用的存在性集合 */
  entryIds(jobId: string): Set<string> {
    return new Set(this.list(jobId).map((e) => e.entryId));
  }

  truncatedCount(jobId: string): number {
    return this.truncated.get(jobId) ?? 0;
  }

  clear(jobId: string): void {
    this.byJob.delete(jobId);
    this.truncated.delete(jobId);
  }
}

/**
 * M8 PricingStore：达人报价的结构化查询与偏差收敛
 *
 * 关键设计（对应 PRD 的「报价偏差收敛」）：刊例价与实际成交价分开存，
 * 估计值优先用实际成交（回归到均值）；样本不足时给区间而非点估计，
 * 并按样本量落置信度档。
 */

import {
  type Citation,
  type IPricingStore,
  type PricingEstimate,
  type PricingQuery,
  type PricingRecord,
  type TalentProfile,
  type Money,
} from "@brandsale/contracts";
import type { Db } from "@brandsale/storage";
import { newId, nowIso } from "@brandsale/storage";
import { ConfidencePolicy, ageInDays } from "./confidence.ts";

export class PricingStore implements IPricingStore {
  private readonly confidence = new ConfidencePolicy();

  constructor(private readonly db: Db) {}

  async upsertTalent(t: TalentProfile): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO talents (talent_id, platform, nickname, category, followers, engagement_rate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      t.talentId,
      t.platform,
      t.nickname,
      t.category,
      t.followers,
      t.engagementRate,
      nowIso(),
    );
  }

  async addPricing(r: PricingRecord): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO pricing (record_id, talent_id, quoted_amount, actual_amount, currency, source_type, observed_at, human_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      r.recordId || newId("prc"),
      r.talentId,
      r.quoted.amount,
      r.actual ? r.actual.amount : null,
      r.quoted.currency,
      r.sourceType,
      r.observedAt,
      r.humanVerified ? 1 : 0,
    );
  }

  async query(q: PricingQuery): Promise<TalentProfile[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.platform) {
      where.push("platform = ?");
      params.push(q.platform);
    }
    if (q.category) {
      where.push("category = ?");
      params.push(q.category);
    }
    if (q.followersMin !== undefined) {
      where.push("followers >= ?");
      params.push(q.followersMin);
    }
    if (q.followersMax !== undefined) {
      where.push("followers <= ?");
      params.push(q.followersMax);
    }
    const rows = this.db.all<{
      talent_id: string;
      platform: string;
      nickname: string;
      category: string;
      followers: number;
      engagement_rate: number;
    }>(
      `SELECT * FROM talents ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY followers DESC LIMIT ?`,
      ...params,
      q.topK ?? 20,
    );
    return rows.map((r) => ({
      talentId: r.talent_id,
      platform: r.platform as TalentProfile["platform"],
      nickname: r.nickname,
      category: r.category,
      followers: r.followers,
      engagementRate: r.engagement_rate,
    }));
  }

  async estimate(talentId: string, _tenantId: string): Promise<PricingEstimate | null> {
    const rows = this.db.all<{
      record_id: string;
      quoted_amount: number;
      actual_amount: number | null;
      currency: string;
      source_type: string;
      observed_at: string;
      human_verified: number;
    }>("SELECT * FROM pricing WHERE talent_id = ? ORDER BY observed_at DESC", talentId);
    if (rows.length === 0) return null;

    const actuals = rows.filter((r) => r.actual_amount !== null).map((r) => r.actual_amount as number);
    const quotes = rows.map((r) => r.quoted_amount);
    const base = actuals.length > 0 ? median(actuals) : median(quotes) * 0.78; // 无成交数据时按经验折扣收敛
    const spread = actuals.length > 1 ? stddev(actuals) : base * 0.18;

    const newest = rows[0]!;
    const { score, tier } = this.confidence.evaluate({
      sourceType: (actuals.length > 0 ? "l2_execution" : "l3_public") as never,
      sampleSize: rows.length,
      ageDays: ageInDays(newest.observed_at),
      humanVerified: rows.some((r) => r.human_verified === 1),
    });

    const currency = (newest.currency as Money["currency"]) ?? "CNY";
    const citations: Citation[] = rows.slice(0, 5).map((r) => ({
      id: `cit_${r.record_id}`,
      sourceId: `pricing:${talentId}`,
      sourceName: "达人报价库",
      tier: r.actual_amount !== null ? "L2" : "L3",
      collectedAt: r.observed_at,
      note: `刊例 ${r.quoted_amount}${r.actual_amount !== null ? ` / 成交 ${r.actual_amount}` : " / 无成交记录"}`,
    }));

    return {
      talentId,
      estimate: { currency, amount: round2(base) },
      range: { low: { currency, amount: round2(Math.max(0, base - spread * 1.5)) }, high: { currency, amount: round2(base + spread * 1.5) } },
      basis: rows.length,
      confidence: tier,
      citations,
    };
  }

  /** 报价偏差诊断：用于运营看板上「模型估算 vs 实际成交」的收敛曲线 */
  deviationReport(talentId: string): { samples: number; meanAbsPctError: number } {
    const rows = this.db.all<{ quoted_amount: number; actual_amount: number | null }>(
      "SELECT quoted_amount, actual_amount FROM pricing WHERE talent_id = ? AND actual_amount IS NOT NULL",
      talentId,
    );
    if (rows.length === 0) return { samples: 0, meanAbsPctError: 0 };
    const errs = rows.map((r) => Math.abs((r.quoted_amount - (r.actual_amount as number)) / (r.actual_amount as number)));
    return { samples: rows.length, meanAbsPctError: Number((errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(4)) };
  }
}

const round2 = (n: number): number => Number(n.toFixed(2));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

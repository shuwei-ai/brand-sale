/**
 * M4 DataSourceAdapter 数据源适配层（对应 LLD §2.5）
 *
 * **架构约束**：本包只能被 M3 之后的调用链使用（M3 通过工具层间接放行）。
 * 适配器的工厂函数不导出给 AgentPack 之外的模块，由 `createGateBoundAdapterRegistry()`
 * 在装配时注入闸门引用，避免任何模块绕过闸门直连数据源。
 *
 * **当前数据现实**：本包只有**一个**适配器 —— `volc_web_search`（联网检索，见 web-search.ts），
 * 走火山引擎联网搜索 API 抓公开网页，`synthetic: false`。
 *
 * 早先随 Phase 0 纵切一起进来的 5 个合成适配器（千川 / 星图 / 蒲公英 / 生意参谋 / 巨量算数）
 * 已整体移除：它们只输出确定性伪随机数（`synthetic: true`），从未接入真实平台，
 * 留在注册表里只会让报告出现「看起来像实测值的假数据」。
 *
 * 需要某一级平台数据时，正确做法是等客户授权后**新增**一个真实适配器并走完整的
 * 登记 → 授权 → 闸门流程，而不是让模型去公开网页里「调研」自己店铺的 ROI。
 */

import type { DataTier, Degraded, Money } from "@brandsale/contracts";
import type { Config } from "@brandsale/config";
import type { Db } from "@brandsale/storage";
import { parseJson, stringify } from "@brandsale/storage";
import { WEB_SEARCH_SOURCE_ID, createWebSearchAdapter } from "./web-search.ts";

/** 确定性哈希：仅用于缓存键，保证同输入同输出，便于回归与复现 */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface Provenance {
  sourceId: string;
  sourceName: string;
  tier: DataTier;
  /** 是否为合成值。当前唯一的适配器抓的是真实网页，恒为 false */
  synthetic: boolean;
  asOf: string;
  /** 取数口径的人类可读说明，直接写进报告脚注 */
  note: string;
  rowCount: number;
}

export interface DataResult<T> {
  rows: T[];
  provenance: Provenance;
  degraded?: Degraded;
}

export interface DataSourceQuery {
  tenantId: string;
  jobId: string;
  /** 平台 → 类目 → 指标 */
  platform?: string;
  category?: string;
  metric?: string;
  window?: { from: string; to: string };
  limit?: number;
  /** 透传的业务参数 */
  params?: Record<string, unknown>;
}

export interface DataSourceAdapter {
  sourceId: string;
  displayName: string;
  tier: DataTier;
  /** 该源能提供哪些指标 */
  capabilities: string[];
  /** 结果缓存 TTL（秒）。缺省 3600。网页检索等时效性强的源应调小 */
  cacheTtlSeconds?: number;
  /** 实际取数。抛错由 M10 的工具层统一处理为降级 */
  fetch(query: DataSourceQuery, config: Config): Promise<DataResult<Record<string, unknown>>>;
}

/* ── 缓存包装 ───────────────────────────────────────────── */

export function withCache(db: Db, adapter: DataSourceAdapter, ttlSeconds: number): DataSourceAdapter {
  return {
    ...adapter,
    async fetch(query, config) {
      const key = `adapter:${adapter.sourceId}:${hashSeed(JSON.stringify(query)).toString(36)}`;
      const hit = db.get<{ payload: string; expires_at: string }>(
        "SELECT payload, expires_at FROM external_cache WHERE cache_key = ?",
        key,
      );
      if (hit && hit.expires_at > new Date().toISOString()) {
        const parsed = parseJson<{ rows: Record<string, unknown>[]; provenance: Provenance }>(hit.payload, { rows: [], provenance: {} as Provenance });
        return {
          rows: parsed.rows,
          provenance: { ...parsed.provenance, note: `${parsed.provenance.note}（命中缓存）` },
        };
      }
      const res = await adapter.fetch(query, config);
      db.run(
        "INSERT OR REPLACE INTO external_cache (cache_key, payload, expires_at) VALUES (?, ?, ?)",
        key,
        stringify({ rows: res.rows, provenance: res.provenance }),
        new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      );
      return res;
    },
  };
}

/* ── 注册表 ─────────────────────────────────────────────── */

export class DataSourceRegistry {
  private readonly map = new Map<string, DataSourceAdapter>();

  constructor(adapters: DataSourceAdapter[]) {
    for (const a of adapters) {
      this.map.set(a.sourceId, a);
    }
  }

  get(sourceId: string): DataSourceAdapter | undefined {
    return this.map.get(sourceId);
  }

  require(sourceId: string): DataSourceAdapter {
    const a = this.map.get(sourceId);
    if (!a) throw new Error(`未注册的数据源适配器: ${sourceId}`);
    return a;
  }

  list(): DataSourceAdapter[] {
    return [...this.map.values()];
  }

  /** 按分级筛出可用源（L4 由闸门再判一次双开关） */
  byTier(tiers: DataTier[]): DataSourceAdapter[] {
    return this.list().filter((a) => tiers.includes(a.tier));
  }
}

/**
 * 装配注册表。
 *
 * 联网检索是**唯一**的真实外部源，同时是**可选能力**：没配 API Key 就不注册适配器，
 * 下游（M10 工具层）据此判断「能力是否就绪」，未就绪则不把 web_search 暴露给 Agent，
 * 避免 Agent 反复调用一个必然失败的工具、把预算烧在重试上。
 */
export function createRegistry(db: Db, config: Config): DataSourceRegistry {
  const webSearch = config.webSearch.enabled && config.webSearch.apiKey ? [createWebSearchAdapter(config)] : [];
  const adapters = webSearch.map((a) => withCache(db, a, a.cacheTtlSeconds ?? 3600));
  return new DataSourceRegistry(adapters);
}

/** 聚合多源结果，用于竞品情报阶段 */
export function mergeProvenance(list: Provenance[]): { sources: Provenance[]; anySynthetic: boolean } {
  return { sources: list, anySynthetic: list.some((p) => p.synthetic) };
}

export const money = (amount: number): Money => ({ currency: "CNY", amount });

/* ── 联网检索（唯一的真实外部源） ───────────────────────── */

export { createWebSearchAdapter, WEB_SEARCH_SOURCE_ID } from "./web-search.ts";
export type { WebSearchItem } from "./web-search.ts";

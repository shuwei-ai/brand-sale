/**
 * M4 DataSourceAdapter 数据源适配层（对应 LLD §2.5）
 *
 * **架构约束**：本包只能被 M3 之后的调用链使用（M3 通过工具层间接放行）。
 * 适配器的工厂函数不导出给 AgentPack 之外的模块，由 `createGateBoundAdapterRegistry()`
 * 在装配时注入闸门引用，避免任何模块绕过闸门直连数据源。
 *
 * **当前数据现实**：本包有**两类**适配器，全部 `synthetic: false`，全部按 L3 处理：
 *   1. `volc_web_search` —— 联网检索（web-search.ts），火山引擎联网搜索 API 抓公开网页；
 *   2. `mc_xhs` / `mc_dy` / `mc_ks` / `mc_bili` / `mc_wb` / `mc_tieba` / `mc_zhihu`
 *      —— 七平台公开内容采集（media-crawler.ts），经 `apps/collector` sidecar
 *      复用 MediaCrawler。每个平台一个源，按 `config.mediaCrawler.platforms` 逐个装配。
 *
 * 两类都是"公开但未经人工核验"，分级是 L3、**不是 L1**：与平台之间不存在授权合同，
 * 标成 L1 等于把公开采集洗成甲方授权实测。L3 源还禁止填 contractRef
 * （governance 的 assertSourceRegistration 会以 E-GOV-005 从写入口拦下）。
 *
 * ⚠️ 七个平台源的装配还多一道**许可证闸**：MediaCrawler 为非商用许可，
 * 只有 `config.mediaCrawler.licenseAcknowledged === true` 时才会装配（见 media-crawler.ts 文件头）。
 * 未开启时它们整体缺席，报告如实写"无平台数据"——这比留一条"看起来有平台数据"的
 * 窄通道、却让人误以为是授权实测更安全。
 *
 * 真正的 L1（抖音开放平台 fans_data 粉丝画像）需要企业主体 + 权限审批 + 达人 OAuth，
 * 未就绪之前**不注册**——这也是下面这段历史教训的延续：
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
import { createMediaCrawlerAdapters } from "./media-crawler.ts";

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
  /** 是否为合成值。当前所有适配器抓的都是真实外部内容，恒为 false */
  synthetic: boolean;
  asOf: string;
  /** 取数口径的人类可读说明，直接写进报告脚注 */
  note: string;
  rowCount: number;
  /**
   * 本次取数是**命中本地缓存**还是真打了一次外部源。
   *
   * 为什么要有这个结构化字段：下游台账原来靠 `note.includes("缓存")` 判断，
   * 而采集侧的说明里有一句"本次无本地缓存，已排队采集" —— 于是**未命中被记成命中**
   * （实测台账 mc_xhs cached=true 却 rowCount=0）。缓存命中率是运营指标，
   * 靠文案匹配迟早会错，命中与否只有缓存包装层自己知道。
   */
  cacheHit?: boolean;
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
          provenance: { ...parsed.provenance, cacheHit: true, note: `${parsed.provenance.note}（命中缓存）` },
        };
      }
      const res = await adapter.fetch(query, config);
      /* **空结果不进缓存**。
       *
       * 采类适配器（媒体采集、联网检索）返回空，最常见的两种原因是
       * "还没采过 / 还没配好"，都是**临时状态**而不是结论。一旦把空结果按
       * TTL（30 分钟）缓存下来，"首次调用排队采集 → 稍后重试"这条自愈路径
       * 就会被自己的缓存堵死：重试仍然命中那条空缓存，永远等不到数据。
       * 所以只缓存有内容的响应。代价是空结果会让下游多打一次适配器，
       * 但这个代价远小于"看起来永远没数据"。 */
      const stamped: DataResult<Record<string, unknown>> = { ...res, provenance: { ...res.provenance, cacheHit: false } };
      if (res.rows.length === 0) return stamped;
      db.run(
        "INSERT OR REPLACE INTO external_cache (cache_key, payload, expires_at) VALUES (?, ?, ?)",
        key,
        stringify({ rows: res.rows, provenance: res.provenance }),
        new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      );
      return stamped;
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
 * 两类外部源，各自**按就绪条件**装配，未就绪就整体不注册，下游（M10 工具层）据此
 * 判断「能力是否就绪」，未就绪则不把对应工具暴露给 Agent —— 避免 Agent 反复调用
 * 一个必然失败的工具、把预算烧在重试上。
 *
 * 就绪条件刻意不同，因为凭据形态不同：
 *   · web_search：`enabled && apiKey`（火山引擎按 Key 计费，没 Key 就是没能力）
 *   · 平台采集：`enabled && licenseAcknowledged && collectorBaseUrl`，且逐平台看开关
 *     （自托管 sidecar，地址在则能力在；许可确认是硬门槛，见 media-crawler.ts 文件头）
 */
export function createRegistry(db: Db, config: Config): DataSourceRegistry {
  const webSearch = config.webSearch.enabled && config.webSearch.apiKey ? [createWebSearchAdapter(config)] : [];
  const mediaCrawler = createMediaCrawlerAdapters(config);
  const adapters = [...webSearch, ...mediaCrawler].map((a) => withCache(db, a, a.cacheTtlSeconds ?? 3600));
  return new DataSourceRegistry(adapters);
}

/** 聚合多源结果，用于竞品情报阶段 */
export function mergeProvenance(list: Provenance[]): { sources: Provenance[]; anySynthetic: boolean } {
  return { sources: list, anySynthetic: list.some((p) => p.synthetic) };
}

export const money = (amount: number): Money => ({ currency: "CNY", amount });

/* ── 联网检索 ───────────────────────────────────────────── */

export { createWebSearchAdapter, WEB_SEARCH_SOURCE_ID } from "./web-search.ts";
export type { WebSearchItem } from "./web-search.ts";

/* ── 七平台公开内容采集（MediaCrawler / collector sidecar）── */

export {
  createMediaCrawlerAdapter,
  createMediaCrawlerAdapters,
  mediaCrawlerReady,
  mediaCrawlerPlatformReady,
  MEDIA_CRAWLER_SOURCE_IDS,
  /** rows 里的"作者主页资料行"标记（粉丝量等）：下游据此与内容行分流 */
  CREATOR_ROW_TYPE,
} from "./media-crawler.ts";

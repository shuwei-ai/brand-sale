/**
 * M4 平台内公开内容采集适配器（复用 MediaCrawler，经 collector sidecar）。
 *
 * 每个平台一个适配器（`mc_xhs` / `mc_dy` / ... 共七个），全部 **L3**：
 *   这些数据本身公开可见，但与平台之间**不存在任何授权合同**，且未经人工核验。
 *   所以 provenance.note 必须如实写明"公开采集、未经核验"，报告里只能支撑
 *   "关于他人"的公开断言，不能当作甲方自身的实测经营数据。
 *
 * ⚠️ **许可证红线**：底层是 MediaCrawler，其许可证为
 * `NON-COMMERCIAL LEARNING LICENSE 1.1`，条件第 3 条禁止未经版权方书面同意的
 * 商业用途。因此适配器**只有在 `config.mediaCrawler.licenseAcknowledged === true`
 * 时才装配**——把"引入一个非商用组件"固化成一次必须显式做的决定，
 * 而不是顺手配个地址就悄悄生效。未开启时七个适配器与七个工具一律缺席，
 * 报告会如实写"无平台数据"。
 *
 * 为什么适配器只打 collector、不直连 MediaCrawler：
 *   MediaCrawler 的 HTTP 面是**任务控制面**（起任务 → 子进程跑 Playwright →
 *   结果落盘），单进程串行、分钟级，与 `fetch(query)` 的同步语义根本对不上。
 *   collector 把"采"与"查"解耦：采集异步发生一次，查询读它的本地归一化缓存。
 *   适配器因此保持同步、快速、可缓存，和 web_search 的形状一致。
 */

import {
  MEDIA_CRAWLER_PLATFORM_META,
  MEDIA_CRAWLER_PLATFORMS,
  type CollectOp,
  type MediaCrawlerPlatform,
} from "@brandsale/config";
import type { Config } from "@brandsale/config";
import type { DataResult, DataSourceAdapter, Provenance } from "./index.ts";

/** collector 的 /query 响应 */
interface CollectorQueryResponse {
  platform?: string;
  rows?: Record<string, unknown>[];
  /**
   * 这批内容所属作者的**个人主页资料**（粉丝数 / 关注数 / 主页链接）。
   * 由 collector 在 op=search 时按作者拼上来（见 apps/collector/src/server.ts:POST /query）
   * —— 内容行里没有粉丝数，这是报告"粉丝量"一列的唯一真实来源。
   */
  creators?: Record<string, unknown>[];
  meta?: { total?: number; returned?: number; creatorCount?: number; collectedAt?: string | null; sourceId?: string };
}

/** 资料行在 `rows` 里的类型标记：下游据此把它们与内容行分开处理 */
export const CREATOR_ROW_TYPE = "creator";

/**
 * 采集链路是否就绪。三道门缺一不可：
 *   1. `enabled` —— 总开关；
 *   2. `licenseAcknowledged` —— 许可红线（见文件头）；
 *   3. `collectorBaseUrl` —— sidecar 地址（地址在则能力在，与 web_search 看 apiKey 同理）。
 */
export function mediaCrawlerReady(config: Config): boolean {
  return (
    config.mediaCrawler.enabled &&
    config.mediaCrawler.licenseAcknowledged &&
    Boolean(config.mediaCrawler.collectorBaseUrl)
  );
}

/** 某个平台是否已就绪（总开关 + 该平台开关） */
export function mediaCrawlerPlatformReady(config: Config, platform: MediaCrawlerPlatform): boolean {
  return mediaCrawlerReady(config) && config.mediaCrawler.platforms[platform] === true;
}

async function callCollector(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      // 归一化超时措辞：M10 按 /超时|timeout/ 判 E-DATA-001，否则会被当成 E-DATA-002
      throw new Error(`采集服务超时（${timeoutMs}ms）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const truthy = (v: unknown): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : null;
};

export function createMediaCrawlerAdapter(platform: MediaCrawlerPlatform, config: Config): DataSourceAdapter {
  const meta = MEDIA_CRAWLER_PLATFORM_META[platform];
  const { collectorBaseUrl, timeoutMs, cacheTtlSeconds } = config.mediaCrawler;

  return {
    sourceId: meta.sourceId,
    displayName: `平台公开内容·${meta.displayName}（MediaCrawler 采集）`,
    tier: "L3",
    capabilities: meta.ops.map((op) => `${platform}:${op}`),
    cacheTtlSeconds,

    async fetch(query): Promise<DataResult<Record<string, unknown>>> {
      const op = truthy(query.params?.op) as CollectOp | null;
      if (!op || !meta.ops.includes(op)) {
        throw new Error(
          `${meta.displayName}采集缺少合法算子（params.op）。可选：${meta.ops.join(" / ")}`,
        );
      }

      // 过滤词按算子取：搜索用关键词，详情/评论用内容 ID，创建者用创建者 ID
      const keyword =
        op === "search"
          ? (truthy(query.params?.keyword) ?? truthy(query.metric))
          : op === "creator"
            ? truthy(query.params?.creatorId)
            : (truthy(query.params?.contentId) ?? truthy(query.params?.url));
      if (!keyword) {
        throw new Error(`${meta.displayName} ${op} 缺少必要参数（${op === "search" ? "keyword" : op === "creator" ? "creatorId" : "contentId"}）`);
      }

      const limit = query.limit && query.limit > 0 ? query.limit : 20;
      /* 点名要哪些作者的资料行（`authorIds` = creator_hash 列表）。
       * 不传就沿用「只拼本批 rows 的作者」—— 那条默认路径在 `limit` 截断面前会漏人，
       * 见 collector/src/server.ts 的注释与 2026-10-20 真机事故。 */
      const authorIds = Array.isArray(query.params?.authorIds)
        ? (query.params.authorIds as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];
      const resp = await callCollector(
        collectorBaseUrl,
        "/query",
        { platform, op, keyword, limit, ...(authorIds.length > 0 ? { authorIds } : {}) },
        timeoutMs,
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`采集服务 HTTP ${resp.status}：${body.slice(0, 200)}`);
      }
      const json = (await resp.json()) as CollectorQueryResponse;
      const contentRows = json.rows ?? [];
      // 作者主页资料行：附在 rows 尾部并打上 rowType，**由下游分流**（内容行做声量与
      // 内容分析，资料行只提供粉丝数/主页链接）。混在一起不做标记会让"粉丝数"被当成
      // 内容指标参与横向对比，那是错的。
      const creatorRows = (json.creators ?? []).map((c) => ({ ...c, rowType: CREATOR_ROW_TYPE }));
      const rows = [...contentRows, ...creatorRows];
      const collectedAt = json.meta?.collectedAt ?? null;

      // 缓存里没有这批数据时，**后台排队一次采集**，让"下一次调用"有结果。
      // 采集本身是分钟级的，不能在这里同步等（会撞上工具超时），所以只投递、不等待。
      let queued = false;
      if (contentRows.length === 0) {
        queued = await dispatchCollect(collectorBaseUrl, platform, op, query, config);
      }

      const provenance: Provenance = {
        sourceId: meta.sourceId,
        sourceName: `平台公开内容·${meta.displayName}`,
        tier: "L3",
        // 真实采集到的平台公开内容，不是合成值；但未经人工核验，见 note
        synthetic: false,
        asOf: collectedAt ?? new Date().toISOString(),
        note:
          `${meta.displayName}平台内公开内容（${op}），经 MediaCrawler 采集、未经人工核验；` +
          `与平台无授权合同，引用须标注为公开来源` +
          (creatorRows.length > 0 ? `；含 ${creatorRows.length} 位作者的个人主页公开统计（粉丝数等）` : "") +
          (contentRows.length === 0 && queued ? "；本次无本地缓存，已排队采集，请稍后重试" : ""),
        rowCount: rows.length,
      };

      return { rows, provenance };
    },
  };
}

/** 投递一次采集（不等待结果）。collector 忙或有同名任务在跑时返回 false，属正常 */
async function dispatchCollect(
  baseUrl: string,
  platform: MediaCrawlerPlatform,
  op: CollectOp,
  query: { params?: Record<string, unknown>; limit?: number },
  config: Config,
): Promise<boolean> {
  const params: Record<string, unknown> = {};
  if (op === "search") params.keyword = truthy(query.params?.keyword) ?? truthy(query.params?.query) ?? "";
  else if (op === "creator") params.creatorId = truthy(query.params?.creatorId) ?? "";
  else {
    params.contentId = truthy(query.params?.contentId) ?? truthy(query.params?.url) ?? "";
  }
  try {
    const resp = await callCollector(
      config.mediaCrawler.collectorBaseUrl,
      "/collect",
      { platform, op, params, maxItems: query.limit && query.limit > 0 ? query.limit : undefined },
      Math.min(config.mediaCrawler.timeoutMs, 8000),
    );
    return resp.status === 202;
  } catch {
    // 投递失败不影响本次查询：仍返回空行 + 说明。下次调用会再试
    return false;
  }
}

/**
 * 装配全部已就绪的平台适配器。
 *
 * **按平台注册**而不是一个大适配器：每个平台的台账、授权、工具绑定都是独立的，
 * 只登录了抖音时不该让小红书也出现在可用源里——那会让报告多出"小红书可用但无数据"
 * 的假象。未启用的平台直接不注册，对应工具也随之缺席。
 */
export function createMediaCrawlerAdapters(config: Config): DataSourceAdapter[] {
  if (!mediaCrawlerReady(config)) return [];
  return MEDIA_CRAWLER_PLATFORMS.filter((p) => config.mediaCrawler.platforms[p]).map((p) =>
    createMediaCrawlerAdapter(p, config),
  );
}

/** 供 seed / 测试使用：全部七源的 sourceId（与平台开关无关） */
export const MEDIA_CRAWLER_SOURCE_IDS = MEDIA_CRAWLER_PLATFORMS.map((p) => MEDIA_CRAWLER_PLATFORM_META[p].sourceId);

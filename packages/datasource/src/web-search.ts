/**
 * M4 联网检索适配器 —— 火山引擎「联网搜索 Lite」
 *
 * 为什么把它做成**数据源适配器**而不是直接写在工具里：
 *   1. 它是一条新的信息入口，就必须和其他源一样进台账（sources / authz），
 *      由 M3 闸门按 scope → source → authz → tenant 检查后才放行；
 *   2. 它要返回标准 `Provenance`，报告层的引用分级才能判得出来；
 *   3. 装配期若未配置 API Key，适配器不存在 → 工具也不注册，
 *      Agent 的工具清单里就不会出现一个注定失败的工具。
 *
 * 分级：L3（公开）。注意 L3 的语义是「公开指数与人工核验」，
 * 网页检索结果是公开但**未经人工核验**的，所以 provenance.note 里必须写明，
 * 引用时也要带站点名，不允许当成 L1/L2 事实基准使用。
 */

import type { Config } from "@brandsale/config";
import type { DataResult, DataSourceAdapter, Provenance } from "./index.ts";

/** 台账与工具绑定都引用这个常量，避免两处字符串漂移 */
export const WEB_SEARCH_SOURCE_ID = "volc_web_search";

/** 一条检索结果。字段名即火山返回字段，保留原始大小写便于对账 */
export interface WebSearchItem {
  title: string;
  siteName: string;
  url: string;
  publishTime: string;
  snippet: string;
  summary: string;
}

interface VolcWebResult {
  Id?: string;
  SortId?: number;
  Title?: string;
  SiteName?: string;
  Url?: string;
  Snippet?: string;
  Summary?: string;
  PublishTime?: string;
}

interface VolcSearchResponse {
  ResponseMetadata?: { RequestId?: string; Error?: { Code?: string; Message?: string } };
  Result?: { ResultCount?: number; WebResults?: VolcWebResult[] };
}

const clamp = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;

export function createWebSearchAdapter(config: Config): DataSourceAdapter {
  const { baseUrl, apiKey, defaultCount, maxCount, timeoutMs, cacheTtlSeconds } = config.webSearch;

  return {
    sourceId: WEB_SEARCH_SOURCE_ID,
    displayName: "联网搜索（公开网页）",
    tier: "L3",
    capabilities: ["web_search", "industry_news", "platform_policy"],
    cacheTtlSeconds,

    async fetch(query): Promise<DataResult<Record<string, unknown>>> {
      // 查询词走 params.query（自由文本），metric 作为兼容回退
      const text = String(query.params?.query ?? query.metric ?? "").trim();
      if (!text) throw new Error("联网检索缺少查询词（params.query 为空）");

      const count = clamp(Number(query.params?.count ?? defaultCount), 1, maxCount);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            Query: text,
            SearchType: "web",
            Count: count,
            Filter: { NeedContent: false, NeedUrl: true },
            QueryControl: { QueryRewrite: false },
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new Error(`联网检索 HTTP ${resp.status}：${body.slice(0, 200)}`);
        }

        const json = (await resp.json()) as VolcSearchResponse;
        const apiError = json.ResponseMetadata?.Error;
        if (apiError) {
          throw new Error(`联网检索 API 错误 code=${apiError.Code ?? "?"} message=${apiError.Message ?? ""}`);
        }

        const items: WebSearchItem[] = (json.Result?.WebResults ?? []).map((w) => ({
          title: w.Title ?? "",
          siteName: w.SiteName ?? "",
          url: w.Url ?? "",
          publishTime: w.PublishTime ?? "",
          snippet: w.Snippet ?? "",
          summary: w.Summary ?? "",
        }));

        const provenance: Provenance = {
          sourceId: WEB_SEARCH_SOURCE_ID,
          sourceName: "联网搜索（公开网页）",
          tier: "L3",
          // 真实抓取的公开网页，不是合成值；但**未经人工核验**，见 note
          synthetic: false,
          asOf: new Date().toISOString(),
          note: `公开网页检索「${text}」，未经人工核验，引用须标注来源站点`,
          rowCount: items.length,
        };

        return { rows: items as unknown as Record<string, unknown>[], provenance };
      } catch (e) {
        // 归一化超时：M10 按 /超时|timeout/ 判定 E-DATA-001，
        // 否则 AbortError 的原文（"This operation was aborted"）会被误判为 E-DATA-002
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
          throw new Error(`联网检索超时（${timeoutMs}ms）`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

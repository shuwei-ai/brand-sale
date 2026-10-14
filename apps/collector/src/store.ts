/**
 * 采集结果的本地只读缓存。
 *
 * 为什么 collector 需要自己存一份，而不是每次查询都去翻 MediaCrawler 的 data/：
 *   1. **采集慢、查询快**。一次采集要跑 Playwright（几十秒到几分钟），而
 *      brandsale 的工具调用是同步的、带 12s 级超时。必须把"采"与"查"解耦：
 *      采集在后台发生一次，查询读本地缓存、毫秒级返回。
 *   2. **原始 jsonl 是平台字段**，查询侧要的是归一化行。存归一化行就不必每次重算。
 *   3. 采集历史可以留痕：同一条内容被采过两次，保留最新的 collectedAt，可追溯。
 *
 * 存储形态刻意选 JSONL 而不是 sqlite：追加安全（采集中途被杀不会损坏已有数据）、
 * 人类可读、零依赖。数据量级是"报告用到的几十到几千条"，扫描完全够快。
 */

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CollectOp, MediaCrawlerPlatform } from "@brandsale/config";
import type { CollectRow, RowKind } from "./normalize.ts";

interface StoredLine {
  collectedAt: string;
  row: CollectRow;
}

export interface QueryFilter {
  op?: CollectOp;
  kind?: RowKind;
  /**
   * 关键词。两种语义，按算子分：
   *   · `op=search` —— 是**采集用语**：**只**匹配该批采集结果（行的 `raw.source_keyword`）。
   *     搜索词本来就常常不在正文里（`护肤品-精华` 这类类目词，采集回来的笔记正文
   *     一条都不含它），拿它当正文子串过滤等于把刚采到的数据全部判 0。
   *     **查不到就是空**，不再退回子串兜底 —— 见 `query()` 里那段说明：子串兜底会让
   *     别的批次的正文冒充本批命中，而适配器"查询非空就不排队"，于是该关键词永远采不到。
   *   · 其余算子（详情 / 评论 / creator 的入参是内容 id / 达人 id）—— 仍是字段子串匹配。
   */
  keyword?: string;
  limit?: number;
}

export interface QueryResult {
  rows: CollectRow[];
  /** 这批数据里最新一条的采集时间；没有数据则为 null */
  collectedAt: string | null;
  total: number;
}

const rowKey = (r: CollectRow): string => `${r.op}|${r.kind}|${r.id || r.url || r.title}`;

/** 该行是用哪个搜索词采回来的（内核原始记录上的 `source_keyword`），取不到则空串 */
const collectKeywordOf = (r: CollectRow): string => {
  const raw = r.raw as { source_keyword?: unknown } | undefined;
  const v = raw?.source_keyword;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
};

export class CollectStore {
  constructor(private readonly dir: string) {}

  private fileOf(platform: MediaCrawlerPlatform): string {
    return join(this.dir, `${platform}.jsonl`);
  }

  async append(platform: MediaCrawlerPlatform, rows: CollectRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    await mkdir(this.dir, { recursive: true });
    const collectedAt = new Date().toISOString();
    const payload = rows.map((row) => JSON.stringify({ collectedAt, row } satisfies StoredLine)).join("\n");
    await appendFile(this.fileOf(platform), `${payload}\n`, "utf8");
    return rows.length;
  }

  /** 读取某平台全部已缓存行（未去重） */
  private async readAll(platform: MediaCrawlerPlatform): Promise<StoredLine[]> {
    let text: string;
    try {
      text = await readFile(this.fileOf(platform), "utf8");
    } catch {
      return [];
    }
    const out: StoredLine[] = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as StoredLine;
        if (obj?.row) out.push(obj);
      } catch {
        /* 半截行跳过 */
      }
    }
    return out;
  }

  /**
   * 查询。同一条记录被多次采集时**保留最新**（按 collectedAt）。
   * 排序按采集时间倒序，让"最近采到的"排前面——模型通常更关心时效。
   */
  async query(platform: MediaCrawlerPlatform, filter: QueryFilter = {}): Promise<QueryResult> {
    const all = await this.readAll(platform);
    const latest = new Map<string, StoredLine>();
    for (const line of all) {
      if (filter.op && line.row.op !== filter.op) continue;
      if (filter.kind && line.row.kind !== filter.kind) continue;
      const key = rowKey(line.row);
      const prev = latest.get(key);
      // 同刻用 `<=` 让**后写入的**赢：两次采集可能落在同一毫秒，
      // 而文件是追加写的，后出现的行就是更新的一次采集结果。
      if (!prev || prev.collectedAt <= line.collectedAt) latest.set(key, line);
    }

    let rows = [...latest.values()].sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1)).map((l) => l.row);

    const kw = filter.keyword?.trim().toLowerCase();
    if (kw) {
      if (filter.op === "search") {
        /* `op=search` 的关键词是**采集用语**，只认行上记录的采集词（`raw.source_keyword`），
         * **不再退回正文子串**。
         *
         * 两个理由，第二个是 2026-10-14 实测出来的硬伤：
         *   ① 语义：搜 A 就该拿回"用 A 采回来的那一批"。采集用语本来就常常不出现在正文里
         *      （`护肤品-精华` 这类类目词一条正文都不含它），拿正文过滤等于把真数据判 0；
         *   ② 子串兜底会把**别的批次**的正文当成本批命中，而调用方是"查询非空 = 无需采集"
         *      （`packages/datasource/src/media-crawler.ts` 的 `contentRows.length === 0` 才排队）——
         *      于是该关键词**永远采不到真实数据**，报告引用的是别批次的正文。实测 `keyword=电脑`
         *      在 dy/xhs/bili 分别命中 17/39/7 条（抖音侧是"局域网文件夹"这类**评论**、
         *      小红书侧是"折叠屏新王"手机笔记，采集词全是别的词），而三平台**一条**带
         *      `source_keyword=电脑` 的行都不存在。业主看到的报告"电脑市场数据"就是这批噪声。
         *
         * 代价是"没有 source_keyword 的老数据"（字段上线前的行 / 平台内核不回该字段）不再被
         * 关键词搜到 —— 那是**正确**结果：查不到这一批就是没有，由适配器排队一次真实采集补上，
         * 而不是拿别的正文冒充。 */
        rows = rows.filter((r) => collectKeywordOf(r) === kw);
      } else {
        /* 其余算子（详情 / 评论 / creator）的入参是内容 id / 达人 id，仍是字段子串匹配。
         * id 也参与匹配：按 contentId / creatorId 查详情时，命中的就是行的 id 字段 */
        rows = rows.filter((r) =>
          [r.id, r.title, r.text, r.author, r.authorId, r.url].some((f) => f && f.toLowerCase().includes(kw)),
        );
      }
    }

    const total = rows.length;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 0;
    if (limit) rows = rows.slice(0, limit);

    const collectedAt = [...latest.values()].reduce<string | null>(
      (acc, l) => (acc === null || l.collectedAt > acc ? l.collectedAt : acc),
      null,
    );
    return { rows, collectedAt, total };
  }

  /** 各平台已缓存条数（去重后），供 /health 与运维核对 */
  async stats(): Promise<Record<string, number>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return {};
    }
    const out: Record<string, number> = {};
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const platform = name.slice(0, -6) as MediaCrawlerPlatform;
      const lines = await this.readAll(platform);
      out[platform] = new Set(lines.map((l) => rowKey(l.row))).size;
    }
    return out;
  }
}

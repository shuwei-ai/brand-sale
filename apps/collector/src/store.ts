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
   *   · `op=search` —— 是**采集用语**：匹配该批采集结果（行的 `raw.source_keyword`）。
   *     搜索词本来就常常不在正文里（`护肤品-精华` 这类类目词，采集回来的笔记正文
   *     一条都不含它），拿它当正文子串过滤等于把刚采到的数据全部判 0。
   *   · 其余算子（详情 / 评论 / creator 的入参是内容 id / 达人 id）—— 仍是字段子串匹配。
   * 另外 `op=search` 下若没有任何行带采集词（老数据 / 平台没回该字段），
   * 退回子串匹配，避免"改完更差"。
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
      /* 先按"采集用语"匹配（op=search）。**这一步不是优化，是修 bug**：
       * 采集是按 keyword 去平台搜的，落库时把搜索词写在行的 `raw.source_keyword` 上；
       * 但查询侧原来只做正文子串过滤，于是"用 A 搜回来 220 条，再用 A 去查却是 0 条"。
       * 实测：`keyword=护肤品-精华` → 0 条，同一份缓存里 `keyword=面膜` → 4 条。 */
      const byCollect =
        filter.op === "search" ? rows.filter((r) => collectKeywordOf(r) !== "" && collectKeywordOf(r) === kw) : [];
      if (byCollect.length > 0) {
        rows = byCollect;
      } else {
        // 没有行带采集词（老数据 / 该平台内核不回这个字段）→ 退回子串。
        // id 也参与匹配：按 contentId / creatorId 查详情时，命中的就是行的 id 字段
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

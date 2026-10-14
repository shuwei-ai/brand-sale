/**
 * 平台原始记录 → 统一行 的归一化。
 *
 * 为什么需要这一层：MediaCrawler 七个平台各写各的 jsonl，字段名、时间戳单位、
 * 指标命名全不一样（抖音叫 `aweme_id`、小红书叫 `note_id`、B站叫 `bvid`；
 * 抖音点赞叫 `digg_count`，小红书叫 `liked_count`…）。brandsale 的报告与引用
 * 需要一个**形状固定**的行，否则每个下游都要再写一遍平台分支。
 *
 * 两条设计约束：
 *   1. **候选字段表集中在这一处**。平台改字段只改这里，不在业务逻辑里散落 `??`。
 *   2. **原始记录一并保留在 `raw`**。映射表是"尽力而为"，难免有平台改版打偏；
 *      保留原文后，校准只是改候选表，历史数据的核查也不丢。
 *
 * ⚠️ 这份映射表按 MediaCrawler 各平台的**真实落盘字段**校准（小红书已用真机输出逐字段核对）。
 *
 * 两个必须记住的事实（都是真机跑通后才暴露的）：
 *   1. 内核把原始 `user_id` / `uid` / `mid` 一律换成 `creator_hash`，所以 `authorId`
 *      的首选候选是 `creator_hash`，找 `user_id` 永远是空的。昵称则**完整保留**
 *      （brandsale 已关闭内核的昵称脱敏，业主明确要求账号完整显示）。
 *   2. 大数指标是**中文单位的字符串**（`'7.8万'`、`'1.2亿'`），不是数字。
 *      不认这两个单位就会静默丢掉全部点赞量级。
 */

import type { CollectOp, MediaCrawlerPlatform } from "@brandsale/config";

export type RowKind = "content" | "comment" | "creator";

export interface CollectRow {
  platform: MediaCrawlerPlatform;
  op: CollectOp;
  kind: RowKind;
  id: string;
  title: string;
  text: string;
  author: string;
  authorId: string;
  url: string;
  /** ISO 时间；取不到则空串（**不**填当前时间冒充发布时间） */
  publishedAt: string;
  /** 互动指标。键是统一命名，取不到的键不出现（不补 0，避免"0 次点赞"被当真） */
  metrics: Record<string, number>;
  /** 原始记录，保留全部字段供核查与后续校准 */
  raw: Record<string, unknown>;
}

interface FieldMap {
  id: string[];
  title: string[];
  text: string[];
  author: string[];
  authorId: string[];
  url: string[];
  publishedAt: string[];
  /** 统一指标名 → 候选原始键 */
  metrics: Record<string, string[]>;
}

/** 内容类共同用的指标候选（多数平台命名接近，差异写在各平台覆盖里） */
const BASE_CONTENT_METRICS: Record<string, string[]> = {
  likes: ["liked_count", "digg_count", "like_count", "voteup_count", "attitudes_count", "praise_count"],
  comments: ["comment_count", "comments_count", "video_comment", "reply_count", "comment"],
  collects: ["collected_count", "collect_count", "favorite_count", "fav_count"],
  shares: ["share_count", "reposts_count", "forward_count", "share"],
  views: ["viewd_count", "video_play_count", "play_count", "view_count", "read_count", "view"],
};

const CONTENT_FIELDS: Record<MediaCrawlerPlatform, FieldMap> = {
  xhs: {
    id: ["note_id", "id"],
    title: ["title", "display_title"],
    text: ["desc", "content", "text"],
    author: ["nickname", "user_nickname"],
    authorId: ["creator_hash", "user_id", "author_id"],
    url: ["note_url", "url"],
    publishedAt: ["time", "publish_time", "create_time", "last_modify_ts"],
    metrics: BASE_CONTENT_METRICS,
  },
  dy: {
    id: ["aweme_id", "id"],
    title: ["desc", "title"],
    text: ["desc", "content"],
    author: ["nickname", "nick_name", "author_nickname"],
    authorId: ["creator_hash", "sec_uid", "author_user_id", "uid", "user_id"],
    url: ["aweme_url", "url", "share_url"],
    publishedAt: ["create_time", "publish_time"],
    metrics: BASE_CONTENT_METRICS,
  },
  ks: {
    id: ["video_id", "photo_id", "id"],
    title: ["caption", "title"],
    text: ["caption", "desc", "content"],
    author: ["nickname", "user_name"],
    authorId: ["creator_hash", "user_id", "author_id"],
    url: ["video_url", "photo_url", "url"],
    publishedAt: ["timestamp", "create_time", "publish_time"],
    metrics: { ...BASE_CONTENT_METRICS, views: ["viewd_count", "view_count", "play_count"] },
  },
  bili: {
    // 内核落盘主键是 `video_id`（= View.aid），**没有** `bvid` —— 见
    // `store/bilibili/__init__.py:update_bilibili_video`。留着 bvid 只做前向兼容。
    id: ["video_id", "bvid", "aid", "id"],
    title: ["title"],
    text: ["desc", "content"],
    author: ["nickname", "author", "owner_name"],
    authorId: ["creator_hash", "owner_id", "user_id", "mid", "author_id"],
    url: ["video_url", "url", "arcurl"],
    publishedAt: ["create_time", "pubdate", "publish_time"],
    metrics: {
      ...BASE_CONTENT_METRICS,
      comments: ["video_comment", "comment_count", "reply"],
      // B站的收藏/分享不带 `_count` 后缀，而是 `video_` 前缀，通用候选表吃不到
      collects: ["video_favorite_count", "favorite_count", "collect_count", "fav_count"],
      shares: ["video_share_count", "share_count", "reposts_count"],
    },
  },
  wb: {
    id: ["note_id", "id", "mid"],
    // 微博没有标题字段，正文即全部；此处不给 title 兜底，避免把正文复制成标题
    title: ["title"],
    text: ["content", "text"],
    author: ["nickname", "user_nickname"],
    authorId: ["creator_hash", "user_id", "author_id", "uid"],
    url: ["note_url", "url"],
    publishedAt: ["create_time", "publish_time", "created_at"],
    metrics: {
      ...BASE_CONTENT_METRICS,
      // 微博的转发数是 `shared_count`（不是 share_count / reposts_count）
      shares: ["shared_count", "share_count", "reposts_count"],
    },
  },
  tieba: {
    id: ["note_id", "id", "tid"],
    title: ["title"],
    text: ["desc", "content"],
    author: ["user_nickname", "nickname", "author"],
    authorId: ["creator_hash", "user_id", "author_id"],
    url: ["note_url", "url"],
    publishedAt: ["publish_time", "create_time"],
    metrics: {
      ...BASE_CONTENT_METRICS,
      // ⚠️ 内核模型的字段名是 `total_replay_num`（repl**a**y，上游拼写如此，
      // 见 `model/m_baidu_tieba.py:TiebaNote`）。按语义猜 `reply` 会永远取不到值。
      comments: ["total_replay_num", "comment_count", "total_reply_num", "reply_num"],
    },
  },
  zhihu: {
    id: ["content_id", "id", "answer_id", "article_id"],
    title: ["title", "question_title"],
    text: ["content_text", "desc", "content", "excerpt"],
    author: ["user_nickname", "nickname", "author_name"],
    authorId: ["creator_hash", "user_id", "author_id", "url_token"],
    url: ["content_url", "url"],
    publishedAt: ["created_time", "create_time", "updated_time"],
    metrics: BASE_CONTENT_METRICS,
  },
};

const COMMENT_FIELDS: FieldMap = {
  id: ["comment_id", "cid", "id", "rpid"],
  title: [],
  text: ["content", "text", "message"],
  author: ["nickname", "user_nickname", "user_name"],
  authorId: ["creator_hash", "user_id", "author_id", "uid", "mid"],
  url: [],
  publishedAt: ["create_time", "publish_time", "time", "ctime"],
  metrics: {
    // 微博评论的点赞键是 `comment_like_count`（不是 like_count），见
    // store/weibo/__init__.py:update_weibo_note_comment。
    likes: ["like_count", "liked_count", "comment_like_count", "digg_count", "voteup_count"],
    subComments: ["sub_comment_count", "reply_count", "sub_comment_count"],
  },
};

const CREATOR_SOURCE_KEYS = ["creator", "creator_info", "user", "user_info", "author"];

const CREATOR_FIELDS: FieldMap = {
  id: ["creator_hash", "user_id", "uid", "mid", "url_token", "sec_uid", "id"],
  title: ["nickname", "user_nickname", "name", "user_name"],
  text: ["desc", "signature", "description", "sign", "headline"],
  author: ["nickname", "user_nickname", "name"],
  authorId: ["creator_hash", "user_id", "uid", "mid", "url_token", "sec_uid"],
  url: ["home_url", "url", "user_url"],
  publishedAt: [],
  metrics: {
    followers: ["fans", "follower_count", "followers", "fans_count", "follower"],
    contents: ["note_count", "aweme_count", "video_count", "article_count", "answer_count", "post_count"],
    likes: ["total_liked", "liked_count", "total_favorited"],
  },
};

/**
 * Python 侧 `str(None)` / `str(float('nan'))` 会落成**字面量字符串**写进 jsonl
 * （快手 `liked_count` 实测全是 `'None'`）。这类值必须当空处理，
 * 否则它会作为"看起来有值"的字符串参与 `pick`，把真正可用的候选挤掉。
 */
const NULLISH_STRINGS = new Set(["None", "null", "undefined", "NaN", "nan"]);

const str = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  return NULLISH_STRINGS.has(s) ? "" : s;
};

/** 取第一个非空候选字段 */
function pick(rec: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const s = str(rec[k]);
    if (s) return s;
  }
  return "";
}

/**
 * 数字解析。平台把大数写成**带中文单位的字符串**（小红书 `'7.8万'`、`'3928'`），
 * 不认单位就会静默丢掉全部高赞内容 —— 而高赞恰恰是报告最关心的那批。
 *
 * 只认 `万`(1e4) / `亿`(1e8) 这两个**语义确定**的单位；其余一律按纯数字解析，
 * 认不出来就返回 null（宁可缺指标，也不要猜出一个错的数量级）。
 */
function numOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/[,\s]/g, "");
  if (!s) return null;
  const cn = /^(-?\d+(?:\.\d+)?)(万|亿)$/.exec(s);
  if (cn) {
    const n = Number(cn[1]) * (cn[2] === "亿" ? 1e8 : 1e4);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 时间戳归一化。
 *
 * MediaCrawler 各平台存的既有秒级也有毫秒级（抖音 `create_time` 是秒，
 * 小红书 `time` 常是毫秒，B站 `pubdate` 是秒）。这里按量级判定而不是靠平台名，
 * 因为同一平台不同字段也会不一致。判定不出来就原样返回——**不猜**。
 */
function toIso(v: unknown): string {
  const n = numOf(v);
  if (n !== null) {
    const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
    if (ms === null) return "";
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const s = str(v);
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function buildRow(
  platform: MediaCrawlerPlatform,
  op: CollectOp,
  kind: RowKind,
  map: FieldMap,
  rec: Record<string, unknown>,
): CollectRow {
  const metrics: Record<string, number> = {};
  for (const [name, keys] of Object.entries(map.metrics)) {
    for (const k of keys) {
      const n = numOf(rec[k]);
      if (n !== null) {
        metrics[name] = n;
        break;
      }
    }
  }
  return {
    platform,
    op,
    kind,
    id: pick(rec, map.id),
    title: pick(rec, map.title),
    text: pick(rec, map.text),
    author: pick(rec, map.author),
    authorId: pick(rec, map.authorId),
    url: pick(rec, map.url),
    publishedAt: toIso(pick(rec, map.publishedAt)),
    metrics,
    raw: rec,
  };
}

/** 评论记录在 mc 里嵌套在 `comments` 下；creator 信息可能包在 `creator` 键里 */
function unwrap(rec: Record<string, unknown>, kind: RowKind): Record<string, unknown> {
  if (kind !== "creator") return rec;
  for (const k of CREATOR_SOURCE_KEYS) {
    const v = rec[k];
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return rec;
}

/**
 * 把一批原始记录归一化成统一行。
 *
 * `rawKind` 是"这批 jsonl 里装的是什么"，由采集时的 op 决定：
 *   search / content_detail → content；comments → comment；creator → creator。
 */
export function normalizeBatch(
  platform: MediaCrawlerPlatform,
  op: CollectOp,
  kind: RowKind,
  records: Record<string, unknown>[],
): CollectRow[] {
  const map = kind === "comment" ? COMMENT_FIELDS : kind === "creator" ? CREATOR_FIELDS : CONTENT_FIELDS[platform];
  return records
    .map((r) => buildRow(platform, op, kind, map, unwrap(r, kind)))
    .filter((r) => r.id || r.title || r.text); // 全空的记录直接丢弃，避免污染缓存
}

/** op → 这批数据里装的记录类型 */
export function kindOf(op: CollectOp): RowKind {
  if (op === "comments") return "comment";
  if (op === "creator") return "creator";
  return "content";
}

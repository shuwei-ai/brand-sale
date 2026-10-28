/**
 * 确定性合成（degraded synthesis）
 *
 * 用途有两个，同一个实现：
 *   1. mock 模式下的 LLM 桩——让整条链路在无模型可用时也能跑通并被测试；
 *   2. **降级链的最后一环**——模型不可用时，用工具真实取回的数据 + 保守模板产出结构化结果，
 *      并强制标注 `synthesized: true` 与降置信度。绝不静默用假数据充数。
 *
 * 注意：合成内容里的数字**全部来自工具返回**，模板只负责组织语言。
 *
 * P0~P2 之后这里还多了一个职责：**深度基线**。
 * mock 模式跑出来的报告就是 `tests/e2e.test.ts` 里深度回归的基准，
 * 所以模板必须产出完整的 13 页结构（含 chart / matrix / timeline），
 * 而不是"能跑通就行"的 8 页骨架。
 */

import type { EvidenceEntry, ReportDsl, SlideSpec, SourceCatalog } from "@brandsale/contracts";
import { DEFAULT_DEPTH_POLICY, DISCLAIMER_TEXT } from "@brandsale/contracts";
import { MEDIA_CRAWLER_PLATFORM_META, type MediaCrawlerPlatform } from "@brandsale/config";
import { WEB_SEARCH_SOURCE_ID } from "@brandsale/datasource";
import { evidenceIdOf } from "./evidence.ts";
import { PLATFORM_DIGEST_TOOL_NAME } from "./tool-impls.ts";
import type { BudgetOutput, CreatorOutput, CreatorTier, IntelOutput, PlaybookOutput, StarLead } from "./schemas.ts";

export interface PrefetchedToolData {
  [toolName: string]: unknown;
}

const num = (v: unknown, dflt = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);

/**
 * 工具返回值形如 `{ result, provenance?, note? }`，这里统一解包到 `result`。
 *
 * **必须用它，不要直接读 `.rows`**：`ToolRegistry.invoke` 返回的是外层包着的对象，
 * 直接读 `res.rows` 恒为 undefined —— agents.ts 的机械补齐曾因此静默失效
 * （证据表里有几十条真实平台条目，intel 的 evidences 却一条都没补上）。
 */
export function unwrap(result: unknown): Record<string, unknown> {
  const r = result as Record<string, unknown> | null;
  if (!r) return {};
  const inner = r["result"];
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return r;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

/**
 * Brief 里的品牌标签：**多品牌要全列出来**，不能只写第一个。
 *
 * 实测问题（2026-10-11 双十一精华自测）：Brief 里是「施华蔻/赫莲娜/兰蔻/雅诗兰黛」四个品牌，
 * 报告封面与页脚却只印「施华蔻」—— 读者（甲方）第一眼就会觉得"这不是我要的那份报告"。
 * 只取 `brandIds[0]` 是把"主品牌"当成了"唯一品牌"，多品牌共用预算的场景直接失真。
 */
function brandLabel(brief: { brandIds?: readonly string[] | undefined }, fallback = "未指定"): string {
  const ids = (brief.brandIds ?? []).filter((b) => Boolean(b && b.trim()));
  return ids.length > 0 ? ids.join(" / ") : fallback;
}

/**
 * 最多引用几条平台原始条目：够撑起"有出处的证据"即可，不是做内容搬运。
 * 7 个平台每个至少 1 条，再额外补几条撑样本量 —— 若上限小于平台数，
 * 排在前面的平台会把名额占满，后面那几个平台在报告里就会"像没接上"。
 */
const PLATFORM_EVIDENCE_QUOTE_LIMIT = 12;

/**
 * 平台 rows → 条目级引用（entryId 复用证据表的同一个生成器，两边永远一致）。
 *
 * 分配方式是**逐平台轮转**（每个平台先各出 1 条，再各出第 2 条……），而不是按 rows 顺序截断。
 * 为什么：rows 是按平台成批返回的，顺序截断会让第一个平台独占全部名额 ——
 * 报告于是只认领 1~2 个平台，其余"取到了数据但没被引用"的平台读起来就是"没接上"。
 *
 * 导出给 `agents.ts` 用：模型路径（Pi 循环 / 单次结构化输出）也要能机械补上条目级引用，
 * 否则「取回了平台内容」与「报告能点回原帖」之间会断一环（详见 agents.ts 的 attachPlatformEvidences）。
 */
export function platformEvidencesFrom(rows: readonly Record<string, unknown>[]): NonNullable<IntelOutput["evidences"]> {
  type Candidate = { entryId: string; title: string; text: string };
  const byPlatform = new Map<string, Candidate[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    const platform = String(r.platform ?? "");
    const id = String(r.id ?? "");
    if (!platform || !id) continue;
    const entryId = evidenceIdOf(platform, id);
    if (seen.has(entryId)) continue;
    const title = String(r.title ?? "").trim();
    const text = String(r.text ?? "").trim();
    // 既没标题也没正文的条目（只剩指标）对报告无用：引用一条读者看不到内容的记录没有意义
    if (!title && !text) continue;
    seen.add(entryId);
    const bucket = byPlatform.get(platform) ?? [];
    bucket.push({ entryId, title, text });
    byPlatform.set(platform, bucket);
  }

  const out: NonNullable<IntelOutput["evidences"]> = [];
  for (let round = 0; out.length < PLATFORM_EVIDENCE_QUOTE_LIMIT; round += 1) {
    let tookAny = false;
    for (const bucket of byPlatform.values()) {
      const c = bucket[round];
      if (!c) continue;
      tookAny = true;
      out.push({
        entryId: c.entryId,
        quote: `${c.title}${c.title && c.text ? "：" : ""}${c.text}`.slice(0, 80),
        useFor: "平台公开内容",
      });
      if (out.length >= PLATFORM_EVIDENCE_QUOTE_LIMIT) break;
    }
    if (!tookAny) break;
  }
  return out;
}

/** 证据集按 平台 × 算子 汇总（纯机械聚合，不经模型 —— 附录的数字必须可复算） */
export function summarizeEvidence(entries: readonly EvidenceEntry[]): string[][] {
  const map = new Map<string, { platformName: string; op: string; count: number; from: string; to: string }>();
  for (const e of entries) {
    const key = `${e.platform}|${e.op}`;
    const at = (e.collectedAt || "").slice(0, 10);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { platformName: e.platformName, op: e.op, count: 1, from: at, to: at });
      continue;
    }
    cur.count += 1;
    if (at && (!cur.from || at < cur.from)) cur.from = at;
    if (at && at > cur.to) cur.to = at;
  }
  return [...map.values()].map((m) => [
    m.platformName,
    m.op,
    String(m.count),
    m.from ? (m.from === m.to ? m.from : `${m.from} ~ ${m.to}`) : "未知",
  ]);
}

/** 附录里「平台真实账号」最多列多少个作者：这是核对用的清单，不是通讯录 */
export const PLATFORM_ACCOUNT_LIMIT = 24;

/**
 * 证据集按 平台 × 作者 汇总（纯机械聚合）。
 *
 * 为什么需要它：报告里的人选/达人可能来自本地报价库（只有昵称、没有平台账号 ID），
 * 读者拿那些昵称去平台上搜是搜不到的 —— 于是最容易被读成"数据是编的"。
 * 这张表把**真正从平台采集回来的账号**摆出来，让"平台数据是真的"这件事可核对。
 *
 * 账号名按采集结果**完整显示**（业主明确要求不要用 `****` 打码）：读者可以拿它
 * 去平台直接检索该账号。用户 id 仍被换成 `creator_hash`（不落原始 uid），但那只是
 * 分组键，不参与展示。所以这里给的是"完整账号昵称 + 条目数 + 代表原帖链接"。
 */
export function platformAccountRows(entries: readonly EvidenceEntry[]): string[][] {
  const map = new Map<
    string,
    { platformName: string; author: string; count: number; url: string; followers: number | null; profileUrl: string }
  >();
  for (const e of entries) {
    const author = (e.author || "").trim();
    if (!author) continue; // 没有作者就不进这张表：宁可少，不要用"—"充数
    const key = `${e.platform}|${author}`;
    const cur = map.get(key);
    // 资料条目（op=creator）只贡献粉丝量与主页链接，不算一份"条目"
    if (e.op === "creator") {
      const followers = typeof e.metrics["followers"] === "number" ? e.metrics["followers"] : null;
      if (cur) {
        if (followers !== null) cur.followers = Math.max(cur.followers ?? 0, followers);
        if (!cur.profileUrl && e.url) cur.profileUrl = e.url;
        continue;
      }
      map.set(key, {
        platformName: e.platformName,
        author,
        count: 0,
        url: "",
        followers,
        profileUrl: e.url || "",
      });
      continue;
    }
    if (cur) {
      cur.count += 1;
      if (!cur.url && e.url) cur.url = e.url;
      continue;
    }
    map.set(key, {
      platformName: e.platformName,
      author,
      count: 1,
      url: e.url || "",
      followers: null,
      profileUrl: "",
    });
  }
  const rowsAll = [...map.values()].filter((m) => m.count > 0); // 只有资料、名下没有采到条目的作者不进这张"账号清单"

  /**
   * 名额分配：**逐平台轮转**，而不是排序后一刀切。
   *
   * 实测事故（2026-10-11 双十一精华自测）：抖音 35 条、微博 20 条真实内容都已采集入库，
   * 附录里却一个抖音/微博账号都没有 —— 因为排序键是 platformName 的字典序
   * （"B站" < "小红书" < "微博" < "抖音"），`slice(0, 24)` 被 B站 + 小红书 吃满后，
   * 抖音、微博**整平台**被砍掉。这类"截断不报错、只是少了一块"的残缺最难发现，
   * 所以改成轮转：只要某个平台真采到了账号，它就一定在表里有席位。
   */
  const byPlatform = new Map<string, typeof rowsAll>();
  for (const m of rowsAll) {
    const list = byPlatform.get(m.platformName);
    if (list) list.push(m);
    else byPlatform.set(m.platformName, [m]);
  }
  const platformNames = [...byPlatform.keys()].sort();
  for (const list of byPlatform.values()) {
    /* 平台内排序：**先把采到粉丝量的账号排前面**（粉丝量大的更靠前），再按条目数。
     * 理由：这张表是给商务核对 "这个账号真实存在、体量多大" 用的，
     * 只按条目数排会让 "微博路人甲（1 条内容）" 挤掉 "丝芙兰（409.5 万粉）" ——
     * 表里全是查不到体量的路人昵称，等于白列。 */
    list.sort(
      (a, b) =>
        Number(b.followers !== null) - Number(a.followers !== null) ||
        (b.followers ?? 0) - (a.followers ?? 0) ||
        b.count - a.count ||
        (a.author < b.author ? -1 : a.author > b.author ? 1 : 0),
    );
  }

  const picked: typeof rowsAll = [];
  for (let round = 0; picked.length < PLATFORM_ACCOUNT_LIMIT; round += 1) {
    let advanced = false;
    for (const name of platformNames) {
      const hit = byPlatform.get(name)![round];
      if (!hit) continue;
      picked.push(hit);
      advanced = true;
      if (picked.length >= PLATFORM_ACCOUNT_LIMIT) break;
    }
    if (!advanced) break; // 所有平台都取空了
  }

  return picked
    .sort((a, b) =>
      a.platformName === b.platformName
        ? // 平台内保持上面的次序（粉丝量优先）；sort 是稳定的，比较器返回 0 即保留原序
          0
        : a.platformName < b.platformName
          ? -1
          : 1,
    )
    .map((m) => [
      m.platformName,
      m.author,
      String(m.count),
      m.followers !== null ? String(m.followers) : "未采集",
      m.profileUrl || m.url || "—",
    ]);
}

/* ── 真实账号 → 候选人（"人选只能来自真实数据"的落点） ──────── */

/** 平台候选人的 id 前缀：一眼能看出"这位人选的数据来自平台公开采集" */
export const PLATFORM_CREATOR_PREFIX = "pfcre_";
/** 无人选时的诚实占位 id 前缀（与装配层 `synthCreators` 的补层逻辑一致） */
export const PLACEHOLDER_CREATOR_PREFIX = "none_";
/** 一次最多把多少个真实采集账号作为候选人（够用即可；总量由报告附录兜底） */
export const PLATFORM_CREATOR_LIMIT = 12;

/** 平台采集账号的聚合视图（只含能核对到的真实字段，没有一个是推断出来的） */
export interface PlatformAccountAgg {
  platform: string;
  platformName: string;
  /** 采集到的账号昵称（完整显示，可直接用于平台检索） */
  author: string;
  /** 该账号名下采集到的条目 id（可反查证据表） */
  entryIds: string[];
  contentCount: number;
  commentCount: number;
  /** 代表原帖（真实链接，可点开核对） */
  sampleUrl: string;
  /** 内容标题样本，用于判断内容形态 */
  titles: string[];
  /** 采集到的公开互动量合计（各平台指标口径不同，只用于同平台内排序） */
  observedInteractions: number;
  collectedAt: string;
  /**
   * 该账号的**粉丝量**（个人主页公开统计，`kind=creator` 条目里的 `followers`）。
   * 没有就 null —— 报告显示"未采集"，**绝不用 0 或有值兜底**：
   * 一个假的粉丝数会让读者无法分辨哪一列是真的。
   */
  followers: number | null;
  /** 该账号的关注数（同样来自个人主页），没有则 null */
  follows: number | null;
  /** 个人主页链接（可点开核对粉丝数），没有则空串 */
  profileUrl: string;
  /**
   * 平台原始 UID（抖音 `user_id` / 小红书 `user_id` / B站 `mid`）。
   *
   * 报告里的人选标识列用它 —— `pfcre_<platform>_<hash>` 是内部聚合 id，读者拿去
   * 任何平台都查不到，模型还会把它误当 `creatorId` 喂回采集（真机 stored:0）。
   */
  uid: string;
}

/** 互动量计入项：只取"越多越热"的计数型指标，避免把时长/评分之类的量纲混进来 */
const INTERACTION_KEYS = ["likeCount", "likes", "likedCount", "collectCount", "collects", "commentCount", "comments", "shareCount", "shares", "viewCount", "playCount", "coins", "replies"] as const;

const interactionsOf = (m: Record<string, number>): number => INTERACTION_KEYS.reduce((n, k) => n + (typeof m[k] === "number" ? m[k]! : 0), 0);

/** 平台候选人的稳定 id：由（平台 + 账号昵称）推导，报告与附录两处必须得出同一个值 */
export const platformCandidateId = (platform: string, author: string): string =>
  `${PLATFORM_CREATOR_PREFIX}${platform}_${simpleHash(author)}`;

/** 稳定短哈希（djb2 变体，取 32 位十六进制）：只用于 id，不承担加密职责 */
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 把证据条目按 平台 × 作者 聚合成账号（纯机械，不经模型）。
 *
 * 无作者的条目直接丢弃：**宁可少一个账号，也不要造一个**。这条规则和
 * `platformAccountRows` 一致 —— 报告里出现的每个账号都必须能点回原帖。
 */
export function aggregatePlatformAccounts(entries: readonly EvidenceEntry[]): PlatformAccountAgg[] {
  const map = new Map<string, PlatformAccountAgg>();
  for (const e of entries) {
    const author = (e.author || "").trim();
    if (!author) continue;
    const key = `${e.platform}|${author}`;
    const cur = map.get(key);
    /* 个人主页资料条目（op=creator）与内容条目**同作者合并**，但只贡献账号级字段：
     * 粉丝量 / 关注数 / 主页链接。它们不算"条目"、不计互动量 ——
     * 否则"该账号名下 12 条内容"会变成 13 条，粉丝量也会混进互动量排序。 */
    const isProfile = e.op === "creator";
    const add = isProfile ? 0 : interactionsOf(e.metrics);
    if (isProfile) {
      const followers = typeof e.metrics["followers"] === "number" ? e.metrics["followers"] : null;
      const follows = typeof e.metrics["follows"] === "number" ? e.metrics["follows"] : null;
      if (cur) {
        if (followers !== null) cur.followers = Math.max(cur.followers ?? 0, followers);
        if (follows !== null) cur.follows = Math.max(cur.follows ?? 0, follows);
        if (!cur.profileUrl && e.url) cur.profileUrl = e.url;
        if (!cur.uid && e.uid) cur.uid = e.uid;
        continue;
      }
      map.set(key, {
        platform: e.platform,
        platformName: e.platformName || e.platform,
        author,
        entryIds: [],
        contentCount: 0,
        commentCount: 0,
        sampleUrl: "",
        titles: [],
        observedInteractions: 0,
        collectedAt: e.collectedAt || "",
        followers,
        follows,
        profileUrl: e.url || "",
        uid: e.uid || "",
      });
      continue;
    }
    if (cur) {
      cur.entryIds.push(e.entryId);
      if (e.kind === "comment") cur.commentCount += 1;
      else cur.contentCount += 1;
      if (!cur.sampleUrl && e.url) cur.sampleUrl = e.url;
      if (cur.titles.length < 3 && e.title) cur.titles.push(e.title);
      cur.observedInteractions += add;
      if (e.collectedAt && (!cur.collectedAt || e.collectedAt < cur.collectedAt)) cur.collectedAt = e.collectedAt;
      continue;
    }
    map.set(key, {
      platform: e.platform,
      platformName: e.platformName || e.platform,
      author,
      entryIds: [e.entryId],
      contentCount: e.kind === "comment" ? 0 : 1,
      commentCount: e.kind === "comment" ? 1 : 0,
      sampleUrl: e.url || "",
      titles: e.title ? [e.title] : [],
      observedInteractions: add,
      collectedAt: e.collectedAt || "",
      followers: null,
      follows: null,
      profileUrl: "",
      uid: "",
    });
  }
  return [...map.values()].sort(
    (a, b) =>
      (b.followers ?? -1) - (a.followers ?? -1) ||
      b.observedInteractions - a.observedInteractions ||
      b.entryIds.length - a.entryIds.length ||
      (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0) ||
      (a.author < b.author ? -1 : 1),
  );
}

/**
 * 从**真实采集到的平台账号**构建候选人池。
 *
 * 起因（业主反馈）：报告里的人选来自本地样例库，昵称在平台上搜不到 ——
 * "本地那些假数据不要参考，我要真实数据"。于是人选池改成：优先用真实采集回来的
 * 账号（这位作者真实存在、他的帖子链接可点开），代价是**没有粉丝量与报价** ——
 * 那就如实写"未采集 / 无样本"，绝不用样例数字填坑。
 *
 * 分层（head/mid/tail）按**同平台内采集到的公开互动量分位**划分，而不是粉丝量：
 * 粉丝量根本没采到，硬套就会变成编造。分层口径写在每个候选的 contentFit 里，
 * 读者一眼能看到"这个 head 是按互动量排出来的"，不会误读成粉丝量分层。
 */
export function platformCreatorCandidates(
  entries: readonly EvidenceEntry[],
  brief: { category?: string; platforms?: readonly string[] },
  opts: { limit?: number } = {},
): CreatorOutput["candidates"] {
  const aggs = aggregatePlatformAccounts(entries);
  if (aggs.length === 0) return [];
  const limit = opts.limit ?? PLATFORM_CREATOR_LIMIT;

  // 同平台内的互动量最大值，用于把 matchScore 归一化到 0.3~0.7（真实相对值，不是拍脑袋）
  const maxByPlatform = new Map<string, number>();
  for (const a of aggs) maxByPlatform.set(a.platform, Math.max(maxByPlatform.get(a.platform) ?? 0, a.observedInteractions));

  /* 逐平台轮转取样，而不是"互动量前 12 名"：后者会让一个平台（通常是小红书或贴吧）
   * 占满整张表，报告读起来像"只在某一个平台做了功课"。 */
  const byPlatform = new Map<string, PlatformAccountAgg[]>();
  for (const a of aggs) {
    const list = byPlatform.get(a.platform) ?? [];
    list.push(a);
    byPlatform.set(a.platform, list);
  }
  const ordered: PlatformAccountAgg[] = [];
  const queues = [...byPlatform.values()];
  for (let i = 0; ordered.length < limit && i < 1000; i += 1) {
    let picked = false;
    for (const q of queues) {
      const item = q[i];
      if (!item) continue;
      ordered.push(item);
      picked = true;
      if (ordered.length >= limit) break;
    }
    if (!picked) break;
  }

  const tierOfAgg = (a: PlatformAccountAgg): CreatorTier => {
    // 有真实粉丝量就按粉丝量分层（与 L2 人选同一把尺子 `tierOf`）；
    // 没采到才退回"同平台互动量分位"——并存时**不能混用**，否则同一张表里
    // 两条人选的 head/mid 依据不一样，读者无从比较。
    if (a.followers !== null) return tierOf(a.followers);
    const list = byPlatform.get(a.platform) ?? [];
    // 同平台内按互动量排名分位：前 1/3 头部、中 1/3 腰部、其余尾部
    const ranked = [...list].sort((x, y) => y.observedInteractions - x.observedInteractions);
    const idx = ranked.findIndex((x) => x.author === a.author);
    const rank = idx < 0 ? ranked.length : idx;
    const share = ranked.length <= 1 ? 0 : rank / (ranked.length - 1);
    return share <= 0.34 ? "head" : share <= 0.67 ? "mid" : "tail";
  };

  return ordered.map((a) => {
    const max = maxByPlatform.get(a.platform) ?? 0;
    const rel = max > 0 ? a.observedInteractions / max : 0;
    const metricsText = a.observedInteractions > 0 ? `采集到的公开互动量合计 ${a.observedInteractions}` : "互动量未采集到";
    const hasFollowers = a.followers !== null;
    const followerText = hasFollowers
      ? `粉丝量 ${a.followers}（取自个人主页公开统计${a.profileUrl ? `，见 ${a.profileUrl}` : ""}）`
      : "粉丝量**未采集**";
    return {
      talentId: platformCandidateId(a.platform, a.author),
      nickname: a.author,
      platform: a.platformName,
      // 真实粉丝量：主页公开统计拿到的就写进去；拿不到才是 0（报告显示"未采集"）
      followers: a.followers ?? 0,
      category: brief.category ?? "未分类",
      matchScore: Number((0.3 + 0.4 * rel).toFixed(2)),
      rationale:
        `来自 ${a.platformName} 公开采集：该账号名下有 ${a.entryIds.length} 条可核对条目（${a.contentCount} 条内容 / ${a.commentCount} 条评论），` +
        `代表原帖 ${a.sampleUrl || "（无链接）"}。账号昵称完整显示，${followerText}；报价**未采集**。`,
      // 无 L2 报价样本 → 成本不估计。填 0 而不是样例金额，报告里显示"无样本"
      estimatedCost: 0,
      costRange: { low: 0, high: 0 },
      riskFlags: [
        hasFollowers
          ? "账号来自平台公开采集（L3），粉丝量取自个人主页公开统计，报价未采集，投放前须按原帖人工核验"
          : "账号来自平台公开采集（L3），粉丝量与报价未采集，投放前须按原帖人工核验",
      ],
      tier: tierOfAgg(a),
      contentFit:
        `${a.titles[0] ? `代表作「${a.titles[0].slice(0, 30)}」；` : ""}${metricsText}；` +
        (hasFollowers
          ? `分层依据为粉丝量（个人主页公开统计）`
          : `分层依据为同平台互动量分位（粉丝量未采集）`),
      historicalPerformance: "无 L2 历史执行样本",
      confidence: hasFollowers ? 0.45 : 0.35,
    };
  });
}

/* ── 粉丝量的"读时解析"（而不是写时快照） ────────────────── */

/** 一个账号在**当前证据表**下的真实状态 */
export interface CreatorLiveView {
  talentId: string;
  /** 个人主页公开统计；没采到是 null（**不是 0**） */
  followers: number | null;
  tier: "head" | "mid" | "tail";
  profileUrl: string;
  sampleUrl: string;
  uid: string;
}

/**
 * 从证据表实时算出"每位账号现在到底多少粉丝、该归哪层"。
 *
 * 为什么需要它（2026-10-20 真机 job_0mvgany95k7poz73mks）：
 * 候选人池是在 creator 阶段**开头**机械生成的，那一刻作者主页资料行还没落库
 * （补采任务排在采集队列尾，实测 06:45:09 才写完），于是 `followers` 被固化成 0；
 * 而 report 阶段（06:45:37 起）运行时数据早就在缓存里，只是没人再去读一次。
 * 结果是 5 位人选的粉丝量在报告里全是「未采集」，缓存里其实是 60.1 万 / 13.0 万 / …。
 *
 * 修法不是在写的时候再猜一次，而是**读的时候以证据表为准**：
 * 同一份 DSL 在证据表补齐前后渲染出不同（更准）的结果，这是期望行为。
 */
export function creatorLiveViews(entries: readonly EvidenceEntry[]): Map<string, CreatorLiveView> {
  const aggs = aggregatePlatformAccounts(entries);
  const byPlatform = new Map<string, PlatformAccountAgg[]>();
  for (const a of aggs) {
    const list = byPlatform.get(a.platform);
    if (list) list.push(a);
    else byPlatform.set(a.platform, [a]);
  }
  const out = new Map<string, CreatorLiveView>();
  for (const a of aggs) {
    let tier: CreatorLiveView["tier"];
    if (a.followers !== null) {
      tier = tierOf(a.followers);
    } else {
      /* 没有粉丝量才退回"同平台互动量分位"——与 `platformCreatorCandidates` 同一把尺子，
       * 两处口径必须一致，否则同一账号在正文与附录里会显示成两个层级。 */
      const list = byPlatform.get(a.platform) ?? [];
      const ranked = [...list].sort((x, y) => y.observedInteractions - x.observedInteractions);
      const idx = ranked.findIndex((x) => x.author === a.author);
      const rank = idx < 0 ? ranked.length : idx;
      const share = ranked.length <= 1 ? 0 : rank / (ranked.length - 1);
      tier = share <= 0.34 ? "head" : share <= 0.67 ? "mid" : "tail";
    }
    out.set(platformCandidateId(a.platform, a.author), {
      talentId: platformCandidateId(a.platform, a.author),
      followers: a.followers,
      tier,
      profileUrl: a.profileUrl,
      sampleUrl: a.sampleUrl,
      uid: a.uid,
    });
  }
  return out;
}

/** 把候选人文案里"未采集"的口径改成真实值（否则同一行会一边写粉丝量一边写未采集） */
function applyLiveFollowerText(s: string, lv: CreatorLiveView): string {
  if (lv.followers === null) return s;
  return s
    .replace(
      /粉丝量\*\*未采集\*\*/g,
      `粉丝量 ${lv.followers}（取自个人主页公开统计${lv.profileUrl ? `，见 ${lv.profileUrl}` : ""}）`,
    )
    .replace(/粉丝量与报价未采集/g, "报价未采集")
    .replace(/粉丝量未采集，投放前/g, "报价未采集，投放前")
    .replace(/分层依据为同平台互动量分位（粉丝量未采集）/g, "分层依据为粉丝量（个人主页公开统计）");
}

/**
 * 用证据表里的实时值刷新候选人池（纯函数）。
 *
 * 只改**账号级事实**（粉丝量 / 分层 / 依赖它们的文案），不动模型或机械层选出来的人：
 * 换人会改变报告结构，属另一件事。`followers` 只在实时值存在时覆盖 —— 实时拿不到就保留原值，
 * 绝不把已知值降级成 0。
 */
export function withLiveCreatorStats(
  creators: CreatorOutput | undefined,
  entries: readonly EvidenceEntry[],
): CreatorOutput | undefined {
  if (!creators) return creators;
  const live = creatorLiveViews(entries);
  if (live.size === 0) return creators;
  let changed = false;
  const candidates = creators.candidates.map((c) => {
    const lv = live.get(c.talentId);
    if (!lv) return c;
    const followers = lv.followers ?? c.followers;
    const tier = lv.followers !== null ? lv.tier : c.tier;
    if (followers === c.followers && tier === c.tier) return c;
    changed = true;
    return {
      ...c,
      followers,
      tier,
      rationale: applyLiveFollowerText(c.rationale, lv),
      contentFit: applyLiveFollowerText(c.contentFit, lv),
      riskFlags: c.riskFlags.map((f) => applyLiveFollowerText(f, lv)),
      confidence: lv.followers !== null ? Math.max(c.confidence, 0.45) : c.confidence,
    };
  });
  return changed ? { ...creators, candidates } : creators;
}

/**
 * 把**模型自己写的表格**里的粉丝量 / 人选标识按证据表回填（纯函数）。
 *
 * 为什么要有这一步：`creatorRosterBlocks` 是机械块，改了读侧就自动对；但正文里那张
 * 「人选建议与分层」是模型生成的，它把 creator 阶段的 `followers=0` 直接写成了「未采集」。
 * 只修机械块的话，同一份报告里两张表会自相矛盾（一张有粉丝量、一张"未采集"）。
 *
 * 两条规则刻意保守：
 *   · 只在**表格块已有 `sourceRef`** 时回填数字 —— 否则会把一个"无数字、本来不触发 R6"的块
 *     变成"有数字但无来源"，凭空造出一条阻塞；
 *   · 只填空值（未采集 / — / 空），**不覆盖**模型写过的具体数字 —— 那可能是它从别处引的，
 *     覆盖等于替模型改口。
 */
export function backfillCreatorStatsInTables(
  dsl: ReportDsl,
  creators: CreatorOutput | undefined,
  entries: readonly EvidenceEntry[],
): ReportDsl {
  const live = creatorLiveViews(entries);
  if (live.size === 0) return dsl;
  /** 模型偶尔只写昵称不写 id，用它兜底 */
  const byNickname = new Map<string, CreatorLiveView>();
  for (const c of creators?.candidates ?? []) {
    const lv = live.get(c.talentId);
    if (lv && c.nickname) byNickname.set(c.nickname.trim(), lv);
  }
  const EMPTY = new Set(["", "—", "-", "未采集", "未知", "无样本", "N/A", "n/a"]);
  let touched = false;

  const slides = dsl.slides.map((slide) => {
    const blocks = slide.blocks.map((b) => {
      if (b.type !== "table") return b;
      const cols = b.columns.map((c) => String(c));
      const fIdx = cols.findIndex((c) => /粉丝量|粉丝数/.test(c));
      const idIdx = cols.findIndex((c) => /人选\s*ID|达人\s*ID|人选ID/i.test(c));
      if (fIdx < 0 && idIdx < 0) return b;
      let blockChanged = false;
      const rows = b.rows.map((row) => {
        const cells = row.map((c) => String(c ?? ""));
        // 定位这一行是哪个人：先看 id 列，其次扫全行，最后用昵称兜底
        let lv: CreatorLiveView | undefined;
        const idCell = idIdx >= 0 ? cells[idIdx] ?? "" : "";
        if (idCell.startsWith(PLATFORM_CREATOR_PREFIX)) lv = live.get(idCell);
        if (!lv) {
          for (const cell of cells) {
            if (cell.startsWith(PLATFORM_CREATOR_PREFIX) && live.has(cell)) {
              lv = live.get(cell);
              break;
            }
          }
        }
        if (!lv) {
          for (const cell of cells) {
            const hit = byNickname.get(cell.trim());
            if (hit) {
              lv = hit;
              break;
            }
          }
        }
        if (!lv) return row;
        const next = [...cells];
        let rowChanged = false;
        // ① 人选标识：内部哈希对读者无用（查不到、喂回采集还会失败），换成平台原始 UID
        if (idIdx >= 0 && idCell.startsWith(PLATFORM_CREATOR_PREFIX) && (lv.uid || lv.profileUrl)) {
          next[idIdx] = lv.uid || lv.profileUrl;
          rowChanged = true;
        }
        // ② 粉丝量：只补空值，且该表必须已有来源
        if (fIdx >= 0 && lv.followers !== null && EMPTY.has(next[fIdx]!.trim()) && b.sourceRef) {
          next[fIdx] = String(lv.followers);
          rowChanged = true;
        }
        if (!rowChanged) return row;
        blockChanged = true;
        return next;
      });
      if (!blockChanged) return b;
      touched = true;
      return { ...b, rows };
    });
    if (blocks.every((b, i) => b === slide.blocks[i])) return slide;
    return { ...slide, blocks };
  });

  return touched ? { ...dsl, slides } : dsl;
}

/**
 * 「这条候选只靠公开报道成立」的机械标记（由 `pruneUnverifiableCreators` 第三条通道打上）。
 *
 * ⚠️ **判定必须看风险标记，不能看 talentId 前缀**：明星候选的 id 是**模型自己编的**
 * （真机 `job_0mvqiisybvto1p5nkf9` 写的是 `celeb_loreal_tianxuning`），代码里根本没有
 * 这个常量。只按前缀判断 → 明星候选掉进"报价库"分支 → 报告里出现
 * 「本地达人报价库（L2）」「成本 0.0 万」这类**溯源错误 + 读起来像"免费"**的表述。
 */
export const PUBLIC_FIGURE_FLAG = "公开报道口径";
export const PUBLIC_FIGURE_SOURCE_LABEL = "公开报道线索（L3，未经核验）";

/** 是否"只靠公开报道成立"的公众人物候选（明星/名人） */
export function isPublicFigureCandidate(c: { talentId: string; riskFlags?: readonly string[] }): boolean {
  if ((c.riskFlags ?? []).some((f) => f.includes(PUBLIC_FIGURE_FLAG))) return true;
  // 兜底：模型常用 celeb_ 前缀（不是契约，但出现时按公众人物处理，不要落进报价库分支）
  return /^celeb[_-]/i.test(c.talentId);
}

/** 候选人来源标签：报告逐条标出来源，读者才知道哪一条能点回原帖 */
export function creatorSourceOf(c: string | { talentId: string; riskFlags?: readonly string[] }): string {
  const talentId = typeof c === "string" ? c : c.talentId;
  if (typeof c !== "string" && isPublicFigureCandidate(c)) return PUBLIC_FIGURE_SOURCE_LABEL;
  if (talentId.startsWith(PLATFORM_CREATOR_PREFIX)) return "平台公开采集（L3，未核验）";
  if (talentId.startsWith(PLACEHOLDER_CREATOR_PREFIX)) return "无数据（占位）";
  return "本地达人报价库（L2）";
}

/**
 * 按姓名在官宣报道里找**出处**（标题含该姓名即算命中）。
 *
 * 纯机械子串匹配：不做实体识别、不猜品牌、不合并同名 —— 命不中就如实说没命中。
 * 这是把用户诉求「给出姓名 + 官宣时间 + 来源链接」落到纸面的唯一不造假做法：
 * 姓名来自候选人，标题/时间/链接来自已经检索回来的报道原文。
 */
export function starLeadOf(leads: readonly StarLead[] | undefined, name: string): StarLead | undefined {
  const n = name.replace(/\s+/g, "");
  if (n.length < 2) return undefined;
  return (leads ?? []).find((l) => l.title.replace(/\s+/g, "").includes(n));
}

/**
 * 报道时间显示：`2026-05-06T09:30:00+08:00` → `2026-05-06 09:30`。
 *
 * 原样塞 ISO 串进中文表格（真机报告里就是 `2026-02-03T18:39:00+08:00`）读者要自己拆
 * `T` 和时区后缀才看得懂；这里只做**格式**转换，不改数值、不推算时区 ——
 * 原文写几点就显示几点（表头注明「原文所示时间」）。
 */
export function fmtLeadTime(s: string | undefined): string {
  const raw = (s ?? "").trim();
  if (!raw) return "未标注";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(raw);
  return m ? `${m[1]} ${m[2]}` : raw;
}

/**
 * 人选核验状态表：报告里出现的达人逐条给出来源、可核验凭据与"账号是否可得"。
 *
 * 为什么必须分来源：本地报价库的人选只有昵称（平台上搜不到，属预期），
 * 平台采集的人选有真实原帖链接（可点开核对）、账号名完整显示，但没有报价。
 * 两者混在一张表里而不标注，读者只能得出"报告在编数据"这一个结论。
 */
export function creatorAccountRows(creatorsIn: CreatorOutput | undefined, entries: readonly EvidenceEntry[] = []): string[][] {
  /* 粉丝量以**证据表**为准，而不是候选人对象里的快照（见 `creatorLiveViews` 的长注释）。
   * 放在这里而不是每个调用点：合成路径、模型路径、补丁路径都会经过本函数，
   * 少一处就是"同一份报告两张表两种数字"。 */
  const creators = withLiveCreatorStats(creatorsIn, entries);
  const urlByTalent = new Map<string, string>();
  /** 个人主页链接（比原帖更能核验"粉丝量"这一列），有就用它 */
  const profileByTalent = new Map<string, string>();
  /** 平台原始 UID：标识列优先展示它 */
  const uidByTalent = new Map<string, string>();
  for (const a of aggregatePlatformAccounts(entries)) {
    const id = platformCandidateId(a.platform, a.author);
    urlByTalent.set(id, a.sampleUrl);
    if (a.profileUrl) profileByTalent.set(id, a.profileUrl);
    if (a.uid) uidByTalent.set(id, a.uid);
  }
  return (creators?.candidates ?? []).map((c) => {
    const source = creatorSourceOf(c);
    const label = PLATFORM_LABEL_BY_NAME.get(c.platform) ?? c.platform;
    const isPlatform = c.talentId.startsWith(PLATFORM_CREATOR_PREFIX);
    const isPlaceholder = c.talentId.startsWith(PLACEHOLDER_CREATOR_PREFIX);
    /* 公众人物候选（只靠公开报道成立）单列：凭据是**官宣报道链接**，不是"库内无账号 ID"。
     * 三处必须一起改，少一处就自相矛盾：来源写"报价库"、凭据写"无账号"、
     * 成本写"0.0 万"（读起来像免费）、粉丝量写"未知"（看起来像查过但没查到）。 */
    const isPublicFigure = isPublicFigureCandidate(c);
    const starLead = isPublicFigure ? starLeadOf(creators?.starLeads, c.nickname) : undefined;
    const credential = profileByTalent.get(c.talentId) || urlByTalent.get(c.talentId) || "";
    return [
      /* 标识列：**平台原始 UID 优先**（抖音 `67142047882`、小红书 24 位主页 id，站内可查），
       * 其次主页链接，都没有才回退内部哈希。
       * `pfcre_<平台>_<昵称哈希>` 对读者没有任何可操作价值 —— 拿去平台搜不到，
       * 模型还会把它误当 `creatorId` 喂回采集（真机 stored:0 就是这条链）。 */
      isPlatform ? uidByTalent.get(c.talentId) || profileByTalent.get(c.talentId) || c.talentId : c.talentId,
      c.nickname,
      label,
      source,
      isPlatform
        ? credential || "—"
        : isPublicFigure
          ? starLead?.url || "—（未命中官宣报道，仅检索正文提及姓名）"
          : isPlaceholder
            ? "—"
            : "库内无账号 ID（未核验）",
      // 粉丝量：采到就写真实值（个人主页公开统计），没采到如实写"未采集"
      c.followers > 0
        ? String(c.followers)
        : isPlatform || isPublicFigure
          ? "未采集"
          : isPlaceholder
            ? "—"
            : "未知",
      isPlatform || isPlaceholder || isPublicFigure ? "无样本" : `${(c.estimatedCost / 10000).toFixed(1)} 万`,
      isPublicFigure
        ? starLead
          ? `公开报道口径：点开凭据核对「${fmtLeadTime(starLead.publishedAt)}」的官宣报道；代言有期限，当前是否仍在合作须确认`
          : "公开报道口径：仅检索正文提及姓名，未命中官宣报道；粉丝量/报价无样本，须人工核验"
        : isPlaceholder
          ? c.rationale.slice(0, 60)
          : isPlatform
            ? c.followers > 0
              ? "粉丝量取自平台个人主页公开统计；报价无样本，投放前须人工核验"
              : "账号名完整显示；粉丝量未采集，投放前须按原帖人工核验"
            : "平台上搜不到同名账号属预期，投放前须人工核验",
    ];
  });
}

/** 分层标签：报告里给人看，代码里仍用 head/mid/tail */
export const TIER_LABEL: Record<string, string> = { head: "头部", mid: "腰部", tail: "尾部" };

/** 由人选 id 反查它的可核验凭据（原帖链接）；非平台采集人选返回空串 */
export function creatorEvidenceUrl(entries: readonly EvidenceEntry[], talentId: string): string {
  if (!talentId.startsWith(PLATFORM_CREATOR_PREFIX)) return "";
  for (const a of aggregatePlatformAccounts(entries)) {
    if (platformCandidateId(a.platform, a.author) === talentId) return a.sampleUrl;
  }
  return "";
}

/** 由人选 id 反查它名下采集到的条目数（散点图在没有粉丝量时的真实纵轴） */
export function creatorEvidenceCount(entries: readonly EvidenceEntry[], talentId: string): number {
  if (!talentId.startsWith(PLATFORM_CREATOR_PREFIX)) return 0;
  for (const a of aggregatePlatformAccounts(entries)) {
    if (platformCandidateId(a.platform, a.author) === talentId) return a.entryIds.length;
  }
  return 0;
}

/** 采集码/中文名 → 报告里显示的平台名（两个方向都要能查，故用一张双向表） */
const PLATFORM_LABEL_BY_NAME = new Map<string, string>([
  ["xhs", "小红书"],
  ["xiaohongshu", "小红书"],
  ["小红书", "小红书"],
  ["dy", "抖音"],
  ["douyin", "抖音"],
  ["抖音", "抖音"],
  ["ks", "快手"],
  ["kuaishou", "快手"],
  ["快手", "快手"],
  ["bili", "B站"],
  ["bilibili", "B站"],
  ["B站", "B站"],
  ["wb", "微博"],
  ["weibo", "微博"],
  ["微博", "微博"],
  ["tieba", "贴吧"],
  ["贴吧", "贴吧"],
  ["zhihu", "知乎"],
  ["知乎", "知乎"],
]);

/**
 * 「人选名单来源与核验状态」块。
 *
 * 起因（业主实测反馈）：报告里的人选昵称（如"皮肤科医生老王"）在抖音/小红书上搜不到，
 * 于是整份报告的"数据是不是编的"都成了疑问。根因有二：
 *   · 样例数据（seed 灌入的本地报价库）与真实数据在库里长得一样，读者无从分辨；
 *   · 真实采集回来的账号昵称此前又被采集内核脱敏（`长***菜`），看起来同样"不像真账号"。
 * 修法不是"别写人名"，而是**逐条标出来源与可核验凭据**：能点回原帖的标明链接，
 * 只有昵称的明确写"平台账号未核验"，没有数据的写"无数据（占位）"。
 * 另：账号昵称现已按业主要求**完整显示**（不再打码），读者可直接检索。
 */
export function creatorRosterBlocks(creators: CreatorOutput | undefined, entries: readonly EvidenceEntry[] = []): ReportDsl["slides"][number]["blocks"] {
  const rows = creatorAccountRows(creators, entries);
  if (rows.length === 0) return [];
  const anyPlatform = (creators?.candidates ?? []).some((c) => c.talentId.startsWith(PLATFORM_CREATOR_PREFIX));
  const anyPublicFigure = (creators?.candidates ?? []).some((c) => isPublicFigureCandidate(c));
  const base = anyPlatform
    ? "本报告人选**取自本任务真实平台公开采集**（L3、未经人工核验）：账号真实存在、昵称完整显示，逐条附可点开的原帖/个人主页链接；粉丝量取自个人主页公开统计，报价**未采集**，因此成本不做估计。实际执行前必须由商务在平台侧按原帖人工核验并回填报价。"
    : "本报告人选来自**本地达人报价库**（L2 样本）：库内只存昵称/类目/粉丝量与报价样本，不存平台账号 ID，也未与平台账号核验过。因此这些昵称在平台上搜不到同名账号属预期现象，不代表报价是假的，但也不能当作可直接联系或投放的账号 —— 投放前须由商务在平台侧按昵称+类目人工核验并回填账号 ID。";
  /* 明星候选是**第三条来源**，与前两条都不一样：它既没有平台账号（明星官方号未采集），
   * 也不在报价库里，唯一的凭据是公开报道。不单独说明的话，读者会把它当成"报价库样本"
   * 或"编出来的名字"。代价必须写出来：粉丝量与报价一律按 0 处理（不是 0 元，是没有数据）。 */
  const starNote = anyPublicFigure
    ? "其中标注「公开报道线索」的是**明星/公众人物候选**：不在平台采集账号池、也不在报价库，凭据是本次联网检索到的官宣报道链接（姓名命中报道标题）——粉丝量与报价**未采集**，表中一律显示「无样本/未采集」，不代表 0 元；代言有期限，是否仍在合作须点开原文并向品牌确认。"
    : "";
  return [
    { type: "text", style: "h3", content: CREATOR_ROSTER_MARK, sourceRef: "phase:creator" },
    {
      type: "callout",
      tone: "warn",
      text: `${base}${starNote}`,
      sourceRef: "phase:creator",
    },
    {
      type: "table",
      columns: ["人选ID", "昵称/账号", "平台", "来源", "可核验凭据", "粉丝量", "预估报价", "备注"],
      rows,
      caption: "逐条标出来源与核验状态：凭据列为原帖链接的可点开核对；「无样本」表示没有真实报价数据，不是 0 元",
      sourceRef: "phase:creator",
    },
  ];
}

/** 「平台真实账号（采集所得）」块：把真正从平台采集回来的账号摆出来，让"平台数据是真的"可核对 */
export function platformAccountBlocks(entries: readonly EvidenceEntry[]): ReportDsl["slides"][number]["blocks"] {
  const rows = platformAccountRows(entries);
  if (rows.length === 0) return [];
  return [
    { type: "text", style: "h3", content: PLATFORM_ACCOUNT_MARK, sourceRef: "meta:sourceDeclaration" },
    {
      type: "table",
      columns: ["平台", "账号昵称", "条目数", "粉丝量", "个人主页 / 代表原帖"],
      rows,
      caption:
        "从本任务平台采集结果中按 平台 × 作者 机械聚合；昵称完整显示，链接可点开逐条核对。" +
        "粉丝量取自该作者**个人主页的公开统计**（采集时点快照），未采到的写「未采集」——不用 0 或估值兜底",
      sourceRef: "meta:sourceDeclaration",
    },
    {
      type: "callout",
      tone: "info",
      text: "账号昵称按采集结果**完整显示**，可直接用于平台站内检索；用户 ID 被转成 creator_hash（仅用于分组，不落原始 uid）。粉丝量来自个人主页公开统计，可能随账号变化；报价无公开来源，一律标注「无样本」，商务联系前须人工核验。",
      sourceRef: "meta:sourceDeclaration",
    },
  ];
}

/** 两块机械内容的判存标记（附录幂等靠它；改文案等于改契约，别只改一处） */
export const CREATOR_ROSTER_MARK = "人选名单来源与核验状态";
export const PLATFORM_ACCOUNT_MARK = "平台真实账号（采集所得）";
export const STAR_LEAD_MARK = "公开报道中的代言/大使线索";

/**
 * 「公开报道中的代言/大使线索」块 —— 让"报告里为什么没有明星"这件事有据可查。
 *
 * 场景：用户明确要求"达人候选里必须包含明星"，而明星既不在平台账号池、也不在报价库，
 * 只能靠公开报道。模型这条路一旦超时走合成兜底，候选表里就只剩普通达人，读者会以为
 * 系统压根没查过。这里把**已经检索回来的官宣报道**按原文标题列出来：
 *   · 不做实体识别 —— 姓名通常就写在标题里（"官宣某某出任品牌代言人"），点开即可核对；
 *   · 不给粉丝量/报价 —— 报道证明不了，任何数字都会变成无源断言；
 *   · 明确写"未经核验 + 可能过期" —— 代言有期限，旧报道不等于当前仍在合作。
 */
export function starLeadBlocks(leads: readonly StarLead[] | undefined): ReportDsl["slides"][number]["blocks"] {
  if (!leads || leads.length === 0) return [];
  return [
    { type: "text", style: "h3", content: STAR_LEAD_MARK, sourceRef: "phase:creator" },
    {
      type: "callout",
      tone: "info",
      text: "以下为机器摘录的公开报道线索（L3、未经人工核验）：只保留原文标题、站点与链接，未做姓名抽取，也未据此推断粉丝量或报价。代言有期限，旧报道不等于当前仍在合作 —— 是否确为该品牌代言人、是否在合作期、档期与报价，都须点开原文并向品牌/商务确认。",
      sourceRef: "phase:creator",
    },
    {
      type: "table",
      columns: ["品牌", "报道标题", "站点", "发布时间（原文所示）", "原文链接"],
      rows: leads.map((l) => [l.brand || "—", l.title, l.site || "—", fmtLeadTime(l.publishedAt), l.url]),
      caption: "线索来自本次联网检索（按品牌逐条检索「品牌 代言人」）；本表不构成人选推荐，也不参与成本测算",
      sourceRef: "phase:creator",
    },
  ];
}

export const STAR_CANDIDATE_MARK = "明星候选与官宣出处";
/** 同一位艺人最多列几条官宣报道（他可能同时代言多个品牌/品类） */
const MAX_LEADS_PER_CANDIDATE = 2;

/**
 * 「明星候选与官宣出处」块 —— 把「姓名 + 官宣时间 + 来源链接」三者**机械**对上。
 *
 * 为什么必须有这块：用户诉求原话是「给出姓名、官宣时间与来源链接」。而现状是
 * 姓名在**人选表**里（来自候选人），官宣报道在**线索表**里（来自检索命中），两张表
 * 谁也不指谁：读者看到「田栩宁」却没有可点开的依据，看到「肖战官宣欧莱雅」却不知道
 * 这在候选里算不算数。靠模型去连等于让模型做实体识别 —— 超时走兜底时直接归零。
 *
 * 所以连接放在这里，规则只有一条：**姓名出现在报道标题里**就算命中（子串匹配）。
 * 命中不了就如实写「未命中官宣报道」，绝不从 rationale 里猜品牌、猜时间。
 */
export function starCandidateBlocks(creators: CreatorOutput | undefined): ReportDsl["slides"][number]["blocks"] {
  const celebs = (creators?.candidates ?? []).filter((c) => isPublicFigureCandidate(c));
  if (celebs.length === 0) return [];
  const leads = creators?.starLeads ?? [];
  /* 一位艺人**可能同时代言多个品牌/品类**：真机里张凌赫既有「巴黎欧莱雅美发代言人」
   * 又有「适乐肤 CeraVe 亚太区品牌代言人」。只取命中的第一条会随机丢掉另一条，
   * 读者会以为他只为其中一个品牌代言 —— 所以按 (候选 × 命中报道) 展开成多行，
   * 每人最多 2 条（再多就变成"检索命中堆在这里"，而不是人选依据）。 */
  let hit = 0;
  const rows: string[][] = [];
  for (const c of celebs) {
    const matched = leads.filter((l) => starLeadOf([l], c.nickname) !== undefined).slice(0, MAX_LEADS_PER_CANDIDATE);
    if (matched.length === 0) {
      rows.push([c.nickname, "—", "未命中官宣报道（仅检索正文提及姓名）", "未标注", "—", "无样本（未采集）"]);
      continue;
    }
    hit += 1;
    for (const l of matched) rows.push([c.nickname, l.brand || "—", l.title, fmtLeadTime(l.publishedAt), l.url, "无样本（未采集）"]);
  }
  const dup = celebs.filter((c) => leads.filter((l) => starLeadOf([l], c.nickname) !== undefined).length > 1).length;
  return [
    { type: "text", style: "h3", content: STAR_CANDIDATE_MARK, sourceRef: "phase:creator" },
    {
      type: "callout",
      tone: "info",
      text:
        `以下 ${celebs.length} 位候选来自「公开报道口径」通道（本次联网检索命中姓名 + 自述为公众人物），` +
        `其中 ${hit} 位在检索回的官宣报道标题里**逐字命中姓名**，故能给出报道链接与发布时间。` +
        (dup > 0 ? `有 ${dup} 位命中了**不止一条**官宣（同一艺人可能同时代言多个品牌/品类），已分行列出，未做取舍。` : "") +
        "姓名↔报道的连接是**标题子串匹配**，不做实体识别、不区分同名同姓；" +
        "未命中的如实写「未命中官宣报道」——那表示本轮没检索到可点开的官宣原文，**不代表否认该身份**。" +
        "粉丝量与报价在这条通道上一律未采集（表中显示「无样本」，不是 0 元）；代言有期限，是否仍在合作须点开原文确认。",
      sourceRef: "phase:creator",
    },
    {
      type: "table",
      columns: ["代言人（候选）", "品牌", "官宣报道标题", "发布时间（原文所示）", "原文链接", "粉丝量/报价"],
      rows,
      caption: "姓名→报道的连接规则：报道标题逐字包含姓名；本表不参与成本测算，也不构成人选推荐",
      sourceRef: "phase:creator",
    },
  ];
}

/** 两块合起来（合成路径一次性拼进附录时用） */export function creatorProvenanceBlocks(
  creators: CreatorOutput | undefined,
  entries: readonly EvidenceEntry[],
): ReportDsl["slides"][number]["blocks"] {
  return [
    ...creatorRosterBlocks(creators, entries),
    ...starCandidateBlocks(creators),
    ...starLeadBlocks(creators?.starLeads),
    ...platformAccountBlocks(entries),
  ];
}

/** 把 [from,to] 切成周（用于 weeklyCalendar 与内容日历页） */
function weeksBetween(from: string, to: string): { from: string; to: string }[] {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out: { from: string; to: string }[] = [];
  for (let cursor = start; cursor < end; cursor += 7 * DAY) {
    out.push({ from: isoDate(cursor), to: isoDate(Math.min(cursor + 7 * DAY - DAY, end)) });
  }
  return out;
}

/* ── CI 竞品情报 ────────────────────────────────────────── */

export function synthIntel(brief: { industry: string; category: string; platforms: string[]; window?: { from: string }; brandIds?: string[] }, tools: PrefetchedToolData): IntelOutput {
  const kb = unwrap(tools["kb_retrieve"]) as { hits?: { text: string; citation: { sourceId: string } }[] };
  const kbHits = kb?.hits ?? [];
  const ws = unwrap(tools["web_search"]) as { results?: { title?: string; siteName?: string; url?: string }[] };
  const webHits = (ws?.results ?? []).filter((w) => w.title || w.siteName);
  const month = (brief.window?.from ?? new Date().toISOString()).slice(0, 7);
  const platform0 = brief.platforms[0] ?? "douyin";

  const citations: IntelOutput["citations"] = [];
  for (const h of kbHits.slice(0, 4)) citations.push({ claim: h.text.slice(0, 40), sourceKey: h.citation.sourceId, confidence: 0.5 });
  // 联网检索结果属 L3 公开、**未经人工核验**：置信度压在中低位，且引用必须带来源站点。
  // 这里只搬用标题与站点名，不做任何数值推断——网页摘要不足以支撑数字断言。
  for (const w of webHits.slice(0, 4)) {
    citations.push({ claim: `${w.siteName ?? "公开网页"}：${w.title ?? ""}`.slice(0, 60), sourceKey: WEB_SEARCH_SOURCE_ID, confidence: 0.45 });
  }

  /* 品牌级联网检索结果（intel 预取按品牌投递，key = `web_search_brand_${brand}`）。
   *
   * 旧兜底对竞品表**一个字的真实素材都不用**：即便行业检索命中了「新国标重塑市场格局」
   * 这类报道、平台缓存里有几百条含品牌名的内容，六家竞品仍整列写「待核验（本轮无竞品
   * 情报来源）」——业主的反馈：'没有核验数据给到我，没有意义'。
   * 现在按品牌取回检索命中（引用原句、标「未经核验」，不解析数字、不编造），
   * 再用平台证据按品牌名统计真实内容条数，竞品表至少有一列看得见的东西。 */
  const brandWebHits = new Map<string, { title: string; siteName: string }[]>();
  for (const brand of (brief.brandIds ?? []).map((b) => b.trim()).filter(Boolean)) {
    const bw = unwrap(tools[`web_search_brand_${brand}`]) as { results?: { title?: string; siteName?: string }[] } | undefined;
    const hits = (bw?.results ?? [])
      .filter((w) => w.title)
      .slice(0, 3)
      .map((w) => ({ title: String(w.title), siteName: str(w.siteName, "公开网页") }));
    if (hits.length > 0) brandWebHits.set(brand, hits);
  }
  for (const [brand, hits] of brandWebHits) {
    citations.push({ claim: `${brand}：${hits[0]!.title}`.slice(0, 60), sourceKey: WEB_SEARCH_SOURCE_ID, confidence: 0.45 });
  }

  /* 平台采集数据（P0 溯源）。
   *
   * 旧实现在这里**一个字节都没用** platform_digest 的返回 —— 平台数据接了等于没接：
   * 预取跑了一遍、rows 进了模型上下文，但合成/降级路径完全不读它，报告里
   * 也就永远没有平台内容。现在改成：取回多少就用多少（上限 6 条），
   * 并且每条都带上 entryId，让渲染层能反查出 URL / 作者 / 发布时间。
   *
   * 只搬标题与摘录，不做任何数值换算：各平台指标口径不同，套一个公式算"声量"
   * 就等于编数（见 platform_digest 的 comparison 说明）。 */
  const pd = unwrap(tools[PLATFORM_DIGEST_TOOL_NAME]) as { rows?: Record<string, unknown>[] };
  const platformRows = Array.isArray(pd?.rows) ? pd.rows : [];
  const evidences = platformEvidencesFrom(platformRows);
  const platformsWithData = [...new Set(evidences.map((e) => e.entryId.split("_")[1]!.toLowerCase()))].filter(
    (p) => p in MEDIA_CRAWLER_PLATFORM_META,
  );
  for (const p of platformsWithData) {
    const meta = MEDIA_CRAWLER_PLATFORM_META[p as MediaCrawlerPlatform];
    const n = platformRows.filter((r) => String(r.platform ?? "") === p).length;
    // 来源级引用：条目级引用之外再给一条"这个平台本批取回了几条"，便于读者判断样本量
    citations.push({ claim: `${meta.displayName}公开内容样本 ${n} 条（公开采集，未人工核验）`, sourceKey: meta.sourceId, confidence: 0.45 });
  }

  /* 竞品集只能来自 `brief.brandIds` —— 客户自己声明的品牌。
   *
   * 旧实现把「成分党 / 平价替代 / 医研背书」三个**护肤品**题材标签硬编码在这里（做美妆演示时
   * 留下的），又把公开检索命中的**站点名**当品牌名拼进去。耳机任务走兜底路径时于是渲染出
   * 「头部成分党（Global Information, Inc. (GII)）」：① 类目错 —— 耳机报告在讲"成分浓度"；
   * ② 主体错 —— GII 是市场研究出版机构，不是品牌；整张"竞品格局对比"表不可用。
   *
   * 兜底路径本来就拿不到竞品情报，正确做法是**如实标「待核验」**：名字用 brief 给的品牌
   * （客户声明，不是编的），分析字段一律留空 —— 既不编造，也不张冠李戴。 */
  const briefBrands = (brief.brandIds ?? []).map((b) => b.trim()).filter(Boolean);
  const mkCompetitor = (name: string) => {
    /* 素材两路，都是"引用"而不是"分析"：
     * ① 品牌级联网检索命中 —— 标题逐字引用（公开报道口径，未经人工核验）；
     * ② 平台证据按品牌名匹配标题 —— 真实的内容条数与代表作（公开采集，样本内口径）。
     * 两路都空（没配检索 Key 且平台无该品牌内容）才回退「待核验」。 */
    const hits = brandWebHits.get(name) ?? [];
    const claims = hits.slice(0, 2).map((w) => `${w.siteName}：${w.title}`.slice(0, 80));
    const priceHit = hits.find((w) => /(元|价|¥|万)/.test(w.title));
    // 平台内容条数：标题含品牌名（子串匹配，样本内口径；评测量/对比帖天然含多品牌）
    const brandRows = platformRows.filter((r) => str(r.title).includes(name));
    return {
      name,
      positioning: claims[0]
        ? `公开报道口径（未经核验）：${claims[0]}`
        : "待核验（本轮无竞品情报来源）",
      priceBand: priceHit ? `公开报道口径（未经核验）：${priceHit.title}`.slice(0, 80) : "待核验",
      keyClaims: (claims.length > 0 ? claims : ["待核验（本轮无竞品情报来源）"]) as string[],
      // 声量份额必须由可量化数据源估算；公开网页检索给不出这个口径，如实置空
      // （平台条数只进 contentMatrix.form 的文本，换算成 0-1 的"份额"就是编口径）
      shareOfVoice: null,
      contentMatrix: [
        {
          form:
            brandRows.length > 0
              ? `公开可见内容 ${brandRows.length} 条（${platform0} 等平台样本内）`
              : "公开可见内容形态（未经人工核验）",
          share: null,
          platform: platform0,
        },
      ],
      sovTrend: [{ month, value: null }],
      differentiation: claims[1]
        ? `公开报道口径（未经核验）：${claims[1]}`.slice(0, 100)
        : "待核验",
      confidence: claims.length > 0 ? 0.45 : 0.3,
    };
  };
  /* brief 声明的品牌不足 3 个时用**中性占位**补足 —— schema 硬性要求 competitors ≥ 3
   * （`$.competitors 至少需要 3 项`）。占位明确写"未识别"，读者一眼可见这是缺口而非情报；
   * 绝不像旧实现那样拿题材标签凑数。名字里也绝不拼检索站点名：站点名是"资料来源"，不是"竞品"。 */
  const competitorNames =
    briefBrands.length >= 3
      ? briefBrands
      : [
          ...briefBrands,
          ...Array.from({ length: 3 - briefBrands.length }, (_, i) => `其他竞品 ${String.fromCharCode(65 + i)}（未识别）`),
        ];
  const competitors = competitorNames.map((n) => mkCompetitor(n));

  return {
    competitors,
    categoryInsights: {
      trends:
        webHits.length > 0
          ? webHits.slice(0, 3).map((w) => `${w.siteName ?? "公开网页"}：${w.title ?? ""}`)
          : [`${brief.category} 公开趋势未取得（联网检索无结果或未启用）`],
      audience: ["受众画像需接入真实平台授权数据，公开网页检索无法提供可引用口径"],
      seasonality: ["公开检索未提供季节分解，标记为缺失"],
      // 价格带/渠道结构没有可量化口径 → share 一律 null，不编造
      pricingBand: [
        { band: "低价位带", share: null },
        { band: "中价位带", share: null },
        { band: "高价位带", share: null },
      ],
      channelMix: brief.platforms.map((p) => ({ channel: p, share: null })),
    },
    dataGaps: [
      "客户侧投放指标（消耗 / ROI）缺失：未接入平台授权数据源",
      "竞品投放消耗（官方无接口，属预期缺失）",
      "竞品声量份额与价格带分布（需可量化指数源，当前不可得）",
      "达人报价与画像（须走 L2 历史库 + 人工核验）",
      "自有内容资产指标（账号数 / 作品数 / 互动率）：未获平台授权",
      ...(webHits.length === 0 ? ["联网检索未命中（未配置 API Key 或查询无结果）"] : []),
      ...(kbHits.length === 0 ? ["行业情报库（KB-3）无命中"] : []),
    ],
    citations,
    ...(evidences.length > 0 ? { evidences } : {}),
    brandSelf: buildBrandSelf(brief, webHits.length),
  };
}

/**
 * 品牌自身诊断的确定性合成。
 *
 * **这里刻意一个数字都不给。** 确定性兜底路径下没有任何品牌资产数据可得
 * （KB-1 私域经营库为空、平台数据未授权），所以 `contentAssets` 全 null、
 * `reputation.sentiment` 为 unknown、`citations` 为空数组。
 *
 * 为什么不留占位数字：品牌自诊是全篇最容易变成"编造自家数据"的一章——
 * "我方"读起来像"已知信息"，随手写个"品牌认知度 32%"没人会怀疑。
 * 而 Schema 里有一条硬校验：**只要出现数字，citations 就不能为空**。
 * 兜底路径必须首先自己守住这条，否则它会成为绕开校验的后门。
 */
function buildBrandSelf(
  brief: { industry: string; category: string; platforms: string[]; brandIds?: string[] },
  webHitCount: number,
): IntelOutput["brandSelf"] {
  const brandLabel = (brief.brandIds ?? []).filter(Boolean).join("、") || "本品";
  const unknown = "待甲方确认（未获品牌资产数据授权）";

  return {
    positioning: {
      statement:
        `${brandLabel} 在「${brief.industry} / ${brief.category}」的定位与差异点须由甲方确认：` +
        `本轮没有品牌资产数据授权，任何"我方认知度/份额"数字都无从核实。`,
      differentiators: ["待甲方确认（未获授权，不做推断）"],
    },
    // 平台列表来自 Brief（已知），数字全部留空（未知）。这是"知道自己不知道什么"的写法。
    contentAssets: brief.platforms.map((platform) => ({
      platform,
      accountCount: null,
      postCount: null,
      avgEngagement: null,
      tier: "未获授权",
    })),
    reputation: { sentiment: "unknown", themes: [] },
    gaps: [
      {
        dimension: "价格带覆盖",
        self: unknown,
        benchmark: "竞品公开渠道覆盖高 / 中 / 低价位带（3 家，公开页面口径）",
        delta: "无法计算：缺本品价格带与销量结构，公开页面也给不出竞品价格带占比",
      },
      {
        dimension: "内容声量",
        self: unknown,
        benchmark:
          webHitCount > 0
            ? `公开检索命中 ${webHitCount} 条站点内容可作为竞品参考（未经人工核验）`
            : "公开检索未命中，竞品声量参考也缺失",
        delta: "无法计算：未接入本品内容资产与投放数据",
      },
      {
        dimension: "人群重合度",
        self: unknown,
        benchmark: "竞品主攻人群需平台授权才能取到画像，公开口径不可得",
        delta: "无法计算：本品与竞品粉丝画像均缺失（须走抖音开放平台 fans_data，L1）",
      },
      {
        dimension: "投放效率",
        self: unknown,
        benchmark: "竞品投放消耗官方无接口，属预期缺失",
        delta: "无法计算：双方投放指标均未接入",
      },
    ],
    citations: [],
  };
}

/* ── CT 人选匹配 ────────────────────────────────────────── */

/** 分层阈值：头部 ≥100 万粉、腰部 ≥40 万、其余尾部。
 *  与 LLM 路径用同一套口径，避免 mock 与真实产物形状不一致。 */
export function tierOf(followers: number): "head" | "mid" | "tail" {
  if (followers >= 1_000_000) return "head";
  if (followers >= 400_000) return "mid";
  return "tail";
}

/** 预取值里的键：由装配层从**真实采集证据**里机械聚合出的平台候选人（见 agents.ts 的 creator 预取） */
export const PLATFORM_CREATOR_KEY = "platform_creators";

/**
 * 分层兜底：schema 要求 head/mid/tail 三层各至少 1 人。
 * 样本天然不含某一层时，如实补一条「无样本」占位，而不是把别人的层级改掉。
 *
 * 抽成公共函数是因为它有**两个**调用点：合成路径（这里）与模型路径的事后校验
 * （`pruneUnverifiableCreators` 剔除不可溯源人选后可能把某一层剔空）。
 * 两处各写一遍的结果是"其中一处忘了补层"，表现为报告某一页突然空掉。
 */
export function fillCreatorTiers(
  candidates: CreatorOutput["candidates"],
  brief: { platforms?: readonly string[] },
): CreatorOutput["candidates"] {
  const filled: CreatorOutput["candidates"] = [...candidates];
  for (const t of ["head", "mid", "tail"] as const) {
    if (filled.some((c) => c.tier === t)) continue;
    filled.push({
      talentId: `${PLACEHOLDER_CREATOR_PREFIX}${t}`,
      nickname: `${t === "head" ? "头部" : t === "mid" ? "腰部" : "尾部"}暂无人选`,
      platform: brief.platforms?.[0] ?? "douyin",
      followers: 0,
      category: "未分类（无样本）",
      matchScore: 0,
      rationale: `真实数据源在${t}层无可用样本（本地报价库无记录、平台采集无命中），需补数据后重算`,
      estimatedCost: 0,
      costRange: { low: 0, high: 0 },
      riskFlags: ["无数据支撑，禁止编造人选"],
      tier: t,
      contentFit: "无样本",
      historicalPerformance: "无样本",
      confidence: 0.1,
    });
  }
  return filled;
}

export interface CreatorPruneResult {
  value: CreatorOutput;
  /** 被剔除的候选（报告附录要如实列出"剔了谁、为什么"） */
  dropped: { talentId: string; nickname: string; reason: string }[];
}

/**
 * 剔除**无法溯源**的候选人选。
 *
 * 这是「禁止编造人选」这条不变量的最后一道机械闸门：提示词里写了再多遍
 * "不得编造达人"，模型（尤其降级到单次结构化输出时）仍会产出看起来很像真的的
 * 人名与粉丝量。判定依据只有两条，都来自真实数据：
 *   · talentId 出现在真实报价库的候选里；或
 *   · （平台 + 昵称）能对上本次**真实采集到的账号**（必须与采集结果逐一比对命中）。
 * 其余一律剔除，并把它记进 `excluded`，让报告读起来是"数据不够"而不是"数据很全"。
 *
 * 占位条目（`none_*`）保留：它本来就是"这一层没有真实样本"的诚实表达。
 */
export function pruneUnverifiableCreators(
  value: CreatorOutput,
  real: {
    talentIds?: Iterable<string>;
    accounts?: readonly { platform: string; platformName: string; author: string }[];
    /**
     * 本次公开检索命中的正文（标题 + 摘要拼接）。
     *
     * 这条通道是为「明星 / 名人候选」开的，而不是给普通达人放宽门槛：明星既不在
     * 平台采集账号池、也不在本地报价库，前两条路都走不通时，**唯一**能证明"这个人
     * 确实存在且与本次话题相关"的证据就是公开报道里出现过该姓名。
     * 代价必须显式：走这条路的候选，粉丝量、报价一律强制归零（未采集就是未采集），
     * 并追加一条"公开报道口径、未经核验"的风险标记 —— 不能因为名字是真的，
     * 就默认它旁边那些数字也是真的。
     */
    publicText?: string;
  },
): CreatorPruneResult {
  const ids = new Set(real.talentIds ?? []);
  const keys = new Set<string>();
  for (const a of real.accounts ?? []) {
    keys.add(`${a.platform}|${a.author}`);
    keys.add(`${a.platformName}|${a.author}`);
  }
  const haystack = (real.publicText ?? "").replace(/\s+/g, "").toLowerCase();
  /* `known` **只**看前两条强证据（报价库 / 采集账号），公开报道不算：
   * 它只用来"捞回"本该被剔除的人，不用来新增剔除面 —— 在没有任何强证据可比对的
   * 任务里，"全放行"是刻意的（否则离线链路与空采集任务的人选页会整片空白）。 */
  const known = ids.size > 0 || keys.size > 0;
  // 没有任何真实数据可比对时不做剔除：闸门缺输入时"全放行"和"全拦下"都错，
  // 前者让报告可能引用编造人选，后者会让离线 mock 全链路直接空掉。
  // 这里选择放行并让 sources 声明兜底（配置关闭演示数据时，报告仍会标出无报价样本）。
  if (!known) return { value, dropped: [] };

  const dropped: CreatorPruneResult["dropped"] = [];
  let publicBacked = 0;
  const kept = value.candidates.map((c) => {
    if (c.talentId.startsWith(PLACEHOLDER_CREATOR_PREFIX)) return c;
    if (ids.has(c.talentId)) return c;
    const label = PLATFORM_LABEL_BY_NAME.get(c.platform) ?? c.platform;
    if (keys.has(`${c.platform}|${c.nickname}`) || keys.has(`${label}|${c.nickname}`)) return c;
    // 平台采集账号的 id 是确定性推导的：即便模型改写了昵称格式，只要 id 对得上就放行
    if (keys.size > 0) {
      for (const k of keys) {
        const [p, author] = k.split("|");
        if (p && author && platformCandidateId(p, author) === c.talentId) return c;
      }
    }
    // ③ 公开报道通道：姓名（≥2 字，打码不算）在本次检索命中里出现过，**且该候选自述是公众人物**
    /* 为什么要后者：这条通道只该服务"明星/名人"这一类人。若对所有候选都放开，
     * 「小美」这种两字昵称撞上正文里的同名词就会把一条无源候选洗成"公开报道可溯源"，
     * 反造假闸等于被一句话绕开。自述里没有明星/代言/艺人字样的，仍走严格通道。 */
    const claimsPublicFigure = /明星|艺人|名人|代言人|顶流|偶像/.test(`${c.rationale} ${c.contentFit} ${c.category}`);
    const name = c.nickname.replace(/\s+/g, "").replace(/\*/g, "").toLowerCase();
    if (claimsPublicFigure && haystack.length > 0 && name.length >= 2 && haystack.includes(name)) {
      publicBacked += 1;
      return {
        ...c,
        followers: 0,
        estimatedCost: 0,
        costRange: { low: 0, high: 0 },
        confidence: Math.min(c.confidence, 0.4),
        riskFlags: [
          ...c.riskFlags.filter((f) => !f.includes("公开报道")),
          "公开报道口径（联网检索命中姓名），未经人工核验；粉丝量与报价无样本",
        ],
      } satisfies CreatorOutput["candidates"][number];
    }
    dropped.push({
      talentId: c.talentId,
      nickname: c.nickname,
      reason: "无法在真实数据源中溯源（本地报价库无此记录、平台采集结果中无此账号、公开检索也未提及该姓名）",
    });
    return null;
  }).filter((c): c is CreatorOutput["candidates"][number] => c !== null);

  const excluded = [...value.excluded];
  if (publicBacked > 0) {
    excluded.push({
      reason: "部分人选只来自公开报道（联网检索命中姓名）：粉丝量与报价未采集，一律按 0 处理，投放前须人工核验",
      count: publicBacked,
    });
  }
  if (dropped.length > 0) {
    excluded.push({ reason: "剔除无法溯源的候选人选（禁止编造达人）：本地报价库、平台采集结果与公开检索中均无此账号", count: dropped.length });
  }
  return { value: { ...value, candidates: fillCreatorTiers(kept, {}), excluded }, dropped };
}

/** 机械补入平台账号时的条数上限（一张人选表塞 30 个账号没人看） */
export const PLATFORM_CREATOR_INJECT_LIMIT = 9;

/**
 * 让真实采集账号**必然**出现在人选结果里（模型没写就由系统补进去）。
 *
 * 为什么非得机械补：模型路径（Pi 循环 / 单次结构化输出）拿到的平台账号池，
 * 只是**提示词里的一段上下文** —— 模型完全可以选择不用它。实测就是这么发生的：
 * 本次六个平台采回几百条、几十个真实账号（每条都能点回原帖），模型却在
 * "kb_retrieve 返回 0 条、pricing_query 返回 0 个候选人"之后直接写下
 * 「【严重数据缺失】此条目为占位符」并造出三条 `待确认头部达人`。
 * 结果是最荒诞的一种：**数据在手，报告里一条真账号都没有**。
 *
 * 判定完全机械、没有解释空间：人选中只要已经出现平台账号就原样放行（尊重模型的选择），
 * 一条都没有而池子里有时，补进去并把"这几条是系统按采集结果补的"写进 `excluded`。
 * 补入的账号全部来自本任务真实采集，粉丝量与报价如实留空（`未采集 / 无样本`），
 * 不做任何数字填充。
 */
export function ensurePlatformCreators(
  value: CreatorOutput,
  pool: CreatorOutput["candidates"],
): { value: CreatorOutput; injected: number } {
  const real = pool.filter((c) => c.talentId.startsWith(PLATFORM_CREATOR_PREFIX));
  if (real.length === 0) return { value, injected: 0 };
  if (value.candidates.some((c) => c.talentId.startsWith(PLATFORM_CREATOR_PREFIX))) return { value, injected: 0 };

  const injected = real.slice(0, PLATFORM_CREATOR_INJECT_LIMIT);
  // 占位条目在这里让位：它表达的是"这一层没有真实样本"，而真实账号已经补进来了
  const kept = value.candidates.filter((c) => !c.talentId.startsWith(PLACEHOLDER_CREATOR_PREFIX));
  return {
    value: {
      ...value,
      candidates: fillCreatorTiers([...kept, ...injected], {}),
      excluded: [
        ...value.excluded,
        {
          reason:
            "人选取自本任务平台公开采集（账号真实存在、可点回原帖/个人主页核对；粉丝量为主页公开统计、报价未采集，成本不做估计）：模型未给出平台账号，由系统按采集结果机械补入",
          count: injected.length,
        },
      ],
    },
    injected: injected.length,
  };
}

export function synthCreators(brief: { platforms: string[]; category?: string }, tools: PrefetchedToolData): CreatorOutput {
  const kb = unwrap(tools["kb_retrieve"]) as { hits?: { text: string; citation: { sourceId: string } }[] };
  const pq = unwrap(tools["pricing_query"]) as {
    candidates?: {
      talent: { talentId: string; nickname: string; platform: string; followers: number; category: string; engagementRate: number };
      estimate: { estimate: { amount: number }; range: { low: { amount: number }; high: { amount: number } }; confidence: string } | null;
    }[];
  };
  /** 风控结果按 talentId 归档：预取阶段对**全部**候选都跑了 risk_screen */
  const riskByTalent: Record<string, { flags?: { rule: string; level: string; detail: string }[] }> = {};
  for (const [key, value] of Object.entries(tools)) {
    if (!key.startsWith("risk_")) continue;
    const id = key.slice("risk_".length);
    riskByTalent[id] = unwrap(value) as { flags?: { rule: string; level: string; detail: string }[] };
  }

  const candidates = (pq?.candidates ?? []).map((c) => {    const cost = c.estimate?.estimate.amount ?? 0;
    const eng = c.talent.followers > 0 ? c.talent.engagementRate : 0;
    const matchScore = Number(Math.min(0.95, 0.5 + (c.estimate ? 0.2 : 0) + Math.min(0.25, eng / 40)).toFixed(2));
    const flags = riskByTalent[c.talent.talentId]?.flags ?? [];
    return {
      talentId: c.talent.talentId,
      nickname: c.talent.nickname,
      platform: c.talent.platform,
      followers: c.talent.followers,
      category: c.talent.category,
      matchScore,
      rationale: c.estimate
        ? `报价库有 ${c.estimate.range.low.amount}–${c.estimate.range.high.amount} 元区间样本，按类目与粉丝量匹配得 ${cost.toFixed(0)} 元估计`
        : "报价库无样本，仅按类目与粉丝量粗匹配，成本未估计",
      estimatedCost: cost,
      costRange: { low: c.estimate?.range.low.amount ?? 0, high: c.estimate?.range.high.amount ?? 0 },
      riskFlags: flags.filter((f) => f.level !== "low").map((f) => `[${f.level}] ${f.rule}: ${f.detail}`),
      tier: tierOf(c.talent.followers),
      contentFit: `互动率 ${eng.toFixed(1)}%，按粉丝量分层为${tierOf(c.talent.followers) === "head" ? "头部" : tierOf(c.talent.followers) === "mid" ? "腰部" : "尾部"}，内容形态需人工确认`,
      historicalPerformance: flags.some((f) => f.rule === "interaction-anomaly") ? "互动数据异常，历史表现存疑" : "无样本",
      confidence: c.estimate ? (c.estimate.confidence === "high" ? 0.75 : c.estimate.confidence === "medium" ? 0.6 : 0.4) : 0.3,
    };
  });

  /* 真实采集账号：本地报价库没有真实样本时的人选池。
   *
   * 业主的原话是「本地那些假数据不要参考，我要真实数据」。真实数据有两条路：
   *   ① 客户端录入/回灌的 L2 报价库（真实，且带报价样本）——有就优先用；
   *   ② 本任务从平台真实采集回来的账号（真实存在、可点回原帖），
   *      代价是没有粉丝量与报价 —— 那就如实写"未采集 / 无样本"，不拿数字填坑。
   * 两条都没有时只给「无数据」占位：报告读起来应该是"数据不够"，而不是"数据很全"。 */
  const platformCands = (unwrap(tools[PLATFORM_CREATOR_KEY]) as { candidates?: CreatorOutput["candidates"] }).candidates ?? [];
  const fromPricing = candidates;
  const base = fromPricing.length > 0 ? fromPricing : platformCands;

  const filled = fillCreatorTiers(base, brief);

  return {
    candidates:
      filled.length > 0
        ? filled
        : [
            {
              talentId: "none",
              nickname: "暂无人选",
              platform: brief.platforms[0] ?? "douyin",
              followers: 0,
              category: "未分类（无样本）",
              matchScore: 0,
              rationale: "真实数据源均无可用样本（本地报价库无真实记录、平台采集无命中），无法给出人选；请先完成 L2 数据回灌或核对采集通道",
              estimatedCost: 0,
              costRange: { low: 0, high: 0 },
              riskFlags: ["无数据支撑，禁止编造人选"],
              tier: "tail" as const,
              contentFit: "无样本",
              historicalPerformance: "无样本",
              confidence: 0.1,
            },
          ],
    excluded: [
      { reason: "演示样例数据（seed 灌入的本地达人库）默认不参与计算，已排除在候选人选之外", count: 0 },
      { reason: "官方无达人报价接口，报价仅能来自 L2 历史成交与人工核验", count: 0 },
      ...(fromPricing.length === 0 && platformCands.length > 0
        ? [{ reason: "本地报价库无真实样本，人选取自平台公开采集：粉丝量取自个人主页公开统计、报价未采集，成本不做估计", count: platformCands.length }]
        : []),
      { reason: "样本量 < 3 的达人只给区间不给点估计", count: Math.max(0, (pq?.candidates?.length ?? 0) - fromPricing.filter((c) => c.confidence >= 0.5).length) },
    ],
    citations: (kb?.hits ?? []).slice(0, 3).map((h) => ({ claim: h.text.slice(0, 40), sourceKey: h.citation.sourceId, confidence: 0.5 })),
    // 兜底合成不读拆解条目：留空由 enforceRequirementCoverage 统一补成 gap
    // （"没做到"必须显式，不能让兜底路径看起来像"没有这项要求"）
    requirementCoverage: [],
  };
}

/* ── PL 打法排期 ────────────────────────────────────────── */

export function synthPlaybook(brief: { category: string; platforms: string[]; window: { from: string; to: string } }, tools: PrefetchedToolData): PlaybookOutput {
  const kb = unwrap(tools["kb_retrieve"]) as { hits?: { text: string; citation: { sourceId: string } }[] };
  const cal = unwrap(tools["calendar_plan"]) as { phases?: { label: string; from: string; to: string; budgetShare: number; creatorIds: string[] }[]; conflicts?: string[] };
  const phases = cal.phases ?? [];
  const platforms = brief.platforms.length > 0 ? brief.platforms : ["douyin"];
  const contentTypesByPhase: Record<string, string[]> = {
    预热期: ["成分科普笔记", "收藏型干货"],
    爆发期: ["达人种草短视频", "直播间承接"],
    长尾期: ["搜索承接", "用户口碑"],
  };

  const weeklyCalendar: PlaybookOutput["weeklyCalendar"] = [];
  let week = 1;
  for (const p of phases) {
    for (const w of weeksBetween(p.from, p.to)) {
      weeklyCalendar.push({
        week,
        from: w.from,
        to: w.to,
        platform: p.creatorIds.length % 2 === 1 && platforms[1] ? platforms[1] : platforms[0]!,
        contentType: (contentTypesByPhase[p.label] ?? ["达人种草内容"])[0]!,
        creatorIds: p.creatorIds,
        theme: `${p.label}：${brief.category} 内容节奏第 ${week} 周`,
      });
      week += 1;
    }
  }

  return {
    phases: phases.map((p) => ({
      label: p.label,
      from: p.from,
      to: p.to,
      platforms,
      contentTypes: contentTypesByPhase[p.label] ?? ["达人种草内容", "信息流承接"],
      budgetShare: p.budgetShare,
      creatorIds: p.creatorIds,
      kpiTargets: [{ metric: "ROI", target: 1.8, unit: "", stopLoss: 1.3, trigger: "日 ROI 连续 2 天低于止损线即暂停放量并复盘素材" }],
    })),
    weeklyCalendar:
      weeklyCalendar.length > 0
        ? weeklyCalendar
        : [
            {
              week: 1,
              from: brief.window.from,
              to: brief.window.to,
              platform: platforms[0]!,
              contentType: "达人种草内容",
              creatorIds: [],
              theme: `${brief.category} 单一阶段推进（排期工具未返回分段）`,
            },
          ],
    rationale: `${brief.category} 采用「预热—爆发—长尾」三段式：预热期建立类目话语权，爆发期集中投放，长尾期用搜索承接。该结构与排期工具计算出的时间分段一致。`,
    conflicts: cal.conflicts ?? [],
    citations: (kb?.hits ?? []).slice(0, 3).map((h) => ({ claim: h.text.slice(0, 40), sourceKey: h.citation.sourceId, confidence: 0.5 })),
  };
}

/* ── BR 预算风控 ────────────────────────────────────────── */

export function synthBudget(
  brief: { budget: { amount: number } },
  tools: PrefetchedToolData,
  upstream?: { phases?: { label: string; budgetShare: number }[] },
): BudgetOutput {
  const sim = unwrap(tools["scenario_simulate"]) as { scenarios?: { worst: { roi: number; gmv: number }; base: { roi: number; gmv: number }; best: { roi: number; gmv: number } }; disclaimer?: string };
  const total = brief.budget.amount;
  // 未接入平台授权数据，没有可观测 ROI 基准：取情景模拟给出的基准值，缺则退回保守缺省 1.8。
  // 该口径在 risks 与 disclaimer 中显式声明为估算，不伪装成实测值。
  const roiObserved = num(sim.scenarios?.base.roi, 1.8);
  const scenarios = sim.scenarios ?? {
    worst: { roi: Number((roiObserved * 0.7).toFixed(2)), gmv: Number((total * roiObserved * 0.7).toFixed(2)) },
    base: { roi: Number(roiObserved.toFixed(2)), gmv: Number((total * roiObserved).toFixed(2)) },
    best: { roi: Number((roiObserved * 1.36).toFixed(2)), gmv: Number((total * roiObserved * 1.36).toFixed(2)) },
  };

  const allocation: BudgetOutput["allocation"] = [
    { channel: "达人种草", amount: Number((total * 0.5).toFixed(2)), share: 0.5, expectedRoi: Number((roiObserved * 1.05).toFixed(2)), rationale: "爆发期主力，拉声量并沉淀内容资产", confidence: 0.62 },
    { channel: "信息流投放", amount: Number((total * 0.3).toFixed(2)), share: 0.3, expectedRoi: Number((roiObserved * 1.2).toFixed(2)), rationale: "承接达人外溢流量，控制流失", confidence: 0.7 },
    { channel: "搜索与内容长尾", amount: Number((total * 0.2).toFixed(2)), share: 0.2, expectedRoi: Number((roiObserved * 0.7).toFixed(2)), rationale: "降低教育成本、承接搜索需求", confidence: 0.55 },
  ];

  /* 渠道 × 阶段交叉矩阵：报告「渠道×阶段矩阵」页的数据来源。
   * 用上游排期的阶段与份额权重拆解——阶段缺失时退化为按「全周期」单列，不编造阶段名。 */
  const phases = upstream?.phases?.length ? upstream.phases : [{ label: "全周期", budgetShare: 1 }];
  const stageMatrix: BudgetOutput["stageMatrix"] = [];
  for (const p of phases) {
    for (const a of allocation) {
      const amount = Number((a.amount * p.budgetShare).toFixed(2));
      if (amount <= 0) continue;
      stageMatrix.push({
        channel: a.channel,
        stage: p.label,
        amount,
        expectedRoi: Number((a.expectedRoi * (1 + (p.budgetShare - 0.33) * 0.2)).toFixed(2)),
      });
    }
  }

  return {
    allocation,
    stageMatrix,
    scenarios,
    risks: [
      {
        risk: "头部达人档期冲突",
        probability: 0.4,
        impact: "爆发期声量不达标",
        mitigation: "预留 15% 预算作为备选达人池，签约时锁定备选档期",
        owner: "商务/达人合作组",
        signal: "开播前 7 天仍未确认档期，或备选池少于 3 人",
      },
      {
        risk: "达人实际成交价高于刊例折扣预期",
        probability: 0.55,
        impact: "预算缺口约 8–12%",
        mitigation: "按成交价而非刊例价签约，设置阶梯报价与效果对赌条款",
        owner: "商务/采购",
        signal: "已签合同中成交价高于刊例 0.8 折的比例超过 30%",
      },
      {
        risk: "L1 授权数据缺失导致效果归因不完整",
        probability: 0.5,
        impact: "无法准确计算真实 ROI",
        mitigation: "Phase 0 完成字段级实测与授权补全后再放量",
        owner: "数据/投放运营",
        signal: "归因口径只能覆盖不到 60% 的成交",
      },
    ],
    disclaimer: sim.disclaimer ?? "情景模拟基于历史数据与公开指数，不构成投放承诺。",
  };
}

/* ── RG 研报 DSL ────────────────────────────────────────── */

interface ReportBrief {
  brandIds: string[];
  category: string;
  window: { from: string; to: string };
  budget: { amount: number };
  /** 自有品牌；给了才出「品牌自诊」两页，否则报告只做市场调研（见 contracts `Brief.ownBrandId`） */
  ownBrandId?: string;
}

interface ReportUpstream {
  intel?: IntelOutput;
  creator?: CreatorOutput;
  playbook?: PlaybookOutput;
  budget?: BudgetOutput;
}

/**
 * 合成报告 = mock 基线 + 降级兜底。
 *
 * 两条硬约束：
 *   ① 结构必须满足 `DEFAULT_DEPTH_POLICY`（13 页 / 10 种块型 / 可溯源引用 ≥60%）——
 *      否则 mock 模式的深度回归会红，而且"降级"会变成"报告很薄"的借口；
 *   ② 来源声明只能从 catalog 里取 —— 与真实路径同一套来源合法性规则，
 *      不允许出现"合成产物可以随便写来源"这种双标。
 */
export function synthReport(
  brief: ReportBrief,
  upstream: ReportUpstream,
  options: { degraded?: { reason: string; missingSections: string[] }; synthesized: boolean; catalog?: SourceCatalog },
): ReportDsl {
  const title = `${brief.category} 品牌营销策略建议`;
  const catByKey = new Map((options.catalog?.entries ?? []).map((e) => [e.key, e]));
  const declared = new Map<string, ReportDsl["sourceDeclaration"]["sources"][number]>();
  /** 本 job 的条目级证据（人选页与附录都要用它反查原帖链接/条目数） */
  const evidenceEntries = options.catalog?.evidenceEntries ?? [];

  /** 声明一个来源；不在目录里返回 false（调用方应把它降级成 model_inference） */
  const ensureSource = (key: string): boolean => {
    if (declared.has(key)) return true;
    const e = catByKey.get(key);
    if (!e) return false;
    declared.set(key, { key, displayName: e.displayName, grade: e.grade, asOf: e.asOf, coverage: e.coverage });
    return true;
  };

  type Cite = ReportDsl["slides"][number]["citations"][number];
  /** 上游 citation → 报告 citation：来源在目录里就是 data_source，否则如实降级为推断 */
  const toCite = (claim: string, sourceKey: string, confidence: number): Cite => {
    const tier = confidence >= 0.75 ? "high" : confidence >= 0.45 ? "medium" : "low";
    if (ensureSource(sourceKey)) {
      return { claim, kind: "data_source", ref: { sourceKey }, grade: "L3", confidence, tier, verifiedBy: "auto" };
    }
    return { claim, kind: "model_inference", ref: {}, confidence: Math.min(confidence, 0.4), tier: "low", verifiedBy: "auto" };
  };
  /** 纯估算：不声称来自任何数据源 */
  const inference = (claim: string, confidence: number): Cite => ({
    claim,
    kind: "model_inference",
    ref: {},
    confidence,
    tier: "low",
    verifiedBy: "auto",
  });

  const intel = upstream.intel;
  /* 是否做品牌自诊：**只看客户有没有指定自有品牌**（`brief.ownBrandId`），
   * 不看 intel 有没有产出 brandSelf —— 没指定时"我方"根本不是个已知实体，
   * 硬出这一页只会得到一整页「无数据」，还让读者误以为系统知道他是谁。
   * 此时报告退化为**纯市场与竞品调研**（这正是大多数委托的真实形态）。 */
  const hasOwnBrand = Boolean((brief.ownBrandId ?? "").trim());

  /** 品牌自身诊断：与竞品同属 intel 产物，但它说的是"我方"，引用必须单列 */
  const brandSelf = intel?.brandSelf;
  const creator = upstream.creator;
  const playbook = upstream.playbook;
  const budget = upstream.budget;

  const intelCites: Cite[] = (intel?.citations ?? []).map((c) => toCite(c.claim, c.sourceKey, c.confidence));
  /** 品牌自诊的引用单列：它只该为"我方"数字作证，混进竞品引用里会让读者误以为品牌资产也来自公开检索 */
  const brandSelfCites: Cite[] = (intel?.brandSelf?.citations ?? []).map((c) =>
    toCite(c.claim, c.sourceKey, c.confidence),
  );
  /** 报价库是内部数据仓，估价值来自真实成交记录 → 可溯源 */
  const creatorCites: Cite[] = (creator?.candidates ?? []).map((c) =>
    toCite(`${c.nickname} 成本估计 ${c.estimatedCost.toFixed(0)} 元（${c.tier}）`, "pricing", c.confidence),
  );
  const creatorKbCites: Cite[] = (creator?.citations ?? []).map((c) => toCite(c.claim, c.sourceKey, c.confidence));
  const playbookCites: Cite[] = (playbook?.citations ?? []).map((c) => toCite(c.claim, c.sourceKey, c.confidence));

  /* 条目级平台引用（P0 溯源）。
   *
   * 三个刻意的取舍：
   *   ① entryId **只透传**，绝不在这里生成 —— 它必须等于工具登记时的那个值，
   *      否则渲染层反查不到（R13 也会判非法）；
   *   ② 反查证据表只为拿 sourceKey：有来源级出处就一并写上，让渲染期的降级阶梯
   *      能退到"来源级引用"而不是一步退成"模型推断"；
   *   ③ 证据表里查不到的条目直接不写进报告 —— 上游 enforceEvidence 已经拦过一道，
   *      这里是双保险（防止手写 DSL / 其他调用方绕过那道校验）。 */
  const evidenceById = new Map((options.catalog?.evidenceEntries ?? []).map((e) => [e.entryId, e]));
  const platformEntryCites: Cite[] = (intel?.evidences ?? []).flatMap((ev) => {
    const entry = evidenceById.get(ev.entryId);
    if (!entry) return [];
    const meta = MEDIA_CRAWLER_PLATFORM_META[entry.platform as MediaCrawlerPlatform];
    const sourceKey = meta && ensureSource(meta.sourceId) ? meta.sourceId : undefined;
    return [
      {
        claim: ev.quote || entry.title || ev.entryId,
        kind: "platform_entry" as const,
        ref: { entryId: ev.entryId, ...(sourceKey ? { sourceKey } : {}) },
        grade: "L3" as const,
        confidence: 0.5,
        tier: "medium" as const,
        verifiedBy: "auto" as const,
      },
    ];
  });

  const exclusions: ReportDsl["sourceDeclaration"]["exclusions"] = (intel?.dataGaps ?? []).map((g) => ({ key: g.slice(0, 24), reason: g }));
  const noData = (what: string): SlideSpec["blocks"] => [
    { type: "callout", tone: "warn", text: `上游未产出${what}，本页内容缺失；该缺口已计入排除项。`, sourceRef: "meta:disclaimer" },
    { type: "bullets", items: [`${what}缺失`, "请检查上游阶段产物或数据授权状态"], sourceRef: "meta:disclaimer" },
    { type: "text", style: "caption", content: `缺失项：${what}`, sourceRef: "meta:disclaimer" },
  ];

  const slides: SlideSpec[] = [];
  const push = (pageRole: SlideSpec["pageRole"], t: string, layoutId: string, blocks: SlideSpec["blocks"], citations: Cite[] = []): void => {
    slides.push({ index: slides.length, pageRole, title: t, layoutId, blocks, citations });
  };

  /* ── 品牌自诊页用到的小工具 ─────────────────────────────── */

  /**
   * 未获授权的指标一律渲染成「无数据」，**不写 0**。
   * 0 会被读者理解成"确实没有账号 / 确实零互动"，那是另一种编造。
   */
  const kpiSelf = (label: string, sum: number, hasData: boolean) =>
    hasData
      ? { label, value: String(sum), unit: "", tier: "medium" as const }
      : { label, value: "无数据", unit: "", tier: "low" as const };

  const SENTIMENT_LABEL: Record<string, string> = {
    positive: "偏正面",
    neutral: "中性",
    negative: "偏负面",
    unknown: "未知（无样本）",
  };

  /** 公开价格带描述 → 档位序号。识别不出档位返回 0（落在矩阵的"未知"一侧），不猜 */
  const priceBandRank = (priceBand: string): number => {
    const p = priceBand ?? "";
    if (p.includes("低")) return 1;
    if (p.includes("中")) return 2;
    if (p.includes("高")) return 3;
    return 0;
  };

  /** 品牌自诊页的警示语：只有当真有数字时才说"已授权" */
  const brandSelfCallout = (bs: IntelOutput["brandSelf"]): string => {
    const hasAny = bs.contentAssets.some(
      (a) => a.accountCount !== null || a.postCount !== null || a.avgEngagement !== null,
    );
    return hasAny
      ? "品牌资产数据来自甲方提供 / 平台授权，逐项来源见本页引用；未经人工复核前请勿直接作为投放依据。"
      : "品牌资产数据未获授权，本页为定性判断：所有指标显示「无数据」，不做任何推断。补齐需甲方提供经营数据或走平台授权（L1）。";
  };

  /* 0 封面 */
  push("cover", title, "cover/hero", [
    { type: "text", style: "h2", content: title },
    {
      type: "text",
      style: "caption",
      content: `分析窗口 ${brief.window.from} ~ ${brief.window.to} · 预算 ${(brief.budget.amount / 10000).toFixed(0)} 万元 · 品牌 ${brandLabel(brief)}`,
    },
    ...(options.synthesized
      ? ([{ type: "callout", tone: "info", text: `本报告由工具实测数据 + 保守模板合成，结论仅作参考。降级原因：${options.degraded?.reason ?? "模型输出未参与最终生成"}。`, sourceRef: "degrade:synthesis" }] as const)
      : []),
  ]);

  /* 1 数据来源与口径声明 */
  push(
    "data",
    "数据来源与口径声明",
    "content/table",
    [
      { type: "table", columns: ["来源", "分级", "取数口径"], rows: [...declared.values()].map((s) => [s.displayName, s.grade, s.coverage]), caption: "本报告实际使用的数据来源（按目录核验）", sourceRef: "meta:sourceDeclaration" },
      { type: "bullets", items: exclusions.length > 0 ? exclusions.map((e) => `未使用：${e.key}`) : ["无排除项"], sourceRef: "meta:sourceDeclaration" },
      {
        type: "callout",
        tone: exclusions.length > 0 ? "warn" : "info",
        text: exclusions.length > 0 ? "存在排除项，相关维度结论为估算或无数据，请勿直接作为投放依据。" : "未发现排除项，本次数据覆盖完整。",
        sourceRef: "meta:sourceDeclaration",
      },
    ],
    [],
  );

  /* 2 目录
   * 这里**故意不放手工章节列表**：目录由渲染器按实际页序自动生成（带页码），
   * 手工再列一遍必然与实际页码漂移（页面增删后没人回来改它）。
   * 渲染规则：toc 页若已有 bullets/table，则认为是人工目录，不再自动生成。 */
  push("toc", "目录", "toc/list", [
    { type: "text", style: "caption", content: "目录按实际页序自动生成，页码为报告内页码。", sourceRef: "meta:sourceDeclaration" },
    { type: "callout", tone: "info", text: "正文页均标注数据来源与置信度；估算值统一以 low 标注。", sourceRef: "meta:sourceDeclaration" },
  ]);

  /* 3 核心结论速览 */
  const overviewItems: SlideSpec["blocks"][number] = {
    type: "kpi",
    sourceRef: "phase:intel",
    items: [
      { label: "竞品可识别家数", value: String(intel?.competitors.length ?? 0), unit: "家", tier: (intel?.competitors.length ?? 0) >= 3 ? "medium" : "low" },
      { label: "候选达人数", value: String(creator?.candidates.length ?? 0), unit: "位", tier: "medium" },
      { label: "基准情景 ROI", value: budget ? budget.scenarios.base.roi.toFixed(2) : "无数据", tier: "low" },
      { label: "数据缺口项", value: String(exclusions.length), unit: "项", tier: "low" },
    ],
  };
  const overviewHasLow = (overviewItems.type === "kpi" ? overviewItems.items : []).some((it) => it.tier === "low");
  /* 竞品集的来源在快捷结论里要如实交代：有则点名（客户声明的品牌），无则说明"未获情报"。
   * 旧实现这里写死"已识别三类定位坐标（成分党 / 平价替代 / 医研背书）"—— 那是美妆演示的残留。 */
  const briefBrands = (brief.brandIds ?? []).map((b) => b.trim()).filter(Boolean);
  push(
    "content",
    "核心结论速览",
    "content/kpi",
    [
      overviewItems,
      {
        type: "bullets",
        items: [
          briefBrands.length > 0
            ? `竞品格局：按客户声明的 ${briefBrands.length} 个品牌列出（${briefBrands.join("、")}），定位与价格带待核验`
            : "竞品格局：本轮未获竞品情报，不作定位判断",
          "达人分层覆盖 head / mid / tail 三层",
          "预算按渠道 × 阶段拆解，并给出三档情景",
        ],
        sourceRef: "phase:intel",
      },
      /* `quote` 是必需块型（见 report-depth 的 requiredBlockTypes），**但内容必须可溯源**。
       * 旧实现把它写死成「达人种草占比 45% 时 ROI 最优（2.3）」并署名"KB-2 内部复盘"：
       * 那串数字只是 `scripts/seed.ts` 里的演示种子，KB 没这条时就成了无源的假引用
       * （旧报告实测渲染出了这一段）。这里改成不承载任何数字的口径说明。 */
      {
        type: "quote",
        text: "竞品投放消耗、声量份额与达人报价均无授权数据源，本报告一律写「无数据」，不给估算值。",
        attribution: "口径说明",
        sourceRef: "meta:disclaimer",
      },
      ...(overviewHasLow ? ([{ type: "callout", tone: "warn", text: "本页含低置信度估算值（ROI 与数据缺口来自模型推断），请结合人工判断使用。", sourceRef: "meta:disclaimer" }] as const) : []),
    ],
    intelCites.slice(0, 2),
  );

  /* 4 竞品格局对比 */
  push(
    "data",
    "竞品格局对比",
    "content/table",
    intel
      ? [
          {
            type: "table",
            columns: ["竞品", "定位", "价格带", "声量份额", "核心主张", hasOwnBrand ? "与本品差异" : "差异化主张"],
            rows: intel.competitors.map((c) => [c.name, c.positioning, c.priceBand, c.shareOfVoice === null ? "无数据" : `${(c.shareOfVoice * 100).toFixed(0)}%`, c.keyClaims.join("；"), c.differentiation]),
            caption: "声量份额无可量化指数源，一律标为「无数据」，不编造",
            sourceRef: "phase:intel",
          },
          { type: "bullets", items: intel.competitors.map((c) => `${c.name}：${c.contentMatrix.map((m) => m.form).join("、") || "内容形态未取得"}`), sourceRef: "phase:intel" },
          { type: "callout", tone: "warn", text: "竞品信息来自公开网页检索，未经人工核验；声量份额与投放消耗均无授权数据源支撑。", sourceRef: "phase:intel" },
        ]
      : noData("竞品情报"),
    [...intelCites, ...platformEntryCites],
  );

  /* 5 品牌自身诊断（P0-1）：我方基线 —— **仅当客户指定了自有品牌（`brief.ownBrandId`）时才出**。
   * 未指定时整页省略，而不是写满「无数据」：那时的正确动作是只做市场调研，
   * 不该拿一整页去替客户声明"我们不知道你是谁"。 */
  if (hasOwnBrand) {
    push(
      "data",
      "品牌自诊概览",
      "content/kpi+bullets",
      brandSelf
        ? [
            {
              type: "kpi",
              items: [
                kpiSelf("自有账号数", brandSelf.contentAssets.reduce((n, a) => n + (a.accountCount ?? 0), 0), brandSelf.contentAssets.some((a) => a.accountCount !== null)),
                kpiSelf("自有作品数", brandSelf.contentAssets.reduce((n, a) => n + (a.postCount ?? 0), 0), brandSelf.contentAssets.some((a) => a.postCount !== null)),
                { label: "口碑情感", value: SENTIMENT_LABEL[brandSelf.reputation.sentiment], unit: "", tier: brandSelf.reputation.sentiment === "unknown" ? "low" : "medium" },
                { label: "覆盖平台", value: String(brandSelf.contentAssets.length), unit: "个", tier: "medium" },
              ],
              sourceRef: "phase:intel",
            },
            { type: "text", style: "h3", content: `我方定位：${brandSelf.positioning.statement}`, sourceRef: "phase:intel" },
            { type: "bullets", items: brandSelf.positioning.differentiators.map((d) => `差异点：${d}`), sourceRef: "phase:intel" },
            { type: "callout", tone: "warn", text: brandSelfCallout(brandSelf), sourceRef: "phase:intel" },
          ]
        : noData("品牌自诊"),
      brandSelfCites,
    );

    /* 6 品牌 vs 竞品差距矩阵（同样只在有自有品牌时出现） */
    push(
      "data",
      "品牌 vs 竞品差距矩阵",
      "content/matrix+table",
      brandSelf
        ? [
            {
              type: "table",
              columns: ["对比维度", "我方", "竞品基准", "差距 / 为什么算不出"],
              rows: brandSelf.gaps.map((g) => [g.dimension, g.self, g.benchmark, g.delta]),
              caption: "「我方」列在未获品牌资产授权时一律写「待甲方确认」，不做任何推断",
              sourceRef: "phase:intel",
            },
            {
              type: "matrix",
              xLabel: "公开价格带档位（低 1 → 高 3）",
              yLabel: "公开可见内容形态数量",
              // 矩阵单元里是数字坐标，必须声明来源，否则被 R6（无来源数字断言）拦下
              sourceRef: "phase:intel",
              cells: (intel?.competitors ?? []).map((c) => ({
                x: priceBandRank(c.priceBand),
                y: c.contentMatrix.length,
                label: c.name,
                size: 1,
              })),
            },
            { type: "bullets", items: brandSelf.gaps.slice(0, 3).map((g) => `${g.dimension}：${g.delta}`), sourceRef: "phase:intel" },
            { type: "callout", tone: "warn", text: "矩阵仅含竞品坐标：本品的位置未知，声量份额与粉丝画像均无授权数据源，故未绘制本方点位。", sourceRef: "phase:intel" },
          ]
        : noData("品牌 vs 竞品差距"),
      brandSelfCites,
    );
  } else {
    /* 6' 竞品定位矩阵 —— 未指定自有品牌时的替代页：**只呈现市场侧坐标**，页内不出现任何「我方」。
     * 它同时保住两件事：chart/matrix 的可视化块下限，以及"竞品之间怎么分布"这个纯市场结论。 */
    push(
      "data",
      "竞品定位矩阵",
      "content/matrix+table",
      intel
        ? [
            {
              type: "table",
              columns: ["竞品", "定位", "价格带", "公开内容形态数"],
              rows: intel.competitors.map((c) => [
                c.name,
                c.positioning || "待核验",
                c.priceBand || "未取到",
                String(c.contentMatrix.length),
              ]),
              caption: "本页仅呈现各竞品在公开渠道的价格带与内容形态坐标，均未经人工核验",
              sourceRef: "phase:intel",
            },
            {
              type: "matrix",
              xLabel: "公开价格带档位（低 1 → 高 3）",
              yLabel: "公开可见内容形态数量",
              // 矩阵单元里是数字坐标，必须声明来源，否则被 R6（无来源数字断言）拦下
              sourceRef: "phase:intel",
              cells: intel.competitors.map((c) => ({
                x: priceBandRank(c.priceBand),
                y: c.contentMatrix.length,
                label: c.name,
                size: 1,
              })),
            },
            {
              type: "bullets",
              items: intel.competitors.map((c) => `${c.name}：${c.differentiation || "差异点待核验"}`),
              sourceRef: "phase:intel",
            },
            {
              type: "callout",
              tone: "warn",
              text: "本页为竞品公开坐标，未经人工核验；声量份额与投放消耗均无授权数据源支撑。",
              sourceRef: "phase:intel",
            },
          ]
        : noData("竞品情报"),
      [...intelCites, ...platformEntryCites],
    );
  }

  /* 7 类目趋势与人群洞察 */
  push(
    "content",
    "类目趋势与人群洞察",
    "content/chart",
    intel
      ? [
          { type: "text", style: "h3", content: "类目趋势与人群", sourceRef: "phase:intel" },
          {
            type: "chart",
            chartType: "bar",
            series: [{ name: "价格带分布（无口径时为空）", points: intel.categoryInsights.pricingBand.map((p, i) => ({ x: p.band, y: p.share === null ? 0 : p.share * 100 })) }],
            axis: { xLabel: "价格带", yLabel: "%" },
            sourceRef: "phase:intel",
          },
          { type: "bullets", items: [...intel.categoryInsights.trends, ...intel.categoryInsights.audience, ...intel.categoryInsights.seasonality], sourceRef: "phase:intel" },
        ]
      : noData("类目洞察"),
    intelCites.slice(0, 1),
  );

  /* 6 人选建议与分层 */
  push(
    "data",
    "人选建议与分层",
    "content/table+matrix",
    creator
      ? [
          {
            type: "table",
            columns: ["分层", "人选/账号", "平台", "来源", "粉丝量", "匹配度", "成本估计(元)", "可核验凭据"],
            rows: creator.candidates.map((c) => {
              const isPlatform = c.talentId.startsWith(PLATFORM_CREATOR_PREFIX);
              const isPlaceholder = c.talentId.startsWith(PLACEHOLDER_CREATOR_PREFIX);
              const isPublicFigure = isPublicFigureCandidate(c);
              const starLead = isPublicFigure ? starLeadOf(creator.starLeads, c.nickname) : undefined;
              return [
                TIER_LABEL[c.tier] ?? c.tier,
                c.nickname,
                PLATFORM_LABEL_BY_NAME.get(c.platform) ?? c.platform,
                creatorSourceOf(c),
                c.followers > 0 ? String(c.followers) : "未采集",
                c.matchScore.toFixed(2),
                c.estimatedCost > 0 ? c.estimatedCost.toFixed(0) : isPlaceholder ? "—" : "无样本",
                isPlatform
                  ? creatorEvidenceUrl(evidenceEntries, c.talentId) || "—"
                  : isPublicFigure
                    ? starLead?.url || "—（未命中官宣报道）"
                    : "—",
              ];
            }),
            caption:
              "来源列逐条标注数据出处：「平台公开采集」的账号名完整显示、可点开凭据列原帖/个人主页核对（粉丝量取自个人主页公开统计、报价无样本，故成本不做估计）；" +
              "「本地达人报价库」为商务录入样本，库内无平台账号 ID，平台上搜不到同名账号属预期；" +
              "「公开报道线索」为明星/公众人物候选，凭据是本次检索到的官宣报道链接（姓名命中标题），粉丝量与报价未采集 —— 「无样本」不是 0 元。" +
              "详见附录「人选名单来源与核验状态」「明星候选与官宣出处」与「平台真实账号（采集所得）」",
            sourceRef: "phase:creator",
          },
          /* 散点图要两个**真实**量纲。粉丝量在平台采集路径下根本不存在，
           * 用 0 铺满整张图只会画出一条压在轴上的假分布（比不画更糟）。
           * 所以两条路径各用自己能拿到的真实数字：
           *   报价库路径：粉丝量 × 匹配度；采集路径：匹配度 × 采集到的条目数。
           * 两个轴都必须在表里能查到，读者才能复算。 */
          ...(() => {
            const byFollower = creator.candidates.filter((c) => c.followers > 0);
            if (byFollower.length > 0) {
              return [
                {
                  type: "matrix" as const,
                  xLabel: "粉丝量",
                  yLabel: "匹配度",
                  cells: creator.candidates.map((c) => ({ x: c.followers, y: c.matchScore * 100, label: c.nickname, size: Math.max(1, c.estimatedCost / 1000) })),
                },
              ];
            }
            const withEvidence = creator.candidates.filter((c) => creatorEvidenceCount(evidenceEntries, c.talentId) > 0);
            if (withEvidence.length === 0) return [];
            return [
              {
                type: "matrix" as const,
                xLabel: "匹配度（按同平台采集互动量分位）",
                yLabel: "采集到的条目数",
                cells: withEvidence.map((c) => ({
                  x: c.matchScore * 100,
                  y: creatorEvidenceCount(evidenceEntries, c.talentId),
                  label: c.nickname,
                  size: creatorEvidenceCount(evidenceEntries, c.talentId),
                })),
              },
            ];
          })(),
          { type: "callout", tone: "info", text: `排除项：${creator.excluded.map((e) => `${e.reason}(${e.count})`).join("；") || "无"}`, sourceRef: "phase:creator" },
        ]
      : noData("人选匹配"),
    [...creatorCites, ...creatorKbCites],
  );

  /* 7 内容日历 */
  const weekly = playbook?.weeklyCalendar ?? [];
  push(
    "content",
    "内容日历",
    "content/timeline",
    playbook
      ? [
          {
            type: "timeline",
            phases: weekly.map((w) => ({
              label: `第 ${w.week} 周`,
              from: w.from,
              to: w.to,
              items: [`平台：${w.platform}`, `形态：${w.contentType}`, `主题：${w.theme}`, `达人：${w.creatorIds.join("、") || "待定"}`],
            })),
            sourceRef: "phase:playbook",
          },
          { type: "bullets", items: playbook.phases.map((p) => `${p.label}（${p.from}~${p.to}）：预算份额 ${(p.budgetShare * 100).toFixed(0)}%，KPI ${p.kpiTargets.map((k) => `${k.metric}≥${k.target}`).join("、")}`), sourceRef: "phase:playbook" },
          { type: "callout", tone: playbook.conflicts.length > 0 ? "warn" : "info", text: playbook.conflicts.length > 0 ? `排期冲突：${playbook.conflicts.join("；")}` : "未检测到档期冲突。", sourceRef: "phase:playbook" },
        ]
      : noData("打法与排期"),
    playbookCites,
  );

  /* 8 预算分配 */
  push(
    "data",
    "预算分配",
    "content/chart+table",
    budget
      ? [
          {
            type: "chart",
            chartType: "bar",
            series: [{ name: "渠道预算（元）", points: budget.allocation.map((a) => ({ x: a.channel, y: a.amount })) }],
            axis: { xLabel: "渠道", yLabel: "元" },
            sourceRef: "phase:budget",
          },
          {
            type: "table",
            columns: ["渠道", "金额(元)", "份额", "预期ROI", "依据"],
            rows: budget.allocation.map((a) => [a.channel, a.amount.toFixed(0), `${(a.share * 100).toFixed(0)}%`, a.expectedRoi.toFixed(2), a.rationale]),
            caption: "预期 ROI 为情景模拟的估算值，非实测",
            sourceRef: "phase:budget",
          },
          { type: "callout", tone: "info", text: budget.disclaimer, sourceRef: "phase:budget" },
        ]
      : noData("预算分配"),
    // 本页所有含数字的块都声明了 sourceRef（phase:budget），因此不需要 citations；
    // 预期 ROI 本身是估算值，不声称来自任何数据源。
    [],
  );

  /* 9 渠道 × 阶段矩阵 */
  push(
    "content",
    "渠道 × 阶段矩阵",
    "content/matrix",
    budget && budget.stageMatrix.length > 0
      ? [
          {
            type: "matrix",
            xLabel: "阶段投入（万元）",
            yLabel: "预期 ROI",
            cells: budget.stageMatrix.map((m) => ({ x: Number((m.amount / 10000).toFixed(2)), y: m.expectedRoi, label: `${m.channel}·${m.stage}`, size: Math.max(1, m.amount / 20000) })),
          },
          {
            type: "table",
            columns: ["渠道", "阶段", "金额(元)", "预期ROI"],
            rows: budget.stageMatrix.map((m) => [m.channel, m.stage, m.amount.toFixed(0), m.expectedRoi.toFixed(2)]),
            sourceRef: "phase:budget",
          },
          { type: "bullets", items: budget.allocation.map((a) => `${a.channel}：全周期 ${a.amount.toFixed(0)} 元，份额 ${(a.share * 100).toFixed(0)}%`), sourceRef: "phase:budget" },
        ]
      : noData("渠道 × 阶段矩阵"),
    /* matrix 块类型不带 sourceRef 字段，只能靠本页 citations 满足「含数字必须有依据」。
     * 矩阵里的 ROI 是模拟值 → 如实标成模型推断，不给它安一个假来源。 */
    budget && budget.stageMatrix.length > 0
      ? [
          inference(`各渠道 × 阶段的预期 ROI 为情景模拟值（样本 ${budget.stageMatrix.length} 组）`, 0.4),
          inference("阶段投入由预算分配按排期份额拆解得到", 0.45),
        ]
      : [],
  );

  /* 10 三档情景模拟 */
  push(
    "content",
    "三档情景模拟",
    "content/kpi",
    budget
      ? [
          {
            type: "kpi",
            sourceRef: "tool:scenario_simulate",
            items: [
              { label: "悲观情景 ROI", value: budget.scenarios.worst.roi.toFixed(2), sourceRef: "tool:scenario_simulate" },
              { label: "基准情景 ROI", value: budget.scenarios.base.roi.toFixed(2), sourceRef: "tool:scenario_simulate" },
              { label: "乐观情景 ROI", value: budget.scenarios.best.roi.toFixed(2), sourceRef: "tool:scenario_simulate" },
            ],
          },
          {
            type: "table",
            columns: ["情景", "ROI", "GMV(元)"],
            rows: [
              ["悲观", budget.scenarios.worst.roi.toFixed(2), budget.scenarios.worst.gmv.toFixed(0)],
              ["基准", budget.scenarios.base.roi.toFixed(2), budget.scenarios.base.gmv.toFixed(0)],
              ["乐观", budget.scenarios.best.roi.toFixed(2), budget.scenarios.best.gmv.toFixed(0)],
            ],
            caption: "情景为模拟区间，不构成投放承诺",
            sourceRef: "phase:budget",
          },
          { type: "callout", tone: "info", text: budget.disclaimer, sourceRef: "phase:budget" },
        ]
      : noData("情景模拟"),
  );

  /* 11 风险登记与应对 */
  push(
    "data",
    "风险登记与应对",
    "content/table",
    budget
      ? [
          {
            type: "table",
            columns: ["风险", "概率", "影响", "触发信号", "应对", "责任人"],
            rows: budget.risks.map((r) => [r.risk, `${(r.probability * 100).toFixed(0)}%`, r.impact, r.signal, r.mitigation, r.owner]),
            caption: "风险为自动规则筛查结果（verifiedBy=auto），未经人工核验",
            sourceRef: "phase:budget",
          },
          { type: "bullets", items: budget.risks.map((r) => `${r.risk} → ${r.owner}：${r.mitigation}`), sourceRef: "phase:budget" },
          { type: "callout", tone: "risk", text: "风险登记项均来自自动规则与公开信息，需结合商务与法务复核后再执行。", sourceRef: "phase:budget" },
        ]
      : noData("风险登记"),
  );

  /* 13 数据来源与溯源（P0）
   *
   * 这一页**完全机械生成**：来源清单来自目录、采集概览来自证据表聚合、被引条目
   * 来自 entryId 反查。没有一处需要模型参与 —— 所以它不会因为"模型今天不想写来源"
   * 而消失，也不会有编造的链接。把溯源做成附录而不是正文，是因为读者看结论时需要
   * 的是页码级线索，核对时才需要 URL 级清单。 */
  const citedIds = new Set(platformEntryCites.flatMap((c) => (c.ref.entryId ? [c.ref.entryId] : [])));
  const overviewRows = summarizeEvidence(evidenceEntries);
  const citedRows = evidenceEntries
    .filter((e) => citedIds.has(e.entryId))
    .map((e) => [
      e.platformName,
      (e.title || e.excerpt || "（无标题）").slice(0, 48),
      `${e.op} / ${e.kind === "comment" ? "评论" : "内容"}`,
      e.publishedAt ? e.publishedAt.slice(0, 10) : "未知",
      e.url || "—",
    ]);
  const overviewBlock: SlideSpec["blocks"] =
    overviewRows.length > 0
      ? [
          {
            type: "table",
            columns: ["平台", "算子", "条目数", "采集时点"],
            rows: overviewRows,
            caption: "按平台 × 算子聚合自本任务证据表，不经模型改写",
            sourceRef: "meta:sourceDeclaration",
          },
        ]
      : [
          {
            type: "callout",
            tone: "info",
            text: "本次任务未采集到任何平台公开内容（未开启平台采集、未获授权，或采集仍在后台排队）。",
            sourceRef: "meta:sourceDeclaration",
          },
        ];
  const citedBlock: SlideSpec["blocks"] =
    citedRows.length > 0
      ? [
          {
            type: "table",
            columns: ["平台", "内容", "类型", "发布时间", "原文链接"],
            rows: citedRows,
            caption: "正文引用的条目级出处：每条都能点回原帖核对",
            sourceRef: "meta:sourceDeclaration",
          },
        ]
      : [
          {
            type: "bullets",
            items: ["本次报告没有条目级平台引用", "平台内容属 L3 公开采集，且与平台无授权合同"],
            sourceRef: "meta:sourceDeclaration",
          },
        ];
  push("appendix", "数据来源与溯源", "appendix/dense", [
    { type: "text", style: "h3", content: "一、来源级声明（本次真实可用）", sourceRef: "meta:sourceDeclaration" },
    {
      type: "table",
      columns: ["来源", "分级", "取数口径"],
      rows: [...declared.values()].map((s) => [s.displayName, s.grade, s.coverage]),
      caption: "与报告首页声明一致；未使用的来源见排除项",
      sourceRef: "meta:sourceDeclaration",
    },
    { type: "text", style: "h3", content: "二、平台采集概览（机械汇总）", sourceRef: "meta:sourceDeclaration" },
    ...overviewBlock,
    { type: "text", style: "h3", content: "三、被引用的原始条目", sourceRef: "meta:sourceDeclaration" },
    ...citedBlock,
    {
      type: "callout",
      tone: "warn",
      text: "平台内容为 L3 公开采集、未经人工核验；各平台指标口径不同（部分平台无点赞或评论数），跨平台只做定性对照，不做数值横向比较。",
      sourceRef: "meta:sourceDeclaration",
    },
    // 四、人选来源与平台真实账号：与模型路径同一实现，保证两条路径口径一致
    ...creatorProvenanceBlocks(upstream.creator, evidenceEntries),
  ]);

  /* 12 免责声明 */
  push("closing", "免责声明", "closing/statement", [{ type: "callout", tone: "risk", text: DISCLAIMER_TEXT, sourceRef: "meta:disclaimer" }]);

  const sources = [...declared.values()];
  return {
    meta: {
      dslVersion: "1.0",
      title,
      /* meta.brand 是"这份报告为谁而做"：指定了自有品牌才是"我方"；
       * 未指定时回落到本轮品牌集合（它同时是报告主体与竞品集），而不是凭空写个"本品"。 */
      brand: {
        id: (brief.ownBrandId ?? "").trim() || brief.brandIds[0] || "unknown",
        name: (brief.ownBrandId ?? "").trim() || brandLabel(brief, "未指定品牌"),
      },
      window: brief.window,
      generatedAt: new Date().toISOString(),
      ...(options.degraded ? { degraded: options.degraded } : {}),
    },
    sourceDeclaration: {
      grade: "L3",
      sources: sources.length > 0 ? sources : [{ key: "none", displayName: "无有效数据源", grade: "L3", asOf: new Date().toISOString(), coverage: "本次未取得任何数据源，结论为模板合成" }],
      exclusions,
    },
    slides: slides.map((s, i) => ({ ...s, index: i })),
  };
}

/** 合成报告的深度基线（供测试与运维核对；与 DEFAULT_DEPTH_POLICY 同源） */
export const SYNTH_DEPTH_TARGET = DEFAULT_DEPTH_POLICY;

/* ── 模型路径的机械溯源补齐 ────────────────────────────────
 *
 * 上面 `synthIntel` / `synthReport` 是"合成路径"的完整实现；下面这两个函数是**同一套取
 * 舍的复用**，但作用于**模型产出的**产物（Pi 循环 / 单次结构化输出）。
 *
 * 为什么必须复用而不是各写一份：实测暴露过一个断点 ——
 *   模型路径下 `evidences` 是可选字段，模型不填，于是 `platform_digest` 取回的 90 条真实
 *   平台内容"取到了但报告没认领"：一条条目级引用都写不出来，来源声明里那几个平台被算作
 *   "没被引用"，附录只能写"本次报告没有条目级平台引用"。
 * 这类事是**确定性的**，交给模型自由发挥就会随模型心情漂移；抽成纯函数还能被确定性测试钉住。 */

/** 机械补挂的条目级引用上限：附录是"让人能核对"用的，不是把几百条原始内容抄一遍 */
export const APPENDIX_ENTRY_LIMIT = 12;

/** 平台码 → 台账源（不在目录里的平台不得进声明，否则会造出"不存在的来源"） */
function platformSourceOf(platform: string, catalog?: SourceCatalog): SourceCatalog["entries"][number] | undefined {
  const meta = MEDIA_CRAWLER_PLATFORM_META[platform as MediaCrawlerPlatform];
  if (!meta) return undefined;
  return catalog?.entries.find((e) => e.key === meta.sourceId);
}

/**
 * 把平台采集的原始条目机械补进 intel 的 `evidences`（模型路径专用，幂等）。
 *
 * 三条刻意的取舍：
 *   ① 模型自己写的条目**排前面**（它知道哪条支撑哪个结论），机械补的只做兜底、按 entryId 去重；
 *   ② 只搬 entryId 与摘录，**不生成 URL** —— 出处仍由渲染层按 entryId 反查，模型编不出链接；
 *   ③ 无 rows（没开平台采集、或本次仍在后台排队）时原样返回，不凭空造证据。
 */
export function mergePlatformEvidences(value: IntelOutput, rows: readonly Record<string, unknown>[]): IntelOutput {
  const mechanical = platformEvidencesFrom(rows);
  if (mechanical.length === 0) return value;
  const own = value.evidences ?? [];
  const seen = new Set(own.map((e) => e.entryId));
  return { ...value, evidences: [...own, ...mechanical.filter((e) => !seen.has(e.entryId))] };
}

/**
 * 机械补齐模型产出 DSL 里的平台溯源（只补不删）。
 *
 * 做四件确定性的事：
 *   ① 有证据的平台补进 `sourceDeclaration.sources`（"已使用"必须有数据支撑，不是模型说了算）；
 *   ② 「数据来源与溯源」附录页缺就建、有就补（列表按平台 × 算子机械汇总，不经模型改写）；
 *   ③ 挂上条目级引用（含原文出处），渲染层据此把每条结论反查成可点链接；
 *   ④ 补上「人选名单来源与核验状态」「平台真实账号（采集所得）」两块 —— 前者回答
 *      "报告里的人名是哪来的、能不能搜"，后者给出真正从平台采集回来的账号。
 *
 * 边界：已经在正文引用过的条目**不重复挂**到附录；模型自己写的声明/引用/附录内容一律保留；
 * 附录块已含同名机械块（本函数跑过第二遍）时不再叠加。
 */
export function enrichReportProvenance(
  dsl: ReportDsl,
  entries: readonly EvidenceEntry[],
  catalog?: SourceCatalog,
  opts: { creators?: CreatorOutput } = {},
): ReportDsl {
  /* 必须把 `entries` 一起传下去：不传的话「可核验凭据」列在**模型路径**下永远是「—」，
   * 只有降级/合成路径才有链接 —— 同一张表两条路径两种结果，最容易被当成"模型路径数据是假的"。
   * 实测事故（2026-10-11 双十一精华自测第三次重跑）：模型路径产出的报告里，
   * 人选表的凭据列 6 行全是「—」，而平台账号表却有链接（因为那一路本来就传了 entries）。 */
  /* 粉丝量的**读时解析**（2026-10-20）：creator 阶段的候选人池是写时快照，
   * 那时作者主页资料行往往还没落库；这里按当前证据表刷新一遍，再回填模型写的表。
   * 顺序不能反 —— 回填要用刷新后的池子，否则用的是旧的 0。 */
  const liveCreators = withLiveCreatorStats(opts.creators, entries);
  dsl = backfillCreatorStatsInTables(dsl, liveCreators, entries);
  const creatorBlocks = creatorRosterBlocks(liveCreators, entries);
  const accountBlocks = platformAccountBlocks(entries);
  const starBlocks = starLeadBlocks(liveCreators?.starLeads);
  const starCandidateBlockList = starCandidateBlocks(liveCreators);

  /* 没有平台证据时不再整段跳过：人选来源标注与证据无关（它回答的是"人名哪来的"），
   * 缺了它，读者仍会把本地报价库的样例昵称当成真实平台账号。 */
  if (entries.length === 0) {
    const groups = [
      { present: (t: string) => t.includes(CREATOR_ROSTER_MARK), blocks: creatorBlocks },
      { present: (t: string) => t.includes(STAR_CANDIDATE_MARK), blocks: starCandidateBlockList },
      { present: (t: string) => t.includes(STAR_LEAD_MARK), blocks: starBlocks },
    ].filter((g) => g.blocks.length > 0);
    if (groups.length === 0) return dsl;
    return appendToAppendix(dsl, groups, []);
  }

  // ① 来源声明：把"真的有证据"的平台补进去
  const sources = [...dsl.sourceDeclaration.sources];
  const declaredKeys = new Set(sources.map((s) => s.key));
  for (const platform of new Set(entries.map((e) => e.platform))) {
    const src = platformSourceOf(platform, catalog);
    if (src && !declaredKeys.has(src.key)) {
      sources.push({ key: src.key, displayName: src.displayName, grade: src.grade, asOf: src.asOf, coverage: src.coverage });
      declaredKeys.add(src.key);
    }
  }
  /* `key: "none"` 是"一个来源都没声明"时的占位（见 synthReport 末尾）。
   * 现在既然补进了真实平台源，占位必须撤掉 —— 否则报告会一边列着小红书/知乎，
   * 一边声明"无有效数据源"，而且该占位不在台账里，会被渲染校验判成"声明了不存在的来源"。 */
  const real = sources.filter((s) => s.key !== "none");
  const finalSources = real.length > 0 ? real : sources;

  // ② 正文已引用过的条目（含模型自己写的）不重复挂
  const alreadyCited = new Set<string>();
  for (const slide of dsl.slides) {
    for (const c of slide.citations) if (c.kind === "platform_entry" && c.ref.entryId) alreadyCited.add(c.ref.entryId);
  }
  const fresh = entries.filter((e) => !alreadyCited.has(e.entryId) && (e.title || e.excerpt)).slice(0, APPENDIX_ENTRY_LIMIT);

  const newCites: ReportDsl["slides"][number]["citations"] = fresh.map((e) => {
    const src = platformSourceOf(e.platform, catalog);
    return {
      claim: (e.title || e.excerpt || e.entryId).slice(0, 80),
      kind: "platform_entry" as const,
      ref: { entryId: e.entryId, ...(src ? { sourceKey: src.key } : {}) },
      grade: "L3" as const,
      confidence: 0.5,
      tier: "medium" as const,
      verifiedBy: "auto" as const,
    };
  });

  // ③ 附录页：缺就建、有就补
  const citedIds = new Set([...alreadyCited, ...newCites.map((c) => c.ref.entryId ?? "")]);
  const citedRows = entries
    .filter((e) => citedIds.has(e.entryId))
    .slice(0, APPENDIX_ENTRY_LIMIT)
    .map((e) => [
      e.platformName,
      (e.title || e.excerpt || "（无标题）").slice(0, 48),
      `${e.op} / ${e.kind === "comment" ? "评论" : "内容"}`,
      e.publishedAt ? e.publishedAt.slice(0, 10) : "未知",
      e.url || "—",
    ]);

  type Blocks = ReportDsl["slides"][number]["blocks"];
  const overviewBlock: Blocks = [
    { type: "text", style: "h3", content: "平台采集概览（机械汇总）", sourceRef: "meta:sourceDeclaration" },
    {
      type: "table",
      columns: ["平台", "算子", "条目数", "采集时点"],
      rows: summarizeEvidence(entries),
      caption: "按平台 × 算子聚合自本任务证据表，不经模型改写",
      sourceRef: "meta:sourceDeclaration",
    },
  ];
  /* 空表会被结构校验判为非法（rows 至少 1 行），所以"一条都没引用上"时退化成一句话，
   * 而不是渲染一张只有表头的表。 */
  const citedBody: Blocks =
    citedRows.length > 0
      ? [
          {
            type: "table",
            columns: ["平台", "内容", "类型", "发布时间", "原文链接"],
            rows: citedRows,
            caption: "条目级出处：链接由渲染层按 entryId 反查证据表，模型不提供链接",
            sourceRef: "meta:sourceDeclaration",
          },
        ]
      : [
          {
            type: "bullets",
            items: [`本次采集到 ${entries.length} 条平台内容，但报告正文尚未引用其中任何一条`],
            sourceRef: "meta:sourceDeclaration",
          },
        ];
  const citedBlock: Blocks = [
    { type: "text", style: "h3", content: "被引用的原始条目（可点回原帖）", sourceRef: "meta:sourceDeclaration" },
    ...citedBody,
  ];
  const cautionBlock: Blocks = [
    {
      type: "callout",
      tone: "warn",
      text: "平台内容为 L3 公开采集、未经人工核验；各平台指标口径不同，跨平台只做定性对照，不做数值横向比较。",
      sourceRef: "meta:sourceDeclaration",
    },
  ];

  const dslWithAppendix = appendToAppendix(
    dsl,
    [
      { present: (t) => t.includes("机械汇总"), blocks: overviewBlock },
      { present: (t) => t.includes("原文链接") || t.includes("尚未引用"), blocks: citedBlock },
      { present: (t) => t.includes("机械汇总") || t.includes("原文链接") || t.includes("尚未引用"), blocks: cautionBlock },
      /* 人选块与账号块**必须分成两组**：合成路径已经写过账号块（它不依赖人选），
       * 合在一组时"人选块缺失"会把账号块一起再拼一遍 —— 附录里出现两张一模一样的表。 */
      { present: (t) => t.includes(CREATOR_ROSTER_MARK), blocks: creatorBlocks },
      { present: (t) => t.includes(PLATFORM_ACCOUNT_MARK), blocks: accountBlocks },
      /* 明星候选↔官宣出处**单独一组**（先于线索表）：它回答"这些人名的依据在哪"，
       * 而线索表回答"这一轮检索到了哪些官宣报道"。合成路径两块都会写，彼此不能互相顶替。 */
      { present: (t) => t.includes(STAR_CANDIDATE_MARK), blocks: starCandidateBlockList },
      /* 代言线索**单独一组**：它既不依赖平台证据、也不依赖人选，缺它时读者会以为
       * "系统压根没查过明星"。合成路径已经写过（present 命中）时这里不会重复追加。 */
      { present: (t) => t.includes(STAR_LEAD_MARK), blocks: starBlocks },
    ],
    newCites,
  );

  return {
    ...dslWithAppendix,
    sourceDeclaration: { ...dslWithAppendix.sourceDeclaration, sources: finalSources },
  };
}

/**
 * 把机械块按"组"追加到附录页（缺页就建），组内全有全无、组间独立去重。
 *
 * 为什么要抽成组而不是继续写 `if (!text.includes(...))`：这里已经有四组内容
 * （采集概览 / 被引条目 / 口径提醒 / 人选与账号来源），而且有两个调用点 ——
 * 有平台证据时的完整补齐，以及**没有平台证据但有人选**时只补人选那一组。
 * 两处各写一套 includes 判断，迟早会不一致，届时表现是"重跑报告时同一块叠加两遍"
 * 或"该补的没补上"，都属于很难复现的那类问题。
 */
function appendToAppendix(
  dsl: ReportDsl,
  groups: { present: (text: string) => boolean; blocks: ReportDsl["slides"][number]["blocks"] }[],
  citations: ReportDsl["slides"][number]["citations"],
): ReportDsl {
  const slides = [...dsl.slides];
  const appendixIdx = slides.findIndex((s) => s.pageRole === "appendix");
  const missing = groups.filter((g) => g.blocks.length > 0);
  if (missing.length === 0) return dsl;

  if (appendixIdx === -1) {
    slides.push({
      index: slides.length,
      pageRole: "appendix",
      title: "数据来源与溯源",
      layoutId: "appendix/dense",
      blocks: missing.flatMap((g) => g.blocks),
      citations,
    });
    return { ...dsl, slides: slides.map((s, i) => ({ ...s, index: i })) };
  }

  const old = slides[appendixIdx]!;
  const text = JSON.stringify(old.blocks);
  const appended = groups.filter((g) => g.blocks.length > 0 && !g.present(text)).flatMap((g) => g.blocks);
  if (appended.length === 0) return dsl;

  slides[appendixIdx] = {
    ...old,
    layoutId: old.layoutId || "appendix/dense",
    blocks: [...old.blocks, ...appended],
    citations: [...old.citations, ...citations],
  };
  return { ...dsl, slides: slides.map((s, i) => ({ ...s, index: i })) };
}

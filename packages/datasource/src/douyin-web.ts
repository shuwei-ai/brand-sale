/**
 * 抖音公开数据只读适配器（自托管 DTK）
 *
 * 对接：`Evil0ctal/Douyin_TikTok_Download_API`（Apache-2.0，自托管）。
 * 它把抖音网页端的签名与身份池问题封装掉，暴露 REST 端点。本项目**只**用它做只读采集。
 *
 * ── 三条边界，都写在代码里而不是文档里 ──────────────────────────────
 *
 * 1) **只读子集**。适配器只认 `profile / posts / video / comments` 四个 op（见 OP_SPEC），
 *    其余一律抛错。DTK 本身还带签名生成、直播、下载等能力，本项目一个都不用。
 *    这和当初删掉 5 个合成适配器是同一条原则：能力边界不清的工具，早晚被用成别的东西。
 *
 * 2) **分级 L3，不是 L1**。这条链路与抖音之间不存在授权合同，拿的是公开可见内容，
 *    且**未经人工核验**。标成 L1 等于把"公开采集"洗成"甲方授权实测"，报告会据此
 *    把数字标成高置信度 —— 这是本项目最不能出的错。注意 `TIER_LABEL.L3` 写的是
 *    "公开指数与人工核验"，而采集结果的后半段（人工核验）**不成立**，
 *    所以 provenance.note 必须如实写明，报告侧也要据此限制表述范围。
 *
 * 3) **不做搜索、不做热榜、不做关注/粉丝列表**。DTK 的 `GENERAL_SEARCH` 与
 *    `DOUYIN_HOT_SEARCH` 在类里定义了却没进注册表（等价于没有），关注/粉丝列表
 *    因需登录态被作者明确拒绝。不去"补上"它们：那意味着自己去补签名与登录态，
 *    等于绕过平台风控，与本项目的合规底线冲突。
 *
 * ── 关于字段归一化 ──────────────────────────────────────────────
 *
 * DTK 有 v4 / v5 两代形态，且上游（抖音）字段名本身不稳定。所以这里做**宽容归一化**：
 * 信封按优先级解开，字段用候选名列表提取，**取不到就留 null**。
 * 宁可让下游看到 null（并在报告里体现为"该项缺失"），也不要编一个看起来合理的数字。
 */

import type { Config, DouyinPaths } from "@brandsale/config";
import type { DataResult, DataSourceAdapter, Provenance } from "./index.ts";

/** 台账、工具绑定、测试三处共用，防字符串漂移 */
export const DOUYIN_WEB_SOURCE_ID = "douyin_web_public";

/** 只读操作白名单。新增 op 必须同时想清楚它在报告里的合规表述。 */
export type DouyinOp = "profile" | "posts" | "video" | "comments";

interface OpSpec {
  pathKey: keyof DouyinPaths;
  /** **出站**请求的入参名（DTK 用 snake_case：sec_user_id / aweme_id） */
  idParam: string;
  /** **入站**参数名：工具层按 TS 惯例用 camelCase，必须与出站的 snake_case 分开，
   *  否则会出现"工具传 secUserId、适配器读 sec_user_id"这类静默失配 */
  paramKey: string;
  label: string;
  /** 是否支持 count 分页参数 */
  paged: boolean;
}

const OP_SPEC: Record<DouyinOp, OpSpec> = {
  profile: { pathKey: "profile", idParam: "sec_user_id", paramKey: "secUserId", label: "达人主页", paged: false },
  posts: { pathKey: "posts", idParam: "sec_user_id", paramKey: "secUserId", label: "作品列表", paged: true },
  video: { pathKey: "video", idParam: "aweme_id", paramKey: "awemeId", label: "作品详情", paged: false },
  comments: { pathKey: "comments", idParam: "aweme_id", paramKey: "awemeId", label: "评论", paged: true },
};

const READONLY_OPS = Object.keys(OP_SPEC) as DouyinOp[];

/* ── 归一化小工具 ───────────────────────────────────────── */

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 按候选名顺序取第一个非空值。上游字段名不稳定，这里不赌单一名字。 */
const pick = (o: Json, keys: string[]): unknown => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const boolOf = (v: unknown): boolean => v === true || v === 1 || v === "1" || (typeof v === "string" && v.length > 0);

/** 抖音的头像/封面是 `{url_list: [...]}`，也偶见直接给字符串 */
const urlIn = (v: unknown): string => {
  if (typeof v === "string") return v;
  const list = asArr(asObj(v).url_list ?? asObj(v).urlList);
  return list.length ? str(list[0]) : "";
};

const clamp = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;

/**
 * HTTP 失败 → 可执行的排查方向。
 *
 * 为什么要翻译而不是直接抛状态码：自托管 DTK 的 4xx 每一种都对应一个不同的动作，
 * 而"HTTP 404"这句话无法区分"路径配错了形态"和"服务没起来"。这两件事的排查成本
 * 差一个数量级，把区别丢掉等于把成本推给运维。
 */
function describeHttpFailure(status: number, raw: unknown, text: string, style: string, path: string): string {
  const root = asObj(raw);
  const err = asObj(root.error);
  // FastAPI 的校验失败把 detail 写成**数组**（每个字段一条）。直接 String() 会得到
  // "[object Object]"，等于把唯一的线索丢掉，所以这里逐条取 msg。
  const rawDetail = err.message || root.detail || root.msg;
  const detail = Array.isArray(rawDetail)
    ? rawDetail.map((d) => str(asObj(d).msg ?? d)).filter(Boolean).join("；")
    : str(rawDetail);
  const tail = detail ? `（服务说明：${detail}）` : text ? `（响应：${text.slice(0, 160)}）` : "";

  switch (status) {
    case 401:
    case 403:
      return (
        `鉴权未通过。DTK v5 默认要求每个端点带 API Key —— 在控制台建一个 Key 填进 BM_DOUYIN_API_KEY，` +
        `或把该端点加进 api.public_endpoints 显式放开${tail}`
      );
    case 404:
      return (
        `端点不存在。当前 BM_DOUYIN_STYLE=${style}，请求路径 ${path}。` +
        `v4 与 v5 的前缀完全不同（v5 是 /api/v1/douyin/...），形态选错时四个端点会**全部** 404${tail}`
      );
    case 400:
      return `参数被拒。最常见的是 wait 超出上限：DTK 的 api.max_wait_seconds（默认 30）会拒绝而不是截断${tail}`;
    case 422:
      return `参数类型不对（服务端校验失败）。v5 的 wait 是**秒数**，传 wait=true 会直接 422 —— 检查 BM_DOUYIN_WAIT${tail}`;
    case 429:
      return `被服务端限流。降低调用频率或调大缓存 TTL（BM_DOUYIN_CACHE_TTL）${tail}`;
    default:
      return status >= 500
        ? `自托管服务自身出错（可能没起来、或身份池/数据库不可用）${tail}`
        : `未归类的服务端拒绝${tail}`;
  }
}

/**
 * 解开 DTK 响应信封。
 *
 * 兼容两代形态：
 *   v4：`{ code: 200, router, data: {…原始…}, router_data: {…归一化…} }`
 *   v5：`{ success: true, data: {…}, error: null, meta: {…} }`
 *
 * 取值优先级 `router_data → data → 顶层`：`router_data` 是 DTK 自己归一化过的，
 * 比原始结构稳定（v5 已去掉该字段，这一支对 v5 不会命中）。
 *
 * ── 异步判定为什么必须做在**两层**上 ────────────────────────────
 *
 * v4 把 `task_id` 放在顶层；v5 放在 `data` 里面：
 *   `{ success: true, data: { task_id: "…", state: "running" }, meta: {…} }`
 * 只看顶层的话，v5 的 202 会被当成成功响应 —— `data` 非空 → 返回 → 下游
 * `toCreator({task_id, state})` 得到一行**字段全空但 synthetic=false、tier=L3**
 * 的"达人数据"。那是最坏的一种错：报告会把它当成一次真实采集，
 * 而实际上什么也没查到。所以这里要往下再探一层。
 *
 * 返回 null 表示"仍在异步处理中"，由调用方**明确报错** ——
 * 绝不能把 task_id 当成数据返回。
 */
const TERMINAL_STATES = ["done", "success", "succeeded", "finished", "completed"];

function unwrap(payload: unknown): Json | null {
  const root = asObj(payload);

  // 顶层异步（v4 与 v5 的某些中间层都会有）
  if (isPendingTask(root)) return null;

  // 嵌在 data 里的异步：v5 的 202 形态
  const inner0 = asObj(root.router_data ?? root.data);
  if (isPendingTask(inner0)) return null;

  // v5 的失败信封：{ success: false, error: {...} }
  const err = asObj(root.error);
  if (root.success === false || Object.keys(err).length > 0) {
    throw new Error(
      `抖音采集服务业务错误 ${str(err.code) || "(no code)"}：${str(err.message) || str(root.msg) || "未提供说明"}`,
    );
  }

  const code = numOrNull(root.code);
  if (code !== null && code !== 0 && code !== 200) {
    throw new Error(`抖音采集服务业务错误 code=${code}${root.msg ? ` message=${str(root.msg)}` : ""}`);
  }

  const inner = inner0;
  return Object.keys(inner).length ? inner : root;
}

/** 一个对象是不是"还没做完的任务句柄"（有 task_id 且状态不是终态） */
function isPendingTask(o: Json): boolean {
  if (o.task_id === undefined) return false;
  const status = str(o.state ?? o.status ?? o.task_status).toLowerCase();
  return !TERMINAL_STATES.includes(status);
}

/* ── 三类结果的归一化 ────────────────────────────────────── */

export interface DouyinCreator {
  secUserId: string;
  uniqueId: string;
  nickname: string;
  signature: string;
  followerCount: number | null;
  followingCount: number | null;
  totalFavorited: number | null;
  awemeCount: number | null;
  ipLocation: string;
  verified: boolean;
  avatarUrl: string;
}

export interface DouyinWork {
  awemeId: string;
  desc: string;
  createTime: string;
  diggCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  collectCount: number | null;
  coverUrl: string;
}

export interface DouyinComment {
  commentId: string;
  text: string;
  nickname: string;
  diggCount: number | null;
  /** 抖音展示的"IP 属地"（省份/国家），不是粉丝地域。见文件头与文档的合规说明 */
  ipLabel: string;
  createTime: string;
}

function toCreator(payload: Json): DouyinCreator {
  // 有的端点把用户对象放在 `user`，有的直接就是用户对象
  const u = asObj(pick(payload, ["user", "user_info", "userInfo"]) ?? payload);
  return {
    secUserId: str(pick(u, ["sec_uid", "sec_user_id", "secUserId"])),
    uniqueId: str(pick(u, ["unique_id", "uniqueId", "short_id"])),
    nickname: str(pick(u, ["nickname", "nick_name"])),
    signature: str(pick(u, ["signature", "desc"])),
    followerCount: numOrNull(pick(u, ["follower_count", "fans_count", "mplatform_followers_count", "followers"])),
    followingCount: numOrNull(pick(u, ["following_count", "follow_count", "following"])),
    totalFavorited: numOrNull(pick(u, ["total_favorited", "favoriting_count", "like_count"])),
    awemeCount: numOrNull(pick(u, ["aweme_count", "video_count"])),
    // ip_location 是账号属地；city 是城市码，只在没有前者时兜底
    ipLocation: str(pick(u, ["ip_location", "ipLocation", "city"])),
    verified: boolOf(pick(u, ["verified", "custom_verify", "enterprise_verify_reason"])),
    avatarUrl: urlIn(pick(u, ["avatar_thumb", "avatar_168x168", "avatar_larger", "avatar"])),
  };
}

function toWorks(payload: Json): DouyinWork[] {
  const list = asArr(pick(payload, ["aweme_list", "awemeList", "videos", "list", "data"]));
  return list.map((raw) => {
    const w = asObj(raw);
    const stats = asObj(pick(w, ["statistics", "stats"]));
    return {
      awemeId: str(pick(w, ["aweme_id", "awemeId", "id"])),
      desc: str(pick(w, ["desc", "title"])),
      createTime: isoFromUnix(pick(w, ["create_time", "createTime"])),
      diggCount: numOrNull(pick(stats, ["digg_count", "diggCount"]) ?? pick(w, ["digg_count", "like_count"])),
      commentCount: numOrNull(pick(stats, ["comment_count", "commentCount"])),
      shareCount: numOrNull(pick(stats, ["share_count", "shareCount"])),
      collectCount: numOrNull(pick(stats, ["collect_count", "collectCount"])),
      coverUrl: urlIn(pick(w, ["cover", "video", "origin_cover"])),
    };
  });
}

function toComments(payload: Json): DouyinComment[] {
  const list = asArr(pick(payload, ["comments", "comment_list", "commentList", "list"]));
  return list.map((raw) => {
    const c = asObj(raw);
    const u = asObj(pick(c, ["user", "user_info", "userInfo"]));
    return {
      commentId: str(pick(c, ["cid", "comment_id", "commentId", "id"])),
      text: str(pick(c, ["text", "content"])),
      nickname: str(pick(u, ["nickname", "nick_name"])),
      diggCount: numOrNull(pick(c, ["digg_count", "diggCount", "like_count"])),
      // 关键区分：ip_label 是**评论者**属地。它不等于粉丝地域，也不等于账号属地。
      ipLabel: str(pick(c, ["ip_label", "ipLabel", "ip_location"])),
      createTime: isoFromUnix(pick(c, ["create_time", "createTime"])),
    };
  });
}

/** 抖音时间戳是秒级。非数字原样返回，别把一个 ISO 串变成 1970 年。 */
function isoFromUnix(v: unknown): string {
  const n = numOrNull(v);
  if (n === null || n <= 0) return str(v);
  // 已经是毫秒级就不再乘 1000
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

/* ── 适配器 ─────────────────────────────────────────────── */

export function createDouyinWebAdapter(config: Config): DataSourceAdapter {
  const { baseUrl, apiKey, style, wait, timeoutMs, cacheTtlSeconds, paths } = config.douyin;

  return {
    sourceId: DOUYIN_WEB_SOURCE_ID,
    displayName: "抖音公开内容（自托管采集）",
    tier: "L3",
    capabilities: ["creator_profile", "creator_posts", "content_detail", "comments"],
    cacheTtlSeconds,

    async fetch(query): Promise<DataResult<Record<string, unknown>>> {
      const op = String(query.params?.op ?? "profile") as DouyinOp;
      const spec = OP_SPEC[op];
      if (!spec) {
        throw new Error(
          `不支持的抖音操作「${op}」。本适配器只提供只读子集：${READONLY_OPS.join(" / ")}`,
        );
      }

      const id = str(query.params?.[spec.paramKey] ?? query.params?.id).trim();
      if (!id) throw new Error(`抖音采集缺少 ${spec.paramKey}（操作：${spec.label}）`);

      const url = new URL(`${baseUrl}${paths[spec.pathKey]}`);
      url.searchParams.set(spec.idParam, id);
      // 两代的 wait 语义不同，取值由 config.douyin.wait 决定（默认随 style）：
      //   v4 是布尔开关 `true`；v5 是**秒数**，传 `true` 会被 FastAPI 直接判 422。
      // 这也是"共用一份代码兼容两者"唯一做不到自动兼容的地方 —— 类型层面就不兼容。
      url.searchParams.set("wait", wait);
      const count = clamp(Number(query.params?.count ?? query.limit ?? 20), 1, 50);
      if (spec.paged) url.searchParams.set("count", String(count));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const resp = await fetch(url, { method: "GET", headers, signal: controller.signal });
        const text = await resp.text().catch(() => "");
        // 先解析再判状态码：v5 用 400/403/404 分别表达"参数不合法 / 没带 Key / 路径不存在"，
        // 这三种的排查动作完全不同。只报一句 `HTTP 404` 等于把区别丢掉。
        let raw: unknown = null;
        try {
          raw = text ? JSON.parse(text) : null;
        } catch {
          raw = null;
        }
        if (!resp.ok) {
          throw new Error(`抖音采集失败（服务 HTTP ${resp.status}）：${describeHttpFailure(resp.status, raw, text, style, paths[spec.pathKey])}`);
        }
        if (raw === null) {
          throw new Error(`抖音采集服务的响应不是 JSON（前 200 字符）：${text.slice(0, 200) || "(空响应)"}`);
        }

        /* 联调工具（scripts/datasource-lab.ts）返回的假数据带 `_lab:{mock:true}`。
         * 识别它并把 synthetic 置为 true —— 目的是让"假数据"在 provenance 里**显式可见**。
         * 不加这一步的话，联调数据会被报告当成真实采集的 L3 内容，
         * 而这正是本项目当初删掉 5 个合成适配器要防的同一类问题。 */
        const labMock = asObj(asObj(raw)._lab).mock === true;
        const data = unwrap(raw);
        if (!data) {
          throw new Error(
            `抖音采集仍在异步处理中（${style} 的服务未在等待窗口内返回结果，wait=${wait}）。` +
              (style === "v5"
                ? "v5 常见原因：身份池里还没有可用身份，或 api.max_wait_seconds 被调小。请在 DTK 控制台补一个身份后重试。"
                : "请确认自建 DTK 已启用同步/等待模式。"),
          );
        }

        const rows: Record<string, unknown>[] =
          op === "profile"
            ? [toCreator(data) as unknown as Record<string, unknown>]
            : op === "posts"
              ? (toWorks(data) as unknown as Record<string, unknown>[])
              : op === "video"
                ? (toWorks({ aweme_list: [data] }) as unknown as Record<string, unknown>[])
                : (toComments(data) as unknown as Record<string, unknown>[]);

        const provenance: Provenance = {
          sourceId: DOUYIN_WEB_SOURCE_ID,
          sourceName: "抖音公开内容（自托管采集）",
          tier: "L3",
          // 真实采集的公开内容不是合成值；只有联调工具的假数据才会是 true
          synthetic: labMock,
          asOf: new Date().toISOString(),
          note:
            (labMock ? "[本地联调假数据，非真实采集] " : "") +
            `抖音公开内容采集（${spec.label}），自托管服务、未经人工核验、非平台授权实测；` +
            `仅可支撑对第三方的公开断言（如"该达人公开粉丝量"），不得用于甲方自身经营指标`,
          rowCount: rows.length,
        };

        return { rows, provenance };
      } catch (e) {
        // 归一化超时：工具层按 /超时|timeout/ 判定 E-DATA-001，
        // 否则 AbortError 的原文（"This operation was aborted"）会被误判成 E-DATA-002「不可用」
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
          throw new Error(`抖音采集超时（${timeoutMs}ms，端点：${paths[spec.pathKey]}）`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 小红书公开内容只读适配器（自托管只读代理）
 *
 * ── 为什么必须经过代理，而不是直连采集工具 ──────────────────────
 *
 * 可用的开源采集工具（如 `jackwener/xiaohongshu-cli`）有三个特点同时成立：
 *   ① 是 **CLI**，不是 HTTP 服务 → 进程内直连意味着适配器要去 spawn 子进程；
 *   ② 需要**登录态 Cookie**（浏览器提取或扫码），且内置人类化延迟与风控退避；
 *   ③ **同时提供写命令**：发笔记 / 点赞 / 收藏 / 评论 / 关注 / 删除。
 *
 * 第 ③ 条是决定性的。整包封装后，模型可以合法地通过白名单、合法地过闸门，
 * 然后以甲方账号名义发出一条笔记 —— 类型层拦不住，因为"能不能写"取决于
 * 我们**封装了哪些子命令**，而不是工具策略里的一个布尔值。
 *
 * 所以这里划一条硬边界：适配器不 spawn 任何东西，只认一个
 * **只暴露只读子命令**的 HTTP 代理。代理实现（`scripts/datasource-lab.ts`）
 * 把命令白名单写死在代码里，写命令根本不存在于它的路由表上。
 * 契约与示例响应见 docs/datasource-integration.md。
 *
 * ── 分级与表述边界 ────────────────────────────────────────────
 *
 * 分级 **L3**：内容本身公开可见，但访问经过登录态、且未经人工核验。
 * provenance.note 必须如实写明这两点，报告侧据此限制表述范围。
 *
 * ── 风控是常态，不是异常 ──────────────────────────────────────
 *
 * 单账号、Cookie 7 天有效、触发验证码需人工介入、激进使用会被封 IP。
 * 因此这几类失败**不允许**被压成一句"接口不可用"——必须把
 * not_authenticated / session_expired / verification_required / ip_blocked
 * 翻译成可执行的处置说明，否则运营看到"小红书不可用"根本不知道该做什么。
 */

import type { Config, XhsPaths } from "@brandsale/config";
import type { DataResult, DataSourceAdapter, Provenance } from "./index.ts";

/** 台账、工具绑定、测试三处共用 */
export const XHS_WEB_SOURCE_ID = "xhs_web_public";

/** 只读操作白名单。写操作（like/comment/post/follow/delete）**不在其中**，也不该被加进来。 */
export type XhsOp = "note" | "comments" | "user" | "userPosts";

interface OpSpec {
  pathKey: keyof XhsPaths;
  /** **出站**请求的入参名（代理契约用 snake_case） */
  idParam: string;
  /** **入站**参数名：工具层用 camelCase，必须与出站的 snake_case 分开，
   *  否则会出现"工具传 noteId、适配器读 note_id"这类静默失配 */
  paramKey: string;
  label: string;
  /** 单条类（拿不到数据要报错），还是列表类（空数组是合法结果） */
  single: boolean;
}

const OP_SPEC: Record<XhsOp, OpSpec> = {
  note: { pathKey: "note", idParam: "note_id", paramKey: "noteId", label: "笔记详情", single: true },
  comments: { pathKey: "comments", idParam: "note_id", paramKey: "noteId", label: "笔记评论", single: false },
  user: { pathKey: "user", idParam: "user_id", paramKey: "userId", label: "用户主页", single: true },
  userPosts: { pathKey: "userPosts", idParam: "user_id", paramKey: "userId", label: "用户笔记列表", single: false },
};

const READONLY_OPS = Object.keys(OP_SPEC) as XhsOp[];

/**
 * 代理侧错误码 → 可执行的处置说明。
 *
 * 这张表的每一个 value 都要能回答"我现在该做什么"。
 * 只写"小红书不可用"等于把排查成本推给运营，而这几类失败的原因是完全确定的。
 */
const XHS_ERROR_HINT: Record<string, string> = {
  not_authenticated: "代理未登录：需在代理侧执行一次登录（xhs login 或 --qrcode 扫码）后重试",
  session_expired: "登录态已过期（Cookie 通常 7 天有效）：需重新登录后重试",
  verification_required: "触发了小红书验证码：需人工在浏览器完成验证，代理侧会自动退避冷却后重试",
  ip_blocked: "出口 IP 被限流：需切换网络/出口 IP，并降低调用频率后重试",
  signature_error: "请求签名失败：通常是采集工具版本过旧，升级代理侧工具后重试",
  tool_missing:
    "代理未就绪：代理所在机器没装或无法执行 xhs CLI。这不是小红书侧的问题，也不是本系统的数据缺口。" +
    "需在代理侧执行 uv tool install xiaohongshu-cli 并完成一次登录；若只想先跑通链路，" +
    "可把 BM_XHS_BASE_URL 指向 npm run datasource:lab（mock 模式，数据自带 synthetic 标记）。",
  proxy_error: "代理自身出错（CLI 进程启动失败或代理内部异常）：看代理侧日志定位，与小红书限流无关",
  unsupported_operation: "代理不支持该操作：适配器只请求只读子集（note/comments/user/userPosts）",
  api_error: "小红书上游接口报错（可能是笔记已删除、链接缺 xsec_token，或字段结构有变）",
};

/** 错误码 → 处置。未登记的码也要给出可动作的下一步，不能只丢一个码给运营。 */
const xhsHint = (code: string): string =>
  XHS_ERROR_HINT[code] ??
  `代理返回未登记的错误码「${code}」：先确认代理实现是否与 docs/datasource-integration.md 的契约一致，再看代理侧日志`;

/* ── 归一化小工具（与抖音适配器同一套口径，两个文件各自独立以免耦合） ── */

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const pick = (o: Json, keys: string[]): unknown => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

const numOrNull = (v: unknown): number | null => {
  if (typeof v === "string") {
    // 小红书常把计数写成 "1.2万" / "3456"
    const wan = /^([\d.]+)\s*万$/.exec(v.trim());
    if (wan) return Math.round(Number(wan[1]) * 10_000);
  }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const clamp = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;

/* ── 结果类型 ───────────────────────────────────────────── */

export interface XhsNote {
  noteId: string;
  title: string;
  desc: string;
  type: string;
  authorId: string;
  authorName: string;
  likedCount: number | null;
  collectedCount: number | null;
  commentCount: number | null;
  publishTime: string;
  tags: string[];
}

export interface XhsComment {
  commentId: string;
  content: string;
  nickname: string;
  likeCount: number | null;
  /** 小红书展示的评论者 IP 属地（省份/国家）。**不是粉丝地域**，也不是账号属地。 */
  ipLocation: string;
  createTime: string;
  subCommentCount: number | null;
}

export interface XhsUser {
  userId: string;
  nickname: string;
  desc: string;
  followerCount: number | null;
  followingCount: number | null;
  noteCount: number | null;
  likedCount: number | null;
  ipLocation: string;
}

function toNote(raw: unknown): XhsNote {
  const n = asObj(raw);
  const user = asObj(pick(n, ["user", "author"]));
  const interact = asObj(pick(n, ["interact_info", "interactInfo"]));
  const tags = asArr(pick(n, ["tags", "tag_list"])).map((t) =>
    typeof t === "string" ? t : str(pick(asObj(t), ["name", "title"])),
  );
  return {
    noteId: str(pick(n, ["note_id", "noteId", "id"])),
    title: str(pick(n, ["title"])),
    desc: str(pick(n, ["desc", "content", "body"])),
    type: str(pick(n, ["type", "note_type"])),
    authorId: str(pick(user, ["user_id", "userId", "id"])),
    authorName: str(pick(user, ["nickname", "nick_name", "name"])),
    likedCount: numOrNull(pick(interact, ["liked_count", "likedCount"]) ?? pick(n, ["liked_count", "like_count"])),
    collectedCount: numOrNull(pick(interact, ["collected_count", "collectedCount"])),
    commentCount: numOrNull(pick(interact, ["comment_count", "commentCount"])),
    publishTime: str(pick(n, ["time", "publish_time", "publishTime", "last_update_time"])),
    tags: tags.filter(Boolean),
  };
}

function toComment(raw: unknown): XhsComment {
  const c = asObj(raw);
  const user = asObj(pick(c, ["user", "author"]));
  return {
    commentId: str(pick(c, ["comment_id", "commentId", "id"])),
    content: str(pick(c, ["content", "text"])),
    nickname: str(pick(user, ["nickname", "nick_name"])),
    likeCount: numOrNull(pick(c, ["like_count", "likeCount"])),
    ipLocation: str(pick(c, ["ip_location", "ipLocation"])),
    createTime: str(pick(c, ["create_time", "createTime", "time"])),
    subCommentCount: numOrNull(pick(c, ["sub_comment_count", "subCommentCount"])),
  };
}

function toUser(raw: unknown): XhsUser {
  const u = asObj(raw);
  // CLI 有时把资料放在 user 下
  const inner = asObj(pick(u, ["user", "user_info", "basic_info"]) ?? u);
  const interact = asObj(pick(inner, ["interact_info", "interactInfo"]) ?? pick(u, ["interact_info", "interactInfo"]));
  return {
    userId: str(pick(inner, ["user_id", "userId", "id"]) ?? pick(u, ["user_id", "userId", "id"])),
    nickname: str(pick(inner, ["nickname", "nick_name", "name"])),
    desc: str(pick(inner, ["desc", "description", "signature"])),
    // 小红书 web 接口不提供关注/粉丝**列表**，计数也常常缺失；取不到就留 null
    followerCount: numOrNull(pick(interact, ["fans", "fans_count", "follower_count"])),
    followingCount: numOrNull(pick(interact, ["follows", "following_count"])),
    noteCount: numOrNull(pick(interact, ["note_count"]) ?? pick(inner, ["note_count"])),
    likedCount: numOrNull(pick(interact, ["liked", "liked_count"])),
    ipLocation: str(pick(inner, ["ip_location", "ipLocation"])),
  };
}

/* ── 适配器 ─────────────────────────────────────────────── */

export function createXhsWebAdapter(config: Config): DataSourceAdapter {
  const { baseUrl, apiKey, timeoutMs, cacheTtlSeconds, paths } = config.xiaohongshu;

  return {
    sourceId: XHS_WEB_SOURCE_ID,
    displayName: "小红书公开内容（自托管只读代理）",
    tier: "L3",
    capabilities: ["note_detail", "note_comments", "creator_profile", "creator_notes"],
    cacheTtlSeconds,

    async fetch(query): Promise<DataResult<Record<string, unknown>>> {
      const op = String(query.params?.op ?? "note") as XhsOp;
      const spec = OP_SPEC[op];
      if (!spec) {
        throw new Error(`不支持的小红书操作「${op}」。本适配器只提供只读子集：${READONLY_OPS.join(" / ")}`);
      }

      // 笔记类允许直接给 URL（CLI 能从 URL 里提取 xsec_token，比裸 note_id 更稳）
      const url = str(query.params?.url).trim();
      const id = str(query.params?.[spec.paramKey] ?? query.params?.id).trim();
      if (!url && !id) throw new Error(`小红书采集缺少 ${spec.paramKey} 或 url（操作：${spec.label}）`);

      const target = new URL(`${baseUrl}${paths[spec.pathKey]}`);
      if (url) target.searchParams.set("url", url);
      else target.searchParams.set(spec.idParam, id);
      if (op === "comments") target.searchParams.set("all", "true");
      if (spec.pathKey === "userPosts" || op === "comments") {
        target.searchParams.set("count", String(clamp(Number(query.params?.count ?? query.limit ?? 20), 1, 50)));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const resp = await fetch(target, { method: "GET", headers, signal: controller.signal });
        const text = await resp.text().catch(() => "");
        // 先解析再判状态码。反过来的话，"代理未就绪"（503）与"代理内部错"（502）会在
        // HTTP 分支上被压成一句 `代理 HTTP 503`，永远走不到上面的处置表 —— 而归一化
        // 错误码的全部意义就是让这几种失败各自带上可执行的下一步。
        let env: Json | null = null;
        try {
          const j = JSON.parse(text) as unknown;
          // 不用 asObj：它对非对象返回 {} 而不是 null，"是不是 JSON 对象"这个判断会永远为真
          env = j !== null && typeof j === "object" && !Array.isArray(j) ? (j as Json) : null;
        } catch {
          env = null;
        }
        if (!resp.ok) {
          const err = asObj(env?.error);
          const code = str(err.code ?? env?.code ?? `http_${resp.status}`);
          throw new Error(
            `小红书采集失败 [${code}]（代理 HTTP ${resp.status}）：${xhsHint(code)}` +
              (err.message ? `（原文：${str(err.message).slice(0, 200)}）` : text ? `（响应：${text.slice(0, 200)}）` : ""),
          );
        }
        if (!env) {
          throw new Error(`小红书代理返回的不是 JSON（前 200 字符）：${text.slice(0, 200) || "(空响应)"}`);
        }

        // 联调工具返回的假数据带 `_lab:{mock:true}`，据此把 synthetic 置 true。
        // 理由同抖音适配器：假数据必须在 provenance 里显式可见，不能被当成真实采集。
        const labMock = asObj(env._lab).mock === true;
        if (env.ok === false || env.error !== undefined) {
          const err = asObj(env.error);
          const code = str(err.code ?? env.code ?? "api_error");
          throw new Error(
            `小红书采集失败 [${code}]：${xhsHint(code)}${err.message ? `（原文：${str(err.message).slice(0, 200)}）` : ""}`,
          );
        }

        // CLI 的输出信封把载荷放在 data 下；代理契约保持一致
        const data = asObj(env.data ?? env);
        if (spec.single && Object.keys(data).length === 0) {
          throw new Error("小红书代理返回了空数据（笔记/用户可能不存在、已删除，或需要传完整的 URL 以携带 xsec_token）");
        }

        const rows: Record<string, unknown>[] =
          op === "note"
            ? [toNote(pick(data, ["note", "note_detail", "data"]) ?? data) as unknown as Record<string, unknown>]
            : op === "user"
              ? [toUser(pick(data, ["user", "user_info", "data"]) ?? data) as unknown as Record<string, unknown>]
              : op === "comments"
                ? (asArr(pick(data, ["comments", "comment_list", "data", "list"])).map(toComment) as unknown as Record<string, unknown>[])
                : (asArr(pick(data, ["notes", "note_list", "items", "data", "list"])).map(toNote) as unknown as Record<string, unknown>[]);

        const provenance: Provenance = {
          sourceId: XHS_WEB_SOURCE_ID,
          sourceName: "小红书公开内容（自托管只读代理）",
          tier: "L3",
          synthetic: labMock,
          asOf: new Date().toISOString(),
          note:
            (labMock ? "[本地联调假数据，非真实采集] " : "") +
            `小红书公开内容采集（${spec.label}），经登录态只读代理访问、未经人工核验、非平台授权实测；` +
            `引用须标注笔记/账号来源，且不得用于甲方自身经营指标`,
          rowCount: rows.length,
        };

        return { rows, provenance };
      } catch (e) {
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
          throw new Error(`小红书采集超时（${timeoutMs}ms）。代理内部含人类化请求延迟，可适当调大 BM_XHS_TIMEOUT_MS`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 配置加载（对应 LLD §7.2）
 *
 * 不引入 dotenv：手写一个 60 行的解析器，避免依赖，也便于私有化离线部署。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type Env = "dev" | "staging" | "prod";

/**
 * 抖音自托管采集服务的端点路径。
 *
 * 为什么路径要可覆盖：DTK 有两代形态，端点前缀完全不同。默认值随
 * `BM_DOUYIN_STYLE` 走（见 `DOUYIN_DEFAULT_PATHS`），显式设了 `BM_DOUYIN_PATH_*` 就以它为准。
 */
export interface DouyinPaths {
  profile: string;
  posts: string;
  video: string;
  comments: string;
}

/**
 * 自托管 DTK 的**形态**。两代的差异大到必须显式区分，不能共用一套默认值：
 *
 * | | v4 | v5 |
 * |---|---|---|
 * | 端点前缀 | `/api/douyin/web/fetch_*` | `/api/v1/douyin/{user,user/posts,video,video/comments}` |
 * | 同步方式 | `?wait=true` | `?wait=<秒数>`（传 `true` 会被 FastAPI 判 422） |
 * | 鉴权 | 无 | `X-API-Key` / `Authorization: Bearer`，默认强制 |
 * | 响应信封 | `{code, router_data?}` | `{success, data, error, meta}` |
 * | 异步 | 无 | 默认 `202 + data.{task_id,state}` |
 *
 * 默认取 **v5**：当前仓库 `docker compose up` 装出来的就是 v5（dtk 5.1.x），
 * 而 v4 的四个路径在 v5 上**一个都不存在**——照 v4 默认值配过去，全是 404。
 * 对接老的 v4 部署时把 `BM_DOUYIN_STYLE=v4` 显式设回来。
 */
export type DouyinStyle = "v4" | "v5";

/** 两代的默认端点。显式 `BM_DOUYIN_PATH_*` 仍然优先。 */
export const DOUYIN_DEFAULT_PATHS: Record<DouyinStyle, DouyinPaths> = {
  v4: {
    profile: "/api/douyin/web/fetch_user_profile",
    posts: "/api/douyin/web/fetch_user_post_videos",
    video: "/api/douyin/web/fetch_one_video",
    comments: "/api/douyin/web/fetch_video_comments",
  },
  v5: {
    profile: "/api/v1/douyin/user",
    posts: "/api/v1/douyin/user/posts",
    video: "/api/v1/douyin/video",
    comments: "/api/v1/douyin/video/comments",
  },
};

/**
 * `wait` 的默认值。两代语义不同，这是最容易踩的一脚：
 *   v4：布尔开关，`true` = "在服务端等结果"。
 *   v5：**秒数**，且超过 `api.max_wait_seconds`（DTK 默认 30）会被 400 拒掉；
 *       传 `true` 连类型都过不了，直接 422。
 */
export const DOUYIN_DEFAULT_WAIT: Record<DouyinStyle, string> = { v4: "true", v5: "20" };

/** 小红书自托管**只读**代理的端点路径。契约定义见 docs/datasource-integration.md */
export interface XhsPaths {
  note: string;
  comments: string;
  user: string;
  userPosts: string;
}

export interface Config {
  env: Env;
  httpPort: number;
  dataDir: string;

  storage: { driver: "sqlite"; sqlitePath: string };

  llm: {
    mode: "live" | "mock";
    baseUrl: string;
    apiKey: string;
    models: { strong: string; medium: string; light: string };
    concurrency: number;
    timeoutMs: number;
    maxRetries: number;
    maxOutputTokens: number;
    disableThinking: boolean;
    /** 连续多少次「端点级失败」后熔断（0 = 关闭熔断） */
    breakerThreshold: number;
    /** 熔断后多少毫秒内直接快速失败、不再打端点 */
    breakerCooldownMs: number;
    priceInputPer1k: number;
    priceOutputPer1k: number;
  };

  retrieval: {
    vectorDriver: "memory" | "qdrant";
    embedUrl: string;
    embedModel: string;
    rerankUrl: string;
    rerankModel: string;
    rerankPoolSize: number;
    rerankTimeoutMs: number;
    rerankCooldownMs: number;
  };

  parser: {
    url: string;
    fallback: "mineru" | "textonly" | "none";
    /**
     * 文档解析超时（毫秒）。默认 60s——远高于普通接口，
     * 因为 pdf/扫描件解析本身就慢，用 8s 这种默认值会必然超时。
     */
    timeoutMs: number;
  };
  render: { engine: "markdown" | "presenton" };

  /**
   * 报告深度预算（P2-2）。
   *
   * 一份 13 页、含真表格与图表的报告 DSL 约 40–60KB JSON（≈2 万+ token），
   * 用网关默认的 4096 输出上限必然截断，截断后走合成兜底 →
   * 报告顶部出现误导性的「模型不可用」。所以 report 阶段单列预算。
   */
  report: {
    /** 单次输出 token 上限 */
    maxTokens: number;
    /** 提示词里上游产物的字符上限 */
    contextMaxChars: number;
    /** 报告页数下限（深度策略） */
    minSlides: number;
  };

  /**
   * M4 联网检索（火山引擎「联网搜索 Lite」）。
   *
   * 定位：给 Agent 补一条**公开网页**信息通道。返回结果按 L3 处理
   * （公开但未经人工核验），必须带出处站点与链接才能被报告引用。
   * 未配置 apiKey 时适配器不注册，web_search 工具也不会出现在 Agent 的工具清单里。
   */
  webSearch: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    /** 不传 count 时的默认条数 */
    defaultCount: number;
    maxCount: number;
    timeoutMs: number;
    /** 相同查询的缓存 TTL（秒）：网页结果比指数变得快，默认 15 分钟 */
    cacheTtlSeconds: number;
    /** intel 阶段是否自动预取一次检索（关闭后仅允许 Agent 在工具循环里主动调用） */
    prefetch: boolean;
  };

  /**
   * 抖音公开数据（自托管 DTK：Evil0ctal/Douyin_TikTok_Download_API）。
   *
   * 定位：给达人/内容/舆情补一条**平台内**的公开信息通道，补 web_search 抓不到的
   * 作品数据与评论。只做只读子集：达人主页 / 作品列表 / 作品详情 / 评论。
   *
   * ⚠️ 分级是 **L3（公开）**，不是 L1。这是红线：
   *   这条链路与抖音平台之间**不存在授权合同**，拿到的是公开可见的内容。
   *   标成 L1 等于把"公开采集"洗成"甲方授权实测"，报告会据此把数字标成高置信度——
   *   而这条数据既不来自甲方后台、也没经过人工核验。L3 源还禁止填 contractRef
   *   （见 governance 的 assertSourceRegistration），从写入口就堵住这种伪装。
   *
   * 未配置 baseUrl 时适配器不注册，douyin_* 工具也不会出现在 Agent 的工具清单里
   * （与 web_search 同一模式）——宁可没有这项能力，也不要让模型调一个必然失败的工具。
   */
  douyin: {
    enabled: boolean;
    /** 自托管服务地址，例如 http://127.0.0.1:8000（留空 = 能力缺席） */
    baseUrl: string;
    /** DTK v5 需要 API Key；v4 留空即可。非空时带 Authorization: Bearer */
    apiKey: string;
    /** DTK 形态（决定端点默认值与 `wait` 语义），默认 v5 */
    style: DouyinStyle;
    /**
     * 同步等待参数。v4 用 `true`，v5 用**秒数**。默认随 style 走，
     * 单独可覆盖（v5 身份池繁忙时可以调大，上限是 DTK 的 `api.max_wait_seconds`）。
     */
    wait: string;
    timeoutMs: number;
    /** 采集类结果变化慢，默认缓存 30 分钟 */
    cacheTtlSeconds: number;
    paths: DouyinPaths;
  };

  /**
   * 小红书公开内容（自托管**只读**代理）。
   *
   * 为什么必须经代理而不是直连：可用的开源采集工具（如 xiaohongshu-cli）是 CLI、
   * 需要登录态 Cookie、且**同时提供写命令**（发笔记/点赞/评论/关注/删除）。
   * 整包封装会让模型有机会以甲方账号名义产生副作用。所以这里约定一个
   * **只暴露只读子命令**的 HTTP 代理作为唯一边界，适配器只认这个契约。
   *
   * 分级同为 **L3**：内容本身公开可见，但访问经过登录态、且未经人工核验，
   * provenance.note 必须如实写明这两点。
   */
  xiaohongshu: {
    enabled: boolean;
    /** 自托管只读代理地址，例如 http://127.0.0.1:8899（留空 = 能力缺席） */
    baseUrl: string;
    /** 代理侧若配了访问令牌则一致填写；留空表示代理无鉴权 */
    apiKey: string;
    timeoutMs: number;
    cacheTtlSeconds: number;
    paths: XhsPaths;
  };

  tiers: { L1: boolean; L2: boolean; L3: boolean; L4: boolean };

  tools: {
    /**
     * 是否允许注册 `mutating` 工具（会改变外部系统状态：发帖/点赞/评论/关注/删除）。
     *
     * 默认 **false**。让"引入写能力"成为一次主动决策，而不是封装数据源时的副作用：
     * 公开采集类工具包（如 xiaohongshu-cli）自带写操作，整包封装后
     * 模型可以合法地通过白名单、合法地过闸门，然后以甲方名义发出一条笔记。
     * 打开它之前请确认：工具已挂 authz 检查、且只封装了确实需要的写命令。
     */
    allowMutating: boolean;
  };

  job: { maxJobMinutes: number; allowPartial: boolean };

  kb: {
    /**
     * 是否允许通过入库通道写入**跨租户共享**的全局语料（KB-3/KB-4，tenant_id=''）。
     *
     * 默认 **false**。当前 TenantContext 里还没有角色概念（token 只有
     * `t.<tenantId>.<userId>` 三段），所以"仅 admin 可写全局"这条约束
     * 暂时只能落在部署配置上——**宁可暂时用一个开关守住，也不要靠
     * userId 字符串匹配去猜谁是管理员**。等角色系统落地后，
     * 这里应改为按角色鉴权，而不是放宽开关。
     */
    allowGlobalWrite: boolean;
  };

  observability: {
    traceContent: boolean;
    otelEndpoint: string;
    langfuseUrl: string;
    logLevel: "debug" | "info" | "warn" | "error";
  };

  /** 闸门异常时是否拒绝。**必须为 true**，仅测试可改。 */
  gateFailClosed: boolean;
}

function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v);

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : dflt;
};

const str = (v: string | undefined, dflt = ""): string => (v === undefined ? dflt : v);

export function loadConfig(cwd: string = process.cwd(), overrides: Record<string, string> = {}): Config {
  const fileVars = parseDotEnv(resolve(cwd, ".env"));
  const env: Record<string, string> = { ...fileVars, ...overrides };
  const get = (k: string, fallback?: string): string | undefined =>
    overrides[k] ?? process.env[k] ?? env[k] ?? fallback;

  /**
   * DTK 形态。认不出的值**不静默退回默认**——写错 `BM_DOUYIN_STYLE=v6` 却按 v5
   * 的路径去请求，得到的是四个 404，排查成本远高于现在直接报错。
   */
  const douyinStyle = (): DouyinStyle => {
    const raw = str(get("BM_DOUYIN_STYLE"), "v5").toLowerCase();
    if (raw !== "v4" && raw !== "v5") {
      throw new Error(
        `BM_DOUYIN_STYLE 只能是 v4 或 v5，收到「${raw}」。` +
          `当前仓库 docker compose 装出来的 DTK 是 v5；若你自建的是老版本，显式设成 v4。`,
      );
    }
    return raw;
  };

  const dataDir = resolve(cwd, str(get("BM_DATA_DIR"), "./.data"));
  const envName = str(get("BM_ENV"), "dev") as Env;

  const config: Config = {
    env: envName,
    httpPort: num(get("BM_HTTP_PORT"), 8787),
    dataDir,

    storage: {
      driver: "sqlite",
      sqlitePath: resolve(dataDir, "brandsale.sqlite"),
    },

    llm: {
      mode: str(get("BM_LLM_MODE"), "live") === "mock" ? "mock" : "live",
      baseUrl: str(get("BM_LLM_BASE_URL"), "http://127.0.0.1:8000/v1").replace(/\/+$/, ""),
      apiKey: str(get("BM_LLM_API_KEY"), "sk-local-dev"),
      models: {
        strong: str(get("BM_MODEL_STRONG"), "qwen3.8-flash-next"),
        medium: str(get("BM_MODEL_MEDIUM"), "qwen3.8-flash-next"),
        light: str(get("BM_MODEL_LIGHT"), "qwen3.8-flash-next"),
      },
      concurrency: num(get("BM_LLM_CONCURRENCY"), 4),
      timeoutMs: num(get("BM_LLM_TIMEOUT_MS"), 180_000),
      maxRetries: num(get("BM_LLM_MAX_RETRIES"), 2),
      maxOutputTokens: num(get("BM_LLM_MAX_OUTPUT_TOKENS"), 4096),
      disableThinking: bool(get("BM_LLM_DISABLE_THINKING"), true),
      breakerThreshold: num(get("BM_LLM_BREAKER_THRESHOLD"), 3),
      breakerCooldownMs: num(get("BM_LLM_BREAKER_COOLDOWN_MS"), 120_000),
      priceInputPer1k: num(get("BM_PRICE_INPUT_PER_1K"), 0.001),
      priceOutputPer1k: num(get("BM_PRICE_OUTPUT_PER_1K"), 0.002),
    },

    retrieval: {
      vectorDriver: str(get("BM_VECTOR_DRIVER"), "memory") === "qdrant" ? "qdrant" : "memory",
      embedUrl: str(get("BM_EMBED_URL")),
      embedModel: str(get("BM_EMBED_MODEL")),
      rerankUrl: str(get("BM_RERANK_URL")),
      rerankModel: str(get("BM_RERANK_MODEL")),
      rerankPoolSize: num(get("BM_RERANK_POOL_SIZE"), 50),
      rerankTimeoutMs: num(get("BM_RERANK_TIMEOUT_MS"), 30_000),
      rerankCooldownMs: num(get("BM_RERANK_COOLDOWN_MS"), 30_000),
    },

    parser: {
      url: str(get("BM_PARSER_URL")),
      fallback: (str(get("BM_PARSER_FALLBACK"), "textonly") as Config["parser"]["fallback"]) ?? "textonly",
      timeoutMs: num(get("BM_PARSER_TIMEOUT_MS"), 60_000),
    },

    render: { engine: str(get("BM_RENDER_ENGINE"), "markdown") === "presenton" ? "presenton" : "markdown" },

    report: {
      maxTokens: num(get("BM_REPORT_MAX_TOKENS"), 32_768),
      contextMaxChars: num(get("BM_REPORT_CONTEXT_CHARS"), 48_000),
      minSlides: num(get("BM_REPORT_MIN_SLIDES"), 12),
    },

    webSearch: {
      enabled: bool(get("BM_WEB_SEARCH_ENABLED"), true),
      baseUrl: str(get("BM_WEB_SEARCH_URL"), "https://open.feedcoopapi.com/search_api/web_search"),
      apiKey: str(get("BM_WEB_SEARCH_API_KEY"), ""),
      defaultCount: num(get("BM_WEB_SEARCH_COUNT"), 5),
      maxCount: num(get("BM_WEB_SEARCH_MAX_COUNT"), 50),
      timeoutMs: num(get("BM_WEB_SEARCH_TIMEOUT_MS"), 8000),
      cacheTtlSeconds: num(get("BM_WEB_SEARCH_CACHE_TTL"), 900),
      prefetch: bool(get("BM_WEB_SEARCH_PREFETCH"), true),
    },

    douyin: {
      enabled: bool(get("BM_DOUYIN_ENABLED"), true),
      // 去掉结尾斜杠：适配器按 `${baseUrl}${path}` 拼接，双斜杠在某些反代上会 404
      baseUrl: str(get("BM_DOUYIN_BASE_URL")).replace(/\/+$/, ""),
      apiKey: str(get("BM_DOUYIN_API_KEY")),
      style: douyinStyle(),
      wait: str(get("BM_DOUYIN_WAIT")) || DOUYIN_DEFAULT_WAIT[douyinStyle()],
      timeoutMs: num(get("BM_DOUYIN_TIMEOUT_MS"), 15_000),
      cacheTtlSeconds: num(get("BM_DOUYIN_CACHE_TTL"), 1_800),
      paths: {
        profile: str(get("BM_DOUYIN_PATH_PROFILE")) || DOUYIN_DEFAULT_PATHS[douyinStyle()].profile,
        posts: str(get("BM_DOUYIN_PATH_POSTS")) || DOUYIN_DEFAULT_PATHS[douyinStyle()].posts,
        video: str(get("BM_DOUYIN_PATH_VIDEO")) || DOUYIN_DEFAULT_PATHS[douyinStyle()].video,
        comments: str(get("BM_DOUYIN_PATH_COMMENTS")) || DOUYIN_DEFAULT_PATHS[douyinStyle()].comments,
      },
    },

    xiaohongshu: {
      enabled: bool(get("BM_XHS_ENABLED"), true),
      baseUrl: str(get("BM_XHS_BASE_URL")).replace(/\/+$/, ""),
      apiKey: str(get("BM_XHS_API_KEY")),
      // 小红书代理内部是 spawn CLI + 内置人类化延迟（~1-1.5s/次），超时给得比抖音宽
      timeoutMs: num(get("BM_XHS_TIMEOUT_MS"), 25_000),
      cacheTtlSeconds: num(get("BM_XHS_CACHE_TTL"), 1_800),
      paths: {
        note: str(get("BM_XHS_PATH_NOTE"), "/xhs/note"),
        comments: str(get("BM_XHS_PATH_COMMENTS"), "/xhs/comments"),
        user: str(get("BM_XHS_PATH_USER"), "/xhs/user"),
        userPosts: str(get("BM_XHS_PATH_USER_POSTS"), "/xhs/user-posts"),
      },
    },

    tiers: {
      L1: bool(get("BM_L1_ENABLED"), true),
      L2: bool(get("BM_L2_ENABLED"), true),
      L3: bool(get("BM_L3_ENABLED"), true),
      L4: bool(get("BM_L4_ENABLED"), false),
    },

    tools: {
      allowMutating: bool(get("BM_TOOLS_ALLOW_MUTATING"), false),
    },

    job: {
      maxJobMinutes: num(get("BM_MAX_JOB_MINUTES"), 60),
      allowPartial: bool(get("BM_ALLOW_PARTIAL"), true),
    },

    kb: {
      allowGlobalWrite: bool(get("BM_KB_ALLOW_GLOBAL_WRITE"), false),
    },

    observability: {
      traceContent: bool(get("BM_TRACE_CONTENT"), false),
      otelEndpoint: str(get("BM_OTEL_ENDPOINT")),
      langfuseUrl: str(get("BM_LANGFUSE_URL")),
      logLevel: (str(get("BM_LOG_LEVEL"), "info") as Config["observability"]["logLevel"]) ?? "info",
    },

    gateFailClosed: bool(get("BM_GATE_FAIL_CLOSED"), true),
  };

  return config;
}

/** 供 AppError/启动自检使用：prod 下的硬性约束 */
export function assertConfigInvariants(c: Config): string[] {
  const problems: string[] = [];
  if (c.env === "prod" && !c.gateFailClosed) {
    problems.push("BM_GATE_FAIL_CLOSED 在 prod 下必须为 true（否则闸门异常会放行数据访问）");
  }
  if (c.env === "prod" && c.tiers.L4 && !c.observability.traceContent) {
    // L4 在 prod 打开时必须同时有法务审批台账，这里只做提醒
    problems.push("L4 数据源在 prod 下已开启，请确认台账中存在 legal_approved=true 的登记记录");
  }
  if (c.llm.mode === "live" && !c.llm.baseUrl) {
    problems.push("BM_LLM_MODE=live 但 BM_LLM_BASE_URL 为空");
  }
  if (c.webSearch.enabled && !c.webSearch.apiKey) {
    problems.push("BM_WEB_SEARCH_ENABLED=true 但 BM_WEB_SEARCH_API_KEY 为空：联网检索适配器与 web_search 工具都不会注册");
  }
  // 这两个源的注册条件是 baseUrl（自托管地址），不是凭据：
  // 抖音适配器打的是自建 DTK 服务，小红书打的是只读代理，都是"地址在则能力在"。
  if (c.douyin.enabled && !c.douyin.baseUrl) {
    problems.push(
      "BM_DOUYIN_ENABLED=true 但 BM_DOUYIN_BASE_URL 为空：抖音公开数据适配器与 douyin_* 工具都不会注册。" +
        "自建 DTK（Evil0ctal/Douyin_TikTok_Download_API）后把地址填进去即可；本地联调可用 npm run datasource:lab",
    );
  }
  // v5 默认强制鉴权（dtk 5.1 起每个端点都要 API Key 或有 `api.public_endpoints` 显式放开），
  // 而 v4 完全不校验。这里只提醒，不阻断——运维可能确实放开了公开端点。
  if (c.douyin.enabled && c.douyin.baseUrl && c.douyin.style === "v5" && !c.douyin.apiKey) {
    problems.push(
      "BM_DOUYIN_STYLE=v5 但 BM_DOUYIN_API_KEY 为空：DTK v5 默认要求鉴权，" +
        "四个端点会返回 401/403。请在 DTK 控制台建一个 Key，或把对应端点加入 api.public_endpoints",
    );
  }
  if (c.xiaohongshu.enabled && !c.xiaohongshu.baseUrl) {
    problems.push(
      "BM_XHS_ENABLED=true 但 BM_XHS_BASE_URL 为空：小红书只读适配器与 xhs_* 工具都不会注册。" +
        "自建只读代理后填入地址；本地联调可用 npm run datasource:lab",
    );
  }
  return problems;
}

/**
 * 配置加载（对应 LLD §7.2）
 *
 * 不引入 dotenv：手写一个 60 行的解析器，避免依赖，也便于私有化离线部署。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type Env = "dev" | "staging" | "prod";

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

  parser: { url: string; fallback: "mineru" | "textonly" | "none" };
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

  tiers: { L1: boolean; L2: boolean; L3: boolean; L4: boolean };

  job: { maxJobMinutes: number; allowPartial: boolean };

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

    tiers: {
      L1: bool(get("BM_L1_ENABLED"), true),
      L2: bool(get("BM_L2_ENABLED"), true),
      L3: bool(get("BM_L3_ENABLED"), true),
      L4: bool(get("BM_L4_ENABLED"), false),
    },

    job: {
      maxJobMinutes: num(get("BM_MAX_JOB_MINUTES"), 60),
      allowPartial: bool(get("BM_ALLOW_PARTIAL"), true),
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
  return problems;
}

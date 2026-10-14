/**
 * 配置加载（对应 LLD §7.2）
 *
 * 不引入 dotenv：手写一个 60 行的解析器，避免依赖，也便于私有化离线部署。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type Env = "dev" | "staging" | "prod";

/**
 * MediaCrawler 支持的七个平台。取值用的是 MediaCrawler 自己的平台码
 * （`xhs`/`dy`/`ks`/`bili`/`wb`/`tieba`/`zhihu`），因为它就是被复用的那个采集内核，
 * 保持同码可以少一层翻译、也便于直接对照它的 `POST /api/crawler/start`。
 *
 * ⚠️ 这与业务侧的 `Platform`（`douyin`/`xiaohongshu`/`bilibili`/`weibo`，见
 * packages/contracts）**不是一回事**：业务侧是"这个 brief 投哪几个平台"，
 * 这里说的是"哪几个平台的公开内容采集通道可用"。两者只是部分重叠。
 */
export const MEDIA_CRAWLER_PLATFORMS = ["xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu"] as const;
export type MediaCrawlerPlatform = (typeof MEDIA_CRAWLER_PLATFORMS)[number];

/**
 * 采集算子。**七平台统一这四个**——因为 MediaCrawler 对七个平台都只实现了
 * `search` / `detail` / `creator` 三种 `crawler_type`（已核对各平台 core.py）。
 *
 * 曾经考虑把 B站 的「粉丝列表 / 关注列表」也作为算子暴露，**放弃**：
 * 客户端里虽然有 `get_creator_fans` / `get_creator_followings`，但 core.py 里
 * 对应的调用是**注释掉的**，且 CLI 与 FastAPI 都没有开关可以触发它。
 * 走现有黑盒入口根本拿不到——把不可达的能力写进工具描述，只会让模型反复去调一个必然空手的算子。
 */
export type CollectOp = "search" | "content_detail" | "comments" | "creator";

/**
 * 归一化后的**统一指标名**。与 `apps/collector/src/normalize.ts` 里的 metrics 键一一对应：
 * 那边的候选表负责"把各平台千奇百怪的原始字段名映射到这几个键"，这边负责声明
 * "某平台**真的有**哪些键"。
 *
 * 为什么要单独声明而不能从候选表推：候选表是**并集**（为了容错，基类候选表对七个平台
 * 是同一份），它回答"怎么解析"；而能力矩阵回答"存不存在"。快手的内容记录里根本没有
 * 评论数字段，从候选表看不出来，只能靠真机核对后显式写下（见
 * docs/platform-capability-integration-plan.md §1）。
 */
export type ContentMetricKey = "likes" | "comments" | "collects" | "shares" | "views";
export type CommentMetricKey = "likes" | "subComments";

export const CONTENT_METRIC_LABEL: Record<ContentMetricKey, string> = {
  likes: "点赞",
  comments: "评论数",
  collects: "收藏",
  shares: "转发/分享",
  views: "播放/阅读",
};

export const COMMENT_METRIC_LABEL: Record<CommentMetricKey, string> = {
  likes: "评论点赞",
  subComments: "子评论数",
};

/**
 * 指标键的**有序全集**。存在的意义是"遍历"：`platform_digest` 要按固定顺序
 * 逐个指标判定"本批数据里是否真有非零值"，顺序不定会让同一批数据的输出不稳定。
 * 与 label 表保持一致，新增指标时两处一起改（放在相邻位置就是为了让人看见）。
 */
export const CONTENT_METRIC_KEYS: readonly ContentMetricKey[] = ["likes", "comments", "collects", "shares", "views"];
export const COMMENT_METRIC_KEYS: readonly CommentMetricKey[] = ["likes", "subComments"];

export interface MediaCrawlerPlatformMeta {
  platform: MediaCrawlerPlatform;
  /** 台账源 ID（seed 登记与工具 boundSourceId 共用，避免两处字符串漂移） */
  sourceId: string;
  displayName: string;
  /**
   * MediaCrawler 落盘目录名。**与 API 平台码不是同一套**：
   * FastAPI 的 `PlatformEnum` 收 `xhs`/`dy`/`ks`/`bili`/`wb`/`tieba`/`zhihu`，
   * 而它写文件写的是 `data/{douyin,kuaishou,bilibili,weibo,...}/`。
   * 两套码混起来会得到"任务成功但永远读不到文件"这种最难查的故障，所以显式列出来。
   */
  dataDirName: string;
  /** 内容对象的称呼，写进工具描述帮模型选词（笔记 / 视频 / 微博 / 帖子 / 回答） */
  contentNoun: string;
  /** 创作者的称呼（博主 / 达人 / UP 主 / 用户） */
  creatorNoun: string;
  /**
   * 常驻采集浏览器的调试端口（`--cdp reuse` 模式下由 collector 下发给内核的 `--cdp-port`）。
   *
   * 为什么每个平台一个**固定**端口：
   *   · 常驻浏览器是**按平台**隔离的（各有一份登录态 profile，内核侧是
   *     `USER_DATA_DIR = "%s_user_data_dir"`）。端口若共用，后启动的平台会连上前一个
   *     平台的会话，直接串掉登录态。
   *   · 端口是 collector 回收浏览器时**唯一的身份标识**（`lsof -t -i tcp:<port>`），
   *     所以必须固定，不能让内核 `find_available_port` 自己向上找空闲端口。
   *
   * 段位取 9333 起：避开 9222（Chrome 手工远程调试与各类 devtools 桥的常用位）。
   */
  cdpPort: number;
  ops: CollectOp[];
  /**
   * 该平台**内容行里真实存在**的互动指标（真机核对，非推断）。
   *
   * 这张表是"跨平台能不能比"的唯一依据：`platform_digest` 会按它算
   * 「本组平台的**共有**指标」，报告里只允许在这些指标上做横向对比。
   * 拿 B站投币数比小红书点赞那种错，根因就是这里没被显式声明过。
   */
  contentMetrics: ContentMetricKey[];
  /** 该平台**评论行里真实存在**的指标。快手与贴吧的评论模型没有点赞字段 */
  commentMetrics: CommentMetricKey[];
}

/**
 * 七平台的展示名与台账源 ID。放在 config 而不是 datasource，是为了让
 * **collector（app）与 datasource（包）共用同一份常量**：两边各自写一遍，
 * 迟早会出现「seed 登记的是 mc_xhs、工具绑的是 xhs_public」这类静默错配。
 */
export const MEDIA_CRAWLER_PLATFORM_META: Record<MediaCrawlerPlatform, MediaCrawlerPlatformMeta> = {
  xhs: {
    platform: "xhs",
    cdpPort: 9333,
    sourceId: "mc_xhs",
    displayName: "小红书",
    dataDirName: "xhs",
    contentNoun: "笔记",
    creatorNoun: "博主",
    ops: ["search", "content_detail", "comments", "creator"],
    // 内核 store/xhs/__init__.py：liked_count / comment_count / collected_count / share_count
    contentMetrics: ["likes", "comments", "collects", "shares"],
    commentMetrics: ["likes", "subComments"],
  },
  dy: {
    platform: "dy",
    cdpPort: 9334,
    sourceId: "mc_dy",
    displayName: "抖音",
    dataDirName: "douyin",
    contentNoun: "视频",
    creatorNoun: "达人",
    ops: ["search", "content_detail", "comments", "creator"],
    // digg_count / comment_count / collect_count / share_count（**没有**播放量）
    contentMetrics: ["likes", "comments", "collects", "shares"],
    commentMetrics: ["likes", "subComments"],
  },
  ks: {
    platform: "ks",
    cdpPort: 9335,
    sourceId: "mc_ks",
    displayName: "快手",
    dataDirName: "kuaishou",
    contentNoun: "视频",
    creatorNoun: "博主",
    ops: ["search", "content_detail", "comments", "creator"],
    /* ⚠️ 只有 realLikeCount + viewCount：**内容记录里没有评论总数**（这是唯一缺评论数的平台），
     * 也**没有**收藏/转发。需要评论热度只能用 comments 算子的采样条数近似，且必须写明口径。 */
    contentMetrics: ["likes", "views"],
    commentMetrics: ["subComments"],
  },
  bili: {
    platform: "bili",
    cdpPort: 9336,
    sourceId: "mc_bili",
    displayName: "B站",
    dataDirName: "bili",
    contentNoun: "视频",
    creatorNoun: "UP 主",
    ops: ["search", "content_detail", "comments", "creator"],
    /* 指标最全：like / reply / favorite / share / view 全有（另有弹幕/投币，未归一化）。
     * 落盘主键是 `video_id`（= aid），不是 bvid —— 见 store/bilibili/__init__.py。 */
    contentMetrics: ["likes", "comments", "collects", "shares", "views"],
    commentMetrics: ["likes", "subComments"],
  },
  wb: {
    platform: "wb",
    cdpPort: 9337,
    sourceId: "mc_wb",
    displayName: "微博",
    dataDirName: "weibo",
    contentNoun: "微博",
    creatorNoun: "博主",
    ops: ["search", "content_detail", "comments", "creator"],
    // attitudes_count / comments_count / shared_count（注意是 shared_ 不是 share_）；无收藏、无阅读
    contentMetrics: ["likes", "comments", "shares"],
    commentMetrics: ["likes", "subComments"],
  },
  tieba: {
    platform: "tieba",
    cdpPort: 9338,
    sourceId: "mc_tieba",
    displayName: "贴吧",
    dataDirName: "tieba",
    contentNoun: "帖子",
    creatorNoun: "用户",
    ops: ["search", "content_detail", "comments", "creator"],
    /* 指标最贫：只有正文与评论数（`total_replay_num`，**repl a y**，上游拼写如此）。
     * 没有点赞/收藏/转发/播放 —— 所以贴吧帖只能做"正文 + 评论数"分析。 */
    contentMetrics: ["comments"],
    commentMetrics: ["subComments"],
  },
  zhihu: {
    platform: "zhihu",
    cdpPort: 9339,
    sourceId: "mc_zhihu",
    displayName: "知乎",
    dataDirName: "zhihu",
    contentNoun: "回答",
    creatorNoun: "答主",
    ops: ["search", "content_detail", "comments", "creator"],
    // voteup_count / comment_count；无收藏、无转发、无阅读（回答另带 question_id 与问题标题）
    contentMetrics: ["likes", "comments"],
    commentMetrics: ["likes", "subComments"],
  },
};

/**
 * 业务平台码 → 采集平台码。
 *
 * 两套编码**不通用**，混用会出现"任务提交成功但一个平台都没采"这种静默故障：
 *   · 业务码在 `packages/contracts`（`POPULAR_PLATFORMS`：douyin/xiaohongshu/bilibili/weibo），
 *     表示"这个 brief 要投哪几个平台"，直接来自客户 Brief；
 *   · 采集码是本文件的 `MediaCrawlerPlatform`，表示"哪几个平台的公开内容通道可用"。
 *
 * 只映射**业务侧真会出现的那四个**。快手/贴吧/知乎刻意不在这里：`Brief.platforms`
 * 的候选集（`POPULAR_PLATFORMS`）里没有它们，凭空映射等于替客户造主张。它们只能由
 * 智能体在工具循环里按需指定（`platform_digest` 的 `platforms` 参数接受全部七个采集码）。
 *
 * 放在 config 而不是 agent-pack：`tool-impls.ts` 需要它做参数别名归一，
 * 而 `agents.ts` 需要它做预采集——分别写一份，迟早两边对不上。
 */
export const BRIEF_PLATFORM_TO_MC: Record<string, MediaCrawlerPlatform> = {
  xiaohongshu: "xhs",
  douyin: "dy",
  bilibili: "bili",
  weibo: "wb",
};

/**
 * 一组平台的**共有内容指标**（交集）。
 *
 * 这是聚合层"哪些指标可以横向比"的权威答案：报告里做跨平台声量对比时，
 * 只允许落在交集上。空集是合法结果（例如「贴吧 + 快手」只剩 0 个共有指标），
 * 此时调用方必须如实写"不可跨平台对比"，而不是挑一个指标硬比。
 */
export function comparableContentMetrics(platforms: readonly MediaCrawlerPlatform[]): ContentMetricKey[] {
  return intersectMetricKeys(platforms, (m) => m.contentMetrics);
}

/** 一组平台的**共有评论指标**（交集） */
export function comparableCommentMetrics(platforms: readonly MediaCrawlerPlatform[]): CommentMetricKey[] {
  return intersectMetricKeys(platforms, (m) => m.commentMetrics);
}

/** 交集计算：按第一个平台的顺序输出，保证同输入同输出（便于回归与快照） */
function intersectMetricKeys<K extends string>(
  platforms: readonly MediaCrawlerPlatform[],
  pick: (m: MediaCrawlerPlatformMeta) => readonly K[],
): K[] {
  const known = platforms.filter((p) => MEDIA_CRAWLER_PLATFORM_META[p]);
  if (known.length === 0) return [];
  const first = pick(MEDIA_CRAWLER_PLATFORM_META[known[0]!]);
  return first.filter((k) => known.every((p) => pick(MEDIA_CRAWLER_PLATFORM_META[p]).includes(k)));
}

export interface Config {
  env: Env;
  httpPort: number;
  dataDir: string;

  storage: { driver: "sqlite"; sqlitePath: string };

  /**
   * 是否允许把**内置演示样例数据**当作可用数据（达人报价库 + 已灌入的 KB 语料）。
   *
   * 默认 **false**：报告里出现的每一个达人与每一句结论，都必须能追溯到真实来源
   * （客户录入 / 平台采集 / 联网检索）。演示样例只在开发与自动化测试里打开
   * （`BM_ALLOW_DEMO_DATA=true`），它存在的意义是让空库能跑通全链路，不是数据。
   *
   * 实现在读取侧（`PricingStore` / KB 检索）而不是写入侧：写入侧堵住只是"罐子里没毒"，
   * 万一有人手工灌了样例，读取侧过滤才是真正保证"报告不会引用样例"的那道闸。
   */
  allowDemoData: boolean;

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
    /**
     * 语义向量的存储驱动。
     *   `"memory"` —— 向量落在 SQLite（`kb_chunks.vec` BLOB）+ 应用层暴力余弦。
     *     万级 chunk 下是毫秒级，且与 chunk 同事务读写，**默认且推荐**。
     *   `"milvus"` —— 向量额外写入 Milvus（可重建的索引，非真相源）。
     *     仅在语料量/多实例等触发条件满足时启用，见
     *     `docs/report-summary-vectordb-integration-plan.md` §6。
     * 注意：SQLite 永远是唯一真相源；Milvus 挂了必须能退回纯 BM25 而不是让检索失败。
     */
    vectorDriver: "memory" | "milvus";
    /** 嵌入服务地址（OpenAI 兼容 /v1/embeddings）。为空 → 退回本地哈希向量 */
    embedUrl: string;
    embedModel: string;
    /** 向量维度。**决定落盘向量能参与比较的范围**；改变它需要重建已有向量 */
    embedDim: number;
    /** 单次嵌入请求的最大条数（分批） */
    embedBatchSize: number;
    embedTimeoutMs: number;
    /* Milvus（仅 vectorDriver === "milvus" 时使用；它永远只是可重建的索引，不是真相源） */
    milvusUri: string;
    milvusToken: string;
    milvusCollection: string;
    /**
     * Milvus 超时。默认 3s 而不是 30s：它是旁路，挂了就该立刻退回 SQLite + BM25，
     * 而不是把一次 `kb_retrieve` 拖到工具超时（20s）。宁可降级，不要等待。
     */
    milvusTimeoutMs: number;
    rerankUrl: string;
    rerankModel: string;
    rerankPoolSize: number;
    rerankTimeoutMs: number;
    rerankCooldownMs: number;
  };

  knowledge: {
    /**
     * 报告生成后是否把「机械抽取的摘要」回灌知识库（KB-2）。
     * 失败不影响报告本身（best-effort），只记 degraded。
     */
    summaryIngest: boolean;
  };

  parser: {
    /**
     * MinerU 文档解析服务地址。**空 = 只支持纯文本**：二进制（pdf/docx/xlsx/pptx/图片）
     * 会在入库前被 415 `E-INGEST-002` 拦下（见 `packages/knowledge/src/parser.ts` 文件头）。
     *
     * ⚠️ 这里**刻意没有** `fallback` 字段。原先定义过一个
     * `fallback: "mineru" | "textonly" | "none"`（读 `BM_PARSER_FALLBACK`），但它
     * **全仓零消费** —— `createParser()` 只看 `url`。更关键的是"解析器挂了就退回纯文本"
     * 这件事本来就**不该做**：那等于把二进制当文本塞进库，产出一批能检索、能被引用、
     * 但毫无意义的乱码 chunk（`parser.ts` 文件头记录的正是这个教训）。所以删掉字段，
     * 而不是把它接活。
     */
    url: string;
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
   * M4 平台内公开内容采集（复用 MediaCrawler，经独立 collector sidecar）。
   *
   * 架构：MediaCrawler 是一个**任务控制面**（POST /api/crawler/start → 子进程跑
   * Playwright → 结果落盘 data/），不是查询面。所以中间加了 `apps/collector`
   * 这层只读归一化 sidecar：它负责跑采集任务、把各平台的原始 jsonl 归一化成
   * 统一行、缓存到本地，再对 brandsale 暴露同步的只读 `/query`。
   * 适配器只认 collector，**不直接打 MediaCrawler**，也不碰它的源码。
   *
   * ⚠️ **许可证红线（务必先读）**：MediaCrawler 的许可证是
   * `NON-COMMERCIAL LEARNING LICENSE 1.1`，条件第 3 条明确：
   * 「未经版权所有者书面同意，不得将本软件用于任何商业用途」。
   * brandsale 是商业交付系统（报告直接指导甲方真实投放预算），所以这条链路
   * 只有在**取得版权方书面同意**或**你已在合规上明确接受该风险**之后才允许打开。
   * `licenseAcknowledged` 就是这道闸：默认 false，为 false 时七个适配器与
   * 七个工具**一律不注册**——把"引入一个非商用组件"固化成一个必须显式做的决定，
   * 而不是顺手配个地址就悄悄生效。
   *
   * 分级：全部 **L3**（公开、未经人工核验）。与平台之间**不存在授权合同**，
   * 因此绝不填 contractRef（governance 的 assertSourceRegistration 会以
   * E-GOV-005 在登记期拦下），报告里也只能支撑"关于他人"的公开断言。
   */
  mediaCrawler: {
    enabled: boolean;
    /** collector sidecar 地址，例如 http://127.0.0.1:8890（留空 = 能力缺席） */
    collectorBaseUrl: string;
    timeoutMs: number;
    cacheTtlSeconds: number;
    /**
     * 是否已确认接受 MediaCrawler 的非商用许可约束（或已获版权方书面同意）。
     * **必须显式打开**，否则整条链路的适配器与工具都不注册。
     */
    licenseAcknowledged: boolean;
    /** 各平台开关。默认七平台全开；只登录了部分平台时可在这里收窄 */
    platforms: Record<MediaCrawlerPlatform, boolean>;
  };

  tiers: { L1: boolean; L2: boolean; L3: boolean; L4: boolean };

  tools: {
    /**
     * 是否允许注册 `mutating` 工具（会改变外部系统状态：发帖/点赞/评论/关注/删除）。
     *
     * 默认 **false**。让"引入写能力"成为一次主动决策，而不是封装数据源时的副作用：
     * 公开采集类工具包普遍**读写同包**（如 xiaohongshu-cli 一类项目，发笔记/点赞/评论/关注
     * 与只读命令出自同一 CLI），整包封装后模型可以合法地通过白名单、合法地过闸门，
     * 然后以甲方名义发出一条笔记。打开它之前请确认：工具已挂 authz 检查、且只封装了确实需要的写命令。
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

/**
 * 导出给同仓的 collector 用：sidecar 与主程序读**同一份 .env**，
 * 避免两处各写一个解析器导致「.env 改了但只有一边生效」。
 */
export function parseDotEnv(path: string): Record<string, string> {
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

/**
 * 解析平台开关列表。
 *
 * 用**列表**而不是七个布尔变量：收窄平台是常见操作（例如只登录了抖音+小红书），
 * 写成 `BM_MC_PLATFORMS=dy,xhs` 比在七个 `BM_MC_PLATFORM_*=true/false` 里翻找清楚得多。
 * 认不出的平台码**直接抛错**而不是静默忽略——写错 `BM_MC_PLATFORMS=dy,xhss` 却以为
 * 小红书开着，是最难排查的一类配置事故。
 */
function parsePlatformList(raw: string): Record<MediaCrawlerPlatform, boolean> {
  const out = {} as Record<MediaCrawlerPlatform, boolean>;
  for (const p of MEDIA_CRAWLER_PLATFORMS) out[p] = false;
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const item of items) {
    if (!(MEDIA_CRAWLER_PLATFORMS as readonly string[]).includes(item)) {
      throw new Error(
        `BM_MC_PLATFORMS 含未知平台码「${item}」。可选：${MEDIA_CRAWLER_PLATFORMS.join(", ")}`,
      );
    }
    out[item as MediaCrawlerPlatform] = true;
  }
  return out;
}

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

    // 默认**不参考**本地演示样例；只有显式打开才允许它进入检索与报告
    allowDemoData: bool(get("BM_ALLOW_DEMO_DATA"), false),

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
      /* 单次请求超时（流式语义=空闲超时）。自建端点有冷启动：未驻留时可能"连上但
       * 数分钟不吐 token"，故默认给到 5 分钟，且阶段预算会在此基础上再加余量。 */
      timeoutMs: num(get("BM_LLM_TIMEOUT_MS"), 300_000),
      maxRetries: num(get("BM_LLM_MAX_RETRIES"), 2),
      maxOutputTokens: num(get("BM_LLM_MAX_OUTPUT_TOKENS"), 4096),
      disableThinking: bool(get("BM_LLM_DISABLE_THINKING"), true),
      breakerThreshold: num(get("BM_LLM_BREAKER_THRESHOLD"), 3),
      breakerCooldownMs: num(get("BM_LLM_BREAKER_COOLDOWN_MS"), 120_000),
      priceInputPer1k: num(get("BM_PRICE_INPUT_PER_1K"), 0.001),
      priceOutputPer1k: num(get("BM_PRICE_OUTPUT_PER_1K"), 0.002),
    },

    retrieval: {
      vectorDriver: str(get("BM_VECTOR_DRIVER"), "memory") === "milvus" ? "milvus" : "memory",
      embedUrl: str(get("BM_EMBED_URL")),
      embedModel: str(get("BM_EMBED_MODEL")),
      // 默认 768：EmbeddingGemma 2 的原生维度。用哈希兜底时该值不参与（哈希固定 256）。
      embedDim: num(get("BM_EMBED_DIM"), 768),
      embedBatchSize: num(get("BM_EMBED_BATCH_SIZE"), 32),
      embedTimeoutMs: num(get("BM_EMBED_TIMEOUT_MS"), 60_000),
      milvusUri: str(get("BM_MILVUS_URI"), "http://127.0.0.1:19530"),
      milvusToken: str(get("BM_MILVUS_TOKEN")),
      milvusCollection: str(get("BM_MILVUS_COLLECTION"), "brandsale_kb"),
      milvusTimeoutMs: num(get("BM_MILVUS_TIMEOUT_MS"), 3_000),
      rerankUrl: str(get("BM_RERANK_URL")),
      rerankModel: str(get("BM_RERANK_MODEL")),
      rerankPoolSize: num(get("BM_RERANK_POOL_SIZE"), 50),
      rerankTimeoutMs: num(get("BM_RERANK_TIMEOUT_MS"), 30_000),
      rerankCooldownMs: num(get("BM_RERANK_COOLDOWN_MS"), 30_000),
    },

    knowledge: {
      summaryIngest: bool(get("BM_SUMMARY_INGEST"), true),
    },

    parser: {
      url: str(get("BM_PARSER_URL")),
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

    mediaCrawler: {
      enabled: bool(get("BM_MC_ENABLED"), false),
      // 去掉结尾斜杠：适配器按 `${baseUrl}${path}` 拼接，双斜杠在某些反代上会 404
      collectorBaseUrl: str(get("BM_MC_COLLECTOR_URL")).replace(/\/+$/, ""),
      timeoutMs: num(get("BM_MC_TIMEOUT_MS"), 15_000),
      cacheTtlSeconds: num(get("BM_MC_CACHE_TTL"), 1_800),
      licenseAcknowledged: bool(get("BM_MC_LICENSE_ACK"), false),
      platforms: parsePlatformList(str(get("BM_MC_PLATFORMS"), MEDIA_CRAWLER_PLATFORMS.join(","))),
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

  /* 平台采集链路的三道门。这里只**提示**、不阻断——collector 可能稍后才起，
   * 但三道门缺任何一道，七个适配器与七个工具都不会注册，必须让人看见为什么。 */
  if (c.mediaCrawler.enabled && !c.mediaCrawler.licenseAcknowledged) {
    problems.push(
      "BM_MC_ENABLED=true 但 BM_MC_LICENSE_ACK 未开启：MediaCrawler 为非商用许可" +
        "（NON-COMMERCIAL LEARNING LICENSE 1.1，条件第 3 条禁止未经书面同意的商业用途），" +
        "在取得版权方书面同意或明确接受该风险之前，七个平台的采集适配器与工具都不会注册",
    );
  }
  if (c.mediaCrawler.enabled && !c.mediaCrawler.collectorBaseUrl) {
    problems.push(
      "BM_MC_ENABLED=true 但 BM_MC_COLLECTOR_URL 为空：采集适配器与平台工具都不会注册。" +
        "先起 collector sidecar（npm run collector），再填入其地址",
    );
  }
  const enabledPlatforms = MEDIA_CRAWLER_PLATFORMS.filter((p) => c.mediaCrawler.platforms[p]);
  if (c.mediaCrawler.enabled && enabledPlatforms.length === 0) {
    problems.push("BM_MC_ENABLED=true 但 BM_MC_PLATFORMS 为空：没有任何平台被启用");
  }
  return problems;
}

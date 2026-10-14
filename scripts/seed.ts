/**
 * 种子数据：让「可运行纵切」一装起来就有东西可跑。
 *
 * 内容对应四库分工与当前的数据现实：
 *   L2 历史执行库（达人 + 报价，这是「私域护城河」的雏形）
 *   KB-3 公开情报（行业趋势、竞品话语，出处标记为 public_intel）
 *   L3 公开源：联网检索 + 七个平台的公开内容采集（全部未经人工核验）
 *   L4 第三方源：**登记但法务未批**，用于验证双重开关被正确拦截
 *
 * 注意：L1 平台源（千川/星图/蒲公英/生意参谋）与合成公开指数（巨量算数）
 * 已从种子与适配器中一并移除，原因见 packages/datasource/src/index.ts 的文件头。
 * 七个平台采集源的**能力装配**另有许可证闸（BM_MC_LICENSE_ACK），见 media-crawler.ts。
 *
 *   tsx scripts/seed.ts
 */

import {
  loadConfig,
  MEDIA_CRAWLER_PLATFORM_META,
  MEDIA_CRAWLER_PLATFORMS,
  type Config,
} from "@brandsale/config";
import { openDb, migrate, Repositories } from "@brandsale/storage";
import { GovernanceGate } from "@brandsale/governance";
import { KnowledgeService, PricingStore } from "@brandsale/knowledge";
import { WEB_SEARCH_SOURCE_ID } from "@brandsale/datasource";
import { createContainer } from "../apps/gateway/src/container.ts";

export const DEMO_TENANT = "tenant_demo";
const ctx = { tenantId: DEMO_TENANT, userId: "u_admin", traceId: "seed", locale: "zh-CN" as const };

const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

/**
 * 内置数据源清单。`seed()` 与 `ensureBuiltinSources()` 共用同一份，
 * 避免两处各写一遍导致「新加的源只出现在空库自举里」。
 */
interface BuiltinSource {
  sourceId: string;
  name: string;
  tier: "L1" | "L2" | "L3" | "L4";
  authMethod?: string;
  contractRef?: string;
  /** 合规布尔量。**故意声明为可选**：漏写要能被 resolveLegalApproved 判成默认拒绝 */
  legalApproved?: boolean;
}

/**
 * 七个平台的公开内容采集源（复用 MediaCrawler，经 apps/collector sidecar）。
 *
 * 全部 L3。三条硬约束照旧：
 *   · **不填 contractRef** —— 与平台之间不存在授权合同，填了就是把"公开采集"
 *     洗成"已授权实测"，governance 的 assertSourceRegistration 会以 E-GOV-005 拦下；
 *   · **legalApproved 显式写 true** —— L3 是公开数据、不需要法务审批，写 true 是明确表态；
 *   · tier 是 L3 而不是 L1 —— 这条链路与平台没有授权关系，标 L1 是造假。
 *
 * 注意：**登记源与"能力是否装配"是两件事**。这七条照常登记进台账，
 * 但对应适配器/工具只有在 `BM_MC_LICENSE_ACK=true` 且 collector 已配置时才装配
 * （MediaCrawler 为非商用许可，见 packages/datasource/src/media-crawler.ts）。
 * 先登记是为了让 resolve_authorization 能如实报出"这些源在台账里、但当前未启用采集能力"。
 */
const MC_SOURCES: BuiltinSource[] = MEDIA_CRAWLER_PLATFORMS.map((p) => {
  const meta = MEDIA_CRAWLER_PLATFORM_META[p];
  return {
    sourceId: meta.sourceId,
    name: `${meta.displayName}公开内容（MediaCrawler 采集）`,
    tier: "L3",
    authMethod: "自托管只读采集（MediaCrawler；与平台无授权合同）",
    legalApproved: true,
  };
});

const BUILTIN_SOURCES: BuiltinSource[] = [
  // 联网检索：公开网页，L3
  { sourceId: WEB_SEARCH_SOURCE_ID, name: "联网搜索（公开网页）", tier: "L3", authMethod: "火山引擎联网搜索 API Key", legalApproved: true },
  // 七个平台公开内容采集：公开、未经人工核验，L3
  ...MC_SOURCES,
  // L4 第三方源：登记但**法务未批**，用于验证双重开关（config.tiers.L4 + 本字段）被正确拦截
  { sourceId: "l4_example_vendor", name: "某第三方数据服务商", tier: "L4", authMethod: "商务合同", contractRef: "合同编号待法务确认", legalApproved: false },
];

/** 各内置源的授权有效期（天）。故意不含负数样本——过期样本由 grantAuthz 之后的流程另行构造 */
const BUILTIN_GRANTS: { sourceId: string; days: number }[] = [
  { sourceId: WEB_SEARCH_SOURCE_ID, days: 365 },
  ...MEDIA_CRAWLER_PLATFORMS.map((p) => ({ sourceId: MEDIA_CRAWLER_PLATFORM_META[p].sourceId, days: 365 })),
];

/**
 * tier → 台账 sourceType 的映射。
 * 用映射表而非嵌套三元：将来加回 L1 平台源时只需在 BUILTIN_SOURCES 加条目，这里不用动。
 */
const SOURCE_TYPE_BY_TIER: Record<string, string> = {
  L1: "l1_platform",
  L2: "l2_execution",
  L3: "l3_public",
  L4: "l4_purchased",
};

/**
 * 解析台账条目的 legalApproved。
 *
 * **合规布尔量不设"默认值"，只设"默认拒绝"。** 早先这里写的是
 * `"legalApproved" in s ? Boolean(s.legalApproved) : true` —— 即"漏写 = 法务已批准"。
 * 后果：将来往 BUILTIN_SOURCES 加一条 L4 源、忘记写 legalApproved，它就会静默变成
 * 已批准的采购数据源，而 legalApproved 正是 L4 双重开关（config.tiers.L4 + 本字段）的一半。
 *
 * 本项目其余合规开关一律 fail-closed（BM_GATE_FAIL_CLOSED 要求显式开、
 * BM_TOOLS_ALLOW_MUTATING / BM_KB_ALLOW_GLOBAL_WRITE / BM_L4_ENABLED 默认 false），
 * 这里必须同向。
 *
 * L4 单独**直接报错**而不是取 false：L4 的登记是商务动作，漏写字段说明写错了意图，
 * 让它在 seed 期炸掉比让它带着 false 悄悄写进台账更容易被发现。
 * （L1/L2 漏写不必在这里重复拦：registerSource 的 assertSourceRegistration
 *   会以 E-GOV-005 拒绝"缺 legalApproved 的 L1/L2"，那是更准确的错误码。）
 *
 * 参数刻意声明为可选字段的结构类型，而不是 `(typeof BUILTIN_SOURCES)[number]`：
 * 后者在**所有**条目都写了该字段之后，`!("legalApproved" in s)` 会被收窄成 `never`，
 * 编译期就把这条防线删掉了。这里的判断要针对"将来某个条目漏写"，
 * 所以类型必须允许漏写。
 *
 * 导出是为了可单测：这条防线只在"将来有人加条目漏写字段"时才起作用，
 * 靠代码审查守不住（它现在看起来毫无影响），必须用测试钉住。
 */
export function resolveLegalApproved(s: { sourceId: string; tier: string; legalApproved?: boolean }): boolean {
  if (s.legalApproved === undefined) {
    if (s.tier === "L4") {
      throw new Error(
        `L4 来源 ${s.sourceId} 必须显式声明 legalApproved：合规标志不得依赖默认值` +
          `（漏写会静默变成"法务已批准"）。`,
      );
    }
    return false;
  }
  return s.legalApproved;
}

export async function seed(): Promise<{ chunks: number; talents: number }> {
  const config = loadConfig();
  const db = openDb(config.storage.sqlitePath);
  migrate(db);
  const repos = new Repositories(db);
  const gate = new GovernanceGate({ repos, config });
  const knowledge = new KnowledgeService(db, config);
  const pricing = new PricingStore(db);

  /* ── 1. 数据源登记 ─────────────────────────────────────── */

  const sources = BUILTIN_SOURCES;

  for (const s of sources) {
    await gate.registerSource(
      {
        sourceId: s.sourceId,
        tenantId: DEMO_TENANT,
        name: s.name,
        tier: s.tier as never,
        sourceType: SOURCE_TYPE_BY_TIER[s.tier] as never,
        owner: "品牌方市场部",
        ...("authMethod" in s && s.authMethod ? { authMethod: s.authMethod } : {}),
        ...("contractRef" in s && s.contractRef ? { contractRef: s.contractRef } : {}),
        legalApproved: resolveLegalApproved(s),
        registeredBy: ctx.userId,
        registeredAt: new Date().toISOString(),
      },
      ctx,
    );
  }

  /* ── 2. 授权 ───────────────────────────────────────────── */

  const grants = BUILTIN_GRANTS;
  for (const g of grants) {
    const from = new Date();
    const to = new Date(Date.now() + g.days * 86_400_000);
    await gate.grantAuthz(
      { tenantId: DEMO_TENANT, sourceId: g.sourceId, grantedBy: "品牌方市场部", validFrom: from.toISOString(), validTo: to.toISOString(), scopes: ["read", "aggregate"] },
      ctx,
    );
  }

  /* ── 3. L3 公开情报 ────────────────────────────────────── */

  const kb3 = [
    { t: "2026 年 Q2 精华类目趋势：抗老胜肽与玻色因复配成为主流叙事，「早C晚A」进入收缩期。", s: "行业季报", n: 3 },
    { t: "精华类目大促峰值集中在 618 前两周与双 11 首波，声量峰值通常领先销量峰值 7–10 天。", s: "行业季报", n: 5 },
    { t: "竞品X 以「专利肽浓度」为核心话术，竞品Y 走平价平替路线，两者在 25–34 岁女性人群重叠度约 41%。", s: "公开指数分析", n: 6 },
    { t: "美妆类目达人报价在近一年整体上浮 12%–18%，头部达人刊例价与实际成交价平均折扣为 0.78。", s: "行业报告", n: 4 },
    { t: "广告法对「功效宣称」口径趋严，抗老类内容需避免疗效承诺表述，建议使用「改善外观」等合规措辞。", s: "法规解读", n: 2 },
  ];

  /* ── 4. L2 历史执行与私域知识 ──────────────────────────── */

  const kb2 = [
    { t: "2025 年双 11 复盘：达人种草占比 45% 时 ROI 最优（2.3），超过 60% 后边际递减明显。", s: "内部复盘", n: 1 },
    { t: "成分讲解型达人的精华类目转化率平均比颜值型达人高 34%，但声量扩散慢 20%。", s: "内部复盘", n: 1 },
    { t: "与达人签约时按成交价而非刊例价，并设置阶梯对赌，可将实际成本压到刊例的 0.72–0.8。", s: "商务经验", n: 1 },
    { t: "搜索承接页必须在达人内容上线前 3 天完成，否则流量溢出会流向竞品。", s: "投放 SOP", n: 1 },
    { t: "小红书笔记的收藏率是搜索型转化的领先指标，收藏率 > 3.5% 的笔记后续 30 天转化显著更好。", s: "内部复盘", n: 1 },
  ];

  /* ── 5. KB-4 方法论/模板 ───────────────────────────────── */

  const kb4 = [
    { t: "三段式打法模板：预热期建立类目话语权（预算 20%）→ 爆发期集中投放（60%）→ 长尾期搜索承接（20%）。", s: "方法论库", n: 1 },
    { t: "报告首屏必须包含数据来源声明与排除项，未使用的数据源必须写明原因。", s: "方法论库", n: 1 },
    { t: "低置信度结论必须同页出现风险提示，且不得使用肯定语气。", s: "方法论库", n: 1 },
  ];

  const mk = (arr: { t: string; s: string; n: number }[], collection: string, sourceId: string, sourceType: string, tier: string, ageDays: number) =>
    arr.map((x, i) => ({
      chunkId: `${collection}_${i + 1}`,
      docId: `${collection}_doc_${Math.floor(i / 5) + 1}`,
      collection: collection as never,
      tenantId: collection === "KB-2" ? DEMO_TENANT : "",
      text: x.t,
      sourceId,
      sourceType: sourceType as never,
      tier: tier as never,
      sampleSize: x.n,
      publishedAt: daysAgo(ageDays),
      humanVerified: collection !== "KB-3",
      // 同达人样例：这些语料是**演示文案**，不是任何客户的真实复盘/方法论，一律标 demo
      provenance: "demo" as const,
      meta: { origin: x.s },
    }));

  const ingest = await knowledge.ingest(
    [
      ...mk(kb3, "KB-3", "public_intel", "l3_public", "L3", 20),
      ...mk(kb2, "KB-2", "internal_review", "l2_execution", "L2", 60),
      ...mk(kb4, "KB-4", "methodology", "human_verified", "L2", 90),
    ],
    ctx,
  );

  /* ── 6. 达人 + 报价（L2 私域库） ───────────────────────── */

  const talents = [
    { talentId: "t_1001", platform: "douyin", nickname: "护肤成分实验室", category: "美妆护肤", followers: 1_280_000, engagementRate: 4.2, quote: 236_000, actual: 185_000 },
    { talentId: "t_1002", platform: "xiaohongshu", nickname: "三十岁护肤日记", category: "美妆护肤", followers: 460_000, engagementRate: 6.1, quote: 78_000, actual: 62_000 },
    { talentId: "t_1003", platform: "douyin", nickname: "皮肤科医生老王", category: "美妆护肤", followers: 2_150_000, engagementRate: 2.8, quote: 420_000, actual: 330_000 },
    { talentId: "t_1004", platform: "xiaohongshu", nickname: "成分党小圆", category: "美妆护肤", followers: 168_000, engagementRate: 7.4, quote: 26_000, actual: 19_500 },
    { talentId: "t_1005", platform: "douyin", nickname: "精致阿姨的梳妆台", category: "美妆护肤", followers: 890_000, engagementRate: 5.3, quote: 158_000, actual: 121_000 },
  ];

  for (const t of talents) {
    /* ⚠️ 全部标 `provenance: "demo"`，这不是可选项。
     *
     * 这 5 位达人与报价是**样例**（昵称、粉丝量、刊例价、成交价都是编的），
     * 表里也没有平台账号 ID。业主看到报告后去平台搜索这些昵称，一个都搜不到 ——
     * 若它们以"真实数据"的身份进入报告，整份报告的可信度都会被质疑。
     * 打上 demo 之后，读取侧（PricingStore，默认 `allowDemoData=false`）会把它们
     * 挡在检索之外：报告只会说「无 L2 报价样本」，而不是给出编造的报价。
     * 开发/自动化测试需要它们时，显式加 `BM_ALLOW_DEMO_DATA=true`。 */
    await pricing.upsertTalent({ talentId: t.talentId, platform: t.platform as never, nickname: t.nickname, category: t.category, followers: t.followers, engagementRate: t.engagementRate, provenance: "demo" });
    await pricing.addPricing({ recordId: `prc_${t.talentId}_1`, talentId: t.talentId, quoted: { currency: "CNY", amount: t.quote }, actual: { currency: "CNY", amount: t.actual }, sourceType: "l2_execution", observedAt: daysAgo(45), humanVerified: true, provenance: "demo" });
    await pricing.addPricing({ recordId: `prc_${t.talentId}_2`, talentId: t.talentId, quoted: { currency: "CNY", amount: Math.round(t.quote * 1.08) }, sourceType: "l3_public", observedAt: daysAgo(120), humanVerified: false, provenance: "demo" });
  }

  db.close();
  return { chunks: ingest.ingested, talents: talents.length };
}

/**
 * 开发态自举：只在**空库**时灌种子。
 * 目的：`npm start` 在干净机器上也能直接跑通全链路，而不是所有阶段
 * 都因为「没有登记数据源 / 没有达人库」而静默降级成 partial。
 * 已有数据则一律跳过，绝不覆盖本地改动。
 */
export async function seedIfEmpty(): Promise<{ seeded: boolean; chunks: number; talents: number }> {
  const config = loadConfig();
  const db = openDb(config.storage.sqlitePath);
  migrate(db);
  const repos = new Repositories(db);
  const empty = repos.sources.list(DEMO_TENANT).length === 0;
  db.close();
  if (!empty) return { seeded: false, chunks: 0, talents: 0 };
  const out = await seed();
  return { seeded: true, ...out };
}

/**
 * 幂等补齐内置数据源的登记与授权。
 *
 * 为什么需要它（这是个真实的坑）：
 *   `seedIfEmpty()` 只在**空库**时灌种子。而联网检索是后加的能力——
 *   已经在跑的库（./.data、./.data-live）不会因为重启就多出这条源。
 *   结果是 `web_search` 每次调用都在闸门的 source 检查上被拦下（E-GOV-001
 *   「数据源未在台账登记」），工具一直降级，而代码看起来完全正确。
 *
 * 语义：只补缺，不覆盖。已登记的源与生效中的授权原样保留，
 * 因此对人工改过的租户配置没有副作用。返回本次实际补了哪些项，便于启动日志核对。
 *
 * 参数：必须传入**与容器同一份** config。早先的实现内部自己 `loadConfig()`，
 * 于是当调用方用 BM_DATA_DIR 指到别的库（如 ./.data-live）时，
 * 补齐动作落在了默认库上——工具照样被 E-GOV-001 拦下，排查起来非常反直觉。
 */
export async function ensureBuiltinSources(config: Config = loadConfig()): Promise<string[]> {
  const db = openDb(config.storage.sqlitePath);
  migrate(db);
  const repos = new Repositories(db);
  const gate = new GovernanceGate({ repos, config });
  const added: string[] = [];
  try {
    for (const s of BUILTIN_SOURCES) {
      if (!repos.sources.get(DEMO_TENANT, s.sourceId)) {
        await gate.registerSource(
          {
            sourceId: s.sourceId,
            tenantId: DEMO_TENANT,
            name: s.name,
            tier: s.tier as never,
            sourceType: SOURCE_TYPE_BY_TIER[s.tier] as never,
            owner: "品牌方市场部",
            ...("authMethod" in s && s.authMethod ? { authMethod: s.authMethod } : {}),
            ...("contractRef" in s && s.contractRef ? { contractRef: s.contractRef } : {}),
            legalApproved: resolveLegalApproved(s),
            registeredBy: ctx.userId,
            registeredAt: new Date().toISOString(),
          },
          ctx,
        );
        added.push(`源登记 ${s.sourceId}`);
      }
      const grant = BUILTIN_GRANTS.find((g) => g.sourceId === s.sourceId);
      if (grant && !repos.authz.active(DEMO_TENANT, s.sourceId)) {
        const now = Date.now();
        await gate.grantAuthz(
          {
            tenantId: DEMO_TENANT,
            sourceId: s.sourceId,
            grantedBy: "品牌方市场部（自动补齐）",
            validFrom: new Date(now).toISOString(),
            validTo: new Date(now + grant.days * 86_400_000).toISOString(),
            scopes: ["read", "aggregate"],
          },
          ctx,
        );
        added.push(`授权 ${s.sourceId}`);
      }
    }
  } finally {
    db.close();
  }
  return added;
}

if (process.argv[1]?.endsWith("seed.ts")) {
  void (async () => {
    const container = createContainer();
    void container;
    const out = await seed();
    console.log(`[seed] 完成：知识库 ${out.chunks} 条、达人 ${out.talents} 位（含 1 个未能入库的样本用于验证回灌不变量）`);
    process.exit(0);
  })();
}

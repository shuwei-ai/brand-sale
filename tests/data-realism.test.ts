/**
 * 数据真实性（业主明确要求：**不要引用本地样例数据，只要真实数据**）。
 *
 * 这一层守三件在结构上成立的事：
 *   1. 演示样例（seed 的样例达人/报价/语料）默认**读不到** —— 不管谁往库里灌，
 *      报告都不可能引用它（闸门在读取侧，不是"约定不要用"）；
 *   2. 人选可以来自**本任务真实采集回来的平台账号**，且没有的字段（粉丝量/报价）
 *      如实留空，绝不用任何来源的数字去填；
 *   3. 模型编出来的达人（真实数据源里对不上）会被**机械剔除**，不是警告。
 *
 * 运行：npm test（全离线）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@brandsale/config";
import { openDb, migrate, Repositories } from "@brandsale/storage";
import { KnowledgeService, PricingStore } from "@brandsale/knowledge";
import { seed } from "../scripts/seed.ts";
import { LOGICAL_REFS, type SourceCatalog } from "@brandsale/contracts";
import {
  aggregatePlatformAccounts,
  creatorAccountRows,
  ensurePlatformCreators,
  PLATFORM_CREATOR_LIMIT,
  PLACEHOLDER_CREATOR_PREFIX,
  platformCandidateId,
  platformCreatorCandidates,
  pruneUnverifiableCreators,
  synthCreators,
  synthReport,
  toEvidenceEntries,
  type CreatorOutput,
} from "@brandsale/agent-pack";

/* ── fixtures ───────────────────────────────────────────── */

const mkRows = (author: string, platform: string, platformName: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    platform,
    platformName,
    id: `${platform}_${author}_${i}`,
    title: `${author} 的代表作品 ${i}`,
    text: "正文内容",
    author,
    url: `https://example.com/${platform}/${i}`,
    publishedAt: "2026-05-02T10:00:00Z",
    metrics: { likes: 100 * (n - i) },
  }));

const ROWS = [
  ...mkRows("长草的菜菜", "xhs", "小红书", 3),
  ...mkRows("太阳花主理人", "xhs", "小红书", 1),
  ...mkRows("雪梨梨666", "ks", "快手", 2),
];

const entries = toEvidenceEntries(ROWS, { op: "search", collectedAt: "2026-05-20T08:00:00Z" });

/** 只读 env 的临时容器：`demo` 决定是否放行演示样例 */
async function freshDb(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-realism-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", ...env });
  const db = openDb(config.storage.sqlitePath);
  migrate(db);
  return { dir, config, db };
}

/**
 * 在临时库上跑一次 seed。
 *
 * `seed()` 自己 `loadConfig()` 读进程 env（它同时被 `npm run seed` 用），
 * 所以要**临时**把 BM_DATA_DIR 指到临时目录，否则样例会灌进真实开发库。
 */
async function seedInto(dir: string) {
  const before = process.env["BM_DATA_DIR"];
  process.env["BM_DATA_DIR"] = dir;
  try {
    return await seed();
  } finally {
    if (before === undefined) delete process.env["BM_DATA_DIR"];
    else process.env["BM_DATA_DIR"] = before;
  }
}

/* ── ① 演示样例默认读不到 ───────────────────────────────── */

test("演示样例（seed 的样例达人/报价）默认不可见，打开 BM_ALLOW_DEMO_DATA 才可见", async () => {
  const { dir, config, db } = await freshDb({ BM_ALLOW_DEMO_DATA: "false" });
  try {
    // seed 往库里灌样例（达人 + 报价 + 语料），全程标 provenance='demo'
    const seeded = await seedInto(dir);
    assert.ok(seeded.talents > 0, "seed 仍然写入样例数据（供演示与离线测试用）");
    const v = db.get<{ c: number }>("SELECT COUNT(*) c FROM talents WHERE provenance = 'demo'");
    assert.equal(v?.c, seeded.talents, "seed 写入的达人必须全部标记为 demo");
    const pr = db.get<{ c: number }>("SELECT COUNT(*) c FROM pricing WHERE provenance = 'demo'");
    assert.equal(pr?.c, seeded.talents * 2, "样例报价同样要标 demo（两者的标记缺一不可）");

    // 关掉开关：查询/估价都拿不到样例
    const off = new PricingStore(db, { allowDemo: false });
    assert.deepEqual(await off.query({ topK: 10 }), [], "默认配置下样例达人不得出现在候选人里");
    assert.equal(await off.estimate("t_1003", "tenant_demo"), null, "样例达人不得被估价（否则报告会写出一份编造的报价）");

    // 打开开关：演示/离线测试仍能拿到（否则 mock 全链路没有数据可跑）
    const on = new PricingStore(db, { allowDemo: true });
    const rows = await on.query({ topK: 10 });
    assert.ok(rows.length > 0, "显式允许时样例数据可见");
    assert.ok(rows.every((r) => r.provenance === "demo"), "可见的样例达人必须自报 provenance=demo");
    assert.ok(await on.estimate("t_1003", "tenant_demo"), "显式允许时样例报价可用");

    // 配置项确实接上了：不设环境变量时默认 false（生产默认值）
    const beforeEnv = process.env["BM_ALLOW_DEMO_DATA"];
    delete process.env["BM_ALLOW_DEMO_DATA"];
    try {
      assert.equal(loadConfig(process.cwd(), { BM_DATA_DIR: dir }).allowDemoData, false, "allowDemoData 默认必须是 false");
    } finally {
      if (beforeEnv !== undefined) process.env["BM_ALLOW_DEMO_DATA"] = beforeEnv;
    }
    assert.equal(loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_ALLOW_DEMO_DATA: "false" }).allowDemoData, false);
    assert.equal(config.allowDemoData, false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("演示语料默认不参与检索：KB 检索与来源目录都不含 demo 语料", async () => {
  const { dir, db, config } = await freshDb({ BM_ALLOW_DEMO_DATA: "false" });
  try {
    await seedInto(dir);
    const off = new KnowledgeService(db, config);
    const hits = await off.retrieve({ tenantId: "tenant_demo", text: "达人种草占比 45% ROI 最优" });
    assert.equal(hits.hits.length, 0, "演示语料不得被检索到（否则报告会把它当真实复盘引用）");
    assert.deepEqual(off.sourceIds("tenant_demo"), [], "没有真实语料时，来源目录也不该声明内部语料源");

    const on = new KnowledgeService(db, loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_ALLOW_DEMO_DATA: "true" }));
    const hitsOn = await on.retrieve({ tenantId: "tenant_demo", text: "达人种草占比 45% ROI 最优" });
    assert.ok(hitsOn.hits.length > 0, "显式允许时演示语料可用于离线测试");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── ② 真实采集账号作为人选池 ───────────────────────────── */

test("platformCreatorCandidates：只用人选真实字段，粉丝量与报价留空、不编造", () => {
  const cands = platformCreatorCandidates(entries, { category: "美妆护肤", platforms: ["xiaohongshu"] });
  assert.ok(cands.length >= 3, "三个真实账号都该成为候选人");

  const top = cands.find((c) => c.nickname === "长草的菜菜")!;
  assert.ok(top, "真实采集到的作者必须出现");
  assert.equal(top.talentId, platformCandidateId("xhs", "长草的菜菜"), "id 必须由（平台+昵称）确定性推导，报告才能反查到原帖");
  assert.equal(top.followers, 0, "粉丝量没采到就写 0 —— 决不用互动量倒推或凭经验填");
  assert.equal(top.estimatedCost, 0, "没有 L2 报价样本就不估成本");
  assert.deepEqual(top.costRange, { low: 0, high: 0 });
  assert.ok(top.rationale.includes("未采集"), "必须在 rationale 里写明哪些字段没采到");
  assert.ok(top.rationale.includes("https://example.com/xhs/0"), "必须给出可核对的原帖链接");
  assert.ok(/分层依据为同平台互动量分位/.test(top.contentFit), "分层口径必须自证（不是粉丝量分层）");

  // 分层：同平台内按互动量分位，且口径必须自证（不是粉丝量分层）；
  // 样本太少时某一层可能天然没人 —— 由 fillCreatorTiers 补「暂无人选」占位，
  // 而不是把别人的层级改掉（见下面 synthCreators 的断言）。
  const xhs = cands.filter((c) => c.platform === "小红书");
  assert.equal(xhs[0]!.tier, "head", "小红书内互动量最高的账号应落在头部（分位口径）");
  assert.equal(xhs[xhs.length - 1]!.tier, "tail", "同平台互动量最低的账号应落在尾部");
  const viaSynth = synthCreators({ platforms: ["xiaohongshu"], category: "美妆护肤" }, { pricing_query: { candidates: [] }, platform_creators: { candidates: cands } });
  const tiers = new Set(viaSynth.candidates.map((c) => c.tier));
  assert.ok(tiers.has("head") && tiers.has("mid") && tiers.has("tail"), `三层都要有人选（缺层要用占位补齐），实际：${[...tiers].join("/")}`);

  // 无作者 / 无 id 的条目不得造出账号
  const noAuthor = toEvidenceEntries([{ platform: "xhs", id: "1", title: "t", text: "x", author: "" }]);
  assert.deepEqual(platformCreatorCandidates(noAuthor, {}), [], "采集不到作者的条目不得变成候选人");
});

test("synthCreators：本地报价库无真实样本时，人选取自真实采集账号而不是编造", () => {
  const platformCands = platformCreatorCandidates(entries, { category: "美妆护肤" });
  const out = synthCreators(
    { platforms: ["xiaohongshu"], category: "美妆护肤" },
    { pricing_query: { candidates: [] }, platform_creators: { candidates: platformCands } },
  );
  assert.ok(out.candidates.some((c) => c.nickname === "长草的菜菜"), "有真实采集账号时，人选必须用它");
  assert.ok(
    out.candidates.every((c) => c.followers === 0 && c.estimatedCost === 0),
    "平台人选的成本/粉丝量一律留空，不得填数字",
  );
  assert.ok(
    out.excluded.some((e) => e.reason.includes("演示样例数据")),
    "排除项必须写明演示样例被排除（读者才知道'为什么没有报价'）",
  );

  // 两条真实来源都没有 → 只给「无数据」占位，不给编造人选
  const empty = synthCreators({ platforms: ["xiaohongshu"], category: "美妆护肤" }, { pricing_query: { candidates: [] } });
  assert.ok(
    empty.candidates.every((c) => c.talentId.startsWith(PLACEHOLDER_CREATOR_PREFIX)),
    "没有真实数据时只允许占位条目",
  );
  assert.ok(empty.candidates.some((c) => c.riskFlags.some((f) => f.includes("禁止编造人选"))));
});

/* ── ③ 模型编的人选会被剔除 ─────────────────────────────── */

const mkCandidate = (over: Partial<CreatorOutput["candidates"][number]> = {}): CreatorOutput["candidates"][number] => ({
  talentId: "t_9999",
  nickname: "编造出来的达人",
  platform: "douyin",
  followers: 999_999,
  category: "美妆护肤",
  matchScore: 0.9,
  rationale: "看着挺合适",
  estimatedCost: 200_000,
  costRange: { low: 150_000, high: 250_000 },
  riskFlags: [],
  tier: "head",
  contentFit: "无样本",
  historicalPerformance: "无样本",
  confidence: 0.8,
  ...over,
});

test("pruneUnverifiableCreators：编造人选被剔除，真实账号与占位保留，剔空后自动补层", () => {
  const real = entries.find((e) => e.author === "长草的菜菜")!;
  const value: CreatorOutput = {
    candidates: [
      mkCandidate(), // 编的
      mkCandidate({ talentId: "t_1003", nickname: "客户录入的真实达人", platform: "douyin" }), // 报价库里有
      mkCandidate({ talentId: platformCandidateId("xhs", "长草的菜菜"), nickname: "长草的菜菜", platform: "小红书" }), // 采集来的
      mkCandidate({ talentId: `${PLACEHOLDER_CREATOR_PREFIX}mid`, nickname: "腰部暂无人选", tier: "mid" }),
    ],
    excluded: [],
    citations: [],
  };

  const { value: pruned, dropped } = pruneUnverifiableCreators(value, { talentIds: ["t_1003"], accounts: aggregatePlatformAccounts(entries) });
  const ids = pruned.candidates.map((c) => c.talentId);
  assert.ok(!ids.includes("t_9999"), "编造的人选必须被剔除");
  assert.ok(ids.includes("t_1003"), "报价库里真实的达人要保留");
  assert.ok(ids.includes(platformCandidateId("xhs", "长草的菜菜")), "真实采集到的账号要保留");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.reason, /无法在真实数据源中溯源/);
  assert.ok(pruned.excluded.some((e) => e.reason.includes("禁止编造达人")), "剔除要落进 excluded，报告要如实说明");

  // 剔空某一层时必须补层，否则报告人选页会缺层
  const tiers = new Set(pruned.candidates.map((c) => c.tier));
  assert.ok(tiers.has("head") && tiers.has("mid") && tiers.has("tail"), "剔除后仍必须三层齐全");

  // 全被剔空 → 只留占位，不留下编造遗留
  const allFake = pruneUnverifiableCreators({ ...value, candidates: [mkCandidate()] }, { talentIds: ["t_1003"], accounts: [] });
  assert.ok(allFake.value.candidates.every((c) => c.talentId.startsWith(PLACEHOLDER_CREATOR_PREFIX)));
  assert.equal(allFake.dropped.length, 1);
});

test("pruneUnverifiableCreators：真实数据源为空时不误删（闸门缺输入不做全拦）", () => {
  const value: CreatorOutput = { candidates: [mkCandidate({ talentId: "t_1003" })], excluded: [], citations: [] };
  const { value: out, dropped } = pruneUnverifiableCreators(value, {});
  assert.equal(dropped.length, 0);
  assert.equal(out.candidates[0]!.talentId, "t_1003", "没有可比对的真实数据时不得凭空剔除");
});

/* ── ③b 数据在手就必须进报告（模型没用平台账号池时机械补入） ────────
 *
 * 实测事故：本次六个平台采回几百条、几十个真实账号，模型却在
 * 「kb_retrieve 返回 0 条、pricing_query 返回 0 个候选人」之后直接写下
 * 「【严重数据缺失】此条目为占位符」并造出三条 `待确认头部达人`。
 * 于是最荒诞的结果出现了：数据在手，报告的人选页一条真账号都没有。
 * 剔除（prune）只解决"编造"，解决不了"无视"。这里补上后者。
 */
test("ensurePlatformCreators：模型没用平台账号池时，真实采集账号必须被机械补进人选", () => {
  const pool = platformCreatorCandidates(entries, { category: "美妆护肤" });
  // 模型交上来的全是不带平台账号的占位/编造结果
  const value: CreatorOutput = {
    candidates: [mkCandidate({ talentId: `${PLACEHOLDER_CREATOR_PREFIX}head`, nickname: "头部暂无人选", tier: "head" })],
    excluded: [],
    citations: [],
  };
  const { value: out, injected } = ensurePlatformCreators(value, pool);
  assert.ok(injected > 0, "池子里有真实账号时必须补入");
  assert.ok(
    out.candidates.some((c) => c.talentId === platformCandidateId("xhs", "长草的菜菜")),
    "补入的必须是真实采集到的账号（id 由平台+昵称确定性推导）",
  );
  assert.ok(
    !out.candidates.some((c) => c.talentId === `${PLACEHOLDER_CREATOR_PREFIX}head`),
    "补入的账号占了 head 层，该层的「暂无人选」占位要让位（没有真实账号的层仍保留占位）",
  );
  assert.ok(
    out.candidates.filter((c) => c.talentId.startsWith("pfcre_")).every((c) => c.followers === 0 && c.estimatedCost === 0),
    "补入的账号没有粉丝量与报价，必须留空而不是填数字",
  );
  assert.ok(
    out.excluded.some((e) => e.reason.includes("由系统按采集结果机械补入")),
    "补入这件事必须写进 excluded，读者才知道这几条不是模型选的",
  );
  const tiers = new Set(out.candidates.map((c) => c.tier));
  assert.ok(tiers.has("head") && tiers.has("mid") && tiers.has("tail"), "补入后仍必须三层齐全");

  // 模型已经用了平台账号 → 尊重它的选择，不叠加
  const used: CreatorOutput = {
    candidates: [mkCandidate({ talentId: platformCandidateId("xhs", "长草的菜菜"), nickname: "长草的菜菜", platform: "小红书" })],
    excluded: [],
    citations: [],
  };
  assert.equal(ensurePlatformCreators(used, pool).injected, 0, "模型已给出平台账号时不再叠加");

  // 池子为空 → 什么都不做（不能在没数据时造账号）
  assert.equal(ensurePlatformCreators(value, []).injected, 0);
});

/* ── ④ 上限与聚合 ───────────────────────────────────────── */

test("aggregatePlatformAccounts：按平台×作者聚合、无作者丢弃、代表原帖取首条", () => {
  const aggs = aggregatePlatformAccounts(entries);
  assert.equal(aggs.length, 3);
  const xhs = aggs.filter((a) => a.platform === "xhs");
  assert.equal(xhs.length, 2, "同名作者按（平台+昵称）聚合，不同作者分开");
  const top = aggs.find((a) => a.author === "长草的菜菜")!;
  assert.equal(top.entryIds.length, 3);
  assert.equal(top.sampleUrl, "https://example.com/xhs/0");
  assert.ok(top.observedInteractions > 0, "互动量取真实指标，用于同平台内相对排序");

  // 候选人上限：避免一张表被某个平台刷满
  const many = toEvidenceEntries(
    Array.from({ length: 40 }, (_, i) => ({ platform: "xhs", platformName: "小红书", id: `m${i}`, title: `t${i}`, text: "x", author: `作者${i}`, url: `https://e.com/${i}`, metrics: { likes: 10 } })),
  );
  assert.equal(platformCreatorCandidates(many, {}).length, PLATFORM_CREATOR_LIMIT, "候选人数量必须有上限");
});

/* ── ⑤ 报告里人选页的呈现（真实量纲，不画假分布） ───────── */

test("报告人选页：来源列标出真实出处，散点图用采集条目数而不是压平的粉丝量", () => {
  const platformCands = platformCreatorCandidates(entries, { category: "美妆护肤" });
  const creator = synthCreators({ platforms: ["xiaohongshu"], category: "美妆护肤" }, { pricing_query: { candidates: [] }, platform_creators: { candidates: platformCands } });
  const catalog: SourceCatalog = {
    entries: [
      { key: "mc_xhs", displayName: "小红书", grade: "L3", origin: "external", coverage: "公开采集，未人工核验", asOf: "2026-05-20" },
      { key: "mc_ks", displayName: "快手", grade: "L3", origin: "external", coverage: "公开采集，未人工核验", asOf: "2026-05-20" },
    ],
    logicalRefs: [...LOGICAL_REFS],
    evidenceEntries: entries,
  };
  const dsl = synthReport(
    { brandIds: ["brand_A"], category: "美妆护肤", window: { from: "2026-05-20", to: "2026-06-20" }, budget: { amount: 3_000_000 } } as never,
    { intel: { competitors: [], categoryInsights: { trends: [], audience: [], seasonality: [], pricingBand: [], channelMix: [] }, dataGaps: [], citations: [], evidences: [], brandSelf: { positioning: { statement: "s", differentiators: [] }, contentAssets: [], reputation: { sentiment: "unknown", themes: [] }, gaps: [], citations: [] } } as never, creator },
    { synthesized: false, catalog },
  );

  const page = dsl.slides.find((s) => s.title.includes("人选"))!;
  const table = page.blocks.find((b) => b.type === "table")!;
  const text = JSON.stringify(table);
  assert.ok(text.includes("平台公开采集（L3，未核验）"), "来源列必须标出真实出处");
  assert.ok(text.includes("https://example.com/xhs/0"), "必须有可点开核对的原帖链接");
  assert.ok(text.includes("未采集"), "粉丝量没采到就写「未采集」，不能写 0 冒充实测");
  assert.ok(text.includes("无样本"), "没有报价样本时写「无样本」，不能写 0 元");

  const matrix = page.blocks.find((b) => b.type === "matrix");
  assert.ok(matrix, "没有人选可视化时深度下限会不达标");
  assert.ok(matrix!.xLabel.includes("互动量分位"), "粉丝量缺失时，散点轴必须换成真实量纲并标注口径");
  assert.equal(matrix!.yLabel, "采集到的条目数");
  assert.ok(matrix!.cells.every((c: { y: number }) => c.y > 0), "纵轴必须是真实条目数，不能全 0（那是假分布）");
});

/* ── ⑥ 表结构 ───────────────────────────────────────────── */

test("迁移幂等：重复 migrate 不失败", async () => {
  const { dir, db } = await freshDb({ BM_ALLOW_DEMO_DATA: "false" });
  try {
    // 模拟"迁移前就已经灌了样例数据"的存量库：手工插一行，再回填
    db.run(
      "INSERT OR REPLACE INTO talents (talent_id, platform, nickname, category, followers, engagement_rate, updated_at, provenance) VALUES ('t_1001','douyin','样例达人','美妆',1000,1,'x','unknown')",
    );
    const second = migrate(db);
    assert.deepEqual(second.applied, [], "迁移必须幂等（第二次不重复执行）");
    const kinds = new Repositories(db);
    void kinds;
    const row = db.get<{ provenance: string }>("SELECT provenance FROM talents WHERE talent_id = 't_1001'");
    assert.equal(row?.provenance, "unknown", "已标记过的行不会再被改写（迁移里的回填只跑一次）");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 真实粉丝量：个人主页资料行进人选表 ────────────────────────────
 *
 * 起因（业主实测追问）："这个个人主页账号的个人主页都有啊，为什么拿不到粉丝数据？"
 * 平台的内容行（搜索结果）里**不带**作者粉丝数 —— 小红书只在个人主页的 `data-info`
 * （`/user/profile/<id>` 的 `interactions[type=fans]`）、抖音只在
 * `/aweme/v1/web/user/profile/other/` 里。所以 collector 在搜索完成后自动补采一次
 * 主页资料，落成 `op=creator` 的证据条目（`metrics.followers`），这里验证：
 *   · 资料行与内容行**按作者合并**，但只贡献账号级字段；
 *   · 资料行不算"条目数"、不计互动量（否则 12 条内容会变成 13 条）；
 *   · 粉丝量真实进人选表，并按同一把尺子（tierOf）分层。
 */
const PROFILE_ROWS = [
  { platform: "xhs", platformName: "小红书", id: "creator_hash_1", author: "长草的菜菜", url: "https://www.xiaohongshu.com/user/profile/u1", metrics: { followers: 2373, follows: 31 } },
];
const profileEntries = toEvidenceEntries(PROFILE_ROWS, { op: "creator", collectedAt: "2026-05-20T08:05:00Z" });
const withProfiles = [...entries, ...profileEntries];

test("个人主页资料行：与内容行合并出账号视图，且不虚增条目数、不混入互动量", () => {
  const before = aggregatePlatformAccounts(entries).find((a) => a.author === "长草的菜菜")!;
  const after = aggregatePlatformAccounts(withProfiles).find((a) => a.author === "长草的菜菜")!;

  assert.equal(after.entryIds.length, before.entryIds.length, "资料行不是一条'内容条目'");
  assert.equal(after.contentCount, before.contentCount, "内容条数不能被资料行虚增");
  assert.equal(after.observedInteractions, before.observedInteractions, "粉丝量不是内容互动量，不得计入");
  assert.equal(after.followers, 2373, "粉丝量要真的落到账号视图上");
  assert.equal(after.profileUrl, "https://www.xiaohongshu.com/user/profile/u1");
  // 没有资料行的账号保持 null（报告显示"未采集"，不允许用 0 冒充）
  assert.equal(aggregatePlatformAccounts(withProfiles).find((a) => a.author === "太阳花主理人")!.followers, null);
});

test("有真实粉丝量时：人选表填真实值并按粉丝量分层（不再退回互动量分位）", () => {
  const cands = platformCreatorCandidates(withProfiles, { category: "护肤品-精华", platforms: ["xiaohongshu"] });
  const me = cands.find((c) => c.nickname === "长草的菜菜")!;
  assert.equal(me.followers, 2373);
  assert.equal(me.tier, "tail", "2373 粉丝按 tierOf 属尾部（<40万）；分层依据必须是粉丝量而非互动量");
  assert.match(me.contentFit, /分层依据为粉丝量/);
  assert.ok(!/粉丝量\*\*未采集\*\*/.test(me.rationale), "既然采到了粉丝量，就不该再写'未采集'");

  const rows = creatorAccountRows({ candidates: cands, excluded: [], citations: [] } as CreatorOutput, withProfiles);
  const row = rows.find((r) => r[1] === "长草的菜菜")!;
  assert.equal(row[5], "2373", "人选核验表必须显示真实粉丝量");
  assert.equal(row[4], "https://www.xiaohongshu.com/user/profile/u1", "凭据列优先给个人主页链接");
});

test("无资料行时如实写'未采集'（绝不能填 0 冒充真实粉丝量）", () => {
  const cands = platformCreatorCandidates(entries, { category: "护肤品-精华", platforms: ["xiaohongshu"] });
  const me = cands.find((c) => c.nickname === "长草的菜菜")!;
  assert.equal(me.followers, 0, "字段值是 0（结构要求），但…");
  assert.match(me.rationale, /粉丝量\*\*未采集\*\*/, "…文案必须明确说未采集");
  const rows = creatorAccountRows({ candidates: cands, excluded: [], citations: [] } as CreatorOutput, entries);
  assert.equal(rows.find((r) => r[1] === "长草的菜菜")![5], "未采集", "表格里显示'未采集'而不是 0");
});

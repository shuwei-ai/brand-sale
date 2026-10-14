/**
 * 报告数据溯源（P0）自检。
 *
 * 这一层要守住的，是"报告能说清数据来自哪条内容"这件事**不依赖模型自觉**：
 *   1. 证据由工具机械登记（entryId 系统生成），模型只被允许引用；
 *   2. 引用未登记的条目 → 校验判非法 → 自动降级（而不是渲染出悬空引用）；
 *   3. URL / 发布时间由渲染层按 entryId 反查证据表拼接 —— 模型从不提供链接，
 *      所以"编一个看起来很像的 URL"这条路在结构上就不通；
 *   4. 溯源附录页完全机械生成，关掉所有提示词话术它也在。
 *
 * 运行：npm test（全离线，不碰 collector、不调模型）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOGICAL_REFS,
  validateReportDsl,
  autoRepair,
  type EvidenceEntry,
  type ReportDsl,
  type SourceCatalog,
} from "@brandsale/contracts";
import { loadConfig } from "@brandsale/config";
import {
  EVIDENCE_MAX_PER_JOB,
  EvidenceRegistry,
  PLATFORM_DIGEST_TOOL_NAME,
  SYSTEM_PROMPTS,
  platformAccountRows,
  platformCandidateId,
  enrichReportProvenance,
  evidenceIdOf,
  mergePlatformEvidences,
  platformEvidencesFrom,
  synthIntel,
  synthReport,
  toEvidenceEntries,
  unwrap,
  type CreatorOutput,
  type IntelOutput,
} from "@brandsale/agent-pack";
import { RenderService } from "@brandsale/render";

/* ── fixtures ───────────────────────────────────────────── */

const ROWS = [
  { platform: "xhs", platformName: "小红书", id: "65f2abc", title: "成分党笔记", text: "烟酰胺浓度对比实测".repeat(30), author: "护肤研究所", url: "https://www.xiaohongshu.com/explore/65f2abc", publishedAt: "2026-05-02T10:00:00Z", metrics: { likes: 1200 } },
  { platform: "xhs", platformName: "小红书", id: "65f2abc", title: "重复条目", text: "同一条内容", author: "护肤研究所", url: "https://www.xiaohongshu.com/explore/65f2abc", publishedAt: "2026-05-02T10:00:00Z", metrics: {} },
  { platform: "dy", platformName: "抖音", id: "", title: "没有 id 的条目", text: "不该进证据表", author: "x", url: "https://example.com/x", publishedAt: "", metrics: {} },
  { platform: "tieba", platformName: "贴吧", id: "tb9", title: "", text: "贴吧讨论帖正文", author: "路人", url: "", publishedAt: "", metrics: { comments: 12, bogus: "n/a" } },
];

const mkEntry = (over: Partial<EvidenceEntry> = {}): EvidenceEntry => ({
  entryId: evidenceIdOf("xhs", "65f2abc"),
  platform: "xhs",
  platformName: "小红书",
  op: "search",
  kind: "content",
  title: "成分党笔记",
  excerpt: "烟酰胺浓度对比",
  author: "护肤研究所",
  url: "https://www.xiaohongshu.com/explore/65f2abc",
  publishedAt: "2026-05-02T10:00:00Z",
  metrics: { likes: 1200 },
  collectedAt: "2026-05-20T08:00:00Z",
  ...over,
});

const catalogWith = (evidenceEntries: EvidenceEntry[]): SourceCatalog => ({
  entries: [
    { key: "mc_xhs", displayName: "小红书", grade: "L3", origin: "external", coverage: "公开采集，未人工核验", asOf: "2026-05-20" },
    { key: "mc_tieba", displayName: "贴吧", grade: "L3", origin: "external", coverage: "公开采集，未人工核验", asOf: "2026-05-20" },
  ],
  logicalRefs: [...LOGICAL_REFS],
  evidenceEntries,
});

const REPORT_BRIEF = { brandIds: ["brand_A"], category: "护肤品-精华", window: { from: "2026-05-20", to: "2026-06-20" }, budget: { amount: 3_000_000 } };

/** 最小 intel 产物：synthReport 只读字段、不做 schema 校验，够跑通溯源链即可 */
const intelWith = (evidences: NonNullable<IntelOutput["evidences"]>): IntelOutput =>
  ({
    competitors: [],
    categoryInsights: { trends: [], audience: [], seasonality: [], pricingBand: [{ band: "低价位带", share: null }], channelMix: [] },
    dataGaps: [],
    citations: [],
    evidences,
    brandSelf: {
      positioning: { statement: "定位待确认", differentiators: ["待确认"] },
      contentAssets: [{ platform: "douyin", accountCount: null, postCount: null, avgEngagement: null, tier: "未获授权" }],
      reputation: { sentiment: "unknown", themes: [] },
      gaps: [{ dimension: "价格带覆盖", self: "待确认", benchmark: "公开口径", delta: "算不出" }],
      citations: [],
    },
  }) as unknown as IntelOutput;

/* ── ① 行 → 证据条目：主键缺失即丢弃，去重，摘录截断 ─────────── */

test("toEvidenceEntries 丢弃无 id 的条目、按 entryId 去重、指标只留有限数值", () => {
  const entries = toEvidenceEntries(ROWS, { op: "search", collectedAt: "2026-05-20T08:00:00Z" });

  assert.deepEqual(
    entries.map((e) => e.entryId),
    ["pf_xhs_65f2abc", "pf_tieba_tb9"],
    "重复条目应合并；没有原始 id 的条目必须丢弃（entryId 是溯源主键，造不出主键的条目留着也无法被引用）",
  );
  assert.equal(entries[0]!.platformName, "小红书");
  assert.ok(entries[0]!.excerpt.length <= 121, `摘录应截断，实际 ${entries[0]!.excerpt.length}`);
  assert.equal(entries[0]!.collectedAt, "2026-05-20T08:00:00Z", "采集时点应取调用方给的 asOf");
  assert.deepEqual(entries[1]!.metrics, { comments: 12 }, "非数值指标不得进证据表（会让可比性判断失效）");
  assert.equal(entries[1]!.kind, "content");
  assert.equal(toEvidenceEntries(ROWS, { op: "comments" })[0]!.kind, "comment", "comments 算子产出评论层条目");
});

/* ── ② 登记表：跨批次去重 + 上限显式计数 ───────────────────── */

test("EvidenceRegistry 跨批次去重、按 job 隔离、超限只计数不静默丢弃", () => {
  const reg = new EvidenceRegistry(3);
  const first = reg.record("job_a", [mkEntry(), mkEntry({ entryId: evidenceIdOf("dy", "1"), platform: "dy" })]);
  assert.deepEqual(first, { added: 2, truncated: 0, total: 2 });

  const again = reg.record("job_a", [mkEntry()]);
  assert.equal(again.added, 0, "同 entryId 不应重复入表");

  const over = reg.record("job_a", [mkEntry({ entryId: evidenceIdOf("dy", "2") }), mkEntry({ entryId: evidenceIdOf("dy", "3") })]);
  assert.equal(over.total, 3, "不应超过上限");
  assert.equal(over.truncated, 1, "超限条数必须显式计数（不做静默丢弃）");
  assert.equal(reg.truncatedCount("job_a"), 1);

  assert.equal(reg.list("job_a").length, 3);
  assert.equal(reg.list("job_b").length, 0, "证据必须按 job 隔离");
  assert.equal(EVIDENCE_MAX_PER_JOB, 500, "上限是产品参数，改动需显式确认");
});

/* ── ③ 合成路径真的消费平台 rows（旧实现完全不读）─────────── */

test("synthIntel 把 platform_digest 的 rows 转成条目级引用，无数据时不编造", () => {
  const tools = {
    [PLATFORM_DIGEST_TOOL_NAME]: { result: { op: "search", rows: ROWS, totalCount: 3 } },
  };
  const out = synthIntel(
    { industry: "美妆", category: "护肤品-精华", platforms: ["douyin", "xiaohongshu"], window: { from: "2026-05-20" } },
    tools,
  );

  assert.ok(out.evidences && out.evidences.length > 0, "取回了平台内容就必须留下条目级证据");
  assert.equal(out.evidences[0]!.entryId, "pf_xhs_65f2abc");
  assert.ok(out.evidences[0]!.quote.length <= 80);
  assert.ok(
    out.citations.some((c) => c.sourceKey === "mc_xhs"),
    "同时要有来源级引用（样本量），让降级阶梯能退到来源级而不是模型推断",
  );

  const empty = synthIntel({ industry: "美妆", category: "x", platforms: ["douyin"], window: { from: "2026-05-20" } }, {});
  assert.equal(empty.evidences, undefined, "没取到平台数据时不得凭空造证据");
});

/* ── ④ 端到端：DSL 带条目级引用 + 机械附录页 + 渲染出真链接 ─── */

test("报告出现条目级引用与溯源附录页，且 URL 由证据表反查而来", () => {
  const entries = toEvidenceEntries(ROWS, { op: "search", collectedAt: "2026-05-20T08:00:00Z" });
  const catalog = catalogWith(entries);
  const dsl = synthReport(
    REPORT_BRIEF,
    { intel: intelWith([{ entryId: entries[0]!.entryId, quote: "成分党笔记：烟酰胺浓度对比实测", useFor: "竞品内容形态" }]) },
    { synthesized: true, catalog },
  );

  const competitorPage = dsl.slides.find((s) => s.title === "竞品格局对比")!;
  const entryCite = competitorPage.citations.find((c) => c.kind === "platform_entry");
  assert.ok(entryCite, "竞品页必须有条目级引用");
  assert.equal(entryCite!.ref.entryId, entries[0]!.entryId);
  assert.equal(entryCite!.ref.sourceKey, "mc_xhs", "同平台来源在场时应一并带上来源级出处");

  const appendix = dsl.slides.find((s) => s.pageRole === "appendix");
  assert.ok(appendix, "溯源附录页必须存在（机械生成，与模型无关）");
  const appendixText = JSON.stringify(appendix!.blocks);
  assert.ok(appendixText.includes("https://www.xiaohongshu.com/explore/65f2abc"), "被引条目清单必须能给出原文链接");
  assert.ok(appendixText.includes("平台采集概览"), "附录要有采集概览");
  assert.ok(!appendixText.includes("没有 id 的条目"), "证据表外的条目不得出现在附录里");

  // 带目录的兜底校验必须通过（R13 存在性校验在这里执行）
  const post = validateReportDsl(dsl, { catalog });
  assert.equal(post.ok, true, `带目录校验应通过：${post.issues.filter((i) => i.level === "error").map((i) => i.message).join("；")}`);

  // 渲染层：平台徽标 + 可点原文链接 + 采集口径（全部来自证据表，模型没提供任何 URL）
  const render = new RenderService(loadConfig(process.cwd(), { BM_LLM_MODE: "mock" }));
  const html = render.toHtml(dsl, { catalog });
  assert.ok(html.includes('class="badge"'), "条目级引用应带平台徽标");
  assert.ok(html.includes('href="https://www.xiaohongshu.com/explore/65f2abc"'), "应渲染出可点原文链接");
  assert.ok(html.includes('rel="noopener noreferrer"'), "外链必须带 noopener（报告是自包含 HTML）");
  assert.ok(html.includes("L3 公开采集"), "应标注数据分级口径");

  const md = render.toMarkdown(dsl, { catalog });
  assert.ok(md.includes("[原文](https://www.xiaohongshu.com/explore/65f2abc)"), "Markdown 同样要能点回原帖");
});

/* ── ⑤ R13：未登记的 entryId 判非法，并按阶梯降级 ───────────── */

test("未登记的条目级引用被 R13 拦下，降级为来源级引用而不是删内容", () => {
  const catalog = catalogWith([mkEntry()]);
  const build = (entryId: string): ReportDsl =>
    synthReport(
      REPORT_BRIEF,
      { intel: intelWith([{ entryId, quote: "伪造的引用" }]) },
      { synthesized: true, catalog },
    );

  // ① 证据表里没有的 entryId：synthReport 的透传白名单先挡一道
  const invented = build("pf_xhs_never_collected");
  assert.ok(
    !invented.slides.some((s) => s.citations.some((c) => c.kind === "platform_entry")),
    "查不到出处的条目级引用不得写进报告",
  );

  // ② 绕过合成层（手写 DSL）时，R13 兜底：判 error 且可修复
  const rogue: ReportDsl = {
    ...build(mkEntry().entryId),
    slides: build(mkEntry().entryId).slides.map((s) =>
      s.title === "竞品格局对比"
        ? { ...s, citations: [{ claim: "手工伪造", kind: "platform_entry" as const, ref: { entryId: "pf_xhs_never_collected", sourceKey: "mc_xhs" }, confidence: 0.5, tier: "medium" as const, verifiedBy: "auto" as const }] }
        : s,
    ),
  };
  const issues = validateReportDsl(rogue, { catalog }).issues;
  const r13 = issues.find((i) => i.path.includes("citations") && i.message.includes("未登记的采集条目"));
  assert.ok(r13, `R13 必须拦下未登记的 entryId，实际 issues=${JSON.stringify(issues.map((i) => i.message))}`);
  assert.equal(r13!.level, "error");
  assert.equal(r13!.repairable, true);

  // ③ 降级阶梯：条目级 → 来源级（保留 sourceKey），而不是一步退成模型推断
  const { dsl: repaired, actions } = autoRepair(rogue, { catalog });
  const fixed = repaired.slides.find((s) => s.title === "竞品格局对比")!.citations[0]!;
  assert.equal(fixed.kind, "data_source", "有来源级出处时应退到来源级");
  assert.equal(fixed.ref.sourceKey, "mc_xhs");
  assert.ok(actions.some((a) => a.includes("降级为来源级引用")), `应有降级动作，实际 ${JSON.stringify(actions)}`);

  // ④ 连 sourceKey 都没有 / 也没声明时，才退成模型推断
  const orphan: ReportDsl = {
    ...rogue,
    slides: rogue.slides.map((s) =>
      s.title === "竞品格局对比"
        ? { ...s, citations: [{ claim: "无出处", kind: "platform_entry" as const, ref: { entryId: "pf_ghost" }, confidence: 0.5, tier: "medium" as const, verifiedBy: "auto" as const }] }
        : s,
    ),
  };
  const orphanFixed = autoRepair(orphan, { catalog }).dsl.slides.find((s) => s.title === "竞品格局对比")!.citations[0]!;
  assert.equal(orphanFixed.kind, "model_inference");
  assert.equal(orphanFixed.tier, "low");
});

/* ── ⑥ 目录没给证据集 = 不校验（不能冤杀历史调用方）─────────── */

test("catalog 未提供 evidenceEntries 时跳过 R13", () => {
  const dsl = synthReport(
    REPORT_BRIEF,
    { intel: intelWith([{ entryId: "pf_xhs_whatever", quote: "无证据集可校验" }]) },
    { synthesized: true, catalog: { entries: [], logicalRefs: [...LOGICAL_REFS] } },
  );
  const withoutEvidenceField: ReportDsl = {
    ...dsl,
    slides: dsl.slides.map((s) =>
      s.title === "竞品格局对比"
        ? { ...s, citations: [{ claim: "x", kind: "platform_entry" as const, ref: { entryId: "pf_xhs_whatever" }, confidence: 0.5, tier: "medium" as const, verifiedBy: "auto" as const }] }
        : s,
    ),
  };
  const issues = validateReportDsl(withoutEvidenceField, { catalog: { entries: [], logicalRefs: [...LOGICAL_REFS] } }).issues;
  assert.ok(!issues.some((i) => i.message.includes("未登记的采集条目")), "无法判定时不应冤杀");
});

/* ── ⑦ 模型路径的机械补齐：取回了平台内容就必须"被报告认领" ──────
 *
 * 实测踩到的断点：`evidences` 在结构里是可选字段，模型不填 → `platform_digest` 取回的
 * 几十条真实平台内容"取到了但报告没认领"：一条条目级引用都写不出来、来源表只有报价库、
 * 附录写着"本次报告没有条目级平台引用"。这两条用例把这个断点钉住。
 */

test("mergePlatformEvidences：模型不填 evidences 时机械补齐，填了的排前面且不重复", () => {
  const bare = { competitors: [], citations: [] } as unknown as IntelOutput;

  const merged = mergePlatformEvidences(bare, ROWS);
  assert.ok(merged.evidences && merged.evidences.length > 0, "取回平台内容就必须留下条目级证据（模型不填也要补）");
  assert.equal(merged.evidences![0]!.entryId, "pf_xhs_65f2abc");
  assert.ok(merged.evidences!.every((e) => e.quote.length <= 80), "机械补的摘录同样要限长");

  const own = mergePlatformEvidences(intelWith([{ entryId: "pf_own_1", quote: "模型自己写的", useFor: "结论 A" }]), ROWS);
  assert.equal(own.evidences![0]!.entryId, "pf_own_1", "模型自己写的条目必须排在前面（它知道哪条支撑哪个结论）");
  assert.equal(
    new Set(own.evidences!.map((e) => e.entryId)).size,
    own.evidences!.length,
    "机械补的条目不得与模型写过的重复",
  );

  assert.equal(mergePlatformEvidences(bare, []).evidences, undefined, "没有平台数据时不得凭空造证据");
});

test("platformEvidencesFrom 逐平台轮转：名额不被排在第一的平台占满", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ platform: "xhs", id: `x${i}`, title: `笔记 ${i}`, text: "正文" })),
    { platform: "zhihu", id: "z1", title: "知乎回答", text: "正文" },
    { platform: "tieba", id: "t1", title: "贴吧讨论帖", text: "正文" },
  ];
  const ev = platformEvidencesFrom(rows);
  const platforms = [...new Set(ev.map((e) => e.entryId.split("_")[1]!))].sort();
  assert.deepEqual(platforms, ["tieba", "xhs", "zhihu"], "每个有数据的平台都必须拿到名额（否则报告会把它读成没接上）");
  assert.equal(ev[0]!.entryId, "pf_xhs_x0", "顺序稳定：按平台首现顺序各出第 1 条");
  assert.equal(ev[1]!.entryId, "pf_zhihu_z1");
});

test("enrichReportProvenance：模型一条平台引用都没写时，来源声明/条目级引用/附录页全部机械补齐", () => {
  const entries = toEvidenceEntries(ROWS, { op: "search", collectedAt: "2026-05-20T08:00:00Z" });
  const catalog = catalogWith(entries);

  // 模拟模型产出：intel 没写 evidences → 报告里 0 条 platform_entry、来源表里没有平台
  const fromModel = synthReport(REPORT_BRIEF, { intel: intelWith([]) }, { synthesized: false, catalog });
  assert.ok(
    !fromModel.slides.some((s) => s.citations.some((c) => c.kind === "platform_entry")),
    "前置条件：这份 DSL 本来一条条目级引用都没有",
  );
  assert.ok(!fromModel.sourceDeclaration.sources.some((s) => s.key === "mc_xhs"), "前置条件：来源表里本来没有平台");

  const enriched = enrichReportProvenance(fromModel, entries, catalog);

  // ① 来源声明：真的有证据的平台被补进"已使用"
  const keys = enriched.sourceDeclaration.sources.map((s) => s.key);
  assert.ok(keys.includes("mc_xhs") && keys.includes("mc_tieba"), `平台源应被补进声明，实际 ${JSON.stringify(keys)}`);

  // ② 条目级引用：挂到附录页，且带来源级出处
  const appendix = enriched.slides.find((s) => s.pageRole === "appendix");
  assert.ok(appendix, "附录页必须存在");
  const entryCite = appendix!.citations.find((c) => c.kind === "platform_entry");
  assert.ok(entryCite, "附录页必须有条目级引用");
  assert.equal(entryCite!.ref.sourceKey, "mc_xhs", "同平台来源在场时应一并带上来源级出处");

  // ③ 附录里能点回原帖（URL 由证据表反查，模型从未提供链接）
  const text = JSON.stringify(appendix!.blocks);
  assert.ok(text.includes("机械汇总"), "附录要有平台采集概览");
  assert.ok(text.includes("https://www.xiaohongshu.com/explore/65f2abc"), "被引条目清单必须给出原文链接");
  assert.ok(!text.includes("没有 id 的条目"), "证据表外的条目不得出现在附录里");

  // ④ 只补不删 + 幂等：跑第二遍不再叠加同名机械块
  const twice = enrichReportProvenance(enriched, entries, catalog);
  assert.equal(
    JSON.stringify(twice.slides).split("机械汇总").length - 1,
    1,
    "机械块不得叠加（回喂重跑会二次经过这里）",
  );
  assert.equal(twice.slides.length, enriched.slides.length, "幂等重跑不得增删页面");

  // ⑤ 补完的 DSL 必须过渲染层不变量校验（R6/R11/R13 都在这条链上）
  const post = validateReportDsl(twice, { catalog });
  assert.equal(
    post.ok,
    true,
    `机械补齐后必须仍然合法：${post.issues.filter((i) => i.level === "error").map((i) => i.message).join("；")}`,
  );

  // ⑥ 证据表为空 → 原样返回，不凭空造页面
  const untouched = enrichReportProvenance(fromModel, [], catalog);
  assert.equal(untouched.slides.length, fromModel.slides.length);
  assert.equal(untouched.sourceDeclaration.sources.length, fromModel.sourceDeclaration.sources.length);
});

/* ── 人选来源标注：业主实测"报告里的抖音/小红书账号搜不到" ────────────
 *
 * 实情是两种数据被混在一起读：
 *   · 报告里的人选（达人）来自**本地达人报价库**（L2 私域样本），库内只有昵称与报价样本，
 *     **没有平台账号 ID**，也从未与平台账号核验 → 平台上搜不到同名账号是预期；
 *   · 从平台采集回来的内容是真的，账号昵称按业主要求**完整显示**（不再打码），可站内检索。
 * 两种都必须标出来，否则整份报告的可信度会被一个"搜不到的名字"拖垮。
 */

const CREATORS_FOR_TEST = {
  candidates: [
    {
      talentId: "t_1003",
      nickname: "皮肤科医生老王",
      platform: "douyin",
      followers: 2_150_000,
      category: "美妆护肤",
      matchScore: 0.77,
      rationale: "报价库有区间样本",
      estimatedCost: 330_000,
      costRange: { low: 240_900, high: 419_100 },
      riskFlags: [],
      tier: "head",
      contentFit: "互动率 2.8%",
      historicalPerformance: "无样本",
      confidence: 0.75,
    },
  ],
  excluded: [],
  citations: [],
} as unknown as CreatorOutput;

test("人选来源必须机械标注：报价库昵称标'未核验'，真实采集账号单列且完整显示", () => {
  const entries = toEvidenceEntries(ROWS, { op: "search", collectedAt: "2026-05-20T08:00:00Z" });
  const catalog = catalogWith(entries);
  const dsl = synthReport(REPORT_BRIEF, { intel: intelWith([]) }, { synthesized: false, catalog });

  const enriched = enrichReportProvenance(dsl, entries, catalog, { creators: CREATORS_FOR_TEST });
  const appendix = enriched.slides.find((s) => s.pageRole === "appendix");
  assert.ok(appendix, "附录页必须存在");
  const text = JSON.stringify(appendix!.blocks);

  // ① 人选表：逐条给出"来源=本地报价库 + 账号未核验"，让读者知道这个名字搜不到是预期
  assert.ok(text.includes("人选名单来源与核验状态"), "附录必须有人选来源说明");
  assert.ok(text.includes("皮肤科医生老王") && text.includes("t_1003"), "人选逐条列出（含人选 ID）");
  assert.ok(text.includes("库内无账号 ID（未核验）"), "必须明写平台账号未核验");
  assert.ok(text.includes("本地达人报价库（L2）"), "必须在来源列标出数据出处");
  assert.ok(text.includes("搜不到同名账号属预期"), "必须解释'搜不到'的原因");

  // ② 平台真实账号：把采集回来的账号单列（完整昵称，不打码），让"平台数据是真的"可核对
  assert.ok(text.includes("平台真实账号（采集所得）"), "附录必须有真实账号清单");
  assert.ok(text.includes("护肤研究所"), "证据表里的真实作者要出现在账号清单里");
  assert.ok(text.includes("账号昵称"), "账号清单的表头必须是完整昵称列");
  assert.ok(!/\*\*\*/.test(text), "账号名不得再被打上 **** 马赛克（业主要求完整显示）");

  // ③ 幂等：回喂重跑不得把这两块叠加两遍（只统计附录页，正文的人选表 caption 会引用块名）
  const appendixText = (d: typeof enriched) => JSON.stringify(d.slides.find((s) => s.pageRole === "appendix")?.blocks ?? []);
  const twice = enrichReportProvenance(enriched, entries, catalog, { creators: CREATORS_FOR_TEST });
  assert.equal(appendixText(twice).split("人选名单来源与核验状态").length - 1, 1, "人选块不得叠加");
  assert.equal(appendixText(twice).split("平台真实账号（采集所得）").length - 1, 1, "真实账号块不得叠加");
  assert.equal(twice.slides.length, enriched.slides.length, "幂等重跑不得增删页面");

  // ④ 补完仍须通过结构校验（新增表/块不能破坏 DSL 合法性）
  const post = validateReportDsl(twice, { catalog });
  assert.equal(
    post.ok,
    true,
    `新增溯源块后必须仍然合法：${post.issues.filter((i) => i.level === "error").map((i) => i.message).join("；")}`,
  );

  // ⑤ 没有任何平台证据时，人选来源仍要被标注（它回答的是"人名哪来的"，与证据无关）
  const catalogNoEvidence = { ...catalog, evidenceEntries: [] };
  const dslNoEvidence = synthReport(REPORT_BRIEF, { intel: intelWith([]) }, { synthesized: false, catalog: catalogNoEvidence });
  const onlyCreators = enrichReportProvenance(dslNoEvidence, [], catalogNoEvidence, { creators: CREATORS_FOR_TEST });
  assert.ok(JSON.stringify(onlyCreators.slides).includes("人选名单来源与核验状态"), "无平台证据也要标人选来源");
  assert.ok(!JSON.stringify(onlyCreators.slides).includes("平台真实账号（采集所得）"), "无证据时不得凭空造账号清单");
});

/* 平台采集人选的「可核验凭据」列在**模型路径**下也必须有链接。
 *
 * 实测事故（2026-10-11 双十一精华自测第三次重跑）：模型路径产出的报告里，
 * 人选表 6 行的凭据列全是「—」，而同一页的平台账号表却有链接 ——
 * 根因是 `enrichReportProvenance` 调 `creatorRosterBlocks(opts.creators)` 时**漏传了 entries**，
 * 于是只有降级/合成路径拿得到 URL。甲方拿这张表核对"这个达人是不是真的"，
 * 凭据列全空等于这张表白做。
 */
test("人选凭据列：模型路径（enrichReportProvenance）也必须带上平台真实链接", () => {
  const entries = toEvidenceEntries(ROWS, { op: "search", collectedAt: "2026-05-20T08:00:00Z" });
  const catalog = catalogWith(entries);
  const dsl = synthReport(REPORT_BRIEF, { intel: intelWith([]) }, { synthesized: false, catalog });
  const platformCreator = {
    ...(CREATORS_FOR_TEST.candidates[0]! as unknown as Record<string, unknown>),
    talentId: platformCandidateId("xhs", "护肤研究所"),
    nickname: "护肤研究所",
    platform: "小红书",
    followers: 120_000,
  };
  const creators = { candidates: [platformCreator], excluded: [], citations: [] } as unknown as CreatorOutput;

  const enriched = enrichReportProvenance(dsl, entries, catalog, { creators });
  const appendix = JSON.stringify(enriched.slides.find((s) => s.pageRole === "appendix")?.blocks ?? []);
  assert.ok(!appendix.includes("— | 120000"), "凭据列不得在模型路径下退化成「—」");
  assert.ok(
    appendix.includes("https://www.xiaohongshu.com/explore/65f2abc"),
    "凭据列必须是证据表里的真实原帖链接（渲染层按 entryId 反查，不可能是模型编的）",
  );
});

/* ── 平台真实账号：按 平台 × 作者 聚合（报告"账号清单"的数据源） ─────── */

test("platformAccountRows：按平台×作者聚合、条目多的排前、无作者的条目不进表", () => {
  const entries = toEvidenceEntries(
    [
      { platform: "xhs", platformName: "小红书", id: "a1", title: "T1", text: "x", author: "同名作者", url: "https://x/1", publishedAt: "", metrics: {} },
      { platform: "xhs", platformName: "小红书", id: "a2", title: "T2", text: "x", author: "同名作者", url: "https://x/2", publishedAt: "", metrics: {} },
      { platform: "xhs", platformName: "小红书", id: "a3", title: "T3", text: "x", author: "另一个作者", url: "https://x/3", publishedAt: "", metrics: {} },
      { platform: "dy", platformName: "抖音", id: "b1", title: "T4", text: "x", author: "", url: "https://y/1", publishedAt: "", metrics: {} },
    ],
    { op: "search", collectedAt: "2026-05-20T08:00:00Z" },
  );

  const rows = platformAccountRows(entries);
  assert.deepEqual(
    rows.map((r) => [r[0], r[1], r[2]]),
    [
      ["小红书", "同名作者", "2"],
      ["小红书", "另一个作者", "1"],
    ],
    "按平台×作者聚合、条目多的排前；无作者的条目不得进表（不能用「—」充数）",
  );
  assert.equal(rows[0]![3], "未采集", "没有主页资料行时粉丝量如实写「未采集」，不能用 0 冒充");
  assert.equal(rows[0]![4], "https://x/1", "凭据列取该作者的首条链接（有个人主页链接时优先主页）");
});

/* 名额分配必须逐平台轮转：不能让字典序靠后的平台被整块截掉。
 *
 * 实测事故（2026-10-11 双十一精华自测）：抖音采回 35 条、微博 20 条并已入库，
 * 附录里却一个抖音/微博账号都没有 —— `platformName` 字典序是
 * "B站" < "小红书" < "微博" < "抖音"，24 个名额被前两个平台吃满后 `slice` 把后两个整块砍了。
 * 报告不会报错、也不会出现"缺失"提示，只是干干净净少了一块：业主看到的就是"数据没采集"。
 */
test("platformAccountRows：名额逐平台轮转，字典序靠后的平台不得被整块截掉", () => {
  const entries = toEvidenceEntries(
    [
      // 条目数最多的平台（字典序最靠前）：单靠它就能吃满 24 个名额
      ...Array.from({ length: 30 }, (_, i) => ({
        platform: "bili",
        platformName: "B站",
        id: `b${i}`,
        title: `T${i}`,
        text: "x",
        author: `B站作者${String(i).padStart(2, "0")}`,
        url: `https://space.bilibili.com/${i}`,
        publishedAt: "",
        metrics: {},
      })),
      { platform: "wb", platformName: "微博", id: "w1", title: "W", text: "x", author: "微博作者", url: "https://m.weibo.cn/u/1", publishedAt: "", metrics: {} },
      { platform: "dy", platformName: "抖音", id: "d1", title: "D", text: "x", author: "抖音作者", url: "https://www.douyin.com/user/1", publishedAt: "", metrics: {} },
    ],
    { op: "search", collectedAt: "2026-05-20T08:00:00Z" },
  );

  const rows = platformAccountRows(entries);
  assert.equal(rows.length, 24, "总量仍然受 PLATFORM_ACCOUNT_LIMIT 约束");
  const platforms = new Set(rows.map((r) => r[0]));
  for (const p of ["B站", "微博", "抖音"]) {
    assert.ok(platforms.has(p), `${p} 采到了账号就必须在清单里有席位（不得被字典序截断）`);
  }
});

/* 多品牌 Brief：封面/页脚必须列全，不能只印第一个品牌。
 *
 * 实测问题（2026-10-11 双十一精华自测）：Brief 是「施华蔻/赫莲娜/兰蔻/雅诗兰黛」四个品牌共用预算，
 * 报告封面却只写「施华蔻」—— 甲方第一眼就会觉得拿错了报告。
 */
test("多品牌 Brief：报告封面与 meta 里的品牌名必须列全（不是只取 brandIds[0]）", () => {
  const brief = {
    brandIds: ["施华蔻", "赫莲娜", "兰蔻", "雅诗兰黛"],
    category: "精华",
    window: { from: "2026-10-20", to: "2026-11-15" },
    budget: { amount: 3_000_000 },
  };
  const dsl = synthReport(brief, { intel: intelWith([]) }, { synthesized: true, catalog: catalogWith([]) });

  const flat = JSON.stringify(dsl);
  const label = "施华蔻 / 赫莲娜 / 兰蔻 / 雅诗兰黛";
  assert.ok(flat.includes(label), "封面副标题与 meta.brand.name 都要带上全部品牌");
  assert.equal(dsl.meta.brand.name, label, "meta.brand.name 不能只写第一个品牌");
  assert.equal(dsl.meta.brand.id, "施华蔻", "meta.brand.id 仍是单一 id（契约要求），品牌清单放在 name 里");
});

/* ── 机械补齐的接线：invoke 返回值必须先解包 ─────────────────────────
 *
 * 实测事故（业主看到的「[产出不完整] 竞品情报分析 降级」那一串的根因之一）：
 * 证据表里躺着真实平台条目，intel 的 evidences 却一条都没被机械化补齐 ——
 * 因为 attachPlatformEvidences 直接读了 `res.rows`，而 `ToolRegistry.invoke` 返回的是
 * `{ result, provenance, note }`，顶层**没有 rows**。这类"接了线但没通电"的缺陷不会报错，
 * 只会让兜底静默失效。这里把"必须 unwrap"钉成契约。
 */
test("工具返回值形状：机械补齐必须先 unwrap 到 result（直接读顶层 rows 会静默失效）", () => {
  const entries = toEvidenceEntries(ROWS, { op: "search" });
  // 真实形态：一次 registry.invoke 的返回值
  const invokeResult: unknown = { result: { rows: ROWS, count: ROWS.length }, provenance: [], note: "小红书 search 命中 3 条" };

  assert.equal(
    (invokeResult as { rows?: unknown }).rows,
    undefined,
    "顶层没有 rows —— 这就是当年补齐静默失效的原因（改成断言，防止有人又直接读 .rows）",
  );

  const unwrapped = unwrap(invokeResult);
  const merged = mergePlatformEvidences(intelWith([]), (unwrapped.rows ?? []) as Record<string, unknown>[]);
  assert.ok(merged.evidences && merged.evidences.length > 0, "解包之后必须能补出条目级证据");
  assert.equal(merged.evidences![0]!.entryId, entries[0]!.entryId);
  assert.ok(
    merged.evidences!.every((e) => e.quote.length <= 80),
    "机械补的摘录同样受长度约束（不是原文留存）",
  );
});

/* ── 提示词不得给出可照抄的 entryId 示例 ────────────────────────────
 *
 * 起因：报错里那 5 条被摘除的 entryId，其中一条 `pf_xhs_65f2abc` 就是**提示词示例本身** ——
 * 模型在没有取到任何平台条目的情况下，照着示例编了 5 个像真的 id。
 * 示例必须是占位符，且必须明确"取不到就留空"。
 */
test("提示词里的 entryId 示例必须是占位符，且明确禁止编造", () => {
  const text = Object.values(SYSTEM_PROMPTS).join("\n");
  const copyable = text.match(/pf_[a-z]+_[0-9a-f]{5,}/g) ?? [];
  assert.deepEqual(
    copyable,
    [],
    `示例 id 会被模型逐字照抄（实测抄出 pf_xhs_65f2abc），只能写成占位符，实际出现：${copyable.join("、")}`,
  );
  assert.match(text, /不要凭印象编一个 entryId/, "必须明确禁止编造 entryId");
  assert.match(text, /留空/, "必须告诉模型：本次没取到平台条目时把 evidences 留空（系统会机械补齐）");
});

/**
 * WP-B 品牌自身诊断（P0-1）验收测试。
 *
 * 这一章最大的风险不是"没写"，而是**写成编造**：品牌自诊读起来像在陈述"已知的自家情况"，
 * 于是最容易出现"品牌认知度 32%"这类没有任何来源的数字。
 * 所以这里的断言集中在"没数据时它是否老老实实说没有"。
 *
 * 对应方案 `docs/requirements-implementation-plan.md` §WP-B：
 *   报告含该 2 页（**仅当 Brief 指定了自有品牌 ownBrandId**）；gaps.length >= 3；
 *   未授权场景 contentAssets[].avgEngagement === null 且存在 warn callout；
 *   measureReportDepth().slides >= 15。
 *   未指定自有品牌时报告整份不做品牌自诊（WP-B-8）—— 那时只做市场与竞品调研。
 *
 * 运行：npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEPTH_POLICY,
  OWN_BRAND_LEAK_RE,
  autoRepair,
  measureReportDepth,
  stripOwnBrandLeak,
  validateReportDsl,
  type ReportDsl,
} from "@brandsale/contracts";
import { CompetitorIntelSchema, PLATFORM_DIGEST_TOOL_NAME, synthIntel, synthReport } from "@brandsale/agent-pack";

/** 未接入任何品牌资产数据源的最小 Brief（这是当前的真实处境） */
const brief = {
  industry: "美妆个护",
  category: "抗老精华",
  platforms: ["douyin", "xiaohongshu"],
  window: { from: "2026-10-01", to: "2026-12-31" },
  brandIds: ["b_demo_1"],
  /** 指定了自有品牌 → 报告才做品牌自诊（见 WP-B-8 的反例） */
  ownBrandId: "b_demo_1",
  budget: { amount: 3_000_000 },
};

const noTools = {};

test("WP-B-1 未授权场景：自有资产数字必须全为 null，且不挂任何引用", () => {
  const intel = synthIntel(brief, noTools);
  const bs = intel.brandSelf;

  assert.ok(bs, "intel 必须带 brandSelf");
  assert.ok(bs.contentAssets.length > 0, "至少要按 Brief 的平台列表列出待确认的行");
  for (const a of bs.contentAssets) {
    assert.equal(a.accountCount, null, `${a.platform} 的账号数无来源，必须是 null`);
    assert.equal(a.postCount, null, `${a.platform} 的作品数无来源，必须是 null`);
    assert.equal(a.avgEngagement, null, `${a.platform} 的互动率无来源，必须是 null`);
    assert.match(a.tier, /未获授权/, "tier 必须如实写明这一行数据的可得性");
  }
  assert.equal(bs.reputation.sentiment, "unknown", "没有口碑样本就不能给情感倾向");
  assert.equal(bs.reputation.themes.length, 0);
  assert.equal(bs.citations.length, 0, "一个数字都没有，就不该有任何引用（否则引用是装饰）");
});

test("WP-B-2 差距矩阵不少于 3 条，且量化不了要写明原因而不是给 0", () => {
  const bs = synthIntel(brief, noTools).brandSelf;
  assert.ok(bs.gaps.length >= 3, `差距条目 ${bs.gaps.length} 条应 ≥ 3`);
  for (const g of bs.gaps) {
    assert.ok(g.dimension && g.benchmark && g.delta, "四段式（dimension/self/benchmark/delta）必须齐全");
    assert.ok(!/^0$/.test(g.delta.trim()), `「${g.dimension}」的差距不得用 0 冒充"没有差距"`);
  }
});

test("WP-B-3 兜底产物必须能通过自己的 Schema（有数字必须有来源的硬校验）", () => {
  // 兜底路径不能成为绕开校验的后门：它自己写出来的东西必须过自己的 schema
  const intel = synthIntel(brief, noTools);
  const validated = CompetitorIntelSchema.validate(intel);
  assert.ok(validated.brandSelf, "校验后 brandSelf 不能丢");
  assert.deepEqual(validated.brandSelf.citations, []);
});

test("WP-B-4 有数字却没引用时，Schema 必须拒绝（这是本章的核心防线）", () => {
  const intel = synthIntel(brief, noTools);
  const forged = structuredClone(intel);
  // 模拟模型"顺手填了个合理数字"：把 avgEngagement 填上，但仍不给引用
  forged.brandSelf.contentAssets[0]!.avgEngagement = 0.032;
  assert.throws(
    () => CompetitorIntelSchema.validate(forged),
    /citations 为空|自有资产数字必须逐项说明来源/,
    "无来源的自有资产数字必须被拒 —— 否则这一章就成了编造甲方经营数据的入口",
  );

  // 补上来源后就应放行（说明拦截的是"无来源"，不是"不许有数字"）
  const sourced = structuredClone(forged);
  sourced.brandSelf.citations = [{ claim: "抖音后台导出近 30 天互动率 3.2%", sourceKey: "internal_review", confidence: 0.8 }];
  assert.doesNotThrow(() => CompetitorIntelSchema.validate(sourced));
});

test("WP-B-5 无样本时不得给情感结论", () => {
  const intel = synthIntel(brief, noTools);
  const forged = structuredClone(intel);
  forged.brandSelf.reputation.sentiment = "positive"; // themes 仍为空
  assert.throws(
    () => CompetitorIntelSchema.validate(forged),
    /sentiment 必须是 unknown/,
    "没有口碑样本就给「偏正面」等于凭空造结论",
  );
});

test("WP-B-6 报告含品牌自诊 2 页，且概览页带 warn callout、KPI 不写 0", () => {
  const dsl = synthReport(brief, { intel: synthIntel(brief, noTools) }, { synthesized: true });
  const titles = dsl.slides.map((s) => s.title);
  assert.ok(titles.includes("品牌自诊概览"), "报告必须含「品牌自诊概览」页");
  assert.ok(titles.includes("品牌 vs 竞品差距矩阵"), "报告必须含「品牌 vs 竞品差距矩阵」页");

  const selfSlide = dsl.slides.find((s) => s.title === "品牌自诊概览");
  assert.ok(selfSlide, "品牌自诊概览页应存在");
  assert.ok(
    selfSlide.blocks.some((b) => b.type === "callout" && b.tone === "warn"),
    "未授权时该页必须有 tone=warn 的 callout 声明本页为定性判断",
  );

  const kpi = selfSlide.blocks.find((b) => b.type === "kpi");
  assert.ok(kpi && kpi.type === "kpi", "概览页应含 KPI 块");
  for (const item of kpi.items) {
    assert.notEqual(item.value, "0", `「${item.label}」未授权时必须写「无数据」，写 0 会被读成确实为零`);
  }

  const gapSlide = dsl.slides.find((s) => s.title === "品牌 vs 竞品差距矩阵");
  assert.ok(
    gapSlide?.blocks.some((b) => b.type === "matrix"),
    "差距页应含象限矩阵（可视化块）",
  );
  assert.ok(
    gapSlide?.blocks.some((b) => b.type === "table"),
    "差距页应含差距表格",
  );
});

test("WP-B-7 报告页数达到方案验收的 15 页下限", () => {
  const dsl = synthReport(brief, { intel: synthIntel(brief, noTools) }, { synthesized: true });
  const depth = measureReportDepth(dsl);
  assert.ok(
    depth.slides >= 15,
    `页数 ${depth.slides} 应 ≥ 15（方案 WP-B 把 13 页扩到 15 页）；当前策略下限为 ${DEFAULT_DEPTH_POLICY.minSlides}`,
  );
});

test("WP-B-8 未指定自有品牌时：报告整份不做品牌自诊，且不得出现「我方 / 本品」字样", () => {
  // 这是大多数委托的真实形态：客户只说"帮我看看这个类目"，没有告诉我他是谁。
  // 那种情况下"我方"不是一个已知实体，任何"自诊"都只能是编的。
  const noOwnBrand = { ...brief, ownBrandId: undefined };
  const dsl = synthReport(noOwnBrand, { intel: synthIntel(brief, noTools) }, { synthesized: true });
  const titles = dsl.slides.map((s) => s.title);

  assert.ok(!titles.includes("品牌自诊概览"), "未指定自有品牌时不得出现「品牌自诊概览」页");
  assert.ok(!titles.includes("品牌 vs 竞品差距矩阵"), "未指定自有品牌时不得出现「品牌 vs 竞品差距矩阵」页");

  const blob = JSON.stringify(dsl);
  assert.ok(!blob.includes("我方"), "报告任何位置都不得出现「我方」（含列名、caption、callout）");
  assert.ok(!blob.includes("本品"), "报告任何位置都不得出现「本品」");

  // 但市场侧内容与深度基线不能因此塌掉：替代页仍在，可视化块一块不少
  const titlesWithOwn = synthReport(brief, { intel: synthIntel(brief, noTools) }, { synthesized: true }).slides.map((s) => s.title);
  assert.ok(titles.includes("竞品定位矩阵"), "未指定自有品牌时应以「竞品定位矩阵」承接矩阵块");
  assert.ok(!titlesWithOwn.includes("竞品定位矩阵"), "指定了自有品牌时应走「品牌 vs 竞品差距矩阵」，不出现替代页");

  const depth = measureReportDepth(dsl);
  const depthWithOwn = measureReportDepth(
    synthReport(brief, { intel: synthIntel(brief, noTools) }, { synthesized: true }),
  );
  assert.ok(depth.slides >= DEFAULT_DEPTH_POLICY.minSlides, `页数 ${depth.slides} 应 ≥ ${DEFAULT_DEPTH_POLICY.minSlides}`);
  assert.equal(
    depth.visualBlocks,
    depthWithOwn.visualBlocks,
    "去掉「我方」不该顺带砍掉可视化块：替代页必须把 matrix 补回来",
  );
});

/* ── WP-B-9 / WP-B-10：R14 未指定自有品牌时的「我方口径」泄漏 ──────────── */

/**
 * 一份把**每一种可渲染槽位**都塞进违禁词的最小报告。
 *
 * 为什么非得覆盖到"每一种槽位"：R14 是 `repairable: true` 的 error，而 `render.compile`
 * 的流程是「autoRepair → 再校验一次 → 仍有 error 就抛错拒绝渲染」。只要扫描覆盖的槽位比
 * 修复覆盖的多**一个**，那个槽位上的违禁词就会在修复后继续报 error → 报告整份丢失。
 * 这份夹具就是那条不变量的护栏（与 report-repair 里"autoRepair 不得制造新 error"同源）。
 */
const leakyDsl: ReportDsl = {
  meta: {
    dslVersion: "1.0",
    title: "我方 Q4 市场调研报告",
    brand: { id: "b1", name: "未指定品牌" },
    window: { from: "2026-10-01", to: "2026-12-31" },
    generatedAt: "2026-10-15T00:00:00.000Z",
  },
  sourceDeclaration: {
    grade: "L3",
    sources: [{ key: "mc_dy", displayName: "抖音", grade: "L3", asOf: "2026-10-15", coverage: "我方通过公开检索取数" }],
    exclusions: [{ key: "mc_ks", reason: "快手不在本次我方调研范围" }],
  },
  slides: [
    {
      index: 0,
      pageRole: "cover",
      title: "我方双十一投放方案",
      layoutId: "cover/hero",
      blocks: [{ type: "text", style: "body", content: "竞品格局调研" }],
      citations: [],
    },
    {
      index: 1,
      pageRole: "data",
      title: "数据来源与口径声明",
      layoutId: "content/default",
      blocks: [
        /* 真机形状：模型为了守规矩而写的**负面声明** —— 声明本身就把词写进了报告 */
        {
          type: "text",
          style: "body",
          content: "本页数字全部来自公开采集。由于未指定自有品牌，报告不含任何「我方」或「本品」的自诊数据。",
          sourceRef: "meta:sourceDeclaration",
        },
        { type: "bullets", items: ["我方在小红书的声量低于竞品", "竞品内容以测评与开箱为主"], sourceRef: "phase:intel" },
        {
          type: "kpi",
          items: [
            { label: "覆盖平台", value: "3", unit: "个" },
            { label: "我方", value: "待甲方确认", tier: "low" },
          ],
          sourceRef: "phase:intel",
        },
        {
          type: "table",
          columns: ["维度", "我方", "竞品基准"],
          rows: [["公开发声量", "低", "中"]],
          caption: "「我方」列仅在有自有品牌时才有值",
          sourceRef: "phase:intel",
        },
        {
          type: "chart",
          chartType: "bar",
          series: [{ name: "我方声量", points: [{ x: "抖音", y: 12 }, { x: "我方", y: 3 }] }],
          axis: { xLabel: "平台", yLabel: "我方声量占比" },
          sourceRef: "phase:intel",
        },
        {
          type: "matrix",
          xLabel: "价格带",
          yLabel: "我方内容形态数",
          cells: [
            { x: 1, y: 2, label: "竞品 A" },
            { x: 3, y: 1, label: "我方" },
          ],
          sourceRef: "phase:intel",
        },
        {
          type: "timeline",
          phases: [{ label: "我方预热期", from: "2026-10-01", to: "2026-10-07", items: ["我方发布 3 条短视频", "竞品保持静默"] }],
          sourceRef: "phase:intel",
        },
        { type: "quote", text: "我方要抢首屏", attribution: "我方", sourceRef: "phase:intel" },
        { type: "callout", tone: "warn", text: "我方品牌资产未获授权，本页仅作定性判断。", sourceRef: "phase:intel" },
        { type: "image", ref: "https://example.com/struct.png", caption: "我方投放结构示意", sourceRef: "phase:intel" },
      ],
      citations: [
        { claim: "我方抖音账号近 30 天互动率 3.2%", kind: "data_source", ref: { sourceKey: "mc_dy" }, confidence: 0.5, tier: "low", verifiedBy: "auto" },
        { claim: "公开采集样本覆盖 3 个平台", kind: "data_source", ref: { sourceKey: "mc_dy" }, confidence: 0.6, tier: "medium", verifiedBy: "auto" },
      ],
    },
  ],
};

test("WP-B-9 R14：未指定自有品牌时，任何槽位出现「我方」口径都判错，且机械修复后仍能过校验", () => {
  const scan = stripOwnBrandLeak(leakyDsl, { apply: false });
  // 逐个槽位族都要被抓到：漏掉任何一族，"修复后仍报错 → 拒绝渲染"的死结就会复现
  for (const frag of [
    "meta.title",
    "coverage",
    "exclusions[0].reason",
    "slides[0].title",
    ".content",
    ".items[0]",
    ".items", // kpi
    ".columns[1]",
    ".caption",
    ".series[0].name",
    ".axis.yLabel",
    ".cells[1].label",
    ".phases[0].label",
    ".attribution",
    ".citations[0].claim",
  ]) {
    assert.ok(
      scan.hits.some((h) => h.path.includes(frag)),
      `槽位 ${frag} 上的违禁词必须被扫描到（漏一个 = 修复后仍报错 = 报告整份丢失）`,
    );
  }

  // 指定了自有品牌时**不**触发：这些字样在那种报告里是合法的（品牌自诊页本来就要写「我方」）
  assert.equal(
    validateReportDsl(leakyDsl, { hasOwnBrand: true }).issues.filter((i) => i.message.includes("我方")).length,
    0,
    "有自有品牌时 R14 必须沉默",
  );
  assert.equal(autoRepair(leakyDsl, { hasOwnBrand: true }).dsl.slides[1]!.title, "数据来源与口径声明");

  const before = validateReportDsl(leakyDsl, { hasOwnBrand: false });
  const r14 = before.issues.filter((i) => i.message.includes("我方"));
  assert.equal(r14.length, 1, "R14 聚合成一条 error（样例只列前 3 处）");
  assert.equal(r14[0]!.level, "error");
  assert.equal(r14[0]!.repairable, true, "必须标可机械修复 —— 否则渲染期会直接拒绝整份报告");
  assert.equal(before.ok, false);

  const { dsl: fixed, actions, cosmeticActions } = autoRepair(leakyDsl, { hasOwnBrand: false });
  assert.equal(OWN_BRAND_LEAK_RE.test(JSON.stringify(fixed)), false, "修复后整份 DSL 不得再出现「我方 / 本品 / 本方 / 品牌自诊」");
  const post = validateReportDsl(fixed, { hasOwnBrand: false });
  assert.equal(post.ok, true, `修复后必须过校验（否则 compile 抛错、报告丢失）：${JSON.stringify(post.issues)}`);
  assert.ok(actions.length + cosmeticActions.length > 0, "每一处改动都要留下可回溯的 action");

  // 结构不能因为剔除而塌掉
  const s1 = fixed.slides[1]!;
  assert.equal(fixed.slides.length, 2, "页数不变");
  const table = s1.blocks.find((b) => b.type === "table");
  assert.ok(table && table.type === "table");
  assert.deepEqual(table.columns, ["维度", "竞品基准"], "「我方」列整列删除，其余列保留");
  assert.deepEqual(table.rows, [["公开发声量", "中"]], "行要与列同步裁掉，不能错位");
  assert.equal(table.caption, "列仅在有自有品牌时才有值", "表注里的「我方」按词摘掉（不是整段删）");
  const bullets = s1.blocks.find((b) => b.type === "bullets");
  assert.ok(bullets && bullets.type === "bullets");
  assert.deepEqual(bullets.items, ["竞品内容以测评与开箱为主"], "只删讲自有品牌的条目，其余条目保留");
  const quote = s1.blocks.find((b) => b.type === "quote");
  assert.ok(quote && quote.type === "quote");
  assert.equal(quote.attribution, undefined, "出处整个就是违禁词时连同槽位一起删掉");
  assert.equal(quote.text, "本轮未指定自有品牌，本页只呈现公开市场与竞品信息。", "必填文本被摘空时用中性文案补位（不删块）");
  const image = s1.blocks.find((b) => b.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.caption, "投放结构示意", "图注按词摘，保留其余信息");
  const matrix = s1.blocks.find((b) => b.type === "matrix");
  assert.ok(matrix && matrix.type === "matrix");
  assert.deepEqual(matrix.cells.map((c) => c.label), ["竞品 A", "—"], "点位标签被摘空时用中性占位，避免空标签");
  const chart = s1.blocks.find((b) => b.type === "chart");
  assert.ok(chart && chart.type === "chart");
  assert.equal(chart.series[0]!.name, "声量", "短标签按词摘（「我方声量」→「声量」），保留可用信息");
  assert.equal(chart.axis?.yLabel, "声量占比");
});

test("WP-B-10 R14 的分级：负面声明按观感级修复（不脏任务），带数字的越界断言必须标脏", () => {
  // 真机形状（job_0mv86by83ilvbnn0h1a 的口径页）：模型主动写"不含任何我方或本品数据"。
  // 它是在守规矩，但读者看到的是同一串字 —— 规则必须连它一起拦，否则这条校验形同虚设。
  const briefWithNote = { ...brief, ownBrandId: undefined };
  const dsl = synthReport(briefWithNote, { intel: synthIntel(brief, noTools) }, { synthesized: true });
  const patched: ReportDsl = {
    ...dsl,
    slides: dsl.slides.map((s, i) =>
      i === 1
        ? {
            ...s,
            blocks: [
              { type: "text", style: "body", content: "本报告所有量化指标均来源于公开采集。由于未指定自有品牌，报告中不包含任何「我方」或「本品」的自诊数据。", sourceRef: "meta:sourceDeclaration" },
              ...s.blocks,
            ],
          }
        : s,
    ),
  };

  const { dsl: fixed, actions, cosmeticActions } = autoRepair(patched, { hasOwnBrand: false });
  const text = fixed.slides[1]!.blocks[0];
  assert.ok(text && text.type === "text");
  assert.equal(text.content, "本报告所有量化指标均来源于公开采集。", "只删那一句负面声明，同段其余内容原样保留");
  assert.equal(cosmeticActions.filter((a) => a.includes("我方")).length, 1);
  assert.equal(actions.filter((a) => a.includes("我方")).length, 0, "纯措辞、不含数字 → 不该把一份完好报告标成「产出不完整」");
  assert.equal(validateReportDsl(fixed, { hasOwnBrand: false }).ok, true);

  // 反面：如果是**带数字的越界断言**，删掉它属于数据级修复，必须标脏
  const forge: ReportDsl = {
    ...fixed,
    slides: fixed.slides.map((s, i) =>
      i === 1
        ? { ...s, blocks: [{ type: "text", style: "body", content: "我方抖音账号近 30 天互动率 3.2%。", sourceRef: "meta:sourceDeclaration" }, ...s.blocks] }
        : s,
    ),
  };
  const r = autoRepair(forge, { hasOwnBrand: false });
  assert.equal(r.actions.filter((a) => a.includes("我方")).length, 1, "带数字的我方断言被删属于数据级改动");
  assert.equal(r.cosmeticActions.filter((a) => a.includes("我方")).length, 0);
});

/* ── WP-B-11/12 兜底竞品表的真实素材（2026-10-16）─────────────────────────
 * 业主反馈：竞品表六行全是「待核验（本轮无竞品情报来源）」，'没有核验数据给到我，
 * 没有意义'。而兜底当时手里其实有素材：行业级联网检索命中了 4 条报道、平台缓存里
 * 有几百条含品牌名的内容 —— 一个都没用上。修法：intel 预取按品牌各投一次联网检索
 * （key = `web_search_brand_${brand}`），兜底把命中标题**逐字引用**进竞品表
 * （标「公开报道口径，未经核验」，不解析数字、不编造），再用平台证据按品牌名
 * 统计真实内容条数。 */

const evBrief = {
  industry: "两轮出行",
  category: "电动车",
  platforms: ["douyin", "xiaohongshu", "bilibili"],
  window: { from: "2026-10-01", to: "2026-12-31" },
  brandIds: ["雅迪", "九号", "爱玛"],
  budget: { amount: 3_000_000 },
};

test("WP-B-11 兜底竞品表：有品牌级检索/平台内容时必须引用公开口径，而不是整列「待核验」", () => {
  const tools = {
    web_search_brand_雅迪: {
      result: { results: [{ title: "雅迪冠能3上市 售价4199元起", siteName: "新浪财经", url: "https://example.com/yadea" }] },
    },
    [PLATFORM_DIGEST_TOOL_NAME]: {
      result: {
        rows: [
          { platform: "douyin", id: "d1", title: "雅迪冠能3 续航实测", text: "高速路 200 公里", author: "超哥超车" },
          { platform: "douyin", id: "d2", title: "九号 E 系列开箱", text: "智能化配置", author: "工控圈" },
          { platform: "bilibili", id: "b1", title: "九号 vs 雅迪 对比评测", text: "同价位对比", author: "者也" },
        ],
      },
    },
  };

  const intel = synthIntel(evBrief, tools);
  const byName = new Map(intel.competitors.map((c) => [c.name, c]));

  // 雅迪：检索命中 + 平台内容双路都有素材
  const yadea = byName.get("雅迪")!;
  assert.match(yadea.positioning, /^公开报道口径（未经核验）：新浪财经：雅迪冠能3/);
  assert.match(yadea.priceBand, /4199/, "标题里的价格信息逐字引用（不是解析出的数字）");
  assert.ok(yadea.keyClaims.some((k) => k.includes("雅迪冠能3上市")));
  assert.match(yadea.contentMatrix[0]!.form, /公开可见内容 2 条/, "平台证据按品牌名匹配（对比评测两条都含「雅迪」）");
  assert.equal(yadea.contentMatrix[0]!.share, null, "样本内条数不能换算成声量份额 —— 口径不同");
  assert.equal(yadea.confidence > 0.3, true);

  // 九号：没有品牌级检索命中，但平台内容有 → 至少内容条数是真实的
  const ninebot = byName.get("九号")!;
  assert.match(ninebot.contentMatrix[0]!.form, /公开可见内容 2 条/);
  assert.match(ninebot.positioning, /待核验/, "无检索命中时定位仍如实待核验 —— 不拿平台标题冒充报道");

  // 爱玛：两路全空 → 保持「待核验」，绝不编
  const aima = byName.get("爱玛")!;
  assert.match(aima.positioning, /待核验/);
  assert.equal(aima.confidence, 0.3);

  // 品牌检索命中要进 citations（读者能点回来源）
  assert.ok(intel.citations.some((c) => c.claim.includes("雅迪冠能3上市")), "品牌检索引用不能缺席");

  // 兜底产物必须能过自己的 schema（有数字/有引用的硬校验）
  CompetitorIntelSchema.validate(intel);
});

test("WP-B-12 兜底竞品表：无任何素材时行为不变（整列待核验、置信度 0.3）", () => {
  const intel = synthIntel(evBrief, {});
  for (const c of intel.competitors) {
    assert.match(c.positioning, /待核验/);
    assert.equal(c.confidence, 0.3);
    assert.equal(c.shareOfVoice, null);
  }
  assert.equal(intel.competitors.length >= 3, true);
  CompetitorIntelSchema.validate(intel);
});

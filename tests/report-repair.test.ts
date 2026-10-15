/**
 * 渲染期自动修复的分级语义（actions vs cosmeticActions）+ 降级上报的合并语义。
 *
 * 不变量 1：只影响观感的修复（结构页/免责页上不含数字的装饰性引用）**不得**把任务
 * 标成 partial——orchestrator 只把 actions（data 级）写进 job.degraded。
 * 历史事故：真机 job 的免责页出现一条「把 meta:disclaimer 当数据来源」的引用，
 * 被降级后整个 15 页完好报告被标成「产出不完整」，状态语义失真。
 *
 * 不变量 2：同 (reason, sources) 分组的降级记录必须**合并 missing**，
 * 否则同组更早的项会被静默覆盖（同一真机 job 实际 5 处修复只上报了 1 条）。
 *
 * 不变量 3（2026-10-13 事故后新增）：**autoRepair 不得制造出新的 error**。
 * 「校验」与「修复」对同一件事（逻辑命名空间引用算不算有效引用）必须有同一套判定，
 * 否则会出现「修复前算通过、修复后变硬失败」→ render.compile 抛错 → 报告整份丢失。
 *
 * 不变量 4：**深度下限必须是可达解**。下限要求的所有块型都必须是本链路真能产出的；
 * image 需要外部图片素材（ref 只放行 https:// 与 data:image/，链路不下发任何图片 URL），
 * 拿它凑数只会换来一个渲染时被摘掉的空块 —— 缺口文案还必须点名"缺哪种"，否则回喂无意义。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  autoRepair,
  BLOCK_TYPE_HINTS,
  DEFAULT_DEPTH_POLICY,
  describeDepthPolicy,
  LOGICAL_REFS,
  measureReportDepth,
  USABLE_BLOCK_TYPES,
  validateReportDsl,
  type Block,
  type ReportCitation,
  type ReportDsl,
  type SlideSpec,
  type SourceCatalog,
} from "@brandsale/contracts";
import { migrate, openDb, Repositories } from "@brandsale/storage";
import { loadConfig } from "@brandsale/config";
import { RenderService } from "@brandsale/render";

const CATALOG: SourceCatalog = {
  entries: [
    { key: "mc_xhs", displayName: "小红书公开内容", grade: "L3", origin: "external", asOf: "2026-10-12", coverage: "search/content_detail/comments" },
  ],
  logicalRefs: [],
};

const cite = (overrides: Partial<ReportCitation>): ReportCitation => ({
  claim: "某结论",
  kind: "data_source",
  ref: { sourceKey: "mc_xhs" },
  confidence: 0.8,
  tier: "medium",
  verifiedBy: "auto",
  ...overrides,
});

const slide = (index: number, pageRole: SlideSpec["pageRole"], citations: ReportCitation[], blocks: Block[] = []): SlideSpec => ({
  index,
  pageRole,
  title: `页 ${index}`,
  layoutId: "content/default",
  blocks,
  citations,
});

const dsl = (slides: SlideSpec[]): ReportDsl => ({
  meta: {
    dslVersion: "1.0",
    title: "测试报告",
    brand: { id: "b1", name: "品牌" },
    window: { from: "2026-10-01", to: "2026-10-31" },
    generatedAt: "2026-10-12T00:00:00.000Z",
  },
  sourceDeclaration: {
    grade: "L3",
    sources: [{ key: "mc_xhs", displayName: "小红书公开内容", grade: "L3", asOf: "2026-10-12", coverage: "search" }],
    exclusions: [],
  },
  slides,
});

test("① 逻辑引用命名空间被当成数据来源 → 引用被移除，且只记 cosmetic", () => {
  const input = dsl([
    slide(0, "closing", [cite({ claim: "免责与口径声明", ref: { sourceKey: "meta:disclaimer" }, tier: "high", confidence: 1 })]),
  ]);
  const { dsl: fixed, actions, cosmeticActions } = autoRepair(input, { catalog: CATALOG });

  const closing = fixed.slides[0]!;
  assert.equal(closing.citations.length, 0, "meta:* 不是数据源，引用应被直接移除而不是降级保留");
  assert.equal(actions.length, 0, "装饰性修复不得进入 data 级 actions");
  assert.equal(cosmeticActions.length, 1);
  assert.match(cosmeticActions[0]!, /meta:disclaimer/);
});

test("② 内容页上含数字的未声明来源引用 → data 级（必须标 partial）", () => {
  const input = dsl([slide(0, "content", [cite({ claim: "小红书声量占比 45%，环比翻倍", ref: { sourceKey: "mc_unknown" } })])]);
  const { actions, cosmeticActions } = autoRepair(input, { catalog: CATALOG });

  assert.equal(actions.length, 1, "数据断言的出处修复必须计入 degraded");
  assert.match(actions[0]!, /mc_unknown/);
  assert.equal(cosmeticActions.length, 0);
});

test("③ 结构页上不含数字的降级 → cosmetic；附录页含数字 → data", () => {
  const input = dsl([
    // 免责页：模型编了一条不含数字的来源引用
    slide(0, "closing", [cite({ claim: "本报告基于公开信息整理", ref: { sourceKey: "mc_unknown" } })]),
    // 附录页：含数字的引用仍按数据修复对待
    slide(1, "appendix", [cite({ claim: "采集 500 条内容", ref: { sourceKey: "mc_unknown" } })]),
  ]);
  const { actions, cosmeticActions } = autoRepair(input, { catalog: CATALOG });

  assert.equal(cosmeticActions.length, 1);
  assert.match(cosmeticActions[0]!, /本报告基于公开信息整理/);
  assert.equal(actions.length, 1);
  assert.match(actions[0]!, /采集 500 条内容/);
});

test("④ 同一 action 文本不会同时出现在两个分级里（渲染层按文本查 severity 不能撞车）", () => {
  const input = dsl([
    slide(0, "closing", [cite({ claim: "免责说明", ref: { sourceKey: "mc_unknown" } })]),
    slide(1, "content", [cite({ claim: "免责说明", ref: { sourceKey: "mc_unknown" } })]),
  ]);
  const { actions, cosmeticActions } = autoRepair(input, { catalog: CATALOG });

  assert.equal(actions.length, 1, "内容页走 data");
  assert.equal(cosmeticActions.length, 1, "结构页走 cosmetic");
  assert.notEqual(actions[0], cosmeticActions[0], "两档即使 claim 相同也必须可区分（页码前缀不同）");
});

test("⑤ 同组降级合并 missing，而不是覆盖（真机 5 处修复只上报 1 条的事故）", () => {
  const db = openDb(":memory:");
  migrate(db);
  const repos = new Repositories(db);
  repos.jobs.create({ jobId: "job_merge", tenantId: "t_demo", createdBy: "u_demo", spec: {} as never, idempotencyKey: "k1" });

  for (const m of ["修复A", "修复B", "修复C"]) {
    repos.jobs.addDegraded("job_merge", { missing: [m], reason: "partial_output", note: "渲染期自动修复" });
  }
  const job = repos.jobs.get("job_merge")!;
  assert.equal(job.degraded.length, 1, "同 (reason, sources) 分组仍只保留一条");
  assert.deepEqual(job.degraded[0]!.missing, ["修复A", "修复B", "修复C"], "missing 必须逐条累积，不能只剩最后一条");

  // 重复上报同一条不得产生重复项
  repos.jobs.addDegraded("job_merge", { missing: ["修复B"], reason: "partial_output", note: "渲染期自动修复" });
  assert.deepEqual(repos.jobs.get("job_merge")!.degraded[0]!.missing, ["修复A", "修复B", "修复C"]);
  db.close();
});

test("⑥ compile 把装饰性修复标成 severity=cosmetic（编排层据此跳过 degraded）", async () => {
  const r = new RenderService(loadConfig(process.cwd(), { BM_LLM_MODE: "mock" }));
  const compiled = await r.compile(
    dsl([
      slide(0, "cover", []),
      slide(1, "closing", [cite({ claim: "免责与口径声明", ref: { sourceKey: "meta:disclaimer" }, tier: "high", confidence: 1 })]),
    ]),
    { catalog: CATALOG },
  );

  assert.equal(compiled.repairs.length, 1);
  assert.equal(compiled.repairs[0]!.severity, "cosmetic", "编排层只跳过 cosmetic，标错就等于继续误判 partial");
  assert.match(compiled.repairs[0]!.action, /meta:disclaimer/);
});

test("⑦ 重跑阶段前清空旧降级记录（修掉的原因不该跟着重跑复活）", () => {
  const db = openDb(":memory:");
  migrate(db);
  const repos = new Repositories(db);
  repos.jobs.create({ jobId: "job_rerun", tenantId: "t_demo", createdBy: "u_demo", spec: {} as never, idempotencyKey: "k2" });
  repos.jobs.addDegraded("job_rerun", { missing: ["旧问题"], reason: "partial_output", note: "渲染期自动修复" });
  assert.equal(repos.jobs.get("job_rerun")!.degraded.length, 1);

  repos.jobs.clearDegraded("job_rerun");
  assert.deepEqual(repos.jobs.get("job_rerun")!.degraded, [], "重跑必须从零开始统计降级");
  db.close();
});

/**
 * ⑧ 回归：真机事故 job_0mv5ydf69a7aio1uhfd（2026-10-13）——报告整份丢失。
 *
 * 现场：模型把 `phase:budget` / `meta:sourceDeclaration` 这类**块级 sourceRef 的命名空间**
 * 写进了 citations（提示词同时教了两套写法）。旧实现把这类引用**直接删掉**，
 * 本页 citations 随即归零，而 R6 只看 citations 是否为空 →
 * 同一次 compile 里「修复前算通过、修复后变硬失败」，`repairable` 又没置位 →
 * render.compile 抛「拒绝渲染」，21KB 的 DSL 落库了、report_html 永远不会产出来。
 *
 * 不变量：**autoRepair 不得制造出新的 error** —— 修复后的 DSL 必须能过校验、能渲染。
 */
const PROD_CATALOG: SourceCatalog = { entries: CATALOG.entries, logicalRefs: [...LOGICAL_REFS] };

test("⑧ 逻辑引用被误当来源 → 改挂块级 sourceRef；修复后的 DSL 仍能通过校验与渲染", async () => {
  const input = dsl([
    slide(
      0,
      "content",
      [cite({ claim: "预算分配", ref: { sourceKey: "phase:budget" } })],
      [
        { type: "kpi", items: [{ label: "总预算", value: "2000000", unit: "CNY", tier: "high" }] },
        { type: "text", style: "body", content: "本页为定性判断。" },
      ],
    ),
  ]);

  const { dsl: fixed, actions, cosmeticActions } = autoRepair(input, { catalog: PROD_CATALOG });
  const page = fixed.slides[0]!;

  assert.equal(page.citations.length, 0, "逻辑引用不是数据源，不能留在 citations");
  assert.equal(cosmeticActions.length, 1);
  assert.match(cosmeticActions[0]!, /phase:budget/);
  assert.equal(actions.length, 0, "改挂 sourceRef 不改写任何数据断言，仍属观感修复");

  const kpi = page.blocks[0] as { sourceRef?: string };
  assert.equal(kpi.sourceRef, "phase:budget", "含数字的块必须拿到块级 sourceRef（这正是 R6 要的）");
  assert.equal(
    (page.blocks[1] as { sourceRef?: string }).sourceRef,
    undefined,
    "不含数字的块不该被顺手挂上来源（最小改动）",
  );

  const post = validateReportDsl(fixed, { catalog: PROD_CATALOG });
  assert.equal(
    post.issues.filter((i) => i.level === "error").length,
    0,
    "修复动作本身不得制造新的 error —— 这就是事故的根因",
  );
  assert.equal(post.ok, true);

  // 端到端：compile 不再抛「报告 DSL 校验失败，拒绝渲染」
  const r = new RenderService(loadConfig(process.cwd(), { BM_LLM_MODE: "mock" }));
  const compiled = await r.compile(fixed, { catalog: PROD_CATALOG });
  assert.ok(String(compiled.ref.inline).length > 0, "报告必须真的产出内容");
  assert.equal(compiled.repairs.length, 0, "修复已在 autoRepair 阶段完成，compile 不应再记二次修复");
});

test("⑨ R6 与 autoRepair 用同一套「有效引用」判定：逻辑命名空间引用不算引用", () => {
  // 同一份 DSL：citations 里只有一条把 phase:budget 当来源的引用，且该页含数字块、块上无 sourceRef
  const input = dsl([
    slide(0, "content", [cite({ claim: "预算分配", ref: { sourceKey: "phase:budget" } })], [
      { type: "kpi", items: [{ label: "总预算", value: "2000000", unit: "CNY", tier: "high" }] },
    ]),
  ]);

  const issues = validateReportDsl(input, { catalog: PROD_CATALOG }).issues;
  const r6 = issues.filter((i) => i.path === "slides[0]" && i.message.includes("无来源的数字断言"));
  assert.equal(r6.length, 1, "校验期就要报出来，否则这条错误永远进不了回喂清单（旧实现正是如此）");
  assert.equal(r6[0]!.repairable, undefined, "R6 依旧不可机械修复（只能回喂/降级，不能静默改写结论）");

  // 换成真实来源 → 不再报
  const ok = dsl([
    slide(0, "content", [cite({ claim: "预算分配", ref: { sourceKey: "mc_xhs" } })], [
      { type: "kpi", items: [{ label: "总预算", value: "2000000", unit: "CNY", tier: "high" }] },
    ]),
  ]);
  assert.equal(
    validateReportDsl(ok, { catalog: PROD_CATALOG }).issues.filter((i) => i.message.includes("无来源的数字断言")).length,
    0,
  );
});

test("⑩ 深度下限必须是可达解：必需块型 ⊆ 可用块型，image 不得进下限", () => {
  const usable = new Set<string>(USABLE_BLOCK_TYPES);

  assert.ok(
    !usable.has("image"),
    "image 必须排除在「可用块型」之外：链路不下发图片 URL，写它只会在渲染时被摘掉（白写且不算块型数）",
  );

  for (const t of DEFAULT_DEPTH_POLICY.requiredBlockTypes) {
    assert.ok(usable.has(t), `必需块型 ${t} 在本链路不可达 —— 模型永远凑不齐，报告会永久 partial`);
  }

  assert.ok(
    DEFAULT_DEPTH_POLICY.minBlockTypes <= USABLE_BLOCK_TYPES.length,
    `下限 ${DEFAULT_DEPTH_POLICY.minBlockTypes} 超过可用块型总数 ${USABLE_BLOCK_TYPES.length}，属于不可能达成的约束`,
  );

  for (const t of USABLE_BLOCK_TYPES) {
    assert.ok(BLOCK_TYPE_HINTS[t]?.length > 0, `${t} 缺少用途说明，提示词清单会留下空条目`);
  }
});

test("⑪ 块型缺口必须点名「还没用上的可用块型」，否则回喂没有可执行性", () => {
  // 真机事故原型：只用到 8 种块型，而 gap 只说「只用到 8 种（下限 9）」—— 模型无从知道该补哪种
  const thin = dsl([
    slide(0, "content", [cite({})], [{ type: "bullets", items: ["a", "b", "c"], sourceRef: "phase:intel" }]),
  ]);
  const depth = measureReportDepth(thin, { ...DEFAULT_DEPTH_POLICY, minSlides: 1 });
  const gap = depth.gaps.find((g) => g.includes("block type"));
  assert.ok(gap, "块型不足必须产生 gap");
  assert.ok(gap!.includes("还没用上"), `gap 必须列出未使用的可用块型；实际：${gap}`);
  assert.ok(gap!.includes("quote"), "quote 是本次实际可补、也是事故中缺的那种块型，必须被点名");
  assert.ok(!/image（/.test(gap!), "不可达的 image 不能出现在「还没用上」清单里（那是错误建议）");

  // 第一道（提示词）与第二道（回喂）同源：清单、条数、image 禁令都要在策略文案里
  const text = describeDepthPolicy();
  for (const t of USABLE_BLOCK_TYPES) assert.ok(text.includes(t), `颗粒度下限文案缺少块型 ${t}`);
  assert.ok(text.includes("image"), "必须明写「不要用 image」及原因，否则模型仍会拿它凑块型数");
  assert.ok(
    text.includes(String(USABLE_BLOCK_TYPES.length)),
    "清单条数要与实际可用块型数一致（写死的数字会随契约漂移）",
  );
});

/**
 * ⑫ ⑬ 缺失声明被写成了引用（真机 job_0mv86by83ilvbnn0h1a 的 slides[7]）。
 *
 * 现场：模型写 `{"kind":"data_source","ref":{"sourceKey":"pricing"},"claim":"所有候选人报价未采集"}`。
 * 旧实现把它当"引用了未声明的来源"降级 → 报告里凭空多出一条**「模型推断：所有候选人报价未采集」**，
 * 而且任务被标成 partial——读者看到的是"缺失"，状态说的是"产出不完整"，语义正好相反。
 * 缺失不是数据来源，更不是推断：它在同页 callout 里已经写过一遍了。
 */
test("⑫ 缺失声明写成引用 → 移除且只记 cosmetic；不得造出「模型推断」条目、不得误挂无关块", () => {
  const input = dsl([
    slide(
      0,
      "data",
      [
        cite({ claim: "品牌声量占比 45%", ref: { sourceKey: "mc_xhs" }, tier: "low" }),
        cite({ claim: "所有候选人报价未采集", ref: { sourceKey: "pricing" }, tier: "low" }),
      ],
      [
        { type: "table", columns: ["昵称", "粉丝量"], rows: [["硬件茶谈", "3968624"]], sourceRef: "phase:creator" },
        { type: "callout", tone: "warn", text: "报价未采集，投放前须人工询价与档期确认。" },
      ],
    ),
  ]);

  const { dsl: fixed, actions, cosmeticActions } = autoRepair(input, { catalog: PROD_CATALOG });
  const page = fixed.slides[0]!;

  assert.equal(page.citations.length, 1, "缺失声明不能留在 citations（真实来源那条不受影响）");
  assert.equal(page.citations[0]!.ref.sourceKey, "mc_xhs");
  assert.ok(
    !page.citations.some((c) => c.kind === "model_inference"),
    "缺失不是推断——造一条「模型推断：报价未采集」比不写更糟",
  );
  assert.equal(actions.length, 0, "缺失声明不承载数据断言，不该把完好报告标成「产出不完整」");
  assert.equal(cosmeticActions.length, 1);
  assert.match(cosmeticActions[0]!, /未采集/);

  const post = validateReportDsl(fixed, { catalog: PROD_CATALOG });
  assert.equal(post.issues.filter((i) => i.level === "error").length, 0, "移除动作不得制造新的 error");
});

test("⑬ R6 保护：缺失声明是本页唯一引用时**不移除**（宁可多一条引用，不可丢报告）", () => {
  // 本页有含数字且无 sourceRef 的块，且这条缺失声明是唯一 citation。
  // 若移除，citations 归零 → R6 报一条 repairable:false 的 error → compile 抛错、报告整份丢失
  // （job_0mv5ydf69a7aio1uhfd 的事故形态）。此时保守回退到原来的降级路径。
  const input = dsl([
    slide(
      0,
      "data",
      [cite({ claim: "所有候选人报价未采集", ref: { sourceKey: "pricing" }, tier: "low" })],
      [{ type: "table", columns: ["昵称"], rows: [["硬件茶谈"]], caption: "共 3 位候选人" }],
    ),
  ]);

  const { dsl: fixed, actions } = autoRepair(input, { catalog: PROD_CATALOG });
  const page = fixed.slides[0]!;

  assert.equal(page.citations.length, 1, "移除会让本页归零并触发不可修复的 R6 error → 必须保留");
  assert.equal(page.citations[0]!.kind, "model_inference", "回退路径就是原来的降级（可见地标成推断）");
  assert.equal(actions.length, 1, "回退意味着仍按数据级上报——这是刻意的保守取舍");
  assert.equal(validateReportDsl(fixed, { catalog: PROD_CATALOG }).ok, true);
});

test("⑭ low 置信度 KPI 缺 warn callout → 自动补，且只记 cosmetic（补的是合规提示，不是数据）", () => {
  const input = dsl([
    slide(
      0,
      "content",
      [cite({ claim: "品牌声量占比 45%", ref: { sourceKey: "mc_xhs" }, tier: "low" })],
      [{ type: "kpi", items: [{ label: "Q4 大促预算占比", value: "60", unit: "%", tier: "low" }] }],
    ),
  ]);

  const { dsl: fixed, actions, cosmeticActions } = autoRepair(input, { catalog: PROD_CATALOG });
  const page = fixed.slides[0]!;

  assert.equal(actions.length, 0, "补 callout 不改写任何数字也不丢出处 → 不该把完好报告标成「产出不完整」");
  assert.equal(cosmeticActions.length, 1);
  assert.match(cosmeticActions[0]!, /warn callout/);
  assert.ok(
    page.blocks.some((b) => b.type === "callout" && b.tone === "warn"),
    "callout 必须真的补上去（补记 cosmetic 不等于不补）",
  );
});

/**
 * ⑮ 逻辑引用的**裸写**形式。
 *
 * `REF_ALIASES` 早就把 `pricing` 归一到 `tool:pricing`，但引用形态判定只对**带前缀**的字符串做正则，
 * 别名表根本没参与——写 `tool:pricing` 会被"降落"到块级 sourceRef，写裸的 `pricing` 却掉进降级路径。
 * 同一个东西两种命运，只取决于模型有没有敲那个前缀。
 */
test("⑮ 裸写的逻辑引用与带前缀等价：落回块级 sourceRef，而不是降级标脏", () => {
  const input = dsl([
    slide(
      0,
      "content",
      [cite({ claim: "报价区间 1–3 万", ref: { sourceKey: "pricing" } })],
      [{ type: "kpi", items: [{ label: "报价区间", value: "30000", unit: "CNY", tier: "medium" }] }],
    ),
  ]);

  const { dsl: fixed, actions, cosmeticActions } = autoRepair(input, { catalog: PROD_CATALOG });
  const page = fixed.slides[0]!;

  assert.equal(page.citations.length, 0, "pricing 是工具产物的逻辑引用，不是数据源");
  assert.equal((page.blocks[0] as { sourceRef?: string }).sourceRef, "tool:pricing");
  assert.equal(actions.length, 0, "落回块级 sourceRef 比降级更正确，不该标脏");
  assert.match(cosmeticActions[0]!, /tool:pricing/);

  // 不认识的自造 key 必须继续降级 —— 那不是逻辑引用，是编造
  const bogus = dsl([
    slide(0, "content", [cite({ claim: "声量占比 45%", ref: { sourceKey: "mc_unknown" } })], [
      { type: "kpi", items: [{ label: "占比", value: "45", unit: "%", tier: "high" }] },
    ]),
  ]);
  const r = autoRepair(bogus, { catalog: PROD_CATALOG });
  assert.equal(r.actions.length, 1, "mc_unknown 不是别名能归一的写法，必须按数据级上报");
});

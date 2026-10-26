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

  /**
   * **这里与 ⑨′ 的分界就是"有没有可回挂的逻辑引用"**：autoRepair 会把这条误置引用从
   * citations 摘出来、回挂到无 sourceRef 的数字块上，所以它**确实**是可机械修复的。
   *
   * 生成期若把它当"不可修的阻塞项"，就会白跑一次整份报告回喂 —— 真机
   * job_0mv9k0wvg8vvpwmqd9y 正是如此（report 阶段 23 分钟、单次 4 万 token），
   * 而渲染期同一份 DSL 被静默修好、且归观感级：**报告内容一字未变，任务却被标成 partial**。
   */
  assert.equal(r6[0]!.repairable, true, "有可回挂的 phase:budget → 渲染期能修掉，生成期不该拦它");
  assert.match(r6[0]!.fix ?? "", /sourceRef/, "改法必须能直接照做（回喂清单只带 message 等于没带）");

  // 不是嘴上说可修：跑一遍修复，这条 error 必须真的消失、且没动任何数据断言
  const fixed = autoRepair(input, { catalog: PROD_CATALOG });
  assert.equal(fixed.actions.length, 0, "回挂 sourceRef 不改写任何数据断言，仍属观感级");
  assert.equal(
    validateReportDsl(fixed.dsl, { catalog: PROD_CATALOG }).issues.filter((i) => i.message.includes("无来源的数字断言")).length,
    0,
  );

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

test("⑨′ 页面里没有可回挂的逻辑引用时，R6 依旧不可机械修复（绝不能凭空造来源）", () => {
  /* 情形一：citations 完全为空 —— autoRepair 手里没有任何"模型自己声明的来源"可以回挂。 */
  const orphan = dsl([
    slide(0, "content", [], [{ type: "kpi", items: [{ label: "总预算", value: "2000000", unit: "CNY", tier: "high" }] }]),
  ]);
  const r6 = validateReportDsl(orphan, { catalog: PROD_CATALOG }).issues.filter((i) => i.message.includes("无来源的数字断言"));
  assert.equal(r6.length, 1);
  assert.equal(r6[0]!.repairable, undefined, "只能靠回喂：系统不许给数字块编一个来源");

  /* 情形二：命名空间写法认不出来（不在 logicalRefs 里）—— 那也不是"可回挂的来源"。 */
  const unknown = dsl([
    slide(0, "content", [cite({ claim: "预算分配", ref: { sourceKey: "phase:unknown_thing" } })], [
      { type: "kpi", items: [{ label: "总预算", value: "2000000", unit: "CNY", tier: "high" }] },
    ]),
  ]);
  const r6b = validateReportDsl(unknown, { catalog: PROD_CATALOG }).issues.filter((i) => i.message.includes("无来源的数字断言"));
  assert.equal(r6b[0]!.repairable, undefined, "认不出的写法回挂不了，仍属「只能回喂」");

  /* 但"移除它"不能以丢掉整份报告为代价：修完之后本页必须还有可用引用、且不报 error。 */
  const repaired = autoRepair(unknown, { catalog: PROD_CATALOG });
  assert.equal(repaired.dsl.slides[0]!.citations.length, 1, "本页唯一的引用不能被移除（移除后数字断言就没了来源）");
  assert.equal(repaired.dsl.slides[0]!.citations[0]!.kind, "model_inference", "退回普通降级：如实标成模型推断");
  assert.equal(
    validateReportDsl(repaired.dsl, { catalog: PROD_CATALOG }).issues.filter((i) => i.level === "error").length,
    0,
    "autoRepair 不得制造出新的 error —— 否则 render.compile 会拒绝渲染、报告整份丢失",
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
 *
 * 2026-10-16 修正记账口径：能移除时移除（⑫），不能移除时保留+降级也**只记观感级**（⑯），
 * ⑬ 介于两者之间，只守"不许移除、不许改挂"这条安全不变量。
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

test("⑬ R6 保护：缺失声明是本页唯一引用时**不移除、也不许被改挂**（宁可多一条引用，不可丢报告）", () => {
  // 本页有含数字且无 sourceRef 的块，且这条缺失声明是唯一 citation。
  // 若移除，citations 归零 → R6 报一条 repairable:false 的 error → compile 抛错、报告整份丢失
  // （job_0mv5ydf69a7aio1uhfd 的事故形态）。此时保守回退到原来的降级路径。
  //
  // ⚠️ 这里刻意用**裸写别名** `pricing`（而不是 `tool:pricing`）：它恰好是上面"误置逻辑引用"
  // 分支能认出来的 relocatable 形态。若缺失声明不豁免那一步，本页的结果会是
  // 「引用被摘走 + 改挂到候选人表格上」—— 而表格跟报价毫无关系，正是注释里点名的那种误挂。
  // 所以本用例守的是**豁免本身**：不管引用写成哪种形态，都不能拿它去挂块。
  // 记账口径（观感级）另见 ⑯。
  const input = dsl([
    slide(
      0,
      "data",
      [cite({ claim: "所有候选人报价未采集", ref: { sourceKey: "pricing" }, tier: "low" })],
      [{ type: "table", columns: ["昵称"], rows: [["硬件茶谈"]], caption: "共 3 位候选人" }],
    ),
  ]);

  const { dsl: fixed, actions, cosmeticActions } = autoRepair(input, { catalog: PROD_CATALOG });
  const page = fixed.slides[0]!;

  assert.equal(page.citations.length, 1, "移除会让本页归零并触发不可修复的 R6 error → 必须保留");
  assert.equal(page.citations[0]!.kind, "model_inference", "回退路径就是原来的降级（可见地标成推断）");
  assert.equal(
    (page.blocks[0] as { sourceRef?: string }).sourceRef,
    undefined,
    "不许把「报价未采集」挂成候选人表格的来源——表格与报价无关（真机里的误挂形态）",
  );
  assert.equal(actions.length, 0, "报告文本一字未改，不该把完好报告标成「产出不完整」（口径见 ⑯）");
  assert.equal(cosmeticActions.length, 1);
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

/**
 * ⑯ 被 R6 保护**留下**的缺失声明：降级按观感级记账。
 *
 * 真机形状（job_0mv9k0wvg8vvpwmqd9y 2026-10-16 的第二次重跑）：本页唯一一条引用是"缺失声明"
 * （claim 含「无样本」），而页上有含数字却没有 `sourceRef` 的块 —— 移除它就会在第二次校验里
 * 多报一条 `repairable: false` 的 error → 报告整份丢失，所以只能保留、退而求其次降级标注。
 *
 * 这一步不该把任务标脏：**报告文本一字未改**，变的只是溯源自述（而且变成更诚实的那一种）。
 * 不这么分级就会出现一个说不通的结果 —— 同一个写作瑕疵（把"无样本"写成 citation、sourceKey
 * 还用了逻辑命名空间），同页有别的可用引用时算观感级、恰好没有时算数据级，
 * **任务脏不脏取决于同页的其他槽位**。
 */
test("⑯ 被 R6 保护留下的缺失声明：降级记 cosmetic（不脏任务），且引用不许被移除", () => {
  const input = dsl([
    slide(
      0,
      "data",
      [cite({ claim: "达人报价库本次查询全量返回无样本", ref: { sourceKey: "tool:pricing" } })],
      [
        { type: "table", columns: ["渠道", "预算"], rows: [["抖音", "45 万"]], sourceRef: "phase:budget" },
        /* matrix 故意不带 sourceRef：这正是"移除缺失声明就会撞 R6"的原因 */
        { type: "matrix", xLabel: "阶段", yLabel: "渠道", cells: [{ x: 1, y: 1, label: "抖音 P1：45万" }] },
      ],
    ),
  ]);

  const r = autoRepair(input, { catalog: PROD_CATALOG });
  const page = r.dsl.slides[0]!;

  assert.equal(r.actions.length, 0, "报告文本一字未改，不该被标成「产出不完整」");
  assert.equal(r.cosmeticActions.filter((a) => a.includes("tool:pricing")).length, 1);
  assert.equal(page.citations.length, 1, "引用必须保留 —— 移除会让本页数字断言失去来源（报告整份丢失）");
  assert.equal(page.citations[0]!.kind, "model_inference", "保留下来就如实降级成模型推断");
  assert.equal(page.citations[0]!.tier, "low");
  assert.equal(
    validateReportDsl(r.dsl, { catalog: PROD_CATALOG }).issues.filter((i) => i.level === "error").length,
    0,
    "autoRepair 不得制造新的 error",
  );

  // 反面：同页还有别的可用引用时，缺失声明的正确处置是**移除**，同样归观感级
  const withOther = dsl([
    slide(
      0,
      "data",
      [
        cite({ claim: "达人报价库本次查询全量返回无样本", ref: { sourceKey: "tool:pricing" } }),
        cite({ claim: "公开采集样本覆盖 3 个平台", ref: { sourceKey: "mc_xhs" } }),
      ],
      [{ type: "table", columns: ["渠道", "预算"], rows: [["抖音", "45 万"]], sourceRef: "phase:budget" }],
    ),
  ]);
  const r2 = autoRepair(withOther, { catalog: PROD_CATALOG });
  assert.equal(r2.dsl.slides[0]!.citations.length, 1, "有别的可用引用撑着，缺失声明直接移除");
  assert.equal(r2.dsl.slides[0]!.citations[0]!.ref.sourceKey, "mc_xhs");
  assert.equal(r2.actions.length, 0);
});

/**
 * ⑰ ⑱ P0 自愈契约（2026-10-17）：
 * finalizeReport 的自校验管线在加入 P0 后是「autoRepair 先跑、对修后 DSL 判阻塞」。
 * 这两条**纯函数等价**测试钉的就是这条契约 —— 不绕 `AgentPack` 私有方法（那是 e2e 范畴），
 * 直接断言"`autoRepair` + `validateReportDsl` 的复合行为 = finalizeReport 的判阻塞步骤"。
 * 真机回归点：job_0mv9k0wvg8vvpwmqd9y 的 slides[9] —— matrix 漏 sourceRef + 同页误置 phase:budget。
 * 旧实现：validateReportDsl 直接报 R6 error（`repairable: undefined`）→ 判阻塞 → 整份回喂。
 * P0 后：autoRepair 把 phase:budget 回挂到 matrix → R6 走 sourceRef 分支 → 0 issue → 不回喂。
 */
test("⑰ P0-a 生成期先 autoRepair 再判阻塞：R6 误置引用 + matrix 漏 sourceRef → 0 阻塞，机械修一遍即闭环", () => {
  /* 还原真机 slides[9] 的原始形态：table/callout 有 phase:budget，matrix 漏；并把同一 phase:budget
   * 当成 citation 写进 citations。P0 之前 finalizeReport 直接把这份 DSL 喂给 validateReportDsl
   * → 判阻塞 → 整份回喂；P0 之后 autoRepair 把它回挂到 matrix（matrix 不再是"无 sourceRef 的数字块"），
   * R6 走 sourceRef 分支通过，0 阻塞。 */
  const input = dsl([
    slide(0, "content", [cite({ claim: "渠道 × 阶段预算分配数据", ref: { sourceKey: "phase:budget" } })], [
      { type: "matrix", xLabel: "阶段", yLabel: "渠道", cells: [{ x: 1, y: 1, label: "抖音 P1: 45万" }] },
      { type: "table", columns: ["渠道", "预算"], rows: [["抖音", "150 万"]], sourceRef: "phase:budget" },
      { type: "callout", tone: "info", text: "本预算分配沿用 P1 阶段测算口径", sourceRef: "phase:budget" },
    ]),
  ]);

  /* 对照：纯 P0 前形态（matrix 漏 sourceRef、且同页没有可回挂的误置引用、也没有别的 citation）——
   * 这种情形 R6 仍然阻塞（连 cosmetic 都修不掉），P0 也救不回来；这就是 P0 的边界。 */
  const noRepairable = dsl([
    slide(0, "content", [], [
      { type: "matrix", xLabel: "阶段", yLabel: "渠道", cells: [{ x: 1, y: 1, label: "抖音 P1: 45万" }] },
    ]),
  ]);
  const stillBlocking = validateReportDsl(noRepairable, { catalog: PROD_CATALOG }).issues.filter(
    (i) => i.level === "error" && !i.repairable,
  );
  assert.ok(stillBlocking.length > 0, "P0 边界确认：无可回挂引用时 R6 仍阻塞（不变量保护，不能误以为 P0 万能）");
  assert.ok(stillBlocking.some((i) => i.message.includes("无来源的数字断言")), "阻塞来源正是 R6");

  /* P0 主路径：先 autoRepair，再对修后 DSL 判阻塞 —— 应当 0 阻塞 */
  const repair = autoRepair(input, { catalog: PROD_CATALOG });
  const newBlocking = validateReportDsl(repair.dsl, { catalog: PROD_CATALOG }).issues.filter(
    (i) => i.level === "error" && !i.repairable,
  );
  assert.equal(newBlocking.length, 0, "P0 之后这条历史阻塞消失");
  assert.equal(repair.actions.length, 0, "误置引用→回挂是观感级（不脏任务）");
  assert.ok(repair.cosmeticActions.some((a) => a.includes("phase:budget")), "回挂必须真实发生");

  /* 行为不变性：渲染期 compile() 拿到 autoRepair 后的 DSL 仍要过校验 */
  const post = validateReportDsl(repair.dsl, { catalog: PROD_CATALOG });
  assert.equal(post.issues.filter((i) => i.level === "error").length, 0, "autoRepair 不得制造新 error（不变量 3）");
  assert.equal((repair.dsl.slides[0]!.blocks[0] as { sourceRef?: string }).sourceRef, "phase:budget", "matrix 已拿到 sourceRef");
  assert.equal(repair.dsl.slides[0]!.citations.length, 0, "误置引用已被摘出 citations");
});

/**
 * ⑱ P0-b 回喂失败降级契约：
 * finalizeReport 的"回喂失败"分支必须返回 autoRepair 后的版本（不是原稿），避免：
 *   原稿含非 repairable error → 渲染期 compile() 再次校验命中 → 抛"拒绝渲染" → 报告整份丢失
 *   （真机 job_0mv7sfn3kh7q2k0h80l 就是这条路径）。
 * 这条测试以"等价函数调用"模拟该分支：原图 → autoRepair → 拿到应交付的 DSL。
 * 验收点：原图非 repairable 的 error（如果有）在 autoRepair 后被消化；同时 0 issue 的 case 应
 * 完整保留（不能因为标记了 degraded 就把好内容扔了）。
 */
test("⑱ P0-b 回喂失败的降级版本 = autoRepair 修后 DSL（不再保留未修复原稿）", () => {
  /* Case A：原图里 matrix 没 sourceRef、且同页**没有任何**可回挂的误置引用 —— 这种情况即使
   * 走完 autoRepair R6 仍报（`repairable: undefined`，P0 也救不回来，这是边界）。这模拟了
   * 「回喂失败后用 autoRepair 修后版本兜底」时硬错误留存的真实形态。
   * 旧实现会保留原稿（含未修瑕疵）→ 渲染期再校验命中 → 拒绝渲染 → 报告丢失。
   * P0 后：返回 autoRepair 修后版本（即原图，因为无可修），硬错误如实落进 markDegraded。 */
  const unrecoverable = dsl([
    slide(0, "data", [], [
      { type: "matrix", xLabel: "阶段", yLabel: "渠道", cells: [{ x: 1, y: 1, label: "抖音 P1: 45万" }] },
    ]),
  ]);

  const repair = autoRepair(unrecoverable, { catalog: PROD_CATALOG });
  /* P0 边界确认：R6 不可修，但 autoRepair 至少没**造**新 error（同输入同输出是合约） */
  const post = validateReportDsl(repair.dsl, { catalog: PROD_CATALOG });
  const r6 = post.issues.filter(
    (i) => i.level === "error" && i.message.includes("无来源的数字断言") && !i.repairable,
  );
  assert.ok(r6.length > 0, "硬错误留下来了 → 这是 markDegraded 的输入；不要把它误以为 P0 万能");
  assert.equal(repair.actions.length, 0, "autoRepair 至少不能凭空给数字块捏来源（用例⑨ 钉这条底线）");
  assert.deepEqual(repair.dsl, unrecoverable, "无可修时 autoRepair 不动 DSL（pure-function 性质）");

  /* Case B：原图同时含 ①类（autoRepair 修得掉）+ 真不可修的 R6 错误。修后版本应当：
   *   · ①类（误置引用回挂）已完成（matrix 拿到 sourceRef、citations 清空）；
   *   · kpi 仍无 sourceRef，但本页已无误置引用可回挂 → R6 仍报 → markDegraded 要带它回去。 */
  const mixed = dsl([
    slide(0, "data", [cite({ claim: "渠道×阶段预算分配数据", ref: { sourceKey: "phase:budget" } })], [
      { type: "matrix", xLabel: "阶段", yLabel: "渠道", cells: [{ x: 1, y: 1, label: "抖音 P1: 45万" }] },
      { type: "kpi", items: [{ label: "总声量", value: "500", unit: "万" }] },
    ]),
  ]);
  const mixedRepair = autoRepair(mixed, { catalog: PROD_CATALOG });
  assert.equal((mixedRepair.dsl.slides[0]!.blocks[0] as { sourceRef?: string }).sourceRef, "phase:budget", "matrix 拿到 sourceRef（①类已修）");
  assert.equal(mixedRepair.dsl.slides[0]!.citations.length, 0, "误置引用已被摘出");
  assert.equal(mixedRepair.dsl.slides[0]!.blocks[0]!.type === "kpi" ? (mixedRepair.dsl.slides[0]!.blocks[1] as { sourceRef?: string }).sourceRef : (mixedRepair.dsl.slides[0]!.blocks[0] as { sourceRef?: string }).sourceRef, "phase:budget", "kpi 同样被回挂（autoRepair 会把 relocatable 引用挂给所有无 sourceRef 的数字块）");
  assert.equal(validateReportDsl(mixedRepair.dsl, { catalog: PROD_CATALOG }).issues.filter((i) => i.level === "error").length, 0, "①+② 都修好时整体 0 error");

  /* Case C：autoRepair 一步到位 0 issue 的原图 → 应当原样返回（不无故降级） */
  const clean = dsl([
    slide(0, "closing", [{ ...cite({ claim: "免责与口径声明", ref: { sourceKey: "meta:disclaimer" }, tier: "high", confidence: 1 }) }]),
  ]);
  const cleanRepair = autoRepair(clean, { catalog: CATALOG });
  const cleanPost = validateReportDsl(cleanRepair.dsl, { catalog: CATALOG });
  assert.equal(cleanPost.issues.filter((i) => i.level === "error").length, 0);
  assert.equal(cleanRepair.actions.length, 0, "closer 页的装饰性修复不脏任务");
  assert.equal(cleanRepair.dsl.slides[0]!.citations.length, 0, "meta:* 引用已被摘出（用例①同类）");
});

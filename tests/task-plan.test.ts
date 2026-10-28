/**
 * 任务拆解（taskPlan）：把「补充说明」落成"谁负责、怎么算做到"。
 *
 * 背景（用户原话）："我要达人候选包含明星，那么拆解任务时候就需要考虑" ——
 * 改之前 `brief.notes` 只是被拼进提示词，六个阶段**没有任何一处负责它**：
 * 用户写"需要明星代言"，报告照样跑完，人选页全是普通达人，而界面看不出异常。
 *
 * 这套用例钉四件事：
 *   ① 拆解条目的洗数据规则（模型输出的 phase/id/keywords 都可能不规范）；
 *   ② `notes` 有内容却不给拆解 = 不合格（否则"漏写"与"没有要求"无法区分）；
 *   ③ 拆解必须真的到达对应阶段的提示词，且被标注为"意图，不是事实"；
 *   ④ 明星候选的溯源：只有平台采集或公开报道命中该姓名才留得下来，
 *      且粉丝量/报价强制归零 —— 名字真实不代表旁边的数字真实。
 *
 * 运行：npm test（全离线，不发任何外部请求）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTaskPlan,
  planItemsFor,
  planKeywordsFor,
  isStarRequirement,
  taskPlanOf,
  TASK_PLAN_MAX_ITEMS,
  type TaskPlanItem,
} from "@brandsale/contracts";
import {
  BriefSchema,
  CreatorCandidatesSchema,
  enforceRequirementCoverage,
  extractStarLeads,
  planSearchQueries,
  planSearchQuery,
  creatorAccountRows,
  creatorSourceOf,
  PUBLIC_FIGURE_SOURCE_LABEL,
  pruneUnverifiableCreators,
  starCandidateBlocks,
  starLeadBlocks,
  starLeadOf,
  taskPlanPromptSection,
  webSearchRows,
  type CreatorOutput,
} from "@brandsale/agent-pack";

/* ── fixtures ─────────────────────────────────────────────── */

const item = (over: Partial<TaskPlanItem> = {}): TaskPlanItem => ({
  id: "P1",
  need: "品牌需要明星代言",
  phase: "creator",
  requirement: "候选池里至少 1 位明星/名人，并写明来源",
  ...over,
});

const candidate = (over: Partial<CreatorOutput["candidates"][number]> = {}): CreatorOutput["candidates"][number] => ({
  talentId: "t_9001",
  nickname: "某明星",
  platform: "weibo",
  followers: 12_000_000,
  category: "美妆护肤",
  matchScore: 0.8,
  rationale: "公开报道口径，未经核验；粉丝量与报价无样本",
  estimatedCost: 3_000_000,
  costRange: { low: 2_000_000, high: 4_000_000 },
  riskFlags: [],
  tier: "head",
  contentFit: "代言人形象与品牌调性契合",
  historicalPerformance: "无样本",
  confidence: 0.5,
  ...over,
});

const creatorOutput = (over: Partial<CreatorOutput> = {}): CreatorOutput => ({
  candidates: [candidate(), candidate({ talentId: "t_9002", nickname: "腰部达人", tier: "mid" }), candidate({ talentId: "t_9003", nickname: "尾部达人", tier: "tail" })],
  excluded: [],
  citations: [{ claim: "公开报道提及代言人", sourceKey: "volc_web_search", confidence: 0.5 }],
  ...over,
});

const briefJson = (notes?: string) => ({
  brief: {
    industry: "美妆",
    category: "护肤品-精华",
    brandIds: ["欧莱雅"],
    budget: { currency: "CNY", amount: 3_000_000 },
    objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
    window: { from: "2026-10-01", to: "2026-10-31" },
    platforms: ["douyin", "xiaohongshu"],
    ...(notes === undefined ? {} : { notes }),
  },
  authorization: { usableSources: [], blockedSources: [] },
  clarifications: [],
  confidence: 0.9,
});

/* ── ① 洗数据 ─────────────────────────────────────────────── */

test("TP-1 拆解条目洗数据：非数组 → 空；缺 need/requirement 丢弃；phase 拼错归 report；重复 id 去重", () => {
  assert.deepEqual(normalizeTaskPlan(undefined), []);
  assert.deepEqual(normalizeTaskPlan("要明星"), [], "模型给字符串不能当数组用");

  const plan = normalizeTaskPlan([
    { id: "P1", need: "要明星代言", phase: "creator", requirement: "至少 1 位明星，且写明来源" },
    { id: "P1", need: "只看人选不要排期", phase: "playbook", requirement: "排期阶段可以不产出" },
    { need: "只写在需求里没有验收标准", phase: "creator" },
    { id: "P9", need: "要避开绝对化表述", phase: "planning", requirement: "报告正文不得出现「最」「第一」" },
  ]);
  assert.equal(plan.length, 3, "缺 requirement 的条目必须丢弃");
  assert.deepEqual(plan.map((p) => p.id), ["P1", "P1-2", "P9"], "重复 id 必须自动去重，否则 coverage 对不上账");
  assert.equal(plan[2].phase, "report", "未知 phase 归到 report：直接丢弃会让诉求在最后一环彻底消失");
  assert.ok(isStarRequirement(plan[0]));
  assert.equal(isStarRequirement(plan[1]), false);
});

test("TP-2 拆解条目上限与关键词：超过上限截断，关键词去重且最多 3 个", () => {
  const many = Array.from({ length: TASK_PLAN_MAX_ITEMS + 4 }, (_, i) => ({
    id: `P${i + 1}`,
    need: `要求 ${i}`,
    phase: "creator",
    requirement: `验收 ${i}`,
    keywords: ["明星", "明星", "代言", "品牌", "多余"],
  }));
  const plan = normalizeTaskPlan(many);
  assert.equal(plan.length, TASK_PLAN_MAX_ITEMS);
  assert.deepEqual(plan[0].keywords, ["明星", "代言", "品牌"]);
});

test("TP-3 按阶段取条目与检索词（老任务没有 taskPlan 字段 → 空数组，不是错误）", () => {
  const plan = [item({ id: "P1" }), item({ id: "P2", phase: "report", need: "报告要提一句明星", requirement: "结论页提到", keywords: ["代言人"] })];
  assert.deepEqual(planItemsFor(plan, "creator").map((i) => i.id), ["P1"]);
  assert.deepEqual(planKeywordsFor(plan, "report"), ["代言人"]);
  assert.deepEqual(planKeywordsFor(plan, "creator"), []);
  assert.deepEqual(taskPlanOf({ brief: {} }), []);
  assert.deepEqual(taskPlanOf(null), []);
});

/* ── ② notes 有内容就必须拆解 ─────────────────────────────── */

test("TP-4 notes 有内容却缺 taskPlan 字段 → 不合格；显式写 [] → 合格", () => {
  assert.throws(
    () => BriefSchema.validate(briefJson("品牌需要明星代言，重点看人选")),
    /taskPlan 缺失/,
    "有补充说明却不拆解，等于把用户要求整条丢掉",
  );

  const ok = BriefSchema.validate({ ...briefJson("品牌需要明星代言"), taskPlan: [] });
  assert.deepEqual(ok.taskPlan, [], "显式空数组表示「读过、但没有可执行要求」");

  // 老任务 / 离线桩：notes 为空时字段缺省可以接受
  assert.deepEqual(BriefSchema.validate(briefJson()).taskPlan, []);
});

test("TP-5 notes 里的诉求拆成条目后能落到对应阶段", () => {
  const out = BriefSchema.validate({
    ...briefJson("达人候选要包含明星；另外报告里必须避开绝对化表述"),
    taskPlan: [
      { id: "P1", need: "达人候选要包含明星", phase: "creator", requirement: "候选池至少 1 位明星且写明来源", keywords: ["明星代言"] },
      { id: "P2", need: "报告里必须避开绝对化表述", phase: "report", requirement: "正文不出现「最」「第一」" },
    ],
  });
  assert.equal(out.taskPlan.length, 2);
  assert.deepEqual(planItemsFor(out.taskPlan, "creator").map((i) => i.need), ["达人候选要包含明星"]);
});

/* ── ③ 提示词段 ───────────────────────────────────────────── */

test("TP-6 提示词段只列本阶段条目，并明确「意图不是事实」", () => {
  const plan = [item(), item({ id: "P2", phase: "report", need: "报告要提一句明星", requirement: "结论页提到" })];
  const forCreator = taskPlanPromptSection(plan, "creator");
  assert.match(forCreator, /P1/);
  assert.doesNotMatch(forCreator, /P2/, "不能把别的阶段的条目塞给本阶段（会诱导模型越权作答）");
  assert.match(forCreator, /不是事实数据/);
  assert.match(forCreator, /逐条回应/);

  const forBudget = taskPlanPromptSection(plan, "budget");
  assert.match(forBudget, /没有一条归本阶段负责/);
  assert.match(forBudget, /不要替别的阶段作答/);

  assert.equal(taskPlanPromptSection([], "creator"), "", "没有拆解时不该多出一段噪音");
});

test("TP-7 拆解检索词：明星条目**每品牌一条**（拼成一条会退化成类目测评、0 个姓名）", () => {
  const brief = { brandIds: ["欧莱雅", "适乐肤"], category: "护肤品-精华" };
  assert.deepEqual(planSearchQueries([item({ keywords: undefined })], "creator", brief), [], "没给检索词就不该额外检索");
  /* 真机实测：`欧莱雅 适乐肤 护肤品-精华 明星代言人 品牌代言人` → 20 条全是类目测评；
   * `适乐肤 代言人` → 直接命中"官宣张凌赫""官宣樊振东"。品牌名是最强锚点，词越少越准。 */
  assert.deepEqual(
    planSearchQueries([item({ keywords: ["明星代言"] })], "creator", brief),
    ["欧莱雅 代言人", "适乐肤 代言人"],
  );
  /* 非明星条目仍是"一条拼合查询"，控制成本 */
  const other = planSearchQueries(
    [item({ need: "优先女性向达人", requirement: "至少一半女性向内容", keywords: ["女粉", "宝妈"] })],
    "creator",
    brief,
  );
  assert.equal(other.length, 1);
  assert.match(other[0], /欧莱雅 适乐肤 护肤品-精华 女粉 宝妈/);
  assert.ok(other[0].length <= 120);
  /* 品牌多时按次计费封顶 3 条 */
  assert.equal(
    planSearchQueries([item({ keywords: ["代言人"] })], "creator", { brandIds: ["A", "B", "C", "D"], category: "x" }).length,
    3,
  );
});

/* ── ④ 覆盖校验与明星溯源 ─────────────────────────────────── */

test("TP-8 漏回应的条目机械补成 gap（「没做到」必须显式，而不是安静少一块）", () => {
  const { value, gaps } = enforceRequirementCoverage(creatorOutput(), [item(), item({ id: "P2", need: "只要女性达人", requirement: "候选人至少一半女性向内容" })], {
    verifiable: ["腰部达人"],
    publicText: "",
  });
  assert.deepEqual(value.requirementCoverage?.map((c) => c.itemId), ["P1", "P2"]);
  assert.equal(value.requirementCoverage?.every((c) => c.status === "gap"), true);
  assert.equal(gaps.length, 2);
  assert.match(gaps[0], /未回应/);
});

test("TP-9 明星条目自称已满足，但姓名不在任何真实来源里 → 降级为 gap", () => {
  const out = creatorOutput({ requirementCoverage: [{ itemId: "P1", status: "met", note: "已包含明星代言人" }] });
  const { value, gaps } = enforceRequirementCoverage(out, [item()], {
    verifiable: ["腰部达人"],
    publicText: "某品牌宣布新代言人，引发讨论", // 没有 "某明星" 这三个字
  });
  assert.equal(value.requirementCoverage?.[0].status, "gap");
  assert.match(value.requirementCoverage?.[0].note ?? "", /不编造/);
  assert.equal(gaps.length, 1);
});

test("TP-10 姓名出现在本次公开检索命中里 → 明星条目得以保留", () => {
  const out = creatorOutput({ requirementCoverage: [{ itemId: "P1", status: "met", note: "某明星（公开报道）" }] });
  const { value, gaps } = enforceRequirementCoverage(out, [item()], {
    verifiable: [],
    publicText: "欧莱雅官宣：某明星出任精华代言人",
  });
  assert.equal(value.requirementCoverage?.[0].status, "met");
  assert.deepEqual(gaps, []);
});

test("TP-11 公开报道通道：明星候选留得住，但粉丝量与报价强制归零并打风险标记", () => {
  const value = creatorOutput();
  const { value: pruned, dropped } = pruneUnverifiableCreators(value, {
    accounts: [{ platform: "dy", platformName: "抖音", author: "腰部达人" }],
    publicText: "欧莱雅官宣某明星出任精华代言人，话题阅读量破亿",
  });
  assert.equal(
    pruned.candidates.some((c) => c.nickname === "某明星"),
    true,
    "姓名在公开检索里出现过，就不该被当成幻觉删掉",
  );
  assert.equal(dropped.some((d) => d.nickname === "某明星"), false);
  const star = pruned.candidates.find((c) => c.nickname === "某明星")!;
  assert.equal(star.followers, 0, "公开报道证明不了粉丝量，必须归零");
  assert.equal(star.estimatedCost, 0);
  assert.deepEqual(star.costRange, { low: 0, high: 0 });
  assert.ok(star.riskFlags.some((f) => f.includes("公开报道")), "必须标出「未经核验」的来源性质");
  assert.ok(pruned.excluded.some((e) => e.reason.includes("公开报道")), "排除项里要交代这批人只来自公开报道");
});

test("TP-12 三条路都对不上的名字仍然剔除（反造假闸不放宽）", () => {
  const value = creatorOutput({ candidates: [candidate({ nickname: "查无此人" })], });
  const { value: pruned, dropped } = pruneUnverifiableCreators(value, {
    accounts: [{ platform: "dy", platformName: "抖音", author: "腰部达人" }],
    publicText: "欧莱雅官宣某明星出任精华代言人",
  });
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /公开检索也未提及/);
  assert.equal(pruned.candidates.some((c) => c.nickname === "查无此人"), false);
});

test("TP-13 requirementCoverage 必须出现在 validate 的返回里（新字段被静默吞掉的教训）", () => {
  const out = CreatorCandidatesSchema.validate({
    candidates: [candidate({ talentId: "t_1", tier: "head" }), candidate({ talentId: "t_2", tier: "mid" }), candidate({ talentId: "t_3", tier: "tail" })],
    excluded: [],
    requirementCoverage: [{ itemId: "P1", status: "gap", note: "无明星样本" }],
    citations: [{ claim: "公开报道提及代言人", sourceKey: "volc_web_search", confidence: 0.5 }],
  });
  assert.deepEqual(out.requirementCoverage, [{ itemId: "P1", status: "gap", note: "无明星样本" }]);
});

test("TP-14 公开报道通道只服务公众人物：普通达人撞上同名也不放行", () => {
  const normal = candidate({
    talentId: "t_777",
    nickname: "小美",
    rationale: "类目匹配，报价库无样本",
    contentFit: "日常护肤分享",
    category: "美妆护肤",
  });
  const { dropped } = pruneUnverifiableCreators(creatorOutput({ candidates: [normal] }), {
    accounts: [{ platform: "dy", platformName: "抖音", author: "另一个人" }],
    publicText: "有用户留言说小美推荐的精华很好用", // 正文里恰好有「小美」，但这不是公众人物报道
  });
  assert.equal(dropped.length, 1, "自述里没有明星/代言/艺人字样的候选，不能借同名蒙混过关");
  assert.equal(dropped[0].nickname, "小美");
});

test("TP-15 代言线索机械摘录：认「品牌 + 代言/大使」，不猜姓名、不带任何数字", () => {
  const rows = [
    { title: "适乐肤官宣品牌代言人樊振东，携手开启科学屏障清洁新旅程", siteName: "中华网", url: "https://a", publishTime: "2026-02-03", snippet: "" },
    { title: "适乐肤C乳上榜HWB必试榜", siteName: "微博", url: "https://b", publishTime: "", snippet: "张凌赫推荐，48 小时保湿" },
    { title: "欧莱雅签约肖战为PRO品牌全球代言人", siteName: "新榜", url: "https://c", publishTime: "", snippet: "" },
    { title: "达人直播带货构成商业广告，需依法承担广告代言人责任", siteName: "监管解读", url: "https://d", publishTime: "", snippet: "" },
    { title: "欧莱雅 代言人（重复链接）", siteName: "某站", url: "https://c", publishTime: "", snippet: "" },
  ];
  const leads = extractStarLeads(rows, ["欧莱雅", "适乐肤"]);
  assert.deepEqual(leads.map((l) => l.url).sort(), ["https://a", "https://c"], "既没代言标记也没品牌名的行不能混进来；链接去重");
  const byUrl = new Map(leads.map((l) => [l.url, l]));
  assert.equal(byUrl.get("https://a")?.brand, "适乐肤");
  assert.equal(byUrl.get("https://a")?.site, "中华网");
  assert.equal(byUrl.get("https://c")?.brand, "欧莱雅");

  /* 线索块只能说"有这篇报道"，不能顺手变成结论或数字 */
  const blocks = starLeadBlocks(leads);
  const table = blocks.find((b) => b.type === "table");
  assert.ok(table && table.type === "table");
  assert.deepEqual(table.columns, ["品牌", "报道标题", "站点", "发布时间（原文所示）", "原文链接"]);
  assert.ok(!table.columns.some((c) => /粉丝|报价|成本/.test(c)), "报道证明不了粉丝量与报价，不许给这两列");
  const callout = blocks.find((b) => b.type === "callout");
  assert.ok(callout && callout.type === "callout" && /未经人工核验/.test(callout.text));
  assert.equal(starLeadBlocks([]).length, 0);
  assert.equal(starLeadBlocks(undefined).length, 0);
});

test("TP-16 检索命中行必须从 result.results 取（读 rows 会静默返回空 → 明星通道曾整条失效）", () => {
  const prefetched = {
    web_search_plan: {
      result: {
        query: "适乐肤 代言人",
        count: 1,
        results: [{ title: "适乐肤官宣品牌代言人樊振东", siteName: "中华网", url: "https://a", publishTime: "2026-02-03", snippet: "", summary: "" }],
      },
      provenance: [],
    },
    web_search_plan_2: {
      result: { results: [{ title: "欧莱雅签约肖战为PRO品牌全球代言人", siteName: "新榜", url: "https://c", publishTime: "" }] },
    },
    platform_digest: { result: { rows: [{ title: "别的工具的行不该被读进来" }] } },
  };
  const rows = webSearchRows(prefetched);
  assert.equal(rows.length, 2, "只认 web_search_plan* 键，且行在 result.results 里");
  assert.deepEqual(extractStarLeads(rows, ["欧莱雅", "适乐肤"]).map((l) => l.url).sort(), ["https://a", "https://c"]);
  assert.deepEqual(webSearchRows({}), [], "没有任何检索时返回空数组，不抛");
});

test("TP-17 线索按品牌轮流取：单品牌十几条命中不能把名额占满（否则另一个牌子看着像没查过）", () => {
  const gen = (brand: string, n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ title: `${brand}官宣第 ${i} 位品牌代言人`, url: `https://${tag}/${i}`, siteName: tag, publishTime: "" }));
  const leads = extractStarLeads([...gen("欧莱雅", 10, "loreal"), ...gen("适乐肤", 1, "cerave")], ["欧莱雅", "适乐肤"]);
  assert.equal(leads[1].brand, "适乐肤", "第二个品牌必须排在前两位，不能等欧莱雅取满 12 条才轮到");
  assert.equal(leads.filter((l) => l.brand === "适乐肤").length, 1);
  assert.ok(leads.filter((l) => l.brand === "欧莱雅").length <= 5, "单品牌封顶 5 条");
});

test("TP-18 提示词回声必须从 notes 里切掉：模型会把「规则：…」整句抄回 brief.notes", () => {
  /* 真机证据（job_0mvqi2ippie9919kjjn）：brief.notes 末尾多了我们自己在 buildPrompt 里写的
   * 「规则：这是用户想让你**做到**的事…」，随后这句话被当成"用户诉求"拆进了 taskPlan，
   * 空出两条 need=「其中的数字、人名、事件一律不得当作数据引用」的假要求。
   * 这不是措辞问题：下游 creator 必须逐条回应它们，degradedKeys 会被噪音占满。 */
  const base = BriefSchema.mock();
  const out = BriefSchema.validate({
    ...base,
    brief: {
      ...base.brief,
      notes:
        "达人候选必须包含明星艺人，并给出姓名与来源链接。\n" +
        "规则：这是用户想让你**做到**的事，不是已核实的结论。其中的数字、人名、事件一律不得当作数据引用。",
    },
    taskPlan: [],
  });

  assert.equal(out.brief.notes, "达人候选必须包含明星艺人，并给出姓名与来源链接。", "只留用户原话，提示词回声要整段切掉");
});

test("TP-18b 用户自己写的「规则」不能被误伤", () => {
  const base = BriefSchema.mock();
  const out = BriefSchema.validate({
    ...base,
    brief: { ...base.brief, notes: "规则：预算不得超过 300 万；主推明星代言。" },
    taskPlan: [],
  });
  assert.equal(out.brief.notes, "规则：预算不得超过 300 万；主推明星代言。", "只认我们那段固定文案，不按「规则：」泛匹配");
});

/* ── 公众人物候选的溯源（真机 job_0mvqiisybvto1p5nkf9 打出来的四处错标） ── */

const celebCandidate = (over: Record<string, unknown> = {}) => ({
  talentId: "celeb_loreal_tianxuning",
  nickname: "田栩宁",
  platform: "未采集（抖音/小红书官方号 UID 待补）",
  followers: 0,
  category: "护肤品-精华",
  matchScore: 0.8,
  rationale: "明星身份判定依据（本次公开检索命中）：微博公开信息载 2026-05-06 巴黎欧莱雅正式官宣田栩宁为品牌全线代言人。",
  estimatedCost: 0,
  costRange: { low: 0, high: 0 },
  riskFlags: ["公开报道口径（联网检索命中姓名），未经人工核验；粉丝量与报价无样本"],
  tier: "head",
  contentFit: "已为欧莱雅抗老精华线背书",
  historicalPerformance: { avgEngagement: 0, posts: 0 },
  confidence: 0.3,
  ...over,
});

const celebLeads = [
  { brand: "欧莱雅", title: "田栩宁代言欧莱雅小蜜罐_新浪新闻", site: "手机新浪网", url: "https://lead/tianxuning", publishedAt: "2026-05-06T09:30:00+08:00" },
  { brand: "欧莱雅", title: "肖战官宣欧莱雅 PRO 品牌全球代言人", site: "手机新浪网", url: "https://lead/xiaozhan", publishedAt: "2026-09-04T19:00:00+08:00" },
];

test("TP-19 明星候选不能标成「本地达人报价库」：来源/凭据/粉丝量/成本四处必须一起改", () => {
  /* 真机原样：附录人选表里 4 位明星全是
   *   来源「本地达人报价库（L2）」/ 凭据「库内无账号 ID（未核验）」/ 粉丝量「未知」/ 成本「0.0 万」。
   * 四处都错，而「0.0 万」最危险 —— 读者会得出"请这位明星不要钱"这个结论。 */
  const creators = { candidates: [celebCandidate()], excluded: [], citations: [], starLeads: celebLeads } as unknown as CreatorOutput;
  const row = creatorAccountRows(creators, [])[0]!;
  const [id, nickname, , source, credential, followers, cost, note] = row;
  assert.equal(nickname, "田栩宁");
  assert.equal(source, PUBLIC_FIGURE_SOURCE_LABEL, "来源必须是「公开报道线索」，不能落进报价库分支");
  assert.equal(credential, "https://lead/tianxuning", "凭据必须是官宣报道链接（姓名命中标题），不能写「库内无账号 ID」");
  assert.equal(followers, "未采集", "这条通道粉丝量被强制归零 —— 如实写未采集，不能写「未知」");
  assert.equal(cost, "无样本", "不能出现「0.0 万」：那是「免费」的意思，实际是没有报价数据");
  assert.match(note, /代言有期限|未命中官宣报道/);
  assert.ok(id.startsWith("celeb_"), "没有平台账号时标识列原样保留候选 id（不伪造 UID）");

  /* 旧签名（只传 talentId 字符串）必须继续可用：外部调用点不保证都改了 */
  assert.equal(typeof creatorSourceOf("celeb_x"), "string");
  assert.equal(creatorSourceOf("pfcre_dy_abc"), "平台公开采集（L3，未核验）");
});

test("TP-20 「明星候选与官宣出处」把姓名、官宣时间、链接机械对上；命中不了就如实说没命中", () => {
  const creators = {
    candidates: [celebCandidate(), celebCandidate({ talentId: "celeb_unknown", nickname: "查无此人" })],
    excluded: [],
    citations: [],
    starLeads: celebLeads,
  } as unknown as CreatorOutput;
  const blocks = starCandidateBlocks(creators);
  const table = blocks.find((b) => b.type === "table");
  assert.ok(table && table.type === "table");
  assert.deepEqual(table.columns, ["代言人（候选）", "品牌", "官宣报道标题", "发布时间（原文所示）", "原文链接", "粉丝量/报价"]);

  const hitRow = table.rows.find((r) => r[0] === "田栩宁")!;
  assert.equal(hitRow[1], "欧莱雅");
  assert.match(hitRow[2]!, /田栩宁代言欧莱雅小蜜罐/);
  assert.equal(hitRow[3], "2026-05-06 09:30", "官宣时间取自报道原文（只做格式转换，不推算时区），不由模型推断");
  assert.equal(hitRow[4], "https://lead/tianxuning");
  assert.match(hitRow[5]!, /无样本/, "这条通道不给粉丝量与报价的任何数字");

  const missRow = table.rows.find((r) => r[0] === "查无此人")!;
  assert.match(missRow[2]!, /未命中官宣报道/, "没命中就写没命中，不能从 rationale 里猜一个品牌或时间");
  assert.equal(missRow[4], "—");

  const callout = blocks.find((b) => b.type === "callout");
  assert.ok(callout && callout.type === "callout" && /1 位在检索回的官宣报道标题里/.test(callout.text), "要报出命中了几位，读者才知道覆盖率");
  /* 不是明星候选的报告不该凭空多出这一块 */
  assert.equal(starCandidateBlocks({ candidates: [], excluded: [], citations: [] } as unknown as CreatorOutput).length, 0);
  assert.equal(starCandidateBlocks(undefined).length, 0);
});

test("TP-21 starLeadOf 只做标题子串匹配：任一字不差才算命中，不做同名合并", () => {
  assert.equal(starLeadOf(celebLeads, "田栩宁")?.url, "https://lead/tianxuning");
  assert.equal(starLeadOf(celebLeads, "田 栩 宁")?.url, "https://lead/tianxuning", "姓名里的空格不该影响匹配");
  assert.equal(starLeadOf(celebLeads, "肖战")?.url, "https://lead/xiaozhan");
  /* ⚠️ 断言的是**实际语义**而不是"理想语义"：中文没有词边界，2 字查询按子串匹配，
   * 所以「田栩」也会命中「田栩宁」。这是刻意的取舍 —— 候选昵称正常就是全名
   * （「肖战」本身就是 2 字），若给短名加"必须词尾对齐"的猜测，会把两字艺人全判成未命中。
   * 代价写在块里的 callout 上：只做标题子串匹配、不区分同名同姓。 */
  assert.equal(starLeadOf(celebLeads, "田栩")?.url, "https://lead/tianxuning", "2 字查询按子串匹配（中文无词边界）");
  assert.equal(starLeadOf(celebLeads, "田"), undefined, "单字姓名一律不匹配（会撞上任意标题里的同字）");
  assert.equal(starLeadOf(celebLeads, ""), undefined, "空名不匹配");
  assert.equal(starLeadOf(undefined, "田栩宁"), undefined);
});

test("TP-22 同一艺人命中多条官宣时分行列出（张凌赫既是欧莱雅美发代言人、又是适乐肤亚太区代言人）", () => {
  /* 真机 job_0mvqiisybvto1p5nkf9 的候选只有「张凌赫」一行，官宣报道却有两条。
   * 只取第一条（命中顺序随机）会让人以为他只为其中一个品牌代言，而这两条恰恰分属
   * 用户点名的两个品牌 —— 取舍等于替他做了一次没有依据的选择。 */
  const leads = [
    { brand: "欧莱雅", title: "张凌赫成为巴黎欧莱雅美发代言人", site: "手机新浪网", url: "https://lead/loreal", publishedAt: "2026-09-02T15:54:00+08:00" },
    { brand: "适乐肤", title: "张凌赫升级适乐肤CeraVe亚太区品牌代言人", site: "手机搜狐网", url: "https://lead/cerave", publishedAt: "2026-07-29T10:33:00+08:00" },
    { brand: "欧莱雅", title: "肖战官宣欧莱雅 PRO 品牌全球代言人", site: "手机新浪网", url: "https://lead/xiaozhan", publishedAt: "2026-09-04T19:00:00+08:00" },
  ];
  const creators = {
    candidates: [celebCandidate({ talentId: "celeb_cerave_zhanglinghe", nickname: "张凌赫" })],
    excluded: [],
    citations: [],
    starLeads: leads,
  } as unknown as CreatorOutput;
  const table = starCandidateBlocks(creators).find((b) => b.type === "table");
  assert.ok(table && table.type === "table");
  assert.equal(table.rows.length, 2, "两条官宣各占一行，不合并、不取舍");
  assert.deepEqual(table.rows.map((r) => r[1]).sort(), ["欧莱雅", "适乐肤"], "两个品牌都要出现");
  const callout = starCandidateBlocks(creators).find((b) => b.type === "callout");
  assert.ok(callout && callout.type === "callout" && /不止一条/.test(callout.text), "要说明为什么同一人出现多行");

  /* 上限 2：再多就不该堆在"人选依据"里了 */
  const many = Array.from({ length: 5 }, (_, i) => ({
    brand: "欧莱雅",
    title: `张凌赫官宣第${i}个代言`,
    site: "某站",
    url: `https://lead/${i}`,
    publishedAt: "2026-09-02T00:00:00+08:00",
  }));
  const capped = starCandidateBlocks({ candidates: [celebCandidate({ nickname: "张凌赫" })], excluded: [], citations: [], starLeads: many } as unknown as CreatorOutput).find(
    (b) => b.type === "table",
  );
  assert.ok(capped && capped.type === "table" && capped.rows.length === 2, "每人最多 2 条");
});

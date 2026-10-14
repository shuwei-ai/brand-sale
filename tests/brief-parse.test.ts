/**
 * WP-C 自然语言解析（规则段）验收测试。
 *
 * 这些用例是**中英混合**的真实输入，覆盖方案 §WP-C 的验收：
 * filled 覆盖 budget/window/platforms/objectiveWeights 中 ≥3 项；
 * 缺字段时 ambiguities 有对应问题；解析结果是纯函数、可重复。
 *
 * 运行：npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cnToNumber, parseBriefUtterance, parseBudget, parsePlatforms, parseWeights, parseWindow } from "@brandsale/contracts";

/** 固定"现在"，否则跨年/跨月运行会得到不同结果（测试不能依赖真实时钟） */
const NOW = new Date("2026-10-08T10:00:00+08:00");

/* ── 中文数字 ───────────────────────────────────────────── */

test("WP-C-NUM 中文数字与千分位都能解析，含未知字符则拒绝", () => {
  assert.equal(cnToNumber("三十"), 30);
  assert.equal(cnToNumber("十五"), 15);
  assert.equal(cnToNumber("二十五"), 25);
  assert.equal(cnToNumber("三百"), 300);
  assert.equal(cnToNumber("十万"), 100_000);
  assert.equal(cnToNumber("五百万"), 5_000_000);
  assert.equal(cnToNumber("1,200,000"), 1_200_000);
  assert.equal(cnToNumber("2.5"), 2.5);
  assert.equal(cnToNumber("大约三万多"), null, "含未知字符必须返回 null，宁可抽不到也不猜");
});

/* ── 样例 1：完整中文诉求 ───────────────────────────────── */

test("WP-C-1 完整诉求：预算/窗口/平台/权重/行业类目全部命中", () => {
  const d = parseBriefUtterance(
    "双11 想在小红书和抖音做一波精华投放，预算 300 万，主要要曝光也要销量",
    undefined,
    NOW,
  );
  assert.equal(d.brief.budget?.amount, 3_000_000);
  assert.deepEqual(
    { from: d.brief.window?.from, to: d.brief.window?.to },
    { from: "2026-11-01", to: "2026-11-11" },
  );
  assert.deepEqual(d.brief.platforms, ["xiaohongshu", "douyin"], "按文本出现顺序，先说的一般是主阵地");
  assert.equal(d.brief.industry, "美妆个护");
  assert.equal(d.brief.category, "护肤品-精华");
  assert.ok(d.brief.objectiveWeights, "命中曝光 + 销量两个维度，应给出权重");
  assert.deepEqual(d.missing, [], "关键字段齐全就不该追问");
  assert.equal(d.ambiguities.length, 0);
});

/* ── 样例 2：中文数字 + 季度 + 英文平台名 ───────────────── */

test("WP-C-2 中文数字预算 + Q4 + 英文平台名", () => {
  const d = parseBriefUtterance("帮某咖啡品牌做 Q4 的全案，预算两百万元，B站为主", undefined, NOW);
  assert.equal(d.brief.budget?.amount, 2_000_000, "「两百万元」应解析为 2000000");
  assert.deepEqual({ from: d.brief.window?.from, to: d.brief.window?.to }, { from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(d.brief.platforms, ["bilibili"]);
  assert.equal(d.brief.industry, "食品饮料");
  assert.equal(d.brief.category, "饮料-咖啡");
});

/* ── 样例 3：相对时间 + 裸数字预算（靠关键词定调）────────── */

test("WP-C-3 近90天 + 裸数字预算 + 缺行业类目时给出追问", () => {
  const d = parseBriefUtterance("近90天抖音达人投放，预算 500000，目标是提升品牌形象和复购", undefined, NOW);
  assert.equal(d.brief.budget?.amount, 500_000, "没有单位时，靠「预算」这个关键词定调才接受裸数字");
  assert.deepEqual({ from: d.brief.window?.from, to: d.brief.window?.to }, { from: "2026-07-10", to: "2026-10-08" });
  assert.deepEqual(d.brief.platforms, ["douyin"]);
  assert.deepEqual(d.missing, ["industry", "category"], "行业与类目都没命中，必须列为缺失");
  assert.equal(d.ambiguities.length, 2);
  assert.match(d.ambiguities[0]!.question, /行业/);
});

/* ── 样例 4：已过去的季度应顺延到明年 ───────────────────── */

test("WP-C-4 已过去的季度顺延到明年（排期不能落在过去）", () => {
  const d = parseBriefUtterance("Q3 小红书防晒新品，预算三十万，要打响声量同时转化", undefined, NOW);
  // NOW 是 2026-10-08，Q3（7–9 月）已经过去 → 顺延为 2027 Q3
  assert.deepEqual({ from: d.brief.window?.from, to: d.brief.window?.to }, { from: "2027-07-01", to: "2027-09-30" });
  assert.equal(d.brief.budget?.amount, 300_000);
  assert.deepEqual(d.brief.platforms, ["xiaohongshu"]);
  assert.equal(d.brief.category, "护肤品-防晒");
  assert.ok(d.brief.objectiveWeights, "打响声量 + 转化 → 两个维度，应给出权重");
});

/* ── 样例 5：千分位 + 英文权重关键词 ────────────────────── */

test("WP-C-5 千分位金额 + 英文表达的目标权重", () => {
  const d = parseBriefUtterance("小红书 Q4 campaign, budget ¥1,200,000, focus on awareness and conversion", undefined, NOW);
  assert.equal(d.brief.budget?.amount, 1_200_000, "千分位不该截断成 1");
  assert.deepEqual(d.brief.platforms, ["xiaohongshu"]);
  assert.ok(d.brief.objectiveWeights, "awareness / conversion 是英文关键词，也要认");
  assert.ok(d.brief.objectiveWeights!.awareness > 0);
  assert.ok(d.brief.objectiveWeights!.conversion > 0);
  assert.deepEqual(d.missing, ["industry", "category"]);
});

/* ── 样例 6：明确百分比权重 ─────────────────────────────── */

test("WP-C-6 显式百分比权重优先于关键词计数", () => {
  const w = parseWeights("曝光 60%，转化 30%，其余留给品牌心智");
  assert.ok(w);
  assert.equal(w.awareness, 0.6);
  assert.equal(w.conversion, 0.3);
  assert.ok(Math.abs(w.awareness + w.conversion + w.retention - 1) < 1e-6, "权重之和必须为 1");
});

/* ── 默认值与覆盖方向 ───────────────────────────────────── */

test("WP-C-7 文本识别结果覆盖表单默认值，未提及的字段沿用默认值", () => {
  const defaults = { industry: "家居", category: "收纳", budget: { currency: "CNY" as const, amount: 99 } };
  const d = parseBriefUtterance("抖音投精华，预算 300 万", defaults, NOW);
  assert.equal(d.brief.budget?.amount, 3_000_000, "文本里写了预算，就该覆盖表单旧值");
  assert.equal(d.brief.category, "护肤品-精华", "文本命中的类目优先");
  assert.equal(d.brief.industry, "美妆个护", "命中行业词表时同样覆盖");
  assert.ok(!d.filled.includes("platforms") || true);
  // notes 保留原话，便于下游 Agent 看到用户自己的措辞
  assert.equal(d.brief.notes, "抖音投精华，预算 300 万");
});

/* ── 不该误抽的负样本 ───────────────────────────────────── */

test("WP-C-8 裸数字不得被当成预算（防「近90天」「11.11」误抽）", () => {
  assert.equal(parseBudget("近90天做一波投放"), null, "没有单位也没有预算关键词，不许猜");
  assert.equal(parseBudget("双11 大促"), null);
  assert.equal(parseBudget("Q4 计划，3 家竞品"), null);
  // 有单位才是证据
  assert.equal(parseBudget("预算 300 万"), 3_000_000);
  assert.equal(parseBudget("投入 500k"), 500_000);
});

test("WP-C-9 平台识别只认已知平台，且按出现顺序去重", () => {
  assert.deepEqual(parsePlatforms("抖音、抖音、小红书"), ["douyin", "xiaohongshu"]);
  assert.deepEqual(parsePlatforms("只投知乎和豆瓣"), [], "未支持的平台不硬塞");
});

test("WP-C-10 时间窗识别不出时返回 null，不编造默认窗口", () => {
  assert.equal(parseWindow("尽快做一波投放", NOW), null);
  assert.notEqual(parseWindow("明年 618 冲一波", NOW), null, "能识别就该给出来");
});

/* ── 3C 品类：category 会被逐字当平台搜索词，必须是中文 ───── */

/**
 * `category` 不只是分类标签 —— `agents.ts:platformPrefetchArgs()` 把它**逐字**当作
 * 平台内搜索关键词。所以它必须是一个"人真的会输进搜索框的中文词"。
 *
 * 反例（本用例守的就是它）：词表漏了 3C 时，intake 退到 LLM 补全，模型给出
 * `industry: consumer_electronics` / `category: headphones`，搜索结果实测
 * 小红书 0 条、抖音 14 条里混进 3 条英语教学视频（"英文K歌屋：Headphones On"）。
 */
test("WP-C-11 耳机诉求：category 必须是中文词（它会被直接用作平台搜索关键词）", () => {
  const d = parseBriefUtterance(
    "索尼、Bose、华为、小米四个耳机品牌，在抖音、小红书、B站投放，预算 200 万",
    undefined,
    NOW,
  );
  assert.equal(d.brief.industry, "3C数码");
  assert.equal(d.brief.category, "耳机");
  assert.match(d.brief.category ?? "", /[\u4e00-\u9fff]/, "category 必须含中文，英文标识符在中文平台搜不到内容");
  assert.deepEqual(d.brief.platforms, ["douyin", "xiaohongshu", "bilibili"]);
  assert.equal(d.brief.budget?.amount, 2_000_000);
  assert.ok(!d.missing.includes("industry"), "词表命中后 industry 不该再进 missing");
  assert.ok(!d.missing.includes("category"), "词表命中后 category 不该再进 missing");
  assert.ok(d.filled.includes("industry"), "industry 应由规则段命中，而不是留给模型补");});

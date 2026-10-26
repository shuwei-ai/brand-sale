/**
 * 人选粉丝量的「读时解析」（2026-10-20）。
 *
 * 真实事故：双十一羽绒服任务（job_0mvgany95k7poz73mks）报告里 5 位人选的粉丝量
 * 全是「未采集」，而缓存里早就采到了 60.1 万 / 13.0 万 / 16.1 万 / 16.9 万 / 43.5 万。
 * 根因不是采集，是**读的时刻不对**：
 *   · 候选人池在 creator 阶段开头生成，那一刻作者主页资料行还没落库 → `followers` 固化成 0；
 *   · report 阶段资料行已躺在缓存里，却没人再读一次（补读白名单写死在 intel/creator）；
 *   · 读侧（`creatorAccountRows`）只取 `c.followers` 快照，台账后来有了也不回填。
 *
 * 这三条各有一个用例钉住。运行：npm test（全离线）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvidenceEntry, ReportDsl } from "@brandsale/contracts";
import { matchCreatorRows } from "../apps/collector/src/server.ts";
import {
  PLATFORM_CREATOR_PREFIX,
  backfillCreatorStatsInTables,
  creatorAccountRows,
  creatorLiveViews,
  evidenceIdOf,
  platformCandidateId,
  platformCreatorCandidates,
  shouldRefreshPlatform,
  toEvidenceEntries,
  withLiveCreatorStats,
  type CreatorOutput,
} from "@brandsale/agent-pack";

/* ── fixtures：内容行 + 主页资料行（同一个 authorId 才能拼上） ───────── */

const AUTHOR_KEYWORD = "羽绒服";
const CONTENT_URL = "https://www.douyin.com/video/7592831440572714280";
const PROFILE_URL = "https://www.douyin.com/user/MS4wLjABAAAAufc4YpOwkF3rgXJyoAKRJX7auflxBD";
const PLATFORM_UID = "67142047882";

const contentEntry = (over: Partial<EvidenceEntry> = {}): EvidenceEntry => ({
  entryId: evidenceIdOf("dy", "7592831440572714280"),
  platform: "dy",
  platformName: "抖音",
  op: "search",
  kind: "content",
  title: "羽绒服测评",
  excerpt: "充绒量与蓬松度实测",
  author: "Sodabobo",
  url: CONTENT_URL,
  publishedAt: "2026-10-02T10:00:00Z",
  metrics: { likes: 52000, comments: 800 },
  collectedAt: "2026-10-20T06:30:00Z",
  authorId: "3a2dce8e81e328ff",
  ...over,
});

/** 主页资料行：**只有它带粉丝量**（内容行天生没有） */
const profileEntry = (over: Partial<EvidenceEntry> = {}): EvidenceEntry => ({
  entryId: evidenceIdOf("dy", "3a2dce8e81e328ff"),
  platform: "dy",
  platformName: "抖音",
  op: "creator",
  kind: "content",
  title: "Sodabobo",
  excerpt: "",
  author: "Sodabobo",
  url: PROFILE_URL,
  publishedAt: "",
  metrics: { followers: 601216, follows: 12 },
  collectedAt: "2026-10-20T06:45:28Z",
  authorId: "3a2dce8e81e328ff",
  uid: PLATFORM_UID,
  ...over,
});

/** creator 阶段生成的那个池子：followers=0，分层靠互动量分位 → 误判成头部 */
const poolWithZeroFollowers = (): CreatorOutput =>
  ({
    candidates: [
      {
        talentId: platformCandidateId("dy", "Sodabobo"),
        nickname: "Sodabobo",
        platform: "抖音",
        followers: 0,
        category: AUTHOR_KEYWORD,
        matchScore: 0.7,
        rationale:
          "来自 抖音 公开采集：该账号名下有 1 条可核对条目（1 条内容 / 0 条评论），代表原帖 " +
          `${CONTENT_URL}。账号昵称完整显示，粉丝量**未采集**；报价**未采集**。`,
        estimatedCost: 0,
        costRange: { low: 0, high: 0 },
        riskFlags: ["账号来自平台公开采集（L3），粉丝量与报价未采集，投放前须按原帖人工核验"],
        tier: "head",
        contentFit: "采集到的公开互动量合计 52800；分层依据为同平台互动量分位（粉丝量未采集）",
        historicalPerformance: "无 L2 历史执行样本",
        confidence: 0.35,
      },
    ],
    excluded: [],
    citations: [],
  }) as CreatorOutput;

/* ── ① 读时解析：台账里有了，就必须读出来 ───────────────────────── */

test("读到主页资料行时，粉丝量与分层按证据表重算（不再用写时快照的 0）", () => {
  const entries = [contentEntry(), profileEntry()];
  const live = creatorLiveViews(entries);
  const lv = live.get(platformCandidateId("dy", "Sodabobo"));
  assert.equal(lv?.followers, 601216, "资料行的 followers 要能被聚合出来");
  assert.equal(lv?.uid, PLATFORM_UID, "平台原始 UID 要一起带出来（报告标识列要用）");

  const refreshed = withLiveCreatorStats(poolWithZeroFollowers(), entries);
  const c = refreshed!.candidates[0]!;
  assert.equal(c.followers, 601216, "候选人对象的 followers 要从 0 刷成真实值");
  assert.equal(c.tier, "mid", "60.1 万粉按 tierOf 落 mid —— 不能再沿用『互动量分位』的 head");
  assert.ok(!c.rationale.includes("粉丝量**未采集**"), `粉丝量文案必须同步，实际：${c.rationale}`);
  assert.ok(c.rationale.includes("601216"), "文案里要写出真实粉丝量");
  assert.ok(
    !c.riskFlags.some((f) => f.includes("粉丝量与报价未采集")),
    "风险提示不能一边写粉丝量一边说未采集",
  );
  assert.ok(c.contentFit.includes("分层依据为粉丝量"), "分层依据的说明也要跟着换口径");
});

test("资料行还没到（只有内容行）时保留原值，不把已知数据降级成 0", () => {
  const refreshed = withLiveCreatorStats(poolWithZeroFollowers(), [contentEntry()]);
  const c = refreshed!.candidates[0]!;
  assert.equal(c.followers, 0, "采不到就是采不到，不能编一个数");
  assert.equal(c.tier, "head", "没有粉丝量时仍按互动量分位分层");
  assert.ok(c.rationale.includes("未采集"), "文案要如实说明未采集");
});

/* ── ② 内部分层哈希不该出现在报告里 ─────────────────────────────── */

test("人选表标识列优先输出平台原始 UID，而不是 pfcre_ 哈希", () => {
  const rows = creatorAccountRows(poolWithZeroFollowers(), [contentEntry(), profileEntry()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![0], PLATFORM_UID, "标识列应是平台 UID（站内可查），不是 pfcre_dy_xxx");
  assert.ok(!rows[0]![0]!.startsWith(PLATFORM_CREATOR_PREFIX), "不得回退到内部哈希");
  assert.equal(rows[0]![5], "601216", "同一张表的粉丝量列也要是真实值");
});

/* ── ③ 模型写的表也要回填（否则同一份报告两张表自相矛盾） ─────────── */

const MODEL_TABLE_DSL = (withSourceRef: boolean): ReportDsl =>
  ({
    meta: { title: "双十一羽绒服投放策略", version: "1.0" },
    sourceDeclaration: { sources: [{ key: "mc_dy", displayName: "抖音", grade: "L3", asOf: "2026-10-20", coverage: "公开采集" }], notes: [] },
    slides: [
      {
        index: 0,
        title: "人选建议与分层",
        blocks: [
          {
            type: "table",
            columns: ["人选 ID", "昵称", "平台", "分层", "粉丝量", "报价", "来源"],
            rows: [[platformCandidateId("dy", "Sodabobo"), "Sodabobo", "抖音", "head", "未采集", "未采集", "平台公开采集（L3）"]],
            ...(withSourceRef ? { sourceRef: "phase:creator" } : {}),
          },
        ],
        citations: [],
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as ReportDsl;

test("模型表格里的「未采集」按证据表回填，标识列换成平台 UID", () => {
  const out = backfillCreatorStatsInTables(MODEL_TABLE_DSL(true), poolWithZeroFollowers(), [contentEntry(), profileEntry()]);
  const row = (out.slides[0]!.blocks[0] as { rows: string[][] }).rows[0]!;
  assert.equal(row[0], PLATFORM_UID, "标识列换成 UID");
  assert.equal(row[4], "601216", "粉丝量补上真实值");
  assert.equal(row[5], "未采集", "报价仍如实写未采集（L3 本来就采不到报价）");
});

test("表格没有 sourceRef 时不回填数字 —— 否则凭空造出一条 R6 阻塞", () => {
  const out = backfillCreatorStatsInTables(MODEL_TABLE_DSL(false), poolWithZeroFollowers(), [contentEntry(), profileEntry()]);
  const row = (out.slides[0]!.blocks[0] as { rows: string[][] }).rows[0]!;
  assert.equal(row[4], "未采集", "无来源的块不得塞进数字断言");
  assert.equal(row[0], PLATFORM_UID, "标识列替换不涉及数字断言，可以照做");
});

/* ── ④ 证据层要能留住 authorId / uid（否则上游再准也传不下来） ───── */

test("toEvidenceEntries 保留 authorId 与平台原始 uid", () => {
  const [e] = toEvidenceEntries(
    [{ platform: "dy", id: "h1", author: "Sodabobo", authorId: "3a2dce8e81e328ff", uid: PLATFORM_UID, metrics: { followers: 601216 } }],
    { op: "creator", collectedAt: "2026-10-20T06:45:28Z" },
  );
  assert.equal(e!.authorId, "3a2dce8e81e328ff");
  assert.equal(e!.uid, PLATFORM_UID);
});

test("候选池机械生成时也会带上真实粉丝量与 uid（回归 creator 阶段之后的路径）", () => {
  const [c] = platformCreatorCandidates([contentEntry(), profileEntry()], { category: AUTHOR_KEYWORD });
  assert.equal(c!.followers, 601216);
  assert.equal(c!.tier, "mid");
});

/* ── ⑤ /query 取资料行的两种模式（report 阶段靠"点名"绕开 limit 截断） ── */

test("默认模式只拼本批 rows 的作者；点名模式连『不在本批前 N 条』的人也能取回来", () => {
  const all = [
    { authorId: "h1", id: "p1", author: "甲" },
    { authorId: "h2", id: "p2", author: "乙" },
  ];
  // 本批内容只命中 h1（`limit` 截断后 h2 的作者被挤掉了）
  const batch = [{ authorId: "h1" }];
  assert.deepEqual(
    matchCreatorRows(all, batch, []).map((r) => r.id),
    ["p1"],
    "默认模式：只认本批作者 —— 这正是报告里「未采集」的来源",
  );
  assert.deepEqual(
    matchCreatorRows(all, batch, ["h2"]).map((r) => r.id),
    ["p2"],
    "点名模式：按名册取，不受本批 rows 截断影响（report 阶段就靠这条）",
  );
  assert.deepEqual(matchCreatorRows(all, [], []), [], "既没有本批作者也没点名 → 空，不滥发全量");
});

/* ── ⑥ 补读窗口：report 阶段必须有份，但不是无条件跑 ────────────── */

test("report 阶段允许补读平台数据（资料行比 creator 阶段晚到时，这是最后机会）", () => {
  const noProfile = [contentEntry()];
  assert.equal(shouldRefreshPlatform("report", noProfile), true, "有内容行但还没粉丝量 → 必须补");
  assert.equal(shouldRefreshPlatform("intel", noProfile), true, "情报阶段照旧");
  assert.equal(shouldRefreshPlatform("creator", noProfile), true, "选人阶段照旧");
  for (const p of ["intake", "playbook", "budget"] as const) {
    assert.equal(shouldRefreshPlatform(p, noProfile), false, `${p} 不该做平台补读`);
  }
});

test("report 阶段的两道闸：台账没有平台内容 / 粉丝量已齐，都不补", () => {
  assert.equal(shouldRefreshPlatform("report", []), false, "空台账补也补不出东西，白跑一次闸门");
  assert.equal(
    shouldRefreshPlatform("report", [contentEntry(), profileEntry()]),
    false,
    "粉丝量已经齐了就没必要再查",
  );
  assert.equal(
    shouldRefreshPlatform("report", [contentEntry(), profileEntry({ metrics: { follows: 3 } })]),
    true,
    "半池（资料行没带粉丝量）仍要补 —— 这是最常见的形态",
  );
});

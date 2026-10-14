/**
 * collector sidecar 的归一化与缓存自检。
 *
 * 运行：npm test —— 纯函数级，不发网络请求、不碰 MediaCrawler。
 *
 * 为什么这些用例要单独存在：
 *   collector 是全链路里**唯一**把"平台原始字段"翻译成"统一行"的地方。它翻译错的
 *   后果不是报错，而是**静默的字段错位**：把 `digg_count` 当成评论数、把秒级时间戳
 *   当毫秒解析（于是发布时间变成 1970 年）、把嵌套的 creator 对象当内容行。
 *   这类错误会一路顺到报告里，且看起来完全正常。所以字段映射必须有回归钉住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEDIA_CRAWLER_PLATFORM_META, MEDIA_CRAWLER_PLATFORMS } from "@brandsale/config";
import { kindOf, normalizeBatch } from "../apps/collector/src/normalize.ts";
import { CollectStore } from "../apps/collector/src/store.ts";
import { TaskManager } from "../apps/collector/src/tasks.ts";
import { buildRunnerArgs, lastKernelError, readRecordsSince, snapshotDataFiles } from "../apps/collector/src/core-runner.ts";
import { listenersOnPort, reapBrowser } from "../apps/collector/src/browser-session.ts";

/* ── 归一化 ─────────────────────────────────────────────── */

test("归一化：小红书笔记字段映射到统一行", () => {
  const rows = normalizeBatch("xhs", "search", "content", [
    {
      note_id: "n_1",
      title: "精华怎么选",
      desc: "抗老胜肽实测",
      nickname: "成分党",
      user_id: "u_1",
      note_url: "https://www.xiaohongshu.com/explore/n_1",
      time: 1_730_000_000_000, // 毫秒
      liked_count: 120,
      collected_count: 33,
      comment_count: 7,
      share_count: 4,
    },
  ]);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.id, "n_1");
  assert.equal(r.title, "精华怎么选");
  assert.equal(r.text, "抗老胜肽实测");
  assert.equal(r.author, "成分党");
  assert.equal(r.authorId, "u_1");
  assert.equal(r.metrics.likes, 120);
  assert.equal(r.metrics.collects, 33);
  assert.equal(r.metrics.comments, 7);
  assert.equal(r.metrics.shares, 4);
  // 毫秒时间戳直接可解析
  assert.equal(r.publishedAt, new Date(1_730_000_000_000).toISOString());
  assert.equal(r.kind, "content");
  assert.equal(r.platform, "xhs");
  // 原始记录必须留档，供后续校准映射表
  assert.ok(r.raw && (r.raw as Record<string, unknown>).note_id === "n_1");
});

test("归一化：抖音秒级时间戳按量级判定，不当毫秒解析成 1970", () => {
  const rows = normalizeBatch("dy", "search", "content", [
    { aweme_id: "a_1", desc: "短视频文案", nickname: "达人甲", sec_uid: "s_1", create_time: 1_730_000_000, digg_count: 55 },
  ]);
  const r = rows[0]!;
  assert.equal(r.id, "a_1");
  assert.equal(r.metrics.likes, 55, "digg_count 应映射为统一的 likes");
  assert.equal(r.publishedAt, new Date(1_730_000_000_000).toISOString(), "秒级时间戳应被识别并换算");
});

test("归一化：B站用 video_id（不是 bvid），收藏/分享是 video_ 前缀", () => {
  // 字段名照抄真机落盘的一条（store/bilibili/__init__.py:update_bilibili_video）。
  // ❗旧版这个用例写的是 `bvid`/`owner_id` —— 内核**从不写**这两个键，
  //   结果 id 恒为空、测试却"绿着"，跟快手 photo_* 那次是同一类问题。
  const rows = normalizeBatch("bili", "search", "content", [
    {
      video_id: "1055448934",
      video_type: "video",
      title: "【热销TOP20面膜红黑榜】过半拔草立省百分百！ 爱用种草+雷品吐槽",
      desc: "欧莱雅玻色因B5安瓶面膜\n颐莲小耳朵面膜",
      create_time: 1717411299, // 秒级
      creator_hash: "287229e886e972e3",
      nickname: "萱萱yoyo",
      liked_count: "16414",
      video_play_count: "1418577",
      video_favorite_count: "9130",
      video_share_count: "803",
      video_comment: "474",
      video_url: "https://www.bilibili.com/video/av1055448934",
    },
  ]);
  const r = rows[0]!;
  assert.equal(r.id, "1055448934", "主键是 video_id（= View.aid），没有 bvid");
  assert.equal(r.url, "https://www.bilibili.com/video/av1055448934");
  assert.equal(r.authorId, "287229e886e972e3");
  assert.equal(r.metrics.likes, 16414);
  assert.equal(r.metrics.comments, 474, "video_comment 应映射为统一的 comments");
  assert.equal(r.metrics.views, 1418577, "video_play_count 应映射为统一的 views");
  assert.equal(r.metrics.collects, 9130, "收藏是 video_favorite_count，不是 favorite_count");
  assert.equal(r.metrics.shares, 803, "分享是 video_share_count，不是 share_count");
  assert.equal(r.publishedAt, new Date(1717411299_000).toISOString(), "秒级时间戳按量级判定");
});

test("归一化：微博转发数是 shared_count，不是 share_count", () => {
  // 真机落盘见 store/weibo/__init__.py:update_weibo_note（liked_count/comments_count/shared_count）。
  const rows = normalizeBatch("wb", "search", "content", [
    {
      note_id: "5012345678",
      content: "换季面膜怎么选",
      create_time: 1_717_411_299,
      liked_count: "128",
      comments_count: "19",
      shared_count: "7",
      creator_hash: "aa11bb22cc33dd44",
      nickname: "美研社",
      note_url: "https://m.weibo.cn/detail/5012345678",
    },
  ]);
  const r = rows[0]!;
  assert.equal(r.id, "5012345678");
  assert.equal(r.metrics.likes, 128);
  assert.equal(r.metrics.comments, 19);
  assert.equal(r.metrics.shares, 7, "微博的转发键是 shared_count");
  assert.equal(r.url, "https://m.weibo.cn/detail/5012345678");
});

test("归一化：贴吧回复数字段是 total_replay_num（上游拼写如此）", () => {
  // ⚠️ 内核 pydantic 模型写的是 `total_replay_num`（repl**a**y，见 model/m_baidu_tieba.py）。
  // 按语义猜 `total_reply_num` 会永远取不到值——拼写坑，必须钉住。
  const rows = normalizeBatch("tieba", "search", "content", [
    {
      note_id: "8172635490",
      title: "求推荐平价面膜",
      desc: "预算 100 以内",
      note_url: "https://tieba.baidu.com/p/8172635490",
      publish_time: "2024-06-03 18:21:00",
      creator_hash: "9f8e7d6c5b4a3928",
      user_nickname: "贴吧老友",
      tieba_name: "护肤吧",
      total_replay_num: 42,
    },
  ]);
  const r = rows[0]!;
  assert.equal(r.id, "8172635490");
  assert.equal(r.title, "求推荐平价面膜");
  assert.equal(r.metrics.comments, 42, "贴吧的回复数是 total_replay_num");
  assert.equal(r.url, "https://tieba.baidu.com/p/8172635490");
});

test("归一化：评论行用评论字段表（微博真实字段：comment_like_count）", () => {
  // 字段名照抄 store/weibo/__init__.py:update_weibo_note_comment。
  // 微博评论的点赞键是 `comment_like_count`，通用候选表原先没有它 → 点赞数恒缺失。
  const rows = normalizeBatch("wb", "comments", "comment", [
    {
      comment_id: "5012345678901234",
      content: "说得好",
      create_time: 1_717_411_299,
      note_id: "5012345678",
      nickname: "路过的路人",
      sub_comment_count: "1",
      comment_like_count: "3",
      creator_hash: "cc33dd44ee55ff66",
      parent_comment_id: "",
    },
  ]);
  const r = rows[0]!;
  assert.equal(r.id, "5012345678901234");
  assert.equal(r.text, "说得好");
  assert.equal(r.kind, "comment");
  assert.equal(r.metrics.likes, 3, "微博评论点赞是 comment_like_count");
  assert.equal(r.metrics.subComments, 1);
  assert.equal(r.authorId, "cc33dd44ee55ff66");
  assert.equal(r.publishedAt, new Date(1_717_411_299_000).toISOString());
});

test("归一化：creator 记录被解开嵌套（资料在 creator 子对象里）", () => {
  const rows = normalizeBatch("zhihu", "creator", "creator", [
    { creator: { user_id: "u_9", nickname: "答主乙", headline: "护肤十年", fans: 12345 } },
  ]);
  const r = rows[0]!;
  assert.equal(r.id, "u_9", "应从嵌套的 creator 对象里取字段，而不是留空");
  assert.equal(r.title, "答主乙");
  assert.equal(r.metrics.followers, 12345);
});

test("归一化：全空记录被丢弃，避免污染缓存", () => {
  const rows = normalizeBatch("tieba", "search", "content", [{}, { unknown_field: 1 }, { note_id: "t_1", title: "有内容" }]);
  assert.equal(rows.length, 1, "只有能识别出 id/title/text 的记录才保留");
  assert.equal(rows[0]!.id, "t_1");
});

test("归一化：取不到时间就不填，不用当前时间冒充发布时间", () => {
  const rows = normalizeBatch("ks", "search", "content", [{ video_id: "v_1", title: "文案", create_time: 42 }]);
  assert.equal(rows[0]!.publishedAt, "", "量级不合法的时间戳应留空，而不是猜");
});

test("归一化：快手用视频自己的 video_id / video_url，不是不存在的 photo_*", () => {
  // 内核落盘字段是 video_id / video_url（见 store/kuaishou/__init__.py 的 update_kuaishou_video）。
  // 早期映射表照抄了「photo_*」这套并不存在的键 —— 于是 id 与 url 双双为空，
  // 行的去重只能靠 title 兜底，同名视频会被误判成同一条。
  // 注意：这个用例必须用**真实字段名**，否则会像旧版那样"绿着掩盖缺陷"。
  const rows = normalizeBatch("ks", "search", "content", [
    {
      video_id: "3xryknatvhxq72a",
      title: "#素颜也好看 #海藻面膜",
      desc: "#素颜也好看 #海藻面膜",
      creator_hash: "02ee500f5b4c5f9a",
      nickname: "嗨购清单",
      create_time: 1_772_377_526_453, // 毫秒（13 位）
      viewd_count: "90286",
      video_url: "https://www.kuaishou.com/short-video/3xryknatvhxq72a",
    },
  ]);
  const r = rows[0]!;
  assert.equal(r.id, "3xryknatvhxq72a");
  assert.equal(r.url, "https://www.kuaishou.com/short-video/3xryknatvhxq72a");
  assert.equal(r.authorId, "02ee500f5b4c5f9a");
  assert.equal(r.metrics.views, 90286);
  assert.equal(r.publishedAt, new Date(1_772_377_526_453).toISOString(), "毫秒时间戳也要能归一");
});

test("归一化：Python 落下的字面量 'None' 当空处理，不挤占候选位", () => {
  // 快手搜索场景 liked_count 实测 20/20 都是字符串 'None'（Python `str(None)` 的产物）。
  // 若不处理，它会作为"看起来有值"的字符串被 pick 选中，把真正可用的候选挤掉。
  const rows = normalizeBatch("ks", "search", "content", [
    { video_id: "v_none", caption: "None", title: "正常标题", liked_count: "None", collected_count: "1234" },
  ]);
  const r = rows[0]!;
  assert.equal(r.title, "正常标题", "caption='None' 应被跳过，回落到 title");
  assert.equal(r.metrics.collects, 1234, "同一行里的真实指标不受影响");
  assert.ok(!("likes" in r.metrics), "解析不出数字时宁可不出现该指标，也不补 0");
});

test("算子 → 记录类型 的映射", () => {
  assert.equal(kindOf("search"), "content");
  assert.equal(kindOf("content_detail"), "content");
  assert.equal(kindOf("comments"), "comment");
  assert.equal(kindOf("creator"), "creator");
});

/* ── 本地缓存 ───────────────────────────────────────────── */

test("缓存：同一记录多次采集保留最新，并按关键词/条数过滤", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-collector-"));
  try {
    const store = new CollectStore(dir);
    const base = normalizeBatch("xhs", "search", "content", [
      { note_id: "n_1", title: "精华 A", desc: "抗老", liked_count: 10 },
      { note_id: "n_2", title: "精华 B", desc: "美白", liked_count: 20 },
    ]);
    await store.append("xhs", base);
    // 再采一次，n_1 的点赞涨了 —— 应覆盖旧值而不是产生第二行
    const again = normalizeBatch("xhs", "search", "content", [{ note_id: "n_1", title: "精华 A", desc: "抗老", liked_count: 99 }]);
    await store.append("xhs", again);

    const all = await store.query("xhs", { op: "search" });
    assert.equal(all.total, 2, "同 id 记录应去重");
    const n1 = all.rows.find((r) => r.id === "n_1")!;
    assert.equal(n1.metrics.likes, 99, "应保留最新一次采集的值");

    const filtered = await store.query("xhs", { op: "search", keyword: "美白" });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.rows[0]!.id, "n_2");

    const limited = await store.query("xhs", { op: "search", limit: 1 });
    assert.equal(limited.rows.length, 1);
    assert.equal(limited.total, 2, "total 反映过滤后的总条数，limit 只影响返回条数");

    // 按 id 也能命中（适配器按 contentId 查详情时依赖这一点）
    const byId = await store.query("xhs", { op: "search", keyword: "n_2" });
    assert.equal(byId.total, 1);

    const stats = await store.stats();
    assert.equal(stats.xhs, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缓存：空目录查询返回空结果而不是抛错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-collector-empty-"));
  try {
    const store = new CollectStore(dir);
    const out = await store.query("bili", {});
    assert.deepEqual(out.rows, []);
    assert.equal(out.collectedAt, null);
    assert.deepEqual(await store.stats(), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 缓存查询：关键词的两种语义 ──────────────────────────────
 *
 * 这一组钉住的是业主实测踩到的那个坑：报告显示"5 条条目级引用未通过校验"，
 * 根因不在模型，而在**采集回来的 220 条数据被判成 0 条**。
 * 采集是拿 `护肤品-精华` 去平台搜的，落库时把搜索词写在行的 `raw.source_keyword` 上；
 * 而查询侧当时只做正文子串过滤 —— 那个串在笔记正文里一个字都不出现，
 * 于是"用 A 搜回来 220 条，再用 A 去查却是 0 条"，数据等于白采。
 */

test("缓存查询：op=search 的关键词是「采集用语」，不要求出现在正文里", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-collector-kw-"));
  try {
    const store = new CollectStore(dir);
    await store.append(
      "xhs",
      normalizeBatch("xhs", "search", "content", [
        { note_id: "n_1", title: "精华怎么选", desc: "抗老胜肽实测", source_keyword: "护肤品-精华" },
        { note_id: "n_2", title: "早C晚A", desc: "换季维稳", source_keyword: "护肤品-精华" },
        // 这一条正文里**恰好**含检索串，但它属于另一批采集 —— 不该混进上面那批
        { note_id: "n_3", title: "面膜复盘", desc: "护肤品-精华 到底怎么挑", source_keyword: "面膜" },
      ]),
    );

    const batch = await store.query("xhs", { op: "search", keyword: "护肤品-精华" });
    assert.deepEqual(
      batch.rows.map((r) => r.id).sort(),
      ["n_1", "n_2"],
      "必须按采集用语取回整批，而不是按正文子串（否则真实数据被全判 0）",
    );
    assert.equal(batch.total, 2);

    // 采集用语匹配不到 → 退回正文子串（兼容没有 source_keyword 的老数据）
    const legacy = await store.query("xhs", { op: "search", keyword: "换季维稳" });
    assert.deepEqual(legacy.rows.map((r) => r.id), ["n_2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 采集任务队列 ────────────────────────────────────────────
 *
 * 内核单会话只能串行跑，但**串行不等于忙就拒**：原来忙时返 409，调用方（brandsale）
 * 只能把请求丢掉，而它一次要扇出七个平台 —— 实测一个 brief 里明写 douyin 的任务，
 * 最后只采到了小红书。这里钉住"忙时入队、闲时自动开跑、同参数去重"。
 */

/** 一个假装是内核解释器的脚本：不产出任何数据，只保证退出码 0（任务能跑完并让出队列） */
function writeFakeKernel(dir: string): string {
  const bin = join(dir, "fake-kernel.sh");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

test("任务队列：内核忙时入队而不是丢弃，前一个跑完自动开跑下一个", async () => {
  const base = mkdtempSync(join(tmpdir(), "brandsale-queue-"));
  try {
    const store = new CollectStore(join(base, "store"));
    const tm = new TaskManager({
      store,
      paths: {
        coreDir: base,
        pythonBin: writeFakeKernel(base),
        runPy: join(base, "run.py"),
        dataDir: join(base, "data"),
        logDir: join(base, "logs"),
      },
      headless: true,
      cdpMode: "false",
      defaultMaxItems: 5,
      maxItemsCap: 20,
      crawlTimeoutMs: 5_000,
      maskNickname: false,
      // 关掉自动补采：这些用例用的是假内核（不产出数据），补采分支另有专门用例
      profileEnrich: { enabled: false, maxAuthors: 3 },
    });

    const first = tm.submit("xhs", "search", { keyword: "精华" });
    assert.ok(first.ok, "空闲时第一个任务应立即开跑");
    assert.equal(first.ok && first.task.state, "running");

    const second = tm.submit("dy", "search", { keyword: "精华" });
    assert.ok(second.ok, "内核忙时也必须受理：入队，而不是 409 让调用方丢弃");
    assert.equal(second.ok && second.task.state, "queued");
    assert.equal(tm.pendingCount(), 1);

    // 同参数重复投递复用排队中的那个，不再堆一条（模型反复调同一算子时靠它挡住）
    const again = tm.submit("dy", "search", { keyword: "精华" });
    assert.ok(again.ok && again.reused === true);
    assert.equal(tm.pendingCount(), 1);

    const deadline = Date.now() + 15_000;
    while ((tm.isBusy() || tm.pendingCount() > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(tm.isBusy(), false, "队列应被自动消化，不需要外部再踢一脚");
    assert.equal(tm.pendingCount(), 0);
    assert.equal(tm.list().length, 2);
    const states = tm.list().map((t) => `${t.platform}:${t.state}`).sort();
    assert.deepEqual(states, ["dy:done", "xhs:done"], `两个任务都应跑完，实际 ${states.join(",")}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("归一化：原始 ID 已不存在，authorId 只能取 creator_hash", () => {
  // 七平台统一把 user_id / uid / mid 换成 creator_hash（tools/user_hash.py，仅 ID 匿名化）；
  // 昵称则完整保留。
  // 映射表若还找 user_id，authorId 就会**恒为空**——报告里所有作者都成匿名。
  const rows = normalizeBatch("xhs", "search", "content", [
    { note_id: "n_1", title: "t", nickname: "福气菜友", creator_hash: "18ff08bb1c898356" },
  ]);
  assert.equal(rows[0]!.authorId, "18ff08bb1c898356");
  assert.equal(rows[0]!.author, "福气菜友");
});

test("归一化：大数指标是中文单位字符串（7.8万 / 1.2亿），不能静默丢掉", () => {
  const rows = normalizeBatch("xhs", "search", "content", [
    { note_id: "n_1", title: "t", liked_count: "7.8万", collected_count: "3928", comment_count: "1.2亿", share_count: "3567" },
  ]);
  const m = rows[0]!.metrics;
  assert.equal(m.likes, 78000, "'7.8万' → 78000");
  assert.equal(m.collects, 3928, "纯数字串照常解析");
  assert.equal(m.comments, 120000000, "'1.2亿' → 1.2e8");
  assert.equal(m.shares, 3567);

  // 认不出的单位一律不猜，宁可缺指标也不要错的数量级
  const weird = normalizeBatch("xhs", "search", "content", [{ note_id: "n_2", title: "t", liked_count: "约1千" }]);
  assert.equal(weird[0]!.metrics.likes, undefined);
});

test("归一化：评论必须按评论字段表走，不能取所属笔记的 note_id", () => {
  // 真机暴露的坑：一次 search 同时产出 contents 与 comments 两类文件。
  // 若按算子统一推类型，评论行会落到 content 字段表 —— id 被取成 note_id，
  // 同一笔记下几百条评论去重后塌缩成 1 条，评论查询恒为 0。
  const raw = [
    { comment_id: "c_1", note_id: "n_1", content: "好用", nickname: "甲路人", creator_hash: "h1", like_count: "4.7万" },
    { comment_id: "c_2", note_id: "n_1", content: "回购", nickname: "乙路人", creator_hash: "h2", like_count: "12" },
  ];
  const asComment = normalizeBatch("xhs", "search", "comment", raw);
  assert.deepEqual(asComment.map((r) => r.id), ["c_1", "c_2"]);
  assert.equal(asComment[0]!.authorId, "h1");
  assert.equal(asComment[0]!.metrics.likes, 47000);

  // 反面证据：走内容字段表会塌缩成同一个 id（这正是修复前的行为）
  const asContent = normalizeBatch("xhs", "search", "content", raw);
  assert.deepEqual(asContent.map((r) => r.id), ["n_1", "n_1"]);
});

/* ── 读取内核落盘 ────────────────────────────────────────── */

test("读取落盘：内核在平台目录下**再分一层** SAVE_DATA_OPTION 子目录，必须递归找到", async () => {
  // 这是真数据跑通后才暴露的 bug：内核写 <platform>/jsonl/*.jsonl，
  // 而早期实现只 readdir 平台目录顶层、按扩展名过滤，于是把 `jsonl/` 这个
  // **目录**当成不匹配项跳过 —— 采集成功、collector 却报"未读到任何记录"。
  const dir = mkdtempSync(join(tmpdir(), "bs-collector-"));
  try {
    const sub = join(dir, "xhs", "jsonl");
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, "search_contents_2026-10-09.jsonl"),
      `${JSON.stringify({ note_id: "n_1", title: "t1" })}\n${JSON.stringify({ note_id: "n_2", title: "t2" })}\n`,
      "utf8",
    );
    writeFileSync(join(sub, "search_comments_2026-10-09.jsonl"), `${JSON.stringify({ comment_id: "c_1" })}\n`, "utf8");

    // 快照在写文件之前拍 → 两个文件都是"本次新建"，全部行都算新增
    const out = await readRecordsSince(dir, "xhs", new Map(), "content");
    assert.deepEqual(out.files.sort(), [
      "jsonl/search_comments_2026-10-09.jsonl",
      "jsonl/search_contents_2026-10-09.jsonl",
    ]);

    // 类型必须**按文件**判定：一次 search 同时产出内容和评论，不能都当成内容
    assert.equal(out.groups.length, 2);
    const contents = out.groups.find((g) => g.itemType === "contents");
    const comments = out.groups.find((g) => g.itemType === "comments");
    assert.equal(contents?.kind, "content");
    assert.equal(contents?.records.length, 2);
    assert.equal(comments?.kind, "comment", "search_comments_* 必须归成 comment");
    assert.equal(comments?.records.length, 1);

    // 平台目录整个不存在时要静默返回空，不能抛
    const none = await readRecordsSince(join(dir, "不存在的平台"), "xhs", new Map(), "content");
    assert.deepEqual(none, { files: [], groups: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读取落盘：快照之后只取**新增行**，不重复吞当天旧数据", async () => {
  // 真机暴露：内核的 jsonl 是**按天共享**的（`search_comments_2026-10-09.jsonl`）。
  // 同一天在同一平台跑第二个任务时，文件已存在、只是被追加 —— 早期实现按"文件 mtime"
  // 判断本次是否被写过，命中就**整文件重读**，于是把当天旧行重新吞一遍并打上当前算子的
  // 标签（贴吧实测：真采 3 条的 comments 任务报 stored: 14，多出的 11 条来自上一个
  // content_detail 任务；行键含 op，所以同一条记录在缓存里存了两份，按 kind 汇总会重复计数）。
  const dir = mkdtempSync(join(tmpdir(), "bs-collector-"));
  try {
    const sub = join(dir, "tieba", "jsonl");
    mkdirSync(sub, { recursive: true });
    const contents = join(sub, "detail_contents_2026-10-09.jsonl");
    const comments = join(sub, "detail_comments_2026-10-09.jsonl");
    writeFileSync(contents, `${JSON.stringify({ note_id: "n_1" })}\n`, "utf8");
    writeFileSync(comments, `${JSON.stringify({ comment_id: "c_1" })}\n${JSON.stringify({ comment_id: "c_2" })}\n`, "utf8");

    // 采集开始：拍快照
    const snap = await snapshotDataFiles(dir, "tieba");
    assert.equal(snap.get(contents), 1, "1 条记录 = 1 行（不计结尾换行产生的空元素）");
    assert.equal(snap.get(comments), 2);

    // 采集期间：contents 追加 1 条、comments 一条没写
    writeFileSync(contents, `${JSON.stringify({ note_id: "n_2" })}\n`, { flag: "a", encoding: "utf8" });

    const out = await readRecordsSince(dir, "tieba", snap, "content");
    assert.deepEqual(out.files, ["jsonl/detail_contents_2026-10-09.jsonl"], "本次没写过的文件不该出现");
    const g = out.groups.find((x) => x.itemType === "contents");
    assert.equal(g?.records.length, 1, "只应读到新增的那 1 条，而不是整份 2 条");
    assert.equal((g?.records[0] as { note_id: string }).note_id, "n_2");

    // 本次追加的评论能被读到，旧的两条不会被重读
    const snap2 = await snapshotDataFiles(dir, "tieba");
    writeFileSync(comments, `${JSON.stringify({ comment_id: "c_3" })}\n`, { flag: "a", encoding: "utf8" });
    const out2 = await readRecordsSince(dir, "tieba", snap2, "comment");
    const c = out2.groups.find((x) => x.itemType === "comments");
    assert.equal(c?.records.length, 1);
    assert.equal((c?.records[0] as { comment_id: string }).comment_id, "c_3");

    // 防御：文件被**重写**（行数变少）时整读，宁可重复也不丢数据
    writeFileSync(contents, `${JSON.stringify({ note_id: "rewritten" })}\n`, "utf8");
    const out3 = await readRecordsSince(dir, "tieba", snap2, "content");
    const g3 = out3.groups.find((x) => x.itemType === "contents");
    assert.equal(g3?.records.length, 1);
    assert.equal((g3?.records[0] as { note_id: string }).note_id, "rewritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读取落盘：文件名不符合命名规则时退回 fallbackKind，不硬猜", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-collector-"));
  try {
    // ⚠️ 平台短码 ≠ 落盘目录名：bili→bili / dy→douyin / ks→kuaishou / wb→weibo。
    // 这里**写死**内核真实目录名，不从 meta 取 —— 从 meta 取的话，table 本身写错时
    // 测试会跟着一起错，仍然"绿着"（B站就真的这么错过一次：table 写了 bilibili，
    // 内核写的是 bili，于是真机采集成功、collector 却报"未读到任何归一化记录"）。
    const sub = join(dir, "bili", "jsonl");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "whatever_2026-10-09.jsonl"), `${JSON.stringify({ bvid: "BV1" })}\n`, "utf8");

    const out = await readRecordsSince(dir, "bili", new Map(), "creator");
    assert.equal(out.groups.length, 1);
    assert.equal(out.groups[0]!.itemType, "unknown");
    assert.equal(out.groups[0]!.kind, "creator", "识别不出文件类型时用调用方给的兜底类型");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 落盘目录名 = 内嵌内核 store 的 platform= ──────────────── */

test("落盘目录名必须与内嵌内核 store 的 platform= 完全一致", () => {
  // 为什么钉这个：collector 靠"平台目录名"去找内核落盘的 jsonl。table 与内核不一致时，
  // 采集本身是**成功**的（子进程 exit 0、文件确实写出来了），collector 却报
  // "未读到任何归一化记录" —— 一个纯配置错位伪装成"平台没数据"，最难查。
  // B站就真踩过：table 写 `bilibili`、内核写 `bili`。
  // 内核就在本仓库里，所以直接读它的源码字面量，把这个跨语言契约变成可执行断言。
  const storeRoot = join(process.cwd(), "services", "collector-core", "store");
  const literals = new Set<string>();
  for (const d of readdirSync(storeRoot)) {
    const file = join(storeRoot, d, "_store_impl.py");
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/platform\s*=\s*"([^"]+)"/g)) literals.add(m[1]!);
  }
  assert.ok(literals.size > 0, "没能从内核 store 源码里读到任何 platform= 字面量（路径或写法变了？）");
  for (const p of MEDIA_CRAWLER_PLATFORMS) {
    const name = MEDIA_CRAWLER_PLATFORM_META[p].dataDirName;
    assert.ok(
      literals.has(name),
      `${p} 的 dataDirName="${name}" 在内核 store 里找不到对应的 platform="${name}"；内核实际写的是：${[...literals].sort().join(" / ")}`,
    );
  }
});

/* ── B站：搜索结果能否喂回 detail ─────────────────────────── */

test("B站：搜索拿到的 id / url 必须能喂回详情算子（BV / av / 裸 aid 三种形式）", () => {
  // 真机暴露的闭环缺陷：搜索结果的落盘字段里**没有 BV 号**（store 只写 video_id = aid），
  // url 也是 /video/av<aid>；而上游解析器只认 BV —— 于是"搜索→详情"这条路
  // 会在 ValueError: Unable to parse video ID 上直接断掉。
  // 这条断言跨语言调内核的函数，把闭环钉住（缺 Python 环境时跳过，不假装通过）。
  const coreDir = join(process.cwd(), "services", "collector-core");
  const py = join(coreDir, ".venv", "bin", "python");
  if (!existsSync(py)) {
    // 没准备内核环境（npm run collector:setup）时无法验证，明确跳过
    console.log("  ↷ 跳过：未找到内核 Python（services/collector-core/.venv/bin/python）");
    return;
  }
  const script = [
    "from media_platform.bilibili.help import parse_video_info_from_url as p",
    "cases = ['BV1d54y1g7db', 'https://www.bilibili.com/video/av1055448934', '1055448934',",
    "         'https://www.bilibili.com/video/BV1dwuKzmE26/?spm_id_from=333.1387']",
    "print('|'.join(p(c).video_id for c in cases))",
  ].join("\n");
  const r = spawnSync(py, ["-c", script], { cwd: coreDir, encoding: "utf8" });
  assert.equal(r.status, 0, `内核解析器调用失败：${r.stderr || r.stdout}`);
  assert.deepEqual(r.stdout.trim().split("|"), [
    "BV1d54y1g7db",
    "1055448934", // av 号 → aid（详情接口按 aid 取）
    "1055448934", // 裸 aid
    "BV1dwuKzmE26",
  ]);
});

/* ── 微博：搜索结果能否喂回 detail ─────────────────────────── */

test("微博：搜索拿到的 url 必须能喂回详情算子（内核只吃纯 note_id）", () => {
  // 与 B站 同类的闭环缺陷，但更隐蔽：微博详情接口是拿 id 去拼 `{host}/detail/{id}`，
  // 把归一化输出里的 url（`https://m.weibo.cn/detail/<id>`）原样传进去，会拼成
  // `.../detail/https://m.weibo.cn/detail/<id>` —— 微博回 404 页面，
  // 结果是**子进程 exit 0 + 0 条记录**，看起来像"这条没数据"而不是"入参不对"。
  // run.py 的薄入口负责把 URL 收敛回 id，这里跨语言调它钉住。
  const coreDir = join(process.cwd(), "services", "collector-core");
  const py = join(coreDir, ".venv", "bin", "python");
  if (!existsSync(py)) {
    console.log("  ↷ 跳过：未找到内核 Python（services/collector-core/.venv/bin/python）");
    return;
  }
  const script = [
    "import run",
    "cases = ['5352201578875308',",
    "         'https://m.weibo.cn/detail/5352201578875308',",
    "         'https://m.weibo.cn/detail/5352201578875308?type=comment',",
    "         'https://weibo.com/1234567890/5352201578875308']",
    "print('|'.join(run._normalize_weibo_note_id(c) for c in cases))",
  ].join("\n");
  const r = spawnSync(py, ["-c", script], { cwd: coreDir, encoding: "utf8" });
  assert.equal(r.status, 0, `run.py 归一化调用失败：${r.stderr || r.stdout}`);
  assert.deepEqual(r.stdout.trim().split("|"), [
    "5352201578875308", // 裸 note_id 原样
    "5352201578875308", // m.weibo.cn/detail/<id>
    "5352201578875308", // 带查询串
    "5352201578875308", // /statuses/<id> 形态
  ]);
});

/* ── 贴吧：搜索结果能否喂回 detail ─────────────────────────── */

test("贴吧：搜索拿到的 url 必须能喂回详情算子（/p/<id> 收敛回 note_id）", () => {
  // 与 B站 / 微博 同类的闭环契约。贴吧落盘的 note_url 就是 `https://tieba.baidu.com/p/<id>`，
  // 而 --specified-id 只吃 note_id。
  const coreDir = join(process.cwd(), "services", "collector-core");
  const py = join(coreDir, ".venv", "bin", "python");
  if (!existsSync(py)) {
    console.log("  ↷ 跳过：未找到内核 Python（services/collector-core/.venv/bin/python）");
    return;
  }
  const script = [
    "import run",
    "cases = ['4545338662',",
    "         'https://tieba.baidu.com/p/4545338662',",
    "         'https://tieba.baidu.com/p/4545338662?pn=1']",
    "print('|'.join(run._normalize_tieba_note_id(c) for c in cases))",
  ].join("\n");
  const r = spawnSync(py, ["-c", script], { cwd: coreDir, encoding: "utf8" });
  assert.equal(r.status, 0, `run.py 归一化调用失败：${r.stderr || r.stdout}`);
  assert.deepEqual(r.stdout.trim().split("|"), [
    "4545338662", // 裸 note_id 原样
    "4545338662", // /p/<id>
    "4545338662", // 带查询串
  ]);
});

/* ── 贴吧：登录流程不得硬失败 ────────────────────────────── */

test("贴吧：登录找不到二维码时不得 sys.exit（会把整条链路带 traceback 打死）", () => {
  // 真机暴露：贴吧首页不自动弹码，且登录入口选择器随改版变化（老 `li.u_login` → 新 `div.login-btn`）。
  // 上游行为是「找不到码 → 点老选择器（Timeout 30s）→ sys.exit()」——SystemExit 不被任何
  // except Exception 捕获，子进程直接死、日志只剩 traceback，上层只能给一句"未登录"的猜测。
  // 这里把两件事钉住：① 不再出现**真实调用**的 sys.exit（注释里提到不算）；② 二维码探测支持
  // 短超时入参（否则"确认没有"要白等 30s）。
  const coreDir = join(process.cwd(), "services", "collector-core");
  const py = join(coreDir, ".venv", "bin", "python");
  if (!existsSync(py)) {
    console.log("  ↷ 跳过：未找到内核 Python（services/collector-core/.venv/bin/python）");
    return;
  }
  const script = [
    "import ast, inspect",
    "src = open('media_platform/tieba/login.py', encoding='utf-8').read()",
    "tree = ast.parse(src)",
    "exits = [n for n in ast.walk(tree)",
    "         if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)",
    "         and n.func.attr == 'exit' and isinstance(n.func.value, ast.Name)",
    "         and n.func.value.id == 'sys']",
    "from tools.crawler_util import find_login_qrcode",
    "params = inspect.signature(find_login_qrcode).parameters",
    "print(len(exits), 'timeout_ms' in params)",
  ].join("\n");
  const r = spawnSync(py, ["-c", script], { cwd: coreDir, encoding: "utf8" });
  assert.equal(r.status, 0, `内核源码检查失败：${r.stderr || r.stdout}`);
  assert.equal(r.stdout.trim(), "0 True", "不应有真实的 sys.exit 调用，且探测二维码需支持短超时");
});

/* ── 知乎：详情页（SSR）字段不得静默归零 ──────────────────── */

test("知乎：详情页 HTML(SSR) 与搜索接口(API) 必须归一化出同样的数值字段", () => {
  // 真机暴露的静默数据损失：知乎同一条回答有**两套命名**——
  //   搜索 / 评论走 JSON API，键是 snake_case（`created_time` / `voteup_count`）；
  //   详情走落地页 HTML 的 `js-initialData`，键是 camelCase（`createdTime` / `voteupCount`）。
  // 上游提取器只认 snake_case，于是经搜索带出的 `voteup_count=4`、时间戳，走详情全变
  // 0 / None，报告里读成"零互动"。比缺字段更有害：它**看起来有值**。
  // 这里把两种输入喂给同一个提取器，断言产出必须一致（缺 Python 环境时跳过）。
  const coreDir = join(process.cwd(), "services", "collector-core");
  const py = join(coreDir, ".venv", "bin", "python");
  if (!existsSync(py)) {
    console.log("  ↷ 跳过：未找到内核 Python（services/collector-core/.venv/bin/python）");
    return;
  }
  const script = [
    "from media_platform.zhihu.help import ZhihuExtractor",
    "ex = ZhihuExtractor()",
    "base = {'id': '2088627738299085227', 'type': 'answer', 'content': '<p>正文</p>',",
    "        'question': {'id': '1930207888737014984', 'title': '我想天天敷面膜，可以吗？'},",
    "        'author': {'id': '7d0119971924be5c9495caedf64867d9', 'name': '某人'}}",
    // camelCase：详情页 SSR 的真实形态（键名取自真机 dump）
    "ssr = dict(base, excerpt='摘要', createdTime=1790747657, updatedTime=1790747658,",
    "           voteupCount=4, commentCount=7)",
    // snake_case：搜索接口的形态
    "api = dict(base, title='我想天天敷面膜，可以吗？', description='摘要', created_time=1790747657,",
    "           updated_time=1790747658, voteup_count=4, comment_count=7)",
    "def sig(a):",
    "    return '|'.join(str(x) for x in (a.created_time, a.updated_time, a.voteup_count,",
    "                                      a.comment_count, bool(a.title), a.question_id))",
    "print(sig(ex._extract_answer_content(ssr)), sig(ex._extract_answer_content(api)))",
  ].join("\n");
  const r = spawnSync(py, ["-c", script], { cwd: coreDir, encoding: "utf8" });
  assert.equal(r.status, 0, `知乎提取器调用失败：${r.stderr || r.stdout}`);
  const [ssr, api] = r.stdout.trim().split(/\s+/);
  assert.equal(
    ssr,
    api,
    `SSR(camelCase) 与 API(snake_case) 归一化结果不一致：SSR=${ssr} API=${api}（camelCase 又没被读取？）`,
  );
  // 顺带钉住不是"两边都为 0"的假通过
  assert.match(api!, /^1790747657\|1790747658\|4\|7\|True\|1930207888737014984$/);
});

/* ── 创作者资料页落盘：逐平台能力边界 ────────────────────── */

test("creator 资料页落盘：七个平台都必须真写（报告粉丝量的地基，不许退回空操作）", () => {
  // 为什么钉：报告人选页的「粉丝量」一列**只能**来自个人主页公开统计，
  // 而资料是 `save_creator` → `store_creator` 两跳写出来的。上游教学版把其中
  // 一跳写成空操作（`return` / `pass`），于是一整列数据恒为"未采集"——
  // 业主实测追问"这个个人主页都有粉丝数，为什么拿不到？"。这里把它钉死：
  // **任何一个平台的 store_creator 退回空操作，报告就会退回"未采集"。**
  const coreDir = join(process.cwd(), "services", "collector-core");
  const py = join(coreDir, ".venv", "bin", "python");
  if (!existsSync(py)) {
    console.log("  ↷ 跳过：未找到内核 Python（services/collector-core/.venv/bin/python）");
    return;
  }
  const script = [
    "import ast",
    "plats = {'xhs': 'XhsJsonlStoreImplement', 'douyin': 'DouyinJsonlStoreImplement',",
    "         'kuaishou': 'KuaishouJsonlStoreImplement', 'bilibili': 'BiliJsonlStoreImplement',",
    "         'weibo': 'WeiboJsonlStoreImplement', 'tieba': 'TieBaJsonlStoreImplement',",
    "         'zhihu': 'ZhihuJsonlStoreImplement'}",
    "def trivial_noop(p, cls_name):",
    "    tree = ast.parse(open('store/%s/_store_impl.py' % p, encoding='utf-8').read())",
    "    for c in tree.body:",
    "        if isinstance(c, ast.ClassDef) and c.name == cls_name:",
    "            for fn in c.body:",
    "                if isinstance(fn, ast.AsyncFunctionDef) and fn.name == 'store_creator':",
    "                    body = [b for b in fn.body",
    "                            if not (isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant))]",
    "                    return len(body) == 1 and isinstance(body[0], ast.Pass)",
    "    return None",
    "noop = sorted(p for p, c in plats.items() if trivial_noop(p, c))",
    "zhihu_core = open('media_platform/zhihu/core.py', encoding='utf-8').read()",
    "print('NOOP=' + (','.join(noop) or 'none') + ' ZHIHU=' + str('save_creator' in zhihu_core))",
  ].join("\n");
  const r = spawnSync(py, ["-c", script], { cwd: coreDir, encoding: "utf8" });
  assert.equal(r.status, 0, `内核源码检查失败：${r.stderr || r.stdout}`);
  const m = /NOOP=(\S*) ZHIHU=(\S+)/.exec(r.stdout.trim());
  assert.ok(m, `解析内核检查输出失败：${r.stdout}`);
  const noop = m![1] === "none" ? "" : m![1]!;
  const saveCreators = m![2]!;
  assert.equal(
    noop,
    "",
    `这些平台的 store_creator 又变回空操作了：${noop}。报告「粉丝量」一列会随之为空，请连工具描述一起复核`,
  );
  assert.equal(
    saveCreators,
    "False",
    "知乎 core.py 仍不调用 save_creator —— 它的 creator 模式本来就只抓内容，不抓主页资料。" +
      "store 那层已能落盘，但知乎的粉丝量要等 core 接上（见 docs/data-provenance-design.md §13）",
  );
});

/* ── 算子 → 内嵌内核 CLI 参数 ────────────────────────────── */

const PATHS = {
  coreDir: "/repo/services/collector-core",
  pythonBin: "/repo/services/collector-core/.venv/bin/python",
  runPy: "/repo/services/collector-core/run.py",
  dataDir: "/repo/services/collector-core/data",
  logDir: "/repo/.data-collector/logs",
};
const valOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];
/** 构造一次采集请求；浏览器模式默认 auto，个别用例再覆盖 */
const req = (o: {
  platform: Parameters<typeof buildRunnerArgs>[0]["platform"];
  op: Parameters<typeof buildRunnerArgs>[0]["op"];
  params: Record<string, unknown>;
  maxItems: number;
  headless: boolean;
  cdpMode?: "auto" | "true" | "false" | "reuse";
  cdpPort?: number;
}): Parameters<typeof buildRunnerArgs>[0] => ({ cdpMode: "auto", cdpPort: 9222, ...o });

test("算子 → CLI 参数：search 用 --keywords，detail 用 --specified-id", () => {
  const search = buildRunnerArgs(req({ platform: "xhs", op: "search", params: { keyword: "精华" }, maxItems: 20, headless: false }), PATHS);
  assert.equal(search[0], PATHS.runPy);
  assert.equal(valOf(search, "--platform"), "xhs");
  assert.equal(valOf(search, "--save-path"), PATHS.dataDir);
  assert.equal(valOf(search, "--type"), "search");
  assert.equal(valOf(search, "--keywords"), "精华");
  assert.equal(valOf(search, "--max-notes"), "20");
  assert.equal(valOf(search, "--headless"), "false");

  const detail = buildRunnerArgs(
    req({ platform: "dy", op: "content_detail", params: { url: "https://v.douyin.com/xxx/" }, maxItems: 5, headless: true }),
    PATHS,
  );
  assert.equal(valOf(detail, "--type"), "detail");
  assert.equal(valOf(detail, "--specified-id"), "https://v.douyin.com/xxx/", "URL 形式的 ID 应原样透传");
  assert.equal(valOf(detail, "--headless"), "true");
});

test("算子 → CLI 参数：comments 走 detail + 评论开关，二级评论跟着 subComments", () => {
  const args = buildRunnerArgs(
    req({ platform: "bili", op: "comments", params: { contentId: "BV1xx", subComments: true }, maxItems: 10, headless: false }),
    PATHS,
  );
  assert.equal(valOf(args, "--type"), "detail");
  assert.equal(valOf(args, "--specified-id"), "BV1xx");
  assert.equal(valOf(args, "--get-comments"), "true");
  assert.equal(valOf(args, "--get-sub-comments"), "true");
  assert.equal(valOf(args, "--max-comments"), "10");

  // 未显式要求二级评论时必须是 false（默认不抓，减少请求量）
  const noSub = buildRunnerArgs(
    req({ platform: "wb", op: "comments", params: { contentId: "c1" }, maxItems: 10, headless: false }),
    PATHS,
  );
  assert.equal(valOf(noSub, "--get-sub-comments"), "false");
});

/* ── 常驻浏览器复用（--cdp reuse）────────────────────────── */

test("CLI 参数：reuse 模式必须下发固定 --cdp-port，其它模式不下发", () => {
  const reuse = buildRunnerArgs(
    req({
      platform: "xhs",
      op: "search",
      params: { keyword: "精华" },
      maxItems: 5,
      headless: false,
      cdpMode: "reuse",
      cdpPort: 9333,
    }),
    PATHS,
  );
  assert.equal(valOf(reuse, "--cdp"), "reuse");
  assert.equal(
    valOf(reuse, "--cdp-port"),
    "9333",
    "reuse 模式下端口必须显式下发：内核靠它判断「这个端口上有没有可复用的常驻浏览器」，" +
      "collector 靠同一个端口回收（apps/collector/src/browser-session.ts）。" +
      "漏掉它内核会自己向上找空闲端口 —— 结果是复用错平台的登录态，且窗口再也回收不掉",
  );

  // 其余三态每次都是任务级浏览器，端口由内核自己找，不该被固定
  for (const mode of ["auto", "true", "false"] as const) {
    const args = buildRunnerArgs(
      req({ platform: "xhs", op: "search", params: { keyword: "精华" }, maxItems: 5, headless: false, cdpMode: mode }),
      PATHS,
    );
    assert.equal(valOf(args, "--cdp"), mode);
    /* 用 includes 判存在：valOf 在 flag 缺席时会取到 args[0]（run.py 路径），
     * 那正是这个断言最容易假过的地方。 */
    assert.equal(args.includes("--cdp-port"), false, `${mode} 模式不该下发 --cdp-port`);
  }
});

test("平台元数据：cdpPort 一平台一个且固定（复用与回收都靠它定位）", () => {
  const ports = MEDIA_CRAWLER_PLATFORMS.map((p) => MEDIA_CRAWLER_PLATFORM_META[p].cdpPort);
  assert.equal(
    new Set(ports).size,
    ports.length,
    `cdpPort 出现重复：${ports.join(", ")}。端口共用会让后启动的平台连上前一个平台的会话，串掉登录态`,
  );
  /* 快照式锁定。端口漂移的后果很隐蔽：上一轮留下的常驻浏览器回收不到，
   * 窗口一直挂在桌面上 —— 正是这次要修的那个观感问题。 */
  assert.deepEqual(
    MEDIA_CRAWLER_PLATFORMS.map((p) => `${p}:${MEDIA_CRAWLER_PLATFORM_META[p].cdpPort}`),
    ["xhs:9333", "dy:9334", "ks:9335", "bili:9336", "wb:9337", "tieba:9338", "zhihu:9339"],
  );
});

test("回收常驻浏览器：端口上不是浏览器时绝不动手", async () => {
  const { createServer } = await import("node:net");
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    if (listenersOnPort(port).length === 0) return; // 环境没有 lsof（精简容器）→ 无从回收，跳过

    const logs: string[] = [];
    assert.equal(
      reapBrowser(port, (m) => logs.push(m)),
      0,
      `端口 ${port} 上跑的是 node，名字不像浏览器 —— 绝不能杀。` +
        "端口是 collector 自己挑的固定值，但本机别的程序也可能占着，误杀代价远大于漏收一个窗口",
    );
    assert.ok(
      logs.some((l) => l.includes("非浏览器")),
      `应留下「不回收」的说明供排障，实际输出：${logs.join(" / ") || "（空）"}`,
    );
  } finally {
    server.close();
  }
});

test("算子 → CLI 参数：creator 用 --creator-id（不是 keywords）", () => {
  const args = buildRunnerArgs(
    req({ platform: "zhihu", op: "creator", params: { creatorId: "u_9" }, maxItems: 3, headless: true }),
    PATHS,
  );
  assert.equal(valOf(args, "--type"), "creator");
  assert.equal(valOf(args, "--creator-id"), "u_9");
  assert.ok(!args.includes("--keywords"), "creator 模式不该带 keywords");
});

test("算子 → CLI 参数：浏览器模式透传 --cdp，默认 auto", () => {
  // auto 是默认：内核自己判断本机有没有 Chrome/Edge，避免强行下载 150MB chromium
  const auto = buildRunnerArgs(
    req({ platform: "xhs", op: "search", params: { keyword: "x" }, maxItems: 1, headless: false }),
    PATHS,
  );
  assert.equal(valOf(auto, "--cdp"), "auto");

  for (const mode of ["true", "false"] as const) {
    const args = buildRunnerArgs(
      req({ platform: "xhs", op: "search", params: { keyword: "x" }, maxItems: 1, headless: false, cdpMode: mode }),
      PATHS,
    );
    assert.equal(valOf(args, "--cdp"), mode);
  }
});

test("算子 → CLI 参数：未知算子直接抛错，不透传给内核", () => {
  assert.throws(() => buildRunnerArgs(req({ platform: "xhs", op: "whatever" as never, params: {}, maxItems: 1, headless: false }), PATHS), /未知算子/);
});

/* ── 内核报错的提取（子进程非 0 退出时） ─────────────────────── */

test("内核报错：取带消息的根因，不被外层的 tenacity.RetryError 带偏", () => {
  // 真机实录（微博 creator 传了脱敏 hash）。尾部的 RetryError 只是重试包装，
  // 而"这里还没有内容"才是根因——提取错了会把人送去查登录态。
  const dir = mkdtempSync(join(tmpdir(), "bs-log-"));
  try {
    const f = join(dir, "t.log");
    writeFileSync(
      f,
      [
        "2026-10-09 20:43:11 MediaCrawler INFO (core.py:325) - [WeiboCrawler] Begin get weibo creators",
        "Traceback (most recent call last):",
        '  File "/x/tenacity/_asyncio.py", line 88, in async_wrapped',
        "    return await fn(*args, **kwargs)",
        "  File \"/x/media_platform/weibo/client.py\", line 315, in get_creator_info_by_id",
        "    raise DataFetchError(data.get(\"msg\", \"response error\"))",
        "media_platform.weibo.exception.DataFetchError: 这里还没有内容",
        "tenacity.RetryError: RetryError[<Future at 0x113d7f890 state=finished raised DataFetchError>]",
        "[collector-core] 采集失败：RetryError[<Future at 0x113d7f890 state=finished raised DataFetchError>]",
        "2026-10-09 20:43:24 MediaCrawler INFO (cdp_browser.py:57) - [CDPBrowserManager] atexit: Cleaning up",
      ].join("\n"),
      "utf8",
    );
    assert.equal(lastKernelError(f), "media_platform.weibo.exception.DataFetchError: 这里还没有内容");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内核报错：Playwright 超时能被指出来（历史故障：goto 默认等 load 30s）", () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-log-"));
  try {
    const f = join(dir, "t.log");
    writeFileSync(
      f,
      [
        "  File \"x.py\", line 1, in fn",
        "playwright._impl._errors.TimeoutError: Page.goto: Timeout 30000ms exceeded.",
        "[collector-core] 采集失败：TimeoutError",
      ].join("\n"),
      "utf8",
    );
    assert.match(lastKernelError(f)!, /TimeoutError: Page\.goto: Timeout 30000ms exceeded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内核报错：日志不存在 / 没有可用报错行时返回 null，不抛错", () => {
  assert.equal(lastKernelError("/definitely/not/here.log"), null);
  const dir = mkdtempSync(join(tmpdir(), "bs-log-"));
  try {
    const f = join(dir, "t.log");
    writeFileSync(f, "全部正常，没有任何错误\n", "utf8");
    assert.equal(lastKernelError(f), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 假内核（比 `exit 0` 再多做一件事）：按 --type 往 --save-path 下写一条 jsonl。
 *
 * 用来验证"搜索完成后自动补采作者主页"这条派生链 —— 它依赖真实落盘的行，
 * 光靠空跑的假内核触发不了。
 *
 * `FAKE_KERNEL_DELAY_MS` 让内核"占住"一段时间：内核单会话串行，只有它还在跑时
 * 后续提交才会真排队 —— 测"队列满时补采进积压"必须能稳定造出这个状态。
 */
function writeFakeKernelWithData(dir: string): string {
  const bin = join(dir, "fake-kernel-data.cjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ""; };
const save = get("--save-path"), type = get("--type"), platform = get("--platform");
const dirName = { xhs: "xhs", dy: "douyin", bili: "bili", wb: "weibo" }[platform] || platform;
const out = path.join(save, dirName, "jsonl");
fs.mkdirSync(out, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const push = (itemType, obj) => fs.appendFileSync(path.join(out, type + "_" + itemType + "_" + day + ".jsonl"), JSON.stringify(obj) + "\\n");
if (type === "search") {
  // 两个作者各一条内容；u1 出现两次，用于验证按作者去重
  push("contents", { note_id: "n1", title: "t1", nickname: "甲", creator_hash: "h1", author_user_id: "u1", liked_count: "10" });
  push("contents", { note_id: "n2", title: "t2", nickname: "乙", creator_hash: "h2", author_user_id: "u2", liked_count: "20" });
  push("contents", { note_id: "n3", title: "t3", nickname: "甲", creator_hash: "h1", author_user_id: "u1", liked_count: "30" });
} else if (type === "creator") {
  // 资料行
  push("creators", { creator_hash: "h1", user_id: "u1", nickname: "甲", fans: "1234", follows: "12", home_url: "https://example.com/u1" });
  // ⚠️ 顺带写一条**作品行**：真机内核在 creator 模式下确实会写
  // （B站 CREATOR_MODE 会把该 UP 的全部作品连评论一起爬）。它不该被当成"资料行"
  // 落进缓存 —— 落了就会污染报告的主页链接与粉丝量那两列。
  push("contents", { video_id: "v-should-be-ignored", title: "作品行不该进资料行", nickname: "甲", creator_hash: "h1" });
}
const delay = Number(process.env.FAKE_KERNEL_DELAY_MS || 0);
if (delay > 0) setTimeout(() => process.exit(0), delay); else process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

test("作者主页自动补采：搜索完成后按 author_user_id 派生 profile-only 的 creator 任务（按作者去重）", async () => {
  const base = mkdtempSync(join(tmpdir(), "brandsale-enrich-"));
  try {
    const store = new CollectStore(join(base, "store"));
    const tm = new TaskManager({
      store,
      paths: {
        coreDir: base,
        pythonBin: writeFakeKernelWithData(base),
        runPy: join(base, "run.py"),
        dataDir: join(base, "data"),
        logDir: join(base, "logs"),
      },
      headless: true,
      cdpMode: "false",
      defaultMaxItems: 5,
      maxItemsCap: 20,
      crawlTimeoutMs: 15_000,
      maskNickname: false,
      profileEnrich: { enabled: true, maxAuthors: 3 },
    });

    const first = tm.submit("xhs", "search", { keyword: "精华" });
    assert.ok(first.ok && first.task.state === "running");

    const deadline = Date.now() + 30_000;
    while ((tm.isBusy() || tm.pendingCount() > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(tm.isBusy(), false, "派生的补采任务也要被自动消化完");

    const creators = tm.list().filter((t) => t.op === "creator");
    assert.equal(creators.length, 1, "整批合成一个任务（内核支持逗号分隔的 ID 列表），不是一人一个");
    assert.ok(creators.every((t) => t.profileOnly === true), "补采必须是 profile-only（只看主页，不抓作品）");
    assert.equal(creators[0]!.params.creatorId, "u1,u2", "两个作者去重后合成一个 ID 列表；u1 出现两次只补一次");
    assert.ok(creators.every((t) => Boolean(t.derivedFrom)), "派生任务要能回溯到发起它的那次搜索");

    // 资料真的落进了缓存，且归一化出 followers —— 这是报告"粉丝量"一列的唯一来源
    const q = await store.query("xhs", { op: "creator" });
    assert.equal(q.rows.length, 1, "creator 算子只认资料行：同批写出的作品行不能混进来");
    assert.equal(q.rows[0]!.kind, "creator");
    assert.equal(q.rows[0]!.metrics.followers, 1234);
    assert.equal(q.rows[0]!.author, "甲");
    assert.equal(q.rows[0]!.url, "https://example.com/u1", "主页链接不能被作品 URL 顶掉");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * 假内核：`search` 时**顺带**也写一份 `creators`。
 *
 * 真机会这样：B站搜索过程中会按 UP 主取一次主页统计并落盘。这条路径踩过一个坑 ——
 * 资料行若按 `task.op`（=search）归一化，就被打成 `op=search`，于是
 * ① 查询侧"按 op=creator 取资料行"捞不到它，粉丝量/主页链接丢了；
 * ② 它又以"内容行"的身份混进条目数。修法是**按记录类型纠偏**：creator 记录一律 op=creator。
 */
function writeFakeKernelSearchAlsoProfiles(dir: string): string {
  const bin = join(dir, "fake-kernel-search-profile.cjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ""; };
const save = get("--save-path"), type = get("--type"), platform = get("--platform");
const dirName = { xhs: "xhs", dy: "douyin", bili: "bili", wb: "weibo" }[platform] || platform;
const out = path.join(save, dirName, "jsonl");
fs.mkdirSync(out, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const push = (itemType, obj) => fs.appendFileSync(path.join(out, type + "_" + itemType + "_" + day + ".jsonl"), JSON.stringify(obj) + "\\n");
if (type === "search") {
  push("contents", { note_id: "n1", title: "t1", nickname: "甲", creator_hash: "h1", author_user_id: "u1", liked_count: "10" });
  // 搜索途中顺带写出的主页资料行（B站会）
  push("creators", { creator_hash: "h1", user_id: "u1", nickname: "甲", fans: "8888", follows: "5", home_url: "https://example.com/u1" });
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

test("搜索顺带取回的主页资料，要按记录类型归一化为 op=creator（不能被打成 op=search 混进内容）", async () => {
  const base = mkdtempSync(join(tmpdir(), "brandsale-search-profile-"));
  try {
    const store = new CollectStore(join(base, "store"));
    const tm = new TaskManager({
      store,
      paths: {
        coreDir: base,
        pythonBin: writeFakeKernelSearchAlsoProfiles(base),
        runPy: join(base, "run.py"),
        dataDir: join(base, "data"),
        logDir: join(base, "logs"),
      },
      headless: true,
      cdpMode: "false",
      defaultMaxItems: 5,
      maxItemsCap: 20,
      crawlTimeoutMs: 15_000,
      maskNickname: false,
      profileEnrich: { enabled: false, maxAuthors: 3 },
    });

    const r = tm.submit("bili", "search", { keyword: "精华" });
    assert.ok(r.ok);
    const deadline = Date.now() + 20_000;
    while (tm.isBusy() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 30));

    const creators = await store.query("bili", { op: "creator" });
    assert.equal(creators.rows.length, 1, "搜索顺带取回的资料要能被 op=creator 查到");
    assert.equal(creators.rows[0]!.kind, "creator");
    assert.equal(creators.rows[0]!.metrics.followers, 8888);

    const content = await store.query("bili", { op: "search" });
    assert.ok(
      content.rows.every((row) => row.kind !== "creator"),
      "资料行不能以内容行的身份混进 op=search",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("作者主页自动补采：开关关掉时一条都不派生（不悄悄给平台加压力）", async () => {
  const base = mkdtempSync(join(tmpdir(), "brandsale-enrich-off-"));
  try {
    const store = new CollectStore(join(base, "store"));
    const tm = new TaskManager({
      store,
      paths: {
        coreDir: base,
        pythonBin: writeFakeKernelWithData(base),
        runPy: join(base, "run.py"),
        dataDir: join(base, "data"),
        logDir: join(base, "logs"),
      },
      headless: true,
      cdpMode: "false",
      defaultMaxItems: 5,
      maxItemsCap: 20,
      crawlTimeoutMs: 15_000,
      maskNickname: false,
      profileEnrich: { enabled: false, maxAuthors: 3 },
    });
    tm.submit("xhs", "search", { keyword: "精华" });
    const deadline = Date.now() + 20_000;
    while ((tm.isBusy() || tm.pendingCount() > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(tm.list().filter((t) => t.op === "creator").length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * 真机踩到过的：一次微博搜索派生 4 个作者补采，队列那时已被别的采集塞满，
 * 只排上 1 个（`派生 1/4`），另外 3 个的粉丝数就此永远采不到。
 * 修法是不丢 —— 队列满的进 `profileBacklog`，内核腾出位置时自动接上。
 */
test("作者主页自动补采：队列满时不丢，进积压并在内核空闲后自动补上", async () => {
  const base = mkdtempSync(join(tmpdir(), "brandsale-enrich-backlog-"));
  const prevDelay = process.env["FAKE_KERNEL_DELAY_MS"];
  process.env["FAKE_KERNEL_DELAY_MS"] = "120";
  try {
    const store = new CollectStore(join(base, "store"));
    const tm = new TaskManager({
      store,
      paths: {
        coreDir: base,
        pythonBin: writeFakeKernelWithData(base),
        runPy: join(base, "run.py"),
        dataDir: join(base, "data"),
        logDir: join(base, "logs"),
      },
      headless: true,
      cdpMode: "false",
      defaultMaxItems: 5,
      maxItemsCap: 20,
      crawlTimeoutMs: 20_000,
      maskNickname: false,
      profileEnrich: { enabled: true, maxAuthors: 3 },
    });

    // ① 搜索占住内核（假内核睡 120ms），随后的任务只能排队
    const search = tm.submit("xhs", "search", { keyword: "精华" });
    assert.ok(search.ok && search.task.state === "running");

    // ② 把队列填满（MAX_PENDING = 12）：补采只能进积压。
    //    填充任务刻意用 `creator` 算子 —— 只有 `search` 会派生补采，用它填充
    //    才不会引入第二拨派生（否则断言里的 creator 数量里混着填充任务的产出）
    let filled = 0;
    for (let i = 0; i < 12; i += 1) {
      const out = tm.submit("wb", "creator", { creatorId: `fill-${i}` });
      if (out.ok) filled += 1;
    }
    assert.equal(filled, 12, "队列应能被填满，填不满就测不到「队列满」这条路径");
    assert.equal(tm.pendingCount(), 12);

    // ③ 等全部消化 —— 若积压不接上，两个 creator 任务会永远缺一个（或两个都缺）
    const deadline = Date.now() + 40_000;
    while ((tm.isBusy() || tm.pendingCount() > 0 || tm.profileBacklogCount() > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(tm.isBusy(), false, "队列应全部消化完");
    assert.equal(tm.profileBacklogCount(), 0, "积压应被接上，不能留着");
    const derived = tm.list().filter((t) => t.op === "creator" && t.profileOnly === true);
    assert.equal(derived.length, 1, "整批补采应被接上（曾经队列满时会被丢掉）");
    assert.equal(derived[0]!.params.creatorId, "u1,u2");
  } finally {
    if (prevDelay === undefined) delete process.env["FAKE_KERNEL_DELAY_MS"];
    else process.env["FAKE_KERNEL_DELAY_MS"] = prevDelay;
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * 外部数据源适配器自检：抖音（L3 自托管采集）+ 小红书（L3 只读代理）
 *
 * 运行：npm test —— 全部在 mock 模式下跑，**打桩 globalThis.fetch**，不发任何真实外部请求。
 *
 * 为什么这些用例必须存在：
 *   这两条源是**公开采集**，它们最大的风险不是"取不到数据"，而是三个静默错误：
 *     ① 被当成甲方授权实测数据（分级写错、或 sourceId 由模型自报从而让闸门查错对象）；
 *     ② 联调假数据悄悄流进正式报告（假数据看起来和真数据一模一样）；
 *     ③ 写能力被顺带封装进来（可用的开源采集工具普遍自带点赞/发笔记等写命令）。
 *   这三个都不会报错，只会累积 —— 所以每一条都要有用例把住，否则它只活在注释里。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@brandsale/config";
import type { TenantContext } from "@brandsale/contracts";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { seed, DEMO_TENANT } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_ds", traceId: "trace_ds", locale: "zh-CN" };
const toolCtx = {
  ctx,
  jobId: "job_ds",
  phase: "intel" as const,
  attempt: 1,
  emit: () => {},
  signal: new AbortController().signal,
};

const LAB = { mock: true, tool: "datasource-lab" };

/* ── 打桩 fetch ─────────────────────────────────────────── */

interface Sent {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(handler: (url: string) => unknown): { sent: Sent[]; restore: () => void } {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const out = handler(url);
    // handler 返回 Error 表示"模拟网络层失败"（如 abort），直接抛出
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

/** 抖音假响应（DTK v4 形态）。sec_user_id 含 `_realmock` 时不带 `_lab`，用于验证真实采集判定。 */
function douyinDto(url: string): unknown {
  const real = url.includes("_realmock");
  const envelope = real ? {} : { _lab: LAB };
  if (url.includes("fetch_user_profile")) {
    return {
      code: 200,
      router: "/api/douyin/web/fetch_user_profile",
      ...envelope,
      data: {
        user: {
          sec_uid: "MS4wLjABAAAA_demo_1001",
          nickname: "护肤成分实验室",
          follower_count: 1_280_000,
          following_count: 290,
          aweme_count: 342,
          ip_location: "上海",
          verified: true,
          avatar_thumb: { url_list: ["https://example.invalid/a.jpg"] },
        },
      },
    };
  }
  if (url.includes("fetch_user_post_videos")) {
    return {
      code: 200,
      ...envelope,
      data: {
        aweme_list: [
          { aweme_id: "7111111111111111111", desc: "成分拆解", create_time: 1_760_000_000, statistics: { digg_count: 12000, comment_count: 300, share_count: 90, collect_count: 800 } },
          { aweme_id: "7222222222222222222", desc: "空瓶记", create_time: 1_759_000_000, statistics: { digg_count: 8000, comment_count: 120, share_count: 30, collect_count: 500 } },
        ],
      },
    };
  }
  if (url.includes("fetch_video_comments")) {
    return {
      code: 200,
      ...envelope,
      data: { comments: { bad: true } }, // 故意不是数组：验证"字段不是预期结构时返回空列表而不是崩溃"
    };
  }
  return { code: 200, ...envelope, data: {} };
}

const xhsOk = (url: string): unknown =>
  url.includes("/xhs/note")
    ? { ok: true, _lab: LAB, data: { note: { note_id: "n1", title: "空瓶记", desc: "正文", user: { user_id: "u1", nickname: "三十岁护肤日记" }, interact_info: { liked_count: 12_400, collected_count: 8_900, comment_count: 431 }, tags: ["护肤"], time: "2026-09-26T00:00:00Z" } } }
    : { ok: true, _lab: LAB, data: { user: { user_id: "u1", nickname: "三十岁护肤日记", interact_info: { fans: 460_000, note_count: 120 } } } };

/* ── 容器与种子 ─────────────────────────────────────────── */

async function freshContainer(env: Record<string, string>): Promise<{ c: Container; dir: string; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-ds-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", ...env });
  const c = createContainer(config);
  const saved = process.env.BM_DATA_DIR;
  process.env.BM_DATA_DIR = dir;
  try {
    await seed();
  } finally {
    if (saved === undefined) delete process.env.BM_DATA_DIR;
    else process.env.BM_DATA_DIR = saved;
  }
  return {
    c,
    dir,
    dispose: () => {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* 本文件里的抖音桩数据是 **v4 形态**（`/api/douyin/web/fetch_*` + `{code, router_data}`），
 * 所以这里显式把形态钉成 v4。默认值已经是 v5（当前仓库 docker compose 装出来的就是 v5），
 * 若不开这个开关，本文件的断言会去撞一条不存在的路径 —— 那是另一组用例的正题，
 * 不属于这里。v5 的请求形态与异步信封见 tests/douyin-style.test.ts。 */
const BOTH_ON = {
  BM_DOUYIN_BASE_URL: "http://127.0.0.1:8899",
  BM_DOUYIN_STYLE: "v4",
  BM_XHS_BASE_URL: "http://127.0.0.1:8899",
};

interface CreatorOut {
  result: { creator: { nickname: string; followerCount: number | null; awemeCount: number | null } | null; works: { awemeId: string; diggCount: number | null }[]; workCount: number };
  provenance: { sourceId: string; tier: string; synthetic: boolean; note: string }[];
  note: string;
}

/* ── 抖音 ───────────────────────────────────────────────── */

test("抖音 采集达人主页+作品：字段归一化、L3 分级、请求形态正确", async () => {
  const { c, dir, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(douyinDto);
  try {
    assert.ok(c.agentPack.registry.get("douyin_creator"), "配置了 baseUrl 后应注册 douyin_creator");
    assert.ok(c.agentPack.registry.get("douyin_comments"), "CI 的评论工具也应注册");

    const out = (await c.agentPack.registry.invoke(
      "douyin_creator",
      { secUserId: "MS4wLjABAAAA_demo_1001" },
      "CI",
      toolCtx,
    )) as CreatorOut;

    assert.equal(out.result.creator?.nickname, "护肤成分实验室");
    assert.equal(out.result.creator?.followerCount, 1_280_000, "下划线字段 follower_count 应被归一化");
    assert.equal(out.result.creator?.awemeCount, 342);
    assert.equal(out.result.works.length, 2);
    assert.equal(out.result.works[0]?.diggCount, 12_000, "嵌套 statistics.digg_count 应被归一化");
    assert.match(out.result.works[0]!.awemeId, /^7\d{18}$/, "aweme_id 应原样透传");

    assert.equal(out.provenance[0]?.tier, "L3", "公开采集必须是 L3，不能是 L1");
    assert.equal(out.provenance[0]?.sourceId, "douyin_web_public");

    assert.equal(stub.sent.length, 2, "主页 + 作品各一次请求");
    assert.match(stub.sent[0]!.url, /\/api\/douyin\/web\/fetch_user_profile\?/, "应打到 v4 端点路径");
    assert.match(stub.sent[0]!.url, /sec_user_id=MS4wLjABAAAA_demo_1001/);
    assert.match(stub.sent[0]!.url, /wait=true/, "v4 形态的 wait 是布尔开关");
  } finally {
    stub.restore();
    dispose();
    void dir;
  }
});

test("抖音 联调假数据被标记为 synthetic；真实采集不标记", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(douyinDto);
  try {
    const labOut = (await c.agentPack.registry.invoke("douyin_creator", { secUserId: "MS4wLjABAAAA_demo_1001", includePosts: false }, "CI", toolCtx)) as CreatorOut;
    assert.equal(labOut.provenance[0]?.synthetic, true, "带 _lab 的联调数据必须标 synthetic，否则会冒充真实采集");
    assert.match(labOut.provenance[0]?.note ?? "", /联调假数据/);

    const realOut = (await c.agentPack.registry.invoke("douyin_creator", { secUserId: "MS4wLjABAAAA_realmock", includePosts: false }, "CI", toolCtx)) as CreatorOut;
    assert.equal(realOut.provenance[0]?.synthetic, false, "真实采集不得被标成合成值");
  } finally {
    stub.restore();
    dispose();
  }
});

test("抖音 闸门检查的是绑定来源：参数里塞一个会被拒的 sourceId 仍然放行", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(douyinDto);
  try {
    /* 这是最关键的一条安全不变量。`l4_example_vendor` 已登记但法务未批准，
     * 直接访问会被闸门拦下。若闸门相信模型自报的 sourceId，这里必然降级；
     * 工具声明了 boundSourceId，闸门检查的是真实来源（L3 公开采集），因此应正常放行。
     * —— 放行本身即证明闸门没有被参数带偏。 */
    const out = (await c.agentPack.registry.invoke(
      "douyin_creator",
      { secUserId: "MS4wLjABAAAA_demo_1001", includePosts: false, sourceId: "l4_example_vendor" },
      "CI",
      toolCtx,
    )) as CreatorOut;

    assert.ok(!("degraded" in out) || (out as { degraded?: boolean }).degraded !== true, "不得因参数里的 sourceId 而降级");
    assert.equal(out.provenance[0]?.sourceId, "douyin_web_public", "provenance 必须是绑定源");
    assert.equal(stub.sent.length, 1, "应真实触达采集端点");
  } finally {
    stub.restore();
    dispose();
  }
});

test("抖音 白名单按工具粒度收窄：CT 能取达人主页但取不到评论，越权不触达端点", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(douyinDto);
  try {
    await assert.rejects(
      () => c.agentPack.registry.invoke("douyin_comments", { awemeId: "7111111111111111111" }, "CT", toolCtx),
      /白名单/,
      "评论工具只给 CI —— 越权必须抛错，而不是静默降级",
    );
    assert.equal(stub.sent.length, 0, "被拒时不得触达外部端点");
  } finally {
    stub.restore();
    dispose();
  }
});

test("抖音 同参数命中缓存；单任务调用上限触发降级后不再触达端点", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(douyinDto);
  try {
    await c.agentPack.registry.invoke("douyin_creator", { secUserId: "MS4wLjABAAAA_c1", includePosts: false }, "CI", toolCtx);
    const afterFirst = stub.sent.length;
    assert.ok(afterFirst > 0);

    const again = (await c.agentPack.registry.invoke("douyin_creator", { secUserId: "MS4wLjABAAAA_c1", includePosts: false }, "CI", toolCtx)) as CreatorOut;
    assert.equal(stub.sent.length, afterFirst, "同参数应命中缓存，不重复采集");
    assert.match(again.provenance[0]?.note ?? "", /命中缓存/);

    // maxCallsPerJob = 15：一直问到降级为止
    let capped: { degraded?: boolean; code?: string } | undefined;
    for (let i = 0; i < 25 && !capped; i++) {
      const r = (await c.agentPack.registry.invoke("douyin_creator", { secUserId: `MS4wLjABAAAA_cap_${i}`, includePosts: false }, "CI", toolCtx)) as {
        degraded?: boolean;
        code?: string;
      };
      if (r.degraded) capped = r;
    }
    assert.ok(capped, "超过单任务上限后应降级");
    assert.equal(capped.code, "E-DATA-003");

    const atCap = stub.sent.length;
    await c.agentPack.registry.invoke("douyin_creator", { secUserId: "MS4wLjABAAAA_over", includePosts: false }, "CI", toolCtx);
    assert.equal(stub.sent.length, atCap, "超限后不得再触达端点 —— 这背后是甲方账号的风控额度");
  } finally {
    stub.restore();
    dispose();
  }
});

test("抖音 超时归一化：AbortError 被判成超时（E-DATA-001）而不是不可用", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(() => Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
  try {
    const out = (await c.agentPack.registry.invoke("douyin_creator", { secUserId: "MS4wLjABAAAA_to", includePosts: false }, "CI", toolCtx)) as {
      degraded?: boolean;
      code?: string;
      reason?: string;
    };
    assert.equal(out.degraded, true);
    assert.equal(out.code, "E-DATA-001", "超时必须分类为超时；否则排障方向会跑偏");
    assert.match(out.reason ?? "", /超时/);
  } finally {
    stub.restore();
    dispose();
  }
});

/* ── 小红书 ─────────────────────────────────────────────── */

test("小红书 读取笔记：L3 分级、联调数据标 synthetic、请求带 all=true", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(xhsOk);
  try {
    const out = (await c.agentPack.registry.invoke("xhs_note", { noteId: "n1" }, "CI", toolCtx)) as {
      result: { note: { title: string; likedCount: number | null } | null; comments: unknown[] };
      provenance: { tier: string; synthetic: boolean; sourceId: string }[];
    };
    assert.equal(out.result.note?.title, "空瓶记");
    assert.equal(out.result.note?.likedCount, 12_400, "嵌套 interact_info 应被归一化");
    assert.equal(out.provenance[0]?.tier, "L3");
    assert.equal(out.provenance[0]?.sourceId, "xhs_web_public");
    assert.equal(out.provenance[0]?.synthetic, true);
    assert.match(stub.sent[0]!.url, /\/xhs\/note\?note_id=n1/);
    assert.ok(stub.sent.some((s) => s.url.includes("/xhs/comments") && s.url.includes("all=true")), "评论请求应带 all=true");
  } finally {
    stub.restore();
    dispose();
  }
});

test("小红书 风控类失败翻译成可执行处置，而不是一句「不可用」", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(() => ({ ok: false, error: { code: "not_authenticated", message: "no a1 cookie" } }));
  try {
    const out = (await c.agentPack.registry.invoke("xhs_note", { noteId: "n1", includeComments: false }, "CI", toolCtx)) as {
      degraded?: boolean;
      code?: string;
      reason?: string;
    };
    assert.equal(out.degraded, true);
    assert.match(out.reason ?? "", /代理未登录/, "必须说明该做什么（去登录），而不是笼统报错");
    assert.match(out.reason ?? "", /not_authenticated/, "原始错误码要保留，便于对账");
  } finally {
    stub.restore();
    dispose();
  }
});

test("小红书 缺少笔记标识时不发请求（省风控额度）", async () => {
  const { c, dispose } = await freshContainer(BOTH_ON);
  const stub = stubFetch(xhsOk);
  try {
    const out = (await c.agentPack.registry.invoke("xhs_note", {}, "CI", toolCtx)) as { result: { degraded?: boolean; note: string } };
    assert.equal(out.result.degraded, true);
    assert.equal(stub.sent.length, 0, "参数不全不得触达端点");
  } finally {
    stub.restore();
    dispose();
  }
});

/* ── 未配置即不注册 ──────────────────────────────────────── */

test("未配置 baseUrl 时抖音/小红书适配器与工具都不注册，且给出启动告警", async () => {
  const { c, dispose } = await freshContainer({
    BM_WEB_SEARCH_API_KEY: "test-key",
    BM_DOUYIN_BASE_URL: "",
    BM_XHS_BASE_URL: "",
  });
  try {
    assert.equal(c.agentPack.registry.get("douyin_creator"), undefined);
    assert.equal(c.agentPack.registry.get("xhs_note"), undefined);
    // 14 - 2(抖音) - 2(小红书) = 10：只有联网检索缺席时不注册，其余照常
    assert.equal(c.agentPack.registry.list().length, 10, "未配置的外部源不应注册，也不能影响其他工具");

    assert.ok(c.warnings.some((w) => w.includes("BM_DOUYIN_BASE_URL")), "应告警说明抖音能力缺席");
    assert.ok(c.warnings.some((w) => w.includes("BM_XHS_BASE_URL")), "应告警说明小红书能力缺席");
  } finally {
    dispose();
  }
});

test("配置齐全时四个新工具都在，且工具清单里没有写操作入口", async () => {
  const { c, dispose } = await freshContainer({ BM_WEB_SEARCH_API_KEY: "test-key", ...BOTH_ON });
  const stub = stubFetch(xhsOk);
  try {
    for (const name of ["douyin_creator", "douyin_comments", "xhs_creator", "xhs_note"]) {
      assert.ok(c.agentPack.registry.get(name), `${name} 应已注册`);
    }
    assert.equal(c.agentPack.registry.list().length, 14, "工具总数应为 14（原 10 + 4）");

    // 工具清单里不得存在任何 mutating 工具：小红书采集本身带写命令，
    // 这里确认"只读代理 + 只读适配器"这条边界真的守住了
    assert.equal(c.agentPack.registry.list().filter((t) => t.policy.mutating).length, 0, "不得注册任何写能力工具");
  } finally {
    stub.restore();
    dispose();
  }
});

test("新登记的源自动进报告来源目录（渲染层无需改动），L4 未法务批准仍被排除", async () => {
  const { c, dispose } = await freshContainer({ BM_WEB_SEARCH_API_KEY: "k", ...BOTH_ON });
  try {
    const catalog = c.agentPack.sourceCatalog(ctx);
    const keys = catalog.entries.map((e) => e.key);
    const publicSourceIds = ["volc_web_search", "douyin_web_public", "xhs_web_public"];

    for (const key of publicSourceIds) {
      assert.ok(keys.includes(key), `${key} 应出现在来源目录里 —— 否则报告无法声明这一来源，引用校验会把合法数字判成 model_inference`);
    }

    const l3Entries = catalog.entries.filter((e) => publicSourceIds.includes(e.key));
    assert.ok(l3Entries.every((e) => e.grade === "L3"), "三条公开源的分级都必须是 L3（不得被标成 L1）");
    assert.ok(l3Entries.every((e) => e.origin === "external"), "应在来源声明里体现为外部源");

    assert.ok(!keys.includes("l4_example_vendor"), "L4 未过法务不得进来源目录");
  } finally {
    dispose();
  }
});

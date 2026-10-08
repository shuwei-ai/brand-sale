/**
 * DTK 两代形态（v4 / v5）：请求形态与异步信封
 *
 * ── 为什么单独一组用例 ─────────────────────────────────────────
 *
 * 默认值曾经是 v4 的 `/api/douyin/web/fetch_*` 路径 + `wait=true`。而去当前仓库
 * `docker compose up` 装出来的是 **dtk 5.1.x**，它：
 *
 *   ① 四个 v4 路径**一个都不存在**（v5 是 `/api/v1/douyin/{user,user/posts,video,video/comments}`）；
 *   ② `wait` 是**秒数**，传 `true` 连 FastAPI 的类型校验都过不了（422）；
 *   ③ 默认强制鉴权（`X-API-Key` / `Authorization: Bearer`）；
 *   ④ 失败信封是 `{success:false, error:{...}}`，成功是 `{success:true, data, error:null, meta}`；
 *   ⑤ 未在等待窗口内完成时返回 `202`，且把任务句柄放在 **`data` 里面**：
 *      `{ success: true, data: { task_id, state: "running" }, meta: {...} }`
 *
 * 第 ⑤ 条是这组用例里最要紧的一条：旧代码只在**顶层**找 `task_id`，于是 v5 的 202
 * 会被当成成功响应 —— `data` 非空 → 返回 → `toCreator({task_id, state})` 得到一行
 * **所有字段为空、但 synthetic=false、tier=L3、note 声称"真实采集"** 的记录。
 * 这是最坏的一类错：报告会把它当成一次真实采集，而实际上什么都没查到。
 * 它不会报错，只会让报告里多一个"查到了但全是缺失"的达人。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DOUYIN_DEFAULT_PATHS } from "@brandsale/config";
import type { TenantContext } from "@brandsale/contracts";
import { createDouyinWebAdapter, DOUYIN_WEB_SOURCE_ID } from "@brandsale/datasource";

const ctx: TenantContext = { tenantId: "t_dy", userId: "u_dy", traceId: "tr_dy", locale: "zh-CN" };

interface Sent {
  url: string;
  headers: Record<string, string>;
}

/** 打桩 fetch，返回给定的 JSON 与状态码 */
function stubJson(payload: unknown, status = 200): { sent: Sent[]; restore: () => void } {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

function env(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-dyv5-"));
  const config = loadConfig(process.cwd(), {
    BM_DATA_DIR: dir,
    BM_LLM_MODE: "mock",
    BM_DOUYIN_BASE_URL: "http://dtk.internal:8000",
    ...overrides,
  });
  return {
    config,
    adapter: createDouyinWebAdapter(config),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const call = (config: ReturnType<typeof env>["config"], params: Record<string, unknown>) =>
  createDouyinWebAdapter(config).fetch({ tenantId: ctx.tenantId, jobId: "j", params }, config);

/* ── v5 成功信封 ─────────────────────────────────────────── */

test("DTK-V5-1 默认形态就是 v5；路径与 wait 秒数都对得上真实 dtk 5.1 的路由", async () => {
  const { config, dispose } = env();
  const stub = stubJson({
    success: true,
    data: {
      user: {
        sec_uid: "MS4wLjABAAAA_real_one",
        nickname: "护肤成分实验室",
        follower_count: 1_280_000,
        aweme_count: 342,
        ip_location: "上海",
        verified: true,
        avatar_thumb: { url_list: ["https://example.invalid/a.jpg"] },
      },
    },
    error: null,
    meta: { request_id: "r1", task_id: "t1" },
  });
  try {
    assert.equal(config.douyin.style, "v5", "默认必须取 v5 —— 当前仓库 compose 出来的就是 v5");
    assert.equal(config.douyin.paths.profile, "/api/v1/douyin/user");
    assert.equal(config.douyin.wait, "20", "v5 的 wait 是秒数，不是布尔量");

    const res = await call(config, { op: "profile", secUserId: "MS4wLjABAAAA_real_one" });
    assert.equal(res.rows[0]?.nickname, "护肤成分实验室");
    assert.equal(res.rows[0]?.followerCount, 1_280_000);
    assert.equal(res.provenance.sourceId, DOUYIN_WEB_SOURCE_ID);
    assert.equal(res.provenance.tier, "L3");

    const u = stub.sent[0]!.url;
    assert.match(u, /\/api\/v1\/douyin\/user\?/, "v5 的路径是 /api/v1/douyin/user");
    assert.match(u, /sec_user_id=MS4wLjABAAAA_real_one/);
    assert.match(u, /wait=20/, "v5 的 wait 必须是秒数；传 true 会被服务端判 422");
    assert.doesNotMatch(u, /wait=true/);
  } finally {
    stub.restore();
    dispose();
  }
});

test("DTK-V5-2 meta 里的 task_id 不得被误判成「还在异步处理」", async () => {
  // finished() 把 task_id 塞进 meta（而不是 data），所以正常完成的结果里也会有 task_id。
  // 异步判定必须只认"和 state 待在一起的那个 task_id"，否则每次成功都会报"仍在处理中"。
  const { config, dispose } = env();
  const stub = stubJson({
    success: true,
    data: { user: { sec_uid: "s1", nickname: "正常结果", follower_count: 10 } },
    error: null,
    meta: { task_id: "11111111-2222-3333-4444-555555555555", duration_ms: 830 },
  });
  try {
    const res = await call(config, { op: "profile", secUserId: "s1" });
    assert.equal(res.rows[0]?.nickname, "正常结果");
  } finally {
    stub.restore();
    dispose();
  }
});

/* ── v5 的 202：这组用例的正题 ───────────────────────────── */

test("DTK-V5-3 v5 的 202（任务句柄在 data 里）必须显式报错，不得当成达人数据返回", async () => {
  const { config, dispose } = env();
  const stub = stubJson(
    {
      success: true,
      data: { task_id: "9f1c0f4e-0000-4000-8000-000000000000", state: "running" },
      error: null,
      meta: { request_id: "r2" },
    },
    202,
  );
  try {
    await assert.rejects(
      () => call(config, { op: "profile", secUserId: "MS4wLjABAAAA_x" }),
      (e: Error) => {
        assert.match(e.message, /异步处理中/, "必须明确说它还在处理，而不是返回一行空数据");
        assert.match(e.message, /身份池/, "v5 的下一步动作是去 DTK 控制台补身份");
        assert.doesNotMatch(e.message, /task_id":/, "不能把任务句柄当成结果吐出来");
        return true;
      },
    );
  } finally {
    stub.restore();
    dispose();
  }
});

test("DTK-V5-4 终态任务句柄（state=done）不应被误判为仍在处理", async () => {
  // 这一条是上一条的反面。若异步判定只要看到 task_id 就拦，正常的终态形态会被冤枉。
  const { config, dispose } = env();
  const stub = stubJson({
    success: true,
    data: { task_id: "task-1", state: "done", user: { sec_uid: "s9", nickname: "终态结果" } },
    error: null,
    meta: {},
  });
  try {
    const res = await call(config, { op: "profile", secUserId: "s9" });
    assert.equal(res.rows[0]?.nickname, "终态结果");
  } finally {
    stub.restore();
    dispose();
  }
});

/* ── v5 的失败信封与 4xx ─────────────────────────────────── */

test("DTK-V5-5 v5 失败信封（success:false + error）要带出服务的说明", async () => {
  const { config, dispose } = env();
  const stub = stubJson(
    { success: false, data: null, error: { code: "scheduler.identity_unavailable", message: "没有空闲身份" }, meta: {} },
    200,
  );
  try {
    await assert.rejects(
      () => call(config, { op: "profile", secUserId: "s" }),
      /scheduler\.identity_unavailable[\s\S]*没有空闲身份/,
    );
  } finally {
    stub.restore();
    dispose();
  }
});

test("DTK-V5-6 4xx 要翻译成可执行的排查方向，而不是一句裸状态码", async () => {
  const { config, dispose } = env();
  const cases: { status: number; body: unknown; mustSay: RegExp }[] = [
    { status: 401, body: { success: false, error: { code: "auth.missing" } }, mustSay: /BM_DOUYIN_API_KEY/ },
    { status: 404, body: { detail: "Not Found" }, mustSay: /BM_DOUYIN_STYLE=v5[\s\S]*\/api\/v1\/douyin\// },
    { status: 422, body: { detail: [{ msg: "float_parsing" }] }, mustSay: /wait 是\*\*秒数\*\*|BM_DOUYIN_WAIT/ },
    { status: 400, body: { error: { message: "wait above ceiling" } }, mustSay: /api\.max_wait_seconds/ },
  ];
  for (const c of cases) {
    const stub = stubJson(c.body, c.status);
    try {
      await assert.rejects(
        () => call(config, { op: "profile", secUserId: "s" }),
        (e: Error) => {
          assert.match(e.message, c.mustSay, `HTTP ${c.status} 的说明不合格：${e.message}`);
          assert.doesNotMatch(e.message, /^\S*HTTP 4\d\d：/, "不得退化成裸状态码");
          return true;
        },
      );
    } finally {
      stub.restore();
    }
  }
  dispose();
});

/* ── 形态切换与覆盖 ─────────────────────────────────────── */

test("DTK-V5-7 显式 v4 形态要还原成老路径与布尔 wait", async () => {
  const { config, dispose } = env({ BM_DOUYIN_STYLE: "v4" });
  const stub = stubJson({ code: 200, data: { user: { sec_uid: "s", nickname: "v4 结果" } } });
  try {
    assert.equal(config.douyin.paths.profile, "/api/douyin/web/fetch_user_profile");
    assert.equal(config.douyin.wait, "true");

    await call(config, { op: "profile", secUserId: "s" });
    assert.match(stub.sent[0]!.url, /\/api\/douyin\/web\/fetch_user_profile\?/);
    assert.match(stub.sent[0]!.url, /wait=true/);
  } finally {
    stub.restore();
    dispose();
  }
});

test("DTK-V5-8 显式路径与 wait 仍然优先于形态默认值", async () => {
  const { config, dispose } = env({
    BM_DOUYIN_STYLE: "v5",
    BM_DOUYIN_PATH_PROFILE: "/custom/profile",
    BM_DOUYIN_WAIT: "5",
  });
  const stub = stubJson({ success: true, data: { user: { sec_uid: "s", nickname: "自定义" } } });
  try {
    await call(config, { op: "profile", secUserId: "s" });
    assert.match(stub.sent[0]!.url, /\/custom\/profile\?/);
    assert.match(stub.sent[0]!.url, /wait=5/);
  } finally {
    stub.restore();
    dispose();
  }
});

test("DTK-V5-9 形态写错不得静默退回默认（否则四个端点全 404，排查成本极高）", () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-dyv5-bad-"));
  try {
    assert.throws(
      () => loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_DOUYIN_STYLE: "v6" }),
      /BM_DOUYIN_STYLE 只能是 v4 或 v5/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DTK-V5-10 两代默认路径的键必须一致，且都非空", () => {
  // 形态表被手写了两遍路径，键名漂移会导致某个 op 悄悄打到 undefined 上
  for (const style of ["v4", "v5"] as const) {
    const p = DOUYIN_DEFAULT_PATHS[style];
    for (const k of ["profile", "posts", "video", "comments"] as const) {
      assert.ok(p[k]?.startsWith("/"), `${style}.${k} 必须是以 / 开头的路径`);
    }
    assert.notEqual(p.profile, p.posts, `${style} 的 profile 与 posts 不能是同一个路径`);
  }
});

test("DTK-V5-11 只读白名单：非白名单 op 一律拒绝（v5 端点更多，这条更要守）", async () => {
  const { config, dispose } = env();
  try {
    for (const op of ["search", "hot", "followers", "following", "like", "post"]) {
      await assert.rejects(() => call(config, { op, secUserId: "s" }), /不支持的小红书操作|不支持的抖音操作/);
    }
  } finally {
    dispose();
  }
});

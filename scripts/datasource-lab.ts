#!/usr/bin/env tsx
/**
 * 数据源实验室：本地假数据源服务 + 小红书只读代理
 *
 * ── 它是什么，不是什么 ────────────────────────────────────────
 *
 * 这是**联调工具**，不属于生产链路。用途：在没有真实后端的情况下，把
 * 「适配器 → 注册表 → 工具 → 闸门 → 降级链」整条链路真跑一遍。
 *
 * 它不是"内置的假数据源"。区别在于：
 *   · 假数据源会伪装成真实源，让报告出现"看起来像实测值的假数据"（本项目删过一次）；
 *   · 本工具返回的每个响应都带 `_lab: { mock: true }`，适配器据此把
 *     `provenance.synthetic` 置为 **true**。于是报告层的引用分级会把它降级，
 *     任何人都能一眼看出这是联调数据。**假数据自己声明自己是假的**，这是底线。
 *
 * ── 两种模式 ────────────────────────────────────────────────
 *
 *   默认（mock）：抖音按 DTK v4 响应形态、小红书按只读代理契约，返回确定性假数据
 *   `--xhs-real`：小红书侧改为调用真实的 `xhs` CLI（只读子命令白名单）
 *
 * ── 快速开始 ────────────────────────────────────────────────
 *
 *   npm run datasource:lab            # 一个进程同时提供抖音 + 小红书（端口 8899）
 *   BM_DOUYIN_BASE_URL=http://127.0.0.1:8899
 *   BM_XHS_BASE_URL=http://127.0.0.1:8899
 *
 * ── 故意失败开关（用来验证降级路径，别只在 happy path 上验收）────
 *
 *   任何请求加 `?__fail=not_authenticated` → 小红书侧返回该错误码
 *   任何请求加 `?__fail=http_500`          → 返回 500
 *   任何请求加 `?__delay=8000`             → 延迟 8 秒（验证超时归一化）
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";

/* ── 参数 ───────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string, dflt: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const PORT = Number(opt("port", "8899"));
const HOST = opt("host", "127.0.0.1");
const XHS_REAL = flag("xhs-real");
/** 真实模式下单个 CLI 命令的超时（要留出 CLI 内置的 1-1.5s 人类化延迟） */
const CLI_TIMEOUT_MS = Number(opt("cli-timeout", "20000"));

/* ── 确定性假数据（与 scripts/seed.ts 里的达人保持一致的观感） ── */

const seedNum = (text: string, min: number, max: number): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return min + ((h >>> 0) % Math.max(1, max - min));
};

const KNOWN_CREATORS: Record<string, { nickname: string; followers: number; awemeCount: number }> = {
  MS4wLjABAAAA_demo_1001: { nickname: "护肤成分实验室", followers: 1_280_000, awemeCount: 342 },
  MS4wLjABAAAA_demo_1003: { nickname: "皮肤科医生老王", followers: 2_150_000, awemeCount: 187 },
  MS4wLjABAAAA_demo_1005: { nickname: "精致阿姨的梳妆台", followers: 890_000, awemeCount: 256 },
};

function creatorPayload(secUserId: string): Record<string, unknown> {
  const known = KNOWN_CREATORS[secUserId];
  const nickname = known?.nickname ?? `Demo 达人 ${String(seedNum(secUserId, 1000, 9999))}`;
  const followers = known?.followers ?? seedNum(secUserId, 30_000, 800_000);
  return {
    code: 200,
    router: "/api/douyin/web/fetch_user_profile",
    // `_lab` 会被适配器识别成"联调假数据"，从而把 provenance.synthetic 置 true
    _lab: { mock: true, tool: "datasource-lab" },
    data: {
      user: {
        sec_uid: secUserId,
        unique_id: `demo_${String(seedNum(secUserId, 100000, 999999))}`,
        nickname,
        signature: "成分党 · 只讲有证据的成分（联调假数据）",
        follower_count: followers,
        following_count: seedNum(secUserId + "f", 20, 400),
        total_favorited: Math.round(followers * (seedNum(secUserId + "l", 30, 90) / 10)),
        aweme_count: known?.awemeCount ?? seedNum(secUserId + "a", 20, 400),
        ip_location: "上海",
        verified: true,
        avatar_thumb: { url_list: ["https://example.invalid/avatar.jpg"] },
      },
    },
  };
}

function worksPayload(secUserId: string, count: number): Record<string, unknown> {
  const now = Date.now();
  const list = Array.from({ length: count }, (_, i) => {
    const id = `${seedNum(secUserId + i, 7_000_000_000_000_000_000, 7_999_999_999_999_999_999)}`;
    return {
      aweme_id: id,
      desc: `第 ${i + 1} 条作品：精华成分拆解（联调假数据）`,
      create_time: Math.floor((now - i * 86_400_000 * 3) / 1000),
      statistics: {
        digg_count: seedNum(id, 2_000, 180_000),
        comment_count: seedNum(id + "c", 20, 3_000),
        share_count: seedNum(id + "s", 10, 900),
        collect_count: seedNum(id + "f", 50, 9_000),
      },
      cover: { url_list: ["https://example.invalid/cover.jpg"] },
    };
  });
  return { code: 200, router: "/api/douyin/web/fetch_user_post_videos", _lab: { mock: true }, data: { aweme_list: list } };
}

function commentsPayload(awemeId: string, count: number): Record<string, unknown> {
  const now = Date.now();
  const platitudes = ["成分表看懂了，已加购", "求链接！", "这个浓度会不会刺激", "主播讲得太清楚了", "同款用过，确实好用"];
  const list = Array.from({ length: count }, (_, i) => {
    const cid = `${seedNum(awemeId + i, 1_000_000_000, 1_999_999_999)}`;
    return {
      cid,
      text: platitudes[seedNum(cid, 0, platitudes.length)] ?? platitudes[0],
      user: { nickname: `用户${String(seedNum(cid + "u", 100, 999))}` },
      digg_count: seedNum(cid + "d", 0, 800),
      // IP 属地：用来演示"有偏代理"——它不等于粉丝地域
      ip_label: ["广东", "浙江", "江苏", "北京", "四川"][seedNum(cid + "p", 0, 5)] ?? "广东",
      create_time: Math.floor((now - i * 3_600_000) / 1000),
    };
  });
  return { code: 200, router: "/api/douyin/web/fetch_video_comments", _lab: { mock: true }, data: { comments: list, total: list.length } };
}

function xhsNotePayload(noteId: string): Record<string, unknown> {
  return {
    ok: true,
    _lab: { mock: true },
    meta: { via: "xhs-readonly-proxy(mock)", fetchedAt: new Date().toISOString() },
    data: {
      note: {
        note_id: noteId,
        title: "早C晚A退场后，我在用什么（联调假数据）",
        desc: "胜肽 + 玻色因复配，比单纯堆浓度更稳。三个月实测记录…",
        type: "normal",
        user: { user_id: "xhs_demo_2001", nickname: "三十岁护肤日记" },
        interact_info: { liked_count: 12_400, collected_count: 8_900, comment_count: 431 },
        tags: ["护肤", "成分党", "抗老"],
        time: new Date(Date.now() - 12 * 86_400_000).toISOString(),
      },
    },
  };
}

function xhsCommentsPayload(noteId: string, count: number): Record<string, unknown> {
  const platitudes = ["收藏了！", "求同款", "这个搭配我也可以", "已下单试试", "讲得好细"];
  const list = Array.from({ length: count }, (_, i) => {
    const cid = `${seedNum(noteId + i, 1_000_000, 9_999_999)}`;
    return {
      comment_id: cid,
      content: platitudes[seedNum(cid, 0, platitudes.length)] ?? platitudes[0],
      user: { nickname: `小红薯${String(seedNum(cid + "u", 100, 999))}` },
      like_count: seedNum(cid + "l", 0, 500),
      ip_location: ["上海", "广东", "浙江", "湖北", "福建"][seedNum(cid + "p", 0, 5)] ?? "上海",
      create_time: new Date(Date.now() - i * 3_600_000).toISOString(),
      sub_comment_count: seedNum(cid + "s", 0, 12),
    };
  });
  return { ok: true, _lab: { mock: true }, data: { comments: list, total: list.length } };
}

function xhsUserPayload(userId: string): Record<string, unknown> {
  return {
    ok: true,
    _lab: { mock: true },
    data: {
      user: {
        user_id: userId,
        nickname: `小红书博主 ${String(seedNum(userId, 100, 999))}`,
        desc: "护肤 · 成分 · 生活（联调假数据）",
        // 刻意留 null 演示"取不到就是 null"：小红书 web 接口常缺这些计数
        interact_info: { fans: seedNum(userId + "f", 10_000, 600_000), note_count: seedNum(userId + "n", 20, 300) },
        ip_location: "浙江",
      },
    },
  };
}

function xhsUserPostsPayload(userId: string, count: number): Record<string, unknown> {
  const notes = Array.from({ length: count }, (_, i) => ({
    note_id: `${seedNum(userId + i, 1_000_000_000, 9_999_999_999)}`,
    title: `笔记 ${i + 1}：空瓶记（联调假数据）`,
    desc: "本期空瓶与回购清单…",
    type: i % 4 === 0 ? "video" : "normal",
    user: { user_id: userId, nickname: `小红书博主 ${String(seedNum(userId, 100, 999))}` },
    interact_info: {
      liked_count: seedNum(userId + i + "l", 200, 60_000),
      collected_count: seedNum(userId + i + "c", 100, 30_000),
      comment_count: seedNum(userId + i + "m", 10, 2_000),
    },
    time: new Date(Date.now() - i * 3 * 86_400_000).toISOString(),
  }));
  return { ok: true, _lab: { mock: true }, data: { notes, total: notes.length } };
}

/* ── 小红书真实只读代理（--xhs-real） ──────────────────────
 *
 * 命令白名单写死在这张表里。写命令（like / comment / post / follow / delete /
 * favorite / reply / unfavorite / unfollow / delete-comment）**根本不在表中**，
 * 因此不存在"某个参数能触发写操作"的路径 —— 这是代码级隔离，不是文档约定。
 *
 * 另外：argv 以数组形式交给 spawn（不走 shell），用户输入永远只是**一个参数**，
 * 没有拼接，也就没有注入面。
 */

interface CliPlan {
  argv(userInput: string, count: number): string[];
}

const XHS_CLI_READONLY: Record<string, CliPlan> = {
  note: { argv: (v) => ["read", v, "--json"] },
  comments: { argv: (v) => ["comments", v, "--all", "--json"] },
  user: { argv: (v) => ["user", v, "--json"] },
  userPosts: { argv: (v) => ["user-posts", v, "--json"] },
};

function runXhsCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("xhs", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`xhs ${args[0]} 超时（${CLI_TIMEOUT_MS}ms）`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
    child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** CLI 可能在 JSON 前后打日志，所以取第一个 `{` 到最后一个 `}` 之间的内容 */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function callXhsCli(op: string, input: string, count: number): Promise<{ status: number; body: unknown }> {
  const plan = XHS_CLI_READONLY[op];
  if (!plan) return { status: 400, body: { ok: false, error: { code: "unsupported_operation", message: `未登记的操作 ${op}` } } };

  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await runXhsCli(plan.argv(input, count));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT：本机没装 CLI。这属于"代理未就绪"，不是"小红书不可用"，要说清区别
    const code = /ENOENT/.test(msg) ? "tool_missing" : "proxy_error";
    return {
      status: 503,
      body: {
        ok: false,
        error: {
          code,
          message: /ENOENT/.test(msg)
            ? "本机未安装 xhs CLI（uv tool install xiaohongshu-cli）。用 --xhs-mock 可先跑通链路。"
            : msg,
        },
      },
    };
  }

  const parsed = extractJson(r.stdout) ?? extractJson(r.stderr);
  if (!parsed) {
    return { status: 502, body: { ok: false, error: { code: "api_error", message: `无法解析 CLI 输出：${(r.stderr || r.stdout).slice(0, 200)}` } } };
  }

  // CLI 自己的信封已经是 { ok, data, error }（见其 SCHEMA.md），直接透传
  const err = parsed.error as { code?: string; message?: string } | undefined;
  if (err?.code || parsed.ok === false) {
    return { status: 200, body: { ok: false, error: { code: err?.code ?? "api_error", message: err?.message ?? "CLI 返回失败" } } };
  }
  return { status: 200, body: { ok: true, data: parsed.data ?? parsed, meta: { via: "xhs-cli" } } };
}

/* ── HTTP 服务 ───────────────────────────────────────────── */

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
};

const num = (v: string | null, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== "" ? Math.max(1, Math.min(50, Math.trunc(n))) : dflt;
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const q = url.searchParams;
  const path = url.pathname;

  if (path === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      mode: XHS_REAL ? "xhs-real" : "mock",
      douyinEndpoints: [
        "/api/douyin/web/fetch_user_profile",
        "/api/douyin/web/fetch_user_post_videos",
        "/api/douyin/web/fetch_one_video",
        "/api/douyin/web/fetch_video_comments",
      ],
      xhsEndpoints: ["/xhs/note", "/xhs/comments", "/xhs/user", "/xhs/user-posts"],
    });
    return;
  }

  // 故意失败 / 延迟开关
  const fail = q.get("__fail");
  const delay = Number(q.get("__delay") ?? 0);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  if (fail === "http_500") {
    sendJson(res, 500, { ok: false, error: { code: "http_500", message: "lab：按 __fail 参数故意返回 500" } });
    return;
  }

  /* ── 抖音（DTK v4 响应形态） ── */
  if (path === "/api/douyin/web/fetch_user_profile") {
    const id = q.get("sec_user_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 sec_user_id" });
    return sendJson(res, 200, creatorPayload(id));
  }
  if (path === "/api/douyin/web/fetch_user_post_videos") {
    const id = q.get("sec_user_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 sec_user_id" });
    return sendJson(res, 200, worksPayload(id, num(q.get("count"), 20)));
  }
  if (path === "/api/douyin/web/fetch_one_video") {
    const id = q.get("aweme_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 aweme_id" });
    return sendJson(res, 200, { code: 200, _lab: { mock: true }, data: (worksPayload("video", 1).data as { aweme_list: unknown[] }).aweme_list[0] });
  }
  if (path === "/api/douyin/web/fetch_video_comments") {
    const id = q.get("aweme_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 aweme_id" });
    return sendJson(res, 200, commentsPayload(id, num(q.get("count"), 20)));
  }

  /* ── 小红书（只读代理契约） ── */
  const XHS_ROUTES: Record<string, { op: string; inputParam: string }> = {
    "/xhs/note": { op: "note", inputParam: "note_id" },
    "/xhs/comments": { op: "comments", inputParam: "note_id" },
    "/xhs/user": { op: "user", inputParam: "user_id" },
    "/xhs/user-posts": { op: "userPosts", inputParam: "user_id" },
  };
  const xhsRoute = XHS_ROUTES[path];
  if (xhsRoute) {
    // 笔记类允许用 url 代替 id（真实 CLI 从 URL 里提取 xsec_token）
    const input = (q.get("url") ?? q.get(xhsRoute.inputParam) ?? "").trim();
    if (!input) return sendJson(res, 400, { ok: false, error: { code: "api_error", message: `缺少 ${xhsRoute.inputParam} 或 url` } });
    if (fail) return sendJson(res, 200, { ok: false, error: { code: fail, message: "lab：按 __fail 参数故意返回的业务错误" } });

    const count = num(q.get("count"), 20);
    if (XHS_REAL) return sendJson(res, ...(await callXhsCliToTuple(xhsRoute.op, input, count)));

    const mock =
      xhsRoute.op === "note"
        ? xhsNotePayload(input)
        : xhsRoute.op === "comments"
          ? xhsCommentsPayload(input, count)
          : xhsRoute.op === "user"
            ? xhsUserPayload(input)
            : xhsUserPostsPayload(input, count);
    return sendJson(res, 200, mock);
  }

  sendJson(res, 404, { ok: false, error: { code: "not_found", message: `lab 未登记的路由 ${path}` } });
}

const callXhsCliToTuple = async (op: string, input: string, count: number): Promise<[number, unknown]> => {
  const r = await callXhsCli(op, input, count);
  return [r.status, r.body];
};

const server = createServer((req, res) => {
  void handle(req, res).catch((e) => {
    sendJson(res, 500, { ok: false, error: { code: "lab_internal", message: e instanceof Error ? e.message : String(e) } });
  });
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log(`[lab] 监听 ${base}  模式：${XHS_REAL ? "小红书走真实 xhs CLI" : "全部 mock"}`);
  console.log(`[lab] 抖音假数据源：${base}/api/douyin/web/fetch_user_profile 等 4 个端点`);
  console.log(`[lab] 小红书只读代理：${base}/xhs/note|comments|user|user-posts`);
  console.log("");
  console.log("把下面两行加进 .env 即可让网关接到本服务：");
  console.log(`  BM_DOUYIN_BASE_URL=${base}`);
  console.log(`  BM_XHS_BASE_URL=${base}`);
  console.log("");
  console.log("所有响应都带 _lab:{mock:true}，适配器会据此把 provenance.synthetic 置为 true —— 假数据自己声明自己是假的。");
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

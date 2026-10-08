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
 *   默认（mock）：抖音**两代形态都提供**（v4 老路径 + v5 `/api/v1/douyin/*`）、
 *                小红书按只读代理契约，返回确定性假数据
 *   `--xhs-real`：小红书侧改为调用真实的 `xhs` CLI（只读子命令白名单）
 *                可用 `--xhs-bin=<路径>` 换掉可执行文件名（默认 `xhs`），
 *                便于用假 CLI 夹具验证错误码归一化，或指向 uv tool 装的另一份拷贝
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
/**
 * 可执行文件名/路径。默认 `xhs`；给测试夹具或另一份安装留出口子。
 *
 * 它不削弱"只读"这条边界：边界落在**参数怎么拼**上（`XHS_CLI_READONLY` 只生成
 * read/comments/user/user-posts 四个子命令），换二进制不改变会调用哪些命令。
 * 一个被换掉的二进制能干的事，和 PATH 上一个被投毒的 `xhs` 能干的事是一样的，
 * 所以这里没有引入新的信任假设。
 */
const XHS_BIN = opt("xhs-bin", "xhs");

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

/* ── 抖音假后端 ─────────────────────────────────────────────
 *
 * 两代形态**都提供**，因为它们的信封与路径毫无交集：
 *   v4：`{ code, router, _lab, data }`       路径 /api/douyin/web/fetch_*
 *   v5：`{ success, _lab, data, error, meta }` 路径 /api/v1/douyin/*
 * 下面的 builder 只产出**内层 data**，由 HTTP 层按路径选信封 —— 这样两代共用一份
 * 假数据，且不会出现"改了 v4 忘了改 v5"的静默漂移。
 *
 * 为什么必须提供 v5：适配器的默认形态就是 v5（当前仓库 compose 装出来的 DTK 是 5.1.x）。
 * 只有 v4 假后端的话，`npm run datasource:smoke` 跑的是默认配置，却打到一个不存在的
 * 路径上 —— 联调工具会以"服务不通"的形式掩盖真正的形态问题。
 */

const creatorData = (secUserId: string): Record<string, unknown> => {
  const known = KNOWN_CREATORS[secUserId];
  const nickname = known?.nickname ?? `Demo 达人 ${String(seedNum(secUserId, 1000, 9999))}`;
  const followers = known?.followers ?? seedNum(secUserId, 30_000, 800_000);
  return {
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
  };
};

const worksData = (secUserId: string, count: number): Record<string, unknown> => {
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
  return { aweme_list: list };
};

const commentsData = (awemeId: string, count: number): Record<string, unknown> => {
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
  return { comments: list, total: list.length };
};

/** 单条作品。适配器对 `video` op 的约定是"data 就是那一条作品本身" */
const oneVideo = (): Record<string, unknown> => (worksData("video", 1).aweme_list as Record<string, unknown>[])[0] ?? {};

/** v4 信封 */
const v4Envelope = (router: string, data: unknown): Record<string, unknown> => ({
  code: 200,
  router,
  _lab: { mock: true },
  data,
});

/** v5 信封。真实 v5 的字段是 `{success, data, error, meta}`，`_lab` 是我们的约定扩展 */
const v5Envelope = (data: unknown): Record<string, unknown> => ({
  success: true,
  _lab: { mock: true, tool: "datasource-lab" },
  data,
  error: null,
  meta: { request_id: "lab", duration_ms: 0 },
});

/** v5 的 202：任务句柄放在 data 里面。用来验证"适配器不会把它当成数据" */
const v5Accepted = (): Record<string, unknown> => ({
  success: true,
  _lab: { mock: true, tool: "datasource-lab" },
  data: { task_id: "00000000-0000-4000-8000-000000000000", state: "running" },
  error: null,
  meta: { request_id: "lab" },
});

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

/* ── CLI 原生失败 → 契约标准错误码 ───────────────────────────
 *
 * 为什么需要这一层：CLI 的失败词汇**不稳定**。它有时给出自己的 `err.code`（且命名
 * 不一定与契约一致），有时只打印一句中文/英文报错，有时连 JSON 都不给、只能靠退出码
 * 判断。如果原样透传，适配器那张「错误码 → 处置」表就永远命中不了，
 * 运营最终看到的仍然是一句"小红书不可用"——而归一化的全部意义就是消灭这句话。
 *
 * 所以这里只做一件事：把能识别的失败压成契约里固定的那几个码。
 * **认不出来就如实说认不出来**，不猜——留原始片段，让人去看。
 *
 * 判定顺序有讲究：先"登录态过期"再"未登录"，因为"登录已过期"同时含"登录"，
 * 反过来会把过期误报成未登录；"验证码"排在"限流"前，因为触发验证的文案里常带"风控"。
 */
const XHS_CANONICAL_CODES = new Set([
  "not_authenticated",
  "session_expired",
  "verification_required",
  "ip_blocked",
  "signature_error",
  "tool_missing",
  "unsupported_operation",
  "api_error",
]);

const XHS_FAIL_PATTERNS: { code: string; re: RegExp }[] = [
  // 登录态过期：Cookie 约 7 天，这是最高频的一类
  { code: "session_expired", re: /(登录|登陆|登入)[^\n]{0,8}(已)?(过期|失效|超时)|session[^\n]{0,10}expir|token[^\n]{0,10}expir|cookie[^\n]{0,10}expir/i },
  // 从未登录：代理侧还没做过那一次登录
  { code: "not_authenticated", re: /未登录|尚未登录|请先登录|需要登录|请登录|重新登录|未认证|未授权|缺少\s*cookie|没有\s*cookie|cookie\s*(缺失|为空)|no\s*a1\s*cookie|not\s*(logged|authenticated)|login\s*required|unauthenticated/i },
  // 验证码 / 人机校验：需要人工介入，自动重试没有意义
  { code: "verification_required", re: /验证码|captcha|人机(验证|校验)|滑块|安全验证|verify[_ ]?(code|failed)|verification[^\n]{0,10}(required|failed)/i },
  // 限流 / IP 被封
  { code: "ip_blocked", re: /(ip)[^\n]{0,10}(封|限|拉黑|异常)|ip[^\n]{0,10}(block|ban|limit)|too\s*many\s*request|rate[^\n]{0,6}limit|请求(过于)?频繁|频率(过高|限制)|限流|风控拦截|\b429\b/i },
  // 签名失败：通常是采集工具版本过旧
  { code: "signature_error", re: /签名(错误|失败|校验|不合法|异常)|signature[^\n]{0,10}(error|fail|invalid)|sign[^\n]{0,6}fail/i },
];

/** 命中返回标准码，否则返回 null（= 认不出来，不猜） */
function classifyXhsFailure(text: string): string | null {
  for (const { code, re } of XHS_FAIL_PATTERNS) if (re.test(text)) return code;
  return null;
}

/**
 * 把「CLI 给的错误码 + 原文」归一化成契约码。
 *
 * 返回的码**一定落在 XHS_CANONICAL_CODES 里**。理由：错误码空间必须是闭合的，
 * 否则适配器的处置表就是一个永远补不完的表格，而"未登记的错误码"对运营毫无信息量。
 * 认不出来时退到 `api_error`，但 CLI 的原始码会由调用方写进 message 里，不丢信息。
 *
 * @param code CLI 自己给的码（可能没有、可能不是契约词汇）
 * @param text 原文（stdout + stderr），用于在 code 不可用时兜底识别
 */
function normalizeXhsFailure(code: string, text: string): string {
  // CLI 若已经给出契约里的码，尊重它——不要用文案去覆盖一个明确的结构化声明
  if (XHS_CANONICAL_CODES.has(code)) return code;
  // 否则用 code + 原文一起识别（code 本身可能就是有信息量的英文单词）
  return classifyXhsFailure(`${code}\n${text}`) ?? "api_error";
}

/** 把 CLI 的原始码与原文拼成一条不丢信息的 message */
function xhsFailureMessage(code: string, text: string): string {
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 240);
  const tag = code && !XHS_CANONICAL_CODES.has(code) ? `[CLI 原始码 ${code}] ` : "";
  return `${tag}${excerpt || "(CLI 未输出任何错误信息)"}`;
}

function runXhsCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(XHS_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
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

const xhsErr = (code: string, message: string): { ok: false; error: { code: string; message: string } } => ({
  ok: false,
  error: { code, message },
});

async function callXhsCli(op: string, input: string, count: number): Promise<{ status: number; body: unknown }> {
  const plan = XHS_CLI_READONLY[op];
  if (!plan) return { status: 400, body: xhsErr("unsupported_operation", `未登记的操作 ${op}`) };

  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await runXhsCli(plan.argv(input, count));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT：本机没装 CLI。这属于"代理未就绪"，不是"小红书不可用"，要说清区别
    if (/ENOENT/.test(msg)) {
      return {
        status: 503,
        body: xhsErr(
          "tool_missing",
          `本机未安装 xhs CLI（可执行文件 "${XHS_BIN}" 不存在）。在部署机器上执行 uv tool install xiaohongshu-cli 并完成一次登录；` +
            `若只想先跑通链路，用 npm run datasource:lab（mock 模式）并把 BM_XHS_BASE_URL 指向它。`,
        ),
      };
    }
    if (/EACCES/.test(msg)) {
      // EACCES 和 ENOENT 都是"代理未就绪"，但对运维来说修复动作不同，不能合并成一句
      return {
        status: 503,
        body: xhsErr("tool_missing", `xhs CLI 存在但不可执行（权限不足）：给 "${XHS_BIN}" 补上执行位，或换用 --xhs-bin 指向可执行的拷贝。`),
      };
    }
    if (/超时/.test(msg)) {
      return { status: 504, body: xhsErr("proxy_error", `${msg}。CLI 内置人类化延迟，可用 --cli-timeout 调大，或降低并发。`) };
    }
    return { status: 502, body: xhsErr("proxy_error", `无法启动 xhs CLI：${msg}`) };
  }

  const raw = `${r.stderr}\n${r.stdout}`.trim();
  const parsed = extractJson(r.stdout) ?? extractJson(r.stderr);

  if (parsed) {
    // CLI 自己的信封已经是 { ok, data, error }（见其 SCHEMA.md），先看它是不是失败
    const err = parsed.error as { code?: unknown; message?: unknown } | undefined;
    if (err !== undefined || parsed.ok === false) {
      const cliCode = String(err?.code ?? "");
      const cliMsg = String(err?.message ?? "");
      return {
        status: 200,
        body: xhsErr(normalizeXhsFailure(cliCode, `${cliMsg}\n${raw}`), xhsFailureMessage(cliCode, cliMsg || raw)),
      };
    }
    // 上游若自己带了 `_lab`（测试夹具会带），原样透传 —— 适配器据此把 synthetic 置 true。
    // 真实 xhs CLI 不带这个字段，所以这一分支只在夹具上生效，不影响真实链路。
    const lab = parsed._lab;
    return {
      status: 200,
      body: { ok: true, ...(lab ? { _lab: lab } : {}), data: parsed.data ?? parsed, meta: { via: "xhs-cli" } },
    };
  }

  // 没有可解析的 JSON：可能是升级提示、可能只是把错误打在了 stderr。用原文归一化。
  if (r.code === 0) {
    return { status: 502, body: xhsErr("api_error", `CLI 退出码 0 但输出不是 JSON，无法解析：${raw.slice(0, 240)}`) };
  }
  const sniffed = classifyXhsFailure(raw);
  if (sniffed) {
    // 认出来了：按契约码返回（业务错误走 200，与 xhs-cli 的失败信封一致）
    return { status: 200, body: xhsErr(sniffed, xhsFailureMessage("", raw)) };
  }
  return {
    status: 502,
    body: xhsErr(
      "api_error",
      `xhs CLI 退出码 ${r.code}，输出既不匹配任何已知失败模式、也不是 JSON：${raw.slice(0, 240) || "(无输出)"}`,
    ),
  };
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
      xhsBin: XHS_REAL ? XHS_BIN : null,
      douyinEndpoints: [
        "/api/v1/douyin/user",
        "/api/v1/douyin/user/posts",
        "/api/v1/douyin/video",
        "/api/v1/douyin/video/comments",
      ],
      douyinV4Endpoints: [
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

  /* ── 抖音 v4 形态（DTK 老版本：同步 GET，无鉴权） ── */
  if (path === "/api/douyin/web/fetch_user_profile") {
    const id = q.get("sec_user_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 sec_user_id" });
    return sendJson(res, 200, v4Envelope(path, creatorData(id)));
  }
  if (path === "/api/douyin/web/fetch_user_post_videos") {
    const id = q.get("sec_user_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 sec_user_id" });
    return sendJson(res, 200, v4Envelope(path, worksData(id, num(q.get("count"), 20))));
  }
  if (path === "/api/douyin/web/fetch_one_video") {
    const id = q.get("aweme_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 aweme_id" });
    return sendJson(res, 200, v4Envelope(path, oneVideo()));
  }
  if (path === "/api/douyin/web/fetch_video_comments") {
    const id = q.get("aweme_id") ?? "";
    if (!id) return sendJson(res, 400, { code: 400, msg: "缺少 aweme_id" });
    return sendJson(res, 200, v4Envelope(path, commentsData(id, num(q.get("count"), 20))));
  }

  /* ── 抖音 v5 形态（dtk 5.1.x：/api/v1 前缀、wait 是秒数、默认强制鉴权） ──
   *
   * 与真实 v5 的三处差异都在**故意为之**，因为它们正是联调要验的东西：
   *   · `wait=true` 一律 422 —— 真实 v5 的类型校验就这么严；把布尔量放过去的话，
   *     "形态选错"这个最贵的错会在联调阶段被掩盖；
   *   · `?__v5=202`（或缺少 wait）时返回任务句柄 —— 用来验证适配器不会把它当成数据；
   *   · 不校验 API Key（联调工具不该逼迫使用者配一个假 Key），但在响应头里点明这件事。
   */
  if (path.startsWith("/api/v1/douyin/")) {
    const wait = q.get("wait");
    // HTTP 头只能是 latin1：中文放进去 Node 会抛
    // `Invalid character in header content`，本地能跑的服务到线上就是 500。
    res.setHeader("X-Lab-Note", "mock backend: auth is NOT enforced here; real DTK v5 requires an API key");
    if (wait === "true") {
      return sendJson(res, 422, {
        detail: [
          {
            type: "float_parsing",
            loc: ["query", "wait"],
            msg: "Input should be a valid number, unable to parse string as a number",
            input: "true",
          },
        ],
      });
    }
    const secUserId = q.get("sec_user_id") ?? "";
    const awemeId = q.get("aweme_id") ?? "";
    const count = num(q.get("count"), 20);
    const asyncWanted = wait === null || Number(wait) <= 0 || q.get("__v5") === "202";

    if (path === "/api/v1/douyin/user") {
      if (!secUserId) return sendJson(res, 422, { detail: [{ loc: ["query", "sec_user_id"], msg: "one of url or sec_user_id is required" }] });
      return sendJson(res, asyncWanted ? 202 : 200, asyncWanted ? v5Accepted() : v5Envelope(creatorData(secUserId)));
    }
    if (path === "/api/v1/douyin/user/posts") {
      if (!secUserId) return sendJson(res, 422, { detail: [{ loc: ["query", "sec_user_id"], msg: "one of url or sec_user_id is required" }] });
      return sendJson(res, asyncWanted ? 202 : 200, asyncWanted ? v5Accepted() : v5Envelope(worksData(secUserId, count)));
    }
    if (path === "/api/v1/douyin/video") {
      if (!awemeId) return sendJson(res, 422, { detail: [{ loc: ["query", "aweme_id"], msg: "one of url or aweme_id is required" }] });
      return sendJson(res, asyncWanted ? 202 : 200, asyncWanted ? v5Accepted() : v5Envelope(oneVideo()));
    }
    if (path === "/api/v1/douyin/video/comments") {
      if (!awemeId) return sendJson(res, 422, { detail: [{ loc: ["query", "aweme_id"], msg: "one of url or aweme_id is required" }] });
      return sendJson(res, asyncWanted ? 202 : 200, asyncWanted ? v5Accepted() : v5Envelope(commentsData(awemeId, count)));
    }
    return sendJson(res, 404, {
      success: false,
      error: { code: "not_found", message: `lab 未登记的 v5 路由 ${path}` },
      data: null,
      meta: {},
    });
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
  console.log(`[lab] 监听 ${base}  模式：${XHS_REAL ? `小红书走真实 CLI（${XHS_BIN}）` : "全部 mock"}`);
  console.log(`[lab] 抖音假数据源 v5：${base}/api/v1/douyin/user 等 4 个端点（wait 是秒数，传 wait=true 会 422）`);
  console.log(`[lab] 抖音假数据源 v4：${base}/api/douyin/web/fetch_user_profile 等 4 个端点（老版本用）`);
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

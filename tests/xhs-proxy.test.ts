/**
 * 小红书只读代理：真实进程级联调（失败路径为主）
 *
 * 运行：npm test —— 会真实 spawn 子进程，但**不访问任何外部网络**：
 * 代理是 `scripts/datasource-lab.ts`（本机），"xhs CLI" 是 `tests/fixtures/fake-xhs.mjs`。
 *
 * ── 为什么不能只用打桩 ─────────────────────────────────────────
 *
 * `datasource-adapters.test.ts` 把 `globalThis.fetch` 打桩，验的是"拿到某个响应之后
 * 适配器怎么处理"。它**验不到**这一层：代理拿到 CLI 那堆不稳定的输出之后，
 * 到底能不能认出这是哪一种失败。
 *
 * 而真实环境的失败长这样（夹具逐一复刻）：
 *   · 只给一句中文"登录已过期"，**不给错误码**；
 *   · 给一个自造的码 `E_RISK`，信息全在 message 里；
 *   · 连 JSON 都没有，只在 stderr 打一行限流文案 + 非零退出码；
 *   · 打的还是英文 `no a1 cookie found, not logged in`。
 *
 * 这几种如果归一层不认，适配器那张「错误码 → 处置」表就永远命中不了，
 * 运营最终看到的还是"小红书不可用"—— 而归一化存在的唯一理由就是消灭这句话。
 * 所以这一组用例必须走**真实 spawn**，否则验的是假的那一层。
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@brandsale/config";
import { createXhsWebAdapter, XHS_WEB_SOURCE_ID } from "@brandsale/datasource";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "tests", "fixtures", "fake-xhs.mjs");
const LAB = join(ROOT, "scripts", "datasource-lab.ts");
/** 保证不存在的路径，用来验 `tool_missing` */
const MISSING_BIN = join(ROOT, "tests", "fixtures", "no-such-xhs-binary");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

interface Lab {
  base: string;
  child: ChildProcess;
}

async function startLab(xhsBin: string): Promise<Lab> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", LAB, "--xhs-real", `--xhs-bin=${xhsBin}`, `--port=${port}`, "--host=127.0.0.1"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  child.stdout?.on("data", (d: Buffer) => (logs += String(d)));
  child.stderr?.on("data", (d: Buffer) => (logs += String(d)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { base, child };
    } catch {
      /* 还没起来 */
    }
    await sleep(120);
  }
  child.kill("SIGKILL");
  throw new Error(`lab 未在 30s 内起来。日志：\n${logs.slice(0, 2000)}`);
}

const stopLab = (l: Lab | null): void => {
  if (l && !l.child.killed) l.child.kill("SIGKILL");
};

let lab: Lab | null = null;
let missingLab: Lab | null = null;
let tmp = "";

before(async () => {
  assert.ok(existsSync(FIXTURE), `夹具缺失：${FIXTURE}`);
  chmodSync(FIXTURE, 0o755); // spawn 需要执行位；git 的 exec 位在某些环境下会丢
  tmp = mkdtempSync(join(tmpdir(), "bm-xhsp-"));
  lab = await startLab(FIXTURE);
  missingLab = await startLab(MISSING_BIN);
});

after(() => {
  stopLab(lab);
  stopLab(missingLab);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/* ── 工具 ─────────────────────────────────────────────── */

function adapterFor(base: string) {
  const config = loadConfig(ROOT, {
    BM_DATA_DIR: tmp,
    BM_LLM_MODE: "mock",
    BM_XHS_BASE_URL: base,
    BM_XHS_TIMEOUT_MS: "8000",
  });
  const adapter = createXhsWebAdapter(config);
  // 适配器契约里 fetch 收 (query, config)；工具层也是这么调的，测试保持一致
  return { adapter, call: (q: Parameters<typeof adapter.fetch>[0]) => adapter.fetch(q, config) };
}

/** 直接打代理，拿原始信封 —— 验"归一层认出了什么" */
async function callProxy(base: string, noteId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/xhs/note?note_id=${encodeURIComponent(noteId)}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

const codeOf = (body: Record<string, unknown>): string =>
  String((body.error as { code?: string } | undefined)?.code ?? "");

/** 走一次适配器，把抛出的错误信息取回来（适配器契约就是"抛错带处置说明"） */
async function adapterError(base: string, noteId: string): Promise<string> {
  const { call } = adapterFor(base);
  try {
    await call({ tenantId: "t1", jobId: "j1", params: { op: "note", noteId } });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`预期适配器抛错，但它成功了（noteId=${noteId}）`);
}

/* ── 1. 夹具自身：先把"验的是真进程"这件事钉住 ─────────── */

test("XHS-PROXY-0 夹具真的被子进程执行了，且成功响应自带 synthetic 标记", async () => {
  const health = (await (await fetch(`${lab!.base}/healthz`)).json()) as Record<string, unknown>;
  assert.equal(health.mode, "xhs-real", "lab 必须处于真实 CLI 模式，否则这组用例验的还是 mock");
  assert.equal(health.xhsBin, FIXTURE, "healthz 必须回显实际用的可执行文件，防止悄悄跑回默认的 xhs");

  const { call } = adapterFor(lab!.base);
  const res = await call({ tenantId: "t1", jobId: "j1", params: { op: "note", noteId: "preamble-note" } });

  // JSON 前后夹了日志行，仍要能被解出来
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0]?.title, "换季护肤的 5 个坑，我全踩过");
  assert.equal(res.provenance.sourceId, XHS_WEB_SOURCE_ID);

  // 关键：夹具带了 _lab:{mock:true}，代理必须透传，适配器必须据此降级为合成数据。
  // 否则"用假 CLI 跑出来的假数据"会以真实采集的身份进入报告 —— 这正是本项目删过一次的坑。
  assert.equal(res.provenance.synthetic, true, "夹具数据必须被标为合成，不得冒充真实采集");
  assert.match(res.provenance.note, /本地联调假数据/);

  // 计数归一化："1.2万" 要变成 12000
  const userRes = await call({ tenantId: "t1", jobId: "j1", params: { op: "user", userId: "u_8842" } });
  assert.equal(userRes.rows[0]?.followerCount, 12_000);
});

/* ── 2. 失败路径：CLI 输出形态各异，归一层都要认出来 ────── */

/** 夹具场景 → 期望的契约错误码 */
const FAIL_CASES: { name: string; token: string; code: string; adapterMustSay: RegExp }[] = [
  // 只有一句中文报错，没有 code。归一层必须从文案里认出"登录态过期"
  { name: "登录已过期（CLI 未给错误码）", token: "expired", code: "session_expired", adapterMustSay: /登录态已过期/ },
  // 自造的码 E_RISK，信息全在 message 里
  { name: "验证码（CLI 给的码不在契约里）", token: "captcha", code: "verification_required", adapterMustSay: /验证码/ },
  // 完全没有 JSON，只有 stderr + 非零退出码
  { name: "IP 限流（无 JSON，仅 stderr + 退出码）", token: "blocked", code: "ip_blocked", adapterMustSay: /出口 IP 被限流/ },
  // 英文文案
  { name: "未登录（英文文案）", token: "noauth", code: "not_authenticated", adapterMustSay: /代理未登录/ },
  { name: "签名失败", token: "signfail", code: "signature_error", adapterMustSay: /签名/ },
  // CLI 已经给了契约里的码 → 必须原样尊重，不能被文案覆盖
  { name: "CLI 已给契约码（应原样透传）", token: "canonical", code: "session_expired", adapterMustSay: /登录态已过期/ },
  // 认不出来就如实说认不出来，不许猜
  { name: "无法识别的输出（应如实报，不猜）", token: "garbage", code: "api_error", adapterMustSay: /未登记|上游接口报错|代理/ },
];

for (const c of FAIL_CASES) {
  test(`XHS-PROXY 归一层：${c.name} → ${c.code}`, async () => {
    const { body } = await callProxy(lab!.base, c.token);
    assert.equal(codeOf(body), c.code, `归一层输出不符：${JSON.stringify(body)}`);
    assert.equal(body.ok, false);

    // 代理给出的 message 必须保留原文，不能只剩一个码
    const msg = String((body.error as { message?: string }).message ?? "");
    assert.ok(msg.length > 0, "message 不能为空：运维需要看到 CLI 的原始输出");

    // 适配器必须把它翻成可执行的处置。只写"小红书不可用"等于把排查成本推给运营。
    const err = await adapterError(lab!.base, c.token);
    assert.match(err, c.adapterMustSay, `适配器未给出对应处置：${err}`);
  });
}

test("XHS-PROXY-9 归一层输出始终落在契约码集合内（错误码空间必须闭合）", async () => {
  const canonical = new Set([
    "not_authenticated",
    "session_expired",
    "verification_required",
    "ip_blocked",
    "signature_error",
    "tool_missing",
    "unsupported_operation",
    "api_error",
  ]);
  for (const c of FAIL_CASES) {
    const { body } = await callProxy(lab!.base, c.token);
    assert.ok(canonical.has(codeOf(body)), `码 ${codeOf(body)} 不在契约集合内：适配器的处置表会永远补不完`);
  }
});

test("XHS-PROXY-10 非契约原始码不丢信息：会写进 message 里", async () => {
  const { body } = await callProxy(lab!.base, "captcha-case");
  const msg = String((body.error as { message?: string }).message ?? "");
  assert.match(msg, /E_RISK/, "CLI 自己起的码要保留，否则排查时无法与 CLI 日志对上");
});

/* ── 3. 代理未就绪 ≠ 小红书不可用 ────────────────────────── */

test("XHS-PROXY-11 本机未装 CLI → tool_missing，且给出可执行的安装步骤", async () => {
  const { status, body } = await callProxy(missingLab!.base, "any-note");
  assert.equal(status, 503, "代理未就绪用 5xx，与业务失败（200）区分开");
  assert.equal(codeOf(body), "tool_missing");

  const err = await adapterError(missingLab!.base, "any-note");
  // 这条是本次修复的正题：503 曾在 HTTP 状态分支上被压成一句 `代理 HTTP 503`，
  // 根本走不到处置表。现在必须带上"该做什么"。
  assert.match(err, /代理未就绪/, `适配器未把 503 翻译成处置：${err}`);
  assert.match(err, /uv tool install xiaohongshu-cli/, "要给出确切的下一步命令");
  assert.doesNotMatch(err, /^小红书采集失败 \[http_503\]/, "不得退化成裸 HTTP 状态");
});

/* ── 4. 写能力隔离：靠路由表，不靠开关 ──────────────────── */

test("XHS-PROXY-12 写命令根本不存在于代理路由表与 CLI 白名单", async () => {
  // 代理路由表只有四个只读端点，任何写路径都必须是 404
  for (const p of ["/xhs/like", "/xhs/comment", "/xhs/post", "/xhs/follow", "/xhs/delete", "/xhs/favorite"]) {
    const r = await fetch(`${lab!.base}${p}?note_id=x`);
    assert.equal(r.status, 404, `${p} 不该存在：写能力必须靠"路由表里没有"来隔离`);
  }

  // 适配器侧：op 白名单同样闭合
  const { adapter, call } = adapterFor(lab!.base);
  assert.ok(adapter.sourceId === XHS_WEB_SOURCE_ID);
  await assert.rejects(
    () => call({ tenantId: "t1", jobId: "j1", params: { op: "like", noteId: "x" } }),
    /不支持的小红书操作/,
  );
});

/* ── 5. 刻意失败开关仍然可用（降级路径联调） ────────────── */

test("XHS-PROXY-13 代理的 __fail 开关仍能注入契约码，供降级路径联调", async () => {
  for (const code of ["not_authenticated", "session_expired", "verification_required", "ip_blocked"]) {
    const r = await fetch(`${lab!.base}/xhs/note?note_id=x&__fail=${code}`);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(codeOf(body), code);
  }
});

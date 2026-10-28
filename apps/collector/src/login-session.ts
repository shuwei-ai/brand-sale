/**
 * 服务端扫码登录的**会话管理**（Node 侧）。
 *
 * 分工：真正的浏览器操作在 `apps/collector/py/login_runner.py`（只读、无头、与内核共用
 * profile），这里负责三件事 —— 起子进程、把它的 JSON 事件行翻译成会话状态、让上层
 * （collector HTTP → 网关 → 前端）能轮询到二维码与结果。
 *
 * 两个刻意的设计：
 *   1. **同一时刻只允许一个登录/探测进程**（`active` 守护）。七个平台并发扫码就是七个
 *      chromium，按每个 0.5–0.8 GB 算直接把 4 GB 机器打爆；而且内核采集本身也是串行的，
 *      这里并发没有收益，只有风险。
 *   2. **二维码只在内存里**。它是短时效凭据（2 分钟内可换一个账号会话），不落库、不落
 *      磁盘日志 —— 日志里只记"已获取二维码 / 已登录"，不记 base64。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { MEDIA_CRAWLER_PLATFORM_META, MEDIA_CRAWLER_PLATFORMS, type MediaCrawlerPlatform } from "@brandsale/config";
import type { CdpMode, SpiderXhsConfig, SpiderDyConfig, XhsDriver, DyDriver } from "./config.ts";
import { reapBrowser } from "./browser-session.ts";

/** 会话状态机。`waiting_scan` 之后只可能落到四个终态之一 */
export type LoginState =
  | "starting"
  | "waiting_scan"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled";

export interface LoginSession {
  id: string;
  platform: MediaCrawlerPlatform;
  name: string;
  state: LoginState;
  /** `data:image/png;base64,...`，仅内存持有；过期后前端应展示"刷新二维码" */
  qrDataUrl?: string;
  /** 二维码获取时间（ISO） */
  qrAt?: string;
  /** 二维码过期时间（ISO），前端据此倒计时 */
  qrExpiresAt?: string;
  expiresAt: string;
  startedAt: string;
  finishedAt?: string;
  /** 人类可读的原因（失败/超时/已登录时给出） */
  message?: string;
  logFile: string;
}

/** 单平台登录态探测结果 */
export interface PlatformStatus {
  platform: MediaCrawlerPlatform;
  name: string;
  /**
   * bound      探活通过（接口/页面确认已登录）
   * unbound    探活确认未登录，或 profile 里根本没有该平台的 cookie
   * unverified 有 cookie 但无法确认（平台无稳定探活手段 / 探活被风控挡住）
   * error      浏览器或网络故障，什么都判不出来
   */
  state: "bound" | "unbound" | "unverified" | "error";
  /** verified = 有可信探活；cookie = 只看了 cookie 存在性 */
  confidence?: "verified" | "cookie";
  detail?: string;
  profileExists?: boolean;
  cookiePresent?: string[];
}

export interface StatusSnapshot {
  checkedAt?: string;
  probing: boolean;
  results: PlatformStatus[];
}

/** 子进程吐出来的一行事件（stdout 约定：单行 JSON） */
export interface LoginEvent {
  event: "qr" | "logged_in" | "already_logged_in" | "timeout" | "failed" | "status" | "done";
  platform?: string;
  dataUrl?: string;
  expiresIn?: number;
  at?: number;
  error?: string;
  state?: PlatformStatus["state"];
  confidence?: PlatformStatus["confidence"];
  detail?: string;
  cookiePresent?: string[];
  profileExists?: boolean;
  name?: string;
  seconds?: number;
}

/**
 * 解析一行 stdout。非 JSON（内核/浏览器的人类日志）返回 null —— 调用方据此落日志。
 *
 * 单独抽成纯函数是为了可测：这条边界一旦放宽（比如允许前后缀），Node 侧就会把
 * 浏览器噪音当成事件，症状是会话永远停在 starting。
 */
export function parseLoginEvent(line: string): LoginEvent | null {
  const t = line.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const obj = JSON.parse(t) as LoginEvent;
    return typeof obj?.event === "string" ? obj : null;
  } catch {
    return null;
  }
}

export interface LoginManagerDeps {
  coreDir: string;
  pythonBin: string;
  /** `apps/collector/py/login_runner.py` 的绝对路径 */
  scriptPath: string;
  /** 与内核共用的 profile 根目录（`<coreDir>/browser_data`） */
  browserDataDir: string;
  logDir: string;
  /** 登录是否无头。true = 服务端形态；false 仅本机调试用 */
  headless: boolean;
  /** 单次扫码总等待（毫秒） */
  timeoutMs: number;
  /** 二维码有效期（秒），透传给 Python 侧决定刷新节奏 */
  qrTtlSeconds: number;
  /** 七平台状态探测的总超时（毫秒） */
  checkTimeoutMs: number;
  /** 上一次探测结果的落盘路径（重启后仍能显示"最后确认时间"） */
  statusFile: string;
  /** 小红书可切换为 Spider_XHS；缺省 mc 保持旧部署行为 */
  xhsDriver?: XhsDriver;
  spiderXhs?: SpiderXhsConfig;
  /** 抖音可切换为 DouYin_Spider；缺省 mc 保持旧部署行为 */
  dyDriver?: DyDriver;
  spiderDy?: SpiderDyConfig;
  /**
   * 采集浏览器的启动模式。登录态变更成功后，仅在 `reuse` 模式下需要回收该平台的
   * 常驻浏览器（其它模式下浏览器是任务级的，登录态变更不产生"旧实例复用"问题）。
   */
  cdpMode?: CdpMode;
}

const TERMINAL: ReadonlySet<LoginState> = new Set<LoginState>(["succeeded", "failed", "timeout", "cancelled"]);

export class LoginManager {
  private readonly deps: LoginManagerDeps;
  private readonly sessions = new Map<string, LoginSession>();
  /** 当前占着浏览器的那一个（登录或探测），两者互斥 */
  private active: { kind: "login"; id: string } | { kind: "check" } | null = null;
  private child: ChildProcess | null = null;
  private probing = false;
  private snapshot: StatusSnapshot = { probing: false, results: [] };

  constructor(deps: LoginManagerDeps) {
    this.deps = deps;
    this.loadSnapshot();
  }

  private useSpider(platform: MediaCrawlerPlatform): boolean {
    return (
      (platform === "xhs" && this.deps.xhsDriver === "spider") ||
      (platform === "dy" && this.deps.dyDriver === "spider")
    );
  }

  private spiderRuntime(platform: MediaCrawlerPlatform): { pythonBin: string; scriptPath: string; cwd: string } {
    if (platform === "dy") {
      const spider = this.deps.spiderDy;
      if (!spider?.installed) {
        throw new Error("已选择 DouYin_Spider，但项目目录不完整；请检查 BM_SPIDER_DY_DIR");
      }
      return { pythonBin: spider.pythonBin, scriptPath: spider.runnerPy, cwd: spider.dir };
    }
    const spider = this.deps.spiderXhs;
    if (!spider?.installed) {
      throw new Error("已选择 Spider_XHS，但项目目录不完整；请检查 BM_SPIDER_XHS_DIR");
    }
    return { pythonBin: spider.pythonBin, scriptPath: spider.runnerPy, cwd: spider.dir };
  }

  /** 上次探测结果（重启后也能显示）。读不到就是空的，不算错误 */
  private loadSnapshot(): void {
    try {
      if (!existsSync(this.deps.statusFile)) return;
      const raw = JSON.parse(readFileSync(this.deps.statusFile, "utf8")) as StatusSnapshot;
      if (Array.isArray(raw?.results)) this.snapshot = { ...raw, probing: false };
    } catch {
      /* 文件损坏就当没有 —— 状态面板退化成"未探测"，不阻断任何东西 */
    }
  }

  private async saveSnapshot(): Promise<void> {
    try {
      await mkdir(this.deps.logDir, { recursive: true });
      await mkdir(dirname(this.deps.statusFile), { recursive: true });
      await writeFile(this.deps.statusFile, JSON.stringify(this.snapshot, null, 2), "utf8");
    } catch {
      /* 落盘失败只影响"重启后还能看到上次结果"，不影响本次 */
    }
  }

  /** 当前是否被占用（登录会话或状态探测） */
  busy(): { busy: boolean; kind?: "login" | "check"; platform?: string } {
    if (!this.active) return { busy: false };
    if (this.active.kind === "check") return { busy: true, kind: "check" };
    const s = this.sessions.get(this.active.id);
    return { busy: true, kind: "login", ...(s ? { platform: s.platform } : {}) };
  }

  get(id: string): LoginSession | undefined {
    return this.sessions.get(id);
  }

  list(): LoginSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  status(): StatusSnapshot {
    return { ...this.snapshot, probing: this.probing };
  }

  /**
   * 开一次扫码会话。
   *
   * 已经有**同一个平台**的活跃会话时直接复用（前端重复点"扫码绑定"不该开两次浏览器）；
   * 被别的平台或状态探测占着时返回 busy，让调用方明确告诉用户"稍后再试"。
   */
  start(platform: MediaCrawlerPlatform): { ok: true; session: LoginSession } | { ok: false; reason: string } {
    const running = [...this.sessions.values()].find((s) => s.platform === platform && !TERMINAL.has(s.state));
    if (running) return { ok: true, session: running };

    const busy = this.busy();
    if (busy.busy) {
      const who = busy.kind === "check" ? "正在探测登录状态" : `正在为 ${busy.platform} 扫码登录`;
      return { ok: false, reason: `${who}，请等它结束后再试（同一时刻只允许一个浏览器会话）` };
    }

    if (this.useSpider(platform) && platform === "dy") {
      // DouYin_Spider 没有 login 算子（抖音登录被风控，无法本地扫码），
      // 登录态只能来自「填 cookie」—— 引导用户走 setCookie 路径。
      return { ok: false, reason: "抖音已切换为 DouYin_Spider 通道，无法扫码登录；请在平台绑定页用「填 cookie」方式导入登录态" };
    }

    if (this.useSpider(platform) && !this.deps.spiderXhs?.installed) {
      return { ok: false, reason: "Spider_XHS 项目目录不完整，请检查 BM_SPIDER_XHS_DIR" };
    }

    const id = randomUUID();
    const now = Date.now();
    const meta = MEDIA_CRAWLER_PLATFORM_META[platform];
    const session: LoginSession = {
      id,
      platform,
      name: meta.displayName,
      state: "starting",
      expiresAt: new Date(now + this.deps.timeoutMs).toISOString(),
      startedAt: new Date(now).toISOString(),
      logFile: join(this.deps.logDir, `login-${platform}-${now}.log`),
    };
    this.sessions.set(id, session);
    this.prune();
    this.active = { kind: "login", id };

    const spider = this.useSpider(platform) ? this.deps.spiderXhs! : null;
    const child = this.spawnRunner(
      spider
        ? [
            "--op", "login",
            "--spider-dir", spider.dir,
            "--session-file", spider.sessionFile,
            "--timeout", String(Math.max(30, Math.round(this.deps.timeoutMs / 1000))),
            "--qr-ttl", String(this.deps.qrTtlSeconds),
          ]
        : [
            "--mode", "login",
            "--platform", platform,
            "--timeout", String(Math.max(30, Math.round(this.deps.timeoutMs / 1000))),
            "--qr-ttl", String(this.deps.qrTtlSeconds),
            "--browser-data", this.deps.browserDataDir,
            "--headless", this.deps.headless ? "true" : "false",
          ],
      session,
      (ev) => this.applyLoginEvent(session, ev),
      spider ? this.spiderRuntime(platform) : undefined,
    );

    // 子进程自己会按 --timeout 退出；这里只是兜底：万一它卡死，别把浏览器永久占住
    const guard = setTimeout(() => {
      if (!TERMINAL.has(session.state)) {
        session.state = "timeout";
        session.finishedAt = new Date().toISOString();
        session.message = "登录会话超时（兜底终止）";
        this.killChild();
      }
    }, this.deps.timeoutMs + 20_000);
    guard.unref();
    child.on("exit", () => clearTimeout(guard));

    return { ok: true, session };
  }

  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || TERMINAL.has(s.state)) return false;
    s.state = "cancelled";
    s.finishedAt = new Date().toISOString();
    s.message = "用户取消";
    if (this.active?.kind === "login" && this.active.id === id) this.killChild();
    return true;
  }

  /**
   * 手动导入 cookie（扫码被风控挡住时的兜底路径）。
   *
   * 用户在本机浏览器登录平台后复制 cookie，前端提交到这里，由 Python 侧写进
   * 与内核共用的 profile，再探活确认。整个过程仍走「同一时刻只允许一个浏览器
   * 会话」的互斥 —— 写 cookie 也要起浏览器，和扫码/探测共享 `active` 守护。
   *
   * 同步等待子进程完成（浏览器启动 + 写入 + 探活，通常十几秒），直接返回探活
   * 后的最终状态 —— 前端一次调用即可拿到「写进去了没有 / 是不是真的有效」。
   */
  async setCookie(platform: MediaCrawlerPlatform, cookie: string): Promise<{ ok: true; status: PlatformStatus } | { ok: false; reason: string }> {
    const busy = this.busy();
    if (busy.busy) {
      const who = busy.kind === "check" ? "正在探测登录状态" : `正在为 ${busy.platform} 扫码登录`;
      return { ok: false, reason: `${who}，请等它结束后再试（同一时刻只允许一个浏览器会话）` };
    }
    if (this.useSpider(platform) && platform === "dy" && !this.deps.spiderDy?.installed) {
      return { ok: false, reason: "DouYin_Spider 项目目录不完整，请检查 BM_SPIDER_DY_DIR" };
    }
    if (this.useSpider(platform) && platform !== "dy" && !this.deps.spiderXhs?.installed) {
      return { ok: false, reason: "Spider_XHS 项目目录不完整，请检查 BM_SPIDER_XHS_DIR" };
    }
    const trimmed = cookie.trim();
    if (!trimmed || !trimmed.includes("=")) {
      return { ok: false, reason: "cookie 为空或不是 name=value 形式" };
    }

    const meta = MEDIA_CRAWLER_PLATFORM_META[platform];
    const useSpiderDy = this.useSpider(platform) && platform === "dy";
    const useSpiderXhs = this.useSpider(platform) && platform !== "dy";
    let status: PlatformStatus = {
      platform,
      name: meta.displayName,
      state: "error",
      detail: "写入 cookie 未返回结果",
    };

    this.active = { kind: "check" }; // 复用 check 的互斥语义：写 cookie 也是一次浏览器操作
    this.probing = true;
    this.snapshot = { ...this.snapshot, probing: true };

    const child = this.spawnRunner(
      useSpiderDy
        ? ["--op", "set_cookie", "--spider-dir", this.deps.spiderDy!.dir,
            "--session-file", this.deps.spiderDy!.sessionFile, "--cookie", trimmed]
        : ["--mode", "cookie", "--platform", platform, "--cookie", trimmed,
            "--browser-data", this.deps.browserDataDir,
            "--headless", this.deps.headless ? "true" : "false"],
      null,
      (ev) => {
        if (ev.event === "status" && ev.platform === platform) {
          status = {
            platform,
            name: ev.name ?? meta.displayName,
            state: ev.state ?? "error",
            ...(ev.confidence ? { confidence: ev.confidence } : {}),
            ...(ev.detail ? { detail: ev.detail } : {}),
            ...(Array.isArray(ev.cookiePresent) ? { cookiePresent: ev.cookiePresent } : {}),
          };
        } else if (ev.event === "failed" && ev.platform === platform) {
          status = {
            platform,
            name: meta.displayName,
            state: "error",
            detail: ev.error ?? "写入 cookie 失败",
          };
        }
      },
      useSpiderDy || useSpiderXhs ? this.spiderRuntime(platform) : undefined,
    );

    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.killChild();
          resolve();
        }, this.deps.checkTimeoutMs);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      this.active = null;
      this.probing = false;
      this.snapshot = { ...this.snapshot, probing: false };
    }

    // 把探活结果并入快照，让前端列表与「检测登录状态」保持一致
    this.snapshot = {
      ...this.snapshot,
      results: mergeStatuses([platform], [status]),
      checkedAt: new Date().toISOString(),
    };
    await this.saveSnapshot();

    // 写 cookie 成功且确认 bound 时，同样要回收该平台的常驻浏览器，否则下次采集
    // 复用的旧实例仍是写 cookie 前的内存态（见 reapResidentBrowser 注释）。
    if (status.state === "bound") this.reapResidentBrowser(platform);

    return { ok: true, status };
  }

  /**
   * 探测七平台（或指定平台）的登录状态。
   *
   * 串行是有意的：探测要真起浏览器，七个并发 = 五 GB 内存；而且这些 profile 平时
   * 被采集任务用着，并发打开同一个 profile 会撞 SingletonLock。
   */
  async check(platforms: readonly MediaCrawlerPlatform[]): Promise<StatusSnapshot> {
    const busy = this.busy();
    if (busy.busy) {
      const who = busy.kind === "check" ? "正在探测登录状态" : `正在为 ${busy.platform} 扫码登录`;
      throw new Error(`${who}，请稍后再试`);
    }
    this.active = { kind: "check" };
    this.probing = true;
    this.snapshot = { ...this.snapshot, probing: true };

    const requested = platforms.length > 0 ? [...platforms] : [...MEDIA_CRAWLER_PLATFORMS];
    const xhsSpiderPlatforms = requested.filter((p) => p === "xhs" && this.useSpider(p));
    const dySpiderPlatforms = requested.filter((p) => p === "dy" && this.useSpider(p));
    const mcPlatforms = requested.filter((p) => !this.useSpider(p));
    const collected: PlatformStatus[] = [];
    const deadline = Date.now() + this.deps.checkTimeoutMs;

    const collectEvent = (ev: LoginEvent): void => {
      if (ev.event !== "status" || !ev.platform) return;
      const p = ev.platform as MediaCrawlerPlatform;
      collected.push({
        platform: p,
        name: ev.name ?? MEDIA_CRAWLER_PLATFORM_META[p]?.displayName ?? p,
        state: ev.state ?? "error",
        ...(ev.confidence ? { confidence: ev.confidence } : {}),
        ...(ev.detail ? { detail: ev.detail } : {}),
        ...(typeof ev.profileExists === "boolean" ? { profileExists: ev.profileExists } : {}),
        ...(Array.isArray(ev.cookiePresent) ? { cookiePresent: ev.cookiePresent } : {}),
      });
    };

    const awaitChild = (child: ChildProcess): Promise<void> =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.killChild();
          resolve();
        }, Math.max(1, deadline - Date.now()));
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });

    // 单个 spider 平台探活（xhs / dy 各用自己的 runner 与 session 文件，逐个跑）。
    const runSpiderPlatform = async (platform: MediaCrawlerPlatform): Promise<void> => {
      if (Date.now() >= deadline) return;
      const isDy = platform === "dy";
      const spider = isDy ? this.deps.spiderDy : this.deps.spiderXhs;
      if (!spider?.installed) {
        collected.push({
          platform,
          name: MEDIA_CRAWLER_PLATFORM_META[platform].displayName,
          state: "error",
          detail: isDy ? "DouYin_Spider 项目目录不完整，无法探测" : "Spider_XHS 项目目录不完整，无法探测",
        });
        return;
      }
      const child = this.spawnRunner(
        ["--op", "check", "--spider-dir", spider.dir, "--session-file", spider.sessionFile],
        null,
        collectEvent,
        this.spiderRuntime(platform),
      );
      await awaitChild(child);
    };

    // MC 平台批量探活（浏览器，串行）。
    const runMcBatch = async (batch: MediaCrawlerPlatform[]): Promise<void> => {
      if (batch.length === 0 || Date.now() >= deadline) return;
      const child = this.spawnRunner(
        [
          "--mode", "check",
          "--platforms", batch.join(","),
          "--browser-data", this.deps.browserDataDir,
          "--headless", this.deps.headless ? "true" : "false",
        ],
        null,
        collectEvent,
        undefined,
      );
      await awaitChild(child);
    };

    // 先跑纯 HTTP 的 spider 平台（xhs / dy，逐个），再跑浏览器平台（批量）；共用总超时预算。
    for (const p of xhsSpiderPlatforms) await runSpiderPlatform(p);
    for (const p of dySpiderPlatforms) await runSpiderPlatform(p);
    await runMcBatch(mcPlatforms);

    this.probing = false;
    this.active = null;
    this.snapshot = {
      checkedAt: new Date().toISOString(),
      probing: false,
      results: mergeStatuses(platforms, collected),
    };
    await this.saveSnapshot();
    return this.snapshot;
  }

  /** 关停（collector 退出时调用）：杀掉在跑的登录子进程 */
  shutdown(): void {
    this.killChild();
  }

  private killChild(): void {
    if (!this.child) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* 已经退出 */
    }
    this.child = null;
    if (this.active?.kind === "login") {
      const s = this.sessions.get(this.active.id);
      if (s && !TERMINAL.has(s.state)) {
        s.state = "failed";
        s.finishedAt = new Date().toISOString();
        s.message = s.message ?? "登录子进程被终止";
      }
    }
    this.active = null;
    this.probing = false;
    this.snapshot = { ...this.snapshot, probing: false };
  }

  private spawnRunner(
    args: string[],
    session: LoginSession | null,
    onEvent: (ev: LoginEvent) => void,
    runtime?: { pythonBin: string; scriptPath: string; cwd: string },
  ): ChildProcess {
    const log = session ? createWriteStream(session.logFile, { flags: "a" }) : null;
    const write = (chunk: string): void => {
      log?.write(chunk);
    };

    const pythonBin = runtime?.pythonBin ?? this.deps.pythonBin;
    const scriptPath = runtime?.scriptPath ?? this.deps.scriptPath;
    const cwd = runtime?.cwd ?? this.deps.coreDir;
    const child = spawn(pythonBin, [scriptPath, ...args], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    write(`$ ${pythonBin} ${scriptPath} ${args.join(" ")}\n(cwd=${cwd})\n\n`);

    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const ev = parseLoginEvent(line);
        if (ev) {
          write(`[event] ${line}\n`);
          onEvent(ev);
        } else if (line.trim()) {
          write(`${line}\n`);
        }
        idx = buf.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => write(chunk));

    child.on("error", (e) => {
      write(`\n[spawn error] ${e.message}\n`);
      onEvent({ event: "failed", error: `无法启动登录子进程：${e.message}` });
    });
    child.on("exit", (code) => {
      write(`\n[exit] code=${code}\n`);
      log?.end();
      if (session && !TERMINAL.has(session.state)) {
        // 进程退了却没给终态事件：按失败处理，别让前端无限转圈
        session.state = code === 0 ? "succeeded" : "failed";
        session.finishedAt = new Date().toISOString();
        session.message = session.message ?? `登录子进程退出（code=${code}）`;
      }
      if (this.active?.kind === "login" && session && this.active.id === session.id) this.active = null;
      if (this.child === child) this.child = null;
    });
    return child;
  }

  private applyLoginEvent(session: LoginSession, ev: LoginEvent): void {
    const now = Date.now();
    switch (ev.event) {
      case "qr": {
        if (!ev.dataUrl) return;
        session.qrDataUrl = ev.dataUrl;
        session.qrAt = new Date(now).toISOString();
        session.qrExpiresAt = new Date(now + (ev.expiresIn ?? this.deps.qrTtlSeconds) * 1000).toISOString();
        session.state = "waiting_scan";
        session.message = "二维码已就绪，请用手机 App 扫码";
        return;
      }
      case "already_logged_in": {
        session.state = "succeeded";
        session.finishedAt = new Date(now).toISOString();
        session.message = "该平台登录态仍然有效，无需扫码";
        session.qrDataUrl = undefined;
        // 探活刚判过 bound（Python 侧不再凭 cookie/localStorage 痕迹就发这个事件），
        // 比上一次全量探测新鲜，必须立刻反映到列表上
        this.markBound(session.platform, "探活确认登录态有效（扫码会话复用已有 profile）");
        return;
      }
      case "logged_in": {
        session.state = "succeeded";
        session.finishedAt = new Date(now).toISOString();
        session.message = this.useSpider(session.platform)
          ? "扫码成功，登录态已保存到 Spider_XHS 会话文件"
          : "扫码成功，登录态已写入 profile";
        session.qrDataUrl = undefined;
        // 平台侧刚完成授权 + marker cookie 已换发，这是最强证据
        this.markBound(
          session.platform,
          this.useSpider(session.platform) ? "已通过扫码授权，Spider_XHS 接口会话已保存" : "已通过扫码授权，登录态写入 profile",
        );
        return;
      }
      case "timeout": {
        session.state = "timeout";
        session.finishedAt = new Date(now).toISOString();
        session.message = `等待扫码超时（${ev.seconds ?? Math.round(this.deps.timeoutMs / 1000)}s）`;
        return;
      }
      case "failed": {
        session.state = "failed";
        session.finishedAt = new Date(now).toISOString();
        session.message = ev.error ?? "登录失败";
        return;
      }
      default:
        return;
    }
  }

  /** 登录会话确认成功后，把该平台就地标为已绑定并落盘 */
  private markBound(platform: MediaCrawlerPlatform, detail: string): void {
    this.snapshot = {
      ...this.snapshot,
      results: markPlatformBound(this.snapshot.results, platform, detail),
    };
    void this.saveSnapshot();
    // 登录态已刷新到磁盘 profile，但 `--cdp reuse` 模式下采集复用的是**常驻浏览器
    // 进程的内存态**（不会重新加载 profile）。旧常驻浏览器里还是扫码前的登录态，
    // 下一次采集连上去会误判未登录、重新弹扫码。所以这里主动回收该平台的常驻
    // 浏览器，让下次采集从磁盘 profile 冷启动、读到最新登录态。
    this.reapResidentBrowser(platform);
  }

  /** 登录态变更后，回收该平台可能残留的常驻采集浏览器（仅 reuse 模式下有意义）。 */
  private reapResidentBrowser(platform: MediaCrawlerPlatform): void {
    if (this.deps.cdpMode !== "reuse") return;
    const port = MEDIA_CRAWLER_PLATFORM_META[platform].cdpPort;
    const killed = reapBrowser(port, (m) => console.warn(m));
    if (killed > 0) {
      console.info(`[collector] 登录态已更新，回收 ${platform} 常驻浏览器（port ${port}）以加载新登录态`);
    }
  }

  /** 只保留最近 20 个会话，避免长跑进程无限增长 */
  private prune(): void {
    if (this.sessions.size <= 20) return;
    const sorted = [...this.sessions.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const s of sorted.slice(0, this.sessions.size - 20)) {
      if (TERMINAL.has(s.state)) this.sessions.delete(s.id);
    }
  }
}

/**
 * 把一个平台就地标成「已绑定」，不改动其它平台与数组顺序。
 *
 * 为什么需要它：`snapshot` 原来只在 `check()` 里更新，于是**扫码成功后列表仍然是上一次
 * 探测的旧结果** —— 弹层写着「登录态仍然有效 / 无需扫码」，卡片却显示「未绑定」、计数
 * 停在 0/7。扫码会话本身比任何探活都强（平台侧刚完成授权），必须立刻反映出来。
 *
 * 缺条目时追加而不是丢弃：`/login/status` 是按平台清单 `find` 的，少一条不会少卡片，
 * 但会让「最后检测时间」与卡片内容对不上，所以宁可补齐。
 */
export function markPlatformBound(
  results: readonly PlatformStatus[],
  platform: MediaCrawlerPlatform,
  detail: string,
): PlatformStatus[] {
  const name = MEDIA_CRAWLER_PLATFORM_META[platform]?.displayName ?? platform;
  const next: PlatformStatus = { platform, name, state: "bound", confidence: "verified", detail };
  const idx = results.findIndex((r) => r.platform === platform);
  if (idx < 0) return [...results, next];
  return results.map((r, i) => (i === idx ? next : r));
}

/**
 * 把探测结果补齐成"每个平台都有一行"。
 *
 * 子进程被杀 / 某平台直接崩掉时不会吐 status，缺口用 `error` 补上而不是**丢掉** ——
 * 否则前端会少一张卡片，用户以为那个平台不存在。
 */
export function mergeStatuses(
  platforms: readonly MediaCrawlerPlatform[],
  got: readonly PlatformStatus[],
): PlatformStatus[] {
  const want = platforms.length > 0 ? platforms : (Object.keys(MEDIA_CRAWLER_PLATFORM_META) as MediaCrawlerPlatform[]);
  const byPlatform = new Map(got.map((g) => [g.platform, g]));
  return want.map(
    (p) =>
      byPlatform.get(p) ?? {
        platform: p,
        name: MEDIA_CRAWLER_PLATFORM_META[p]?.displayName ?? p,
        state: "error",
        detail: "本次探测没有返回结果（超时或被中断）",
      },
  );
}

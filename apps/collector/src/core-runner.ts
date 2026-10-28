/**
 * 内嵌采集内核（`services/collector-core`）的**子进程驱动**。
 *
 * 为什么是子进程而不是 HTTP：早期版本驱动的是**独立部署的 MediaCrawler**，走它的
 * FastAPI 控制面（`POST /api/crawler/start` → 轮询 status → 直读它的 data/ 目录）。
 * 现在内核已经内嵌进本仓库，第二个部署单元没有了，那层 HTTP 也随之取消：
 * collector 用 `python services/collector-core/run.py ...` 起一个采集子进程，
 * 等它退出后读取落盘的 jsonl。
 *
 * 这样做的三个理由：
 *   1. **部署只有一个系统**：内核随 brandsale 一起发布，不必再单独运维一个
 *      MediaCrawler 进程与端口。
 *   2. **少一层协议**：子进程的退出码就是任务结果，不需要"起任务—查状态—判断忙"
 *      三跳，也不需要内核侧多开一个 HTTP 端口。
 *   3. **行为可追溯**：子进程的 stdout/stderr 全量落日志文件，扫码登录、风控、
 *      依赖缺失这些排查场景都有原始输出可看。
 *
 * 串行性依然保留（见 tasks.ts）：内核内部的浏览器会话一次只能跑一个采集，
 * 并发起两个子进程只会互相抢登录态。
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, type Dirent } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_CRAWLER_PLATFORM_META, type CollectOp, type MediaCrawlerPlatform } from "@brandsale/config";
import type { CdpMode, SpiderDyConfig, SpiderXhsConfig, XhsDriver, DyDriver } from "./config.ts";
import type { RowKind } from "./normalize.ts";

export interface CorePaths {
  /** 内核目录（`services/collector-core`） */
  coreDir: string;
  /** 内核 Python 解释器（绝对路径，或 PATH 上可执行的命令） */
  pythonBin: string;
  /** 内核入口脚本路径（`<coreDir>/run.py`） */
  runPy: string;
  /** 采集落盘根目录（作为内核的 `--save-path` 传入） */
  dataDir: string;
  /** 子进程日志目录 */
  logDir: string;
  /** 小红书后端；缺省为 mc，保证旧部署与测试的构造方式不变 */
  xhsDriver?: XhsDriver;
  spiderXhs?: SpiderXhsConfig;
  /** 抖音后端；缺省为 mc */
  dyDriver?: DyDriver;
  spiderDy?: SpiderDyConfig;
}

export interface CrawlRequest {
  platform: MediaCrawlerPlatform;
  op: CollectOp;
  params: Record<string, unknown>;
  /** 单次采集上限（条数） */
  maxItems: number;
  headless: boolean;
  /** 透传给内核 `--cdp` 的浏览器启动模式 */
  cdpMode: CdpMode;
  /**
   * 常驻复用模式（`cdpMode === "reuse"`）下要固定的调试端口，
   * 取自 `MEDIA_CRAWLER_PLATFORM_META[platform].cdpPort` —— 每个平台一个，不能共用。
   */
  cdpPort: number;
  /**
   * creator 模式**只取个人主页资料**（粉丝数 / 关注数等），不继续抓该作者的作品。
   * brandsale 补采作者资料时用（见 tasks.ts 的 profileEnrich）：作品早在关键词搜索
   * 阶段采过了，再抓一遍只是把一次秒级的资料采集拖成几分钟。
   */
  profileOnly?: boolean;
}

export interface CrawlOutcome {
  /** 子进程退出码；被信号杀死时为 null */
  code: number | null;
  /** 是否因超时被 collector 主动终止 */
  timedOut: boolean;
  /** 完整日志文件路径（stdout + stderr 合并） */
  logFile: string;
  durationMs: number;
}

export interface ReadResult {
  /** 本次任务期间写过的数据文件（相对平台目录，如 `jsonl/search_contents_2026-10-09.jsonl`） */
  files: string[];
  /** 按落盘文件类型分组的原始记录 */
  groups: ReadGroup[];
}

/** 一个落盘文件里装的是哪一类记录 */
export interface ReadGroup {
  /** 文件名里的 item_type 段（`contents` / `comments` / `creators`）；识别不出为 `unknown` */
  itemType: string;
  kind: RowKind;
  /** 相对平台目录的路径 */
  file: string;
  records: Record<string, unknown>[];
}

/**
 * 内核落盘文件名格式：`{crawler_type}_{item_type}_{date}.{ext}`
 * （见 `services/collector-core/tools/async_file_writer.py`）。
 */
const ITEM_TYPE_TO_KIND: Record<string, RowKind> = {
  contents: "content",
  comments: "comment",
  creators: "creator",
};

const itemTypeOf = (name: string): string => /_(contents|comments|creators)_/.exec(name)?.[1] ?? "";

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * 采集算子 → `run.py` 命令行参数。
 *
 * 四个算子与内核 `crawler_type` 的对应关系（已对各平台 `core.py` 核实）：
 *   search         → --type search  --keywords <kw>
 *   content_detail → --type detail  --specified-id <id|url>
 *   comments       → --type detail  --specified-id <id|url> --get-comments true（同一次采集带出评论）
 *   creator        → --type creator --creator-id <id|url>
 *
 * 这里刻意**只暴露四个固定算子**，不把任意 CLI 参数透传给内核：内核的能力面包含
 * 关键词搜索、ID 详情、创作者主页这几类只读操作，也有 `--get-media` 之类会落文件的开关。
 * 用白名单拼参数，模型就无法把采集变成别的东西。
 */
export function buildRunnerArgs(req: CrawlRequest, paths: CorePaths): string[] {
  const { platform, op, params, maxItems, headless, cdpMode, cdpPort, profileOnly } = req;
  const contentId = s(params.contentId ?? params.url);
  const creatorId = s(params.creatorId ?? params.creator);
  const keyword = s(params.keyword ?? params.query);

  const args = [paths.runPy, "--platform", platform, "--save-path", paths.dataDir];

  if (op === "search") {
    args.push("--type", "search", "--keywords", keyword);
  } else if (op === "content_detail") {
    args.push("--type", "detail", "--specified-id", contentId);
  } else if (op === "comments") {
    args.push(
      "--type",
      "detail",
      "--specified-id",
      contentId,
      "--get-comments",
      "true",
      "--get-sub-comments",
      params.subComments === true ? "true" : "false",
      "--max-comments",
      String(maxItems),
    );
  } else if (op === "creator") {
    args.push("--type", "creator", "--creator-id", creatorId);
    // 只要主页资料、不抓作品：一次资料采集从"分钟级"降到"秒级"（见 CrawlRequest.profileOnly）
    if (profileOnly) args.push("--profile-only", "true");
  } else {
    // 理论上到不了这里（server 层已校验），留一手防止将来加算子时漏配参数
    throw new Error(`未知算子：${op}`);
  }

  args.push("--max-notes", String(maxItems));
  // 本机扫码登录需要可见窗口，故默认 headless=false
  args.push("--headless", headless ? "true" : "false");
  // 浏览器启动模式交给内核自己判断：auto = 有本机 Chrome/Edge 就用它，省掉 chromium 下载。
  args.push("--cdp", cdpMode);
  // reuse 模式端口必须**固定下发**，不能让内核自己向上找空闲端口：
  //   · 内核靠它判断"这个端口上有没有可复用的常驻浏览器"；
  //   · collector 也靠同一个端口回收（见 browser-session.ts）。
  // 端口一漂移，就会复用错平台的登录态，且窗口再也回收不掉。
  if (cdpMode === "reuse") args.push("--cdp-port", String(cdpPort));
  // 媒体文件下载与词云在 brandsale 里没有用途，内核侧 run.py 已固定关闭，这里不传
  return args;
}

/**
 * Spider_XHS 的四个只读算子。与 MediaCrawler 一样使用白名单拼参，不透传任意 CLI。
 * 落盘目录与 session 文件由 collector 固定下发，调用方无法改写。
 */
export function buildSpiderRunnerArgs(req: CrawlRequest, paths: CorePaths): string[] {
  if (!paths.spiderXhs) throw new Error("BM_XHS_DRIVER=spider 但未配置 Spider_XHS");
  const spider = paths.spiderXhs;
  const { op, params, maxItems } = req;
  const args = [
    spider.runnerPy,
    "--spider-dir",
    spider.dir,
    "--session-file",
    spider.sessionFile,
    "--data-dir",
    paths.dataDir,
  ];
  if (op === "search") {
    args.push("--op", "search", "--keyword", s(params.keyword ?? params.query), "--max-items", String(maxItems));
  } else if (op === "content_detail") {
    args.push("--op", "content_detail", "--note-id", s(params.contentId ?? params.url));
  } else if (op === "comments") {
    args.push(
      "--op",
      "comments",
      "--note-id",
      s(params.contentId ?? params.url),
      "--max-comments",
      String(maxItems),
      "--sub-comments",
      params.subComments === true ? "true" : "false",
    );
  } else if (op === "creator") {
    args.push("--op", "creator", "--creator-ids", s(params.creatorId ?? params.creator));
  } else {
    throw new Error(`未知算子：${op}`);
  }
  return args;
}

/**
 * DouYin_Spider 的四个只读算子。与 MediaCrawler 一样使用白名单拼参，不透传任意 CLI。
 * 落盘目录与 session 文件由 collector 固定下发，调用方无法改写。
 */
export function buildSpiderDyRunnerArgs(req: CrawlRequest, paths: CorePaths): string[] {
  if (!paths.spiderDy) throw new Error("BM_DY_DRIVER=spider 但未配置 DouYin_Spider");
  const spider = paths.spiderDy;
  const { op, params, maxItems } = req;
  const args = [
    spider.runnerPy,
    "--spider-dir",
    spider.dir,
    "--session-file",
    spider.sessionFile,
    "--data-dir",
    paths.dataDir,
  ];
  if (op === "search") {
    args.push("--op", "search", "--keyword", s(params.keyword ?? params.query), "--max-items", String(maxItems));
  } else if (op === "content_detail") {
    args.push("--op", "content_detail", "--aweme-id", s(params.contentId ?? params.url));
  } else if (op === "comments") {
    args.push("--op", "comments", "--aweme-id", s(params.contentId ?? params.url), "--max-comments", String(maxItems));
  } else if (op === "creator") {
    args.push("--op", "creator", "--creator-ids", s(params.creatorId ?? params.creator));
  } else {
    throw new Error(`未知算子：${op}`);
  }
  return args;
}

/** 某次采集的日志文件路径（`<logDir>/<taskId>.log`）。运行前即可确定。 */
export const logFileFor = (paths: CorePaths, taskId: string): string => join(paths.logDir, `${taskId}.log`);

/**
 * 从内核日志里挑出**真正的报错行**（拿不到就 null）。
 *
 * 子进程非 0 退出时日志尾部是一坨 Python traceback，里面三类行都不能直接用：
 *   - `(file.py:12)` / `File "...", line 3` 只有位置没有原因；
 *   - `raise DataFetchError(...)` 只有异常类型没有消息；
 *   - `tenacity.RetryError: RetryError[...]` 只是重试包装，**不是根因**（真踩过：
 *     微博 creator 传了脱敏 hash，最终报 RetryError，根因其实藏在更上面一行的
 *     `DataFetchError: 这里还没有内容`）。
 * 所以要"从尾部往前找**第一个带消息的异常行**"并显式跳过 RetryError。
 */
export function lastKernelError(logFile: string): string | null {
  let lines: string[];
  try {
    if (!existsSync(logFile)) return null;
    // 内核日志带 ANSI 颜色码（尤其 pip/playwright 的输出），先剥掉再匹配
    lines = readFileSync(logFile, "utf8").replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  } catch {
    return null; // 报错信息本身不该再抛错
  }

  const msgs: string[] = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || /\bRetryError\b/.test(raw)) continue;
    if (raw.startsWith("File \"") || /^[\^~]+\s*$/.test(raw)) continue;
    const m = /^(?:\[collector-core\]\s*)?([A-Za-z_][\w.]*(?:Error|Exception))\s*:\s*(\S.*)$/.exec(raw);
    if (m) msgs.push(`${m[1]}: ${m[2]}`);
  }
  const cause = msgs.at(-1);
  if (cause) return cause.slice(0, 300);

  // 兜底：内核自己打的 `[collector-core] 采集失败：xxx`（没有异常类名的情况）
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /失败\s*[:：]\s*(\S.*)$/.exec(lines[i]!.trim());
    if (m && !/\bRetryError\b/.test(m[1]!)) return m[1]!.slice(0, 300);
  }
  return null;
}

/**
 * 起一次采集并等它结束。**不抛错**——把退出码/超时原样返回，由调用方决定怎么记状态。
 *
 * `PYTHONUNBUFFERED=1`：不设的话子进程 stdout 会按块缓冲，扫码登录这类交互场景
 * 在日志里会长时间看不到任何输出。
 */
export async function runCrawl(
  req: CrawlRequest,
  paths: CorePaths,
  taskId: string,
  opts: { timeoutMs: number; maskNickname?: boolean },
): Promise<CrawlOutcome> {
  await mkdir(paths.logDir, { recursive: true });
  const logFile = logFileFor(paths, taskId);
  const logStream = createWriteStream(logFile, { flags: "a" });

  const useSpiderXhs = req.platform === "xhs" && paths.xhsDriver === "spider";
  const useSpiderDy = req.platform === "dy" && paths.dyDriver === "spider";
  if (useSpiderXhs && !paths.spiderXhs?.installed) {
    logStream.end();
    throw new Error("已选择 Spider_XHS，但 services/spider-xhs 不完整；请检查 BM_SPIDER_XHS_DIR");
  }
  if (useSpiderDy && !paths.spiderDy?.installed) {
    logStream.end();
    throw new Error("已选择 DouYin_Spider，但 services/douyin-spider 不完整；请检查 BM_SPIDER_DY_DIR");
  }
  const args = useSpiderXhs
    ? buildSpiderRunnerArgs(req, paths)
    : useSpiderDy
      ? buildSpiderDyRunnerArgs(req, paths)
      : buildRunnerArgs(req, paths);
  const pythonBin = useSpiderXhs ? paths.spiderXhs!.pythonBin : useSpiderDy ? paths.spiderDy!.pythonBin : paths.pythonBin;
  const cwd = useSpiderXhs ? paths.spiderXhs!.dir : useSpiderDy ? paths.spiderDy!.dir : paths.coreDir;
  const startedAt = Date.now();

  const driverLabel = useSpiderXhs ? "spider-xhs" : useSpiderDy ? "spider-dy" : "mediacrawler";
  logStream.write(`$ ${pythonBin} ${args.join(" ")}\n(cwd=${cwd})\n(driver=${driverLabel})\n\n`);

  const child = spawn(pythonBin, args, {
    cwd,
    // BM_MC_MASK_NICKNAME 显式透传给内核：默认**空**（= 完整显示昵称，见 tools/user_hash.py）。
    // 之所以要显式传而不靠继承：`.env` 里的变量不会自动进 collector 进程的 process.env。
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      BM_MC_MASK_NICKNAME: opts.maskNickname ? "true" : "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    logStream.write(`\n[collector] 采集超过 ${Math.round(opts.timeoutMs / 1000)}s，终止子进程\n`);
    child.kill("SIGTERM");
    // 给内核 5 秒做优雅清理（关浏览器、落盘），否则强杀
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, opts.timeoutMs);

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (e) => {
      logStream.write(`\n[collector] 无法启动内核子进程：${e.message}\n`);
      resolve(null);
    });
    child.on("close", (c) => resolve(c));
  });

  clearTimeout(timer);
  logStream.end();
  return { code, timedOut, logFile, durationMs: Date.now() - startedAt };
}

/**
 * 内核自检：跑 `python run.py --help`。
 *
 * 为什么用 `--help` 而不是 `-c "import ..."`：`run.py` 的 import 区会拉齐
 * 七个平台的全部依赖（playwright / pyexecjs / cv2 / xhshow …），`--help` 能一次性
 * 把这些"缺哪个包"的问题暴露出来，而 argparse 拿到 `--help` 会直接退 0、不会真的采集。
 */
async function probeCommand(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { ok: boolean; detail: string }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done({ ok: false, detail: `无法启动${label}解释器：${e instanceof Error ? e.message : String(e)}` });
    }

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, detail: `${label}自检超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout?.on("data", (b: Buffer) => {
      out += String(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      err += String(b);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, detail: `无法启动${label}解释器：${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const first = out.split("\n").find((l) => l.trim()) ?? `${label}就绪`;
        done({ ok: true, detail: first.trim() });
      } else {
        const tail = (err || out).trim().split("\n").slice(-6).join(" ｜ ");
        done({ ok: false, detail: tail || `${label}退出码 ${code}` });
      }
    });
  });
}

export async function probeCore(paths: CorePaths, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  return probeCommand("内核", paths.pythonBin, [paths.runPy, "--help"], paths.coreDir, timeoutMs);
}

/** Spider_XHS 自检会真正 import 签名与登录依赖，并确认本机有可用 JS 运行时。 */
export async function probeSpiderXhs(spider: SpiderXhsConfig, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  if (!spider.installed) return { ok: false, detail: `Spider_XHS 目录不完整：${spider.dir}` };
  return probeCommand(
    "Spider_XHS",
    spider.pythonBin,
    [spider.runnerPy, "--op", "probe", "--spider-dir", spider.dir],
    spider.dir,
    timeoutMs,
  );
}

/** DouYin_Spider 自检会真正 import 签名与 curl_cffi 依赖。 */
export async function probeSpiderDy(spider: SpiderDyConfig, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  if (!spider.installed) return { ok: false, detail: `DouYin_Spider 目录不完整：${spider.dir}` };
  return probeCommand(
    "DouYin_Spider",
    spider.pythonBin,
    [spider.runnerPy, "--op", "probe", "--spider-dir", spider.dir],
    spider.dir,
    timeoutMs,
  );
}

/**
 * 递归收集落盘目录下的数据文件。
 *
 * ⚠️ 必须递归：内核按 `SAVE_DATA_OPTION` 再分一层子目录 ——
 * `jsonl` 写成 `<platform>/jsonl/*.jsonl`，`json` 写成 `<platform>/json/*.json`。
 * 早先这里只 `readdir` 平台目录顶层、按 `.jsonl` 后缀过滤，于是把 `jsonl/`
 * 这个**目录**当成不匹配的文件跳过了，结果是采集明明成功、collector 却报
 * "未读到任何归一化记录"。这是真数据跑通后才暴露的。
 */
async function collectDataFiles(root: string, depth = 3): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (depth > 0) out.push(...(await collectDataFiles(full, depth - 1)));
      continue;
    }
    if (e.name.endsWith(".jsonl") || e.name.endsWith(".json")) out.push(full);
  }
  return out;
}

/**
 * 采集开始前对平台落盘目录做一次快照：`绝对路径 → 该文件当前的行数`。
 *
 * 为什么需要它：内核的 jsonl 落盘文件是**按天**共享的
 * （`<platform>/jsonl/search_comments_2026-10-09.jsonl`）。同一天在这个平台上跑第二个
 * 任务时，文件已存在、又被追加内容 —— 若按"文件整体"读，就会把**当天全部旧行**重新吞一遍，
 * 并给它们打上当前算子的标签（贴吧实测：一次真采 3 条的 `comments` 任务报 `stored: 14`，
 * 多出来的 11 条是上一个 `content_detail` 任务写的）。行键含 `op`，所以同一条真实记录
 * 会在缓存里以不同 op 各存一份，按 kind 汇总时被重复计数。
 */
export type DataSnapshot = Map<string, number>;

/** 统一的行切分（快照与增量读取必须用同一套口径，否则行数对不上）。
 *  jsonl 每行以 `\n` 结尾，`split` 会多出一个空元素 —— 去掉它，让"行数"等于"记录数"。 */
const splitLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** 取平台落盘目录的当前快照（文件不存在时返回空 map）。 */
export async function snapshotDataFiles(
  dataDir: string,
  platform: MediaCrawlerPlatform,
): Promise<DataSnapshot> {
  const platformDir = join(dataDir, MEDIA_CRAWLER_PLATFORM_META[platform].dataDirName);
  const snap: DataSnapshot = new Map();
  for (const full of await collectDataFiles(platformDir)) {
    const text = await readFile(full, "utf8").catch(() => "");
    snap.set(full, splitLines(text).length);
  }
  return snap;
}

/**
 * 读取某平台本次采集**新增**的落盘数据，**按文件类型分组**。
 *
 * 为什么必须分组、不能混在一起：一次采集会同时写出多个文件 ——
 * `search` 既有 `search_contents_*.jsonl` 也有 `search_comments_*.jsonl`。
 * 早先实现把所有行拼成一个数组、用 `kindOf(op)` 统一推测类型，于是
 * **200 条评论被当成内容行归一化**：它们的 id 被取成所属笔记的 `note_id`，
 * 去重后塌缩成 1 条，评论查询恒为 0。类型只能由**文件**决定，不能由算子猜。
 *
 * `snapshot` 必须是**采集开始前**用 `snapshotDataFiles` 拍的快照：只取快照之后新增的行。
 * 不能改成"按 mtime 判断本文件本次有没有被写过"——按天共享的 jsonl 会被追加，
 * 那种做法会把当天旧行整份重读（见 `snapshotDataFiles` 的注释）。
 *
 * `fallbackKind`：文件名不符合命名规则时用的兜底类型（通常传 `kindOf(op)`）。
 */
export async function readRecordsSince(
  dataDir: string,
  platform: MediaCrawlerPlatform,
  snapshot: DataSnapshot,
  fallbackKind: RowKind,
): Promise<ReadResult> {
  const meta = MEDIA_CRAWLER_PLATFORM_META[platform];
  const platformDir = join(dataDir, meta.dataDirName);
  const found = await collectDataFiles(platformDir);

  const files: string[] = [];
  const groups = new Map<string, ReadGroup>();

  for (const full of found) {
    let text = await readFile(full, "utf8").catch(() => "");

    const before = snapshot.get(full);
    if (before !== undefined) {
      // 快照前就存在的文件：只取新增的行。
      if (!full.endsWith(".jsonl")) continue; // 整文件重写型（json 数组）无法算增量，跳过
      const lines = splitLines(text);
      if (lines.length === before) continue; // 本次没写这个文件
      // 行数变少说明文件被**重写**过（而非追加）——保守起见整读，宁可重复也别丢数据
      if (lines.length > before) text = lines.slice(before).join("\n");
    }

    if (!text.trim()) continue;

    const base = full.startsWith(platformDir) ? full.slice(platformDir.length + 1) : full;
    files.push(base);
    const itemType = itemTypeOf(base) || "unknown";
    const group = groups.get(itemType) ?? {
      itemType,
      kind: ITEM_TYPE_TO_KIND[itemType] ?? fallbackKind,
      file: base,
      records: [],
    };

    if (full.endsWith(".jsonl")) {
      for (const line of splitLines(text)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const parsed: unknown = JSON.parse(t);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) group.records.push(parsed as Record<string, unknown>);
        } catch {
          /* 长任务落盘时最后一行可能是半截，跳过即可 */
        }
      }
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const r of parsed) if (r && typeof r === "object" && !Array.isArray(r)) group.records.push(r as Record<string, unknown>);
        } else if (parsed && typeof parsed === "object") {
          group.records.push(parsed as Record<string, unknown>);
        }
      } catch {
        /* 同上 */
      }
    }
    groups.set(itemType, group);
  }

  return { files, groups: [...groups.values()].filter((g) => g.records.length > 0) };
}

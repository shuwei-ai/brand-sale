/**
 * collector sidecar 自己的配置。
 *
 * 与主程序共用同一份 `.env`（复用 @brandsale/config 的解析器），但读的是
 * **另一组变量**：collector 关心的是"内嵌采集内核在哪、用哪个 Python、数据落在哪"，
 * 主程序关心的是"collector 在哪"（`BM_MC_COLLECTOR_URL`）。两者刻意分开命名，
 * 避免"同一个变量在两边含义不同"这种最难排查的配置事故。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "@brandsale/config";

/**
 * 小红书采集后端选择。
 *
 * 背景（真机）：MediaCrawler 的小红书是 Playwright 浏览器自动化，出口 IP 被风控时
 * （error_code 300012）连登录二维码都拿不到；`services/spider-xhs`（Spider_XHS，
 * cv-cat）走纯 HTTP + 本地签名，登录与采集都不起浏览器。
 *
 *   mc     = MediaCrawler（默认，历史行为）
 *   spider = services/spider-xhs（只读公开内容；不启用蒲公英/千帆/私信/发布等能力）
 */
export type XhsDriver = "mc" | "spider";

export interface SpiderXhsConfig {
  /** Spider_XHS 项目目录（本地克隆，不进公开仓库） */
  dir: string;
  /** 它自己的 Python 解释器（独立 venv，与 MediaCrawler 的依赖面互不污染） */
  pythonBin: string;
  pythonSource: string;
  /** brandsale 自有的执行器脚本（apps/collector/py/spider_xhs_runner.py） */
  runnerPy: string;
  /** 登录会话落盘（a1+web_session 完整 cookie；.data-collector 已被 gitignore） */
  sessionFile: string;
  /** 目录是否存在（不存在时 /health 会报出来，显式选择 spider 的任务会明确失败） */
  installed: boolean;
}

/**
 * 抖音采集后端选择（与小红书同理）。
 *
 * 背景（真机）：MediaCrawler 的抖音搜索接口 `search_info_by_keyword` 已被抖音风控
 * 封死 —— 即使登录态真实有效，搜索恒返回空 `data`；`services/douyin-spider`
 * （DouYin_Spider，cv-cat）走纯 HTTP + 本地签名（curl_cffi + a_bogus/msToken），
 * 实测同一 sessionid 能正常出搜索/评论数据。
 *
 *   mc     = MediaCrawler（默认，历史行为）
 *   spider = services/douyin-spider（只读公开内容；不接发布/私信/直播等能力）
 */
export type DyDriver = "mc" | "spider";

export interface SpiderDyConfig {
  /** DouYin_Spider 项目目录（本地克隆，不进公开仓库） */
  dir: string;
  /** 它自己的 Python 解释器（独立 venv，与 MediaCrawler 的依赖面互不污染） */
  pythonBin: string;
  pythonSource: string;
  /** brandsale 自有的执行器脚本（apps/collector/py/spider_dy_runner.py） */
  runnerPy: string;
  /** 登录会话落盘（sessionid 等完整 cookie；.data-collector 已被 gitignore） */
  sessionFile: string;
  /** 目录是否存在（不存在时 /health 会报出来，显式选择 spider 的任务会明确失败） */
  installed: boolean;
}

export interface CollectorConfig {
  host: string;
  port: number;

  /** 内嵌采集内核目录（`services/collector-core`） */
  coreDir: string;
  /** 内核 Python 解释器的可执行路径 */
  pythonBin: string;
  /** 解释器从哪来的（排障用：BM_MC_PYTHON / coreDir/.venv / PATH） */
  pythonSource: string;
  /** 内核入口脚本 */
  runPy: string;
  /** 采集落盘根目录（传给内核 `--save-path`） */
  dataDir: string;
  /** 子进程日志目录 */
  logDir: string;
  /** 归一化结果的本地缓存目录 */
  storeDir: string;

  /** 小红书驱动；其余六平台始终走 MediaCrawler */
  xhsDriver: XhsDriver;
  spiderXhs: SpiderXhsConfig;

  /** 抖音驱动；其余六平台始终走 MediaCrawler */
  dyDriver: DyDriver;
  spiderDy: SpiderDyConfig;

  /** 采集时是否无头。本机扫码登录需要可见窗口，默认 false */
  headless: boolean;
  /**
   * 浏览器启动模式，透传给内核 `--cdp`：
   *   reuse = **常驻复用（默认）**：端口上有该平台的常驻浏览器就直接接上、没有才拉起，
   *           且退出时不关闭它，留给同平台的下一个任务。端口由
   *           `MEDIA_CRAWLER_PLATFORM_META[].cdpPort` 固定下发，collector 靠它回收。
   *   auto  = 本机有 Chrome/Edge 就用它（免下载 chromium），否则用 playwright 自带 chromium
   *   true  = 强制 CDP
   *   false = 强制 playwright 自带 chromium（需要先 `playwright install chromium`）
   *
   * 默认从上游的 `auto` 改成 `reuse`：collector 每个采集任务都是一个新子进程，
   * 而 `auto` 下每个子进程都会 launch 一次浏览器 —— 一次报告几十个任务就是几十次窗口闪烁。
   */
  cdpMode: CdpMode;
  defaultMaxItems: number;
  maxItemsCap: number;
  /** 单次采集的等待上限（毫秒）。采集是分钟级，默认给 10 分钟（首次含扫码） */
  crawlTimeoutMs: number;
  /** 内核自检超时（毫秒）。要 import 全部平台依赖，给得比一般请求宽 */
  envCheckTimeoutMs: number;
  /**
   * 是否让内核把账号昵称打码（`BM_MC_MASK_NICKNAME`）。
   * 默认 **false** = 完整显示账号昵称（业主明确要求报告里的人选/账号不要 `****`）；
   * 置 true 才退回上游的中间脱敏。该值会显式透传给内核子进程。
   */
  maskNickname: boolean;
  /**
   * 搜索完成后自动补采作者**个人主页资料**（粉丝数 / 关注数等）。
   *
   * 为什么默认开：平台的内容行里不带作者粉丝数（小红书只在个人主页的 `data-info`、
   * 抖音只在 `user/profile/other` 接口），报告人选页的"粉丝量"一列此前恒为"未采集"。
   * 补采是 `op=creator` + profile-only（只打一次主页接口，不抓作品），单次几秒。
   * `maxAuthors` 限制一次搜索最多补几位作者 —— 一次搜索几十个作者全补会把平台刷爆。
   * 默认值 2026-10-15 由 12 提到 **30**：实测一次搜索的作者数常到 25 上下（电脑品类
   * 抖音那批 25 位），而报告的人选页只认"采到了的" —— 12 位之后的作者粉丝量会永远
   * 停留在「未采集」。整批作者是**合成一个任务**跑的（见 tasks.ts:enqueueAuthorProfiles），
   * 所以提高上限并不成比例地加重平台侧登录校验。
   * 关掉：`BM_MC_PROFILE_ENRICH=false`。
   */
  profileEnrich: { enabled: boolean; maxAuthors: number };

  /* ── 服务端扫码登录（无头）───────────────────────────
   * 与采集共用同一份 profile（`<coreDir>/browser_data`），扫完码采集子进程直接复用。
   */
  /** profile 根目录。内核的 `browser_data`，两边必须一致，否则扫了也不生效 */
  browserDataDir: string;
  /** 登录执行器脚本（`apps/collector/py/login_runner.py`） */
  loginRunnerPy: string;
  /** 无头登录。服务端部署必须 true —— 有头模式需要 DISPLAY，无图形界面起不来 */
  loginHeadless: boolean;
  /** 单次扫码总等待（毫秒） */
  loginTimeoutMs: number;
  /** 二维码有效期（秒），决定前端倒计时与 Python 侧刷新节奏 */
  loginQrTtlSeconds: number;
  /** 七平台状态探测总超时（毫秒）。串行起浏览器，每个 3–8s */
  loginCheckTimeoutMs: number;
}

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : dflt;
};
const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v);
const str = (v: string | undefined, dflt = ""): string => (v === undefined ? dflt : v);
/**
 * 浏览器启动模式。`reuse` 是 brandsale 相对上游的**默认值变更**：上游每次采集都新开
 * 一个浏览器，而 collector 每个采集任务都是一个独立子进程，一次报告几十个任务
 * 就是几十次窗口闪烁。reuse 让同平台任务复用同一个常驻窗口（详见 browser-session.ts）。
 *
 * 显式写了 `auto` / `true` / `false` 就照旧尊重；写错或没写一律落到 `reuse`。
 */
export type CdpMode = "auto" | "true" | "false" | "reuse";

const cdpMode = (v: string | undefined): CdpMode => {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "true" || t === "false" || t === "auto" || t === "reuse") return t;
  return "reuse";
};

const xhsDriver = (v: string | undefined): XhsDriver =>
  (v ?? "").trim().toLowerCase() === "spider" ? "spider" : "mc";

const dyDriver = (v: string | undefined): DyDriver =>
  (v ?? "").trim().toLowerCase() === "spider" ? "spider" : "mc";

/**
 * 选定内核解释器。优先级：
 *   1. `BM_MC_PYTHON`（显式指定，排障或自定义环境时用）
 *   2. `<coreDir>/.venv/{bin,Scripts}/python`（`npm run collector:setup` 建的那个）
 *   3. PATH 上的 `python3`（兜底；若依赖没装，内核自检会明确报出来）
 */
function resolvePython(coreDir: string, configured: string): { bin: string; source: string } {
  if (configured) return { bin: configured, source: "BM_MC_PYTHON" };
  const candidates: [string, string][] = [
    [join(coreDir, ".venv", "bin", "python"), "coreDir/.venv"],
    [join(coreDir, ".venv", "Scripts", "python.exe"), "coreDir/.venv"],
  ];
  for (const [bin, source] of candidates) {
    if (existsSync(bin)) return { bin, source };
  }
  return { bin: "python3", source: "PATH" };
}

/** Spider_XHS 用独立 venv，避免与 MediaCrawler 的 Playwright 依赖面互相污染。 */
function resolveSpiderPython(spiderDir: string, configured: string): { bin: string; source: string } {
  if (configured) return { bin: configured, source: "BM_SPIDER_XHS_PYTHON" };
  const candidates: [string, string][] = [
    [join(spiderDir, ".venv", "bin", "python"), "spiderDir/.venv"],
    [join(spiderDir, ".venv", "Scripts", "python.exe"), "spiderDir/.venv"],
  ];
  for (const [bin, source] of candidates) {
    if (existsSync(bin)) return { bin, source };
  }
  return { bin: "python3", source: "PATH" };
}

export function loadCollectorConfig(cwd: string = process.cwd()): CollectorConfig {
  const fileVars = parseDotEnv(resolve(cwd, ".env"));
  // 真实环境变量优先于 .env（与主程序的优先级保持一致）
  const get = (k: string, fallback?: string): string | undefined => process.env[k] ?? fileVars[k] ?? fallback;

  // 内核默认就在本仓库内。找不到时也**不报错**——collector 仍可启动，
  // /health 会把 coreDir / pythonBin / 自检结果明确报出来，便于定位。
  const coreDir = resolve(cwd, str(get("BM_MC_CORE_DIR"), "services/collector-core"));
  const dataDir = resolve(cwd, str(get("BM_MC_DATA_DIR"), join(coreDir, "data")));
  const python = resolvePython(coreDir, str(get("BM_MC_PYTHON")));
  const spiderDir = resolve(cwd, str(get("BM_SPIDER_XHS_DIR"), "services/spider-xhs"));
  const spiderPython = resolveSpiderPython(spiderDir, str(get("BM_SPIDER_XHS_PYTHON")));
  const spiderDyDir = resolve(cwd, str(get("BM_SPIDER_DY_DIR"), "services/douyin-spider"));
  const spiderDyPython = resolveSpiderPython(spiderDyDir, str(get("BM_SPIDER_DY_PYTHON")));
  const storeDir = resolve(cwd, str(get("BM_COLLECTOR_DATA"), "./.data-collector"));

  return {
    host: str(get("BM_COLLECTOR_HOST"), "127.0.0.1"),
    port: num(get("BM_COLLECTOR_PORT"), 8890),

    coreDir,
    pythonBin: python.bin,
    pythonSource: python.source,
    runPy: join(coreDir, "run.py"),
    dataDir,
    logDir: resolve(cwd, str(get("BM_MC_LOG_DIR"), "./.data-collector/logs")),
    storeDir,

    xhsDriver: xhsDriver(get("BM_XHS_DRIVER")),
    spiderXhs: {
      dir: spiderDir,
      pythonBin: spiderPython.bin,
      pythonSource: spiderPython.source,
      runnerPy: fileURLToPath(new URL("../py/spider_xhs_runner.py", import.meta.url)),
      sessionFile: resolve(cwd, str(get("BM_SPIDER_XHS_SESSION"), join(storeDir, "spider-xhs-session.json"))),
      installed: existsSync(join(spiderDir, "apis", "xhs_pc_apis.py")),
    },

    dyDriver: dyDriver(get("BM_DY_DRIVER")),
    spiderDy: {
      dir: spiderDyDir,
      pythonBin: spiderDyPython.bin,
      pythonSource: spiderDyPython.source,
      runnerPy: fileURLToPath(new URL("../py/spider_dy_runner.py", import.meta.url)),
      sessionFile: resolve(cwd, str(get("BM_SPIDER_DY_SESSION"), join(storeDir, "spider-dy-session.json"))),
      installed: existsSync(join(spiderDyDir, "dy_apis", "douyin_api.py")),
    },

    headless: bool(get("BM_MC_HEADLESS"), false),
    cdpMode: cdpMode(get("BM_MC_CDP")),
    defaultMaxItems: num(get("BM_MC_MAX_ITEMS"), 50),
    maxItemsCap: num(get("BM_MC_MAX_ITEMS_CAP"), 200),
    crawlTimeoutMs: num(get("BM_MC_CRAWL_TIMEOUT_MS"), 600_000),
    envCheckTimeoutMs: num(get("BM_MC_ENV_CHECK_TIMEOUT_MS"), 60_000),

    maskNickname: bool(get("BM_MC_MASK_NICKNAME"), false),
    profileEnrich: {
      enabled: bool(get("BM_MC_PROFILE_ENRICH"), true),
      maxAuthors: num(get("BM_MC_PROFILE_ENRICH_MAX"), 30),
    },

    /* 登录执行器与本文件同仓：用 `import.meta.url` 定位，不依赖 cwd ——
     * systemd / 容器里 cwd 未必是仓库根，用相对 cwd 的路径会找不到脚本。 */
    browserDataDir: resolve(cwd, str(get("BM_MC_BROWSER_DATA"), join(coreDir, "browser_data"))),
    loginRunnerPy: fileURLToPath(new URL("../py/login_runner.py", import.meta.url)),
    loginHeadless: bool(get("BM_MC_LOGIN_HEADLESS"), true),
    loginTimeoutMs: num(get("BM_MC_LOGIN_TIMEOUT_MS"), 180_000),
    loginQrTtlSeconds: num(get("BM_MC_LOGIN_QR_TTL"), 120),
    loginCheckTimeoutMs: num(get("BM_MC_LOGIN_CHECK_TIMEOUT_MS"), 240_000),
  };
}

export const dataDirExists = (dir: string): boolean => existsSync(dir);

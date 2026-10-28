/**
 * collector sidecar 入口。
 *
 *   npm run collector            # 先跑一次 npm run collector:setup 准备内核环境
 *   BM_COLLECTOR_PORT=8890 npm run collector
 *
 * 它不依赖 brandsale 的任何运行时（不连库、不进闸门），只做三件事：
 *   驱动内嵌采集内核跑采集、把结果归一化、对 brandsale 暴露只读查询。
 * 这样"要不要接平台采集"这个决定被收在一个可独立启停的进程里 ——
 * 主程序即使不接它也能完整跑通（七个适配器缺席，报告如实写"无平台数据"）。
 *
 * ⚠️ 采集内核就在本仓库内（`services/collector-core`），不再是第二个部署单元。
 * 唯一的额外前置是那份 Python 环境（`npm run collector:setup` 一次搞定）。
 */

import { join } from "node:path";
import { MEDIA_CRAWLER_PLATFORM_META, MEDIA_CRAWLER_PLATFORMS } from "@brandsale/config";
import { reapBrowser } from "./browser-session.ts";
import { loadCollectorConfig, dataDirExists } from "./config.ts";
import { CollectStore } from "./store.ts";
import { LoginManager } from "./login-session.ts";
import { TaskManager } from "./tasks.ts";
import { createCollectorServer } from "./server.ts";

const config = loadCollectorConfig();
const store = new CollectStore(config.storeDir);
const tasks = new TaskManager({
  store,
  paths: {
    coreDir: config.coreDir,
    pythonBin: config.pythonBin,
    runPy: config.runPy,
    dataDir: config.dataDir,
    logDir: config.logDir,
    xhsDriver: config.xhsDriver,
    spiderXhs: config.spiderXhs,
    dyDriver: config.dyDriver,
    spiderDy: config.spiderDy,
  },
  headless: config.headless,
  cdpMode: config.cdpMode,
  defaultMaxItems: config.defaultMaxItems,
  maxItemsCap: config.maxItemsCap,
  crawlTimeoutMs: config.crawlTimeoutMs,
  maskNickname: config.maskNickname,
  profileEnrich: config.profileEnrich,
});

/* 服务端扫码登录（方案 A：无头 + 二维码下发）。与采集共用同一份 profile，
 * 所以这里只负责起会话；真正的浏览器操作在 apps/collector/py/login_runner.py。 */
const login = new LoginManager({
  coreDir: config.coreDir,
  pythonBin: config.pythonBin,
  scriptPath: config.loginRunnerPy,
  browserDataDir: config.browserDataDir,
  logDir: config.logDir,
  headless: config.loginHeadless,
  timeoutMs: config.loginTimeoutMs,
  qrTtlSeconds: config.loginQrTtlSeconds,
  checkTimeoutMs: config.loginCheckTimeoutMs,
  statusFile: join(config.storeDir, "login-status.json"),
  xhsDriver: config.xhsDriver,
  spiderXhs: config.spiderXhs,
  dyDriver: config.dyDriver,
  spiderDy: config.spiderDy,
  cdpMode: config.cdpMode,
});

const server = createCollectorServer({ config, store, tasks, login });

server.listen(config.port, config.host, () => {
  console.log(`[collector] 监听 http://${config.host}:${config.port}`);
  console.log(
    `[collector] 采集内核：${config.coreDir}${dataDirExists(config.coreDir) ? "" : "（不存在 —— 请确认仓库完整或设置 BM_MC_CORE_DIR）"}`,
  );
  console.log(`[collector] 解释器：${config.pythonBin}（来源 ${config.pythonSource}）`);
  console.log(
    `[collector] 小红书驱动：${config.xhsDriver}` +
      (config.xhsDriver === "spider"
        ? `（${config.spiderXhs.dir}；Python=${config.spiderXhs.pythonBin}；会话=${config.spiderXhs.sessionFile}）`
        : ""),
  );
  console.log(
    `[collector] 抖音驱动：${config.dyDriver}` +
      (config.dyDriver === "spider"
        ? `（${config.spiderDy.dir}；Python=${config.spiderDy.pythonBin}；会话=${config.spiderDy.sessionFile}）`
        : ""),
  );
  console.log(`[collector] 采集落盘：${config.dataDir}`);
  console.log(`[collector] 归一化缓存：${config.storeDir}`);
  console.log(`[collector] 子进程日志：${config.logDir}`);
  console.log(`[collector] 采集形态：headless=${config.headless}（false 时首次采集会弹浏览器窗口扫码登录）`);
  console.log(
    `[collector] 扫码登录：headless=${config.loginHeadless}（超时 ${Math.round(config.loginTimeoutMs / 1000)}s，` +
      `profile=${config.browserDataDir}）`,
  );
  console.log(
    `[collector] 浏览器：cdp=${config.cdpMode}` +
      (config.cdpMode === "auto" ? "（本机有 Chrome/Edge 就用它，否则用 playwright 自带 chromium）" : "") +
      (config.cdpMode === "reuse"
        ? "（常驻复用：同平台任务共用一个窗口，该平台无待跑任务时自动回收）"
        : ""),
  );
});

const shutdown = (): void => {
  console.log("[collector] 正在关闭…");
  login.shutdown();
  /* 常驻复用模式下浏览器**不随内核子进程退出而关闭**（这正是复用能成立的前提），
   * 所以这里得统一收尾，否则每关一次 collector 就留下一个孤儿 Chrome 窗口。
   * 按端口回收、且只在进程名确实是浏览器时才动手 —— 见 browser-session.ts。 */
  for (const p of MEDIA_CRAWLER_PLATFORMS) {
    reapBrowser(MEDIA_CRAWLER_PLATFORM_META[p].cdpPort, (m) => console.warn(m));
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

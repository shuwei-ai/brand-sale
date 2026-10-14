/**
 * 常驻采集浏览器的查找与回收。
 *
 * 背景：`--cdp reuse` 模式下浏览器是**平台级常驻资源** —— 同一平台的连续采集任务复用
 * 同一个窗口，只有该平台第一个任务会真正把它拉起来（内核 `tools/cdp_browser.py`
 * 的 `_connect_or_launch_persistent`）。好处是窗口不再随任务数闪烁；代价是**得有人负责收尾**，
 * 否则采集一停，那个窗口就一直挂在桌面上。
 *
 * 收尾为什么交给 collector 而不是内核：**"这个平台还有没有活"只有 collector 知道**。
 * 它手里才有 pending 队列和补采积压；内核子进程既看不到全局，也不该去管别人的窗口
 * （它跑完就退出了，而浏览器要活到下一个任务）。
 *
 * 身份识别用**端口**而不是交接 PID 文件：
 *   · 端口是 collector 自己下发的固定值（`MEDIA_CRAWLER_PLATFORM_META[].cdpPort`），
 *     不需要额外的文件交换，也就没有"文件过期 / PID 被复用"这类问题；
 *   · 但端口毕竟是我们挑的固定值，本机别的程序也可能占着 —— 所以杀之前还会用
 *     `ps -o comm=` 核一遍它确实是浏览器，核不过就只记一行日志、绝不动手。
 */

import { execFileSync } from "node:child_process";

/** 跑一条只读命令，失败一律返回 null（**不抛**：收尾是旁路能力，不该带崩采集链） */
function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * 监听指定端口的进程 PID 列表。
 *
 * 拿不到 `lsof`（精简容器里常见）或没有监听者时返回空数组 —— 即"不回收"。
 * 收不掉窗口只是体验问题，不是数据问题，所以这里刻意不抛错。
 */
export function listenersOnPort(port: number): number[] {
  const out = run("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (!out) return [];
  return out
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** 进程可执行名（`ps -o comm=`）；取不到返回空串 */
export const processName = (pid: number): string => run("ps", ["-p", String(pid), "-o", "comm="])?.trim() ?? "";

/** 什么样的进程名才允许被回收。macOS 是 `Google Chrome`，Linux 多为 `chromium`/`chrome` */
const BROWSER_COMM = /(google chrome|chromium|msedge|microsoft edge|chrome)/i;

/**
 * 回收指定端口上的常驻浏览器。返回**实际回收的进程数**。
 *
 * `0` 是正常的（该平台没跑过、或已经收过了），调用方不必据此判断故障。
 * 端口被非浏览器进程占用时**不杀**，只通过 `log` 说明 —— 宁可漏收一个窗口，
 * 也不能误杀用户本机正在跑的程序。
 */
export function reapBrowser(port: number, log: (msg: string) => void = console.info): number {
  const pids = listenersOnPort(port);
  if (pids.length === 0) return 0;

  let killed = 0;
  for (const pid of pids) {
    const name = processName(pid);
    if (!BROWSER_COMM.test(name)) {
      log(`[collector] 端口 ${port} 被非浏览器进程占用（pid ${pid} · ${name || "名称未知"}），不回收`);
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      killed += 1;
    } catch (e) {
      log(`[collector] 回收端口 ${port} 的浏览器（pid ${pid}）失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return killed;
}

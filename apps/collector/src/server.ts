/**
 * collector 的 HTTP 面。
 *
 * 路由刻意**只有只读查询与"提交采集"两类，没有任何写平台的操作**——
 * 公开采集类工具包普遍自带写命令（点赞/评论/关注/发帖），整包封装的最大风险就是
 * 模型可以合法地调用它们。这里从接口形状上就杜绝：collector 不做转发式代理，
 * 只暴露四个固定算子，写操作无从表达。
 *
 * 接口（brandsale 的适配器只用到 /query 与 /health）：
 *   GET  /health           探活：内核路径与解释器、落盘目录、缓存条数、是否忙、排队数
 *   GET  /platforms        七平台能力表（算子、内容/创作者称呼、台账源 ID）
 *   POST /collect          {platform, op, params, maxItems?} → 受理一次采集
 *                          （内核单会话串行：空闲则开跑，忙则入队；两者都返 202「已受理」）
 *   GET  /tasks            任务列表（含 state=queued 的排队任务）
 *   GET  /tasks/:id        单任务状态（含子进程日志路径）
 *   GET  /tasks/:id/log    该任务的子进程完整日志（尾部 20KB，排障用）
 *   POST /query            {platform, op?, kind?, keyword?, limit?, authorIds?} → 读本地缓存
 *   GET  /stats            各平台缓存条数
 *   GET  /env-check        内核自检（跑 run.py --help，验证依赖是否齐）
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { MEDIA_CRAWLER_PLATFORM_META, MEDIA_CRAWLER_PLATFORMS, type MediaCrawlerPlatform } from "@brandsale/config";
import type { CollectOp } from "@brandsale/config";
import type { CollectorConfig } from "./config.ts";
import { dataDirExists } from "./config.ts";
import { probeCore } from "./core-runner.ts";
import type { CollectStore } from "./store.ts";
import type { TaskManager } from "./tasks.ts";

export interface ServerDeps {
  config: CollectorConfig;
  store: CollectStore;
  tasks: TaskManager;
}

/** 缓存行里我们关心的最小形状：只做 authorId / id 的关联 */
interface AuthorKeyed {
  authorId?: string;
  id?: string;
}

/**
 * 从**全量**主页资料行里挑出本批要用的那些（纯函数，便于单测）。
 *
 * 两种模式，区别只在一件事：要不要"这位作者出现在本批 rows 里"这个前提。
 *   · 未点名（默认）—— 只取本批内容行的作者。适合工具调用那一刻的"随搜随附"。
 *   · 点名（`authorIds` 非空）—— 取名册里的人，**不要求**出现在本批 rows 里。
 *     2026-10-20 加它是因为默认模式有个盲区：rows 被 `limit` 截到前 N 条，
 *     而报告阶段要的是**整份任务**的人选，问到的多半不在前 N 条里。
 *     真机：5 位人选的资料行 06:45:09 已落库，report 阶段 06:45:37 才开始，
 *     却因为"不在本批前 20 条"而全部显示「未采集」。
 */
export function matchCreatorRows<T extends AuthorKeyed>(
  all: readonly T[],
  rows: readonly AuthorKeyed[],
  authorIds: readonly string[],
): T[] {
  if (authorIds.length > 0) {
    const want = new Set(authorIds);
    return all.filter((c) => {
      const key = c.authorId || c.id || "";
      return key !== "" && want.has(key);
    });
  }
  const batch = new Set(rows.map((r) => r.authorId || "").filter(Boolean));
  if (batch.size === 0) return [];
  return all.filter((c) => {
    const key = c.authorId || c.id || "";
    return key !== "" && batch.has(key);
  });
}

/**
 * 从缓存行的 `raw` 里取**平台原始 UID**（不是归一化哈希）。
 *
 * 顺序有讲究：`user_id` 最先 —— 抖音它是短数字 id（站内可搜），小红书是 24 位主页 id；
 * B站只在 `mid` 里；`sec_uid` 放最后（抖音的长串，能用但可读性最差）。
 * 取不到就返回空串：报告侧会退回主页链接，**不编一个**。
 */
function uidOf(row: unknown): string {
  const raw = (row as { raw?: unknown } | null)?.raw;
  if (!raw || typeof raw !== "object") return "";
  const r = raw as Record<string, unknown>;
  for (const k of ["user_id", "mid", "uid", "sec_uid"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
};

async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

const isPlatform = (v: unknown): v is MediaCrawlerPlatform =>
  typeof v === "string" && (MEDIA_CRAWLER_PLATFORMS as readonly string[]).includes(v);

const isOp = (v: unknown): v is CollectOp =>
  typeof v === "string" && ["search", "content_detail", "comments", "creator"].includes(v);

export function createCollectorServer(deps: ServerDeps) {
  const { config, store, tasks } = deps;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      try {
        if (req.method === "GET" && path === "/health") {
          const stats = await store.stats();
          const coreInstalled = dataDirExists(config.coreDir);
          return json(res, 200, {
            ok: true,
            service: "brandsale-collector",
            core: {
              dir: config.coreDir,
              installed: coreInstalled,
              runPy: config.runPy,
              python: config.pythonBin,
              pythonSource: config.pythonSource,
            },
            dataDir: { path: config.dataDir, exists: dataDirExists(config.dataDir) },
            logDir: config.logDir,
            browser: { cdpMode: config.cdpMode, headless: config.headless },
            store: { dir: config.storeDir, records: stats },
            busy: tasks.isBusy(),
            /** 排队等待内核空闲的采集数。内核单会话串行，忙时新请求入队而不是丢弃 */
            pending: tasks.pendingCount(),
            /** 队列满时没能排上的作者主页补采（不丢，内核空闲时自动接上） */
            profileBacklog: tasks.profileBacklogCount(),
            note: coreInstalled
              ? "采集由内嵌内核（services/collector-core）子进程执行；首次采集会在本机弹浏览器窗口，需扫码登录。" +
                (config.cdpMode === "reuse"
                  ? "浏览器为 reuse（常驻复用）：同一平台的连续任务共用一个窗口，不再每个任务都新开一次；" +
                    "该平台无待跑采集时由 collector 按端口回收（端口取自 MEDIA_CRAWLER_PLATFORM_META[].cdpPort）。"
                  : "") +
                (config.cdpMode === "auto"
                  ? "浏览器为 auto：本机有 Chrome/Edge 就直接驱动它（隔离 profile），无需下载 chromium；" +
                    "注意每个采集任务都会新开一个窗口。"
                  : "")
              : `找不到内嵌内核目录 ${config.coreDir}：请确认仓库完整，或用 BM_MC_CORE_DIR 指定路径。`,
          });
        }

        if (req.method === "GET" && path === "/platforms") {
          return json(res, 200, {
            platforms: MEDIA_CRAWLER_PLATFORMS.map((p) => ({ ...MEDIA_CRAWLER_PLATFORM_META[p] })),
          });
        }

        if (req.method === "POST" && path === "/collect") {
          const body = await readJsonBody(req);
          if (!isPlatform(body.platform)) return json(res, 400, { ok: false, error: `platform 必须是 ${MEDIA_CRAWLER_PLATFORMS.join("/")}` });
          if (!isOp(body.op)) return json(res, 400, { ok: false, error: "op 必须是 search/content_detail/comments/creator" });
          const meta = MEDIA_CRAWLER_PLATFORM_META[body.platform];
          if (!meta.ops.includes(body.op)) return json(res, 400, { ok: false, error: `${meta.displayName} 不支持算子 ${body.op}` });

          const params = (body.params as Record<string, unknown>) ?? {};
          if (body.op === "search" && !String(params.keyword ?? "").trim()) {
            return json(res, 400, { ok: false, error: "search 需要 params.keyword" });
          }
          if ((body.op === "content_detail" || body.op === "comments") && !String(params.contentId ?? params.url ?? "").trim()) {
            return json(res, 400, { ok: false, error: `${body.op} 需要 params.contentId（或 url）` });
          }
          if (body.op === "creator" && !String(params.creatorId ?? params.creator ?? "").trim()) {
            return json(res, 400, { ok: false, error: "creator 需要 params.creatorId" });
          }

          /* `params.creatorId` 允许**逗号分隔的 ID 列表** —— 内核原生支持
           * （`run.py --creator-id a,b,c` → `config.<PF>_CREATOR_ID_LIST`）。
           * 一次资料补采跑完整批作者，省掉"一人一次内核 + 一次浏览器启动"，
           * 也少惹平台侧的登录校验（见 tasks.ts:enqueueAuthorProfiles）。
           *
           * `profileOnly` 由调用方显式指定：只要主页公开统计（粉丝数等）、
           * 不抓该作者的作品。自动派生出来的补采任务一直走这条路，
           * 这里把它开放给手工调用，便于"补一个账号的资料"而不惊动它的全部作品。 */
          const out = tasks.submit(body.platform, body.op, params, typeof body.maxItems === "number" ? body.maxItems : undefined, {
            profileOnly: body.profileOnly === true,
          });
          if (!out.ok) return json(res, 409, { ok: false, error: out.reason });
          // 202 = 已受理。忙时是入队（state=queued），不是拒绝 —— 调用方只需知道"稍后有数据"
          return json(res, 202, { ok: true, reused: out.reused ?? false, queued: out.task.state === "queued", task: out.task });
        }

        if (req.method === "GET" && path === "/tasks") {
          return json(res, 200, { tasks: tasks.list() });
        }

        // 注意顺序：/tasks/:id/log 必须排在 /tasks/:id 之前，否则 id 会被解析成 "xxx/log"
        if (req.method === "GET" && path.startsWith("/tasks/") && path.endsWith("/log")) {
          const id = path.slice("/tasks/".length, -"/log".length);
          const task = tasks.get(id);
          if (!task) return json(res, 404, { ok: false, error: `任务不存在：${id}` });
          if (!task.logFile) return json(res, 404, { ok: false, error: "该任务还没有生成日志文件" });
          const text = await readFile(task.logFile, "utf8").catch(() => "");
          if (!text) {
            // 采集刚受理、子进程还没写出第一行时走到这里，属正常等待态
            return json(res, 202, {
              ok: true,
              pending: true,
              state: task.state,
              detail: `子进程还没写出日志（任务 ${task.state}）。日志文件：${task.logFile}`,
            });
          }
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          // 只回尾部 20KB：扫码登录 + 采集的完整日志可能很长，排障看尾部就够了
          res.end(text.length > 20_000 ? `…（仅显示末尾 20KB）\n${text.slice(-20_000)}` : text);
          return;
        }

        if (req.method === "GET" && path.startsWith("/tasks/")) {
          const id = path.slice("/tasks/".length);
          const task = tasks.get(id);
          if (!task) return json(res, 404, { ok: false, error: `任务不存在：${id}` });
          return json(res, 200, { task });
        }

        if (req.method === "POST" && path === "/query") {
          const body = await readJsonBody(req);
          if (!isPlatform(body.platform)) return json(res, 400, { ok: false, error: `platform 必须是 ${MEDIA_CRAWLER_PLATFORMS.join("/")}` });
          const op = isOp(body.op) ? body.op : undefined;
          const kind = typeof body.kind === "string" ? (body.kind as "content" | "comment" | "creator") : undefined;
          const keyword = typeof body.keyword === "string" ? body.keyword : undefined;
          const limit = typeof body.limit === "number" ? body.limit : undefined;
          const out = await store.query(body.platform, { op, kind, keyword, limit });
          /* 附带**这些人物的个人主页资料行**（粉丝数 / 关注数 / 主页链接）。
           *
           * 为什么在这层拼：内容行里没有粉丝数 —— 小红书只在个人主页的 `data-info`、
           * 抖音只在 `user/profile/other` 接口。资料行由搜索完成后的自动补采写进缓存
           * （见 tasks.ts:enqueueAuthorProfiles），这里按 `authorId`（= 内核的
           * creator_hash，内容行与资料行都带）把它们接到本批内容上。
           * 拼不上（该作者还没补采 / 补采失败 / 平台不给）就不出现 —— 绝不填 0 冒充。
           *
           * `authorIds` 是**点名要**（2026-10-20 新增）：默认行为「只拼本批 rows 的作者」
           * 有个致命盲区 —— rows 被 `limit` 截到前 N 条，而报告阶段是拿**整份任务**的
           * 人选来要数据的，问到的多半不在前 N 条里。真机：5 位人选的资料行 06:45:09 落库，
           * report 阶段 06:45:37 才开始，比数据晚 9 秒仍是「未采集」。
           * 传了 authorIds 就按名册取，不再要求该账号出现在本批 rows 里。 */
          const authorIds = Array.isArray(body.authorIds)
            ? (body.authorIds as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean)
            : [];
          const creators =
            op === "search"
              ? matchCreatorRows(
                  (await store.query(body.platform, { op: "creator", kind: "creator" })).rows,
                  out.rows,
                  authorIds,
                ).map((c) => ({ ...c, ...(uidOf(c) ? { uid: uidOf(c) } : {}), rowType: "creator" }))
              : [];
          return json(res, 200, {
            platform: body.platform,
            rows: out.rows,
            ...(creators.length > 0 ? { creators } : {}),
            meta: {
              total: out.total,
              returned: out.rows.length,
              creatorCount: creators.length,
              collectedAt: out.collectedAt,
              sourceId: MEDIA_CRAWLER_PLATFORM_META[body.platform].sourceId,
            },
          });
        }

        if (req.method === "GET" && path === "/stats") {
          return json(res, 200, { records: await store.stats() });
        }

        if (req.method === "GET" && path === "/env-check") {
          const out = await probeCore(
            { coreDir: config.coreDir, pythonBin: config.pythonBin, runPy: config.runPy, dataDir: config.dataDir, logDir: config.logDir },
            config.envCheckTimeoutMs,
          );
          return json(res, out.ok ? 200 : 503, { ok: out.ok, detail: out.detail });
        }

        return json(res, 404, { ok: false, error: `未知路由 ${req.method} ${path}` });
      } catch (e) {
        return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

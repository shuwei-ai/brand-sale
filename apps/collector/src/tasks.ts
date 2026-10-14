/**
 * 采集任务管理。
 *
 * ⚠️ 一个硬事实决定了这里的形状：**采集内核一次只能跑一个采集**。
 * 它内部是一个浏览器会话加一份登录态，并发起两个子进程只会互相抢 Cookie、
 * 一起撞平台风控。所以 collector 侧必须**串行**执行。
 *
 * 但"串行"不等于"忙就拒"。原来忙时直接返 409 让调用方丢弃请求，代价在实际链路上
 * 暴露得很彻底：brandsale 的聚合工具一次要扇出**七个平台**（brief 声明的排前面），
 * 而侧车只接受第一个，其余六个 409 被丢掉且**不会重排队** —— 实测一个 brief 里
 * 明写 douyin 的任务，最后只采到了小红书，抖音从头到尾没采过。
 *
 * 现在的形态：忙时**入队**（FIFO、同参数去重、队列有上限），闲下来按序执行。
 * 之所以敢排队，是因为调用方是"只投递、不等待"的（`/collect` 立即返 202，
 * brandscale 侧的 HTTP 调用超时是 8 秒，不会跟着采集一起等）—— 队列排的是
 * 后台采集，不是让请求挂住。上限存在的意义是防止被反复投递撑爆本机浏览器会话。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_CRAWLER_PLATFORM_META, type CollectOp, type MediaCrawlerPlatform } from "@brandsale/config";
import { reapBrowser } from "./browser-session.ts";
import type { CdpMode } from "./config.ts";
import { kindOf, normalizeBatch, type CollectRow } from "./normalize.ts";
import { lastKernelError, logFileFor, readRecordsSince, runCrawl, snapshotDataFiles, type CorePaths } from "./core-runner.ts";
import type { CollectStore } from "./store.ts";

export type TaskState = "queued" | "running" | "done" | "error";

/**
 * 等待执行的采集上限。七个平台一轮扇出 = 7 个，留出余量给"重试 + 补充查询"。
 * 超上限才拒（并明确告知），拒绝是最后手段：**宁可排长队，也不静默丢平台**。
 */
const MAX_PENDING = 12;

/**
 * 「补采积压」上限。队列满时被拒的作者主页补采不丢，挪到这里等队列腾出位置
 * （见 `enqueueAuthorProfiles` / `flushProfileBacklog`）。有上限是为了仍然守得住
 * "不被反复投递撑爆本机浏览器会话"这条底线：最坏情况是排队 12 + 积压 64。
 */
const MAX_PROFILE_BACKLOG = 64;

export interface CollectTask {
  id: string;
  platform: MediaCrawlerPlatform;
  op: CollectOp;
  params: Record<string, unknown>;
  state: TaskState;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 归一化后落缓存的条数 */
  stored?: number;
  /** 本次任务读取到的内核数据文件名 */
  files?: string[];
  /** 子进程完整日志（stdout + stderr 合并）路径，排查扫码/风控问题用 */
  logFile?: string;
  /** 子进程退出码；被信号杀死为 null */
  exitCode?: number | null;
  error?: string;
  /** creator 模式只取个人主页资料、不抓该作者的作品（见 inner-core config:PROFILE_ONLY） */
  profileOnly?: boolean;
  /** 这条任务是由哪次采集自动派生出来的（作者主页补采），便于回看链路 */
  derivedFrom?: string;
}

export interface RunnerDeps {
  store: CollectStore;
  /** 内嵌采集内核的路径信息 */
  paths: CorePaths;
  headless: boolean;
  /** 浏览器启动模式，透传给内核 `--cdp`（默认 `reuse`，见 config.ts 的 `CdpMode`） */
  cdpMode: CdpMode;
  defaultMaxItems: number;
  maxItemsCap: number;
  /** 单次采集的等待上限（毫秒）。采集是分钟级，首次含扫码，默认给 10 分钟 */
  crawlTimeoutMs: number;
  /** 是否让内核把账号昵称打码（默认 false = 完整显示，透传为 `BM_MC_MASK_NICKNAME`） */
  maskNickname: boolean;
  /**
   * 搜索完成后**自动补采作者个人主页资料**（粉丝数 / 关注数等主页公开统计）。
   *
   * 为什么要自动补：平台的内容行（搜索结果）里**不带**作者粉丝数 ——
   * 小红书只在 `/user/profile/<id>` 的 `data-info` 里、抖音只在
   * `/aweme/v1/web/user/profile/other/` 里。报告人选页的"粉丝量"一列此前因此
   * 恒为"未采集"，业主明确要求"报告里要有实际的数据"。补采只打一次主页接口、
   * 不抓该作者的作品（`profileOnly`），单次几秒。
   */
  profileEnrich: { enabled: boolean; maxAuthors: number };
}

/** 同参数（平台 + 算子 + 入参）—— 与状态无关：跑着的、排队的都算"这次采集已经有了" */
const sameParams = (t: CollectTask, platform: string, op: string, params: Record<string, unknown>): boolean =>
  t.platform === platform && t.op === op && JSON.stringify(t.params) === JSON.stringify(params);

let seq = 0;
const nextId = (): string => `ct_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export class TaskManager {
  private readonly tasks = new Map<string, CollectTask>();
  private active: string | null = null;
  /** 等待执行的 id（FIFO）。内核单会话，正在跑的只有一个，其余排这里 */
  private readonly pending: string[] = [];
  /** 每个任务受理时的 maxItems：排队任务真正开跑时要用当初那个值 */
  private readonly maxItemsOf = new Map<string, number>();
  /**
   * 因为**队列满**而没排上的作者主页补采。等队列腾出位置自动接上。
   *
   * 为什么不能丢：一次搜索派生 N 个补采，而队列可能在别的搜索/详情任务后面塞满 ——
   * 实测 4 个作者只排上 1 个（`派生 1/4`），另外 3 个的粉丝数就此永远采不到，
   * 而报告的人选表只认"采到了的"。补采任务本身很轻（一次主页接口，`profileOnly`），
   * 攒着等比"丢掉再等下一次搜索重新派生"可靠得多。
   */
  private readonly profileBacklog: { platform: MediaCrawlerPlatform; creatorId: string; derivedFrom: string }[] = [];
  /** 积压去重键：同一平台的同一作者只积压一次（多次搜索会反复派生同一个人） */
  private readonly backlogKeys = new Set<string>();

  constructor(private readonly deps: RunnerDeps) {}

  list(): CollectTask[] {
    return [...this.tasks.values()].sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1));
  }

  get(id: string): CollectTask | undefined {
    return this.tasks.get(id);
  }

  /** 当前是否有采集在跑（内核单会话，最多一个） */
  isBusy(): boolean {
    return this.active !== null;
  }

  /** 还在等内核空闲的任务数（不含正在跑的那个），供 /health 观察积压 */
  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * 因队列满而暂时没排上的作者主页补采数。单独报而不是并进 `pending`：
   * 它不占队列位置、随时会被 drain 接上，混在一起就分不清"真排队"与"等腾位"。
   */
  profileBacklogCount(): number {
    return this.profileBacklog.length;
  }

  /**
   * 提交一次采集。返回三种结果之一：
   *   · `{ ok: true, task }` —— 任务已受理（立即开跑，或入队等待）
   *   · `{ ok: true, task, reused: true }` —— 同参数任务已在跑/已在排队，直接复用
   *   · `{ ok: false, reason }` —— 队列已满（唯一会拒的情况）
   *
   * 注意受理 ≠ 开跑：`task.state` 在忙时是 `queued`，HTTP 侧统一返 202（已受理）。
   * 调用方（brandscale 适配器）只看 202，不看状态 —— "排队中"对它就是"稍后有数据"。
   */
  submit(
    platform: MediaCrawlerPlatform,
    op: CollectOp,
    params: Record<string, unknown>,
    maxItemsOverride?: number,
    opts: { profileOnly?: boolean; derivedFrom?: string } = {},
  ): { ok: true; task: CollectTask; reused?: boolean; queued?: boolean } | { ok: false; reason: string } {
    const running = this.active ? this.tasks.get(this.active) : undefined;
    if (running && sameParams(running, platform, op, params)) return { ok: true, task: running, reused: true };
    const waiting = this.pending.map((id) => this.tasks.get(id)).find((t) => t && sameParams(t, platform, op, params));
    if (waiting) return { ok: true, task: waiting, reused: true };

    if (this.pending.length >= MAX_PENDING) {
      return {
        ok: false,
        reason: `采集队列已满（${MAX_PENDING} 个待跑：${this.pending
          .map((id) => this.tasks.get(id)?.platform ?? "?")
          .join("/")}）。内核一次只能跑一个采集，请等队列消化后再提交。`,
      };
    }

    const maxItems = Math.min(maxItemsOverride ?? this.deps.defaultMaxItems, this.deps.maxItemsCap);
    const task: CollectTask = {
      id: nextId(),
      platform,
      op,
      params,
      state: this.active ? "queued" : "running",
      queuedAt: new Date().toISOString(),
      ...(opts.profileOnly ? { profileOnly: true } : {}),
      ...(opts.derivedFrom ? { derivedFrom: opts.derivedFrom } : {}),
    };
    // 日志路径在起子进程之前就能确定。提前记到任务上，`/tasks/:id/log` 在**采集进行中**
    // 就能看 —— 首次采集要等用户扫码，是分钟级的等待，那段时间看不到日志会让人以为卡死。
    task.logFile = logFileFor(this.deps.paths, task.id);
    this.tasks.set(task.id, task);
    this.maxItemsOf.set(task.id, maxItems);

    if (this.active) {
      this.pending.push(task.id);
      return { ok: true, task, queued: true };
    }
    this.active = task.id;
    void this.run(task, maxItems);
    return { ok: true, task };
  }

  /** 内核空出来了：按 FIFO 取下一个排队任务开跑 */
  private drain(): void {
    this.flushProfileBacklog();
    // 补采积压里若成功开跑了一个，`active` 已被占；此刻再取排队任务就会两个采集同时跑，
    // 撞同一份登录态。所以这里必须先让路，交给那个任务的 finally 继续 drain。
    if (this.active !== null) return;
    for (;;) {
      const nextId = this.pending.shift();
      if (nextId === undefined) return;
      const task = this.tasks.get(nextId);
      if (!task) continue; // 任务被清掉过，跳过而不是卡住整条队列
      this.active = task.id;
      void this.run(task, this.maxItemsOf.get(task.id) ?? this.deps.defaultMaxItems);
      return;
    }
  }

  /**
   * 把因队列满而积压的作者主页补采重新投进队列。
   *
   * 放在 `drain()` 最前面：内核刚空出来那一刻队列最短，是唯一能塞进去的时机。
   * 若此刻队列仍然满（`submit` 再拒一次），原样放回、不丢，等下一次 drain。
   */
  private flushProfileBacklog(): void {
    while (this.profileBacklog.length > 0 && this.pending.length < MAX_PENDING && this.active === null) {
      const item = this.profileBacklog.shift()!;
      this.backlogKeys.delete(`${item.platform}|${item.creatorId}`);
      const out = this.submit(item.platform, "creator", { creatorId: item.creatorId }, 1, {
        profileOnly: true,
        derivedFrom: item.derivedFrom,
      });
      if (!out.ok) {
        // 又被拒（队列仍是满的 / 参数去重之外的拒绝）：放回队首，不能丢
        this.profileBacklog.unshift(item);
        this.backlogKeys.add(`${item.platform}|${item.creatorId}`);
        return;
      }
      if (this.active !== null) return; // 已直接开跑，让路
    }
  }

  /**
   * 搜索采集结束后，为**这批内容里出现过的作者**补采个人主页资料。
   *
   * 只认 `raw.author_user_id` —— 内核写内容行时专门留的平台原始标识
   * （小红书 user_id / 抖音 sec_uid / B站 mid / 微博 uid …）。
   * 归一化后的 `authorId` 是脱敏哈希，喂回内核必然失败，不能用。
   * 没有这个字段的平台（贴吧 / 知乎，内容模型里只存了哈希）自动跳过，不报错。
   *
   * 三处刻意的收敛：
   *   · **只认 search**：详情/评论/creator 自己不会再派生任务，避免无限膨胀；
   * 三处刻意的收敛：
   *   · **只认 search**：详情/评论/creator 自己不会再派生任务，避免无限膨胀；
   *   · **上限 maxAuthors**：一次搜索可能几十个作者，全补会把这个平台刷爆，
   *     取前 N 个（按内容出现顺序，通常就是本批结果的主要作者）；
   *   · **失败静默**：未登录导致补采失败只是日志，不影响已经落库的内容。
   *     但"队列满"不算失败 —— 那一条会进 `profileBacklog`，等队列腾出位置再接上。
   *
   * ⚠️ 整批**合成一个任务**（`--creator-id a,b,c`），不是一人一个任务。
   * 真机试出来的：一人一个任务时，每个任务都要重新起一次内核、重新开浏览器、
   * 重新校一次登录态；4 个作者连跑会明显加重平台侧登录校验，实测出现
   * `Login state result: False` 卡在扫码等待 120s。内核本来就支持 ID 列表，
   * 一批一次跑既省时间也少惹风控。
   */
  private enqueueAuthorProfiles(task: CollectTask, rows: readonly CollectRow[]): void {
    const cfg = this.deps.profileEnrich;
    if (task.op !== "search" || !cfg.enabled || task.profileOnly) return;

    const seen = new Set<string>();
    const ids: string[] = [];
    for (const r of rows) {
      if (r.kind !== "content") continue;
      const raw = r.raw as { author_user_id?: unknown } | undefined;
      const id = typeof raw?.author_user_id === "string" ? raw.author_user_id.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= cfg.maxAuthors) break;
    }
    if (ids.length === 0) return;

    const creatorId = ids.join(",");
    const out = this.submit(task.platform, "creator", { creatorId }, 1, {
      profileOnly: true,
      derivedFrom: task.id,
    });
    if (out.ok) {
      console.info(
        `[collector] ${task.platform} 搜索完成，派生 1 个作者主页补采任务（profile-only，含 ${ids.length} 位作者：${ids
          .map((i) => i.slice(0, 10))
          .join("/")}）`,
      );
      return;
    }
    // 队列满：不丢，整批进积压等 drain 接上（见 profileBacklog 注释）
    const deferred = this.pushProfileBacklog(task.platform, creatorId, task.id);
    console.info(
      `[collector] ${task.platform} 搜索完成，作者主页补采${deferred ? "入积压" : "被丢弃（积压已满）"}：` +
        `${ids.length} 位作者（队列满，等腾位）`,
    );
  }

  /** 积压一条作者主页补采；已在积压里 / 积压已满则返回 false */
  private pushProfileBacklog(platform: MediaCrawlerPlatform, creatorId: string, derivedFrom: string): boolean {
    const key = `${platform}|${creatorId}`;
    if (this.backlogKeys.has(key)) return false;
    if (this.profileBacklog.length >= MAX_PROFILE_BACKLOG) {
      console.warn(`[collector] 补采积压已满（${MAX_PROFILE_BACKLOG}），丢弃 ${platform} 作者 ${creatorId}`);
      return false;
    }
    this.backlogKeys.add(key);
    this.profileBacklog.push({ platform, creatorId, derivedFrom });
    return true;
  }

  private async run(task: CollectTask, maxItems: number): Promise<void> {
    const d = this.deps;
    try {
      task.state = "running";
      task.startedAt = new Date().toISOString();
      // 采集前给平台落盘目录拍快照。内核的 jsonl 文件是**按天共享**的
      // （`<platform>/jsonl/search_comments_2026-10-09.jsonl`），同一天在该平台跑第二个任务时
      // 文件已存在、只是被追加 —— 按"文件整体"读会把当天旧行重新吞一遍，还打上当前算子的标签
      // （贴吧实测：真采 3 条的 comments 任务报 stored: 14，多出的 11 条来自上一个
      // content_detail 任务）。快照后只取新增行。
      const snapshot = await snapshotDataFiles(d.paths.dataDir, task.platform);

      const outcome = await runCrawl(
        {
          platform: task.platform,
          op: task.op,
          params: task.params,
          maxItems,
          headless: d.headless,
          cdpMode: d.cdpMode,
          // 端口按平台固定下发：内核靠它复用常驻浏览器，collector 靠它回收（见 browser-session.ts）
          cdpPort: MEDIA_CRAWLER_PLATFORM_META[task.platform].cdpPort,
          ...(task.profileOnly ? { profileOnly: true } : {}),
        },
        d.paths,
        task.id,
        { timeoutMs: d.crawlTimeoutMs, maskNickname: d.maskNickname },
      );
      task.logFile = outcome.logFile;
      task.exitCode = outcome.code;

      if (outcome.timedOut) {
        throw new Error(
          `采集超时（${Math.round(d.crawlTimeoutMs / 1000)}s），子进程已终止。日志：${outcome.logFile}`,
        );
      }
      if (outcome.code !== 0) {
        // 别只报"退出码 1 + 猜原因"：内核日志里通常有一行写明根因，带出来，
        // 否则每次都要人去翻日志尾部那坨 traceback。
        const cause = lastKernelError(outcome.logFile);
        const hints = [
          "未登录或登录态失效（首次需在浏览器窗口扫码）",
          "平台风控",
          "内核依赖缺失",
        ];
        // creator 的入参是平台**原始 UID**，而归一化输出里的 authorId 是脱敏 hash
        // （上游教学版刻意不采集原始 user_id）——喂进去必然 DataFetchError。
        if (task.op === "creator") {
          hints.push("creator 入参必须是平台原始 UID（脱敏后的 authorId 喂不进去）");
        }
        throw new Error(
          `采集子进程退出码 ${outcome.code}。` +
            (cause ? `内核报错：${cause}。` : "") +
            `常见原因：${hints.join("、")}。日志：${outcome.logFile}`,
        );
      }

      // 一次采集可能同时产出内容与评论两类文件，各自按自己的字段表归一化
      const { files, groups } = await readRecordsSince(d.paths.dataDir, task.platform, snapshot, kindOf(task.op));
      /* `creator` 算子只认 `*_creators_*.jsonl`。
       *
       * 内核在 creator 模式下**顺带**会写 `creator_contents_*` / `creator_comments_*`
       * （该作者的全部作品与评论，B站 `CREATOR_MODE` 就会）。这些行的 op 会被打上
       * `creator`，于是查询侧"按 op=creator 取资料行"时把它们一起捞出来 ——
       * 实测 B站一次 creator 任务让 `meta.creatorCount` 变成 64，里面全是视频行，
       * 主页链接位被视频 URL 顶掉、粉丝量那列还多出一批空值。
       * 作品数据该由 search / content_detail 采，不该从这个口子进来。
       */
      const keptGroups = task.op === "creator" ? groups.filter((g) => g.kind === "creator") : groups;
      /* 一个记录是"个人主页资料"这件事，**由记录本身的类型决定，而不是由哪个算子取回来的**。
       *
       * 内核在 search 模式下也可能顺带写出 `*_creators_*.jsonl`（B站搜索时会顺带按 UP 主
       * 取一次主页统计）。若仍按 `task.op` 归一化，这批资料行会被打成 `op=search`，
       * 于是：① 查询侧"按 op=creator 取资料行"捞不到它们，粉丝量/主页链接丢失；
       * ② 它们又以"内容行"的身份混进条目数。所以这里是**按 kind 纠偏**：
       *   creator 记录 → 一律 op=creator（账号级字段），其余沿用任务算子。 */
      const rows = keptGroups.flatMap((g) =>
        normalizeBatch(task.platform, g.kind === "creator" ? "creator" : task.op, g.kind, g.records),
      );
      task.stored = await d.store.append(task.platform, rows);
      task.files = files;
      task.state = "done";
      // 搜索刚落地 → 顺手补采这批作者的**个人主页资料**（粉丝数等），见 profileEnrich 注释。
      // 放在 drain() 之前：此刻 this.active 还是自己，补采任务会**排到队尾**，
      // 由 finally 里的 drain() 接上，不会和正在进行的内核会话抢浏览器。
      this.enqueueAuthorProfiles(task, rows);
      if (rows.length === 0) {
        // 采集"成功但读不到记录"最常见的原因不是平台没数据，而是**平台目录名对不上**：
        // 子进程 exit 0、jsonl 确实写出来了，只是写在另一个目录下（B站就真踩过：
        // 表里写 bilibili、内核写 bili）。所以这里把内核实际写出的目录一并报出来，
        // 让这类配置错位一眼可辨，而不是让人去翻内核源码。
        const expected = `${d.paths.dataDir}/${MEDIA_CRAWLER_PLATFORM_META[task.platform].dataDirName}`;
        const actual = existsSync(d.paths.dataDir)
          ? readdirSync(d.paths.dataDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
              .sort()
          : [];
        task.error =
          `采集执行完成，但未读到任何归一化记录。可能原因：该平台登录态失效（重新扫码登录）、` +
          `关键词/ID 无结果、或内核 data 目录名与预期不一致（期望 ${expected}）。` +
          (existsSync(join(d.paths.dataDir, MEDIA_CRAWLER_PLATFORM_META[task.platform].dataDirName))
            ? ""
            : `内核实际写出的平台目录：${actual.length ? actual.join(" / ") : "（空）"}。`) +
          `日志：${outcome.logFile}`;
      }
    } catch (e) {
      task.state = "error";
      task.error = e instanceof Error ? e.message : String(e);
    } finally {
      task.finishedAt = new Date().toISOString();
      this.active = null;
      this.maxItemsOf.delete(task.id);
      // 队列里还有就接着跑 —— 漏掉这一步，被排队的平台会永远停在 queued
      this.drain();
      // 必须放在 drain() **之后**：drain 可能同步就把同平台的下一个任务置为 active，
      // 那时 reapIdleBrowser 会看到它、从而正确地不回收（见 hasWorkFor）。
      this.reapIdleBrowser(task.platform);
    }
  }

  /**
   * 某平台还有活干吗？正在跑 / 在排队 / 在补采积压里，三者都算。
   *
   * `profileBacklog` 必须算进来：作者主页补采在队列满时会先进积压、等 drain 才补位。
   * 漏掉它的话，一次搜索刚结束就会把浏览器收掉，紧接着补采任务又得重新拉一个 ——
   * 正好是这次修复要消灭的"窗口反复开"。
   */
  private hasWorkFor(platform: MediaCrawlerPlatform): boolean {
    const active = this.active ? this.tasks.get(this.active) : undefined;
    if (active?.platform === platform) return true;
    if (this.pending.some((id) => this.tasks.get(id)?.platform === platform)) return true;
    return this.profileBacklog.some((b) => b.platform === platform);
  }

  /**
   * 某平台空闲下来了 → 收掉它的常驻浏览器。
   *
   * 只在 `--cdp reuse` 模式下有意义。普通模式里浏览器是**任务级**的，子进程退出时
   * 内核自己就关掉了；复用模式把它升级成了**平台级**资源，就必须有人在"这个平台没活了"
   * 的时刻收尾，否则窗口会一直挂在桌面上 —— 那只是把"反复弹"换成了"一直在"。
   */
  private reapIdleBrowser(platform: MediaCrawlerPlatform): void {
    if (this.deps.cdpMode !== "reuse") return;
    if (this.hasWorkFor(platform)) return;
    const port = MEDIA_CRAWLER_PLATFORM_META[platform].cdpPort;
    const killed = reapBrowser(port, (m) => console.warn(m));
    if (killed > 0) {
      console.info(`[collector] ${platform} 已无待跑采集，回收常驻浏览器（port ${port}）`);
    }
  }
}

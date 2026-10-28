/**
 * M1 Gateway 接入网关：对外唯一入口
 *
 * 用 node:http 手写路由 + SSE，不引 Fastify：
 * 交付面上少一个依赖，SSE 的行为反而更可控（不会被框架的压缩/缓冲中间件干扰）。
 *
 * 职责：
 *   - 鉴权：Bearer token → TenantContext（**不信任请求体里的 tenantId**）
 *   - 幂等：Idempotency-Key
 *   - 协议转换：HTTP / SSE
 *   - 统一错误体（除鉴权与限流外一律 200，业务错误放事件里）
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  API_PREFIX,
  KB_COLLECTIONS,
  PHASE_LABEL,
  PHASE_ORDER,
  parseBriefUtterance,
  type Brief,
  type JobSpec,
  type PhaseName,
  type TenantContext,
} from "@brandsale/contracts";
import { AppError, isAppError } from "@brandsale/contracts";
import { MEDIA_CRAWLER_PLATFORM_META, MEDIA_CRAWLER_PLATFORMS } from "@brandsale/config";
import { completeBriefDraft } from "@brandsale/agent-pack";
import { createContainer, type Container } from "./container.ts";
import { bootstrapHtml } from "./bootstrap.ts";
import { resolveWebDist, serveStatic, webDistBuiltAt, type StaticMount } from "./static.ts";

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError({ code: "E-SYS-500", message: "请求体不是合法 JSON" });
  }
};

/**
 * 鉴权：token 形如 `t.<tenantId>.<userId>`。
 * 这是 Phase 1 的本地实现；接 OIDC/JWT 时只替换这一个函数，其余逻辑不变。
 */
function authenticate(req: IncomingMessage): TenantContext {
  const auth = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) {
    throw new AppError({ code: "E-AUTH-001", message: "缺少 Authorization: Bearer <token>", userMessage: "请先登录" });
  }
  const parts = m[1]!.split(".");
  if (parts.length !== 3 || parts[0] !== "t") {
    throw new AppError({ code: "E-AUTH-001", message: "token 格式非法，应为 t.<tenantId>.<userId>", userMessage: "登录态无效，请重新登录" });
  }
  return {
    tenantId: parts[1]!,
    userId: parts[2]!,
    traceId: String(req.headers["x-trace-id"] ?? randomUUID()),
    locale: "zh-CN",
  };
}

/** 前端 SPA 的入口路径别名。这些路径一律吐 index.html（hash 路由只占用 #） */
const SPA_ENTRY = new Set(["/", "/console", "/console/", "/index.html"]);

export function createGateway(container: Container, web: StaticMount = resolveWebDist()) {
  const { orchestrator, repos, config } = container;

  /**
   * 转发到采集 sidecar。**前端永远只认网关**（不直连 8890）：
   * collector 只绑回环、无鉴权，一旦被浏览器直连就等于把采集面暴露给任意页面。
   */
  const collectorCall = async (
    sub: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const base = config.mediaCrawler.collectorBaseUrl;
    if (!base) {
      return {
        status: 503,
        body: { ok: false, error: "未配置 BM_MC_COLLECTOR_URL：采集/登录 sidecar 未接入" },
      };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 15_000);
    try {
      const r = await fetch(`${base}${sub}`, {
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json" },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: ac.signal,
      });
      const text = await r.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { ok: false, error: `collector 返回的不是 JSON：${text.slice(0, 200)}` };
      }
      return { status: r.status, body };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        status: 504,
        body: { ok: false, error: msg.includes("abort") ? "collector 响应超时" : `无法连接 collector：${msg}` },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/health" || path === `${API_PREFIX}/health`) {
      const health = await container.gateway.health();
      return json(res, 200, {
        ok: true,
        env: config.env,
        llm: { mode: config.llm.mode, baseUrl: config.llm.baseUrl, model: config.llm.models.medium, ...health },
        tiers: config.tiers,
        gateFailClosed: config.gateFailClosed,
        warnings: container.warnings,
        // 前端形态自证：部署到一半（只更新了后端、忘了构建前端）时能一眼看出来
        web: { built: web.ready, dist: web.root, builtAt: webDistBuiltAt(web) },
      });
    }

    /**
     * 前端页面（在鉴权之前处理）。
     *
     * 产物不存在（例如只 clone 了源码没跑前端构建）时，`/` 吐引导页，
     * 告诉用户跑一次 `npm run web:build` —— `npm start` 依然开箱可用，
     * 不会变成一个裸 404。引导页只含构建指引，不含任何业务数据与 API 调用。
     * 页面本身公开可访问；页内所有 API 调用都带 Bearer token，
     * 不为了"页面能打开"而放宽接口鉴权。
     */
    if (method === "GET" && path !== "/health" && !path.startsWith(API_PREFIX)) {
      if (serveStatic(web, SPA_ENTRY.has(path) ? "/" : path, res)) return;
      if (SPA_ENTRY.has(path)) {
        const html = bootstrapHtml();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Cache-Control": "no-cache" });
        return res.end(html);
      }
    }

    let ctx: TenantContext;
    try {
      ctx = authenticate(req);
    } catch (e) {
      const err = e as AppError;
      return json(res, err.httpStatus ?? 401, err.toApiError(String(req.headers["x-trace-id"] ?? randomUUID())));
    }

    try {
      /* ── 任务 ─────────────────────────────────────────── */

      if (path === `${API_PREFIX}/jobs` && method === "POST") {
        const body = (await readBody(req)) as { spec?: JobSpec; brief?: JobSpec["brief"] };
        const spec: JobSpec = body.spec ?? { brief: body.brief! };
        if (!spec?.brief) throw new AppError({ code: "E-SYS-500", message: "缺少 spec.brief" });
        const idempotencyKey = String(req.headers["idempotency-key"] ?? randomUUID());
        const handle = await orchestrator.startJob(
          { spec, idempotencyKey, ...(url.searchParams.get("rerunFrom") ? { rerunFrom: url.searchParams.get("rerunFrom") as PhaseName } : {}) },
          ctx,
        );
        const job = await orchestrator.getJob(handle.jobId, ctx.tenantId);
        return json(res, 201, { job, reused: handle.reused });
      }

      if (path === `${API_PREFIX}/jobs` && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        return json(res, 200, { items: repos.jobs.findByTenant(ctx.tenantId, limit, url.searchParams.get("cursor") ?? undefined), nextCursor: null });
      }

      const jobRoute = new RegExp(`^${API_PREFIX}/jobs/([^/]+)(?:/(.+))?$`).exec(path);
      if (jobRoute) {
        const jobId = jobRoute[1]!;
        const sub = jobRoute[2] ?? "";
        const job = await orchestrator.getJob(jobId, ctx.tenantId);
        if (!job) throw new AppError({ code: "E-AUTH-002", message: "任务不存在或不属于该租户", userMessage: "未找到该任务" });

        if (sub === "" && method === "GET") return json(res, 200, { job });

        if (sub === "phases" && method === "GET") {
          const phases = await orchestrator.listPhases(jobId);
          return json(res, 200, {
            items: phases.map((p) => ({ ...p, label: PHASE_LABEL[p.phase] })),
            order: PHASE_ORDER,
          });
        }

        if (sub === "usage" && method === "GET") {
          return json(res, 200, (await orchestrator.getUsage(jobId)) ?? { jobId, tokens: {}, cost: { currency: "CNY", amount: 0 }, byPhase: [] });
        }

        if (sub === "ledger" && method === "GET") {
          return json(res, 200, { items: container.ledger.byJob(jobId) });
        }

        if (sub === "artifacts" && method === "GET") {
          return json(res, 200, { items: repos.artifacts.list(jobId).map(({ artifactId, kind, createdAt, url: u }) => ({ artifactId, kind, createdAt, url: u })) });
        }

        if (sub === "report" && method === "GET") {
          const html = repos.artifacts.list(jobId).find((a) => a.kind === "report_html");
          if (!html?.inline) throw new AppError({ code: "E-RENDER-002", message: "报告尚未生成" });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(String(html.inline));
        }

        /**
         * 按类型取单个产物内容（控制台的「预览/下载」用）。
         * 列表接口刻意不回传 inline（报告 DSL 可达数十 KB），需要内容时走这个端点。
         */
        const artifactRoute = /^artifacts\/([a-z_]+)$/.exec(sub);
        if (artifactRoute && method === "GET") {
          const kind = artifactRoute[1]!;
          const hit = repos.artifacts.list(jobId).find((a) => a.kind === kind);
          if (hit?.inline === undefined || hit.inline === null) {
            throw new AppError({ code: "E-RENDER-002", message: `产物 ${kind} 尚未生成` });
          }
          const contentType =
            kind === "report_html" ? "text/html; charset=utf-8"
            : kind === "report_markdown" ? "text/markdown; charset=utf-8"
            : "application/json; charset=utf-8";
          const body = typeof hit.inline === "string" ? hit.inline : JSON.stringify(hit.inline, null, 2);
          res.writeHead(200, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
          return res.end(body);
        }

        if (sub === "cancel" && method === "POST") {
          const body = (await readBody(req)) as { reason?: string };
          await orchestrator.cancelJob(jobId, ctx.tenantId, body.reason ?? "用户取消");
          return json(res, 200, { ok: true });
        }

        if (sub === "" && method === "DELETE") {
          await orchestrator.deleteJob(jobId, ctx.tenantId);
          repos.audit.add({
            tenantId: ctx.tenantId,
            kind: "job.delete",
            jobId,
            reason: `删除任务「${jobId}」及其全部关联数据`,
            traceId: ctx.traceId,
          });
          return json(res, 200, { ok: true });
        }

        if (sub.startsWith("rerun/") && method === "POST") {
          const phase = sub.slice("rerun/".length) as PhaseName;
          if (!PHASE_ORDER.includes(phase)) throw new AppError({ code: "E-SYS-500", message: `未知阶段 ${phase}` });
          await orchestrator.rerunPhase(jobId, ctx.tenantId, phase);
          return json(res, 200, { ok: true, rerunFrom: phase });
        }

        if (sub === "stream") {
          return streamJob(res, req, container, jobId);
        }
      }

      /* ── 数据源与授权 ─────────────────────────────────── */

      if (path === `${API_PREFIX}/sources` && method === "GET") {
        const list = repos.sources.list(ctx.tenantId).map((s) => ({
          ...s,
          authz: repos.authz.active(ctx.tenantId, s.sourceId),
        }));
        return json(res, 200, { items: list });
      }

      if (path === `${API_PREFIX}/sources` && method === "POST") {
        const body = (await readBody(req)) as { sourceId: string; name: string; tier: string; owner?: string; contractRef?: string; legalApproved?: boolean; authMethod?: string };
        const res1 = await container.gate.registerSource(
          {
            sourceId: body.sourceId,
            tenantId: ctx.tenantId,
            name: body.name,
            tier: body.tier as never,
            sourceType: (body.tier === "L1" ? "l1_platform" : body.tier === "L2" ? "l2_execution" : body.tier === "L3" ? "l3_public" : "l4_purchased") as never,
            owner: body.owner ?? ctx.userId,
            ...(body.authMethod ? { authMethod: body.authMethod } : {}),
            ...(body.contractRef ? { contractRef: body.contractRef } : {}),
            legalApproved: Boolean(body.legalApproved),
            registeredBy: ctx.userId,
            registeredAt: new Date().toISOString(),
          },
          ctx,
        );
        return json(res, 201, res1);
      }

      if (path === `${API_PREFIX}/authz` && method === "GET") {
        return json(res, 200, { items: await container.gate.listAuthorizations(ctx.tenantId) });
      }

      if (path === `${API_PREFIX}/authz` && method === "POST") {
        const body = (await readBody(req)) as { sourceId: string; grantedBy?: string; days?: number; scopes?: string[] };
        const now = new Date();
        const to = new Date(now.getTime() + (body.days ?? 180) * 86_400_000);
        const out = await container.gate.grantAuthz(
          {
            tenantId: ctx.tenantId,
            sourceId: body.sourceId,
            grantedBy: body.grantedBy ?? ctx.userId,
            validFrom: now.toISOString(),
            validTo: to.toISOString(),
            scopes: body.scopes ?? ["read"],
          },
          ctx,
        );
        return json(res, 201, out);
      }

      /* ── 平台绑定（服务端无头扫码，方案 A）─────────────────
       *
       * 三个动作都只是**代理**到 collector 的 `/login/*`：网关不自己起浏览器。
       * 为什么把这些路由放在网关而不是让前端直连 8890 —— 8890 只绑回环、无鉴权，
       * 直连等于绕过租户隔离，且浏览器会因跨域/端口策略拿到一堆奇怪错误。
       *
       * `configured=false` 是最常见的分支（没装采集内核 / 没配 sidecar）：返回结构
       * 仍然完整，前端据此显示「采集未接入」而不是报一个 500。
       */

      if (path === `${API_PREFIX}/platforms` && method === "GET") {
        const out = await collectorCall("/login/status", { timeoutMs: 10_000 });
        if (out.status === 200) {
          // `mcEnabled` 由网关自己补：collector 不知道主程序的采集开关，
          // 但用户需要知道"绑定了会不会真的被用上"
          return json(res, 200, { ...out.body, mcEnabled: config.mediaCrawler.enabled });
        }
        return json(res, 200, {
          ok: true,
          configured: false,
          reason: String(out.body.error ?? "采集 sidecar 不可用"),
          checkedAt: null,
          probing: false,
          platforms: MEDIA_CRAWLER_PLATFORMS.map((p) => ({
            platform: p,
            name: MEDIA_CRAWLER_PLATFORM_META[p].displayName,
            sourceId: MEDIA_CRAWLER_PLATFORM_META[p].sourceId,
            state: "unavailable",
            detail: "采集 sidecar 未接入，无法查询绑定状态",
          })),
          mcEnabled: config.mediaCrawler.enabled,
        });
      }

      if (path === `${API_PREFIX}/platforms/check` && method === "POST") {
        const body = (await readBody(req)) as { platforms?: string[] };
        // 串行起浏览器，七平台十几秒到一分钟 → 给足 5 分钟，别让代理层先超时
        const out = await collectorCall("/login/check", {
          method: "POST",
          body: { platforms: body.platforms ?? [] },
          timeoutMs: 300_000,
        });
        return json(res, out.status, out.body);
      }

      const loginStart = new RegExp(`^${API_PREFIX}/platforms/([a-z]+)/login$`).exec(path);
      if (loginStart && method === "POST") {
        const platform = loginStart[1]!;
        if (!(MEDIA_CRAWLER_PLATFORMS as readonly string[]).includes(platform)) {
          return json(res, 400, { ok: false, error: `未知平台 ${platform}` });
        }
        const out = await collectorCall("/login/start", { method: "POST", body: { platform }, timeoutMs: 20_000 });
        return json(res, out.status, out.body);
      }

      const loginCookie = new RegExp(`^${API_PREFIX}/platforms/([a-z]+)/cookie$`).exec(path);
      if (loginCookie && method === "POST") {
        const platform = loginCookie[1]!;
        if (!(MEDIA_CRAWLER_PLATFORMS as readonly string[]).includes(platform)) {
          return json(res, 400, { ok: false, error: `未知平台 ${platform}` });
        }
        const body = (await readBody(req)) as { cookie?: unknown };
        if (typeof body.cookie !== "string") {
          return json(res, 400, { ok: false, error: "cookie 必须是字符串" });
        }
        // 写 cookie 要起浏览器 + 探活，十几秒到半分钟 → 给足 2 分钟
        const out = await collectorCall("/login/cookie", {
          method: "POST",
          body: { platform, cookie: body.cookie },
          timeoutMs: 120_000,
        });
        return json(res, out.status, out.body);
      }

      const loginPoll = new RegExp(`^${API_PREFIX}/platforms/login/([0-9a-fA-F-]+)$`).exec(path);
      if (loginPoll && method === "GET") {
        const out = await collectorCall(`/login/${loginPoll[1]!}`, { timeoutMs: 10_000 });
        return json(res, out.status, out.body);
      }

      const loginCancel = new RegExp(`^${API_PREFIX}/platforms/login/([0-9a-fA-F-]+)/cancel$`).exec(path);
      if (loginCancel && method === "POST") {
        const out = await collectorCall(`/login/${loginCancel[1]!}/cancel`, { method: "POST", timeoutMs: 10_000 });
        return json(res, out.status, out.body);
      }

      /* ── 知识库与审计 ─────────────────────────────────── */

      /* ── 自然语言 Brief 解析（P0-2 / WP-C） ──────────────
       *
       * 只产出**草稿**：不落库、不建 job。用户在前端确认草稿后再走 POST /jobs。
       * 为什么不顺便建个任务：
       *   - 解析是试错的（用户会反复改措辞），每次建 job 会污染任务列表与用量台账；
       *   - 结构化字段仍然是唯一的提交契约，自然语言只是录入入口的糖
       *     （见 docs/requirements-implementation-plan.md §WP-C）。
       *
       * 两段式：规则段（纯函数，在本进程内跑）+ 仅当有关键字段缺失时才调一次模型的补全段。
       * 模型不可用时**不报错**，退回"规则结果 + 让它自己去问用户"。
       */
      if (path === `${API_PREFIX}/brief/parse` && method === "POST") {
        const body = (await readBody(req)) as { utterance?: unknown; defaults?: Partial<Brief> };
        const utterance = typeof body.utterance === "string" ? body.utterance.trim() : "";
        if (utterance.length === 0) {
          throw new AppError({
            code: "E-BRIEF-001",
            message: "utterance 不能为空",
            userMessage: "请用一句话描述你的营销诉求，例如「双11 在小红书投精华，预算 300 万」。",
            details: { field: "utterance" },
          });
        }
        const draft = parseBriefUtterance(utterance, body.defaults);
        // jobId 只用于模型调用记账与日志串接，因此给一个带前缀的临时 id 以区别真实任务
        const out = await completeBriefDraft(utterance, draft, {
          gateway: container.gateway,
          jobId: `brief_parse_${randomUUID().slice(0, 12)}`,
        });
        return json(res, 200, out);
      }

      if (path === `${API_PREFIX}/kb/stats` && method === "GET") {
        return json(res, 200, { items: await container.knowledge.stats(ctx.tenantId) });
      }

      if (path === `${API_PREFIX}/kb/retrieve` && method === "POST") {
        const body = (await readBody(req)) as { query: string; collections?: string[]; topK?: number };
        const out = await container.knowledge.retrieve({
          text: body.query,
          collections: body.collections as never,
          topK: body.topK ?? 6,
          tenantId: ctx.tenantId,
        });
        return json(res, 200, {
          reranked: out.reranked,
          degraded: out.degraded ?? null,
          hits: out.hits.map((h) => ({ chunkId: h.chunk.chunkId, collection: h.chunk.collection, score: h.score, rerankScore: h.rerankScore, text: h.chunk.text.slice(0, 200) })),
        });
      }

      /* ── KB 入库通道（P1-5） ─────────────────────────────
       *
       * 这是"结合甲方资料让策略更精准"从口号变成能力的唯一路径：
       * 此前 knowledge.ingest() 全库只有 seed.ts 一处调用，
       * 运营无法自助往知识库放东西，甲方的行业资料只能靠改代码灌进去。
       *
       * 出错用 4xx 而不是项目惯用的 200：那条"业务错误一律 200"的规则
       * 针对的是**长任务内的降级**（前端要继续渲染其余结果），
       * 而入库是同步请求——前提条件不满足却回 200，调用方会以为写进去了。
       */

      if (path === `${API_PREFIX}/kb/documents` && method === "POST") {
        const body = (await readBody(req)) as {
          title?: string;
          collection?: string;
          sourceId?: string;
          mime?: string;
          publishedAt?: string;
          sampleSize?: number;
          humanVerified?: boolean;
          global?: boolean;
          meta?: Record<string, string | number | boolean>;
          content?: string;
          contentBase64?: string;
          filename?: string;
        };

        const collection = String(body.collection ?? "").trim();
        if (!KB_COLLECTIONS.includes(collection as never)) {
          throw new AppError({
            code: "E-INGEST-001",
            message: `collection 必填且必须为 ${KB_COLLECTIONS.join(" / ")} 之一，收到「${collection}」`,
            details: { field: "collection" },
          });
        }

        // 全局写入是部署级开关，不是用户级权限（见 Config.kb 的注释）
        const isGlobal = Boolean(body.global);
        if (isGlobal && !config.kb.allowGlobalWrite) {
          throw new AppError({
            code: "E-INGEST-001",
            message: "本部署未开启全局语料写入（BM_KB_ALLOW_GLOBAL_WRITE=false）",
            userMessage: "跨租户共享的知识库写入已关闭。如需上传面向所有租户的公开情报，请让管理员开启该能力。",
            details: { field: "global" },
          });
        }

        const hasBinary = typeof body.contentBase64 === "string" && body.contentBase64.length > 0;
        const mime = String(body.mime ?? (hasBinary ? "application/octet-stream" : "text/plain"));
        const filename = body.filename ? String(body.filename) : undefined;

        // 解析在写入之前：拿不到文本就不写、不建文档行。
        // 未配置 BM_PARSER_URL 时 pdf/docx 会在这里被 415 拦下，
        // 而不是被当成二进制文本塞进 KB 变成乱码 chunk。
        let text = typeof body.content === "string" ? body.content : "";
        let parserName = "textonly";
        if (hasBinary) {
          const buf = Buffer.from(body.contentBase64!, "base64");
          const parsed = await container.parser.parse(new Uint8Array(buf), mime, filename);
          text = parsed.text;
          parserName = parsed.parser;
        } else if (!text.trim()) {
          throw new AppError({
            code: "E-INGEST-001",
            message: "content 与 contentBase64 至少提供一个且不能为空",
            details: { field: "content" },
          });
        }

        const result = await container.knowledge.ingestDocument(
          {
            title: String(body.title ?? "").trim(),
            collection: collection as never,
            sourceId: String(body.sourceId ?? "").trim(),
            mime,
            content: text,
            publishedAt: body.publishedAt ? String(body.publishedAt) : new Date().toISOString(),
            ...(body.sampleSize !== undefined ? { sampleSize: Number(body.sampleSize) } : {}),
            ...(body.humanVerified !== undefined ? { humanVerified: Boolean(body.humanVerified) } : {}),
            ...(body.meta ? { meta: body.meta } : {}),
            ...(isGlobal ? { global: true } : {}),
          },
          ctx,
        );

        repos.audit.add({
          tenantId: ctx.tenantId,
          kind: "kb.ingest",
          reason: `${result.replaced ? "覆盖" : "新增"}文档「${result.docId}」到 ${collection}（来源 ${result.sourceId}，${result.chunks} 块，解析器 ${parserName}）`,
          traceId: ctx.traceId,
        });

        return json(res, 201, { ...result, parser: parserName, global: isGlobal });
      }

      if (path === `${API_PREFIX}/kb/documents` && method === "GET") {
        const collection = url.searchParams.get("collection") ?? undefined;
        return json(res, 200, {
          items: container.knowledge.listDocuments(ctx.tenantId, collection as never),
        });
      }

      const kbDocRoute = new RegExp(`^${API_PREFIX}/kb/documents/([^/]+)$`).exec(path);
      if (kbDocRoute && method === "DELETE") {
        const docId = decodeURIComponent(kbDocRoute[1]!);
        const out = container.knowledge.deleteDocument(ctx.tenantId, docId);
        repos.audit.add({
          tenantId: ctx.tenantId,
          kind: "kb.ingest",
          reason: `删除文档「${docId}」及其 ${out.removedChunks} 个块`,
          traceId: ctx.traceId,
        });
        return json(res, 200, out);
      }

      if (path === `${API_PREFIX}/audit` && method === "GET") {
        const items = repos.audit.list(ctx.tenantId, Number(url.searchParams.get("limit") ?? 50));
        return json(res, 200, {
          // 登记 / 授权类审计没有 error code，语义上等价于成功，统一补 OK，
          // 否则前端会渲染出一片 undefined
          items: items.map((a) => ({ ...a, code: a.code ?? "OK" })),
          summary: repos.audit.countByKind(ctx.tenantId),
        });
      }

      /* ── 运维 ─────────────────────────────────────────── */

      if (path === `${API_PREFIX}/recover` && method === "POST") {
        return json(res, 200, await orchestrator.recover({ tenantId: ctx.tenantId, userId: ctx.userId, traceId: ctx.traceId, locale: "zh-CN" }));
      }

      return json(res, 404, {
        error: { code: "E-SYS-500", message: `未知路由 ${method} ${path}`, retryable: false, traceId: ctx.traceId },
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (isAppError(e)) {
        return json(res, e.httpStatus, e.toApiError(ctx.traceId));
      }
      return json(res, 500, {
        error: { code: "E-SYS-500", message: err.message, retryable: true, traceId: ctx.traceId },
      });
    }
  });

  return server;
}

/** SSE：先回放历史（Last-Event-ID），再持续推送 */
function streamJob(res: ServerResponse, req: IncomingMessage, container: Container, jobId: string): void {
  const lastEventId = req.headers["last-event-id"];
  const since = lastEventId ? Number(lastEventId) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = container.orchestrator.subscribe(jobId, Number.isFinite(since as number) ? (since as number) : null, (e) => {
    const { seq, ...rest } = e as never as { seq: number } & Record<string, unknown>;
    res.write(`id: ${seq}\nevent: ${String(rest.type)}\ndata: ${JSON.stringify(rest)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, 15_000);
  heartbeat.unref?.();

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
}

export { createContainer };

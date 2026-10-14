/**
 * WP-A / WP-D 自检：KB 入库通道 + 来源登记不变量 + mutating 工具准入
 *
 * 运行：npm test
 * 全部在 mock 模式下跑，不依赖任何外部服务。
 *
 * 为什么这些用例值得写：
 *   入库通道是"甲方资料进得来"的唯一路径，它同时是**合规入口**——
 *   来路不明的数据一旦进库，报告就会把它当合法来源引用，而这个错误比
 *   出站数据错误更隐蔽（数据已经躺在库里了，谁也看不出它不该在）。
 *   所以每个不变量都要有用例把住，而不是靠读代码确认。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadConfig } from "@brandsale/config";
import {
  AppError,
  chunkText,
  extractSampleSize,
  type IngestSourceGuard,
  type TenantContext,
  type ToolPolicy,
} from "@brandsale/contracts";
import { DataSourceRegistry } from "@brandsale/datasource";
import { admitTool } from "@brandsale/agent-pack";
import { assertSourceRegistration } from "@brandsale/governance";
import { KnowledgeService, createParser, stableDocId } from "@brandsale/knowledge";
import { migrate, openDb, Repositories } from "@brandsale/storage";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { createGateway } from "../apps/gateway/src/server.ts";
import { seed, DEMO_TENANT } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_test", traceId: "trace_kb", locale: "zh-CN" };

/* 种子数据里唯一"已登记 + 已授权"的数据源。运营把公开情报贴进知识库时，
 * 用的正是它——语义上也对：来源就是"联网检索到的公开网页"。 */
const SEEDED_SOURCE = "volc_web_search";

async function seedInto(dir: string): Promise<void> {
  const saved = process.env.BM_DATA_DIR;
  process.env.BM_DATA_DIR = dir;
  try {
    await seed();
  } finally {
    if (saved === undefined) delete process.env.BM_DATA_DIR;
    else process.env.BM_DATA_DIR = saved;
  }
}

async function freshContainer(env: Record<string, string> = {}): Promise<{ c: Container; dir: string; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-kb-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", ...env });
  const c = createContainer(config);
  await seedInto(dir);
  return {
    c,
    dir,
    dispose: () => {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function bootServer(env: Record<string, string> = {}): Promise<{ c: Container; server: Server; base: string; dispose: () => Promise<void> }> {
  const { c, dir, dispose: closeContainer } = await freshContainer(env);
  const server = createGateway(c);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    c,
    server,
    base: `http://127.0.0.1:${port}/api/v1`,
    dispose: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      closeContainer();
      void dir;
    },
  };
}

const auth = { Authorization: `Bearer t.${DEMO_TENANT}.u_test`, "Content-Type": "application/json" };

/* 一段结构化的中文文档：带标题层级、长段落、可提取的样本量 */
const SAMPLE_DOC = `# 2026 Q3 美妆行业公开情报

## 一、类目大盘

本季度美妆类目 GMV 同比增速放缓至 12%，样本量 1200 条笔记。其中护肤子类目占比 47%，
彩妆子类目占比 31%，个护占比 22%。整体呈现"高端化与平价化两端走强、中间价位被挤压"的格局，
这一结构与去年同期的"腰部最厚"形成明显反差，说明消费分层在加速。

## 二、人群结构

核心消费人群年龄集中在 18-30 岁，占样本的 61%。地域上一线及新一线城市占比 55%，
低于去年同期的 63%，下沉市场渗透在持续加深。内容偏好方面，成分党内容互动率显著高于
颜值导向内容，差距达到 2.3 倍。

## 三、竞品动作

头部品牌在本季度普遍加大了达人投放密度，中腰部达人合作数量同比增加 38%。
值得注意的是，单条内容报价的中位数并未同步上涨，说明供给端的达人数量增长快于品牌需求增长，
这给品牌方在议价上留出了空间。
`;

/* ── 切分器（纯函数） ───────────────────────────────────── */

test("KB-切分 标题层级保留、块长受控、超长段被按句切开、样本量可提取", () => {
  const chunks = chunkText(SAMPLE_DOC, { targetChars: 120, maxChars: 240, overlapChars: 30 });
  assert.ok(chunks.length >= 3, `长文档应切出多块，实际 ${chunks.length}`);
  assert.equal(chunks[0]!.index, 0);

  // 标题路径必须保留，且作为前缀出现在块文本里（提升"章节名"类查询的命中率）
  const withPath = chunks.find((c) => c.headingPath.length > 0);
  assert.ok(withPath, "至少有一块应带标题路径");
  assert.ok(withPath!.text.includes(withPath!.headingPath[withPath!.headingPath.length - 1]!), "标题应作为前缀出现在块文本中");

  // 单块不应超过硬上限 + 标题前缀的少量开销
  for (const c of chunks) {
    assert.ok(c.text.length <= 260, `块 ${c.index} 长度 ${c.text.length} 超限`);
  }

  // 长段落必须被切开，不能整段塞成一块
  const longest = Math.max(...chunks.map((c) => c.text.length));
  assert.ok(longest <= 260, "最长的块也必须受 maxChars 约束");

  assert.equal(extractSampleSize("样本量 1200 条"), 1200);
  assert.equal(extractSampleSize("n=350"), 350);
  assert.equal(extractSampleSize("没有数字的一句话"), 0);
});

test("KB-切分 doc_id 稳定：同输入同 id，任一维度变化则换 id", () => {
  const a = stableDocId(["t1", "s1", "标题", "2026-10-01"]);
  const b = stableDocId(["t1", "s1", "标题", "2026-10-01"]);
  const c = stableDocId(["t1", "s1", "标题", "2026-11-01"]);
  assert.equal(a, b, "同输入必须同 id（幂等的前提）");
  assert.notEqual(a, c, "数据时点变化即为新文档");
});

/* ── 解析器 ─────────────────────────────────────────────── */

test("KB-解析 未配置 BM_PARSER_URL 时：纯文本可解析，docx 明确报 415", async () => {
  const config = loadConfig(process.cwd(), { BM_PARSER_URL: "", BM_LLM_MODE: "mock" });
  const parser = createParser(config);
  assert.equal(parser.supports("text/markdown"), true);
  assert.equal(parser.supports("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), false);

  const ok = await parser.parse(new TextEncoder().encode("# 标题\n正文"), "text/plain; charset=utf-8");
  assert.equal(ok.parser, "textonly");
  assert.ok(ok.text.includes("标题"));

  await assert.rejects(
    () => parser.parse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    (e: unknown) => e instanceof AppError && e.code === "E-INGEST-002" && e.httpStatus === 415,
    "未配解析器时必须明确拒绝，不能把二进制当文本",
  );
});

/* ── 入库来源守卫 ───────────────────────────────────────── */

test("KB-守卫 未登记来源 / 无授权来源 都被拒绝，且一行都不写", async () => {
  const { c, dispose } = await freshContainer();
  try {
    const before = await c.knowledge.stats(DEMO_TENANT);
    const beforeTotal = before.reduce((s, x) => s + x.chunks, 0);

    await assert.rejects(
      () =>
        c.knowledge.ingestDocument(
          { title: "来路不明", collection: "KB-3", sourceId: "never_registered", mime: "text/plain", content: SAMPLE_DOC, publishedAt: "2026-10-01T00:00:00Z" },
          ctx,
        ),
      (e: unknown) => e instanceof AppError && e.code === "E-INGEST-001",
    );

    const after = await c.knowledge.stats(DEMO_TENANT);
    assert.equal(after.reduce((s, x) => s + x.chunks, 0), beforeTotal, "校验失败时不得写入任何 chunk");

    const docRows = c.repos.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM kb_docs WHERE source_id = ?", "never_registered");
    assert.equal(docRows[0]!.n, 0, "校验失败时不得写入 kb_docs 行");
  } finally {
    dispose();
  }
});

test("KB-守卫 未注入守卫时 fail-closed（默认拒绝，而不是默认放行）", async () => {
  const db = openDb(":memory:");
  migrate(db);
  const svc = new KnowledgeService(db, loadConfig(process.cwd(), { BM_LLM_MODE: "mock" }));
  await assert.rejects(
    () => svc.ingestDocument({ title: "x", collection: "KB-3", sourceId: SEEDED_SOURCE, mime: "text/plain", content: "正文内容不少于几个字", publishedAt: "2026-10-01T00:00:00Z" }, ctx),
    (e: unknown) => e instanceof AppError && e.code === "E-INGEST-001",
    "没有守卫就必须拒绝——没接校验的入库通道等于没有来源门槛",
  );
  db.close();
});

test("KB-守卫 自定义守卫可以放行（验证注入链路本身可用）", async () => {
  const db = openDb(":memory:");
  migrate(db);
  const allowAll: IngestSourceGuard = () => ({ ok: true, tier: "L3", sourceType: "l3_public" });
  const svc = new KnowledgeService(db, loadConfig(process.cwd(), { BM_LLM_MODE: "mock" }), allowAll);
  const out = await svc.ingestDocument(
    { title: "行业报告", collection: "KB-3", sourceId: "s1", mime: "text/markdown", content: SAMPLE_DOC, publishedAt: "2026-10-01T00:00:00Z" },
    ctx,
  );
  assert.ok(out.chunks > 0);
  assert.equal(out.replaced, false);

  // 覆盖式重传：块数不翻倍、replaced 转 true、chunkId 稳定
  const again = await svc.ingestDocument(
    { title: "行业报告", collection: "KB-3", sourceId: "s1", mime: "text/markdown", content: SAMPLE_DOC, publishedAt: "2026-10-01T00:00:00Z" },
    ctx,
  );
  assert.equal(again.replaced, true, "同键重传必须识别为覆盖");
  assert.equal(again.docId, out.docId);
  assert.equal(again.chunks, out.chunks, "覆盖后块数应保持，而不是翻倍");

  const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?", out.docId);
  assert.equal(n!.n, out.chunks);

  // 倒排词项必须同步清理：残留词项会让 BM25 命中不存在的 chunk
  const orphan = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM kb_terms WHERE chunk_id NOT IN (SELECT chunk_id FROM kb_chunks)",
  );
  assert.equal(orphan!.n, 0, "不得残留孤儿倒排词项");
  db.close();
});

/* ── HTTP 路由（端到端） ────────────────────────────────── */

test("E2E-KB-1 入库即可检索：POST /kb/documents → /kb/retrieve 命中 → stats 计数增加", async () => {
  const { c, base, dispose } = await bootServer();
  try {
    const before = await c.knowledge.stats(DEMO_TENANT);
    const beforeKb3 = before.find((x) => x.collection === "KB-3")?.chunks ?? 0;

    const res = await fetch(`${base}/kb/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        title: "2026 Q3 美妆行业公开情报",
        collection: "KB-3",
        sourceId: SEEDED_SOURCE,
        mime: "text/markdown",
        publishedAt: "2026-10-01T00:00:00Z",
        content: SAMPLE_DOC,
      }),
    });
    assert.equal(res.status, 201, `入库应返回 201，实际 ${res.status}`);
    const body = (await res.json()) as { docId: string; chunks: number; parser: string; collection: string };
    assert.ok(body.chunks > 0, "应切出至少一个块");
    assert.equal(body.parser, "textonly");
    assert.equal(body.collection, "KB-3");

    // 立刻可检索——这是"入库通道真的通了"的唯一证据
    const rres = await fetch(`${base}/kb/retrieve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ query: "美妆类目同比增速", collections: ["KB-3"], topK: 5 }),
    });
    assert.equal(rres.status, 200);
    const rout = (await rres.json()) as { hits: { chunkId: string; text: string }[] };
    assert.ok(rout.hits.length > 0, "刚入库的内容应能被检索到");
    assert.ok(
      rout.hits.some((h) => h.chunkId.startsWith(body.docId)),
      `检索结果应包含本次入库的文档（期望前缀 ${body.docId}）`,
    );

    // 统计计数增加
    const after = await c.knowledge.stats(DEMO_TENANT);
    const afterKb3 = after.find((x) => x.collection === "KB-3")?.chunks ?? 0;
    assert.equal(afterKb3 - beforeKb3, body.chunks, "KB-3 计数应恰好增加本次入库的块数");

    // 文档列表可见
    const lres = await fetch(`${base}/kb/documents?collection=KB-3`, { headers: auth });
    const lbody = (await lres.json()) as { items: { docId: string }[] };
    assert.ok(lbody.items.some((d) => d.docId === body.docId), "文档列表应包含刚入库的文档");
  } finally {
    await dispose();
  }
});

test("E2E-KB-2 未登记来源：400 E-INGEST-001，且库内容不变", async () => {
  const { c, base, dispose } = await bootServer();
  try {
    const before = await c.knowledge.stats(DEMO_TENANT);
    const beforeTotal = before.reduce((s, x) => s + x.chunks, 0);

    const res = await fetch(`${base}/kb/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "来路不明", collection: "KB-3", sourceId: "never_registered", content: SAMPLE_DOC, publishedAt: "2026-10-01T00:00:00Z" }),
    });
    assert.equal(res.status, 400, `来源未登记必须返回 400（同步请求不能回 200 让调用方以为写进去了）`);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "E-INGEST-001");

    const after = await c.knowledge.stats(DEMO_TENANT);
    assert.equal(after.reduce((s, x) => s + x.chunks, 0), beforeTotal, "拒绝时不得写入任何 chunk");
  } finally {
    await dispose();
  }
});

test("E2E-KB-3 未配解析器上传 docx：415 E-INGEST-002，且不产生任何 chunk", async () => {
  const { c, base, dispose } = await bootServer({ BM_PARSER_URL: "" });
  try {
    const before = await c.knowledge.stats(DEMO_TENANT);
    const beforeTotal = before.reduce((s, x) => s + x.chunks, 0);

    const res = await fetch(`${base}/kb/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        title: "某品牌 brief.docx",
        collection: "KB-2",
        sourceId: SEEDED_SOURCE,
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentBase64: Buffer.from("PK\u0003\u0004 not a real docx").toString("base64"),
        filename: "brief.docx",
      }),
    });
    assert.equal(res.status, 415, "不支持的格式必须是 415，而不是静默塞进去");
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "E-INGEST-002");

    const after = await c.knowledge.stats(DEMO_TENANT);
    assert.equal(after.reduce((s, x) => s + x.chunks, 0), beforeTotal, "解析失败时不得写入任何 chunk");
  } finally {
    await dispose();
  }
});

test("KB-路由 全局语料写入默认关闭；打开后才允许，且仍禁止写 KB-1/KB-2", async () => {
  const off = await bootServer({ BM_KB_ALLOW_GLOBAL_WRITE: "false" });
  try {
    const res = await fetch(`${off.base}/kb/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "全局情报", collection: "KB-3", sourceId: SEEDED_SOURCE, content: SAMPLE_DOC, publishedAt: "2026-10-01T00:00:00Z", global: true }),
    });
    assert.equal(res.status, 400, "默认必须拒绝全局写入");
  } finally {
    await off.dispose();
  }

  const on = await bootServer({ BM_KB_ALLOW_GLOBAL_WRITE: "true" });
  try {
    const ok = await fetch(`${on.base}/kb/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "全局情报", collection: "KB-3", sourceId: SEEDED_SOURCE, content: SAMPLE_DOC, publishedAt: "2026-10-01T00:00:00Z", global: true }),
    });
    assert.equal(ok.status, 201, "开关打开后应可写入");
    const okBody = (await ok.json()) as { global: boolean };
    assert.equal(okBody.global, true);

    // 全局写入只对公开情报与方法论开放——KB-1/KB-2 装的是客户私域数据
    const bad = await fetch(`${on.base}/kb/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "私域数据", collection: "KB-2", sourceId: SEEDED_SOURCE, content: SAMPLE_DOC, publishedAt: "2026-10-01T00:00:00Z", global: true }),
    });
    assert.equal(bad.status, 400, "KB-2 是客户私域数据，不得写成全局可见");
  } finally {
    await on.dispose();
  }
});

/* ── 来源登记不变量（WP-D2） ─────────────────────────────── */

test("契约-L3 禁止填写 contractRef：防止把公开采集洗成已授权实测", async () => {
  assert.throws(
    () =>
      assertSourceRegistration({
        sourceId: "l3_public_demo",
        tenantId: DEMO_TENANT,
        name: "公开采集示例源",
        tier: "L3",
        sourceType: "l3_public",
        owner: "growth",
        contractRef: "合同编号 A-123",
        legalApproved: true,
        registeredBy: "u_test",
        registeredAt: new Date().toISOString(),
      }),
    (e: unknown) => e instanceof AppError && e.code === "E-GOV-005",
    "L3 没有授权合同，填了 contractRef 就是伪造授权",
  );

  // 不带 contractRef 的 L3 必须放行（正常路径不能被误伤）
  assert.doesNotThrow(() =>
    assertSourceRegistration({
      sourceId: "l3_public_demo",
      tenantId: DEMO_TENANT,
      name: "公开采集示例源",
      tier: "L3",
      sourceType: "l3_public",
      owner: "growth",
      authMethod: "自托管采集服务",
      legalApproved: true,
      registeredBy: "u_test",
      registeredAt: new Date().toISOString(),
    }),
  );
});

test("契约-L1/L2 必须齐备 authMethod + contractRef + legalApproved", () => {
  const base = {
    sourceId: "douyin_open_fans",
    tenantId: DEMO_TENANT,
    name: "抖音开放平台粉丝画像",
    tier: "L1" as const,
    sourceType: "l1_platform" as const,
    owner: "brand",
    registeredBy: "u_test",
    registeredAt: new Date().toISOString(),
  };

  assert.throws(() => assertSourceRegistration({ ...base, authMethod: "OAuth", legalApproved: true }), (e: unknown) => e instanceof AppError && e.code === "E-GOV-005");
  assert.throws(() => assertSourceRegistration({ ...base, contractRef: "合同", legalApproved: true }), (e: unknown) => e instanceof AppError && e.code === "E-GOV-005");
  assert.throws(() => assertSourceRegistration({ ...base, authMethod: "OAuth", contractRef: "合同", legalApproved: false }), (e: unknown) => e instanceof AppError && e.code === "E-GOV-005");
  assert.doesNotThrow(() => assertSourceRegistration({ ...base, authMethod: "OAuth（关系能力）", contractRef: "开发者协议", legalApproved: true }));
});

test("契约-L4 不在登记期拦截：先登记、合同后补、使用前由双开关挡住（既有设计）", () => {
  assert.doesNotThrow(
    () =>
      assertSourceRegistration({
        sourceId: "l4_x",
        tenantId: DEMO_TENANT,
        name: "某第三方数据服务商",
        tier: "L4",
        sourceType: "l4_purchased",
        owner: "legal",
        legalApproved: false,
        registeredBy: "u_test",
        registeredAt: new Date().toISOString(),
      }),
    "L4 的门在访问期（config.tiers.L4 + legalApproved），登记期不应拦截",
  );
});

/* ── mutating 工具准入（WP-D3） ──────────────────────────── */

function policyOf(partial: Partial<ToolPolicy>): ToolPolicy {
  return {
    name: "probe",
    allowedAgents: ["CI"],
    governance: ["scope", "source", "authz", "tenant"],
    rateLimit: { rpsPerTenant: 1, burst: 1, queueMaxMs: 1000 },
    timeoutMs: 1000,
    retry: { attempts: 1, backoff: "fixed", baseMs: 100 },
    parallelism: "sequential",
    replaySafe: false,
    ...partial,
  };
}

test("契约-mutating 工具默认不注册；开启后仍要求挂 authz 且 replaySafe=false", () => {
  const mk = (allow: boolean) => ({
    config: loadConfig(process.cwd(), { BM_LLM_MODE: "mock", BM_TOOLS_ALLOW_MUTATING: allow ? "true" : "false" }),
    datasources: new DataSourceRegistry([]),
  });

  const writeTool = policyOf({ mutating: true, replaySafe: false, governance: ["scope", "source", "authz", "tenant"] });

  assert.equal(admitTool(writeTool, mk(false)).ok, false, "默认必须不注册写工具");
  assert.equal(admitTool(writeTool, mk(true)).ok, true, "显式开启后才注册");

  // 配置自相矛盾必须在装配期炸出来，而不是等模型真的调用了写工具
  assert.throws(() => admitTool(policyOf({ mutating: true, replaySafe: false, governance: ["scope", "source"] }), mk(true)), /未挂 "authz"/);
  assert.throws(() => admitTool(policyOf({ mutating: true, replaySafe: true, governance: ["scope", "authz"] }), mk(true)), /replaySafe=true/);

  // 只读工具不受影响（零行为变化）
  assert.equal(admitTool(policyOf({ mutating: false }), mk(false)).ok, true);
  assert.equal(admitTool(policyOf({}), mk(false)).ok, true, "未声明 mutating 时按只读处理");

  // 能力未就绪的绑定源工具仍跳过
  assert.equal(admitTool(policyOf({ boundSourceId: "not_registered_adapter" }), mk(true)).ok, false);
});

/* ── 装配期不变量 ───────────────────────────────────────── */

test("装配 未配置 BM_PARSER_URL 时给出明确启动告警（而不是等使用时才失败）", () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-boot-"));
  try {
    const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", BM_PARSER_URL: "" });
    const c = createContainer(config);
    try {
      assert.ok(
        c.warnings.some((w) => w.includes("BM_PARSER_URL")),
        `应提示解析器未配置，实际告警：${JSON.stringify(c.warnings)}`,
      );
    } finally {
      c.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

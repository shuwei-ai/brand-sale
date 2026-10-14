/**
 * P1/P2 自检：报告摘要回灌 + 向量落盘 + 模型混用守卫
 *
 * 运行：npm test（全部在 mock 模式下，不依赖任何外部服务）
 *
 * 为什么这些用例值得写：这几条链路上每一环**失败时都不报错**——
 *   · 摘要把模型推断当成了"有出处的数字" → 报告里多出一批无源结论；
 *   · 回灌没有幂等 → 同一份报告在检索结果里出现两次，挤占 topK、伪造交叉验证；
 *   · 摘要在跨租户可见 → 客户私域结论泄露给别的租户；
 *   · 落盘向量与查询向量来自不同模型 → 余弦分数没有意义，但排序照样返回；
 *   · 嵌入服务不可用 → 语义通道整条消失，而检索"看起来"仍然正常。
 * 只能靠测试把住。测试全部是"读取真实落库结果"，不是对实现打桩。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@brandsale/config";
import { AppError, type JobRecord, type ReportDsl, type TenantContext } from "@brandsale/contracts";
import {
  ConfidencePolicy,
  HttpEmbeddingProvider,
  KnowledgeService,
  MilvusVectorIndex,
  buildReportSummary,
  createVectorIndex,
  renderSummaryText,
  SUMMARY_SOURCE_ID,
  type EmbeddingProvider,
  type VectorIndex,
  type VectorIndexSearchResult,
} from "@brandsale/knowledge";
import { migrate, openDb, type Db } from "@brandsale/storage";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { seed, DEMO_TENANT } from "../scripts/seed.ts";

const ctx: TenantContext = { tenantId: DEMO_TENANT, userId: "u_test", traceId: "trace_sum", locale: "zh-CN" };

/* ── 夹具 ───────────────────────────────────────────────── */

const DSL: ReportDsl = {
  meta: {
    dslVersion: "1.0",
    title: "双十一精华投放报告",
    brand: { id: "brand_A", name: "施华蔻" },
    window: { from: "2026-05-20", to: "2026-06-20" },
    generatedAt: "2026-06-21T00:00:00.000Z",
  },
  sourceDeclaration: {
    grade: "L2",
    sources: [{ key: "internal_review", displayName: "历史执行与私域知识库（KB-2）", grade: "L2", asOf: "2026-06-21", coverage: "KB-2" }],
    exclusions: [],
  },
  slides: [
    {
      index: 0,
      pageRole: "cover",
      title: "双十一精华投放方案",
      layoutId: "cover/default",
      blocks: [{ type: "text", style: "body", content: "施华蔻 · 精华类目" }],
      citations: [],
    },
    {
      index: 1,
      pageRole: "data",
      title: "预算分配",
      layoutId: "content/default",
      blocks: [
        { type: "kpi", items: [{ label: "总预算", value: "300", unit: "万元" }, { label: "投放周期", value: "30", unit: "天" }] },
        { type: "table", columns: ["渠道", "金额"], rows: [["抖音", "150 万"]] },
      ],
      citations: [{ claim: "总预算 300 万元", kind: "kb_chunk", ref: { chunkId: "KB-2_1" }, confidence: 0.8, tier: "medium", verifiedBy: "auto" }],
    },
    {
      index: 2,
      pageRole: "content",
      title: "模型推断与假设",
      layoutId: "content/default",
      blocks: [
        { type: "kpi", items: [{ label: "预估 ROI", value: "2.5" }] },
        { type: "text", style: "body", content: "预计种草转化显著提升" },
      ],
      // 只有模型推断 → 本页数字**不得**进 keyNumbers（无出处）
      citations: [{ claim: "预估 ROI 2.5", kind: "model_inference", ref: {}, confidence: 0.3, tier: "low", verifiedBy: "auto" }],
    },
  ],
};

const JOB: JobRecord = {
  jobId: "job_sum_1",
  tenantId: DEMO_TENANT,
  createdBy: "u_test",
  status: "succeeded",
  progress: { percent: 1, currentPhase: null },
  spec: {
    brief: {
      industry: "美妆",
      category: "护肤品-精华",
      brandIds: ["brand_A"],
      budget: { currency: "CNY", amount: 3_000_000 },
      objectiveWeights: { awareness: 0.3, conversion: 0.5, retention: 0.2 },
      window: { from: "2026-05-20", to: "2026-06-20" },
      platforms: ["douyin", "xiaohongshu"],
    },
  },
  degraded: [{ missing: ["报价样本"], reason: "no_data", note: "报价无公开来源，按无样本处理" }],
  createdAt: "2026-06-21T00:00:00.000Z",
  updatedAt: "2026-06-21T00:00:00.000Z",
  idempotencyKey: "k_sum",
};

/** 一个"远端"嵌入 provider：维度与哈希不同，用来构造**跨模型**落盘向量的场景 */
class FakeRemoteEmbedding implements EmbeddingProvider {
  readonly model = "fake-remote-8";
  readonly dim = 8;
  readonly local = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
  }
  async health(): Promise<boolean> {
    return true;
  }
}

function svcOf(db: Db, env: Record<string, string> = {}, embedding?: EmbeddingProvider): KnowledgeService {
  // 显式钉住"本地哈希 + 无外部索引"：本文件的用例断言的就是 hash-256 的落盘行为。
  // 不钉的话会隐式继承开发机 .env —— 那里一旦配了 BM_EMBED_URL，主流程会换成 768 维
  // 远端模型，断言就会随环境红/绿。测试必须与环境无关（调用方仍可用 env 覆盖）。
  const config = loadConfig(process.cwd(), { BM_LLM_MODE: "mock", BM_VECTOR_DRIVER: "memory", BM_EMBED_URL: "", BM_EMBED_MODEL: "", ...env });
  return new KnowledgeService(db, config, undefined, embedding);
}

/* ── 摘要抽取（纯函数） ─────────────────────────────────── */

test("摘要 数字只收「挂了可溯源引用」的行；模型推断单列、不进关键数字", () => {
  const s = buildReportSummary(DSL, JOB);

  assert.equal(s.jobId, JOB.jobId);
  assert.equal(s.title, "双十一精华投放报告");

  // 第 1 页有 kb_chunk 引用 → 该页 KPI 与表格行都进
  const labels = s.keyNumbers.map((k) => k.label);
  assert.ok(labels.includes("总预算"), `应包含总预算，实际 ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("抖音"), "表格里含数字的行也应收");
  // 第 2 页只有 model_inference → 该页数字一个都不进
  assert.ok(!labels.includes("预估 ROI"), "没有出处的数字绝不能进关键数字");
  assert.ok(s.modelInference.some((m) => m.includes("预估 ROI")), "模型推断的表述应单列出来");

  // 每一个关键数字都必须带出处，否则这行等于伪造证据
  for (const k of s.keyNumbers) assert.ok(k.ref.length > 0, `关键数字「${k.label}」缺出处`);

  assert.deepEqual(s.citedSources, ["KB-2_1"]);
  assert.ok(s.degradations.some((d) => d.includes("报价")), "job.degraded 应如实带入");
});

test("摘要 空 DSL / 无引用 不炸，且不产出任何无出处数字", () => {
  const empty: ReportDsl = { ...DSL, slides: [] };
  const s = buildReportSummary(empty, JOB);
  assert.deepEqual(s.sections, []);
  assert.deepEqual(s.keyNumbers, []);
  assert.equal(s.citedSources.length, 0);
  assert.match(renderSummaryText(s), /机械抽取/);
});

test("摘要 渲染文本显式声明「派生自历史报告」，避免被当成一手来源", () => {
  const text = renderSummaryText(buildReportSummary(DSL, JOB));
  assert.match(text, /机械抽取/, "必须声明是派生语料");
  assert.match(text, /不是一手数据源/);
  assert.match(text, /总预算 = 300万元（出处 KB-2_1）/, "关键数字要带出处一起写出来");
});

/* ── 入库通道 ───────────────────────────────────────────── */

function freshDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("入库 report_summary 走系统自产通道；同名重写幂等、不翻倍", async () => {
  const db = freshDb();
  const svc = svcOf(db);
  const text = renderSummaryText(buildReportSummary(DSL, JOB));
  const input = {
    title: `报告摘要 ${JOB.jobId}`,
    collection: "KB-2" as const,
    sourceId: SUMMARY_SOURCE_ID,
    mime: "text/markdown",
    content: text,
    publishedAt: JOB.createdAt,
    meta: { jobId: JOB.jobId, derived: true },
  };

  const first = await svc.ingestGeneratedDocument(input, ctx);
  assert.ok(first.chunks > 0);
  assert.equal(first.replaced, false);

  const again = await svc.ingestGeneratedDocument(input, ctx);
  assert.equal(again.docId, first.docId, "同键重写必须命中同一份文档");
  assert.equal(again.replaced, true);

  const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kb_chunks WHERE source_id = ?", SUMMARY_SOURCE_ID);
  assert.equal(n!.n, first.chunks, "重写不得让块数翻倍（否则同一句话在检索里出现两次）");

  const row = db.get<{ tier: string; source_type: string }>("SELECT tier, source_type FROM kb_chunks WHERE source_id = ? LIMIT 1", SUMMARY_SOURCE_ID);
  assert.equal(row!.tier, "L2");
  assert.equal(row!.source_type, "l2_execution");
  db.close();
});

test("入库 report_summary 不能走外部上传通道；系统自产通道也只认白名单", async () => {
  const db = freshDb();
  const svc = svcOf(db);

  // 上传通道未注入守卫 → fail-closed（report_summary 也不在 sources 台账里）
  await assert.rejects(
    () => svc.ingestDocument({ title: "x", collection: "KB-2", sourceId: SUMMARY_SOURCE_ID, mime: "text/plain", content: "内容足够长的一段文字", publishedAt: JOB.createdAt }, ctx),
    (e: unknown) => e instanceof AppError && e.code === "E-INGEST-001",
    "外部上传通道必须拒绝系统自产来源",
  );

  // 自产通道只认白名单：随便传一个 sourceId 必须被拒（防止它变成绕过来源校验的后门）
  await assert.rejects(
    () => svc.ingestGeneratedDocument({ title: "x", collection: "KB-2", sourceId: "some_external_source", mime: "text/plain", content: "内容足够长的一段文字", publishedAt: JOB.createdAt }, ctx),
    (e: unknown) => e instanceof AppError && e.code === "E-INGEST-003",
  );
  db.close();
});

test("入库 跨租户不可见：A 租户的报告摘要不会出现在 B 租户的检索结果里", async () => {
  const db = freshDb();
  const svc = svcOf(db);
  const text = renderSummaryText(buildReportSummary(DSL, JOB));

  await svc.ingestGeneratedDocument(
    { title: "报告摘要 tenant_other", collection: "KB-2", sourceId: SUMMARY_SOURCE_ID, mime: "text/markdown", content: text, publishedAt: JOB.createdAt },
    { tenantId: "tenant_other", traceId: "t" },
  );

  const seenByDemo = await svc.retrieve({ text: "双十一精华投放报告 总预算", tenantId: DEMO_TENANT, collections: ["KB-2"], topK: 10 });
  assert.ok(
    !seenByDemo.hits.some((h) => h.chunk.sourceId === SUMMARY_SOURCE_ID),
    "别的租户的私域摘要不得被检索到",
  );

  const seenByOwner = await svc.retrieve({ text: "双十一精华投放报告 总预算", tenantId: "tenant_other", collections: ["KB-2"], topK: 10 });
  assert.ok(seenByOwner.hits.some((h) => h.chunk.sourceId === SUMMARY_SOURCE_ID), "本租户自己应能检索到");
  db.close();
});

/* ── 向量落盘与混用守卫 ─────────────────────────────────── */

test("向量 入库即落盘 vec/embed_model/embed_dim，且检索能命中", async () => {
  const db = freshDb();
  const svc = svcOf(db);
  const out = await svc.ingestGeneratedDocument(
    { title: "报告摘要 job_vec", collection: "KB-2", sourceId: SUMMARY_SOURCE_ID, mime: "text/markdown", content: renderSummaryText(buildReportSummary(DSL, JOB)), publishedAt: JOB.createdAt },
    ctx,
  );
  assert.equal(out.embedded, out.chunks, "所有块都应带上向量（本地哈希 provider 不会失败）");

  const row = db.get<{ vec: Uint8Array | null; embed_model: string | null; embed_dim: number | null }>(
    "SELECT vec, embed_model, embed_dim FROM kb_chunks WHERE source_id = ? LIMIT 1",
    SUMMARY_SOURCE_ID,
  );
  assert.ok(row!.vec && row!.vec.byteLength > 0, "向量必须落盘");
  assert.equal(row!.embed_model, "hash-256");
  assert.equal(row!.embed_dim, 256);
  assert.equal(row!.vec!.byteLength, 256 * 4, "BLOB 长度必须是 dim × 4 字节");

  const res = await svc.retrieve({ text: "精华投放 预算分配", tenantId: DEMO_TENANT, collections: ["KB-2"], topK: 5, rerank: false });
  assert.ok(res.hits.length > 0, "回灌的内容应能被检索到");
  db.close();
});

test("向量 跨模型：落盘向量与当前 provider 不一致时该行只走关键词，并记 degraded", async () => {
  const db = freshDb();
  // 先用哈希 provider 落盘（embed_model = hash-256）
  const localSvc = svcOf(db);
  await localSvc.ingestGeneratedDocument(
    { title: "报告摘要 job_mix", collection: "KB-2", sourceId: SUMMARY_SOURCE_ID, mime: "text/markdown", content: renderSummaryText(buildReportSummary(DSL, JOB)), publishedAt: JOB.createdAt },
    ctx,
  );

  // 再用一个不同模型的 provider 检索：它不能把哈希向量当同类比较
  const remoteSvc = svcOf(db, {}, new FakeRemoteEmbedding());
  const res = await remoteSvc.retrieve({ text: "精华 预算 分配", tenantId: DEMO_TENANT, collections: ["KB-2"], topK: 5, rerank: false });

  assert.ok(res.degraded, "跨模型状态必须被标记（否则'换模型后检索悄悄变差'无人知晓）");
  assert.match(res.degraded!.note, /其他模型/);
  // 仍然有结果：退回 BM25 而不是整体失败
  assert.ok(res.hits.length > 0, "语义通道不可用时必须仍能靠关键词出结果");
  db.close();
});

test("向量 嵌入服务不可用：降级为纯关键词并记 E-KB-002，不抛错", async () => {
  const db = freshDb();
  // 指向一个必然打不通的端口：模拟"嵌入服务没起"
  const down = new HttpEmbeddingProvider({ url: "http://127.0.0.1:1/v1/embeddings", model: "embeddinggemma-2", dim: 8, timeoutMs: 300 });
  const svc = svcOf(db, {}, down);

  const out = await svc.ingestGeneratedDocument(
    { title: "报告摘要 job_down", collection: "KB-2", sourceId: SUMMARY_SOURCE_ID, mime: "text/markdown", content: renderSummaryText(buildReportSummary(DSL, JOB)), publishedAt: JOB.createdAt },
    ctx,
  );
  assert.ok(out.chunks > 0, "入库不能因为嵌入服务不可用而失败（内容的首要职责是进得来）");
  assert.equal(out.embedded, 0, "没算出向量时如实报 0，而不是假装成功");

  const res = await svc.retrieve({ text: "精华 预算", tenantId: DEMO_TENANT, collections: ["KB-2"], topK: 5, rerank: false });
  assert.ok(res.hits.length > 0, "纯关键词也应能出结果");
  assert.equal(res.degraded?.reason, "E-KB-002", "必须把'语义通道被跳过'如实标出来，而不是伪装成正常检索");
  db.close();
});

/* ── 自引用回声（§5.2） ─────────────────────────────────── */

test("置信度 派生语料不计入多源交叉一致度（防止自证自话抬高置信度）", () => {
  const p = new ConfidencePolicy();
  const base = { sourceType: "l2_execution" as const, sampleSize: 1, ageDays: 1, humanVerified: true };
  const derived = p.score({ ...base, crossSourceAgreement: 1, derived: true });
  const original = p.score({ ...base, crossSourceAgreement: 1, derived: false });
  assert.notEqual(derived, original, "派生语料的交叉一致度加分必须被忽略");
  assert.ok(derived < original, "忽略之后分数应更低——派生语料不比原始来源更可信");
  assert.equal(p.score({ ...base, derived: true }), p.score({ ...base }), "没有 crossSourceAgreement 时两者一致");
});

/* ── 外部向量索引（P3，默认关闭） ───────────────────────── */

/** 假索引：用来构造"索引与真相源不一致"的两个分支，不需要真 Milvus */
class FakeIndex implements VectorIndex {
  readonly kind = "milvus" as const;
  upsertCalls = 0;
  constructor(
    private readonly hits: { chunkId: string; score: number }[],
    private readonly degraded?: { reason: string; note: string },
  ) {}
  async search(): Promise<VectorIndexSearchResult> {
    return { hits: this.hits, ...(this.degraded ? { degraded: this.degraded } : {}) };
  }
  async upsert(): Promise<void> {
    this.upsertCalls += 1;
  }
  async removeByDoc(): Promise<void> {
    /* noop */
  }
}

test("索引 默认关闭：vectorDriver=memory 时不装配外部索引（零行为变化）", () => {
  const config = loadConfig(process.cwd(), { BM_LLM_MODE: "mock", BM_VECTOR_DRIVER: "memory", BM_EMBED_URL: "http://x/v1/embeddings" });
  assert.equal(createVectorIndex(config.retrieval), null, "默认路径不应启用 Milvus");

  const milvus = loadConfig(process.cwd(), { BM_LLM_MODE: "mock", BM_VECTOR_DRIVER: "milvus", BM_EMBED_URL: "http://127.0.0.1:8899/v1/embeddings" });
  assert.ok(createVectorIndex(milvus.retrieval), "开启后应装配 Milvus 驱动");

  const noEmbed = loadConfig(process.cwd(), { BM_LLM_MODE: "mock", BM_VECTOR_DRIVER: "milvus", BM_EMBED_URL: "" });
  assert.equal(createVectorIndex(noEmbed.retrieval), null, "没有嵌入服务时 Milvus 毫无意义，不应装配");
});

test("索引 孤儿向量必须被丢弃并记 degraded（索引与真相源不一致时不能出现空白条目）", async () => {
  const db = freshDb();
  const svc = svcOf(db);
  await svc.ingestGeneratedDocument(
    { title: "报告摘要 job_idx", collection: "KB-2", sourceId: SUMMARY_SOURCE_ID, mime: "text/markdown", content: renderSummaryText(buildReportSummary(DSL, JOB)), publishedAt: JOB.createdAt },
    ctx,
  );

  const config = loadConfig(process.cwd(), { BM_LLM_MODE: "mock" });
  // 索引里有一个 SQLite 早已不存在的 chunk（模拟"删了没同步"）
  const orphanOnly = new KnowledgeService(db, config, undefined, undefined, new FakeIndex([{ chunkId: "ghost#1", score: 0.99 }]));
  const res = await orphanOnly.retrieve({ text: "精华 预算", tenantId: DEMO_TENANT, collections: ["KB-2"], topK: 5, rerank: false });
  assert.ok(res.degraded, "存在孤儿向量时必须标记出来");
  assert.match(res.degraded!.note, /在 SQLite 中找不到对应片段/);
  assert.ok(res.hits.length > 0, "丢弃孤儿不影响正常结果");
  db.close();
});

test("索引 命中真实片段时正常参与融合；索引不可用时降级但不失败", async () => {
  const db = freshDb();
  const svc = svcOf(db);
  await svc.ingestGeneratedDocument(
    { title: "报告摘要 job_idx2", collection: "KB-2", sourceId: SUMMARY_SOURCE_ID, mime: "text/markdown", content: renderSummaryText(buildReportSummary(DSL, JOB)), publishedAt: JOB.createdAt },
    ctx,
  );
  const realId = db.get<{ chunk_id: string }>("SELECT chunk_id FROM kb_chunks WHERE source_id = ? LIMIT 1", SUMMARY_SOURCE_ID)!.chunk_id;

  const config = loadConfig(process.cwd(), { BM_LLM_MODE: "mock" });
  const okIndex = new KnowledgeService(db, config, undefined, undefined, new FakeIndex([{ chunkId: realId, score: 0.9 }]));
  const okRes = await okIndex.retrieve({ text: "精华 预算", tenantId: DEMO_TENANT, collections: ["KB-2"], topK: 5, rerank: false });
  assert.equal(okRes.degraded, undefined, "索引命中真实片段时不应有降级");
  assert.ok(okRes.hits.some((h) => h.chunk.chunkId === realId));

  const downIndex = new KnowledgeService(
    db,
    config,
    undefined,
    undefined,
    new FakeIndex([], { reason: "milvus_unavailable", note: "Milvus 检索失败（连接被拒）" }),
  );
  const downRes = await downIndex.retrieve({ text: "精华 预算", tenantId: DEMO_TENANT, collections: ["KB-2"], topK: 5, rerank: false });
  assert.equal(downRes.degraded?.reason, "E-KB-002");
  assert.ok(downRes.hits.length > 0, "索引挂了必须仍能出结果（退回 SQLite 语义 + 关键词）");
  db.close();
});

test("索引 Milvus 驱动：不可达时 trySearch 语义生效，不抛错", async () => {
  const idx = new MilvusVectorIndex({
    milvusUrl: "http://127.0.0.1:1",
    collection: "brandsale_kb_test",
    timeoutMs: 400,
    embedUrl: "http://127.0.0.1:1/v1/embeddings",
    embedModel: "embeddinggemma-2",
    embedDim: 8,
    embedTimeoutMs: 400,
  });
  const res = await idx.search("美妆 精华 投放", { tenantId: DEMO_TENANT, topK: 3 });
  assert.equal(res.hits.length, 0, "不可达时返回空命中");
  assert.ok(res.degraded, "而不是抛错——Milvus 挂了不该让检索失败");
});

/* ── 端到端：跑一份任务，摘要必须真的进了库 ─────────────── */

async function bootSeeded(env: Record<string, string> = {}): Promise<{ c: Container; dir: string; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-sum-"));
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dir, BM_LLM_MODE: "mock", ...env });
  const c = createContainer(config);
  const saved = process.env.BM_DATA_DIR;
  process.env.BM_DATA_DIR = dir;
  try {
    await seed();
  } finally {
    if (saved === undefined) delete process.env.BM_DATA_DIR;
    else process.env.BM_DATA_DIR = saved;
  }
  return {
    c,
    dir,
    dispose: () => {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitDone(c: Container, jobId: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await c.orchestrator.getJob(jobId, DEMO_TENANT);
    if (job && ["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return;
    if (Date.now() > deadline) throw new Error(`等待任务 ${jobId} 超时`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

const BRIEF = JOB.spec.brief;

test("E2E 报告产出后摘要回灌 KB-2：可检索、带向量、且不影响任务状态", async () => {
  const { c, dispose } = await bootSeeded();
  try {
    const before = c.repos.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kb_chunks WHERE source_id = ?", SUMMARY_SOURCE_ID);
    assert.equal(before!.n, 0, "前置条件：库里本来没有报告摘要");

    const { jobId } = await c.orchestrator.startJob({ idempotencyKey: "k_sum_e2e", spec: { brief: BRIEF } }, ctx);
    await waitDone(c, jobId);

    const job = (await c.orchestrator.getJob(jobId, DEMO_TENANT))!;
    assert.notEqual(job.status, "failed", `任务不应失败：${JSON.stringify(job.degraded)}`);
    assert.ok(
      !job.degraded.some((d) => (d.note ?? "").includes("摘要回灌失败")),
      `摘要回灌不应失败：${JSON.stringify(job.degraded)}`,
    );

    const rows = c.repos.db.all<{ chunk_id: string; vec: Uint8Array | null; embed_model: string | null }>(
      "SELECT chunk_id, vec, embed_model FROM kb_chunks WHERE source_id = ?",
      SUMMARY_SOURCE_ID,
    );
    assert.ok(rows.length > 0, "报告产出后应把摘要写进 KB-2");
    assert.ok(rows.every((r) => r.vec && r.vec.byteLength > 0), "回灌的块都应带落盘向量");
    assert.ok(rows.every((r) => r.embed_model === "hash-256"), "默认用本地哈希 provider");

    // 摘要来源自动进入目录（否则报告引用它会被判非法）
    const catalog = c.agentPack.sourceCatalog(ctx, jobId);
    assert.ok(catalog.entries.some((e) => e.key === SUMMARY_SOURCE_ID), "report_summary 应出现在来源目录里");
  } finally {
    dispose();
  }
});

test("E2E 关闭开关后不回灌（BM_SUMMARY_INGEST=false）", async () => {
  const { c, dispose } = await bootSeeded({ BM_SUMMARY_INGEST: "false" });
  try {
    const { jobId } = await c.orchestrator.startJob({ idempotencyKey: "k_sum_off", spec: { brief: BRIEF } }, ctx);
    await waitDone(c, jobId);
    const n = c.repos.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kb_chunks WHERE source_id = ?", SUMMARY_SOURCE_ID);
    assert.equal(n!.n, 0, "开关关闭时不得回灌");
  } finally {
    dispose();
  }
});

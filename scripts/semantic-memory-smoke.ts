#!/usr/bin/env tsx
/**
 * 语义记忆库真实联通性检查（EmbeddingGemma 2 + Milvus）
 *
 * ── 它解决什么问题 ────────────────────────────────────────────
 *
 * 单元测试会把 fetch 打桩，验证的是"拿到某种响应之后我们怎么处理"，
 * **没有**验证：Milvus 的 REST 路径对不对（是不是 9091）、schema 能不能建起来、
 * 标量过滤表达式能不能真的隔离租户、写入后能不能立刻读到。
 * 这些恰恰是"配置看着没问题但就是不通"的地方，也是踩过的坑所在：
 *
 *   · Milvus 的 RESTful API 在 **19530**，9091 只有健康端点（打过去是 404 page not found）
 *   · 默认 Bounded 一致性下，**刚写入/刚删除的数据可能读不到**（不是 bug，是要用 Strong）
 *   · 租户过滤必须下推到 Milvus 的 filter，否则命中名额会被别的租户挤占且不报错
 *
 * ── 用法 ────────────────────────────────────────────────────
 *
 *   npm run semantic:smoke
 *   npm run semantic:smoke -- --collection=brandsale_smoke
 *
 * 退出码：0 = 全部断言通过；1 = 有失败项。
 *
 * 前置：Milvus 容器已起（infra/milvus），嵌入服务已起（services/embedding-core）。
 */

import { SemanticMemory, SemanticMemoryError } from "@brandsale/knowledge";

const argv = process.argv.slice(2);
const opt = (name: string, dflt = ""): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_beta";

let failed = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed += 1;
};

async function main(): Promise<void> {
  const mem = new SemanticMemory({
    embedUrl: opt("embed-url", process.env.BM_EMBED_URL ?? "http://127.0.0.1:8899/v1/embeddings"),
    milvusUrl: opt("milvus-url", process.env.BM_MILVUS_URI ?? "http://127.0.0.1:19530"),
    collection: opt("collection", "brandsale_smoke"),
    dim: Number(opt("dim", "768")),
    embedModel: "embeddinggemma-2",
    milvusTimeoutMs: 10_000,
  });

  console.log("\n[1] 依赖健康检查");
  const h = await mem.health();
  console.log(`      embed=${h.embed}  milvus=${h.milvus}  dim=${h.dim}  collection=${h.collection}`);
  if (!h.embed || !h.milvus) {
    console.error("\n依赖不可用，先起 Milvus（infra/milvus）与嵌入服务（services/embedding-core）。");
    process.exit(1);
  }
  check("嵌入服务可达", h.embed);
  check("Milvus 可达", h.milvus);

  console.log("\n[2] 建集合（幂等，重复调用应无副作用）");
  const t0 = Date.now();
  await mem.ensureCollection();
  await mem.ensureCollection();
  check("ensureCollection 幂等", true, `${Date.now() - t0}ms`);

  console.log("\n[3] 写入（模拟「每次生成的报告摘要」）");
  // 清掉上一轮残留，保证计数断言可复现
  await mem.removeByDoc("rep_alpha_1").catch(() => undefined);
  await mem.removeByDoc("rep_beta_1").catch(() => undefined);
  await mem.removeByDoc("rep_global_1").catch(() => undefined);

  const tw = Date.now();
  const up = await mem.upsert([
    {
      id: "rep_alpha_1#0",
      docId: "rep_alpha_1",
      tenantId: TENANT_A,
      collection: "KB-2",
      kind: "report_summary",
      sourceId: "report_summary",
      title: "阿尔法品牌 2026Q3 小红书投放复盘",
      text: "小红书美妆赛道：护肤品类以功效测评类内容转化最优，达人层级建议以腰部为主，头部用于声量打底。评论区负面集中在质地偏厚，需在下轮内容中前置回应。",
      publishedAt: "2026-10-01T00:00:00.000Z",
      meta: { jobId: "job_alpha_1", platform: "xiaohongshu" },
    },
    {
      id: "rep_beta_1#0",
      docId: "rep_beta_1",
      tenantId: TENANT_B,
      collection: "KB-2",
      kind: "report_summary",
      sourceId: "report_summary",
      title: "贝塔品牌 2026Q3 抖音直播复盘",
      text: "抖音直播：千川出价以控成本优先，直播间停留时长是转化关键，建议增加福袋频次并前置核心卖点。",
      publishedAt: "2026-10-02T00:00:00.000Z",
      meta: { jobId: "job_beta_1", platform: "douyin" },
    },
    {
      id: "rep_global_1#0",
      docId: "rep_global_1",
      tenantId: "", // 空串 = 全局共享（与 KB-3/KB-4 的约定一致）
      collection: "KB-4",
      kind: "methodology",
      sourceId: "methodology",
      title: "通用方法论：种草内容的信任构建四要素",
      text: "种草内容的方法论：成分透明、真实使用场景、可验证的对比实验、以及评论区即时回应，共同构成信任闭环。",
      publishedAt: "2026-09-15T00:00:00.000Z",
    },
  ]);
  check("写入成功", up.upserted === 3, `upserted=${up.upserted}, ${Date.now() - tw}ms`);

  console.log("\n[4] 检索（查询走 query 前缀，文档走 document 前缀）");
  const ts = Date.now();
  const hits = await mem.search("小红书美妆种草怎么投", { tenantId: TENANT_A, topK: 5, fresh: true });
  console.log(`      返回 ${hits.length} 条，用时 ${Date.now() - ts}ms`);
  for (const hit of hits) console.log(`      ${hit.score.toFixed(4)}  ${hit.title}`);
  check("有命中", hits.length > 0);
  check(
    "语义排序正确（本租户的报告排第一）",
    hits[0]?.docId === "rep_alpha_1",
    `top=${hits[0]?.title ?? "(空)"}`,
  );

  console.log("\n[5] 租户隔离（关键断言）");
  const aHits = await mem.search("复盘", { tenantId: TENANT_A, topK: 20, fresh: true });
  const bHits = await mem.search("复盘", { tenantId: TENANT_B, topK: 20, fresh: true });
  const aIds = aHits.map((x) => x.docId);
  const bIds = bHits.map((x) => x.docId);
  console.log(`      A 可见：${aIds.join(", ")}`);
  console.log(`      B 可见：${bIds.join(", ")}`);
  check("A 看不到 B 的私域报告", !aIds.includes("rep_beta_1"));
  check("B 看不到 A 的私域报告", !bIds.includes("rep_alpha_1"));
  check("两边都能看到全局方法论", aIds.includes("rep_global_1") && bIds.includes("rep_global_1"));

  console.log("\n[6] 幂等（同 id 重复写入不产生重复行）");
  const before = await mem.count({ tenantId: TENANT_A, fresh: true });
  await mem.upsert(
    [
      {
        id: "rep_alpha_1#0",
        docId: "rep_alpha_1",
        tenantId: TENANT_A,
        collection: "KB-2",
        kind: "report_summary",
        text: "小红书美妆赛道：内容以功效测评类转化最优（第二版，已更新）。",
      },
    ],
    { verify: true },
  );
  const after = await mem.count({ tenantId: TENANT_A, fresh: true });
  check("重复写入不增行", after === before, `before=${before} after=${after}`);

  console.log("\n[7] 删除");
  const del = await mem.removeByDoc("rep_alpha_1");
  // 用 Strong 读才能立刻看到删除效果；Bounded 下这里会"删了还查得到"。
  // 注意 count(tenantId) 数的是**该租户可见**的行（本租户 + 全局），
  // 所以删掉 1 条私域记录后应剩 before-1（那条全局方法论仍在）。
  const remain = await mem.count({ tenantId: TENANT_A, fresh: true });
  const stillThere = await mem.search("小红书美妆种草", { tenantId: TENANT_A, topK: 20, fresh: true });
  check(
    "删除生效",
    del.deleted >= 1 && remain === before - 1 && !stillThere.some((x) => x.docId === "rep_alpha_1"),
    `deleted=${del.deleted}, 剩余=${remain}（期望 ${before - 1}）`,
  );

  console.log("\n[8] 降级路径（不可达的 Milvus 不应抛错）");
  const broken = new SemanticMemory({
    embedUrl: opt("embed-url", "http://127.0.0.1:8899/v1/embeddings"),
    milvusUrl: "http://127.0.0.1:1", // 故意打不通
    collection: "brandsale_smoke",
    milvusTimeoutMs: 1_500,
  });
  const brokenResult = await broken.trySearch("任意查询", { tenantId: TENANT_A });
  check(
    "trySearch 不抛错且标记 degraded",
    brokenResult.hits.length === 0 && Boolean(brokenResult.degraded),
    brokenResult.degraded?.note.slice(0, 60) ?? "(无 degraded)",
  );

  console.log("\n[9] 清理");
  await mem.dropCollection();
  check("集合已删除", true);

  console.log(failed === 0 ? "\n全部通过 ✓\n" : `\n有 ${failed} 项失败 ✗\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  if (e instanceof SemanticMemoryError) {
    console.error(`\n失败（${e.code}）：${e.message}\n`);
  } else {
    console.error("\n未预期的错误：", e);
  }
  process.exit(1);
});

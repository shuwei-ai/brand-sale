#!/usr/bin/env tsx
/**
 * 语义检索端到端演示：写一段文本 → 进向量数据库 → 再查出来
 *
 * 与 `semantic:smoke` 的区别：smoke 是"断言清单"（看红绿），
 * 这个脚本是"证据演示"（看数字）。它刻意回答三个问题：
 *
 *   1. 嵌入模型是不是真的？—— 直连 /v1/embeddings，打印真实向量与维度
 *   2. 数据是不是真的进了向量库？—— 建集合、写入，再直接数 Milvus 里的行
 *   3. 检索是不是"语义"而不是"关键词"？—— 用**字面几乎不重合**的查询，
 *      看它能不能命中那条正确的文档，并且分数明显高于无关文档
 *
 * 用法：npm run vector:demo
 * 前置：Milvus（npm run milvus:up）与嵌入服务（npm run embedding:up）已起。
 */

import { SemanticMemory } from "@brandsale/knowledge";

const EMBED_URL = process.env.BM_EMBED_URL || "http://127.0.0.1:8899/v1/embeddings";
const MILVUS_URL = process.env.BM_MILVUS_URI || "http://127.0.0.1:19530";
const COLLECTION = `brandsale_demo_${Date.now().toString(36)}`; // 独立集合，跑完即删，不污染线上语料
const TENANT = "tenant_demo";
const DIM = Number(process.env.BM_EMBED_DIM ?? 768);
const EMBED_API_KEY = process.env.BM_EMBED_API_KEY ?? "";
/** auto：有 Key 按云端 openai 方言（只发 model+input），无 Key 按本地内核（带 input_type） */
const EMBED_DIALECT: "embeddinggemma" | "openai" =
  process.env.BM_EMBED_DIALECT === "openai" || process.env.BM_EMBED_DIALECT === "embeddinggemma"
    ? process.env.BM_EMBED_DIALECT
    : EMBED_API_KEY
      ? "openai"
      : "embeddinggemma";

const line = (s = ""): void => console.log(s);
const head = (s: string): void => console.log(`\n${"─".repeat(4)} ${s} ${"─".repeat(Math.max(0, 56 - s.length))}`);

/* 语料：都是品牌营销领域里"像真的"的句子，故意让它们彼此可区分 */
const CORPUS = [
  {
    id: "doc_hr",
    title: "赫莲娜黑绷带面霜 KOL 策略",
    text: "赫莲娜黑绷带面霜主打玻色因抗老，客单价高，适合走小红书腰部达人的成分党内容，头部用于声量打底。",
  },
  {
    id: "doc_swk",
    title: "施华蔻双十一洗护促销",
    text: "施华蔻双十一洗护套装促销，抖音直播间用福袋拉停留，主推 99 元客单的组合装，配合千川控成本出价。",
  },
  {
    id: "doc_lancome",
    title: "兰蔻菁纯精华客群分析",
    text: "兰蔻菁纯精华的核心客群是 30+ 女性，购买决策高度依赖评论区的真实使用反馈，需要维护口碑而非单纯投放。",
  },
  {
    id: "doc_estee",
    title: "雅诗兰黛小棕瓶内容方向",
    text: "雅诗兰黛小棕瓶在 B站的科技区测评内容转化优于纯种草，建议与成分解析类 UP 主合作。",
  },
  {
    id: "doc_supply",
    title: "供应链库存周转",
    text: "供应链管理中的库存周转率优化，核心是缩短在途时间与提升预测准确度。",
  },
];

/* 三组查询：每组都刻意"少用原词"，验证是语义匹配而非字符串命中。
 *
 * `expect` 是**可接受集合**而不是单条：真实检索里，近义查询本来就会同时命中
 * 多条语义相近的文档。第一组就是活例子——"给高端护肤品找讲成分的博主"
 * 同时贴近「赫莲娜：玻色因抗老 + 找成分党达人」与「雅诗兰黛：找成分解析类 UP 主」，
 * 两条讲的都是"该选哪类内容创作者讲成分"，模型给出 0.76 / 0.75 的并列分是**正确行为**，
 * 说明它认的是语义而不是"面霜"这个词面。用单条期望反而是用例设计有误。
 */
const QUERIES: { q: string; accept: string[]; why: string }[] = [
  {
    q: "预算有限，怎么给高端护肤品找能讲成分的博主？",
    accept: ["doc_hr", "doc_estee"],
    why: "查询用「护肤品/博主/讲成分」，原文用「面霜/达人/成分党」「UP 主/成分解析」，字面几乎不重合；两条都相关",
  },
  {
    q: "大促期间怎么用直播间抽奖把人留在房间里更久？",
    accept: ["doc_swk"],
    why: "查询用「抽奖/留在房间」，原文用「福袋/停留」，唯一共同实词只有「直播间」",
  },
  {
    q: "怎么看一个精华产品的买家真实反馈好不好",
    accept: ["doc_lancome"],
    why: "查询「精华/买家真实反馈」对齐原文「精华/评论区真实使用反馈」",
  },
];

async function main(): Promise<void> {
  line("语义检索端到端演示");
  line(`  嵌入服务 ${EMBED_URL}`);
  line(`  Milvus   ${MILVUS_URL}`);
  line(`  集合     ${COLLECTION}（跑完自动删除）`);

  /* ── 1. 嵌入模型是真的吗 ─────────────────────────────── */
  head("[1] 嵌入模型实测");
  const probe = "赫莲娜黑绷带面霜的抗老成分";
  const t0 = Date.now();
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(EMBED_API_KEY ? { Authorization: `Bearer ${EMBED_API_KEY}` } : {}),
    },
    // 云端 openai 方言不认 input_type / dimensions（严格网关会 400）
    body: JSON.stringify(
      EMBED_DIALECT === "openai"
        ? { model: process.env.BM_EMBED_MODEL ?? undefined, input: [probe] }
        : { input: [probe], input_type: "query", dimensions: DIM },
    ),
  });
  if (!res.ok) throw new Error(`嵌入服务返回 HTTP ${res.status}`);
  const body = (await res.json()) as { data: { embedding: number[] }[]; model?: string; meta?: Record<string, unknown> };
  const vec = body.data[0]!.embedding;
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  line(`  文本     「${probe}」`);
  line(`  模型     ${body.model ?? "(未标注)"}   用时 ${Date.now() - t0}ms`);
  line(`  维度     ${vec.length}`);
  line(`  L2 范数  ${norm.toFixed(4)}（约等于 1 说明已归一化）`);
  line(`  前 8 维  [${vec.slice(0, 8).map((x) => x.toFixed(4)).join(", ")}]`);

  /* ── 2. 写进向量数据库 ───────────────────────────────── */
  head("[2] 写入向量数据库");
  const mem = new SemanticMemory({
    embedUrl: EMBED_URL,
    milvusUrl: MILVUS_URL,
    collection: COLLECTION,
    dim: DIM,
    embedModel: process.env.BM_EMBED_MODEL ?? "embeddinggemma-2",
    ...(process.env.BM_EMBED_API_KEY ? { embedApiKey: process.env.BM_EMBED_API_KEY } : {}),
    ...(process.env.BM_EMBED_DIALECT ? { embedDialect: process.env.BM_EMBED_DIALECT as "auto" | "openai" | "embeddinggemma" } : {}),
    milvusTimeoutMs: 10_000,
  });
  const health = await mem.health();
  line(`  依赖健康 embed=${health.embed}  milvus=${health.milvus}  dim=${health.dim}`);
  if (!health.embed || !health.milvus) throw new Error("依赖不可用：请先起 Milvus 与嵌入服务");

  await mem.ensureCollection();
  const tw = Date.now();
  const up = await mem.upsert(
    CORPUS.map((c) => ({
      id: `${c.id}#0`,
      docId: c.id,
      tenantId: TENANT,
      collection: "KB-2",
      kind: "report_summary",
      sourceId: "report_summary",
      title: c.title,
      text: c.text,
      publishedAt: new Date().toISOString(),
    })),
  );
  line(`  写入 ${up.upserted} 条，用时 ${Date.now() - tw}ms`);

  /* ── 3. 直接看向量库：数据真的在库里吗 ───────────────── */
  head("[3] 回查向量库（证明数据落库）");
  const cnt = await mem.count({ tenantId: TENANT, fresh: true }); // fresh=Strong 一致性，绕开 Bounded 延迟
  line(`  集合内本租户可见行数：${cnt}（期望 ${CORPUS.length}）`);
  // 绕开封装，直接打 Milvus REST 看原始一行
  const raw = await fetch(`${MILVUS_URL}/v2/vectordb/entities/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      collectionName: COLLECTION,
      filter: `doc_id == "doc_hr"`,
      outputFields: ["id", "doc_id", "title", "text", "embed_model"],
      limit: 1,
    }),
  });
  const rawBody = (await raw.json()) as { data?: Record<string, unknown>[] };
  const row = rawBody.data?.[0];
  line(`  直查 Milvus 原始行：${row ? JSON.stringify({ ...row, text: String(row.text).slice(0, 24) + "…" }) : "(未取到)"}`);

  /* ── 4. 语义检索：字面不重合，看能不能命中 ───────────── */
  head("[4] 语义检索（查询刻意不用原文的词）");
  let pass = 0;
  for (const { q, accept, why } of QUERIES) {
    const ts = Date.now();
    const hits = await mem.search(q, { tenantId: TENANT, topK: 3, fresh: true });
    // 判据：可接受文档出现在 top-2 内。用 top-2 而不是 top-1，是因为近义查询
    // 命中多条语义相近的文档本身是正确行为（见 QUERIES 注释）。
    const ok = hits.slice(0, 2).some((h) => accept.includes(h.docId ?? ""));
    if (ok) pass += 1;
    line(`\n  查询「${q}」`);
    line(`  依据  ${why}`);
    for (const h of hits) {
      const mark = accept.includes(h.docId ?? "") ? "◀ 可接受" : "";
      line(`    ${h.score.toFixed(4)}  ${h.title}  ${mark}`);
    }
    line(`  结论  ${ok ? "✓ 期望文档在 top-2 内" : `✗ 期望 ${accept.join("/")}，实际 ${hits.map((h) => h.docId).slice(0, 2).join("/")}`}   (${Date.now() - ts}ms)`);
  }

  /* ── 5. 语义 vs 无关：分数要拉开差距 ─────────────────── */
  head("[5] 语义相关性对照");
  const probeQ = "预算有限，怎么给高端护肤品找能讲成分的博主？";
  const all = await mem.search(probeQ, { tenantId: TENANT, topK: 10, fresh: true });
  const rel = all.find((h) => h.docId === "doc_hr")?.score ?? 0;
  const irr = all.find((h) => h.docId === "doc_supply")?.score ?? 0;
  line(`  与查询相关（赫莲娜面霜）：${rel.toFixed(4)}`);
  line(`  与查询无关（库存周转）：${irr.toFixed(4)}`);
  line(`  差值：${(rel - irr).toFixed(4)}  ${rel > irr ? "✓ 相关项明显更高" : "✗ 未能区分"}`);

  /* ── 6. 清理 ─────────────────────────────────────────── */
  head("[6] 清理演示集合");
  await mem.dropCollection();
  line(`  已删除 ${COLLECTION}`);

  const okAll = pass === QUERIES.length && rel > irr;
  line(`\n${okAll ? "全部通过 ✓" : "存在失败项 ✗"}  语义检索命中 ${pass}/${QUERIES.length}\n`);
  process.exit(okAll ? 0 : 1);
}

main().catch((e) => {
  console.error("\n失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});

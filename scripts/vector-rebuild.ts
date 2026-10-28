#!/usr/bin/env tsx
/**
 * 重建外部向量索引（Milvus）—— `npm run vector:rebuild`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个脚本存在的唯一理由：**SQLite 是唯一真相源，Milvus 必须可重建**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一旦承认"Milvus 只是索引"，就必须有一个"从真相源重建索引"的动作，
 * 否则双写不一致（进程被杀、Milvus 短暂不可用、换了嵌入模型）会永久留在库里。
 * 有了它，下面这些场景都有确定解法：
 *   · 删掉 Milvus 数据卷 → 跑本脚本，一切恢复；
 *   · 换了嵌入模型 / 维度 → `--reset` 重建（旧向量与新向量不在同一空间）；
 *   · 怀疑索引与库不一致 → 直接跑，upsert 幂等，重复执行无副作用。
 *
 * 用法：
 *   npm run vector:rebuild            # 按 SQLite 全量 upsert（幂等）
 *   npm run vector:rebuild -- --reset # 先 drop collection 再重建（换模型时用）
 *   npm run vector:rebuild -- --batch=200
 *
 * 退出码：0 成功；1 失败（配置/连接问题）。
 * 前置：Milvus 已起（`npm run milvus:up`）+ 嵌入服务已起（`npm run embedding:up`），
 *       且 `BM_VECTOR_DRIVER=milvus`、`BM_EMBED_URL` 非空。
 */

import { loadConfig } from "@brandsale/config";
import { MilvusVectorIndex } from "@brandsale/knowledge";
import { migrate, openDb } from "@brandsale/storage";

const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string, dflt: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

interface ChunkRow {
  chunk_id: string;
  doc_id: string;
  collection: string;
  tenant_id: string | null;
  text: string;
  source_id: string;
  published_at: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const r = config.retrieval;

  if (!r.embedUrl) {
    console.error("BM_EMBED_URL 为空：Milvus 里存的必须是模型向量，请先配置嵌入服务（npm run embedding:up）");
    process.exit(1);
  }

  const index = new MilvusVectorIndex({
    milvusUrl: r.milvusUri,
    collection: r.milvusCollection,
    ...(r.milvusToken ? { token: r.milvusToken } : {}),
    timeoutMs: Math.max(r.milvusTimeoutMs, 10_000), // 批量重建允许比在线检索更慢
    embedUrl: r.embedUrl,
    embedModel: r.embedModel,
    embedDim: r.embedDim,
    embedTimeoutMs: r.embedTimeoutMs,
    ...(r.embedApiKey ? { embedApiKey: r.embedApiKey } : {}),
    ...(r.embedDialect ? { embedDialect: r.embedDialect } : {}),
  });

  const db = openDb(config.storage.sqlitePath);
  migrate(db);
  try {
    const health = await index.raw().health();
    console.log(`[1] 依赖健康：embed=${health.embed} milvus=${health.milvus} dim=${health.dim} collection=${health.collection}`);
    if (!health.embed || !health.milvus) {
      console.error("依赖不可用。先起 Milvus（npm run milvus:up）与嵌入服务（npm run embedding:up）。");
      process.exit(1);
    }

    if (hasFlag("reset")) {
      console.log("[2] --reset：删除 collection（旧向量可能是别的模型产的，不能与新的混在一起）");
      // 集合不存在时 drop 会报错，这属于"本来就没有"的正常情形，忽略即可。
      await index.raw().dropCollection().catch(() => undefined);
    }

    // 显式建集合：库为空（rows=0，例如首次部署或全 demo 语料）时下面的 upsert 循环
    // 一次都不会执行，集合就永远不会被创建 —— 那时检索侧会以为"Milvus 里没数据"。
    await index.raw().ensureCollection();

    const rows = db.all<ChunkRow>(
      // 与检索口径一致：demo 语料不进索引（它在检索侧本来就被过滤掉）
      "SELECT chunk_id, doc_id, collection, tenant_id, text, source_id, published_at FROM kb_chunks WHERE COALESCE(provenance,'unknown') <> 'demo'",
    );
    console.log(`[3] 待重建 chunk：${rows.length} 条`);

    const batch = Math.max(1, Number(opt("batch", "64")));
    let done = 0;
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      await index.upsert(
        slice.map((c) => ({
          id: c.chunk_id,
          text: c.text,
          tenantId: c.tenant_id ?? "",
          docId: c.doc_id,
          collection: c.collection,
          sourceId: c.source_id,
          publishedAt: c.published_at,
          kind: "kb_chunk",
        })),
      );
      done += slice.length;
      process.stdout.write(`\r    写入 ${done}/${rows.length}`);
    }
    process.stdout.write("\n");

    const total = await index.raw().count({ fresh: true });
    console.log(`[4] collection 现有记录：${total}`);
    console.log("\n重建完成 ✓（SQLite 仍是唯一真相源；这个索引随时可以再删掉重建）\n");
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error("\n重建失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});

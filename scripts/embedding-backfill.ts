#!/usr/bin/env tsx
/**
 * 存量语料的向量补算（P2）—— `npm run embedding:backfill`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 向量在**写入时**落盘（见 knowledge/retrieval.ts 的 writeChunks）。但两种情况下
 * 库里的行会没有可用的向量：
 *   · 这些行是本次改动**之前**写入的（历史数据，从来没有 vec 列）；
 *   · 写入时嵌入服务不可用（`embedded` 会如实报小于 chunks 的数）。
 *
 * 不补算的后果不是报错，而是"语义通道对这些行静默失效"：它们只能靠 BM25 被召回，
 * 而检索看起来完全正常。这个脚本就是把它们补齐。
 *
 * 它也负责**换模型后的重算**：只比较同 `embed_model` 的向量是硬规则，
 * 所以换嵌入服务后旧向量不会参与比较——必须用这个脚本（或重新入库）刷新。
 *
 * 用法：
 *   npm run embedding:backfill                # 只补缺失 / 模型不符的行
 *   npm run embedding:backfill -- --force     # 全部重算（换模型后建议）
 *   npm run embedding:backfill -- --batch=32  # 每批条数（默认取 BM_EMBED_BATCH_SIZE）
 *
 * 退出码：0 成功；1 失败（配置问题）。
 */

import { loadConfig } from "@brandsale/config";
import { embeddingProviderFromConfig, providerKind, vectorToBlob } from "@brandsale/knowledge";
import { migrate, openDb } from "@brandsale/storage";

const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string, dflt: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

interface Row {
  chunk_id: string;
  text: string;
  vec: Uint8Array | null;
  embed_model: string | null;
  embed_dim: number | null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = embeddingProviderFromConfig(config.retrieval);
  const db = openDb(config.storage.sqlitePath);
  migrate(db); // 脚本自迁移：vec 列由 M4 引入，别让运维先手动跑一次

  try {
    console.log(`[1] 向量来源：${providerKind(provider)}  model=${provider.model} dim=${provider.dim}`);

    const all = db.all<Row>("SELECT chunk_id, text, vec, embed_model, embed_dim FROM kb_chunks WHERE COALESCE(provenance,'unknown') <> 'demo'");
    const todo = hasFlag("force")
      ? all
      : all.filter((r) => !r.vec || r.embed_model !== provider.model || r.embed_dim !== provider.dim);

    console.log(`[2] 语料 ${all.length} 条，需要补算 ${todo.length} 条${hasFlag("force") ? "（--force 全量重算）" : ""}`);
    if (todo.length === 0) {
      console.log("\n无需补算 ✓\n");
      return;
    }

    const batch = Math.max(1, Number(opt("batch", String(config.retrieval.embedBatchSize))));
    let done = 0;
    for (let i = 0; i < todo.length; i += batch) {
      const slice = todo.slice(i, i + batch);
      // 文档侧前缀（input_type=document）。查询侧用 query 前缀，两者不可混用。
      const vectors = await provider.embed(slice.map((r) => r.text), { inputType: "document" });

      // 单事务批量更新：要么这批全写好，要么全不写（避免半批新、半批旧）
      db.tx(() => {
        for (let j = 0; j < slice.length; j++) {
          const v = vectors[j];
          if (!v) continue;
          db.run(
            "UPDATE kb_chunks SET vec = ?, embed_model = ?, embed_dim = ? WHERE chunk_id = ?",
            vectorToBlob(v),
            provider.model,
            provider.dim,
            slice[j]!.chunk_id,
          );
        }
      });
      done += slice.length;
      process.stdout.write(`\r    补算 ${done}/${todo.length}`);
    }
    process.stdout.write("\n");

    const left = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM kb_chunks WHERE (vec IS NULL OR embed_model IS NOT ? OR embed_dim IS NOT ?) AND COALESCE(provenance,'unknown') <> 'demo'",
      provider.model,
      provider.dim,
    );
    console.log(`[3] 仍缺向量的行：${left!.n}（0 = 已全部补齐）`);
    console.log("\n补算完成 ✓\n");
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error("\n补算失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});

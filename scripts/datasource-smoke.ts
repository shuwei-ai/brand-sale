#!/usr/bin/env tsx
/**
 * 外部数据源真实联通性检查
 *
 * ── 它解决什么问题 ────────────────────────────────────────────
 *
 * 单元测试全部打桩 `globalThis.fetch`，所以它们验证的是"拿到某种响应之后我们怎么处理"，
 * **没有**验证 URL 拼接、query 编码、鉴权头、真实响应结构是否被正确解开。
 * 这一层恰恰是最容易在"配置看起来没问题但就是不通"时出问题的地方。
 *
 * 这个脚本对每个**已配置**的源真发一次请求，把结果、耗时、provenance 打出来。
 *
 * ── 它不是什么 ───────────────────────────────────────────────
 *
 * 它**绕过闸门**（直接拿适配器），因为这是运维诊断工具，不是业务调用。
 * 因此它产出的任何数字都不得进入报告 —— 合规检查由闸门负责，这里只管"通不通"。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *
 *   npm run datasource:smoke
 *   npm run datasource:smoke -- --douyin-sec-user-id=MS4wLjABAAAA...
 *   npm run datasource:smoke -- --xhs-note-url='https://www.xiaohongshu.com/explore/xxx?xsec_token=yyy'
 *
 * 退出码：0 = 所有已配置的源都通；1 = 有源不通；未配置的源只提示、不算失败。
 */

import { loadConfig, type Config } from "@brandsale/config";
import { migrate, openDb } from "@brandsale/storage";
import {
  createRegistry,
  DOUYIN_WEB_SOURCE_ID,
  WEB_SEARCH_SOURCE_ID,
  XHS_WEB_SOURCE_ID,
} from "@brandsale/datasource";

const argv = process.argv.slice(2);
const opt = (name: string, dflt = ""): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const config: Config = loadConfig();

interface Probe {
  sourceId: string;
  label: string;
  /** 未配置时该填哪个环境变量 */
  envHint: string;
  params: Record<string, unknown>;
  /** 探针参数本身是占位值时的提示 */
  caveat?: string;
}

const probes: Probe[] = [
  {
    sourceId: WEB_SEARCH_SOURCE_ID,
    label: "联网搜索（公开网页）",
    envHint: "BM_WEB_SEARCH_API_KEY",
    params: { query: opt("query", "美妆 精华 类目趋势 2026") },
  },
  {
    sourceId: DOUYIN_WEB_SOURCE_ID,
    label: "抖音公开内容（自托管采集）",
    envHint: "BM_DOUYIN_BASE_URL",
    params: { op: "profile", secUserId: opt("douyin-sec-user-id", "MS4wLjABAAAA_demo_1001") },
    caveat: opt("douyin-sec-user-id") ? undefined : "用的是示例 sec_user_id，真实环境下请传入实际 ID",
  },
  {
    sourceId: XHS_WEB_SOURCE_ID,
    label: "小红书公开内容（自托管只读代理）",
    envHint: "BM_XHS_BASE_URL",
    params: { op: "note", noteId: opt("xhs-note-id", "demo_note_1") },
    caveat: opt("xhs-note-id") || opt("xhs-note-url") ? undefined : "用的是示例 note_id，真实环境下建议传完整笔记 URL",
  },
];
// 传了 URL 就优先用 URL（真实 CLI 从 URL 里提取 xsec_token 命中率更高）
const xhsNoteUrl = opt("xhs-note-url");
if (xhsNoteUrl) {
  const p = probes[2];
  if (p) p.params = { op: "note", url: xhsNoteUrl };
}

// 内存库：只是为了满足 withCache 的依赖，不落盘、不污染 ./data
const db = openDb(":memory:");
migrate(db);
const registry = createRegistry(db, config);

console.log("外部数据源真实联通性检查");
console.log(`  数据目录：${config.storage.sqlitePath}`);
console.log(`  已注册适配器：${registry.list().map((a) => a.sourceId).join("、") || "（无）"}`);
console.log("");

let failed = 0;
let checked = 0;

for (const probe of probes) {
  const adapter = registry.get(probe.sourceId);
  if (!adapter) {
    console.log(`○ ${probe.label}`);
    console.log(`    未配置，跳过 —— 需要设置 ${probe.envHint}（本地联调可先跑 npm run datasource:lab）`);
    console.log("");
    continue;
  }

  checked++;
  const t0 = Date.now();
  try {
    const res = await adapter.fetch(
      { tenantId: "smoke", jobId: "smoke", params: probe.params },
      config,
    );
    const ms = Date.now() - t0;
    console.log(`● ${probe.label}`);
    console.log(`    通  ${res.rows.length} 行 / ${ms}ms / tier=${res.provenance.tier} / synthetic=${res.provenance.synthetic}`);
    console.log(`    口径：${res.provenance.note}`);
    if (probe.caveat) console.log(`    提示：${probe.caveat}`);
    if (res.provenance.synthetic) {
      console.log("    ⚠️  synthetic=true 说明这是**联调假数据**，不可用于任何正式结论");
    }
    const sample = res.rows[0];
    if (sample) console.log(`    样例：${JSON.stringify(sample).slice(0, 220)}`);
    console.log("");
  } catch (e) {
    failed++;
    const ms = Date.now() - t0;
    console.log(`✗ ${probe.label}`);
    console.log(`    失败（${ms}ms）：${e instanceof Error ? e.message : String(e)}`);
    console.log("");
  }
}

db.close();

if (checked === 0) {
  console.log("没有任何已配置的外部源 —— 三个源当前都缺席。填好 .env 后重跑本检查。");
  process.exit(0);
}

console.log(failed === 0 ? `✅ ${checked} 个已配置的源全部连通。` : `❌ ${failed}/${checked} 个已配置的源不通。`);
process.exit(failed === 0 ? 0 : 1);

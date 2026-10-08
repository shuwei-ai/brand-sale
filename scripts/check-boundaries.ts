/**
 * 架构边界检查（LLD §7.1）
 *
 * 为什么需要它：
 *   分层架构最大的风险不是"写错"，而是"慢慢写歪"——某天有人在 render 里
 *   直接 import 了 storage 去查一条数据，代码照样能跑，但 M16 渲染层
 *   从此不再是纯函数，可测试性与"渲染层无数据访问"这条合规约束同时失效。
 *   这类退化不会报错，只会累积，所以必须由 CI 卡住。
 *
 * 检查三件事：
 *   ① 白名单：每个包只允许依赖矩阵里列出的包（多一个就失败）
 *   ② 零依赖约束：contracts / config 必须是叶子，不得依赖任何业务包
 *   ③ 环检测：实际依赖图不得有环
 *
 * 运行：npm run check:boundaries
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 依赖矩阵：key 只允许依赖 value 中的包（不含自身） */
const MATRIX: Record<string, string[]> = {
  // ── L0 契约层：纯类型 + 纯函数，必须零依赖 ──
  "@brandsale/contracts": [],
  "@brandsale/config": [],

  // ── L1 基础设施：只依赖契约 ──
  "@brandsale/storage": ["@brandsale/contracts", "@brandsale/config"],
  "@brandsale/render": ["@brandsale/contracts", "@brandsale/config"],
  "@brandsale/model-gateway": ["@brandsale/contracts", "@brandsale/config", "@brandsale/storage"],
  "@brandsale/knowledge": ["@brandsale/contracts", "@brandsale/config", "@brandsale/storage"],
  "@brandsale/datasource": ["@brandsale/contracts", "@brandsale/config", "@brandsale/storage"],

  // ── L2 领域能力：可依赖 L1，但不得依赖编排层 ──
  "@brandsale/governance": ["@brandsale/contracts", "@brandsale/config", "@brandsale/storage"],
  "@brandsale/agent-pack": [
    "@brandsale/contracts",
    "@brandsale/config",
    "@brandsale/storage",
    "@brandsale/governance",
    "@brandsale/knowledge",
    "@brandsale/model-gateway",
    "@brandsale/datasource",
  ],

  // ── L3 编排层：唯一可以同时看见 agent-pack 与 render 的层 ──
  "@brandsale/orchestrator": [
    "@brandsale/contracts",
    "@brandsale/config",
    "@brandsale/storage",
    "@brandsale/agent-pack",
    "@brandsale/render",
  ],
};

/** 叶子包：任何其它包都不得被它们依赖，且它们自己不得依赖业务包 */
const LEAF_PACKAGES = ["@brandsale/contracts", "@brandsale/config"];

/** 只有应用层可以依赖全部；包之间出现这些依赖一律视为反向依赖 */
const HIGH_LEVEL = ["@brandsale/orchestrator", "@brandsale/agent-pack"];

interface Violation {
  kind: "whitelist" | "leaf" | "reverse" | "cycle" | "self";
  from: string;
  to: string;
  file: string;
  line: number;
  detail: string;
}

const violations: Violation[] = [];

/* ── 收集源码文件 ─────────────────────────────────────────── */

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

/** 扫描一个目录下所有 `@brandsale/*` 导入 */
function scanImports(dir: string): { pkg: string; file: string; line: number }[] {
  const found: { pkg: string; file: string; line: number }[] = [];
  for (const file of walk(dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const m of text.matchAll(/["'](@brandsale\/[a-z0-9-]+)(?:\/[^"']*)?["']/g)) {
        found.push({ pkg: m[1]!, file, line: i + 1 });
      }
    });
  }
  return found;
}

/* ── 执行检查 ─────────────────────────────────────────────── */

const packageDirs: { name: string; dir: string; isApp: boolean }[] = [];

for (const group of ["packages", "apps"]) {
  const base = join(ROOT, group);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    if (!statSync(dir).isDirectory()) continue;
    const pkgJson = join(dir, "package.json");
    if (!existsSync(pkgJson)) continue;
    const json = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string };
    packageDirs.push({ name: json.name ?? name, dir, isApp: group === "apps" });
  }
}

/** 实际依赖图（用于环检测） */
const graph = new Map<string, Set<string>>();

for (const p of packageDirs) {
  const imports = scanImports(join(p.dir, "src"));
  const deps = new Set<string>();

  for (const imp of imports) {
    if (imp.pkg === p.name) {
      // 自引用（例如 `@brandsale/render` 里 import 自己的类型）是允许的，
      // 但混用相对路径与包名会造成同一模块被加载两次，这里提示一句。
      continue;
    }
    deps.add(imp.pkg);

    if (p.isApp) continue; // 应用层允许依赖全部

    const allowed = MATRIX[p.name];
    if (!allowed) {
      violations.push({
        kind: "whitelist",
        from: p.name,
        to: imp.pkg,
        file: imp.file.replace(ROOT + "/", ""),
        line: imp.line,
        detail: `包 ${p.name} 未在依赖矩阵中声明，请在 scripts/check-boundaries.ts 补充规则`,
      });
      continue;
    }

    if (!allowed.includes(imp.pkg)) {
      violations.push({
        kind: "whitelist",
        from: p.name,
        to: imp.pkg,
        file: imp.file.replace(ROOT + "/", ""),
        line: imp.line,
        detail: `${p.name} 不允许依赖 ${imp.pkg}（白名单：${allowed.join(", ") || "无"}）`,
      });
    }
  }

  // 零依赖约束
  if (LEAF_PACKAGES.includes(p.name)) {
    for (const dep of deps) {
      violations.push({
        kind: "leaf",
        from: p.name,
        to: dep,
        file: p.dir.replace(ROOT + "/", ""),
        line: 0,
        detail: `${p.name} 是叶子包，必须零业务依赖，却引用了 ${dep}`,
      });
    }
  }

  // 反向依赖：L1/L2 不得依赖 L3
  if (!HIGH_LEVEL.includes(p.name) && !p.isApp) {
    for (const dep of deps) {
      if (HIGH_LEVEL.includes(dep)) {
        violations.push({
          kind: "reverse",
          from: p.name,
          to: dep,
          file: p.dir.replace(ROOT + "/", ""),
          line: 0,
          detail: `反向依赖：${p.name}（低层）不得依赖 ${dep}（高层）`,
        });
      }
    }
  }

  graph.set(p.name, deps);
}

/* ── 环检测（DFS） ────────────────────────────────────────── */

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map<string, number>();
const stack: string[] = [];

function dfs(node: string): void {
  color.set(node, GRAY);
  stack.push(node);
  for (const next of graph.get(node) ?? []) {
    if (!graph.has(next)) continue; // 外部包不在本次扫描范围内
    const c = color.get(next) ?? WHITE;
    if (c === GRAY) {
      const cycle = [...stack.slice(stack.indexOf(next)), next].join(" → ");
      violations.push({
        kind: "cycle",
        from: node,
        to: next,
        file: "—",
        line: 0,
        detail: `检测到循环依赖：${cycle}`,
      });
    } else if (c === WHITE) {
      dfs(next);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}

for (const node of graph.keys()) if ((color.get(node) ?? WHITE) === WHITE) dfs(node);

/* ── 输出 ─────────────────────────────────────────────────── */

const ICON: Record<Violation["kind"], string> = {
  whitelist: "⛔ 越界依赖",
  leaf: "⛔ 叶子包被污染",
  reverse: "⛔ 反向依赖",
  cycle: "⛔ 循环依赖",
  self: "⚠️  自引用",
};

console.log("架构边界检查（LLD §7.1）");
console.log(`  扫描包：${packageDirs.length} 个（${packageDirs.filter((p) => p.isApp).length} 个应用）`);
console.log(
  `  依赖边：${[...graph.values()].reduce((n, s) => n + s.size, 0)} 条\n`,
);

for (const p of packageDirs) {
  const deps = [...(graph.get(p.name) ?? [])].sort();
  console.log(`  ${p.name.padEnd(28)} → ${deps.length ? deps.join(", ") : "（无）"}`);
}

console.log();
if (violations.length === 0) {
  console.log("✅ 边界检查通过：无越界、无反向依赖、无环。");
  process.exit(0);
}

console.log(`❌ 发现 ${violations.length} 处边界问题：\n`);
for (const v of violations) {
  console.log(`  ${ICON[v.kind]}  ${v.from} → ${v.to}`);
  console.log(`      ${v.detail}`);
  if (v.line > 0) console.log(`      位置：${v.file}:${v.line}`);
  console.log();
}
process.exit(1);

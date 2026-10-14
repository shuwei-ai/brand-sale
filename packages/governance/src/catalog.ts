/**
 * 来源目录组装（P0-2）
 *
 * 为什么放在 governance 而不是 render：
 *   依赖矩阵里 `render` 只能依赖 `contracts + config`，渲染层必须保持「无数据访问」。
 *   目录一旦在 render 里查库，`npm run check:boundaries` 会当场红——
 *   这正是边界检查存在的意义。
 *
 * 为什么目录要合三类来源：
 *   1) 台账源（sources 表）：外部适配器，走闸门授权，只有生效授权 + 非 L4 未批的才能进；
 *   2) 本地 KB 语料源（public_intel / internal_review / methodology）：
 *      **它们不在 sources 表里**（内部语料，不走外部授权）。只查台账的话，
 *      真实合法的 KB 引用反而会被判非法——这是收紧校验最容易踩的坑；
 *   3) 内部数据仓（如达人报价库）：同样是本地私有数据，需要能出现在来源声明里。
 *
 * 目录以**纯数据**形式一路传到 render.compile，渲染层只做集合判定。
 */

import { LOGICAL_REFS, type ComplianceGrade, type EvidenceEntry, type SourceCatalog, type SourceCatalogEntry } from "@brandsale/contracts";
import type { Repositories } from "@brandsale/storage";

/** 本地 KB 语料的展示名与分级（seed.ts 里写入的 sourceId 就是这几个） */
const KB_DISPLAY: Record<string, string> = {
  public_intel: "行业公开情报库（KB-3）",
  internal_review: "历史执行与私域知识库（KB-2）",
  methodology: "方法论与案例模板库（KB-4）",
  // 系统自产：报告生成后由 pipeline 机械抽取回灌（见 knowledge/summarize.ts）。
  // 它不是一手数据源，命名上必须让人一眼看出"派生"。
  report_summary: "历史报告摘要（本系统生成）",
};

const KB_GRADE: Record<string, ComplianceGrade> = {
  public_intel: "L3",
  internal_review: "L2",
  methodology: "L2",
  report_summary: "L2",
};

/** 内部数据仓：达人报价库（M8）。数据来自客户授权历史成交，属 L2 私域。 */
export const INTERNAL_CATALOG_SOURCES: { key: string; displayName: string; grade: ComplianceGrade; coverage: string }[] = [
  {
    key: "pricing",
    displayName: "达人报价库",
    grade: "L2",
    coverage: "客户授权历史成交价与刊例记录（M8 报价库）",
  },
];

export interface CatalogDeps {
  repos: Repositories;
  tenantId: string;
  /** 由调用方从知识库取（governance 不反向依赖 knowledge） */
  knowledgeSourceIds?: string[];
  /** 已知 KB chunkId，用于 kb_chunk 引用的存在性校验 */
  chunkIds?: string[];
  /**
   * 本 job 真实登记到的平台采集条目（P0 溯源），用于 platform_entry 引用的存在性校验。
   *
   * 为什么由调用方传入而不是 governance 自己去查：证据表在 agent-pack（工具登记），
   * 且是 job 级内存态；governance 的职责只是把"本次可用的东西"组装成纯数据目录，
   * 它不拥有证据表的生命周期。
   */
  evidenceEntries?: EvidenceEntry[];
  /** 额外内部数据仓 */
  internalSources?: { key: string; displayName: string; grade: ComplianceGrade; coverage?: string }[];
  /**
   * **已装配的**数据源适配器 ID 集合（由调用方从 M4 注册表取）。
   *
   * 为什么台账源还得多这一道：台账登记与"能力是否装配"是两件事。平台采集源会
   * 照常登记进台账（这样 resolve_authorization 能如实报出它们），但适配器要过
   * 许可确认 + collector 配置才会装配。若不在这里过滤，报告会在来源声明里
   * 列出一个"已授权但根本取不到数据"的源——正是早先"残留登记记录导致
   * 可用源列表虚高"那类问题的翻版。
   *
   * 缺省 undefined = 不过滤（保持既有调用方零行为变化）。
   */
  availableSourceIds?: string[];
}

export function buildSourceCatalog(deps: CatalogDeps): SourceCatalog {
  const entries: SourceCatalogEntry[] = [];
  const push = (e: SourceCatalogEntry): void => {
    if (!entries.some((x) => x.key === e.key)) entries.push(e);
  };

  // 1) 台账源：必须有生效授权；L4 必须法务已批；若调用方给了适配器清单，还必须有适配器
  const available = deps.availableSourceIds ? new Set(deps.availableSourceIds) : null;
  for (const s of deps.repos.sources.list(deps.tenantId)) {
    const az = deps.repos.authz.active(deps.tenantId, s.sourceId);
    const legal = s.tier !== "L4" || s.legalApproved;
    if (!az || !legal) continue;
    if (available && !available.has(s.sourceId)) continue;
    push({
      key: s.sourceId,
      displayName: s.name,
      grade: s.tier as ComplianceGrade,
      origin: "external",
      coverage: `${s.authMethod ?? "已授权"}，授权有效期至 ${az.validTo.slice(0, 10)}`,
      asOf: az.validFrom,
    });
  }

  // 2) 本地 KB 语料源
  for (const id of deps.knowledgeSourceIds ?? []) {
    push({
      key: id,
      displayName: KB_DISPLAY[id] ?? id,
      grade: KB_GRADE[id] ?? "L2",
      origin: "kb",
      coverage: "本地知识库检索命中（内部语料，未经外部接口核验）",
      asOf: new Date().toISOString(),
    });
  }

  // 3) 内部数据仓
  for (const s of [...INTERNAL_CATALOG_SOURCES, ...(deps.internalSources ?? [])]) {
    push({
      key: s.key,
      displayName: s.displayName,
      grade: s.grade,
      origin: "internal",
      coverage: s.coverage ?? "内部数据仓",
      asOf: new Date().toISOString(),
    });
  }

  return {
    entries,
    logicalRefs: [...LOGICAL_REFS],
    ...(deps.chunkIds ? { chunkIds: deps.chunkIds } : {}),
    // 显式给空数组与"没给"是两回事：前者代表"本 job 确实没有平台证据"，
    // 会让任何条目级引用判非法；后者代表"调用方无法判定"，校验跳过。
    ...(deps.evidenceEntries ? { evidenceEntries: deps.evidenceEntries } : {}),
  };
}

/** 目录里可用的外部源 key，供启动不变量断言使用 */
export const externalCatalogKeys = (catalog: SourceCatalog): string[] =>
  catalog.entries.filter((e) => e.origin === "external").map((e) => e.key);

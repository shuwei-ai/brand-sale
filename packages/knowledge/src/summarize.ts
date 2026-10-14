/**
 * 报告摘要抽取（P1）—— 纯函数、零 I/O、可单测
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它是什么，以及**它刻意不是什么**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 把一份已生成的报告 DSL 投影成一段紧凑文本，用于回灌知识库（KB-2），
 * 让"这家客户过去做过什么、结论是什么"能进入后续任务的检索范围。
 *
 * **默认不用 LLM 总结**。理由不是省钱，是**溯源**：
 *   机械抽取的每一句都能指回 DSL 里已带 citation 的块；
 *   LLM 总结会引入新的、无法溯源的表述，一旦它被当作事实回灌再被引用，
 *   就形成「模型产物 → 存库 → 被当事实引用 → 再生成模型产物」的回环，
 *   本项目最贵的资产——citation 制度——会静默失效（见集成方案 §5.1）。
 *
 * 由此推出两条硬规则，都体现在下面的实现里：
 *   · `keyNumbers` **只收已挂可溯源引用（非 model_inference）的行**，
 *     没有出处的数字一个都不进摘要——摘要不能成为套壳洗白通道；
 *   · 模型推断的表述单独进 `modelInference[]`，入库时按低可信处理。
 *
 * 另一个必须由**调用方**守着的不变量（本文件无法单方面保证）：
 *   `report_summary` 这个来源必须从「多源交叉一致度」（crossSourceAgreement）
 *   的计算中排除。否则「1 个真实来源 + 它自己的摘要」会被算成 2 个来源的
 *   交叉验证，置信度虚高——这个错误没有任何报错（见 §5.2）。
 */

import type { JobRecord, ReportDsl, ReportCitation, SlideSpec, Block } from "@brandsale/contracts";

/** 回灌知识库时使用的来源标识。必须在来源台账登记并授权（见 seed.ts）。 */
export const SUMMARY_SOURCE_ID = "report_summary";

export interface SummarySection {
  /** 章节/页标题 */
  title: string;
  /** 该页首个正文块的要点（截断） */
  gist: string;
  pageIndex: number;
}

export interface SummaryKeyNumber {
  label: string;
  value: string;
  /** 出处（sourceKey / chunkId / entryId）。**必非空**——不收无出处的数字。 */
  ref: string;
}

export interface ReportSummary {
  jobId: string;
  tenantId: string;
  title: string;
  brief: {
    industry?: string;
    category?: string;
    brands?: string[];
    platforms?: string[];
    window?: { from: string; to: string };
    budget?: number;
  };
  sections: SummarySection[];
  keyNumbers: SummaryKeyNumber[];
  /** 去重后的可溯源引用标识 */
  citedSources: string[];
  /** 取自 job.degraded：本次产出完整性的如实记录 */
  degradations: string[];
  /** 模型推断类表述（无出处），单独列出 */
  modelInference: string[];
}

const NUMBER_RE = /[-+]?\d[\d,]*\.?\d*\s*(%|万|亿|元|次|人|条|个|CPM|CPC|CPE|ROI|GMV)?/;
const GIST_MAX = 160;
const MAX_SECTIONS = 16;
const MAX_KEYNUMBERS = 24;

/** 引用 → 可读的出处标识。三类可溯源引用各取自己的定位键。 */
function refOfCitation(c: ReportCitation): string {
  if (c.kind === "data_source") return c.ref?.sourceKey ?? "";
  if (c.kind === "kb_chunk") return c.ref?.chunkId ?? "";
  if (c.kind === "platform_entry") return c.ref?.entryId ?? "";
  return "";
}

const isTraceable = (c: ReportCitation): boolean => c.kind !== "model_inference";

/** 页内首个正文块的要点。优先正文段，其次 bullet，最后 KPI 标签。 */
function gistOf(slide: SlideSpec): string {
  const pick = (blocks: Block[]): string => {
    const text = blocks.find((b) => b.type === "text");
    if (text && text.type === "text") return text.content;
    const bullets = blocks.find((b) => b.type === "bullets");
    if (bullets && bullets.type === "bullets" && bullets.items.length > 0) return bullets.items.join("；");
    const kpi = blocks.find((b) => b.type === "kpi");
    if (kpi && kpi.type === "kpi" && kpi.items.length > 0) {
      return kpi.items.map((it) => `${it.label} ${it.value}${it.unit ?? ""}`).join("；");
    }
    const quote = blocks.find((b) => b.type === "quote");
    if (quote && quote.type === "quote") return quote.text;
    return "";
  };
  const raw = pick(slide.blocks).replace(/\s+/g, " ").trim();
  return raw.length > GIST_MAX ? `${raw.slice(0, GIST_MAX)}…` : raw;
}

/**
 * 从报告 DSL 机械抽取摘要。
 *
 * `job` 只用于取身份与降级记录，**不参与内容生成**——摘要里的每一句都来自 DSL，
 * 这样"摘要说了什么"与"报告说了什么"之间不存在第二份真相。
 */
export function buildReportSummary(dsl: ReportDsl, job: JobRecord): ReportSummary {
  const pages = [...dsl.slides].sort((a, b) => a.index - b.index);

  const sections: SummarySection[] = [];
  const keyNumbers: SummaryKeyNumber[] = [];
  const citedSources: string[] = [];
  const modelInference: string[] = [];
  const seenRefs = new Set<string>();

  for (const slide of pages) {
    const traceable = slide.citations.filter(isTraceable);

    for (const c of slide.citations) {
      if (!isTraceable(c)) {
        if (c.claim) modelInference.push(c.claim);
        continue;
      }
      const ref = refOfCitation(c);
      if (ref && !seenRefs.has(ref)) {
        seenRefs.add(ref);
        citedSources.push(ref);
      }
    }

    if (slide.pageRole === "section" || slide.pageRole === "content" || slide.pageRole === "data" || slide.pageRole === "appendix") {
      const gist = gistOf(slide);
      if (gist && sections.length < MAX_SECTIONS) sections.push({ title: slide.title, gist, pageIndex: slide.index });
    }

    /* 关键数字：**只有挂了可溯源引用的页**才收，且每个数字都必带出处。
     * 页内一个可溯源引用都没有 → 这一页的数字全部跳过（宁可少，不可无出处）。 */
    if (traceable.length === 0 || keyNumbers.length >= MAX_KEYNUMBERS) continue;
    const ref = refOfCitation(traceable[0]!);
    if (!ref) continue;

    for (const b of slide.blocks) {
      if (keyNumbers.length >= MAX_KEYNUMBERS) break;
      if (b.type === "kpi") {
        for (const it of b.items) {
          if (!NUMBER_RE.test(`${it.value}${it.unit ?? ""}`)) continue;
          keyNumbers.push({ label: it.label, value: `${it.value}${it.unit ?? ""}`, ref });
        }
      } else if (b.type === "table") {
        for (const row of b.rows) {
          if (!row.some((cell) => NUMBER_RE.test(cell))) continue;
          keyNumbers.push({ label: row[0] ?? "（表行）", value: row.join(" | "), ref });
        }
      }
    }
  }

  const degradations = job.degraded.map((d) => d.note ?? (d.missing.length > 0 ? `缺失：${d.missing.join("、")}` : d.reason));

  return {
    jobId: job.jobId,
    tenantId: job.tenantId,
    title: dsl.meta.title,
    brief: {
      ...(job.spec.brief.industry ? { industry: job.spec.brief.industry } : {}),
      ...(job.spec.brief.category ? { category: job.spec.brief.category } : {}),
      ...(job.spec.brief.brandIds?.length ? { brands: [...job.spec.brief.brandIds] } : {}),
      ...(job.spec.brief.platforms?.length ? { platforms: [...job.spec.brief.platforms] } : {}),
      ...(job.spec.brief.window ? { window: { from: job.spec.brief.window.from, to: job.spec.brief.window.to } } : {}),
      ...(job.spec.brief.budget ? { budget: job.spec.brief.budget.amount } : {}),
    },
    sections,
    keyNumbers,
    citedSources,
    degradations,
    modelInference,
  };
}

/**
 * 渲染成入库用的紧凑 Markdown。
 *
 * 为什么开头要写"派生自历史报告"：这句话会被后续检索召回并进入新报告的上下文。
 * 若不标注，读到它的人（和模型）会以为这是一手数据源——
 * 那正是 §5.1 溯源回环的起点。
 */
export function renderSummaryText(s: ReportSummary): string {
  const lines: string[] = [];
  lines.push(`# ${s.title}`);
  lines.push("");
  lines.push("> 本文件由系统从一份历史报告**机械抽取**，用于沉淀既往结论；它不是一手数据源，数字类结论请回溯原始出处。");
  lines.push("");

  const b = s.brief;
  const briefParts: string[] = [];
  if (b.brands?.length) briefParts.push(`品牌：${b.brands.join(" / ")}`);
  if (b.industry) briefParts.push(`行业：${b.industry}`);
  if (b.category) briefParts.push(`品类：${b.category}`);
  if (b.platforms?.length) briefParts.push(`平台：${b.platforms.join(" / ")}`);
  if (b.window) briefParts.push(`窗口：${b.window.from} ~ ${b.window.to}`);
  if (b.budget !== undefined) briefParts.push(`预算：${b.budget} 分`);
  if (briefParts.length) {
    lines.push(`**任务**：${briefParts.join("；")}`);
    lines.push("");
  }

  if (s.sections.length > 0) {
    lines.push("## 章节要点");
    for (const sec of s.sections) lines.push(`- ${sec.title}：${sec.gist}`);
    lines.push("");
  }

  if (s.keyNumbers.length > 0) {
    lines.push("## 关键数字（均已挂可溯源引用）");
    for (const k of s.keyNumbers) lines.push(`- ${k.label} = ${k.value}（出处 ${k.ref}）`);
    lines.push("");
  }

  if (s.citedSources.length > 0) {
    lines.push(`## 引用来源\n${s.citedSources.map((r) => `- ${r}`).join("\n")}`);
    lines.push("");
  }

  if (s.modelInference.length > 0) {
    lines.push("## 模型推断（无出处，仅供线索）");
    for (const m of s.modelInference.slice(0, 10)) lines.push(`- ${m}`);
    lines.push("");
  }

  if (s.degradations.length > 0) {
    lines.push("## 产出完整性");
    for (const d of s.degradations) lines.push(`- ${d}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

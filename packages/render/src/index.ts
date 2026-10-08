/**
 * M11 RenderService：报告 DSL → Markdown / HTML
 *
 * 三段式流水线在 Phase 1 的落地：
 *   ① validate  —— 完整性 + 引用一致性 + 来源合法性（R1~R12，拒绝 L4）
 *   ② planLayout —— 选版式、定页面角色（role 驱动兜底 + 自动修复）
 *   ③ compile   —— 渲染为 Markdown / 自包含 HTML（内联 SVG 图表，零依赖）
 * Presenton / pptxgenjs 档留作 Phase 3（`BM_RENDER_ENGINE`），接口形状不变。
 *
 * 关于「渲染层不查库」这条边界（P2-1 的关键约束）：
 *   render 只能依赖 contracts + config，因此来源目录以**纯数据**形式经 opts 传入，
 *   由 governance 组装、orchestrator 透传。render 自己绝不去读 sources 表或 KB。
 */

import {
  DISCLAIMER_TEXT,
  autoRepair,
  type Block,
  type DslIssue,
  type ReportDsl,
  type ReportValidationOptions,
  type SlideSpec,
} from "@brandsale/contracts";
import { validateReportDsl } from "@brandsale/contracts";
import type { Config } from "@brandsale/config";

export interface LayoutPlan {
  master: string;
  slides: { index: number; layoutId: string; role: SlideSpec["pageRole"] }[];
  aspect: "16:9";
}

export interface CompileResult {
  kind: "markdown" | "html";
  ref: { path?: string; inline: string };
  slideCount: number;
  repairs: { slideIndex: number; issue: string; action: string }[];
  dropped: { slideIndex: number; content: string; reason: string }[];
}

export interface IRenderService {
  validate(dsl: ReportDsl, opts?: ReportValidationOptions): Promise<{ ok: boolean; issues: DslIssue[] }>;
  planLayout(dsl: ReportDsl): Promise<LayoutPlan>;
  compile(dsl: ReportDsl, opts?: ReportValidationOptions): Promise<CompileResult>;
}

/** 图表配色（离散、色盲友好、打印可辨） */
const CHART_COLORS = ["#1f6feb", "#bf8700", "#2da44e", "#8250df", "#cf222e", "#0969da", "#4d2d00", "#116329"];

/**
 * 图片地址协议白名单。
 * 报告是自包含 HTML，`javascript:` / `file:` / 相对路径会让前端在打开时产生
 * 越权或 404；只放行 https 与内联 data:image。
 */
const IMAGE_REF_RE = /^(https:\/\/|data:image\/[a-z0-9.+-]+;base64,)/i;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

export class RenderService implements IRenderService {
  constructor(private readonly config: Config) {}

  async validate(dsl: ReportDsl, opts: ReportValidationOptions = {}): Promise<{ ok: boolean; issues: DslIssue[] }> {
    return validateReportDsl(dsl, opts);
  }

  async planLayout(dsl: ReportDsl): Promise<LayoutPlan> {
    return {
      master: "brandsale/default-master",
      aspect: "16:9",
      slides: dsl.slides.map((s) => ({ index: s.index, layoutId: s.layoutId || this.defaultLayout(s), role: s.pageRole })),
    };
  }

  /** pageRole → 兜底版式（比一刀切 content/default 更贴近真实排版意图） */
  private defaultLayout(slide: SlideSpec): string {
    switch (slide.pageRole) {
      case "cover":
        return "cover/hero";
      case "toc":
        return "toc/list";
      case "section":
        return "section/divider";
      case "closing":
        return "closing/statement";
      case "appendix":
        return "appendix/dense";
      case "data":
        return "data/table";
      default:
        return "content/default";
    }
  }

  async compile(dsl: ReportDsl, opts: ReportValidationOptions = {}): Promise<CompileResult> {
    const repairs: CompileResult["repairs"] = [];

    // 自动修复可修复项（warn 级 + 来源降级），先修再判，避免"能修的问题"变成硬失败
    const { dsl: fixed, actions } = autoRepair(dsl, opts);
    actions.forEach((a) => repairs.push({ slideIndex: -1, issue: "invariant", action: a }));

    const post = validateReportDsl(fixed, opts);
    if (!post.ok) {
      // error 级无法修复 → 拒绝渲染，抛出明确原因（不允许静默降级成残缺报告）
      const messages = post.issues.filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`);
      throw new Error(`报告 DSL 校验失败，拒绝渲染：\n${messages.join("\n")}`);
    }

    // 图片协议白名单：非法地址在这里被摘掉，而不是让前端去加载
    const { dsl: safe, dropped } = this.sanitizeImages(fixed);
    dropped.forEach((d) => repairs.push({ slideIndex: d.slideIndex, issue: "image.ref", action: `丢弃非法图片地址 ${d.reason}` }));

    const markdown = this.toMarkdown(safe);
    const html = this.toHtml(safe);
    const isHtml = this.config.render.engine !== "presenton";
    return {
      kind: isHtml ? "html" : "markdown",
      ref: { inline: isHtml ? html : markdown },
      slideCount: safe.slides.length,
      repairs,
      dropped,
    };
  }

  /** 摘掉协议不被允许的 image 块（返回被摘内容的记录，供 orchestrator 记 degraded） */
  private sanitizeImages(dsl: ReportDsl): { dsl: ReportDsl; dropped: CompileResult["dropped"] } {
    const dropped: CompileResult["dropped"] = [];
    const slides = dsl.slides.map((slide) => {
      let changed = false;
      const blocks = slide.blocks.filter((b) => {
        if (b.type !== "image") return true;
        if (IMAGE_REF_RE.test(b.ref)) return true;
        changed = true;
        dropped.push({ slideIndex: slide.index, content: b.ref, reason: `协议不被允许（仅 https:// 与 data:image/）` });
        return false;
      });
      return changed ? { ...slide, blocks } : slide;
    });
    return { dsl: { ...dsl, slides }, dropped };
  }

  /* ── Markdown ─────────────────────────────────────────── */

  toMarkdown(dsl: ReportDsl): string {
    const lines: string[] = [];
    lines.push(`# ${dsl.meta.title}`);
    lines.push("");
    lines.push(`> 分析窗口：${dsl.meta.window.from} ~ ${dsl.meta.window.to} · 生成时间：${dsl.meta.generatedAt}`);
    if (dsl.meta.degraded) {
      lines.push(`> ⚠️ 降级说明：${dsl.meta.degraded.reason}`);
    }
    lines.push("");

    for (const slide of dsl.slides) {
      lines.push(`## ${slide.index + 1}. ${slide.title}`);
      lines.push("");
      for (const block of slide.blocks) {
        // 与 compile 同一套图片协议白名单：非白名单地址在 Markdown 里也不落地
        if (block.type === "image" && !IMAGE_REF_RE.test(block.ref)) continue;
        lines.push(...this.blockToMarkdown(block));
        lines.push("");
      }
      if (slide.citations.length > 0) {
        lines.push("<sub>引用：</sub>");
        for (const c of slide.citations) {
          lines.push(
            `<sub>- ${c.claim} — ${c.ref.sourceKey ?? c.ref.chunkId ?? "模型推断"}（置信度 ${c.confidence.toFixed(2)}，${c.tier}，${
              c.verifiedBy === "human" ? "人工核验" : "自动"
            }）</sub>`,
          );
        }
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
    lines.push(`**数据来源声明（${dsl.sourceDeclaration.grade}）**`);
    for (const s of dsl.sourceDeclaration.sources) {
      lines.push(`- ${s.displayName}（${s.grade}）：${s.coverage}`);
    }
    if (dsl.sourceDeclaration.exclusions.length > 0) {
      lines.push("");
      lines.push("**未使用的来源及原因**");
      for (const e of dsl.sourceDeclaration.exclusions) {
        lines.push(`- ${e.key}：${e.reason}`);
      }
    }
    lines.push("");
    lines.push(`> ${DISCLAIMER_TEXT}`);
    return lines.join("\n");
  }

  private blockToMarkdown(block: Block): string[] {
    switch (block.type) {
      case "text":
        return [block.style === "h2" ? `### ${block.content}` : block.style === "h3" ? `#### ${block.content}` : block.style === "caption" ? `*${block.content}*` : block.content];
      case "bullets":
        return block.items.map((i) => `- ${i}`);
      case "kpi":
        return block.items.map((it) => `- **${it.label}**：${it.value}${it.unit ?? ""}${it.tier ? `（置信度 ${it.tier}）` : ""}`);
      case "table": {
        const out = [this.mdTable(block.columns, block.rows)];
        if (block.caption) out.push(`*${block.caption}*`);
        return out;
      }
      case "chart": {
        // 图表在纯文本环境里退化为「数据表 + 口径说明」，而不是丢掉信息
        const cats = [...new Set(block.series.flatMap((s) => s.points.map((p) => p.x)))];
        const head = [block.axis?.xLabel ?? "分类", ...block.series.map((s) => s.name)];
        const rows = cats.map((c) => [c, ...block.series.map((s) => String(s.points.find((p) => p.x === c)?.y ?? ""))]);
        return [`**图表：${block.chartType}**`, "", this.mdTable(head, rows), "", `*横轴 ${block.axis?.xLabel ?? "分类"} · 纵轴 ${block.axis?.yLabel ?? "数值"}*`];
      }
      case "image":
        return [`![${block.caption ?? ""}](${block.ref})`];
      case "timeline":
        return block.phases.flatMap((p) => [`**${p.label}**（${p.from} ~ ${p.to}）`, ...p.items.map((i) => `  - ${i}`)]);
      case "quote":
        return [`> ${block.text}${block.attribution ? ` —— ${block.attribution}` : ""}`];
      case "callout": {
        const icon = block.tone === "warn" ? "⚠️" : block.tone === "risk" ? "🛑" : "ℹ️";
        return [`${icon} ${block.text}`];
      }
      case "matrix":
        return [`**矩阵：${block.xLabel} × ${block.yLabel}**`, "", this.mdTable([block.xLabel, block.yLabel, "对象"], block.cells.map((c) => [fmt(c.x), fmt(c.y), c.label]))];
      default:
        return [];
    }
  }

  private mdTable(columns: string[], rows: string[][]): string {
    const head = `| ${columns.join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    return [head, sep, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
  }

  /* ── HTML（自包含，可直接预览/打印） ─────────────────── */

  toHtml(dsl: ReportDsl): string {
    const total = dsl.slides.length;
    const toc = this.buildToc(dsl);
    const pages = dsl.slides
      .map((slide) => {
        const role = slide.pageRole;
        const twoCol = slide.layoutId.includes("2col");
        const body =
          role === "toc" && toc.length > 0 && !slide.blocks.some((b) => b.type === "bullets" || b.type === "table")
            ? `<div class="toc">${toc
                .map((t) => `<div class="toc-row"><span class="toc-t">${esc(t.title)}</span><span class="toc-d"></span><span class="toc-p">${t.page}</span></div>`)
                .join("")}</div>`
            : `<div class="${twoCol ? "cols" : "blocks"}">${slide.blocks.map((b) => this.blockToHtml(b)).join("\n")}</div>`;

        return `
      <section class="slide role-${role}${role === "cover" ? " cover-slide" : ""}">
        <div class="slide-head"><span class="idx">${String(slide.index + 1).padStart(2, "0")}</span><h2>${esc(slide.title)}</h2></div>
        ${body}
        ${
          slide.citations.length > 0
            ? `<div class="cites"><b>引用</b><ul>${slide.citations
                .map(
                  (c) =>
                    `<li>${esc(c.claim)} — <code>${esc(c.ref.sourceKey ?? c.ref.chunkId ?? "model")}</code> · 置信度 ${c.confidence.toFixed(2)} · ${c.tier} · ${
                      c.verifiedBy === "human" ? "人工核验" : "自动"
                    }</li>`,
                )
                .join("")}</ul></div>`
            : ""
        }
        ${role === "cover" ? "" : `<div class="pagenum">${slide.index + 1} / ${total}</div>`}
      </section>`;
      })
      .join("\n");

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(dsl.meta.title)}</title>
<style>
  :root{--ink:#1a1c1f;--muted:#5c636e;--line:#e3e6ea;--bg:#f6f7f9;--accent:#1f6feb;--warn:#b45309;--risk:#b91c1c;--up:#c62828;--down:#2e7d32}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:40px 24px 80px}
  .cover{background:#fff;border:1px solid var(--line);border-radius:16px;padding:32px;margin-bottom:20px}
  .cover h1{margin:0 0 8px;font-size:26px}
  .cover .meta{color:var(--muted);font-size:13px}
  .degraded{margin-top:12px;background:#fff7ed;border:1px solid #fed7aa;color:var(--warn);padding:10px 12px;border-radius:10px;font-size:13px}
  .slide{position:relative;background:#fff;border:1px solid var(--line);border-radius:16px;padding:26px 28px 34px;margin-bottom:18px}
  .slide-head{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:16px}
  .slide-head .idx{color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}
  .slide-head h2{margin:0;font-size:18px}
  /* 页面角色样式：section/appendix 与正文拉开视觉层级 */
  .slide.role-section{background:linear-gradient(180deg,#f8faff,#fff);border-left:4px solid var(--accent)}
  .slide.role-section .slide-head h2{font-size:22px}
  .slide.role-appendix{background:#fcfcfd;font-size:13.5px}
  .slide.role-appendix .slide-head .idx{color:var(--muted)}
  .slide.role-closing{background:linear-gradient(180deg,#fff,#f8f9fb)}
  .pagenum{position:absolute;right:20px;bottom:12px;color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums}
  .cols{column-count:2;column-gap:26px}
  .cols > *{break-inside:avoid}
  h3{margin:18px 0 8px;font-size:15px}
  ul{margin:8px 0;padding-left:20px}
  li{margin:4px 0}
  table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13.5px}
  th,td{border:1px solid var(--line);padding:7px 9px;text-align:left}
  th{background:#fafbfc;font-weight:600}
  .kpi{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0}
  .kpi .card{flex:1 1 170px;border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fcfcfd}
  .kpi .card .l{color:var(--muted);font-size:12.5px}
  .kpi .card .v{font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
  .kpi .card .t{margin-top:6px}
  .kpi.kpi-wide .card.lead{border-color:var(--accent);background:#f5f9ff}
  .kpi.kpi-wide .card.lead .v{font-size:26px}
  .tag{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:999px;border:1px solid currentColor}
  .tag.high{color:#15803d}.tag.medium{color:#b45309}.tag.low{color:#b91c1c}
  .callout{border-radius:10px;padding:10px 12px;margin:12px 0;font-size:13.5px}
  .callout.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
  .callout.warn{background:#fff7ed;border:1px solid #fed7aa;color:var(--warn)}
  .callout.risk{background:#fef2f2;border:1px solid #fecaca;color:var(--risk)}
  .cites{margin-top:16px;border-top:1px dashed var(--line);padding-top:10px;font-size:12.5px;color:var(--muted)}
  .cites ul{margin:6px 0 0}
  .timeline{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0}
  .timeline .ph{flex:1 1 200px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:#fcfcfd}
  .timeline .ph b{display:block;margin-bottom:2px}
  .timeline .ph .d{color:var(--muted);font-size:12px;margin-bottom:6px}
  figure.chart,figure.matrix{margin:14px 0;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:#fff}
  figure.chart svg,figure.matrix svg{width:100%;height:auto;display:block}
  figure.chart figcaption,figure.matrix figcaption{color:var(--muted);font-size:12.5px;margin-top:6px}
  .toc{margin:6px 0}
  .toc-row{display:flex;align-items:baseline;gap:8px;padding:6px 0;border-bottom:1px dotted var(--line);font-size:14px}
  .toc-t{font-weight:600}
  .toc-d{flex:1;border-bottom:1px dotted var(--line);transform:translateY(-3px)}
  .toc-p{color:var(--muted);font-variant-numeric:tabular-nums}
  .src{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px 26px;margin-top:18px;font-size:13.5px}
  .src h3{margin-top:0}
  .excl{color:var(--warn)}
  .disc{margin-top:14px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:10px}
  @media print{
    @page{size:A4 portrait;margin:12mm}
    body{background:#fff}
    .wrap{max-width:none;padding:0}
    .cover{page-break-after:always}
    .slide,.src{break-inside:avoid;page-break-inside:avoid;border-radius:0;margin-bottom:10mm}
    .slide{page-break-after:always}
    .pagenum{position:static;text-align:right;margin-top:8mm}
  }
</style></head>
<body><div class="wrap">
  <div class="cover">
    <h1>${esc(dsl.meta.title)}</h1>
    <div class="meta">分析窗口 ${esc(dsl.meta.window.from)} ~ ${esc(dsl.meta.window.to)} · 生成于 ${esc(dsl.meta.generatedAt)} · 品牌 ${esc(dsl.meta.brand.name)}</div>
    ${dsl.meta.degraded ? `<div class="degraded">降级说明：${esc(dsl.meta.degraded.reason)}</div>` : ""}
  </div>
  ${pages}
  <div class="src">
    <h3>数据来源与口径声明（${esc(dsl.sourceDeclaration.grade)}）</h3>
    <ul>${dsl.sourceDeclaration.sources.map((s) => `<li><b>${esc(s.displayName)}</b>（${esc(s.grade)}）：${esc(s.coverage)}</li>`).join("")}</ul>
    ${dsl.sourceDeclaration.exclusions.length > 0 ? `<h3>未使用的来源及原因</h3><ul class="excl">${dsl.sourceDeclaration.exclusions.map((e) => `<li>${esc(e.key)}：${esc(e.reason)}</li>`).join("")}</ul>` : ""}
    <div class="disc">${esc(DISCLAIMER_TEXT)}</div>
  </div>
</div></body></html>`;
  }

  /** 自动目录：从真实页面（正文/数据/小节）派生，页码与页序一致 */
  private buildToc(dsl: ReportDsl): { title: string; page: number }[] {
    return dsl.slides
      .filter((s) => s.pageRole === "content" || s.pageRole === "data" || s.pageRole === "appendix")
      .map((s) => ({ title: s.title, page: s.index + 1 }));
  }

  private blockToHtml(block: Block): string {
    switch (block.type) {
      case "text":
        return block.style === "caption"
          ? `<p style="color:#5c636e;font-size:13px">${esc(block.content)}</p>`
          : block.style === "h2"
            ? `<h3 style="font-size:17px">${esc(block.content)}</h3>`
            : `<h3>${esc(block.content)}</h3>`;
      case "bullets":
        return `<ul>${block.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
      case "kpi": {
        const wide = block.items.length > 4;
        return `<div class="kpi${wide ? " kpi-wide" : ""}">${block.items
          .map(
            (it, i) =>
              `<div class="card${wide && i === 0 ? " lead" : ""}"><div class="l">${esc(it.label)}</div><div class="v">${esc(it.value)}${esc(it.unit ?? "")}</div>${
                it.tier ? `<div class="t"><span class="tag ${it.tier}">${it.tier === "high" ? "已核验" : it.tier === "medium" ? "单一来源" : "估算"}</span></div>` : ""
              }</div>`,
          )
          .join("")}</div>`;
      }
      case "table":
        return `<table><thead><tr>${block.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${block.rows
          .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>${block.caption ? `<p style="color:#5c636e;font-size:12.5px">${esc(block.caption)}</p>` : ""}`;
      case "chart":
        return this.svgChart(block);
      case "image":
        return `<figure><img src="${esc(block.ref)}" alt="${esc(block.caption ?? "")}" style="max-width:100%">${
          block.caption ? `<figcaption style="color:#5c636e;font-size:12.5px">${esc(block.caption)}</figcaption>` : ""
        }</figure>`;
      case "timeline":
        return `<div class="timeline">${block.phases
          .map((p) => `<div class="ph"><b>${esc(p.label)}</b><div class="d">${esc(p.from)} ~ ${esc(p.to)}</div><ul>${p.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`)
          .join("")}</div>`;
      case "quote":
        return `<blockquote style="border-left:3px solid #e3e6ea;margin:10px 0;padding-left:12px;color:#5c636e">${esc(block.text)}${
          block.attribution ? `<div style="font-size:12.5px">—— ${esc(block.attribution)}</div>` : ""
        }</blockquote>`;
      case "callout":
        return `<div class="callout ${block.tone}">${esc(block.text)}</div>`;
      case "matrix":
        return this.svgMatrix(block);
      default:
        return "";
    }
  }

  /* ── 内联 SVG 图表（零依赖） ─────────────────────────── */

  private svgChart(block: Extract<Block, { type: "chart" }>): string {
    const W = 900;
    const H = 360;
    const M = { t: 46, r: 24, b: 52, l: 66 };
    const iw = W - M.l - M.r;
    const ih = H - M.t - M.b;
    const caption = `<figcaption>横轴 ${esc(block.axis?.xLabel ?? "分类")} · 纵轴 ${esc(block.axis?.yLabel ?? "数值")}</figcaption>`;
    const legend = this.svgLegend(block.series.map((s) => s.name), M.l, 20);

    if (block.chartType === "pie") return this.svgPie(block, W, H, legend);
    if (block.chartType === "funnel") return this.svgFunnel(block, W, H, M, legend);

    const cats = [...new Set(block.series.flatMap((s) => s.points.map((p) => p.x)))];
    const ys = block.series.flatMap((s) => s.points.map((p) => p.y));
    let maxY = Math.max(...ys, 0);
    let minY = Math.min(...ys, 0);
    if (maxY === minY) maxY = minY + 1;
    const scaleY = (v: number) => M.t + ih - ((v - minY) / (maxY - minY)) * ih;
    const catX = (i: number) => M.l + (iw * (i + 0.5)) / Math.max(1, cats.length);

    const parts: string[] = [];
    // 网格 + 纵轴刻度
    for (let g = 0; g <= 4; g++) {
      const v = minY + ((maxY - minY) * g) / 4;
      const y = scaleY(v);
      parts.push(`<line x1="${M.l}" y1="${y.toFixed(1)}" x2="${M.l + iw}" y2="${y.toFixed(1)}" stroke="#e3e6ea" stroke-width="1"/>`);
      parts.push(`<text x="${M.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5c636e">${fmt(Math.round(v * 100) / 100)}</text>`);
    }
    parts.push(`<line x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${M.t + ih}" stroke="#c9ced6" stroke-width="1"/>`);
    // 横轴标签
    cats.forEach((c, i) => {
      parts.push(
        `<text x="${catX(i).toFixed(1)}" y="${M.t + ih + 18}" text-anchor="middle" font-size="11.5" fill="#5c636e">${esc(c.length > 8 ? c.slice(0, 8) + "…" : c)}</text>`,
      );
    });

    if (block.chartType === "bar") {
      const groupW = iw / Math.max(1, cats.length);
      const barW = (groupW * 0.72) / Math.max(1, block.series.length);
      block.series.forEach((s, si) => {
        const color = CHART_COLORS[si % CHART_COLORS.length]!;
        s.points.forEach((p) => {
          const ci = cats.indexOf(p.x);
          if (ci < 0) return;
          const y0 = scaleY(0);
          const yv = scaleY(p.y);
          const x = M.l + ci * groupW + groupW * 0.14 + si * barW;
          const h = Math.abs(y0 - yv);
          parts.push(`<rect x="${x.toFixed(1)}" y="${Math.min(y0, yv).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${color}" rx="2"/>`);
          if (cats.length * block.series.length <= 24) {
            parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(Math.min(y0, yv) - 4).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#3b4048">${fmt(p.y)}</text>`);
          }
        });
      });
    } else {
      // line / scatter：折线按 series 连点；scatter 只画点
      block.series.forEach((s, si) => {
        const color = CHART_COLORS[si % CHART_COLORS.length]!;
        const pts = s.points
          .map((p) => {
            const ci = cats.indexOf(p.x);
            return ci < 0 ? null : { x: catX(ci), y: scaleY(p.y) };
          })
          .filter((v): v is { x: number; y: number } => v !== null);
        if (block.chartType === "line" && pts.length > 1) {
          parts.push(`<polyline points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.2"/>`);
        }
        pts.forEach((p) => parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${color}"/>`));
      });
    }

    return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(block.chartType)} 图表" preserveAspectRatio="xMidYMid meet">${legend}${parts.join(
      "",
    )}</svg>${caption}</figure>`;
  }

  private svgLegend(names: string[], x0: number, y: number): string {
    let x = x0;
    const out: string[] = [];
    names.forEach((n, i) => {
      const color = CHART_COLORS[i % CHART_COLORS.length]!;
      out.push(`<rect x="${x}" y="${y - 9}" width="11" height="11" rx="2" fill="${color}"/>`);
      out.push(`<text x="${x + 16}" y="${y}" font-size="12" fill="#3b4048">${esc(n)}</text>`);
      x += 16 + n.length * 12.5 + 22;
    });
    return out.join("");
  }

  private svgPie(block: Extract<Block, { type: "chart" }>, W: number, H: number, legend: string): string {
    const pts = block.series[0]?.points ?? [];
    const total = pts.reduce((a, p) => a + Math.max(0, p.y), 0) || 1;
    const cx = 300;
    const cy = H / 2 + 8;
    const r = 108;
    let angle = -Math.PI / 2;
    const parts: string[] = [];
    pts.forEach((p, i) => {
      const frac = Math.max(0, p.y) / total;
      const a2 = angle + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(a2);
      const y2 = cy + r * Math.sin(a2);
      if (frac >= 0.999) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${CHART_COLORS[i % CHART_COLORS.length]}"/>`);
      } else {
        parts.push(
          `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${
            CHART_COLORS[i % CHART_COLORS.length]
          }" stroke="#fff" stroke-width="1.5"/>`,
        );
      }
      const mid = angle + (frac * Math.PI);
      if (frac > 0.05) {
        const lx = cx + r * 0.62 * Math.cos(mid);
        const ly = cy + r * 0.62 * Math.sin(mid);
        parts.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="12" fill="#fff" font-weight="600">${(frac * 100).toFixed(0)}%</text>`);
      }
      angle = a2;
    });
    // 右下图例（带占比）
    let ly = 70;
    pts.forEach((p, i) => {
      const color = CHART_COLORS[i % CHART_COLORS.length]!;
      parts.push(`<rect x="560" y="${ly - 10}" width="12" height="12" rx="2" fill="${color}"/>`);
      parts.push(`<text x="580" y="${ly}" font-size="12.5" fill="#3b4048">${esc(p.x)}</text>`);
      parts.push(`<text x="860" y="${ly}" text-anchor="end" font-size="12.5" fill="#5c636e" font-variant-numeric="tabular-nums">${((Math.max(0, p.y) / total) * 100).toFixed(1)}%</text>`);
      ly += 24;
    });
    return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="饼图" preserveAspectRatio="xMidYMid meet">${legend}${parts.join("")}</svg>
      <figcaption>构成占比 · 纵轴 ${esc(block.axis?.yLabel ?? "占比")}</figcaption></figure>`;
  }

  private svgFunnel(block: Extract<Block, { type: "chart" }>, W: number, H: number, M: { t: number; r: number; b: number; l: number }, legend: string): string {
    const pts = block.series[0]?.points ?? [];
    const max = Math.max(...pts.map((p) => p.y), 1);
    const top = M.t;
    const usable = H - M.t - M.b;
    const rowH = usable / Math.max(1, pts.length);
    const parts: string[] = [];
    pts.forEach((p, i) => {
      const w = Math.max(40, (p.y / max) * (W - M.l - M.r));
      const x = M.l + (W - M.l - M.r - w) / 2;
      const y = top + i * rowH + 6;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(rowH - 12).toFixed(1)}" rx="4" fill="${CHART_COLORS[i % CHART_COLORS.length]}"/>`);
      parts.push(`<text x="${(W / 2).toFixed(1)}" y="${(y + (rowH - 12) / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12.5" fill="#fff" font-weight="600">${esc(p.x)} · ${fmt(p.y)}</text>`);
    });
    return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="漏斗图" preserveAspectRatio="xMidYMid meet">${legend}${parts.join("")}</svg>
      <figcaption>转化漏斗 · 纵轴 ${esc(block.axis?.yLabel ?? "数值")}</figcaption></figure>`;
  }

  /* ── 象限散点矩阵（零依赖） ───────────────────────────── */

  private svgMatrix(block: Extract<Block, { type: "matrix" }>): string {
    const W = 900;
    const H = 400;
    const M = { t: 30, r: 30, b: 54, l: 70 };
    const iw = W - M.l - M.r;
    const ih = H - M.t - M.b;
    const xs = block.cells.map((c) => c.x);
    const ys = block.cells.map((c) => c.y);
    // 以 0 为四象限中心；若数据全为同号，则用数据中点避免所有点挤在一角
    const pickCenter = (arr: number[]): number => {
      const lo = Math.min(...arr, 0);
      const hi = Math.max(...arr, 0);
      if (lo < 0 && hi > 0) return 0;
      return (Math.min(...arr) + Math.max(...arr)) / 2;
    };
    const cx0 = pickCenter(xs);
    const cy0 = pickCenter(ys);
    const maxAbsX = Math.max(...xs.map((v) => Math.abs(v - cx0)), 1);
    const maxAbsY = Math.max(...ys.map((v) => Math.abs(v - cy0)), 1);
    const scaleX = (v: number) => M.l + iw / 2 + ((v - cx0) / maxAbsX) * (iw / 2);
    const scaleY = (v: number) => M.t + ih / 2 - ((v - cy0) / maxAbsY) * (ih / 2);
    const sizes = block.cells.map((c) => c.size ?? 1);
    const maxSize = Math.max(...sizes, 1);

    const parts: string[] = [];
    // 四象限底色
    parts.push(`<rect x="${M.l}" y="${M.t}" width="${iw / 2}" height="${ih / 2}" fill="#f2f7ff"/>`);
    parts.push(`<rect x="${M.l + iw / 2}" y="${M.t}" width="${iw / 2}" height="${ih / 2}" fill="#f7fbf3"/>`);
    parts.push(`<rect x="${M.l}" y="${M.t + ih / 2}" width="${iw / 2}" height="${ih / 2}" fill="#fbfbf7"/>`);
    parts.push(`<rect x="${M.l + iw / 2}" y="${M.t + ih / 2}" width="${iw / 2}" height="${ih / 2}" fill="#fdf7f7"/>`);
    parts.push(`<rect x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="none" stroke="#c9ced6"/>`);
    parts.push(`<line x1="${M.l + iw / 2}" y1="${M.t}" x2="${M.l + iw / 2}" y2="${M.t + ih}" stroke="#c9ced6" stroke-dasharray="4 4"/>`);
    parts.push(`<line x1="${M.l}" y1="${M.t + ih / 2}" x2="${M.l + iw}" y2="${M.t + ih / 2}" stroke="#c9ced6" stroke-dasharray="4 4"/>`);

    // 点 + 标签
    block.cells.forEach((c, i) => {
      const x = scaleX(c.x);
      const y = scaleY(c.y);
      const r = 6 + ((c.size ?? 1) / maxSize) * 8;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${CHART_COLORS[i % CHART_COLORS.length]}" fill-opacity="0.78" stroke="#fff" stroke-width="1.5"/>`);
      parts.push(
        `<text x="${(x + r + 4).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11.5" fill="#2c3138" font-weight="600">${esc(c.label.length > 10 ? c.label.slice(0, 10) + "…" : c.label)}</text>`,
      );
    });

    // 轴标签
    parts.push(`<text x="${M.l + iw / 2}" y="${H - 12}" text-anchor="middle" font-size="12.5" fill="#5c636e">${esc(block.xLabel)} →</text>`);
    parts.push(`<text x="18" y="${M.t + ih / 2}" text-anchor="middle" font-size="12.5" fill="#5c636e" transform="rotate(-90 18 ${M.t + ih / 2})">${esc(block.yLabel)} →</text>`);
    // 象限角标
    parts.push(`<text x="${M.l + 8}" y="${M.t + 16}" font-size="11" fill="#8a919b">高${esc(block.yLabel)} · 低${esc(block.xLabel)}</text>`);
    parts.push(`<text x="${M.l + iw - 8}" y="${M.t + 16}" text-anchor="end" font-size="11" fill="#8a919b">高${esc(block.yLabel)} · 高${esc(block.xLabel)}</text>`);
    parts.push(`<text x="${M.l + iw - 8}" y="${M.t + ih - 8}" text-anchor="end" font-size="11" fill="#8a919b">低${esc(block.yLabel)} · 高${esc(block.xLabel)}</text>`);

    return `<figure class="matrix"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="象限矩阵" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>
      <figcaption>${esc(block.xLabel)} × ${esc(block.yLabel)} 象限定位（气泡大小表示规模）</figcaption></figure>`;
  }
}

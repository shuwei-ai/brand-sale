/**
 * 文档解析器（P1-5）：把上传的二进制文档转成可切分的纯文本。
 *
 * 设计原则：**宁可明确失败，不要产出"看起来像数据"的垃圾**。
 *
 * 这条原则来自本项目已经付过学费的一次教训：早先 5 个合成适配器会输出
 * 确定性伪随机数（`synthetic: true`），没人注意到报告里那些"实测值"是编的，
 * 直到它们被整体删除。二进制文档有完全同构的风险——
 * 若把 .docx 的 zip 字节当文本塞进 KB，会得到一堆乱码 chunk，
 * 它们**能通过检索、能被引用、在报告里占据一个来源声明**，
 * 但内容毫无意义。所以未配置解析器时直接抛 E-INGEST-002，不做任何"兜底"。
 *
 * 解析通道：
 *   · 纯文本（text/plain、text/markdown）→ 本地解码，零依赖
 *   · 二进制（pdf/docx/xlsx/pptx/图片）→ 交给 MinerU（BM_PARSER_URL）
 *     MinerU 可自部署（Apache-2.0），对外只暴露一个 POST /file_parse
 *
 * 这个文件同时把 `config.parser`（BM_PARSER_URL / BM_PARSER_FALLBACK）
 * 从**死配置**接活——此前全代码库零引用。
 */

import { AppError } from "@brandsale/contracts";
import type { Config } from "@brandsale/config";

export interface ParsedDocument {
  text: string;
  /** 实际使用的解析通道，写进文档 meta 便于排障 */
  parser: "mineru" | "textonly";
  /** 页数（解析器能给出时） */
  pages?: number;
}

export interface DocumentParser {
  /** 该解析器能否处理此 mime。路由据此在解析前返回 415，而不是解析到一半失败 */
  supports(mime: string): boolean;
  parse(buffer: Uint8Array, mime: string, filename?: string): Promise<ParsedDocument>;
}

/** 去参数、转小写：`text/plain; charset=utf-8` → `text/plain` */
export function normalizeMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

export const TEXT_MIMES = ["text/plain", "text/markdown", "text/x-markdown", "application/json"];

export const BINARY_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
];

const decoder = new TextDecoder("utf-8", { fatal: false });

/** 仅处理纯文本。二进制一律拒绝——见文件头注释。 */
export function createTextonlyParser(): DocumentParser {
  return {
    supports: (mime) => TEXT_MIMES.includes(normalizeMime(mime)),
    async parse(buffer, mime) {
      const m = normalizeMime(mime);
      if (!TEXT_MIMES.includes(m)) {
        throw new AppError({
          code: "E-INGEST-002",
          message: `不支持的文档格式 ${m}（当前为纯文本模式，请配置 BM_PARSER_URL 以解析 pdf/docx 等）`,
          details: { mime: m, hint: "配置 BM_PARSER_URL 指向 MinerU 服务后即可解析二进制文档" },
        });
      }
      return { text: decoder.decode(buffer), parser: "textonly" };
    },
  };
}

interface MineruResultEntry {
  md_content?: string;
  markdown?: string;
  text?: string;
}

/** 从 MinerU 的多种返回形态里取正文；取不到返回 null 让调用方报错 */
function pickMarkdown(payload: unknown): { text: string; pages?: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const direct = p.md_content ?? p.markdown ?? p.text;
  if (typeof direct === "string" && direct.trim()) return { text: direct };

  const results = p.results;
  if (results && typeof results === "object") {
    const parts: string[] = [];
    for (const value of Object.values(results as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as MineruResultEntry;
      const t = entry.md_content ?? entry.markdown ?? entry.text;
      if (typeof t === "string" && t.trim()) parts.push(t);
    }
    if (parts.length) return { text: parts.join("\n\n") };
  }

  const data = p.data;
  if (Array.isArray(data)) {
    const parts = data
      .map((d) => (d && typeof d === "object" ? ((d as MineruResultEntry).text ?? "") : ""))
      .filter((t) => typeof t === "string" && t.trim());
    if (parts.length) return { text: parts.join("\n\n") };
  }

  return null;
}

export interface MineruOptions {
  /** 解析超时。文档解析远慢于普通接口，默认 60s */
  timeoutMs: number;
  /** 注入点，便于测试替换 */
  fetchImpl?: typeof fetch;
}

export function createMineruParser(baseUrl: string, opts: MineruOptions): DocumentParser {
  const root = baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    supports: (mime) => {
      const m = normalizeMime(mime);
      return TEXT_MIMES.includes(m) || BINARY_MIMES.includes(m);
    },
    async parse(buffer, mime, filename) {
      const m = normalizeMime(mime);

      // 纯文本没必要过一遍外部分析服务：多一次网络往返 + 多一个失败点，
      // 而且 MinerU 对 txt 的处理也就是原样返回。
      if (TEXT_MIMES.includes(m)) {
        return { text: decoder.decode(buffer), parser: "textonly" };
      }
      if (!BINARY_MIMES.includes(m)) {
        throw new AppError({
          code: "E-INGEST-002",
          message: `不支持的文档格式 ${m}`,
          details: { mime: m },
        });
      }

      const form = new FormData();
      const name = filename ?? `upload.${m.split("/").pop() ?? "bin"}`;
      form.append("files", new Blob([buffer], { type: m }), name);
      form.append("return_md", "true");

      let res: Response;
      try {
        res = await doFetch(`${root}/file_parse`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 解析器不可用属于**可重试**的基础设施故障，与"格式不支持"语义不同，
        // 但对外都是入库失败；用 E-PARSE-002 更贴合它的既有语义（解析器不可用）。
        throw new AppError({
          code: "E-PARSE-002",
          message: `文档解析服务调用失败：${msg}`,
          details: { url: `${root}/file_parse` },
          cause: e,
        });
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AppError({
          code: "E-PARSE-002",
          message: `文档解析服务返回 ${res.status}`,
          details: { status: res.status, body: body.slice(0, 300) },
        });
      }

      const payload = await res.json().catch(() => null);
      const picked = pickMarkdown(payload);
      if (!picked) {
        throw new AppError({
          code: "E-PARSE-001",
          message: "解析结果为空或格式无法识别（可能是扫描件 OCR 质量不足）",
          details: { hint: "检查 MinerU 返回结构，或改用已转好的 Markdown 上传" },
        });
      }
      return { text: picked.text, parser: "mineru", ...(picked.pages ? { pages: picked.pages } : {}) };
    },
  };
}

/**
 * 按配置选择解析器。`BM_PARSER_URL` 非空即启用 MinerU，否则退回纯文本模式。
 *
 * 注意这里**故意不做**"MinerU 挂了就自动退回纯文本"的降级：
 * 那会让 pdf 上传在服务抖动时静默变成"把二进制当文本"，
 * 正好是文件头注释要防的那类垃圾数据。解析器故障应当上抛。
 */
export function createParser(config: Config, opts: { fetchImpl?: typeof fetch } = {}): DocumentParser {
  const url = config.parser.url?.trim();
  if (!url) return createTextonlyParser();
  return createMineruParser(url, { timeoutMs: config.parser.timeoutMs, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
}

/** 路由用：把解析失败翻译成对外可读的提示 */
export function isUnsupportedFormat(e: unknown): boolean {
  return e instanceof AppError && e.code === "E-INGEST-002";
}

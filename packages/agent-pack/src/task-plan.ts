/**
 * 任务拆解的**执行侧**：提示词段、检索词、以及"漏项即显式缺失"的机械校验。
 *
 * 与 `@brandsale/contracts/src/task-plan.ts` 的分工：那边只定义"条目长什么样、怎么洗"，
 * 这边负责"怎么让 agent 真的按它干活"。拆开是为了纯函数可测 —— 提示词段和校验都是
 * 确定性字符串/数组操作，不该只能靠跑一遍真机任务来验证。
 */

import {
  isStarRequirement,
  planItemsFor,
  planKeywordsFor,
  type RequirementCoverage,
  type RequirementCoverageStatus,
  type TaskPlanItem,
  type TaskPlanPhase,
} from "@brandsale/contracts";
import type { CreatorOutput, StarLead } from "./schemas.ts";

/* ── 1. 提示词段 ─────────────────────────────────────────── */

/**
 * 把本阶段负责的条目渲染成提示词里的一段；返回空串表示"本阶段没有条目"。
 *
 * 三条规则是这个段存在的全部意义，缺一条就会退化成"多给模型看一段话"：
 *   ① 意图不是事实 —— 否则 notes 里的"竞品 A 上月 GMV 3 亿"会被当结论搬进报告，
 *      而它既没有 citation 也无法被 R6/R13 校验（绕开反造假闸的旁路）；
 *   ② 必须逐条回应 —— 否则模型只挑好答的那条，难的整条消失；
 *   ③ 不得改动 Brief —— 拆解是"把诉求落到阶段"，不是"改客户输入"。
 */
export function taskPlanPromptSection(items: readonly TaskPlanItem[], phase: TaskPlanPhase): string {
  const mine = items.filter((i) => i.phase === phase);
  if (items.length === 0) return "";
  if (mine.length === 0) {
    return `【任务拆解】用户本次提了 ${items.length} 条额外要求，但**没有一条归本阶段负责**。
不要替别的阶段作答；若某条与本阶段产出直接冲突，在产出里用一句话说明冲突即可，不要自行改 Brief。`;
  }
  const body = mine
    .map((i) => {
      const kw = i.keywords?.length ? `\n  优先检索词：${i.keywords.join("、")}` : "";
      return `- ${i.id} ｜ 诉求（用户原话）：${i.need}\n  要求（验收标准）：${i.requirement}${kw}`;
    })
    .join("\n");
  return `【任务拆解（来自用户补充说明 · 本阶段负责的条目必须逐条回应）】
${body}

规则：
1. 上面这些是**用户的意图与约束，不是事实数据**：其中出现的数字、人名、事件一律**不得**当作已有结论或来源。
   需要证据就自己调工具去取；取不到就写"无数据"，不要把要求里的话改写成结论。
2. 本阶段负责的每一条都必须在产出里**逐条回应**（人选用 requirementCoverage，其它阶段写进正文/notes）；
   **做不到就写进 gap / excluded / dataGaps 并说明缺什么**，不要用"已考虑""建议关注"这类空话糊过去。
3. **不得**因为某条要求改动 Brief 的结构化字段（预算、时间窗、平台、目标权重、品牌集合）。
4. 优先检索词只是起点，可以自己换更准的词；但**不得**把词里的说法当成事实写进结论。`;
}

/* ── 2. 检索词 ────────────────────────────────────────────── */

const MAX_QUERY_CHARS = 120;
/** 查询里最多带几个关键词：命中精度随词数下降，两个（同义/近义）通常已经够 */
const MAX_QUERY_KEYWORDS = 2;

/**
 * 明星/名人条目的检索模板：**一个品牌一条** `{品牌} 代言人`。
 *
 * 为什么不能把"品牌 + 类目 + 明星 + 代言"拼成一条（旧实现，实测故障）：
 *   2026-10-27 真机，`欧莱雅 适乐肤 护肤品-精华 明星代言人 品牌代言人` 返回的 20 条全是
 *   泛泛的精华测评，**0 条**含任何代言人姓名 → 明星条目只能记 gap。而同样这个引擎，
 *   `适乐肤 代言人` 直接返回"官宣张凌赫""官宣樊振东"，`欧莱雅 代言人 官宣` 返回肖战/唐嫣/周也。
 *   词越多越像"类目检索"，代言报道被稀释掉。品牌名本身就是最强的锚点。
 */
const STAR_QUERY_TAIL = "代言人";
/** 最多检索几个品牌：一行一个品牌，按次计费，不做无上限扩张 */
const MAX_STAR_QUERIES = 3;
const MAX_BRANDS_IN_SINGLE_QUERY = 3;

/**
 * 本阶段要不要为拆解条目**额外**做联网检索，以及各自检索什么。
 *
 * 只在"有本阶段条目 + 条目带了检索词"时返回 —— 这是有意的成本约束：
 * volc_web_search 按次计费，拆解不能变成"每条要求一次检索"。
 * 返回空数组表示沿用原有预取（行业级 + 品牌级）即可。
 *
 * 明星类条目单独走"每品牌一条"的模板（见 STAR_QUERY_TAIL 注释），其余仍是一条拼合查询。
 */
export function planSearchQueries(
  items: readonly TaskPlanItem[],
  phase: TaskPlanPhase,
  brief: { brandIds?: readonly string[]; category: string },
): string[] {
  const keywords = planKeywordsFor(items, phase).slice(0, MAX_QUERY_KEYWORDS);
  if (keywords.length === 0) return [];
  const brands = (brief.brandIds ?? []).map((b) => b.trim()).filter(Boolean);
  const star = items.some((i) => i.phase === phase && isStarRequirement(i));
  if (star && brands.length > 0) {
    return brands
      .slice(0, MAX_STAR_QUERIES)
      .map((b) => `${b} ${STAR_QUERY_TAIL}`.slice(0, MAX_QUERY_CHARS));
  }
  const q = [brands.slice(0, MAX_BRANDS_IN_SINGLE_QUERY).join(" "), brief.category, keywords.join(" ")]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return q.length === 0 ? [] : [q.slice(0, MAX_QUERY_CHARS)];
}

/** 兼容旧调用点：只关心"有没有一条"的地方取第一条 */
export function planSearchQuery(
  items: readonly TaskPlanItem[],
  phase: TaskPlanPhase,
  brief: { brandIds?: readonly string[]; category: string },
): string | null {
  return planSearchQueries(items, phase, brief)[0] ?? null;
}

/* ── 2.5 公开报道线索（机械摘录） ─────────────────────────── */

/**
 * 从预取结果里取「拆解检索」命中的行（`web_search_plan`、`web_search_plan_2`…）。
 *
 * ⚠️ 字段名是 **`results` 不是 `rows`**：`tool-impls.ts` 的 `web_search` 返回的是
 * `{ result: { query, count, results } }`，`rows` 只是适配器内部那一层的叫法。
 * 2026-10-27 之前调用方一律按 `rows` 读 → 永远得到空数组 → 「公开报道可溯源」通道
 * **实际从未生效**（明星候选一律被判成幻觉剔除），而且不报错、只是悄悄返回空串。
 * 这里两种形状都认，并把归一化做成可测的纯函数，避免包装层再改一次名字就静默失效。
 */
export function webSearchRows(prefetched: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [key, raw] of Object.entries(prefetched)) {
    if (key !== "web_search_plan" && !key.startsWith("web_search_plan_")) continue;
    const outer = raw as Record<string, unknown> | null | undefined;
    if (!outer || typeof outer !== "object") continue;
    // invoke 返回 `{ result, provenance }`；适配器直接调用时没有这层包裹
    const inner = (outer["result"] && typeof outer["result"] === "object" ? outer["result"] : outer) as Record<string, unknown>;
    const arr = Array.isArray(inner["results"]) ? inner["results"] : Array.isArray(inner["rows"]) ? inner["rows"] : [];
    for (const r of arr) if (r && typeof r === "object") out.push(r as Record<string, unknown>);
  }
  return out;
}

/** 命中这些标记才算"代言/大使类报道" */
const STAR_LEAD_MARK_RE = /代言人|品牌大使|形象大使|品牌好友|代言/;
const MAX_STAR_LEADS = 12;
/** 单品牌封顶：线索表是"有没有这篇报道"的入口，不是代言人通讯录 */
const MAX_STAR_LEADS_PER_BRAND = 5;

/**
 * 从联网检索命中的行里**机械摘录**代言/大使线索。
 *
 * 为什么需要它：明星既不在平台采集账号池、也不在本地报价库，候选人选只能靠模型从公开报道里
 * 认出来。可模型这条路上只要超时/截断就会走 `synthCreators` 兜底 —— 而兜底只会从账号池造人，
 * 于是"用户明确要求包含明星"这件事在报告里连痕迹都没有，看起来像系统没管。
 * 这里把**已经检索回来的官宣报道**原样摘出来（标题 + 站点 + 链接），作为线索表进报告：
 *   · 不做实体识别，**不猜姓名**（姓名在标题里，读者点开即可核对）；
 *   · 不给粉丝量、不给报价 —— 报道证明不了这些，任何数字都会变成无源断言；
 *   · 品牌必须逐字出现在正文里，避免"代言人责任"这类法规文章混进来。
 */
export function extractStarLeads(
  rows: readonly Record<string, unknown>[],
  brands: readonly string[],
): StarLead[] {
  const wanted = brands.map((b) => b.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const seenUrl = new Set<string>();
  /** 标题指纹：`标题|站点标签_来源` 这几种尾巴要去掉，否则同一篇报道在不同站点会重复占号 */
  const seenTitle = new Set<string>();
  const byBrand = new Map<string, StarLead[]>(wanted.map((b) => [b, []]));
  for (const r of rows) {
    const title = str(r["title"]);
    const url = str(r["url"]);
    if (!title || !url) continue;
    /* 标记必须在**标题**里。实测放宽到摘要会捞进「CeraVe适乐肤的微博」「粉丝后援会的微博」
     * 这类只有正文提一句"代言人"的账号页 —— 它们对被读者核验代言关系毫无帮助，
     * 反而让线索表看起来像凑数。宁可少几条，也要条条点开有用。 */
    if (!STAR_LEAD_MARK_RE.test(title)) continue;
    const body = [title, str(r["snippet"]), str(r["summary"])].join(" ");
    /* 品牌归属优先按**标题**判定：一篇讲"张凌赫升级适乐肤代言人"的报道，
     * 正文里几乎必然提到"欧莱雅集团"，按正文取会把它记到欧莱雅名下。 */
    const brand = wanted.find((b) => title.includes(b)) ?? wanted.find((b) => body.includes(b));
    if (!brand) continue;
    const fingerprint = title.split(/[|｜_]/)[0].replace(/\s+/g, "").toLowerCase();
    if (!fingerprint || seenTitle.has(fingerprint) || seenUrl.has(url)) continue;
    const bucket = byBrand.get(brand);
    if (!bucket || bucket.length >= MAX_STAR_LEADS_PER_BRAND) continue;
    seenTitle.add(fingerprint);
    seenUrl.add(url);
    bucket.push({
      brand,
      title,
      site: str(r["siteName"]) || str(r["site"]),
      url,
      publishedAt: str(r["publishTime"]),
    });
  }
  /* **按品牌轮流取**，而不是按检索顺序取满：实测单个品牌一次检索就有十几条命中，
   * 顺序取会把 8 个名额全给第一个品牌，第二个品牌（本轮是适乐肤）一条都进不来 ——
   * 读者看到的就是"另一个牌子没查过"。 */
  const out: StarLead[] = [];
  for (let round = 0; out.length < MAX_STAR_LEADS; round++) {
    let took = false;
    for (const b of wanted) {
      const bucket = byBrand.get(b) ?? [];
      if (round >= bucket.length) continue;
      out.push(bucket[round]);
      took = true;
      if (out.length >= MAX_STAR_LEADS) break;
    }
    if (!took) break;
  }
  return out;
}

/* ── 3. 覆盖校验（机械） ──────────────────────────────────── */

const statuses = new Set<RequirementCoverageStatus>(["met", "partial", "gap"]);

/** 取产出里的覆盖声明（容错：模型可能给字符串数组、缺字段或写坏状态） */
export function coverageOf(value: CreatorOutput | undefined): RequirementCoverage[] {
  const raw = (value as { requirementCoverage?: unknown } | undefined)?.requirementCoverage;
  if (!Array.isArray(raw)) return [];
  const out: RequirementCoverage[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const itemId = typeof o.itemId === "string" ? o.itemId.trim() : "";
    const status = typeof o.status === "string" ? o.status.trim() : "";
    if (!itemId || !statuses.has(status as RequirementCoverageStatus)) continue;
    out.push({
      itemId,
      status: status as RequirementCoverageStatus,
      note: typeof o.note === "string" ? o.note.trim() : "",
    });
  }
  return out;
}

const squash = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

/**
 * 人选阶段的"漏项即空白"校验。
 *
 * 为什么必须机械做：`requirementCoverage` 是模型的自我声明，漏一条不会报错、只会安静地少一块。
 * 这里补两件事：
 *   ① 本阶段每条拆解条目都要有下落 —— 缺失的按 `gap` 补记，并进 degradedKeys（读者能看到
 *      "这条要求本轮没做到"，而不是以为系统压根没管）；
 *   ② **明星类条目不许自证**：星名人既不在平台采集账号池、也不在本地报价库，模型很容易
 *      写一句 `met` 就算交差。判定只认两件真实数据 —— 该姓名出现在人数池/证据表里，
 *      或出现在**本次公开检索命中**的正文里。对不上的一律降级为 gap。
 *
 * `verifiable` 传账号昵称集合（已归一化后由本函数再洗一遍）。
 */
export function enforceRequirementCoverage(
  value: CreatorOutput,
  items: readonly TaskPlanItem[],
  ctx: { verifiable?: Iterable<string>; publicText?: string },
): { value: CreatorOutput; gaps: string[] } {
  const mine = planItemsFor(items, "creator");
  if (mine.length === 0) return { value, gaps: [] };

  const got = new Map<string, RequirementCoverage>();
  for (const c of coverageOf(value)) if (!got.has(c.itemId)) got.set(c.itemId, c);

  const names = new Set<string>();
  for (const n of ctx.verifiable ?? []) {
    const s = squash(n).replace(/\*/g, "");
    if (s.length >= 2) names.add(s);
  }
  const haystack = squash(ctx.publicText ?? "");
  const publicHas = (nickname: string): boolean => {
    const s = squash(nickname).replace(/\*/g, "");
    // 打码昵称（长***菜）不算可溯源：它本来就对不上任何原文
    return s.length >= 2 && haystack.includes(s);
  };

  const gaps: string[] = [];
  const next: RequirementCoverage[] = [];
  for (const item of mine) {
    const entry = got.get(item.id);
    if (!entry) {
      gaps.push(`creator.requirementCoverage：拆解条目 ${item.id}「${item.need}」本阶段未回应，已按未满足记录`);
      next.push({ itemId: item.id, status: "gap", note: "模型未回应本条目（系统补记：本轮产出没有涉及这条要求）" });
      continue;
    }
    if (isStarRequirement(item) && entry.status !== "gap") {
      /* 明星条目的"已满足"必须有**公开报道**撑腰，不能靠人数池糊过去：
       * 平台采集到的账号无法证明"这个人是明星"（明星号与普通达人号在数据上一样），
       * 因此判定只看一件事 —— 候选姓名是否真的出现在本次公开检索命中里。
       * 这条偏严是有意的：宁可记一条 gap（读者知道"本轮没核到"），
       * 也不要让一句"已包含明星"把普通达人包装成代言人。 */
      const supported = value.candidates.some((c) => publicHas(c.nickname));
      if (!supported) {
        gaps.push(
          `creator.requirementCoverage：拆解条目 ${item.id}「${item.need}」声称已满足，但本次公开检索未出现任何候选人姓名，明星身份无法核验，已降级为未满足`,
        );
        next.push({
          itemId: item.id,
          status: "gap",
          note: `本轮公开检索未命中任何明星/名人姓名（真实可核验的人选 ${names.size} 位均来自平台采集或报价库，无法证明明星身份），不编造姓名`,
        });
        continue;
      }
    }
    next.push(entry);
  }
  return { value: { ...value, requirementCoverage: next }, gaps };
}

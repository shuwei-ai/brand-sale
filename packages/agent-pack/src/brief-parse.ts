/**
 * 自然语言 Brief 解析 —— **LLM 补全段**。
 *
 * 与 `@brandsale/contracts` 里的规则段分工明确：
 *   - 规则段负责**确定**的字段（预算/时间窗/平台/权重/行业类目），抽出来就可解释、可复现；
 *   - 这里只在规则段仍有**关键字段缺失**时补**一次**，且**只补缺、不推翻**规则结果。
 *
 * 三条硬约束：
 *   ① 只在 missing 非空时调用 —— 规则段已抽全就不烧 token，也不给模型改写的机会；
 *   ② merge 时规则优先 —— 模型返回的字段若与规则冲突，一律丢弃（规则可解释，模型不可解释）；
 *   ③ 失败不抛异常 —— 解析只是录入的"糖"，模型不可用时应当退化成"规则结果 + 追问用户"，
 *      而不是让用户连表单都提交不了。
 *
 * 为什么要防到这一步：模型很乐意"帮你想一个预算"。预算与时间窗决定了整份排期，
 * 一旦被模型悄悄改写，报告会基于一个用户从未同意的数字展开。
 */

import {
  POPULAR_PLATFORMS,
  money,
  type Brief,
  type BriefDraft,
  type Platform,
} from "@brandsale/contracts";
import type { ModelGateway } from "@brandsale/model-gateway";

export interface BriefParseResult extends BriefDraft {
  /**
   * 解析路径。
   *   - `"rule"`：只用了规则（关键字段本就齐全，或模型不可用/无贡献）；
   *   - `"rule+llm"`：模型**成功参与了**（哪怕它只是提出澄清问题、一个字段都没补）。
   * 注意判定依据是"模型调用成功"，不是"模型补到了字段"——
   * 模型回答"我不知道，请用户补充"同样是有效参与，把它记成 `rule` 会掩盖真实过程。
   */
  source: "rule" | "rule+llm";
  /** 明确哪些字段是**模型**补上的（`filled` 里混着规则结果，这个字段用于区分） */
  filledByModel: string[];
  /** 模型提出的澄清问题（规则段的 ambiguities 之外） */
  clarifications: string[];
  /** 走了 LLM 但没走通时的原因，前端可据此提示"AI 补全不可用，请手工补" */
  llmNote?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/**
 * 只接受**形状正确**的字段，其余一律丢弃。
 * 不信任模型返回的结构：多出来的字段、类型不对的字段都要挡在外面，
 * 否则一个 `budget: "300万"` 就能让下游按字符串算钱。
 */
function sanitizeFill(raw: unknown): Partial<Brief> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<Brief> = {};

  const industry = str(o.industry);
  if (industry) out.industry = industry;
  const category = str(o.category);
  if (category) out.category = category;

  if (Array.isArray(o.brandIds)) {
    const ids = o.brandIds.map((x) => str(x)).filter((x): x is string => x !== undefined);
    if (ids.length > 0) out.brandIds = ids;
  }

  const budget = o.budget as Record<string, unknown> | undefined;
  if (budget && typeof budget.amount === "number" && Number.isFinite(budget.amount) && budget.amount > 0) {
    // Currency 目前只有 CNY（见 contracts/common.ts），无需也不该接受模型给出的币种
    out.budget = money(budget.amount);
  }

  const window = o.window as Record<string, unknown> | undefined;
  if (window) {
    const from = str(window.from);
    const to = str(window.to);
    if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to) out.window = { from, to };
  }

  if (Array.isArray(o.platforms)) {
    const ps = o.platforms
      .map((p) => str(p))
      .filter((p): p is Platform => p !== undefined && (POPULAR_PLATFORMS as readonly string[]).includes(p));
    if (ps.length > 0) out.platforms = [...new Set(ps)];
  }

  const ow = o.objectiveWeights as Record<string, unknown> | undefined;
  if (ow) {
    const pick = (k: string): number | undefined => {
      const v = ow[k];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
    };
    const a = pick("awareness");
    const c = pick("conversion");
    const r = pick("retention");
    if (a !== undefined && c !== undefined && r !== undefined) {
      const sum = a + c + r;
      // 模型算不对权重之和是常态，归一化比报错更有用（且这里归一化是安全的：比例关系仍由模型给出）
      if (sum > 0) {
        const n = (x: number): number => Math.round((x / sum) * 1000) / 1000;
        out.objectiveWeights = { awareness: n(a), conversion: n(c), retention: n(r) };
      }
    }
  }

  return out;
}

const FILL_PROMPT = (utterance: string, known: Partial<Brief>, missing: string[]): string => `你在帮用户把一个品牌营销任务录入系统。

【用户原话】
${utterance}

【已用规则确定的字段（这些是**确定**的，不要修改、不要重复输出）】
${JSON.stringify(known, null, 1)}

【仍缺失、需要你根据原话推断补全的字段】
${missing.join("、")}

只输出**上述缺失字段**中你能从原话推断出来的部分。

规则：
1. **只输出上面列出的缺失字段**；不要重复输出已确定的字段，不要发明其它字段。
2. 推断不出来就**不要写这个字段**，改为在 clarifications 里向用户提问。**绝不编造**：
   预算、时间窗这类数字决定了整份方案，猜错比缺失更糟。
3. budget 形如 { "amount": number, "currency": "CNY" }，amount 单位是**元**，纯数字不加引号。
4. window 形如 { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }。
5. platforms 只能取 douyin / xiaohongshu / bilibili / weibo。
6. objectiveWeights 三项（awareness / conversion / retention）之和必须为 1。

输出 JSON：
{ "brief": { "只包含你补的字段": "..." }, "clarifications": ["向用户追问的问题"] }`;

/**
 * 在规则段结果之上做一次 LLM 补全。
 *
 * 返回的 `brief` 满足：**规则抽到的字段一定等于规则结果**（模型无法改写），
 * 模型只可能填充 rules 没抽到的字段。
 */
export async function completeBriefDraft(
  utterance: string,
  draft: BriefDraft,
  deps: { gateway: ModelGateway; jobId: string; signal?: AbortSignal },
): Promise<BriefParseResult> {
  const base: BriefParseResult = { ...draft, source: "rule", filledByModel: [], clarifications: [] };

  // ① 规则段已抽全 → 不调模型
  if (draft.missing.length === 0) return base;

  // ② 规则段的确定性结果：模型返回后用于"覆盖回去"，保证规则优先
  const ruleOwned: Partial<Brief> = {};
  for (const f of draft.filled) {
    const v = draft.brief[f as keyof Brief];
    if (v !== undefined) (ruleOwned as Record<string, unknown>)[f] = v;
  }

  let raw: string;
  try {
    const res = await deps.gateway.completeJson<{ brief: unknown; clarifications: unknown }>({
      tier: "light",
      // 录入解析不需要强模型：只是从一句话里补几个结构化字段
      system: "你是一个严谨的任务录入助手。你从不编造用户没说的数字。只输出 JSON。",
      prompt: FILL_PROMPT(utterance, ruleOwned, draft.missing),
      schemaName: "BriefDraftFill",
      maxTokens: 1024,
      jobId: deps.jobId,
      phase: "intake",
      attempt: 1,
      callId: `brief_parse_${deps.jobId}`,
      ...(deps.signal ? { signal: deps.signal } : {}),
      parse: (text) => {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed !== "object" || parsed === null) throw new Error("输出必须是 JSON 对象");
        return parsed as { brief: unknown; clarifications: unknown };
      },
    });
    if (!res.ok) {
      // ③ 模型不可用不是错误路径：退回纯规则结果 + 让用户手工补
      return { ...base, llmNote: `AI 补全不可用（${res.code}），请手工补齐缺失字段` };
    }
    raw = res.raw;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, llmNote: `AI 补全调用失败（${msg}），请手工补齐缺失字段` };
  }

  // ④ 合并：只接受"缺失字段"里模型给出的值；缺失字段之外一律以规则结果为准
  let filledByModel: Partial<Brief> = {};
  let clarifications: string[] = [];
  try {
    const parsed = JSON.parse(raw) as { brief?: unknown; clarifications?: unknown };
    filledByModel = sanitizeFill(parsed.brief);
    clarifications = Array.isArray(parsed.clarifications)
      ? parsed.clarifications.map((c) => str(c)).filter((c): c is string => c !== undefined)
      : [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, llmNote: `AI 返回内容无法解析（${msg}），请手工补齐缺失字段` };
  }

  const accepted: Partial<Brief> = {};
  for (const f of draft.missing) {
    const v = (filledByModel as Record<string, unknown>)[f];
    if (v !== undefined) (accepted as Record<string, unknown>)[f] = v;
  }

  const brief: Partial<Brief> = { ...draft.brief, ...accepted };
  const missing = draft.missing.filter((f) => (accepted as Record<string, unknown>)[f] === undefined);
  const ambiguities = draft.ambiguities.filter((a) => missing.includes(a.field));

  return {
    brief,
    filled: [...draft.filled, ...Object.keys(accepted)],
    filledByModel: Object.keys(accepted),
    missing,
    ambiguities,
    // 调用成功即算"模型参与过"——即使它只是回了一句"请用户补充行业"
    source: "rule+llm",
    clarifications,
  };
}

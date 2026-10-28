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
 *
 * **唯一的例外是 `brandIds`**：它是「可选字段」——不在 `BRIEF_REQUIRED_FIELDS` 里，
 * 因此永远不会出现在 missing 中，也就永远轮不到模型补，这正是"填了『关注欧莱雅、适乐肤』
 * 却一个品牌也识别不出来"的原因（规则段压根没有品牌解析器）。但中文品牌名没有可靠的
 * 形态特征（「欧莱雅」和「精华」在字面上无从区分），规则抽取必然大面积误报，所以品牌
 * **专门交给模型**：由 `BRAND_CONTEXT_RE` 做一次廉价预判决定"要不要问"，模型只负责摘录。
 * 这条路径仍然受 ② 约束——表单已有品牌（`defaults.brandIds`）时不问也不覆盖。
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
    // 只按**字面**去重（「欧莱雅」与「巴黎欧莱雅」是不同的字符串，不能合并），并截到 10 个：
    // 竞品集合是要逐个去联网检索与采集的，超量只说明模型把长尾水牌也数进来了。
    const uniq = [...new Set(ids)];
    if (uniq.length > 0) out.brandIds = uniq.slice(0, 10);
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

/**
 * 品牌语境的**触发词**。
 *
 * 它只回答"这句话要不要问模型"，**不负责抽取品牌名本身**：中文品牌名没有可靠的形态特征，
 * 规则抽取必然把「精华」「明星代言」这类词也吞进来；真正的识别交给模型。这里做一次廉价
 * 预判，是为了不让每条 brief（尤其那些压根没提品牌的）都白烧一次模型调用。
 *
 * 为什么不能只认「品牌/竞品」这几个元词：用户常常**直接点名品牌却不写元词**——
 * 例如「波司登或鸭鸭羽绒服的明星同款投放」「波司登、鸭鸭、高梵三个羽绒服品牌」。
 * 这类表达里品牌名与品类词在字面上无从区分，规则正则无法可靠抽取，但它的**结构特征**
 * （顿号/「或」连接的并列名词、后接品类词，或「明星同款/代言」这种与品牌强绑定的措辞）
 * 却足以作为"值得问一次模型"的廉价信号。宁可多问一次 light 模型，也不能让点名了品牌的
 * brief 静默丢掉竞品集合（竞品集合决定整份差距矩阵展开在谁身上）。
 */
const BRAND_CONTEXT_RE =
  /品牌|竞品|竞对|对标|牌子|明星同款|明星代言|代言人|知名品牌|头部品牌|一线品牌|大牌|老字号/;

/**
 * 并列名词信号：顿号（、）或「或」连接的连续名词片段，后跟品类词。
 * 例：「波司登或鸭鸭羽绒服」→「波司登或鸭鸭」+「羽绒服」；「波司登、鸭鸭、高梵三个羽绒服品牌」→ 命中。
 * 这是"直接点名品牌但没写元词"的另一种常见形态：品牌名与品类词在字面上无法区分，
 * 但「X或Y / X、Y、Z + 品类词」的结构足以作为"值得问一次模型"的廉价证据。
 * 不要求品牌名本身可枚举——真正的摘录仍交给模型。
 */
const BRAND_PARALLEL_RE = /[\u4e00-\u9fffA-Za-z0-9]{1,8}(?:[、或/][\u4e00-\u9fffA-Za-z0-9]{1,8})+/;

/** 判断一段诉求是否值得为品牌摘录调一次模型（不含「表单已有品牌则不覆盖」那条约束）。 */
export function hasBrandContext(utterance: string): boolean {
  const text = (utterance ?? "").trim();
  if (text.length === 0) return false;
  return BRAND_CONTEXT_RE.test(text) || BRAND_PARALLEL_RE.test(text);
}

const FILL_PROMPT = (
  utterance: string,
  known: Partial<Brief>,
  missing: string[],
  wantBrands: boolean,
): string => `你在帮用户把一个品牌营销任务录入系统。

【用户原话】
${utterance}

【已用规则确定的字段（这些是**确定**的，不要修改、不要重复输出）】
${JSON.stringify(known, null, 1)}

【仍缺失、需要你根据原话推断补全的字段】
${missing.length > 0 ? missing.join("、") : "（无）"}
${
  wantBrands
    ? `
【可选补充字段（不在缺失清单里，但可以从原话摘录）】
brandIds —— 用户在**原话里明确提到**的品牌名数组，按原样保留（例如 ["欧莱雅","适乐肤"]）。
`
    : ""
}
只输出**上述字段**中你能从原话推断出来的部分。

规则：
1. **只输出上面列出的字段**；不要重复输出已确定的字段，不要发明其它字段。
2. 推断不出来就**不要写这个字段**，改为在 clarifications 里向用户提问。**绝不编造**：
   预算、时间窗这类数字决定了整份方案，猜错比缺失更糟。
3. budget 形如 { "amount": number, "currency": "CNY" }，amount 单位是**元**，纯数字不加引号。
4. window 形如 { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }。
5. platforms 只能取 douyin / xiaohongshu / bilibili / weibo。
6. objectiveWeights 三项（awareness / conversion / retention）之和必须为 1。
7. industry / category 必须是**中文短语**（industry 形如「3C数码」「美妆个护」，
   category 形如「耳机」「护肤品-精华」）。**绝不要用英文或下划线标识符**
   （consumer_electronics / headphones 这类）。原因：category 会被**逐字用作平台内的
   搜索关键词**，英文词在抖音/小红书/B站搜不到内容（实测小红书 0 条）。
8. brandIds 只能**原样摘录原话里出现过的品牌名**：不要翻译、不要展开简称、不要补全
   「这个赛道还有谁」、不要把品类词（精华 / 保暖内衣）或渠道词（抖音 / 小红书）当品牌。
   宁可漏掉，也不要写一个用户没提过的品牌——品牌集合就是竞品集合，凭空多一个，
   整份竞品格局与差距矩阵都会对着无关品牌展开。原话一个品牌都没提，就不要输出该字段。

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

  /**
   * 品牌是否值得问模型：
   *   · 表单/默认值里已有品牌 → 不问（受约束 ② 保护，不让模型覆盖用户/表单的选择）；
   *   · 原话里没有品牌语境触发词 → 不问（规则段已抽全的 brief 仍保持"零调用"）。
   */
  const wantBrands = (draft.brief.brandIds?.length ?? 0) === 0 && hasBrandContext(utterance);

  // ① 关键字段齐全、且没有品牌可摘 → 不调模型
  if (draft.missing.length === 0 && !wantBrands) return base;

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
      prompt: FILL_PROMPT(utterance, ruleOwned, draft.missing, wantBrands),
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

  /**
   * brandIds 单独放行：它不在 `BRIEF_REQUIRED_FIELDS` 里，因此不可能出现在 `draft.missing`，
   * 上面那个白名单循环永远轮不到它。**只额外放开这一个键**，其余字段的白名单不变——
   * 放宽成"模型返回什么都收"会让预算/时间窗的规则优先权一起失守。
   */
  if (wantBrands && filledByModel.brandIds?.length) {
    accepted.brandIds = filledByModel.brandIds;
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

/**
 * 任务拆解（Task Plan）—— 把 `brief.notes`（补充说明）里的零散诉求变成「谁负责、怎么算做到」的条目。
 *
 * 为什么需要这一层：`notes` 原本只是把用户原话拼进提示词，**没有任何阶段负责它**。
 * 用户写「需要明星代言」「只看人选不要排期」，六个阶段的产出与它无关 —— 报告照样跑完，
 * 但一个字都没回应。拆解层解决的是"诉求 → 责任阶段 → 可验收要求"这条链，而不是
 * 让模型"多读一段话"。
 *
 * 三条边界（与 R6/R13 的反造假约定一致，勿放宽）：
 *   ① **意图不是事实**：notes 里出现的数字、人名、事件一律不得当作已有结论，
 *      只能变成"要去取数 / 要去覆盖"的要求；
 *   ② **阶段固定**：`phase` 只表示"这条归谁负责"，不得据此增删或重排六个阶段；
 *   ③ **缺失要显式**：做不到就写进 excluded / dataGaps / coverage 的 gap，不许沉默跳过。
 *
 * 归一化刻意容错：模型输出的 phase / id / keywords 都可能不规范，这里统一洗一遍，
 * 宁可降级也不能让整条诉求因为一个字段拼错就凭空消失。
 */

/** 拆解条目可以落到哪些阶段（intake 自己不接条目：它是拆解者） */
export const TASK_PLAN_PHASES = ["intel", "creator", "playbook", "budget", "report"] as const;
export type TaskPlanPhase = (typeof TASK_PLAN_PHASES)[number];

export interface TaskPlanItem {
  /** 稳定标识：P1 / P2 …… 报告与 coverage 都靠它对账 */
  id: string;
  /** 用户原话的逐字摘录（不改写、不合并） */
  need: string;
  /** 这条要求由哪个阶段负责 */
  phase: TaskPlanPhase;
  /** 验收标准：看到产出就能判断"做到没做到"的一句话 */
  requirement: string;
  /** 可选检索词（用于取数，**不是**结论）。最多 3 个 */
  keywords?: string[];
}

/** 上限：一张报告塞 20 条"要求"就等于没有要求 */
export const TASK_PLAN_MAX_ITEMS = 8;
/** 每条最多保留几个关键词（检索词越多，命中越散） */
export const TASK_PLAN_MAX_KEYWORDS = 3;

/**
 * 「要明星 / 名人」这类诉求的识别词。
 *
 * 它不是用来"抽明星名字"的（中文人名没有形态特征，规则抽必然误报），只用来判断
 * **这条要求的验收要不要走"公开报道可溯源"这条更严的通道** —— 明星既不在平台
 * 采集账号池里、也不在本地报价库里，普通的人选溯源闸门会把模型写的明星全部剔除，
 * 所以这一类必须额外要求"姓名在本次公开检索里出现过"。
 */
export const STAR_PERSONA_RE = /明星|艺人|名人|顶流|偶像|代言人/;

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

const isPhase = (v: unknown): v is TaskPlanPhase =>
  typeof v === "string" && (TASK_PLAN_PHASES as readonly string[]).includes(v);

/**
 * 把模型给的 taskPlan 洗成可用条目。
 *
 * 容错策略（每一处都对应一种实测过的坏输出）：
 *   · 不是数组 / 全空 → 返回 `[]`（表示"用户没提额外要求"，是合法状态，不是错误）；
 *   · phase 拼错或缺失 → 归到 `report`（报告的兜底职责是"必须提到这件事"，
 *     直接丢弃会让用户的诉求在最后一环彻底消失）；
 *   · id 缺失 / 重复 → 按 P1..Pn 重新编号并去重（coverage 靠它对账，重复即错乱）；
 *   · need 与 requirement 任一为空 → 丢弃（没有诉求或没有验收标准的条目无法执行）。
 */
export function normalizeTaskPlan(input: unknown): TaskPlanItem[] {
  if (!Array.isArray(input)) return [];
  const out: TaskPlanItem[] = [];
  const seenIds = new Set<string>();
  const seenNeed = new Set<string>();
  for (const raw of input) {
    if (out.length >= TASK_PLAN_MAX_ITEMS) break;
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const need = asString(o.need);
    const requirement = asString(o.requirement);
    if (!need || !requirement) continue;
    // 同一条原话重复拆（模型常见：把一句话拆成两条几乎相同的条目）
    if (seenNeed.has(need)) continue;
    seenNeed.add(need);

    const wanted = asString(o.id) ?? `P${out.length + 1}`;
    let id = wanted;
    for (let n = 2; seenIds.has(id); n++) id = `${wanted}-${n}`;
    seenIds.add(id);

    const keywords = Array.isArray(o.keywords)
      ? [...new Set(o.keywords.map(asString).filter((k): k is string => Boolean(k)))].slice(0, TASK_PLAN_MAX_KEYWORDS)
      : [];

    out.push({
      id,
      need,
      phase: isPhase(o.phase) ? o.phase : "report",
      requirement,
      ...(keywords.length > 0 ? { keywords } : {}),
    });
  }
  return out;
}

/** 某阶段要负责的条目（顺序即原顺序，便于确定性断言） */
export function planItemsFor(plan: readonly TaskPlanItem[], phase: TaskPlanPhase): TaskPlanItem[] {
  return plan.filter((i) => i.phase === phase);
}

/** 某阶段条目上的检索词（去重、保序） */
export function planKeywordsFor(plan: readonly TaskPlanItem[], phase: TaskPlanPhase): string[] {
  const out: string[] = [];
  for (const item of planItemsFor(plan, phase)) {
    for (const k of item.keywords ?? []) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** 这条要求是否在要「明星 / 名人」——决定人选能否走公开报道溯源通道 */
export function isStarRequirement(item: TaskPlanItem): boolean {
  return STAR_PERSONA_RE.test(`${item.need} ${item.requirement} ${(item.keywords ?? []).join(" ")}`);
}

/**
 * 人选阶段对每条拆解条目的回应（`CreatorOutput.requirementCoverage`）。
 *
 * `gap` 是**合法且常见**的结果：明星既不在平台采集账号池、也不在本地报价库时，
 * 正确做法就是如实记 gap，而不是编一个名字。报告的读者看到 gap 才知道"这条没做到"。
 */
export type RequirementCoverageStatus = "met" | "partial" | "gap";

export interface RequirementCoverage {
  /** 对应 `TaskPlanItem.id` */
  itemId: string;
  status: RequirementCoverageStatus;
  /** 做到了什么 / 缺什么（缺的时候必须写清缺哪类数据） */
  note: string;
}

/** 从上游 intake 产物里取拆解结果（老任务没有这个字段 → 空数组，不是错误） */
export function taskPlanOf(intake: unknown): TaskPlanItem[] {
  if (typeof intake !== "object" || intake === null) return [];
  return normalizeTaskPlan((intake as { taskPlan?: unknown }).taskPlan);
}

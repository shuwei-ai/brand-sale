/**
 * 自然语言 Brief 解析 —— **规则段**（纯函数，零依赖）。
 *
 * 设计取舍：为什么不做成"整段交给 LLM 解析"。
 * 预算、时间窗、平台、目标权重这四类是**强结构化**的，正则能稳定抽出来，而且抽出来的
 * 结果**可解释**（"从文本中识别到预算 ¥300 万"），出错时能一眼看出是规则错还是模型错。
 * 全交给 LLM 会引入不确定性，且每次解析都要烧 token。
 * 所以这里做规则优先，只在关键字段仍缺失时才让模型补一次（见 agent-pack 的补全段）。
 *
 * 本文件不能有 IO、不能依赖 config —— 它是 `contracts` 的叶子代码，只允许 import
 * common.ts / job.ts 的类型与常量。
 */

import { POPULAR_PLATFORMS, money, type Platform } from "./common.ts";
import type { Brief, TimeWindow } from "./job.ts";

export interface BriefDraft {
  /**
   * 合并后的草稿：先铺 `defaults`（表单当前值），再被**文本识别结果**覆盖。
   * 之所以识别结果优先：用户特意写出来的应该赢过表单里的旧值。
   */
  brief: Partial<Brief>;
  /** **本次文本**识别到的字段（不含从 defaults 继承来的） */
  filled: string[];
  /** 合并 defaults 之后仍缺失的关键字段 */
  missing: string[];
  /** 针对缺失字段的追问；有可枚举选项时给出 options */
  ambiguities: { field: string; question: string; options?: string[] }[];
}

/** 关键字段：缺任何一个都不该直接开跑（缺的可让 LLM 补一次，仍缺则向用户提问） */
export const BRIEF_REQUIRED_FIELDS = ["industry", "category", "budget", "window", "platforms"] as const;

/* ── 通用小工具 ─────────────────────────────────────────── */

const pad = (n: number): string => String(n).padStart(2, "0");
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};

/**
 * 中文数字 → 数值。支持"十 / 十五 / 二十 / 二十五 / 三百 / 一千二 / 五百万"。
 * 拒绝任何含未知字符的输入（返回 null），宁可抽不到也不猜。
 */
export function cnToNumber(input: string): number | null {
  // 千分位（"1,200,000"）是常见输入，先去分隔符再判断，否则会被当成中文数字解析失败
  const s = input.trim().replace(/,/g, "");
  if (s.length === 0) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);

  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
      seen = true;
      continue;
    }
    if (ch === "万") {
      section = (section + digit) * 10_000;
      total += section;
      section = 0;
      digit = 0;
      seen = true;
      continue;
    }
    const u = units[ch];
    if (u !== undefined) {
      // "十五" 的十前面没有数字 → 视为 1×10
      section += (digit || 1) * u;
      digit = 0;
      seen = true;
      continue;
    }
    return null;
  }
  return seen ? total + section + digit : null;
}

/* ── 预算 ───────────────────────────────────────────────── */

const MONEY_UNIT: Record<string, number> = {
  亿: 100_000_000,
  万: 10_000,
  w: 10_000,
  W: 10_000,
  k: 1_000,
  K: 1_000,
  千: 1_000,
  元: 1,
  块: 1,
};

const CN_NUM_CHARS = "零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千万";
/** 数字：允许千分位（1,200,000）与小数 */
const NUM_PATTERN = `(\\d[\\d,]*(?:\\.\\d+)?|[${CN_NUM_CHARS}]+)`;
const BUDGET_KEYWORDS = "预算|费用|金额|投入|花费|投放金额|总金额|总预算|预算金额|budget|spend|investment";

/**
 * 抽预算。
 *
 * 关键点：**没有单位的裸数字一律不认**。"近90天""11.11""Q4""3家"里全是数字，
 * 一旦放宽就会抽出一个荒唐的预算。所以：
 *   ① 先找"关键词 + 数字 + 单位"（最强证据）；
 *   ② 再找"数字 + 金额单位"（万/亿/w/k，单位本身就是证据）；
 *   ③ 最后才接受"关键词 + 裸数字"（如"预算 300000"）。
 */
export function parseBudget(text: string): number | null {
  const num = NUM_PATTERN;

  // ① 关键词 + 数字 + 单位
  const kwUnit = new RegExp(`(?:${BUDGET_KEYWORDS})[^0-9${CN_NUM_CHARS}]{0,6}?${num}\\s*(亿|万|w|W|k|K|千|元|块)`, "i");
  const m1 = kwUnit.exec(text);
  if (m1) {
    const v = cnToNumber(m1[1]!);
    const u = MONEY_UNIT[m1[2]!];
    if (v !== null && u !== undefined) return Math.round(v * u);
  }

  // ② 数字 + 金额量级单位（万/亿/w/k）—— 单位本身就是证据，不要求带"预算"字样
  const unitOnly = new RegExp(`${num}\\s*(亿|万|w|W|k|K)`, "i");
  const m2 = unitOnly.exec(text);
  if (m2) {
    const v = cnToNumber(m2[1]!);
    const u = MONEY_UNIT[m2[2]!];
    if (v !== null && u !== undefined) return Math.round(v * u);
  }

  // ③ 关键词 + 裸数字（给了元/块最好，没给也接受——因为有"预算"这个词定调）
  const kwPlain = new RegExp(`(?:${BUDGET_KEYWORDS})[^0-9${CN_NUM_CHARS}]{0,6}?${num}`, "i");
  const m3 = kwPlain.exec(text);
  if (m3) {
    const v = cnToNumber(m3[1]!);
    if (v !== null && v >= 1_000) return Math.round(v);
  }

  return null;
}

/* ── 时间窗 ─────────────────────────────────────────────── */

interface WindowHit {
  window: TimeWindow;
  /** 固定节日/季度：若已过去则滚到明年（"双11"在 12 月说，指的是下一年的） */
  rollForward: boolean;
}

/**
 * 抽时间窗。识别不出返回 null —— 不要用"今天起 90 天"之类的默认值蒙混，
 * 时间窗错了会让整份排期全错。
 */
export function parseWindow(text: string, now = new Date()): TimeWindow | null {
  const y = now.getFullYear();
  const hits: WindowHit[] = [];

  const fixed = (label: RegExp, from: (yy: number) => string, to: (yy: number) => string): void => {
    if (label.test(text)) hits.push({ window: { from: from(y), to: to(y) }, rollForward: true });
  };

  // 大促：双11 / 618 / 双12
  fixed(/双\s*11|11\.11|11\s*月\s*11|双十一/, (yy) => `${yy}-11-01`, (yy) => `${yy}-11-11`);
  fixed(/618|6\.18|六一八/, (yy) => `${yy}-06-01`, (yy) => `${yy}-06-18`);
  fixed(/双\s*12|12\.12|双十二/, (yy) => `${yy}-12-01`, (yy) => `${yy}-12-12`);

  // 季度
  const q = /\bQ([1-4])\b/i.exec(text) ?? /第\s*([一二三四])\s*季度/.exec(text);
  if (q) {
    const idx = /^\d$/.test(q[1]!) ? Number(q[1]) - 1 : "一二三四".indexOf(q[1]!);
    if (idx >= 0) {
      const startMonth = idx * 3;
      const from = new Date(y, startMonth, 1);
      const to = new Date(y, startMonth + 3, 0);
      hits.push({ window: { from: ymd(from), to: ymd(to) }, rollForward: true });
    }
  }

  // 相对月份
  if (/本月|这个月|当月|当前月/.test(text)) {
    const from = new Date(y, now.getMonth(), 1);
    const to = new Date(y, now.getMonth() + 1, 0);
    hits.push({ window: { from: ymd(from), to: ymd(to) }, rollForward: false });
  } else if (/下个月|下月/.test(text)) {
    const from = new Date(y, now.getMonth() + 1, 1);
    const to = new Date(y, now.getMonth() + 2, 0);
    hits.push({ window: { from: ymd(from), to: ymd(to) }, rollForward: false });
  } else if (/上个月|上月/.test(text)) {
    const from = new Date(y, now.getMonth() - 1, 1);
    const to = new Date(y, now.getMonth(), 0);
    hits.push({ window: { from: ymd(from), to: ymd(to) }, rollForward: false });
  }

  // 近 N 天 / 周 / 月
  const rel = /近\s*(\d+)\s*(天|日|周|个?星期|个?月)/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unitDays = rel[2]!.includes("天") || rel[2]!.includes("日") ? 1 : rel[2]!.includes("月") ? 30 : 7;
    const from = new Date(now.getTime() - n * unitDays * 86_400_000);
    hits.push({ window: { from: ymd(from), to: ymd(now) }, rollForward: false });
  }

  // 明确的年月 / 年月范围
  const explicitRange = /(\d{4})?年?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:到|至|~|-|—)\s*(\d{4})?年?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
  if (explicitRange) {
    const y1 = explicitRange[1] ? Number(explicitRange[1]) : y;
    const y2 = explicitRange[4] ? Number(explicitRange[4]) : y;
    hits.push({
      window: { from: ymd(new Date(y1, Number(explicitRange[2]) - 1, Number(explicitRange[3]))), to: ymd(new Date(y2, Number(explicitRange[5]) - 1, Number(explicitRange[6]))) },
      rollForward: false,
    });
  } else {
    const ym = /(\d{4})年\s*(\d{1,2})\s*月/.exec(text);
    if (ym) {
      const yy = Number(ym[1]);
      const mm = Number(ym[2]) - 1;
      hits.push({ window: { from: ymd(new Date(yy, mm, 1)), to: ymd(new Date(yy, mm + 1, 0)) }, rollForward: false });
    }
  }

  if (hits.length === 0) return null;

  // 命中多个时取**最长**的那个：显式区间 > 单月 > 大促
  const best = hits.reduce((a, b) => (span(b.window) > span(a.window) ? b : a));
  let { from, to } = best.window;
  if (best.rollForward && to < ymd(now)) {
    // 已过去 → 顺延一年（"双11"在 12 月提到，说的是明年那次）
    const shift = (s: string): string => `${Number(s.slice(0, 4)) + 1}${s.slice(4)}`;
    from = shift(from);
    to = shift(to);
  }
  return { from, to };

  function span(w: TimeWindow): number {
    return new Date(w.to).getTime() - new Date(w.from).getTime();
  }
}

/* ── 平台 ───────────────────────────────────────────────── */

const PLATFORM_ALIASES: { re: RegExp; platform: Platform }[] = [
  { re: /抖音|douyin|dy\b/i, platform: "douyin" },
  { re: /小红书|红书|xiaohongshu|xhs/i, platform: "xiaohongshu" },
  { re: /B\s*站|哔哩|bilibili|b站/i, platform: "bilibili" },
  { re: /微博|weibo/i, platform: "weibo" },
];

/** 按**文本出现顺序**返回平台（顺序本身有信息量：先说的一般是主阵地） */
export function parsePlatforms(text: string): Platform[] {
  const found: { at: number; platform: Platform }[] = [];
  for (const { re, platform } of PLATFORM_ALIASES) {
    const m = re.exec(text);
    if (m) found.push({ at: m.index, platform });
  }
  found.sort((a, b) => a.at - b.at);
  const unique = [...new Set(found.map((f) => f.platform))];
  return unique.filter((p) => (POPULAR_PLATFORMS as readonly string[]).includes(p));
}

/* ── 目标权重 ───────────────────────────────────────────── */

/**
 * 目标权重。
 * ① 文本里写了明确百分比（"曝光 60% 转化 30%"）→ 直接用，剩余部分摊给未提及项；
 * ② 否则按关键词命中次数归一化 —— 这是**有偏**的，所以只在没有明确数字时用，
 *    且要求至少命中 2 个不同维度（只提到一个维度说明信息量不足，交给 LLM 或追问）。
 * 中英关键词都认：中文诉求里夹 "focus on awareness and conversion" 很常见。
 */
const WEIGHT_KEYWORDS: Record<"awareness" | "conversion" | "retention", string[]> = {
  awareness: ["曝光", "声量", "认知", "知名度", "种草", "破圈", "拉新", "铺量", "打响声量", "awareness", "brand awareness", "reach"],
  conversion: ["销量", "转化", "成交", "GMV", "带货", "下单", "卖货", "roi", "销售额", "冲销量", "conversion", "sales", "performance"],
  retention: ["复购", "留存", "会员", "私域", "忠诚", "品牌形象", "心智", "口碑沉淀", "长尾", "retention", "loyalty", "brand equity"],
};

export function parseWeights(text: string): { awareness: number; conversion: number; retention: number } | null {
  const explicit: Partial<Record<"awareness" | "conversion" | "retention", number>> = {};
  for (const key of ["awareness", "conversion", "retention"] as const) {
    for (const kw of WEIGHT_KEYWORDS[key]) {
      const m = new RegExp(`${kw}[^0-9%]{0,8}?(\\d{1,3})\\s*%`, "i").exec(text);
      if (m) {
        explicit[key] = Number(m[1]) / 100;
        break;
      }
    }
  }
  const explicitKeys = Object.keys(explicit) as (keyof typeof explicit)[];
  if (explicitKeys.length >= 2) {
    const sum = explicitKeys.reduce((n, k) => n + (explicit[k] ?? 0), 0);
    if (sum > 0 && sum <= 1.0001) {
      // 未提及的维度按比例摊掉剩余部分（若全提及且不足 1，则补在 awareness 上由调用方校验器拦）
      const rest = Math.max(0, 1 - sum);
      const out = { awareness: 0, conversion: 0, retention: 0 };
      for (const k of explicitKeys) out[k] = explicit[k]!;
      if (rest > 0) {
        const missingKeys = (["awareness", "conversion", "retention"] as const).filter((k) => explicit[k] === undefined);
        if (missingKeys.length > 0) for (const k of missingKeys) out[k] = rest / missingKeys.length;
        else out.awareness += rest;
      }
      return out;
    }
  }

  const counts = { awareness: 0, conversion: 0, retention: 0 };
  const lower = text.toLowerCase();
  for (const key of ["awareness", "conversion", "retention"] as const) {
    for (const kw of WEIGHT_KEYWORDS[key]) if (lower.includes(kw.toLowerCase())) counts[key] += 1;
  }
  const hitDims = (Object.keys(counts) as (keyof typeof counts)[]).filter((k) => counts[k] > 0);
  if (hitDims.length < 2) return null;

  const total = hitDims.reduce((n, k) => n + counts[k], 0);
  const raw = {
    awareness: counts.awareness / total,
    conversion: counts.conversion / total,
    retention: counts.retention / total,
  };
  // 归一到 3 位小数并修掉舍入误差，避免 validateBrief 的"权重之和 ≠ 1"误报
  const rounded = {
    awareness: Math.round(raw.awareness * 1000) / 1000,
    conversion: Math.round(raw.conversion * 1000) / 1000,
    retention: Math.round(raw.retention * 1000) / 1000,
  };
  rounded.awareness = Math.round((1 - rounded.conversion - rounded.retention) * 1000) / 1000;
  return rounded;
}

/* ── 行业 / 类目 ────────────────────────────────────────── */

/**
 * 一个**很小**的行业/类目词表。
 * 只覆盖种子数据所在的领域与少数常见类目 —— 大词表是幻觉的来源，
 * 命中不了就让它缺着，由调用方追问或交给 LLM，而不是硬塞一个"其他"。
 */
const INDUSTRY_LEXICON: { industry: string; categories: { re: RegExp; name: string }[] }[] = [
  {
    industry: "美妆个护",
    categories: [
      { re: /精华|serum/i, name: "护肤品-精华" },
      { re: /面霜|乳液|保湿霜/, name: "护肤品-面霜" },
      { re: /面膜/, name: "护肤品-面膜" },
      { re: /口红|唇釉|唇膏/, name: "彩妆-唇部" },
      { re: /粉底|气垫|遮瑕/, name: "彩妆-底妆" },
      { re: /防晒/, name: "护肤品-防晒" },
      /* 洁面品类：`category` 会被逐字当平台搜索词，「洗面奶」是人真的会输进搜索框的词，
       * 比「护肤品-洁面」这种内部分类名更贴近平台真实语料（见 3C 词表那段的长注释）。 */
      { re: /洗面奶|洗面乳|洁面乳|洁面/, name: "洗面奶" },
      { re: /洗发|护发/, name: "洗护发" },
    ],
  },
  { industry: "食品饮料", categories: [{ re: /咖啡/, name: "饮料-咖啡" }, { re: /零食/, name: "休闲食品" }, { re: /奶粉|营养品/, name: "营养保健" }] },
  {
    industry: "服饰鞋包",
    categories: [
      { re: /女装/, name: "女装" },
      { re: /运动鞋|跑鞋/, name: "运动鞋服" },
      /* 冬装两件套：口述里出现「羽绒服」「保暖内衣」时**不要**交给 LLM 补全 ——
       * LLM 无人约束时会给出英文标识符（实测 `headphones`/`thermal underwear`），
       * 而 `category` 会被逐字当平台搜索词，英文在中文平台等于 0 条（WP-C-11）。 */
      { re: /羽绒服|鹅绒|鸭绒/, name: "羽绒服" },
      { re: /保暖内衣|保暖衣|秋衣|秋裤|打底衫|发热内衣/, name: "保暖内衣" },
    ],
  },
  /*
   * 3C 数码。**为什么必须进词表**：`category` 不只是分类标签，它会被
   * `agents.ts:platformPrefetchArgs()` **逐字当作平台内的搜索关键词**（抖音/小红书/B站）。
   * 词表命中不了时，intake 阶段会退到 LLM 补全，而 LLM 面对无人约束的 `category` 会给出
   * 英文标识符（实测 `headphones`）——英文词在中文平台搜不到东西：实测小红书 0 条、
   * 抖音 14 条里混进 3 条英语教学视频。中文名进词表就绕开了这条路径。
   */
  {
    industry: "3C数码",
    categories: [
      { re: /耳机|耳麦|headphone|earphone|earbud/i, name: "耳机" },
      { re: /手机|smartphone/i, name: "手机" },
      { re: /平板|tablet/i, name: "平板电脑" },
      { re: /笔记本|电脑|laptop/i, name: "电脑" },
      { re: /手表|手环|watch|band/i, name: "智能穿戴" },
      { re: /音箱|音响|speaker/i, name: "音箱" },
    ],
  },
  /*
   * 家纺。与 3C 同理：`category` 会被逐字当平台搜索词，必须给"人真的会输进搜索框"
   * 的中文词。「棉被 / 被子 / 四件套」这些口述里高频出现、但旧词表完全没覆盖，
   * 命不中时 LLM 兜底常给英文标识符，在中文平台搜不到内容。
   */
  {
    industry: "家纺",
    categories: [
      { re: /棉被|被子|被芯|冬被|夏被/, name: "被子" },
      { re: /四件套|床品|床单|被套|枕套/, name: "床品四件套" },
      { re: /枕头|枕芯|乳胶枕/, name: "枕头" },
      { re: /毛毯|毯子|凉席/, name: "毛毯" },
      { re: /床垫|床褥|乳胶垫/, name: "床垫" },
    ],
  },
];

export function parseIndustryCategory(text: string): { industry: string; category: string } | null {
  for (const entry of INDUSTRY_LEXICON) {
    for (const c of entry.categories) {
      if (c.re.test(text)) return { industry: entry.industry, category: c.name };
    }
  }
  return null;
}

/* ── 主入口 ─────────────────────────────────────────────── */

/**
 * 解析一段中文/中英混合的营销诉求。
 *
 * 纯函数：不读环境、不联网、不看时钟以外的东西（`now` 可注入，便于测试）。
 * 返回的 `ambiguities` 只针对**关键字段**提问，且带可枚举选项时给出 options——
 * 让前端能直接渲染成选项按钮，而不是让用户面对一个空白输入框。
 */
export function parseBriefUtterance(utterance: string, defaults?: Partial<Brief>, now = new Date()): BriefDraft {
  const text = (utterance ?? "").trim();
  const filled: string[] = [];
  const parsed: Partial<Brief> = {};

  const budget = parseBudget(text);
  if (budget !== null) {
    parsed.budget = money(budget, defaults?.budget?.currency ?? "CNY");
    filled.push("budget");
  }

  const window = parseWindow(text, now);
  if (window) {
    parsed.window = window;
    filled.push("window");
  }

  const platforms = parsePlatforms(text);
  if (platforms.length > 0) {
    parsed.platforms = platforms;
    filled.push("platforms");
  }

  const weights = parseWeights(text);
  if (weights) {
    parsed.objectiveWeights = weights;
    filled.push("objectiveWeights");
  }

  const ic = parseIndustryCategory(text);
  if (ic) {
    parsed.industry = ic.industry;
    parsed.category = ic.category;
    filled.push("industry", "category");
  }

  // 原始诉求留进 notes：下游 Agent 能看到用户自己的措辞，比只给结构化字段信息量大
  if (text.length > 0) {
    parsed.notes = text;
    filled.push("notes");
  }

  const brief: Partial<Brief> = { ...defaults, ...parsed };
  const missing = BRIEF_REQUIRED_FIELDS.filter((f) => {
    const v = brief[f as keyof Brief];
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "string") return v.trim().length === 0;
    if (typeof v === "number") return !Number.isFinite(v) || v <= 0;
    return v === undefined;
  });

  const questions: Record<string, string> = {
    industry: "这份策略针对哪个行业？",
    category: "具体是哪个品类？",
    budget: "本次投放预算大概多少？（例如「预算 300 万」）",
    window: "投放窗口是哪段时间？（例如「双11」「Q4」「近90天」）",
    platforms: "主要投哪几个平台？",
  };
  const optionSets: Record<string, string[]> = {
    platforms: [...POPULAR_PLATFORMS],
  };
  const ambiguities = missing.map((f) => ({
    field: f,
    question: questions[f] ?? `请补充「${f}」`,
    ...(optionSets[f] ? { options: optionSets[f] } : {}),
  }));

  return { brief, filled, missing, ambiguities };
}

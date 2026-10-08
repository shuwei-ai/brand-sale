/**
 * M9 AgentPack / M10 ToolRegistry 契约（对应 LLD §2.10、§2.11）
 */

import type { PhaseName } from "./job.ts";
import type { GovernanceCheck } from "./governance.ts";

export type AgentCode = "AO" | "CI" | "CT" | "PL" | "BR" | "RG";

export const AGENT_CODE_LABEL: Record<AgentCode, string> = {
  AO: "任务录入",
  CI: "竞品情报",
  CT: "人选匹配",
  PL: "打法排期",
  BR: "预算风控",
  RG: "研报生成",
};

export const PHASE_AGENT: Record<PhaseName, AgentCode> = {
  intake: "AO",
  intel: "CI",
  creator: "CT",
  playbook: "PL",
  budget: "BR",
  report: "RG",
};

export interface ToolRateLimit {
  rpsPerTenant: number;
  burst: number;
  /** 排队上限，超时走 E-DATA-003 */
  queueMaxMs: number;
}

export interface ToolRetry {
  attempts: number;
  backoff: "exponential" | "fixed";
  baseMs: number;
}

/** 工具治理策略（LLD §2.11） */
export interface ToolPolicy {
  name: string;
  /** 允许调用它的 Agent（白名单） */
  allowedAgents: AgentCode[];
  /** 需通过 M3 的哪几项检查 */
  governance: GovernanceCheck[];
  /**
   * 该工具**唯一绑定**的数据源（如 web_search → volc_web_search）。
   *
   * 为什么必须由代码声明而不是从调用参数里读：闸门的 source / authz / tenant
   * 三项检查都是按 `args.sourceId` 定位数据源的。若来源由模型在参数里"自报"，
   * 模型传一个别的 sourceId 就能让闸门去检查另一个（已登记的）源，
   * 而工具实际访问的那个源根本没被检查——闸门形同虚设。
   * 声明在这里后，M10 会用它覆盖参数里的 sourceId（见 tools.ts invoke）。
   *
   * 另一层作用：装配期用它判断该工具的能力是否就绪（适配器未注册则不暴露该工具）。
   */
  boundSourceId?: string;
  rateLimit: ToolRateLimit;
  timeoutMs: number;
  retry: ToolRetry;
  /** 超时/失败后的降级返回 */
  fallback?: "cached" | "partial" | "empty" | "none";
  /** 是否可并行（影响 M12 的并发预算） */
  parallelism: "parallel" | "sequential";
  /** 幂等：同参数重复调用是否安全（供 checkpoint 重放判断） */
  replaySafe: boolean;
  /**
   * 单次任务内的调用次数上限（缺省不限）。
   *
   * 专给**外部计费接口**用：令牌桶限的是速率，限不住总量——
   * 模型在工具循环里可以换着关键词把同一个源问上一百遍，速率完全合规，
   * 账单却失控。超过上限后返回 E-DATA-003 降级，让 Agent 改用已有结果收尾。
   */
  maxCallsPerJob?: number;
}

export interface ToolDescriptor {
  policy: ToolPolicy;
  /** 人类可读描述，写进 Agent 的工具声明 */
  description: string;
  /** 该工具产出是否必须带 citation */
  producesCitedData: boolean;
}

/** Agent 的静态定义（提示词 + 工具箱 + 输出 Schema 名） */
export interface AgentSpec {
  code: AgentCode;
  phase: PhaseName;
  /** 输出结构名，用于 Schema 校验与错误定位 */
  outputSchema: string;
  /** 系统提示词（含 LLD §2.10 的五条通用约定） */
  systemPrompt: string;
  /** 允许使用的工具名（白名单，运行时还会二次校验） */
  tools: string[];
  /** 该阶段超时 */
  timeoutMs: number;
}

/** 结构化交接：阶段产物以 schema 化的形式在 Agent 之间传递，不走自由对话 */
export interface HandoffEnvelope<T = unknown> {
  from: AgentCode | "system";
  to: AgentCode;
  phase: PhaseName;
  schema: string;
  data: T;
  producedAt: string;
  /** 上游缺失字段，下游必须显式体现 */
  missing: string[];
  degraded: string[];
}

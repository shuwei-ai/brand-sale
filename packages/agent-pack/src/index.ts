/**
 * @brandsale/agent-pack —— M9 AgentPack + M10 ToolRegistry
 */

export { AgentPack, MOCK_BRIEF, extractJsonObject, type AgentRuntimeDeps, type PhaseResult, type PhaseStrategy } from "./agents.ts";
export { ToolRegistry, policy, TIER_GOVERNANCE, type ToolCallContext, type ToolCallRecord, type ToolDeps, type ToolImpl } from "./tools.ts";
export { PHASE_TOOL_HINT, TOOL_IMPLEMENTATIONS, admitTool, registerAllTools, bindDeps } from "./tool-impls.ts";
export { SYSTEM_PROMPTS, contextBlock } from "./prompts.ts";
export {
  ALL_SCHEMAS,
  BriefSchema,
  BudgetSchema,
  CompetitorIntelSchema,
  CreatorCandidatesSchema,
  PlaybookSchema,
  ReportDslSchema,
  SchemaError,
  type BriefOutput,
  type BudgetOutput,
  type CreatorOutput,
  type IntelOutput,
  type PlaybookOutput,
  type SchemaDef,
} from "./schemas.ts";
export { synthBudget, synthCreators, synthIntel, synthPlaybook, synthReport, type PrefetchedToolData } from "./synthesis.ts";

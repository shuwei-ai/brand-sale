/**
 * @brandsale/contracts —— 全系统唯一的接口与 Schema 定义处（LLD §7.1 强制约束）
 *
 * 其它任何包**只能 import 这里**，不得重复定义同名类型。
 */

export * from "./common.ts";
export * from "./errors.ts";
export * from "./governance.ts";
export * from "./kb.ts";
export * from "./job.ts";
export * from "./agent.ts";
export * from "./events.ts";
export * from "./report.ts";
export * from "./report-depth.ts";
export * from "./orchestrator.ts";

export const CONTRACTS_VERSION = "0.1.0";
export const API_PREFIX = "/api/v1";

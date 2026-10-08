/**
 * @brandsale/governance —— M3 GovernanceGate + M5 LineageLedger
 */

export { GovernanceGate, assertToolAllowed, type GovernanceDeps } from "./gate.ts";
export { LineageLedger, toOpenLineageRunEvent, type LedgerInput, type LedgerOutput, type LedgerRun } from "./ledger.ts";
export { buildSourceCatalog, externalCatalogKeys, INTERNAL_CATALOG_SOURCES, type CatalogDeps } from "./catalog.ts";
export { assertSourceRegistration, createIngestSourceGuard } from "./source-guard.ts";

/**
 * @brandsale/knowledge —— M7 KnowledgeService + M8 PricingStore
 */

export { ConfidencePolicy, ageInDays } from "./confidence.ts";
export { KnowledgeService, cosine, hashEmbed, ingestStamp, stableDocId, tokenize, type RerankOptions } from "./retrieval.ts";
export { PricingStore } from "./pricing.ts";
export {
  BINARY_MIMES,
  TEXT_MIMES,
  createMineruParser,
  createParser,
  createTextonlyParser,
  isUnsupportedFormat,
  normalizeMime,
  type DocumentParser,
  type ParsedDocument,
} from "./parser.ts";

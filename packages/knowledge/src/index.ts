/**
 * @brandsale/knowledge —— M7 KnowledgeService + M8 PricingStore
 */

export { ConfidencePolicy, ageInDays } from "./confidence.ts";
export { KnowledgeService, INTERNAL_INGEST_SOURCES, ingestStamp, stableDocId, type RerankOptions } from "./retrieval.ts";
export {
  HASH_DIM,
  HashEmbeddingProvider,
  HttpEmbeddingProvider,
  EmbeddingUnavailableError,
  blobToVector,
  cosine,
  embeddingProviderFromConfig,
  hashEmbed,
  providerKind,
  resolveEmbedDialect,
  tokenize,
  vectorToBlob,
  type EmbedOptions,
  type EmbedInputType,
  type EmbedDialect,
  type EmbedDialectConfig,
  type EmbeddingConfigLike,
  type EmbeddingProvider,
  type HttpEmbeddingOptions,
} from "./embedding.ts";
export {
  buildReportSummary,
  renderSummaryText,
  SUMMARY_SOURCE_ID,
  type ReportSummary,
  type SummarySection,
  type SummaryKeyNumber,
} from "./summarize.ts";
export {
  MilvusVectorIndex,
  createVectorIndex,
  type VectorIndex,
  type VectorIndexHit,
  type VectorIndexSearchResult,
} from "./vector-index.ts";
export { PricingStore } from "./pricing.ts";
export {
  SemanticMemory,
  SemanticMemoryError,
  semanticMemoryFromEnv,
  type MemoryHit,
  type MemoryRecord,
  type SearchOptions,
  type SearchResult,
  type SemanticMemoryErrorCode,
  type SemanticMemoryOptions,
} from "./semantic-memory.ts";
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

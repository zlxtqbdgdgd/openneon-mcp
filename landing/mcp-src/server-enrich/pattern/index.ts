/**
 * server-enrich/pattern barrel · feat-037 log pattern 聚类 hybrid path.
 *
 * Re-exports the public API; consumers should import from this barrel rather than the individual
 * files (keeps the seam stable when internals shift).
 */

export type {
  Drain3Config,
  ForcePath,
  LogLine,
  LogPattern,
  PathDecision,
  PatternClusterResult,
  RouterResult,
  SemanticCategory,
  Severity,
  TailAggregate,
} from './types';

export { SEMANTIC_CATEGORIES } from './types';

export {
  Drain3,
  DRAIN3_DEFAULTS,
  readDrain3ConfigFromEnv,
  tokenize,
} from './drain3';

export {
  LLM_CLUSTERING_SYSTEM_PROMPT,
  LLM_CLUSTERING_SYSTEM_PROMPT_VERSION,
  LLM_CLUSTERING_MAX_INPUT_TOKENS,
  LLM_CLUSTERING_MAX_OUTPUT_TOKENS,
  buildClusteringUserPayload,
  llmClusterLogs,
  type LlmClusteringResult,
  type LlmClusteringSuccess,
  type LlmClusteringError,
} from './llm-clustering';

export {
  routeAndCluster,
  buildCacheKey,
  estimateLines,
  resetRouterCache,
  getRouterCache,
  ForceMainOverLimitError,
  PATH_ROUTER_AUTO_THRESHOLD_TOKENS,
  PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS,
  type RouterRequest,
  type RouterPayload,
  type ClusterTraceState,
} from './path-router';

export {
  buildClusterPlanPayload,
  estimateClusterCostUsd,
  DEFAULT_CLUSTER_REQUEST_APPROVAL,
  type ClusterPlanPayload,
  type ClusterPlanDecision,
  type ClusterRequestApproval,
} from './plan-mode';

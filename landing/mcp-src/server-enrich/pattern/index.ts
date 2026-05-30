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

// feat-037 form-shift (规则 P4 · LLM-out-of-mcp): LLM 聚类主路径 + plan-mode 已迁 cc skill ·
// mcp 只保留确定性 Drain3 + path-router (enrichment hint) backbone。
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

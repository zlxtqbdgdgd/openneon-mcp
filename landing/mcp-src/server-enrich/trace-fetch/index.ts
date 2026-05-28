/**
 * trace-fetch seam · feat-066 (L2a) · the single collection point for "fetch a trace".
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-066-L3-mcp-tool-trace-read-seam.html
 *
 * Consumers (mcp tools `get_neondb_trace` / `search_neondb_traces` · feat-066/#2) call into this
 * module · the adapter (currently Datadog APM `/api/v2/spans/events/search`) is hidden — swap
 * backends without touching this interface or any consumer.
 *
 * SUB-INTERFACE of the broader Observability seam (ADR-0009 单一收口) · separated from
 * `MetricHistoryAdapter` per feat-066/#1 acceptance gate "TraceFetchAdapter interface 拆出".
 * Existing metric consumers (feat-016 baseline / feat-018 SLI / feat-019 EXPLAIN / feat-021
 * pg_stat_statements) are NOT touched · they continue to import from `../metrics-history`.
 *
 * INTERNAL only · not agent-facing (§6).
 */

import { datadogTraceAdapter } from './datadog-adapter';
import type {
  GetTraceByIdRequest,
  GetTraceByIdResult,
  SearchTracesResult,
  TraceFetchAdapter,
  TraceSearchRequest,
} from './types';

export type {
  GetTraceByIdRequest,
  GetTraceByIdResult,
  ObservabilityAdapter,
  SearchTracesResult,
  TraceFetchAdapter,
  TraceFetchError,
  TraceFetchSuccess,
  TraceSearchFilter,
  TraceSearchRequest,
  TraceSearchSuccess,
  TraceSpan,
  TraceSummary,
} from './types';
export {
  isSearchTracesError,
  isTraceFetchError,
  TRACE_SEARCH_LIMIT_MAX,
} from './types';

/**
 * Fetch a single trace by id · returns spans + summary or `{ error }`.
 *
 * @param req - trace_id + optional time_range (helps the backend query planner)
 * @param adapter - backend adapter · defaults to Datadog APM · overridable (tests / future backends)
 */
export function getTraceById(
  req: GetTraceByIdRequest,
  adapter: TraceFetchAdapter = datadogTraceAdapter,
): Promise<GetTraceByIdResult> {
  return adapter.getTraceById(req);
}

/**
 * Search trace summaries by filter · returns one row per matching root span (token economy ·
 * agent calls `getTraceById` to drill into a specific trace).
 *
 * @param req - filter + limit (hard-capped at TRACE_SEARCH_LIMIT_MAX = 50)
 * @param adapter - backend adapter · defaults to Datadog APM · overridable
 */
export function searchTraces(
  req: TraceSearchRequest,
  adapter: TraceFetchAdapter = datadogTraceAdapter,
): Promise<SearchTracesResult> {
  return adapter.searchTraces(req);
}

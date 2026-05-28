/**
 * trace-fetch seam types · feat-066 (L2a · sub-interface 拆出).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-066-L3-mcp-tool-trace-read-seam.html §3.1 + §4
 *
 * Vendor-neutral interface for "fetch a single trace by id" + "search trace summaries by filter".
 * Sub-interface of the larger Observability seam (ADR-0009 单一收口) — sits alongside the
 * `MetricHistoryAdapter` (feat-064) and shares the same Datadog config / HTTP error classifier.
 * Swap backends (Tempo / Jaeger) = swap adapter · the interface and consumers don't move.
 *
 * INTERNAL seam · NOT an agent-facing tool surface (raw HTTP / credentials stay below the tool
 * layer · §6 fail-closed).
 */

import type { MetricWindow } from '../metrics-history/types';

export type IsoTimestamp = string; // ISO8601 e.g. '2026-05-28T12:00:00Z'

/**
 * OTel-compatible span (semantic conventions). Returned by `getTraceById` and embedded in
 * `TraceSummary` for `searchTraces` (only `root_span` materialised — the full span list is
 * fetched per-trace on demand to keep token economy in check · §3 · OWASP LLM10).
 */
export type TraceSpan = {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service_name: string;
  operation_name: string;
  /** Start time · ISO8601 (vendor-neutral · adapter converts from epoch). */
  start_time: IsoTimestamp;
  /** Duration in microseconds (OTel convention). */
  duration_us: number;
  /** USR + Neon Key + business attrs (resource-level + span-level merged). */
  attributes: Record<string, string | number | boolean | null>;
  /** W3C tracestate · ADR-0011 marks path β (`neon=root=proxy`) vs path α (`neon=root=app`). */
  tracestate?: string;
};

/** Compact "one row per trace" projection · used by `searchTraces`. */
export type TraceSummary = {
  trace_id: string;
  /** Total span count in the trace (server-side count). */
  span_count: number;
  /** End-to-end duration in microseconds (root span duration). */
  duration_us: number;
  /** Root span service (e.g. 'neon-proxy' / app-service when path α). */
  root_service: string;
  /** Root span op (e.g. 'pg.proxy.query' / 'http.GET /api/orders'). */
  root_operation: string;
  /** Earliest start time of any span in the trace · ISO8601. */
  start_time: IsoTimestamp;
  /** Whether ANY span carried `error=true` (OTel status_code=ERROR). */
  has_error: boolean;
  /** Component breakdown · only top 4 to stay token-economic (proxy/compute/safekeeper/pageserver). */
  components: Array<{
    service_name: string;
    duration_us: number;
  }>;
  /** Echoed from root span for downstream filtering / display. */
  tracestate?: string;
};

/** Logical filter for `searchTraces` (translated to backend query DSL by the adapter). */
export type TraceSearchFilter = {
  /** Min wall-clock latency (root span) — used to surface slow traces (P95/P99 spelunking). */
  min_latency_ms?: number;
  /** Component scope · keeps the search inside one tier of the Neon stack. */
  component?: 'proxy' | 'compute' | 'safekeeper' | 'pageserver';
  /** Neon project id · cross-tenant guard hard-overrides this (feat-066/#3 + feat-060). */
  project_id?: string;
  /** Optional endpoint slice (sub-project). */
  endpoint_id?: string;
  /** Absolute or relative window (reuses feat-064 MetricWindow shape). */
  time_range: MetricWindow;
};

export type TraceSearchRequest = {
  filter: TraceSearchFilter;
  /** Hard-capped at TRACE_SEARCH_LIMIT_MAX (50) regardless of agent ask · token economy. */
  limit: number;
};

export type GetTraceByIdRequest = {
  trace_id: string;
  /** Optional · narrows backend query when supplied (helps Datadog query planner). */
  time_range?: MetricWindow;
};

export type TraceFetchSuccess = {
  spans: TraceSpan[];
  /** Convenience: same data root-projected (matches `searchTraces` row shape · skip in agent if not needed). */
  summary: TraceSummary;
};

export type TraceSearchSuccess = {
  traces: TraceSummary[];
};

export type TraceFetchError = {
  error: {
    reason: 'unreachable' | 'auth' | 'rate_limited' | 'backend_error' | 'not_found';
    detail?: string;
  };
};

export type GetTraceByIdResult = TraceFetchSuccess | TraceFetchError;
export type SearchTracesResult = TraceSearchSuccess | TraceFetchError;

/**
 * Backend adapter contract (sub-interface · separated from `MetricHistoryAdapter` per
 * feat-066/#1 acceptance gate "TraceFetchAdapter interface 拆出"). A backend may implement
 * one, the other, or both — the union `ObservabilityAdapter` (below) is the merged shape.
 */
export type TraceFetchAdapter = {
  getTraceById: (req: GetTraceByIdRequest) => Promise<GetTraceByIdResult>;
  searchTraces: (req: TraceSearchRequest) => Promise<SearchTracesResult>;
};

/**
 * Merged observability adapter — the seam-level type that lets a single backend satisfy both
 * sub-interfaces (Datadog implements both; mock backends in tests often implement only one).
 * Consumers depend on the SUB-interfaces · NOT the union (smaller dependency surface).
 */
export type ObservabilityAdapter =
  import('../metrics-history/types').MetricHistoryAdapter & Partial<TraceFetchAdapter>;

/** Narrowing helpers — symmetric to feat-064 `isMetricHistoryError`. */
export function isTraceFetchError(
  r: GetTraceByIdResult,
): r is TraceFetchError {
  return (r as TraceFetchError).error !== undefined;
}

export function isSearchTracesError(
  r: SearchTracesResult,
): r is TraceFetchError {
  return (r as TraceFetchError).error !== undefined;
}

/** Hard upper bound on `searchTraces` limit · token economy · OWASP LLM10. */
export const TRACE_SEARCH_LIMIT_MAX = 50;

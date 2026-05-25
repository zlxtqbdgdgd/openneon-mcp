/**
 * metrics-history seam types · feat-064 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-064-L2-mcp-server-enrich-metrics-history.html §4
 *
 * Vendor-neutral interface for "fetch one signal's historical time series over a window". A single
 * collection point for history retrieval (ADR-0009): consumers (feat-016 baseline, …) pass a logical
 * signal name + dimensions + window + bucket; an adapter translates to the backend's query language
 * (currently Datadog). Swap backends = swap adapter · the interface and consumers don't move.
 *
 * INTERNAL seam · NOT an agent-facing tool (§6 form decision · keeps raw history out of the LLM,
 * keeps credentials off the tool surface, prevents the agent computing baselines itself · §3.3.0).
 */

/** A relative ('last 7d') or absolute (unix-second from/to) window. */
export type MetricWindow =
  | { last: string }
  | { from: number; to: number };

export type MetricHistoryRequest = {
  /** Logical signal name (neutral · resolved by the adapter's translation table). */
  signal: string;
  /** Dimension filters (e.g. { endpoint: 'main' }) → backend tag filter. */
  dimensions: Record<string, string>;
  /** Window · relative ({ last: '7d' }) or absolute ({ from, to } unix seconds). */
  window: MetricWindow;
  /** Bucket width (e.g. '1h', '5m') → backend rollup. */
  bucket: string;
};

/** Coverage metadata · lets the consumer judge "enough data?" and "stale?" (vendor-neutral). */
export type Coverage = {
  /** Buckets that actually carried a value. */
  actual_points: number;
  /** window ÷ bucket · how many buckets the window SHOULD contain. */
  expected_points: number;
  /** Covered time span in seconds (= to − from). */
  span_seconds: number;
  /** Timestamp (unix seconds) of the latest non-null point · null when no data · staleness check. */
  latest_point_ts: number | null;
};

export type MetricHistorySuccess = {
  /** [unix_ts_seconds, value] · value null = bucket had no data (sparse · NOT a failure). */
  points: Array<[number, number | null]>;
  coverage: Coverage;
};

/**
 * A retrieval FAILURE · explicitly distinct from "fetched but sparse" (which is success with low
 * coverage). Consumers MUST NOT treat an error as "everything is fine" (fail-closed · §6).
 */
export type MetricHistoryError = {
  error: {
    reason: 'unreachable' | 'auth' | 'rate_limited' | 'backend_error';
    detail?: string;
  };
};

export type MetricHistoryResult = MetricHistorySuccess | MetricHistoryError;

/** Narrowing helper · true when the result is a failure (not a sparse success). */
export function isMetricHistoryError(
  r: MetricHistoryResult,
): r is MetricHistoryError {
  return (r as MetricHistoryError).error !== undefined;
}

/**
 * Backend adapter contract. A new backend (Prometheus / self-hosted TSDB) implements this; the seam
 * and all consumers stay untouched ("换源只改一处").
 */
export type MetricHistoryAdapter = {
  fetch: (req: MetricHistoryRequest) => Promise<MetricHistoryResult>;
};

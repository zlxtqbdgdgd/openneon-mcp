/**
 * Datadog signal translation table · feat-064 (L2a · OQ2).
 *
 * Maps a LOGICAL signal name (neutral · owned by the T4 registry · feat-020) to a Datadog metric +
 * aggregation + optional dimension-key remap. "用一个加一个" — entries are added as consumers need
 * them, NOT pre-populated wholesale.
 *
 * The logical → backend translation is the ONE place Datadog query syntax leaks. A different backend
 * ships its own map; the seam interface and consumers are untouched.
 */

export type DatadogSignalMapping = {
  /** Datadog metric name (e.g. 'postgresql.connections' · L2 namespace · test-infra §12.F). */
  ddMetric: string;
  /** Aggregation prefix in the query (`avg:` / `sum:` / `max:`). Default 'avg'. */
  aggregation?: 'avg' | 'sum' | 'max' | 'min';
  /**
   * Optional remap from a logical dimension key to a Datadog tag key (e.g. endpoint → endpoint_id).
   * Keys not present here pass through unchanged.
   */
  tagKeyMap?: Record<string, string>;
};

/**
 * feat-064/#first-signal · `connections` → Datadog Postgres integration gauge.
 *
 * NOTE: the exact metric name (`postgresql.connections`) must be confirmed against the live dev
 * server's active metrics (`GET /api/v1/metrics`) before relying on real-Datadog e2e — the L2
 * `postgresql.*` namespace is integration-version dependent (test-infra §12.F). Adjust here only.
 */
export const DATADOG_SIGNAL_MAP: Record<string, DatadogSignalMapping> = {
  connections: {
    ddMetric: 'postgresql.connections',
    aggregation: 'avg',
  },
};

export function getDatadogMapping(
  signal: string,
): DatadogSignalMapping | undefined {
  return DATADOG_SIGNAL_MAP[signal];
}

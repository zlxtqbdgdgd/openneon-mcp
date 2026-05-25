/**
 * T4 health-signals signal registry · feat-020/#1 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-020-L2-mcp-tool-t4-health-signals.html §4
 *
 * The registry is the home of "which health signals exist + how to read each current value +
 * whether to baseline it + which direction is bad". A single logical `signal` name threads
 * through feat-016 (baseline) and feat-064 (metrics-history adapter): T4 owns "what signals /
 * how to read now / baseline?", feat-064 owns "how to fetch history".
 *
 * feat-020/#1 ships ONE signal (`connections`) as the end-to-end tracer bullet. The full L2a
 * signal set (replication lag / cache_hit_ratio / LFC / storage_size …) lands in feat-020/#5,
 * which appends entries here without touching the handler.
 */

/** Which direction of deviation is "bad" for SLI/burn-rate purposes (feat-018 consumes this). */
export type SliDirection = 'high-bad' | 'low-bad' | 'none';

export type SignalDef = {
  /** Logical signal name · stable id threaded to feat-016 baseline + feat-064 adapter. */
  signal: string;
  /** Human-readable current-value source (e.g. 'pg_stat_activity') · surfaced for transparency. */
  source: string;
  /**
   * SQL that returns the signal's current value as a single row with a single numeric `value`
   * column. Read from the live DB on every T4 call (no history here · that's feat-064).
   */
  currentValueSql: string;
  /**
   * true → the signal comes from a neon-specific extension view (e.g. LFC). When the extension
   * is absent the signal degrades to `status='unavailable'` (graceful · standard signals still
   * return). feat-020/#5 wires the extension check.
   */
  requiresNeonExt: boolean;
  /**
   * false → monotonic / non-stationary signal (e.g. storage_size) · do NOT run median+MAD
   * (feat-016) or it would forever report "high". Use threshold / growth-rate instead.
   */
  baselineApplicable: boolean;
  /** Direction that counts as bad · feat-018 burn-rate uses this. */
  sliDirection: SliDirection;
  /**
   * true → always shown in shallow depth (a key summary signal) even when `status='ok'`.
   * Non-key ok signals are omitted from shallow output (feat-007 token economy). Anomalous /
   * unavailable signals always surface regardless of this flag.
   */
  keySummary: boolean;
};

/**
 * feat-020/#1 · single tracer-bullet signal.
 *
 * `connections` = current active connection count from pg_stat_activity. baseline_applicable
 * (a busy-vs-quiet gauge that swings around a stable band) · high-bad (approaching max_connections
 * is the failure mode). Key summary signal · always shown.
 */
export const SIGNAL_REGISTRY: readonly SignalDef[] = [
  {
    signal: 'connections',
    source: 'pg_stat_activity',
    currentValueSql:
      'SELECT count(*)::float8 AS value FROM pg_stat_activity WHERE datname = current_database()',
    requiresNeonExt: false,
    baselineApplicable: true,
    sliDirection: 'high-bad',
    keySummary: true,
  },
] as const;

/** Look up a signal definition by logical name. */
export function getSignalDef(signal: string): SignalDef | undefined {
  return SIGNAL_REGISTRY.find((s) => s.signal === signal);
}

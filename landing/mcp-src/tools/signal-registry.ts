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
  /**
   * feat-017 (L2b) · true → ALSO opt into seasonal-MAD (24 hour-of-day buckets). Only meaningful
   * when `baselineApplicable === true`. Signals with no clear daily cycle (noise-dominated, e.g.
   * replication_lag_seconds) keep this false and run feat-016 global baseline only.
   */
  seasonalApplicable: boolean;
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
 * L2a signal set. Every SQL below was verified against the dev server's real neon_local PG 16.9
 * (`先核实再假设` · OQ1) — the neon extension is NOT installed there, so `lfc_hit_rate` exercises
 * the graceful-degradation path (extension absent → status='unavailable' · standard signals still
 * return). The LFC view/column (`neon_stat_file_cache.file_cache_hit_ratio`) is taken from the neon
 * source (pgxn/neon/neon--1.1--1.2.sql), not guessed.
 */
export const SIGNAL_REGISTRY: readonly SignalDef[] = [
  // connections · current active connection count · swings around a stable band → baseline ·
  // high-bad (approaching max_connections is the failure mode). Key summary.
  {
    signal: 'connections',
    source: 'pg_stat_activity',
    currentValueSql:
      'SELECT count(*)::float8 AS value FROM pg_stat_activity WHERE datname = current_database()',
    requiresNeonExt: false,
    baselineApplicable: true,
    seasonalApplicable: true,
    sliDirection: 'high-bad',
    keySummary: true,
  },
  // cache_hit_ratio · shared-buffer hit ratio [0,1] from pg_stat_database · low-bad (low hit ratio
  // means more storage reads). The canonical native_ratio SLO signal (feat-018). Key summary.
  {
    signal: 'cache_hit_ratio',
    source: 'pg_stat_database',
    currentValueSql:
      'SELECT (sum(blks_hit)::float8 / nullif(sum(blks_hit + blks_read), 0)) AS value FROM pg_stat_database WHERE datname = current_database()',
    requiresNeonExt: false,
    baselineApplicable: true,
    seasonalApplicable: true,
    sliDirection: 'low-bad',
    keySummary: true,
  },
  // replication_lag_seconds · max replay lag across replicas (pg_stat_replication) · high-bad.
  // neon_local is single-node (0 replicas) → null → status='unavailable' (honest · OQ5). Non-key
  // (only surfaces when anomalous / unavailable). seasonal=false: replay lag is noise-dominated
  // with no clear daily cycle · feat-017 §3.4 keeps it on the global feat-016 baseline.
  {
    signal: 'replication_lag_seconds',
    source: 'pg_stat_replication',
    currentValueSql:
      'SELECT max(EXTRACT(EPOCH FROM replay_lag))::float8 AS value FROM pg_stat_replication',
    requiresNeonExt: false,
    baselineApplicable: true,
    seasonalApplicable: false,
    sliDirection: 'high-bad',
    keySummary: false,
  },
  // storage_size_bytes · database on-disk size · MONOTONIC-ish → baseline_applicable=false (median+
  // MAD would forever report "high"; use threshold / growth-rate instead · §3). sli_direction none.
  // Key summary (capacity is worth always showing). seasonal moot since baselineApplicable=false.
  {
    signal: 'storage_size_bytes',
    source: 'pg_database_size',
    currentValueSql: 'SELECT pg_database_size(current_database())::float8 AS value',
    requiresNeonExt: false,
    baselineApplicable: false,
    seasonalApplicable: false,
    sliDirection: 'none',
    keySummary: true,
  },
  // lfc_hit_rate · Neon Local File Cache hit ratio [0,1] · requires the neon extension. view +
  // column verified from neon source (neon--1.1--1.2.sql · file_cache_hit_ratio is a 0–100 %, so
  // /100 → ratio). low-bad. Extension absent → unavailable (graceful · standard signals unaffected).
  // seasonal=true: LFC daily cycle is the feat-017 §2 motivating example (workhour vs nighttime).
  {
    signal: 'lfc_hit_rate',
    source: 'neon_stat_file_cache',
    currentValueSql:
      'SELECT (file_cache_hit_ratio / 100.0)::float8 AS value FROM neon_stat_file_cache',
    requiresNeonExt: true,
    baselineApplicable: true,
    seasonalApplicable: true,
    sliDirection: 'low-bad',
    keySummary: false,
  },
] as const;

/** Look up a signal definition by logical name. */
export function getSignalDef(signal: string): SignalDef | undefined {
  return SIGNAL_REGISTRY.find((s) => s.signal === signal);
}

/**
 * T4 get_neondb_health_signals handler · feat-020/#1 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-020-L2-mcp-tool-t4-health-signals.html
 *
 * One call gives the agent a whole-DB health snapshot: each signal's current value (live DB),
 * later enriched with baseline deviation (feat-016 · feat-020/#4) and is_sli_burning (feat-018 ·
 * feat-020/#6). The agent's FIRST choice instead of writing raw `run_sql` + playing statistician
 * (§3.3.0).
 *
 * feat-020/#1 scope (this file): tool skeleton + signal-registry walk + first current-value
 * signal (`connections`). NO baseline / SLO enrich yet (those land in #4 / #6 and slot into the
 * `enriched` fields below without changing this shape).
 */

import type { Api } from '@neondatabase/api-client';
import { startSpan } from '@sentry/node';
import { handleGetConnectionString } from './connection-string';
import { createSqlClient } from './sql-driver';
import {
  DEFAULT_DEPTH,
  isValidDepth,
  type DepthLevel,
} from '../../config/depth';
import { SIGNAL_REGISTRY, type SignalDef } from '../signal-registry';
import { baseline } from '../../server-enrich/baseline/baseline';
import { sloBurnRate, type SloBlock } from '../../server-enrich/baseline/slo-burn-rate';
import { getSloSpec } from '../../server-enrich/baseline/slo-specs';
import type { ToolHandlerExtraParams } from '../types';

export type GetHealthSignalsInput = {
  /** Neon project ID · required (per §4 input schema). */
  projectId: string;
  /** Optional branch ID · defaults to project's default branch. */
  branchId?: string;
  /** Optional database name · defaults to 'neondb' (NEON_DEFAULT_DATABASE_NAME). */
  databaseName?: string;
  /** Optional compute ID · defaults to read-write compute for the branch. */
  computeId?: string;
  /**
   * Dimension filters (e.g. { endpoint: 'main' }) · threaded to the baseline cache key in #4
   * (full dimensions = cross-tenant isolation boundary · §6). Accepted day-one · used once
   * baseline enrich lands.
   */
  dimensions?: Record<string, string>;
  /** Progressive disclosure depth (reuses feat-007) · default 'shallow'. */
  depth?: DepthLevel;
};

/** Per-signal status. `unavailable` = neon extension absent OR current-value read failed. */
export type SignalStatus = 'ok' | 'anomalous' | 'unavailable';

export type HealthSignal = {
  /** Logical signal name (from the registry). */
  signal_type: string;
  /** Current value from the live DB · null when status='unavailable'. */
  value: number | null;
  status: SignalStatus;
  /** median baseline · only baseline_applicable signals with a usable band (feat-020/#4). */
  baseline_value?: number;
  /** Deviation from the baseline band · computed on demand (feat-020/#4). */
  robust_z?: number;
  label?: 'normal' | 'high' | 'low';
  /** SLO burn-rate verdict (feat-018 · feat-020/#6) · 'unknown' when SLI history is insufficient. */
  is_sli_burning?: boolean | 'unknown';
  baseline_algo?: 'median-mad' | null;
  /** Full SLO block (feat-018 · ~7 fields) for signals with an SLO spec. */
  slo?: SloBlock;
};

const DEFAULT_DATABASE = 'neondb';

// Baseline window/bucket defaults for non-seasonal signals (feat-016 OQ2 · 7d history @ 1h buckets).
// feat-017 (L2b) will vary these per-signal for seasonal signals.
const DEFAULT_BASELINE_WINDOW = { last: '7d' } as const;
const DEFAULT_BASELINE_BUCKET = '1h';

/**
 * Read one signal's current value from the live DB.
 *
 * Each registry SQL returns a single row with a single numeric `value`. A read failure (missing
 * extension view, permission, etc.) degrades to `status='unavailable'` with `value=null` — the
 * signal is reported as blind, never silently treated as "ok" (§6 honesty rule). feat-020/#5
 * adds the up-front `requiresNeonExt` extension check so neon-specific signals degrade gracefully
 * while standard signals keep returning.
 */
async function readCurrentValue(
  sql: { query: (q: string, p?: unknown[]) => Promise<Array<Record<string, unknown>>> },
  def: SignalDef,
): Promise<HealthSignal> {
  try {
    const rows = await sql.query(def.currentValueSql);
    const raw = rows?.[0]?.value;
    if (raw === undefined || raw === null) {
      return { signal_type: def.signal, value: null, status: 'unavailable' };
    }
    return { signal_type: def.signal, value: Number(raw), status: 'ok' };
  } catch {
    return { signal_type: def.signal, value: null, status: 'unavailable' };
  }
}

/**
 * Lazily check (and memoize) whether the `neon` extension is installed. Only consulted for signals
 * with requiresNeonExt — since those come last in the registry, the check fires after the standard
 * signals' reads (and is skipped entirely if no neon-ext signal is reached). On any error → treated
 * as absent (conservative · the signal degrades to unavailable).
 */
function makeNeonExtGate(
  sql: { query: (q: string, p?: unknown[]) => Promise<Array<Record<string, unknown>>> },
): () => Promise<boolean> {
  let checked = false;
  let installed = false;
  return async () => {
    if (!checked) {
      try {
        const rows = await sql.query(
          `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'neon') AS has_neon`,
        );
        installed = rows?.[0]?.has_neon === true;
      } catch {
        installed = false;
      }
      checked = true;
    }
    return installed;
  };
}

/**
 * Enrich an `ok` baseline_applicable signal with feat-016 median+MAD baseline (feat-020/#4).
 *
 * On a usable band + deviation: surface baseline_value / robust_z / label, and flip status to
 * 'anomalous' when the label is high/low. On insufficient_data / degenerate: return the current
 * value only with NO baseline fields and status='ok' — never report an anomaly off a non-existent
 * or zero-width band (avoids noise). Baseline failure degrades, never blocks the signal (§8).
 */
async function enrichWithBaseline(
  sig: HealthSignal,
  def: SignalDef,
  dimensions: Record<string, string>,
): Promise<HealthSignal> {
  if (sig.status !== 'ok' || sig.value === null) return sig;
  try {
    const b = await baseline({
      signal: def.signal,
      dimensions,
      window: DEFAULT_BASELINE_WINDOW,
      bucket: DEFAULT_BASELINE_BUCKET,
      current_value: sig.value,
    });
    if (b.status === 'ok' && b.band && b.deviation) {
      return {
        ...sig,
        baseline_value: b.band.median,
        robust_z: b.deviation.robust_z,
        label: b.deviation.label,
        baseline_algo: 'median-mad',
        status: b.deviation.label === 'normal' ? 'ok' : 'anomalous',
      };
    }
    // insufficient_data / degenerate → current value only · no anomaly (§12).
    return sig;
  } catch {
    return sig;
  }
}

/**
 * Enrich a signal with the feat-018 SLO burn-rate block (feat-020/#6), when an SLO spec exists.
 *
 * Surfaces the full SLO block + the top-level is_sli_burning verdict. A burning SLI (true) flips
 * status to 'anomalous' so it surfaces in shallow depth — a page-level burn is the MOST important
 * thing to show, even when the baseline label is normal (the two answer different questions:
 * deviation vs budget burn). 'unknown' never flips status (blind ≠ burning). Failure degrades,
 * never blocks (§8).
 */
async function enrichWithSlo(
  sig: HealthSignal,
  def: SignalDef,
  dimensions: Record<string, string>,
): Promise<HealthSignal> {
  if (sig.status === 'unavailable') return sig;
  const spec = getSloSpec(def.signal);
  if (!spec) return sig;
  try {
    const slo = await sloBurnRate(spec, dimensions);
    const next: HealthSignal = {
      ...sig,
      slo,
      is_sli_burning: slo.is_sli_burning,
    };
    if (slo.is_sli_burning === true && next.status === 'ok') {
      next.status = 'anomalous';
    }
    return next;
  } catch {
    return sig;
  }
}

/**
 * Filter signals for the requested depth (feat-007 token economy).
 *
 * - `shallow` (default): anomalous + unavailable signals (always surfaced for honesty) plus
 *   `keySummary` signals (even when ok). Non-key ok signals are dropped.
 * - `full`: every signal.
 */
function filterByDepth(
  signals: HealthSignal[],
  depth: DepthLevel,
): HealthSignal[] {
  if (depth === 'full') return signals;
  return signals.filter((s) => {
    if (s.status !== 'ok') return true;
    const def = SIGNAL_REGISTRY.find((d) => d.signal === s.signal_type);
    return def?.keySummary === true;
  });
}

/**
 * Flatten an enriched signal into a single scalar-only row for CSV/TSV output (feat-006 token
 * economy · csv-stringify can't render the nested `slo` object). Every row carries the same key set
 * (missing values → '') so the CSV columns stay consistent across heterogeneously-enriched signals.
 * The structured form (nested `slo`) is preserved for `format=json`.
 */
export function flattenSignalRow(
  sig: HealthSignal,
): Record<string, string | number> {
  const blank = (v: number | string | boolean | null | undefined) =>
    v === undefined || v === null ? '' : typeof v === 'boolean' ? String(v) : v;
  return {
    signal_type: sig.signal_type,
    value: blank(sig.value),
    status: sig.status,
    baseline_value: blank(sig.baseline_value),
    robust_z: blank(sig.robust_z),
    label: blank(sig.label),
    is_sli_burning: blank(sig.is_sli_burning),
    sli_value: blank(sig.slo?.sli_value),
    slo_target: blank(sig.slo?.slo_target),
    burn_rate_1h: blank(sig.slo?.burn_rate_1h),
    burn_rate_5m: blank(sig.slo?.burn_rate_5m),
    error_budget_remaining: blank(sig.slo?.error_budget_remaining),
  };
}

/**
 * Aggregate health signals for a Neon database.
 *
 * Walks the signal registry, reads each current value from the live DB, then (in later sub-issues)
 * enriches baseline_applicable signals with feat-016 baseline + feat-018 SLO burn-rate. Returns the
 * depth-filtered enriched signal list.
 */
export async function handleGetHealthSignals(
  args: GetHealthSignalsInput,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<HealthSignal[]> {
  return await startSpan(
    {
      name: 'get_neondb_health_signals',
    },
    async () => {
      const connectionString = await handleGetConnectionString(
        {
          projectId: args.projectId,
          branchId: args.branchId,
          computeId: args.computeId,
          databaseName: args.databaseName ?? DEFAULT_DATABASE,
        },
        neonClient,
        extra,
      );

      const sql = await createSqlClient(connectionString.uri);
      try {
        const dimensions = args.dimensions ?? {};
        const neonExtInstalled = makeNeonExtGate(sql);
        const signals: HealthSignal[] = [];
        for (const def of SIGNAL_REGISTRY) {
          // neon-extension-backed signal + extension absent → unavailable (graceful · standard
          // signals unaffected). Never silently dropped — the agent sees the signal is blind.
          if (def.requiresNeonExt && !(await neonExtInstalled())) {
            signals.push({
              signal_type: def.signal,
              value: null,
              status: 'unavailable',
            });
            continue;
          }
          let sig = await readCurrentValue(sql, def);
          if (def.baselineApplicable) {
            sig = await enrichWithBaseline(sig, def, dimensions);
          }
          if (def.sliDirection !== 'none') {
            sig = await enrichWithSlo(sig, def, dimensions);
          }
          signals.push(sig);
        }

        const depth: DepthLevel = isValidDepth(args.depth)
          ? args.depth
          : DEFAULT_DEPTH;
        return filterByDepth(signals, depth);
      } finally {
        await sql.release();
      }
    },
  );
}

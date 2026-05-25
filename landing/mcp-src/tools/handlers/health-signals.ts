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
};

const DEFAULT_DATABASE = 'neondb';

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
    const raw = rows[0]?.value;
    if (raw === undefined || raw === null) {
      return { signal_type: def.signal, value: null, status: 'unavailable' };
    }
    return { signal_type: def.signal, value: Number(raw), status: 'ok' };
  } catch {
    return { signal_type: def.signal, value: null, status: 'unavailable' };
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
        const signals: HealthSignal[] = [];
        for (const def of SIGNAL_REGISTRY) {
          signals.push(await readCurrentValue(sql, def));
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

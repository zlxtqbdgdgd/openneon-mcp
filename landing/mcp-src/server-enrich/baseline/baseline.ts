/**
 * median+MAD baseline library · feat-016 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-016-L2-mcp-server-enrich-baseline-mad.html
 *
 * Signal-agnostic robust baseline. Given a logical signal, fetch its history via the feat-064 seam,
 * compute a median+MAD band, and (if a current value is supplied) the deviation. Honest THREE-STATE:
 * never emits a fake band when data is insufficient or degenerate. Consumed by feat-018 (SLO) /
 * feat-020 (T4) / feat-017 (seasonal) / feat-038 (STL). INTERNAL · not agent-facing.
 *
 * Caching (feat-020 grill · 2026-05-25): the OBJECTIVE core (status + median + MAD + coverage) is
 * cached per signal+dimensions+window+bucket with TTL ≈ bucket. robust_z / band edges / label are
 * computed FRESH each call from the cached core + the live current_value (which is never cached).
 * The key includes full dimensions → cross-tenant isolation (§6).
 */

import {
  getMetricHistory,
  type MetricHistoryRequest,
  type MetricHistoryResult,
  isMetricHistoryError,
  type Coverage,
} from '../metrics-history';
import { TtlCache, dimensionsKey, type Clock } from '../ttl-cache';
import {
  median,
  medianAbsoluteDeviation,
  computeBand,
  robustZ,
  deviationLabel,
  type BaselineBand,
  type DeviationLabel,
} from './median-mad';
import { parseDurationSeconds } from '../metrics-history/duration';

export const DEFAULT_K = 3;
export const DEFAULT_MIN_POINTS = 20;

export type BaselineStatus = 'ok' | 'insufficient_data' | 'degenerate';

export type BaselineRequest = {
  signal: string;
  dimensions: Record<string, string>;
  window: MetricHistoryRequest['window'];
  bucket: string;
  /** Live current value from the consumer (live DB) · supply to get deviation. NEVER cached. */
  current_value?: number;
  /** Band width multiplier · default 3. */
  k?: number;
  /** Minimum non-null points required before a band is trusted · default 20. */
  min_points?: number;
};

export type BaselineResult = {
  status: BaselineStatus;
  /** Only on status='ok'. */
  band?: BaselineBand;
  /** Only on status='ok' AND a current_value was supplied. */
  deviation?: { robust_z: number; label: DeviationLabel };
  /** Always present (zeroed on a history-fetch failure · honest "no data"). */
  coverage: Coverage;
};

/** The objective, cacheable part · k-independent · current_value-independent. */
type BaselineCore = {
  status: BaselineStatus;
  median?: number;
  mad?: number;
  coverage: Coverage;
};

const ZERO_COVERAGE: Coverage = {
  actual_points: 0,
  expected_points: 0,
  span_seconds: 0,
  latest_point_ts: null,
};

export type BaselineDeps = {
  /** History fetcher · defaults to the feat-064 seam · overridable in tests. */
  fetchHistory?: (req: MetricHistoryRequest) => Promise<MetricHistoryResult>;
  /** Band-core cache · defaults to the module-level cache · overridable for test isolation. */
  cache?: TtlCache<BaselineCore>;
};

const defaultCache = new TtlCache<BaselineCore>();

/** Build a typed band-core cache (e.g. for test isolation with a controllable clock). */
export function createBaselineCache(now?: Clock): TtlCache<BaselineCore> {
  return new TtlCache<BaselineCore>(now);
}

/** Test / rollback helper · clear the module-level band cache. */
export function clearBaselineCache(): void {
  defaultCache.clear();
}

function coreCacheKey(req: BaselineRequest): string {
  const win =
    'last' in req.window
      ? `last:${req.window.last}`
      : `abs:${req.window.from}-${req.window.to}`;
  // Full dimensions in the key = cross-tenant isolation boundary (§6).
  return `${req.signal}|${dimensionsKey(req.dimensions)}|${win}|${req.bucket}`;
}

/** Compute the objective band core (history fetch → median/MAD → three-state). No caching here. */
async function computeCore(
  req: BaselineRequest,
  fetchHistory: NonNullable<BaselineDeps['fetchHistory']>,
  minPoints: number,
): Promise<BaselineCore> {
  const history = await fetchHistory({
    signal: req.signal,
    dimensions: req.dimensions,
    window: req.window,
    bucket: req.bucket,
  });

  // Fetch failure → can't baseline. Degrade to insufficient_data (the consumer then reports NO
  // anomaly · §8) · never silently treats it as "normal".
  if (isMetricHistoryError(history)) {
    return { status: 'insufficient_data', coverage: ZERO_COVERAGE };
  }

  const values: number[] = [];
  for (const [, v] of history.points) {
    if (v !== null && v !== undefined && Number.isFinite(v)) values.push(v);
  }

  if (values.length < minPoints) {
    return { status: 'insufficient_data', coverage: history.coverage };
  }

  const med = median(values);
  const mad = medianAbsoluteDeviation(values, med);

  // MAD == 0 (all identical) → degenerate · give the median but no band / no robust_z (无尺度) ·
  // never report an anomaly off a zero-width band.
  if (mad === 0) {
    return { status: 'degenerate', median: med, coverage: history.coverage };
  }

  return { status: 'ok', median: med, mad, coverage: history.coverage };
}

/**
 * Compute a robust baseline for a signal.
 *
 * Cache-then-fetch on the objective core; assemble band edges + deviation fresh from the live
 * current_value (never cached). Returns a three-state result · honest about insufficient / degenerate.
 */
export async function baseline(
  req: BaselineRequest,
  deps: BaselineDeps = {},
): Promise<BaselineResult> {
  const fetchHistory = deps.fetchHistory ?? getMetricHistory;
  const cache = deps.cache ?? defaultCache;
  const k = req.k ?? DEFAULT_K;
  const minPoints = req.min_points ?? DEFAULT_MIN_POINTS;

  const key = coreCacheKey(req);
  let core = cache.get(key);
  if (!core) {
    core = await computeCore(req, fetchHistory, minPoints);
    // TTL ≈ bucket · short-lived so the band tracks reality without hammering the backend.
    let ttlMs = 60_000;
    try {
      ttlMs = parseDurationSeconds(req.bucket) * 1000;
    } catch {
      // unparseable bucket already surfaced as insufficient_data upstream · use a safe default TTL
    }
    cache.set(key, core, ttlMs);
  }

  if (core.status !== 'ok' || core.median === undefined || core.mad === undefined) {
    return { status: core.status, coverage: core.coverage };
  }

  const band = computeBand(core.median, core.mad, k);
  const result: BaselineResult = { status: 'ok', band, coverage: core.coverage };

  if (req.current_value !== undefined) {
    const z = robustZ(req.current_value, core.median, core.mad);
    result.deviation = { robust_z: z, label: deviationLabel(z, k) };
  }

  return result;
}

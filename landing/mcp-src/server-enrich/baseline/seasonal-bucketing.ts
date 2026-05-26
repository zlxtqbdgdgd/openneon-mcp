/**
 * seasonal-MAD bucketing · feat-017 (L2b) · pure functions (no I/O · no LLM · §3.3.0).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-017-L2b-mcp-server-enrich-baseline-seasonal-mad.html §3
 *
 * Split a time series into 24 hour-of-day buckets (UTC). Each bucket then independently runs
 * feat-016's median+MAD via `computeBucketCore`. Cross-bucket fallback is handled by the caller
 * (baseline.ts seasonal branch) per the three-level chain in §3.2.
 */

import {
  median,
  medianAbsoluteDeviation,
  type BaselineBand,
} from './median-mad';

/** Number of hour-of-day buckets · 24 (L2b · OQ1 留扩展点给 168 桶 hour-of-week). */
export const BUCKET_COUNT = 24;

/** UTC hour-of-day (0..23) for a unix-second timestamp. UTC keeps dev server / Datadog consistent. */
export function hourOfDayUTC(unixSec: number): number {
  return new Date(unixSec * 1000).getUTCHours();
}

/**
 * Per-bucket objective baseline (k-independent · current_value-independent · cacheable).
 *
 * Mirrors feat-016 `BaselineCore` shape but per-bucket: status is one of ok/insufficient_data/
 * degenerate. The seasonal cache layer holds 24 of these plus one global fallback.
 */
export type BucketCore =
  | { status: 'ok'; median: number; mad: number; sample_count: number }
  | { status: 'insufficient_data'; sample_count: number }
  | { status: 'degenerate'; median: number; sample_count: number };

/**
 * Group finite values by their UTC hour-of-day. null / NaN / non-finite points are skipped (sparse
 * buckets ≠ failures · §6 fail-honest).
 */
export function groupByHourOfDay(
  points: Array<[number, number | null]>,
): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (let h = 0; h < BUCKET_COUNT; h++) groups.set(h, []);
  for (const [t, v] of points) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    groups.get(hourOfDayUTC(t))!.push(v);
  }
  return groups;
}

/**
 * Compute the per-bucket objective core. Three-state mirroring feat-016: insufficient_data when
 * the bucket has fewer than `minPoints` finite values · degenerate when MAD=0 (give the median
 * but no band) · ok otherwise.
 */
export function computeBucketCore(
  values: number[],
  minPoints: number,
): BucketCore {
  if (values.length < minPoints) {
    return { status: 'insufficient_data', sample_count: values.length };
  }
  const med = median(values);
  const mad = medianAbsoluteDeviation(values, med);
  if (mad === 0) {
    return {
      status: 'degenerate',
      median: med,
      sample_count: values.length,
    };
  }
  return { status: 'ok', median: med, mad, sample_count: values.length };
}

/**
 * Flatten all finite values across buckets · used to compute the global fallback core (level ② of
 * the three-level fallback chain in §3.2 of feat-017).
 */
export function flattenFiniteValues(
  points: Array<[number, number | null]>,
): number[] {
  const out: number[] = [];
  for (const [, v] of points) {
    if (v !== null && v !== undefined && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Re-export for ergonomic imports by consumers walking the seasonal pipeline. */
export type { BaselineBand };

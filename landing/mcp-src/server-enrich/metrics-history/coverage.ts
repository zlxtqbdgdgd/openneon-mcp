/**
 * Coverage computation for the metrics-history seam · feat-064 (L2a).
 *
 * Vendor-neutral: given the parsed points + the absolute window + bucket, compute how much of the
 * window actually carried data. Lets a consumer (feat-016) tell "enough to baseline?" from "the
 * backend was down for part of the window" — distinct from an outright retrieval failure.
 */

import type { Coverage } from './types';

/**
 * Compute coverage from points + window + bucket.
 *
 * - expected_points = floor(span ÷ bucket) · how many buckets the window should contain.
 * - actual_points   = number of points carrying a non-null value (sparse = actual < expected).
 * - span_seconds    = to − from.
 * - latest_point_ts = max ts among non-null points · null when there is no data (staleness).
 */
export function computeCoverage(
  points: Array<[number, number | null]>,
  fromSeconds: number,
  toSeconds: number,
  bucketSeconds: number,
): Coverage {
  const span = Math.max(0, toSeconds - fromSeconds);
  const expected =
    bucketSeconds > 0 ? Math.floor(span / bucketSeconds) : 0;

  let actual = 0;
  let latest: number | null = null;
  for (const [ts, value] of points) {
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      actual++;
      if (latest === null || ts > latest) latest = ts;
    }
  }

  return {
    actual_points: actual,
    expected_points: expected,
    span_seconds: span,
    latest_point_ts: latest,
  };
}

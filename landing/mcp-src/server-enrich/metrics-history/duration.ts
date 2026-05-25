/**
 * Duration / window helpers for the metrics-history seam · feat-064 (L2a).
 *
 * Vendor-neutral: parses '7d' / '24h' / '1h' / '5m' / '15s' style durations into seconds, and
 * resolves a MetricWindow into an absolute [from, to] unix-second range. Shared by every adapter
 * (coverage math + rollup sizing depend on it).
 */

import type { MetricWindow } from './types';

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Parse a duration like '7d' / '1h' / '5m' / '15s' into seconds.
 *
 * @throws Error on an unparseable / non-positive duration (caught upstream → backend_error · never
 *   silently coerced, which would corrupt expected_points).
 */
export function parseDurationSeconds(d: string): number {
  const m = DURATION_RE.exec(d.trim());
  if (!m) {
    throw new Error(`Unparseable duration: '${d}' (expected e.g. '7d', '1h', '5m', '15s')`);
  }
  const value = Number(m[1]);
  if (value <= 0) {
    throw new Error(`Non-positive duration: '${d}'`);
  }
  return value * UNIT_SECONDS[m[2]];
}

/**
 * Resolve a window into an absolute [from, to] unix-second range.
 *
 * - Relative ({ last: '7d' }): to = now, from = now − duration. `now` is the wall clock (seconds).
 * - Absolute ({ from, to }): used directly.
 */
export function resolveWindow(
  window: MetricWindow,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { from: number; to: number } {
  if ('last' in window) {
    const span = parseDurationSeconds(window.last);
    return { from: nowSeconds - span, to: nowSeconds };
  }
  return { from: window.from, to: window.to };
}

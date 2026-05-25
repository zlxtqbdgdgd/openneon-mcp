/**
 * median + MAD robust baseline math · feat-016 (L2a) · pure functions (no I/O · no LLM · §3.3.0).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-016-L2-mcp-server-enrich-baseline-mad.html §3
 *
 * Why median+MAD over mean+stddev: robust to outliers. A few one-off spikes (occasional slow
 * queries) drag mean+stddev up → the band inflates → real anomalies get missed. median (middle) +
 * MAD (median absolute deviation) barely move with a few outliers → the band hugs the normal level.
 */

/** Consistency scale factor making 1.4826·MAD a robust estimator of σ for normal data. */
export const MAD_SCALE = 1.4826;

/** Median of a numeric array (assumes non-empty · caller guards via min_points). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Median Absolute Deviation: median(|v − median(values)|). 0 when all values are identical. */
export function medianAbsoluteDeviation(values: number[], med?: number): number {
  const m = med ?? median(values);
  const deviations = values.map((v) => Math.abs(v - m));
  return median(deviations);
}

export type BaselineBand = {
  median: number;
  mad: number;
  /** median − k·(1.4826·MAD). */
  lo: number;
  /** median + k·(1.4826·MAD). */
  hi: number;
};

/** Two-sided band median ± k·(1.4826·MAD). */
export function computeBand(med: number, mad: number, k: number): BaselineBand {
  const half = k * MAD_SCALE * mad;
  return { median: med, mad, lo: med - half, hi: med + half };
}

/** Robust z-score (current − median) / (1.4826·MAD). Undefined-safe only when MAD > 0 (caller guards). */
export function robustZ(current: number, med: number, mad: number): number {
  return (current - med) / (MAD_SCALE * mad);
}

export type DeviationLabel = 'normal' | 'high' | 'low';

/** label: high when robust_z > k · low when < −k · else normal. */
export function deviationLabel(z: number, k: number): DeviationLabel {
  if (z > k) return 'high';
  if (z < -k) return 'low';
  return 'normal';
}

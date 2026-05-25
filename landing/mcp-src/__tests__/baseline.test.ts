/**
 * feat-016 median+MAD baseline unit tests (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-016-L2-mcp-server-enrich-baseline-mad.html §7
 *
 * Covers: pure median/MAD math, robustness vs mean+stddev, the honest THREE-STATE (ok /
 * insufficient_data / degenerate), band caching (TTL · current_value never cached · cross-tenant
 * isolation), and history-fetch-failure degradation. History is injected (no real Datadog).
 */

import { describe, it, expect } from 'vitest';
import {
  median,
  medianAbsoluteDeviation,
  computeBand,
  MAD_SCALE,
} from '../server-enrich/baseline/median-mad';
import { baseline, createBaselineCache } from '../server-enrich/baseline/baseline';
import type {
  MetricHistoryRequest,
  MetricHistoryResult,
  Coverage,
} from '../server-enrich/metrics-history';

function coverage(actual: number, expected: number): Coverage {
  return {
    actual_points: actual,
    expected_points: expected,
    span_seconds: expected * 3600,
    latest_point_ts: 1000,
  };
}

/** Build an injectable history fetcher returning a fixed value series. */
function historyFrom(
  values: number[],
): (req: MetricHistoryRequest) => Promise<MetricHistoryResult> {
  return async () => ({
    points: values.map((v, i) => [1000 + i * 3600, v] as [number, number | null]),
    coverage: coverage(values.length, Math.max(values.length, 168)),
  });
}

const errorHistory = async (): Promise<MetricHistoryResult> => ({
  error: { reason: 'unreachable' as const },
});

describe('median + MAD pure math', () => {
  it('median (odd / even)', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('MAD = median absolute deviation · 0 for identical values', () => {
    expect(medianAbsoluteDeviation([5, 5, 5, 5])).toBe(0);
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
  });

  it('band = median ± k·1.4826·MAD', () => {
    const band = computeBand(100, 2, 3);
    expect(band.median).toBe(100);
    expect(band.hi).toBeCloseTo(100 + 3 * MAD_SCALE * 2, 6);
    expect(band.lo).toBeCloseTo(100 - 3 * MAD_SCALE * 2, 6);
  });
});

describe('robustness: median+MAD vs mean+stddev under outliers', () => {
  it('a handful of spikes barely widen the MAD band but would NOT be caught by a wide mean+stddev band', async () => {
    // 30 values ~100 ± 2, then 3 spikes of 1000.
    const normal = [98, 99, 100, 101, 102];
    const values = [
      ...normal, ...normal, ...normal, ...normal, ...normal, ...normal,
      1000, 1000, 1000,
    ];

    // mean + stddev (the naive approach the design rejects).
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    const meanHi = mean + 3 * stddev;

    const result = await baseline(
      {
        signal: 's',
        dimensions: {},
        window: { last: '7d' },
        bucket: '1h',
        current_value: 200,
      },
      { fetchHistory: historyFrom(values), cache: createBaselineCache(() => 0) },
    );

    expect(result.status).toBe('ok');
    // MAD band hugs ~100 (spikes don't inflate it) → 200 is far outside.
    expect(result.band!.hi).toBeLessThan(150);
    // A current value of 200 is flagged high by MAD ...
    expect(result.deviation!.label).toBe('high');
    expect(result.deviation!.robust_z).toBeGreaterThan(3);
    // ... but the mean+stddev band is so wide it would MISS the anomaly (demonstrates why MAD wins).
    expect(meanHi).toBeGreaterThan(200);
  });
});

describe('three-state honesty', () => {
  const base = {
    signal: 's',
    dimensions: {},
    window: { last: '7d' } as const,
    bucket: '1h',
  };

  it('ok: sufficient varied history → band + (with current) deviation', async () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
    const result = await baseline(
      { ...base, current_value: 102 },
      { fetchHistory: historyFrom(values), cache: createBaselineCache(() => 0) },
    );
    expect(result.status).toBe('ok');
    expect(result.band).toBeDefined();
    expect(result.deviation!.label).toBe('normal');
  });

  it('insufficient_data: < min_points → NO band (never a fake band)', async () => {
    const values = Array.from({ length: 10 }, (_, i) => 100 + i);
    const result = await baseline(
      { ...base },
      { fetchHistory: historyFrom(values), cache: createBaselineCache(() => 0) },
    );
    expect(result.status).toBe('insufficient_data');
    expect(result.band).toBeUndefined();
  });

  it('degenerate: MAD=0 (all identical) → NO band · NO robust_z (不报异常)', async () => {
    const values = Array.from({ length: 30 }, () => 50);
    const result = await baseline(
      { ...base, current_value: 999 },
      { fetchHistory: historyFrom(values), cache: createBaselineCache(() => 0) },
    );
    expect(result.status).toBe('degenerate');
    expect(result.band).toBeUndefined();
    expect(result.deviation).toBeUndefined();
  });

  it('history fetch failure → insufficient_data (degrade · never "normal")', async () => {
    const result = await baseline(
      { ...base, current_value: 100 },
      { fetchHistory: errorHistory, cache: createBaselineCache(() => 0) },
    );
    expect(result.status).toBe('insufficient_data');
    expect(result.band).toBeUndefined();
  });
});

describe('band caching', () => {
  const base = {
    signal: 's',
    dimensions: { endpoint: 'main' },
    window: { last: '7d' } as const,
    bucket: '1h',
  };
  const values = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));

  it('second call within TTL reuses the cached band (no refetch)', async () => {
    let fetches = 0;
    const fetchHistory = async () => {
      fetches++;
      return historyFrom(values)({} as MetricHistoryRequest);
    };
    const cache = createBaselineCache(() => 0);
    const deps = { fetchHistory, cache };

    await baseline({ ...base, current_value: 100 }, deps);
    await baseline({ ...base, current_value: 999 }, deps);
    expect(fetches).toBe(1);
  });

  it('current_value is NOT cached · robust_z recomputed fresh per call from the same band', async () => {
    const cache = createBaselineCache(() => 0);
    const deps = { fetchHistory: historyFrom(values), cache };

    const r1 = await baseline({ ...base, current_value: 100 }, deps);
    const r2 = await baseline({ ...base, current_value: 130 }, deps);
    // Same band (median identical), different deviation (different live value).
    expect(r1.band!.median).toBe(r2.band!.median);
    expect(r2.deviation!.robust_z).toBeGreaterThan(r1.deviation!.robust_z);
  });

  it('TTL expiry → refetch', async () => {
    let fetches = 0;
    const fetchHistory = async () => {
      fetches++;
      return historyFrom(values)({} as MetricHistoryRequest);
    };
    let clock = 0;
    const cache = createBaselineCache(() => clock);
    const deps = { fetchHistory, cache };

    await baseline({ ...base, current_value: 100 }, deps); // bucket 1h → TTL 3.6e6 ms
    clock = 3_600_001; // just past TTL
    await baseline({ ...base, current_value: 100 }, deps);
    expect(fetches).toBe(2);
  });

  it('cross-tenant isolation: different dimensions → separate cache entries (never shared)', async () => {
    let fetches = 0;
    const fetchHistory = async () => {
      fetches++;
      return historyFrom(values)({} as MetricHistoryRequest);
    };
    const cache = createBaselineCache(() => 0);
    const deps = { fetchHistory, cache };

    await baseline(
      { ...base, dimensions: { endpoint: 'tenant-a' }, current_value: 100 },
      deps,
    );
    await baseline(
      { ...base, dimensions: { endpoint: 'tenant-b' }, current_value: 100 },
      deps,
    );
    expect(fetches).toBe(2); // no cross-tenant cache hit
  });
});

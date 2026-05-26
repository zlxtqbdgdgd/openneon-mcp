/**
 * feat-017 seasonal-MAD baseline branch · integration tests.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-017-L2b-mcp-server-enrich-baseline-seasonal-mad.html
 *
 * Covers the three-level fallback chain (§3.2):
 *   ① seasonal-mad   · bucket for current hour is ok
 *   ② median-mad     · bucket unavailable but global is ok
 *   ③ status only    · both unavailable · algo=null
 *
 * History fetch + Clock are injected; the math layer is the production code path (feat-016 +
 * feat-017 seasonal-bucketing).
 */

import { describe, it, expect } from 'vitest';
import {
  baseline,
  createBaselineCache,
  createSeasonalCache,
  type BaselineRequest,
} from '../server-enrich/baseline/baseline';
import type {
  MetricHistoryRequest,
  MetricHistoryResult,
} from '../server-enrich/metrics-history';

/**
 * Build a synthetic history covering the last 21d at 1h granularity. Each hour h gets a value drawn
 * from `valueForHour(h, day)`. Timestamps step backward 1h from `nowSec` over 21 * 24 = 504 buckets.
 */
function makeHistory(
  nowSec: number,
  valueForHour: (hour: number, day: number) => number | null,
): MetricHistoryResult {
  const points: Array<[number, number | null]> = [];
  const total = 21 * 24;
  for (let i = 0; i < total; i++) {
    const t = nowSec - i * 3600;
    const day = Math.floor(i / 24);
    const h = new Date(t * 1000).getUTCHours();
    points.push([t, valueForHour(h, day)]);
  }
  return {
    points,
    coverage: {
      actual_points: points.filter((p) => p[1] !== null).length,
      expected_points: total,
      span_seconds: total * 3600,
      latest_point_ts: nowSec,
    },
  };
}

function makeFetcher(history: MetricHistoryResult) {
  const calls: MetricHistoryRequest[] = [];
  const fetcher = async (req: MetricHistoryRequest) => {
    calls.push(req);
    return history;
  };
  return { fetcher, calls };
}

/** UTC 14:00 on 2026-05-26 · used by every seasonal test to pin the "current hour" bucket. */
const NOW_MS_14_UTC = Date.UTC(2026, 4, 26, 14, 30, 0);
const NOW_CLOCK = () => NOW_MS_14_UTC;

const baseReq: BaselineRequest = {
  signal: 'connections',
  dimensions: { endpoint: 'main' },
  window: { last: '21d' },
  bucket: '1h',
  seasonal: true,
};

describe('feat-017 seasonal · level ① seasonal-mad (current bucket ok)', () => {
  // workhour bucket (h=14) median ≈ 100 with day-by-day jitter so MAD>0 · nighttime ≈ 5.
  const dailyCycleHistory = (now: number) =>
    makeHistory(now, (h, day) =>
      h === 14 ? 100 + (day % 5) : 5 + ((h * 3 + day) % 4),
    );

  it('14:00 UTC bucket centered ~100 · current 100 → label=normal · algo=seasonal-mad', async () => {
    const { fetcher, calls } = makeFetcher(dailyCycleHistory(NOW_MS_14_UTC / 1000));
    const r = await baseline(
      { ...baseReq, current_value: 100 },
      {
        fetchHistory: fetcher,
        seasonalCache: createSeasonalCache(),
        now: NOW_CLOCK,
      },
    );
    expect(r.status).toBe('ok');
    expect(r.algo).toBe('seasonal-mad');
    expect(r.bucket_id).toBe(14);
    expect(r.band?.median).toBeGreaterThanOrEqual(100);
    expect(r.band?.median).toBeLessThanOrEqual(104);
    expect(r.deviation?.label).toBe('normal');
    expect(calls.length).toBe(1);
  });

  it('14:00 bucket centered ~100 · current 5 → label=low · status=ok (algo flag tells caller)', async () => {
    const { fetcher } = makeFetcher(dailyCycleHistory(NOW_MS_14_UTC / 1000));
    const r = await baseline(
      { ...baseReq, current_value: 5 },
      {
        fetchHistory: fetcher,
        seasonalCache: createSeasonalCache(),
        now: NOW_CLOCK,
      },
    );
    expect(r.status).toBe('ok');
    expect(r.algo).toBe('seasonal-mad');
    expect(r.deviation?.label).toBe('low');
  });
});

describe('feat-017 seasonal · level ② median-mad fallback (bucket short / degenerate)', () => {
  it('current bucket has < 20 points → fallback to global · algo=median-mad · bucket_id still set', async () => {
    // Only the 14h bucket has limited data: most of the 21 occurrences of hour 14 return null,
    // leaving < 20 finite samples in that bucket. Other hours have full samples → global ok.
    const hist = makeHistory(NOW_MS_14_UTC / 1000, (h, day) => {
      if (h === 14 && day > 2) return null; // ~3 finite samples for h=14
      return 50 + ((h * 7) % 11);
    });
    const { fetcher } = makeFetcher(hist);
    const r = await baseline(
      { ...baseReq, current_value: 50 },
      {
        fetchHistory: fetcher,
        seasonalCache: createSeasonalCache(),
        now: NOW_CLOCK,
      },
    );
    expect(r.status).toBe('ok');
    expect(r.algo).toBe('median-mad');
    expect(r.bucket_id).toBe(14); // honest about which bucket we WANTED
  });

  it('current bucket all identical (MAD=0 · degenerate) · global ok → fallback algo=median-mad', async () => {
    const hist = makeHistory(NOW_MS_14_UTC / 1000, (h) =>
      h === 14 ? 100 : 50 + ((h * 7) % 11),
    );
    const { fetcher } = makeFetcher(hist);
    const r = await baseline(
      { ...baseReq, current_value: 50 },
      {
        fetchHistory: fetcher,
        seasonalCache: createSeasonalCache(),
        now: NOW_CLOCK,
      },
    );
    expect(r.status).toBe('ok');
    expect(r.algo).toBe('median-mad');
    expect(r.bucket_id).toBe(14);
  });
});

describe('feat-017 seasonal · level ③ both unavailable · honest pass-through', () => {
  it('total points < min_points → status=insufficient_data · algo=null · bucket_id still recorded', async () => {
    // Sparse history · only the first 10 timestamps carry a value → 10 finite < MIN_POINTS=20.
    let kept = 0;
    const sparseHist = makeHistory(NOW_MS_14_UTC / 1000, () =>
      kept++ < 10 ? 10 + ((kept * 3) % 7) : null,
    );
    const { fetcher } = makeFetcher(sparseHist);
    const r = await baseline(
      { ...baseReq, current_value: 50 },
      {
        fetchHistory: fetcher,
        seasonalCache: createSeasonalCache(),
        now: NOW_CLOCK,
      },
    );
    expect(r.status).toBe('insufficient_data');
    expect(r.algo).toBeNull();
    expect(r.bucket_id).toBe(14);
    expect(r.band).toBeUndefined();
  });

  it('history fetch fails (error) → status=insufficient_data · algo=null · no throw (§8)', async () => {
    const fetcher = async () =>
      ({ error: { reason: 'auth' as const } }) as MetricHistoryResult;
    const r = await baseline(
      { ...baseReq, current_value: 50 },
      {
        fetchHistory: fetcher,
        seasonalCache: createSeasonalCache(),
        now: NOW_CLOCK,
      },
    );
    expect(r.status).toBe('insufficient_data');
    expect(r.algo).toBeNull();
  });

  it('all points identical (MAD=0 globally · ALL buckets degenerate) → status=degenerate · algo=null', async () => {
    const hist = makeHistory(NOW_MS_14_UTC / 1000, () => 7);
    const { fetcher } = makeFetcher(hist);
    const r = await baseline(
      { ...baseReq, current_value: 7 },
      {
        fetchHistory: fetcher,
        seasonalCache: createSeasonalCache(),
        now: NOW_CLOCK,
      },
    );
    expect(r.status).toBe('degenerate');
    expect(r.algo).toBeNull();
  });
});

describe('feat-017 seasonal · caching (independent space from non-seasonal)', () => {
  it('second call same key hits cache · NO second fetchHistory call', async () => {
    const hist = makeHistory(NOW_MS_14_UTC / 1000, (h) =>
      h === 14 ? 100 + (h % 3) : 5 + (h % 4),
    );
    const { fetcher, calls } = makeFetcher(hist);
    const cache = createSeasonalCache();
    const deps = { fetchHistory: fetcher, seasonalCache: cache, now: NOW_CLOCK };
    await baseline({ ...baseReq, current_value: 100 }, deps);
    await baseline({ ...baseReq, current_value: 101 }, deps);
    expect(calls.length).toBe(1);
  });

  it('different dimensions → different cache key · separate fetches (cross-tenant isolation)', async () => {
    const hist = makeHistory(NOW_MS_14_UTC / 1000, () => 50);
    const { fetcher, calls } = makeFetcher(hist);
    const cache = createSeasonalCache();
    await baseline(
      { ...baseReq, dimensions: { endpoint: 'A' }, current_value: 50 },
      { fetchHistory: fetcher, seasonalCache: cache, now: NOW_CLOCK },
    );
    await baseline(
      { ...baseReq, dimensions: { endpoint: 'B' }, current_value: 50 },
      { fetchHistory: fetcher, seasonalCache: cache, now: NOW_CLOCK },
    );
    expect(calls.length).toBe(2);
  });

  it('seasonal=false uses the feat-016 cache space · does NOT collide with seasonal=true', async () => {
    // Two calls: one seasonal:true, one seasonal:false (same signal/dims/window/bucket). Both
    // must trigger their own fetch (independent cache spaces). Use isolated caches both sides so
    // the test doesn't depend on / dirty the module-level default cache.
    const hist = makeHistory(NOW_MS_14_UTC / 1000, () => 50);
    const { fetcher, calls } = makeFetcher(hist);
    const seasonalCache = createSeasonalCache();
    const cache = createBaselineCache();
    await baseline(
      { ...baseReq, current_value: 50 },
      { fetchHistory: fetcher, seasonalCache, cache, now: NOW_CLOCK },
    );
    await baseline(
      { ...baseReq, seasonal: false, current_value: 50 },
      { fetchHistory: fetcher, seasonalCache, cache, now: NOW_CLOCK },
    );
    expect(calls.length).toBe(2);
  });
});

describe('feat-017 seasonal · current-hour pinning via injected Clock', () => {
  it('different "now" → different bucket_id (each picks its own hour)', async () => {
    const hist = makeHistory(NOW_MS_14_UTC / 1000, (h) => 50 + (h % 7));
    const { fetcher } = makeFetcher(hist);
    const cache = createSeasonalCache();

    const r14 = await baseline(
      { ...baseReq, current_value: 50 },
      { fetchHistory: fetcher, seasonalCache: cache, now: () => NOW_MS_14_UTC },
    );
    const r02 = await baseline(
      {
        ...baseReq,
        current_value: 50,
        dimensions: { endpoint: 'other' }, // bypass cache so the fetch + bucket happen fresh
      },
      {
        fetchHistory: fetcher,
        seasonalCache: cache,
        now: () => Date.UTC(2026, 4, 26, 2, 0, 0),
      },
    );
    expect(r14.bucket_id).toBe(14);
    expect(r02.bucket_id).toBe(2);
  });
});

describe('feat-017 seasonal · feat-016 unchanged when seasonal=false (regression guard)', () => {
  it('seasonal=false path returns algo=median-mad without bucket_id', async () => {
    // Day-varying values guarantee globally MAD>0 (otherwise computeCore reports degenerate).
    const hist = makeHistory(NOW_MS_14_UTC / 1000, (h, day) => 50 + ((h + day) % 5));
    const { fetcher } = makeFetcher(hist);
    const r = await baseline(
      { ...baseReq, seasonal: false, current_value: 50 },
      { fetchHistory: fetcher, cache: createBaselineCache(), now: NOW_CLOCK },
    );
    expect(r.status).toBe('ok');
    expect(r.algo).toBe('median-mad');
    expect(r.bucket_id).toBeUndefined();
  });
});

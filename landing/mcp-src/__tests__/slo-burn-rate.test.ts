/**
 * feat-018 SLO multi-window burn rate unit tests (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-018-L2-mcp-server-enrich-sli-burn-rate.html §7
 *
 * Covers: dual-window fast burn (both > 14.4), anti-staleness (5m recovered → false), honest
 * three-state (short-window unavailable → 'unknown' ≠ false; 30d unavailable → budget null), and
 * both SLI kinds (native_ratio / gauge_threshold). History is injected (no real Datadog).
 */

import { describe, it, expect } from 'vitest';
import {
  computeSli,
  burnRate,
  errorBudgetRemaining,
  sloBurnRate,
  createSloCache,
  type SloSpec,
} from '../server-enrich/baseline/slo-burn-rate';
import type {
  MetricHistoryRequest,
  MetricHistoryResult,
  Coverage,
} from '../server-enrich/metrics-history';

const cov: Coverage = {
  actual_points: 12,
  expected_points: 12,
  span_seconds: 3600,
  latest_point_ts: 1,
};

/** Build a history fetcher that returns a per-window value list keyed by the window's `last`. */
function historyByWindow(
  byLast: Record<string, number[] | 'error'>,
): (req: MetricHistoryRequest) => Promise<MetricHistoryResult> {
  return async (req) => {
    const last = 'last' in req.window ? req.window.last : 'abs';
    const v = byLast[last];
    if (v === undefined || v === 'error') {
      return { error: { reason: 'unreachable' as const } };
    }
    return {
      points: v.map((x, i) => [i * 60, x] as [number, number | null]),
      coverage: cov,
    };
  };
}

const NATIVE_SPEC: SloSpec = {
  signal: 'cache_hit_ratio',
  sli_kind: 'native_ratio',
  slo_target: 0.99,
  budget_window: '30d',
};

const GAUGE_SPEC: SloSpec = {
  signal: 'connections',
  sli_kind: 'gauge_threshold',
  threshold: 80,
  good_when: 'below',
  slo_target: 0.99,
  budget_window: '30d',
};

describe('pure helpers', () => {
  it('computeSli · native_ratio = mean of values', () => {
    expect(computeSli([[0, 0.9], [60, 0.8]], NATIVE_SPEC)).toBeCloseTo(0.85, 6);
  });

  it('computeSli · gauge_threshold = proportion satisfying (below)', () => {
    // 3 of 4 buckets ≤ 80 → 0.75
    const sli = computeSli([[0, 50], [60, 60], [120, 70], [180, 200]], GAUGE_SPEC);
    expect(sli).toBeCloseTo(0.75, 6);
  });

  it('computeSli · no data → null (→ unknown upstream)', () => {
    expect(computeSli([[0, null]], NATIVE_SPEC)).toBeNull();
    expect(computeSli([], NATIVE_SPEC)).toBeNull();
  });

  it('burnRate = (1−SLI)/(1−target)', () => {
    expect(burnRate(0.85, 0.99)).toBeCloseTo(15, 6); // (0.15)/(0.01)
  });

  it('errorBudgetRemaining clamps to [0,1]', () => {
    expect(errorBudgetRemaining(0.999, 0.99)).toBeCloseTo(0.9, 6); // consumed 0.1
    expect(errorBudgetRemaining(0.5, 0.99)).toBe(0); // way over budget → clamp 0
  });
});

describe('dual-window fast burn (native_ratio)', () => {
  it('both windows burning (>14.4) → is_sli_burning=true', async () => {
    // SLI ~0.85 in both 1h and 5m → burn ~15 > 14.4
    const fetchHistory = historyByWindow({
      '1h': [0.85, 0.85],
      '5m': [0.82, 0.84],
      '30d': [0.995],
    });
    const block = await sloBurnRate(NATIVE_SPEC, {}, {
      fetchHistory,
      cache: createSloCache(() => 0),
    });
    expect(block.is_sli_burning).toBe(true);
    expect(block.burn_rate_1h!).toBeGreaterThan(14.4);
    expect(block.burn_rate_5m!).toBeGreaterThan(14.4);
  });

  it('anti-staleness: 1h burning but 5m recovered → false', async () => {
    const fetchHistory = historyByWindow({
      '1h': [0.85, 0.85], // burn ~15
      '5m': [0.999, 0.999], // recovered → burn ~0.1
      '30d': [0.995],
    });
    const block = await sloBurnRate(NATIVE_SPEC, {}, {
      fetchHistory,
      cache: createSloCache(() => 0),
    });
    expect(block.is_sli_burning).toBe(false);
  });
});

describe('honest three-state', () => {
  it("short-window SLI history insufficient → 'unknown' (NOT false)", async () => {
    const fetchHistory = historyByWindow({
      '1h': [0.85, 0.85],
      '5m': 'error', // recent window blind
      '30d': [0.995],
    });
    const block = await sloBurnRate(NATIVE_SPEC, {}, {
      fetchHistory,
      cache: createSloCache(() => 0),
    });
    expect(block.is_sli_burning).toBe('unknown');
    expect(block.burn_rate_5m).toBeNull();
  });

  it('30d history insufficient → error_budget_remaining=null (short burn still computed)', async () => {
    const fetchHistory = historyByWindow({
      '1h': [0.999, 0.999],
      '5m': [0.999, 0.999],
      '30d': 'error',
    });
    const block = await sloBurnRate(NATIVE_SPEC, {}, {
      fetchHistory,
      cache: createSloCache(() => 0),
    });
    expect(block.error_budget_remaining).toBeNull();
    expect(block.is_sli_burning).toBe(false); // short windows healthy
    expect(block.burn_rate_1h).not.toBeNull();
  });
});

describe('gauge_threshold SLI', () => {
  it('connections-style gauge → proportion-under-threshold SLI drives burn', async () => {
    // 5m window: 3 of 4 buckets over 80 → SLI 0.25 → burn (0.75/0.01)=75 ≫ 14.4
    const fetchHistory = historyByWindow({
      '1h': [200, 200, 200, 50], // SLI 0.25
      '5m': [200, 200, 200, 50], // SLI 0.25
      '30d': [50],
    });
    const block = await sloBurnRate(GAUGE_SPEC, {}, {
      fetchHistory,
      cache: createSloCache(() => 0),
    });
    expect(block.is_sli_burning).toBe(true);
    expect(block.sli_value).toBeCloseTo(0.25, 6);
  });
});

describe('caching', () => {
  it('second call within TTL reuses the block (no refetch)', async () => {
    let fetches = 0;
    const base = historyByWindow({ '1h': [0.999], '5m': [0.999], '30d': [0.999] });
    const fetchHistory = (req: MetricHistoryRequest) => {
      fetches++;
      return base(req);
    };
    const cache = createSloCache(() => 0);
    await sloBurnRate(NATIVE_SPEC, { endpoint: 'a' }, { fetchHistory, cache });
    await sloBurnRate(NATIVE_SPEC, { endpoint: 'a' }, { fetchHistory, cache });
    expect(fetches).toBe(3); // 3 windows fetched once · second call all-cached
  });

  it('cross-tenant isolation: different dimensions → separate entries', async () => {
    let fetches = 0;
    const base = historyByWindow({ '1h': [0.999], '5m': [0.999], '30d': [0.999] });
    const fetchHistory = (req: MetricHistoryRequest) => {
      fetches++;
      return base(req);
    };
    const cache = createSloCache(() => 0);
    await sloBurnRate(NATIVE_SPEC, { endpoint: 'a' }, { fetchHistory, cache });
    await sloBurnRate(NATIVE_SPEC, { endpoint: 'b' }, { fetchHistory, cache });
    expect(fetches).toBe(6); // 3 per tenant · no cross-tenant hit
  });
});

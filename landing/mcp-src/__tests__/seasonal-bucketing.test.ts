/**
 * feat-017 seasonal-MAD bucketing · pure-function tests.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-017-L2b-mcp-server-enrich-baseline-seasonal-mad.html
 *
 * No I/O · no mocks · just verifies bucketing math + three-state per-bucket core.
 */

import { describe, it, expect } from 'vitest';
import {
  hourOfDayUTC,
  groupByHourOfDay,
  computeBucketCore,
  flattenFiniteValues,
  BUCKET_COUNT,
} from '../server-enrich/baseline/seasonal-bucketing';

describe('hourOfDayUTC · UTC hour extraction', () => {
  it('midnight UTC → 0', () => {
    // 2026-05-26T00:00:00Z = 1779580800
    expect(hourOfDayUTC(1779580800)).toBe(0);
  });

  it('one second before midnight → 23', () => {
    expect(hourOfDayUTC(1779580800 - 1)).toBe(23);
  });

  it('14:30 UTC → 14 (workhour example from feat-017 §12)', () => {
    // 2026-05-26T14:30:00Z
    expect(hourOfDayUTC(1779580800 + 14 * 3600 + 30 * 60)).toBe(14);
  });
});

describe('groupByHourOfDay · 24-bucket partition', () => {
  it('always returns 24 keyed buckets (some may be empty)', () => {
    const groups = groupByHourOfDay([[1779580800, 1.0]]);
    expect(groups.size).toBe(BUCKET_COUNT);
    for (let h = 0; h < BUCKET_COUNT; h++) {
      expect(groups.has(h)).toBe(true);
    }
  });

  it('puts points into the right hour bucket', () => {
    const points: Array<[number, number | null]> = [
      [1779580800, 10], // 00:00 UTC
      [1779580800 + 14 * 3600, 100], // 14:00 UTC
      [1779580800 + 14 * 3600 + 60, 101], // 14:01 UTC
    ];
    const groups = groupByHourOfDay(points);
    expect(groups.get(0)).toEqual([10]);
    expect(groups.get(14)).toEqual([100, 101]);
    expect(groups.get(5)).toEqual([]);
  });

  it('skips null / NaN / non-finite values (sparse ≠ failure · §6)', () => {
    const points: Array<[number, number | null]> = [
      [1779580800, 10],
      [1779580800 + 60, null],
      [1779580800 + 120, Number.NaN],
      [1779580800 + 180, Number.POSITIVE_INFINITY],
      [1779580800 + 240, 11],
    ];
    const groups = groupByHourOfDay(points);
    expect(groups.get(0)).toEqual([10, 11]);
  });
});

describe('computeBucketCore · three-state mirrors feat-016', () => {
  it('< minPoints → insufficient_data (no median · no MAD)', () => {
    const core = computeBucketCore([1, 2, 3, 4], 20);
    expect(core.status).toBe('insufficient_data');
    if (core.status === 'insufficient_data') {
      expect(core.sample_count).toBe(4);
    }
  });

  it('all identical → degenerate (median set · no MAD · honest no-band)', () => {
    const core = computeBucketCore(Array(30).fill(42), 20);
    expect(core.status).toBe('degenerate');
    if (core.status === 'degenerate') {
      expect(core.median).toBe(42);
      expect(core.sample_count).toBe(30);
    }
  });

  it('ok · MAD > 0 · median+mad both computed', () => {
    const values = [];
    for (let i = 0; i < 25; i++) values.push(20 + (i % 5)); // 20..24 repeating
    const core = computeBucketCore(values, 20);
    expect(core.status).toBe('ok');
    if (core.status === 'ok') {
      expect(core.median).toBeGreaterThanOrEqual(21);
      expect(core.median).toBeLessThanOrEqual(23);
      expect(core.mad).toBeGreaterThan(0);
      expect(core.sample_count).toBe(25);
    }
  });

  it('respects custom minPoints', () => {
    const core = computeBucketCore([10, 11, 12, 13, 14, 15], 5);
    expect(core.status).toBe('ok');
  });
});

describe('flattenFiniteValues · for the level ② global fallback', () => {
  it('drops null / NaN / Infinity', () => {
    const vs = flattenFiniteValues([
      [1, 1],
      [2, null],
      [3, Number.NaN],
      [4, 2],
      [5, Number.NEGATIVE_INFINITY],
      [6, 3],
    ]);
    expect(vs).toEqual([1, 2, 3]);
  });

  it('empty input → empty output (no throw)', () => {
    expect(flattenFiniteValues([])).toEqual([]);
  });
});

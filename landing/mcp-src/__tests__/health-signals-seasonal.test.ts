/**
 * T4 ↔ feat-017 seasonal-MAD wiring tests · feat-020 + feat-017 (L2b).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-017-L2b-mcp-server-enrich-baseline-seasonal-mad.html
 *
 * Asserts:
 *   - signals with seasonalApplicable=true pass `seasonal: true` + 21d/1h window through to baseline()
 *   - signals with seasonalApplicable=false stay on the feat-016 path (no seasonal flag · 7d/1h)
 *   - baseline_algo + bucket_id from the seasonal result surface into the HealthSignal output
 *   - flattenSignalRow emits the new baseline_algo + bucket_id columns
 *
 * The feat-016 baseline lib is mocked here; the seasonal math itself is covered by
 * seasonal-baseline.test.ts + seasonal-bucketing.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSqlQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => ({ query: mockSqlQuery })),
}));

vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: 'postgresql://mock-user:mock-pass@mock-host.neon.tech/mock-db',
    computeId: 'ep-mock',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

const mockBaseline = vi.fn();
vi.mock('../server-enrich/baseline/baseline', () => ({
  baseline: (...args: unknown[]) => mockBaseline(...args),
}));

import {
  handleGetHealthSignals,
  flattenSignalRow,
  type HealthSignal,
} from '../tools/handlers/health-signals';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetHealthSignals
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

beforeEach(() => {
  mockSqlQuery.mockReset();
  mockBaseline.mockReset();
});

describe('T4 seasonal opt-in · per-signal routing', () => {
  it('connections (seasonalApplicable=true) → baseline called with seasonal:true + 21d window', async () => {
    // Each of the 5 signals reads current value first · neon ext absent → lfc unavailable
    mockSqlQuery
      .mockResolvedValueOnce([{ value: 50 }]) // connections
      .mockResolvedValueOnce([{ value: 0.95 }]) // cache_hit_ratio
      .mockResolvedValueOnce([{ value: 0 }]) // replication_lag
      .mockResolvedValueOnce([{ value: 8000000 }]) // storage_size
      .mockResolvedValueOnce([{ has_neon: false }]); // neon ext probe
    mockBaseline.mockResolvedValue({
      status: 'insufficient_data',
      algo: null,
      coverage: { actual_points: 0, expected_points: 0, span_seconds: 0, latest_point_ts: null },
    });

    await handleGetHealthSignals(
      { projectId: 'p', dimensions: { endpoint: 'main' }, depth: 'full' },
      mockNeonClient,
      mockExtra,
    );

    // Find the call for `connections` → must carry seasonal:true + 21d window + 1h bucket.
    const connArg = mockBaseline.mock.calls.find(
      (c) => (c[0] as { signal: string }).signal === 'connections',
    )?.[0] as { seasonal?: boolean; window?: { last?: string }; bucket?: string };
    expect(connArg).toBeDefined();
    expect(connArg.seasonal).toBe(true);
    expect(connArg.window).toEqual({ last: '21d' });
    expect(connArg.bucket).toBe('1h');
  });

  it('replication_lag (seasonalApplicable=false) → baseline NOT called with seasonal:true', async () => {
    mockSqlQuery
      .mockResolvedValueOnce([{ value: 50 }])
      .mockResolvedValueOnce([{ value: 0.95 }])
      .mockResolvedValueOnce([{ value: 1.5 }]) // replication_lag has a value
      .mockResolvedValueOnce([{ value: 8000000 }])
      .mockResolvedValueOnce([{ has_neon: false }]);
    mockBaseline.mockResolvedValue({
      status: 'insufficient_data',
      algo: null,
      coverage: { actual_points: 0, expected_points: 0, span_seconds: 0, latest_point_ts: null },
    });

    await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );

    const replArg = mockBaseline.mock.calls.find(
      (c) => (c[0] as { signal: string }).signal === 'replication_lag_seconds',
    )?.[0] as { seasonal?: boolean; window?: { last?: string } };
    expect(replArg).toBeDefined();
    expect(replArg.seasonal).toBe(false);
    expect(replArg.window).toEqual({ last: '7d' });
  });
});

describe('T4 seasonal · result surfaces algo + bucket_id', () => {
  it('seasonal-mad ok result → baseline_algo + bucket_id appear in HealthSignal', async () => {
    mockSqlQuery
      .mockResolvedValueOnce([{ value: 95 }]) // connections current
      .mockResolvedValueOnce([{ value: 0.95 }])
      .mockResolvedValueOnce([{ value: 0 }])
      .mockResolvedValueOnce([{ value: 8000000 }])
      .mockResolvedValueOnce([{ has_neon: false }]);
    // First call (connections) returns seasonal-mad anomalous · other calls insufficient.
    mockBaseline.mockImplementation((arg: { signal: string }) => {
      if (arg.signal === 'connections') {
        return Promise.resolve({
          status: 'ok',
          band: { median: 20, mad: 4, lo: 2, hi: 38 },
          deviation: { robust_z: 12.6, label: 'high' },
          algo: 'seasonal-mad',
          bucket_id: 14,
          coverage: { actual_points: 480, expected_points: 504, span_seconds: 21 * 86400, latest_point_ts: 1 },
        });
      }
      return Promise.resolve({
        status: 'insufficient_data',
        algo: null,
        coverage: { actual_points: 0, expected_points: 0, span_seconds: 0, latest_point_ts: null },
      });
    });

    const result = await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.status).toBe('anomalous');
    expect(conn.baseline_algo).toBe('seasonal-mad');
    expect(conn.bucket_id).toBe(14);
    expect(conn.baseline_value).toBe(20);
    expect(conn.label).toBe('high');
  });

  it('seasonal fallback to median-mad → baseline_algo reflects fallback · bucket_id still set (transparency)', async () => {
    mockSqlQuery
      .mockResolvedValueOnce([{ value: 100 }])
      .mockResolvedValueOnce([{ value: 0.95 }])
      .mockResolvedValueOnce([{ value: 0 }])
      .mockResolvedValueOnce([{ value: 8000000 }])
      .mockResolvedValueOnce([{ has_neon: false }]);
    mockBaseline.mockImplementation((arg: { signal: string }) => {
      if (arg.signal === 'connections') {
        return Promise.resolve({
          status: 'ok',
          band: { median: 95, mad: 5, lo: 80, hi: 110 },
          deviation: { robust_z: 0.67, label: 'normal' },
          algo: 'median-mad', // fallback path
          bucket_id: 14, // bucket we WANTED · transparency
          coverage: { actual_points: 480, expected_points: 504, span_seconds: 21 * 86400, latest_point_ts: 1 },
        });
      }
      return Promise.resolve({
        status: 'insufficient_data',
        algo: null,
        coverage: { actual_points: 0, expected_points: 0, span_seconds: 0, latest_point_ts: null },
      });
    });

    const result = await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.baseline_algo).toBe('median-mad');
    expect(conn.bucket_id).toBe(14);
  });
});

describe('flattenSignalRow · new feat-017 columns', () => {
  it('seasonal-mad row carries baseline_algo + bucket_id as scalar columns', () => {
    const sig: HealthSignal = {
      signal_type: 'connections',
      value: 95,
      status: 'anomalous',
      baseline_value: 20,
      robust_z: 12.6,
      label: 'high',
      baseline_algo: 'seasonal-mad',
      bucket_id: 14,
    };
    const row = flattenSignalRow(sig);
    expect(row.baseline_algo).toBe('seasonal-mad');
    expect(row.bucket_id).toBe(14);
  });

  it('non-seasonal row leaves bucket_id blank (consistent columns across heterogeneous rows)', () => {
    const sig: HealthSignal = {
      signal_type: 'replication_lag_seconds',
      value: 1.5,
      status: 'ok',
      baseline_value: 1.4,
      robust_z: 0.1,
      label: 'normal',
      baseline_algo: 'median-mad',
    };
    const row = flattenSignalRow(sig);
    expect(row.baseline_algo).toBe('median-mad');
    expect(row.bucket_id).toBe('');
  });
});

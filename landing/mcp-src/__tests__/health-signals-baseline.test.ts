/**
 * T4 ↔ feat-016 baseline wiring tests · feat-020/#4 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-020-L2-mcp-tool-t4-health-signals.html §3
 *
 * Asserts the enrich seam: T4 passes a baseline_applicable signal's live value to feat-016 and
 * surfaces baseline_value / robust_z / label · flips status to 'anomalous' on a high/low label ·
 * and DEGRADES (current value only · status stays ok) on insufficient_data or a baseline error
 * (§8 degrade-not-block). The feat-016 baseline is mocked (its own math is tested in baseline.test.ts).
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

import { handleGetHealthSignals } from '../tools/handlers/health-signals';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetHealthSignals
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

beforeEach(() => {
  mockSqlQuery.mockReset();
  mockBaseline.mockReset();
});

describe('T4 baseline enrich · tracer bullet (value + baseline + label)', () => {
  it('high deviation → anomalous + robust_z + label + baseline_value (端到端打通)', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 95 }]); // connections current value
    mockBaseline.mockResolvedValueOnce({
      status: 'ok',
      band: { median: 20, mad: 4, lo: 2, hi: 38 },
      deviation: { robust_z: 12.6, label: 'high' },
      algo: 'median-mad',
      coverage: {
        actual_points: 120,
        expected_points: 168,
        span_seconds: 604800,
        latest_point_ts: 1,
      },
    });

    const result = await handleGetHealthSignals(
      { projectId: 'p', dimensions: { endpoint: 'main' } },
      mockNeonClient,
      mockExtra,
    );

    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.status).toBe('anomalous');
    expect(conn.value).toBe(95);
    expect(conn.baseline_value).toBe(20);
    expect(conn.robust_z).toBeCloseTo(12.6, 5);
    expect(conn.label).toBe('high');
    expect(conn.baseline_algo).toBe('median-mad');
  });

  it('passes the live current_value + dimensions through to feat-016', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 42 }]);
    mockBaseline.mockResolvedValueOnce({
      status: 'insufficient_data',
      algo: null,
      coverage: { actual_points: 0, expected_points: 0, span_seconds: 0, latest_point_ts: null },
    });

    await handleGetHealthSignals(
      { projectId: 'p', dimensions: { endpoint: 'main' } },
      mockNeonClient,
      mockExtra,
    );

    expect(mockBaseline).toHaveBeenCalledOnce();
    const arg = mockBaseline.mock.calls[0][0];
    expect(arg.signal).toBe('connections');
    expect(arg.current_value).toBe(42);
    expect(arg.dimensions).toEqual({ endpoint: 'main' });
  });

  it('normal label → status stays ok (not anomalous)', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 21 }]);
    mockBaseline.mockResolvedValueOnce({
      status: 'ok',
      band: { median: 20, mad: 4, lo: 2, hi: 38 },
      deviation: { robust_z: 0.17, label: 'normal' },
      algo: 'median-mad',
      coverage: { actual_points: 120, expected_points: 168, span_seconds: 604800, latest_point_ts: 1 },
    });

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.status).toBe('ok');
    expect(conn.label).toBe('normal');
  });
});

describe('T4 baseline enrich · honest degradation (§8 §12)', () => {
  it('insufficient_data → current value only · no baseline fields · no anomaly', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 50 }]);
    mockBaseline.mockResolvedValueOnce({
      status: 'insufficient_data',
      algo: null,
      coverage: { actual_points: 5, expected_points: 168, span_seconds: 604800, latest_point_ts: 1 },
    });

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.status).toBe('ok');
    expect(conn.value).toBe(50);
    expect(conn.baseline_value).toBeUndefined();
    expect(conn.robust_z).toBeUndefined();
  });

  it('baseline throws → degrade (current value only) · never blocks the signal', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 50 }]);
    mockBaseline.mockRejectedValueOnce(new Error('seam exploded'));

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.status).toBe('ok');
    expect(conn.value).toBe(50);
  });

  it('unavailable current value → baseline NOT called', async () => {
    mockSqlQuery.mockRejectedValueOnce(new Error('permission denied'));

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.status).toBe('unavailable');
    expect(mockBaseline).not.toHaveBeenCalled();
  });
});

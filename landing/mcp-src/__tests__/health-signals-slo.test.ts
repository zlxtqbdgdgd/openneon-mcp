/**
 * T4 ↔ feat-018 SLO burn-rate wiring tests · feat-020/#6 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-020-L2-mcp-tool-t4-health-signals.html §3
 *
 * Asserts: T4 injects the SLO block + top-level is_sli_burning for signals with an SLO spec; a
 * burning SLI (true) flips status to 'anomalous' (so it surfaces in shallow depth) while 'unknown'
 * does NOT; burn-rate failure degrades (no block) and never blocks the signal. Also covers the
 * CSV-flattening of the nested slo block. feat-018 + feat-016 are mocked.
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

// feat-016 baseline mocked to insufficient_data (keeps status ok · isolates SLO behavior).
vi.mock('../server-enrich/baseline/baseline', () => ({
  baseline: vi.fn().mockResolvedValue({
    status: 'insufficient_data',
    coverage: { actual_points: 0, expected_points: 0, span_seconds: 0, latest_point_ts: null },
  }),
}));

const mockSloBurnRate = vi.fn();
vi.mock('../server-enrich/baseline/slo-burn-rate', () => ({
  sloBurnRate: (...args: unknown[]) => mockSloBurnRate(...args),
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

function burningBlock(is_sli_burning: boolean | 'unknown') {
  return {
    sli_value: 0.25,
    slo_target: 0.99,
    budget_window: '30d',
    error_budget_remaining: is_sli_burning === true ? 0.02 : 0.9,
    burn_rate_1h: is_sli_burning === 'unknown' ? null : 15,
    burn_rate_5m: is_sli_burning === 'unknown' ? null : 18,
    is_sli_burning,
  };
}

beforeEach(() => {
  mockSqlQuery.mockReset();
  mockSloBurnRate.mockReset();
});

describe('T4 SLO enrich', () => {
  it('burning (true) → injects slo block + is_sli_burning + flips status to anomalous', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 95 }]);
    mockSloBurnRate.mockResolvedValueOnce(burningBlock(true));

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_sli_burning).toBe(true);
    expect(conn.slo?.burn_rate_1h).toBe(15);
    expect(conn.status).toBe('anomalous');
  });

  it("'unknown' → injects block but does NOT flip status (blind ≠ burning)", async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 30 }]);
    mockSloBurnRate.mockResolvedValueOnce(burningBlock('unknown'));

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_sli_burning).toBe('unknown');
    expect(conn.status).toBe('ok');
  });

  it('not burning (false) → block present · status ok', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 30 }]);
    mockSloBurnRate.mockResolvedValueOnce(burningBlock(false));

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_sli_burning).toBe(false);
    expect(conn.status).toBe('ok');
  });

  it('burn-rate failure → degrade (no slo block) · signal still returned', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 30 }]);
    mockSloBurnRate.mockRejectedValueOnce(new Error('seam down'));

    const result = await handleGetHealthSignals({ projectId: 'p' }, mockNeonClient, mockExtra);
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.slo).toBeUndefined();
    expect(conn.status).toBe('ok');
    expect(conn.value).toBe(30);
  });
});

describe('flattenSignalRow · CSV flattening of the nested slo block', () => {
  it('a burning signal flattens slo fields into scalar columns', () => {
    const sig: HealthSignal = {
      signal_type: 'connections',
      value: 95,
      status: 'anomalous',
      is_sli_burning: true,
      slo: burningBlock(true),
    };
    const row = flattenSignalRow(sig);
    expect(row.is_sli_burning).toBe('true');
    expect(row.burn_rate_1h).toBe(15);
    expect(row.sli_value).toBe(0.25);
  });

  it('a signal without slo leaves the slo columns blank (consistent columns)', () => {
    const sig: HealthSignal = {
      signal_type: 'storage_size',
      value: 42,
      status: 'ok',
    };
    const row = flattenSignalRow(sig);
    expect(row.burn_rate_1h).toBe('');
    expect(row.sli_value).toBe('');
    expect(row.is_sli_burning).toBe('');
    // same key set as an enriched row → stable CSV columns
    expect(Object.keys(row)).toContain('burn_rate_5m');
  });
});

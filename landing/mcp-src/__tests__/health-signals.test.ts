/**
 * T4 get_neondb_health_signals handler unit tests · feat-020/#1 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-020-L2-mcp-tool-t4-health-signals.html
 *
 * Scope of #1: tool skeleton + signal-registry walk + first current-value signal (connections).
 * baseline/SLO enrich (#4/#6) and the full signal set + extension graceful degradation (#5) are
 * separate sub-issues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @neondatabase/serverless before importing handler (sql-driver.ts uses neon() internally)
const mockSqlQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => ({
    query: mockSqlQuery,
  })),
}));

// Mock connection-string handler · isolate T4 SQL logic
vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: 'postgresql://mock-user:mock-pass@mock-host.neon.tech/mock-db',
    computeId: 'ep-mock',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

import { handleGetHealthSignals } from '../tools/handlers/health-signals';
import { getNeondbHealthSignalsInputSchema } from '../tools/toolsSchema';
import { SIGNAL_REGISTRY } from '../tools/signal-registry';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetHealthSignals
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

beforeEach(() => {
  mockSqlQuery.mockReset();
});

describe('handleGetHealthSignals · happy path', () => {
  it('returns the connections signal with its current value (status ok)', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 42 }]);

    const result = await handleGetHealthSignals(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    const connections = result.find((s) => s.signal_type === 'connections');
    expect(connections).toMatchObject({
      signal_type: 'connections',
      value: 42,
      status: 'ok',
    });
  });

  it('reads connections from pg_stat_activity scoped to the current database', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 5 }]);

    await handleGetHealthSignals({ projectId: 'proj-abc' }, mockNeonClient, mockExtra);

    expect(mockSqlQuery).toHaveBeenCalledOnce();
    const [actualSql] = mockSqlQuery.mock.calls[0];
    expect(actualSql).toMatch(/FROM pg_stat_activity/);
    expect(actualSql).toMatch(/datname = current_database\(\)/);
  });
});

describe('handleGetHealthSignals · honesty (unavailable, never silent)', () => {
  it('a current-value read failure degrades to status=unavailable with value=null (not "ok")', async () => {
    mockSqlQuery.mockRejectedValueOnce(new Error('permission denied'));

    const result = await handleGetHealthSignals(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    const connections = result.find((s) => s.signal_type === 'connections');
    expect(connections).toMatchObject({
      signal_type: 'connections',
      value: null,
      status: 'unavailable',
    });
  });

  it('a NULL value (no row) degrades to unavailable, not value=0', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: null }]);

    const result = await handleGetHealthSignals(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(result[0]).toMatchObject({ value: null, status: 'unavailable' });
  });
});

describe('handleGetHealthSignals · progressive depth (feat-007)', () => {
  it('shallow (default) keeps the connections key summary signal even when ok', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 10 }]);

    const result = await handleGetHealthSignals(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(result.map((s) => s.signal_type)).toContain('connections');
  });

  it('full returns every registry signal', async () => {
    // One mock row per signal in the registry.
    for (const _ of SIGNAL_REGISTRY) {
      mockSqlQuery.mockResolvedValueOnce([{ value: 1 }]);
    }

    const result = await handleGetHealthSignals(
      { projectId: 'proj-abc', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );

    expect(result).toHaveLength(SIGNAL_REGISTRY.length);
  });
});

describe('getNeondbHealthSignalsInputSchema · validation', () => {
  it('rejects missing projectId', () => {
    const result = getNeondbHealthSignalsInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts projectId-only (dimensions/depth optional)', () => {
    const result = getNeondbHealthSignalsInputSchema.safeParse({
      projectId: 'proj-abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts dimensions + depth', () => {
    const result = getNeondbHealthSignalsInputSchema.safeParse({
      projectId: 'proj-abc',
      dimensions: { endpoint: 'main' },
      depth: 'full',
    });
    expect(result.success).toBe(true);
  });
});

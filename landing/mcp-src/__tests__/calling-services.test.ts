/**
 * T2 get_neondb_calling_services handler unit tests (feat-002 #1 · L1 day-one ship).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-002-L1-mcp-tool-t2-calling-services.html
 *
 * Sales 剧本应用归因工具 · 通过 pg_stat_activity 查 application_name → 当前调当前 DB
 * 的应用名 + 连接数 + 最近活动 · agent 不必自己写 SQL（防 feat-003 SQL 幻觉）。
 *
 * Scope of #1 (this PR): handler + zod input schema. Registry entry + dispatch wiring +
 * threshold/endpoint_id schema 预留 are separate sub-issues (#2-#5).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @neondatabase/serverless before importing handler (sql-driver.ts uses neon() internally)
const mockSqlQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => ({
    query: mockSqlQuery,
  })),
}));

// Mock connection-string handler · isolate T2 SQL logic
vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: 'postgresql://mock-user:mock-pass@mock-host.neon.tech/mock-db',
    computeId: 'ep-mock',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

import { handleGetCallingServices } from '../tools/handlers/calling-services';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetCallingServices
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

beforeEach(() => {
  mockSqlQuery.mockReset();
});

describe('handleGetCallingServices · happy path', () => {
  it('returns one row per application aggregated by application_name', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        application_name: 'backend-api',
        connection_count: 15,
        last_active_time: '2026-05-20T07:23:14.000Z',
      },
      {
        application_name: 'analytics-worker',
        connection_count: 8,
        last_active_time: '2026-05-20T06:45:33.000Z',
      },
      {
        application_name: 'cron-aggregator',
        connection_count: 3,
        last_active_time: '2026-05-20T07:00:00.000Z',
      },
    ]);

    const result = await handleGetCallingServices(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      application_name: 'backend-api',
      connection_count: 15,
      endpoint_id: '',
    });
    expect(result[0].last_active_time).toBe('2026-05-20T07:23:14.000Z');
  });

  it('endpoint_id is always empty string day-one (L2b USR ship 后填实 · per §4)', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        application_name: 'backend-api',
        connection_count: 5,
        last_active_time: '2026-05-20T07:23:14.000Z',
      },
    ]);

    const result = await handleGetCallingServices(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(result[0].endpoint_id).toBe('');
  });

  it('NULL application_name renders as "unknown" (COALESCE in SQL)', async () => {
    // The handler delegates COALESCE to SQL · we simulate the SQL behavior here
    // by returning what pg_stat_activity COALESCE'd would give.
    mockSqlQuery.mockResolvedValueOnce([
      {
        application_name: 'unknown',
        connection_count: 2,
        last_active_time: '2026-05-20T07:15:00.000Z',
      },
    ]);

    const result = await handleGetCallingServices(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(result[0].application_name).toBe('unknown');
  });

  it('SQL query includes COALESCE+NULLIF for application_name + GROUP BY + ORDER BY DESC + LIMIT 50', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    await handleGetCallingServices(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(mockSqlQuery).toHaveBeenCalledOnce();
    const [actualSql, actualParams] = mockSqlQuery.mock.calls[0];
    expect(actualSql).toMatch(/COALESCE\(NULLIF\(application_name, ''\), 'unknown'\)/);
    expect(actualSql).toMatch(/FROM pg_stat_activity/);
    expect(actualSql).toMatch(/GROUP BY application_name/);
    expect(actualSql).toMatch(/ORDER BY connection_count DESC/);
    expect(actualSql).toMatch(/LIMIT 50/);
    expect(actualParams).toEqual(['neondb', 1]);
  });

  it('uses provided database name in WHERE datname clause', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    await handleGetCallingServices(
      { projectId: 'proj-abc', databaseName: 'production' },
      mockNeonClient,
      mockExtra,
    );

    const [, actualParams] = mockSqlQuery.mock.calls[0];
    expect(actualParams[0]).toBe('production');
  });
});

describe('handleGetCallingServices · threshold filter', () => {
  it('threshold.min_connections defaults to 1 (skip idle apps with 0 conn)', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);
    await handleGetCallingServices(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );
    const [, actualParams] = mockSqlQuery.mock.calls[0];
    expect(actualParams[1]).toBe(1);
  });

  it('threshold.min_connections=5 passed to SQL HAVING clause', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);
    await handleGetCallingServices(
      {
        projectId: 'proj-abc',
        threshold: { min_connections: 5 },
      },
      mockNeonClient,
      mockExtra,
    );
    const [actualSql, actualParams] = mockSqlQuery.mock.calls[0];
    expect(actualSql).toMatch(/HAVING count\(\*\) >= \$2/);
    expect(actualParams[1]).toBe(5);
  });
});

describe('handleGetCallingServices · empty result handling', () => {
  it('empty pg_stat_activity (no apps · or db filtered out) returns empty array (no throw · per §7 case 3)', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    const result = await handleGetCallingServices(
      { projectId: 'proj-abc', databaseName: 'nonexistent' },
      mockNeonClient,
      mockExtra,
    );

    expect(result).toEqual([]);
  });
});

describe('handleGetCallingServices · SQL injection防护 (LLM01)', () => {
  it('databaseName + min_connections passed as parameterized $1/$2 (never inlined)', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    await handleGetCallingServices(
      {
        projectId: 'proj-abc',
        databaseName: "'; DROP TABLE users; --",
        threshold: { min_connections: 999 },
      },
      mockNeonClient,
      mockExtra,
    );

    const [actualSql, actualParams] = mockSqlQuery.mock.calls[0];
    // Raw SQL string must NOT contain the injection payload (it should be in params)
    expect(actualSql).not.toContain('DROP TABLE');
    expect(actualSql).toMatch(/WHERE datname = \$1/);
    // Params must contain the raw string · pg client / Neon HTTP API escape at protocol boundary
    expect(actualParams[0]).toBe("'; DROP TABLE users; --");
    expect(actualParams[1]).toBe(999);
  });
});

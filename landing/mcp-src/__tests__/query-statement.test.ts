import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @neondatabase/serverless before importing handler
const mockSqlQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => ({
    query: mockSqlQuery,
  })),
}));

// Mock connection-string handler (avoid full Neon API integration · isolate T6 logic)
vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: 'postgresql://mock-user:mock-pass@mock-host/mock-db',
    computeId: 'ep-mock',
  }),
}));

// Mock @sentry/node startSpan (passthrough)
vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

import { handleGetQueryStatement } from '../tools/handlers/query-statement';
import { NotFoundError } from '../server/errors';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetQueryStatement
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

beforeEach(() => {
  mockSqlQuery.mockReset();
});

describe('handleGetQueryStatement · happy path', () => {
  it('returns parameterized SQL row for valid query_signature', async () => {
    // Mock pg_stat_statements extension exists
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    // Mock query row found
    mockSqlQuery.mockResolvedValueOnce([
      {
        query_signature: '12345',
        query:
          'SELECT AVG(amount) FROM sales WHERE sale_date BETWEEN $1 AND $2',
        calls: 1247,
        total_exec_time_ms: 892341.5,
        mean_exec_time_ms: 715.6,
        rows: 1247,
      },
    ]);

    const result = await handleGetQueryStatement(
      { query_signature: '12345', projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(result.query_signature).toBe('12345');
    expect(result.query).toBe(
      'SELECT AVG(amount) FROM sales WHERE sale_date BETWEEN $1 AND $2',
    );
    expect(result.calls).toBe(1247);
    expect(result.total_exec_time_ms).toBe(892341.5);
    expect(result.mean_exec_time_ms).toBe(715.6);
    expect(result.rows).toBe(1247);
  });

  it('OWASP LLM02 防护 · query field contains parameterized SQL ($N) · no raw values', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    mockSqlQuery.mockResolvedValueOnce([
      {
        query_signature: '999',
        query: "SELECT * FROM users WHERE email = $1 AND status = $2",
        calls: 5,
        total_exec_time_ms: 12.3,
        mean_exec_time_ms: 2.5,
        rows: 5,
      },
    ]);

    const result = await handleGetQueryStatement(
      { query_signature: '999', projectId: 'proj-x' },
      mockNeonClient,
      mockExtra,
    );

    // Critical assertion: parameterized form ($N) present
    expect(result.query).toMatch(/\$\d+/);
    // Critical assertion: no email-shaped raw values (no @ + dot pattern in query field)
    expect(result.query).not.toMatch(/[a-zA-Z]+@[a-zA-Z]+\.[a-zA-Z]+/);
  });

  it('executes 2 SQL queries · extension check + pg_stat_statements lookup', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    mockSqlQuery.mockResolvedValueOnce([
      {
        query_signature: '1',
        query: 'SELECT 1',
        calls: 1,
        total_exec_time_ms: 0.1,
        mean_exec_time_ms: 0.1,
        rows: 1,
      },
    ]);

    await handleGetQueryStatement(
      { query_signature: '1', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    expect(mockSqlQuery).toHaveBeenCalledTimes(2);
    expect(mockSqlQuery.mock.calls[0][0]).toContain('pg_extension');
    expect(mockSqlQuery.mock.calls[1][0]).toContain('pg_stat_statements');
    expect(mockSqlQuery.mock.calls[1][1]).toEqual(['1']);
  });
});

describe('handleGetQueryStatement · error paths', () => {
  it('throws NotFoundError with CREATE EXTENSION hint when pg_stat_statements not installed', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: false }]);

    let caught: Error | undefined;
    try {
      await handleGetQueryStatement(
        { query_signature: '1', projectId: 'p' },
        mockNeonClient,
        mockExtra,
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught?.message).toMatch(/CREATE EXTENSION pg_stat_statements/);
  });

  it('throws NotFoundError when query_signature not in pg_stat_statements', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    mockSqlQuery.mockResolvedValueOnce([]); // empty result

    await expect(
      handleGetQueryStatement(
        { query_signature: 'q_nonexistent', projectId: 'p' },
        mockNeonClient,
        mockExtra,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('error message mentions pg_stat_statements eviction (max 5000 default)', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    mockSqlQuery.mockResolvedValueOnce([]);

    await expect(
      handleGetQueryStatement(
        { query_signature: 'q_old', projectId: 'p' },
        mockNeonClient,
        mockExtra,
      ),
    ).rejects.toThrow(/evicted|max = 5000/);
  });
});

describe('handleGetQueryStatement · param forwarding to handleGetConnectionString', () => {
  it('forwards projectId / branchId / databaseName / computeId all to connection-string handler', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    mockSqlQuery.mockResolvedValueOnce([
      {
        query_signature: '1',
        query: 'SELECT 1',
        calls: 1,
        total_exec_time_ms: 0,
        mean_exec_time_ms: 0,
        rows: 0,
      },
    ]);

    const csMod = await import('../tools/handlers/connection-string');
    const csSpy = vi.mocked(csMod.handleGetConnectionString);
    csSpy.mockClear();

    await handleGetQueryStatement(
      {
        query_signature: '1',
        projectId: 'proj-abc',
        branchId: 'br-main-001',
        databaseName: 'mydb',
        computeId: 'ep-prod-001',
      },
      mockNeonClient,
      mockExtra,
    );

    expect(csSpy).toHaveBeenCalledWith(
      {
        projectId: 'proj-abc',
        branchId: 'br-main-001',
        computeId: 'ep-prod-001',
        databaseName: 'mydb',
      },
      mockNeonClient,
      mockExtra,
    );
  });
});

describe('handleGetQueryStatement · numeric type coercion', () => {
  it('coerces stats to numbers (defensive · DB driver may return string for numeric)', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    // Simulate driver returning strings for numeric (some Postgres clients do this)
    mockSqlQuery.mockResolvedValueOnce([
      {
        query_signature: '1',
        query: 'SELECT 1',
        calls: '100',
        total_exec_time_ms: '50.5',
        mean_exec_time_ms: '0.505',
        rows: '100',
      },
    ]);

    const result = await handleGetQueryStatement(
      { query_signature: '1', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    expect(typeof result.calls).toBe('number');
    expect(typeof result.total_exec_time_ms).toBe('number');
    expect(typeof result.mean_exec_time_ms).toBe('number');
    expect(typeof result.rows).toBe('number');
    expect(result.calls).toBe(100);
    expect(result.mean_exec_time_ms).toBeCloseTo(0.505);
  });
});

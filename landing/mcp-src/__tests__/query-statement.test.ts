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

import {
  handleGetQueryStatement,
  truncateSqlForDepth,
} from '../tools/handlers/query-statement';
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

describe('truncateSqlForDepth · 30-line + char-cap truncation (feat-003 #3)', () => {
  it('full depth → SQL unchanged (no marker)', () => {
    const sql = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    expect(truncateSqlForDepth(sql, 'full')).toBe(sql);
  });

  it('shallow · short SQL (≤ 30 lines) → unchanged (no marker)', () => {
    const sql = 'SELECT AVG(amount) FROM sales WHERE sale_date BETWEEN $1 AND $2';
    expect(truncateSqlForDepth(sql, 'shallow')).toBe(sql);
  });

  it('shallow · SQL > 30 lines → first 30 lines + tail marker', () => {
    const sql = Array.from({ length: 50 }, (_, i) => `line_${i}`).join('\n');
    const result = truncateSqlForDepth(sql, 'shallow');
    const lines = result.split('\n');
    // 30 content lines + 1 marker line
    expect(lines).toHaveLength(31);
    expect(lines[29]).toBe('line_29');
    expect(lines[30]).toContain('truncated');
    expect(lines[30]).toContain('depth=full');
    // line_30+ omitted
    expect(result).not.toContain('line_30');
  });

  it('shallow · cuts at line boundary (never mid-line · WHERE clause not split mid-token)', () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      i === 25 ? 'WHERE sale_date BETWEEN $1 AND $2' : `col_${i},`,
    );
    const result = truncateSqlForDepth(lines.join('\n'), 'shallow');
    // The WHERE line (index 25 < 30) is fully present · not split
    expect(result).toContain('WHERE sale_date BETWEEN $1 AND $2');
  });

  it('shallow · pathological single long line → char-capped at whitespace + marker', () => {
    const longLine = 'SELECT ' + 'col, '.repeat(1000) + 'FROM t'; // ~5000 chars · 1 line
    const result = truncateSqlForDepth(longLine, 'shallow');
    expect(result.length).toBeLessThan(longLine.length);
    expect(result).toContain('truncated');
    // Cut at whitespace · last char before marker is not mid-token
    const beforeMarker = result.split('\n')[0];
    expect(beforeMarker.endsWith(',') || beforeMarker.endsWith('col')).toBe(true);
  });

  it('shallow · $1/$2 placeholders preserved in truncated output (OWASP LLM02)', () => {
    const lines = [
      'SELECT * FROM big WHERE a = $1',
      ...Array.from({ length: 40 }, (_, i) => `  AND col_${i} = $${i + 2}`),
    ];
    const result = truncateSqlForDepth(lines.join('\n'), 'shallow');
    expect(result).toContain('$1');
    expect(result).not.toMatch(/= '[^$]/); // no raw values leaked
  });
});

describe('handleGetQueryStatement · depth param (feat-003 #3)', () => {
  const longSql = Array.from(
    { length: 50 },
    (_, i) => `SELECT col_${i} FROM t${i}`,
  ).join('\n');

  function mockLongQueryRow() {
    mockSqlQuery.mockResolvedValueOnce([{ extension_exists: true }]);
    mockSqlQuery.mockResolvedValueOnce([
      {
        query_signature: '999',
        query: longSql,
        calls: 5,
        total_exec_time_ms: 12.3,
        mean_exec_time_ms: 2.5,
        rows: 5,
      },
    ]);
  }

  it('default (no depth) → shallow · long SQL truncated to 30 lines + marker', async () => {
    mockLongQueryRow();
    const result = await handleGetQueryStatement(
      { query_signature: '999', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );
    expect(result.query.split('\n')).toHaveLength(31); // 30 + marker
    expect(result.query).toContain('truncated');
    expect(result.query).not.toContain('col_30');
  });

  it('depth=full → complete SQL (no truncation · no marker)', async () => {
    mockLongQueryRow();
    const result = await handleGetQueryStatement(
      { query_signature: '999', projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    expect(result.query).toBe(longSql);
    expect(result.query).toContain('col_49');
    expect(result.query).not.toContain('truncated');
  });

  it('depth=shallow explicit → same as default (truncated)', async () => {
    mockLongQueryRow();
    const result = await handleGetQueryStatement(
      { query_signature: '999', projectId: 'p', depth: 'shallow' },
      mockNeonClient,
      mockExtra,
    );
    expect(result.query).toContain('truncated');
    expect(result.query).not.toContain('col_30');
  });

  it('invalid depth (e.g. via OAuth-free local-call · skips zod) → fallback shallow (truncated)', async () => {
    mockLongQueryRow();
    const result = await handleGetQueryStatement(
      // 'deep' is not a valid DepthLevel · isValidDepth normalizes to DEFAULT_DEPTH (shallow)
      {
        query_signature: '999',
        projectId: 'p',
        depth: 'deep' as unknown as 'full',
      },
      mockNeonClient,
      mockExtra,
    );
    expect(result.query).toContain('truncated');
    expect(result.query).not.toContain('col_30');
  });
});

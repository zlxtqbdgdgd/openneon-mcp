import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSqlQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => ({
    query: mockSqlQuery,
  })),
}));

vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: 'postgresql://mock-user:mock-pass@mock-host/mock-db',
    computeId: 'ep-mock',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

import { handleGetSchemas, toLikePattern } from '../tools/handlers/schemas';
import { NotFoundError } from '../server/errors';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetSchemas
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

beforeEach(() => {
  mockSqlQuery.mockReset();
});

describe('handleGetSchemas · happy path · sales table 4 columns', () => {
  it('returns 4-column shallow schema for sales table', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'sales',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
      {
        table_name: 'sales',
        column_name: 'product_id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: true,
      },
      {
        table_name: 'sales',
        column_name: 'sale_date',
        data_type: 'timestamp without time zone',
        is_indexed: false,
        is_nullable: true,
      },
      {
        table_name: 'sales',
        column_name: 'amount',
        data_type: 'numeric',
        is_indexed: false,
        is_nullable: true,
      },
    ]);

    const result = await handleGetSchemas(
      { filter: 'sales', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    expect(result.rows).toHaveLength(4);
    expect(result.meta.totalRows).toBe(4);
    expect(result.meta.filter).toBe('sales');
    expect(result.meta.schema).toBe('public'); // default
    expect(result.rows[0]).toEqual({
      table_name: 'sales',
      column_name: 'id',
      data_type: 'integer',
      is_indexed: true,
      is_nullable: false,
    });
  });

  it('correctly identifies sale_date as NOT indexed (sales 剧本核心信号)', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'sales',
        column_name: 'sale_date',
        data_type: 'timestamp without time zone',
        is_indexed: false,
        is_nullable: true,
      },
    ]);

    const result = await handleGetSchemas(
      { filter: 'sales', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    const saleDate = result.rows.find((r) => r.column_name === 'sale_date');
    expect(saleDate?.is_indexed).toBe(false);
  });

  it('uses default schema "public" when not specified', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'users',
        column_name: 'email',
        data_type: 'text',
        is_indexed: true,
        is_nullable: false,
      },
    ]);

    await handleGetSchemas(
      { filter: 'users', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    expect(mockSqlQuery.mock.calls[0][1]).toEqual(['public', 'users']);
  });

  it('uses custom schema when specified', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'orders',
        column_name: 'id',
        data_type: 'bigint',
        is_indexed: true,
        is_nullable: false,
      },
    ]);

    await handleGetSchemas(
      { filter: 'orders', projectId: 'p', schema: 'analytics' },
      mockNeonClient,
      mockExtra,
    );

    expect(mockSqlQuery.mock.calls[0][1]).toEqual(['analytics', 'orders']);
  });
});

describe('handleGetSchemas · narrative #3 防表名字段幻觉 · TDD anti-hallucination foundation', () => {
  it('users table returns ground-truth column "email" NOT脑补的 "email_address"', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'users',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
      {
        table_name: 'users',
        column_name: 'email',
        data_type: 'text',
        is_indexed: true,
        is_nullable: false,
      },
      {
        table_name: 'users',
        column_name: 'created_at',
        data_type: 'timestamp without time zone',
        is_indexed: false,
        is_nullable: false,
      },
    ]);

    const result = await handleGetSchemas(
      { filter: 'users', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    // Ground truth: column is 'email' (not LLM-hallucinated 'email_address')
    const columnNames = result.rows.map((r) => r.column_name);
    expect(columnNames).toContain('email');
    expect(columnNames).not.toContain('email_address'); // 防 LLM 凭表名脑补常见字段名
  });

  it('sales table returns ground-truth column "sale_date" NOT脑补的 "created_at"', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'sales',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
      {
        table_name: 'sales',
        column_name: 'sale_date',
        data_type: 'timestamp without time zone',
        is_indexed: false,
        is_nullable: true,
      },
    ]);

    const result = await handleGetSchemas(
      { filter: 'sales', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    const columnNames = result.rows.map((r) => r.column_name);
    expect(columnNames).toContain('sale_date');
    expect(columnNames).not.toContain('created_at'); // 防 LLM 凭"销售"表名脑补出 created_at
  });
});

describe('handleGetSchemas · error paths', () => {
  it('throws NotFoundError when filter matches no tables', async () => {
    mockSqlQuery.mockResolvedValueOnce([]); // empty result

    let caught: Error | undefined;
    try {
      await handleGetSchemas(
        { filter: 'nonexistent_table', projectId: 'p' },
        mockNeonClient,
        mockExtra,
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught?.message).toMatch(/nonexistent_table/);
    expect(caught?.message).toMatch(/public/); // mentions schema
  });

  it('error mentions custom schema when set', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    let caught: Error | undefined;
    try {
      await handleGetSchemas(
        { filter: 'missing', projectId: 'p', schema: 'analytics' },
        mockNeonClient,
        mockExtra,
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toMatch(/analytics/);
  });
});

describe('handleGetSchemas · type coercion', () => {
  it('coerces is_indexed/is_nullable to booleans (defensive · pg driver may return strings)', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'sales',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: 't', // pg sometimes returns 't'/'f' as boolean
        is_nullable: 'f',
      },
    ]);

    const result = await handleGetSchemas(
      { filter: 'sales', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    expect(typeof result.rows[0].is_indexed).toBe('boolean');
    expect(typeof result.rows[0].is_nullable).toBe('boolean');
  });
});

describe('toLikePattern · wildcard conversion + LIKE escape (feat-004 #2)', () => {
  it('exact name (no wildcard) → identical pattern (LIKE behaves as exact match)', () => {
    expect(toLikePattern('sales')).toBe('sales');
    expect(toLikePattern('users')).toBe('users');
  });

  it('user wildcard * → SQL LIKE %', () => {
    expect(toLikePattern('sales*')).toBe('sales%'); // prefix
    expect(toLikePattern('*sales')).toBe('%sales'); // suffix
    expect(toLikePattern('*sales*')).toBe('%sales%'); // contains
  });

  it('literal LIKE metachars escaped · _ matches literally (not single-char wildcard)', () => {
    expect(toLikePattern('user_data')).toBe('user\\_data');
  });

  it('literal % escaped (not a multi-char wildcard)', () => {
    expect(toLikePattern('100%off')).toBe('100\\%off');
  });

  it('literal backslash escaped first (no double-escape of added escapes)', () => {
    expect(toLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('combined · escapes metachars then converts wildcard', () => {
    // user_* → escape _ → user\_ → convert * → user\_%  (literal underscore THEN prefix wildcard)
    expect(toLikePattern('user_*')).toBe('user\\_%');
  });
});

describe('handleGetSchemas · wildcard filter end-to-end (feat-004 #2)', () => {
  it('prefix wildcard sales* matches multiple tables (sales + sales_archive)', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'sales',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
      {
        table_name: 'sales_archive',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
    ]);

    const result = await handleGetSchemas(
      { filter: 'sales*', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    const tableNames = [...new Set(result.rows.map((r) => r.table_name))];
    expect(tableNames).toEqual(['sales', 'sales_archive']);
    // SQL uses LIKE + the converted pattern (sales% with ESCAPE)
    const sqlString = mockSqlQuery.mock.calls[0][0] as string;
    expect(sqlString).toContain("LIKE $2 ESCAPE '\\'");
    expect(mockSqlQuery.mock.calls[0][1]).toEqual(['public', 'sales%']);
  });

  it('exact filter (no wildcard) still passes a literal LIKE pattern (= exact match)', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'sales',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
    ]);

    await handleGetSchemas(
      { filter: 'sales', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    expect(mockSqlQuery.mock.calls[0][1]).toEqual(['public', 'sales']);
  });

  it('SQL injection攻击 in filter is bound as parameter · not inlined (LLM01防护)', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    try {
      await handleGetSchemas(
        { filter: "sales'; DROP TABLE users; --", projectId: 'p' },
        mockNeonClient,
        mockExtra,
      );
    } catch {
      // empty result → NotFoundError · expected · we only assert the SQL/params shape
    }

    const sqlString = mockSqlQuery.mock.calls[0][0] as string;
    // Raw SQL must NOT contain the injection payload (it's bound to $2)
    expect(sqlString).not.toContain('DROP TABLE');
    // The payload is passed as the bound parameter (pg/Neon escapes at protocol boundary)
    expect(mockSqlQuery.mock.calls[0][1][1]).toBe("sales'; DROP TABLE users; --");
  });

  it('literal underscore filter escaped · matches only literal table (not single-char wildcard)', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'user_data',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
    ]);

    await handleGetSchemas(
      { filter: 'user_data', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    // _ escaped → user\_data → only matches literal underscore, not userXdata
    expect(mockSqlQuery.mock.calls[0][1]).toEqual(['public', 'user\\_data']);
  });

  it('no-match wildcard → NotFoundError with wildcard-aware hint', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    let caught: Error | undefined;
    try {
      await handleGetSchemas(
        { filter: 'nonexistent*', projectId: 'p' },
        mockNeonClient,
        mockExtra,
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught?.message).toMatch(/nonexistent\*/);
    expect(caught?.message).toMatch(/wildcard/);
  });
});

describe('handleGetSchemas · SQL query structure', () => {
  it('queries pg_attribute + pg_index + pg_class + pg_namespace (all 4 catalogs)', async () => {
    mockSqlQuery.mockResolvedValueOnce([
      {
        table_name: 'sales',
        column_name: 'id',
        data_type: 'integer',
        is_indexed: true,
        is_nullable: false,
      },
    ]);

    await handleGetSchemas(
      { filter: 'sales', projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );

    const sqlString = mockSqlQuery.mock.calls[0][0] as string;
    expect(sqlString).toContain('pg_attribute');
    expect(sqlString).toContain('pg_index');
    expect(sqlString).toContain('pg_class');
    expect(sqlString).toContain('pg_namespace');
    // Day-one shallow: 5 字段 (table_name/column_name/data_type/is_indexed/is_nullable · NO INCLUDE/WHERE)
    expect(sqlString).not.toContain('indpred'); // partial index WHERE · feat-004 #4 才加
    expect(sqlString).not.toContain('indkeyinclude'); // INCLUDE column · feat-004 #4 才加
  });
});

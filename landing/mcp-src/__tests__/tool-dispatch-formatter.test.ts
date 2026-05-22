/**
 * Dispatch-layer integration tests for feat-006 #2 · CSV default output.
 *
 * Verifies that T6 (get_neondb_query_statement) and T8 (get_neondb_schemas)
 * dispatch wraps handler results through `formatToolResponse` and honors the
 * `format` param (default 'csv' · opt-in 'json' / 'tsv').
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-006-L1-mcp-server-csv-default-output.html
 *
 * Scope decision (feat-006 #2 PR · 2026-05-21):
 * - T1 (find_neondb_instances) + T2 (get_neondb_calling_services) not yet shipped (feat-001/002 #1)
 *   · their handlers will adopt this same dispatch pattern when they land
 * - Upstream Neon handlers (list_projects / list_slow_queries / etc.) can adopt later when
 *   token pressure surfaces · not gated by day-one ship
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock handlers BEFORE importing NEON_HANDLERS (which imports them)
vi.mock('../tools/handlers/query-statement', () => ({
  handleGetQueryStatement: vi.fn(),
}));
vi.mock('../tools/handlers/schemas', () => ({
  handleGetSchemas: vi.fn(),
}));

import { NEON_HANDLERS } from '../tools/tools';
import { handleGetQueryStatement } from '../tools/handlers/query-statement';
import { handleGetSchemas } from '../tools/handlers/schemas';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockHandleGetQueryStatement = vi.mocked(handleGetQueryStatement);
const mockHandleGetSchemas = vi.mocked(handleGetSchemas);

const mockNeonClient = {} as Parameters<
  (typeof NEON_HANDLERS)['get_neondb_query_statement']
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

beforeEach(() => {
  mockHandleGetQueryStatement.mockReset();
  mockHandleGetSchemas.mockReset();
});

describe('T6 get_neondb_query_statement dispatch · feat-006 #2 CSV default', () => {
  const sampleResult = {
    query_signature: '12345',
    query: 'SELECT AVG(amount) FROM sales WHERE sale_date BETWEEN $1 AND $2',
    calls: 1247,
    total_exec_time_ms: 892341.5,
    mean_exec_time_ms: 715.6,
    rows: 1247,
  };

  it('default (no format param) → CSV format', async () => {
    mockHandleGetQueryStatement.mockResolvedValue(sampleResult);

    const response = await NEON_HANDLERS.get_neondb_query_statement(
      {
        params: { query_signature: '12345', projectId: 'proj-abc' },
      },
      mockNeonClient,
      mockExtra,
    );

    const text = response.content[0].text;
    expect(typeof text).toBe('string');
    // CSV: header + 1 data row · 7 commas per line (7 columns × 8 with trailing newline)
    expect(text).toContain(
      'query_signature,query,calls,total_exec_time_ms,mean_exec_time_ms,rows',
    );
    expect(text).toContain('12345');
    // CSV should NOT contain JSON braces (sanity check)
    expect(text).not.toContain('{');
    expect(text).not.toContain('"query_signature":');
  });

  it('format=json → JSON array (single-obj auto-wrapped to 1-row array per formatter contract)', async () => {
    mockHandleGetQueryStatement.mockResolvedValue(sampleResult);

    const response = await NEON_HANDLERS.get_neondb_query_statement(
      {
        params: {
          query_signature: '12345',
          projectId: 'proj-abc',
          format: 'json',
        },
      },
      mockNeonClient,
      mockExtra,
    );

    const text = response.content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      query_signature: '12345',
      query: sampleResult.query,
      calls: 1247,
    });
  });

  it('format=tsv → tab-separated', async () => {
    mockHandleGetQueryStatement.mockResolvedValue(sampleResult);

    const response = await NEON_HANDLERS.get_neondb_query_statement(
      {
        params: {
          query_signature: '12345',
          projectId: 'proj-abc',
          format: 'tsv',
        },
      },
      mockNeonClient,
      mockExtra,
    );

    const text = response.content[0].text;
    expect(text).toContain('\t');
    expect(text).toContain(
      'query_signature\tquery\tcalls\ttotal_exec_time_ms\tmean_exec_time_ms\trows',
    );
  });

  it('OWASP LLM02 防护 · parameterized SQL ($N placeholders) preserved through CSV serialization', async () => {
    mockHandleGetQueryStatement.mockResolvedValue({
      ...sampleResult,
      query: 'SELECT * FROM users WHERE email = $1 AND status = $2',
    });

    const response = await NEON_HANDLERS.get_neondb_query_statement(
      {
        params: { query_signature: '999', projectId: 'proj-abc' },
      },
      mockNeonClient,
      mockExtra,
    );

    const text = response.content[0].text;
    expect(text).toContain('$1');
    expect(text).toContain('$2');
    // No raw email values like 'user@example.com' should leak (handler guarantee · re-verified through dispatch)
    expect(text).not.toMatch(/@\w+\.\w+/);
  });
});

describe('T8 get_neondb_schemas dispatch · feat-006 #2 CSV default', () => {
  const sampleResult = {
    rows: [
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
      {
        table_name: 'sales',
        column_name: 'amount',
        data_type: 'numeric',
        is_indexed: false,
        is_nullable: true,
      },
    ],
    meta: {
      filter: 'sales',
      schema: 'public',
      depth: 'shallow' as const,
      totalRows: 3,
    },
  };

  it('default (no format param) → CSV format · rows array · meta dropped (derivable per detail design §4)', async () => {
    mockHandleGetSchemas.mockResolvedValue(sampleResult);

    const response = await NEON_HANDLERS.get_neondb_schemas(
      {
        params: { filter: 'sales', projectId: 'proj-abc', schema: 'public' },
      },
      mockNeonClient,
      mockExtra,
    );

    const text = response.content[0].text;
    expect(text).toContain(
      'table_name,column_name,data_type,is_indexed,is_nullable',
    );
    // 3 data rows
    expect(text.match(/sales,/g)).toHaveLength(3);
    expect(text).toContain('sale_date');
    expect(text).toContain('amount');
    // meta intentionally dropped · totalRows derivable from rows.length, filter/schema from args
    expect(text).not.toContain('totalRows');
    expect(text).not.toContain('"filter"');
  });

  it('format=json → JSON array of row objects (meta dropped · per detail design §4 [{}, {}, ...])', async () => {
    mockHandleGetSchemas.mockResolvedValue(sampleResult);

    const response = await NEON_HANDLERS.get_neondb_schemas(
      {
        params: { filter: 'sales', projectId: 'proj-abc', schema: 'public', format: 'json' },
      },
      mockNeonClient,
      mockExtra,
    );

    const text = response.content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      table_name: 'sales',
      column_name: 'id',
      is_indexed: true,
    });
    // meta NOT present at top level (formatter outputs rows, not {rows, meta})
    expect(parsed).not.toHaveProperty('meta');
  });

  it('anti-hallucination invariant · CSV preserves real column names (e.g. sale_date) · agent sees ground truth not guess', async () => {
    mockHandleGetSchemas.mockResolvedValue(sampleResult);

    const response = await NEON_HANDLERS.get_neondb_schemas(
      {
        params: { filter: 'sales', projectId: 'proj-abc', schema: 'public' },
      },
      mockNeonClient,
      mockExtra,
    );

    const text = response.content[0].text;
    expect(text).toContain('sale_date');
    // Agent would commonly hallucinate 'created_at' for sales tables · verify the real column wins
    expect(text).not.toContain('created_at');
  });

  it('token economy invariant · CSV strictly shorter than JSON for same data (feat-006 §5 ≥ 8× target)', async () => {
    mockHandleGetSchemas.mockResolvedValue(sampleResult);

    const csvResponse = await NEON_HANDLERS.get_neondb_schemas(
      {
        params: { filter: 'sales', projectId: 'proj-abc', schema: 'public' },
      },
      mockNeonClient,
      mockExtra,
    );
    const jsonResponse = await NEON_HANDLERS.get_neondb_schemas(
      {
        params: { filter: 'sales', projectId: 'proj-abc', schema: 'public', format: 'json' },
      },
      mockNeonClient,
      mockExtra,
    );

    const csvLen = csvResponse.content[0].text.length;
    const jsonLen = jsonResponse.content[0].text.length;
    // 3-row sample is small · 8× ratio not yet hit (CSV header overhead amortizes only at scale)
    // But CSV MUST be at least 2× shorter even at this size (compression real)
    expect(csvLen).toBeLessThan(jsonLen / 2);
  });
});

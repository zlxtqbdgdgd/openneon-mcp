/**
 * T5 get_neondb_query_performance handler unit tests · feat-021 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-021-L2-mcp-tool-t5-query-performance.html
 *
 * Covers: cumulative top-N ranking (rank_by → column), deterministic profile derivation
 * (frequent-but-fast NOT mislabeled slow-per-call), partial visibility marker, stats_since,
 * progressive depth, and SQL-injection防护 (rank_by whitelist · parameterized LIMIT).
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

import {
  handleGetQueryPerformance,
  deriveProfile,
} from '../tools/handlers/query-performance';
import { getNeondbQueryPerformanceInputSchema } from '../tools/toolsSchema';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetQueryPerformance
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

// Helper: wire the 4 sequential queries the handler runs (ext check → visibility → stats_info → rows).
function wireQueries(opts: {
  extExists?: boolean;
  hasReadAll?: boolean;
  statsReset?: string | null;
  rows?: Array<Record<string, unknown>>;
}) {
  mockSqlQuery.mockReset();
  mockSqlQuery.mockResolvedValueOnce([
    { extension_exists: opts.extExists ?? true },
  ]);
  mockSqlQuery.mockResolvedValueOnce([
    { has_read_all: opts.hasReadAll ?? true },
  ]);
  mockSqlQuery.mockResolvedValueOnce(
    opts.statsReset === undefined
      ? [{ stats_reset: '2026-05-01T00:00:00.000Z' }]
      : [{ stats_reset: opts.statsReset }],
  );
  mockSqlQuery.mockResolvedValueOnce(opts.rows ?? []);
}

beforeEach(() => {
  mockSqlQuery.mockReset();
});

describe('deriveProfile · deterministic tags (no LLM)', () => {
  it('frequent-but-fast query → high-frequency, NOT slow-per-call', () => {
    const tags = deriveProfile({
      calls: 50000,
      mean_exec_time: 2,
      shared_blks_read: 0,
    });
    expect(tags).toContain('high-frequency');
    expect(tags).not.toContain('slow-per-call');
  });

  it('high mean → slow-per-call', () => {
    const tags = deriveProfile({
      calls: 10,
      mean_exec_time: 780,
      shared_blks_read: 0,
    });
    expect(tags).toContain('slow-per-call');
  });

  it('high shared_blks_read per call → io-heavy', () => {
    const tags = deriveProfile({
      calls: 10,
      mean_exec_time: 5,
      shared_blks_read: 50000, // 5000 blocks/call
    });
    expect(tags).toContain('io-heavy');
  });

  it('slow AND io-heavy can both apply', () => {
    const tags = deriveProfile({
      calls: 1200,
      mean_exec_time: 780,
      shared_blks_read: 6_000_000, // 5000 blocks/call
    });
    expect(tags).toEqual(
      expect.arrayContaining(['slow-per-call', 'io-heavy']),
    );
  });
});

describe('handleGetQueryPerformance · ranking + rows', () => {
  it('returns top-N rows with profile derived per row', async () => {
    wireQueries({
      rows: [
        {
          queryid: '111',
          query: 'SELECT * FROM sales WHERE sale_date > $1',
          calls: 1200,
          mean_exec_time: 780,
          total_exec_time: 936000,
          rows: 1200,
          shared_blks_read: 6_000_000,
        },
      ],
    });

    const result = await handleGetQueryPerformance(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );

    expect(result.queries).toHaveLength(1);
    expect(result.queries[0].queryid).toBe('111');
    expect(result.queries[0].profile).toContain('slow-per-call');
  });

  it('rank_by=io maps to shared_blks_read column in ORDER BY', async () => {
    wireQueries({ rows: [] });
    await handleGetQueryPerformance(
      { projectId: 'proj-abc', rank_by: 'io' },
      mockNeonClient,
      mockExtra,
    );
    const rankSql = mockSqlQuery.mock.calls[3][0];
    expect(rankSql).toMatch(/ORDER BY shared_blks_read DESC/);
  });

  it('default rank_by=total_exec_time', async () => {
    wireQueries({ rows: [] });
    await handleGetQueryPerformance(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );
    const rankSql = mockSqlQuery.mock.calls[3][0];
    expect(rankSql).toMatch(/ORDER BY total_exec_time DESC/);
  });

  it('limit is parameterized ($1) and clamped to [1,100]', async () => {
    wireQueries({ rows: [] });
    await handleGetQueryPerformance(
      { projectId: 'proj-abc', limit: 9999 },
      mockNeonClient,
      mockExtra,
    );
    const [rankSql, params] = mockSqlQuery.mock.calls[3];
    expect(rankSql).toMatch(/LIMIT \$1/);
    expect(params).toEqual([100]); // clamped
  });
});

describe('handleGetQueryPerformance · honesty (visibility + stats_since)', () => {
  it('role lacking pg_read_all_stats → visibility=partial', async () => {
    wireQueries({ hasReadAll: false, rows: [] });
    const result = await handleGetQueryPerformance(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );
    expect(result.visibility).toBe('partial');
  });

  it('role with pg_read_all_stats → visibility=full', async () => {
    wireQueries({ hasReadAll: true, rows: [] });
    const result = await handleGetQueryPerformance(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );
    expect(result.visibility).toBe('full');
  });

  it('stats_since reflects pg_stat_statements_info.stats_reset', async () => {
    wireQueries({ statsReset: '2026-05-10T12:00:00.000Z', rows: [] });
    const result = await handleGetQueryPerformance(
      { projectId: 'proj-abc' },
      mockNeonClient,
      mockExtra,
    );
    expect(result.stats_since).toBe('2026-05-10T12:00:00.000Z');
  });

  it('throws NotFoundError when pg_stat_statements is not installed', async () => {
    wireQueries({ extExists: false });
    await expect(
      handleGetQueryPerformance({ projectId: 'proj-abc' }, mockNeonClient, mockExtra),
    ).rejects.toThrow(/pg_stat_statements/);
  });
});

describe('handleGetQueryPerformance · progressive depth', () => {
  it('shallow truncates a >30-line query and appends the tail marker', async () => {
    const longQuery = Array.from({ length: 60 }, (_, i) => `line_${i}`).join('\n');
    wireQueries({
      rows: [
        {
          queryid: '1',
          query: longQuery,
          calls: 1,
          mean_exec_time: 1,
          total_exec_time: 1,
          rows: 1,
          shared_blks_read: 0,
        },
      ],
    });
    const result = await handleGetQueryPerformance(
      { projectId: 'proj-abc' }, // default shallow
      mockNeonClient,
      mockExtra,
    );
    expect(result.queries[0].query).toContain('depth=full');
    expect(result.queries[0].query.split('\n').length).toBeLessThan(60);
  });

  it('full returns the complete query text', async () => {
    const longQuery = Array.from({ length: 60 }, (_, i) => `line_${i}`).join('\n');
    wireQueries({
      rows: [
        {
          queryid: '1',
          query: longQuery,
          calls: 1,
          mean_exec_time: 1,
          total_exec_time: 1,
          rows: 1,
          shared_blks_read: 0,
        },
      ],
    });
    const result = await handleGetQueryPerformance(
      { projectId: 'proj-abc', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    expect(result.queries[0].query).toBe(longQuery);
  });
});

describe('getNeondbQueryPerformanceInputSchema · validation', () => {
  it('rejects missing projectId', () => {
    expect(
      getNeondbQueryPerformanceInputSchema.safeParse({}).success,
    ).toBe(false);
  });

  it('rejects an unknown rank_by (whitelist enum)', () => {
    expect(
      getNeondbQueryPerformanceInputSchema.safeParse({
        projectId: 'p',
        rank_by: 'shared_blks_read; DROP TABLE x',
      }).success,
    ).toBe(false);
  });

  it('accepts projectId + valid rank_by + limit', () => {
    expect(
      getNeondbQueryPerformanceInputSchema.safeParse({
        projectId: 'p',
        rank_by: 'mean_exec_time',
        limit: 5,
      }).success,
    ).toBe(true);
  });
});

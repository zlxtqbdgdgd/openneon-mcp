/**
 * feat-021 · T5 query-performance 端到端验证 (real neon_local · pg_stat_statements · pg TCP)。
 *
 * Gated on NEON_LOCAL_URL · 无 neon_local 时 skip。在 dev server 上跑:
 *   NEON_LOCAL_URL='postgres://cloud_admin:cloud_admin@127.0.0.1:55432/neondb' npm run test:e2e:mcp
 *
 * 造已知工作负载验证排序 + 画像不误导: 频繁但快的 query (calls 巨大 · mean 低) → high-frequency
 * 且 **不** 误标 slow-per-call (详设 §7 核心 AC)。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const NEON_LOCAL_URL = process.env.NEON_LOCAL_URL;

vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: NEON_LOCAL_URL,
    computeId: 'ep-local',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
}));

import { createSqlClient } from '../tools/handlers/sql-driver';
import { handleGetQueryPerformance } from '../tools/handlers/query-performance';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetQueryPerformance
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

const FREQUENT_CALLS = 1200; // > HIGH_FREQUENCY_CALLS (1000)

describe.skipIf(!NEON_LOCAL_URL)(
  'feat-021 T5 query performance · neon_local e2e (pg TCP)',
  () => {
    beforeAll(async () => {
      const client = await createSqlClient(NEON_LOCAL_URL as string);
      try {
        // Best-effort reset so our workload dominates the top-N (needs superuser · cloud_admin has it).
        try {
          await client.query('SELECT pg_stat_statements_reset()');
        } catch {
          // ignore · cumulative history still contains our workload below
        }
        // Frequent-but-fast workload · normalizes to `SELECT $1::int` → one pgss entry, high calls.
        for (let i = 0; i < FREQUENT_CALLS; i++) {
          await client.query('SELECT $1::int', [i]);
        }
      } finally {
        await client.release();
      }
    });

    it('frequent-but-fast query → high-frequency, NOT slow-per-call (画像不误导)', async () => {
      const result = await handleGetQueryPerformance(
        { projectId: 'x', rank_by: 'calls', limit: 50 },
        mockNeonClient,
        mockExtra,
      );

      const frequent = result.queries.find(
        (q) => q.calls >= 1000 && q.mean_exec_time < 100,
      );
      expect(frequent).toBeDefined();
      expect(frequent?.profile).toContain('high-frequency');
      expect(frequent?.profile).not.toContain('slow-per-call');
    });

    it('returns visibility + stats_since metadata', async () => {
      const result = await handleGetQueryPerformance(
        { projectId: 'x', limit: 5 },
        mockNeonClient,
        mockExtra,
      );
      expect(['full', 'partial']).toContain(result.visibility);
      // cloud_admin is superuser → full visibility on the dev server.
      expect(result.visibility).toBe('full');
      // stats_reset is set after pg_stat_statements_reset().
      expect(result.stats_since).not.toBeNull();
    });

    it('query text is normalized ($N placeholders · no literal leak)', async () => {
      const result = await handleGetQueryPerformance(
        { projectId: 'x', rank_by: 'calls', limit: 50, depth: 'full' },
        mockNeonClient,
        mockExtra,
      );
      const frequent = result.queries.find((q) => q.calls >= 1000);
      expect(frequent?.query).toMatch(/\$1/);
    });
  },
);

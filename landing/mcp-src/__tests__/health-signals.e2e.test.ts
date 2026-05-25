/**
 * feat-020/#1 · T4 health-signals 端到端验证 (real neon_local · 自托管 PostgreSQL · pg TCP)。
 *
 * Gated on NEON_LOCAL_URL · 无 neon_local 时 skip。在 dev server 上跑:
 *   NEON_LOCAL_URL='postgres://cloud_admin:cloud_admin@127.0.0.1:55432/neondb' npm run test:e2e:mcp
 *
 * 验证 connections 信号的 currentValueSql 对真实 pg_stat_activity 取值正确 · status='ok'。
 * connection-string 被 mock 成 NEON_LOCAL_URL → createSqlClient 走 pg TCP 直连 neon_local。
 */
import { describe, it, expect, vi } from 'vitest';

const NEON_LOCAL_URL = process.env.NEON_LOCAL_URL;

// NOTE: vi.mock is hoisted above module-level consts · reference process.env directly inside the
// factory (never the outer NEON_LOCAL_URL const · that would be a TDZ ReferenceError at hoist time).
vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: process.env.NEON_LOCAL_URL,
    computeId: 'ep-local',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
}));

import { handleGetHealthSignals } from '../tools/handlers/health-signals';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetHealthSignals
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

describe.skipIf(!NEON_LOCAL_URL)(
  'feat-020/#1 T4 health signals · neon_local e2e (pg TCP)',
  () => {
    it('connections signal reads a real, non-negative count from pg_stat_activity', async () => {
      const result = await handleGetHealthSignals(
        { projectId: 'x', depth: 'full' },
        mockNeonClient,
        mockExtra,
      );

      const connections = result.find((s) => s.signal_type === 'connections');
      expect(connections).toBeDefined();
      expect(connections?.status).toBe('ok');
      expect(typeof connections?.value).toBe('number');
      // This test session holds at least one connection.
      expect(connections?.value as number).toBeGreaterThanOrEqual(1);
    });

    it('cache_hit_ratio reads a real ratio in [0,1] from pg_stat_database', async () => {
      const result = await handleGetHealthSignals(
        { projectId: 'x', depth: 'full' },
        mockNeonClient,
        mockExtra,
      );
      const chr = result.find((s) => s.signal_type === 'cache_hit_ratio');
      expect(chr?.status).toBe('ok');
      expect(chr?.value as number).toBeGreaterThanOrEqual(0);
      expect(chr?.value as number).toBeLessThanOrEqual(1);
    });

    it('storage_size returns a real size · NOT baselined (no robust_z · 不误报 high)', async () => {
      const result = await handleGetHealthSignals(
        { projectId: 'x', depth: 'full' },
        mockNeonClient,
        mockExtra,
      );
      const storage = result.find((s) => s.signal_type === 'storage_size_bytes');
      expect(storage?.status).toBe('ok');
      expect(storage?.value as number).toBeGreaterThan(0);
      expect(storage?.robust_z).toBeUndefined();
    });

    it('graceful degradation: neon ext absent → lfc_hit_rate unavailable · single-node → replication unavailable', async () => {
      const result = await handleGetHealthSignals(
        { projectId: 'x', depth: 'full' },
        mockNeonClient,
        mockExtra,
      );
      // dev server has no `neon` extension → LFC blind, but the call still succeeds.
      expect(result.find((s) => s.signal_type === 'lfc_hit_rate')?.status).toBe(
        'unavailable',
      );
      // neon_local is single-node → no replica → replication lag unavailable (honest, not 0).
      expect(
        result.find((s) => s.signal_type === 'replication_lag_seconds')?.status,
      ).toBe('unavailable');
    });
  },
);

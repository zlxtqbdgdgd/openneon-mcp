/**
 * feat-030/#80 · Neon Cloud HTTP 路径 timeout 注入 + CONCURRENTLY 死角 (unit-only)。
 *
 * day-one 无 Neon Cloud · neon_local 走 pg TCP (#79 已 e2e) · 此 HTTP 路径无法 e2e
 * (类比 feat-063 deferred 的 management-API e2e) → mock `neon()` 的 query / transaction 验证:
 * - 非 CONCURRENTLY 写 + timeouts → transaction(["SET LOCAL lock", "SET LOCAL stmt", sql])
 * - CONCURRENTLY + timeouts → 裸 query (不包事务 · 不触发 "cannot run inside a transaction block")
 * - 无 timeouts → 裸 query (回归)
 *
 * 注: HTTP 路径要求 URI 非 local (hostname 非 127.0.0.1/localhost · 非 NEON_LOCAL_URL) ·
 * 用 *.neon.tech URI 触发 neon() 分支。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// hoisted mock: neon(uri) → 同一个 neonSql (callable + .query + .transaction)
const { mockQuery, mockTransaction, mockNeon } = vi.hoisted(() => {
  const mockQuery = vi.fn((sql: string, params?: unknown) => ({ sql, params }));
  const mockTransaction = vi.fn(
    async (queries: Array<{ sql: string; params?: unknown }>) =>
      // 每条语句一份结果 · 实际 SQL (末条) 回一行,SET LOCAL 回空
      queries.map((q, i) =>
        i === queries.length - 1 ? [{ ok: q.sql }] : [],
      ),
  );
  const neonSql = Object.assign(() => undefined, {
    query: mockQuery,
    transaction: mockTransaction,
  });
  return { mockQuery, mockTransaction, mockNeon: vi.fn(() => neonSql) };
});

vi.mock('@neondatabase/serverless', () => ({ neon: mockNeon }));

import { createSqlClient } from '../tools/handlers/sql-driver';

const CLOUD_URI = 'postgres://u:p@ep-cool-darkness-123.us-east-2.aws.neon.tech/neondb';

describe('createSqlClient · Neon Cloud HTTP timeout 注入 (feat-030/#80)', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockTransaction.mockClear();
    mockNeon.mockClear();
    delete process.env.NEON_LOCAL_URL; // 确保走 HTTP 分支 (URI 非 local)
  });

  it('非 CONCURRENTLY 写 + timeouts → transaction([SET LOCAL lock, SET LOCAL stmt, sql])', async () => {
    const client = await createSqlClient(CLOUD_URI, {
      lock_timeout: '30s',
      statement_timeout: '5min',
    });
    await client.query('ALTER TABLE sales ADD COLUMN region text');

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const batch = mockTransaction.mock.calls[0][0];
    expect(batch.map((q) => q.sql)).toEqual([
      "SET LOCAL lock_timeout = '30s'",
      "SET LOCAL statement_timeout = '5min'",
      'ALTER TABLE sales ADD COLUMN region text',
    ]);
  });

  it('返回 transaction 末条结果 (= 实际 SQL · 非 SET LOCAL 的空结果)', async () => {
    const client = await createSqlClient(CLOUD_URI, {
      lock_timeout: '30s',
      statement_timeout: '5min',
    });
    const rows = await client.query('DELETE FROM sales WHERE id < 100');
    expect(rows).toEqual([{ ok: 'DELETE FROM sales WHERE id < 100' }]);
  });

  it('仅 lock_timeout (CONCURRENTLY 档) 的非并发写 → transaction 只含 1 条 SET LOCAL', async () => {
    const client = await createSqlClient(CLOUD_URI, { lock_timeout: '30s' });
    await client.query('UPDATE sales SET x = 1');
    const batch = mockTransaction.mock.calls[0][0];
    expect(batch.map((q) => q.sql)).toEqual([
      "SET LOCAL lock_timeout = '30s'",
      'UPDATE sales SET x = 1',
    ]);
  });

  it('CONCURRENTLY + timeouts → 裸 query (不包事务 · 避免 "cannot run inside a transaction block")', async () => {
    const client = await createSqlClient(CLOUD_URI, { lock_timeout: '30s' });
    await client.query('CREATE INDEX CONCURRENTLY idx ON sales(sale_date)');

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      'CREATE INDEX CONCURRENTLY idx ON sales(sale_date)',
      [],
    );
  });

  it('DROP INDEX CONCURRENTLY 也走裸 query (CONCURRENTLY 通用判定)', async () => {
    const client = await createSqlClient(CLOUD_URI, { lock_timeout: '30s' });
    await client.query('DROP INDEX CONCURRENTLY idx');
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('无 timeouts → 裸 query (回归 · 不包事务)', async () => {
    const client = await createSqlClient(CLOUD_URI);
    await client.query('SELECT 1');
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith('SELECT 1', []);
  });

  it('非法 timeout 值 → 拒绝注入抛错 (防 SQL 注入白名单 · 不发请求)', async () => {
    const client = await createSqlClient(CLOUD_URI, {
      lock_timeout: "30s'; DROP TABLE x; --",
    });
    await expect(client.query('UPDATE sales SET x = 1')).rejects.toThrow(
      /非法 lock_timeout/,
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

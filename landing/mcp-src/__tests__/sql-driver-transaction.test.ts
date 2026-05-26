/**
 * issue #98 · SqlClient.transaction(sqls, opts?) · 两条路径的原子事务语义。
 *
 * - Neon HTTP path: 委托 neonSql.transaction([...], { readOnly? })。
 * - pg TCP path:    BEGIN [READ ONLY] / 每条 SQL / COMMIT · 任意失败 ROLLBACK 后抛。
 *
 * 由 5 个 upstream tool (run_sql / run_sql_transaction / get_database_tables /
 * list_slow_queries / describe_branch) 从直 neon(uri) 切到 createSqlClient 引入 ·
 * 旧 sql-driver-http-timeout.test.ts 只覆盖 query() · 此 file 覆盖 transaction() 新方法。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockNeonQuery, mockNeonTransaction, mockNeon } = vi.hoisted(() => {
  const mockNeonQuery = vi.fn((sql: string, params?: unknown) => ({ sql, params }));
  const mockNeonTransaction = vi.fn(
    async (queries: Array<{ sql: string; params?: unknown }>) =>
      queries.map((q) => [{ sql: q.sql }]),
  );
  const neonSql = Object.assign(() => undefined, {
    query: mockNeonQuery,
    transaction: mockNeonTransaction,
  });
  return { mockNeonQuery, mockNeonTransaction, mockNeon: vi.fn(() => neonSql) };
});

const { mockPgClientQuery, mockPgClientConnect, mockPgClientEnd, MockPgClient } =
  vi.hoisted(() => {
    const mockPgClientQuery = vi.fn();
    const mockPgClientConnect = vi.fn(async () => undefined);
    const mockPgClientEnd = vi.fn(async () => undefined);
    class MockPgClient {
      constructor(public opts: unknown) {}
      connect = mockPgClientConnect;
      query = mockPgClientQuery;
      end = mockPgClientEnd;
    }
    return { mockPgClientQuery, mockPgClientConnect, mockPgClientEnd, MockPgClient };
  });

vi.mock('@neondatabase/serverless', () => ({ neon: mockNeon }));
vi.mock('pg', () => ({ default: { Client: MockPgClient } }));

import { createSqlClient } from '../tools/handlers/sql-driver';

const CLOUD_URI = 'postgres://u:p@ep-cool.us-east-2.aws.neon.tech/neondb';
const LOCAL_URI = 'postgres://cloud_admin:cloud_admin@127.0.0.1:55432/neondb';

describe('SqlClient.transaction · Neon HTTP path (issue #98)', () => {
  beforeEach(() => {
    mockNeonQuery.mockClear();
    mockNeonTransaction.mockClear();
    mockNeon.mockClear();
    delete process.env.NEON_LOCAL_URL;
  });

  it('委托 neonSql.transaction · readOnly undefined → 不传 opts', async () => {
    const client = await createSqlClient(CLOUD_URI);
    const result = await client.transaction(['SELECT 1', 'SELECT 2']);

    expect(mockNeonTransaction).toHaveBeenCalledTimes(1);
    const [batch, opts] = mockNeonTransaction.mock.calls[0];
    expect((batch as Array<{ sql: string }>).map((q) => q.sql)).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
    expect(opts).toBeUndefined();
    expect(result).toEqual([[{ sql: 'SELECT 1' }], [{ sql: 'SELECT 2' }]]);
  });

  it('readOnly: true → 传 { readOnly: true } 给 neonSql.transaction', async () => {
    const client = await createSqlClient(CLOUD_URI);
    await client.transaction(['SELECT 1'], { readOnly: true });

    const opts = mockNeonTransaction.mock.calls[0][1];
    expect(opts).toEqual({ readOnly: true });
  });

  it('readOnly: false → 不传 opts (避免 Neon HTTP 把 readOnly:false 当成显式声明)', async () => {
    const client = await createSqlClient(CLOUD_URI);
    await client.transaction(['INSERT INTO t VALUES (1)'], { readOnly: false });

    const opts = mockNeonTransaction.mock.calls[0][1];
    expect(opts).toBeUndefined();
  });

  it('release 是 no-op (HTTP stateless)', async () => {
    const client = await createSqlClient(CLOUD_URI);
    await expect(client.release()).resolves.toBeUndefined();
  });
});

describe('SqlClient.transaction · pg TCP path (issue #98)', () => {
  beforeEach(() => {
    mockPgClientQuery.mockReset();
    mockPgClientConnect.mockClear();
    mockPgClientEnd.mockClear();
    mockPgClientQuery.mockImplementation(async (sql: string) => ({
      rows: [{ sql }],
    }));
    process.env.NEON_LOCAL_URL = LOCAL_URI;
  });

  it('BEGIN → 每条 SQL → COMMIT · 返回每条 rows 数组', async () => {
    const client = await createSqlClient(LOCAL_URI);
    const result = await client.transaction(['SELECT 1', 'SELECT 2']);

    const sqls = mockPgClientQuery.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT']);
    expect(result).toEqual([[{ sql: 'SELECT 1' }], [{ sql: 'SELECT 2' }]]);
  });

  it('readOnly: true → BEGIN TRANSACTION READ ONLY · COMMIT', async () => {
    const client = await createSqlClient(LOCAL_URI);
    await client.transaction(['SELECT 1'], { readOnly: true });

    const sqls = mockPgClientQuery.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(['BEGIN TRANSACTION READ ONLY', 'SELECT 1', 'COMMIT']);
  });

  it('SQL 抛错 → ROLLBACK + 抛 · 不进 COMMIT', async () => {
    const boom = new Error('relation t does not exist');
    mockPgClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT 1') {
        return { rows: [{ sql }] };
      }
      if (sql === 'SELECT bad') {
        throw boom;
      }
      return { rows: [] };
    });
    const client = await createSqlClient(LOCAL_URI);

    await expect(
      client.transaction(['SELECT 1', 'SELECT bad', 'SELECT skip']),
    ).rejects.toBe(boom);

    const sqls = mockPgClientQuery.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(['BEGIN', 'SELECT 1', 'SELECT bad', 'ROLLBACK']);
    expect(sqls).not.toContain('SELECT skip');
    expect(sqls).not.toContain('COMMIT');
  });

  it('ROLLBACK 本身失败 · 仍抛原 SQL 错 (不掩盖根因)', async () => {
    const boom = new Error('original');
    const rollbackBoom = new Error('rollback failed');
    mockPgClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT bad') throw boom;
      if (sql === 'ROLLBACK') throw rollbackBoom;
      return { rows: [] };
    });
    const client = await createSqlClient(LOCAL_URI);

    await expect(client.transaction(['SELECT bad'])).rejects.toBe(boom);
  });

  it('release 关闭 pg.Client (end)', async () => {
    const client = await createSqlClient(LOCAL_URI);
    await client.release();
    expect(mockPgClientEnd).toHaveBeenCalledTimes(1);
  });
});

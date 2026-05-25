/**
 * feat-019/#1 · explain gate 端到端验证 (real neon_local · 自托管 PostgreSQL · pg TCP)。
 *
 * Gated on NEON_LOCAL_URL · 无 neon_local 时 skip。在 dev server 上跑:
 *   NEON_LOCAL_URL='postgres://cloud_admin:cloud_admin@127.0.0.1:55432/neondb' npm run test:e2e:mcp
 *
 * 核心安全断言 (详设 §7 · AC): DML explain 强制 analyze=false → 纯 EXPLAIN 估算 · **数据零改动**。
 *
 * 注: 真上游 handleExplainSqlStatement 需 Neon API 取连接串 (neon_local 无 project) · 故这里注入一个
 * 镜像上游 EXPLAIN prefix 的 runner · 直连 neon_local (pg TCP) 跑 EXPLAIN —— 验证的是
 * handleExplainPlans 的 gate 行为 + "非 ANALYZE 的 EXPLAIN <DML> 不执行" 这一真实 PG 性质。
 */
import { describe, it, expect } from 'vitest';
import { createSqlClient, type SqlClient } from '../tools/handlers/sql-driver';
import {
  handleExplainPlans,
  type ExplainRunner,
} from '../tools/handlers/explain-plans';

const NEON_LOCAL_URL = process.env.NEON_LOCAL_URL;
const TBL = `feat019_e2e_${process.pid}`;

// 镜像上游 handleExplainSqlStatement 的 prefix · 直连 neon_local 跑 EXPLAIN
function neonLocalRunner(client: SqlClient, sql: string): ExplainRunner {
  return async (analyze) => {
    const prefix = analyze
      ? 'EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT JSON)'
      : 'EXPLAIN (VERBOSE, FORMAT JSON)';
    const rows = await client.query(`${prefix} ${sql}`);
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  };
}

describe.skipIf(!NEON_LOCAL_URL)(
  'feat-019/#1 explain gate · neon_local e2e (pg TCP)',
  () => {
    it('AC: DML explain 强制 analyze=false · 数据零改动', async () => {
      const client = await createSqlClient(NEON_LOCAL_URL as string);
      try {
        await client.query(`DROP TABLE IF EXISTS ${TBL}`);
        await client.query(`CREATE TABLE ${TBL} (id int)`);
        await client.query(`INSERT INTO ${TBL}(id) VALUES (1),(2),(3)`);

        const sql = `DELETE FROM ${TBL} WHERE id < 100`;
        const result = await handleExplainPlans(
          { sql, projectId: 'x', analyze: true },
          neonLocalRunner(client, sql),
        );

        // gate: DML → analyze 被强制 false · annotation 诚实标 destructive
        expect(result.analyzed).toBe(false);
        expect(result.downgraded).toBe(true);
        expect(result.annotation.destructiveHint).toBe(true);

        // 关键: 纯 EXPLAIN (非 ANALYZE) 不执行 DELETE → 3 行还在
        const rows = await client.query(`SELECT count(*)::int AS n FROM ${TBL}`);
        expect(rows[0]?.n).toBe(3);
      } finally {
        try {
          await client.query(`DROP TABLE IF EXISTS ${TBL}`);
        } catch {
          // best-effort cleanup
        }
        await client.release();
      }
    });

    it('SELECT explain → analyze 真跑 · plan 非空 · annotation readOnly', async () => {
      const client = await createSqlClient(NEON_LOCAL_URL as string);
      try {
        await client.query(`DROP TABLE IF EXISTS ${TBL}`);
        await client.query(`CREATE TABLE ${TBL} (id int)`);
        await client.query(`INSERT INTO ${TBL}(id) VALUES (1),(2)`);

        const sql = `SELECT count(*) FROM ${TBL}`;
        const result = await handleExplainPlans(
          { sql, projectId: 'x', analyze: true },
          neonLocalRunner(client, sql),
        );

        expect(result.analyzed).toBe(true);
        expect(result.downgraded).toBe(false);
        expect(result.annotation.readOnlyHint).toBe(true);
        expect(result.plan).toBeTruthy();
      } finally {
        try {
          await client.query(`DROP TABLE IF EXISTS ${TBL}`);
        } catch {
          // best-effort cleanup
        }
        await client.release();
      }
    });
  },
);

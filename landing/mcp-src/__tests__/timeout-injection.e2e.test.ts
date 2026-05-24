/**
 * feat-030/#79 · timeout 注入 pg TCP 路径端到端验证 (real neon_local · 自托管 PostgreSQL)。
 *
 * Gated on NEON_LOCAL_URL (同 feat-062 sql-driver pg TCP 路径触发条件) · 无 neon_local 时 skip。
 * 在 dev server 上跑: `NEON_LOCAL_URL='postgres://cloud_admin:cloud_admin@127.0.0.1:55432/neondb' \
 *   npm run test:e2e:mcp`。验证 createSqlClient(uri, timeouts) 真把 SET 打进 session + 锁/语句
 * 超时真 abort (详设 §7 · AC4/AC5)。
 *
 * 注: 通过 sql-driver 这一层直接验注入机制 · 不经 run_sql 全 pipeline (run_sql 仍走 neon() 直连 ·
 * 且 L2a 写 op 被 matrix fail-closed deny 到 feat-027 #77 plan mode 落地 · inject_timeout verdict
 * 的执行期消费随 write-path 成熟后接上)。
 */
import { describe, it, expect } from 'vitest';
import { createSqlClient } from '../tools/handlers/sql-driver';

const NEON_LOCAL_URL = process.env.NEON_LOCAL_URL;
// 每进程唯一表名 · 避免并发 / 残留冲突
const TBL = `feat030_e2e_${process.pid}`;

// pg 错误码: 57014 = query_canceled (statement_timeout) · 55P03 = lock_not_available (lock_timeout)
const QUERY_CANCELED = '57014';
const LOCK_NOT_AVAILABLE = '55P03';

describe.skipIf(!NEON_LOCAL_URL)(
  'feat-030/#79 timeout 注入 · neon_local e2e (pg TCP)',
  () => {
    it('AC4: SET lock_timeout + statement_timeout 同连接实际生效 (SHOW 验证)', async () => {
      const c = await createSqlClient(NEON_LOCAL_URL as string, {
        lock_timeout: '1s',
        statement_timeout: '2s',
      });
      try {
        const lk = await c.query('SHOW lock_timeout');
        const st = await c.query('SHOW statement_timeout');
        expect(lk[0]?.lock_timeout).toBe('1s');
        expect(st[0]?.statement_timeout).toBe('2s');
      } finally {
        await c.release();
      }
    });

    it('CONCURRENTLY 档 (仅 lock_timeout) → statement_timeout 不被设 (保持默认 0)', async () => {
      const c = await createSqlClient(NEON_LOCAL_URL as string, {
        lock_timeout: '1s',
      });
      try {
        const lk = await c.query('SHOW lock_timeout');
        const st = await c.query('SHOW statement_timeout');
        expect(lk[0]?.lock_timeout).toBe('1s');
        expect(st[0]?.statement_timeout).toBe('0'); // 未注入 → PG 默认 0 (无限)
      } finally {
        await c.release();
      }
    });

    it('statement_timeout → 长查询自动 abort (57014)', async () => {
      const c = await createSqlClient(NEON_LOCAL_URL as string, {
        lock_timeout: '1s',
        statement_timeout: '200ms',
      });
      try {
        await expect(c.query('SELECT pg_sleep(2)')).rejects.toMatchObject({
          code: QUERY_CANCELED,
        });
      } finally {
        await c.release();
      }
    });

    it('AC5: lock_timeout → ALTER 等锁超时自动 abort (55P03) · 不堵后续查询', async () => {
      const holder = await createSqlClient(NEON_LOCAL_URL as string); // 无 timeout · 持锁方
      const writer = await createSqlClient(NEON_LOCAL_URL as string, {
        lock_timeout: '500ms',
        statement_timeout: '5min',
      });
      try {
        await holder.query(`DROP TABLE IF EXISTS ${TBL}`);
        await holder.query(`CREATE TABLE ${TBL} (id int)`);
        // holder 在事务里拿 ACCESS EXCLUSIVE 锁不放
        await holder.query('BEGIN');
        await holder.query(`LOCK TABLE ${TBL} IN ACCESS EXCLUSIVE MODE`);

        // writer 的 ALTER 拿不到锁 · 等满 500ms → 55P03 (而非无限排队堵库)
        await expect(
          writer.query(`ALTER TABLE ${TBL} ADD COLUMN region text`),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });

        // holder 释放锁后 · writer 后续查询不被堵 (整表读写恢复)
        await holder.query('ROLLBACK');
        const rows = await writer.query(
          `SELECT count(*)::int AS n FROM ${TBL}`,
        );
        expect(rows[0]?.n).toBe(0);
      } finally {
        try {
          await holder.query(`DROP TABLE IF EXISTS ${TBL}`);
        } catch {
          // best-effort cleanup
        }
        await holder.release();
        await writer.release();
      }
    });
  },
);

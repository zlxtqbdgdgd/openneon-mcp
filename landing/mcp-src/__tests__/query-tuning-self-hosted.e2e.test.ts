/**
 * query-tuning-self-hosted.e2e.test.ts · ADR-0021 follow-up · 临时分支自托管 seam e2e
 *   验 handlers/local-branch.ts + connection-string.ts 分支解析 · dev server 直连真 neon_local · 无云。
 *
 * 设计依据: [ADR-0021](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/docs/adr/0021-branch-lifecycle-self-hosted-control-plane-never-official-cloud.md)
 *   把 prepare_query_tuning / database-migration 的「临时分支」从云迁到自托管 neon_local seam。
 *
 * 只在 dev server (NEON_LOCAL_REPO_DIR + NEON_LOCAL_URL set) 跑 · 本地 / CI 自动 skip。
 * 跑法 (dev server · 见 test-infra.md §13):
 *   NEON_LOCAL_URL=$(cat ~/.neon_url) \
 *   NEON_LOCAL_REPO_DIR=/home/z1/liqiang/zlxtqbdgdgd/openneon \
 *     npx vitest run mcp-src/__tests__/query-tuning-self-hosted.e2e.test.ts
 *
 * 验 autopilot「开分支 → 分支建候选索引 → 分支 EXPLAIN 验证修复 → 删」闭环在自托管真跑通,
 * 且分支改动不污染 main (CoW 隔离)。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import {
  createLocalTempBranch,
  deleteLocalTempBranch,
} from '../tools/handlers/local-branch';
import { handleGetConnectionString } from '../tools/handlers/connection-string';

const REPO = process.env.NEON_LOCAL_REPO_DIR;
const LOCAL = process.env.NEON_LOCAL_URL;
const CANDIDATE = 'checkout_orders_tsc_idx';

// 占位守卫: 缺 env 时本文件仍有 1 个收集到的用例 (否则 vitest "no tests" 失败)。
it('e2e 文件守卫 (seam 可导入)', () => {
  expect(typeof createLocalTempBranch).toBe('function');
});

describe.skipIf(!REPO || !LOCAL)(
  'ADR-0021 临时分支自托管 seam e2e (真 neon_local · 无云)',
  () => {
    let leaked: string | undefined;

    afterAll(async () => {
      if (leaked)
        await deleteLocalTempBranch('local-dev', leaked).catch(() => {});
    });

    it('建分支 → handleGetConnectionString 返分支串 → 分支建索引 EXPLAIN 用上 → main 不受影响 → 删', async () => {
      // 1. 自托管建临时分支 (neon_local timeline branch off main · 永不连云)
      const branch = await createLocalTempBranch('local-dev');
      leaked = branch.id;
      expect(branch.id).toMatch(/^[0-9a-f]{32}$/);

      // 2. ★核心修复★ handleGetConnectionString 对该 branch 返回**分支自己**的 endpoint connstr
      //    (而非 main 的 NEON_LOCAL_URL) → 下游所有 SQL 自动落到分支。
      const cs = await handleGetConnectionString(
        { projectId: 'local-dev', branchId: branch.id, databaseName: 'neondb' },
        null as never,
        {} as never,
      );
      expect(cs.uri).not.toBe(LOCAL); // 不是 main
      const u = new URL(cs.uri);
      expect(u.hostname).toBe('127.0.0.1');
      expect(u.pathname).toBe('/neondb');
      const mainPort = new URL(LOCAL as string).port || '55432';
      expect(u.port).not.toBe(mainPort); // 分支 endpoint 端口 ≠ main compute

      // 3. 分支上: 看得到 main 的 checkout_orders (CoW) + 建候选复合索引 + EXPLAIN 用上 = 修复被验证
      const br = new Client({ connectionString: cs.uri });
      await br.connect();
      try {
        const cnt = await br.query(
          'SELECT count(*)::int AS n FROM checkout_orders',
        );
        expect(cnt.rows[0].n).toBeGreaterThan(0); // CoW 看得到 main 数据
        await br.query(
          `CREATE INDEX ${CANDIDATE} ON checkout_orders(tenant_id, status, created_at DESC)`,
        );
        await br.query('ANALYZE checkout_orders');
        const idx = await br.query(
          'SELECT 1 FROM pg_indexes WHERE indexname=$1',
          [CANDIDATE],
        );
        expect(idx.rowCount).toBe(1); // 候选索引在分支上
        const plan = await br.query(
          `EXPLAIN (FORMAT JSON) SELECT id FROM checkout_orders
             WHERE tenant_id=42 AND status='pending'
             ORDER BY created_at DESC LIMIT 50`,
        );
        expect(JSON.stringify(plan.rows[0])).toContain(CANDIDATE); // 计划用上候选索引
      } finally {
        await br.end();
      }

      // 4. ★隔离★ main 上不存在该候选索引 (分支 DDL 不污染 main · CoW)
      const main = new Client({ connectionString: LOCAL });
      await main.connect();
      try {
        const onMain = await main.query(
          'SELECT 1 FROM pg_indexes WHERE indexname=$1',
          [CANDIDATE],
        );
        expect(onMain.rowCount).toBe(0);
      } finally {
        await main.end();
      }

      // 5. 删分支 (拆 endpoint + pageserver HTTP delete timeline) + 反注册
      await deleteLocalTempBranch('local-dev', branch.id);
      leaked = undefined;
    }, 180_000);
  },
);

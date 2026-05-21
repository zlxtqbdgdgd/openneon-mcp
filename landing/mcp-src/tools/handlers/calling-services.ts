/**
 * T2 get_neondb_calling_services handler · L1 day-one ship · feat-002 #1.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-002-L1-mcp-tool-t2-calling-services.html
 *
 * Sales 剧本应用归因工具 (L1 ship day-one core): 通过 pg_stat_activity 查 application_name
 * GUC + count(*) + max(state_change)·  返当前调当前 DB 的应用名 + 连接数 + 最近活动时间。
 * agent 不必自己 `run_sql('SELECT application_name FROM pg_stat_activity ...')` 写 SQL ·
 * 跟 feat-003 T6 防 SQL 幻觉 + feat-004 T8 防字段幻觉 一起 form L1 day-one core 4 个 read-only
 * 工具组合 (T1 entrance / T2 应用归因 / T6 query / T8 schema)。
 *
 * Output schema (day-one · per §4):
 *   { application_name, connection_count, last_active_time, endpoint_id: '' (always empty) }
 *
 * `endpoint_id` field 预留但 day-one 始终为空 · L2b USR 全栈贴标 ship 后填实 (per §11 R1 · 跟
 * feat-008-011 USR registry CI 联动)。Schema shape 不变·  forward-compat。
 *
 * Related sub-issues (this is #1 · others depend on this PR):
 * - feat-002 #1 (this file) · base handler + pg_stat_activity query
 * - feat-002 #2 (next PR) · tool registry T2 entry (annotation/category)
 * - feat-002 #3 (next PR) · threshold filter UX polish + project/branch param 完善
 * - feat-002 #4 (next PR) · endpoint_id schema 预留 + L2b 升级文档 note
 * - feat-002 #5 (next PR) · feat-061 fixture step 7 (4 case)
 */

import type { Api } from '@neondatabase/api-client';
import { startSpan } from '@sentry/node';
import { handleGetConnectionString } from './connection-string';
import { createSqlClient } from './sql-driver';
import type { ToolHandlerExtraParams } from '../types';

export type GetCallingServicesInput = {
  /** Neon project ID · required (per §4 input schema). */
  projectId: string;
  /** Optional branch ID · defaults to project's primary branch. */
  branchId?: string;
  /** Optional database name · defaults to 'neondb' (NEON_DEFAULT_DATABASE_NAME). */
  databaseName?: string;
  /** Optional compute ID · defaults to read-write compute for the branch. */
  computeId?: string;
  /** Optional connection-count threshold · defaults to min_connections=1 (skip idle apps). */
  threshold?: {
    /** Minimum connections required to include the application in results (HAVING count(*) >= N). */
    min_connections?: number;
  };
};

export type CallingServiceRow = {
  /** Application name from PostgreSQL `application_name` GUC · COALESCE+NULLIF → 'unknown' when NULL/empty. */
  application_name: string;
  /** Active connection count for this application (pg_stat_activity count(*)). */
  connection_count: number;
  /** Last state_change timestamp (ISO 8601) for any connection of this application. */
  last_active_time: string;
  /** Endpoint ID where the application is connected · **always empty day-one** · L2b USR fills (per §4). */
  endpoint_id: string;
};

const DEFAULT_DATABASE = 'neondb';
const DEFAULT_MIN_CONNECTIONS = 1;

/**
 * Aggregate active connections in `pg_stat_activity` by `application_name`.
 *
 * Returns rows ordered by `connection_count DESC` (busiest application first) ·
 * limited to top 50 (per §5 non-functional · token budget 2K · 50 row × 4 字段 cap).
 *
 * Empty result is a valid response (not an error) — e.g. database name not matched ·
 * or all applications below `min_connections` threshold. Agent sees empty CSV and can
 * recover (per detail design §7 case 3).
 */
export async function handleGetCallingServices(
  args: GetCallingServicesInput,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<CallingServiceRow[]> {
  return await startSpan(
    {
      name: 'get_neondb_calling_services',
    },
    async () => {
      const connectionString = await handleGetConnectionString(
        {
          projectId: args.projectId,
          branchId: args.branchId,
          computeId: args.computeId,
          databaseName: args.databaseName,
        },
        neonClient,
        extra,
      );

      const sql = await createSqlClient(connectionString.uri);
      try {
        const dbName = args.databaseName ?? DEFAULT_DATABASE;
        const minConnections =
          args.threshold?.min_connections ?? DEFAULT_MIN_CONNECTIONS;

        // pg_stat_activity COALESCE+NULLIF: NULL or '' application_name → 'unknown' (per §4).
        // HAVING (not WHERE) because count(*) aggregate · defaults skip idle (0 conn).
        const query = `
          SELECT
            COALESCE(NULLIF(application_name, ''), 'unknown') AS application_name,
            count(*)::int AS connection_count,
            max(state_change) AS last_active_time
          FROM pg_stat_activity
          WHERE datname = $1
          GROUP BY application_name
          HAVING count(*) >= $2
          ORDER BY connection_count DESC
          LIMIT 50;
        `;

        const rows = await sql.query(query, [dbName, minConnections]);

        return rows.map((r) => ({
          application_name: String(r.application_name),
          connection_count: Number(r.connection_count),
          last_active_time:
            r.last_active_time instanceof Date
              ? r.last_active_time.toISOString()
              : String(r.last_active_time ?? ''),
          // Per §4: endpoint_id 预留 · day-one 始终空 · L2b USR ship 后填 · schema 不变
          endpoint_id: '',
        }));
      } finally {
        await sql.release();
      }
    },
  );
}

/**
 * T5 get_neondb_query_performance handler · feat-021 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-021-L2-mcp-tool-t5-query-performance.html
 *
 * Finds / ranks "slow queries". L2a core = pg_stat_statements CUMULATIVE top-N (rank by
 * total / mean / calls / I/O). Each row carries multiple dimensions + a deterministic profile
 * (slow-per-call / high-frequency / io-heavy). Diagnostic chain: T4 (which signals are off) →
 * T5 (which queries are slow) → T3 (explain that one).
 *
 * The agent's first choice instead of `run_sql('SELECT ... FROM pg_stat_statements ...')` + DIY
 * sorting / mean computation (§3.3.0). rate / true p95p99 / per-query baseline need per-query TSDB
 * history → deferred to feat-064 increments.
 */

import type { Api } from '@neondatabase/api-client';
import { startSpan } from '@sentry/node';
import { NotFoundError } from '../../server/errors';
import { handleGetConnectionString } from './connection-string';
import { createSqlClient } from './sql-driver';
import { truncateSqlForDepth } from './query-statement';
import {
  DEFAULT_DEPTH,
  isValidDepth,
  type DepthLevel,
} from '../../config/depth';
import type { ToolHandlerExtraParams } from '../types';

export type QueryRankBy =
  | 'total_exec_time'
  | 'mean_exec_time'
  | 'calls'
  | 'io';

export type QueryProfileTag = 'slow-per-call' | 'high-frequency' | 'io-heavy';

export type GetQueryPerformanceInput = {
  /** Neon project ID · required. */
  projectId: string;
  branchId?: string;
  databaseName?: string;
  computeId?: string;
  /** Ranking dimension · default 'total_exec_time'. */
  rank_by?: QueryRankBy;
  /** Top-N · default 20 · clamped to [1, 100]. */
  limit?: number;
  /** Progressive disclosure depth for the query text (reuses feat-007) · default 'shallow'. */
  depth?: DepthLevel;
};

export type QueryPerformanceRow = {
  queryid: string;
  /** Normalized SQL ($1 placeholders · no literal leakage) · progressive-truncated. */
  query: string;
  calls: number;
  mean_exec_time: number;
  total_exec_time: number;
  rows: number;
  shared_blks_read: number;
  profile: QueryProfileTag[];
};

export type QueryPerformanceResult = {
  /** pg_stat_statements_info.stats_reset · the "since when" of the cumulative numbers. */
  stats_since: string | null;
  /** 'partial' = role lacks pg_read_all_stats (sees only its own queries · NOT the whole DB). */
  visibility: 'full' | 'partial';
  queries: QueryPerformanceRow[];
};

const DEFAULT_DATABASE = 'neondb';
const DEFAULT_RANK_BY: QueryRankBy = 'total_exec_time';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Whitelist rank_by → pg_stat_statements column. Re-guarded here (not just at the zod boundary)
// because the OAuth-free local-call path skips zod · this map is the SQL-injection防线 for ORDER BY
// (column names can't be parameterized).
const RANK_BY_COLUMN: Record<QueryRankBy, string> = {
  total_exec_time: 'total_exec_time',
  mean_exec_time: 'mean_exec_time',
  calls: 'calls',
  io: 'shared_blks_read',
};

// Profile thresholds (OQ4/OQ5 · starting points · calibrate via feat-054 eval).
/** mean_exec_time at/above which a query is "slow per call" (ms). */
const SLOW_PER_CALL_MEAN_MS = 100;
/** calls at/above which a query is "high frequency". */
const HIGH_FREQUENCY_CALLS = 1000;
/** shared_blks_read PER CALL at/above which a query is "io heavy" (blocks · 1000 ≈ 8 MB/exec). */
const IO_HEAVY_BLKS_PER_CALL = 1000;

/**
 * Derive the deterministic profile tags for one query row (no LLM · §3.3.0).
 *
 * - `slow-per-call`: mean_exec_time ≥ 100ms.
 * - `high-frequency`: calls ≥ 1000 AND mean is low (< 100ms) — a frequent-but-fast query. A
 *   frequent-AND-slow query is `slow-per-call` only (per design §3 "calls 极高且 mean 低"), so a
 *   huge-calls/low-mean query is NEVER mislabeled `slow-per-call` (fixture invariant).
 * - `io-heavy`: shared_blks_read per call ≥ 1000 blocks.
 */
export function deriveProfile(row: {
  calls: number;
  mean_exec_time: number;
  shared_blks_read: number;
}): QueryProfileTag[] {
  const tags: QueryProfileTag[] = [];
  if (row.mean_exec_time >= SLOW_PER_CALL_MEAN_MS) {
    tags.push('slow-per-call');
  }
  if (
    row.calls >= HIGH_FREQUENCY_CALLS &&
    row.mean_exec_time < SLOW_PER_CALL_MEAN_MS
  ) {
    tags.push('high-frequency');
  }
  const blksPerCall = row.shared_blks_read / Math.max(row.calls, 1);
  if (blksPerCall >= IO_HEAVY_BLKS_PER_CALL) {
    tags.push('io-heavy');
  }
  return tags;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/**
 * Rank slow queries from pg_stat_statements (cumulative top-N) + derive per-row profiles.
 *
 * @throws NotFoundError if the pg_stat_statements extension is not installed.
 */
export async function handleGetQueryPerformance(
  args: GetQueryPerformanceInput,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<QueryPerformanceResult> {
  return await startSpan(
    {
      name: 'get_neondb_query_performance',
    },
    async () => {
      const connectionString = await handleGetConnectionString(
        {
          projectId: args.projectId,
          branchId: args.branchId,
          computeId: args.computeId,
          databaseName: args.databaseName ?? DEFAULT_DATABASE,
        },
        neonClient,
        extra,
      );

      const sql = await createSqlClient(connectionString.uri);
      try {
        // 1. pg_stat_statements must be installed.
        const extCheck = (await sql.query(
          `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS extension_exists`,
        )) as Array<{ extension_exists: boolean }>;
        if (!extCheck[0]?.extension_exists) {
          throw new NotFoundError(
            `pg_stat_statements extension is not installed on the database. Install it with: CREATE EXTENSION pg_stat_statements;`,
          );
        }

        // 2. Visibility: does the connecting role see all queries (pg_read_all_stats / superuser)
        //    or only its own? Honest 'partial' marker · never pretend a partial view is complete.
        let visibility: 'full' | 'partial' = 'partial';
        try {
          const visRows = (await sql.query(
            `SELECT (
               COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
               OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')
             ) AS has_read_all`,
          )) as Array<{ has_read_all: boolean }>;
          visibility = visRows[0]?.has_read_all ? 'full' : 'partial';
        } catch {
          // pg_read_all_stats predates PG10 · on any error stay conservative ('partial').
          visibility = 'partial';
        }

        // 3. stats_since from pg_stat_statements_info (PG14+) · best-effort.
        let stats_since: string | null = null;
        try {
          const infoRows = (await sql.query(
            `SELECT stats_reset FROM pg_stat_statements_info LIMIT 1`,
          )) as Array<{ stats_reset: unknown }>;
          const reset = infoRows[0]?.stats_reset;
          if (reset instanceof Date) stats_since = reset.toISOString();
          else if (reset != null) stats_since = String(reset);
        } catch {
          stats_since = null;
        }

        // 4. Cumulative top-N. rank column comes from the whitelist (ORDER BY can't be a param) ·
        //    LIMIT is parameterized ($1).
        const rankBy: QueryRankBy = args.rank_by ?? DEFAULT_RANK_BY;
        const rankColumn = RANK_BY_COLUMN[rankBy] ?? RANK_BY_COLUMN[DEFAULT_RANK_BY];
        const limit = clampLimit(args.limit);

        const rows = (await sql.query(
          `SELECT
             queryid::text AS queryid,
             query,
             calls,
             mean_exec_time,
             total_exec_time,
             rows,
             shared_blks_read
           FROM pg_stat_statements
           ORDER BY ${rankColumn} DESC NULLS LAST
           LIMIT $1`,
          [limit],
        )) as Array<Record<string, unknown>>;

        const depth: DepthLevel = isValidDepth(args.depth)
          ? args.depth
          : DEFAULT_DEPTH;

        const queries: QueryPerformanceRow[] = rows.map((r) => {
          const calls = Number(r.calls);
          const mean_exec_time = Number(r.mean_exec_time);
          const shared_blks_read = Number(r.shared_blks_read);
          return {
            queryid: String(r.queryid),
            // pg_stat_statements normalizes literals to $1/$2 (no raw values · OWASP LLM02) ·
            // we only truncate for shallow depth (line-level · placeholders preserved).
            query: truncateSqlForDepth(String(r.query ?? ''), depth),
            calls,
            mean_exec_time,
            total_exec_time: Number(r.total_exec_time),
            rows: Number(r.rows),
            shared_blks_read,
            profile: deriveProfile({ calls, mean_exec_time, shared_blks_read }),
          };
        });

        return { stats_since, visibility, queries };
      } finally {
        await sql.release();
      }
    },
  );
}

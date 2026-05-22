/**
 * T6 get_neondb_query_statement handler · L1 day-one ship.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-003-L1-mcp-tool-t6-query-statement.html
 * Narrative #3 主卖点 (per ADR-0003) · 防 LLM 自负幻觉 SQL.
 *
 * Returns parameterized SQL text for a given query signature (queryid in
 * pg_stat_statements). Guarantees no raw values leak ($1 / $2 placeholders only).
 *
 * Pairs with feat-004 T8 get_neondb_schemas as 防幻觉一对组合 (narrative #3).
 *
 * Related sub-issues (this is #1 · others depend on this PR):
 * - feat-003 #1 (this file) · base handler + pg_stat_statements query
 * - feat-003 #2 (next PR) · tool registry T6 entry (annotation/category/depth)
 * - feat-003 #3 (next PR) · depth shallow/full · SQL 30-line truncation + tail marker
 * - feat-003 #4 (next PR) · anti-hallucination fixture (feat-061 step 4 · case 5)
 * - feat-003 #5 (next PR) · prompt template (tool description guidance)
 */

import type { Api } from '@neondatabase/api-client';
import { startSpan } from '@sentry/node';
import { NotFoundError } from '../../server/errors';
import { handleGetConnectionString } from './connection-string';
import { createSqlClient } from './sql-driver';
import { DEFAULT_DEPTH, type DepthLevel } from '../../config/depth';
import type { ToolHandlerExtraParams } from '../types';

// feat-003 #3 · shallow depth truncation thresholds (per detail design §5 · shallow ≤ 1K token).
const SHALLOW_MAX_LINES = 30;
// Secondary char cap for pathological single-line SQL (a 10K-char one-liner has only 1 line ·
// line-count alone wouldn't truncate it · token budget would blow). ~2K chars ≈ 500 token.
const SHALLOW_MAX_CHARS = 2000;
const TRUNCATION_MARKER = '-- <truncated · use depth=full for complete SQL>';

/**
 * Truncate SQL text for shallow depth (feat-003 #3).
 *
 * - `full` → return SQL unchanged.
 * - `shallow` → first 30 lines (line-boundary cut · never mid-line, so a WHERE clause on its
 *   own line is never split mid-token), then a secondary 2K-char cap for pathological
 *   single-line SQL (cut at last whitespace to avoid splitting a token). Appends a tail marker
 *   so the agent knows to re-request with depth=full.
 *
 * Returns the (possibly truncated) query string. Idempotent for short SQL (no marker added).
 */
export function truncateSqlForDepth(sql: string, depth: DepthLevel): string {
  if (depth === 'full') return sql;

  const lines = sql.split('\n');
  let result = sql;
  let truncated = false;

  if (lines.length > SHALLOW_MAX_LINES) {
    result = lines.slice(0, SHALLOW_MAX_LINES).join('\n');
    truncated = true;
  }

  if (result.length > SHALLOW_MAX_CHARS) {
    const slice = result.slice(0, SHALLOW_MAX_CHARS);
    const lastWhitespace = slice.lastIndexOf(' ');
    result = lastWhitespace > 0 ? slice.slice(0, lastWhitespace) : slice;
    truncated = true;
  }

  return truncated ? `${result}\n${TRUNCATION_MARKER}` : result;
}

export type GetQueryStatementInput = {
  /** PostgreSQL pg_stat_statements queryid (bigint as string per detail design §4). */
  query_signature: string;
  /** Neon project ID. */
  projectId: string;
  /** Optional branch ID. Defaults to project's default branch (per handleGetConnectionString). */
  branchId?: string;
  /** Optional database name. Defaults to 'neondb' (NEON_DEFAULT_DATABASE_NAME). */
  databaseName?: string;
  /** Optional compute ID. Defaults to default compute (per handleGetConnectionString). */
  computeId?: string;
  /**
   * Progressive disclosure depth (feat-003 #3 · feat-007 shared infra).
   * - 'shallow' (default · token economy) · SQL truncated to first 30 lines + tail marker
   * - 'full' · complete SQL text (any length · agent explicit opt-in)
   */
  depth?: DepthLevel;
};

export type QueryStatementResult = {
  query_signature: string;
  /** Parameterized SQL text. $1/$2 placeholders only · NO raw values (OWASP LLM02 防护). */
  query: string;
  calls: number;
  total_exec_time_ms: number;
  mean_exec_time_ms: number;
  rows: number;
};

/**
 * Fetch parameterized SQL text + execution stats for a given query signature.
 *
 * @throws NotFoundError if pg_stat_statements extension not installed
 * @throws NotFoundError if query_signature not found in pg_stat_statements view
 */
export async function handleGetQueryStatement(
  args: GetQueryStatementInput,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<QueryStatementResult> {
  return await startSpan(
    {
      name: 'get_neondb_query_statement',
    },
    async () => {
      // 1. Get connection string via shared handler (same pattern as handleListSlowQueries)
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

      // 2. Connect to the database via SqlClient (routes between Neon HTTP and
      //    plain Postgres TCP based on URI · see sql-driver.ts).
      const sql = await createSqlClient(connectionString.uri);
      try {
        // 3. Verify pg_stat_statements extension is installed
        const checkExtensionQuery = `
          SELECT EXISTS (
            SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
          ) as extension_exists;
        `;
        const extensionCheck = (await sql.query(checkExtensionQuery)) as Array<{
          extension_exists: boolean;
        }>;
        if (!extensionCheck[0]?.extension_exists) {
          throw new NotFoundError(
            `pg_stat_statements extension is not installed on the database. Please install it using the following command: CREATE EXTENSION pg_stat_statements;`,
          );
        }

        // 4. Query pg_stat_statements by queryid (single row lookup)
        //
        // Note: pg_stat_statements.query is ALREADY parameterized by PostgreSQL
        // ($1, $2 placeholders auto-generated · raw values never present).
        // This is the OWASP LLM02 防护 mechanism · we just透传.
        const querySql = `
          SELECT
            queryid::text AS query_signature,
            query,
            calls,
            total_exec_time AS total_exec_time_ms,
            mean_exec_time AS mean_exec_time_ms,
            rows
          FROM pg_stat_statements
          WHERE queryid::text = $1
          LIMIT 1;
        `;
        const rows = await sql.query(querySql, [args.query_signature]);

        if (rows.length === 0) {
          throw new NotFoundError(
            `query_signature '${args.query_signature}' not found in pg_stat_statements view. ` +
              `It may have been evicted (default pg_stat_statements.max = 5000 unique queries).`,
          );
        }

        const row = rows[0];
        const depth = args.depth ?? DEFAULT_DEPTH;
        return {
          query_signature: String(row.query_signature),
          // Truncate to first 30 lines for shallow depth (token economy · per §5) · full = complete.
          // Parameterized $1/$2 placeholders preserved either way (truncation is line-level · OWASP LLM02 防护 intact).
          query: truncateSqlForDepth(String(row.query), depth),
          calls: Number(row.calls),
          total_exec_time_ms: Number(row.total_exec_time_ms),
          mean_exec_time_ms: Number(row.mean_exec_time_ms),
          rows: Number(row.rows),
        };
      } finally {
        await sql.release();
      }
    },
  );
}

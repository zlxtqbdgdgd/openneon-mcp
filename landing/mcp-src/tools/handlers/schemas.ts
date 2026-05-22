/**
 * T8 get_neondb_schemas handler · L1 day-one ship.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-004-L1-mcp-tool-t8-schemas.html
 * Narrative #3 配对 (per ADR-0003) · 防 LLM agent 凭表名脑补字段 (e.g. users 表的
 * email_address vs email · sales 表的 created_at vs sale_date).
 *
 * Pairs with feat-003 T6 get_neondb_query_statement as 防幻觉一对组合 (narrative #3 主 pillar 1).
 *
 * Returns column metadata (column_name / data_type / is_indexed / is_nullable) for
 * one or more tables matching the `filter` (supports wildcards via `*`).
 *
 * Related sub-issues (this is #1 · others depend on this PR):
 * - feat-004 #1 (this file) · base handler + pg_attribute + pg_index query
 * - feat-004 #2 (next PR) · wildcard filter (`*` → SQL LIKE `%` + escape)
 * - feat-004 #3 (next PR) · tool registry T8 entry (annotation/category/depth)
 * - feat-004 #4 (next PR) · progressive disclosure shallow/full impl
 * - feat-004 #5 (next PR) · anti-hallucination fixture (feat-061 step 5 · case 5/6)
 */

import type { Api } from '@neondatabase/api-client';
import { startSpan } from '@sentry/node';
import { NotFoundError } from '../../server/errors';
import { handleGetConnectionString } from './connection-string';
import { createSqlClient } from './sql-driver';
import type { ToolHandlerExtraParams } from '../types';

export type GetSchemasInput = {
  /**
   * Table name filter. Supports user-facing wildcard `*` (feat-004 #2):
   * - 'sales' (exact match · no wildcard)
   * - 'sales*' (prefix · matches sales / sales_archive / ...)
   * - '*sales*' (contains)
   * LIKE metacharacters (`%` `_` `\`) in the filter are escaped to match literally ·
   * only `*` is treated as a wildcard.
   */
  filter: string;
  /** Neon project ID. */
  projectId: string;
  /** Optional branch ID. Defaults to project's default branch. */
  branchId?: string;
  /** Optional database name. Defaults to 'neondb'. */
  databaseName?: string;
  /** Optional compute ID. */
  computeId?: string;
  /** Optional PostgreSQL schema name. Defaults to 'public'. */
  schema?: string;
};

export type SchemaRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  /** true if the column appears in any index (single-column index OR multi-column index leading column). */
  is_indexed: boolean;
  is_nullable: boolean;
};

export type GetSchemasResult = {
  rows: SchemaRow[];
  meta: {
    filter: string;
    schema: string;
    totalRows: number;
    /** Empty when nothing matched · provides hint for agent UX. */
    hint?: string;
  };
};

/**
 * Convert a user-facing table filter into a SQL LIKE pattern (feat-004 #2).
 *
 * - Escapes LIKE metacharacters (`\` `%` `_`) so they match literally · prevents a table
 *   name like `user_data` from matching `userXdata`, or `100%off` from matching anything.
 * - Converts the user-facing wildcard `*` into the SQL LIKE wildcard `%`.
 *
 * Used with `LIKE $2 ESCAPE '\'` so the escape sequences resolve correctly. A filter with no
 * `*` produces a pattern with no wildcards → LIKE behaves like exact match.
 *
 * SQL injection is not a concern here — the pattern is bound as a parameter ($2) · pg / Neon
 * HTTP driver escapes at the protocol boundary. This function only governs LIKE *matching*.
 */
export function toLikePattern(filter: string): string {
  const escaped = filter
    .replace(/\\/g, '\\\\') // backslash first · so escapes we add below aren't double-escaped
    .replace(/%/g, '\\%') // literal % → escaped (not a multi-char wildcard)
    .replace(/_/g, '\\_'); // literal _ → escaped (not a single-char wildcard)
  return escaped.replace(/\*/g, '%'); // user wildcard * → SQL LIKE %
}

/**
 * Fetch column-level schema metadata for tables matching the filter.
 *
 * Day-one base impl (feat-004 #1 + #2):
 * - exact match OR wildcard `*` (feat-004 #2 · `*` → SQL LIKE `%` · metachars escaped)
 * - shallow schema (5 cols: table/column/type/indexed/nullable) — full schema is sub-issue #4
 *
 * @throws NotFoundError if filter matches no tables in the schema
 */
export async function handleGetSchemas(
  args: GetSchemasInput,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<GetSchemasResult> {
  const schema = args.schema ?? 'public';

  return await startSpan(
    {
      name: 'get_neondb_schemas',
    },
    async () => {
      // 1. Get connection string via shared handler (same pattern as T6 / list_slow_queries)
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
        // 3. Query pg_attribute + pg_index + information_schema for column metadata
        //
        // Strategy:
        // - pg_attribute · base column metadata (name + type + nullable)
        // - pg_index · check if column appears in any index (any position · feat-004 #1 base)
        // - feat-004 #4 (depth full) will expand to index_name / index_type / partial WHERE / INCLUDE
        const schemasQuery = `
          SELECT
            c.relname AS table_name,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            NOT a.attnotnull AS is_nullable,
            EXISTS (
              SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.oid
              AND a.attnum = ANY(i.indkey)
            ) AS is_indexed
          FROM pg_class c
          JOIN pg_attribute a ON a.attrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relkind = 'r'
            AND n.nspname = $1
            AND c.relname LIKE $2 ESCAPE '\\'
            AND a.attnum > 0
            AND NOT a.attisdropped
          ORDER BY c.relname, a.attnum;
        `;

        const rows = await sql.query(schemasQuery, [
          schema,
          toLikePattern(args.filter),
        ]);

        if (rows.length === 0) {
          throw new NotFoundError(
            `no tables matching '${args.filter}' in schema '${schema}'. ` +
              `Check spelling, or use '*' as a wildcard (e.g. 'sales*'), or try schema='${schema}' explicitly.`,
          );
        }

        const formattedRows: SchemaRow[] = rows.map((r) => ({
          table_name: String(r.table_name),
          column_name: String(r.column_name),
          data_type: String(r.data_type),
          is_indexed: Boolean(r.is_indexed),
          is_nullable: Boolean(r.is_nullable),
        }));

        return {
          rows: formattedRows,
          meta: {
            filter: args.filter,
            schema,
            totalRows: formattedRows.length,
          },
        };
      } finally {
        await sql.release();
      }
    },
  );
}

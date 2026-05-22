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
import { DEFAULT_DEPTH, type DepthLevel } from '../../config/depth';
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
  /**
   * Progressive disclosure depth (feat-004 #4 · feat-007 shared infra).
   * - 'shallow' (default · token economy) · 5 fields: table/column/type/is_indexed/is_nullable
   * - 'full' · 9 fields: + default_value + index detail (name/type/partial WHERE/INCLUDE cols)
   */
  depth?: DepthLevel;
};

/** Shallow row (default · 5 fields · token economy). */
export type SchemaRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  /** true if the column appears in any index (single-column index OR multi-column index leading column). */
  is_indexed: boolean;
  is_nullable: boolean;
};

/**
 * Full row (depth=full · 9 fields · per detail design §4 full output schema).
 *
 * One row per (column × index it participates in) · columns in no index get one row with
 * null index fields · columns in N indexes get N rows. `is_indexed` is dropped (index_name
 * non-null conveys it).
 */
export type SchemaRowFull = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  /** Column DEFAULT expression (pg_get_expr) · null when no default. */
  default_value: string | null;
  /** Index name this column participates in · null when column is in no index. */
  index_name: string | null;
  /** Index access method (btree / hash / gin / gist / ...) · null when no index. */
  index_type: string | null;
  /** Partial index WHERE expression (pg_get_expr indpred) · null when not a partial index. */
  index_partial_where: string | null;
  /** Comma-joined INCLUDE columns of the index (covering index non-key cols) · null when none. */
  index_include_columns: string | null;
};

export type GetSchemasResult = {
  rows: SchemaRow[] | SchemaRowFull[];
  meta: {
    filter: string;
    schema: string;
    depth: DepthLevel;
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

type SqlClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
};

/**
 * Shallow schema query (feat-004 #1 base · 5 字段 · token economy default).
 *
 * One row per column · `is_indexed` is a boolean EXISTS over pg_index.
 */
async function queryShallowSchema(
  sql: SqlClientLike,
  schema: string,
  likePattern: string,
): Promise<SchemaRow[]> {
  const shallowQuery = `
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
  const rows = await sql.query(shallowQuery, [schema, likePattern]);
  return rows.map((r) => ({
    table_name: String(r.table_name),
    column_name: String(r.column_name),
    data_type: String(r.data_type),
    is_indexed: Boolean(r.is_indexed),
    is_nullable: Boolean(r.is_nullable),
  }));
}

/**
 * Full schema query (feat-004 #4 · 9 字段 · opt-in via depth=full · per detail design §4).
 *
 * LEFT JOINs each column to pg_attrdef (default) + every pg_index it participates in.
 * - column in no index → one row · index_* fields null
 * - column in N indexes → N rows (full detail mode · acceptable per §4)
 * INCLUDE columns: indkey entries beyond indnkeyatts are covering (non-key) columns.
 */
async function queryFullSchema(
  sql: SqlClientLike,
  schema: string,
  likePattern: string,
): Promise<SchemaRowFull[]> {
  const fullQuery = `
    SELECT
      c.relname AS table_name,
      a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      NOT a.attnotnull AS is_nullable,
      pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
      ic.relname AS index_name,
      am.amname AS index_type,
      pg_get_expr(ix.indpred, ix.indrelid) AS index_partial_where,
      (
        SELECT string_agg(ia.attname, ',' ORDER BY k.ord)
        FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute ia ON ia.attrelid = ix.indrelid AND ia.attnum = k.attnum
        WHERE k.ord > ix.indnkeyatts
      ) AS index_include_columns
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    LEFT JOIN pg_index ix ON ix.indrelid = c.oid AND a.attnum = ANY(ix.indkey)
    LEFT JOIN pg_class ic ON ic.oid = ix.indexrelid
    LEFT JOIN pg_am am ON am.oid = ic.relam
    WHERE c.relkind = 'r'
      AND n.nspname = $1
      AND c.relname LIKE $2 ESCAPE '\\'
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum, ic.relname;
  `;
  const rows = await sql.query(fullQuery, [schema, likePattern]);
  return rows.map((r) => ({
    table_name: String(r.table_name),
    column_name: String(r.column_name),
    data_type: String(r.data_type),
    is_nullable: Boolean(r.is_nullable),
    default_value: r.default_value == null ? null : String(r.default_value),
    index_name: r.index_name == null ? null : String(r.index_name),
    index_type: r.index_type == null ? null : String(r.index_type),
    index_partial_where:
      r.index_partial_where == null ? null : String(r.index_partial_where),
    index_include_columns:
      r.index_include_columns == null ? null : String(r.index_include_columns),
  }));
}

/**
 * Fetch column-level schema metadata for tables matching the filter.
 *
 * feat-004 #1 + #2 + #4:
 * - exact match OR wildcard `*` (feat-004 #2 · `*` → SQL LIKE `%` · metachars escaped)
 * - depth shallow (5 字段 · default · token economy) / full (9 字段 · index detail · feat-004 #4)
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
        const depth = args.depth ?? DEFAULT_DEPTH;
        const likePattern = toLikePattern(args.filter);

        // 3. Query pg system catalogs for column metadata · depth决定字段宽度 (feat-004 #4 + feat-007):
        // - shallow (default · token economy): pg_attribute base + EXISTS is_indexed boolean
        // - full: + pg_attrdef default_value + pg_index name/am/indpred + INCLUDE columns
        const formattedRows: SchemaRow[] | SchemaRowFull[] =
          depth === 'full'
            ? await queryFullSchema(sql, schema, likePattern)
            : await queryShallowSchema(sql, schema, likePattern);

        if (formattedRows.length === 0) {
          throw new NotFoundError(
            `no tables matching '${args.filter}' in schema '${schema}'. ` +
              `Check spelling, or use '*' as a wildcard (e.g. 'sales*'), or try schema='${schema}' explicitly.`,
          );
        }

        return {
          rows: formattedRows,
          meta: {
            filter: args.filter,
            schema,
            depth,
            totalRows: formattedRows.length,
          },
        };
      } finally {
        await sql.release();
      }
    },
  );
}

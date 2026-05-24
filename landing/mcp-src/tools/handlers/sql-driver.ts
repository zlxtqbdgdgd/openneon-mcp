/**
 * SQL driver abstraction · routes between Neon Cloud HTTP/WS driver and plain
 * PostgreSQL TCP driver based on the connection URL.
 *
 * - Neon Cloud (`*.neon.tech`): `@neondatabase/serverless` neon() · HTTP/WS · stateless
 * - Self-hosted (`127.0.0.1`, `localhost`, anything when NEON_LOCAL_URL is set):
 *   node-postgres `pg.Client` · plain TCP · explicit connection lifecycle
 *
 * Used by T6 (query-statement) and T8 (schemas) handlers · enables day-one L1
 * testing against a self-hosted neon_local cluster (dev server :55432) without
 * needing a Neon Cloud project.
 *
 * NOTE: The Neon serverless driver's `neon(uri)` rejects non-Neon URLs at query
 * time (HTTP proxy hits `*.neon.tech` only) · so this routing is mandatory when
 * NEON_LOCAL_URL is set · not just an optimisation.
 */

import { neon } from '@neondatabase/serverless';
import pg from 'pg';
import {
  isValidPgTimeoutValue,
  type TimeoutSpec,
} from '../../policy/stages/timeout-injection';

const { Client: PgClient } = pg;

export type SqlClient = {
  query: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  release: () => Promise<void>;
};

/**
 * Returns true when the URI points to a self-hosted Postgres reachable over TCP
 * (i.e. NOT the Neon Cloud HTTP/WS proxy). Two triggers:
 *   1. `NEON_LOCAL_URL` env is set and matches the URI · explicit operator opt-in
 *   2. URI host is `127.0.0.1` / `localhost` · safety net for direct calls
 */
function isLocalPgUri(uri: string): boolean {
  if (process.env.NEON_LOCAL_URL && uri === process.env.NEON_LOCAL_URL) {
    return true;
  }
  try {
    const url = new URL(uri);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Build the validated feat-030 timeout `SET` / `SET LOCAL` statements.
 *
 * - `local = false` (pg TCP · persistent session · #79): plain `SET` stays in force for the
 *   connection's whole lifetime.
 * - `local = true` (Neon Cloud HTTP · stateless single-shot · #80): `SET LOCAL` scopes the timeout
 *   to the wrapping transaction only, so it never leaks onto a pooled connection reused by another
 *   request (详设 §3.2 / OQ3).
 *
 * Values come only from DEFAULT_TIMEOUTS or validated policy overrides, but the value is
 * string-interpolated into the statement, so we re-guard with a strict PG-interval whitelist here —
 * that whitelist is the SQL-injection防线 (详设 §6).
 */
function timeoutSetStatements(timeouts: TimeoutSpec, local: boolean): string[] {
  const keyword = local ? 'SET LOCAL' : 'SET';
  const lock = timeouts.lock_timeout;
  if (!isValidPgTimeoutValue(lock)) {
    throw new Error(`非法 lock_timeout (拒绝注入): ${String(lock)}`);
  }
  const statements = [`${keyword} lock_timeout = '${lock}'`];
  if (timeouts.statement_timeout !== undefined) {
    const stmt = timeouts.statement_timeout;
    if (!isValidPgTimeoutValue(stmt)) {
      throw new Error(`非法 statement_timeout (拒绝注入): ${String(stmt)}`);
    }
    statements.push(`${keyword} statement_timeout = '${stmt}'`);
  }
  return statements;
}

/**
 * CONCURRENTLY index ops (CREATE / DROP INDEX CONCURRENTLY · REINDEX CONCURRENTLY) cannot run
 * inside a transaction block (PostgreSQL hard limit). The Neon Cloud HTTP path injects timeouts by
 * wrapping `SET LOCAL` + SQL in one transaction — impossible for these — so we fall back to a bare
 * query and accept no HTTP session timeout for them (详设 §3.2 / §11 OQ1: CONCURRENTLY already
 * exempts statement_timeout, and the lock_timeout loss is acceptable because the lock is short).
 * The pg TCP path is unaffected — session `SET` works without a transaction.
 */
function cannotRunInTransaction(sql: string): boolean {
  return /\bCONCURRENTLY\b/i.test(sql);
}

/**
 * Create a SqlClient over the given URI. Caller MUST `await client.release()`
 * to close the TCP connection when done (no-op for Neon HTTP driver, required
 * for pg).
 *
 * `timeouts` (feat-030 · from the pipeline's inject_timeout verdict) injects lock_timeout
 * (+ optional statement_timeout) before any SQL runs:
 * - pg TCP path (#79): session-level `SET` on the persistent connection.
 * - Neon Cloud HTTP path (#80): each query is wrapped in a transaction with `SET LOCAL` so the
 *   stateless single-shot request carries the timeout on the same connection (CONCURRENTLY ops are
 *   the exception — see `cannotRunInTransaction`).
 */
export async function createSqlClient(
  uri: string,
  timeouts?: TimeoutSpec,
): Promise<SqlClient> {
  if (isLocalPgUri(uri)) {
    const client = new PgClient({ connectionString: uri });
    await client.connect();
    if (timeouts) {
      for (const statement of timeoutSetStatements(timeouts, false)) {
        await client.query(statement);
      }
    }
    return {
      query: async (sql, params) => {
        const result = await client.query(sql, params ?? []);
        return result.rows as Array<Record<string, unknown>>;
      },
      release: async () => {
        await client.end();
      },
    };
  }

  const neonSql = neon(uri);
  return {
    query: async (sql, params) => {
      if (timeouts && !cannotRunInTransaction(sql)) {
        // 把 SET LOCAL + 实际 SQL 包进同一事务 → stateless HTTP 下同连接保证 timeout 生效,
        // 且 SET LOCAL 仅本事务有效 · 不泄漏到连接池其他请求 (详设 §3.2)。
        // transaction 返回各语句结果数组 · 取末条 (= 实际 SQL 的结果)。
        const queries = [
          ...timeoutSetStatements(timeouts, true).map((s) => neonSql.query(s)),
          neonSql.query(sql, params ?? []),
        ];
        const results = await neonSql.transaction(queries);
        return (results[results.length - 1] ?? []) as Array<
          Record<string, unknown>
        >;
      }
      // 无 timeout · 或 CONCURRENTLY (不能进事务 · OQ1 接受 HTTP 下无 session timeout) → 裸 query
      return (await neonSql.query(sql, params ?? [])) as Array<
        Record<string, unknown>
      >;
    },
    release: async () => {
      // Neon HTTP driver is stateless · nothing to release.
    },
  };
}

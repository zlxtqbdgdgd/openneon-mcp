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
 * Inject feat-030 timeouts on a live pg session (pg TCP path · isLocalPgUri true).
 *
 * Connection persists, so a plain session-level `SET` before any SQL keeps the timeout in force
 * for every subsequent query on this client. Values come only from DEFAULT_TIMEOUTS or validated
 * policy overrides, but we guard again at the injection point: the value is string-interpolated
 * into the SET statement, so a strict PG-interval whitelist is the SQL-injection防线 (详设 §6).
 */
async function injectPgTimeouts(
  client: InstanceType<typeof PgClient>,
  timeouts: TimeoutSpec,
): Promise<void> {
  const lock = timeouts.lock_timeout;
  if (!isValidPgTimeoutValue(lock)) {
    throw new Error(`非法 lock_timeout (拒绝注入): ${String(lock)}`);
  }
  await client.query(`SET lock_timeout = '${lock}'`);
  if (timeouts.statement_timeout !== undefined) {
    const stmt = timeouts.statement_timeout;
    if (!isValidPgTimeoutValue(stmt)) {
      throw new Error(`非法 statement_timeout (拒绝注入): ${String(stmt)}`);
    }
    await client.query(`SET statement_timeout = '${stmt}'`);
  }
}

/**
 * Create a SqlClient over the given URI. Caller MUST `await client.release()`
 * to close the TCP connection when done (no-op for Neon HTTP driver, required
 * for pg).
 *
 * `timeouts` (feat-030/#79 · from the pipeline's inject_timeout verdict) injects
 * lock_timeout (+ optional statement_timeout) before any query runs:
 * - pg TCP path (this PR): session-level `SET` on the persistent connection.
 * - Neon Cloud HTTP path: transaction-wrapped `SET LOCAL` is feat-030/#80 (stateless
 *   single-shot requests can't carry a session SET reliably) · not injected here yet.
 */
export async function createSqlClient(
  uri: string,
  timeouts?: TimeoutSpec,
): Promise<SqlClient> {
  if (isLocalPgUri(uri)) {
    const client = new PgClient({ connectionString: uri });
    await client.connect();
    if (timeouts) {
      await injectPgTimeouts(client, timeouts);
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
      return (await neonSql.query(sql, params ?? [])) as Array<
        Record<string, unknown>
      >;
    },
    release: async () => {
      // Neon HTTP driver is stateless · nothing to release.
    },
  };
}

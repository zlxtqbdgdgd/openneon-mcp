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
 * Create a SqlClient over the given URI. Caller MUST `await client.release()`
 * to close the TCP connection when done (no-op for Neon HTTP driver, required
 * for pg).
 */
export async function createSqlClient(uri: string): Promise<SqlClient> {
  if (isLocalPgUri(uri)) {
    const client = new PgClient({ connectionString: uri });
    await client.connect();
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

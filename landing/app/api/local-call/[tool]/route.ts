/**
 * OAuth-free local development endpoint for invoking MCP tool handlers directly.
 *
 * GATED on `process.env.NEON_LOCAL_URL`: when this env var is NOT set, every
 * request returns 404. Production deploys must never set `NEON_LOCAL_URL`. The
 * same env var also short-circuits `handleGetConnectionString` and routes the
 * SQL driver to plain TCP `pg` (see `mcp-src/tools/handlers/sql-driver.ts`).
 *
 * Purpose: day-one L1 testing on a self-hosted neon_local cluster (dev server
 * `127.0.0.1:55432`). Bypasses the OAuth bearer-token + Neon Cloud Management
 * API path that production MCP clients (Claude Desktop, Cursor, ...) traverse,
 * letting `curl` exercise the same handler code paths the MCP server would.
 *
 * Usage:
 *   POST /api/local-call/get_neondb_schemas
 *   Content-Type: application/json
 *   Body: { "filter": "sales" }            // becomes handler's `params`
 *
 * Response is the handler's raw return value (typically MCP tool response shape
 * `{ content: [{ type: 'text', text: '...' }] }`).
 */

import { NextResponse } from 'next/server';
import type { Api } from '@neondatabase/api-client';
import { NEON_HANDLERS } from '../../../../mcp-src/tools/tools';
import { DEFAULT_GRANT } from '../../../../mcp-src/utils/grant-context';
import type { ToolHandlerExtraParams } from '../../../../mcp-src/tools/types';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const NOT_FOUND_BODY = {
  error: 'local-call disabled · set NEON_LOCAL_URL env to enable',
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tool: string }> },
) {
  if (!process.env.NEON_LOCAL_URL) {
    return NextResponse.json(NOT_FOUND_BODY, {
      status: 404,
      headers: CORS_HEADERS,
    });
  }

  const { tool } = await params;
  const handlerMap = NEON_HANDLERS as unknown as Record<
    string,
    (
      args: { params: Record<string, unknown> },
      neonClient: Api<unknown>,
      extra: ToolHandlerExtraParams,
    ) => Promise<unknown>
  >;
  const handler = handlerMap[tool];
  if (!handler) {
    return NextResponse.json(
      { error: `unknown tool: ${tool}` },
      { status: 404, headers: CORS_HEADERS },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // The neonClient is never invoked when NEON_LOCAL_URL is set
  // (connection-string handler short-circuits) · pass an empty stub.
  const fakeNeonClient = {} as unknown as Api<unknown>;
  const fakeExtra = {
    authInfo: {
      extra: {
        apiKey: 'local-dev',
        account: { id: 'local-dev', name: 'local-dev' },
        readOnly: false,
        grant: DEFAULT_GRANT,
      },
    },
    readOnly: false,
    account: { id: 'local-dev', name: 'local-dev' },
    clientApplication: 'other' as const,
  } as unknown as ToolHandlerExtraParams;

  try {
    const result = await handler({ params: body }, fakeNeonClient, fakeExtra);
    return NextResponse.json(result, { headers: CORS_HEADERS });
  } catch (e: unknown) {
    const err = e as { message?: string; name?: string };
    return NextResponse.json(
      { error: err.message ?? String(e), name: err.name },
      { status: 400, headers: CORS_HEADERS },
    );
  }
}

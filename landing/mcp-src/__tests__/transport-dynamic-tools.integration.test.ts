import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantContext } from '../utils/grant-context';

const { runSqlSpy } = vi.hoisted(() => ({
  runSqlSpy: vi.fn(async ({ params }: { params: Record<string, unknown> }) => ({
    content: [{ type: 'text', text: JSON.stringify(params) }],
  })),
}));

vi.mock('../oauth/model', () => ({
  model: {
    getAccessToken: vi.fn(),
  },
}));

vi.mock('../tools/index', async () => {
  const actual =
    await vi.importActual<typeof import('../tools/index')>('../tools/index');
  const actualHandlers =
    await vi.importActual<typeof import('../tools/tools')>('../tools/tools');
  return {
    ...actual,
    NEON_HANDLERS: {
      ...actualHandlers.NEON_HANDLERS,
      run_sql: runSqlSpy,
    },
  };
});

vi.mock('../analytics/analytics', () => ({
  track: vi.fn(),
  flushAnalytics: vi.fn().mockResolvedValue(undefined),
}));

// feat-060/#2-#3 (92a3b43): the dispatch path now runs the claim-binding
// middleware before the tool handler. run_sql declares a `fromClaim` binding in
// the side-table, so a project-scoped call against a project with no configured
// authServices is denied (PROJECT_HAS_NO_AUTH_SERVICE · fail-closed) and never
// reaches the handler. This composition test only exercises projectId injection
// by variant — claim binding is an orthogonal concern with its own dedicated
// suites (feat-060-claim-binding / feat-060-run-sql-claim-check). Returning no
// fromClaim declarations here takes bindClaims' first-line bypass branch
// (outcome: 'pass') so dispatch proceeds to the (mocked) run_sql handler.
vi.mock('../auth/tool-claim-bindings', () => ({
  getToolClaimBindings: vi.fn(() => undefined),
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    silent: false,
  },
}));

const { model } = await import('../oauth/model');
const { POST } = await import('../../app/api/[transport]/route');

type TokenShape = {
  accessToken: string;
  scope: string;
  client: { id: string; client_name: string; grants: string[] };
  user: { id: string; name: string; email: string };
  grant?: GrantContext;
};

function buildOAuthToken(
  accessToken: string,
  scope: string,
  grant?: GrantContext,
): TokenShape {
  return {
    accessToken,
    scope,
    client: { id: 'client-1', client_name: 'Cursor', grants: ['*'] },
    user: { id: 'user-1', name: 'User', email: 'user@example.com' },
    grant,
  };
}

// feat-072/#216+#218 (ADR-0019): the remote transport is now **stateful**
// Streamable HTTP — initialize returns an Mcp-Session-Id and subsequent requests
// MUST carry it. mcpCall threads the session id in/out; openSession() below does
// the initialize → notifications/initialized handshake and returns the sid.
async function mcpCall(
  bearerToken: string,
  method: string,
  id: number | undefined,
  params?: unknown,
  queryString = '',
  sessionId?: string,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
    headers['mcp-protocol-version'] = '2025-03-26';
  }
  const req = new Request(`http://localhost/api/mcp${queryString}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params ? { params } : {}),
    }),
  });

  const res = await POST(req);
  const sessionIdOut = res.headers.get('mcp-session-id') ?? sessionId;
  const raw = await res.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    const dataLines = raw
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length).trim());
    const lastDataLine = dataLines[dataLines.length - 1];
    if (lastDataLine) {
      try {
        body = JSON.parse(lastDataLine);
      } catch {
        // Keep raw text for debugging/assertions
      }
    }
  }
  return { status: res.status, body, sessionId: sessionIdOut };
}

// feat-005 #3 (47bc1e7): tools/list defaults to the `core` listing tier (4
// day-one tools) so the agent's listing budget isn't crowded out by the full
// 30+ tool surface. Optional tools (run_sql, create_project, etc.) only appear
// when the caller opts into the full surface with `?include=all`. These
// integration tests exercise the full toolset, so they pass `?include=all` on
// every request (initialize + tools/list + tools/call) — the per-request
// StaticToolContext is rebuilt from the URL query on each POST, so the include
// tier must be set consistently across the whole sequence for both the listing
// and the registered (callable) handler set to include the optional tools.
const INCLUDE_ALL = '?include=all';

async function openSession(token: string, queryString = INCLUDE_ALL) {
  const init = await mcpCall(
    token,
    'initialize',
    1,
    {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
    queryString,
  );
  const sessionId = init.sessionId;
  if (!sessionId) {
    throw new Error(
      `initialize did not return an Mcp-Session-Id: ${JSON.stringify(init.body)}`,
    );
  }
  await mcpCall(
    token,
    'notifications/initialized',
    undefined,
    undefined,
    queryString,
    sessionId,
  );
  return sessionId;
}

async function listToolsForToken(token: string, queryString = INCLUDE_ALL) {
  const sessionId = await openSession(token, queryString);

  const list = await mcpCall(
    token,
    'tools/list',
    2,
    {},
    queryString,
    sessionId,
  );
  if (list.status !== 200) {
    throw new Error(
      `tools/list failed with status ${list.status}: ${JSON.stringify(list.body)}`,
    );
  }
  expect(list.status).toBe(200);
  const listBody = list.body as {
    error?: unknown;
    result: { tools: unknown[] };
  };
  expect(listBody.error).toBeUndefined();
  return listBody.result.tools as Array<{
    name: string;
    inputSchema: { properties?: Record<string, unknown> };
  }>;
}

describe('transport dynamic tool composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSqlSpy.mockClear();
  });

  it('keeps same tool names and enforces projectId by selected variant', async () => {
    const unscopedToken = 'oauth-unscoped';
    const scopedToken = 'oauth-scoped';

    vi.mocked(model.getAccessToken).mockImplementation(async (token) => {
      if (token === unscopedToken) {
        return buildOAuthToken(unscopedToken, 'read write', {
          projectId: null,
          scopes: null,
        });
      }
      if (token === scopedToken) {
        return buildOAuthToken(scopedToken, 'read write', {
          projectId: 'proj_123',
          scopes: null,
        });
      }
      return undefined;
    });

    const unscopedTools = await listToolsForToken(unscopedToken);
    const scopedTools = await listToolsForToken(scopedToken);

    const unscopedNames = new Set(unscopedTools.map((t) => t.name));
    const scopedNames = new Set(scopedTools.map((t) => t.name));

    expect(unscopedNames.has('run_sql')).toBe(true);
    expect(scopedNames.has('run_sql')).toBe(true);
    expect(scopedNames.has('list_projects')).toBe(false);

    // Unscoped variant still requires projectId from caller -> handler should not run.
    const unscopedSid = await openSession(unscopedToken, INCLUDE_ALL);
    await mcpCall(
      unscopedToken,
      'tools/call',
      3,
      {
        name: 'run_sql',
        arguments: { sql: 'select 1' },
      },
      INCLUDE_ALL,
      unscopedSid,
    );
    expect(runSqlSpy).toHaveBeenCalledTimes(0);

    // Project-scoped variant injects projectId from auth grant -> handler runs.
    const scopedSid = await openSession(scopedToken, INCLUDE_ALL);
    await mcpCall(
      scopedToken,
      'tools/call',
      4,
      {
        name: 'run_sql',
        arguments: { sql: 'select 1' },
      },
      INCLUDE_ALL,
      scopedSid,
    );
    expect(runSqlSpy).toHaveBeenCalledTimes(1);
  });

  it('isolates cached handlers by auth context key', async () => {
    const fullAccessToken = 'oauth-full';
    const readOnlyToken = 'oauth-read-only';

    vi.mocked(model.getAccessToken).mockImplementation(async (token) => {
      if (token === fullAccessToken) {
        return buildOAuthToken(fullAccessToken, 'read write');
      }
      if (token === readOnlyToken) {
        return buildOAuthToken(readOnlyToken, 'read');
      }
      return undefined;
    });

    const fullAccessTools = await listToolsForToken(fullAccessToken);
    const readOnlyTools = await listToolsForToken(readOnlyToken);

    const fullNames = new Set(fullAccessTools.map((t) => t.name));
    const readOnlyNames = new Set(readOnlyTools.map((t) => t.name));

    expect(fullNames.has('create_project')).toBe(true);
    expect(readOnlyNames.has('create_project')).toBe(false);
    expect(readOnlyNames.has('list_projects')).toBe(true);
  });

  it('ignores runtime URL grant params for OAuth tokens', async () => {
    const oauthToken = 'oauth-unscoped-with-query';

    vi.mocked(model.getAccessToken).mockResolvedValue(
      buildOAuthToken(oauthToken, 'read write', {
        projectId: null,
        scopes: null,
      }) as never,
    );

    const sid = await openSession(oauthToken, '?projectId=proj_123');

    await mcpCall(
      oauthToken,
      'tools/call',
      11,
      {
        name: 'run_sql',
        arguments: { sql: 'select 1' },
      },
      '?projectId=proj_123',
      sid,
    );

    // If query params were merged at runtime, run_sql would receive injected projectId.
    // OAuth must only use the grant persisted from authorize/token flow.
    expect(runSqlSpy).toHaveBeenCalledTimes(0);
  });

  it('ignores runtime readonly query param for OAuth tokens', async () => {
    const readOnlyToken = 'oauth-readonly-with-query';

    vi.mocked(model.getAccessToken).mockResolvedValue(
      buildOAuthToken(readOnlyToken, 'read') as never,
    );

    const sid = await openSession(readOnlyToken, '?readonly=false');

    const list = await mcpCall(
      readOnlyToken,
      'tools/list',
      21,
      {},
      '?readonly=false',
      sid,
    );
    expect(list.status).toBe(200);

    const listBody = list.body as {
      error?: unknown;
      result: { tools: Array<{ name: string }> };
    };
    expect(listBody.error).toBeUndefined();

    const toolNames = new Set(listBody.result.tools.map((t) => t.name));
    // If readonly query params overrode OAuth scopes, this would appear.
    expect(toolNames.has('create_project')).toBe(false);
  });

  it('emits resource_metadata for the exact requested resource path and query', async () => {
    vi.mocked(model.getAccessToken).mockResolvedValue(undefined);

    const req = new Request('http://localhost:3100/mcp?readonly=true', {
      method: 'POST',
      headers: {
        host: 'localhost:3100',
        Authorization: 'Bearer invalid-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/list',
        params: {},
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const challenge = res.headers.get('WWW-Authenticate');
    expect(challenge).toContain(
      'resource_metadata="https://localhost:3100/.well-known/oauth-protected-resource/mcp?readonly=true"',
    );
  });

  it('?category=docs bypasses OAuth without an Authorization header', async () => {
    // Critical contract: the docs-only branch in handleRequest routes the
    // request to the no-auth handler and never consults model.getAccessToken.
    // A regression that removes the bypass or routes through authHandler
    // would surface here as a 401 with WWW-Authenticate set.
    const getAccessTokenMock = vi.mocked(model.getAccessToken);
    getAccessTokenMock.mockReset();

    const req = new Request('http://localhost/api/mcp?category=docs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'docs-only-integration', version: '1.0.0' },
        },
      }),
    });

    const res = await POST(req);

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    expect(getAccessTokenMock).not.toHaveBeenCalled();
  });
});

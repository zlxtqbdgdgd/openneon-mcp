// feat-072/#216 (ADR-0019): 远程**有状态** Streamable HTTP transport（裸 SDK · 取代
// mcp-handler 的无状态 streamable 路径）。
//
// 为什么有状态：单 `/mcp` 端点用 SDK 的 `WebStandardStreamableHTTPServerTransport`
// （`sessionIdGenerator` 生成 session id），McpServer 按 session 持久 → GET 侧
// server→client SSE 流可用 → feat-027 的 `elicitInput` 人工审批在同端点透传（不再
// 需要切到独立 SSE + redis）。因为 server 实例不再每请求重建，issue #100 的
// capability-cache / redis workaround 这里不需要：`getClientCapabilities()` 在
// initialize 握手后自然有值。
//
// 仅在常驻 server 上正确（内存 session 跨请求存活）——见 ADR-0019 §3 部署形态。
// OAuth 仍由上游 `withMcpAuth` 解析（设 `req.auth`），本模块只接 transport：把
// `req.auth` 经 handleRequest 的 `authInfo` 选项穿给 tool handler 的 `extra`。
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import {
  registerNeonServer,
  type StaticToolContext,
  type AuthenticatedExtra,
  type ResolvedAuthContext,
} from './register-neon-server';
import { type ElicitResultLike } from '../policy/stages/plan-mode';
import { createNeonClient } from './api';
import { detectClientApplication } from '../utils/client-application';
import { DEFAULT_GRANT } from '../utils/grant-context';
import { logger } from '../utils/logger';
import { track, flushAnalytics } from '../analytics/analytics';
import { waitUntil } from '@vercel/functions';
import type { ServerContext } from '../types/context';
import pkg from '../../package.json';

type SessionEntry = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
};

// Module-level session store. Persists across requests on a long-running server
// (the deployment form ADR-0019 §3 mandates). Keyed by Mcp-Session-Id.
const sessions = new Map<string, SessionEntry>();

// Per-call auth context from the request's authInfo.extra (set by verifyToken via
// withMcpAuth). Simplified vs the legacy SSE getAuthContext — no capability-cache
// (stateful session keeps client capabilities live).
function deriveAuthContext(extra: AuthenticatedExtra): ResolvedAuthContext {
  const authInfo = extra.authInfo;
  if (!authInfo?.extra?.apiKey || !authInfo?.extra?.account) {
    throw new Error('Authentication required');
  }
  const apiKey = authInfo.extra.apiKey;
  const account = authInfo.extra.account;
  const readOnly = authInfo.extra.readOnly ?? false;
  const grant = { ...(authInfo.extra.grant ?? DEFAULT_GRANT) };
  const client = authInfo.extra.client;
  const clientName = authInfo.extra.userAgent ?? 'unknown';
  const clientApplication = detectClientApplication(clientName);
  const neonClient = createNeonClient(apiKey);

  const context: ServerContext = {
    apiKey,
    account,
    client,
    readOnly,
    grant,
    app: {
      name: 'mcp-server-neon',
      transport: 'stream',
      environment: (process.env.NODE_ENV ??
        'production') as ServerContext['app']['environment'],
      version: pkg.version,
    },
  };

  return {
    apiKey,
    account,
    readOnly,
    grant,
    neonClient,
    clientApplication,
    clientName,
    client,
    context,
  };
}

// Build a fresh McpServer for a session, registering the full Neon surface
// through the shared pipeline (registerNeonServer) with the real client
// elicitInput injected as the approval strategy.
function buildSessionServer(staticToolContext: StaticToolContext): McpServer {
  const server = new McpServer(
    { name: 'mcp-server-neon', version: pkg.version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: { listChanged: true },
      },
    },
  );

  let trackedInit = false;
  const trackServerInit = (context: ServerContext) => {
    if (trackedInit) return;
    trackedInit = true;
    const grant = context.grant ?? DEFAULT_GRANT;
    track({
      userId: context.account.id,
      event: 'server_init',
      properties: {
        readOnly: String(context.readOnly ?? false),
        projectScoped: String(!!grant.projectId),
        customScopes: grant.scopes?.join(',') ?? 'all',
        transport: 'stream',
      },
      context: { client: context.client, app: context.app },
    });
    waitUntil(flushAnalytics());
  };

  registerNeonServer(server, {
    staticToolContext,
    getAuthContext: async (extra) => deriveAuthContext(extra),
    trackServerInit,
    // No SSE envelope cross-binding on the streamable path → never short-circuit.
    checkEnvelopeMatches: () => false,
    elicit: async (message, requestedSchema, timeoutMs) => {
      const res = await server.server.elicitInput(
        { message, requestedSchema } as never,
        { timeout: timeoutMs },
      );
      return {
        action: res.action,
        content: res.content,
      } as ElicitResultLike;
    },
  });

  return server;
}

// Handle one Streamable HTTP request on the stateful path. New sessions
// (initialize / no session id) spin up a fresh transport+server; subsequent
// requests reuse the session's transport by Mcp-Session-Id.
export async function handleStatefulStreamableHttp(
  req: Request,
  staticToolContext: StaticToolContext,
): Promise<Response> {
  const authInfo = (req as Request & { auth?: AuthInfo }).auth;
  const sessionId = req.headers.get('mcp-session-id');

  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    return existing.transport.handleRequest(req, { authInfo });
  }

  // New session (initialize) — or an unknown id, which the transport rejects
  // per spec (404 for non-initialize without a known session).
  const server = buildSessionServer(staticToolContext);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId: string) => {
      sessions.set(newSessionId, { server, transport });
      logger.info('streamable-http session initialized', {
        sessionId: newSessionId,
      });
    },
    onsessionclosed: (closedSessionId: string) => {
      sessions.delete(closedSessionId);
      void server.close();
      logger.info('streamable-http session closed', {
        sessionId: closedSessionId,
      });
    },
  });

  await server.connect(transport);
  return transport.handleRequest(req, { authInfo });
}

// Initialize Sentry (must be first import)
import '../../../mcp-src/sentry/instrument';
// Initialize OTel (feat-031 · audit event OTLP HTTP exporter · honors OTEL_SDK_DISABLED)
import { initOtel } from '../../../mcp-src/observability/otel-init';
initOtel();

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidTokenError,
  InsufficientScopeError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { startSpan } from '@sentry/node';

import {
  getParserBackend,
  initPgParser,
} from '../../../mcp-src/protection/destructive-detector';
import { emitAuditEvent } from '../../../mcp-src/observability/audit-emit';
import {
  getDocResource,
  listDocsResources,
} from '../../../mcp-src/tools/handlers/docs';
import { createNeonClient } from '../../../mcp-src/server/api';
import pkg from '../../../package.json';
import { handleToolError } from '../../../mcp-src/server/errors';
import { isReadOnly } from '../../../mcp-src/utils/read-only';
import { logger } from '../../../mcp-src/utils/logger';
import { generateTraceId } from '../../../mcp-src/utils/trace';
import { waitUntil } from '@vercel/functions';
import { track, flushAnalytics } from '../../../mcp-src/analytics/analytics';
import { resolveAccountFromAuth } from '../../../mcp-src/server/account';
import { model } from '../../../mcp-src/oauth/model';
import { getApiKeys, type ApiKeyRecord } from '../../../mcp-src/oauth/kv-store';
import type { AppContext } from '../../../mcp-src/types/context';
import {
  isDocsOnlyRequest,
  resolveGrantFromSearchParams,
  resolveGrantFromToken,
  DEFAULT_GRANT,
  type GrantContext,
} from '../../../mcp-src/utils/grant-context';
import {
  resolveKeyScope,
  KeyResolverError,
  keyLast4,
  type KeyScope,
} from '../../../mcp-src/auth/key-resolver';
import {
  buildGrantFromScope,
  mergeResolvedGrant,
  KeyNotAcceptedError,
  type ResolvedGrant,
} from '../../../mcp-src/auth/grant-builder';
import {
  isLocalDevAuthEnabled,
  buildLocalDevAuthInfo,
} from '../../../mcp-src/server/local-dev-auth';
import { parseCategoryInclude } from '../../../mcp-src/config/categories';
import { NEON_TOOLS } from '../../../mcp-src/tools/definitions';
import { assert } from '../../../lib/assert';
import { type StaticToolContext } from '../../../mcp-src/server/register-neon-server';
import { handleStatefulStreamableHttp } from '../../../mcp-src/server/streamable-http-transport';
import { buildResourceMetadataUrlForResourceRequest } from '../../../lib/oauth/protected-resource-metadata';

// feat-072/#218 part2 (ADR-0019): `req.auth` carries the verified OAuth identity
// set by the self-implemented withOAuth gate — previously provided by
// mcp-handler's global Request augmentation, which went away with the dependency.
declare global {
  // Global augmentation requires interface (declaration merging) — `type` cannot
  // augment the built-in Request, so the repo's prefer-`type` rule is N/A here.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Request {
    auth?: AuthInfo;
  }
}

const ROUTE_PATHS = {
  apiBase: '/api',
  canonicalMcp: '/api/mcp',
  canonicalSse: '/api/sse',
  legacyMcp: '/mcp',
  legacySse: '/sse',
} as const;

const JSON_RESPONSE_HEADERS = { 'Content-Type': 'application/json' } as const;

const HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  serviceUnavailable: 503,
} as const;

const PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource';

// The docs-only handler bypasses OAuth entirely. It only registers tools
// scoped to the `docs` category, which currently fetch from neon.com via
// global fetch and never touch the Neon API client. We deliberately avoid
// going through `getAvailableTools` / `grant-filter` here so the
// "always available" search/fetch tools (which require Neon API auth) are
// not surfaced anonymously.
const DOCS_ONLY_TOOLS = NEON_TOOLS.filter((tool) => tool.scope === 'docs');
function getDocsOnlyToolDefinition(
  name: 'list_docs_resources' | 'get_doc_resource',
) {
  const tool = DOCS_ONLY_TOOLS.find((tool) => tool.name === name);
  assert(tool, `${name} tool definition not found`);
  return tool;
}

const listDocsResourcesTool = getDocsOnlyToolDefinition('list_docs_resources');
const getDocResourceTool = getDocsOnlyToolDefinition('get_doc_resource');

const ANONYMOUS_DOCS_USER_ID = 'anonymous-docs';

const docsOnlyAppContext: AppContext = {
  name: 'mcp-server-neon',
  transport: 'stream',
  environment: (process.env.NODE_ENV ??
    'production') as AppContext['environment'],
  version: pkg.version,
};

function buildDocsOnlyServer(): McpServer {
  const server = new McpServer(
    { name: 'mcp-server-neon', version: pkg.version },
    { capabilities: { tools: {} } },
  );
  async function runDocsTool(
    toolName: 'list_docs_resources' | 'get_doc_resource',
    call: () => Promise<string>,
  ) {
    const traceId = generateTraceId();
    return await startSpan(
      {
        name: 'tool_call',
        attributes: {
          tool_name: toolName,
          trace_id: traceId,
          docs_only: true,
        },
      },
      async (span) => {
        const properties = {
          tool_name: toolName,
          readOnly: 'true',
          projectScoped: 'false',
          clientName: 'anonymous-docs',
          traceId,
          docsOnly: 'true',
        };

        logger.info('tool call (docs-only):', properties);

        track({
          anonymousId: ANONYMOUS_DOCS_USER_ID,
          event: 'tool_call',
          properties,
          context: { app: docsOnlyAppContext },
        });
        waitUntil(flushAnalytics());

        try {
          const text = await call();
          return {
            content: [
              {
                type: 'text' as const,
                text,
              },
            ],
          };
        } catch (error) {
          span.setStatus({ code: 2 });
          const errorResult = handleToolError(error, properties, traceId);
          logger.warn('tool error response (docs-only):', {
            ...properties,
            isError: true,
            contentLength: errorResult.content?.length,
            firstContentType: errorResult.content?.[0]?.type,
          });
          return errorResult;
        }
      },
    );
  }

  server.registerTool(
    listDocsResourcesTool.name,
    {
      description: listDocsResourcesTool.description,
      inputSchema: listDocsResourcesTool.inputSchema,
      annotations: listDocsResourcesTool.annotations,
    },
    async () =>
      runDocsTool(listDocsResourcesTool.name, () => listDocsResources()),
  );

  server.registerTool(
    getDocResourceTool.name,
    {
      description: getDocResourceTool.description,
      inputSchema: getDocResourceTool.inputSchema,
      annotations: getDocResourceTool.annotations,
    },
    async (args: { slug: string }) =>
      runDocsTool(getDocResourceTool.name, () =>
        getDocResource({ slug: args.slug }),
      ),
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = DOCS_ONLY_TOOLS.map((tool) => {
      const normalizedSchema = normalizeObjectSchema(tool.inputSchema);
      const inputSchema = normalizedSchema
        ? toJsonSchemaCompat(normalizedSchema, {
            strictUnions: true,
            pipeStrategy: 'input',
          })
        : { type: 'object' as const };

      return {
        name: tool.name,
        title: tool.annotations?.title,
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
      };
    });

    return { tools };
  });
  return server;
}

async function handleDocsOnly(req: Request): Promise<Response> {
  const server = buildDocsOnlyServer();
  // docs-only is anonymous + simple → stateless transport (sessionIdGenerator
  // undefined), fresh server+transport per request (no cross-request sharing).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

// Cache TTL for API key verification (5 minutes)
// Balances security (revoked keys stop working soon) with performance (reduce API calls)
const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

// Helper: Fetch and cache API key details
const fetchAccountDetails = async (
  accessToken: string,
): Promise<ApiKeyRecord | null> => {
  // 1. Check cache first
  try {
    const cached = await getApiKeys().get(accessToken);
    if (cached) {
      logger.info('API key cache hit', { accountId: cached.account.id });
      // feat-029/#2: 历史 cache 可能缺 keyScope (本字段在 feat-029 ship 前不存在) ·
      // 让 caller 自己兜底 re-resolve 一次 · 不在这里阻塞 cache hit 路径。
      return cached;
    }
  } catch (error) {
    logger.warn('API key cache read failed', { error });
  }

  // 2. Cache miss - verify with Neon API
  try {
    const neonClient = createNeonClient(accessToken);
    const { data: auth } = await neonClient.getAuthDetails();

    // Use shared account resolution with identify on cache miss
    const account = await resolveAccountFromAuth(auth, neonClient, {
      context: { authMethod: auth.auth_method },
    });

    // feat-029/#2: cache miss 顺手解析 key scope · 同期写进 cache · 避免后续每请求重复打 Neon API。
    // resolveKeyScope 抛 KeyResolverError 在外层 catch 兜底成 null（fail-closed · withMcpAuth 401）。
    const keyScope = await resolveKeyScope(neonClient, accessToken);

    const record: ApiKeyRecord = {
      apiKey: accessToken,
      authMethod: auth.auth_method,
      account,
      keyScope,
    };

    // 4. Save to cache with TTL (non-blocking)
    waitUntil(
      getApiKeys()
        .set(accessToken, record, API_KEY_CACHE_TTL_MS)
        .catch((err) => {
          logger.warn('API key cache write failed', { err });
        }),
    );

    logger.info('API key cache miss, verified and cached', {
      accountId: account.id,
      keyType: keyScope.keyType,
      last4: keyScope.last4,
    });
    return record;
  } catch (error) {
    const axiosError = error as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    // feat-029/#3: 启动期 / 鉴权期 fail-closed audit · 区分 KeyResolverError 各 code 给运维定位。
    if (error instanceof KeyResolverError) {
      logger.error('API key scope resolve failed (feat-029 fail-closed)', {
        code: error.code,
        message: error.message,
        httpStatus: error.httpStatus,
        last4: keyLast4(accessToken),
        outcome: 'reject_key_resolve_failed',
      });
      return null;
    }
    logger.error('API key verification failed', {
      message: axiosError.message,
      status: axiosError.response?.status,
      data: axiosError.response?.data,
    });
    return null;
  }
};

// Token verification function with two paths (OAuth tokens + API keys)
/**
 * feat-060/#2 (#130): 扫描 request headers 抓所有 \`MCP-Auth-<authService>\` 形态的 JWT ·
 * 返 {<authService 名 (小写)> → JWT} 字典 · 给 claim-binding middleware 用。
 *
 * header 名跟 Google MCP Toolbox 同源 · authService 名跟 policy.yaml authServices 字典 key 一致。
 * 大小写不敏感 (HTTP 规范) · 此处统一小写 key。
 */
function extractMcpAuthHeaders(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  // Next.js Request.headers 是 Headers (web standard) · 用 forEach iterate
  req.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('mcp-auth-') && value.length > 0) {
      // key 保留 \`mcp-auth-<service>\` 全名 (claim-binding extractJwt 也用全名匹配)
      result[lower] = value;
    }
  });
  return result;
}

const verifyToken = async (
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  const userAgent = req.headers.get('user-agent') || undefined;
  const readOnlyHeader = req.headers.get('x-read-only');
  // feat-060/#2 (#130): 捕获所有 MCP-Auth-<authService> headers · 后续 tool dispatch 时给 bindClaims 用
  const mcpAuthHeaders = extractMcpAuthHeaders(req);

  logger.info('verifyToken called', {
    hasBearerToken: !!bearerToken,
    bearerTokenLength: bearerToken?.length ?? 0,
    tokenPrefix: bearerToken?.substring(0, 10) ?? 'none',
    userAgent,
  });

  // 自托管 dev auth 旁路: NEON_LOCAL_URL set (neon_local · 非生产) → 跳过 Neon Cloud 鉴权 ·
  // 返回 synthetic 本地身份。危险操作仍由 feat-056 pipeline (policy.yaml + hard-deny) 把关 ·
  // 严格 env-gate (production 绝不 set NEON_LOCAL_URL · 同 feat-062 local-call)。
  if (isLocalDevAuthEnabled()) {
    logger.warn(
      'verifyToken · self-hosted dev auth bypass (NEON_LOCAL_URL · no Neon Cloud auth)',
    );
    return buildLocalDevAuthInfo(req, bearerToken, userAgent);
  }

  if (!bearerToken) {
    return undefined;
  }

  // Detect transport from URL pathname and parse query params
  const url = new URL(req.url);
  const transport: AppContext['transport'] =
    url.pathname === ROUTE_PATHS.canonicalMcp ||
    url.pathname === ROUTE_PATHS.legacyMcp
      ? 'stream'
      : 'sse';

  const searchParams = url.searchParams;
  const readOnlyQueryParam = searchParams.get('readonly');

  // ============================================
  // PATH 1: Check OAuth tokens table FIRST
  // (For users who authenticated via OAuth flow)
  // ============================================
  try {
    const token = await model.getAccessToken(bearerToken);
    if (token) {
      // Expiration is checked by withMcpAuth using expiresAt field
      // which returns proper RFC-compliant 401 with WWW-Authenticate header

      logger.info('OAuth token found', { clientId: token.client.id });

      const tokenGrant = resolveGrantFromToken(
        token as { grant?: GrantContext },
      );

      const readOnly = isReadOnly({
        scope: token.scope,
      });

      // Return auth from stored token (0 API calls!)
      return {
        token: token.accessToken,
        scopes: Array.isArray(token.scope)
          ? token.scope
          : (token.scope?.split(' ') ?? ['read', 'write']),
        clientId: token.client.id,
        expiresAt: token.expires_at
          ? Math.floor(token.expires_at / 1000)
          : undefined,
        extra: {
          account: {
            id: token.user.id,
            name: token.user.name,
            email: token.user.email,
            isOrg: token.user.isOrg ?? false,
          },
          apiKey: bearerToken,
          readOnly,
          grant: tokenGrant,
          client: {
            id: token.client.id,
            name: token.client.client_name,
          },
          transport,
          userAgent,
          // feat-060/#2 (#130): forward MCP-Auth-* headers 给 claim-binding
          mcpAuthHeaders,
        },
      };
    }
  } catch (error) {
    logger.warn('OAuth token lookup failed, trying API key path', { error });
  }

  // ============================================
  // PATH 2: Not an OAuth token - try API key
  // (For direct API key usage)
  // ============================================
  logger.info('Trying API key verification path', {
    tokenPrefix: bearerToken.substring(0, 10),
  });

  const apiKeyRecord = await fetchAccountDetails(bearerToken);
  if (!apiKeyRecord) {
    return undefined;
  }

  const readOnly = isReadOnly({
    queryParamValue: readOnlyQueryParam,
    headerValue: readOnlyHeader,
  });
  const urlGrant = resolveGrantFromSearchParams(searchParams);

  // feat-029/#2-#3: 把已解析的 keyScope 翻译成 ResolvedGrant + 应用 policy gate
  // (ALLOW_NON_PROJECT_KEY default false rejects personal/org · feat-029 §4)。
  // 历史 cache 可能缺 keyScope（pre-feat-029 写入）· 缺则 re-resolve 一次（fail-closed if 失败）。
  let keyScope: KeyScope | undefined = apiKeyRecord.keyScope;
  if (!keyScope) {
    try {
      const neonClient = createNeonClient(bearerToken);
      keyScope = await resolveKeyScope(neonClient, bearerToken);
      logger.info('API key scope re-resolved for legacy cache record', {
        accountId: apiKeyRecord.account.id,
        keyType: keyScope.keyType,
        last4: keyScope.last4,
      });
    } catch (error) {
      if (error instanceof KeyResolverError) {
        logger.error('API key scope re-resolve failed (feat-029 fail-closed)', {
          code: error.code,
          message: error.message,
          last4: keyLast4(bearerToken),
          outcome: 'reject_key_resolve_failed',
        });
      } else {
        logger.error('API key scope re-resolve unexpected error', { error });
      }
      return undefined; // fail-closed
    }
  }

  let resolvedGrant: ResolvedGrant;
  try {
    resolvedGrant = buildGrantFromScope(keyScope);
  } catch (error) {
    if (error instanceof KeyNotAcceptedError) {
      // feat-029/#3 audit event · key_type + last4 + outcome 全字段
      logger.warn('mcp Server rejected non-project key (feat-029)', {
        keyType: error.keyType,
        last4: error.last4,
        outcome: error.outcome,
        reason: error.message,
      });
      // feat-031: 鉴权期非项目级 key fail-closed deny (g1_cross_project_deny · §3.2 a)
      // 补必填四件套的 op_class:此 deny 由 G1 跨 project 判定触发 → CROSS_PROJECT
      // (OpClass enum · 非 SQL 内容判 · 跟 pipeline G1 stage 同语义)。
      emitAuditEvent({
        event_type: 'g1_cross_project_deny',
        outcome: 'deny',
        op_class: 'CROSS_PROJECT',
        principal: `agent:${error.last4 ?? 'unknown'}`,
        severity: 'high',
        key_type:
          error.keyType === 'personal' ||
          error.keyType === 'org' ||
          error.keyType === 'project-scoped'
            ? error.keyType
            : undefined,
        last_4: error.last4,
        extra: { 'openneon.audit.deny_reason': error.message },
      });
      return undefined; // fail-closed → withMcpAuth returns 401
    }
    throw error;
  }
  const grant = mergeResolvedGrant(resolvedGrant, urlGrant);

  return {
    token: bearerToken,
    scopes: ['*'], // API keys get all scopes
    clientId: 'api-key', // Literal string
    extra: {
      account: apiKeyRecord.account,
      apiKey: bearerToken,
      readOnly,
      grant,
      transport,
      userAgent,
      // feat-060/#2 (#130): forward MCP-Auth-* headers 给 claim-binding
      mcpAuthHeaders,
    },
  };
};

function getStaticToolContext(req: Request): StaticToolContext {
  const authInfo = req.auth;
  const authExtra = authInfo?.extra;
  const grantFromAuth = authExtra?.grant as Partial<GrantContext> | undefined;
  // Backward compatibility: older tokens may not have persisted grant context.
  // Remove this DEFAULT_GRANT fallback once all active tokens are guaranteed to include grant.
  // Then replace with assert(grantFromAuth, 'grantFromAuth is required');
  const grant: GrantContext =
    grantFromAuth &&
    typeof grantFromAuth === 'object' &&
    'projectId' in grantFromAuth &&
    'scopes' in grantFromAuth
      ? {
          projectId: grantFromAuth.projectId ?? null,
          scopes: grantFromAuth.scopes ?? null,
        }
      : DEFAULT_GRANT;

  // feat-005 #3 listing filter · `?include=core|all` (default 'core' per detail design §3 ·
  // 4 day-one tools default to leave ~26 listing budget for ecosystem MCPs · 'all' opt-in).
  const url = new URL(req.url);
  const categoryInclude = parseCategoryInclude(url.searchParams.get('include'));

  return {
    grant,
    readOnly: authExtra?.readOnly === true,
    categoryInclude,
    // feat-072/#218: SSE retired → no envelope owner identity to bind.
    sseOwnerIdentity: null,
  };
}

// feat-072/#218 part2 (ADR-0019): self-implemented OAuth gate, replacing
// mcp-handler's `withMcpAuth` (dropped with the rest of mcp-handler). Faithfully
// mirrors it: extract `Bearer` → `verifyToken` (reused, unchanged) → fail-closed
// 401 / scope 403 / expiry 401 → set `req.auth` → call handler. The OAuth error
// classes come straight from the MCP SDK, so the `WWW-Authenticate` challenge +
// JSON body are byte-identical to the previous behavior. `rewriteResourceMetadataHeader`
// (below, in handleRequest) still rewrites the 401's resource_metadata to the
// exact requested resource path.
function oauthChallengeResponse(
  error: InvalidTokenError | InsufficientScopeError,
  resourceMetadataUrl: string,
  status: number,
): Response {
  return new Response(JSON.stringify(error.toResponseObject()), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer error="${error.errorCode}", error_description="${error.message}", resource_metadata="${resourceMetadataUrl}"`,
    },
  });
}

function withOAuth(
  handler: (req: Request) => Promise<Response>,
  {
    required = false,
    requiredScopes,
  }: { required?: boolean; requiredScopes?: string[] } = {},
) {
  return async (req: Request): Promise<Response> => {
    const resourceMetadataUrl = `${new URL(req.url).origin}${PROTECTED_RESOURCE_METADATA_PATH}`;
    const authHeader = req.headers.get('Authorization');
    const [type, token] = authHeader?.split(' ') ?? [];
    const bearerToken = type?.toLowerCase() === 'bearer' ? token : undefined;

    let authInfo: AuthInfo | undefined;
    try {
      authInfo = await verifyToken(req, bearerToken);
    } catch (err) {
      logger.error('Unexpected error authenticating bearer token', { err });
      return oauthChallengeResponse(
        new InvalidTokenError('Invalid token'),
        resourceMetadataUrl,
        HTTP_STATUS.unauthorized,
      );
    }

    try {
      if (required && !authInfo) {
        throw new InvalidTokenError('No authorization provided');
      }
      if (!authInfo) {
        return handler(req);
      }
      if (
        requiredScopes?.length &&
        !requiredScopes.every((scope) => authInfo!.scopes.includes(scope))
      ) {
        throw new InsufficientScopeError('Insufficient scope');
      }
      if (authInfo.expiresAt && authInfo.expiresAt < Date.now() / 1000) {
        throw new InvalidTokenError('Token has expired');
      }
      (req as Request & { auth?: AuthInfo }).auth = authInfo;
      return handler(req);
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return oauthChallengeResponse(
          error,
          resourceMetadataUrl,
          HTTP_STATUS.unauthorized,
        );
      }
      if (error instanceof InsufficientScopeError) {
        return oauthChallengeResponse(
          error,
          resourceMetadataUrl,
          HTTP_STATUS.forbidden,
        );
      }
      logger.error('Unexpected error authenticating bearer token', { error });
      return new Response(
        JSON.stringify(
          new ServerError('Internal Server Error').toResponseObject(),
        ),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  };
}

// All authenticated MCP traffic flows through the raw-SDK stateful Streamable
// HTTP handler (single /api/mcp endpoint, carries elicitation).
const authHandler = withOAuth(
  async (req: Request) =>
    handleStatefulStreamableHttp(req, getStaticToolContext(req)),
  { required: true },
);

function rewriteResourceMetadataHeader(
  response: Response,
  request: Request,
): Response {
  if (response.status !== HTTP_STATUS.unauthorized) {
    return response;
  }

  const wwwAuthenticate = response.headers.get('WWW-Authenticate');
  if (!wwwAuthenticate) {
    return response;
  }

  const resourceMetadataUrl =
    buildResourceMetadataUrlForResourceRequest(request);

  const updatedHeader = /resource_metadata="[^"]*"/.test(wwwAuthenticate)
    ? wwwAuthenticate.replace(
        /resource_metadata="[^"]*"/,
        `resource_metadata="${resourceMetadataUrl}"`,
      )
    : `${wwwAuthenticate}, resource_metadata="${resourceMetadataUrl}"`;

  if (updatedHeader === wwwAuthenticate) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('WWW-Authenticate', updatedHeader);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// feat-028/#108: mcp-server 启动期初始化 PG parser (WASM runtime · libpg-query)。
// PARSER_BACKEND=pg-parser (默认) → 必须 await loadModule() 成功才接请求 · 失败 throw 让启动拒
// (fail-closed · 不 silent fallback regex)。PARSER_BACKEND=regex (回滚) → 跳过 init。
const parserInitPromise: Promise<void> = (async () => {
  const backend = getParserBackend();
  if (backend === 'regex') {
    logger.info(
      'feat-028 destructive-detector backend: regex (回滚通路 · 失 4 类绕过防护 + 长锁识别)',
    );
    return;
  }
  try {
    await initPgParser();
    logger.info(
      'feat-028 destructive-detector backend: pg-parser (libpg-query · WASM)',
    );
  } catch (err) {
    logger.error(
      'feat-028 PG parser 初始化失败 · mcp-server 启动拒 (fail-closed · 不 silent fallback regex)',
      { error: err instanceof Error ? err.message : String(err) },
    );
    throw err;
  }
})();

// Normalize legacy paths (/mcp, /sse) to canonical /api/* paths
// for mcp-handler's exact pathname matching.
//
// Next.js rewrites preserve the original client URL in request.url,
// but mcp-handler expects /api/mcp or /api/sse. Without this normalization,
// requests to /mcp would get 404 after OAuth (before auth, withMcpAuth
// returns 401 before pathname matching happens).
const handleRequest = async (req: Request) => {
  // feat-028: 等 PG parser 初始化完 · 失败 throw 透传 → 5xx 给 client (不放行未初始化的 classify)
  await parserInitPromise;
  const url = new URL(req.url);

  if (url.pathname === ROUTE_PATHS.legacyMcp) {
    url.pathname = ROUTE_PATHS.canonicalMcp;
  } else if (url.pathname === ROUTE_PATHS.legacySse) {
    url.pathname = ROUTE_PATHS.canonicalSse;
  }

  // feat-072/#218 (ADR-0019): SSE transport retired — only the stateful
  // Streamable HTTP endpoint (/api/mcp) remains. Return 410 Gone pointing
  // clients at /api/mcp (no auth needed for the retirement notice).
  if (url.pathname === ROUTE_PATHS.canonicalSse) {
    return new Response(
      JSON.stringify({
        error:
          'The SSE transport has been retired; use Streamable HTTP at /api/mcp.',
        code: 'sse_retired',
      }),
      { status: 410, headers: JSON_RESPONSE_HEADERS },
    );
  }

  const normalizedReq = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.body,
    // @ts-expect-error duplex is required for streaming bodies
    duplex: 'half',
  });

  // Strict docs-only mode: bypass OAuth entirely so docs tools are usable
  // without an account. Only triggers when the request is exactly
  // ?category=docs (no other categories, no projectId).
  if (isDocsOnlyRequest(url.searchParams)) {
    return handleDocsOnly(normalizedReq);
  }

  const response = authHandler(normalizedReq);
  if (response instanceof Promise) {
    return response.then((resolved) =>
      rewriteResourceMetadataHeader(resolved, req),
    );
  }
  return rewriteResourceMetadataHeader(response, req);
};

export { handleRequest as GET, handleRequest as POST, handleRequest as DELETE };

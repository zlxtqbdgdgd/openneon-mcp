// Initialize Sentry (must be first import)
import '../../../mcp-src/sentry/instrument';
// Initialize OTel (feat-031 · audit event OTLP HTTP exporter · honors OTEL_SDK_DISABLED)
import { initOtel } from '../../../mcp-src/observability/otel-init';
initOtel();

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { captureException, startSpan } from '@sentry/node';

import {
  getAvailablePrompts,
  getPromptTemplate,
} from '../../../mcp-src/prompts';
import { NEON_HANDLERS } from '../../../mcp-src/tools/index';
import { classifyOp } from '../../../mcp-src/protection/destructive-detector';
import { runPipeline } from '../../../mcp-src/policy/pipeline';
import {
  resolvePlanApproval,
  type ElicitResultLike,
} from '../../../mcp-src/policy/stages/plan-mode';
import { issueConfirmToken } from '../../../mcp-src/policy/confirm-token-issuer';
import { emitConfirmTokenAudit } from '../../../mcp-src/audit/event-types';
import { resolvePolicy, applyOverrides } from '../../../mcp-src/policy/loader';
import {
  getDocResource,
  listDocsResources,
} from '../../../mcp-src/tools/handlers/docs';
import { createNeonClient } from '../../../mcp-src/server/api';
import pkg from '../../../package.json';
import { handleToolError } from '../../../mcp-src/server/errors';
import type { ToolHandlerExtraParams } from '../../../mcp-src/tools/types';
import { detectClientApplication } from '../../../mcp-src/utils/client-application';
import { isReadOnly } from '../../../mcp-src/utils/read-only';
import type { AuthContext } from '../../../mcp-src/types/auth';
import { logger } from '../../../mcp-src/utils/logger';
import { generateTraceId } from '../../../mcp-src/utils/trace';
import { waitUntil } from '@vercel/functions';
import { track, flushAnalytics } from '../../../mcp-src/analytics/analytics';
import {
  saveCapabilities,
  loadCapabilities,
} from '../../../mcp-src/server/capability-cache';
import { resolveAccountFromAuth } from '../../../mcp-src/server/account';
import { model } from '../../../mcp-src/oauth/model';
import { getApiKeys, type ApiKeyRecord } from '../../../mcp-src/oauth/kv-store';
import { setSentryTags } from '../../../mcp-src/sentry/utils';
import type { ServerContext, AppContext } from '../../../mcp-src/types/context';
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
  getAvailableTools,
  getAccessControlWarnings,
  injectProjectId,
} from '../../../mcp-src/tools/grant-filter';
import { filterToolsByRole } from '../../../mcp-src/tools/role-toolsets';
import {
  isLocalDevAuthEnabled,
  buildLocalDevAuthInfo,
} from '../../../mcp-src/server/local-dev-auth';
import {
  parseCategoryInclude,
  type CategoryInclude,
} from '../../../mcp-src/config/categories';
import { NEON_TOOLS } from '../../../mcp-src/tools/definitions';
import { assert } from '../../../lib/assert';
import { buildResourceMetadataUrlForResourceRequest } from '../../../lib/oauth/protected-resource-metadata';
import {
  bindSession,
  deriveIdentity,
  emitSseBindOutcome,
  evaluateMessageOwnership,
  releaseSession,
  shouldRejectEnvelope,
} from '../../../mcp-src/server/session-binding';

class SessionIdentityMismatchError extends Error {
  constructor() {
    super('Session identity mismatch; request dropped');
    this.name = 'SessionIdentityMismatchError';
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type SessionBindingContext = {
  identity: string;
  binding: Deferred<void>;
  sessionId?: string;
  sessionStarted: boolean;
};

type JsonErrorDefinition = {
  status: number;
  error: string;
  code: string;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Carries the authenticated caller's identity fingerprint from post-auth into
// the mcp-handler onEvent callback (where `SESSION_STARTED` fires with the
// newly-generated sessionId). ALS propagates through the library's awaits. For
// SSE, the outer route waits on the same context before returning the stream, so
// clients never receive a usable sessionId before Redis has the owner binding.
const sessionBindingContext = new AsyncLocalStorage<SessionBindingContext>();

// SSE streams live up to this many seconds on Vercel Fluid Compute. Used both
// as mcp-handler's `maxDuration` and (plus a buffer) as the TTL for session
// bindings in Redis.
const SSE_MAX_DURATION_SEC = 800;
const SESSION_BINDING_TTL_SEC = SSE_MAX_DURATION_SEC + 70;

const ROUTE_PATHS = {
  apiBase: '/api',
  canonicalMcp: '/api/mcp',
  canonicalSse: '/api/sse',
  legacyMcp: '/mcp',
  legacySse: '/sse',
} as const;

const SSE_CONNECTION_PATHS = new Set<string>([
  ROUTE_PATHS.canonicalSse,
  ROUTE_PATHS.legacySse,
]);

const JSON_RESPONSE_HEADERS = { 'Content-Type': 'application/json' } as const;

const HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  serviceUnavailable: 503,
} as const;

const PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource';

const SESSION_ERROR_CODES = {
  callerIdentityUnavailable: 'caller_identity_unavailable',
  sessionBindingUnavailable: 'session_binding_unavailable',
  sessionNotOwned: 'session_not_owned',
  sessionVerificationUnavailable: 'session_verification_unavailable',
} as const;

const CALLER_IDENTITY_UNAVAILABLE_RESPONSE: JsonErrorDefinition = {
  status: HTTP_STATUS.unauthorized,
  error: 'Caller identity unavailable',
  code: SESSION_ERROR_CODES.callerIdentityUnavailable,
};

const SESSION_BINDING_UNAVAILABLE_RESPONSE: JsonErrorDefinition = {
  status: HTTP_STATUS.serviceUnavailable,
  error: 'Session binding unavailable',
  code: SESSION_ERROR_CODES.sessionBindingUnavailable,
};

type AuthenticatedExtra = {
  authInfo?: AuthInfo & {
    extra?: {
      apiKey?: string;
      account?: AuthContext['extra']['account'];
      readOnly?: boolean;
      grant?: GrantContext;
      client?: AuthContext['extra']['client'];
      transport?: AppContext['transport'];
      userAgent?: string;
    };
  };
  signal?: AbortSignal;
  sessionId?: string;
};

type StaticToolContext = {
  grant: GrantContext;
  readOnly: boolean;
  // feat-005 #3 listing filter · 'core' (default · 4 day-one tools) or 'all' (33-tool listing).
  // Parsed from `?include=` HTTP query param via parseCategoryInclude (null/invalid → 'core').
  categoryInclude: CategoryInclude;
  // Identity fingerprint of the SSE connection owner, captured at handler
  // construction. Each tool call compares `extra.authInfo`'s identity against
  // this. Mismatches indicate a Redis envelope was routed into a stream it
  // does not belong to — defense in depth on top of the POST-side check.
  sseOwnerIdentity: string | null;
};

function createContextualMcpHandler(staticToolContext: StaticToolContext) {
  const { sseOwnerIdentity } = staticToolContext;

  // Verifies that the caller baked into an incoming MCP envelope (tool or
  // prompt call) matches the identity captured when the SSE stream was
  // established. See StaticToolContext.sseOwnerIdentity for rationale.
  // Returns true on mismatch so the registered handler can short-circuit
  // with a no-op result rather than emitting a JSON-RPC error onto the SSE
  // owner's channel (which is the victim, not the attacker).
  const checkEnvelopeMatches = (
    extra: AuthenticatedExtra,
    invocationName: string,
  ): boolean => {
    if (!shouldRejectEnvelope(sseOwnerIdentity, extra.authInfo)) return false;
    emitSseBindOutcome('envelope_mismatch', { invocation: invocationName });
    logger.error('envelope identity mismatch — dropping invocation', {
      invocation: invocationName,
      hasCallerIdentity: deriveIdentity(extra.authInfo) !== null,
    });
    captureException(new SessionIdentityMismatchError(), {
      tags: { invocation: invocationName },
    });
    return true;
  };

  return createMcpHandler(
    (server: McpServer) => {
      // Request-scoped mutable state (isolated per server instance)
      let clientName = 'unknown';
      let clientApplication = detectClientApplication(clientName);
      let hasTrackedServerInit = false;
      let lastKnownContext: ServerContext | undefined;
      // issue #100 mitigation · one-shot guard for capability cache sync.
      // mcp-handler 1.0.6 SSE reconnect 给 fresh McpServer 而 Claude Code 2.1.150
      // 不重发 initialize → _clientCapabilities 永远 undefined → plan-mode fail-closed
      // deny。每个 server instance 第一次 getAuthContext 时一次性检查:
      //   - SDK 有真 caps → 写 redis cache (后续重连复用)
      //   - SDK 无 caps → 从 redis 取上次同 (accountId, userAgent) 的 cache · 注入
      //                  · 真的没 cache 才走 ADR-0008 fail-closed deny
      let hasTriedCapabilityCacheSync = false;

      // Default app context for analytics/Sentry (used in onerror fallback)
      const defaultAppContext: AppContext = {
        name: 'mcp-server-neon',
        transport: 'sse',
        environment: (process.env.NODE_ENV ??
          'production') as AppContext['environment'],
        version: pkg.version,
      };

      // Track server initialization (called after client detection with proper context)
      function trackServerInit(context: ServerContext) {
        if (hasTrackedServerInit) return;
        hasTrackedServerInit = true;

        const grant = context.grant ?? DEFAULT_GRANT;
        const properties = {
          clientName,
          clientApplication,
          readOnly: String(context.readOnly ?? false),
          projectScoped: String(!!grant.projectId),
          customScopes: grant.scopes?.join(',') ?? 'all',
        };

        track({
          userId: context.account.id,
          event: 'server_init',
          properties,
          context: {
            client: context.client,
            app: context.app,
          },
        });
        waitUntil(flushAnalytics());
        logger.info('Server initialized:', {
          clientName,
          clientApplication,
          readOnly: context.readOnly,
          grant,
        });
      }

      // Helper function to get Neon client and context from auth info
      async function getAuthContext(extra: AuthenticatedExtra) {
        const authInfo = extra.authInfo;
        if (!authInfo?.extra?.apiKey || !authInfo?.extra?.account) {
          throw new Error('Authentication required');
        }

        const apiKey = authInfo.extra.apiKey;
        const account = authInfo.extra.account;
        const readOnly = authInfo.extra.readOnly ?? false;
        const grant = { ...(authInfo.extra.grant ?? DEFAULT_GRANT) };
        const client = authInfo.extra.client;
        const transport = authInfo.extra.transport ?? 'sse';
        const neonClient = createNeonClient(apiKey);

        // Use User-Agent as clientName fallback if MCP handshake hasn't provided it yet
        if (clientName === 'unknown' && authInfo.extra.userAgent) {
          clientName = authInfo.extra.userAgent;
          clientApplication = detectClientApplication(clientName);
        }

        // issue #100 mitigation · one-shot capability cache save/load。
        // 详 server/capability-cache.ts 头注释 + ADR-0008 后果段 "production 部署前置"。
        if (
          !hasTriedCapabilityCacheSync &&
          account?.id &&
          authInfo.extra.userAgent
        ) {
          hasTriedCapabilityCacheSync = true;
          const currentCaps = server.server.getClientCapabilities();
          if (currentCaps && Object.keys(currentCaps).length > 0) {
            // 真 initialize 已来 (oninitialized hook 触发过) → 把 fresh caps 写
            // redis 给后续 reconnect 用。fire-and-forget · 失败不阻塞主流程。
            void saveCapabilities(
              account.id,
              authInfo.extra.userAgent,
              currentCaps,
            );
          } else {
            // SDK _clientCapabilities undefined = client 没发 initialize (或 mcp-handler
            // 还没投递)。试 redis cache · 命中就直接注入 SDK · 跳过 fail-closed deny。
            const cached = await loadCapabilities(
              account.id,
              authInfo.extra.userAgent,
            );
            if (cached) {
              // SDK 1.25.3 server/index.js:272/286 把 `_clientCapabilities` 当普通
              // property 读写 (TS 标 `private` 但运行时无 #private · 外部赋值合法 ·
              // 通过 unknown cast 绕 TS visibility 检查)。等真 initialize 来时 SDK
              // 会自然覆写,我们的 cache 会被刷新。
              (
                server.server as unknown as {
                  _clientCapabilities?: typeof cached;
                }
              )._clientCapabilities = cached;
              logger.info(
                'capability-cache · injected (#100 · reconnect without re-init)',
                { accountId: account.id, caps: cached },
              );
            } else {
              logger.warn(
                'capability-cache · miss + no initialize · plan-mode 将走 ADR-0008 fail-closed deny',
                {
                  accountId: account.id,
                  userAgent: authInfo.extra.userAgent,
                },
              );
            }
          }
        }

        // Create dynamic appContext with actual transport
        const dynamicAppContext: AppContext = {
          name: 'mcp-server-neon',
          transport,
          environment: (process.env.NODE_ENV ??
            'production') as AppContext['environment'],
          version: pkg.version,
        };

        // Build and store context for potential use in onerror
        const context: ServerContext = {
          apiKey,
          account,
          app: dynamicAppContext,
          readOnly,
          client,
          grant,
        };
        lastKnownContext = context;

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

      // Set up lifecycle hooks for client detection and error handling
      server.server.oninitialized = () => {
        const clientInfo = server.server.getClientVersion();
        logger.info('MCP oninitialized:', {
          clientInfo,
          hasName: !!clientInfo?.name,
          currentClientName: clientName,
        });
        // Prefer MCP clientInfo over HTTP User-Agent (more reliable)
        // This ensures we get the real client name even when using mcp-remote,
        // which forwards the original client name (e.g., "Cursor (via mcp-remote 0.1.31)")
        if (clientInfo?.name) {
          clientName = clientInfo.name;
          clientApplication = detectClientApplication(clientName);
        }
        // issue #100 · 真 initialize 来时重置 cache sync guard · 让下次 getAuthContext
        // 拿 fresh caps 刷 redis (覆盖可能 stale 的 cached value · 如 client 升级声明
        // 新能力)。处理 init 与 first tool call 的 race: 即使 inject 路径先跑了,oninit
        // 后下次 tool call 会重新 sync 把 fresh caps 写进 cache。
        hasTriedCapabilityCacheSync = false;
        // Note: server_init is tracked on first authenticated request
        // because we don't have account info here yet
      };

      server.server.onerror = (error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        logger.error('Server error:', {
          message,
          error,
        });

        // Use last known context if available, otherwise use defaults
        const userId = lastKnownContext?.account?.id ?? 'unknown';
        const contexts = {
          app: lastKnownContext?.app ?? defaultAppContext,
          client: lastKnownContext?.client,
        };

        const eventId = captureException(error, {
          user: lastKnownContext?.account
            ? { id: lastKnownContext.account.id }
            : undefined,
          contexts,
        });

        track({
          userId,
          event: 'server_error',
          properties: { message, error, eventId },
          context: contexts,
        });
        waitUntil(flushAnalytics());
      };

      const composedTools = getAvailableTools(
        staticToolContext.grant,
        staticToolContext.readOnly,
        staticToolContext.categoryInclude,
      );

      // Register tools for this specific auth context.
      composedTools.forEach((tool) => {
        const toolHandler = NEON_HANDLERS[tool.name];
        assert(toolHandler, `Handler for tool ${tool.name} not found`);

        server.registerTool(
          tool.name,
          {
            description: tool.description,
            // NOTE: This intentionally stays strongly typed (no cast). If this starts failing
            // after an SDK upgrade, treat it as a schema-type compatibility regression between
            // MCP SDK zod-compat types and our tool schema definitions.
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          },
          async (args: any, extra: any) => {
            const typedExtra = extra as AuthenticatedExtra;
            if (checkEnvelopeMatches(typedExtra, tool.name)) {
              // Silently drop the misrouted invocation. Returning a non-error
              // empty result avoids leaking a JSON-RPC error onto the SSE
              // owner's (victim's) channel.
              return { content: [], isError: false } as const;
            }

            const traceId = generateTraceId();
            return await startSpan(
              {
                name: 'tool_call',
                attributes: {
                  tool_name: tool.name,
                  trace_id: traceId,
                },
              },
              async (span) => {
                const {
                  account,
                  readOnly,
                  grant,
                  neonClient,
                  clientApplication: clientApp,
                  clientName: cName,
                  client,
                  context,
                } = await getAuthContext(typedExtra);

                // Track server_init on first authenticated request (after client detection)
                trackServerInit(context);

                const properties = {
                  tool_name: tool.name,
                  readOnly: String(readOnly),
                  projectScoped: String(!!grant.projectId),
                  clientName: cName,
                  traceId,
                };

                logger.info('tool call:', properties);
                setSentryTags(context);

                track({
                  userId: account.id,
                  event: 'tool_call',
                  properties,
                  context: {
                    client,
                    app: context.app,
                    clientName: cName,
                  },
                });
                waitUntil(flushAnalytics());

                const extraArgs: ToolHandlerExtraParams = {
                  ...extra,
                  account,
                  readOnly,
                  clientApplication: clientApp,
                };

                try {
                  // Inject projectId if in project-scoped mode
                  const effectiveArgs = injectProjectId(
                    (args ?? {}) as Record<string, unknown>,
                    grant,
                  );

                  // feat-056 enforcement pipeline (ADR-0007 · #73 骨架: hard-deny G4 · 在 toolHandler 之前)
                  const a = effectiveArgs as Record<string, unknown>;
                  const sqlForClassify =
                    typeof a.sql === 'string'
                      ? a.sql
                      : Array.isArray(a.sqlStatements)
                        ? (a.sqlStatements as string[]).join('; ')
                        : undefined;
                  const opClass = classifyOp(tool.name, sqlForClassify);
                  const effectiveProjectId =
                    grant.projectId ?? (a.projectId as string | undefined);
                  const resolved = resolvePolicy(effectiveProjectId);
                  const pipelineCtx = {
                    opClass,
                    toolName: tool.name,
                    projectId: effectiveProjectId,
                    // feat-056/#3 (#76): G1 用原始请求 projectId (injectProjectId 覆盖前) 检测跨 project 越权
                    requestedProjectId: (
                      args as Record<string, unknown> | undefined
                    )?.projectId as string | undefined,
                    // feat-056/#2 (#75): per-project autonomy_level + SQL-pattern override
                    autonomyLevel: applyOverrides(sqlForClassify, resolved),
                    grant: { projectId: grant.projectId },
                    // feat-030/#79: per-project timeout 覆盖 → timeoutInjectionStage (执行前注入消费在后续 write-path 成熟)
                    timeoutOverrides: resolved.timeout_overrides,
                    // feat-027/#2: 原始 SQL → planModeStage 组 plan payload
                    sql: sqlForClassify,
                  } as const;
                  const verdict = runPipeline({ ...pipelineCtx });
                  if (verdict.action === 'deny') {
                    logger.warn('policy deny (feat-056):', {
                      ...properties,
                      opClass,
                      reason: verdict.reason,
                    });
                    return {
                      content: [
                        {
                          type: 'text' as const,
                          text: `Denied by policy: ${verdict.reason}`,
                        },
                      ],
                      isError: true,
                    };
                  }

                  // feat-027/#2 plan mode: require_plan → orchestrator 弹 MCP elicitInput 给 DBA 审批 ·
                  // 人批才放行 · fail-closed (client 无 capability / 超时 / 异常 → deny · ADR-0008)。
                  if (verdict.action === 'require_plan') {
                    if (!verdict.plan) {
                      return {
                        content: [
                          {
                            type: 'text' as const,
                            text: 'Plan not approved: plan payload missing · fail-closed',
                          },
                        ],
                        isError: true,
                      };
                    }
                    // 不预检 getClientCapabilities() —— mcp-handler streamable HTTP 下该快照可能拿不到
                    // (tool-call 那次请求的 server 实例未必见过 initialize 握手) → 会误判 fail-closed。
                    // 直接 attempt elicitInput · 由 resolvePlanApproval 的 try/catch 兜底:client 真不支持
                    // 时 SDK 同步抛 "Client does not support elicitation" → catch → fail-closed (SPIKE feat-027/#1)。
                    logger.info('plan mode · attempting elicitation (feat-027):', {
                      ...properties,
                      opClass,
                      clientCaps: server.server.getClientCapabilities() ?? null,
                    });
                    const elicit = async (
                      message: string,
                      requestedSchema: Record<string, unknown>,
                      timeoutMs: number,
                    ): Promise<ElicitResultLike> => {
                      const res = await server.server.elicitInput(
                        { message, requestedSchema } as never,
                        { timeout: timeoutMs },
                      );
                      return {
                        action: res.action,
                        content: res.content,
                      } as ElicitResultLike;
                    };
                    const approval = await resolvePlanApproval(
                      elicit,
                      verdict.plan,
                    );
                    if (!approval.approved) {
                      logger.warn('plan mode deny (feat-027):', {
                        ...properties,
                        opClass,
                        reason: approval.reason,
                        failClosed: approval.failClosed,
                      });
                      return {
                        content: [
                          {
                            type: 'text' as const,
                            text: `Plan not approved: ${approval.reason}`,
                          },
                        ],
                        isError: true,
                      };
                    }
                    logger.info('plan mode approved (feat-027):', {
                      ...properties,
                      opClass,
                      reason: approval.reason,
                    });
                    // feat-026/#1: approve 后 server 颁发 ConfirmToken (audit artifact ·
                    // 短 TTL · single-use) · 注入 ctx 重跑 pipeline · planModeStage 看到
                    // token 后 skip elicitation · confirmTokenStage (step 7) verify + audit
                    // (token_id 是跨系统 join key · 详设 §3 调用链)。
                    const tokenSnapshot = issueConfirmToken({
                      op_class: opClass,
                      args: sqlForClassify ?? '',
                      principal: `human:${account?.id ?? 'unknown'}`,
                      source: 'plan-mode-approval',
                    });
                    emitConfirmTokenAudit({
                      event_type: 'confirm_token_issued',
                      token_id: tokenSnapshot.id,
                      source: tokenSnapshot.source,
                      op_class: opClass,
                      principal: `human:${account?.id ?? 'unknown'}`,
                      ttl_seconds: 300,
                    });
                    const verdict2 = runPipeline({
                      ...pipelineCtx,
                      confirmToken: tokenSnapshot,
                    });
                    if (verdict2.action === 'deny') {
                      logger.warn('policy deny after approve (feat-026):', {
                        ...properties,
                        opClass,
                        reason: verdict2.reason,
                      });
                      return {
                        content: [
                          {
                            type: 'text' as const,
                            text: `Denied by policy: ${verdict2.reason}`,
                          },
                        ],
                        isError: true,
                      };
                    }
                    // verdict2 应为 allow / inject_timeout · 都放行执行 (audit high · 已批准高危 op)
                  }

                  // Wrap args in { params } structure expected by handlers
                  const result = await (toolHandler as any)(
                    { params: effectiveArgs },
                    neonClient,
                    extraArgs,
                  );
                  if (result.isError) {
                    logger.warn('tool error response:', {
                      ...properties,
                      isError: true,
                      contentLength: result.content?.length,
                      firstContentType: result.content?.[0]?.type,
                    });
                  }

                  // Append access control warnings to tool response
                  const accessControlWarnings = getAccessControlWarnings(
                    grant,
                    readOnly,
                  );
                  if (accessControlWarnings.length > 0 && result.content) {
                    result.content.push(
                      ...accessControlWarnings.map((w: string) => ({
                        type: 'text' as const,
                        text: w,
                      })),
                    );
                  }

                  return result;
                } catch (error) {
                  span.setStatus({ code: 2 });
                  // feat-029/#3: 把 apiKey 传给 handleToolError · Neon API 401/403 自动 invalidate
                  // 5min KV cache（运行期 revocation 检测 · 下次 fail-closed）
                  const errorResult = handleToolError(
                    error,
                    properties,
                    traceId,
                    typedExtra.authInfo?.extra?.apiKey,
                  );
                  logger.warn('tool error response:', {
                    ...properties,
                    isError: true,
                    contentLength: errorResult.content?.length,
                    firstContentType: errorResult.content?.[0]?.type,
                  });
                  return errorResult;
                }
              },
            );
          },
        );
      });

      // Register prompts for this specific auth context.
      const composedPrompts = getAvailablePrompts(staticToolContext.grant);
      composedPrompts.forEach((prompt) => {
        server.registerPrompt(
          prompt.name,
          {
            description: prompt.description,
            // Same compatibility guardrail as tool registration above.
            argsSchema: prompt.argsSchema,
          },
          async (args: any, extra: any) => {
            const typedExtra = extra as AuthenticatedExtra;
            if (checkEnvelopeMatches(typedExtra, `prompt:${prompt.name}`)) {
              // Silently drop the misrouted invocation; see tool handler note.
              return { messages: [] } as const;
            }

            const {
              account,
              readOnly,
              clientApplication: clientApp,
              clientName: cName,
              client,
              context,
            } = await getAuthContext(typedExtra);

            // Track server_init on first authenticated request
            trackServerInit(context);

            const traceId = generateTraceId();
            const properties = {
              prompt_name: prompt.name,
              clientName: cName,
              traceId,
            };
            logger.info('prompt call:', properties);
            setSentryTags(context);

            track({
              userId: account.id,
              event: 'prompt_call',
              properties,
              context: { client, app: context.app },
            });
            waitUntil(flushAnalytics());

            try {
              const extraArgs: ToolHandlerExtraParams = {
                ...extra,
                account,
                readOnly,
                clientApplication: clientApp,
              };
              const template = await getPromptTemplate(
                prompt.name,
                extraArgs,
                args,
              );
              return {
                messages: [
                  {
                    role: 'user' as const,
                    content: {
                      type: 'text' as const,
                      text: template,
                    },
                  },
                ],
              };
            } catch (error) {
              captureException(error, {
                extra: properties,
              });
              throw error;
            }
          },
        );
      });

      // Override tools/list to return the same context-scoped surface that was
      // registered for this handler instance.
      server.server.setRequestHandler(ListToolsRequestSchema, async () => {
        // Avoid relying on MCP SDK private fields (`_registeredTools`), which can
        // change across SDK versions and break request handling. Build the list from
        // our canonical tool definitions and convert schemas explicitly.
        //
        // feat-059/#1: role 软过滤 —— listing ∩ ROLE_TOOLSETS[agent_role] (per-project policy ·
        // 未配 → 不过滤)。**软**: 只裁 listing · 不影响上面已 registerTool 的可调用集 (非 toolset 的
        // tool 仍可被调 · 走 feat-056 enforcement · 不因"不在 toolset"而拒)。
        const agentRole = resolvePolicy(
          staticToolContext.grant.projectId ?? undefined,
        ).agent_role;
        const listedTools = filterToolsByRole(composedTools, agentRole);
        const tools = listedTools.map((tool) => {
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
    },
    {
      serverInfo: {
        name: 'mcp-server-neon',
        version: pkg.version,
      },
      capabilities: {
        tools: {},
        resources: {},
        prompts: {
          listChanged: true,
        },
      },
    },
    {
      redisUrl: process.env.KV_URL || process.env.REDIS_URL,
      basePath: ROUTE_PATHS.apiBase,
      maxDuration: SSE_MAX_DURATION_SEC, // Fluid Compute ceiling for SSE connections
      verboseLogs: process.env.NODE_ENV !== 'production',
      onEvent: (event) => {
        switch (event.type) {
          case 'SESSION_STARTED': {
            logger.info('MCP session started', {
              sessionId: event.sessionId,
              transport: event.transport,
              clientInfo: event.clientInfo,
            });
            const bindingContext = sessionBindingContext.getStore();
            const identity = bindingContext?.identity;
            if (event.sessionId && identity && bindingContext) {
              const sessionId = event.sessionId;
              bindingContext.sessionId = sessionId;
              bindingContext.sessionStarted = true;
              void bindSession(sessionId, identity, SESSION_BINDING_TTL_SEC)
                .then(() => {
                  bindingContext.binding.resolve();
                })
                .catch((err) => {
                  logger.error('session-binding bind failed', {
                    sessionId,
                    err,
                  });
                  captureException(err, {
                    tags: { operation: 'bindSession' },
                    extra: { sessionId },
                  });
                  bindingContext.binding.reject(err);
                });
            } else if (bindingContext) {
              const err = new Error('SESSION_STARTED missing sessionId');
              logger.error('session-binding cannot bind SSE session', {
                hasSessionId: !!event.sessionId,
                hasIdentity: !!identity,
              });
              captureException(err, {
                tags: { operation: 'bindSession' },
              });
              bindingContext.binding.reject(err);
            }
            break;
          }

          case 'SESSION_ENDED': {
            logger.info('MCP session ended', {
              sessionId: event.sessionId,
              transport: event.transport,
            });
            if (event.sessionId) {
              const sessionId = event.sessionId;
              waitUntil(
                releaseSession(sessionId).catch((err) => {
                  logger.error('session-binding release failed', {
                    sessionId,
                    err,
                  });
                  captureException(err, {
                    tags: { operation: 'releaseSession' },
                    extra: { sessionId },
                  });
                }),
              );
            }
            break;
          }

          case 'REQUEST_COMPLETED':
            if (event.status === 'error') {
              logger.warn('MCP request failed', {
                sessionId: event.sessionId,
                requestId: event.requestId,
                method: event.method,
                duration: event.duration,
              });
            }
            break;

          case 'ERROR':
            const isConnectionError =
              typeof event.error === 'string'
                ? event.error.includes('No connection established')
                : event.error?.message?.includes('No connection established');

            if (isConnectionError) {
              logger.warn('MCP connection lost', {
                sessionId: event.sessionId,
                source: event.source,
                severity: event.severity,
                context: event.context,
              });
            } else if (event.severity === 'fatal') {
              logger.error('MCP fatal error', {
                sessionId: event.sessionId,
                error: event.error,
                source: event.source,
                context: event.context,
              });
              captureException(
                event.error instanceof Error
                  ? event.error
                  : new Error(String(event.error)),
              );
            }
            break;
        }
      },
    },
  );
}

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

function createDocsOnlyMcpHandler() {
  return createMcpHandler(
    (server: McpServer) => {
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
    },
    {
      serverInfo: {
        name: 'mcp-server-neon',
        version: pkg.version,
      },
      capabilities: {
        tools: {},
      },
    },
    {
      redisUrl: process.env.KV_URL || process.env.REDIS_URL,
      basePath: '/api',
      maxDuration: 800,
      verboseLogs: process.env.NODE_ENV !== 'production',
      onEvent: (event) => {
        switch (event.type) {
          case 'SESSION_STARTED':
            logger.info('MCP docs-only session started', {
              sessionId: event.sessionId,
              transport: event.transport,
              clientInfo: event.clientInfo,
            });
            break;
          case 'SESSION_ENDED':
            logger.info('MCP docs-only session ended', {
              sessionId: event.sessionId,
              transport: event.transport,
            });
            break;
          case 'REQUEST_COMPLETED':
            if (event.status === 'error') {
              logger.warn('MCP docs-only request failed', {
                sessionId: event.sessionId,
                requestId: event.requestId,
                method: event.method,
                duration: event.duration,
              });
            }
            break;
          case 'ERROR':
            if (event.severity === 'fatal') {
              logger.error('MCP docs-only fatal error', {
                sessionId: event.sessionId,
                error: event.error,
                source: event.source,
                context: event.context,
              });
              captureException(
                event.error instanceof Error
                  ? event.error
                  : new Error(String(event.error)),
              );
            }
            break;
        }
      },
    },
  );
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
const verifyToken = async (
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  const userAgent = req.headers.get('user-agent') || undefined;
  const readOnlyHeader = req.headers.get('x-read-only');

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
        logger.error(
          'API key scope re-resolve failed (feat-029 fail-closed)',
          {
            code: error.code,
            message: error.message,
            last4: keyLast4(bearerToken),
            outcome: 'reject_key_resolve_failed',
          },
        );
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
    sseOwnerIdentity: deriveIdentity(authInfo),
  };
}

// Session-binding check for POSTs to the SSE message endpoint. Verifies that
// the caller owns the sessionId they're posting to before the library routes
// the message into the SSE owner's stream. The decision logic lives in
// `evaluateMessageOwnership` so it can be unit-tested in isolation; this
// function is just the Request → Response adapter.
async function checkSessionOwnership(
  req: Request,
  identity: string | null,
): Promise<Response | null> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');
  const result = await evaluateMessageOwnership(
    req.method,
    url.pathname,
    sessionId,
    identity,
  );
  if (result.kind !== 'reject') return null;
  if (result.status === HTTP_STATUS.forbidden) {
    logger.warn('session-binding mismatch on POST /message', {
      sessionId,
      reason: result.reason,
    });
  } else if (result.status === HTTP_STATUS.serviceUnavailable) {
    logger.error('session-binding verify failed; denying', { sessionId });
  }
  const code =
    result.status === HTTP_STATUS.forbidden
      ? SESSION_ERROR_CODES.sessionNotOwned
      : result.status === HTTP_STATUS.serviceUnavailable
        ? SESSION_ERROR_CODES.sessionVerificationUnavailable
        : SESSION_ERROR_CODES.callerIdentityUnavailable;
  return jsonErrorResponse({
    status: result.status,
    error: result.reason,
    code,
  });
}

function isSseConnectionRequest(req: Request): boolean {
  const url = new URL(req.url);
  return req.method === 'GET' && SSE_CONNECTION_PATHS.has(url.pathname);
}

function jsonErrorResponse({
  status,
  error,
  code,
}: JsonErrorDefinition): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: JSON_RESPONSE_HEADERS,
  });
}

function cloneRequestWithSignal(req: Request, signal: AbortSignal): Request {
  const cloned = new Request(req, { signal });
  cloned.auth = req.auth;
  return cloned;
}

async function runSseAfterSessionBinding(
  req: Request,
  identity: string,
): Promise<Response> {
  const abortController = new AbortController();
  const abortFromClient = () => abortController.abort();
  if (req.signal.aborted) {
    abortController.abort();
  } else {
    req.signal.addEventListener('abort', abortFromClient, { once: true });
  }

  const bindingContext: SessionBindingContext = {
    identity,
    binding: createDeferred<void>(),
    sessionStarted: false,
  };
  const sseReq = cloneRequestWithSignal(req, abortController.signal);
  const responsePromise = sessionBindingContext.run(bindingContext, () =>
    createContextualMcpHandler(getStaticToolContext(sseReq))(sseReq),
  );

  try {
    const firstResult = await Promise.race([
      responsePromise.then(
        (response) => ({ type: 'response' as const, response }),
        (error) => ({ type: 'response-error' as const, error }),
      ),
      bindingContext.binding.promise.then(
        () => ({ type: 'bound' as const }),
        (error) => ({ type: 'bind-error' as const, error }),
      ),
    ]);

    if (firstResult.type === 'response-error') {
      throw firstResult.error;
    }
    if (firstResult.type === 'bind-error') {
      abortController.abort();
      void responsePromise.catch(() => undefined);
      return jsonErrorResponse(SESSION_BINDING_UNAVAILABLE_RESPONSE);
    }

    const response =
      firstResult.type === 'response'
        ? firstResult.response
        : await responsePromise;

    if (bindingContext.sessionStarted) {
      try {
        await bindingContext.binding.promise;
      } catch {
        abortController.abort();
        void responsePromise.catch(() => undefined);
        return jsonErrorResponse(SESSION_BINDING_UNAVAILABLE_RESPONSE);
      }
      return response;
    }

    if (response.ok) {
      const err = new Error('SSE response opened without session binding');
      logger.error('session-binding missing SESSION_STARTED event; denying', {
        status: response.status,
      });
      captureException(err, {
        tags: { operation: 'bindSession' },
      });
      abortController.abort();
      return jsonErrorResponse(SESSION_BINDING_UNAVAILABLE_RESPONSE);
    }

    return response;
  } finally {
    req.signal.removeEventListener('abort', abortFromClient);
  }
}

// Wrap with authentication. After auth is resolved, route to a context-scoped
// MCP handler whose registered tools match the token grant/read-only context.
const authHandler = withMcpAuth(
  async (req) => {
    const identity = deriveIdentity(req.auth);
    const rejection = await checkSessionOwnership(req, identity);
    if (rejection) return rejection;
    if (isSseConnectionRequest(req)) {
      if (!identity) {
        return jsonErrorResponse(CALLER_IDENTITY_UNAVAILABLE_RESPONSE);
      }
      return runSseAfterSessionBinding(req, identity);
    }
    return createContextualMcpHandler(getStaticToolContext(req))(req);
  },
  verifyToken,
  {
    required: true,
    resourceMetadataPath: PROTECTED_RESOURCE_METADATA_PATH,
  },
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

// Lazily-initialized docs-only handler. Built on first docs-only request
// so module load doesn't pay the cost when the endpoint is never used.
let docsOnlyHandler: ReturnType<typeof createDocsOnlyMcpHandler> | null = null;
function getDocsOnlyHandler() {
  if (!docsOnlyHandler) {
    docsOnlyHandler = createDocsOnlyMcpHandler();
  }
  return docsOnlyHandler;
}

// Normalize legacy paths (/mcp, /sse) to canonical /api/* paths
// for mcp-handler's exact pathname matching.
//
// Next.js rewrites preserve the original client URL in request.url,
// but mcp-handler expects /api/mcp or /api/sse. Without this normalization,
// requests to /mcp would get 404 after OAuth (before auth, withMcpAuth
// returns 401 before pathname matching happens).
const handleRequest = (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === ROUTE_PATHS.legacyMcp) {
    url.pathname = ROUTE_PATHS.canonicalMcp;
  } else if (url.pathname === ROUTE_PATHS.legacySse) {
    url.pathname = ROUTE_PATHS.canonicalSse;
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
    return getDocsOnlyHandler()(normalizedReq);
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

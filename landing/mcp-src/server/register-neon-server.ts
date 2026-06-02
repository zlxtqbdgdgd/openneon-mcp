// feat-072/#1 (ADR-0019): 传输无关的 Neon MCP tool/prompt 注册模块。
// 把原 app/api/[transport]/route.ts 的 createMcpHandler 回调里 tool/prompt 注册 +
// classify→runPipeline→可注入审批→handler 的 pipeline 包裹抽出，让 HTTP entrypoint
// 与测试夹具复用同一条 pipeline 唯一收口。审批策略 (elicit) 经 deps 注入:
//   - HTTP/SSE 正路注入真人 server.server.elicitInput
//   - 测试/自动化注入 auto-approve (不绕 pipeline · 只换人工那一步)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { captureException, startSpan } from '@sentry/node';
import { waitUntil } from '@vercel/functions';

import { getAvailablePrompts, getPromptTemplate } from '../prompts';
import { NEON_HANDLERS } from '../tools/index';
import { classifyOp } from '../protection/destructive-detector';
import { runPipeline } from '../policy/pipeline';
import {
  resolvePlanApproval,
  type ElicitResultLike,
} from '../policy/stages/plan-mode';
import { issueConfirmToken } from '../policy/confirm-token-issuer';
import { emitConfirmTokenAudit } from '../audit/event-types';
import {
  emitAuditEvent,
  sha256Hex,
  type AuditEventType,
} from '../observability/audit-emit';
import { resolvePolicy, applyOverrides } from '../policy/loader';
import { createNeonClient } from './api';
import { handleToolError } from './errors';
import type { ToolHandlerExtraParams } from '../tools/types';
import type { AuthContext } from '../types/auth';
import { logger } from '../utils/logger';
import { generateTraceId } from '../utils/trace';
import { track, flushAnalytics } from '../analytics/analytics';
import { setSentryTags } from '../sentry/utils';
import type { ServerContext, AppContext } from '../types/context';
import { type GrantContext } from '../utils/grant-context';
import {
  getAvailableTools,
  getAccessControlWarnings,
  injectProjectId,
} from '../tools/grant-filter';
import { filterToolsByRole } from '../tools/role-toolsets';
import { type CategoryInclude } from '../config/categories';
import { bindClaims } from '../auth/claim-binding';
import { getToolClaimBindings } from '../auth/tool-claim-bindings';
import { assert } from '../../lib/assert';

// Identity/auth shapes shared between the HTTP route (which derives them from
// the OAuth bearer token) and the test fixtures.
export type AuthenticatedExtra = {
  authInfo?: AuthInfo & {
    extra?: {
      apiKey?: string;
      account?: AuthContext['extra']['account'];
      readOnly?: boolean;
      grant?: GrantContext;
      client?: AuthContext['extra']['client'];
      transport?: AppContext['transport'];
      userAgent?: string;
      mcpAuthHeaders?: Record<string, string>;
    };
  };
  signal?: AbortSignal;
  sessionId?: string;
};

export type StaticToolContext = {
  grant: GrantContext;
  readOnly: boolean;
  categoryInclude: CategoryInclude;
  sseOwnerIdentity: string | null;
};

// Injectable human-approval seam (ADR-0019): the pipeline calls this for
// require_plan ops. HTTP/SSE wires it to server.server.elicitInput; automated
// tests wire it to an auto-approve so the SAME pipeline runs end-to-end without
// a human, instead of bypassing the pipeline like the legacy local-call path.
export type ElicitFn = (
  message: string,
  requestedSchema: Record<string, unknown>,
  timeoutMs: number,
) => Promise<ElicitResultLike>;

// Resolved per-call auth context (return shape of the route's getAuthContext).
export type ResolvedAuthContext = {
  apiKey: string;
  account: NonNullable<AuthContext['extra']['account']>;
  readOnly: boolean;
  grant: GrantContext;
  neonClient: ReturnType<typeof createNeonClient>;
  clientApplication: string;
  clientName: string;
  client: AuthContext['extra']['client'];
  context: ServerContext;
};

export type NeonServerRegistrationDeps = {
  staticToolContext: StaticToolContext;
  getAuthContext: (extra: AuthenticatedExtra) => Promise<ResolvedAuthContext>;
  trackServerInit: (context: ServerContext) => void;
  checkEnvelopeMatches: (
    extra: AuthenticatedExtra,
    invocationName: string,
  ) => boolean;
  elicit: ElicitFn;
};

// feat-031: pipeline deny verdict -> openneon.audit.event_type.
function denyVerdictToEventType(reason: string): AuditEventType {
  if (/\bG1\b/.test(reason) || reason.includes('跨 project')) {
    return 'g1_cross_project_deny';
  }
  if (/\bG9\b/.test(reason) || reason.includes('速率')) {
    return 'g9_rate_limit_exceeded';
  }
  return 'g4_destructive_deny';
}

// Register the full Neon tool surface (tools + prompts + tools/list override)
// on any MCP Server instance, wrapping every tool call in the feat-056 pipeline
// (classify -> runPipeline -> injected approval -> handler). Transport-agnostic:
// the caller supplies the auth-context resolver and the approval strategy.
export function registerNeonServer(
  server: McpServer,
  deps: NeonServerRegistrationDeps,
): void {
  const {
    staticToolContext,
    getAuthContext,
    trackServerInit,
    checkEnvelopeMatches,
    elicit,
  } = deps;

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
              const argsAfterInject = injectProjectId(
                (args ?? {}) as Record<string, unknown>,
                grant,
              );

              // feat-060/#2 (#130): JWT claim 绑定 middleware · 串在 feat-029 API Key check 之后 / feat-056 pipeline 之前。
              // - 扫 tool inputSchema 的 fromClaim 声明 · verify JWT · 4-outcome 决策 · 强制覆盖 agent 越权值
              // - pass / override → 用 boundArgs 继续 dispatch
              // - deny_missing / deny_invalid → 返 isError content (HTTP 200 + isError=true · 跟 feat-029 一致风格)
              const claimResult = await bindClaims({
                toolName: tool.name,
                // feat-060/#3 (#131): 用 side-table 取 fromClaim 声明 · 不读 zod inputSchema (zod 不支持任意元数据)
                toolSchema: getToolClaimBindings(tool.name),
                args: argsAfterInject,
                headers: typedExtra.authInfo?.extra?.mcpAuthHeaders ?? {},
                projectId:
                  grant.projectId ??
                  (argsAfterInject.projectId as string | undefined),
                principal: `agent:${account?.id ?? 'unknown'}`,
              });
              if (
                claimResult.outcome === 'deny_missing' ||
                claimResult.outcome === 'deny_invalid'
              ) {
                logger.warn('claim-binding deny (feat-060):', {
                  ...properties,
                  outcome: claimResult.outcome,
                  code: claimResult.denyDetail?.code,
                });
                return {
                  content: [
                    {
                      type: 'text',
                      text: `Claim binding rejected: ${claimResult.denyDetail?.code ?? 'UNKNOWN'} (${claimResult.outcome}). ${claimResult.denyDetail?.message ?? ''}`,
                    },
                  ],
                  isError: true,
                } as const;
              }
              const effectiveArgs = claimResult.boundArgs ?? argsAfterInject;

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
                // feat-031: deny 落 audit (G1/G4/G9 越权拦截 · §3.2 a · OWASP LLM02 攻击痕迹)
                emitAuditEvent({
                  event_type: denyVerdictToEventType(verdict.reason),
                  outcome: 'deny',
                  op_class: opClass,
                  principal: `agent:${account?.id ?? 'unknown'}`,
                  severity:
                    verdict.audit_severity === 'high' ? 'high' : 'medium',
                  project_id: effectiveProjectId,
                  db_statement_sha256: sqlForClassify
                    ? sha256Hex(sqlForClassify)
                    : undefined,
                  extra: { 'openneon.audit.deny_reason': verdict.reason },
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
                // feat-031: 弹 plan 给人 (plan_mode_required · §3.2 a)
                emitAuditEvent({
                  event_type: 'plan_mode_required',
                  outcome: 'deny',
                  op_class: opClass,
                  principal: `agent:${account?.id ?? 'unknown'}`,
                  severity: 'medium',
                  project_id: effectiveProjectId,
                  db_statement_sha256: sqlForClassify
                    ? sha256Hex(sqlForClassify)
                    : undefined,
                });
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
                  // feat-031: DBA 拒批 / fail-closed (plan_mode_rejected · §3.2 a)
                  // principal 是 elicitation 的人工审批者 (human responder) · 不是 agent
                  // 账号 (account.id 是 API key 持有者 / LLM agent · OWASP LLM06)。MCP
                  // elicitation 协议不回传 responder 身份 (ElicitResultLike 只有
                  // action/content) → 填 human:unknown 占位 (design §3.2 a
                  // human:<elicitation-responder-id> · L2b 接通真实 responder id 时再填)。
                  emitAuditEvent({
                    event_type: 'plan_mode_rejected',
                    outcome: 'deny',
                    op_class: opClass,
                    principal: approval.failClosed
                      ? 'system:fail-closed'
                      : 'human:unknown',
                    severity: 'high',
                    project_id: effectiveProjectId,
                    db_statement_sha256: sqlForClassify
                      ? sha256Hex(sqlForClassify)
                      : undefined,
                    extra: {
                      'openneon.audit.reject_reason': approval.reason,
                      'openneon.audit.fail_closed': approval.failClosed,
                    },
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
                // feat-031: DBA 批准 (plan_mode_approved · principal=human responder · §3.2 a)
                // 同 plan_mode_rejected: principal 是人工审批者 · 非 agent 账号 (account.id)。
                // MCP elicitation 不回传 responder 身份 → human:unknown 占位
                // (design §3.2 a human:<elicitation-responder-id> · L2b 接通后填真实 id)。
                emitAuditEvent({
                  event_type: 'plan_mode_approved',
                  outcome: 'approved',
                  op_class: opClass,
                  principal: 'human:unknown',
                  severity: 'medium',
                  project_id: effectiveProjectId,
                  db_statement_sha256: sqlForClassify
                    ? sha256Hex(sqlForClassify)
                    : undefined,
                  extra: { 'openneon.audit.approve_reason': approval.reason },
                });
                // feat-026/#1: approve 后 server 颁发 ConfirmToken (audit artifact ·
                // 短 TTL · single-use) · 注入 ctx 重跑 pipeline · planModeStage 看到
                // token 后 skip elicitation · confirmTokenStage (step 7) verify + audit
                // (token_id 是跨系统 join key · 详设 §3 调用链)。
                // confirm token 是这次人工批准的产物 · principal 跟 plan_mode_approved
                // 一致 = 人工审批者 (非 agent account.id) · MCP elicitation 不回传
                // responder 身份 → human:unknown 占位 (L2b 接通后填真实 id)。
                // verify 阶段 (confirm-token.ts) 会读回此 principal emit confirm_token_verified。
                const tokenSnapshot = issueConfirmToken({
                  op_class: opClass,
                  args: sqlForClassify ?? '',
                  principal: 'human:unknown',
                  source: 'plan-mode-approval',
                });
                emitConfirmTokenAudit({
                  event_type: 'confirm_token_issued',
                  token_id: tokenSnapshot.id,
                  source: tokenSnapshot.source,
                  op_class: opClass,
                  principal: 'human:unknown',
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
                  // feat-031: 批准后重跑 pipeline 仍 deny (token verify 失败等 · §3.2 a)
                  emitAuditEvent({
                    event_type: denyVerdictToEventType(verdict2.reason),
                    outcome: 'deny',
                    op_class: opClass,
                    principal: `agent:${account?.id ?? 'unknown'}`,
                    severity: 'high',
                    project_id: effectiveProjectId,
                    db_statement_sha256: sqlForClassify
                      ? sha256Hex(sqlForClassify)
                      : undefined,
                    extra: { 'openneon.audit.deny_reason': verdict2.reason },
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
}

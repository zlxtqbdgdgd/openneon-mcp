/**
 * rewrite_neondb_sql handler · feat-041 (L3) · LLM 改写 SQL.
 *
 * Detail design:
 *   - Parent: https://github.com/zlxtqbdgdgd/openneon-design/issues/56
 *   - #1 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/184 (handler + zod schema + plan mode 集成 · 本文件)
 *   - #2 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/185 (context-builder + llm-rewriter · 复用 feat-045 framework)
 *   - #3 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/186 (cache state-aware + 9 case fixture + 跨 model 100 incident 跑批)
 *
 * 一句话职责: agent 调本 tool, 传 SQL + endpoint_id, server cache 查 → (miss) context-builder
 * 拉 EXPLAIN → obfuscator 脱敏 → plan mode DBA approve → llm-rewriter 调 LLM → self-validation
 * + retry → cache 写 → emit `sql_rewrite_invoked` audit → 返 RewriteResponse.
 *
 * 模块边界 (sub-issue #184 范围):
 *   - 本文件 = handler framework (cache lookup / claim binding / plan mode wire / audit emit / response shape)
 *   - context-builder + llm-rewriter 是 DI deps · stub default (#185 ship 后注入真实) · #184 不实现 LLM call
 *   - cache 默认 in-memory placeholder · #186 接通 feat-064 ttl-cache seam (state-aware TTL)
 *   - obfuscator 是 DI default = feat-024 T11 (已 ship)
 *   - feat-060 claim binding 走 middleware (route.ts 注入 currentProjectId · 本 handler 接收后强校)
 *
 * Contract-first DI 让 sub-issue 各自独立 ship · 不互相阻塞 (跟 generate-rca-report.ts 同 pattern).
 */

import { z } from 'zod/v3';
import { rewriteNeondbSqlInputSchema } from '../toolsSchema';

export type RewriteSqlInput = z.infer<typeof rewriteNeondbSqlInputSchema>;

export type RewriteModelId =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

export type RewriteRiskCategory =
  | 'null_handling'
  | 'case_sensitivity'
  | 'index_dependency'
  | 'transaction_isolation';

export type RewriteOutput = {
  rewritten_sql: string;
  rationale: string;
  expected_improvement: string;
  risks: Array<{ category: RewriteRiskCategory; description: string }>;
  confidence: number;
};

export type RewriteFallbackReason =
  | 'dba_denied'
  | 'self_validation_failed'
  | 'llm_timeout'
  | 'context_fetch_failed'
  | 'cross_tenant_blocked';

export type RewriteResponse = {
  best: RewriteOutput | null;
  backups: RewriteOutput[];
  path_used: 'with_explain' | 'sql_only_simple';
  fallback_reason?: RewriteFallbackReason;
  tokens_used: number;
  cache_hit: boolean;
  audit_event_id: string;
};

/** Server-side plan payload sent to feat-027 elicitation · 跟 feat-045 RcaPlanPayload 同 shape. */
export type RewriteSqlPlanPayload = {
  tool: 'rewrite_neondb_sql';
  endpoint_id: string;
  model: RewriteModelId;
  context_level: 'with_explain' | 'sql_only_simple';
  estimatedInputTokens: number;
  estimatedMaxOutputTokens: number;
  estimatedCostUsd: number;
  cache_hit: boolean;
};

export type RewriteApprovalDecision = 'allow' | 'deny' | 'unavailable';

export type RewriteRequestApproval = (
  payload: RewriteSqlPlanPayload,
) => Promise<RewriteApprovalDecision> | RewriteApprovalDecision;

/** Default = fail-closed deny when elicitation orchestrator not wired (跟 feat-045 同 stance). */
export const DEFAULT_REWRITE_REQUEST_APPROVAL: RewriteRequestApproval = () =>
  'unavailable';

/** Per-model USD per 1M tokens · same source as feat-045 rca/plan-mode.ts PRICE_TABLE. */
const PRICE_TABLE: Record<
  RewriteModelId,
  { inputPer1M: number; outputPer1M: number }
> = {
  'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4 },
};

export function estimateRewriteCostUsd(
  model: RewriteModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICE_TABLE[model];
  const usd =
    (inputTokens / 1_000_000) * p.inputPer1M +
    (outputTokens / 1_000_000) * p.outputPer1M;
  return Math.round(usd * 10_000) / 10_000;
}

// -----------------------------------------------------------------------------
// Context (#185 will replace stub with real EXPLAIN pull via feat-019 tool)
// -----------------------------------------------------------------------------

export type RewriteContext = {
  sql: string;
  explain: string | null;
  path: 'with_explain' | 'sql_only_simple';
};

export type RewriteContextBuilder = (args: {
  sql: string;
  endpoint_id: string;
  level: 'auto' | 'sql_only' | 'with_explain';
}) => Promise<RewriteContext> | RewriteContext;

const DEFAULT_CONTEXT_BUILDER: RewriteContextBuilder = ({ sql }) => ({
  sql,
  explain: null,
  path: 'sql_only_simple',
});

// -----------------------------------------------------------------------------
// LLM rewriter (#185 will replace with feat-045 llm-prompt.ts framework reuse)
// -----------------------------------------------------------------------------

export type RewriteLlmCallResult = {
  best: RewriteOutput;
  backups: RewriteOutput[];
  input_tokens: number;
  output_tokens: number;
  fallback_reason?: RewriteFallbackReason;
};

export type RewriteLlmRewriter = (args: {
  context: RewriteContext;
  model: RewriteModelId;
}) => Promise<RewriteLlmCallResult>;

const DEFAULT_LLM_REWRITER: RewriteLlmRewriter = async () => {
  // #184 stub · #185 replaces with real Anthropic SDK call.
  // Fail-closed: returns self_validation_failed so handler short-circuits without faking data.
  return {
    best: {
      rewritten_sql: '',
      rationale: '',
      expected_improvement: '',
      risks: [],
      confidence: 0,
    },
    backups: [],
    input_tokens: 0,
    output_tokens: 0,
    fallback_reason: 'self_validation_failed',
  };
};

// -----------------------------------------------------------------------------
// Cache (placeholder · #186 接通 feat-064 ttl-cache · state-aware TTL)
// -----------------------------------------------------------------------------

export type RewriteCacheKey = {
  endpoint_id: string;
  sqlHash: string;
  explainHash: string | null;
  model: RewriteModelId;
};

export type RewriteCache = {
  get(key: RewriteCacheKey): RewriteResponse | undefined;
  set(key: RewriteCacheKey, value: RewriteResponse): void;
};

/** Minimal in-memory placeholder · #186 swaps in feat-064 ttl-cache. */
class InMemoryRewriteCache implements RewriteCache {
  private readonly store = new Map<string, RewriteResponse>();
  get(key: RewriteCacheKey): RewriteResponse | undefined {
    return this.store.get(this.serialize(key));
  }
  set(key: RewriteCacheKey, value: RewriteResponse): void {
    this.store.set(this.serialize(key), value);
  }
  private serialize(key: RewriteCacheKey): string {
    return `${key.endpoint_id}|${key.sqlHash}|${key.explainHash ?? ''}|${key.model}`;
  }
}

let defaultCache: RewriteCache | null = null;
export function getDefaultRewriteCache(): RewriteCache {
  if (!defaultCache) defaultCache = new InMemoryRewriteCache();
  return defaultCache;
}

// -----------------------------------------------------------------------------
// Obfuscator (feat-024 T11 · default = identity to keep handler decoupled from
// the live obfuscator binding · production wiring injects the real T11.)
// -----------------------------------------------------------------------------

export type RewriteObfuscator = (sql: string) => string;
const DEFAULT_OBFUSCATOR: RewriteObfuscator = (sql) => sql;

// -----------------------------------------------------------------------------
// Handler dependencies (DI for test + sibling decoupling)
// -----------------------------------------------------------------------------

export type RewriteSqlAuditEvent = {
  event_type: 'sql_rewrite_invoked' | 'sql_rewrite_denied';
  outcome: 'allow' | 'deny';
  endpoint_id: string;
  project_id: string;
  model: RewriteModelId;
  cache_hit: boolean;
  path_used: 'with_explain' | 'sql_only_simple';
  tokens_used: number;
  fallback_reason: RewriteFallbackReason | null;
  duration_ms: number;
  trace_id: string | null;
};

export type RewriteSqlDeps = {
  /** feat-060 claim binding · current project from JWT (route.ts injects). */
  currentProjectId: string;
  /** feat-060 endpoint → project resolver. Returns project_id of the endpoint. */
  resolveEndpointProject?: (endpoint_id: string) => Promise<string> | string;
  contextBuilder?: RewriteContextBuilder;
  llmRewriter?: RewriteLlmRewriter;
  cache?: RewriteCache;
  obfuscator?: RewriteObfuscator;
  requestApproval?: RewriteRequestApproval;
  emitAudit?: (event: RewriteSqlAuditEvent) => void;
  now?: () => Date;
  /** Test hook · skip plan mode entirely (default false · plan mode is fail-closed). */
  skipPlanMode?: boolean;
};

// -----------------------------------------------------------------------------
// Core entry point
// -----------------------------------------------------------------------------

export async function handleRewriteNeondbSql(
  input: RewriteSqlInput,
  deps: RewriteSqlDeps,
): Promise<RewriteResponse> {
  const t0 = Date.now();
  const model: RewriteModelId = input.model ?? 'claude-opus-4-7';
  const useCache = input.cache ?? true;
  const contextLevel = input.context_level ?? 'auto';
  const traceId = input.trace_id ?? null;
  const cache = deps.cache ?? getDefaultRewriteCache();
  const obfuscator = deps.obfuscator ?? DEFAULT_OBFUSCATOR;
  const contextBuilder = deps.contextBuilder ?? DEFAULT_CONTEXT_BUILDER;
  const llmRewriter = deps.llmRewriter ?? DEFAULT_LLM_REWRITER;
  const requestApproval =
    deps.requestApproval ?? DEFAULT_REWRITE_REQUEST_APPROVAL;
  const emitAudit = deps.emitAudit ?? (() => undefined);
  const now = deps.now ?? (() => new Date());

  // 1. feat-060 claim binding · 跨 tenant 拒 (agent project ≠ endpoint project).
  if (deps.resolveEndpointProject) {
    const endpointProject = await deps.resolveEndpointProject(input.endpoint_id);
    if (endpointProject !== deps.currentProjectId) {
      const response: RewriteResponse = {
        best: null,
        backups: [],
        path_used: 'sql_only_simple',
        fallback_reason: 'cross_tenant_blocked',
        tokens_used: 0,
        cache_hit: false,
        audit_event_id: makeAuditEventId(now()),
      };
      emitAudit({
        event_type: 'sql_rewrite_denied',
        outcome: 'deny',
        endpoint_id: input.endpoint_id,
        project_id: deps.currentProjectId,
        model,
        cache_hit: false,
        path_used: 'sql_only_simple',
        tokens_used: 0,
        fallback_reason: 'cross_tenant_blocked',
        duration_ms: Date.now() - t0,
        trace_id: traceId,
      });
      return response;
    }
  }

  // 2. Build context (obfuscation applied to SQL · EXPLAIN obfuscated inside context-builder when wired).
  const obfuscatedSql = obfuscator(input.sql);
  const context = await contextBuilder({
    sql: obfuscatedSql,
    endpoint_id: input.endpoint_id,
    level: contextLevel,
  });

  // 3. Cache lookup (key = obfuscated sql hash + explain hash + model · 防 PII 命中).
  const sqlHash = simpleHash(context.sql);
  const explainHash = context.explain ? simpleHash(context.explain) : null;
  const cacheKey: RewriteCacheKey = {
    endpoint_id: input.endpoint_id,
    sqlHash,
    explainHash,
    model,
  };
  if (useCache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const auditEventId = makeAuditEventId(now());
      emitAudit({
        event_type: 'sql_rewrite_invoked',
        outcome: 'allow',
        endpoint_id: input.endpoint_id,
        project_id: deps.currentProjectId,
        model,
        cache_hit: true,
        path_used: hit.path_used,
        tokens_used: hit.tokens_used,
        fallback_reason: null,
        duration_ms: Date.now() - t0,
        trace_id: traceId,
      });
      return { ...hit, cache_hit: true, audit_event_id: auditEventId };
    }
  }

  // 4. Plan mode elicitation · feat-027 (fail-closed: unavailable → deny without LLM call).
  if (!deps.skipPlanMode) {
    const estimatedInputTokens = estimateTokens(context.sql, context.explain);
    const estimatedMaxOutputTokens = 1000;
    const planPayload: RewriteSqlPlanPayload = {
      tool: 'rewrite_neondb_sql',
      endpoint_id: input.endpoint_id,
      model,
      context_level: context.path,
      estimatedInputTokens,
      estimatedMaxOutputTokens,
      estimatedCostUsd: estimateRewriteCostUsd(
        model,
        estimatedInputTokens,
        estimatedMaxOutputTokens,
      ),
      cache_hit: false,
    };
    const decision = await requestApproval(planPayload);
    if (decision !== 'allow') {
      const auditEventId = makeAuditEventId(now());
      const response: RewriteResponse = {
        best: null,
        backups: [],
        path_used: context.path,
        fallback_reason: 'dba_denied',
        tokens_used: 0,
        cache_hit: false,
        audit_event_id: auditEventId,
      };
      emitAudit({
        event_type: 'sql_rewrite_denied',
        outcome: 'deny',
        endpoint_id: input.endpoint_id,
        project_id: deps.currentProjectId,
        model,
        cache_hit: false,
        path_used: context.path,
        tokens_used: 0,
        fallback_reason: 'dba_denied',
        duration_ms: Date.now() - t0,
        trace_id: traceId,
      });
      return response;
    }
  }

  // 5. LLM rewrite (#185 will inject real Anthropic SDK · self-validation + retry inside).
  const llmResult = await llmRewriter({ context, model });
  const auditEventId = makeAuditEventId(now());
  const response: RewriteResponse = {
    best: llmResult.fallback_reason ? null : llmResult.best,
    backups: llmResult.fallback_reason ? [] : llmResult.backups,
    path_used: context.path,
    fallback_reason: llmResult.fallback_reason,
    tokens_used: llmResult.input_tokens + llmResult.output_tokens,
    cache_hit: false,
    audit_event_id: auditEventId,
  };

  // 6. Cache write (only when LLM succeeded · no fallback reason).
  if (useCache && !llmResult.fallback_reason) {
    cache.set(cacheKey, response);
  }

  // 7. Audit emit · sql_rewrite_invoked (含 fallback_reason 让 DBA 区分 success vs llm_timeout vs validation_failed).
  emitAudit({
    event_type: 'sql_rewrite_invoked',
    outcome: llmResult.fallback_reason ? 'deny' : 'allow',
    endpoint_id: input.endpoint_id,
    project_id: deps.currentProjectId,
    model,
    cache_hit: false,
    path_used: context.path,
    tokens_used: response.tokens_used,
    fallback_reason: llmResult.fallback_reason ?? null,
    duration_ms: Date.now() - t0,
    trace_id: traceId,
  });

  return response;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function simpleHash(input: string): string {
  // Lightweight non-cryptographic hash for cache key uniqueness · two 32-bit djb2 streams
  // (low + high bits) so equal-length inputs differ on more than just final char ·
  // #186 swaps in sha256 once feat-064 ttl-cache seam is wired.
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    lo = (Math.imul(lo, 33) + c) | 0;
    hi = (Math.imul(hi, 65599) + c) | 0;
  }
  const loHex = (lo >>> 0).toString(16).padStart(8, '0');
  const hiHex = (hi >>> 0).toString(16).padStart(8, '0');
  return `${hiHex}${loHex}`;
}

function estimateTokens(sql: string, explain: string | null): number {
  // Rough 4 char/token estimate (matches feat-045 estimateTokens convention).
  const sqlChars = sql.length;
  const explainChars = explain ? explain.length : 0;
  return Math.ceil((sqlChars + explainChars) / 4);
}

let auditCounter = 0;
function makeAuditEventId(_now: Date): string {
  auditCounter = (auditCounter + 1) & 0xffffffff;
  return `${_now.getTime().toString(36)}-${auditCounter.toString(36)}`;
}

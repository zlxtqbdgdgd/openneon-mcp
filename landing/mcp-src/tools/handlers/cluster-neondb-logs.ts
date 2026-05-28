/**
 * cluster_neondb_logs handler · feat-037/#4 (L3) · agent-facing mcp tool.
 *
 * Detail design:
 *   - Parent: https://github.com/zlxtqbdgdgd/openneon-design/issues/51
 *   - #1: openneon-mcp#157 (Drain3 TS 手写)
 *   - #2: openneon-mcp#155 (LLM 主路径)
 *   - #3: openneon-mcp#158 (path-router + LogFetchAdapter)
 *   - #4: openneon-mcp#154 (本文件 · mcp tool + obfuscator + plan mode + audit)
 *   - #5: openneon-mcp#156 (8 case fixture + 跨 model 一致性)
 *
 * 一句话: agent 调本 tool · server 拉 log (LogFetchAdapter) → 强制 obfuscate → path-router 主备
 * 切换 → 出 PatternClusterResult (top N + tail aggregate) · 主路径走 plan mode + audit.
 *
 * Sibling contract dependencies:
 *   - feat-036 (v2 jsonlog) · trace_id filter 真生效需要 v2 jsonlog · v1 阶段返 feat_036_not_ready
 *   - feat-027 plan mode · LLM 主路径调用前 DBA approve · 备路径 Drain3 零 LLM 成本不走 plan mode
 *   - feat-060 claim binding · current_project_id filter (caller 上下文 · 此处接受 projectId 注入)
 *   - feat-024 T11 obfuscator · obfuscateLogLine 强制复用 · raw log 不出 mcp 边界
 *   - feat-031 audit-emit · log_clustering_invoked event
 */

import { z } from 'zod/v3';
import {
  routeAndCluster,
  ForceMainOverLimitError,
  type RouterPayload,
} from '../../server-enrich/pattern/path-router';
import {
  getLogFetchAdapter,
  isLogFetchError,
  type LogFetchAdapter,
  type LogFetchSuccess,
} from '../../server-enrich/metrics-history/log-fetch';
import { obfuscateLogLine } from '../../server-enrich/samples-store/obfuscator';
import {
  buildClusterPlanPayload,
  DEFAULT_CLUSTER_REQUEST_APPROVAL,
  type ClusterRequestApproval,
} from '../../server-enrich/pattern/plan-mode';
import type { RcaModelId } from '../../server-enrich/rca/llm-client';
import type {
  ForcePath,
  LogLine,
  PatternClusterResult,
} from '../../server-enrich/pattern/types';

// ------------------------------------------------------------------------------------------------
// Input schema (zod) · re-exported via toolsSchema.ts for tools registry
// ------------------------------------------------------------------------------------------------

const MODEL_ENUM = z.enum([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);

export const clusterNeondbLogsInputSchema = z.object({
  endpoint_id: z
    .string()
    .min(1)
    .describe('Compute endpoint id (feat-060 claim binding · current_project_id 自动 filter).'),
  time_range: z
    .object({
      start: z.string().describe('ISO8601 start inclusive.'),
      end: z.string().describe('ISO8601 end exclusive.'),
    })
    .describe('Log fetch window · half-open [start, end).'),
  trace_id: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'trace_id must be 32 hex characters (W3C trace_id)')
    .optional()
    .describe(
      'Optional W3C trace_id filter. v1 阶段 (feat-036 v1 raw stderr) 返 feat_036_not_ready · 等 v2 jsonlog ship.',
    ),
  severity: z
    .array(z.enum(['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG']))
    .optional()
    .describe('Severity filter (e.g. ["ERROR","FATAL"]).'),
  force_path: z
    .enum(['auto', 'main', 'backup'])
    .optional()
    .describe(
      'auto (default · 50K token 阈值切主备) · main (强制 LLM · 200K hard cap) · backup (强制 Drain3 · 0 LLM cost).',
    ),
  top_n: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Top N pattern · default 50 (matches drain3.top_n_patterns GUC).'),
  cache: z
    .boolean()
    .optional()
    .describe('Consult router cache · default true · ongoing trace 1h TTL · closed 24h.'),
  trace_state: z
    .enum(['ongoing', 'closed'])
    .optional()
    .describe('Trace state hint · default ongoing (conservative TTL).'),
  model: MODEL_ENUM.optional().describe(
    'LLM model for 主路径 · default claude-opus-4-7 · sonnet/haiku 也支持 (cost vs depth).',
  ),
});

export type ClusterNeondbLogsInput = z.infer<typeof clusterNeondbLogsInputSchema>;

// ------------------------------------------------------------------------------------------------
// Output shape (handler returns this · tool.ts wraps as text response)
// ------------------------------------------------------------------------------------------------

export type ClusterNeondbLogsResult = {
  decision: 'main' | 'backup';
  reason: string;
  estimated_tokens: number;
  fallback_reason: string | null;
  cluster: PatternClusterResult;
  /** 主路径填 · 备路径 0 */
  input_tokens: number;
  output_tokens: number;
  model: RcaModelId | null;
  cached: boolean;
  duration_ms: number;
  /** Log fetch coverage · 让 DBA 知道 tail 是否被 limit 截断 */
  coverage: {
    fetched_lines: number;
    total_matching_lines: number;
    truncated: boolean;
    latest_line_ts: string | null;
  };
  /** 若某 leg degrade · 这里填具体原因 (e.g. feat_036_not_ready) */
  degraded: string[];
};

// ------------------------------------------------------------------------------------------------
// Handler dependencies (DI · test inject + contract-first sibling decoupling)
// ------------------------------------------------------------------------------------------------

export type ClusterNeondbLogsDeps = {
  /** Log fetch adapter · default 取 module-level getLogFetchAdapter() (stub until feat-036 v2). */
  logFetchAdapter?: LogFetchAdapter;
  /** feat-060 claim binding 注入 project_id · audit + tenant isolation */
  projectId?: string;
  /** feat-027 plan mode approval callback · LLM 主路径调用前 DBA approve · default fail-closed deny */
  requestApproval?: ClusterRequestApproval;
  /** Test hook · skip plan mode entirely · prod 走 DEFAULT (fail-closed unavailable) */
  skipPlanMode?: boolean;
  now?: () => Date;
  /** Audit emission · default no-op · prod 由 tools.ts 注入 emitAuditEvent from observability/audit-emit */
  emitAudit?: (event: ClusterAuditEvent) => void;
};

export type ClusterAuditEvent = {
  event_type: 'log_clustering_invoked';
  outcome: 'allow' | 'deny';
  endpoint_id: string;
  project_id: string | null;
  path_used: 'main' | 'backup';
  cost_estimate_usd: number;
  cache_hit: boolean;
  model: RcaModelId | null;
  total_lines: number;
  duration_ms: number;
  fallback_reason: string | null;
};

// ------------------------------------------------------------------------------------------------
// Core entry point
// ------------------------------------------------------------------------------------------------

export async function handleClusterNeondbLogs(
  input: ClusterNeondbLogsInput,
  deps: ClusterNeondbLogsDeps,
): Promise<ClusterNeondbLogsResult> {
  const t0 = Date.now();
  const adapter = deps.logFetchAdapter ?? getLogFetchAdapter();
  const emit = deps.emitAudit ?? (() => undefined);
  const projectId = deps.projectId ?? null;

  // -- 1. Fetch logs (LogFetchAdapter seam · feat-064 pattern)
  const fetchResult = await adapter.fetch({
    endpointId: input.endpoint_id,
    timeRange: input.time_range,
    severity: input.severity,
    traceId: input.trace_id,
    limit: 100_000,
  });

  // staged delivery: trace_id filter 在 v1 阶段返 feat_036_not_ready (Q6B)
  if (isLogFetchError(fetchResult)) {
    const duration = Date.now() - t0;
    const reason = fetchResult.error.reason;
    emit({
      event_type: 'log_clustering_invoked',
      outcome: 'deny',
      endpoint_id: input.endpoint_id,
      project_id: projectId,
      path_used: 'backup',
      cost_estimate_usd: 0,
      cache_hit: false,
      model: null,
      total_lines: 0,
      duration_ms: duration,
      fallback_reason: reason,
    });
    if (reason === 'feat_036_not_ready') {
      // 契约 · agent 看到这个 error 知道是 staged rollout · 不当 backend_error 处理
      const err = new Error(
        `feat_036_not_ready: trace_id filter requires feat-036 v2 jsonlog (staged delivery · Q6B)`,
      );
      (err as Error & { reason: string }).reason = 'feat_036_not_ready';
      throw err;
    }
    throw new Error(
      `log_fetch_failed:${reason}${fetchResult.error.detail ? `:${fetchResult.error.detail}` : ''}`,
    );
  }

  // -- 2. 强制 obfuscate (feat-024 T11 · raw log 不出 mcp 边界 · 即使 adapter 已 obfuscate 再补一道)
  const obfuscated: LogLine[] = fetchResult.lines.map((l) => ({
    ...l,
    message: obfuscateLogLine(l.message),
  }));

  // -- 3. Plan mode (LLM 主路径 only · 备路径零 LLM cost · skip)
  // 提前预判走哪条路径 · 只在 main 时 elicit approval
  const force: ForcePath = (input.force_path ?? 'auto') as ForcePath;
  const willCallLlm =
    force === 'main' ||
    (force === 'auto' && estimateBatchTokens(obfuscated) <= 50_000);

  if (willCallLlm && !deps.skipPlanMode) {
    const approve = deps.requestApproval ?? DEFAULT_CLUSTER_REQUEST_APPROVAL;
    const plan = buildClusterPlanPayload({
      endpointId: input.endpoint_id,
      model: input.model ?? 'claude-opus-4-7',
      estimatedInputTokens: estimateBatchTokens(obfuscated),
      estimatedMaxOutputTokens: 4500,
      totalLines: obfuscated.length,
    });
    const decision = await approve(plan);
    if (decision !== 'approved') {
      const duration = Date.now() - t0;
      emit({
        event_type: 'log_clustering_invoked',
        outcome: 'deny',
        endpoint_id: input.endpoint_id,
        project_id: projectId,
        path_used: 'main',
        cost_estimate_usd: plan.estimatedCostUsd,
        cache_hit: false,
        model: plan.model,
        total_lines: obfuscated.length,
        duration_ms: duration,
        fallback_reason: `plan_mode_${decision}`,
      });
      throw new Error(
        `plan_mode_${decision}: DBA did not approve LLM clustering for endpoint=${input.endpoint_id} (estimated_cost=$${plan.estimatedCostUsd})`,
      );
    }
  }

  // -- 4. Route + cluster (path-router 主备切换 + cache + fallback)
  let routerPayload: RouterPayload;
  try {
    routerPayload = await routeAndCluster({
      endpointId: input.endpoint_id,
      lines: obfuscated,
      forcePath: force,
      topN: input.top_n,
      model: input.model,
      traceId: input.trace_id ?? null,
      severityFilter: input.severity,
      timeRange: input.time_range,
      traceState: input.trace_state,
      cache: input.cache,
    });
  } catch (err) {
    if (err instanceof ForceMainOverLimitError) {
      const duration = Date.now() - t0;
      emit({
        event_type: 'log_clustering_invoked',
        outcome: 'deny',
        endpoint_id: input.endpoint_id,
        project_id: projectId,
        path_used: 'main',
        cost_estimate_usd: 0,
        cache_hit: false,
        model: input.model ?? 'claude-opus-4-7',
        total_lines: obfuscated.length,
        duration_ms: duration,
        fallback_reason: `force_main_over_limit:${err.estimatedTokens}`,
      });
    }
    throw err;
  }

  // -- 5. Audit (allow path · success)
  const duration = Date.now() - t0;
  const costUsd = estimateLlmCostUsd(routerPayload);
  emit({
    event_type: 'log_clustering_invoked',
    outcome: 'allow',
    endpoint_id: input.endpoint_id,
    project_id: projectId,
    path_used: routerPayload.router.decision,
    cost_estimate_usd: costUsd,
    cache_hit: routerPayload.cached,
    model: routerPayload.model,
    total_lines: obfuscated.length,
    duration_ms: duration,
    fallback_reason: routerPayload.router.fallback_reason,
  });

  // -- 6. Result
  return {
    decision: routerPayload.router.decision,
    reason: routerPayload.router.reason,
    estimated_tokens: routerPayload.router.estimated_tokens,
    fallback_reason: routerPayload.router.fallback_reason,
    cluster: routerPayload.cluster,
    input_tokens: routerPayload.input_tokens,
    output_tokens: routerPayload.output_tokens,
    model: routerPayload.model,
    cached: routerPayload.cached,
    duration_ms: duration,
    coverage: {
      fetched_lines: (fetchResult as LogFetchSuccess).coverage.fetched_lines,
      total_matching_lines: (fetchResult as LogFetchSuccess).coverage.total_matching_lines,
      truncated: (fetchResult as LogFetchSuccess).coverage.truncated,
      latest_line_ts: (fetchResult as LogFetchSuccess).coverage.latest_line_ts,
    },
    degraded:
      routerPayload.router.reason === 'fallback_from_main'
        ? ['llm']
        : [],
  };
}

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

function estimateBatchTokens(lines: LogLine[]): number {
  let total = 0;
  for (const l of lines) total += (l.message?.length ?? 0) + 16;
  return Math.ceil(total / 4);
}

function estimateLlmCostUsd(payload: RouterPayload): number {
  if (payload.router.decision === 'backup' || payload.model === null) return 0;
  const PRICE_PER_1M: Record<RcaModelId, { input: number; output: number }> = {
    'claude-opus-4-7': { input: 15, output: 75 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 0.8, output: 4 },
  };
  const p = PRICE_PER_1M[payload.model];
  const usd =
    (payload.input_tokens / 1_000_000) * p.input +
    (payload.output_tokens / 1_000_000) * p.output;
  return Math.round(usd * 10_000) / 10_000;
}

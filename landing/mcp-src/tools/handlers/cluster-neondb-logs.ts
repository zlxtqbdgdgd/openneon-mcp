/**
 * cluster_neondb_logs handler · feat-037/#4 (L3) · agent-facing mcp tool.
 *
 * Detail design:
 *   - Parent: https://github.com/zlxtqbdgdgd/openneon-design/issues/51
 *   - #1: openneon-mcp#157 (Drain3 TS 手写)
 *   - #3: openneon-mcp#158 (path-router + LogFetchAdapter)
 *   - #4: openneon-mcp#154 (本文件 · mcp tool + obfuscator + audit)
 *   - #5: openneon-mcp#156 (8 case fixture)
 *
 * **feat-037 form-shift (规则 P4 · LLM-out-of-mcp)**: 本 tool 只跑确定性聚类 (Drain3) · 不调 LLM。
 * 旧版"LLM 主路径 + plan mode + 跨 model 一致性"已下线 —— 语义命名 (semantic_*) 由 cc skill
 * 拉 enriched cluster 后用 LLM 补全。本 handler 返回 semantic_* = null + cluster_requires_llm_enrichment
 * hint (token 阈值算出 · 给 skill 看)。
 *
 * 一句话: agent 调本 tool · server 拉 log (LogFetchAdapter) → 强制 obfuscate → path-router (Drain3)
 * → cache → 出 PatternClusterResult (top N + tail aggregate · semantic_* null) + audit。
 *
 * Sibling contract dependencies:
 *   - feat-036 (v2 jsonlog) · trace_id filter 真生效需要 v2 jsonlog · v1 阶段返 feat_036_not_ready
 *   - feat-060 claim binding · current_project_id filter (caller 上下文 · 此处接受 projectId 注入)
 *   - feat-024 T11 obfuscator · obfuscateLogLine 强制复用 · raw log 不出 mcp 边界
 *   - feat-031 audit-emit · log_clustering_invoked event
 *   - cc skill · 拉本 tool 出的 deterministic cluster 后做 LLM 语义补全 (plan mode 也归 skill)
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
import type {
  ForcePath,
  LogLine,
  PatternClusterResult,
} from '../../server-enrich/pattern/types';

// ------------------------------------------------------------------------------------------------
// Input schema (zod) · re-exported via toolsSchema.ts for tools registry
// ------------------------------------------------------------------------------------------------

export const clusterNeondbLogsInputSchema = z.object({
  endpoint_id: z
    .string()
    .min(1)
    .describe(
      'Compute endpoint id (claim binding · current_project_id 自动 filter).',
    ),
  time_range: z
    .object({
      start: z.string().describe('ISO8601 start inclusive.'),
      end: z.string().describe('ISO8601 end exclusive.'),
    })
    .describe('Log fetch window · half-open [start, end).'),
  trace_id: z
    .string()
    .regex(
      /^[0-9a-f]{32}$/i,
      'trace_id must be 32 hex characters (W3C trace_id)',
    )
    .optional()
    .describe(
      'Optional W3C trace_id filter. On v1 (raw stderr) 返 feat_036_not_ready · 等 v2 jsonlog ship.',
    ),
  severity: z
    .array(z.enum(['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG']))
    .optional()
    .describe('Severity filter (e.g. ["ERROR","FATAL"]).'),
  force_path: z
    .enum(['auto', 'main', 'backup'])
    .optional()
    .describe(
      'Controls the cluster_requires_llm_enrichment hint for the cc skill (mcp itself never calls LLM). ' +
        'auto (default · ≤50K tokens → hint=true) · main (force hint=true · 200K hard cap) · ' +
        'backup (force hint=false · skill stays deterministic-only).',
    ),
  top_n: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Top N pattern · default 50 (matches drain3.top_n_patterns GUC).',
    ),
  cache: z
    .boolean()
    .optional()
    .describe(
      'Consult router cache · default true · ongoing trace 1h TTL · closed 24h.',
    ),
  trace_state: z
    .enum(['ongoing', 'closed'])
    .optional()
    .describe('Trace state hint · default ongoing (conservative TTL).'),
});

export type ClusterNeondbLogsInput = z.infer<
  typeof clusterNeondbLogsInputSchema
>;

// ------------------------------------------------------------------------------------------------
// Output shape (handler returns this · tool.ts wraps as text response)
// ------------------------------------------------------------------------------------------------

export type ClusterNeondbLogsResult = {
  /** form-shift: mcp 永远跑确定性 Drain3 · decision 恒为 'deterministic' */
  decision: 'deterministic';
  reason: string;
  estimated_tokens: number;
  cluster: PatternClusterResult;
  /**
   * form-shift hint (规则 P4): cc skill 是否被建议对这批 cluster 做 LLM 语义补全.
   * mcp 不调 LLM · 这只是 token 阈值算出的建议 · skill 决定要不要真补。
   */
  cluster_requires_llm_enrichment: boolean;
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
  now?: () => Date;
  /** Audit emission · default no-op · prod 由 tools.ts 注入 emitAuditEvent from observability/audit-emit */
  emitAudit?: (event: ClusterAuditEvent) => void;
};

export type ClusterAuditEvent = {
  event_type: 'log_clustering_invoked';
  outcome: 'allow' | 'deny';
  endpoint_id: string;
  project_id: string | null;
  /** form-shift: mcp 只跑确定性 Drain3 · path 恒为 'deterministic' */
  path_used: 'deterministic';
  /** mcp 不调 LLM · cost 恒为 0 (语义补全成本归 cc skill) */
  cost_estimate_usd: number;
  cache_hit: boolean;
  /** cc skill 是否被建议补语义 (token 阈值算出 hint) */
  requires_llm_enrichment: boolean;
  total_lines: number;
  duration_ms: number;
  /** staged-delivery / fetch degrade 原因 (e.g. feat_036_not_ready) · 否则 null */
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
      path_used: 'deterministic',
      cost_estimate_usd: 0,
      cache_hit: false,
      requires_llm_enrichment: false,
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

  // -- 3. Route + cluster (path-router · 永远跑确定性 Drain3 + cache + enrichment hint)
  // form-shift (规则 P4): mcp 不调 LLM · 无 plan mode (审批归 cc skill) · force=main > 200K 仍拒。
  const force: ForcePath = (input.force_path ?? 'auto') as ForcePath;
  let routerPayload: RouterPayload;
  try {
    routerPayload = await routeAndCluster({
      endpointId: input.endpoint_id,
      lines: obfuscated,
      forcePath: force,
      topN: input.top_n,
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
        path_used: 'deterministic',
        cost_estimate_usd: 0,
        cache_hit: false,
        requires_llm_enrichment: false,
        total_lines: obfuscated.length,
        duration_ms: duration,
        fallback_reason: `force_main_over_limit:${err.estimatedTokens}`,
      });
    }
    throw err;
  }

  // -- 4. Audit (allow path · success) · mcp 不调 LLM · cost 恒 0
  const duration = Date.now() - t0;
  emit({
    event_type: 'log_clustering_invoked',
    outcome: 'allow',
    endpoint_id: input.endpoint_id,
    project_id: projectId,
    path_used: 'deterministic',
    cost_estimate_usd: 0,
    cache_hit: routerPayload.cached,
    requires_llm_enrichment: routerPayload.router.requires_llm_enrichment,
    total_lines: obfuscated.length,
    duration_ms: duration,
    fallback_reason: null,
  });

  // -- 5. Result
  return {
    decision: routerPayload.router.decision,
    reason: routerPayload.router.reason,
    estimated_tokens: routerPayload.router.estimated_tokens,
    cluster: routerPayload.cluster,
    cluster_requires_llm_enrichment:
      routerPayload.router.requires_llm_enrichment,
    cached: routerPayload.cached,
    duration_ms: duration,
    coverage: {
      fetched_lines: (fetchResult as LogFetchSuccess).coverage.fetched_lines,
      total_matching_lines: (fetchResult as LogFetchSuccess).coverage
        .total_matching_lines,
      truncated: (fetchResult as LogFetchSuccess).coverage.truncated,
      latest_line_ts: (fetchResult as LogFetchSuccess).coverage.latest_line_ts,
    },
    degraded: [],
  };
}

/**
 * generate_rca_report handler · feat-045 (L3) · agent-native RCA 报告.
 *
 * Detail design:
 *   - Parent: https://github.com/zlxtqbdgdgd/openneon-design/issues/18
 *   - #1 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/145 (handler + 7 节模板 + 三原则)
 *   - #2 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/146 (4 mcp tool 并行 + plan mode)
 *   - #3 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/147 (6 fixture + token economy + cache)
 *
 * 一句话职责: agent 调本 tool, 传 trace_id, server 并行拉 4 数据源 → 渲染 7 节 markdown 模板 →
 * (optional) plan mode DBA approve → LLM 三原则 prompt 填空 → 落 cache + audit RCA_GENERATED → 返回。
 *
 * Sibling contract dependencies (按 issue body 编程 · A6 真实 PR 待提):
 *   - A6 (openneon-mcp#139) `get_neondb_trace` / `search_neondb_traces` · TraceSpan[] shape
 *     · 真实 import: `../../tools/handlers/get-neondb-trace` (尚未存在 · 集中修阶段对照 contract)
 *   - B2 (feat-068) dynamic probe mcp tool · 同上 contract-first
 *
 * 不引真实 handler import · fetcher 依赖注入 (data-fetcher.ts §RcaFetcherDeps) 让 A6/B2 真接通前
 * 测试可独立跑;生产 wiring 时仅在本文件 `defaultFetcherDeps` 工厂注入真实 handler。
 */

import { z } from 'zod/v3';
import { RcaCache, getDefaultRcaCache, type TraceState } from '../../server-enrich/rca/cache';
import {
  fetchRcaBundle,
  type RcaFetcherDeps,
} from '../../server-enrich/rca/data-fetcher';
import {
  getLlmClient,
  type LlmCallResult,
  type RcaModelId,
  isLlmCallError,
} from '../../server-enrich/rca/llm-client';
import {
  RCA_SYSTEM_PROMPT,
  RCA_MAX_OUTPUT_TOKENS,
  RCA_MAX_INPUT_TOKENS,
  buildUserPayload,
  estimateTokens,
} from '../../server-enrich/rca/llm-prompt';
import {
  buildPlanPayload,
  DEFAULT_REQUEST_APPROVAL,
  type RequestApproval,
} from '../../server-enrich/rca/plan-mode';
import { renderTemplate } from '../../server-enrich/rca/template';
import type {
  RcaDataBundle,
  RcaSection7Input,
} from '../../server-enrich/rca/types';

// -----------------------------------------------------------------------------
// zod input schema (re-exported from toolsSchema.ts; kept here for type co-location)
// -----------------------------------------------------------------------------

const MODEL_ENUM = z.enum([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);

export const generateRcaReportInputSchema = z.object({
  trace_id: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'trace_id must be 32 hex characters (W3C trace_id)')
    .describe('W3C trace_id (32 hex chars) · identifies the incident to RCA.'),
  audit_filter: z
    .object({
      start: z.string().describe('ISO8601 start time inclusive.'),
      end: z.string().describe('ISO8601 end time exclusive.'),
    })
    .optional()
    .describe(
      'Optional time range for audit-event lookup (feat-031 query_audit_events). Defaults to ±10min around the trace.',
    ),
  cache: z
    .boolean()
    .optional()
    .describe(
      'When true (default) consult RCA cache · ongoing trace 60s TTL · closed trace 24h TTL.',
    ),
  trace_state: z
    .enum(['ongoing', 'closed'])
    .optional()
    .describe(
      'Trace state hint · ongoing → 60s cache TTL · closed → 24h. Default ongoing (conservative).',
    ),
  model: MODEL_ENUM.optional().describe(
    'LLM model · default claude-opus-4-7. claude-sonnet-4-6 / claude-haiku-4-5 also supported for cost vs depth tradeoff.',
  ),
});

export type GenerateRcaReportInput = z.infer<typeof generateRcaReportInputSchema>;

// -----------------------------------------------------------------------------
// Result shape
// -----------------------------------------------------------------------------

export type GenerateRcaReportResult = {
  markdown: string;
  trace_id: string;
  model: RcaModelId;
  cached: boolean;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  /** Set when llm/data legs degraded · array of leg names that fell back to [DATA_MISSING:*]. */
  degraded: Array<'trace' | 'probe' | 'audit' | 'validation' | 'llm'>;
};

// -----------------------------------------------------------------------------
// Handler dependencies (DI for test + contract-first sibling decoupling)
// -----------------------------------------------------------------------------

export type GenerateRcaReportDeps = {
  fetcher: RcaFetcherDeps;
  cache?: RcaCache;
  requestApproval?: RequestApproval;
  now?: () => Date;
  /** Test hook · skip plan mode entirely (default false · plan mode is fail-closed). */
  skipPlanMode?: boolean;
  /** Audit emission hook · default no-op (caller wires emitAuditEvent from observability/audit-emit). */
  emitAudit?: (event: {
    event_type: 'rca_generated';
    outcome: 'allow' | 'deny';
    trace_id: string;
    model: RcaModelId;
    cached: boolean;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    degraded: string[];
  }) => void;
};

// -----------------------------------------------------------------------------
// Core entry point
// -----------------------------------------------------------------------------

export async function handleGenerateRcaReport(
  input: GenerateRcaReportInput,
  deps: GenerateRcaReportDeps,
): Promise<GenerateRcaReportResult> {
  const t0 = Date.now();
  const model: RcaModelId = input.model ?? 'claude-opus-4-7';
  const cache = deps.cache ?? getDefaultRcaCache();
  const useCache = input.cache ?? true;
  const traceState: TraceState = input.trace_state ?? 'ongoing';
  const traceId = input.trace_id.toLowerCase();
  const now = deps.now ?? (() => new Date());
  const emit = deps.emitAudit ?? (() => undefined);

  // -- 1. Cache lookup (零 LLM 调用 · §147 验收门).
  if (useCache) {
    const hit = cache.get(traceId, model);
    if (hit) {
      const duration = Date.now() - t0;
      emit({
        event_type: 'rca_generated',
        outcome: 'allow',
        trace_id: traceId,
        model,
        cached: true,
        input_tokens: hit.inputTokens,
        output_tokens: hit.outputTokens,
        duration_ms: duration,
        degraded: [],
      });
      return {
        markdown: hit.markdown,
        trace_id: traceId,
        model,
        cached: true,
        input_tokens: hit.inputTokens,
        output_tokens: hit.outputTokens,
        duration_ms: duration,
        degraded: [],
      };
    }
  }

  // -- 2. Fan-out 4 data fetchers (Promise.allSettled · #146).
  const bundle: RcaDataBundle = await fetchRcaBundle(traceId, deps.fetcher);
  const degraded: GenerateRcaReportResult['degraded'] = [];
  if (!bundle.trace.ok) degraded.push('trace');
  if (!bundle.probe.ok) degraded.push('probe');
  if (!bundle.audit.ok) degraded.push('audit');
  if (!bundle.validation.ok) degraded.push('validation');

  // -- 3. Render 7-section template (server pre-fill · LLM augments).
  const templateInput: RcaSection7Input = {
    traceId,
    generatedAt: now().toISOString(),
    model,
    cacheHit: false,
    estimatedInputTokens: 0, // patched below once payload size is known
    maxOutputTokens: RCA_MAX_OUTPUT_TOKENS,
    trace: bundle.trace.ok ? bundle.trace.data : undefined,
    probe: bundle.probe.ok ? bundle.probe.data : undefined,
    audit: bundle.audit.ok ? bundle.audit.data : undefined,
    validation: bundle.validation.ok ? bundle.validation.data : undefined,
  };
  let templateMarkdown = renderTemplate(templateInput);
  const evidenceAppendix = JSON.stringify(bundle, null, 2);
  let userPayload = buildUserPayload({ templateMarkdown, evidenceAppendix });
  let estInputTokens = estimateTokens(RCA_SYSTEM_PROMPT) + estimateTokens(userPayload);

  // -- 3a. Input-cap guard (truncate appendix · template is sacred · §三原则 rule 3).
  if (estInputTokens > RCA_MAX_INPUT_TOKENS) {
    const truncatedAppendix =
      evidenceAppendix.slice(0, 1500) + '\n\n[DATA_MISSING:evidence_truncated]';
    userPayload = buildUserPayload({
      templateMarkdown,
      evidenceAppendix: truncatedAppendix,
    });
    estInputTokens =
      estimateTokens(RCA_SYSTEM_PROMPT) + estimateTokens(userPayload);
  }

  // Patch the header now that we have the real token estimate.
  templateInput.estimatedInputTokens = estInputTokens;
  templateMarkdown = renderTemplate(templateInput);

  // -- 4. Plan mode (feat-027 elicitation · #146 验收门).
  if (!deps.skipPlanMode) {
    const approve = deps.requestApproval ?? DEFAULT_REQUEST_APPROVAL;
    const plan = buildPlanPayload({
      traceId,
      model,
      estimatedInputTokens: estInputTokens,
      estimatedMaxOutputTokens: RCA_MAX_OUTPUT_TOKENS,
    });
    const decision = await approve(plan);
    if (decision !== 'approved') {
      const duration = Date.now() - t0;
      emit({
        event_type: 'rca_generated',
        outcome: 'deny',
        trace_id: traceId,
        model,
        cached: false,
        input_tokens: estInputTokens,
        output_tokens: 0,
        duration_ms: duration,
        degraded: [...degraded, 'llm'],
      });
      throw new Error(
        `plan_mode_${decision}: DBA did not approve RCA generation for trace_id=${traceId}`,
      );
    }
  }

  // -- 5. LLM call (三原则 prompt · maxTokens hard cap).
  const llmResult: LlmCallResult = await getLlmClient().call({
    model,
    systemPrompt: RCA_SYSTEM_PROMPT,
    userPayload,
    maxTokens: RCA_MAX_OUTPUT_TOKENS,
  });

  let markdown: string;
  let outputTokens: number;
  if (isLlmCallError(llmResult)) {
    // LLM failure → fall back to the server-rendered template + [DATA_MISSING:llm] marker.
    markdown =
      templateMarkdown +
      `\n\n[DATA_MISSING:llm] (reason=${llmResult.error.reason}${llmResult.error.detail ? ` · ${llmResult.error.detail}` : ''})`;
    outputTokens = 0;
    degraded.push('llm');
  } else {
    markdown = llmResult.text;
    outputTokens = llmResult.outputTokens;
  }

  const duration = Date.now() - t0;

  // -- 6. Cache (only when no degrade · § cache.ts NOT cached on error).
  if (useCache && degraded.length === 0) {
    cache.set(
      traceId,
      model,
      {
        markdown,
        generatedAt: templateInput.generatedAt,
        inputTokens: estInputTokens,
        outputTokens,
        model,
      },
      traceState,
    );
  }

  // -- 7. Audit emit RCA_GENERATED (feat-031 hook · caller wires emitAuditEvent).
  emit({
    event_type: 'rca_generated',
    outcome: 'allow',
    trace_id: traceId,
    model,
    cached: false,
    input_tokens: estInputTokens,
    output_tokens: outputTokens,
    duration_ms: duration,
    degraded,
  });

  return {
    markdown,
    trace_id: traceId,
    model,
    cached: false,
    input_tokens: estInputTokens,
    output_tokens: outputTokens,
    duration_ms: duration,
    degraded,
  };
}

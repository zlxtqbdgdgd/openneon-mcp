/**
 * get_neondb_rca_evidence handler · feat-045 (L3) · agent-native RCA 取证器 (form-shift · 规则 P4).
 *
 * Detail design:
 *   - Parent: https://github.com/zlxtqbdgdgd/openneon-design/issues/18
 *   - #1 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/145 (handler + 7 节模板 + 三原则)
 *   - #2 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/146 (4 mcp tool 并行 + plan mode)
 *   - #3 sub: https://github.com/zlxtqbdgdgd/openneon-mcp/issues/147 (6 fixture + token economy + cache)
 *
 * form-shift (规则 P4 · LLM-out-of-mcp · 跟 feat-037 cluster_neondb_logs / feat-067 同 stance):
 *   mcp 只做**确定性取证 + 模板预填**, 不调 LLM。一句话职责: agent 调本 tool, 传 trace_id,
 *   server 并行拉 4 数据源 → 渲染 7 节 markdown 骨架 (server 事实预填 + [DATA_MISSING:*] 降级) →
 *   落 cache + audit RCA_EVIDENCE_FETCHED → 返回 { templateMarkdown, evidenceBundle, ... }。
 *   7 段叙事 prose (归因句) 由 cc skill 写 —— skill 拉本 tool 的预填模板 + 证据 bundle, 调 LLM
 *   填空。plan mode (feat-027 elicitation) + LLM token-cap 也归 cc skill, 不在 mcp。
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
import { RcaCache, getDefaultRcaCache } from '../../server-enrich/rca/cache';
import {
  fetchRcaBundle,
  type RcaFetcherDeps,
} from '../../server-enrich/rca/data-fetcher';
import {
  RCA_MAX_INPUT_TOKENS,
  estimateTokens,
} from '../../server-enrich/rca/llm-prompt';
import { renderTemplate } from '../../server-enrich/rca/template';
import type {
  RcaDataBundle,
  RcaSection7Input,
} from '../../server-enrich/rca/types';

// -----------------------------------------------------------------------------
// zod input schema (re-exported from toolsSchema.ts; kept here for type co-location)
// -----------------------------------------------------------------------------

export const getNeondbRcaEvidenceInputSchema = z.object({
  trace_id: z
    .string()
    .regex(
      /^[0-9a-f]{32}$/i,
      'trace_id must be 32 hex characters (W3C trace_id)',
    )
    .describe(
      'W3C trace_id (32 hex chars) · identifies the incident to gather RCA evidence for.',
    ),
  audit_filter: z
    .object({
      start: z.string().describe('ISO8601 start time inclusive.'),
      end: z.string().describe('ISO8601 end time exclusive.'),
    })
    .optional()
    .describe(
      'Optional time range for audit-event lookup (query_audit_events). Defaults to ±10min around the trace.',
    ),
});

export type GetNeondbRcaEvidenceInput = z.infer<
  typeof getNeondbRcaEvidenceInputSchema
>;

// -----------------------------------------------------------------------------
// Result shape (form-shift: 预填模板 + 证据 bundle · 叙事由 cc skill 写 · 无 LLM 字段)
// -----------------------------------------------------------------------------

export type GetNeondbRcaEvidenceResult = {
  /** 7-section markdown skeleton · server facts pre-filled · cc skill fills NL prose around tables. */
  templateMarkdown: string;
  /** Raw 4-leg evidence bundle · cc skill cites this when writing attribution sentences. */
  evidenceBundle: RcaDataBundle;
  trace_id: string;
  cached: boolean;
  /** Server-estimated input token size of (template + evidence) · cc skill budgets its LLM call. */
  estimatedInputTokens: number;
  duration_ms: number;
  /** Array of leg names that fell back to [DATA_MISSING:*] (server fetch degraded). */
  degradedLegs: Array<'trace' | 'probe' | 'audit' | 'validation'>;
};

// -----------------------------------------------------------------------------
// Handler dependencies (DI for test + contract-first sibling decoupling)
// -----------------------------------------------------------------------------

export type GetNeondbRcaEvidenceDeps = {
  fetcher: RcaFetcherDeps;
  cache?: RcaCache;
  now?: () => Date;
  /** Audit emission hook · default no-op (caller wires emitAuditEvent from observability/audit-emit). */
  emitAudit?: (event: {
    event_type: 'rca_evidence_fetched';
    outcome: 'allow';
    trace_id: string;
    cached: boolean;
    estimated_input_tokens: number;
    duration_ms: number;
    degraded_legs: string[];
  }) => void;
};

// -----------------------------------------------------------------------------
// Core entry point
// -----------------------------------------------------------------------------

export async function handleGetNeondbRcaEvidence(
  input: GetNeondbRcaEvidenceInput,
  deps: GetNeondbRcaEvidenceDeps,
): Promise<GetNeondbRcaEvidenceResult> {
  const t0 = Date.now();
  const cache = deps.cache ?? getDefaultRcaCache();
  const traceId = input.trace_id.toLowerCase();
  const now = deps.now ?? (() => new Date());
  const emit = deps.emitAudit ?? (() => undefined);

  // -- 1. Cache lookup (零外部 fetch · §147 验收门 · template+evidence 一起缓).
  const hit = cache.get(traceId);
  if (hit) {
    const duration = Date.now() - t0;
    emit({
      event_type: 'rca_evidence_fetched',
      outcome: 'allow',
      trace_id: traceId,
      cached: true,
      estimated_input_tokens: hit.estimatedInputTokens,
      duration_ms: duration,
      degraded_legs: hit.degradedLegs,
    });
    return {
      templateMarkdown: hit.templateMarkdown,
      evidenceBundle: hit.evidenceBundle,
      trace_id: traceId,
      cached: true,
      estimatedInputTokens: hit.estimatedInputTokens,
      duration_ms: duration,
      degradedLegs: hit.degradedLegs,
    };
  }

  // -- 2. Fan-out 4 data fetchers (Promise.allSettled · #146).
  const bundle: RcaDataBundle = await fetchRcaBundle(traceId, deps.fetcher);
  const degradedLegs: GetNeondbRcaEvidenceResult['degradedLegs'] = [];
  if (!bundle.trace.ok) degradedLegs.push('trace');
  if (!bundle.probe.ok) degradedLegs.push('probe');
  if (!bundle.audit.ok) degradedLegs.push('audit');
  if (!bundle.validation.ok) degradedLegs.push('validation');

  // -- 3. Render 7-section template (server pre-fill · cc skill augments with NL prose).
  const templateInput: RcaSection7Input = {
    traceId,
    generatedAt: now().toISOString(),
    cacheHit: false,
    estimatedInputTokens: 0, // patched below once payload size is known
    trace: bundle.trace.ok ? bundle.trace.data : undefined,
    probe: bundle.probe.ok ? bundle.probe.data : undefined,
    audit: bundle.audit.ok ? bundle.audit.data : undefined,
    validation: bundle.validation.ok ? bundle.validation.data : undefined,
  };
  let templateMarkdown = renderTemplate(templateInput);
  // Server-estimated input size of (template + evidence) · the cc skill budgets its own LLM call
  // against this · the mcp tool itself never calls an LLM (form-shift · 规则 P4).
  const evidenceJson = JSON.stringify(bundle, null, 2);
  const estInputTokens =
    estimateTokens(templateMarkdown) + estimateTokens(evidenceJson);

  // Patch the header now that we have the real token estimate.
  templateInput.estimatedInputTokens = Math.min(
    estInputTokens,
    RCA_MAX_INPUT_TOKENS,
  );
  templateMarkdown = renderTemplate(templateInput);

  const duration = Date.now() - t0;

  // -- 4. Cache (only when no degrade · § cache.ts NOT cached on error).
  if (degradedLegs.length === 0) {
    cache.set(traceId, {
      templateMarkdown,
      evidenceBundle: bundle,
      generatedAt: templateInput.generatedAt,
      estimatedInputTokens: estInputTokens,
      degradedLegs,
    });
  }

  // -- 5. Audit emit RCA_EVIDENCE_FETCHED (feat-031 hook · caller wires emitAuditEvent).
  //       取证 audit (不是 "LLM 生成" · LLM 调用归 cc skill).
  emit({
    event_type: 'rca_evidence_fetched',
    outcome: 'allow',
    trace_id: traceId,
    cached: false,
    estimated_input_tokens: estInputTokens,
    duration_ms: duration,
    degraded_legs: degradedLegs,
  });

  return {
    templateMarkdown,
    evidenceBundle: bundle,
    trace_id: traceId,
    cached: false,
    estimatedInputTokens: estInputTokens,
    duration_ms: duration,
    degradedLegs,
  };
}

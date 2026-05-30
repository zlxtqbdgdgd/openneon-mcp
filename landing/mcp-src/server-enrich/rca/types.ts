/**
 * RCA shared types · feat-045 (L3).
 *
 * Detail design: zlxtqbdgdgd/openneon-design#18 §Scope (RCA 报告模板) + openneon-mcp#139
 * (A6 feat-066 trace contract · TraceSpan / TraceSummary shape).
 *
 * Server-side computed view that the template renderer consumes. Each field corresponds to one
 * RCA section · `undefined` means the upstream fetcher failed and the renderer should emit a
 * `[DATA_MISSING:<source>]` placeholder (degrade gracefully).
 */

/** Trace data view (compacted from A6 `get_neondb_trace` output). */
export type RcaTraceView = {
  spanTree: Array<{
    serviceName: string;
    operationName: string;
    durationMs: number;
    depth: number;
  }>;
  componentLatency: Array<{
    component: 'proxy' | 'compute' | 'safekeeper' | 'pageserver';
    durationMs: number;
    pct: number;
  }>;
};

/** Probe data view (from feat-068 dynamic probe tool · optional · degrade gracefully). */
export type RcaProbeView = {
  hotspots: Array<{
    functionName: string;
    p95Ms: number;
    hotspotPct: number;
  }>;
};

/** Audit timeline view (from feat-031 query_audit_events · sourced from feat-044 state machine). */
export type RcaAuditView = {
  events: Array<{
    deltaSeconds: number;
    stage: '感知' | '定位' | '假设' | '修复' | '验证';
    summary: string;
  }>;
};

/** Validation view (from feat-019 compute_explain_diff · before/after compare). */
export type RcaValidationView = {
  beforeMs: number;
  afterMs: number;
  explainDiffSha256: string;
};

/**
 * Aggregate input to the 7-section template renderer.
 *
 * form-shift (规则 P4): no `model` / `maxOutputTokens` here — the mcp tool only pre-fills server
 * facts; model selection + LLM output budget live in the cc skill.
 */
export type RcaSection7Input = {
  traceId: string;
  generatedAt: string; // ISO8601
  cacheHit: boolean;
  estimatedInputTokens: number;
  trace?: RcaTraceView;
  probe?: RcaProbeView;
  audit?: RcaAuditView;
  validation?: RcaValidationView;
};

/** Reasons a per-leg fetch may degrade. */
export type FetchLegStatus = 'ok' | 'unavailable' | 'auth' | 'timeout';

/** Per-leg fetch result · structured for [DATA_MISSING:*] mapping. */
export type FetchLeg<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FetchLegStatus; detail?: string };

/** What `data-fetcher.ts` returns to the handler. */
export type RcaDataBundle = {
  trace: FetchLeg<RcaTraceView>;
  probe: FetchLeg<RcaProbeView>;
  audit: FetchLeg<RcaAuditView>;
  validation: FetchLeg<RcaValidationView>;
};

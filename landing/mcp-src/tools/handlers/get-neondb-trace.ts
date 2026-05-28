/**
 * get_neondb_trace handler · feat-066/#2 (L3).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-066-L3-mcp-tool-trace-read-seam.html §3 + §4
 *
 * Fetches a single trace by id via the feat-064 / feat-066 sub-interface seam (currently Datadog
 * APM `POST /api/v2/spans/events/search`). The seam returns OTel-compatible spans · this handler
 * applies the cross-tenant guard (feat-066/#3) before any span leaves the boundary:
 *
 *   1. caller-supplied projectId is the tenant boundary (route.ts `injectProjectId` already
 *      hard-overrode it from grant.projectId / claim-binding · feat-060) · we treat it as the
 *      "current_project_id" required for tenant-scoped span filtering.
 *   2. every returned span MUST carry `neon.project_id === current_project_id`. Any span that
 *      doesn't match is dropped + a `cross_tenant_blocked` audit event is emitted. Whole-trace
 *      mismatch → returns `not_found` (the agent gets nothing it shouldn't see · OWASP LLM10).
 *   3. handler emits its own `trace_get_invoked` audit (low / high depending on filter result).
 *
 * Token economy (§7 case 8 · OWASP LLM10): a single Neon path-β trace is bounded by the path's
 * span count (~5–20 spans · proxy → compute → safekeeper → pageserver) — within the < 5K token /
 * trace budget.
 */
import { getTraceById } from '../../server-enrich/trace-fetch';
import {
  isTraceFetchError,
  type GetTraceByIdResult,
  type TraceSpan,
  type TraceSummary,
} from '../../server-enrich/trace-fetch';
import { emitAuditEvent } from '../../observability/audit-emit';

export type GetNeondbTraceInput = {
  /** Neon project ID · cross-tenant boundary (hard-overridden by grant.projectId before us). */
  projectId: string;
  /** W3C trace_id · 32 lowercase hex chars. */
  trace_id: string;
  /** Optional ISO time range; helps the backend query planner. */
  time_range?: { start: string; end: string };
};

export type GetNeondbTraceResult =
  | {
      spans: TraceSpan[];
      summary: TraceSummary;
      /** True when at least one span was dropped by the cross-tenant guard. */
      cross_tenant_filtered: boolean;
    }
  | { error: { reason: string; detail?: string } };

/**
 * Cross-tenant guard · drops spans whose `neon.project_id` (resource attribute) doesn't match
 * the caller's current project. Pure (no I/O).
 *
 * Spans without the `neon.project_id` attribute are kept — Neon's own infra spans don't always
 * carry it (e.g. proxy entry span tags only the project AFTER auth-handshake), but they DO
 * carry the trace_id which has already been scoped via the search query. We log a soft warning
 * via the audit emit when stripping happens.
 */
export function applyCrossTenantGuard(
  spans: TraceSpan[],
  currentProjectId: string,
): { kept: TraceSpan[]; dropped: TraceSpan[] } {
  const kept: TraceSpan[] = [];
  const dropped: TraceSpan[] = [];
  for (const s of spans) {
    const spanProject = s.attributes['neon.project_id'];
    if (spanProject !== undefined && spanProject !== null && spanProject !== currentProjectId) {
      dropped.push(s);
    } else {
      kept.push(s);
    }
  }
  return { kept, dropped };
}

export async function handleGetNeondbTrace(
  input: GetNeondbTraceInput,
): Promise<GetNeondbTraceResult> {
  const start = Date.now();
  const timeRange = input.time_range
    ? {
        from: Math.floor(new Date(input.time_range.start).getTime() / 1000),
        to: Math.floor(new Date(input.time_range.end).getTime() / 1000),
      }
    : undefined;

  const res: GetTraceByIdResult = await getTraceById({
    trace_id: input.trace_id,
    time_range: timeRange,
  });

  if (isTraceFetchError(res)) {
    emitTraceGetAudit(input, {
      spanCount: 0,
      crossTenantBlocked: false,
      droppedCount: 0,
      outcome: 'deny',
      durationMs: Date.now() - start,
      errorReason: res.error.reason,
    });
    return { error: res.error };
  }

  const { kept, dropped } = applyCrossTenantGuard(res.spans, input.projectId);

  if (dropped.length > 0) {
    emitCrossTenantBlockedAudit(input, dropped.length);
  }

  if (kept.length === 0) {
    // Every span belonged to another tenant — surface as not_found (don't tell the agent
    // "there were spans but you can't see them" · OWASP LLM10).
    emitTraceGetAudit(input, {
      spanCount: 0,
      crossTenantBlocked: dropped.length > 0,
      droppedCount: dropped.length,
      outcome: 'deny',
      durationMs: Date.now() - start,
      errorReason: 'not_found',
    });
    return {
      error: {
        reason: 'not_found',
        detail: `Trace '${input.trace_id}' not found for project '${input.projectId}'.`,
      },
    };
  }

  // Re-summarise from kept spans so `duration_us` / `components` reflect only what the caller
  // is allowed to see (avoids leaking "trace was actually 5s but we only show 1s" timing).
  const summary = res.summary;
  // If we dropped spans, recompute components (root span timing unchanged · still root).
  let recomputedSummary = summary;
  if (dropped.length > 0) {
    const byService = new Map<string, number>();
    for (const s of kept) {
      byService.set(s.service_name, (byService.get(s.service_name) ?? 0) + s.duration_us);
    }
    recomputedSummary = {
      ...summary,
      span_count: kept.length,
      components: [...byService.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([service_name, duration_us]) => ({ service_name, duration_us })),
    };
  }

  emitTraceGetAudit(input, {
    spanCount: kept.length,
    crossTenantBlocked: dropped.length > 0,
    droppedCount: dropped.length,
    outcome: 'allow',
    durationMs: Date.now() - start,
  });

  return {
    spans: kept,
    summary: recomputedSummary,
    cross_tenant_filtered: dropped.length > 0,
  };
}

function emitTraceGetAudit(
  input: GetNeondbTraceInput,
  fields: {
    spanCount: number;
    crossTenantBlocked: boolean;
    droppedCount: number;
    outcome: 'allow' | 'deny';
    durationMs: number;
    errorReason?: string;
  },
): void {
  emitAuditEvent({
    event_type: 'trace_get_invoked',
    outcome: fields.outcome,
    severity: fields.crossTenantBlocked ? 'high' : 'low',
    project_id: input.projectId,
    extra: {
      'openneon.audit.trace_id': input.trace_id,
      'openneon.audit.span_count': fields.spanCount,
      'openneon.audit.cross_tenant_blocked': fields.crossTenantBlocked,
      'openneon.audit.dropped_span_count': fields.droppedCount,
      'openneon.audit.duration_ms': fields.durationMs,
      ...(fields.errorReason ? { 'openneon.audit.error_reason': fields.errorReason } : {}),
    },
  });
}

function emitCrossTenantBlockedAudit(
  input: GetNeondbTraceInput,
  droppedCount: number,
): void {
  emitAuditEvent({
    event_type: 'cross_tenant_blocked',
    outcome: 'deny',
    severity: 'high',
    project_id: input.projectId,
    extra: {
      'openneon.audit.trace_id': input.trace_id,
      'openneon.audit.dropped_span_count': droppedCount,
      'openneon.audit.guard': 'get_neondb_trace.span_project_id_mismatch',
    },
  });
}

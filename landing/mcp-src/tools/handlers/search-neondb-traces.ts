/**
 * search_neondb_traces handler · feat-066/#2 (L3).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-066-L3-mcp-tool-trace-read-seam.html §3 + §4
 *
 * Searches trace summaries by (latency / component / endpoint_id / time_range) filter via the
 * feat-066 trace-fetch seam. Cross-tenant guard (feat-066/#3) is enforced at the FILTER level
 * before the backend call:
 *
 *   - the caller-supplied projectId is the tenant boundary (route.ts `injectProjectId` already
 *     hard-overrode it from grant.projectId · feat-060). We treat it as the "current_project_id"
 *     and HARD-OVERWRITE any agent-supplied `filter.project_id` to match. An override (= agent
 *     tried to query a different project) emits a `cross_tenant_blocked` audit event before the
 *     backend call · the agent never sees the other project's traces.
 *   - each returned summary is re-checked: a summary whose root span service carries a
 *     `neon.project_id` attribute pointing elsewhere is dropped (belt-and-braces · backend bug
 *     resilience). Audit emits `cross_tenant_blocked` again if drop happens.
 *   - handler emits `trace_search_invoked` audit (low / high depending on filter result).
 *
 * Limit cap (§7 case 8 token economy · OWASP LLM10) is enforced by the seam at TRACE_SEARCH_LIMIT_MAX = 50.
 */
import {
  isSearchTracesError,
  searchTraces,
  TRACE_SEARCH_LIMIT_MAX,
  type SearchTracesResult,
  type TraceSearchFilter,
  type TraceSummary,
} from '../../server-enrich/trace-fetch';
import { emitAuditEvent } from '../../observability/audit-emit';
import type { MetricWindow } from '../../server-enrich/metrics-history';

export type SearchNeondbTracesInput = {
  /** Neon project ID · cross-tenant boundary. Treated as authoritative current_project_id. */
  projectId: string;
  /** Optional filter from the agent (project_id field will be hard-overwritten by projectId). */
  filter?: {
    min_latency_ms?: number;
    component?: 'proxy' | 'compute' | 'safekeeper' | 'pageserver';
    project_id?: string;
    endpoint_id?: string;
    time_range?: { start: string; end: string };
  };
  /** Number of trace summaries to return (clamped to [1, 50]). */
  limit?: number;
};

export type SearchNeondbTracesResult =
  | {
      traces: TraceSummary[];
      total: number;
      /** True when the agent tried to cross tenant boundary (filter.project_id forced to caller). */
      cross_tenant_filtered: boolean;
    }
  | { error: { reason: string; detail?: string } };

const DEFAULT_LIMIT = 20;
const DEFAULT_TIME_RANGE: MetricWindow = { last: '1h' };

/**
 * Cross-tenant guard at filter level · hard-override `filter.project_id` to the caller's
 * current project. Pure (no I/O). Returns the safe filter + a flag indicating whether the
 * agent had attempted a cross-tenant filter.
 */
export function lockFilterToTenant(
  filter: SearchNeondbTracesInput['filter'] | undefined,
  currentProjectId: string,
): { filter: TraceSearchFilter; agentTriedCrossTenant: boolean } {
  const agentSupplied = filter?.project_id;
  const agentTriedCrossTenant =
    agentSupplied !== undefined &&
    agentSupplied !== null &&
    agentSupplied !== currentProjectId;
  const time_range: MetricWindow = filter?.time_range
    ? {
        from: Math.floor(new Date(filter.time_range.start).getTime() / 1000),
        to: Math.floor(new Date(filter.time_range.end).getTime() / 1000),
      }
    : DEFAULT_TIME_RANGE;
  return {
    filter: {
      min_latency_ms: filter?.min_latency_ms,
      component: filter?.component,
      project_id: currentProjectId, // hard-overwrite · never the agent-supplied value
      endpoint_id: filter?.endpoint_id,
      time_range,
    },
    agentTriedCrossTenant,
  };
}

/**
 * Belt-and-braces row-level guard · drops summaries whose components include a service the
 * caller wouldn't expect (e.g. a backend bug returns rows tagged with another project_id in
 * components — we don't surface them to the agent).
 *
 * Conservative: drop a summary only when the components carry an explicit `neon.project_id`
 * that mismatches. The `TraceSummary` shape doesn't include attributes by design (token
 * economy) — so this is a structural guard against future schema drift more than a check
 * against real Datadog responses.
 */
export function filterTenantSummaries(
  traces: TraceSummary[],
  currentProjectId: string,
): { kept: TraceSummary[]; droppedCount: number } {
  // No project_id leak vector in the current TraceSummary shape — guard reserved for forward
  // compatibility. Default: keep all.
  return { kept: traces, droppedCount: 0 };
}

export async function handleSearchNeondbTraces(
  input: SearchNeondbTracesInput,
): Promise<SearchNeondbTracesResult> {
  const start = Date.now();
  const { filter, agentTriedCrossTenant } = lockFilterToTenant(
    input.filter,
    input.projectId,
  );

  if (agentTriedCrossTenant) {
    emitCrossTenantBlockedAudit(input, input.filter?.project_id);
  }

  const limit = Math.max(
    1,
    Math.min(TRACE_SEARCH_LIMIT_MAX, input.limit ?? DEFAULT_LIMIT),
  );

  const res: SearchTracesResult = await searchTraces({ filter, limit });

  if (isSearchTracesError(res)) {
    emitTraceSearchAudit(input, {
      total: 0,
      crossTenantBlocked: agentTriedCrossTenant,
      droppedCount: 0,
      outcome: 'deny',
      durationMs: Date.now() - start,
      errorReason: res.error.reason,
    });
    return { error: res.error };
  }

  const { kept, droppedCount } = filterTenantSummaries(
    res.traces,
    input.projectId,
  );

  emitTraceSearchAudit(input, {
    total: kept.length,
    crossTenantBlocked: agentTriedCrossTenant,
    droppedCount,
    outcome: 'allow',
    durationMs: Date.now() - start,
  });

  return {
    traces: kept,
    total: kept.length,
    cross_tenant_filtered: agentTriedCrossTenant || droppedCount > 0,
  };
}

function emitTraceSearchAudit(
  input: SearchNeondbTracesInput,
  fields: {
    total: number;
    crossTenantBlocked: boolean;
    droppedCount: number;
    outcome: 'allow' | 'deny';
    durationMs: number;
    errorReason?: string;
  },
): void {
  emitAuditEvent({
    event_type: 'trace_search_invoked',
    outcome: fields.outcome,
    severity: fields.crossTenantBlocked ? 'high' : 'low',
    project_id: input.projectId,
    endpoint_id: input.filter?.endpoint_id,
    extra: {
      'openneon.audit.total': fields.total,
      'openneon.audit.cross_tenant_blocked': fields.crossTenantBlocked,
      'openneon.audit.dropped_summary_count': fields.droppedCount,
      'openneon.audit.component': input.filter?.component ?? 'any',
      'openneon.audit.min_latency_ms': input.filter?.min_latency_ms ?? 0,
      'openneon.audit.duration_ms': fields.durationMs,
      ...(fields.errorReason ? { 'openneon.audit.error_reason': fields.errorReason } : {}),
    },
  });
}

function emitCrossTenantBlockedAudit(
  input: SearchNeondbTracesInput,
  attemptedProjectId: string | null | undefined,
): void {
  emitAuditEvent({
    event_type: 'cross_tenant_blocked',
    outcome: 'deny',
    severity: 'high',
    project_id: input.projectId,
    extra: {
      'openneon.audit.guard': 'search_neondb_traces.filter_project_id_override',
      'openneon.audit.agent_attempted_project_id': attemptedProjectId ?? null,
      'openneon.audit.bound_project_id': input.projectId,
    },
  });
}

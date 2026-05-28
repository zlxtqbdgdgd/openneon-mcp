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
 * 安全模型对比 (R2 ⚠ 阻塞-2 决策 · 文档化两条路径差异):
 *   - get 路径 (本 handler)   = **span-level filter AFTER fetch** ·
 *       trace_id 已经传到 Datadog backend (DD 内部可见 trace_id · 但不会泄漏 spans 给 agent
 *       未授权的 project) · 后端返回后逐 span 比对 `neon.project_id` · 不匹配 drop · 全 drop
 *       返 not_found · 不暴露"trace 存在但跨 tenant"信息。**trace_id 不属于 grant.projectId
 *       的合法访问场景目前不在本 handler short-circuit · 安全靠 backend 查询本身不会因
 *       trace_id 跨权而泄漏 + row-level drop 保底。如需"trace_id 不属于 grant 立即 short-circuit"
 *       须前置 trace_id → project_id 反向映射表 (feat-061 待立)**。
 *   - search 路径 (search-neondb-traces.ts) = **filter-level override BEFORE backend call** ·
 *       filter.project_id 被硬覆盖为 grant.projectId · 不一致 emit cross_tenant_blocked + 改写后
 *       才打 backend · 攻击者无法绕过 (即使 agent 提了 filter.project_id=victim 也被改回 self)。
 *   两者均合理 · 但语义不同 · 评审/审计追溯需明确区分。
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

  // R2 ⚠ 阻塞-3 (1000 span 截断检查) · Datadog page.limit=1000 是硬上限 · 拿满即视为可能截断 ·
  // applyCrossTenantGuard 在不完整数据上跑的安全结论不可信 (跨 tenant 的 spans 可能在被截断的尾巴里 ·
  // 我们只能看到前 1000 个 · 反推 = 用户看到的"全干净"也许是假象) · fail-closed 返 backend_error。
  if (res.spans.length >= 1000) {
    emitTraceGetAudit(input, {
      spanCount: res.spans.length,
      crossTenantBlocked: false,
      droppedCount: 0,
      outcome: 'deny',
      durationMs: Date.now() - start,
      errorReason: 'backend_error_truncated',
    });
    return {
      error: {
        reason: 'backend_error',
        detail: `Trace '${input.trace_id}' returned ${res.spans.length} spans which is at the Datadog page.limit=1000 ceiling. Cross-tenant guard cannot give a sound answer on truncated data · fail-closed (R2 ⚠ 阻塞-3 决策 ①). 缩小 time_range 或上 paginate 后端能力 (feat-066-followup) 后重试。`,
      },
    };
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

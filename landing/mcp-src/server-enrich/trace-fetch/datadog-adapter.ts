/**
 * Datadog trace-fetch adapter · feat-066 (L2a · sub-interface 拆出).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-066-L3-mcp-tool-trace-read-seam.html §3.3
 *
 * Translates a logical trace lookup / search into Datadog APM `POST /api/v2/spans/events/search`
 * calls (the only public Datadog endpoint that exposes APM span events · the legacy
 * `/api/v1/trace/{id}` is NOT a public API — Phase C 详设 §11 风险表已澄清). All shaping happens
 * here · the seam contract stays vendor-neutral.
 *
 * Failure (network / auth / rate-limited / backend error / explicit not-found) returns an
 * `error` result · NEVER an empty-spans success. fail-closed (§6) — symmetric with the metrics
 * adapter (feat-064).
 *
 * Reuses (ADR-0009 单一收口 · shared落点):
 *   - readDatadogConfig (DD_API_KEY / DD_APP_KEY / DD_SITE)
 *   - classifyHttpStatus (auth / rate_limited / backend_error)
 *   - resolveWindow (relative '7d' / absolute {from,to})
 */

import { readDatadogConfig } from '../metrics-history/datadog-config';
import {
  classifyHttpStatus,
} from '../metrics-history/datadog-adapter';
import { resolveWindow } from '../metrics-history/duration';
import type { MetricWindow } from '../metrics-history/types';
import type {
  GetTraceByIdRequest,
  GetTraceByIdResult,
  SearchTracesResult,
  TraceFetchAdapter,
  TraceSearchRequest,
  TraceSearchFilter,
  TraceSpan,
  TraceSummary,
} from './types';
import { TRACE_SEARCH_LIMIT_MAX } from './types';

type FetchLike = typeof fetch;

/**
 * Datadog spans/events response shape · only the fields we touch are typed. The actual API
 * returns much richer payload — we narrow to what's needed (forward-compat against schema drift).
 */
type DatadogSpanEvent = {
  id?: string;
  attributes?: {
    /** epoch ns or ISO — Datadog returns ISO in the documented `attributes.start` field. */
    start?: string;
    /** Duration in nanoseconds (Datadog APM convention · we convert to µs). */
    duration?: number;
    service?: string;
    'resource_name'?: string;
    'operation_name'?: string;
    'trace_id'?: string;
    'span_id'?: string;
    'parent_id'?: string;
    /** OTel status_code mapped to Datadog `error` flag. */
    'error'?: number | boolean;
    /** Custom tags · keyed flat (`@neon.project_id`) or nested under `custom`. */
    custom?: Record<string, unknown>;
    tags?: string[];
    /** W3C tracestate · forwarded when DD APM ingested the OTel attribute. */
    tracestate?: string;
  };
};

type DatadogSpansSearchBody = {
  data?: DatadogSpanEvent[];
  errors?: Array<{ status?: string; title?: string; detail?: string }>;
};

const DATADOG_SPANS_SEARCH_PATH = '/api/v2/spans/events/search';

/** Trace_id MUST be 32 lowercase hex chars (W3C trace-context · feat-066 §3.2). */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;

function isValidTraceId(s: string): boolean {
  return TRACE_ID_RE.test(s);
}

/**
 * Map Datadog `attributes.tags` (string[] of `key:value` pairs) + `attributes.custom` (nested)
 * into a flat OTel-style attribute bag. Tags win over custom when both present.
 */
function flattenAttributes(ev: DatadogSpanEvent): TraceSpan['attributes'] {
  const out: TraceSpan['attributes'] = {};
  const a = ev.attributes ?? {};
  if (a.service) out['service.name'] = a.service;
  if (a.resource_name) out['resource.name'] = a.resource_name;
  if (a.operation_name) out['operation.name'] = a.operation_name;
  // Custom dict (e.g. neon.project_id / neon.endpoint_id / neon.branch_id / neon.tenant_id).
  if (a.custom && typeof a.custom === 'object') {
    for (const [k, v] of Object.entries(a.custom)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        out[k] = v as string | number | boolean | null;
      }
    }
  }
  // Tag strings · `@neon.project_id:abc` form (DD reserved-attribute prefix `@`).
  if (Array.isArray(a.tags)) {
    for (const tag of a.tags) {
      const idx = tag.indexOf(':');
      if (idx <= 0) continue;
      const key = tag.slice(0, idx).replace(/^@/, '');
      const value = tag.slice(idx + 1);
      // Only set if not already present (custom field wins · explicit > tag string).
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

/**
 * Convert one Datadog span event into the vendor-neutral TraceSpan shape. Pure.
 */
export function spanFromDatadogEvent(ev: DatadogSpanEvent): TraceSpan | null {
  const a = ev.attributes ?? {};
  const trace_id = a.trace_id;
  const span_id = a.span_id;
  if (!trace_id || !span_id) return null;
  const durationNs = typeof a.duration === 'number' ? a.duration : 0;
  return {
    trace_id,
    span_id,
    parent_span_id: a.parent_id && a.parent_id !== '0' ? a.parent_id : undefined,
    service_name: a.service ?? 'unknown',
    operation_name: a.operation_name ?? a.resource_name ?? 'unknown',
    start_time: a.start ?? new Date(0).toISOString(),
    duration_us: Math.floor(durationNs / 1000),
    attributes: flattenAttributes(ev),
    tracestate: a.tracestate,
  };
}

/**
 * Build the Datadog `/api/v2/spans/events/search` request body for a trace_id lookup.
 * The query DSL is `trace_id:<id> @env:*` (env wildcard keeps it portable across envs · refined
 * downstream if needed). Pure.
 */
export function buildTraceByIdQuery(
  trace_id: string,
  window: { from: number; to: number },
): object {
  return {
    data: {
      type: 'search_request',
      attributes: {
        filter: {
          query: `trace_id:${trace_id}`,
          from: new Date(window.from * 1000).toISOString(),
          to: new Date(window.to * 1000).toISOString(),
        },
        sort: 'timestamp',
        // 1000 should comfortably fit any single trace (Neon path β is ~5–20 spans).
        page: { limit: 1000 },
      },
    },
  };
}

/** Build the search-by-filter query string · DD DSL. Pure. */
export function buildSearchQuery(filter: TraceSearchFilter): string {
  const clauses: string[] = ['@_top_level:1']; // root spans only · 1 row per trace
  if (filter.min_latency_ms !== undefined && filter.min_latency_ms > 0) {
    // Datadog stores duration in ns · convert ms → ns inline.
    const ns = Math.floor(filter.min_latency_ms * 1_000_000);
    clauses.push(`@duration:>${ns}`);
  }
  if (filter.component) {
    // Map logical → DD service-name namespace (neon-* convention · feat-031 OTel infra).
    clauses.push(`service:neon-${filter.component}`);
  }
  if (filter.project_id) {
    clauses.push(`@neon.project_id:${filter.project_id}`);
  }
  if (filter.endpoint_id) {
    clauses.push(`@neon.endpoint_id:${filter.endpoint_id}`);
  }
  return clauses.join(' ');
}

/**
 * Build the Datadog `/api/v2/spans/events/search` request body for a search-by-filter call.
 * Pure.
 */
export function buildSearchRequestBody(
  req: TraceSearchRequest,
  window: { from: number; to: number },
): object {
  return {
    data: {
      type: 'search_request',
      attributes: {
        filter: {
          query: buildSearchQuery(req.filter),
          from: new Date(window.from * 1000).toISOString(),
          to: new Date(window.to * 1000).toISOString(),
        },
        sort: '-@duration',
        page: { limit: Math.min(req.limit, TRACE_SEARCH_LIMIT_MAX) },
      },
    },
  };
}

/**
 * Reduce a span list into a TraceSummary · root span anchored. Pure.
 */
export function summariseTrace(spans: TraceSpan[]): TraceSummary | null {
  if (spans.length === 0) return null;
  // Root = no parent_span_id; if multiple (corrupt), pick the earliest start_time.
  const roots = spans.filter((s) => !s.parent_span_id);
  const root =
    roots.length > 0
      ? roots.sort((a, b) => a.start_time.localeCompare(b.start_time))[0]
      : spans.sort((a, b) => a.start_time.localeCompare(b.start_time))[0];

  const byService = new Map<string, number>();
  let earliest = root.start_time;
  let hasError = false;
  for (const s of spans) {
    byService.set(s.service_name, (byService.get(s.service_name) ?? 0) + s.duration_us);
    if (s.start_time < earliest) earliest = s.start_time;
    if (s.attributes['error'] === true || s.attributes['error'] === 'true') hasError = true;
  }
  const components = [...byService.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([service_name, duration_us]) => ({ service_name, duration_us }));

  // R2 ⚠ 阻塞-1 (handler row-level guard) · 从 root span 提取 `neon.project_id` 给 summary.
  // 多种来源 fallback: custom `neon.project_id` / tag `@neon.project_id` 已 flatten 到 attributes ·
  // 取首个非空 string · 不强制要求 (root span 路径 α agent 没注入会缺 · handler 见 undefined fail-open + audit).
  const rawProjectId = root.attributes['neon.project_id'];
  const project_id =
    typeof rawProjectId === 'string' && rawProjectId.length > 0
      ? rawProjectId
      : undefined;

  return {
    trace_id: root.trace_id,
    span_count: spans.length,
    duration_us: root.duration_us,
    root_service: root.service_name,
    root_operation: root.operation_name,
    start_time: earliest,
    has_error: hasError,
    components,
    tracestate: root.tracestate,
    project_id,
  };
}

/** Default backend trace search window when caller omits `time_range`. */
const DEFAULT_TRACE_WINDOW: MetricWindow = { last: '1h' };

export function createDatadogTraceAdapter(
  fetchImpl: FetchLike = fetch,
): TraceFetchAdapter {
  async function call<T>(
    path: string,
    body: object,
  ): Promise<{ ok: true; body: T } | { ok: false; error: { reason: 'unreachable' | 'auth' | 'rate_limited' | 'backend_error'; detail?: string } }> {
    const config = readDatadogConfig();
    if (!config) {
      return {
        ok: false,
        error: {
          reason: 'auth',
          detail: 'Datadog credentials missing (DD_API_KEY / DD_APP_KEY).',
        },
      };
    }
    const url = `${config.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'DD-API-KEY': config.apiKey,
          'DD-APPLICATION-KEY': config.appKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return {
        ok: false,
        error: {
          reason: 'unreachable',
          detail: e instanceof Error ? e.message : String(e),
        },
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: {
          reason: classifyHttpStatus(res.status),
          detail: `Datadog APM API returned HTTP ${res.status}.`,
        },
      };
    }
    let parsed: T;
    try {
      parsed = (await res.json()) as T;
    } catch (e) {
      return {
        ok: false,
        error: {
          reason: 'backend_error',
          detail: `Failed to parse Datadog response: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
    return { ok: true, body: parsed };
  }

  return {
    async getTraceById(req: GetTraceByIdRequest): Promise<GetTraceByIdResult> {
      if (!isValidTraceId(req.trace_id)) {
        return {
          error: {
            reason: 'backend_error',
            detail: `Invalid trace_id '${req.trace_id}' · expected 32 lowercase hex chars (W3C).`,
          },
        };
      }
      let window: { from: number; to: number };
      try {
        window = resolveWindow(req.time_range ?? DEFAULT_TRACE_WINDOW);
      } catch (e) {
        return {
          error: {
            reason: 'backend_error',
            detail: e instanceof Error ? e.message : String(e),
          },
        };
      }
      const body = buildTraceByIdQuery(req.trace_id, window);
      const res = await call<DatadogSpansSearchBody>(
        DATADOG_SPANS_SEARCH_PATH,
        body,
      );
      if (!res.ok) return { error: res.error };
      if (res.body.errors && res.body.errors.length > 0) {
        const first = res.body.errors[0];
        return {
          error: {
            reason: 'backend_error',
            detail: first.detail ?? first.title ?? 'Datadog APM returned errors[].',
          },
        };
      }
      const events = res.body.data ?? [];
      const spans = events
        .map(spanFromDatadogEvent)
        .filter((s): s is TraceSpan => s !== null);
      if (spans.length === 0) {
        return {
          error: {
            reason: 'not_found',
            detail: `No spans found for trace_id '${req.trace_id}' in the queried window.`,
          },
        };
      }
      const summary = summariseTrace(spans);
      if (!summary) {
        return {
          error: {
            reason: 'backend_error',
            detail: 'Spans returned but trace summarisation failed (no root span detected).',
          },
        };
      }
      return { spans, summary };
    },

    async searchTraces(req: TraceSearchRequest): Promise<SearchTracesResult> {
      const limit = Math.min(Math.max(1, req.limit), TRACE_SEARCH_LIMIT_MAX);
      let window: { from: number; to: number };
      try {
        window = resolveWindow(req.filter.time_range);
      } catch (e) {
        return {
          error: {
            reason: 'backend_error',
            detail: e instanceof Error ? e.message : String(e),
          },
        };
      }
      const body = buildSearchRequestBody({ ...req, limit }, window);
      const res = await call<DatadogSpansSearchBody>(
        DATADOG_SPANS_SEARCH_PATH,
        body,
      );
      if (!res.ok) return { error: res.error };
      if (res.body.errors && res.body.errors.length > 0) {
        const first = res.body.errors[0];
        return {
          error: {
            reason: 'backend_error',
            detail: first.detail ?? first.title ?? 'Datadog APM returned errors[].',
          },
        };
      }
      const events = res.body.data ?? [];
      // `@_top_level:1` already filters to root spans — but each event is itself one trace.
      // Map each root span event to a TraceSummary directly (no per-trace child span fetch ·
      // saves N+1 round-trips · agent calls getTraceById when it wants full spans · §3 token economy).
      const traces: TraceSummary[] = [];
      for (const ev of events) {
        const span = spanFromDatadogEvent(ev);
        if (!span) continue;
        const rawProjectId = span.attributes['neon.project_id'];
        const project_id =
          typeof rawProjectId === 'string' && rawProjectId.length > 0
            ? rawProjectId
            : undefined;
        traces.push({
          trace_id: span.trace_id,
          span_count: 0, // unknown from search · agent calls getTraceById for full count
          duration_us: span.duration_us,
          root_service: span.service_name,
          root_operation: span.operation_name,
          start_time: span.start_time,
          has_error:
            span.attributes['error'] === true ||
            span.attributes['error'] === 'true',
          components: [
            { service_name: span.service_name, duration_us: span.duration_us },
          ],
          tracestate: span.tracestate,
          project_id, // R2 ⚠ 阻塞-1 · row-level guard 用
        });
      }
      return { traces };
    },
  };
}

/** Default Datadog trace-fetch adapter (global fetch). */
export const datadogTraceAdapter: TraceFetchAdapter = createDatadogTraceAdapter();

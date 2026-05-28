/**
 * feat-066 trace-fetch seam unit tests · 验 datadog-adapter pure helpers + adapter fetch behaviour.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-066-L3-mcp-tool-trace-read-seam.html §3 + §7
 *
 * Mirrors metrics-history.test.ts style (feat-064) · HTTP is mocked · NO real Datadog hit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildSearchQuery,
  buildSearchRequestBody,
  buildTraceByIdQuery,
  createDatadogTraceAdapter,
  spanFromDatadogEvent,
  summariseTrace,
} from '../server-enrich/trace-fetch/datadog-adapter';
import {
  getTraceById,
  isSearchTracesError,
  isTraceFetchError,
  searchTraces,
  TRACE_SEARCH_LIMIT_MAX,
} from '../server-enrich/trace-fetch';
import type {
  GetTraceByIdRequest,
  TraceSearchRequest,
  TraceSpan,
} from '../server-enrich/trace-fetch';

describe('buildSearchQuery (DSL translation)', () => {
  it('always pins to top-level (root spans only · 1 row per trace)', () => {
    const q = buildSearchQuery({ time_range: { last: '1h' } });
    expect(q).toBe('@_top_level:1');
  });
  it('min_latency_ms converted to ns and projected as @duration:>', () => {
    const q = buildSearchQuery({
      time_range: { last: '1h' },
      min_latency_ms: 500,
    });
    expect(q).toContain('@duration:>500000000');
  });
  it('component maps to service:neon-<component>', () => {
    expect(
      buildSearchQuery({ time_range: { last: '1h' }, component: 'pageserver' }),
    ).toContain('service:neon-pageserver');
  });
  it('project_id and endpoint_id surface as @neon.* tag filters', () => {
    const q = buildSearchQuery({
      time_range: { last: '1h' },
      project_id: 'proj-A',
      endpoint_id: 'ep-1',
    });
    expect(q).toContain('@neon.project_id:proj-A');
    expect(q).toContain('@neon.endpoint_id:ep-1');
  });
});

describe('spanFromDatadogEvent', () => {
  it('maps DD event → vendor-neutral TraceSpan · ns → µs', () => {
    const span = spanFromDatadogEvent({
      attributes: {
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
        parent_id: 'c'.repeat(16),
        service: 'neon-proxy',
        operation_name: 'pg.proxy.query',
        start: '2026-05-28T11:00:00Z',
        duration: 1_500_000, // 1.5 ms in ns
        tracestate: 'neon=root=proxy',
        custom: { 'neon.project_id': 'proj-A' },
        tags: ['@neon.endpoint_id:ep-1'],
      },
    });
    expect(span).not.toBeNull();
    expect(span!.trace_id).toBe('a'.repeat(32));
    expect(span!.duration_us).toBe(1500);
    expect(span!.attributes['neon.project_id']).toBe('proj-A');
    expect(span!.attributes['neon.endpoint_id']).toBe('ep-1');
    expect(span!.tracestate).toBe('neon=root=proxy');
  });
  it('returns null when trace_id or span_id missing (defensive)', () => {
    expect(spanFromDatadogEvent({ attributes: {} })).toBeNull();
  });
  it("parent_id '0' is treated as root (no parent_span_id)", () => {
    const span = spanFromDatadogEvent({
      attributes: {
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
        parent_id: '0',
        duration: 1_000_000,
        start: '2026-05-28T11:00:00Z',
      },
    });
    expect(span!.parent_span_id).toBeUndefined();
  });
});

describe('summariseTrace', () => {
  it('component breakdown sums per-service durations · top 4', () => {
    const root: TraceSpan = {
      trace_id: 't',
      span_id: 'r',
      service_name: 'neon-proxy',
      operation_name: 'pg.proxy.query',
      start_time: '2026-05-28T11:00:00.000Z',
      duration_us: 5000,
      attributes: {},
    };
    const compute: TraceSpan = {
      ...root,
      span_id: 'c',
      parent_span_id: 'r',
      service_name: 'neon-compute',
      duration_us: 3000,
    };
    const pageserver: TraceSpan = {
      ...root,
      span_id: 'p',
      parent_span_id: 'c',
      service_name: 'neon-pageserver',
      duration_us: 1500,
    };
    const summary = summariseTrace([root, compute, pageserver]);
    expect(summary!.root_service).toBe('neon-proxy');
    expect(summary!.duration_us).toBe(5000);
    expect(summary!.span_count).toBe(3);
    expect(summary!.components.map((c) => c.service_name)).toEqual([
      'neon-proxy',
      'neon-compute',
      'neon-pageserver',
    ]);
  });
});

describe('adapter · success + failure (failure ≠ empty success · feat-064 parity)', () => {
  const req: GetTraceByIdRequest = {
    trace_id: 'a'.repeat(32),
    time_range: { from: 0, to: 3600 },
  };

  beforeEach(() => {
    process.env.DD_API_KEY = 'test-api';
    process.env.DD_APP_KEY = 'test-app';
    process.env.DD_SITE = 'us5.datadoghq.com';
  });
  afterEach(() => {
    delete process.env.DD_API_KEY;
    delete process.env.DD_APP_KEY;
    delete process.env.DD_SITE;
    vi.restoreAllMocks();
  });

  it('getTraceById: 200 with 3 spans → spans + summary', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            attributes: {
              trace_id: 'a'.repeat(32),
              span_id: 'r'.padEnd(16, '0'),
              service: 'neon-proxy',
              operation_name: 'pg.proxy.query',
              start: '2026-05-28T11:00:00Z',
              duration: 2_000_000,
              tracestate: 'neon=root=proxy',
              custom: { 'neon.project_id': 'proj-A' },
            },
          },
          {
            attributes: {
              trace_id: 'a'.repeat(32),
              span_id: 'c'.padEnd(16, '0'),
              parent_id: 'r'.padEnd(16, '0'),
              service: 'neon-compute',
              operation_name: 'pg.query',
              start: '2026-05-28T11:00:00.500Z',
              duration: 1_000_000,
              custom: { 'neon.project_id': 'proj-A' },
            },
          },
          {
            attributes: {
              trace_id: 'a'.repeat(32),
              span_id: 'p'.padEnd(16, '0'),
              parent_id: 'c'.padEnd(16, '0'),
              service: 'neon-pageserver',
              operation_name: 'storage.get_page',
              start: '2026-05-28T11:00:01Z',
              duration: 500_000,
              custom: { 'neon.project_id': 'proj-A' },
            },
          },
        ],
      }),
    });
    const adapter = createDatadogTraceAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getTraceById(req, adapter);
    expect(isTraceFetchError(result)).toBe(false);
    if (!isTraceFetchError(result)) {
      expect(result.spans).toHaveLength(3);
      expect(result.summary.root_service).toBe('neon-proxy');
      expect(result.summary.components.length).toBe(3);
    }
    // Posted via POST + correct path
    const calledUrl = fakeFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/v2/spans/events/search');
    const calledInit = fakeFetch.mock.calls[0][1] as RequestInit;
    expect(calledInit.method).toBe('POST');
  });

  it('getTraceById: empty data → not_found (NOT a sparse success)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    const adapter = createDatadogTraceAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getTraceById(req, adapter);
    expect(isTraceFetchError(result)).toBe(true);
    if (isTraceFetchError(result)) {
      expect(result.error.reason).toBe('not_found');
    }
  });

  it('getTraceById: invalid trace_id → backend_error (rejected before fetch)', async () => {
    const fakeFetch = vi.fn();
    const adapter = createDatadogTraceAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getTraceById({ trace_id: 'short' }, adapter);
    expect(isTraceFetchError(result)).toBe(true);
    if (isTraceFetchError(result)) expect(result.error.reason).toBe('backend_error');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('searchTraces: 403 → error{auth} (not empty list)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    });
    const adapter = createDatadogTraceAdapter(fakeFetch as unknown as typeof fetch);
    const req: TraceSearchRequest = {
      filter: { time_range: { from: 0, to: 3600 } },
      limit: 20,
    };
    const r = await searchTraces(req, adapter);
    expect(isSearchTracesError(r)).toBe(true);
    if (isSearchTracesError(r)) expect(r.error.reason).toBe('auth');
  });

  it('searchTraces: limit clamped to TRACE_SEARCH_LIMIT_MAX (token economy)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    const adapter = createDatadogTraceAdapter(fakeFetch as unknown as typeof fetch);
    await searchTraces(
      { filter: { time_range: { from: 0, to: 3600 } }, limit: 1000 },
      adapter,
    );
    const calledInit = fakeFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(calledInit.body as string);
    expect(body.data.attributes.page.limit).toBe(TRACE_SEARCH_LIMIT_MAX);
  });

  it('missing credentials → error{auth} (no crash · feat-064 parity)', async () => {
    delete process.env.DD_API_KEY;
    const fakeFetch = vi.fn();
    const adapter = createDatadogTraceAdapter(fakeFetch as unknown as typeof fetch);
    const r = await getTraceById(req, adapter);
    expect(isTraceFetchError(r)).toBe(true);
    if (isTraceFetchError(r)) expect(r.error.reason).toBe('auth');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('backend swap-friendly · mock adapter satisfies TraceFetchAdapter interface', async () => {
    // Demonstrates ADR-0009 单一收口: a second backend implementing the SUB-interface plugs in
    // without seam changes (here: a tiny in-memory adapter returning fixture).
    const mockAdapter = {
      async getTraceById() {
        return {
          spans: [
            {
              trace_id: 'a'.repeat(32),
              span_id: 'r',
              service_name: 'fake-tempo',
              operation_name: 'demo',
              start_time: '2026-05-28T11:00:00Z',
              duration_us: 100,
              attributes: {},
            },
          ],
          summary: {
            trace_id: 'a'.repeat(32),
            span_count: 1,
            duration_us: 100,
            root_service: 'fake-tempo',
            root_operation: 'demo',
            start_time: '2026-05-28T11:00:00Z',
            has_error: false,
            components: [{ service_name: 'fake-tempo', duration_us: 100 }],
          },
        };
      },
      async searchTraces() {
        return { traces: [] };
      },
    };
    const r = await getTraceById({ trace_id: 'a'.repeat(32) }, mockAdapter);
    expect(isTraceFetchError(r)).toBe(false);
    if (!isTraceFetchError(r)) {
      expect(r.summary.root_service).toBe('fake-tempo');
    }
  });
});

describe('request body shaping (Datadog APM spans/events/search)', () => {
  it('buildTraceByIdQuery sets filter.query = trace_id:<id>', () => {
    const body = buildTraceByIdQuery('a'.repeat(32), { from: 0, to: 3600 }) as {
      data: { attributes: { filter: { query: string; from: string; to: string }; page: { limit: number } } };
    };
    expect(body.data.attributes.filter.query).toBe(`trace_id:${'a'.repeat(32)}`);
    expect(body.data.attributes.page.limit).toBe(1000);
  });
  it('buildSearchRequestBody uses -@duration sort (slowest first)', () => {
    const body = buildSearchRequestBody(
      {
        filter: { time_range: { from: 0, to: 3600 } },
        limit: 10,
      },
      { from: 0, to: 3600 },
    ) as { data: { attributes: { sort: string; page: { limit: number } } } };
    expect(body.data.attributes.sort).toBe('-@duration');
    expect(body.data.attributes.page.limit).toBe(10);
  });
});

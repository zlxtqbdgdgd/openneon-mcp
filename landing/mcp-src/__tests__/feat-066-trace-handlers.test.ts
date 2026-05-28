/**
 * feat-066 trace handler 8-case fixture · 跨 tenant 安全 + 端到端 mcp tool 行为.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-066-L3-mcp-tool-trace-read-seam.html §6 + §7
 *
 * 8 cases per feat-066/#3 acceptance gate:
 *  1. get_neondb_trace 单 trace 完整 5+ span (path β · proxy → compute → safekeeper → pageserver)
 *  2. search 按 P99 latency (min_latency_ms) 过滤
 *  3. search 按 component (proxy/compute/safekeeper/pageserver) 过滤
 *  4. search 按 endpoint_id 切片
 *  5. mock Datadog backend swap-friendly (verify swap to mock Tempo 单一改 seam 一处)
 *  6. 跨 tenant 攻击: agent 传 filter.project_id=victim → 硬覆盖到 own + cross_tenant_blocked audit
 *  7. agent E2E RAG 剧本拉 trace_id 看 component (handler 返回 components 分布)
 *  8. token economy: 1 trace < 5K token (OWASP LLM10 · 8 KiB JSON 字节上限近似)
 *
 * 跟 feat-064 metrics-history.test.ts 同风格 · 测试边界:
 * - mock Datadog HTTP (fetch impl) · 不访问真后端
 * - mock audit emit · 验事件类型 / outcome / severity
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyCrossTenantGuard,
  handleGetNeondbTrace,
} from '../tools/handlers/get-neondb-trace';
import {
  handleSearchNeondbTraces,
  lockFilterToTenant,
} from '../tools/handlers/search-neondb-traces';
import type {
  TraceFetchAdapter,
  TraceSpan,
} from '../server-enrich/trace-fetch';

// ──────────── audit-emit mock · 收集 emitted events ────────────
const auditEvents: Array<Record<string, unknown>> = [];
vi.mock('../observability/audit-emit', () => ({
  emitAuditEvent: vi.fn((event: Record<string, unknown>) => {
    auditEvents.push(event);
  }),
  sha256Hex: (s: string) => `sha256:${s.slice(0, 8)}`,
}));

// ──────────── 默认 Datadog adapter mock 注入 (覆盖 default) ────────────
// 思路: trace-fetch index.ts 默认用 datadogTraceAdapter (绑了 global fetch) · handler 不传 adapter
// 参数; 因此通过 vi.mock 覆盖整个 trace-fetch 模块的 `getTraceById` / `searchTraces`。
let mockGetTraceById: TraceFetchAdapter['getTraceById'] = async () => {
  throw new Error('mockGetTraceById not configured in test');
};
let mockSearchTraces: TraceFetchAdapter['searchTraces'] = async () => {
  throw new Error('mockSearchTraces not configured in test');
};
vi.mock('../server-enrich/trace-fetch', async () => {
  const actual = await vi.importActual<
    typeof import('../server-enrich/trace-fetch')
  >('../server-enrich/trace-fetch');
  return {
    ...actual,
    getTraceById: (...args: Parameters<TraceFetchAdapter['getTraceById']>) =>
      mockGetTraceById(...args),
    searchTraces: (...args: Parameters<TraceFetchAdapter['searchTraces']>) =>
      mockSearchTraces(...args),
  };
});

const PROJECT_OWN = 'proj-own';
const PROJECT_VICTIM = 'proj-victim';
const TRACE_ID = 'a'.repeat(32);

function spanOf(
  override: Partial<TraceSpan> & {
    service_name: string;
    span_id: string;
  },
): TraceSpan {
  return {
    trace_id: TRACE_ID,
    span_id: override.span_id,
    parent_span_id: override.parent_span_id,
    service_name: override.service_name,
    operation_name: override.operation_name ?? `${override.service_name}.op`,
    start_time: override.start_time ?? '2026-05-28T11:00:00.000Z',
    duration_us: override.duration_us ?? 1000,
    attributes: {
      'neon.project_id': PROJECT_OWN,
      ...override.attributes,
    },
    tracestate: override.tracestate ?? 'neon=root=proxy',
  };
}

beforeEach(() => {
  auditEvents.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ────────────────── Case 1 · get_neondb_trace 完整 5+ span (path β) ──────────────────
describe('case 1 · get_neondb_trace 单 trace 完整 5+ span (path β)', () => {
  it('返回 5 段 span 链 · 跨 4 个组件 · summary.components 列出每个组件耗时', async () => {
    const spans: TraceSpan[] = [
      spanOf({ span_id: 's1', service_name: 'neon-proxy', duration_us: 5000 }),
      spanOf({
        span_id: 's2',
        parent_span_id: 's1',
        service_name: 'neon-compute',
        duration_us: 3500,
      }),
      spanOf({
        span_id: 's3',
        parent_span_id: 's2',
        service_name: 'neon-safekeeper',
        duration_us: 800,
      }),
      spanOf({
        span_id: 's4',
        parent_span_id: 's2',
        service_name: 'neon-pageserver',
        duration_us: 1200,
      }),
      spanOf({
        span_id: 's5',
        parent_span_id: 's4',
        service_name: 'neon-pageserver',
        operation_name: 'storage.get_page',
        duration_us: 600,
      }),
    ];
    mockGetTraceById = async () => ({
      spans,
      summary: {
        trace_id: TRACE_ID,
        span_count: 5,
        duration_us: 5000,
        root_service: 'neon-proxy',
        root_operation: 'neon-proxy.op',
        start_time: '2026-05-28T11:00:00.000Z',
        has_error: false,
        components: [
          { service_name: 'neon-proxy', duration_us: 5000 },
          { service_name: 'neon-compute', duration_us: 3500 },
          { service_name: 'neon-pageserver', duration_us: 1800 },
          { service_name: 'neon-safekeeper', duration_us: 800 },
        ],
        tracestate: 'neon=root=proxy',
      },
    });

    const result = await handleGetNeondbTrace({
      projectId: PROJECT_OWN,
      trace_id: TRACE_ID,
    });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.spans).toHaveLength(5);
      const services = new Set(result.spans.map((s) => s.service_name));
      expect(services.has('neon-proxy')).toBe(true);
      expect(services.has('neon-compute')).toBe(true);
      expect(services.has('neon-safekeeper')).toBe(true);
      expect(services.has('neon-pageserver')).toBe(true);
      expect(result.summary.span_count).toBe(5);
      expect(result.cross_tenant_filtered).toBe(false);
    }
    const auditTypes = auditEvents.map((e) => e.event_type);
    expect(auditTypes).toContain('trace_get_invoked');
    expect(auditEvents[0].outcome).toBe('allow');
  });
});

// ────────────────── Case 2 · search 按 P99 latency 过滤 ──────────────────
describe('case 2 · search_neondb_traces 按 min_latency_ms 过滤', () => {
  it('handler 把 min_latency_ms 透传给 seam (verify 走入 search filter)', async () => {
    const seen: Array<{ filter: unknown; limit: number }> = [];
    mockSearchTraces = async (req) => {
      seen.push({ filter: req.filter, limit: req.limit });
      return {
        traces: [
          {
            trace_id: TRACE_ID,
            span_count: 0,
            duration_us: 1_200_000, // 1.2 s
            root_service: 'neon-proxy',
            root_operation: 'pg.proxy.query',
            start_time: '2026-05-28T11:00:00.000Z',
            has_error: false,
            components: [{ service_name: 'neon-proxy', duration_us: 1_200_000 }],
          },
        ],
      };
    };
    const result = await handleSearchNeondbTraces({
      projectId: PROJECT_OWN,
      filter: {
        min_latency_ms: 1000,
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T12:00:00Z' },
      },
      limit: 10,
    });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.traces).toHaveLength(1);
      expect(result.traces[0].duration_us).toBe(1_200_000);
    }
    expect(seen[0].filter).toMatchObject({ min_latency_ms: 1000 });
  });
});

// ────────────────── Case 3 · search 按 component 切片 ──────────────────
describe('case 3 · search_neondb_traces 按 component 切片', () => {
  it.each(['proxy', 'compute', 'safekeeper', 'pageserver'] as const)(
    'component=%s 透传给 seam',
    async (component) => {
      const seen: Array<{ component?: string }> = [];
      mockSearchTraces = async (req) => {
        seen.push({ component: req.filter.component });
        return { traces: [] };
      };
      await handleSearchNeondbTraces({
        projectId: PROJECT_OWN,
        filter: { component },
      });
      expect(seen[0].component).toBe(component);
    },
  );
});

// ────────────────── Case 4 · search 按 endpoint_id 切片 ──────────────────
describe('case 4 · search_neondb_traces 按 endpoint_id 切片', () => {
  it('endpoint_id 透传给 seam · audit extra 里也带 endpoint_id', async () => {
    const seen: Array<{ endpoint_id?: string }> = [];
    mockSearchTraces = async (req) => {
      seen.push({ endpoint_id: req.filter.endpoint_id });
      return { traces: [] };
    };
    await handleSearchNeondbTraces({
      projectId: PROJECT_OWN,
      filter: { endpoint_id: 'ep-1' },
    });
    expect(seen[0].endpoint_id).toBe('ep-1');
    const auditEv = auditEvents.find((e) => e.event_type === 'trace_search_invoked');
    expect(auditEv).toBeDefined();
    expect(auditEv!.endpoint_id).toBe('ep-1');
  });
});

// ────────────────── Case 5 · backend swap-friendly (mock Tempo adapter) ──────────────────
describe('case 5 · backend swap-friendly · mock Tempo 替 Datadog 仅改 seam 一处', () => {
  it('用满足 TraceFetchAdapter 接口的 mock adapter · index.ts getTraceById 显式传 adapter 即可 swap', async () => {
    // 直接 call 真实 index.ts (无 mock), 但通过显式传 adapter — 等同于"换 backend"。
    // restore the trace-fetch module mock for this case
    vi.doUnmock('../server-enrich/trace-fetch');
    const real = await vi.importActual<
      typeof import('../server-enrich/trace-fetch')
    >('../server-enrich/trace-fetch');
    const mockTempo: TraceFetchAdapter = {
      async getTraceById() {
        return {
          spans: [
            {
              trace_id: TRACE_ID,
              span_id: 'tempo-r',
              service_name: 'tempo-mock-svc',
              operation_name: 'mock.op',
              start_time: '2026-05-28T11:00:00Z',
              duration_us: 100,
              attributes: { 'neon.project_id': PROJECT_OWN },
            },
          ],
          summary: {
            trace_id: TRACE_ID,
            span_count: 1,
            duration_us: 100,
            root_service: 'tempo-mock-svc',
            root_operation: 'mock.op',
            start_time: '2026-05-28T11:00:00Z',
            has_error: false,
            components: [{ service_name: 'tempo-mock-svc', duration_us: 100 }],
          },
        };
      },
      async searchTraces() {
        return { traces: [] };
      },
    };
    const r = await real.getTraceById({ trace_id: TRACE_ID }, mockTempo);
    expect(real.isTraceFetchError(r)).toBe(false);
    if (!real.isTraceFetchError(r)) {
      expect(r.summary.root_service).toBe('tempo-mock-svc');
    }
  });
});

// ────────────────── Case 6 · 跨 tenant 攻击 ──────────────────
describe('case 6 · 跨 tenant 攻击: agent 传 filter.project_id=victim → 硬覆盖 + cross_tenant_blocked audit', () => {
  it('lockFilterToTenant 直接验 · agent 传 victim 被改成 own + agentTriedCrossTenant=true', () => {
    const { filter, agentTriedCrossTenant } = lockFilterToTenant(
      {
        project_id: PROJECT_VICTIM,
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T12:00:00Z' },
      },
      PROJECT_OWN,
    );
    expect(filter.project_id).toBe(PROJECT_OWN);
    expect(agentTriedCrossTenant).toBe(true);
  });

  it('handler 路径 · 跨 tenant attempt → 立即 emit cross_tenant_blocked audit · seam 收到的 filter.project_id 已是 own', async () => {
    let seamGotProjectId: string | undefined;
    mockSearchTraces = async (req) => {
      seamGotProjectId = req.filter.project_id;
      return { traces: [] };
    };
    const result = await handleSearchNeondbTraces({
      projectId: PROJECT_OWN,
      filter: { project_id: PROJECT_VICTIM },
    });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.cross_tenant_filtered).toBe(true);
    }
    expect(seamGotProjectId).toBe(PROJECT_OWN); // backend NEVER saw victim
    // cross_tenant_blocked emitted BEFORE trace_search_invoked
    const types = auditEvents.map((e) => e.event_type);
    expect(types[0]).toBe('cross_tenant_blocked');
    expect(types).toContain('trace_search_invoked');
    const ctb = auditEvents.find((e) => e.event_type === 'cross_tenant_blocked')!;
    expect(ctb.outcome).toBe('deny');
    expect(ctb.severity).toBe('high');
    const extra = ctb.extra as Record<string, unknown>;
    expect(extra['openneon.audit.agent_attempted_project_id']).toBe(PROJECT_VICTIM);
    expect(extra['openneon.audit.bound_project_id']).toBe(PROJECT_OWN);
  });

  it('get_neondb_trace · span 里掺了 victim project_id 的 span 被 applyCrossTenantGuard 丢弃', () => {
    const spans: TraceSpan[] = [
      spanOf({ span_id: 's1', service_name: 'neon-proxy', duration_us: 5000 }),
      // victim 项目串入的污染 span
      spanOf({
        span_id: 's2',
        service_name: 'neon-compute',
        attributes: { 'neon.project_id': PROJECT_VICTIM },
        duration_us: 9999,
      }),
    ];
    const { kept, dropped } = applyCrossTenantGuard(spans, PROJECT_OWN);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(kept[0].span_id).toBe('s1');
  });

  it('handler 全跨 tenant · 所有 span 被丢 → 返回 not_found · 不暴露给 agent', async () => {
    mockGetTraceById = async () => ({
      spans: [
        spanOf({
          span_id: 's1',
          service_name: 'neon-compute',
          attributes: { 'neon.project_id': PROJECT_VICTIM },
        }),
      ],
      summary: {
        trace_id: TRACE_ID,
        span_count: 1,
        duration_us: 1000,
        root_service: 'neon-compute',
        root_operation: 'neon-compute.op',
        start_time: '2026-05-28T11:00:00.000Z',
        has_error: false,
        components: [{ service_name: 'neon-compute', duration_us: 1000 }],
      },
    });
    const result = await handleGetNeondbTrace({
      projectId: PROJECT_OWN,
      trace_id: TRACE_ID,
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.reason).toBe('not_found');
    }
    // both cross_tenant_blocked AND trace_get_invoked (with deny outcome) emitted
    const types = auditEvents.map((e) => e.event_type);
    expect(types).toContain('cross_tenant_blocked');
    expect(types).toContain('trace_get_invoked');
  });
});

// ────────────────── Case 7 · E2E RAG 剧本拉 trace_id 看 component ──────────────────
describe('case 7 · agent E2E RAG 剧本拉 trace_id 看 component', () => {
  it('handler 返回 components 分布 · agent 可直接看每组件耗时占比', async () => {
    mockGetTraceById = async () => ({
      spans: [
        spanOf({ span_id: 's1', service_name: 'neon-proxy', duration_us: 4500 }),
        spanOf({
          span_id: 's2',
          parent_span_id: 's1',
          service_name: 'neon-compute',
          duration_us: 3000,
        }),
        spanOf({
          span_id: 's3',
          parent_span_id: 's2',
          service_name: 'neon-pageserver',
          duration_us: 1500,
        }),
      ],
      summary: {
        trace_id: TRACE_ID,
        span_count: 3,
        duration_us: 4500,
        root_service: 'neon-proxy',
        root_operation: 'pg.proxy.query',
        start_time: '2026-05-28T11:00:00.000Z',
        has_error: false,
        components: [
          { service_name: 'neon-proxy', duration_us: 4500 },
          { service_name: 'neon-compute', duration_us: 3000 },
          { service_name: 'neon-pageserver', duration_us: 1500 },
        ],
        tracestate: 'neon=root=proxy',
      },
    });
    const result = await handleGetNeondbTrace({
      projectId: PROJECT_OWN,
      trace_id: TRACE_ID,
    });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      // 验 agent 拿到的 components 分布按耗时降序 · root 在最前
      expect(result.summary.components[0].service_name).toBe('neon-proxy');
      expect(result.summary.components[1].service_name).toBe('neon-compute');
      expect(result.summary.components[2].service_name).toBe('neon-pageserver');
      // tracestate 区分 path β (proxy=root) vs path α (app=root)
      expect(result.summary.tracestate).toContain('neon=root=proxy');
    }
  });
});

// ────────────────── Case 8 · token economy: 1 trace < 5K token ──────────────────
describe('case 8 · token economy: 1 trace JSON < 5K token (近似 ~20KiB JSON bytes · OWASP LLM10)', () => {
  it('5 span / 详细 attributes 仍在预算内', async () => {
    const spans: TraceSpan[] = [
      'neon-proxy',
      'neon-compute',
      'neon-safekeeper',
      'neon-pageserver',
      'neon-pageserver',
    ].map((svc, i) =>
      spanOf({
        span_id: `span-${i}`,
        parent_span_id: i === 0 ? undefined : `span-${i - 1}`,
        service_name: svc,
        duration_us: 1000 * (5 - i),
        attributes: {
          'neon.project_id': PROJECT_OWN,
          'neon.endpoint_id': 'ep-1',
          'neon.branch_id': 'br-1',
          'neon.tenant_id': 'tenant-x',
          'service.version': '1.2.3',
          'deployment.environment': 'prod',
        },
      }),
    );
    mockGetTraceById = async () => ({
      spans,
      summary: {
        trace_id: TRACE_ID,
        span_count: spans.length,
        duration_us: spans[0].duration_us,
        root_service: 'neon-proxy',
        root_operation: 'neon-proxy.op',
        start_time: '2026-05-28T11:00:00.000Z',
        has_error: false,
        components: spans
          .map((s) => ({ service_name: s.service_name, duration_us: s.duration_us }))
          .slice(0, 4),
      },
    });
    const result = await handleGetNeondbTrace({
      projectId: PROJECT_OWN,
      trace_id: TRACE_ID,
    });
    const serialised = JSON.stringify(result);
    // ~4 chars/token average · 20 KiB bytes ≈ 5K tokens budget · acceptance: stay well under
    expect(serialised.length).toBeLessThan(20_000);
  });

  it('search 结果的 limit 在 handler 层 clamped to ≤ 50 (token economy)', async () => {
    const seenLimit: number[] = [];
    mockSearchTraces = async (req) => {
      seenLimit.push(req.limit);
      return { traces: [] };
    };
    await handleSearchNeondbTraces({
      projectId: PROJECT_OWN,
      limit: 9999, // attacker 试图拉爆 token
    });
    expect(seenLimit[0]).toBeLessThanOrEqual(50);
  });
});

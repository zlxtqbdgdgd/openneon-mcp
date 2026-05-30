/**
 * feat-025 T12 get_neondb_pool_stats 端到端 fixture · pgcat / PgBouncer 连接池 snapshot.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-025-L2b-mcp-tool-t12-pool-stats.html §7
 *
 * 12 用例 (设计 §7 用例表):
 *   1. happy fetch pgcat        → cl_waiting=5 透传 · pgcat_pool_* 命名空间映射
 *   2. happy fetch pgbouncer    → pgbouncer_pools_* 命名空间字段一致 + maxwait µs→ms
 *   3. parse 多 pool            → primary + 2 replica = 3 个 PoolStats (按 pool+role 聚合)
 *   4. empty metrics           → 全注释 /metrics 返空 pools[] (不抛)
 *   5. malformed metrics       → 非 Prometheus 内容 → parse_error + friendly throw
 *   6. endpoint unreachable    → 503 → http_5xx + "unreachable" throw
 *   7. endpoint timeout        → AbortError → timeout + throw
 *   8. cache hit               → 10s TTL 内第 2 次调用 cacheHit=true · 不再 fetch
 *   9. cache expire            → 超 10s 第 2 次调用重 fetch (cacheHit=false)
 *  10. stale fallback          → 第 1 次 ok · cache 后 endpoint 挂 · 第 2 次失败返 stale=true 旧 cache
 *  11. per-project env override → PGCAT_METRICS_URL_<proj> 优先于全局 PGCAT_METRICS_URL
 *  12. audit emit             → emitAuditEvent pool_stats_invoked + fetch_status 字段
 *
 * 测试边界 (跟 docs-tools.test.ts / feat-066 同风格):
 * - mock global fetch (无真 HTTP · pgcat/PgBouncer 不真部署)
 * - mock audit-emit · 验事件类型 / outcome / severity / extra
 * - 每 case beforeEach 清 module-level cache (__resetPgcatCacheForTest) + env
 *
 * 注: 仓内未装 msw (package.json 无 msw dep)· 沿用本仓既有 `globalThis.fetch = vi.fn()`
 * 风格 (docs-tools.test.ts / mcp-server.e2e.test.ts) · 等价覆盖 §7 12 用例。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleGetPoolStats,
  resolveMetricsUrl,
} from '../tools/handlers/pool-stats';
import { __resetPgcatCacheForTest } from '../utils/pgcat-fetcher';

// ──────────── audit-emit mock · 收集 emitted events ────────────
const auditEvents: Array<Record<string, unknown>> = [];
vi.mock('../observability/audit-emit', () => ({
  emitAuditEvent: vi.fn((event: Record<string, unknown>) => {
    auditEvents.push(event);
  }),
  sha256Hex: (s: string) => `sha256:${s.slice(0, 8)}`,
}));

const originalFetch = globalThis.fetch;
const URL_OK = 'http://pgcat.internal:9930/metrics';

/** 标准 pgcat exposition 文本 helper · 单 pool default/primary。 */
function pgcatMetrics({
  pool = 'default',
  role = 'primary',
  clActive = 3,
  clWaiting = 5,
  svActive = 2,
  svIdle = 4,
  svUsed = 6,
  maxWaitMs = 12,
  totalXact = 100,
}: Partial<{
  pool: string;
  role: string;
  clActive: number;
  clWaiting: number;
  svActive: number;
  svIdle: number;
  svUsed: number;
  maxWaitMs: number;
  totalXact: number;
}> = {}): string {
  const lbl = `{pool="${pool}",role="${role}"}`;
  return [
    '# HELP pgcat_pool_active_connections clients in active state',
    '# TYPE pgcat_pool_active_connections gauge',
    `pgcat_pool_active_connections${lbl} ${clActive}`,
    `pgcat_pool_waiting_clients${lbl} ${clWaiting}`,
    `pgcat_pool_server_active${lbl} ${svActive}`,
    `pgcat_pool_server_idle${lbl} ${svIdle}`,
    `pgcat_pool_server_used${lbl} ${svUsed}`,
    `pgcat_pool_max_wait_time_ms${lbl} ${maxWaitMs}`,
    `pgcat_pool_total_xact_count${lbl} ${totalXact}`,
    '',
  ].join('\n');
}

/** mock 一次 fetch 成功返回给定文本 (status 200)。 */
function mockFetchOnceText(text: string): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(text, { status: 200 }),
  );
}

beforeEach(() => {
  auditEvents.length = 0;
  __resetPgcatCacheForTest();
  globalThis.fetch = vi.fn();
  // env 隔离: 清 pool-stats 相关 env · 每 case 显式设
  delete process.env.PGCAT_METRICS_URL;
  delete process.env.POOL_STATS_CACHE_TTL_MS;
  delete process.env.POOL_STATS_TIMEOUT_MS;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PGCAT_METRICS_URL_')) delete process.env[k];
  }
  process.env.PGCAT_METRICS_URL = URL_OK;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ────────────────── Case 1 · happy fetch pgcat ──────────────────
describe('case 1 · happy fetch pgcat · cl_waiting 透传 + 命名空间映射', () => {
  it('返回单 pool · cl_waiting=5 + 字段按 FIELD_MAP 映射', async () => {
    mockFetchOnceText(pgcatMetrics({ clWaiting: 5 }));

    const res = await handleGetPoolStats({ projectId: 'proj-A' });

    expect(res.fetchStatus).toBe('ok');
    expect(res.cacheHit).toBe(false);
    expect(res.stale).toBe(false);
    expect(res.pools).toHaveLength(1);
    const p = res.pools[0];
    expect(p.cl_waiting).toBe(5);
    expect(p.cl_active).toBe(3);
    expect(p.sv_active).toBe(2);
    expect(p.sv_idle).toBe(4);
    expect(p.sv_used).toBe(6);
    expect(p.max_wait_ms).toBe(12);
    expect(p.total_xact_count).toBe(100);
    expect(p.pool_name).toBe('default');
    expect(p.role).toBe('primary');
    // pgcat /metrics 不带 pool_mode label → 'unknown' (不静默假定 'transaction')
    expect(p.pool_mode).toBe('unknown');
    // captured_at 渲染成 ISO8601 string (handler 层转换)
    expect(typeof p.captured_at).toBe('string');
    expect(p.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // endpoint_id 未传 → '' (来自 input · 不来自 metrics)
    expect(p.endpoint_id).toBe('');
  });
});

// ────────────────── Case 2 · happy fetch pgbouncer ──────────────────
describe('case 2 · happy fetch pgbouncer · 命名空间兼容 + maxwait µs→ms', () => {
  it('pgbouncer_pools_* 映射到统一 PoolStats 字段 · maxwait_us 转 ms', async () => {
    // PgBouncer exporter 用 database label (无 role) · maxwait 单位 µs
    const lbl = '{database="appdb"}';
    const text = [
      '# TYPE pgbouncer_pools_client_active gauge',
      `pgbouncer_pools_client_active${lbl} 7`,
      `pgbouncer_pools_client_waiting${lbl} 2`,
      `pgbouncer_pools_server_active${lbl} 1`,
      `pgbouncer_pools_server_idle${lbl} 3`,
      `pgbouncer_pools_server_used${lbl} 4`,
      `pgbouncer_pools_maxwait_us${lbl} 5000`, // 5000µs → 5ms
      `pgbouncer_pools_total_xact_count${lbl} 42`,
      '',
    ].join('\n');
    mockFetchOnceText(text);

    const res = await handleGetPoolStats({ projectId: 'proj-A' });

    expect(res.pools).toHaveLength(1);
    const p = res.pools[0];
    expect(p.cl_active).toBe(7);
    expect(p.cl_waiting).toBe(2);
    expect(p.sv_active).toBe(1);
    expect(p.sv_idle).toBe(3);
    expect(p.sv_used).toBe(4);
    expect(p.max_wait_ms).toBe(5); // 5000µs / 1000
    expect(p.total_xact_count).toBe(42);
    // PgBouncer exporter 无 role label · database 用作 pool_name
    expect(p.pool_name).toBe('appdb');
    expect(p.role).toBe('unknown');
  });
});

// ────────────────── Case 3 · parse 多 pool ──────────────────
describe('case 3 · 多 pool 聚合 · primary + 2 replica = 3 个 PoolStats', () => {
  it('按 (pool, role) 聚合成 3 行', async () => {
    const text =
      pgcatMetrics({ pool: 'pool-a', role: 'primary', clWaiting: 1 }) +
      pgcatMetrics({ pool: 'pool-b', role: 'replica', clWaiting: 2 }) +
      pgcatMetrics({ pool: 'pool-c', role: 'replica', clWaiting: 3 });
    mockFetchOnceText(text);

    const res = await handleGetPoolStats({ projectId: 'proj-A' });

    expect(res.pools).toHaveLength(3);
    const byName = Object.fromEntries(res.pools.map((p) => [p.pool_name, p]));
    expect(byName['pool-a'].role).toBe('primary');
    expect(byName['pool-a'].cl_waiting).toBe(1);
    expect(byName['pool-b'].role).toBe('replica');
    expect(byName['pool-b'].cl_waiting).toBe(2);
    expect(byName['pool-c'].role).toBe('replica');
    expect(byName['pool-c'].cl_waiting).toBe(3);
  });
});

// ────────────────── Case 4 · empty metrics ──────────────────
describe('case 4 · empty metrics · 全注释/空响应返空 pools[] (不抛)', () => {
  it('仅 HELP/TYPE 注释 → pools=[] · fetchStatus ok', async () => {
    const text = [
      '# HELP pgcat_pool_active_connections clients in active state',
      '# TYPE pgcat_pool_active_connections gauge',
      '',
    ].join('\n');
    mockFetchOnceText(text);

    const res = await handleGetPoolStats({ projectId: 'proj-A' });

    expect(res.pools).toHaveLength(0);
    expect(res.fetchStatus).toBe('ok');
    expect(res.stale).toBe(false);
  });
});

// ────────────────── Case 5 · malformed metrics ──────────────────
describe('case 5 · malformed metrics · 非 Prometheus 内容 → parse_error + friendly throw', () => {
  it('HTML/垃圾内容 (有内容行但 0 metric 行) → throw "unparseable"', async () => {
    // 有实际内容行但无任何可解析 metric 行 → PrometheusParseError → friendly parse_error
    const text = '<html><body>404 Not Found</body></html>';
    mockFetchOnceText(text);

    await expect(handleGetPoolStats({ projectId: 'proj-A' })).rejects.toThrow(
      /unparseable content/i,
    );
    // audit 仍 emit · fetch_status = parse_error (handler 从 PgcatFetchError.fetchStatus 取真值)
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].event_type).toBe('pool_stats_invoked');
    expect(
      (auditEvents[0].extra as Record<string, unknown>)[
        'openneon.audit.fetch_status'
      ],
    ).toBe('parse_error');
  });
});

// ────────────────── Case 6 · endpoint unreachable (503) ──────────────────
describe('case 6 · endpoint unreachable · 503 → http_5xx + "unreachable" throw', () => {
  it('503 (retry once 后仍 503) → throw "endpoint unreachable" · audit fetch_status=http_5xx', async () => {
    // retry once · 两次都 503
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    await expect(handleGetPoolStats({ projectId: 'proj-A' })).rejects.toThrow(
      /endpoint unreachable/i,
    );
    // fetch 被调 2 次 (retry once)
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2);
    expect(auditEvents).toHaveLength(1);
    expect(
      (auditEvents[0].extra as Record<string, unknown>)[
        'openneon.audit.fetch_status'
      ],
    ).toBe('http_5xx');
  });
});

// ────────────────── Case 7 · endpoint timeout ──────────────────
describe('case 7 · endpoint timeout · AbortError → timeout + throw', () => {
  it('fetch 抛 AbortError (timeout) → throw + audit fetch_status=timeout', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    vi.mocked(globalThis.fetch).mockRejectedValue(abortErr);

    await expect(handleGetPoolStats({ projectId: 'proj-A' })).rejects.toThrow(
      /unreachable/i,
    );
    // AbortError → classifyError → 'timeout' · retry once 后无 stale → friendly throw 带 timeout status
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2);
    expect(auditEvents).toHaveLength(1);
    expect(
      (auditEvents[0].extra as Record<string, unknown>)[
        'openneon.audit.fetch_status'
      ],
    ).toBe('timeout');
  });
});

// ────────────────── Case 8 · cache hit ──────────────────
describe('case 8 · cache hit · 10s TTL 内第 2 次调用 cacheHit=true 不再 fetch', () => {
  it('连续两次调用 · 第 2 次走 cache · fetch 只调 1 次', async () => {
    mockFetchOnceText(pgcatMetrics({ clWaiting: 9 }));

    const first = await handleGetPoolStats({ projectId: 'proj-A' });
    expect(first.cacheHit).toBe(false);
    expect(first.pools[0].cl_waiting).toBe(9);

    // 第 2 次: 不再 mock 新 fetch · 若真 fetch 会拿到 undefined Response 报错 → 证明走 cache
    const second = await handleGetPoolStats({ projectId: 'proj-A' });
    expect(second.cacheHit).toBe(true);
    expect(second.stale).toBe(false);
    expect(second.pools[0].cl_waiting).toBe(9);
    // fetch 全程只调用 1 次
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
    // 第 2 次 audit cache_hit=true
    expect(
      (auditEvents[1].extra as Record<string, unknown>)[
        'openneon.audit.cache_hit'
      ],
    ).toBe(true);
  });
});

// ────────────────── Case 9 · cache expire ──────────────────
describe('case 9 · cache expire · 超 10s TTL 第 2 次重新 fetch', () => {
  it('用 fake timers 推进 > 10s · 第 2 次 cacheHit=false 重 fetch', async () => {
    vi.useFakeTimers();
    mockFetchOnceText(pgcatMetrics({ clWaiting: 1 }));
    const first = await handleGetPoolStats({ projectId: 'proj-A' });
    expect(first.cacheHit).toBe(false);
    expect(first.pools[0].cl_waiting).toBe(1);

    // 推进超 10s 默认 TTL → cache 过期
    vi.advanceTimersByTime(10_001);

    // 第 2 次需要重新 fetch · 给一个新 mock (cl_waiting 变 8 证明拿到新数据)
    mockFetchOnceText(pgcatMetrics({ clWaiting: 8 }));
    const second = await handleGetPoolStats({ projectId: 'proj-A' });
    expect(second.cacheHit).toBe(false);
    expect(second.stale).toBe(false);
    expect(second.pools[0].cl_waiting).toBe(8);
    // fetch 被调 2 次
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2);
  });
});

// ────────────────── Case 10 · stale fallback ──────────────────
describe('case 10 · stale fallback · cache 过期 + endpoint 挂 → 返 stale=true 旧 cache', () => {
  it('第 1 次 ok 落 lastGood · TTL 过期后 fetch fail → 返旧数据 stale=true', async () => {
    vi.useFakeTimers();
    mockFetchOnceText(pgcatMetrics({ clWaiting: 7 }));
    const first = await handleGetPoolStats({ projectId: 'proj-A' });
    expect(first.stale).toBe(false);
    expect(first.pools[0].cl_waiting).toBe(7);

    // TTL 过期 (cache 删除 · 但 lastGood 仍保留)
    vi.advanceTimersByTime(10_001);

    // 第 2 次 endpoint 挂 (503 · retry once 都失败) → 降级到 lastGood
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('down', { status: 503 }),
    );
    const second = await handleGetPoolStats({ projectId: 'proj-A' });
    expect(second.stale).toBe(true);
    expect(second.cacheHit).toBe(true);
    // stale fallback 返回 fetchStatus = 失败分类 (http_5xx · 非 'ok')
    expect(second.fetchStatus).toBe('http_5xx');
    // 数据是旧的 (cl_waiting=7) · stale 标记透传到 row
    expect(second.pools[0].cl_waiting).toBe(7);
    expect(second.pools[0].stale).toBe(true);
  });
});

// ────────────────── Case 11 · per-project env override ──────────────────
describe('case 11 · per-project env override · PGCAT_METRICS_URL_<proj> 优先', () => {
  it('resolveMetricsUrl 优先级 per-endpoint > per-project > 全局', () => {
    process.env.PGCAT_METRICS_URL = 'http://global:9930/metrics';
    process.env.PGCAT_METRICS_URL_projA = 'http://proj-a:9930/metrics';
    process.env.PGCAT_METRICS_URL_projA_ep1 = 'http://proj-a-ep1:9930/metrics';

    // projectId 含 '-' 会被 norm 成 '_' · 这里用无 '-' 的 projA 直接验优先级
    expect(resolveMetricsUrl('projA')).toBe('http://proj-a:9930/metrics');
    expect(resolveMetricsUrl('projA', 'ep1')).toBe(
      'http://proj-a-ep1:9930/metrics',
    );
    // 其他 project 落全局
    expect(resolveMetricsUrl('projOther')).toBe('http://global:9930/metrics');
    // projectId 的 '-' 归一化成 '_' 后匹配 env key
    process.env['PGCAT_METRICS_URL_proj_X'] = 'http://proj-x:9930/metrics';
    expect(resolveMetricsUrl('proj-X')).toBe('http://proj-x:9930/metrics');
  });

  it('handler 用 per-project URL fetch (隔离不同 project 的 pgcat)', async () => {
    process.env.PGCAT_METRICS_URL = 'http://global:9930/metrics';
    process.env.PGCAT_METRICS_URL_projA = 'http://proj-a:9930/metrics';
    mockFetchOnceText(pgcatMetrics());

    await handleGetPoolStats({ projectId: 'projA' });

    // fetch 第 1 个参数 = per-project URL · 非全局
    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0][0];
    expect(calledUrl).toBe('http://proj-a:9930/metrics');
  });

  it('URL 未配 → friendly throw + audit timeout', async () => {
    delete process.env.PGCAT_METRICS_URL;
    await expect(handleGetPoolStats({ projectId: 'projZ' })).rejects.toThrow(
      /please configure PGCAT_METRICS_URL/i,
    );
    // 未配 URL 也 emit audit (fetch_status hardcoded 'timeout' · poolCount 0)
    expect(auditEvents).toHaveLength(1);
    expect(
      (auditEvents[0].extra as Record<string, unknown>)[
        'openneon.audit.fetch_status'
      ],
    ).toBe('timeout');
    // 完全不 fetch
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(0);
  });
});

// ────────────────── Case 12 · audit emit ──────────────────
describe('case 12 · audit emit · pool_stats_invoked + 全字段', () => {
  it('happy path emit pool_stats_invoked · outcome allow · severity low · extra 字段齐', async () => {
    mockFetchOnceText(pgcatMetrics({ clWaiting: 5 }));

    await handleGetPoolStats({
      projectId: 'proj-A',
      endpoint_id: 'ep-main',
    });

    expect(auditEvents).toHaveLength(1);
    const ev = auditEvents[0];
    expect(ev.event_type).toBe('pool_stats_invoked');
    expect(ev.outcome).toBe('allow');
    expect(ev.severity).toBe('low');
    expect(ev.project_id).toBe('proj-A');
    expect(ev.endpoint_id).toBe('ep-main');
    const extra = ev.extra as Record<string, unknown>;
    expect(extra['openneon.audit.pool_count']).toBe(1);
    expect(extra['openneon.audit.cl_waiting_total']).toBe(5);
    expect(extra['openneon.audit.fetch_status']).toBe('ok');
    expect(extra['openneon.audit.cache_hit']).toBe(false);
    expect(typeof extra['openneon.audit.duration_ms']).toBe('number');
  });

  it('cl_waiting_total 跨多 pool 累加', async () => {
    const text =
      pgcatMetrics({ pool: 'p1', clWaiting: 2 }) +
      pgcatMetrics({ pool: 'p2', clWaiting: 3 });
    mockFetchOnceText(text);

    await handleGetPoolStats({ projectId: 'proj-A' });

    const extra = auditEvents[0].extra as Record<string, unknown>;
    expect(extra['openneon.audit.pool_count']).toBe(2);
    expect(extra['openneon.audit.cl_waiting_total']).toBe(5); // 2 + 3
  });
});

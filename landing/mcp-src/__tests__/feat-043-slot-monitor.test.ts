/**
 * feat-043-slot-monitor.test.ts · 6 case fixture (design#53 §7)
 *
 * mock listEndpoints + mock pg client + mock emitAuditEvent · 不依赖真 Neon / OTel collector。
 * 直接 invoke cron handler (绕过 scheduler · 跟 design#53 §7 mock feat-038 cron register
 * "直接 invoke handler 不走调度器" 一致)。
 *
 * Cases (跟 issue #166 验收门 6 case 对齐):
 *   1. healthy            · 全 active · 0 emit + 1 cron_summary (zero counts)
 *   2. warn 阈值          · 25h inactive · emit warn 1 次 · severity=low
 *   3. critical 阈值      · 40h inactive · emit critical 1 次 · severity=high · recommended_action 含 pg_drop_replication_slot
 *   4. disabled_endpoint  · 40h inactive but disabled · 0 emit · cron_summary scanned_endpoints 不含该 endpoint
 *   5. per-endpoint override · prod 4h 阈值 · 5h inactive → emit warn; test 48h 阈值 · 25h inactive → 不 emit
 *   6. 跨 endpoint 隔离 + cron retry · endpoint-B throw · A/C 正常 · A critical · failed_endpoints=['endpoint-B']
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// hoisted mock · 必须在 import slot-checker / slot-monitor-cron 之前 (vi.mock 自动 hoist)
const emitMock = vi.fn();
vi.mock('../observability/audit-emit', () => ({
  emitAuditEvent: (event: unknown) => emitMock(event),
}));

import {
  initSlotMonitorCron,
  runSlotMonitorRound,
  type EndpointInfo,
  type SlotMonitorDeps,
  CRON_JOB_NAME,
  CRON_EXPRESSION,
} from '../server-enrich/slot-monitor/slot-monitor-cron';
import {
  resolveSlotMonitorPolicy,
  effectiveThresholdsFor,
  SLOT_MONITOR_DEFAULTS,
  type SlotMonitorPolicy,
} from '../server-enrich/slot-monitor/policy';
import type { PgClientLike } from '../server-enrich/slot-monitor/queries';
import {
  __getRegisteredJob,
  __clearRegistry,
} from '../server-enrich/slot-monitor/scheduler-contract';

type AuditEventCapture = {
  event_type: string;
  severity?: string;
  outcome?: string;
  principal?: string;
  project_id?: string;
  endpoint_id?: string;
  extra?: Record<string, unknown>;
};

function emitted(): AuditEventCapture[] {
  return emitMock.mock.calls.map((c) => c[0] as AuditEventCapture);
}

/** 构造 mock pg client · 返回固定 rows (匹配 SLOT_QUERY_SQL 输出 shape) */
function mockPg(
  rows: Array<{
    slot_name: string;
    inactive_seconds: number | null;
    restart_lsn?: string | null;
  }>,
): PgClientLike {
  const mapped = rows.map((r) => ({
    slot_name: r.slot_name,
    active: false,
    restart_lsn: r.restart_lsn ?? '0/0',
    inactive_since_text:
      r.inactive_seconds == null
        ? null
        : new Date(Date.now() - r.inactive_seconds * 1000).toISOString(),
    confirmed_flush_lsn_text: '0/0',
    inactive_seconds_pg16: r.inactive_seconds,
    has_inactive_since: r.inactive_seconds != null,
  }));
  return {
    query: async <R = unknown>(): Promise<{ rows: R[] }> => ({
      rows: mapped as unknown as R[],
    }),
  };
}

/** 构造 throw-on-query pg client (case 6) */
function mockPgThrowing(): PgClientLike {
  return {
    query: async <R = unknown>(): Promise<{ rows: R[] }> => {
      throw new Error('endpoint timeout (mock)');
    },
  };
}

function defaultPolicy(
  overrides: Partial<{
    warn: number;
    critical: number;
    disabled: string[];
    endpointOverrides: Record<
      string,
      { warn_inactive_seconds: number; critical_inactive_seconds: number }
    >;
  }> = {},
): SlotMonitorPolicy {
  return {
    warn_inactive_seconds:
      overrides.warn ?? SLOT_MONITOR_DEFAULTS.warn_inactive_seconds,
    critical_inactive_seconds:
      overrides.critical ?? SLOT_MONITOR_DEFAULTS.critical_inactive_seconds,
    cron_interval_seconds: SLOT_MONITOR_DEFAULTS.cron_interval_seconds,
    disabled_endpoints: overrides.disabled ?? [],
    endpoint_overrides: overrides.endpointOverrides ?? {},
  };
}

function makeDeps(
  endpoints: EndpointInfo[],
  pgFor: (endpoint: EndpointInfo) => PgClientLike,
  policy: SlotMonitorPolicy,
): SlotMonitorDeps {
  return {
    listEndpoints: async () => endpoints,
    pgClientFor: async (e) => pgFor(e),
    loadPolicy: () => policy,
    nowMs: () => 1_700_000_000_000,
    nowIso: () => '2026-05-28T00:00:00.000Z',
  };
}

beforeEach(() => {
  emitMock.mockReset();
  __clearRegistry();
});

describe('feat-043 · slot-monitor fixture · 6 case (design#53 §7)', () => {
  // ────────────────────────────────────────────────────────────────────────
  // Case 1 · healthy: 3 endpoint × 各 2 slot · 全 active · queries 返空 (WHERE active=false)
  // ────────────────────────────────────────────────────────────────────────
  it('case 1 healthy · 0 inactive emit + 1 cron_summary with zero counts', async () => {
    const endpoints: EndpointInfo[] = [
      { endpoint_id: 'ep-a', project_id: 'proj-1' },
      { endpoint_id: 'ep-b', project_id: 'proj-1' },
      { endpoint_id: 'ep-c', project_id: 'proj-2' },
    ];
    // 全 active → query 返 0 row (queries.ts WHERE active=false)
    const deps = makeDeps(endpoints, () => mockPg([]), defaultPolicy());
    initSlotMonitorCron(deps);
    const job = __getRegisteredJob(CRON_JOB_NAME)!;
    expect(job.cronExpression).toBe(CRON_EXPRESSION);

    await job.handler();

    const events = emitted();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('replication_slot_monitor_cron_summary');
    expect(events[0].severity).toBe('low');
    expect(events[0].principal).toBe('system:slot-monitor');
    expect(events[0].extra?.['openneon.slot_monitor.scanned_endpoints']).toBe(3);
    expect(events[0].extra?.['openneon.slot_monitor.scanned_slots']).toBe(0);
    expect(events[0].extra?.['openneon.slot_monitor.warn_emitted']).toBe(0);
    expect(events[0].extra?.['openneon.slot_monitor.critical_emitted']).toBe(0);
    expect(events[0].extra?.['openneon.slot_monitor.failed_endpoints']).toBe(
      '[]',
    );
    expect(events[0].extra?.['openneon.slot_monitor.duration_ms']).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case 2 · warn 阈值: 1 slot inactive_seconds = 25h (>= 24h global warn)
  // ────────────────────────────────────────────────────────────────────────
  it('case 2 warn · emit warn 1 + threshold_seconds=86400 + severity=low', async () => {
    const endpoints: EndpointInfo[] = [
      { endpoint_id: 'ep-prod', project_id: 'proj-1' },
    ];
    const deps = makeDeps(
      endpoints,
      () => mockPg([{ slot_name: 'sub_orders', inactive_seconds: 25 * 3600 }]),
      defaultPolicy(),
    );
    initSlotMonitorCron(deps);
    await __getRegisteredJob(CRON_JOB_NAME)!.handler();

    const warns = emitted().filter(
      (e) => e.event_type === 'replication_slot_inactive_warn',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].severity).toBe('low');
    expect(warns[0].outcome).toBe('allow');
    expect(warns[0].principal).toBe('system:slot-monitor');
    expect(warns[0].project_id).toBe('proj-1');
    expect(warns[0].endpoint_id).toBe('ep-prod');
    expect(warns[0].extra?.['openneon.slot_monitor.slot_name']).toBe(
      'sub_orders',
    );
    expect(warns[0].extra?.['openneon.slot_monitor.inactive_seconds']).toBe(
      25 * 3600,
    );
    expect(warns[0].extra?.['openneon.slot_monitor.threshold_seconds']).toBe(
      86400,
    );
    expect(warns[0].extra?.['openneon.slot_monitor.threshold_kind']).toBe(
      'warn',
    );
    expect(warns[0].extra?.['openneon.slot_monitor.detected_at']).toBe(
      '2026-05-28T00:00:00.000Z',
    );

    const summary = emitted().find(
      (e) => e.event_type === 'replication_slot_monitor_cron_summary',
    )!;
    expect(summary.extra?.['openneon.slot_monitor.warn_emitted']).toBe(1);
    expect(summary.extra?.['openneon.slot_monitor.critical_emitted']).toBe(0);
    expect(summary.extra?.['openneon.slot_monitor.scanned_slots']).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case 3 · critical 阈值: 40h inactive
  // ────────────────────────────────────────────────────────────────────────
  it('case 3 critical · emit critical 1 + severity=high + recommended_action 含 pg_drop_replication_slot', async () => {
    const endpoints: EndpointInfo[] = [
      { endpoint_id: 'ep-prod', project_id: 'proj-1' },
    ];
    const deps = makeDeps(
      endpoints,
      () => mockPg([{ slot_name: 'sub_legacy', inactive_seconds: 40 * 3600 }]),
      defaultPolicy(),
    );
    initSlotMonitorCron(deps);
    await __getRegisteredJob(CRON_JOB_NAME)!.handler();

    const critical = emitted().filter(
      (e) => e.event_type === 'replication_slot_inactive_critical',
    );
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe('high');
    expect(critical[0].project_id).toBe('proj-1');
    expect(critical[0].extra?.['openneon.slot_monitor.threshold_seconds']).toBe(
      129600,
    );
    expect(critical[0].extra?.['openneon.slot_monitor.threshold_kind']).toBe(
      'critical',
    );
    expect(
      String(critical[0].extra?.['openneon.slot_monitor.recommended_action']),
    ).toMatch(/pg_drop_replication_slot/);

    // warn 不能 emit (critical 优先 · slot-checker 单一出口)
    expect(
      emitted().filter(
        (e) => e.event_type === 'replication_slot_inactive_warn',
      ),
    ).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case 4 · disabled_endpoint: 40h inactive 但在 disabled_endpoints
  // ────────────────────────────────────────────────────────────────────────
  it('case 4 disabled_endpoint · 0 emit · summary.scanned_endpoints 不含该 endpoint', async () => {
    const endpoints: EndpointInfo[] = [
      { endpoint_id: 'ep-dev', project_id: 'proj-dev' },
      { endpoint_id: 'ep-prod-healthy', project_id: 'proj-1' },
    ];
    const policy = defaultPolicy({ disabled: ['ep-dev'] });
    const deps = makeDeps(
      endpoints,
      (e) =>
        e.endpoint_id === 'ep-dev'
          ? mockPg([{ slot_name: 'dev_slot', inactive_seconds: 40 * 3600 }])
          : mockPg([]),
      policy,
    );
    initSlotMonitorCron(deps);
    await __getRegisteredJob(CRON_JOB_NAME)!.handler();

    // 0 inactive event (ep-dev 整个跳过 · ep-prod-healthy 全 active)
    expect(
      emitted().filter(
        (e) =>
          e.event_type === 'replication_slot_inactive_warn' ||
          e.event_type === 'replication_slot_inactive_critical',
      ),
    ).toHaveLength(0);

    const summary = emitted().find(
      (e) => e.event_type === 'replication_slot_monitor_cron_summary',
    )!;
    // scanned_endpoints 仅 1 (ep-prod-healthy) · ep-dev 被 filter 掉
    expect(summary.extra?.['openneon.slot_monitor.scanned_endpoints']).toBe(1);
    expect(summary.extra?.['openneon.slot_monitor.warn_emitted']).toBe(0);
    expect(summary.extra?.['openneon.slot_monitor.critical_emitted']).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case 5 · per-endpoint override: prod 4h 阈值 → 5h inactive 触发 warn ·
  //                                  test 48h 阈值 → 25h inactive 不触发
  // ────────────────────────────────────────────────────────────────────────
  it('case 5 per-endpoint override · prod 4h triggers warn @ 5h · test 48h skips @ 25h', async () => {
    const endpoints: EndpointInfo[] = [
      { endpoint_id: 'endpoint_prod_xxx', project_id: 'proj-prod' },
      { endpoint_id: 'endpoint_test_xxx', project_id: 'proj-test' },
    ];
    const policy = defaultPolicy({
      endpointOverrides: {
        endpoint_prod_xxx: {
          warn_inactive_seconds: 14400, // 4h
          critical_inactive_seconds: 21600, // 6h
        },
        endpoint_test_xxx: {
          warn_inactive_seconds: 172800, // 48h
          critical_inactive_seconds: 259200, // 72h
        },
      },
    });
    const deps = makeDeps(
      endpoints,
      (e) =>
        e.endpoint_id === 'endpoint_prod_xxx'
          ? mockPg([
              { slot_name: 'sub_prod_billing', inactive_seconds: 5 * 3600 },
            ])
          : mockPg([
              { slot_name: 'sub_test_smoke', inactive_seconds: 25 * 3600 },
            ]),
      policy,
    );
    initSlotMonitorCron(deps);
    await __getRegisteredJob(CRON_JOB_NAME)!.handler();

    const warns = emitted().filter(
      (e) => e.event_type === 'replication_slot_inactive_warn',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].endpoint_id).toBe('endpoint_prod_xxx');
    expect(warns[0].extra?.['openneon.slot_monitor.threshold_seconds']).toBe(
      14400,
    );
    expect(warns[0].extra?.['openneon.slot_monitor.inactive_seconds']).toBe(
      5 * 3600,
    );

    // test endpoint 不 emit (25h < 48h override warn)
    const testEvents = emitted().filter(
      (e) => e.endpoint_id === 'endpoint_test_xxx',
    );
    expect(testEvents).toHaveLength(0);

    // 0 critical (5h < 6h prod critical)
    expect(
      emitted().filter(
        (e) => e.event_type === 'replication_slot_inactive_critical',
      ),
    ).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case 6 · 跨 endpoint 隔离 + cron retry: endpoint-B throw · A/C 正常
  // ────────────────────────────────────────────────────────────────────────
  it('case 6 cross-endpoint isolation · B throws · A emits critical · C all active · failed_endpoints=["endpoint-B"]', async () => {
    const endpoints: EndpointInfo[] = [
      { endpoint_id: 'endpoint-A', project_id: 'proj-A' },
      { endpoint_id: 'endpoint-B', project_id: 'proj-B' },
      { endpoint_id: 'endpoint-C', project_id: 'proj-C' },
    ];
    const deps = makeDeps(
      endpoints,
      (e) => {
        if (e.endpoint_id === 'endpoint-A')
          return mockPg([
            { slot_name: 'sub_a_critical', inactive_seconds: 40 * 3600 },
          ]);
        if (e.endpoint_id === 'endpoint-B') return mockPgThrowing();
        return mockPg([]);
      },
      defaultPolicy(),
    );
    initSlotMonitorCron(deps);
    await __getRegisteredJob(CRON_JOB_NAME)!.handler();

    const critical = emitted().filter(
      (e) => e.event_type === 'replication_slot_inactive_critical',
    );
    expect(critical).toHaveLength(1);
    expect(critical[0].endpoint_id).toBe('endpoint-A');

    const summary = emitted().find(
      (e) => e.event_type === 'replication_slot_monitor_cron_summary',
    )!;
    expect(summary.extra?.['openneon.slot_monitor.scanned_endpoints']).toBe(3);
    expect(summary.extra?.['openneon.slot_monitor.failed_endpoints']).toBe(
      '["endpoint-B"]',
    );
    expect(summary.extra?.['openneon.slot_monitor.scanned_slots']).toBe(1); // A 1 row · B failed · C 0 row
    expect(summary.extra?.['openneon.slot_monitor.critical_emitted']).toBe(1);
    expect(summary.extra?.['openneon.slot_monitor.warn_emitted']).toBe(0);
    expect(
      Number(summary.extra?.['openneon.slot_monitor.duration_ms']),
    ).toBeGreaterThanOrEqual(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 额外: policy resolver 单测 (boundary · per-endpoint override validation)
// ────────────────────────────────────────────────────────────────────────
describe('feat-043 · slot-monitor policy resolver', () => {
  it('global defaults · 文件缺失 fall-back 24h/36h/3600s', () => {
    const p = resolveSlotMonitorPolicy(null);
    expect(p.warn_inactive_seconds).toBe(86400);
    expect(p.critical_inactive_seconds).toBe(129600);
    expect(p.cron_interval_seconds).toBe(3600);
    expect(p.disabled_endpoints).toEqual([]);
    expect(p.endpoint_overrides).toEqual({});
  });

  it('global warn >= critical · throws (fail-stop · 不静默 swap)', () => {
    expect(() =>
      resolveSlotMonitorPolicy({
        warn_inactive_seconds: 100000,
        critical_inactive_seconds: 100000,
      }),
    ).toThrow(/warn_inactive_seconds.*must be < critical/);
  });

  it('endpoint override 用 · effectiveThresholdsFor 返 override 不返全局', () => {
    const p = resolveSlotMonitorPolicy({
      endpoint_overrides: {
        ep_x: { warn_inactive_seconds: 100, critical_inactive_seconds: 200 },
      },
    });
    const eff = effectiveThresholdsFor('ep_x', p);
    expect(eff.warn_inactive_seconds).toBe(100);
    expect(eff.critical_inactive_seconds).toBe(200);

    const fallback = effectiveThresholdsFor('ep_unknown', p);
    expect(fallback.warn_inactive_seconds).toBe(86400);
    expect(fallback.critical_inactive_seconds).toBe(129600);
  });

  it('endpoint override warn >= critical · throws (fail-stop · per-endpoint)', () => {
    expect(() =>
      resolveSlotMonitorPolicy({
        endpoint_overrides: {
          ep_bad: {
            warn_inactive_seconds: 200,
            critical_inactive_seconds: 100,
          },
        },
      }),
    ).toThrow(/override invalid.*warn/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 额外: runSlotMonitorRound 直接调 (绕过 register · 行为级测试)
// ────────────────────────────────────────────────────────────────────────
describe('feat-043 · runSlotMonitorRound 行为', () => {
  it('duration_ms 用 nowMs 注入 · 不依赖墙钟', async () => {
    let tick = 1000;
    const deps: SlotMonitorDeps = {
      listEndpoints: async () => [
        { endpoint_id: 'e1', project_id: 'p1' },
      ],
      pgClientFor: async () => mockPg([]),
      loadPolicy: () => defaultPolicy(),
      nowMs: () => {
        const t = tick;
        tick += 123;
        return t;
      },
    };
    const result = await runSlotMonitorRound(deps);
    expect(result.duration_ms).toBe(123);
    expect(result.scanned_endpoints).toBe(1);
    expect(result.scanned_slots).toBe(0);
  });
});

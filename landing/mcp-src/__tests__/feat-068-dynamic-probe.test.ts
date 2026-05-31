/**
 * feat-068-dynamic-probe.test.ts · feat-068 重设计 (#210 · ADR-0017) · SQL 驱动 pg_uprobe
 *
 * 重设计前: bpftrace 模板 + ephemeral sidecar (MockDispatcher) + whitelist 强制。
 * 重设计后: pg_uprobe SQL 驱动 (mock PgClientLike) + denylist FLOOR。
 *
 * 覆盖:
 *  case A  · 正路径 TIME probe → enriched (calls/avg_time_ns) + audit attached/detached + SQL 参数化
 *  case A2 · 正路径 HIST probe → 直方图行集
 *  case B  · 恶意 input (probe_type 越界 / function 含 SQL 注入字符) → schema 拒
 *  case C  · denylist FLOOR (scram_sha256 / get_role_password / rust ::scram_) → denylist 拒
 *  case D  · 跨 tenant attach (G1 hard-deny) → policy 拒
 *  case E  · sql-driver 抛 (set_uprobe 失败) → sql-driver 阶段拒 + probe_attach_failed audit
 *  case F  · post-condition fail (stat 没采到 calls = 探针没真挂上) → post-condition 拒
 *  case G  · 限流 (per-function 5min/5) → rate-limit 拒
 *  附加    · L3 require_plan / L1-L2 deny / risk=high
 *  sql-driver 单测 · parseTimeStat / 同连接时序 / delete best-effort / 参数化绑定
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction,
} from 'vitest';
import {
  attachDynamicProbeHandler,
  __resetRateLimitForTest,
  __setDenylistForTest,
  RATE_LIMITS,
  runProbe,
  parseTimeStat,
  type AttachHandlerCtx,
  type Denylist,
  type PgClientLike,
} from '../tools/handlers/dynamic-probe';
import * as auditEmit from '../observability/audit-emit';

/**
 * Fixture denylist FLOOR · 跟 openneon mirror 同形 (version=1 · denylist {usdt_probe_patterns, uprobe_symbol_patterns})。
 * pattern 走 re.fullmatch (整串匹配 · case-sensitive)。
 */
const FIXTURE_DENYLIST: Denylist = {
  version: 1,
  denylist: {
    usdt_probe_patterns: [
      'scram_.*',
      'get_role_password',
      'be_tls_.*',
      'pg_md5_.*',
    ],
    uprobe_symbol_patterns: ['.*::scram_.*', '.*::password::.*'],
  },
};

/** 记录所有 SQL 调用 (test inspect 参数化绑定 + 时序 + 同连接) */
type SqlCall = { sql: string; params: unknown[] };

/**
 * mock PgClientLike · 单连接 (同一实例 = 同 session · 验证 set/stat/delete 同连接) ·
 * 按 SQL 形状返 stat 行 (可配置)。
 */
function mockPgClient(opts: {
  timeStat?: string; // stat_time_uprobe 返回串
  histRows?: Array<{ time_range: string; hist_entry: string; percent: number }>;
  throwOnSet?: boolean;
  throwOnStat?: boolean;
} = {}): { client: PgClientLike; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const client: PgClientLike = {
    async query<R = unknown>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/set_uprobe/.test(sql)) {
        if (opts.throwOnSet) throw new Error('mock set_uprobe failed (capability missing)');
        return { rows: [{ set_uprobe: 'ok' }] as unknown as R[] };
      }
      if (/stat_time_uprobe/.test(sql)) {
        if (opts.throwOnStat) throw new Error('mock stat_time_uprobe failed');
        return {
          rows: [
            { stat_time_uprobe: opts.timeStat ?? 'calls: 1234  avg time: 567 ns' },
          ] as unknown as R[],
        };
      }
      if (/stat_hist_uprobe/.test(sql)) {
        if (opts.throwOnStat) throw new Error('mock stat_hist_uprobe failed');
        return {
          rows: (opts.histRows ?? [
            { time_range: '(12.6 us, 17.1 us)', hist_entry: '@@@', percent: 66.666 },
            { time_range: '(17.1 us, 21.7 us)', hist_entry: '@', percent: 16.666 },
          ]) as unknown as R[],
        };
      }
      if (/delete_uprobe/.test(sql)) {
        return { rows: [] as unknown as R[] };
      }
      return { rows: [] as unknown as R[] };
    },
  };
  return { client, calls };
}

function buildCtx(
  over: Partial<AttachHandlerCtx> = {},
  pgOpts: Parameters<typeof mockPgClient>[0] = {},
): { ctx: AttachHandlerCtx; calls: SqlCall[] } {
  const { client, calls } = mockPgClient(pgOpts);
  const ctx: AttachHandlerCtx = {
    pgClient: client,
    autonomyLevel: 'L4',
    tenant: 'tenant-A',
    denylist: FIXTURE_DENYLIST,
    _testOnlyPlanApprovedBypass: true,
    // 跳过真实 duration 等待 · 单测不卡时长
    _testOnlySleep: async () => {},
    ...over,
  };
  return { ctx, calls };
}

describe('feat-068 dynamic-probe · SQL 驱动 pg_uprobe (#210)', () => {
  let emitSpy: MockedFunction<typeof auditEmit.emitAuditEvent>;

  beforeEach(() => {
    __resetRateLimitForTest();
    __setDenylistForTest(FIXTURE_DENYLIST);
    emitSpy = vi
      .spyOn(auditEmit, 'emitAuditEvent')
      .mockImplementation(() => undefined) as MockedFunction<
      typeof auditEmit.emitAuditEvent
    >;
  });

  // ─────────────────────────────────────────────────────────────
  // case A · 正路径 TIME probe → enriched + audit + 参数化 SQL
  it('case A · 正路径 TIME probe → 拿到 calls/avg_time_ns + audit attached/detached + 参数化 SQL', async () => {
    const { ctx, calls } = buildCtx();
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
        project_id: 'tenant-A',
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.attachId).toMatch(/^probe-/);
    expect(out.result.status).toBe('completed');
    expect(out.result.output.probe_type).toBe('TIME');
    if (out.result.output.probe_type === 'HIST') throw new Error('unreachable');
    expect(out.result.output.calls).toBe(1234);
    expect(out.result.output.avg_time_ns).toBe(567);

    // 时序: set → stat → delete (同一 client 连接 · 顺序正确)
    const sqls = calls.map((c) => c.sql);
    const setIdx = sqls.findIndex((s) => /set_uprobe/.test(s));
    const statIdx = sqls.findIndex((s) => /stat_time_uprobe/.test(s));
    const delIdx = sqls.findIndex((s) => /delete_uprobe/.test(s));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(statIdx).toBeGreaterThan(setIdx);
    expect(delIdx).toBeGreaterThan(statIdx);

    // 参数化绑定 (防注入 · #210): 函数名走 $1 · probe_type 走 $2 · 不出现在 SQL 字符串里
    const setCall = calls[setIdx];
    expect(setCall.sql).toMatch(/\$1.*\$2|\$2.*\$1/);
    expect(setCall.sql).not.toContain('PortalStart');
    expect(setCall.params).toEqual(['PortalStart', 'TIME']);
    expect(calls[statIdx].params).toEqual(['PortalStart']);
    expect(calls[delIdx].params).toEqual(['PortalStart']);

    const types = emitSpy.mock.calls.map((c) => c[0].event_type);
    expect(types).toContain('probe_attached');
    expect(types).toContain('probe_detached');
  });

  // case A2 · HIST probe → 直方图行集
  it('case A2 · 正路径 HIST probe → 直方图行集 + 参数化 stat_hist_uprobe', async () => {
    const { ctx, calls } = buildCtx();
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'HIST',
        function: 'PortalRun',
        target: 'pg',
        duration_seconds: 10,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.result.output.probe_type).toBe('HIST');
    if (out.result.output.probe_type !== 'HIST') throw new Error('unreachable');
    expect(out.result.output.histogram.length).toBe(2);
    expect(out.result.output.histogram[0].percent).toBeCloseTo(66.666, 2);
    // set 第二参 = HIST
    const setCall = calls.find((c) => /set_uprobe/.test(c.sql));
    expect(setCall?.params).toEqual(['PortalRun', 'HIST']);
    // 用 stat_hist_uprobe 而非 stat_time_uprobe
    expect(calls.some((c) => /stat_hist_uprobe/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /stat_time_uprobe/.test(c.sql))).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // case B · 恶意 input → schema 拒
  it('case B · probe_type 越界 / function SQL 注入字符 → schema 拒', async () => {
    const { ctx } = buildCtx();
    // B-1: probe_type 越界
    const bad1 = await attachDynamicProbeHandler(
      {
        probe_type: 'EXFIL', // 不在 enum
        function: 'PortalStart',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
      },
      ctx,
    );
    expect(bad1.ok).toBe(false);
    if (bad1.ok) throw new Error('unreachable');
    expect(bad1.stage).toBe('schema');

    // B-2: function 含 SQL 注入字符
    const bad2 = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: "x'); DROP TABLE users;--",
        duration_seconds: 30,
        max_overhead_pct: 2.0,
      },
      ctx,
    );
    expect(bad2.ok).toBe(false);
    if (bad2.ok) throw new Error('unreachable');
    expect(bad2.stage).toBe('schema');

    // B-3: function 含冒号 (旧 USDT probe_name 形式 · 新 regex 去掉冒号 · 应拒)
    const bad3 = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'postgresql:executor__run',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
      },
      ctx,
    );
    expect(bad3.ok).toBe(false);
    if (bad3.ok) throw new Error('unreachable');
    expect(bad3.stage).toBe('schema');
  });

  // ─────────────────────────────────────────────────────────────
  // case C · denylist FLOOR → denylist 拒 (不再要求 ∈ whitelist · 但 floor 命中即拒)
  it('case C · denylist FLOOR (scram_sha256 / get_role_password) → denylist 阶段拒', async () => {
    const { ctx } = buildCtx();
    for (const fn of ['scram_sha256', 'get_role_password', 'pg_md5_hash', 'be_tls_open_server']) {
      const out = await attachDynamicProbeHandler(
        {
          probe_type: 'TIME',
          function: fn,
          target: 'pg',
          duration_seconds: 5,
          max_overhead_pct: 2.0,
          endpoint_id: 'ep-A',
        },
        ctx,
      );
      expect(out.ok, `function ${fn} 应被 denylist 拒`).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.stage).toBe('denylist');
      expect(out.reason).toMatch(/denylist|FLOOR/);
    }
  });

  it('case C2 · denylist 不误伤合法函数 (fullmatch · scram_X 命中但 myscram 不命中)', async () => {
    const { ctx } = buildCtx();
    // 'myscram_foo' 不被 'scram_.*' fullmatch 命中 (fullmatch 锚 ^$ · 前缀 my 阻断)
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'myscram_foo',
        target: 'pg',
        duration_seconds: 5,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(true);
  });

  it('case C3 · rust target denylist (::scram_) → denylist 拒', async () => {
    const { ctx } = buildCtx();
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'neon_pageserver_auth_scram_verify', // 不命中 · 普通函数
        target: 'rust',
        duration_seconds: 5,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    // 上面这个不含 '::' 不被 .*::scram_.* 命中 → 放行
    expect(out.ok).toBe(true);

    // 用 inline denylist 注入一个会命中的 rust 符号验证拒 (规避 SAFE_SYMBOL_RE 不允许 ':')
    // 注: SAFE_SYMBOL_RE 不含冒号 · 真实 rust 符号 attach 走 schema 后 function 已无 '::' ·
    // 这里验证 denylist uprobe_symbol_patterns 集本身可命中 (单测 checkDenylist 直接覆盖)。
    const { checkDenylist } = await import(
      '../tools/handlers/dynamic-probe/denylist'
    );
    const r = checkDenylist('neon::scram_verify', 'rust', FIXTURE_DENYLIST);
    expect(r.ok).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // case D · 跨 tenant attach (G1 hard-deny)
  it('case D · 跨 tenant attach → policy 拒 (G1 hard-deny)', async () => {
    const { ctx } = buildCtx({ tenant: 'tenant-A' });
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-X',
        project_id: 'tenant-B', // 跨 project
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('policy');
    expect(out.reason).toMatch(/跨 project|G1|hard-deny/);
  });

  // ─────────────────────────────────────────────────────────────
  // case E · sql-driver 抛 (set_uprobe 失败) → sql-driver 阶段拒
  it('case E · sql-driver set_uprobe 抛 → sql-driver 阶段拒 + probe_attach_failed audit', async () => {
    const { ctx } = buildCtx({}, { throwOnSet: true });
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('sql-driver');
    const types = emitSpy.mock.calls.map((c) => c[0].event_type);
    expect(types).toContain('probe_attach_failed');
  });

  // ─────────────────────────────────────────────────────────────
  // case F · post-condition fail (stat 没采到 calls = 探针没真挂上)
  it('case F · stat 返回无 calls (探针没真挂上) → post-condition 拒 + probe_attach_failed', async () => {
    const { ctx } = buildCtx({}, { timeStat: 'no data collected' });
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 5,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('post-condition');
    const types = emitSpy.mock.calls.map((c) => c[0].event_type);
    expect(types).toContain('probe_attach_failed');
  });

  // case F2 · post-condition overhead 超阈值 (route.ts 注入真实 overhead)
  it('case F2 · 真实 overhead > max → post-condition 拒 + overhead_exceeded high', async () => {
    const { ctx } = buildCtx({ observedOverheadPct: 9.0 });
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 5,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('post-condition');
    const overheadEv = emitSpy.mock.calls.find(
      (c) => c[0].event_type === 'probe_overhead_exceeded',
    );
    expect(overheadEv).toBeDefined();
    expect(overheadEv?.[0].severity).toBe('high');
  });

  // ─────────────────────────────────────────────────────────────
  // case G · 限流 (per-function 5min/5)
  it('case G · per-function 5min/5 限流 → rate-limit 拒', async () => {
    // 跑满 per-function 配额 (用不同 tenant 绕过 per-tenant 5min/2)
    for (let i = 0; i < RATE_LIMITS.PER_FUNCTION_MAX; i++) {
      const { ctx: ctxi } = buildCtx({ tenant: `tenant-${i}` });
      const ok = await attachDynamicProbeHandler(
        {
          probe_type: 'TIME',
          function: 'PortalStart',
          target: 'pg',
          duration_seconds: 1,
          max_overhead_pct: 2.0,
          endpoint_id: 'ep-A',
        },
        ctxi,
      );
      expect(ok.ok).toBe(true);
    }
    const { ctx } = buildCtx();
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 1,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('rate-limit');
    expect(out.reason).toMatch(/per-function|5min/);
    const types = emitSpy.mock.calls.map((c) => c[0].event_type);
    expect(types).toContain('probe_rate_limit_exceeded');
  });

  // ─────────────────────────────────────────────────────────────
  // 附加 · L3 require_plan
  it('附加 · L3 + 未审批 → policy 阶段返 require_plan verdict', async () => {
    const { ctx } = buildCtx({
      autonomyLevel: 'L3',
      _testOnlyPlanApprovedBypass: false,
    });
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
        project_id: 'tenant-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('policy');
    expect(out.verdict?.action).toBe('require_plan');
    expect(out.verdict?.plan?.op_class).toBe('DYNAMIC_PROBE_ATTACH');
    expect(out.verdict?.plan?.risk_level).toBe('high');
  });

  // 附加 · L1/L2 deny
  it('附加 · L1/L2a/L2b → 矩阵 deny · 不弹 plan', async () => {
    for (const lvl of ['L1', 'L2a', 'L2b'] as const) {
      const { ctx } = buildCtx({ autonomyLevel: lvl });
      const out = await attachDynamicProbeHandler(
        {
          probe_type: 'TIME',
          function: 'PortalStart',
          target: 'pg',
          duration_seconds: 30,
          max_overhead_pct: 2.0,
          endpoint_id: 'ep-A',
          project_id: 'tenant-A',
        },
        ctx,
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.stage).toBe('policy');
      expect(out.verdict?.action).toBe('deny');
    }
  });

  // 附加 · L3+ 缺 endpoint_id → policy 拒
  it('附加 · L4 缺 endpoint_id → policy 拒 (ODD 内强制)', async () => {
    const { ctx } = buildCtx({ autonomyLevel: 'L4' });
    const out = await attachDynamicProbeHandler(
      {
        probe_type: 'TIME',
        function: 'PortalStart',
        target: 'pg',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
        // endpoint_id 缺
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('policy');
    expect(out.reason).toMatch(/endpoint_id/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// sql-driver 单测 · parseTimeStat / 同连接时序 / delete best-effort / 参数化
// ────────────────────────────────────────────────────────────────────────
describe('feat-068 sql-driver · pg_uprobe SQL 驱动单测 (#210)', () => {
  it('parseTimeStat · "calls: N  avg time: M ns" → { calls, avg_time_ns }', () => {
    expect(parseTimeStat('calls: 1234  avg time: 567 ns')).toEqual({
      calls: 1234,
      avg_time_ns: 567,
    });
    expect(parseTimeStat('calls: 0  avg time: 0 ns')).toEqual({
      calls: 0,
      avg_time_ns: 0,
    });
    // 字段缺失 → null (不抛)
    expect(parseTimeStat('no data')).toEqual({ calls: null, avg_time_ns: null });
  });

  it('runProbe · TIME 同连接跑 set→stat→delete · 参数化 $1/$2 · 不拼接函数名', async () => {
    const calls: SqlCall[] = [];
    const client: PgClientLike = {
      async query<R = unknown>(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (/stat_time_uprobe/.test(sql)) {
          return {
            rows: [
              { stat_time_uprobe: 'calls: 42  avg time: 100 ns' },
            ] as unknown as R[],
          };
        }
        return { rows: [] as unknown as R[] };
      },
    };
    const res = await runProbe(client, {
      function: 'PortalStart',
      probe_type: 'TIME',
      duration_seconds: 30,
      sleep: async () => {}, // 跳过等待
    });
    expect(res.probe_type).toBe('TIME');
    if (res.probe_type === 'HIST') throw new Error('unreachable');
    expect(res.calls).toBe(42);
    expect(res.avg_time_ns).toBe(100);
    // 全程同一 client 实例 (同 session) · set/stat/delete 顺序
    expect(calls.map((c) => c.sql.match(/(set_uprobe|stat_time_uprobe|delete_uprobe)/)?.[1])).toEqual(
      ['set_uprobe', 'stat_time_uprobe', 'delete_uprobe'],
    );
    // 函数名只走 params · 不在 SQL 串里
    for (const c of calls) {
      expect(c.sql).not.toContain('PortalStart');
    }
    expect(calls[0].params).toEqual(['PortalStart', 'TIME']);
  });

  it('runProbe · stat 抛仍 best-effort delete_uprobe (探针不悬挂) + 原始错误透传', async () => {
    const calls: SqlCall[] = [];
    const client: PgClientLike = {
      async query<R = unknown>(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (/stat_time_uprobe/.test(sql)) throw new Error('boom stat');
        return { rows: [] as unknown as R[] };
      },
    };
    await expect(
      runProbe(client, {
        function: 'PortalStart',
        probe_type: 'TIME',
        duration_seconds: 5,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/boom stat/);
    // set 后 stat 抛 · finally 仍跑 delete_uprobe
    expect(calls.some((c) => /delete_uprobe/.test(c.sql))).toBe(true);
  });

  it('runProbe · HIST 走 stat_hist_uprobe · 返直方图行', async () => {
    const client: PgClientLike = {
      async query<R = unknown>(sql: string) {
        if (/stat_hist_uprobe/.test(sql)) {
          return {
            rows: [
              { time_range: '(a,b)', hist_entry: '@@', percent: '50.0' },
            ] as unknown as R[],
          };
        }
        return { rows: [] as unknown as R[] };
      },
    };
    const res = await runProbe(client, {
      function: 'PortalRun',
      probe_type: 'HIST',
      duration_seconds: 1,
      sleep: async () => {},
    });
    expect(res.probe_type).toBe('HIST');
    if (res.probe_type !== 'HIST') throw new Error('unreachable');
    expect(res.histogram).toEqual([
      { time_range: '(a,b)', hist_entry: '@@', percent: 50 },
    ]);
  });
});

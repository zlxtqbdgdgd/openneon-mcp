/**
 * feat-068-dynamic-probe.test.ts · feat-068/#4 (#143) · 8 case fixture 端到端
 *
 * 覆盖 4 个 sub-issue 全部验收门:
 *
 *  case A · 正路径 attach (Rust uprobe neon_pageserver::wal_lazy_apply 30s) → enriched 结果 + audit 完整 (#143 §7)
 *  case B · 恶意 bpftrace 模板 (template enum 越界) → schema 拒
 *  case C · 越权 pid (resolveTargetPid 返 0)        → sidecar 拒 (target-pid 显式)
 *  case D · 跨 tenant attach (G1 hard-deny)          → policy 拒
 *  case E · 容器 capability 缺失 (sidecar.forceFail) → sidecar 拒 + post-condition fail
 *  case F · watchdog 超时 (overhead 超阈值)          → 提前 detach + overhead_exceeded audit high
 *  case G · 限流触发 (per-function 5min 内 5+ 次)     → rate-limit 拒
 *  case H · post-condition fail (跑完后 obs > max)   → post-condition fail + audit
 *
 * 跟现有测试边界:
 *   - 不重测 zod schema 细节 (留 dynamic-probe/__tests__/ 单测) · 这里走 handler 整体
 *   - 不真起 sidecar pod · MockDispatcher 注入 (单元 / e2e 边界 = 真集群)
 *   - feat-027 plan-mode elicitation 由 route.ts 跑 · 这里直接 _testOnlyPlanApprovedBypass=true 模拟过审
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
  MockDispatcher,
  __resetRateLimitForTest,
  __setWhitelistForTest,
  RATE_LIMITS,
  type AttachHandlerCtx,
  type Whitelist,
} from '../tools/handlers/dynamic-probe';
import * as auditEmit from '../observability/audit-emit';

/**
 * Fixture · 跟 anchor #39 schema 同形 (version=1 · usdt[] + uprobe[] · denylist {usdt_probe_patterns, uprobe_symbol_patterns})。
 *
 * USDT 命名遵循 anchor pattern `^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*(__[a-z][a-z0-9_]+)*$`:
 *   - postgresql:executor__run  (executor 子系统 入口探针)
 *   - postgresql:lwlock__acquire (lwlock 子系统 入口探针)
 *
 * uprobe Rust 符号:
 *   - neon_pageserver::wal_lazy_apply (sync_fn / is_async=false)
 */
const FIXTURE_WHITELIST: Whitelist = {
  version: 1,
  usdt: [
    {
      target: 'postgresql',
      probe_name: 'postgresql:executor__run',
      subsystem: 'executor',
      pg_version_min: 14,
      pg_version_max: null,
      notes: 'PG executor run · 单点入口 (无 retprobe)',
    },
    {
      target: 'postgresql',
      probe_name: 'postgresql:lwlock__acquire',
      subsystem: 'lwlock',
      pg_version_min: 14,
      pg_version_max: null,
      notes: 'PG LWLock acquire · arg0=lock name',
    },
  ],
  uprobe: [
    {
      binary: 'pageserver',
      symbol: 'neon_pageserver::wal_lazy_apply',
      module: 'neon_pageserver',
      type: 'sync_fn',
      is_async: false,
      notes: 'Rust uprobe · 同步函数 · 支持 latency_buckets 配对',
    },
  ],
  denylist: {
    usdt_probe_patterns: [
      '^postgresql:scram_.*',
      '.*__(secret|password)__.*',
      '.*authenticate.*',
    ],
    uprobe_symbol_patterns: ['.*::scram_.*', '.*_secret_.*', '.*password.*'],
  },
};

function buildCtx(over: Partial<AttachHandlerCtx> = {}): {
  ctx: AttachHandlerCtx;
  dispatcher: MockDispatcher;
} {
  const dispatcher = new MockDispatcher();
  const ctx: AttachHandlerCtx = {
    dispatcher,
    resolveTargetPid: async () => 12345,
    // L4 ODD + 预审批 = 跳 plan-mode (feat-049 MRC 状态机正路径 · 详 #141 验收门)
    // 8 case fixture 模拟"过审后的 attach 流" · 单独的 require_plan 路径见 case I (L3 + _testOnlyPlanApprovedBypass=false)
    autonomyLevel: 'L4',
    tenant: 'tenant-A',
    whitelist: FIXTURE_WHITELIST,
    _testOnlyPlanApprovedBypass: true,
    watchdogPollMs: 10,
    ...over,
  };
  return { ctx, dispatcher };
}

describe('feat-068 dynamic-probe · 8 case fixture', () => {
  let emitSpy: MockedFunction<typeof auditEmit.emitAuditEvent>;

  beforeEach(() => {
    __resetRateLimitForTest();
    __setWhitelistForTest(FIXTURE_WHITELIST);
    emitSpy = vi
      .spyOn(auditEmit, 'emitAuditEvent')
      .mockImplementation(() => undefined) as MockedFunction<
      typeof auditEmit.emitAuditEvent
    >;
  });

  // ─────────────────────────────────────────────────────────────
  // case A · 正路径 attach (Rust uprobe neon_pageserver::wal_lazy_apply 30s) → enriched + audit 完整
  //  · 用 uprobe + latency_buckets 配对 · 验证 retHead 正确生成 `uretprobe:` (BUG A 反向回归)
  it('case A · 正路径 attach uprobe entry/exit → 拿到 enriched 结果 + audit attached/detached', async () => {
    const { ctx, dispatcher } = buildCtx();
    const out = await attachDynamicProbeHandler(
      {
        template: 'latency_buckets',
        function: 'neon_pageserver::wal_lazy_apply',
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
    expect(out.result.output).toMatchObject({
      template: 'latency_buckets',
      function: 'neon_pageserver::wal_lazy_apply',
    });
    // dispatcher 收到正确的 bpftrace 脚本 (含 target pid · 入口 uprobe + 出口 uretprobe 都生成)
    expect(dispatcher.dispatches[0].targetPid).toBe(12345);
    expect(dispatcher.dispatches[0].bpftraceScript).toContain('pid == 12345');
    expect(dispatcher.dispatches[0].bpftraceScript).toContain('interval:s:30');
    // BUG A 反向回归: 入口走 uprobe: · 出口必须走 uretprobe: · 不能是 usdt:/usdt: 同样的 no-op
    expect(dispatcher.dispatches[0].bpftraceScript).toMatch(/uprobe:pageserver:/);
    expect(dispatcher.dispatches[0].bpftraceScript).toMatch(/uretprobe:pageserver:/);
    // audit: attached + detached 都 emit (count >= 2)
    const types = emitSpy.mock.calls.map((c) => c[0].event_type);
    expect(types).toContain('probe_attached');
    expect(types).toContain('probe_detached');
  });

  // case A' · BUG A 正向回归 · USDT + latency_buckets 必须被 schema 拒
  it("case A' · USDT + latency_buckets (entry/exit 配对) → schema 拒 · BUG A 修复", async () => {
    const { ctx } = buildCtx();
    const out = await attachDynamicProbeHandler(
      {
        template: 'latency_buckets',
        function: 'postgresql:executor__run',
        duration_seconds: 5,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
        project_id: 'tenant-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('schema');
    expect(out.reason).toMatch(/entry\/exit 配对|uretprobe|USDT.*不支持/);
  });

  // ─────────────────────────────────────────────────────────────
  // case B · 恶意 bpftrace 模板 (template enum 越界 / function 含 ; 注入)
  it('case B · 恶意 bpftrace 模板 enum / function 注入 → schema 拒', async () => {
    const { ctx } = buildCtx();
    // B-1: template 越界
    const bad1 = await attachDynamicProbeHandler(
      {
        template: 'rm_rf_anything', // 不在 enum
        function: 'postgresql:executor__run', // function 合法 · 确保 fail 在 template enum 而非 whitelist
        duration_seconds: 30,
        max_overhead_pct: 2.0,
      },
      ctx,
    );
    expect(bad1.ok).toBe(false);
    if (bad1.ok) throw new Error('unreachable');
    expect(bad1.stage).toBe('schema');

    // B-2: function 含 bpftrace 注入字符
    const bad2 = await attachDynamicProbeHandler(
      {
        template: 'latency_buckets',
        function: 'ExecutorRun; system("rm -rf /")',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
      },
      ctx,
    );
    expect(bad2.ok).toBe(false);
    if (bad2.ok) throw new Error('unreachable');
    expect(bad2.stage).toBe('schema');
  });

  // ─────────────────────────────────────────────────────────────
  // case C · 越权 pid (resolveTargetPid 返 0 = 全局) → 拒
  it('case C · target-pid=0 全局 attach → sidecar 阶段拒', async () => {
    const { ctx } = buildCtx({ resolveTargetPid: async () => 0 });
    const out = await attachDynamicProbeHandler(
      {
        // USDT + 单点模板 (无 retprobe 需求) · BUG A 修复后 USDT 仅支持 entry-only 模板
        template: 'call_count',
        function: 'postgresql:executor__run',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('sidecar');
    expect(out.reason).toMatch(/pid=0|target-pid/);
  });

  // ─────────────────────────────────────────────────────────────
  // case D · 跨 tenant attach (G1 hard-deny)
  it('case D · 跨 tenant attach → policy 拒 (G1 hard-deny)', async () => {
    const { ctx } = buildCtx({ tenant: 'tenant-A' });
    const out = await attachDynamicProbeHandler(
      {
        template: 'call_count',
        function: 'postgresql:executor__run',
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
  // case E · 容器 capability 缺失 (sidecar.forceFail)
  it('case E · 容器 capability 缺失 → sidecar attach failed + post-condition fail', async () => {
    const { ctx, dispatcher } = buildCtx();
    dispatcher.forceFail = true;
    const out = await attachDynamicProbeHandler(
      {
        template: 'call_count',
        function: 'postgresql:executor__run',
        duration_seconds: 30,
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

  // ─────────────────────────────────────────────────────────────
  // case F · watchdog 超时 (overhead 超阈值)
  it('case F · watchdog overhead > max → 提前 detach + overhead_exceeded high audit', async () => {
    const { ctx, dispatcher } = buildCtx();
    // 模拟 sidecar 慢慢跑 · watchdog 第一次 poll 就拿到超阈值 overhead
    dispatcher.forceOverheadPct = 8.0; // > max 2.0
    dispatcher.fakeDurationMs = 200; // 给 watchdog 时间触发
    const out = await attachDynamicProbeHandler(
      {
        template: 'call_count',
        function: 'postgresql:executor__run',
        duration_seconds: 30,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    // watchdog 触发 detach → dispatch 返 detached_early · post-condition 仍 audit overhead_exceeded
    const types = emitSpy.mock.calls.map((c) => c[0].event_type);
    expect(types).toContain('probe_overhead_exceeded');
    const overheadEv = emitSpy.mock.calls.find(
      (c) => c[0].event_type === 'probe_overhead_exceeded',
    );
    expect(overheadEv?.[0].severity).toBe('high');
    // out 可能 ok=false (post-condition fail) 或 ok=true (detached_early) 取决于 race ·
    // 关键是 overhead_exceeded audit 必须 emit
    if (out.ok) {
      expect(out.result.status).toBe('detached_early');
    } else {
      expect(out.stage).toBe('post-condition');
    }
  });

  // ─────────────────────────────────────────────────────────────
  // case G · 限流触发 (per-function 5min 内 5+ 次)
  it('case G · per-function 5min/5 限流 → rate-limit 拒', async () => {
    const { ctx } = buildCtx();
    // 跑 5 次成功 attach (耗尽 per-function 配额)
    // 但 per-tenant 5min/2 会先触 · 先用不同 tenant 跑前 4 次再切回 tenant-A
    for (let i = 0; i < RATE_LIMITS.PER_FUNCTION_MAX; i++) {
      const { ctx: ctxi } = buildCtx({ tenant: `tenant-${i}` });
      const ok = await attachDynamicProbeHandler(
        {
          template: 'call_count',
          function: 'postgresql:executor__run',
          duration_seconds: 1,
          max_overhead_pct: 2.0,
          endpoint_id: 'ep-A',
        },
        ctxi,
      );
      expect(ok.ok).toBe(true);
    }
    // 第 6 次 (任何 tenant) → per-function 5min/5 拒
    const out = await attachDynamicProbeHandler(
      {
        template: 'call_count',
        function: 'postgresql:executor__run',
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
  // case H · post-condition fail (跑完后 obs > max · 没被 watchdog 抓到 · 边界 race)
  it('case H · post-condition fail · 跑完后 obs > max → 拒 + audit overhead_exceeded', async () => {
    const { ctx, dispatcher } = buildCtx();
    // 设 fakeDurationMs=0 → dispatch 立即返 · watchdog 来不及 poll · post-condition 收尾时才发现 obs 超阈
    dispatcher.forceOverheadPct = 9.0;
    dispatcher.fakeDurationMs = 0;
    const out = await attachDynamicProbeHandler(
      {
        template: 'call_count',
        function: 'postgresql:executor__run',
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
    expect(types).toContain('probe_overhead_exceeded');
  });

  // ─────────────────────────────────────────────────────────────
  // 额外 · L3 require_plan 路径 (#141 验收门: L3 → plan mode elicitation)
  it('附加 · L3 + 未审批 → policy 阶段返 require_plan verdict (调用方走 elicitInput)', async () => {
    const { ctx } = buildCtx({
      autonomyLevel: 'L3',
      _testOnlyPlanApprovedBypass: false, // 未审批
    });
    const out = await attachDynamicProbeHandler(
      {
        template: 'call_count',
        function: 'postgresql:executor__run',
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
  });

  // L1/L2 直接 deny (#141 验收门: L1/L2 deny)
  it('附加 · L1/L2a/L2b → 矩阵 deny · 不弹 plan', async () => {
    for (const lvl of ['L1', 'L2a', 'L2b'] as const) {
      const { ctx } = buildCtx({ autonomyLevel: lvl });
      const out = await attachDynamicProbeHandler(
        {
          template: 'call_count',
          function: 'postgresql:executor__run',
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

  // ─────────────────────────────────────────────────────────────
  // 额外 · whitelist denylist (scram_*) 拒 · 跟 8 case 主线 case D 互补
  it('附加 · denylist 命中 (scram_*) → whitelist 阶段拒 (denylist 优先于 whitelist)', async () => {
    const wl: Whitelist = {
      ...FIXTURE_WHITELIST,
      usdt: [
        ...(FIXTURE_WHITELIST.usdt ?? []),
        // 故意把 scram probe 同时放白名单 · 验证 denylist 优先
        {
          target: 'postgresql',
          probe_name: 'postgresql:scram_init',
          subsystem: 'other',
        },
      ],
    };
    const { ctx } = buildCtx({ whitelist: wl });
    const out = await attachDynamicProbeHandler(
      {
        template: 'call_count',
        function: 'postgresql:scram_init',
        duration_seconds: 5,
        max_overhead_pct: 2.0,
        endpoint_id: 'ep-A',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.stage).toBe('whitelist');
    expect(out.reason).toMatch(/denylist|scram/);
  });
});

// ─────────────────────────────────────────────────────────────
// 单测 · template 渲染 + escape (#144 验收门: 占位符 escape)
describe('feat-068 templates · escape + render', () => {
  it('renderTemplate 5 个模板都正确渲染含 target pid + duration', async () => {
    const {
      renderTemplate,
      TEMPLATE_NAMES,
      USDT_INCOMPATIBLE_TEMPLATES,
    } = await import('../tools/handlers/dynamic-probe/templates');
    for (const t of TEMPLATE_NAMES) {
      // BUG A 修复: entry/exit 配对模板只能 kind=uprobe · 单点模板两种都行
      const kind: 'usdt' | 'uprobe' = USDT_INCOMPATIBLE_TEMPLATES.has(t)
        ? 'uprobe'
        : 'usdt';
      const script = renderTemplate(t, {
        function: 'ExecutorRun',
        binary: 'postgres',
        kind,
        pid: 9999,
        duration_seconds: 30,
      });
      expect(script).toContain('pid == 9999');
      expect(script).toContain('interval:s:30');
      // 不允许 shell 元字符出现
      expect(script).not.toMatch(/system\(|`|\$\(/);
    }
  });

  // BUG A 修复 (R2 元评 ⚠ 阻塞-A) · USDT + entry/exit 配对模板必须抛
  it('renderTemplate · USDT + latency_buckets/lock_wait_histogram → 抛错 (BUG A)', async () => {
    const { renderTemplate } = await import(
      '../tools/handlers/dynamic-probe/templates'
    );
    for (const t of ['latency_buckets', 'lock_wait_histogram'] as const) {
      expect(() =>
        renderTemplate(t, {
          function: 'ExecutorRun',
          binary: 'postgres',
          kind: 'usdt',
          pid: 1234,
          duration_seconds: 5,
        }),
      ).toThrow(/entry\/exit 配对|uretprobe|USDT.*不支持/);
    }
  });

  it('renderTemplate · uprobe + latency_buckets → 入口 uprobe: + 出口 uretprobe: (BUG A 反向回归)', async () => {
    const { renderTemplate } = await import(
      '../tools/handlers/dynamic-probe/templates'
    );
    const script = renderTemplate('latency_buckets', {
      function: 'neon_pageserver_wal_lazy_apply', // SAFE_SYMBOL_RE 允许的形式 (无 ::)
      binary: 'pageserver',
      kind: 'uprobe',
      pid: 1234,
      duration_seconds: 5,
    });
    expect(script).toMatch(/uprobe:pageserver:neon_pageserver_wal_lazy_apply/);
    expect(script).toMatch(/uretprobe:pageserver:neon_pageserver_wal_lazy_apply/);
    // 显式断言不能出现 retHead 错误替换 (usdt:/usdt: 同样 no-op)
    expect(script).not.toMatch(/(?:^|\n)usdt:.*\{.*hist\(/);
  });

  it('renderTemplate 拒绝注入字符 function 名 · 抛错', async () => {
    const { renderTemplate } = await import(
      '../tools/handlers/dynamic-probe/templates'
    );
    expect(() =>
      renderTemplate('latency_buckets', {
        function: 'ExecutorRun; rm -rf /',
        binary: 'pageserver',
        kind: 'uprobe', // BUG A 修复后 entry/exit 配对模板只能 uprobe
        pid: 1234,
        duration_seconds: 5,
      }),
    ).toThrow(/unsafe symbol/);
  });

  it('renderTemplate 拒绝 pid=0 (全局 attach)', async () => {
    const { renderTemplate } = await import(
      '../tools/handlers/dynamic-probe/templates'
    );
    expect(() =>
      renderTemplate('call_count', {
        function: 'ExecutorRun',
        binary: 'postgres',
        kind: 'usdt', // 单点模板 USDT 合规
        pid: 0,
        duration_seconds: 5,
      }),
    ).toThrow(/pid|invalid/);
  });
});

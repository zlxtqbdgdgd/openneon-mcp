/**
 * attach-dynamic-probe.ts · feat-068 重设计 (#210 · ADR-0017) · 主 handler
 *
 * agent 调 mcp tool `attach_neondb_dynamic_probe` 走这里。
 *
 * 重设计 (ADR-0017): 主引擎从 "bpftrace + ephemeral sidecar" 改为 PostgreSQL 扩展 `pg_uprobe`
 * (compute 内置 · SQL 函数驱动)。治理从 "whitelist 强制" 改为 "denylist floor"。
 *
 * 走链 (fail-closed):
 *   1. zod schema + denylist FLOOR 校验 (schema.ts · 命中 denylist 即拒 · 不再要求 ∈ whitelist)
 *   2. policy engine wiring (op-class DYNAMIC_PROBE_ATTACH 不变)
 *      - L1/L2 deny / L3 require_plan / L4 ODD+预审批跳 plan
 *   3. 三层限流 (per-tool / per-tenant / global · rate-limit.ts 不变)
 *   4. sql-driver.runProbe (同一连接 set→等 duration→stat→delete · 参数化 $1/$2 防注入)
 *   5. post-condition (探针真挂上 + 真实 overhead ≤ 阈值 · watchdog.ts)
 *   6. audit 事件流 (probe_attached / probe_detached / overhead_exceeded)
 *
 * 调用方 = mcp route.ts (orchestrator) · ctx 注入 pgClient (生产 wire pg.PoolClient 单连接 ·
 * 测试 mock PgClientLike)。
 */
import {
  validateAttachInput,
  type AttachDynamicProbeInput,
  type ProbeView,
} from './schema';
import { type Denylist } from './denylist';
import {
  runProbe,
  type PgClientLike,
  type RunProbeResult,
} from './sql-driver';
import { newAttachId } from './attach-id';
import {
  checkRateLimit,
  recordAttach,
  releaseAttach,
  emitRateLimitDenyAudit,
} from './rate-limit';
import { checkPostCondition } from './watchdog';
import { emitAuditEvent, sha256Hex } from '../../../observability/audit-emit';
import {
  runPipeline,
  type AutonomyLevel,
  type EnforcementCtx,
  type Verdict,
} from '../../../policy/pipeline';

/** mcp orchestrator (route.ts) 传给 handler 的运行时上下文 */
export type AttachHandlerCtx = {
  /**
   * PG client · pg_uprobe SQL 驱动用。
   * ⚠️ 必须是**单个物理连接** (pg.PoolClient · 不是 pool) · 因为 is_shared=false 的探针是 session 级 ·
   * set/stat/delete 必须同连接 (详 sql-driver.ts)。生产由 route.ts 注入 · 测试 mock。
   */
  pgClient: PgClientLike;
  /** policy level (来自 resolvePolicy().autonomy_level) */
  autonomyLevel: AutonomyLevel;
  /** 当前 tenant / project_id (来自 grant scope · G1 校验已在 pipeline 里) */
  tenant: string;
  /** denylist FLOOR 注入 (测试用 · 生产从 file load · denylist.ts) */
  denylist?: Denylist;
  /**
   * **@internal @testOnly** plan-mode bypass · 测试 fixture 专用 ·
   * route.ts wiring PR 接入后,真实链路必须用 ConfirmTokenSnapshot (feat-026/§4 issueConfirmToken)
   * 而**不**走这个 boolean shortcut · 命名前缀 `_testOnly` 即合约。
   */
  _testOnlyPlanApprovedBypass?: boolean;
  /**
   * 测试用 · 注入 sql-driver sleep 实现 (默认真 setTimeout(duration*1000)) ·
   * 单测传 `async () => {}` 跳过真实等待。
   */
  _testOnlySleep?: (ms: number) => Promise<void>;
  /**
   * 真实观察 overhead (%) · route.ts 真接通后从 compute metrics 注入 post-condition ·
   * 单测/未接通时 undefined (post-condition 只校验"探针真挂上")。
   */
  observedOverheadPct?: number;
};

export type AttachHandlerOutcome =
  | {
      ok: true;
      attachId: string;
      result: {
        status: 'completed';
        elapsedMs: number;
        observedOverheadPct?: number;
        /** sql-driver 解析后的 enriched 结果 (TIME/MEM: calls/avg_time_ns · HIST: histogram) */
        output: RunProbeResult;
      };
    }
  | {
      ok: false;
      reason: string;
      /** 拒绝阶段 · for debug + 调用方决定怎么回吐 */
      stage:
        | 'schema'
        | 'denylist'
        | 'policy'
        | 'rate-limit'
        | 'sql-driver'
        | 'post-condition';
      /** policy 阶段返 require_plan 时 · 调用方走 elicitInput */
      verdict?: Verdict;
    };

/**
 * 主 entry · mcp orchestrator (route.ts) 调。
 *
 * fail-closed: 任一步失败立即返 {ok: false, ...} · 不 partial attach · 不 silent fallback。
 */
export async function attachDynamicProbeHandler(
  rawInput: unknown,
  ctx: AttachHandlerCtx,
): Promise<AttachHandlerOutcome> {
  // ── 1. schema + denylist FLOOR
  const v = validateAttachInput(rawInput, ctx.denylist);
  if (!v.ok) {
    emitAuditEvent({
      event_type: 'probe_attach_denied',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: ctx.tenant,
      severity: 'medium',
      extra: { stage: 'schema', reason: v.reason },
    });
    // 区分 schema fail 跟 denylist FLOOR fail · 让调用方知道是哪类
    const isDenylistFail = v.reason.includes('denylist');
    return {
      ok: false,
      reason: v.reason,
      stage: isDenylistFail ? 'denylist' : 'schema',
    };
  }
  const input: AttachDynamicProbeInput = v.input;
  const probe: ProbeView = v.probe;

  // ── 2. policy engine wiring (feat-056 pipeline · op-class DYNAMIC_PROBE_ATTACH)
  // L1/L2 deny / L3 require_plan / L4 allow (matrix.ts 配置)
  // L3+ 还需 endpoint_id 强制 (ODD 内强制 · feat-068 详设 §6)
  if (
    (ctx.autonomyLevel === 'L3' || ctx.autonomyLevel === 'L4') &&
    !input.endpoint_id
  ) {
    emitAuditEvent({
      event_type: 'probe_attach_denied',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: ctx.tenant,
      severity: 'medium',
      extra: { stage: 'policy', reason: 'L3+ 必须显式 endpoint_id (ODD 内强制)' },
    });
    return {
      ok: false,
      reason: 'L3+ autonomy 必须显式 endpoint_id (ODD 内强制 · 详设 §6)',
      stage: 'policy',
    };
  }

  const policyCtx: EnforcementCtx = {
    opClass: 'DYNAMIC_PROBE_ATTACH',
    toolName: 'attach_neondb_dynamic_probe',
    projectId: input.project_id ?? ctx.tenant,
    requestedProjectId: input.project_id,
    autonomyLevel: ctx.autonomyLevel,
    grant: { projectId: ctx.tenant },
    sql: `attach_neondb_dynamic_probe(probe_type=${input.probe_type}, function=${input.function}, target=${input.target}, duration=${input.duration_seconds}s)`,
    // 注: 不在此注入 confirm token (该字段需 ConfirmTokenSnapshot 形态 · server-internal 由
    //   issueConfirmToken 颁发 · feat-026/§4)。本 handler 走"orchestrator 已审批后重调"语义。
    //   单测 fixture 用 _testOnlyPlanApprovedBypass boolean shortcut 跳过该流。
  };
  const verdict = runPipeline(policyCtx);
  if (verdict.action === 'deny') {
    emitAuditEvent({
      event_type: 'probe_attach_denied',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: ctx.tenant,
      severity: verdict.audit_severity === 'info' ? 'low' : verdict.audit_severity,
      extra: { stage: 'policy', reason: verdict.reason },
    });
    return { ok: false, reason: verdict.reason, stage: 'policy', verdict };
  }
  if (verdict.action === 'require_plan') {
    // L3/L4 require_plan · 调用方未带 _testOnlyPlanApprovedBypass → 返 verdict 给 orchestrator 跑 elicitInput
    if (!ctx._testOnlyPlanApprovedBypass) {
      return {
        ok: false,
        reason: '需 DBA 审批 (plan mode · feat-027 elicitInput)',
        stage: 'policy',
        verdict,
      };
    }
    // 已带 _testOnlyPlanApprovedBypass · 视为 orchestrator 已跑过 elicit + 颁过真 confirm token
  }

  // ── 3. rate limit (3 layers)
  const rl = checkRateLimit({
    tenant: ctx.tenant,
    functionName: input.function,
  });
  if (!rl.ok) {
    emitRateLimitDenyAudit(
      { tenant: ctx.tenant, functionName: input.function },
      rl,
    );
    return { ok: false, reason: rl.reason, stage: 'rate-limit' };
  }

  // ── 4. sql-driver: 同一连接 set→等 duration→stat→delete (pg_uprobe · 参数化防注入)
  const attachId = newAttachId();
  recordAttach({ tenant: ctx.tenant, functionName: input.function }, attachId);
  emitAuditEvent({
    event_type: 'probe_attached',
    outcome: 'allow',
    op_class: 'DYNAMIC_PROBE_ATTACH',
    project_id: ctx.tenant,
    severity: 'medium',
    db_statement_sha256: sha256Hex(
      `set_uprobe(${input.function},${input.probe_type},false)`,
    ),
    extra: {
      attach_id: attachId,
      probe_type: input.probe_type,
      function: input.function,
      target: input.target,
      duration_seconds: input.duration_seconds,
      max_overhead_pct: input.max_overhead_pct,
      endpoint_id: input.endpoint_id,
    },
  });

  let probeResult: RunProbeResult;
  try {
    probeResult = await runProbe(ctx.pgClient, {
      function: probe.function,
      probe_type: probe.probe_type,
      duration_seconds: input.duration_seconds,
      sleep: ctx._testOnlySleep,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emitAuditEvent({
      event_type: 'probe_attach_failed',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: ctx.tenant,
      severity: 'high',
      extra: { attach_id: attachId, function: input.function, reason },
    });
    releaseAttach(attachId);
    return { ok: false, reason: `pg_uprobe SQL 驱动失败: ${reason}`, stage: 'sql-driver' };
  } finally {
    releaseAttach(attachId);
  }

  // ── 5. post-condition (探针真挂上 + 真实 overhead ≤ 阈值)
  // attached 判定: TIME/MEM 采到 calls (非 null) · HIST 采到至少 1 行直方图。
  const attached =
    probeResult.probe_type === 'HIST'
      ? probeResult.histogram.length > 0
      : probeResult.calls !== null;
  const pc = checkPostCondition({
    attachId,
    tenant: ctx.tenant,
    functionName: input.function,
    maxOverheadPct: input.max_overhead_pct,
    attached,
    observedOverheadPct: ctx.observedOverheadPct,
    elapsedMs: probeResult.elapsed_ms,
  });
  if (!pc.passed) {
    return { ok: false, reason: pc.reason, stage: 'post-condition' };
  }

  return {
    ok: true,
    attachId,
    result: {
      status: 'completed',
      elapsedMs: probeResult.elapsed_ms,
      observedOverheadPct: ctx.observedOverheadPct,
      output: probeResult,
    },
  };
}

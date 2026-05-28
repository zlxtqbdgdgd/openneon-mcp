/**
 * attach-dynamic-probe.ts · feat-068 (#144 + #141 + #142 + #143) · 主 handler
 *
 * agent 调 mcp tool `attach_neondb_dynamic_probe` 走这里。
 *
 * 走链 (fail-closed):
 *   1. zod schema + whitelist 校验          (#144)
 *   2. policy engine wiring                  (#141) · op-class DYNAMIC_PROBE_ATTACH
 *      - L1/L2 deny / L3 require_plan / L4 ODD+预审批跳 plan
 *      - 跟 feat-027 plan-mode 集成 (由 mcp orchestrator/route.ts 的 elicitInput 跑)
 *   3. 三层限流                              (#143) · per-tool / per-tenant / global
 *   4. ephemeral sidecar dispatch            (#142) · target-pid 显式 / CAP_BPF
 *   5. watchdog 监控 + 自动 detach           (#143)
 *   6. post-condition (probe 真挂上 + overhead ≤ 阈值) (#143)
 *   7. audit 事件流                          (#143) · probe_attached / probe_detached / overhead_exceeded
 *
 * 本文件**是一个独立可调函数** (非 NEON_TOOLS 注册路径 · 注册到 tools.ts 留给后续 PR ·
 * sub-issue scope 关闭 4 个验收门即可)。调用方 = mcp route.ts (orchestrator)。
 */
import {
  validateAttachInput,
  type AttachDynamicProbeInput,
  type Whitelist,
} from './schema';
import { renderTemplate } from './templates';
import {
  newAttachId,
  type Dispatcher,
  type AttachRequest,
} from './sidecar';
import {
  checkRateLimit,
  recordAttach,
  releaseAttach,
  emitRateLimitDenyAudit,
} from './rate-limit';
import { runWatchdog, checkPostCondition } from './watchdog';
import { emitAuditEvent, sha256Hex } from '../../../observability/audit-emit';
import {
  runPipeline,
  type AutonomyLevel,
  type EnforcementCtx,
  type Verdict,
} from '../../../policy/pipeline';

/** mcp orchestrator (route.ts) 传给 handler 的运行时上下文 */
export type AttachHandlerCtx = {
  dispatcher: Dispatcher;
  /** target-pid 解析: tenant 提供 endpoint_id → 解析到 compute pid (运维侧映射 · 测试注入) */
  resolveTargetPid: (endpointId: string | undefined) => Promise<number>;
  /** policy level (来自 resolvePolicy().autonomy_level) */
  autonomyLevel: AutonomyLevel;
  /** 当前 tenant / project_id (来自 grant scope · G1 校验已在 pipeline 里) */
  tenant: string;
  /** whitelist 注入 (测试用 · 生产从 file load) */
  whitelist?: Whitelist;
  /**
   * **@internal @testOnly** plan-mode bypass · 测试 fixture 专用 ·
   * route.ts wiring PR 接入后,真实链路必须用 ConfirmTokenSnapshot (feat-026/§4 issueConfirmToken)
   * 而**不**走这个 boolean shortcut · 命名前缀 `_testOnly` 即合约:
   *   1. 单测/集成测试用它跳 elicitInput → issueConfirmToken 副作用
   *   2. 生产 route.ts 必须 sourceforge 真 ConfirmTokenSnapshot 注入 EnforcementCtx 重调 handler
   *   3. 任何非 *.test.ts 引用本字段需 reviewer 显式签名 (R2 元评 ⚠ 阻塞-C)
   */
  _testOnlyPlanApprovedBypass?: boolean;
  /** 测试用 · watchdog poll 缩短 */
  watchdogPollMs?: number;
};

export type AttachHandlerOutcome =
  | {
      ok: true;
      attachId: string;
      result: {
        status: 'completed' | 'detached_early';
        elapsedMs: number;
        observedOverheadPct?: number;
        output?: Record<string, unknown>;
      };
    }
  | {
      ok: false;
      reason: string;
      /** 拒绝阶段 · for debug + 调用方决定怎么回吐 */
      stage:
        | 'schema'
        | 'whitelist'
        | 'policy'
        | 'rate-limit'
        | 'sidecar'
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
  // ── 1. schema + whitelist
  const v = validateAttachInput(rawInput, ctx.whitelist);
  if (!v.ok) {
    emitAuditEvent({
      event_type: 'probe_attach_denied',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: ctx.tenant,
      severity: 'medium',
      extra: { stage: 'schema', reason: v.reason },
    });
    // 区分 schema fail 跟 whitelist fail · 让调用方知道是哪类
    const isWhitelistFail =
      v.reason.includes('whitelist') || v.reason.includes('denylist');
    return {
      ok: false,
      reason: v.reason,
      stage: isWhitelistFail ? 'whitelist' : 'schema',
    };
  }
  const input: AttachDynamicProbeInput = v.input;
  const probe = v.probe;

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
    sql: `attach_neondb_dynamic_probe(template=${input.template}, function=${input.function}, duration=${input.duration_seconds}s)`,
    // 注: 不在此注入 confirm token (该字段需 ConfirmTokenSnapshot 形态 · server-internal 由
    //   issueConfirmToken 颁发 · feat-026/§4)。本 handler 走"orchestrator 已审批后重调"语义:
    //   route.ts 拿 require_plan verdict → 跑 elicitInput → approve 后由 orchestrator issueConfirmToken
    //   并把真 snapshot 注入 EnforcementCtx 重调 → 本 handler 透传给 pipeline。
    //   单测 fixture 用 _testOnlyPlanApprovedBypass boolean shortcut 跳过该流 (避开 confirm-token-store 跨 stage 副作用)。
  };
  const verdict = runPipeline(policyCtx);
  if (verdict.action === 'deny') {
    emitAuditEvent({
      event_type: 'probe_attach_denied',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: ctx.tenant,
      // Verdict.audit_severity 是 'info'|'medium'|'high' · AuditSeverity 是 'low'|'medium'|'high'
      // info → low (audit-emit schema 没 info · 跟 g4_destructive_deny 默认 high 同等地落)
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
    // 已带 _testOnlyPlanApprovedBypass · 视为 orchestrator 已跑过 elicit + 颁过真 confirm token (#141 §6)
    // sub-issue scope: 不重跑 pipeline / 不重新 verify token · 由 route.ts 负责真链路 verification
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

  // ── 4. resolve target-pid (显式 · 不允许 pid=0 全局)
  let targetPid: number;
  try {
    targetPid = await ctx.resolveTargetPid(input.endpoint_id);
    if (!Number.isInteger(targetPid) || targetPid <= 0) {
      throw new Error(`resolveTargetPid 返回 ${targetPid} · 不允许 pid=0 全局`);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emitAuditEvent({
      event_type: 'probe_attach_denied',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: ctx.tenant,
      severity: 'medium',
      extra: { stage: 'sidecar', reason: `target-pid 解析失败: ${reason}` },
    });
    return { ok: false, reason: `target-pid 解析失败: ${reason}`, stage: 'sidecar' };
  }

  // ── 5. render bpftrace script + dispatch sidecar
  const script = renderTemplate(input.template, {
    function: input.function,
    binary: probe.binary,
    kind: probe.kind,
    pid: targetPid,
    duration_seconds: input.duration_seconds,
  });
  const attachId = newAttachId();
  const req: AttachRequest = {
    attachId,
    targetPid,
    bpftraceScript: script,
    durationSeconds: input.duration_seconds,
    meta: {
      template: input.template,
      function: input.function,
      tenant: ctx.tenant,
      endpointId: input.endpoint_id,
    },
  };

  recordAttach({ tenant: ctx.tenant, functionName: input.function }, attachId);
  emitAuditEvent({
    event_type: 'probe_attached',
    outcome: 'allow',
    op_class: 'DYNAMIC_PROBE_ATTACH',
    project_id: ctx.tenant,
    severity: 'medium',
    db_statement_sha256: sha256Hex(script),
    extra: {
      attach_id: attachId,
      template: input.template,
      function: input.function,
      target_pid: targetPid,
      duration_seconds: input.duration_seconds,
      max_overhead_pct: input.max_overhead_pct,
      endpoint_id: input.endpoint_id,
    },
  });

  // dispatch + watchdog 并发跑
  const watchAbort = new AbortController();
  const dispatchPromise = ctx.dispatcher.dispatch(req);
  const watchdogPromise = runWatchdog({
    attachId,
    dispatcher: ctx.dispatcher,
    maxOverheadPct: input.max_overhead_pct,
    durationSeconds: input.duration_seconds,
    tenant: ctx.tenant,
    functionName: input.function,
    pollMs: ctx.watchdogPollMs,
    signal: watchAbort.signal,
  });

  let dispatchResult;
  try {
    dispatchResult = await dispatchPromise;
  } finally {
    watchAbort.abort(); // sidecar 跑完无论结果都停 watchdog
    await watchdogPromise.catch(() => undefined);
    releaseAttach(attachId);
  }

  // ── 6. post-condition
  const pc = checkPostCondition({
    attachId,
    tenant: ctx.tenant,
    functionName: input.function,
    maxOverheadPct: input.max_overhead_pct,
    status: dispatchResult.status,
    observedOverheadPct: dispatchResult.observedOverheadPct,
    elapsedMs: dispatchResult.elapsedMs,
  });
  if (!pc.passed) {
    return { ok: false, reason: pc.reason, stage: 'post-condition' };
  }

  return {
    ok: true,
    attachId,
    result: {
      status: dispatchResult.status === 'failed' ? 'detached_early' : dispatchResult.status,
      elapsedMs: dispatchResult.elapsedMs,
      observedOverheadPct: dispatchResult.observedOverheadPct,
      output: dispatchResult.output,
    },
  };
}

/**
 * watchdog.ts · feat-068 重设计 (#210 · ADR-0017) · post-condition 校验
 *
 * 重设计前: watchdog 是独立 loop · 每 1s 拉 sidecar overhead · 超阈值持续 ≥ 2s 调
 * Dispatcher.detach()。SQL 驱动 (pg_uprobe) 下没有 sidecar pod 也没有 Dispatcher:
 *   - duration cap 由 sql-driver 的 set→sleep(duration)→stat→delete 等待窗口控制 (delete 摘探针)
 *   - 不再有"持续监控 + 主动 detach"的并发 watchdog loop
 *   - 真实 overhead 由 post-condition 在探针跑完后校验 (overhead ≤ max_overhead_pct + 探针真挂上)
 *
 * 因此本文件只保留 post-condition 校验 (探针真挂上 + 真实耗时/overhead 不超阈)。
 */
import { emitAuditEvent } from '../../../observability/audit-emit';

/**
 * post-condition 校验 · 探针跑完 (sql-driver.runProbe 返回) 后跑。
 *
 *   1. probe 没真挂上 (attached=false · stat 没采到任何数据) → 抛 (audit probe_attach_failed high)
 *   2. observedOverheadPct > maxOverheadPct → audit `probe_overhead_exceeded` high (留底)
 *   3. 正常 → audit `probe_detached` (info · 探针已 delete)
 */
export type PostConditionInput = {
  attachId: string;
  tenant: string;
  functionName: string;
  maxOverheadPct: number;
  /** 探针是否真挂上并采到 stat (sql-driver 返回有 calls/histogram 即 true) */
  attached: boolean;
  /** 真实观察 overhead (%) · 由 route.ts 真接通后从 compute metrics 注入 · 单测/未接通时 undefined */
  observedOverheadPct?: number;
  /** 探针实际跑了多少 ms (sql-driver elapsed_ms) */
  elapsedMs: number;
};

export type PostConditionResult = {
  passed: boolean;
  reason: string;
};

export function checkPostCondition(
  input: PostConditionInput,
): PostConditionResult {
  if (!input.attached) {
    emitAuditEvent({
      event_type: 'probe_attach_failed',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: input.tenant,
      severity: 'high',
      extra: {
        attach_id: input.attachId,
        function: input.functionName,
        elapsed_ms: input.elapsedMs,
      },
    });
    return {
      passed: false,
      reason: 'pg_uprobe 没真挂上 (post-condition: stat 未采到任何数据)',
    };
  }
  const obs = input.observedOverheadPct;
  if (obs !== undefined && obs > input.maxOverheadPct) {
    emitAuditEvent({
      event_type: 'probe_overhead_exceeded',
      outcome: 'deny',
      op_class: 'DYNAMIC_PROBE_ATTACH',
      project_id: input.tenant,
      severity: 'high',
      extra: {
        attach_id: input.attachId,
        function: input.functionName,
        observed_pct: obs,
        max_pct: input.maxOverheadPct,
        detach_source: 'post_condition',
        elapsed_ms: input.elapsedMs,
      },
    });
    return {
      passed: false,
      reason: `post-condition fail: observed overhead ${obs}% > max ${input.maxOverheadPct}%`,
    };
  }
  emitAuditEvent({
    event_type: 'probe_detached',
    outcome: 'allow',
    op_class: 'DYNAMIC_PROBE_ATTACH',
    project_id: input.tenant,
    severity: 'low',
    extra: {
      attach_id: input.attachId,
      function: input.functionName,
      observed_pct: obs,
      elapsed_ms: input.elapsedMs,
    },
  });
  return { passed: true, reason: 'post-condition ok' };
}

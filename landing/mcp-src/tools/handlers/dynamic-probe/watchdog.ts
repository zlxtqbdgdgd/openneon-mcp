/**
 * watchdog.ts · feat-068/#4 (#143) · watchdog 监控 + post-condition 校验
 *
 * watchdog:
 *   - 每 1s 拉 sidecar 当前 overhead (Dispatcher.getObservedOverhead)
 *   - 超 max_overhead_pct **持续 ≥ 2s** → 调 Dispatcher.detach + audit `overhead_exceeded` (high)
 *   - spike (单次超阈值 < 2s) 不触发 · 避免 noise detach
 *   - duration 到自动 detach (sidecar 内 interval:s:$dur exit() · mcp 侧 watchdog 也兜底)
 *
 * #182 拍板: 1s poll + 2s persistence threshold (低 latency · ~1% CPU 代价)
 * 跟详设 §3 "持续 ≥ 2s detach" 触发条件保持一致 · poll 频率 1s 是兼顾 latency 跟 overhead。
 *
 * post-condition:
 *   - probe 停止后 mcp 拿真实 elapsed / observedOverheadPct
 *   - 比对 max_overhead_pct 阈值 · 超阈值 → high severity audit
 *   - 检查 sidecar 真挂上 (status !== 'failed') · 失败抛
 */
import type { Dispatcher } from './sidecar';
import { emitAuditEvent } from '../../../observability/audit-emit';

export const WATCHDOG_POLL_MS = 1_000;
/** overhead 超阈值持续多少 ms 才触发 detach (#182 拍板 · 跟详设 §3 一致) */
export const WATCHDOG_PERSISTENCE_MS = 2_000;

export type WatchdogInput = {
  attachId: string;
  dispatcher: Dispatcher;
  maxOverheadPct: number;
  durationSeconds: number;
  tenant: string;
  functionName: string;
  /** 测试用 · 注入 poll interval 缩短测试时长 */
  pollMs?: number;
  /** 测试用 · 注入 persistence 阈值 (#182) · 默认 WATCHDOG_PERSISTENCE_MS=2000 */
  persistenceMs?: number;
  /** 测试用 · 注入 abort controller (handler 用 AbortSignal 让 watchdog 提前停) */
  signal?: AbortSignal;
};

export type WatchdogOutcome =
  | { detached: false }
  | { detached: true; reason: string; observedPct: number };

/**
 * watchdog loop · 跟 dispatch() 并发跑 · 超阈值时调 dispatcher.detach()。
 * 返 Promise · resolve 时机:
 *   - duration_seconds 到 (resolve { detached: false })
 *   - 触发 detach (resolve { detached: true, ... })
 *   - signal.abort() (handler 在 dispatch 完成后通知 watchdog 停 · resolve { detached: false })
 */
export async function runWatchdog(
  input: WatchdogInput,
): Promise<WatchdogOutcome> {
  const poll = input.pollMs ?? WATCHDOG_POLL_MS;
  const persistenceMs = input.persistenceMs ?? WATCHDOG_PERSISTENCE_MS;
  const deadline = Date.now() + input.durationSeconds * 1000;
  // #182: persistence tracking · spike (单次超 < persistenceMs) 不触发 detach
  let firstExceedAt: number | null = null;
  return await new Promise<WatchdogOutcome>((resolve) => {
    const t = setInterval(async () => {
      try {
        if (input.signal?.aborted) {
          clearInterval(t);
          resolve({ detached: false });
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(t);
          resolve({ detached: false });
          return;
        }
        const obs = await input.dispatcher.getObservedOverhead(input.attachId);
        if (obs !== undefined && obs > input.maxOverheadPct) {
          // 首次超阈值 · 标记时间戳 (不立刻 detach · 等持续 ≥ persistenceMs)
          if (firstExceedAt === null) {
            firstExceedAt = Date.now();
            return;
          }
          // 持续 ≥ persistenceMs → 触发 detach
          const persistedMs = Date.now() - firstExceedAt;
          if (persistedMs < persistenceMs) {
            return; // 还没持续够 · 下一 tick 再判
          }
          clearInterval(t);
          await input.dispatcher.detach(
            input.attachId,
            `watchdog: overhead ${obs}% > max ${input.maxOverheadPct}% (持续 ${persistedMs}ms ≥ ${persistenceMs}ms)`,
          );
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
              persisted_ms: persistedMs,
              detach_source: 'watchdog',
            },
          });
          resolve({
            detached: true,
            reason: `overhead ${obs}% > ${input.maxOverheadPct}% (持续 ${persistedMs}ms)`,
            observedPct: obs,
          });
        } else {
          // overhead 回归正常 · 重置 persistence tracker (spike 不触发)
          firstExceedAt = null;
        }
      } catch (e) {
        // poll 错误不应 crash watchdog · 保留下次 tick (但 log)
        // fail-safe: 如果反复失败 · 兜底 detach 在 deadline 上仍生效
      }
    }, poll);
  });
}

/**
 * post-condition 校验 · probe 停止后跑。
 *
 *   1. sidecar.status === 'failed' → 抛 (attach 没真挂上)
 *   2. observedOverheadPct > maxOverheadPct → audit `overhead_exceeded` high (尽管已 detach
 *      也要留底)
 *   3. observedOverheadPct ≤ maxOverheadPct → audit `probe_detached` info (正常)
 */
export type PostConditionInput = {
  attachId: string;
  tenant: string;
  functionName: string;
  maxOverheadPct: number;
  status: 'completed' | 'detached_early' | 'failed';
  observedOverheadPct?: number;
  elapsedMs: number;
};

export type PostConditionResult = {
  passed: boolean;
  reason: string;
};

export function checkPostCondition(input: PostConditionInput): PostConditionResult {
  if (input.status === 'failed') {
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
    return { passed: false, reason: 'sidecar attach failed (post-condition: probe 没真挂上)' };
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
      status: input.status,
      observed_pct: obs,
      elapsed_ms: input.elapsedMs,
    },
  });
  return { passed: true, reason: 'post-condition ok' };
}

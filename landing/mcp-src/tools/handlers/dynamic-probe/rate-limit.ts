/**
 * rate-limit.ts · feat-068/#4 (#143) · 三层限流
 *
 * 全局 / per-tenant / per-function 三层叠加 (任一层超限直接 deny):
 *   1. 全局 hard limit (active probes 数 · 同时刻不超 3 个)
 *   2. per-tenant 5min 滑窗最多 2 次 attach (per tenant_id + per function 组合)
 *   3. per-function 5min 滑窗最多 5 次 attach (跟 feat-055 G9 destructive 集合共享 counter 语义)
 *
 * day-one in-memory · 多实例后续接共享存储 (Redis 等)。
 *
 * 注:跟 feat-055 rate-limiter 边界:
 *   - feat-055 = destructive SQL ops 计数 (DROP / DELETE / ALTER 等)
 *   - 本模块 = dynamic probe attach 计数 (新 op-class DYNAMIC_PROBE_ATTACH)
 *   未来若要把两类计数合到同 counter (feat-055 G9 集合共享 5min/5 上限)· 在 feat-056 pipeline
 *   G9 stage 把本模块计入 RATE_LIMITED_OPS 即可 · 本 PR 维持分离 (sub-issue scope)。
 */
import { emitAuditEvent } from '../../../observability/audit-emit';

export const RATE_LIMITS = {
  /** 全局 hard limit · 同时刻并发 attach 上限 (硬阈) */
  GLOBAL_CONCURRENT_MAX: 3,
  /** per-function 滑窗长度 ms · 5min */
  PER_FUNCTION_WINDOW_MS: 5 * 60 * 1000,
  /** per-function 滑窗内 attach 次数上限 · 5 (跟 feat-055 G9 集合 5min/5 同口径) */
  PER_FUNCTION_MAX: 5,
  /** per-tenant 滑窗长度 ms · 5min */
  PER_TENANT_WINDOW_MS: 5 * 60 * 1000,
  /** per-tenant + function 滑窗内 attach 次数上限 · 2 */
  PER_TENANT_MAX: 2,
} as const;

type AttachHit = { ts: number; tenant: string; functionName: string };

const activeAttaches = new Set<string>(); // attach_id 集合 · global concurrent
const hits: AttachHit[] = [];

/** 测试用 · 重置全部状态 */
export function __resetRateLimitForTest(): void {
  activeAttaches.clear();
  hits.length = 0;
}

function evictOld(now: number): void {
  const cutoff = now - Math.max(
    RATE_LIMITS.PER_FUNCTION_WINDOW_MS,
    RATE_LIMITS.PER_TENANT_WINDOW_MS,
  );
  while (hits.length > 0 && hits[0].ts < cutoff) hits.shift();
}

export type RateCheckInput = {
  tenant: string; // project_id 或 'global'
  functionName: string;
};

export type RateCheckResult =
  | { ok: true }
  | { ok: false; layer: 'global' | 'per-function' | 'per-tenant'; reason: string };

/**
 * pre-attach 校验 · 任一层超限 → deny。
 * 注意: 本函数**只校验不入账** · 真正 attach 后由 recordAttach() 写计数。
 * 这样能在 plan-mode 审批前就回弹"超限" · 不污染 counter。
 */
export function checkRateLimit(input: RateCheckInput): RateCheckResult {
  const now = Date.now();
  evictOld(now);
  // layer 1: 全局并发
  if (activeAttaches.size >= RATE_LIMITS.GLOBAL_CONCURRENT_MAX) {
    return {
      ok: false,
      layer: 'global',
      reason: `全局并发 attach 上限 ${RATE_LIMITS.GLOBAL_CONCURRENT_MAX} · 当前 ${activeAttaches.size} 个在跑`,
    };
  }
  // layer 2: per-function 5min/5
  const fnCount = hits.filter(
    (h) =>
      h.functionName === input.functionName &&
      now - h.ts < RATE_LIMITS.PER_FUNCTION_WINDOW_MS,
  ).length;
  if (fnCount >= RATE_LIMITS.PER_FUNCTION_MAX) {
    return {
      ok: false,
      layer: 'per-function',
      reason: `function "${input.functionName}" 5min 内已 attach ${fnCount} 次 (上限 ${RATE_LIMITS.PER_FUNCTION_MAX})`,
    };
  }
  // layer 3: per-tenant + function 5min/2
  const tenantFnCount = hits.filter(
    (h) =>
      h.tenant === input.tenant &&
      h.functionName === input.functionName &&
      now - h.ts < RATE_LIMITS.PER_TENANT_WINDOW_MS,
  ).length;
  if (tenantFnCount >= RATE_LIMITS.PER_TENANT_MAX) {
    return {
      ok: false,
      layer: 'per-tenant',
      reason: `tenant "${input.tenant}" 对 function "${input.functionName}" 5min 内已 attach ${tenantFnCount} 次 (上限 ${RATE_LIMITS.PER_TENANT_MAX})`,
    };
  }
  return { ok: true };
}

/**
 * 真正 attach 时调 · 计入 counter + 记 active 集合 (用于 global concurrent)。
 * 返 attach_id (后续 detach 时传 releaseAttach)。
 */
export function recordAttach(input: RateCheckInput, attachId: string): void {
  hits.push({ ts: Date.now(), tenant: input.tenant, functionName: input.functionName });
  activeAttaches.add(attachId);
}

export function releaseAttach(attachId: string): void {
  activeAttaches.delete(attachId);
}

/** 限流触发 → audit event (fail-closed) */
export function emitRateLimitDenyAudit(
  input: RateCheckInput,
  result: Extract<RateCheckResult, { ok: false }>,
): void {
  emitAuditEvent({
    event_type: 'probe_rate_limit_exceeded',
    outcome: 'deny',
    op_class: 'DYNAMIC_PROBE_ATTACH',
    project_id: input.tenant,
    severity: 'high',
    extra: {
      layer: result.layer,
      reason: result.reason,
      function: input.functionName,
    },
  });
}

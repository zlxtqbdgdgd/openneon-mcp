/**
 * Redis plan-store backend · feat-023/#1 (L2b) · **L3+ stub**。
 *
 * 详设 §3.2 + §11 OQ1/OQ2: mcp 当前 single-process (streamable HTTP stateless) ·
 * in-memory backend 配合 single-process work。scale-out (多 worker · SSE+Redis) 才需要跨
 * worker 共享 plan-store —— 跟 feat-026 L4 池接口 / feat-031 OTel multi-worker 同 L3+ deferred。
 *
 * 本期是 stub: 所有方法 throw NotImplementedError · CI guard 防被误改成"半截实现"
 * (跟 feat-026 L4 stub 同模式)。getPlanStore() 在 PLAN_STORE_BACKEND=redis 时构造它 ·
 * 第一次调用即 throw · 明确暴露"redis backend 还没接"。
 */

import type { PlanFilter, PlanRecord, PlanStoreBackend } from './types';

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

const L3_MSG =
  'Redis plan-store backend requires L3+ multi-worker (feat-023 §11 OQ2 · deferred with feat-031 OTel multi-worker)';

/**
 * L3+ stub · 不实现。CI guard (feat-023 acceptance) 断言本类每个方法体仅
 * `throw new NotImplementedError(...)` · 防被误改成实现。
 */
export class RedisPlanStore implements PlanStoreBackend {
  readonly kind = 'redis' as const;

  async writePlan(_record: PlanRecord): Promise<void> {
    throw new NotImplementedError(L3_MSG);
  }

  async searchPlans(_filter: PlanFilter): Promise<PlanRecord[]> {
    throw new NotImplementedError(L3_MSG);
  }

  async evictExpired(): Promise<number> {
    throw new NotImplementedError(L3_MSG);
  }
}

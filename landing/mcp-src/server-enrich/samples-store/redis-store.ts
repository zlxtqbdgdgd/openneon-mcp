/**
 * Redis samples-store backend · feat-024/#2 (L2b) · **L3+ stub** (跟 feat-023 plan-store /
 * feat-026 L4 stub 同模式)。
 *
 * 详设 §3 + §11 OQ8: single-process 期用 in-memory · scale-out (多 worker) 才需跨 worker 共享 ·
 * 留 L3+ multi-worker。本期 stub: 方法 throw NotImplementedError · CI guard 防被改成实现。
 */

import type { QuerySample, SampleFilter, SamplesStoreBackend } from './types';

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

const L3_MSG =
  'Redis samples-store backend requires L3+ multi-worker (feat-024 §11 OQ8 · deferred with feat-031 OTel multi-worker)';

/** L3+ stub · CI guard 断言每方法体仅 throw。 */
export class RedisSamplesStore implements SamplesStoreBackend {
  readonly kind = 'redis' as const;

  async writeSample(_sample: QuerySample): Promise<void> {
    throw new NotImplementedError(L3_MSG);
  }

  async searchSamples(_filter: SampleFilter): Promise<QuerySample[]> {
    throw new NotImplementedError(L3_MSG);
  }

  async evictExpired(): Promise<number> {
    throw new NotImplementedError(L3_MSG);
  }
}

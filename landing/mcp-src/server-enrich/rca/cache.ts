/**
 * RCA report cache · feat-045/#3 · trace_id state-aware TTL.
 *
 * Detail design: openneon-mcp#147 §Cache 策略 RFC.
 *
 * 策略 (2 档 · 按 trace 是否还在演化):
 *   - **state=closed** (incident 已收尾 · validation 完成) → 永久 cache (24h)
 *     · trace 数据已定型, RCA 报告永远是同一份, 无理由重算 + 烧 LLM token。
 *   - **state=ongoing** (incident 进行中 · 修复未验证) → TTL 60s
 *     · 数据还在变 (audit timeline 在追新事件 · validation diff 没出来),
 *       60s 缓冲让连续重试不重算, 但保证拿到的不会过期 > 1 分钟。
 *
 * 走 ADR-0009 通用 `TtlCache` 收口 · 复用 `landing/mcp-src/server-enrich/ttl-cache.ts`。
 * Key 编码 trace_id + model · 同 trace_id 跨模型分桶 (#147 跨 model robustness 需要分别比较)。
 *
 * **NOT cached on error**: any leg失败 (data-fetcher 返回 ok=false) → 走真实 LLM 调用且不入 cache ·
 * 避免把 degrade 状态固化成"看起来稳定"的假报告 (§ feat-031 fail-closed 一致)。
 */

import { TtlCache } from '../ttl-cache';
import type { RcaModelId } from './llm-client';

export type TraceState = 'ongoing' | 'closed';

const TTL_ONGOING_MS = 60 * 1000; // 60s
const TTL_CLOSED_MS = 24 * 60 * 60 * 1000; // 24h

export type RcaCacheEntry = {
  markdown: string;
  generatedAt: string; // ISO8601
  inputTokens: number;
  outputTokens: number;
  model: RcaModelId;
};

export class RcaCache {
  private store: TtlCache<RcaCacheEntry>;

  constructor(now: () => number = () => Date.now()) {
    this.store = new TtlCache<RcaCacheEntry>(now);
  }

  /** Build the cache key · trace_id × model · cross-tenant isolation already comes from trace_id. */
  static keyFor(traceId: string, model: RcaModelId): string {
    return `${traceId}::${model}`;
  }

  /** Return cached entry if present + not expired · else undefined. */
  get(traceId: string, model: RcaModelId): RcaCacheEntry | undefined {
    return this.store.get(RcaCache.keyFor(traceId, model));
  }

  /** Store with TTL determined by trace state. */
  set(
    traceId: string,
    model: RcaModelId,
    entry: RcaCacheEntry,
    state: TraceState,
  ): void {
    const ttlMs = state === 'closed' ? TTL_CLOSED_MS : TTL_ONGOING_MS;
    this.store.set(RcaCache.keyFor(traceId, model), entry, ttlMs);
  }

  /** Test helper. */
  clear(): void {
    this.store.clear();
  }
}

/** Module-level singleton · production handler reads here · tests can construct fresh instance. */
let defaultCache = new RcaCache();

export function getDefaultRcaCache(): RcaCache {
  return defaultCache;
}

export function resetDefaultRcaCache(): void {
  defaultCache = new RcaCache();
}

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
 * Key 编码 trace_id · cross-tenant isolation 已由 trace_id 提供 (form-shift 后 mcp 不再选 model ·
 * model 选择 + LLM 调用归 cc skill · 见 get-neondb-rca-evidence.ts)。
 *
 * **NOT cached on error**: any leg失败 (data-fetcher 返回 ok=false) → 不入 cache · 避免把 degrade
 * 状态固化成"看起来稳定"的假证据 bundle (§ feat-031 fail-closed 一致)。
 *
 * **缓的是确定性取证产物** (预填模板 + 证据 bundle) · 不是 LLM 叙事 (那归 cc skill)。trace 演化期
 * (ongoing) 60s TTL · 收尾 (closed) 24h —— form-shift 后 mcp 入口无 trace_state hint, 默认保守
 * ongoing 60s (cc skill 若需长缓由 skill 侧自管)。
 */

import { TtlCache } from '../ttl-cache';
import type { RcaDataBundle } from './types';

export type TraceState = 'ongoing' | 'closed';

const TTL_ONGOING_MS = 60 * 1000; // 60s
const TTL_CLOSED_MS = 24 * 60 * 60 * 1000; // 24h

export type RcaCacheEntry = {
  /** 7-section markdown skeleton (server pre-filled · cc skill fills NL prose later). */
  templateMarkdown: string;
  /** Raw 4-leg evidence bundle the cc skill cites. */
  evidenceBundle: RcaDataBundle;
  generatedAt: string; // ISO8601
  /** Server-estimated input token size of (template + evidence). */
  estimatedInputTokens: number;
  /** Leg names that fell back to [DATA_MISSING:*] (cached only when empty · NOT cached on error). */
  degradedLegs: Array<'trace' | 'probe' | 'audit' | 'validation'>;
};

export class RcaCache {
  private store: TtlCache<RcaCacheEntry>;

  constructor(now: () => number = () => Date.now()) {
    this.store = new TtlCache<RcaCacheEntry>(now);
  }

  /** Build the cache key · trace_id · cross-tenant isolation already comes from trace_id. */
  static keyFor(traceId: string): string {
    return traceId;
  }

  /** Return cached entry if present + not expired · else undefined. */
  get(traceId: string): RcaCacheEntry | undefined {
    return this.store.get(RcaCache.keyFor(traceId));
  }

  /** Store with TTL determined by trace state (default ongoing · conservative 60s). */
  set(traceId: string, entry: RcaCacheEntry, state: TraceState = 'ongoing'): void {
    const ttlMs = state === 'closed' ? TTL_CLOSED_MS : TTL_ONGOING_MS;
    this.store.set(RcaCache.keyFor(traceId), entry, ttlMs);
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

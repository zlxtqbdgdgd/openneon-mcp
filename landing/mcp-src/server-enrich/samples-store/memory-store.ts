/**
 * in-memory samples-store backend · feat-024/#2 (L2b · default backend)。
 *
 * 详设 §3 + §5: 跟 plan-store memory-store 同模式 —— Map · TTL 24h evict · cap 50000 LRU ·
 * multi-project 隔离 by projectId scope (§6 OQ8)。store 内永远 100% 脱敏 (writeSample 类型签名
 * 仅 QuerySample · raw 编译期传不进来)。
 *
 * QuerySample 比 PlanRecord 小 (无大 plan_json) → 平均 ~2KB · 50000 ≈ 100MB (§5)。
 */

import type { QuerySample, SampleFilter, SamplesStoreBackend } from './types';

export type Clock = () => number;

const DEFAULT_TTL_MS = 86_400_000; // 24h
const CAP_TOTAL = 50_000;
const CAP_PER_SIGNATURE = 50;
const DEFAULT_LIMIT = 50;

function scopeKey(projectId: string, signature: string): string {
  return `${projectId} ${signature}`;
}

export class MemorySamplesStore implements SamplesStoreBackend {
  readonly kind = 'memory' as const;

  private store = new Map<string, QuerySample[]>();
  private total = 0;

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: Clock = () => Date.now(),
  ) {}

  async writeSample(sample: QuerySample): Promise<void> {
    const key = scopeKey(sample.projectId, sample.signature);
    let arr = this.store.get(key);
    if (!arr) {
      arr = [];
      this.store.set(key, arr);
    }
    arr.push(sample);
    this.total += 1;

    if (arr.length > CAP_PER_SIGNATURE) {
      arr.sort((a, b) => a.captured_at - b.captured_at);
      const dropped = arr.splice(0, arr.length - CAP_PER_SIGNATURE);
      this.total -= dropped.length;
    }
    if (this.total > CAP_TOTAL) {
      this.evictOldestGlobal(this.total - CAP_TOTAL);
    }
  }

  async searchSamples(filter: SampleFilter): Promise<QuerySample[]> {
    const cutoff = this.now() - this.ttlMs;
    const limit = filter.limit ?? DEFAULT_LIMIT;

    const hits: QuerySample[] = [];
    for (const [key, arr] of this.store) {
      if (!key.startsWith(`${filter.projectId} `)) continue;
      if (filter.signature && !key.endsWith(` ${filter.signature}`)) continue;
      for (const s of arr) {
        if (s.captured_at < cutoff) continue;
        if (
          filter.duration_min_ms !== undefined &&
          s.duration_ms < filter.duration_min_ms
        )
          continue;
        hits.push(s);
      }
    }
    hits.sort((a, b) => b.captured_at - a.captured_at);
    return hits.slice(0, limit);
  }

  async evictExpired(): Promise<number> {
    const cutoff = this.now() - this.ttlMs;
    let evicted = 0;
    for (const [key, arr] of this.store) {
      const kept = arr.filter((s) => s.captured_at >= cutoff);
      evicted += arr.length - kept.length;
      if (kept.length === 0) this.store.delete(key);
      else this.store.set(key, kept);
    }
    this.total -= evicted;
    return evicted;
  }

  clear(): void {
    this.store.clear();
    this.total = 0;
  }

  size(): number {
    return this.total;
  }

  private evictOldestGlobal(count: number): void {
    const all: Array<{ key: string; idx: number; at: number }> = [];
    for (const [key, arr] of this.store) {
      arr.forEach((s, idx) => all.push({ key, idx, at: s.captured_at }));
    }
    all.sort((a, b) => a.at - b.at);
    const toDrop = all.slice(0, count);
    const byKey = new Map<string, number[]>();
    for (const d of toDrop) {
      const list = byKey.get(d.key) ?? [];
      list.push(d.idx);
      byKey.set(d.key, list);
    }
    for (const [key, idxs] of byKey) {
      const arr = this.store.get(key);
      if (!arr) continue;
      idxs.sort((a, b) => b - a).forEach((k) => arr.splice(k, 1));
      if (arr.length === 0) this.store.delete(key);
    }
    this.total -= toDrop.length;
  }
}

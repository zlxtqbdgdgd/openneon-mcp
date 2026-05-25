/**
 * Minimal in-process TTL cache for server-enrich · feat-016 / feat-018 (L2a).
 *
 * Holds objective slow-moving values (baseline bands · burn-rate aggregates) so a T4 call mostly
 * hits cache + computes the live-value-dependent parts fresh, meeting feat-020 p99 < 200ms without
 * a per-call Datadog round-trip.
 *
 * CRITICAL: the cache KEY must encode the full dimension set (tenant / endpoint / db). That is the
 * cross-tenant isolation boundary — two tenants querying the same signal get separate entries and
 * never share a band (§6). Only objective bands are cached; live current values are NEVER stored.
 *
 * The clock is injectable so TTL expiry is deterministically testable.
 */

export type Clock = () => number;

export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private now: Clock = () => Date.now()) {}

  /** Return the cached value if present and not expired · else undefined. */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a value with a TTL in milliseconds. */
  set(key: string, value: V, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Test / rollback helper · drop everything. */
  clear(): void {
    this.store.clear();
  }
}

/**
 * Build a cache key that includes the full dimension set (sorted for determinism).
 *
 * The dimensions segment is the cross-tenant isolation boundary — never omit a dimension from the
 * key or two tenants could collide on one band (§6).
 */
export function dimensionsKey(dimensions: Record<string, string>): string {
  return Object.keys(dimensions)
    .sort()
    .map((k) => `${k}=${dimensions[k]}`)
    .join('&');
}

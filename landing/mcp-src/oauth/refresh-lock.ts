/**
 * Single-flight + transient-failure dedup for refresh-token rotation.
 *
 * feat-072/#218 part2 (ADR-0019): the deployment is now a **single long-running
 * server** (not Vercel multi-instance), so the previous cross-instance Redis
 * distributed lock is unnecessary — the only race left is same-instance
 * concurrency, which an in-process single-flight fully absorbs. This module
 * keeps the exact public API (`withRefreshLock` / `signalTransientFailure` /
 * `peekTransientFailure`) but backs it with in-memory state instead of Redis:
 *
 *  - `withRefreshLock`: if a refresh for the same token is already in flight in
 *    this process, waiters await it and return the materialized cached result
 *    rather than stampeding upstream (Hydra's reuse detector revokes the chain
 *    on a duplicate RT₁). The holder is registered synchronously so concurrent
 *    callers reliably observe it (no SET-NX race).
 *  - transient-failure marker: an in-memory TTL map so waiters bail fast on a
 *    holder's upstream-5xx instead of waiting out a timeout.
 *
 * No external dependency; nothing to configure. (Cross-instance dedup, if a
 * multi-worker deployment ever returns, would need a shared store again — see
 * the git history for the Redis implementation.)
 */
import { logger } from '../utils/logger';

// Short — upstream 5xx-class errors that may recover. Long enough to absorb a
// wave of waiters, short enough that the next legitimate refresh isn't masked.
const TRANSIENT_TTL_MS = 30_000;

// refreshToken → in-flight refresh promise (resolves when the holder finishes).
const inFlight = new Map<string, Promise<unknown>>();
// refreshToken → epoch ms until which a transient failure is signalled.
const transientUntil = new Map<string, number>();

/**
 * Hint object passed to `execute` so the holder can request that completion
 * also marks the transient-failure window for concurrent waiters. Set
 * `markTransientForWaiters = true` when an upstream 5xx-class error is about to
 * throw.
 */
export type ReleaseHint = {
  markTransientForWaiters?: boolean;
};

/**
 * Mark a transient (5xx-class) failure for `refreshToken` so concurrent waiters
 * exit early instead of waiting out the dedup window. Best-effort.
 */
export async function signalTransientFailure(
  refreshToken: string,
): Promise<void> {
  transientUntil.set(refreshToken, Date.now() + TRANSIENT_TTL_MS);
}

/** Whether a transient failure was recently signalled for `refreshToken`. */
export async function peekTransientFailure(
  refreshToken: string,
): Promise<boolean> {
  const until = transientUntil.get(refreshToken);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    transientUntil.delete(refreshToken);
    return false;
  }
  return true;
}

/**
 * Run `execute` under an in-process single-flight on `refreshToken`. Concurrent
 * callers with the same token wait for the in-flight refresh and return its
 * materialized cached result (`peekResult`) instead of forwarding a duplicate
 * refresh upstream.
 *
 * `peekResult` MUST be cheap and idempotent (called multiple times).
 */
export async function withRefreshLock<T>(
  refreshToken: string,
  execute: (hint: ReleaseHint) => Promise<T>,
  peekResult: () => Promise<T | undefined>,
): Promise<T> {
  // If a refresh for this token is already running in-process, wait for it and
  // return the cached result it produced — don't forward a duplicate upstream.
  const existing = inFlight.get(refreshToken);
  if (existing) {
    try {
      await existing;
    } catch {
      // Holder failed; fall through to run our own attempt below.
    }
    if (await peekTransientFailure(refreshToken)) {
      const transientErr: Error & {
        status?: number;
        oauth_error?: string;
      } = new Error('Concurrent refresh failed transiently');
      transientErr.status = 503;
      transientErr.oauth_error = 'temporarily_unavailable';
      throw transientErr;
    }
    const cached = await peekResult();
    if (cached !== undefined) return cached;
    // Holder finished without caching + no transient marker → fall through.
  }

  // Become the single-flight holder. Register synchronously — there is no await
  // between creating `run` and the Map set, so a concurrent caller entering
  // here observes us and waits rather than launching a second upstream refresh.
  const hint: ReleaseHint = {};
  const run = (async (): Promise<T> => {
    // A peer may have cached between our get() above and now.
    const fast = await peekResult();
    if (fast !== undefined) return fast;
    return execute(hint);
  })();
  inFlight.set(refreshToken, run);
  try {
    return await run;
  } catch (err) {
    logger.warn('refresh-lock execute failed', {
      err: err instanceof Error ? err.message : err,
    });
    throw err;
  } finally {
    inFlight.delete(refreshToken);
    if (hint.markTransientForWaiters) {
      transientUntil.set(refreshToken, Date.now() + TRANSIENT_TTL_MS);
    }
  }
}

/** Test seam for resetting module state. */
export function __resetForTests(): void {
  inFlight.clear();
  transientUntil.clear();
}

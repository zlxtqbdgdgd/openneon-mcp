// feat-072/#218 part2 (ADR-0019): refresh-lock is now an in-memory single-flight
// (the cross-instance Redis distributed lock was only needed for Vercel
// multi-instance; the deployment is a single long-running server). These tests
// cover the in-process dedup + transient-failure semantics.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  withRefreshLock,
  signalTransientFailure,
  peekTransientFailure,
  __resetForTests,
} from '../oauth/refresh-lock';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('refresh-lock · in-memory single-flight', () => {
  beforeEach(() => __resetForTests());

  it('runs execute and returns its result when nothing is cached', async () => {
    let calls = 0;
    const result = await withRefreshLock(
      't',
      async () => {
        calls++;
        return 'R';
      },
      async () => undefined,
    );
    expect(result).toBe('R');
    expect(calls).toBe(1);
  });

  it('fast-path: returns the cached result without executing', async () => {
    let calls = 0;
    const result = await withRefreshLock(
      't',
      async () => {
        calls++;
        return 'R';
      },
      async () => 'CACHED',
    );
    expect(result).toBe('CACHED');
    expect(calls).toBe(0);
  });

  it('single-flight: concurrent same-token calls execute exactly once', async () => {
    let calls = 0;
    let cached: string | undefined;
    const execute = async () => {
      calls++;
      await sleep(20);
      cached = 'R';
      return 'R';
    };
    const peek = async () => cached;

    const [a, b, c] = await Promise.all([
      withRefreshLock('t', execute, peek),
      withRefreshLock('t', execute, peek),
      withRefreshLock('t', execute, peek),
    ]);

    expect(calls).toBe(1);
    expect([a, b, c]).toEqual(['R', 'R', 'R']);
  });

  it('different tokens do not dedup against each other', async () => {
    let calls = 0;
    const execute = async () => {
      calls++;
      await sleep(10);
      return 'R';
    };
    await Promise.all([
      withRefreshLock('a', execute, async () => undefined),
      withRefreshLock('b', execute, async () => undefined),
    ]);
    expect(calls).toBe(2);
  });

  it('propagates execute errors and clears in-flight so the next call runs', async () => {
    let calls = 0;
    await expect(
      withRefreshLock(
        't',
        async () => {
          calls++;
          throw new Error('boom');
        },
        async () => undefined,
      ),
    ).rejects.toThrow('boom');

    const result = await withRefreshLock(
      't',
      async () => {
        calls++;
        return 'R';
      },
      async () => undefined,
    );
    expect(result).toBe('R');
    expect(calls).toBe(2);
  });

  it('hint.markTransientForWaiters marks the transient window on completion', async () => {
    await withRefreshLock(
      't',
      async (hint) => {
        hint.markTransientForWaiters = true;
        return 'R';
      },
      async () => undefined,
    );
    expect(await peekTransientFailure('t')).toBe(true);
  });

  it('signalTransientFailure / peekTransientFailure roundtrip per token', async () => {
    expect(await peekTransientFailure('t')).toBe(false);
    await signalTransientFailure('t');
    expect(await peekTransientFailure('t')).toBe(true);
    expect(await peekTransientFailure('other')).toBe(false);
  });
});
